const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { BackupJobService } = require('./backup-job');
const { DatabaseAdapterError, DatabaseAdapterRegistry } = require('./database-adapter');
const { LocalFolderRepositoryAdapter, ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  NATIVE_CONSISTENCY_METHOD,
  InfluxDb3EnterpriseAdapter,
  normalizeNativeBackupExecution
} = require('./influxdb3-enterprise');
const { BACKUP_STATES } = require('./influxdb3-enterprise-native');
const {
  InfluxDb3EnterpriseSourceReaderService,
  METADATA_PATH,
  SOURCE_LEASE_KIND,
  nativeBackupName
} = require('./influxdb3-enterprise-source-reader');

const WORKSPACE_ID = 'workspace-enterprise';
const SOURCE_ID = 'source-enterprise';
const CONNECTION_ID = 'connection-enterprise';
const DEVICE_ID = 'device-enterprise';
const VERSION = '3.5.0';
const CLUSTER_ID = 'cluster-enterprise';
const NODE_ID = 'node-compactor';
const NODE_CATALOG_ID = 7;
const INSTANCE_ID = 'instance-compactor';
const ROLE_FINGERPRINT = `sha256:${'1'.repeat(64)}`;
const DEPLOYMENT_FINGERPRINT = `sha256:${'2'.repeat(64)}`;
const CAPABILITY_FINGERPRINT = `sha256:${'3'.repeat(64)}`;
const SELECTION_DIGEST = `sha256:${'4'.repeat(64)}`;

function execution(overrides = {}) {
  return normalizeNativeBackupExecution({
    version: 1,
    engine: 'influxdb3-enterprise',
    tier: 'upgraded-native',
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
    connectionRevision: 7,
    ...overrides
  });
}

function endpointIdentity(overrides = {}) {
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
    nativeBackupAvailable: true,
    ...overrides
  };
}

function connection(overrides = {}) {
  return {
    id: CONNECTION_ID,
    revision: 7,
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    workerAffinity: [`device:${DEVICE_ID}`],
    endpoint: {
      protocol: 'http',
      allowInsecureHttp: true,
      host: 'private.influx.internal',
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
    trust: { fingerprint: DEPLOYMENT_FINGERPRINT, clusterId: CLUSTER_ID, nodeId: NODE_ID, nodeCatalogId: NODE_CATALOG_ID, instanceId: INSTANCE_ID, roleFingerprint: ROLE_FINGERPRINT, capabilityFingerprint: CAPABILITY_FINGERPRINT },
    lastTest: { status: 'success', endpointIdentity: endpointIdentity() },
    ...overrides
  };
}

function source(overrides = {}) {
  return {
    id: SOURCE_ID,
    revision: 3,
    sourceType: 'database',
    adapterId: ADAPTER_ID,
    enabled: true,
    connectionId: CONNECTION_ID,
    selector: {
      version: 1,
      kind: 'database-objects',
      allDatabases: true,
      databases: { include: [], exclude: [] },
      schemas: { include: [], exclude: [] },
      tables: { include: [], exclude: [] },
      includeGlobalObjects: false,
      digest: SELECTION_DIGEST
    },
    consistency: {
      backupMethod: 'physical',
      backupMode: 'full',
      method: NATIVE_CONSISTENCY_METHOD,
      requestedLevel: 'application',
      captureCoordinates: true,
      allowDowngrade: false
    },
    physicalExecution: execution(),
    ...overrides
  };
}

function ownership(backupName) {
  return {
    version: 1,
    operationKind: NATIVE_CONSISTENCY_METHOD,
    backupName,
    clusterId: CLUSTER_ID,
    storageEngine: 'upgraded',
    nodeId: NODE_ID,
    nodeCatalogId: NODE_CATALOG_ID,
    instanceId: INSTANCE_ID,
    roleFingerprint: ROLE_FINGERPRINT,
    deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
    capabilityFingerprint: CAPABILITY_FINGERPRINT,
    acceptedAt: '2026-08-05T01:00:00.000Z'
  };
}

function completedBackup(name) {
  return {
    name,
    type: 'full',
    parentName: null,
    status: BACKUP_STATES.COMPLETED,
    watermark: 'wal:0000042',
    createdAt: '2026-08-05T01:00:00.000Z',
    completedAt: '2026-08-05T01:00:05.000Z'
  };
}

function notFound() {
  return new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_BACKUP_NOT_FOUND', 'InfluxDB 3 Enterprise backup was not found.', { category: 'not-found' });
}

class FakeNativeController {
  constructor(options = {}) {
    this.options = options;
    this.createCalls = [];
    this.getCalls = [];
    this.cancelCalls = [];
    this.getQueue = [];
  }

  async createBackup(context, request) {
    this.createCalls.push(request);
    const acceptedOwner = ownership(request.name);
    try { await context.onOwnership(acceptedOwner); }
    catch {
      throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_PERSIST_FAILED', 'InfluxDB 3 Enterprise accepted the backup, but durable ownership persistence failed.', { category: 'persistence', details: { operationAccepted: true, backupName: request.name } });
    }
    if (this.options.failAfterOwnership) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_BACKUP_POLL_TIMEOUT', 'InfluxDB 3 Enterprise backup did not finish before the polling deadline.', { category: 'timeout', retryable: true });
    return { ownership: acceptedOwner, identity: endpointIdentity(), backup: completedBackup(request.name), consistency: 'application', nativeMediaManagedByServer: true };
  }

  async getBackup(_context, request) {
    this.getCalls.push(request);
    const next = this.getQueue.length ? this.getQueue.shift() : BACKUP_STATES.COMPLETED;
    if (next instanceof Error) throw next;
    return { identity: endpointIdentity(), backup: next === BACKUP_STATES.COMPLETED ? completedBackup(request.name) : { ...completedBackup(request.name), status: next, watermark: next === BACKUP_STATES.IN_PROGRESS ? null : 'wal:0000042', completedAt: next === BACKUP_STATES.IN_PROGRESS ? null : '2026-08-05T01:00:05.000Z' } };
  }

  async cancelBackup(_context, request) {
    this.cancelCalls.push(request);
    return { backupName: request.name, cancellationAccepted: true, ownershipPreserved: true, identity: endpointIdentity() };
  }
}

function database(records) {
  const transaction = {
    get(kind, workspaceId, id) {
      assert.equal(workspaceId, WORKSPACE_ID);
      if (kind === 'source' && id === SOURCE_ID) return structuredClone(records.source);
      if (kind === 'connection' && id === CONNECTION_ID) return structuredClone(records.connection);
      if (kind === 'run') return { id, jobId: 'job-enterprise', state: 'running' };
      if (kind === 'backupJob' && id === 'job-enterprise') return { id, sourceId: SOURCE_ID };
      return null;
    },
    list(kind, workspaceId) {
      assert.equal(workspaceId, WORKSPACE_ID);
      return kind === 'recoveryPoint' ? structuredClone(records.recoveryPoints || []) : [];
    }
  };
  return {
    repository(kind) {
      return {
        async get(workspaceId, id) {
          return transaction.get(kind, workspaceId, id);
        }
      };
    },
    async read(operation) { return operation(transaction); }
  };
}

async function fixture(context, options = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-enterprise-reader-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const records = { source: options.source || source(), connection: options.connection || connection() };
  const adapter = new InfluxDb3EnterpriseAdapter();
  const controller = options.controller || new FakeNativeController();
  const reader = new InfluxDb3EnterpriseSourceReaderService({
    controlDatabase: database(records),
    secretStore: { async resolve({ workspaceId, id }) { assert.equal(workspaceId, WORKSPACE_ID); assert.equal(id, 'secret-enterprise-admin-token'); return 'private-admin-token'; } },
    deviceId: DEVICE_ID,
    adapterRegistry: { manifest(id) { assert.equal(id, ADAPTER_ID); return adapter.manifest(); } },
    adapter,
    nativeController: controller,
    temporaryRoot,
    fileSystem: options.fileSystem || fs,
    clock: () => '2026-08-05T01:00:10.000Z'
  });
  return { reader, controller, records, temporaryRoot };
}

async function onlyFile(files) {
  const items = [];
  for await (const item of files.create()) items.push(item);
  assert.equal(items.length, 1);
  const chunks = [];
  for await (const chunk of items[0].content) chunks.push(Buffer.from(chunk));
  return { item: items[0], bytes: Buffer.concat(chunks) };
}

test('plans and publishes one bounded secret-free metadata artifact, then releases only local staging', async (context) => {
  const value = await fixture(context);
  const leases = [];
  const plan = await value.reader.plan(WORKSPACE_ID, SOURCE_ID);
  assert.equal(plan.execution.tier, 'upgraded-native');
  const files = await value.reader.files(WORKSPACE_ID, SOURCE_ID, { executionId: 'execution-1', backupMode: 'full', onSourceLease: async (lease) => leases.push(structuredClone(lease)) });
  assert.deepEqual(leases.map((lease) => lease.state), ['acquiring', 'active']);
  assert.equal(leases[1].kind, SOURCE_LEASE_KIND);
  assert.equal(leases[1].ownership.backupName, nativeBackupName(WORKSPACE_ID, SOURCE_ID, 'execution-1'));
  const published = await onlyFile(files);
  assert.equal(published.item.path, METADATA_PATH);
  assert.equal(published.item.metadata.externalNativeMedia, true);
  const metadata = JSON.parse(published.bytes.toString('utf8'));
  assert.equal(metadata.backupMode, 'full');
  assert.equal(metadata.consistency.persistedDataWatermark, 'wal:0000042');
  assert.equal(metadata.operation.status, 'completed');
  assert.equal(metadata.externalNativeMedia.includedInRepository, false);
  assert.equal(metadata.restoreSupported, false);
  const serialized = JSON.stringify({ manifest: files.manifest, item: published.item.metadata, metadata });
  for (const forbidden of ['private-admin-token', 'secret-enterprise-admin-token', 'private.influx.internal', '/private-api', '8181']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(await value.reader.release(WORKSPACE_ID, 'execution-1'), true);
  assert.deepEqual(leases.map((lease) => lease.state), ['acquiring', 'active', 'released']);
  assert.equal(leases[2].releaseReason, 'repository-committed');
  assert.equal((await fs.readdir(value.temporaryRoot)).length, 0);
  assert.equal(value.controller.cancelCalls.length, 0);
});

test('fails closed for incremental creation and for any drift in the tested execution binding', async (context) => {
  const value = await fixture(context);
  await assert.rejects(value.reader.files(WORKSPACE_ID, SOURCE_ID, { executionId: 'execution-incremental', backupMode: 'incremental', requestedBackupMode: 'incremental', onSourceLease: async () => {} }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_INCREMENTAL_WIRE_CONTRACT_UNAVAILABLE');
  assert.equal(value.controller.createCalls.length, 0);
  value.records.connection.lastTest = { status: 'success', endpointIdentity: endpointIdentity({ capabilityFingerprint: `sha256:${'9'.repeat(64)}` }) };
  await assert.rejects(value.reader.plan(WORKSPACE_ID, SOURCE_ID), (error) => error.code === 'INFLUXDB3_ENTERPRISE_SOURCE_CONNECTION_UNHEALTHY');
});

test('rejects native backup admission while retention owns a durable media-deletion claim', async (context) => {
  const value = await fixture(context);
  value.records.recoveryPoints = [{
    id: 'point-deleting',
    sourceId: SOURCE_ID,
    retention: { nativeMediaDeletionClaim: { version: 1, claimId: `influxdb3_enterprise_retention_${'a'.repeat(64)}`, state: 'claimed' } }
  }];
  await assert.rejects(
    value.reader.files(WORKSPACE_ID, SOURCE_ID, { executionId: 'execution-blocked', backupMode: 'full', onSourceLease: async () => {} }),
    (error) => error.code === 'INFLUXDB3_ENTERPRISE_NATIVE_MEDIA_DELETION_ACTIVE'
  );
  assert.equal(value.controller.createCalls.length, 0);
  assert.equal((await fs.readdir(value.temporaryRoot)).length, 0);
});

test('preserves durable acquiring proof when the process stops before native ownership', async (context) => {
  const controller = new FakeNativeController();
  controller.createBackup = async function createWithoutOwnership() {
    this.createCalls.push({});
    throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_REQUEST_FAILED', 'The process stopped before native ownership was accepted.', { category: 'connectivity', retryable: true });
  };
  const value = await fixture(context, { controller });
  const leases = [];
  await assert.rejects(value.reader.files(WORKSPACE_ID, SOURCE_ID, { executionId: 'execution-acquiring', backupMode: 'full', onSourceLease: async (lease) => leases.push(structuredClone(lease)) }));
  assert.deepEqual(leases.map((lease) => lease.state), ['acquiring']);
  assert.equal((await fs.readdir(value.temporaryRoot)).length, 1);
  const reconciled = await value.reader.reconcileRun(WORKSPACE_ID, { id: 'execution-acquiring', sourceLease: leases[0] });
  assert.equal(reconciled.proven, true);
  assert.equal(reconciled.removedTemporaryDirectories, 1);
  assert.equal(reconciled.canceledOwnedBackups, 0);
  assert.equal(reconciled.sourceLease.state, 'released');
  assert.equal(controller.getCalls.length, 0);
});

test('never cancels an accepted backup when durable native ownership persistence fails', async (context) => {
  const renameFailingFileSystem = {
    ...fs,
    async rename(from, to) {
      if (from.endsWith('.owner.json.next') && to.endsWith('.owner.json')) throw Object.assign(new Error('durable write unavailable'), { code: 'EIO' });
      return fs.rename(from, to);
    }
  };
  const value = await fixture(context, { fileSystem: renameFailingFileSystem });
  const leases = [];
  await assert.rejects(value.reader.files(WORKSPACE_ID, SOURCE_ID, { executionId: 'execution-owner-failure', backupMode: 'full', onSourceLease: async (lease) => leases.push(structuredClone(lease)) }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_PERSIST_FAILED');
  assert.equal(value.controller.createCalls.length, 1);
  assert.equal(value.controller.cancelCalls.length, 0);
  assert.deepEqual(leases.map((lease) => lease.state), ['acquiring']);
  const [directory] = await fs.readdir(value.temporaryRoot);
  const owner = JSON.parse(await fs.readFile(path.join(value.temporaryRoot, directory, '.owner.json'), 'utf8'));
  assert.equal(owner.ownership, null);
});

test('reconciles exact file ownership when active run-lease persistence fails after acceptance', async (context) => {
  const value = await fixture(context);
  let acquiringLease = null;
  await assert.rejects(value.reader.files(WORKSPACE_ID, SOURCE_ID, {
    executionId: 'execution-active-lease-failure',
    backupMode: 'full',
    onSourceLease: async (lease) => {
      if (lease.state === 'acquiring') acquiringLease = structuredClone(lease);
      else throw new Error('run projection unavailable');
    }
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_PERSIST_FAILED');
  assert.ok(acquiringLease);
  assert.equal((await fs.readdir(value.temporaryRoot)).length, 1);
  const result = await value.reader.reconcileRun(WORKSPACE_ID, { id: 'execution-active-lease-failure', sourceLease: acquiringLease });
  assert.equal(result.proven, true);
  assert.equal(result.sourceLease.state, 'released');
  assert.equal(result.sourceLease.ownership.backupName, acquiringLease.backupName);
  assert.equal(result.preservedTerminalBackups, 1);
  assert.equal(value.controller.cancelCalls.length, 0);
});

test('requires terminal or not-found proof after exact-owned cancellation before releasing the lease', async (context) => {
  const value = await fixture(context);
  const leases = [];
  await value.reader.files(WORKSPACE_ID, SOURCE_ID, { executionId: 'execution-cancel', backupMode: 'full', onSourceLease: async (lease) => leases.push(structuredClone(lease)) });
  const rejected = await value.reader.reconcileRun(WORKSPACE_ID, { id: 'execution-cancel', sourceLease: { ...leases[1], workspaceId: 'other-workspace' } });
  assert.equal(rejected.proven, false);
  assert.equal(value.controller.getCalls.length, 0);
  assert.equal(value.controller.cancelCalls.length, 0);
  value.controller.getQueue.push(BACKUP_STATES.IN_PROGRESS, BACKUP_STATES.IN_PROGRESS);
  const pending = await value.reader.reconcileRun(WORKSPACE_ID, { id: 'execution-cancel', sourceLease: leases[1] });
  assert.equal(pending.proven, false);
  assert.equal(pending.sourceLease.state, 'active');
  assert.equal(value.controller.cancelCalls.length, 1);
  assert.equal((await fs.readdir(value.temporaryRoot)).length, 1);
  value.controller.getQueue.push(notFound());
  const complete = await value.reader.reconcileRun(WORKSPACE_ID, { id: 'execution-cancel', sourceLease: leases[1] });
  assert.equal(complete.proven, true);
  assert.equal(complete.canceledOwnedBackups, 1);
  assert.equal(complete.nativeMediaDeleted, false);
  assert.equal(complete.sourceLease.state, 'released');
  assert.equal((await fs.readdir(value.temporaryRoot)).length, 0);
});

test('preserves completed and failed server-managed native media during startup reconciliation', async (context) => {
  for (const status of [BACKUP_STATES.COMPLETED, BACKUP_STATES.FAILED]) {
    const value = await fixture(context);
    const leases = [];
    const executionId = `execution-${status}`;
    await value.reader.files(WORKSPACE_ID, SOURCE_ID, { executionId, backupMode: 'full', onSourceLease: async (lease) => leases.push(structuredClone(lease)) });
    value.controller.getQueue.push(status);
    const result = await value.reader.reconcileRun(WORKSPACE_ID, { id: executionId, sourceLease: leases[1] });
    assert.equal(result.proven, true);
    assert.equal(result.preservedTerminalBackups, 1);
    assert.equal(result.canceledOwnedBackups, 0);
    assert.equal(result.nativeMediaDeleted, false);
    assert.equal(result.sourceLease.state, 'released');
    assert.equal(value.controller.cancelCalls.length, 0);
  }
});

test('commits Enterprise native metadata as an encrypted RecoveryPoint and Artifact through ManualBackupService', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-enterprise-manual-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
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
  const connectionRecord = await controlDatabase.repository('connection').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Enterprise production',
    kind: 'database',
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    endpoint: connection().endpoint,
    secretRefIds: ['secret-enterprise-admin-token'],
    workerAffinity: [`device:${DEVICE_ID}`],
    trust: connection().trust,
    lastTest: connection().lastTest
  });
  const sourceRecord = await controlDatabase.repository('source').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Enterprise whole cluster',
    connectionId: connectionRecord.id,
    sourceType: 'database',
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    enabled: true,
    selector: source().selector,
    consistency: source().consistency,
    physicalExecution: execution({ connectionRevision: connectionRecord.revision })
  });
  assert.equal(sourceRecord.physicalExecution.engine, 'influxdb3-enterprise');
  assert.equal(sourceRecord.consistency.backupMethod, 'physical');
  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot, { recursive: true });
  const repository = await controlDatabase.repository('repository').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Encrypted Enterprise metadata',
    connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID,
    adapterVersion: '1.0.0',
    engineId: ENGINE_ID,
    engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot },
    secretRefIds: [],
    encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'enterprise-test-key-v1' },
    workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 27);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const controller = new FakeNativeController();
  const adapter = new InfluxDb3EnterpriseAdapter({ nativeController: controller });
  const adapterRegistry = new DatabaseAdapterRegistry([adapter]);
  const reader = new InfluxDb3EnterpriseSourceReaderService({
    controlDatabase,
    secretStore: { async resolve({ id }) { assert.equal(id, 'secret-enterprise-admin-token'); return 'private-enterprise-token'; } },
    deviceId: DEVICE_ID,
    adapterRegistry,
    adapter,
    nativeController: controller,
    temporaryRoot: path.join(root, 'preparations'),
    clock: () => '2026-08-05T01:00:10.000Z'
  });
  const { job } = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', {
    name: 'Enterprise protection',
    sourceId: sourceRecord.id,
    repositoryIds: [repository.id],
    backupMode: 'full',
    verifyAfterBackup: true
  });
  const service = new ManualBackupService({
    controlDatabase,
    sourceReader: reader,
    checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }),
    deviceId: DEVICE_ID,
    openRepository: async (_workspaceId, repositoryId) => {
      assert.equal(repositoryId, repository.id);
      return { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'enterprise-test-key-v1' };
    }
  });
  const started = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(started.id);
  const run = await controlDatabase.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(run.state, 'succeeded');
  assert.equal(run.sourceLease.state, 'released');
  const points = await controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 10 });
  assert.equal(points.length, 1);
  assert.equal(points[0].sourceId, sourceRecord.id);
  assert.equal(points[0].type, 'full');
  assert.equal(points[0].consistency, 'application');
  const artifacts = await controlDatabase.repository('artifact').list(WORKSPACE_ID, { limit: 20 });
  const metadataArtifact = artifacts.find((artifact) => artifact.recoveryPointId === points[0].id && artifact.kind === 'metadata');
  assert.ok(metadataArtifact);
  assert.equal(metadataArtifact.metadata.adapterId, ADAPTER_ID);
  assert.equal(metadataArtifact.metadata.kind, SOURCE_LEASE_KIND);
  assert.equal(metadataArtifact.metadata.externalNativeMedia.managedByServer, true);
  const copy = points[0].repositoryCopies[0];
  const snapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: copy.engineSnapshotId, masterKey });
  const metadataFile = snapshot.manifest.files.find((item) => item.path === METADATA_PATH);
  assert.ok(metadataFile);
  const chunks = [];
  for await (const chunk of engine.streamFile({}, { repositoryId: repository.id, manifest: snapshot.manifest, masterKey, path: METADATA_PATH })) chunks.push(Buffer.from(chunk));
  const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(metadata.operation.status, 'completed');
  assert.equal(metadata.operation.watermark, 'wal:0000042');
  assert.equal(metadata.externalNativeMedia.includedInRepository, false);
  assert.equal(JSON.stringify({ metadata, artifact: metadataArtifact.metadata }).includes('private-enterprise-token'), false);
  assert.equal(controller.cancelCalls.length, 0);
});
