const { assertSecretRefOnlyCredentials } = require('./database-adapter');
const { ADAPTER_ID } = require('./mongodb');
const { MongoDbSnapshotError, normalizeLayout } = require('./mongodb-snapshot');

const RESTORE_CONFIRMATION = 'RESTORE MONGODB SHARDED EMPTY CLUSTER';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);

class MongoDbShardedRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MongoDbShardedRestoreError';
    this.code = code;
    this.category = options.category || 'restore';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function publicError(error) {
  if (error instanceof MongoDbShardedRestoreError || error instanceof MongoDbSnapshotError || (error?.code && error?.category)) return {
    code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 50), retryable: Boolean(error.retryable), safeMessage: String(error.message).slice(0, 500)
  };
  return { code: 'MONGODB_SHARDED_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the MongoDB sharded-cluster restore.' };
}

function componentId(item) {
  const role = requiredText(item.role, 'MongoDB restore component role', 40).toLowerCase();
  if (!['config-server', 'shard'].includes(role)) throw new TypeError('MongoDB restore component role is invalid.');
  const shardId = role === 'shard' ? requiredText(item.shardId, 'MongoDB restore shard ID', 200) : null;
  return { role, shardId, componentId: role === 'config-server' ? 'config-server' : `shard:${shardId}` };
}

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MongoDB sharded restore request must be an object.');
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the empty-target MongoDB sharded-cluster restore before continuing.', { category: 'conflict' });
  const profile = input.targetProfile && typeof input.targetProfile === 'object' && !Array.isArray(input.targetProfile) ? structuredClone(input.targetProfile) : null;
  if (!profile) throw new TypeError('MongoDB sharded restore target profile is required.');
  assertSecretRefOnlyCredentials(profile, 'MongoDB sharded restore target profile');
  if (!Array.isArray(profile.components) || profile.components.length < 2 || profile.components.length > 1001) throw new TypeError('MongoDB sharded restore requires a config-server and every shard target.');
  const components = profile.components.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('MongoDB sharded restore component target is invalid.');
    const identity = componentId(item);
    return {
      ...identity,
      providerId: requiredText(item.providerId, `MongoDB ${identity.componentId} restore provider ID`, 200),
      targetConnectionId: requiredText(item.targetConnectionId, `MongoDB ${identity.componentId} target connection ID`, 200),
      targetIdentity: requiredText(item.targetIdentity, `MongoDB ${identity.componentId} target identity`, 500),
      layout: normalizeLayout(item.layout),
      providerConfiguration: item.providerConfiguration && typeof item.providerConfiguration === 'object' && !Array.isArray(item.providerConfiguration) ? structuredClone(item.providerConfiguration) : {}
    };
  });
  if (components.filter((item) => item.role === 'config-server').length !== 1 || new Set(components.map((item) => item.componentId)).size !== components.length || new Set(components.map((item) => item.targetConnectionId)).size !== components.length || new Set(components.map((item) => item.targetIdentity)).size !== components.length) throw new TypeError('MongoDB sharded restore requires one distinct config-server and one distinct target per shard.');
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'Recovery point ID', 200),
    targetRouterConnectionId: requiredText(input.targetRouterConnectionId, 'Target router execution connection ID', 200),
    targetProfile: {
      clusterControllerId: requiredText(profile.clusterControllerId, 'MongoDB cluster-controller ID', 200),
      targetClusterIdentity: requiredText(profile.targetClusterIdentity, 'MongoDB target cluster identity', 500),
      controllerConfiguration: profile.controllerConfiguration && typeof profile.controllerConfiguration === 'object' && !Array.isArray(profile.controllerConfiguration) ? structuredClone(profile.controllerConfiguration) : {},
      components
    }
  };
}

function normalizeClusterPreflight(raw, request, expectedOwner) {
  if (!raw || raw.ready !== true || raw.destinationAbsent !== true || raw.servicesStopped !== true || raw.isolated !== true || raw.rollbackAvailable !== true) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_TARGET_NOT_EMPTY', 'The cluster controller did not prove an absent, stopped, isolated, rollback-capable target cluster.', { category: 'conflict' });
  const leaseOwner = requiredText(raw.leaseOwner, 'MongoDB cluster restore lease owner', 500);
  if (leaseOwner !== expectedOwner) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_LEASE_OWNER_MISMATCH', 'The cluster controller returned a lease owned by another execution.', { category: 'integrity' });
  const targetClusterIdentity = requiredText(raw.targetClusterIdentity, 'MongoDB target cluster identity', 500);
  if (targetClusterIdentity !== request.targetProfile.targetClusterIdentity) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_TARGET_IDENTITY_MISMATCH', 'The cluster controller reached a different target cluster.', { category: 'integrity' });
  return { leaseId: requiredText(raw.leaseId, 'MongoDB cluster restore lease ID', 500), leaseOwner, targetClusterIdentity };
}

function normalizeProviderPreflight(raw, component, expectedOwner) {
  if (!raw || raw.ready !== true || raw.destinationAbsent !== true || raw.serviceStopped !== true || raw.rollbackAvailable !== true) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_COMPONENT_TARGET_NOT_EMPTY', `The provider did not prove an empty, stopped, rollback-capable target for ${component.componentId}.`, { category: 'conflict' });
  const layout = normalizeLayout(raw.layout);
  if (JSON.stringify(layout) !== JSON.stringify(component.layout)) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_COMPONENT_LAYOUT_MISMATCH', `The provider returned a different layout for ${component.componentId}.`, { category: 'integrity' });
  const leaseOwner = requiredText(raw.leaseOwner, 'MongoDB component restore lease owner', 500);
  if (leaseOwner !== expectedOwner) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_LEASE_OWNER_MISMATCH', `The ${component.componentId} provider returned a lease owned by another execution.`, { category: 'integrity' });
  const targetIdentity = requiredText(raw.targetIdentity, 'MongoDB component target identity', 500);
  if (targetIdentity !== component.targetIdentity) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_COMPONENT_TARGET_IDENTITY_MISMATCH', `The ${component.componentId} provider reached a different target.`, { category: 'integrity' });
  return { leaseId: requiredText(raw.leaseId, 'MongoDB component restore lease ID', 500), leaseOwner, targetIdentity, layout };
}

function manifestComponents(metadata) {
  if (metadata?.kind !== 'mongodb-sharded-coordinated-snapshot' || metadata.adapterId !== ADAPTER_ID || metadata.backupMethod !== 'physical' || metadata.physicalSnapshot?.consistency?.proven !== true || metadata.physicalSnapshot?.consistency?.method !== 'mongodb-sharded-coordinated-snapshot') throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_MANIFEST_INVALID', 'The MongoDB manifest lacks authenticated sharded coordinated-snapshot evidence.', { category: 'integrity' });
  const cluster = metadata.physicalSnapshot.cluster;
  const interval = metadata.physicalSnapshot.commonRecoveryInterval;
  if (!cluster?.clusterId || !cluster.serverIdentityFingerprint || !cluster.topologyFingerprint || !interval?.start || !interval?.end || !interval?.recoveryTime) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_MANIFEST_INVALID', 'The MongoDB sharded manifest lacks cluster identity or common recovery-time evidence.', { category: 'integrity' });
  const protectedComponents = Array.isArray(metadata.physicalSnapshot.components) ? metadata.physicalSnapshot.components : [];
  const artifacts = Array.isArray(metadata.artifacts) ? metadata.artifacts : [];
  const restoreComponents = Array.isArray(metadata.restore?.components) ? metadata.restore.components : [];
  if (metadata.restore?.topology !== 'sharded' || protectedComponents.length < 2 || artifacts.length !== protectedComponents.length || restoreComponents.length !== protectedComponents.length || protectedComponents.filter((item) => item.role === 'config-server').length !== 1) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_MANIFEST_INVALID', 'The MongoDB sharded manifest has an incomplete component inventory.', { category: 'integrity' });
  const normalized = protectedComponents.map((protectedComponent) => {
    const id = requiredText(protectedComponent.componentId, 'Protected MongoDB component ID', 300);
    const artifact = artifacts.find((item) => item.componentId === id);
    const restore = restoreComponents.find((item) => item.componentId === id);
    if (!artifact || artifact.kind !== 'physical-backup' || !artifact.path || !restore || restore.role !== protectedComponent.role || restore.shardId !== protectedComponent.shardId) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_MANIFEST_INVALID', `The MongoDB manifest is incomplete for ${id}.`, { category: 'integrity' });
    const providerId = protectedComponent.metadata?.provider?.providerId || restore.providerId;
    return { componentId: id, role: protectedComponent.role, shardId: protectedComponent.shardId, artifactPath: requiredText(artifact.path, 'MongoDB component artifact path', 4096), providerId: requiredText(providerId, 'MongoDB protected provider ID', 200), protectedComponent, restore };
  });
  if (new Set(normalized.map((item) => item.componentId)).size !== normalized.length || new Set(normalized.map((item) => item.artifactPath)).size !== normalized.length) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_MANIFEST_INVALID', 'The MongoDB sharded manifest contains duplicate components or artifact paths.', { category: 'integrity' });
  return normalized.sort((left, right) => (left.role === 'config-server' ? -1 : right.role === 'config-server' ? 1 : left.componentId.localeCompare(right.componentId, 'en-US')));
}

class MongoDbShardedRestoreService {
  constructor({ controlDatabase, deviceId, providerRegistry, clusterController, clusterControllerId, openRepository, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !providerRegistry || !clusterController || typeof clusterController.preflightRestore !== 'function' || typeof clusterController.validateRestoredCluster !== 'function' || typeof clusterController.commitRestore !== 'function' || typeof clusterController.rollbackRestore !== 'function' || typeof openRepository !== 'function') throw new TypeError('MongoDB sharded restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.providerRegistry = providerRegistry;
    this.clusterController = clusterController;
    this.clusterControllerId = requiredText(clusterControllerId, 'MongoDB cluster-controller ID', 200);
    this.openRepository = openRepository;
    this.clock = clock;
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    if (request.targetProfile.clusterControllerId !== this.clusterControllerId) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_CONTROLLER_UNAVAILABLE', 'The approved MongoDB cluster controller is unavailable.', { category: 'compatibility' });
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, request.recoveryPointId);
    if (!point || point.type !== 'full') throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RECOVERY_POINT_INVALID', 'Choose a MongoDB sharded physical full RecoveryPoint.', { category: 'validation' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'physical' || source.physicalExecution?.topology !== 'sharded') throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RECOVERY_POINT_INVALID', 'The selected RecoveryPoint is not a MongoDB sharded physical snapshot.', { category: 'validation' });
    const targetIds = [request.targetRouterConnectionId, ...request.targetProfile.components.map((item) => item.targetConnectionId)];
    for (const connectionId of targetIds) {
      const connection = await this.controlDatabase.repository('connection').get(tenant, connectionId);
      if (!connection || connection.lastTest?.status !== 'success' || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_TARGET_CONNECTION_INVALID', 'Every cluster-controller and component execution connection must be tested on this device.', { category: 'connectivity', retryable: true });
    }
    for (const component of request.targetProfile.components) {
      const providerEntry = this.providerRegistry.get(component.providerId);
      if (!providerEntry.manifest.supportsRestore) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_PROVIDER_UNSUPPORTED', `The selected provider cannot restore ${component.componentId}.`, { category: 'compatibility' });
    }
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [point.id], targetConnectionId: request.targetRouterConnectionId,
      target: { operation: 'sharded-physical-empty-target', mode: 'empty-target', engine: 'mongodb', sourceId: source.id, connectionId: request.targetRouterConnectionId, clusterControllerId: this.clusterControllerId, targetClusterIdentity: request.targetProfile.targetClusterIdentity, components: request.targetProfile.components.map((item) => ({ componentId: item.componentId, targetConnectionId: item.targetConnectionId, providerId: item.providerId, targetIdentity: item.targetIdentity, layout: item.layout })) },
      mode: 'empty-target', conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: request.targetProfile.components.length, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, request, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'sharded-physical-empty-target') throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_RUN_NOT_FOUND', 'The MongoDB sharded RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'sharded-physical-empty-target') throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_RUN_NOT_FOUND', 'The MongoDB sharded RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_NOT_ACTIVE', 'The MongoDB sharded restore is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.engine === 'mongodb' && record.target?.operation === 'sharded-physical-empty-target');
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #updateLease(workspaceId, id, actorId, transform) {
    const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, id);
    return this.#project(workspaceId, id, { target: { ...current.target, lease: transform(structuredClone(current.target?.lease || null)) } }, actorId);
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.list(tenant, { limit: 200 });
    const recovered = [];
    for (const record of records.filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      const expectedOwner = `mongodb-sharded-restore:${tenant}:${record.id}`;
      const lease = structuredClone(record.target?.lease || null);
      let cleanupProven = true;
      let changed = false;
      if (lease?.ownerId !== expectedOwner) cleanupProven = false;
      if (lease?.ownerId === expectedOwner) {
        for (const component of [...(lease.components || [])].reverse()) {
          if (component.state === 'committed') { cleanupProven = false; continue; }
          if (component.state !== 'active') continue;
          try {
            const { provider } = this.providerRegistry.get(component.providerId);
            await provider.rollbackRestore({ leaseId: component.leaseId, leaseOwner: expectedOwner, targetIdentity: component.targetIdentity, reason: 'process-interrupted', signal: undefined });
            component.state = 'rolled-back'; component.reconciledAt = this.clock(); changed = true;
          } catch (_error) { cleanupProven = false; }
        }
        if (lease.clusterController?.state === 'committed') cleanupProven = false;
        else if (lease.clusterController?.state === 'active') {
          try {
            const rolledBack = await this.clusterController.rollbackRestore({ leaseId: lease.clusterController.leaseId, leaseOwner: expectedOwner, targetClusterIdentity: lease.targetClusterIdentity, reason: 'process-interrupted', signal: undefined });
            if (rolledBack?.rolledBack !== true || rolledBack.leaseOwner !== expectedOwner) throw new Error('cluster rollback unproven');
            lease.clusterController.state = 'rolled-back'; lease.clusterController.reconciledAt = this.clock(); changed = true;
          } catch (_error) { cleanupProven = false; }
        }
      }
      if (!cleanupProven && record.state === 'interrupted' && !changed) { recovered.push(record); continue; }
      recovered.push(await this.#project(tenant, record.id, {
        state: cleanupProven ? 'failed' : 'interrupted',
        target: { ...record.target, ...(lease ? { lease: { ...lease, state: cleanupProven ? 'rolled-back' : 'cleanup-unproven', reconciledAt: this.clock() } } : {}) },
        progress: { ...(record.progress || {}), phase: cleanupProven ? 'failed' : 'operator-action-required', updatedAt: this.clock() },
        result: { error: cleanupProven
          ? { code: 'MONGODB_SHARDED_RESTORE_INTERRUPTED', category: 'restore', retryable: false, safeMessage: 'The sharded restore was interrupted and every exact-owned lease was rolled back.' }
          : { code: 'MONGODB_SHARDED_RESTORE_LEASE_CLEANUP_UNPROVEN', category: 'consistency', retryable: false, safeMessage: 'Sharded restore cleanup or partial commit could not be proven. Inspect every component before retrying.' }, completedAt: this.clock() }
      }, actorId));
    }
    return recovered;
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let progress = { phase: 'preparing', itemsTotal: request.targetProfile.components.length, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    const leaseOwner = `mongodb-sharded-restore:${workspaceId}:${restoreRunId}`;
    let clusterPreflight = null;
    const staged = [];
    let clusterCommitted = false;
    let cleanupRisk = false;
    let validationRecord = null;
    try {
      if (signal?.aborted) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_CANCELED', 'The MongoDB sharded restore was canceled.', { category: 'canceled' });
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const point = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, request.recoveryPointId);
      const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 });
      let selected = null;
      for (const copy of (point?.repositoryCopies || []).filter((item) => item.state === 'available')) {
        const physical = artifacts.filter((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.kind === 'physical-backup' && item.metadata?.kind === 'mongodb-sharded-coordinated-snapshot');
        if (physical.length) { selected = { copy, artifacts: physical, metadata: physical[0].metadata }; break; }
      }
      if (!selected) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_ARTIFACT_UNAVAILABLE', 'No repository copy contains the MongoDB sharded component artifacts.', { category: 'not-found' });
      const protectedComponents = manifestComponents(selected.metadata);
      if (selected.artifacts.length !== protectedComponents.length || new Set(selected.artifacts.map((item) => item.locator)).size !== selected.artifacts.length) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_REPOSITORY_MANIFEST_INVALID', 'The repository copy contains duplicate or unexpected MongoDB sharded artifacts.', { category: 'integrity' });
      const targets = new Map(request.targetProfile.components.map((item) => [item.componentId, item]));
      if (protectedComponents.length !== targets.size || protectedComponents.some((item) => !targets.has(item.componentId) || targets.get(item.componentId).providerId !== item.providerId)) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_TARGET_TOPOLOGY_MISMATCH', 'The restore target must map exactly one matching provider target to every protected component.', { category: 'validation' });
      const opened = await this.openRepository(workspaceId, selected.copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: selected.copy.repositoryId, snapshotId: selected.copy.engineSnapshotId, masterKey: opened.masterKey });
      const media = protectedComponents.map((component) => {
        const artifact = selected.artifacts.find((item) => decodeURIComponent(String(item.locator || '').split('#').slice(1).join('#')) === component.artifactPath);
        const file = (snapshot.manifest.files || []).find((item) => item.type === 'file' && item.path === component.artifactPath && item.metadata?.artifactKind === 'physical-backup' && item.metadata?.componentId === component.componentId && item.metadata?.database?.kind === 'mongodb-sharded-coordinated-snapshot');
        if (!artifact || !file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_REPOSITORY_MANIFEST_INVALID', `The authenticated repository manifest does not match ${component.componentId}.`, { category: 'integrity' });
        return { ...component, artifact, file, target: targets.get(component.componentId) };
      });
      progress = { ...progress, bytesTotal: media.reduce((total, item) => total + Number(item.file.sizeBytes), 0), updatedAt: this.clock() };
      const rawClusterPreflight = await this.clusterController.preflightRestore({ leaseOwner, target: { connectionId: request.targetRouterConnectionId, identity: request.targetProfile.targetClusterIdentity }, configuration: request.targetProfile.controllerConfiguration, protectedCluster: structuredClone(selected.metadata.physicalSnapshot), components: request.targetProfile.components, signal });
      if (rawClusterPreflight?.leaseOwner === leaseOwner && rawClusterPreflight?.leaseId && rawClusterPreflight?.targetClusterIdentity) {
        clusterPreflight = { leaseOwner, leaseId: requiredText(rawClusterPreflight.leaseId, 'MongoDB cluster restore lease ID', 500), targetClusterIdentity: requiredText(rawClusterPreflight.targetClusterIdentity, 'MongoDB target cluster identity', 500) };
        await this.#project(workspaceId, restoreRunId, {
          state: 'running', progress: { ...progress, phase: 'running' },
          target: { operation: 'sharded-physical-empty-target', mode: 'empty-target', engine: 'mongodb', clusterControllerId: this.clusterControllerId, targetClusterIdentity: clusterPreflight.targetClusterIdentity, lease: { version: 1, kind: 'mongodb-sharded-restore', ownerId: leaseOwner, targetClusterIdentity: clusterPreflight.targetClusterIdentity, state: 'active', clusterController: { id: this.clusterControllerId, leaseId: clusterPreflight.leaseId, state: 'active', acquiredAt: this.clock() }, components: [] } }
        }, actorId);
      } else if (rawClusterPreflight?.leaseId || rawClusterPreflight?.ready === true) cleanupRisk = true;
      clusterPreflight = normalizeClusterPreflight(rawClusterPreflight, request, leaseOwner);
      if (!(await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId)).target?.lease) await this.#project(workspaceId, restoreRunId, {
        state: 'running', progress: { ...progress, phase: 'running' },
        target: { operation: 'sharded-physical-empty-target', mode: 'empty-target', engine: 'mongodb', clusterControllerId: this.clusterControllerId, targetClusterIdentity: clusterPreflight.targetClusterIdentity, lease: { version: 1, kind: 'mongodb-sharded-restore', ownerId: leaseOwner, targetClusterIdentity: clusterPreflight.targetClusterIdentity, state: 'active', clusterController: { id: this.clusterControllerId, leaseId: clusterPreflight.leaseId, state: 'active', acquiredAt: this.clock() }, components: [] } }
      }, actorId);
      for (const item of media) {
        if (signal?.aborted) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_CANCELED', 'The MongoDB sharded restore was canceled.', { category: 'canceled' });
        const providerEntry = this.providerRegistry.get(item.target.providerId);
        const provider = providerEntry.provider;
        const targetConnection = await this.controlDatabase.repository('connection').get(workspaceId, item.target.targetConnectionId);
        const rawPreflight = await provider.preflightRestore({ leaseOwner, target: { connectionId: targetConnection.id, adapterId: targetConnection.adapterId, revision: targetConnection.revision, identity: item.target.targetIdentity }, layout: item.target.layout, configuration: item.target.providerConfiguration, protectedSnapshot: structuredClone(item.protectedComponent.metadata), signal });
        let stagedItem = null;
        if (rawPreflight?.leaseOwner === leaseOwner && rawPreflight?.leaseId && rawPreflight?.targetIdentity) {
          const ownedPreflight = { leaseOwner, leaseId: requiredText(rawPreflight.leaseId, 'MongoDB component restore lease ID', 500), targetIdentity: requiredText(rawPreflight.targetIdentity, 'MongoDB component target identity', 500), layout: item.target.layout };
          stagedItem = { ...item, provider, preflight: ownedPreflight, restored: null, validation: null, committed: false };
          staged.push(stagedItem);
          await this.#updateLease(workspaceId, restoreRunId, actorId, (lease) => ({ ...lease, components: [...(lease.components || []), { componentId: item.componentId, providerId: providerEntry.manifest.providerId, leaseId: ownedPreflight.leaseId, targetIdentity: ownedPreflight.targetIdentity, state: 'active', acquiredAt: this.clock() }] }));
        } else if (rawPreflight?.leaseId || rawPreflight?.ready === true) cleanupRisk = true;
        const preflight = normalizeProviderPreflight(rawPreflight, item.target, leaseOwner);
        if (!stagedItem) {
          stagedItem = { ...item, provider, preflight, restored: null, validation: null, committed: false };
          staged.push(stagedItem);
          await this.#updateLease(workspaceId, restoreRunId, actorId, (lease) => ({ ...lease, components: [...(lease.components || []), { componentId: item.componentId, providerId: providerEntry.manifest.providerId, leaseId: preflight.leaseId, targetIdentity: preflight.targetIdentity, state: 'active', acquiredAt: this.clock() }] }));
        } else stagedItem.preflight = preflight;
        const content = (async function* tracked(service) {
          const stream = opened.engine.streamFile({}, { repositoryId: selected.copy.repositoryId, manifest: snapshot.manifest, masterKey: opened.masterKey, path: item.file.path });
          for await (const chunk of stream) {
            if (signal?.aborted) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_CANCELED', 'The MongoDB sharded restore was canceled.', { category: 'canceled' });
            progress.bytesWritten += Buffer.byteLength(chunk);
            yield Buffer.from(chunk);
          }
        })(this);
        const restored = await provider.restoreExport({ leaseId: preflight.leaseId, leaseOwner, targetIdentity: preflight.targetIdentity, layout: preflight.layout, content, expected: { sizeBytes: item.file.sizeBytes, digest: item.file.contentDigest.digest, snapshot: structuredClone(item.protectedComponent.metadata) }, signal });
        if (!restored || requiredText(restored.leaseId, 'Provider restore lease ID', 500) !== preflight.leaseId || restored.serviceStarted === true || Number(restored.bytesWritten) !== item.file.sizeBytes) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_COMPONENT_RESTORE_RESULT_INVALID', `The provider did not prove complete isolated materialization for ${item.componentId}.`, { category: 'integrity' });
        const validation = await provider.validateRestoredMedia({ leaseId: preflight.leaseId, leaseOwner, targetIdentity: preflight.targetIdentity, layout: preflight.layout, protectedSnapshot: structuredClone(item.protectedComponent.metadata), restoreResult: structuredClone(restored), signal });
        if (validation?.valid !== true || validation?.isolated !== true || validation?.serviceExposed === true) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_COMPONENT_VALIDATION_FAILED', `The restored ${item.componentId} media failed isolated validation.`, { category: 'integrity' });
        stagedItem.restored = restored;
        stagedItem.validation = validation;
        progress = { ...progress, itemsCompleted: progress.itemsCompleted + 1, updatedAt: this.clock() };
        await this.#project(workspaceId, restoreRunId, { progress }, actorId);
      }
      progress = { ...progress, phase: 'validating', updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const clusterValidation = await this.clusterController.validateRestoredCluster({ leaseId: clusterPreflight.leaseId, leaseOwner, targetClusterIdentity: clusterPreflight.targetClusterIdentity, protectedCluster: structuredClone(selected.metadata.physicalSnapshot), components: staged.map((item) => ({ componentId: item.componentId, targetIdentity: item.preflight.targetIdentity, restoreResult: structuredClone(item.restored), validation: structuredClone(item.validation) })), signal });
      const expectedStages = ['config-server', 'shards', 'routing-metadata', 'routers', 'validation'];
      const stagesProven = JSON.stringify(clusterValidation?.stages) === JSON.stringify(expectedStages);
      const valid = clusterValidation?.valid === true && clusterValidation?.isolated === true && clusterValidation?.serviceExposed !== true && clusterValidation?.configServerReady === true && clusterValidation?.shardsReady === true && clusterValidation?.routersReady === true && clusterValidation?.routingMetadataMatches === true && clusterValidation?.componentIdentitiesMatch === true && clusterValidation?.commonRecoveryTimeMatches === true && stagesProven;
      validationRecord = { state: valid ? 'succeeded' : 'failed', connectivity: clusterValidation?.connectivity === true ? 'pass' : 'unavailable', expectedObjects: clusterValidation?.expectedObjects === true ? 'pass' : 'unavailable', nativeIntegrityValidation: clusterValidation?.nativeIntegrityValidation === true, isolated: clusterValidation?.isolated === true, serviceExposed: clusterValidation?.serviceExposed === true, configServerReady: clusterValidation?.configServerReady === true, shardsReady: clusterValidation?.shardsReady === true, routersReady: clusterValidation?.routersReady === true, routingMetadataMatches: clusterValidation?.routingMetadataMatches === true, componentIdentitiesMatch: clusterValidation?.componentIdentitiesMatch === true, commonRecoveryTimeMatches: clusterValidation?.commonRecoveryTimeMatches === true, stages: stagesProven ? expectedStages : [], checks: Array.isArray(clusterValidation?.checks) ? clusterValidation.checks.slice(0, 500) : [], completedAt: this.clock() };
      if (!valid) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_VALIDATION_FAILED', 'The staged MongoDB cluster failed isolated routing and recovery-time validation.', { category: 'integrity' });
      for (const item of staged) {
        const commit = await item.provider.commitRestore({ leaseId: item.preflight.leaseId, leaseOwner, targetIdentity: item.preflight.targetIdentity, restoreResult: structuredClone(item.restored), validation: structuredClone(item.validation), signal });
        if (!commit || commit.committed !== true || commit.leaseOwner !== leaseOwner) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_COMPONENT_COMMIT_UNPROVEN', `The provider did not commit ${item.componentId}.`, { category: 'consistency' });
        item.committed = true;
        await this.#updateLease(workspaceId, restoreRunId, actorId, (lease) => ({ ...lease, components: lease.components.map((component) => component.componentId === item.componentId ? { ...component, state: 'committed', committedAt: this.clock() } : component) }));
      }
      const clusterCommit = await this.clusterController.commitRestore({ leaseId: clusterPreflight.leaseId, leaseOwner, targetClusterIdentity: clusterPreflight.targetClusterIdentity, validation: structuredClone(clusterValidation), signal });
      if (!clusterCommit || clusterCommit.committed !== true || clusterCommit.leaseOwner !== leaseOwner || clusterCommit.serviceExposed === true) throw new MongoDbShardedRestoreError('MONGODB_SHARDED_RESTORE_COMMIT_UNPROVEN', 'The cluster controller did not commit the isolated staged cluster.', { category: 'consistency' });
      clusterCommitted = true;
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      return this.#project(workspaceId, restoreRunId, {
        state: 'succeeded', target: { ...current.target, lease: { ...current.target.lease, state: 'committed', clusterController: { ...current.target.lease.clusterController, state: 'committed', committedAt: this.clock() } } }, progress, validation: validationRecord,
        result: { recoveryPointId: point.id, targetClusterIdentity: clusterPreflight.targetClusterIdentity, componentCount: staged.length, bytesRestored: progress.bytesWritten, serviceExposed: false, activationRequired: true, warnings: [], completedAt: this.clock() }
      }, actorId);
    } catch (error) {
      const canceled = signal?.aborted || error?.code === 'MONGODB_SHARDED_RESTORE_CANCELED';
      let cleanupUnproven = cleanupRisk || clusterCommitted || staged.some((item) => item.committed);
      for (const item of [...staged].reverse()) {
        if (item.committed) continue;
        try {
          await item.provider.rollbackRestore({ leaseId: item.preflight.leaseId, leaseOwner, targetIdentity: item.preflight.targetIdentity, restoreResult: item.restored, reason: canceled ? 'restore-canceled' : 'restore-failed', signal: undefined });
          await this.#updateLease(workspaceId, restoreRunId, actorId, (lease) => ({ ...lease, components: lease.components.map((component) => component.componentId === item.componentId ? { ...component, state: 'rolled-back', reconciledAt: this.clock() } : component) }));
        } catch (_error) { cleanupUnproven = true; }
      }
      if (clusterPreflight && !clusterCommitted) {
        try {
          const rolledBack = await this.clusterController.rollbackRestore({ leaseId: clusterPreflight.leaseId, leaseOwner, targetClusterIdentity: clusterPreflight.targetClusterIdentity, reason: canceled ? 'restore-canceled' : 'restore-failed', signal: undefined });
          if (rolledBack?.rolledBack !== true || rolledBack.leaseOwner !== leaseOwner) throw new Error('cluster rollback unproven');
          await this.#updateLease(workspaceId, restoreRunId, actorId, (lease) => ({ ...lease, clusterController: { ...lease.clusterController, state: 'rolled-back', reconciledAt: this.clock() } }));
        } catch (_error) { cleanupUnproven = true; }
      }
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const state = cleanupUnproven ? 'interrupted' : canceled ? 'canceled' : 'failed';
        return this.#project(workspaceId, restoreRunId, {
          state, target: { ...current.target, ...(current.target?.lease ? { lease: { ...current.target.lease, state: cleanupUnproven ? 'cleanup-unproven' : 'rolled-back', reconciledAt: this.clock() } } : {}) },
          progress: { ...progress, phase: state === 'interrupted' ? 'operator-action-required' : state, updatedAt: this.clock() }, validation: validationRecord,
          result: { error: cleanupUnproven
            ? { code: 'MONGODB_SHARDED_RESTORE_LEASE_CLEANUP_UNPROVEN', category: 'consistency', retryable: false, safeMessage: 'Sharded restore cleanup or partial commit could not be proven. Inspect every component before retrying.' }
            : canceled ? { code: 'MONGODB_SHARDED_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The MongoDB sharded restore was canceled and every exact-owned lease was rolled back.' }
              : publicError(error), completedAt: this.clock() }
        }, actorId);
      }
      throw error;
    }
  }
}

module.exports = { MongoDbShardedRestoreError, MongoDbShardedRestoreService, RESTORE_CONFIRMATION, normalizeRequest };
