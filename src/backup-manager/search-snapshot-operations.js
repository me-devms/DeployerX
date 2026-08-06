const crypto = require('crypto');
const { ADAPTER_ID } = require('./search-snapshot');

const RESTORE_CONFIRMATION = 'RESTORE SEARCH ALTERNATE';
const CLEANUP_CONFIRMATION = 'CLEANUP SEARCH REPOSITORY';
const DRILL_CONFIRMATION = 'RUN SEARCH RECOVERY DRILL';
const METADATA_MODE = 'search-snapshot-metadata';
const DRILL_MODE = 'search-snapshot-full-drill';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const ACTIVE_STATES = new Set(['queued', 'preparing', 'running', 'validating', 'canceling']);
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

class SearchSnapshotOperationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'SearchSnapshotOperationError';
    this.code = code;
    this.category = options.category || 'operation';
    this.retryable = Boolean(options.retryable);
    this.details = options.details || {};
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new SearchSnapshotOperationError('SEARCH_OPERATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function safeError(error, fallback = 'SEARCH_OPERATION_FAILED') {
  if (error?.code && error?.category) return {
    code: String(error.code).slice(0, 100), category: String(error.category).slice(0, 50), retryable: Boolean(error.retryable),
    safeMessage: String(error.message || 'The search snapshot operation failed.').slice(0, 500),
    details: error.details && typeof error.details === 'object' ? Object.fromEntries(Object.entries(error.details).slice(0, 10).map(([key, value]) => [String(key).slice(0, 100), String(value).slice(0, 500)])) : {}
  };
  return { code: fallback, category: 'operation', retryable: false, safeMessage: 'DeployerX could not complete the search snapshot operation.', details: {} };
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function defaultPrefix(scopeId, kind = 'restore') {
  const label = kind === 'drill' ? 'dxdrill' : 'dxr';
  return `${label}-${crypto.createHash('sha256').update(scopeId).digest('hex').slice(0, 12)}-`;
}

async function loadRecoveryMetadata(controlDatabase, snapshotBrowser, workspaceId, recoveryPointId) {
  const point = await controlDatabase.repository('recoveryPoint').get(workspaceId, recoveryPointId);
  if (!point || point.type !== 'full' || point.consistency !== 'crash') throw new SearchSnapshotOperationError('SEARCH_RECOVERY_POINT_INVALID', 'Choose a crash-consistent full search snapshot recovery point.', { category: 'validation' });
  const source = await controlDatabase.repository('source').get(workspaceId, point.sourceId);
  if (!source || source.adapterId !== ADAPTER_ID) throw new SearchSnapshotOperationError('SEARCH_RECOVERY_POINT_INVALID', 'The selected recovery point is not a native search snapshot.', { category: 'validation' });
  const opened = await snapshotBrowser.openAuthenticatedSnapshot(workspaceId, point.id);
  const file = (opened.manifest.files || []).find((entry) => entry.type === 'file' && entry.path === 'search/snapshot-metadata.json' && entry.metadata?.externalNativeMedia === true && entry.metadata?.database?.adapterId === ADAPTER_ID);
  if (!file || Number(file.sizeBytes) < 1 || Number(file.sizeBytes) > MAX_METADATA_BYTES) throw new SearchSnapshotOperationError('SEARCH_RECOVERY_METADATA_INVALID', 'The authenticated search recovery metadata artifact is missing or invalid.', { category: 'integrity' });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of opened.engine.streamFile({}, { repositoryId: opened.copy.repositoryId, manifest: opened.manifest, path: file.path, masterKey: opened.masterKey })) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_METADATA_BYTES) throw new SearchSnapshotOperationError('SEARCH_RECOVERY_METADATA_INVALID', 'The authenticated search recovery metadata exceeds its size limit.', { category: 'integrity' });
    chunks.push(Buffer.from(chunk));
  }
  let metadata;
  try { metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SearchSnapshotOperationError('SEARCH_RECOVERY_METADATA_INVALID', 'The authenticated search recovery metadata is not valid JSON.', { category: 'integrity' }); }
  if (!metadata || metadata.kind !== 'search-native-snapshot' || metadata.adapterId !== ADAPTER_ID || metadata.snapshot?.state !== 'SUCCESS' || metadata.sourceId !== source.id || metadata.workspaceDigest !== digest(workspaceId)) throw new SearchSnapshotOperationError('SEARCH_RECOVERY_METADATA_INVALID', 'The authenticated search recovery metadata identity is incomplete.', { category: 'integrity' });
  return { point, source, opened, metadata };
}

async function connectionContext(controlDatabase, secretStore, adapter, deviceId, workspaceId, connectionId) {
  const connection = await controlDatabase.repository('connection').get(workspaceId, requiredText(connectionId, 'Search target connection ID', 200));
  if (!connection || connection.adapterId !== ADAPTER_ID) throw new SearchSnapshotOperationError('SEARCH_TARGET_CONNECTION_INVALID', 'Choose a tested Elasticsearch or OpenSearch connection.', { category: 'validation' });
  if (!(connection.workerAffinity || []).includes(`device:${deviceId}`)) throw new SearchSnapshotOperationError('SEARCH_TARGET_OTHER_DEVICE', 'Search recovery must run on the target connection device.', { category: 'authorization' });
  if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new SearchSnapshotOperationError('SEARCH_TARGET_CONNECTION_UNHEALTHY', 'Test the search target connection successfully before continuing.', { category: 'connectivity', retryable: true });
  const [credentialSecretRefId] = connection.secretRefIds || [];
  const config = adapter.normalizeConfig({ ...connection.endpoint, credentialSecretRefId });
  return { connection, config, context: { resolveSecret: (id) => secretStore.resolve({ workspaceId, id }) } };
}

function publicPlan(plan) {
  return {
    planDigest: plan.planDigest, product: plan.product, sourceClusterUuid: plan.sourceClusterUuid, targetClusterUuid: plan.targetClusterUuid,
    repositoryName: plan.repositoryName, snapshotName: plan.snapshotName, snapshotUuid: plan.snapshotUuid,
    compatibility: plan.compatibility, renamePrefix: plan.renamePrefix, selection: plan.selection, preview: plan.preview,
    featureStates: plan.featureStates, includeGlobalState: false
  };
}

class SearchSnapshotRestoreService {
  constructor({ controlDatabase, secretStore, snapshotBrowser, adapter, deviceId, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !snapshotBrowser || !adapter) throw new TypeError('Search snapshot restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.snapshotBrowser = snapshotBrowser;
    this.adapter = adapter;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.clock = clock;
    this.active = new Map();
  }

  async #prepare(workspaceId, input) {
    const recoveryPointId = requiredText(input.recoveryPointId, 'Recovery point ID', 200);
    const selected = await loadRecoveryMetadata(this.controlDatabase, this.snapshotBrowser, workspaceId, recoveryPointId);
    const target = await connectionContext(this.controlDatabase, this.secretStore, this.adapter, this.deviceId, workspaceId, input.targetConnectionId);
    const owner = { workspaceId, sourceId: selected.source.id, executionId: selected.point.runId };
    const renamePrefix = input.renamePrefix || defaultPrefix(recoveryPointId);
    const plan = await this.adapter.planRestore(target.context, { connection: target.config, metadata: selected.metadata, renamePrefix, selectedResources: input.selectedResources, featureStates: input.featureStates, owner });
    return { ...selected, target, owner, plan };
  }

  async preview(workspaceId, input = {}) {
    return publicPlan((await this.#prepare(requiredText(workspaceId, 'Workspace ID', 200), input)).plan);
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION) throw new SearchSnapshotOperationError('SEARCH_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the alternate search restore before continuing.', { category: 'conflict' });
    const prepared = await this.#prepare(tenant, input);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [prepared.point.id], targetConnectionId: prepared.target.connection.id,
      target: { operation: 'search-native-alternate', mode: 'alternate', engine: 'search-cluster', sourceId: prepared.source.id, connectionId: prepared.target.connection.id, renamePrefix: prepared.plan.renamePrefix, preview: prepared.plan.preview, planDigest: prepared.plan.planDigest },
      mode: 'alternate', conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: prepared.plan.preview.length, itemsCompleted: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, input, prepared.plan.planDigest, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'search-cluster') throw new SearchSnapshotOperationError('SEARCH_RESTORE_RUN_NOT_FOUND', 'The search RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'search-cluster') throw new SearchSnapshotOperationError('SEARCH_RESTORE_RUN_NOT_FOUND', 'The search RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(record.id);
    if (!active) throw new SearchSnapshotOperationError('SEARCH_RESTORE_NOT_ACTIVE', 'The search restore is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, record.id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.engine === 'search-cluster');
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.list(tenant, { limit: 200 });
    const projected = [];
    for (const record of records.filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      projected.push(await this.#project(tenant, record.id, {
        state: 'interrupted', completedAt: null, progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() },
        result: { state: 'interrupted', cleanupRequired: true, createdTargets: record.target?.preview?.map((item) => item.targetName) || [], error: { code: 'SEARCH_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage: 'Search restore monitoring was interrupted. Any created alternate targets were preserved for operator validation or cleanup.' }, completedAt: null }
      }, actorId));
    }
    return projected;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #execute(workspaceId, actorId, restoreRunId, input, expectedPlanDigest, signal) {
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', startedAt: progress.startedAt, progress }, actorId);
      const prepared = await this.#prepare(workspaceId, input);
      if (prepared.plan.planDigest !== expectedPlanDigest) throw new SearchSnapshotOperationError('SEARCH_RESTORE_PLAN_CHANGED', 'Search restore state changed after confirmation.', { category: 'conflict' });
      progress = { ...progress, phase: 'running', itemsTotal: prepared.plan.preview.length, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      const result = await this.adapter.executeRestore({ ...prepared.target.context, signal, owner: prepared.owner }, prepared.plan);
      progress = { ...progress, phase: 'validating', itemsCompleted: prepared.plan.preview.length, updatedAt: this.clock(), warnings: result.state === 'warning' ? ['Replica allocation remains incomplete.'] : [] };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const validation = await this.adapter.validateRestore(prepared.target.context, { plan: prepared.plan, result });
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, {
        state: result.state, completedAt: this.clock(), progress, validation,
        result: { state: result.state, recoveryPointId: prepared.point.id, targetClusterUuid: prepared.plan.targetClusterUuid, renamePrefix: prepared.plan.renamePrefix, restoredResources: validation.restoredResources, warnings: progress.warnings, cancellationRollbackSupported: false, completedAt: this.clock() }
      }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.code === 'SEARCH_RESTORE_CANCELED';
        return this.#project(workspaceId, restoreRunId, {
          state: canceled ? 'canceled' : 'failed', completedAt: this.clock(), progress: { ...progress, phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() },
          result: { state: canceled ? 'canceled' : 'failed', cleanupRequired: canceled, createdTargets: current.target?.preview?.map((item) => item.targetName) || [], error: safeError(error, 'SEARCH_RESTORE_FAILED'), completedAt: this.clock() }
        }, actorId);
      }
      throw error;
    }
  }
}

class SearchSnapshotMaintenanceService {
  constructor({ controlDatabase, secretStore, snapshotBrowser, adapter, deviceId, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !snapshotBrowser || !adapter) throw new TypeError('Search snapshot maintenance dependencies are required.');
    this.controlDatabase = controlDatabase; this.secretStore = secretStore; this.snapshotBrowser = snapshotBrowser; this.adapter = adapter;
    this.deviceId = requiredText(deviceId, 'Device ID', 200); this.clock = clock;
  }

  async #retentionPlan(workspaceId, recoveryPointId) {
    const selected = await loadRecoveryMetadata(this.controlDatabase, this.snapshotBrowser, workspaceId, recoveryPointId);
    if (selected.point.retention?.deletionEligible !== true || selected.point.legalHold || selected.point.retention?.legalHold || selected.point.retention?.nativeMedia?.state === 'deleted') throw new SearchSnapshotOperationError('SEARCH_RETENTION_POINT_PROTECTED', 'The search recovery point is not eligible for native snapshot deletion.', { category: 'conflict' });
    const sourceConnection = await connectionContext(this.controlDatabase, this.secretStore, this.adapter, this.deviceId, workspaceId, selected.source.connectionId);
    const owner = { workspaceId, sourceId: selected.source.id, executionId: selected.point.runId };
    const inspected = await this.adapter.inspectRecoverySnapshot(sourceConnection.context, { connection: sourceConnection.config, metadata: selected.metadata, owner });
    if (inspected.identity.clusterUuid !== selected.metadata.clusterUuid || inspected.repository.readOnly) throw new SearchSnapshotOperationError('SEARCH_RETENTION_WRITER_CHANGED', 'Search retention must run through the verified native repository writer cluster.', { category: 'authorization' });
    const plan = { recoveryPointId: selected.point.id, recoveryPointRevision: selected.point.revision, sourceId: selected.source.id, connectionId: sourceConnection.connection.id, snapshotName: inspected.snapshot.snapshot, snapshotUuid: inspected.snapshot.uuid, repositoryName: inspected.repository.name, repositoryFingerprint: inspected.repository.repositoryFingerprint };
    return { ...selected, sourceConnection, owner, plan: { ...plan, planId: digest(plan) } };
  }

  async planRetention(workspaceId, recoveryPointId) { return (await this.#retentionPlan(requiredText(workspaceId, 'Workspace ID', 200), requiredText(recoveryPointId, 'Recovery point ID', 200))).plan; }

  async executeRetention(workspaceId, actorId, recoveryPointId, expectedPlanId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const actor = requiredText(actorId, 'Actor ID', 200);
    const prepared = await this.#retentionPlan(tenant, requiredText(recoveryPointId, 'Recovery point ID', 200));
    if (prepared.plan.planId !== expectedPlanId) throw new SearchSnapshotOperationError('SEARCH_RETENTION_PLAN_STALE', 'Search retention state changed after the dry-run plan.', { category: 'conflict' });
    const deletion = await this.adapter.deleteRecoverySnapshot(prepared.sourceConnection.context, { connection: prepared.sourceConnection.config, metadata: prepared.metadata, owner: prepared.owner });
    const current = await this.controlDatabase.repository('recoveryPoint').get(tenant, prepared.point.id);
    if (!current || current.revision !== prepared.point.revision || current.retention?.deletionEligible !== true) throw new SearchSnapshotOperationError('SEARCH_RETENTION_PLAN_STALE', 'The recovery point changed during native snapshot deletion.', { category: 'conflict' });
    const retention = { ...current.retention, nativeMedia: { state: 'deleted', snapshotName: deletion.snapshotName, deletedAt: deletion.deletedAt, planId: expectedPlanId } };
    const point = await this.controlDatabase.transaction((transaction) => transaction.projectRecoveryPointRetention(tenant, current.id, retention, { expectedRevision: current.revision, actorId: actor }));
    return { plan: prepared.plan, deletion, recoveryPoint: point };
  }

  async cleanupRepository(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); requiredText(actorId, 'Actor ID', 200);
    if (String(input.confirmationText || '').trim() !== CLEANUP_CONFIRMATION) throw new SearchSnapshotOperationError('SEARCH_REPOSITORY_CLEANUP_CONFIRMATION_REQUIRED', 'Confirm native search repository cleanup before continuing.', { category: 'conflict' });
    const active = [];
    for (const type of ['run', 'restoreRun', 'verificationRun']) active.push(...(await this.controlDatabase.repository(type).list(tenant, { limit: 1000 })).filter((record) => ACTIVE_STATES.has(record.state)));
    if (active.length) throw new SearchSnapshotOperationError('SEARCH_REPOSITORY_BUSY', 'Search repository cleanup requires no active Backup Manager operations.', { category: 'conflict' });
    const target = await connectionContext(this.controlDatabase, this.secretStore, this.adapter, this.deviceId, tenant, input.connectionId);
    return this.adapter.cleanupRepository(target.context, { connection: target.config, repositoryName: input.repositoryName, repositoryFingerprint: input.repositoryFingerprint, confirmationText: CLEANUP_CONFIRMATION });
  }
}

class SearchSnapshotRecoveryTestService {
  constructor({ controlDatabase, secretStore, snapshotBrowser, adapter, restoreService, deviceId, notificationService = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !snapshotBrowser || !adapter || !restoreService) throw new TypeError('Search snapshot recovery-test dependencies are required.');
    this.controlDatabase = controlDatabase; this.secretStore = secretStore; this.snapshotBrowser = snapshotBrowser; this.adapter = adapter; this.restoreService = restoreService;
    this.deviceId = requiredText(deviceId, 'Device ID', 200); this.notificationService = notificationService; this.clock = clock; this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const actor = requiredText(actorId, 'Actor ID', 200);
    const mode = String(input.mode || METADATA_MODE);
    if (![METADATA_MODE, DRILL_MODE].includes(mode)) throw new SearchSnapshotOperationError('SEARCH_VERIFICATION_MODE_INVALID', 'Choose metadata validation or a full alternate restore drill.', { category: 'validation' });
    if (mode === DRILL_MODE && (input.confirmed !== true || String(input.confirmationText || '').trim() !== DRILL_CONFIRMATION)) throw new SearchSnapshotOperationError('SEARCH_DRILL_CONFIRMATION_REQUIRED', 'Confirm the full alternate search recovery drill before continuing.', { category: 'conflict' });
    const selected = await loadRecoveryMetadata(this.controlDatabase, this.snapshotBrowser, tenant, requiredText(input.recoveryPointId, 'Recovery point ID', 200));
    const now = this.clock();
    const record = await this.controlDatabase.repository('verificationRun').create({ workspaceId: tenant, actorId: actor, scopeType: 'recovery-point', scopeId: selected.point.id, recoveryPointId: selected.point.id, repositoryId: null, mode, targetConnectionId: input.targetConnectionId || null, workerId: `device:${this.deviceId}`, state: 'queued', progress: { phase: 'queued', startedAt: null, updatedAt: now }, result: null });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, input, selected, controller.signal).catch(() => this.controlDatabase.repository('verificationRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller, restoreRunId: null }); operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, id) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const runId = requiredText(id, 'Verification run ID', 200);
    if (this.active.has(runId)) await this.active.get(runId).operation;
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, runId);
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new SearchSnapshotOperationError('SEARCH_VERIFICATION_NOT_FOUND', 'The search recovery test was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, id) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const runId = requiredText(id, 'Verification run ID', 200); requiredText(actorId, 'Actor ID', 200);
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, runId);
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new SearchSnapshotOperationError('SEARCH_VERIFICATION_NOT_FOUND', 'The search recovery test was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(record.id); if (!active) throw new SearchSnapshotOperationError('SEARCH_VERIFICATION_NOT_ACTIVE', 'The search recovery test is not active in this process.', { category: 'conflict' });
    active.controller.abort(); if (active.restoreRunId) await this.restoreService.cancel(tenant, actorId, active.restoreRunId).catch(() => {}); await active.operation;
    return this.controlDatabase.repository('verificationRun').get(tenant, record.id);
  }

  async list(workspaceId, options = {}) { return (await this.controlDatabase.repository('verificationRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => [METADATA_MODE, DRILL_MODE].includes(record.mode)); }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const records = await this.list(tenant, { limit: 200 }); const result = [];
    for (const record of records.filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) result.push(await this.#project(tenant, record.id, { state: 'interrupted', progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() }, result: { state: 'interrupted', cleanupUncertain: record.mode === DRILL_MODE, error: { code: 'SEARCH_VERIFICATION_PROCESS_INTERRUPTED', category: 'verification', retryable: false, safeMessage: record.mode === DRILL_MODE ? 'The full search recovery drill was interrupted; verify the alternate target namespace before cleanup.' : 'Search snapshot metadata validation was interrupted.' }, completedAt: null } }, actorId));
    return result;
  }

  async #project(workspaceId, id, changes, actorId) { return this.controlDatabase.transaction((transaction) => { const current = transaction.get('verificationRun', workspaceId, id); return transaction.projectExecution('verificationRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId }); }); }
  async #notify(workspaceId, run) { if (this.notificationService && ['succeeded', 'warning', 'failed', 'interrupted'].includes(run?.state)) await this.notificationService.notifyVerificationRun(workspaceId, run).catch(() => {}); }

  async #execute(workspaceId, actorId, verificationRunId, input, selected, signal) {
    try {
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt: this.clock(), progress: { phase: selected ? 'validating-native-snapshot' : 'running', startedAt: this.clock(), updatedAt: this.clock() } }, actorId);
      if (signal.aborted) throw new SearchSnapshotOperationError('SEARCH_VERIFICATION_CANCELED', 'The search recovery test was canceled.', { category: 'canceled' });
      if (String(input.mode || METADATA_MODE) === METADATA_MODE) {
        const sourceTarget = await connectionContext(this.controlDatabase, this.secretStore, this.adapter, this.deviceId, workspaceId, selected.source.connectionId);
        const inspected = await this.adapter.inspectRecoverySnapshot({ ...sourceTarget.context, signal }, { connection: sourceTarget.config, metadata: selected.metadata, owner: { workspaceId, sourceId: selected.source.id, executionId: selected.point.runId } });
        const completed = await this.#project(workspaceId, verificationRunId, { state: 'succeeded', completedAt: this.clock(), progress: { phase: 'complete', startedAt: this.clock(), updatedAt: this.clock() }, evidence: { verificationClass: 'metadata-only', repositoryVerified: true, snapshotState: inspected.snapshot.state, shards: inspected.snapshot.shards, exactMembership: true, fullRestorePerformed: false }, result: { state: 'succeeded', mode: METADATA_MODE, recoveryPointId: selected.point.id, completedAt: this.clock() } }, actorId);
        await this.#notify(workspaceId, completed); return completed;
      }
      const prefix = defaultPrefix(verificationRunId, 'drill');
      const startedRestore = await this.restoreService.start(workspaceId, actorId, { recoveryPointId: selected.point.id, targetConnectionId: requiredText(input.targetConnectionId, 'Search drill target connection ID', 200), renamePrefix: prefix, selectedResources: input.selectedResources, featureStates: input.featureStates, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
      const active = this.active.get(verificationRunId); if (active) active.restoreRunId = startedRestore.id;
      await this.#project(workspaceId, verificationRunId, { restoreRunId: startedRestore.id, progress: { phase: 'restoring', startedAt: this.clock(), updatedAt: this.clock() } }, actorId);
      const restored = await this.restoreService.wait(workspaceId, startedRestore.id);
      if (!['succeeded', 'warning'].includes(restored.state) || restored.validation?.nativeIntegrityValidation !== true) throw new SearchSnapshotOperationError('SEARCH_DRILL_RESTORE_FAILED', 'The full search recovery drill did not pass native restore validation.', { category: 'integrity' });
      const target = await connectionContext(this.controlDatabase, this.secretStore, this.adapter, this.deviceId, workspaceId, input.targetConnectionId);
      await this.#project(workspaceId, verificationRunId, { progress: { phase: 'cleaning-up', startedAt: this.clock(), updatedAt: this.clock() } }, actorId);
      const cleanup = await this.adapter.deleteDrillResources(target.context, { connection: target.config, targetClusterUuid: restored.result.targetClusterUuid, resources: restored.validation.restoredResources });
      const completed = await this.#project(workspaceId, verificationRunId, { state: restored.state, completedAt: this.clock(), progress: { phase: 'complete', startedAt: this.clock(), updatedAt: this.clock() }, evidence: { verificationClass: 'full-restore-drill', fullRestorePerformed: true, nativeIntegrityValidation: true, expectedObjects: 'pass', targetDestroyed: cleanup.deleted, restoredResources: restored.validation.restoredResources }, result: { state: restored.state, mode: DRILL_MODE, recoveryPointId: selected.point.id, restoreRunId: restored.id, warnings: restored.result.warnings || [], completedAt: this.clock() } }, actorId);
      await this.#notify(workspaceId, completed); return completed;
    } catch (error) {
      const current = await this.controlDatabase.repository('verificationRun').get(workspaceId, verificationRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.category === 'canceled';
        const failed = await this.#project(workspaceId, verificationRunId, { state: canceled ? 'canceled' : 'failed', completedAt: this.clock(), progress: { ...(current.progress || {}), phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, result: { state: canceled ? 'canceled' : 'failed', cleanupUncertain: current.mode === DRILL_MODE, error: safeError(error, 'SEARCH_VERIFICATION_FAILED'), completedAt: this.clock() } }, actorId);
        await this.#notify(workspaceId, failed); return failed;
      }
      throw error;
    }
  }
}

module.exports = {
  CLEANUP_CONFIRMATION, DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, RESTORE_CONFIRMATION,
  SearchSnapshotMaintenanceService, SearchSnapshotOperationError, SearchSnapshotRecoveryTestService, SearchSnapshotRestoreService,
  defaultPrefix, loadRecoveryMetadata, publicPlan
};
