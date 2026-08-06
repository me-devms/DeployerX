const { releaseRuntimeConnection, resolveRuntimeConnection } = require('./connection-context');
const { normalizeQueryRequest, normalizeQueryResult } = require('./domain');
const { enforceSqlPolicy } = require('./sql-safety');

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function operationKey(workspaceId, actorId, requestId) {
  return JSON.stringify([workspaceId, actorId, requestId]);
}

function normalizeApproval(input) {
  return Object.freeze({
    confirmed: input?.confirmed === true,
    typedProfileName: input?.typedProfileName === null || input?.typedProfileName === undefined ? null : String(input.typedProfileName).slice(0, 120)
  });
}

const DEFINITION_CLASSIFICATION = Object.freeze({ kind: 'destructive', statementCount: 1, malformed: false, statements: Object.freeze(['destructive']) });

class DatabaseDefinitionExecutor {
  constructor({ profileService, secretStore, runtimeRegistry, localResourceResolver = null, tunnelProvider = null } = {}) {
    if (!profileService?.get) throw new TypeError('DatabaseDefinitionExecutor requires the profile service.');
    if (!secretStore?.resolve) throw new TypeError('DatabaseDefinitionExecutor requires the shared secret store.');
    if (!runtimeRegistry?.get) throw new TypeError('DatabaseDefinitionExecutor requires a driver runtime registry.');
    if (localResourceResolver !== null && typeof localResourceResolver !== 'function') throw new TypeError('Database definition local resource resolver is invalid.');
    if (tunnelProvider !== null && typeof tunnelProvider?.open !== 'function') throw new TypeError('Database definition tunnel provider is invalid.');
    this.profileService = profileService;
    this.secretStore = secretStore;
    this.runtimeRegistry = runtimeRegistry;
    this.localResourceResolver = localResourceResolver;
    this.tunnelProvider = tunnelProvider;
    this.active = new Map();
  }

  async execute(workspaceId, actorId, input = {}) {
    return this.#execute(workspaceId, actorId, input);
  }

  async executePrepared(workspaceId, actorId, input = {}, preparation = {}) {
    if (typeof preparation.buildQuery !== 'function') throw new TypeError('Database definition query builder is invalid.');
    const secretRefId = preparation.secretRefId === null || preparation.secretRefId === undefined
      ? null
      : requiredText(preparation.secretRefId, 'Database definition secret reference ID');
    return this.#execute(workspaceId, actorId, input, async (tenant) => {
      if (secretRefId && preparation.secretType && this.secretStore.list) {
        const references = await this.secretStore.list(tenant);
        const reference = references.find((candidate) => candidate.id === secretRefId);
        if (!reference || reference.secretType !== preparation.secretType) {
          throw Object.assign(new Error('The saved database operation credential is unavailable or has the wrong type.'), { code: 'DATABASE_MANAGER_PRINCIPAL_PASSWORD_SECRET_INVALID', category: 'database-manager' });
        }
      }
      const secret = secretRefId ? await this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }) : null;
      try {
        return preparation.buildQuery(secret);
      } finally {
        // Keep the resolved value scoped to this callback and out of task, event, and history objects.
      }
    });
  }

  async #execute(workspaceId, actorId, input = {}, prepareQuery = null) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const request = normalizeQueryRequest({ ...input, page: 1, pageSize: 1, batch: false, source: 'schema' });
    const profile = await this.profileService.get(tenant, request.profileId);
    if (!profile) throw Object.assign(new Error('Database profile was not found.'), { code: 'DATABASE_MANAGER_PROFILE_NOT_FOUND', category: 'database-manager' });
    const policy = enforceSqlPolicy({ profile, classification: DEFINITION_CLASSIFICATION, approval: normalizeApproval(input.approval), batch: false });
    const key = operationKey(tenant, actor, request.requestId);
    if (this.active.has(key)) throw Object.assign(new Error('A database definition with this request ID is already running.'), { code: 'DATABASE_MANAGER_DEFINITION_ALREADY_RUNNING', category: 'database-manager' });
    const controller = new AbortController();
    this.active.set(key, controller);
    let connection = null;
    try {
      connection = await resolveRuntimeConnection({ workspaceId: tenant, profile, secretStore: this.secretStore, localResourceResolver: this.localResourceResolver, tunnelProvider: this.tunnelProvider, signal: controller.signal });
      const runtimeRequest = prepareQuery
        ? normalizeQueryRequest({ ...request, query: await prepareQuery(tenant), page: 1, pageSize: 1, batch: false, source: 'schema' })
        : request;
      const raw = await this.runtimeRegistry.get(profile.driverId).executeQuery(connection, runtimeRequest, { timeoutMs: profile.queryTimeoutMs || 60000, signal: controller.signal });
      const result = normalizeQueryResult(raw);
      return Object.freeze({ requestId: request.requestId, profileId: profile.id, classification: policy.classification, statementCount: 1, totalExecutionTimeMs: result.executionTimeMs, result });
    } finally {
      await releaseRuntimeConnection(connection);
      this.active.delete(key);
    }
  }

  cancel(workspaceId, actorId, requestId) {
    const key = operationKey(requiredText(workspaceId, 'Workspace ID'), requiredText(actorId || 'system', 'Actor ID'), requiredText(requestId, 'Database definition request ID'));
    const controller = this.active.get(key);
    if (controller) controller.abort();
    return Object.freeze({ requestId, cancelled: Boolean(controller) });
  }

  closeAll() {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }
}

module.exports = { DatabaseDefinitionExecutor, DEFINITION_CLASSIFICATION, operationKey };
