const crypto = require('crypto');
const { ADAPTER_ID, stableDigest } = require('./scylla-manager');

const RESTORE_CONFIRMATION = 'RESTORE SCYLLA MANAGER ALTERNATE';
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const SUCCESS_RUN_STATES = new Set(['done', 'success', 'succeeded']);
const FAILED_RUN_STATES = new Set(['aborted', 'error', 'failed', 'stopped']);

class ScyllaManagerRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'ScyllaManagerRestoreError';
    this.code = code;
    this.category = options.category || 'restore';
    this.retryable = Boolean(options.retryable);
    this.details = options.details || {};
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function safeError(error, fallback = 'SCYLLA_MANAGER_RESTORE_FAILED') {
  if (error?.code) return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 50), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The Manager restore failed.').slice(0, 500) };
  return { code: fallback, category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the ScyllaDB Manager restore.' };
}

function versionMajor(value) {
  const match = /^(?:v)?(\d+)[.]/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function normalizeSelection(metadata, input) {
  const available = metadata.target.units.flatMap((unit) => unit.allTables ? [`${unit.keyspace}.*`] : unit.tables.map((table) => `${unit.keyspace}.${table}`)).sort();
  const selected = input === undefined || input === null ? available : [...new Set((Array.isArray(input) ? input : []).map((item) => requiredText(item, 'Manager restore selection', 512)))].sort();
  if (!selected.length || selected.some((pattern) => !available.includes(pattern))) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_SELECTION_INVALID', 'The Manager restore selection is empty or outside the authenticated recovery point.', { category: 'validation' });
  return selected;
}

async function loadRecoveryMetadata(controlDatabase, snapshotBrowser, workspaceId, recoveryPointId) {
  const point = await controlDatabase.repository('recoveryPoint').get(workspaceId, recoveryPointId);
  if (!point || !['full', 'native'].includes(point.type) || point.consistency !== 'crash') throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RECOVERY_POINT_INVALID', 'Choose a crash-consistent ScyllaDB Manager recovery point.', { category: 'validation' });
  const source = await controlDatabase.repository('source').get(workspaceId, point.sourceId);
  if (!source || source.adapterId !== ADAPTER_ID) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RECOVERY_POINT_INVALID', 'The selected recovery point is not a ScyllaDB Manager backup.', { category: 'validation' });
  const opened = await snapshotBrowser.openAuthenticatedSnapshot(workspaceId, point.id);
  const file = (opened.manifest.files || []).find((entry) => entry.type === 'file' && entry.path === 'scylla-manager/backup-metadata.json' && entry.metadata?.externalNativeMedia === true && entry.metadata?.database?.adapterId === ADAPTER_ID);
  if (!file || Number(file.sizeBytes) < 1 || Number(file.sizeBytes) > MAX_METADATA_BYTES) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RECOVERY_METADATA_INVALID', 'The authenticated Manager recovery metadata artifact is missing or invalid.', { category: 'integrity' });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of opened.engine.streamFile({}, { repositoryId: opened.copy.repositoryId, manifest: opened.manifest, path: file.path, masterKey: opened.masterKey })) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_METADATA_BYTES) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RECOVERY_METADATA_INVALID', 'The authenticated Manager metadata exceeds its size limit.', { category: 'integrity' });
    chunks.push(Buffer.from(chunk));
  }
  let metadata;
  try { metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RECOVERY_METADATA_INVALID', 'The authenticated Manager metadata is not valid JSON.', { category: 'integrity' }); }
  if (!metadata || metadata.kind !== 'scylla-manager-backup' || metadata.adapterId !== ADAPTER_ID || metadata.state !== 'succeeded' || metadata.externalNativeMedia !== true || metadata.authoritativeOwner !== 'scylla-manager' || metadata.sourceId !== source.id || metadata.workspaceDigest !== stableDigest(workspaceId) || !metadata.snapshotTag || metadata.catalog?.taskId !== metadata.taskId || !metadata.catalog?.snapshots?.some((snapshot) => snapshot.snapshotTag === metadata.snapshotTag)) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RECOVERY_METADATA_INVALID', 'The authenticated Manager recovery identity is incomplete.', { category: 'integrity' });
  return { point, source, opened, metadata };
}

async function connectionContext(controlDatabase, secretStore, adapter, deviceId, workspaceId, connectionId) {
  const connection = await controlDatabase.repository('connection').get(workspaceId, requiredText(connectionId, 'Manager target connection ID', 200));
  if (!connection || connection.adapterId !== ADAPTER_ID) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_TARGET_CONNECTION_INVALID', 'Choose a tested ScyllaDB Manager connection.', { category: 'validation' });
  if (!(connection.workerAffinity || []).includes(`device:${deviceId}`)) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_TARGET_OTHER_DEVICE', 'Manager recovery must run on the target connection device.', { category: 'authorization' });
  if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint || connection.clusterInventory?.healthy !== true) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_TARGET_UNHEALTHY', 'Retest the alternate Manager connection with every agent, CQL endpoint, and REST endpoint up.', { category: 'connectivity', retryable: true });
  const config = adapter.normalizeConfig({ ...connection.endpoint, credentialSecretRefId: connection.secretRefIds?.[0] || null });
  return { connection, config, context: { resolveSecret: (id) => secretStore.resolve({ workspaceId, id }) } };
}

function restoreProperties(metadata, selection, input, phase) {
  return {
    location: metadata.target.locations.map((item) => item.location),
    snapshot_tag: metadata.snapshotTag,
    keyspace: selection,
    restore_schema: phase === 'schema',
    restore_tables: phase === 'tables',
    dc_mapping: Array.isArray(input.dataCenterMapping) ? input.dataCenterMapping.map((item) => requiredText(item, 'Manager data-center mapping', 512)) : [],
    batch_size: Number(input.batchSize || 0), parallel: Number(input.parallel || 0), transfers: Number(input.transfers || 0),
    rate_limit: Array.isArray(input.rateLimit) ? input.rateLimit.map((item) => requiredText(item, 'Manager restore rate limit', 512)) : [],
    allow_compaction: input.allowCompaction === true, unpin_agent_cpu: input.unpinAgentCpu === true
  };
}

function publicPlan(prepared) {
  return {
    planDigest: prepared.planDigest, recoveryPointId: prepared.point.id, sourceManagedClusterId: prepared.metadata.managedClusterId,
    targetManagedClusterId: prepared.target.config.managedClusterId, snapshotTag: prepared.metadata.snapshotTag,
    locations: prepared.metadata.target.locations, selection: prepared.selection, dataCenterMapping: prepared.input.dataCenterMapping || [],
    managerCompatibility: prepared.managerCompatibility, scyllaCompatibility: prepared.scyllaCompatibility,
    phases: [{ id: 'schema', order: 1, target: prepared.schemaTarget }, { id: 'tables', order: 2, dryRunAfterSchema: true }],
    destructiveOriginalClusterActions: false, cancellationRollbackSupported: false
  };
}

class ScyllaManagerRestoreService {
  constructor({ controlDatabase, secretStore, snapshotBrowser, adapter, deviceId, clock = () => new Date().toISOString(), now = () => Date.now(), delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), maximumWaitMs = MAX_WAIT_MS } = {}) {
    if (!controlDatabase || !secretStore || !snapshotBrowser || !adapter) throw new TypeError('ScyllaDB Manager restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.snapshotBrowser = snapshotBrowser;
    this.adapter = adapter;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.clock = clock;
    this.now = now;
    this.delay = delay;
    this.maximumWaitMs = Math.min(MAX_WAIT_MS, Math.max(1000, Number(maximumWaitMs) || MAX_WAIT_MS));
    this.active = new Map();
  }

  async #prepare(workspaceId, input = {}) {
    const recoveryPointId = requiredText(input.recoveryPointId, 'Recovery point ID', 200);
    const selected = await loadRecoveryMetadata(this.controlDatabase, this.snapshotBrowser, workspaceId, recoveryPointId);
    const target = await connectionContext(this.controlDatabase, this.secretStore, this.adapter, this.deviceId, workspaceId, input.targetConnectionId);
    const environment = await this.adapter.readEnvironment(target.context, target.config);
    if (!environment.status.healthy) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_TARGET_UNHEALTHY', 'Every alternate-cluster Manager agent, CQL endpoint, and REST endpoint must be up.', { category: 'unavailable', retryable: true });
    if (environment.cluster.id === selected.metadata.managedClusterId || environment.deploymentFingerprint === selected.metadata.deploymentFingerprint) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_TARGET_NOT_ALTERNATE', 'ScyllaDB Manager recovery requires a separately tested managed cluster.', { category: 'conflict' });
    const managerCompatibility = versionMajor(environment.version.text) === versionMajor(selected.metadata.managerVersion);
    const sourceScyllaMajors = [...new Set((selected.metadata.scyllaVersions || []).map(versionMajor))];
    const targetScyllaMajors = [...new Set(environment.status.nodes.map((node) => versionMajor(node.scyllaVersion)))];
    const scyllaCompatibility = sourceScyllaMajors.length === 1 && targetScyllaMajors.length === 1 && sourceScyllaMajors[0] === targetScyllaMajors[0];
    if (!managerCompatibility || !scyllaCompatibility) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_VERSION_INCOMPATIBLE', 'Manager or ScyllaDB major versions are incompatible with this recovery point.', { category: 'compatibility' });
    const selection = normalizeSelection(selected.metadata, input.selectedTables);
    const ownerSuffix = crypto.createHash('sha256').update(`${workspaceId}\0${recoveryPointId}\0${target.connection.id}`).digest('hex').slice(0, 20);
    const labels = { 'deployerx.owner': 'deployerx', 'deployerx.operation': 'restore', 'deployerx.execution': ownerSuffix, 'deployerx.source': selected.source.id };
    const schemaTaskUpdate = { name: `deployerx-restore-schema-${ownerSuffix}`, type: 'restore', labels: { ...labels, 'deployerx.phase': 'schema' }, enabled: false, schedule: {}, properties: restoreProperties(selected.metadata, selection, input, 'schema') };
    const schemaTarget = await this.adapter.restoreTarget(target.context, { connection: target.config, taskUpdate: schemaTaskUpdate });
    if (schemaTarget.snapshotTag !== selected.metadata.snapshotTag) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_TARGET_CHANGED', 'Manager resolved a different snapshot tag during schema dry-run.', { category: 'integrity' });
    const planInput = { recoveryPointId, sourceManagedClusterId: selected.metadata.managedClusterId, targetManagedClusterId: target.config.managedClusterId, snapshotTag: selected.metadata.snapshotTag, locations: selected.metadata.target.locations, selection, dataCenterMapping: input.dataCenterMapping || [], schemaTargetFingerprint: schemaTarget.targetFingerprint, ownerSuffix };
    return { ...selected, target, environment, input, selection, labels, schemaTaskUpdate, schemaTarget, managerCompatibility, scyllaCompatibility, planDigest: stableDigest(planInput) };
  }

  async preview(workspaceId, input = {}) { return publicPlan(await this.#prepare(requiredText(workspaceId, 'Workspace ID', 200), input)); }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the alternate ScyllaDB Manager restore before continuing.', { category: 'conflict' });
    const prepared = await this.#prepare(tenant, input);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [prepared.point.id], targetConnectionId: prepared.target.connection.id,
      target: { operation: 'scylla-manager-alternate', mode: 'alternate', engine: 'scylla-manager', sourceId: prepared.source.id, connectionId: prepared.target.connection.id, sourceManagedClusterId: prepared.metadata.managedClusterId, targetManagedClusterId: prepared.target.config.managedClusterId, snapshotTag: prepared.metadata.snapshotTag, selection: prepared.selection, planDigest: prepared.planDigest, ownedTasks: [] },
      mode: 'alternate', conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', phasesTotal: 2, phasesCompleted: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, input, prepared.planDigest, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller, owners: [] });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'scylla-manager') throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_RUN_NOT_FOUND', 'The ScyllaDB Manager RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'scylla-manager') throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_RUN_NOT_FOUND', 'The ScyllaDB Manager RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_NOT_ACTIVE', 'The Manager restore is not active in this process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) { return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.engine === 'scylla-manager'); }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const projected = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      let ownershipProven = true;
      const target = await connectionContext(this.controlDatabase, this.secretStore, this.adapter, this.deviceId, tenant, record.target.connectionId).catch(() => null);
      if (!target) ownershipProven = false;
      for (const owner of record.target.ownedTasks || []) {
        if (!target) break;
        try {
          const task = await this.adapter.getTask(target.context, { connection: target.config, type: 'restore', taskId: owner.taskId });
          if (task.labels['deployerx.owner'] !== 'deployerx' || task.labels['deployerx.execution'] !== owner.execution) { ownershipProven = false; break; }
          const history = await this.adapter.taskHistory(target.context, { connection: target.config, type: 'restore', taskId: owner.taskId, owner, limit: 20 });
          const run = owner.runId ? history.find((item) => item.id === owner.runId) : history[0];
          if (run && !SUCCESS_RUN_STATES.has(run.status) && !FAILED_RUN_STATES.has(run.status)) await this.adapter.stopTask(target.context, { connection: target.config, type: 'restore', taskId: owner.taskId, owner, disable: false });
        } catch { ownershipProven = false; break; }
      }
      projected.push(await this.#project(tenant, record.id, { state: 'interrupted', progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() }, result: { state: 'interrupted', ownershipProven, rollbackPerformed: false, originalClusterModified: false, error: { code: 'SCYLLA_MANAGER_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage: 'Manager restore monitoring was interrupted; inspect the alternate cluster before retrying.' }, completedAt: null } }, actorId));
    }
    return projected;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #recordOwner(workspaceId, actorId, restoreRunId, owner) {
    const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
    const ownedTasks = [...(current.target?.ownedTasks || []).filter((item) => item.phase !== owner.phase), owner];
    await this.#project(workspaceId, restoreRunId, { target: { ...current.target, ownedTasks } }, actorId);
    const active = this.active.get(restoreRunId);
    if (active) active.owners = ownedTasks;
  }

  async #runPhase(workspaceId, actorId, restoreRunId, prepared, phase, taskUpdate, signal) {
    const owner = { version: 1, adapterId: ADAPTER_ID, managedClusterId: prepared.target.config.managedClusterId, type: 'restore', execution: prepared.labels['deployerx.execution'], sourceId: prepared.source.id, phase, taskId: null, runId: null };
    const task = await this.adapter.createOwnedTask({ ...prepared.target.context, signal }, { connection: prepared.target.config, type: 'restore', taskUpdate, owner });
    owner.taskId = task.id;
    await this.#recordOwner(workspaceId, actorId, restoreRunId, { ...owner });
    await this.adapter.startTask({ ...prepared.target.context, signal }, { connection: prepared.target.config, type: 'restore', taskId: task.id, owner, continue: false });
    const deadline = this.now() + this.maximumWaitMs;
    try {
      while (this.now() <= deadline) {
        if (signal.aborted) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_CANCELED', 'Manager restore was canceled.', { category: 'canceled' });
        const history = await this.adapter.taskHistory({ ...prepared.target.context, signal }, { connection: prepared.target.config, type: 'restore', taskId: task.id, owner, limit: 20 });
        const run = history[0];
        if (!run) { await this.delay(500); continue; }
        owner.runId = run.id;
        await this.#recordOwner(workspaceId, actorId, restoreRunId, { ...owner });
        const current = await this.adapter.taskProgress({ ...prepared.target.context, signal }, { connection: prepared.target.config, type: 'restore', taskId: task.id, runId: run.id, owner });
        if (SUCCESS_RUN_STATES.has(current.run.status)) {
          if (current.progress.failed || (phase === 'tables' && current.progress.restored < current.progress.size)) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_INCOMPLETE', `Manager ${phase} restore completed without proving successful native progress.`, { category: 'integrity' });
          return { owner: { ...owner }, progress: current.progress };
        }
        if (FAILED_RUN_STATES.has(current.run.status)) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_TASK_FAILED', `Manager ${phase} restore task failed.`, { category: 'execution', details: { status: current.run.status } });
        await this.delay(500);
      }
      throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_TIMEOUT', `Manager ${phase} restore did not finish before the deadline.`, { category: 'timeout', retryable: true });
    } catch (error) {
      if (signal.aborted || error.category === 'canceled') await this.adapter.stopTask(prepared.target.context, { connection: prepared.target.config, type: 'restore', taskId: task.id, owner, disable: false }).catch(() => {});
      throw error;
    }
  }

  async #execute(workspaceId, actorId, restoreRunId, input, expectedPlanDigest, signal) {
    let progress = { phase: 'preparing', phasesTotal: 2, phasesCompleted: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', startedAt: progress.startedAt, progress }, actorId);
      const prepared = await this.#prepare(workspaceId, input);
      if (prepared.planDigest !== expectedPlanDigest) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_PLAN_CHANGED', 'Manager restore state changed after confirmation.', { category: 'conflict' });
      progress = { ...progress, phase: 'schema', updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      const schema = await this.#runPhase(workspaceId, actorId, restoreRunId, prepared, 'schema', prepared.schemaTaskUpdate, signal);
      const afterSchema = await this.adapter.readEnvironment({ ...prepared.target.context, signal }, prepared.target.config);
      if (!afterSchema.status.healthy) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_HEALTH_FAILED', 'The alternate cluster is unhealthy after schema restore.', { category: 'integrity' });
      const tableTaskUpdate = { name: `deployerx-restore-tables-${prepared.labels['deployerx.execution']}`, type: 'restore', labels: { ...prepared.labels, 'deployerx.phase': 'tables' }, enabled: false, schedule: {}, properties: restoreProperties(prepared.metadata, prepared.selection, input, 'tables') };
      const tableTarget = await this.adapter.restoreTarget({ ...prepared.target.context, signal }, { connection: prepared.target.config, taskUpdate: tableTaskUpdate });
      if (tableTarget.snapshotTag !== prepared.metadata.snapshotTag) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_TARGET_CHANGED', 'Manager resolved a different snapshot after schema restore.', { category: 'integrity' });
      progress = { ...progress, phase: 'tables', phasesCompleted: 1, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { progress }, actorId);
      const tables = await this.#runPhase(workspaceId, actorId, restoreRunId, prepared, 'tables', tableTaskUpdate, signal);
      progress = { ...progress, phase: 'validating', phasesCompleted: 2, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const finalEnvironment = await this.adapter.readEnvironment(prepared.target.context, prepared.target.config);
      if (!finalEnvironment.status.healthy) throw new ScyllaManagerRestoreError('SCYLLA_MANAGER_RESTORE_VALIDATION_FAILED', 'The alternate cluster is unhealthy after table restore.', { category: 'integrity' });
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, {
        state: 'succeeded', completedAt: this.clock(), progress,
        validation: { nativeIntegrityValidation: true, managerProgress: 'pass', clusterHealth: 'pass', schemaPhase: 'pass', tablePhase: 'pass', topologyFingerprint: finalEnvironment.status.topologyFingerprint, validatedAt: this.clock() },
        result: { state: 'succeeded', recoveryPointId: prepared.point.id, sourceManagedClusterId: prepared.metadata.managedClusterId, targetManagedClusterId: prepared.target.config.managedClusterId, snapshotTag: prepared.metadata.snapshotTag, selection: prepared.selection, schema, tables, originalClusterModified: false, sourceMediaDeleted: false, rollbackPerformed: false, cancellationRollbackSupported: false, completedAt: this.clock() }
      }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.category === 'canceled';
        return this.#project(workspaceId, restoreRunId, { state: canceled ? 'canceled' : 'failed', completedAt: this.clock(), progress: { ...progress, phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, result: { state: canceled ? 'canceled' : 'failed', originalClusterModified: false, sourceMediaDeleted: false, rollbackPerformed: false, alternateClusterMayContainData: true, error: safeError(error), completedAt: this.clock() } }, actorId);
      }
      throw error;
    }
  }
}

module.exports = { RESTORE_CONFIRMATION, ScyllaManagerRestoreError, ScyllaManagerRestoreService, connectionContext, loadRecoveryMetadata, normalizeSelection, publicPlan, restoreProperties };
