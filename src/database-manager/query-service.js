const { releaseRuntimeConnection, resolveRuntimeConnection } = require('./connection-context');
const { normalizeQueryRequest, normalizeQueryResult } = require('./domain');
const { classifySql, enforceSqlPolicy, splitSqlStatements } = require('./sql-safety');

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function operationKey(workspaceId, actorId, requestId) {
  return JSON.stringify([workspaceId, actorId, requestId]);
}

function normalizeApproval(input) {
  if (input === null || input === undefined) return Object.freeze({ confirmed: false, typedProfileName: null });
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('Database query approval is invalid.');
  return Object.freeze({
    confirmed: input.confirmed === true,
    typedProfileName: input.typedProfileName === null || input.typedProfileName === undefined ? null : String(input.typedProfileName).slice(0, 120)
  });
}

class DatabaseQueryService {
  constructor({ profileService, secretStore, runtimeRegistry, connectionService = null, localResourceResolver = null, tunnelProvider = null, historyRecorder = null } = {}) {
    if (!profileService?.get) throw new TypeError('DatabaseQueryService requires the profile service.');
    if (!secretStore?.resolve) throw new TypeError('DatabaseQueryService requires the shared secret store.');
    if (!runtimeRegistry?.get) throw new TypeError('DatabaseQueryService requires a driver runtime registry.');
    if (localResourceResolver !== null && typeof localResourceResolver !== 'function') throw new TypeError('Database query local resource resolver is invalid.');
    if (historyRecorder !== null && typeof historyRecorder !== 'function') throw new TypeError('Database query history recorder is invalid.');
    if (connectionService !== null && typeof connectionService.acquire !== 'function') throw new TypeError('Database query connection service is invalid.');
    if (tunnelProvider !== null && typeof tunnelProvider?.open !== 'function') throw new TypeError('Database query tunnel provider is invalid.');
    this.profileService = profileService;
    this.secretStore = secretStore;
    this.runtimeRegistry = runtimeRegistry;
    this.connectionService = connectionService;
    this.localResourceResolver = localResourceResolver;
    this.tunnelProvider = tunnelProvider;
    this.historyRecorder = historyRecorder;
    this.active = new Map();
  }

  async executeReadPage(workspaceId, actorId, input = {}) {
    return this.execute(workspaceId, actorId, input, { requireReadOnly: true, recordHistory: false });
  }

  async execute(workspaceId, actorId, input = {}, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const request = normalizeQueryRequest(input);
    const profile = await this.profileService.get(tenant, request.profileId);
    if (!profile) throw Object.assign(new Error('Database profile was not found.'), { code: 'DATABASE_MANAGER_PROFILE_NOT_FOUND', category: 'database-manager' });
    const driverPolicy = typeof this.runtimeRegistry.getPolicy === 'function'
      ? this.runtimeRegistry.getPolicy(profile.driverId)
      : { sqlDialect: profile.driverId, query: true, readOnly: false };
    if (driverPolicy.query === false) {
      throw Object.assign(new Error('This database driver does not support query execution.'), { code: 'DATABASE_MANAGER_DRIVER_QUERY_UNSUPPORTED', category: 'database-manager', retryable: false });
    }
    const policyProfile = driverPolicy.readOnly && profile.accessMode !== 'read-only' ? { ...profile, accessMode: 'read-only' } : profile;
    const classification = classifySql(request.query, { dialect: driverPolicy.sqlDialect });
    if (options.requireReadOnly === true && classification.kind !== 'read') {
      throw Object.assign(new Error('Only read queries can be exported across all result pages.'), {
        code: 'DATABASE_MANAGER_RESULT_EXPORT_READ_REQUIRED',
        category: 'database-manager',
        retryable: false
      });
    }
    const policy = enforceSqlPolicy({ profile: policyProfile, classification, approval: normalizeApproval(input.approval), batch: request.batch });
    const key = operationKey(tenant, actor, request.requestId);
    if (this.active.has(key)) throw Object.assign(new Error('A database query with this request ID is already running.'), { code: 'DATABASE_MANAGER_QUERY_ALREADY_RUNNING', category: 'database-manager' });
    const controller = new AbortController();
    this.active.set(key, controller);
    let connection = null;
    let openSession = null;
    let driverAttempted = false;
    try {
      openSession = await this.connectionService?.acquire(tenant, actor, profile);
      const runtime = openSession?.runtime || this.runtimeRegistry.get(profile.driverId);
      if (!openSession?.runtimeSessionId || typeof runtime.executeSessionQuery !== 'function') {
        connection = await resolveRuntimeConnection({
          workspaceId: tenant,
          profile,
          secretStore: this.secretStore,
          localResourceResolver: this.localResourceResolver,
          tunnelProvider: this.tunnelProvider,
          signal: controller.signal
        });
      }
      driverAttempted = true;
      const statementQueries = request.batch ? splitSqlStatements(request.query, { dialect: driverPolicy.sqlDialect }) : [request.query];
      const results = [];
      for (let index = 0; index < statementQueries.length; index += 1) {
        const statementRequest = Object.freeze({
          ...request,
          query: statementQueries[index],
          page: statementQueries.length > 1 ? 1 : request.page,
          batch: false
        });
        try {
          const rawResult = openSession?.runtimeSessionId && typeof runtime.executeSessionQuery === 'function'
            ? await runtime.executeSessionQuery(openSession.runtimeSessionId, statementRequest, { timeoutMs: profile.queryTimeoutMs || 60000, signal: controller.signal })
            : await runtime.executeQuery(connection, statementRequest, { timeoutMs: profile.queryTimeoutMs || 60000, signal: controller.signal });
          const statementResult = normalizeQueryResult(rawResult);
          results.push(statementResult, ...statementResult.additionalResults);
        } catch (error) {
          if (statementQueries.length === 1) throw error;
          const safeMessage = `Batch stopped at statement ${index + 1}. ${String(error?.safeMessage || error?.message || 'The statement failed.').slice(0, 700)}`;
          throw Object.assign(new Error(safeMessage), {
            code: String(error?.code || 'DATABASE_MANAGER_QUERY_FAILED').slice(0, 120),
            safeMessage,
            category: String(error?.category || 'database-manager').slice(0, 80),
            retryable: Boolean(error?.retryable),
            details: { statementIndex: index + 1, completedStatementCount: results.length }
          });
        }
      }
      const [firstResult, ...additionalResults] = results;
      const totalExecutionTimeMs = results.reduce((total, item) => total + item.executionTimeMs, 0);
      const result = Object.freeze({
        ...firstResult,
        additionalResults: Object.freeze(additionalResults)
      });
      if (options.recordHistory !== false) {
        await this.#recordHistory(tenant, actor, request, policy.classification, {
          status: 'succeeded',
          executionTimeMs: totalExecutionTimeMs,
          rowCount: results.reduce((total, item) => total + item.rows.length, 0),
          affectedRows: results.reduce((total, item) => total + item.affectedRows, 0)
        });
      }
      return Object.freeze({
        requestId: request.requestId,
        profileId: profile.id,
        classification: policy.classification,
        statementCount: statementQueries.length,
        totalExecutionTimeMs,
        result
      });
    } catch (error) {
      if (driverAttempted && options.recordHistory !== false) {
        await this.#recordHistory(tenant, actor, request, policy.classification, {
          status: error?.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED' ? 'cancelled' : 'failed',
          errorCode: String(error?.code || 'DATABASE_MANAGER_QUERY_FAILED').slice(0, 120),
          safeMessage: String(error?.safeMessage || error?.message || 'The database query failed.').slice(0, 1000)
        });
      }
      throw error;
    } finally {
      await releaseRuntimeConnection(connection);
      await Promise.resolve(openSession?.release?.());
      this.active.delete(key);
    }
  }

  cancel(workspaceId, actorId, requestId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const id = requiredText(requestId, 'Database query request ID');
    const controller = this.active.get(operationKey(tenant, actor, id));
    if (controller) controller.abort();
    return Object.freeze({ requestId: id, cancelled: Boolean(controller) });
  }

  closeAll() {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  async #recordHistory(workspaceId, actorId, request, classification, outcome) {
    if (!this.historyRecorder) return;
    await Promise.resolve(this.historyRecorder(workspaceId, actorId, {
      profileId: request.profileId,
      query: request.query,
      source: request.source,
      classification,
      executionTimeMs: 0,
      rowCount: 0,
      affectedRows: 0,
      errorCode: null,
      safeMessage: null,
      ...outcome
    })).catch(() => {});
  }
}

module.exports = {
  DatabaseQueryService,
  normalizeApproval,
  operationKey
};
