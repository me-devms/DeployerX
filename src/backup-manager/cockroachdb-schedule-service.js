const { ADAPTER_ID } = require('./cockroachdb');
const { cockroachDbSourceReadiness, selectionFromSelector } = require('./cockroachdb-source-reader');
const {
  CockroachDbNativeScheduleError,
  CockroachDbNativeScheduleController,
  normalizeNativeSchedulePolicy,
  publicSchedulePlan
} = require('./cockroachdb-schedule');

const SERVICE_VERSION = '0.1.0';
const SCHEDULE_FIELD = 'cockroachNativeSchedule';
const MAXIMUM_JOBS = 1000;

class CockroachDbScheduleServiceError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CockroachDbScheduleServiceError';
    this.code = code;
    this.category = options.category || 'schedule';
    this.retryable = Boolean(options.retryable);
  }
}

function fail(code, message, category = 'schedule', retryable = false) {
  throw new CockroachDbScheduleServiceError(code, message, { category, retryable });
}

function publicReconciliationError(error) {
  const known = error instanceof CockroachDbScheduleServiceError || error instanceof CockroachDbNativeScheduleError;
  return {
    code: known ? error.code : 'COCKROACH_NATIVE_SCHEDULE_RECONCILIATION_FAILED',
    safeMessage: known ? error.message : 'CockroachDB native schedule reconciliation requires operator attention.'
  };
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function scheduleState(job) {
  const state = job?.adapterSettings?.[SCHEDULE_FIELD];
  return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
}

function publicRecord(job) {
  const state = scheduleState(job);
  if (!state) return null;
  return deepFreeze({
    version: 1,
    jobId: job.id,
    jobName: job.name,
    sourceId: job.sourceId,
    state: state.state === 'submitting' ? 'submission-ambiguous' : state.projection?.state || state.state,
    preparedAt: state.preparedAt || null,
    updatedAt: state.updatedAt || job.updatedAt,
    projection: state.projection || null,
    recovery: state.state === 'submitting'
      ? { recreateAllowed: false, operatorReviewRequired: true, reason: 'Native schedule submission may have crossed the process boundary before exact IDs were persisted.' }
      : null
  });
}

function rawSelection(source) {
  const selection = selectionFromSelector(source.selector);
  if (selection.scope === 'cluster') return { scope: 'cluster' };
  if (selection.scope === 'database') return { scope: 'database', database: selection.database };
  return { scope: 'table', tables: selection.tables.map(({ database, schema, name }) => ({ database, schema, name })) };
}

function rawDestination(connection) {
  const destination = connection?.cockroachdbBackupDestinationTrust?.destination;
  if (!destination || typeof destination !== 'object' || Array.isArray(destination)) {
    fail('COCKROACH_NATIVE_SCHEDULE_DESTINATION_UNAVAILABLE', 'Approve the exact CockroachDB external-connection destination before creating a native schedule.', 'configuration');
  }
  if (destination.externalConnectionName) return { type: 'external-connection', externalConnectionName: destination.externalConnectionName };
  return {
    type: 'external-connection',
    localities: Array.isArray(destination.localities)
      ? destination.localities.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName }))
      : null
  };
}

function normalizeRequestedPolicy(input, source, jobPolicy) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('CockroachDB native schedule policy must be an object.');
  if (input.revisionHistory !== undefined && input.revisionHistory !== source.physicalExecution.revisionHistory) {
    fail('COCKROACH_NATIVE_SCHEDULE_REVISION_HISTORY_CHANGED', 'The native schedule revision-history setting must match the enrolled CockroachDB Source.', 'compatibility');
  }
  const policy = normalizeNativeSchedulePolicy({ ...input, revisionHistory: source.physicalExecution.revisionHistory });
  const expectedMode = policy.mode === 'full-only' ? 'full' : 'incremental';
  if (jobPolicy.backupMode !== expectedMode) {
    fail('COCKROACH_NATIVE_SCHEDULE_JOB_MODE_INVALID', `Use a ${expectedMode} Backup Job for this CockroachDB native schedule mode.`, 'compatibility');
  }
  return {
    mode: policy.mode,
    recurringCron: policy.recurringCron,
    fullCron: policy.fullCron,
    revisionHistory: policy.revisionHistory,
    onPreviousRunning: policy.onPreviousRunning.requested,
    onExecutionFailure: policy.onExecutionFailure,
    firstRun: policy.firstRun,
    chainLimit: policy.chainLimit
  };
}

class CockroachDbScheduleService {
  constructor({ controlDatabase, connectionService, deviceId, controller = new CockroachDbNativeScheduleController(), clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !connectionService || typeof connectionService.withExecution !== 'function' || !controller || typeof clock !== 'function') {
      throw new TypeError('CockroachDB native schedule service dependencies are required.');
    }
    this.controlDatabase = controlDatabase;
    this.connectionService = connectionService;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.controller = controller;
    this.clock = clock;
  }

  async #load(workspaceId, jobId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(jobId, 'Backup Job ID', 200);
    const job = await this.controlDatabase.repository('backupJob').get(tenant, id);
    if (!job) fail('COCKROACH_NATIVE_SCHEDULE_JOB_NOT_FOUND', 'The CockroachDB Backup Job was not found.', 'not-found');
    const [source, policy] = await Promise.all([
      this.controlDatabase.repository('source').get(tenant, job.sourceId),
      this.controlDatabase.repository('policy').get(tenant, job.policyId)
    ]);
    if (!source || source.adapterId !== ADAPTER_ID || source.sourceType !== 'database') {
      fail('COCKROACH_NATIVE_SCHEDULE_SOURCE_INVALID', 'The Backup Job is not bound to an enrolled CockroachDB Source.', 'validation');
    }
    if (!policy || policy.schedule?.type !== 'manual') {
      fail('COCKROACH_NATIVE_SCHEDULE_LOCAL_CONFLICT', 'A CockroachDB native schedule requires a manual DeployerX Job policy to prevent duplicate scheduling.', 'conflict');
    }
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    const readiness = cockroachDbSourceReadiness(source, connection, this.deviceId);
    if (!readiness.ready) fail('COCKROACH_NATIVE_SCHEDULE_SOURCE_CHANGED', readiness.message, 'integrity', true);
    return { tenant, job, source, policy, connection };
  }

  #request(loaded, connectionConfig, inputPolicy) {
    const policy = normalizeRequestedPolicy(inputPolicy, loaded.source, loaded.policy);
    return {
      connection: connectionConfig,
      binding: loaded.source.physicalExecution.binding,
      sourceId: loaded.source.id,
      selection: rawSelection(loaded.source),
      destination: rawDestination(loaded.connection),
      policy
    };
  }

  async #updateJob(loaded, actorId, expectedState, nextState) {
    const actor = requiredText(actorId, 'Actor ID', 200);
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('backupJob', loaded.tenant, loaded.job.id);
      const currentState = scheduleState(current);
      const matches = expectedState === null ? currentState === null : currentState?.state === expectedState.state
        && (!expectedState.planDigest || currentState?.planDigest === expectedState.planDigest)
        && (!expectedState.ownershipFingerprint || currentState?.ownership?.ownershipFingerprint === expectedState.ownershipFingerprint);
      if (!current || !matches) fail('COCKROACH_NATIVE_SCHEDULE_STATE_CHANGED', 'CockroachDB native schedule ownership changed during the operation.', 'conflict');
      const adapterSettings = { ...(current.adapterSettings || {}), [SCHEDULE_FIELD]: nextState };
      return transaction.update('backupJob', loaded.tenant, current.id, { adapterSettings }, { expectedRevision: current.revision, actorId: actor });
    });
  }

  async preview(workspaceId, input = {}) {
    const loaded = await this.#load(workspaceId, input.jobId);
    return this.connectionService.withExecution(loaded.tenant, loaded.connection, input.signal, async (context, connectionConfig) => {
      const plan = await this.controller.plan(context, this.#request(loaded, connectionConfig, input.policy || {}));
      return deepFreeze({ jobId: loaded.job.id, jobName: loaded.job.name, ...publicSchedulePlan(plan) });
    });
  }

  async create(workspaceId, actorId, input = {}) {
    const actor = requiredText(actorId, 'Actor ID', 200);
    const loaded = await this.#load(workspaceId, input.jobId);
    if (scheduleState(loaded.job)) fail('COCKROACH_NATIVE_SCHEDULE_ALREADY_OWNED', 'This Backup Job already has a native schedule reservation or ownership record.', 'conflict');
    return this.connectionService.withExecution(loaded.tenant, loaded.connection, input.signal, async (context, connectionConfig) => {
      const plan = await this.controller.plan(context, this.#request(loaded, connectionConfig, input.policy || {}));
      let persisted = loaded.job;
      const result = await this.controller.create({
        ...context,
        assertNoOwnership: async () => scheduleState(await this.controlDatabase.repository('backupJob').get(loaded.tenant, loaded.job.id)) === null,
        onSubmissionPrepared: async (reservation) => {
          const now = this.clock();
          persisted = await this.#updateJob({ ...loaded, job: persisted }, actor, null, {
            version: 1,
            serviceVersion: SERVICE_VERSION,
            state: 'submitting',
            planDigest: reservation.planDigest,
            label: plan.label,
            labelDigest: reservation.labelDigest,
            preparedAt: reservation.preparedAt,
            updatedAt: now,
            ownership: null,
            projection: null
          });
        },
        onOwnership: async (ownership) => {
          const now = this.clock();
          persisted = await this.#updateJob({ ...loaded, job: persisted }, actor, { state: 'submitting', planDigest: ownership.planDigest }, {
            version: 1,
            serviceVersion: SERVICE_VERSION,
            state: 'owned',
            planDigest: ownership.planDigest,
            label: null,
            labelDigest: ownership.labelDigest,
            preparedAt: scheduleState(persisted)?.preparedAt || now,
            updatedAt: now,
            ownership,
            projection: null
          });
        }
      }, plan);
      persisted = await this.#updateJob({ ...loaded, job: persisted }, actor, { state: 'owned', ownershipFingerprint: result.ownership.ownershipFingerprint }, {
        ...scheduleState(persisted),
        state: 'owned',
        updatedAt: this.clock(),
        projection: result.public
      });
      return publicRecord(persisted);
    });
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const jobs = await this.controlDatabase.repository('backupJob').list(tenant, { limit: MAXIMUM_JOBS });
    if (jobs.length >= MAXIMUM_JOBS) fail('COCKROACH_NATIVE_SCHEDULE_SCAN_LIMIT', 'The native schedule catalog reached its bounded scan limit.', 'capacity');
    return jobs.map(publicRecord).filter(Boolean);
  }

  async #owned(workspaceId, jobId) {
    const loaded = await this.#load(workspaceId, jobId);
    const state = scheduleState(loaded.job);
    if (!state) fail('COCKROACH_NATIVE_SCHEDULE_NOT_FOUND', 'This Backup Job has no CockroachDB native schedule ownership.', 'not-found');
    if (state.state === 'submitting') fail('COCKROACH_NATIVE_SCHEDULE_SUBMISSION_AMBIGUOUS', 'Native schedule submission was interrupted before exact IDs were persisted. Operator review is required and automatic recreation is blocked.', 'conflict');
    if (state.state !== 'owned' || !state.ownership) fail('COCKROACH_NATIVE_SCHEDULE_OWNERSHIP_INVALID', 'The CockroachDB native schedule ownership record is invalid.', 'integrity');
    return { ...loaded, schedule: state };
  }

  async reconcile(workspaceId, actorId, jobId) {
    const actor = requiredText(actorId, 'Actor ID', 200);
    const loaded = await this.#owned(workspaceId, jobId);
    const result = await this.connectionService.withExecution(loaded.tenant, loaded.connection, null, (context, connectionConfig) => this.controller.reconcile(context, { connection: connectionConfig, ownership: loaded.schedule.ownership }));
    const persisted = await this.#updateJob(loaded, actor, { state: 'owned', ownershipFingerprint: loaded.schedule.ownership.ownershipFingerprint }, {
      ...loaded.schedule,
      updatedAt: this.clock(),
      projection: result.public
    });
    return publicRecord(persisted);
  }

  async reconcileAll(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const jobs = await this.controlDatabase.repository('backupJob').list(tenant, { limit: MAXIMUM_JOBS });
    if (jobs.length >= MAXIMUM_JOBS) fail('COCKROACH_NATIVE_SCHEDULE_SCAN_LIMIT', 'The native schedule catalog reached its bounded scan limit.', 'capacity');
    const results = [];
    for (const job of jobs.filter((candidate) => scheduleState(candidate))) {
      const state = scheduleState(job);
      if (state.state === 'submitting') {
        results.push(publicRecord(job));
        continue;
      }
      try { results.push(await this.reconcile(tenant, actor, job.id)); }
      catch (error) {
        results.push(deepFreeze({ jobId: job.id, sourceId: job.sourceId, state: 'attention-required', error: publicReconciliationError(error) }));
      }
    }
    return results;
  }

  async #control(workspaceId, actorId, jobId, operation) {
    const actor = requiredText(actorId, 'Actor ID', 200);
    const loaded = await this.#owned(workspaceId, jobId);
    const result = await this.connectionService.withExecution(loaded.tenant, loaded.connection, null, (context, connectionConfig) => this.controller[operation](context, { connection: connectionConfig, ownership: loaded.schedule.ownership }));
    const persisted = await this.#updateJob(loaded, actor, { state: 'owned', ownershipFingerprint: loaded.schedule.ownership.ownershipFingerprint }, {
      ...loaded.schedule,
      updatedAt: this.clock(),
      projection: result.public
    });
    return publicRecord(persisted);
  }

  pause(workspaceId, actorId, jobId) { return this.#control(workspaceId, actorId, jobId, 'pause'); }
  resume(workspaceId, actorId, jobId) { return this.#control(workspaceId, actorId, jobId, 'resume'); }
}

module.exports = {
  MAXIMUM_JOBS,
  SCHEDULE_FIELD,
  SERVICE_VERSION,
  CockroachDbScheduleService,
  CockroachDbScheduleServiceError,
  publicRecord,
  scheduleState
};
