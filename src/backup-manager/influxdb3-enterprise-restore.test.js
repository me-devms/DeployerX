const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID, LocalFolderRepositoryAdapter } = require('./local-repository');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  NATIVE_CONSISTENCY_METHOD,
  InfluxDb3EnterpriseAdapter,
  normalizeNativeBackupExecution
} = require('./influxdb3-enterprise');
const {
  BACKUP_STATES,
  RESTORE_CONFIRMATION,
  RESTORE_OPERATION_KIND,
  RESTORE_STATES
} = require('./influxdb3-enterprise-native');
const { METADATA_PATH, SOURCE_LEASE_KIND } = require('./influxdb3-enterprise-source-reader');
const {
  InfluxDb3EnterpriseRestoreService,
  RESTORE_OPERATION,
  ROW_DELETE_WARNING,
  SOURCE_TIER,
  normalizeRestoreRequest
} = require('./influxdb3-enterprise-restore');

const WORKSPACE_ID = 'workspace-enterprise-restore';
const DEVICE_ID = 'device-enterprise-restore';
const VERSION = '3.11.0';
const CLUSTER_ID = 'cluster-enterprise-restore';
const NODE_ID = 'node-compactor';
const NODE_CATALOG_ID = 7;
const INSTANCE_ID = 'instance-compactor';
const ROLE_FINGERPRINT = `sha256:${'1'.repeat(64)}`;
const DEPLOYMENT_FINGERPRINT = `sha256:${'2'.repeat(64)}`;
const CAPABILITY_FINGERPRINT = `sha256:${'3'.repeat(64)}`;
const SELECTION_DIGEST = `sha256:${'4'.repeat(64)}`;
const BACKUP_NAME = 'deployerx-enterprise-full-20260805';
const BACKUP_WATERMARK = 'wal:0000042';
const RESTORE_ID = '01K1ENTERPRISERESTORE00000001';
const TOKEN = 'private-enterprise-token-that-must-not-escape';

function endpointIdentity() {
  return {
    version: VERSION,
    storageEngine: 'upgraded',
    clusterId: CLUSTER_ID,
    nodeId: NODE_ID,
    nodeCatalogId: NODE_CATALOG_ID,
    instanceId: INSTANCE_ID,
    roleFingerprint: ROLE_FINGERPRINT,
    deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
    capabilityFingerprint: CAPABILITY_FINGERPRINT,
    compactorCapable: true,
    nativeBackupAvailable: true
  };
}

function execution(connectionRevision) {
  return normalizeNativeBackupExecution({
    version: 1,
    engine: 'influxdb3-enterprise',
    tier: SOURCE_TIER,
    productVersion: VERSION,
    clusterId: CLUSTER_ID,
    storageEngine: 'upgraded',
    nodeId: NODE_ID,
    nodeCatalogId: NODE_CATALOG_ID,
    instanceId: INSTANCE_ID,
    roleFingerprint: ROLE_FINGERPRINT,
    deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
    capabilityFingerprint: CAPABILITY_FINGERPRINT,
    compactorCapable: true,
    nativeBackupAvailable: true,
    connectionRevision
  });
}

function selector() {
  return {
    version: 1,
    kind: 'database-objects',
    allDatabases: true,
    databases: { include: [], exclude: [] },
    schemas: { include: [], exclude: [] },
    tables: { include: [], exclude: [] },
    includeGlobalObjects: false,
    digest: SELECTION_DIGEST
  };
}

function nativeMetadata(sourceId, sourceExecution) {
  return {
    version: 1,
    kind: SOURCE_LEASE_KIND,
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    engine: 'influxdb3-enterprise',
    backupMethod: 'physical',
    backupMode: 'full',
    sourceId,
    selectionDigest: SELECTION_DIGEST,
    consistency: { level: 'application', method: NATIVE_CONSISTENCY_METHOD, persistedDataWatermark: BACKUP_WATERMARK },
    source: {
      product: 'InfluxDB 3 Enterprise',
      productVersion: VERSION,
      clusterId: CLUSTER_ID,
      storageEngine: 'upgraded',
      nodeId: NODE_ID,
      nodeCatalogId: NODE_CATALOG_ID,
      instanceId: INSTANCE_ID,
      roleFingerprint: ROLE_FINGERPRINT,
      deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
      capabilityFingerprint: CAPABILITY_FINGERPRINT,
      compactorCapable: true
    },
    operation: {
      backupName: BACKUP_NAME,
      backupType: 'full',
      status: 'completed',
      watermark: BACKUP_WATERMARK,
      createdAt: '2026-08-05T01:00:00.000Z',
      completedAt: '2026-08-05T01:00:05.000Z'
    },
    publication: { artifactKind: 'metadata', path: METADATA_PATH, mediaType: 'application/vnd.deployerx.influxdb3-enterprise-native-backup+json' },
    externalNativeMedia: { managedByServer: true, authoritativeOwner: 'influxdb3-enterprise', includedInRepository: false, deletionIssued: false },
    restoreSupported: false
  };
}

function mutation() {
  return {
    version: 1,
    operationKind: RESTORE_OPERATION_KIND,
    restoreId: RESTORE_ID,
    backupName: BACKUP_NAME,
    clusterId: CLUSTER_ID,
    storageEngine: 'upgraded',
    nodeId: NODE_ID,
    nodeCatalogId: NODE_CATALOG_ID,
    instanceId: INSTANCE_ID,
    roleFingerprint: ROLE_FINGERPRINT,
    deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
    capabilityFingerprint: CAPABILITY_FINGERPRINT,
    acceptedAt: '2026-08-05T12:00:00.000Z',
    targetMutationStarted: true
  };
}

function remoteBackup() {
  return { name: BACKUP_NAME, type: 'full', parentName: null, status: BACKUP_STATES.COMPLETED, watermark: BACKUP_WATERMARK, createdAt: '2026-08-05T01:00:00.000Z', completedAt: '2026-08-05T01:00:05.000Z' };
}

function remoteRestore(status = RESTORE_STATES.COMPLETED) {
  return { id: RESTORE_ID, backupName: BACKUP_NAME, status, createdAt: '2026-08-05T12:00:00.000Z', completedAt: status === RESTORE_STATES.IN_PROGRESS ? null : '2026-08-05T12:00:05.000Z' };
}

class FakeNativeController {
  constructor(mode = 'success') {
    this.mode = mode;
    this.getBackupCalls = [];
    this.createCalls = [];
    this.getRestoreCalls = [];
    this.cancelCalls = [];
    this.restoreStates = [];
    this.mutationPersisted = new Promise((resolve) => { this.resolveMutationPersisted = resolve; });
  }

  async getBackup(_context, request) {
    this.getBackupCalls.push(request);
    return { identity: endpointIdentity(), backup: remoteBackup() };
  }

  async createRestore(context, request) {
    this.createCalls.push(request);
    if (this.mode === 'conflict') {
      const error = new Error(TOKEN);
      error.code = 'INFLUXDB3_ENTERPRISE_RESTORE_CONFLICT';
      error.category = 'conflict';
      error.retryable = true;
      throw error;
    }
    const owned = mutation();
    await context.onMutationStarted(owned);
    this.resolveMutationPersisted();
    if (this.mode === 'wait-for-cancel') {
      await new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error('poll canceled');
          error.code = 'INFLUXDB3_ENTERPRISE_RESTORE_POLL_CANCELED';
          error.category = 'canceled';
          reject(error);
        };
        if (context.signal?.aborted) abort();
        else context.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return {
      mutation: owned,
      identity: endpointIdentity(),
      restore: remoteRestore(),
      evidence: {
        restoreMode: 'live-cluster-in-place',
        effect: 'point-in-time-rollback',
        sourceBackupName: BACKUP_NAME,
        sourceBackupType: 'full',
        backupWatermark: BACKUP_WATERMARK,
        backupWatermarkApplied: true,
        catalogRestored: true,
        checkpointAdvanced: true,
        walTruncatedToBackupWatermark: true,
        rowDeleteStateCapturedByBackup: false,
        rowDeletesMayPersist: true,
        compactedPostBackupFilesMayRemainUnreferenced: true,
        identityRevalidated: true
      }
    };
  }

  async getRestore(_context, request) {
    this.getRestoreCalls.push(request);
    const status = this.restoreStates.length ? this.restoreStates.shift() : RESTORE_STATES.COMPLETED;
    return { identity: endpointIdentity(), restore: remoteRestore(status) };
  }

  async cancelRestore(_context, request) {
    this.cancelCalls.push(request);
    return { restoreId: request.restoreId, cancellationAccepted: true, mutationPreserved: true, identity: endpointIdentity() };
  }
}

async function fixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-enterprise-restore-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control'), clock: () => '2026-08-05T12:00:10.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  await controlDatabase.repository('secretRef').create({
    id: 'secret-enterprise-admin-token',
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Enterprise admin token',
    provider: 'electron-safe-storage',
    scope: 'device',
    providerKey: 'secret-enterprise-admin-token',
    secretType: 'token',
    version: 1
  });
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Enterprise production compactor',
    kind: 'database',
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    endpoint: {
      protocol: 'http',
      allowInsecureHttp: true,
      host: 'private.enterprise.internal',
      port: 8181,
      basePath: '/private-api',
      caFile: null,
      timeoutMs: 30000,
      expectedVersion: VERSION,
      expectedStorageEngine: 'upgraded',
      expectedClusterId: CLUSTER_ID,
      expectedNodeId: NODE_ID,
      expectedNodeCatalogId: NODE_CATALOG_ID,
      expectedInstanceId: INSTANCE_ID,
      expectedRoleFingerprint: ROLE_FINGERPRINT,
      expectedDeploymentFingerprint: DEPLOYMENT_FINGERPRINT,
      expectedCapabilityFingerprint: CAPABILITY_FINGERPRINT
    },
    secretRefIds: ['secret-enterprise-admin-token'],
    workerAffinity: [`device:${DEVICE_ID}`],
    trust: { fingerprint: DEPLOYMENT_FINGERPRINT, clusterId: CLUSTER_ID, nodeId: NODE_ID, nodeCatalogId: NODE_CATALOG_ID, instanceId: INSTANCE_ID, roleFingerprint: ROLE_FINGERPRINT, capabilityFingerprint: CAPABILITY_FINGERPRINT },
    lastTest: { status: 'success', endpointIdentity: endpointIdentity() }
  });
  const sourceExecution = execution(connection.revision);
  const source = await controlDatabase.repository('source').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Enterprise whole cluster',
    connectionId: connection.id,
    sourceType: 'database',
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    enabled: true,
    selector: selector(),
    consistency: { backupMethod: 'physical', backupMode: 'full', method: NATIVE_CONSISTENCY_METHOD, requestedLevel: 'application', captureCoordinates: true, allowDowngrade: false },
    physicalExecution: sourceExecution
  });
  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot);
  const repository = await controlDatabase.repository('repository').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Encrypted Enterprise repository',
    connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID,
    adapterVersion: '1.0.0',
    engineId: ENGINE_ID,
    engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot },
    secretRefIds: [],
    encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'enterprise-restore-key-v1' },
    workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 73);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  let metadata = nativeMetadata(source.id, sourceExecution);
  if (options.mutateMetadata) metadata = options.mutateMetadata(structuredClone(metadata));
  const bytes = Buffer.from(JSON.stringify(metadata));
  const summary = await engine.createSnapshot({}, {
    repositoryId: repository.id,
    masterKey,
    keyVersion: 'enterprise-restore-key-v1',
    idempotencyKey: `enterprise-restore-${options.idempotency || 'default'}`,
    files: (async function* files() {
      yield {
        path: METADATA_PATH,
        type: 'file',
        metadata: { workload: 'database', artifactKind: 'metadata', externalNativeMedia: true, database: metadata },
        content: (async function* content() { yield bytes; })()
      };
    })()
  });
  const snapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: summary.snapshotId, masterKey });
  const metadataFile = snapshot.manifest.files.find((file) => file.path === METADATA_PATH);
  const policy = await controlDatabase.repository('policy').create({ workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Enterprise full policy', enabled: true, backupMode: 'full', notificationRouteIds: [] });
  const job = await controlDatabase.repository('backupJob').create({ workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Enterprise protection', sourceId: source.id, policyId: policy.id, state: 'enabled', repositoryBindings: [{ repositoryId: repository.id, role: 'primary' }] });
  const run = await controlDatabase.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId: WORKSPACE_ID, actorId: 'tester', jobId: job.id, jobRevision: job.revision, trigger: 'manual', idempotencyKey: 'enterprise-restore-fixture', state: 'pending' });
    return transaction.create('run', { workspaceId: WORKSPACE_ID, actorId: 'tester', jobId: job.id, jobRevision: job.revision, executionGroupId: group.id, idempotencyKey: 'enterprise-restore-fixture:1', trigger: 'manual', workerId: `device:${DEVICE_ID}`, state: 'queued', attempt: 1, configSnapshot: {} });
  });
  const recoveryPointId = options.recoveryPointId || 'rp_019fc700-0000-7000-8000-000000000511';
  const point = await controlDatabase.repository('recoveryPoint').create({
    id: recoveryPointId,
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    jobId: job.id,
    sourceId: source.id,
    runId: run.id,
    type: options.pointType || 'full',
    consistency: 'application',
    chainRootId: options.chainRootId || recoveryPointId,
    parentRecoveryPointId: options.parentRecoveryPointId || null,
    capturedFrom: '2026-08-05T01:00:00.000Z',
    capturedTo: '2026-08-05T01:00:05.000Z',
    repositoryCopies: [{ repositoryId: repository.id, engineSnapshotId: summary.snapshotId, state: 'available', manifestLocator: summary.manifestKey, manifestChecksum: summary.manifestChecksum, immutableUntil: null }],
    verification: { mode: 'manifest-checksum', state: 'succeeded', verifiedAt: '2026-08-05T01:00:06.000Z', verificationRunId: null },
    retention: { expireAt: null, deletionEligible: false }
  });
  await controlDatabase.repository('artifact').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    recoveryPointId: point.id,
    repositoryId: repository.id,
    kind: 'metadata',
    locator: `${summary.manifestKey}#${encodeURIComponent(METADATA_PATH)}`,
    sizeBytes: metadataFile.sizeBytes,
    checksum: metadataFile.contentDigest,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: summary.keyVersion },
    compression: { mode: 'balanced' },
    metadata
  });
  const controller = options.controller || new FakeNativeController(options.mode);
  const adapter = new InfluxDb3EnterpriseAdapter();
  const service = new InfluxDb3EnterpriseRestoreService({
    controlDatabase,
    secretStore: { async resolve({ workspaceId, id }) { assert.equal(workspaceId, WORKSPACE_ID); assert.equal(id, 'secret-enterprise-admin-token'); return TOKEN; } },
    deviceId: DEVICE_ID,
    adapter,
    nativeController: controller,
    openRepository: async (workspaceId, repositoryId) => {
      assert.equal(workspaceId, WORKSPACE_ID);
      assert.equal(repositoryId, repository.id);
      return { repository, adapter: repositoryAdapter, engine, masterKey };
    },
    clock: () => '2026-08-05T12:00:10.000Z'
  });
  return { service, controller, controlDatabase, connection, source, point, metadata, repository, engine, masterKey };
}

function request(point, overrides = {}) {
  return { recoveryPointId: point.id, targetConnectionId: point.targetConnectionId, mode: 'in-place', confirmed: true, confirmationText: RESTORE_CONFIRMATION, ...overrides };
}

test('requires the exact destructive in-place confirmation without trimming', () => {
  assert.deepEqual(normalizeRestoreRequest({ recoveryPointId: 'point-a', confirmed: true, confirmationText: RESTORE_CONFIRMATION }), { recoveryPointId: 'point-a', targetConnectionId: null, mode: 'in-place' });
  assert.throws(() => normalizeRestoreRequest({ recoveryPointId: 'point-a', confirmed: true, confirmationText: `${RESTORE_CONFIRMATION} ` }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RESTORE_CONFIRMATION_REQUIRED');
  assert.throws(() => normalizeRestoreRequest({ recoveryPointId: 'point-a', mode: 'alternate', confirmed: true, confirmationText: RESTORE_CONFIRMATION }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RESTORE_MODE_UNSUPPORTED');
});

test('authenticates encrypted repository metadata and previews the live-cluster limitations', async (context) => {
  const value = await fixture(context);
  const preview = await value.service.preview(WORKSPACE_ID, { recoveryPointId: value.point.id });
  assert.equal(preview.backupName, BACKUP_NAME);
  assert.equal(preview.backupWatermark, BACKUP_WATERMARK);
  assert.equal(preview.clusterId, CLUSTER_ID);
  assert.equal(preview.identity.clusterId, CLUSTER_ID);
  assert.equal(preview.destructive, true);
  assert.equal(preview.providerRestoreConflictScope, 'cluster');
  assert.equal(preview.rowDeleteStateCapturedByBackup, false);
  assert.equal(preview.rowDeletesMayPersist, true);
  assert.equal(preview.confirmationText, RESTORE_CONFIRMATION);
  assert.deepEqual(preview.warnings, [ROW_DELETE_WARNING]);
  assert.equal(value.controller.getBackupCalls.length, 1);
});

test('allows explicit retention authentication of an expired point but rejects confirmed-deleted native media', async (context) => {
  const value = await fixture(context);
  let current = await value.controlDatabase.repository('recoveryPoint').get(WORKSPACE_ID, value.point.id);
  current = await value.controlDatabase.transaction((transaction) => transaction.projectRecoveryPointRetention(WORKSPACE_ID, current.id, {
    ...(current.retention || {}),
    deletionEligible: true,
    expireAt: '2026-08-05T11:00:00.000Z'
  }, { expectedRevision: current.revision, actorId: 'retention-test' }));
  await assert.rejects(value.service.authenticateRecoveryPoint(WORKSPACE_ID, current.id), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RECOVERY_POINT_INVALID');
  const authenticated = await value.service.authenticateRecoveryPoint(WORKSPACE_ID, current.id, { allowDeletionEligible: true });
  assert.equal(authenticated.point.id, current.id);
  assert.equal(authenticated.metadata.operation.backupName, BACKUP_NAME);

  current = await value.controlDatabase.transaction((transaction) => transaction.projectRecoveryPointRetention(WORKSPACE_ID, current.id, {
    ...(current.retention || {}),
    deletionEligible: false,
    nativeMediaDeleted: true,
    nativeMediaState: 'deleted'
  }, { expectedRevision: current.revision, actorId: 'retention-test' }));
  await assert.rejects(value.service.authenticateRecoveryPoint(WORKSPACE_ID, current.id, { allowDeletionEligible: true }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RECOVERY_POINT_INVALID');
});

test('authenticates a coherent incremental descendant only for retention deletion', async (context) => {
  const rootId = 'rp_019fc700-0000-7000-8000-000000000510';
  const value = await fixture(context, {
    idempotency: 'incremental-retention',
    pointType: 'incremental',
    chainRootId: rootId,
    parentRecoveryPointId: rootId,
    mutateMetadata(metadata) {
      return {
        ...metadata,
        backupMode: 'incremental',
        operation: { ...metadata.operation, backupType: 'incremental' }
      };
    }
  });
  await assert.rejects(value.service.authenticateRecoveryPoint(WORKSPACE_ID, value.point.id), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RECOVERY_POINT_INVALID');
  const authenticated = await value.service.authenticateRecoveryPoint(WORKSPACE_ID, value.point.id, { allowDeletionEligible: true });
  assert.equal(authenticated.point.type, 'incremental');
  assert.equal(authenticated.point.chainRootId, rootId);
  assert.equal(authenticated.point.parentRecoveryPointId, rootId);
  assert.equal(authenticated.metadata.backupMode, 'incremental');
  assert.equal(authenticated.metadata.operation.backupType, 'incremental');
});

test('rejects an active native-media deletion claim for both restore and retention authentication', async (context) => {
  const value = await fixture(context, { idempotency: 'claimed-authentication' });
  const current = await value.controlDatabase.repository('recoveryPoint').get(WORKSPACE_ID, value.point.id);
  await value.controlDatabase.transaction((transaction) => transaction.projectRecoveryPointRetention(WORKSPACE_ID, current.id, {
    ...(current.retention || {}),
    nativeMediaDeletionClaim: { claimId: `influxdb3_enterprise_retention_${'a'.repeat(64)}`, state: 'claimed' }
  }, { expectedRevision: current.revision, actorId: 'retention-test' }));
  await assert.rejects(value.service.authenticateRecoveryPoint(WORKSPACE_ID, current.id), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RECOVERY_POINT_INVALID');
  await assert.rejects(value.service.authenticateRecoveryPoint(WORKSPACE_ID, current.id, { allowDeletionEligible: true }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RECOVERY_POINT_INVALID');
});

test('atomically rejects restore admission when a deletion claim wins after preparation', async (context) => {
  const value = await fixture(context, { idempotency: 'claim-race' });
  const originalTransaction = value.controlDatabase.transaction.bind(value.controlDatabase);
  let claimPending = true;
  value.controlDatabase.transaction = async (operation) => {
    if (claimPending) {
      claimPending = false;
      await originalTransaction((transaction) => {
        const current = transaction.get('recoveryPoint', WORKSPACE_ID, value.point.id);
        return transaction.projectRecoveryPointRetention(WORKSPACE_ID, current.id, {
          ...(current.retention || {}),
          nativeMediaDeletionClaim: { claimId: `influxdb3_enterprise_retention_${'b'.repeat(64)}`, state: 'claimed' }
        }, { expectedRevision: current.revision, actorId: 'retention-test' });
      });
    }
    return originalTransaction(operation);
  };
  await assert.rejects(value.service.start(WORKSPACE_ID, 'tester', request({ ...value.point, targetConnectionId: value.connection.id })), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RESTORE_ADMISSION_CHANGED' && error.retryable === true);
  assert.equal((await value.controlDatabase.repository('restoreRun').list(WORKSPACE_ID)).length, 0);
  assert.equal(value.controller.createCalls.length, 0);
});

test('rejects repository-authenticated metadata that does not match the exact Source identity', async (context) => {
  const value = await fixture(context, { idempotency: 'tampered', mutateMetadata: (metadata) => ({ ...metadata, source: { ...metadata.source, clusterId: 'other-cluster' }, adminToken: TOKEN }) });
  await assert.rejects(value.service.preview(WORKSPACE_ID, { recoveryPointId: value.point.id }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RESTORE_ARTIFACT_INVALID');
  assert.equal(value.controller.getBackupCalls.length, 0);
});

test('persists the exact restore ID before terminal validation and records row-delete evidence', async (context) => {
  const value = await fixture(context);
  const started = await value.service.start(WORKSPACE_ID, 'tester', request({ ...value.point, targetConnectionId: value.connection.id }));
  const completed = await value.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.target.targetMutationStarted, true);
  assert.equal(completed.target.nativeRestoreId, RESTORE_ID);
  assert.deepEqual(completed.target.nativeMutation, mutation());
  assert.equal(completed.validation.nativeRestoreStatus, 'completed');
  assert.equal(completed.validation.identityRevalidated, true);
  assert.equal(completed.result.evidence.effect, 'point-in-time-rollback');
  assert.equal(completed.result.evidence.walTruncatedToBackupWatermark, true);
  assert.equal(completed.result.evidence.rowDeleteStateCapturedByBackup, false);
  assert.equal(completed.result.evidence.rowDeletesMayPersist, true);
  assert.deepEqual(completed.result.warnings, [ROW_DELETE_WARNING]);
  assert.equal(value.controller.createCalls.length, 1);
  assert.equal(value.controller.createCalls[0].confirmationText, RESTORE_CONFIRMATION);
  assert.equal(JSON.stringify(completed).includes(TOKEN), false);
});

test('preserves the cluster-wide provider conflict code without exposing private response text', async (context) => {
  const value = await fixture(context, { mode: 'conflict' });
  const started = await value.service.start(WORKSPACE_ID, 'tester', request({ ...value.point, targetConnectionId: value.connection.id }));
  const failed = await value.service.wait(WORKSPACE_ID, started.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result.error.code, 'INFLUXDB3_ENTERPRISE_RESTORE_CONFLICT');
  assert.equal(JSON.stringify(failed).includes(TOKEN), false);
  assert.equal(failed.target.targetMutationStarted, false);
});

test('cancels only the durably owned restore and requires follow-up terminal proof', async (context) => {
  const controller = new FakeNativeController('wait-for-cancel');
  controller.restoreStates.push(RESTORE_STATES.IN_PROGRESS, RESTORE_STATES.FAILED);
  const value = await fixture(context, { controller });
  const started = await value.service.start(WORKSPACE_ID, 'tester', request({ ...value.point, targetConnectionId: value.connection.id }));
  await controller.mutationPersisted;
  const canceled = await value.service.cancel(WORKSPACE_ID, 'tester', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.target.cancellationAccepted, true);
  assert.equal(canceled.result.cancellationConfirmed, true);
  assert.equal(canceled.result.rowDeletesMayPersist, true);
  assert.equal(controller.cancelCalls.length, 1);
  assert.equal(controller.cancelCalls[0].restoreId, RESTORE_ID);
  assert.deepEqual(controller.cancelCalls[0].mutation, mutation());
  assert.equal(controller.getRestoreCalls.length, 2);
});

test('reconciles a completed exact-owned native mutation after process restart', async (context) => {
  const value = await fixture(context);
  const preview = await value.service.preview(WORKSPACE_ID, { recoveryPointId: value.point.id, targetConnectionId: value.connection.id });
  const authenticated = await value.service.authenticateRecoveryPoint(WORKSPACE_ID, value.point.id);
  const record = await value.controlDatabase.repository('restoreRun').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    recoveryPointIds: [value.point.id],
    targetConnectionId: value.connection.id,
    target: {
      operation: RESTORE_OPERATION,
      mode: 'in-place',
      engine: 'influxdb3-enterprise',
      tier: SOURCE_TIER,
      sourceId: value.source.id,
      targetConnectionId: value.connection.id,
      connectionRevision: value.connection.revision,
      clusterId: CLUSTER_ID,
      backupName: BACKUP_NAME,
      backupWatermark: BACKUP_WATERMARK,
      metadataDigest: authenticated.metadataDigest,
      planDigest: preview.planDigest,
      nativeRestoreId: RESTORE_ID,
      nativeMutation: mutation(),
      targetMutationStarted: true,
      mutationStartedAt: '2026-08-05T12:00:00.000Z',
      cancellationAccepted: false
    },
    mode: 'in-place',
    conflictPolicy: 'fail',
    workerId: `device:${DEVICE_ID}`,
    state: 'running',
    progress: { phase: 'restoring-live-cluster', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, updatedAt: '2026-08-05T12:00:00.000Z', warnings: [ROW_DELETE_WARNING] },
    validation: null,
    result: null
  });
  const reconciled = await value.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, record.id);
  assert.equal(reconciled[0].state, 'succeeded');
  assert.equal(reconciled[0].result.reconciledAfterRestart, true);
  assert.equal(reconciled[0].result.restoreId, RESTORE_ID);
  assert.equal(reconciled[0].validation.clusterIdentity, 'succeeded');
});
