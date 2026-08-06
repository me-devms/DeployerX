const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { FileSourceReaderService } = require('./file-source-reader');
const {
  ADAPTER_ID,
  CONSISTENCY_CONFIRMATIONS,
  CONSISTENCY_METHODS,
  RESTORE_CONFIRMATION,
  S3_BIND_CONFIRMATION,
  InfluxDb3CoreAdapter,
  InfluxDb3CoreConnectionService
} = require('./influxdb3-core');
const { InfluxDb3CoreS3Store } = require('./influxdb3-core-s3');
const { InfluxDb3CoreRestoreService } = require('./influxdb3-core-restore');
const { InfluxDb3CoreSourceReaderService } = require('./influxdb3-core-source-reader');
const { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, InfluxDb3CoreRecoveryTestService } = require('./influxdb3-core-verification');
const { LocalFolderRepositoryAdapter, ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const { BackupSecretStore } = require('./secrets');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'influxdb3-core-s3-device';
const NODE_ID = 'node-production-01';
const ACCESS_KEY = 'core-access-key';
const SECRET_KEY = 'core-secret-key';

function pingResponse() {
  return { statusCode: 200, headers: { 'x-influxdb-build': 'Core', 'x-influxdb-version': '3.11.0' }, body: JSON.stringify({ version: '3.11.0', revision: 's3-revision', process_id: '1234' }) };
}

function etag(body) { return `"${crypto.createHash('md5').update(body).digest('hex')}"`; }

function objects(prefix = 'production') {
  const root = `${prefix}/${NODE_ID}`;
  return {
    [`${root}/snapshots/0001/snapshot.parquet`]: 'snapshot-bytes',
    [`${root}/dbs/db-a/data.parquet`]: 'database-bytes',
    [`${root}/wal/0001/wal.log`]: 'wal-bytes',
    [`${root}/catalog/0001/catalog.log`]: 'catalog-bytes',
    [`${root}/_catalog_checkpoint`]: 'checkpoint-bytes',
    [`${root}/table-snapshots/db-a/derived.parquet`]: 'excluded-bytes'
  };
}

class MemoryCoreS3Client {
  constructor(providerCredentials, initialObjects = objects()) {
    this.providerCredentials = providerCredentials;
    this.objects = new Map(Object.entries(initialObjects).map(([key, value]) => [key, { body: Buffer.from(value), lastModified: new Date('2026-08-05T00:00:00.000Z') }]));
    this.resolvedCredentials = [];
    this.failPutKey = null;
  }

  put(key, value) { this.objects.set(key, { body: Buffer.from(value), lastModified: new Date('2026-08-05T00:01:00.000Z') }); }

  async send(command) {
    this.resolvedCredentials.push(await this.providerCredentials());
    const { input } = command;
    if (command.constructor.name === 'HeadBucketCommand') return { $metadata: { httpStatusCode: 200 } };
    if (command.constructor.name === 'ListObjectsV2Command') {
      const Contents = [...this.objects.entries()].filter(([key]) => key.startsWith(input.Prefix)).sort(([left], [right]) => left.localeCompare(right, 'en-US')).map(([Key, value]) => ({ Key, Size: value.body.length, ETag: etag(value.body), LastModified: value.lastModified }));
      return { Contents, IsTruncated: false, KeyCount: Contents.length };
    }
    if (command.constructor.name === 'GetObjectCommand') {
      const value = this.objects.get(input.Key);
      if (!value) { const error = new Error('missing'); error.name = 'NoSuchKey'; error.$metadata = { httpStatusCode: 404 }; throw error; }
      const identity = etag(value.body);
      if (identity !== input.IfMatch) { const error = new Error('changed'); error.name = 'PreconditionFailed'; error.$metadata = { httpStatusCode: 412 }; throw error; }
      return { ETag: identity, ContentLength: value.body.length, Body: (async function* body() { yield Buffer.from(value.body); })() };
    }
    if (command.constructor.name === 'PutObjectCommand') {
      if (this.failPutKey === input.Key) { const error = new Error('write failed'); error.name = 'ServiceUnavailable'; error.$metadata = { httpStatusCode: 503 }; throw error; }
      if (input.IfNoneMatch !== '*' || this.objects.has(input.Key)) { const error = new Error('exists'); error.name = 'PreconditionFailed'; error.$metadata = { httpStatusCode: 412 }; throw error; }
      const chunks = []; for await (const chunk of input.Body) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
      assert.equal(body.length, input.ContentLength);
      assert.equal(crypto.createHash('sha256').update(body).digest('base64'), input.ChecksumSHA256);
      this.put(input.Key, body);
      return { ETag: etag(body), ChecksumSHA256: input.ChecksumSHA256, $metadata: { httpStatusCode: 200 } };
    }
    throw new Error(`Unexpected S3 command ${command.constructor.name}`);
  }
}

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, '')
  };
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-s3-integration-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const secretStore = new BackupSecretStore({ rootPath: path.join(root, 'secrets'), secureStorage: secureStorage(), isReferenced: async () => false });
  await secretStore.initialize();
  const clients = new Map(); const stoppedHosts = new Set();
  const adapter = new InfluxDb3CoreAdapter({
    transport: async ({ config }) => { if (stoppedHosts.has(config.host)) { const error = new Error('stopped'); error.category = 'connectivity'; throw error; } return pingResponse(); },
    clock: () => '2026-08-05T12:00:00.000Z',
    s3StoreFactory: (options) => new InfluxDb3CoreS3Store({ ...options, clientFactory: (provider) => { if (!clients.has(options.config.bucket)) clients.set(options.config.bucket, new MemoryCoreS3Client(provider.credentials, objects(options.config.prefix))); return clients.get(options.config.bucket); } })
  });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new InfluxDb3CoreConnectionService({ controlDatabase, secretStore, deviceId: DEVICE_ID, adapter });
  return { root, controlDatabase, secretStore, adapter, registry, connections, client: (bucket = 'core-production-data') => clients.get(bucket), stopHost: (host) => stoppedHosts.add(host) };
}

function connectionInput(overrides = {}) {
  return {
    name: 'Core S3 production', protocol: 'http', allowInsecureHttp: true, host: '127.0.0.1', port: 8181,
    objectStore: 's3', objectStoreRegion: 'us-east-1', objectStoreBucket: 'core-production-data', objectStorePrefix: 'production', nodeId: NODE_ID,
    accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, confirmationText: S3_BIND_CONFIRMATION, ...overrides
  };
}

test('stores Core S3 credentials only in one encrypted SecretRef and validates exact inventory', async (context) => {
  const current = await fixture(context);
  await assert.rejects(current.connections.create(WORKSPACE_ID, 'tester', connectionInput({ name: 'Unsupported Core store', objectStore: 'azure' })), /not implemented/i);
  const created = await current.connections.create(WORKSPACE_ID, 'tester', connectionInput());
  assert.equal(created.secretRefIds.length, 1);
  assert.equal(JSON.stringify(created.endpoint).includes(created.secretRefIds[0]), false);
  assert.equal(JSON.stringify(created).includes(ACCESS_KEY), false);
  assert.equal(JSON.stringify(created).includes(SECRET_KEY), false);
  const ciphertext = await fs.readFile(path.join(current.root, 'secrets', 'secrets.json'), 'utf8');
  assert.equal(ciphertext.includes(ACCESS_KEY), false);
  assert.equal(ciphertext.includes(SECRET_KEY), false);

  const tested = await current.connections.test(WORKSPACE_ID, created.id, 'tester');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.lastTest.endpointIdentity.objectStore, 's3');
  assert.equal(tested.connection.lastTest.endpointIdentity.restoreSupported, true);
  assert.equal(tested.connection.influxdb3CoreInventory.nodes[0].objectStore, 's3');
  assert.equal(tested.connection.influxdb3CoreInventory.nodes[0].restoreSupported, true);
  assert.deepEqual(current.client().resolvedCredentials[0], { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
  assert.ok((await current.secretStore.list(WORKSPACE_ID))[0].lastValidatedAt);
});

test('removes a newly encrypted SecretRef when S3 connection persistence cannot complete', async (context) => {
  const current = await fixture(context);
  await assert.rejects(current.connections.create(WORKSPACE_ID, 'tester', connectionInput({ name: 'Invalid Core S3', objectStoreBucket: 'invalid_bucket' })), /bucket name is invalid/i);
  assert.deepEqual(await current.secretStore.list(WORKSPACE_ID), []);
  assert.deepEqual(await current.controlDatabase.repository('secretRef').list(WORKSPACE_ID, { limit: 20 }), []);
  assert.deepEqual(await current.connections.list(WORKSPACE_ID), []);
});

test('retains but does not validate an S3 SecretRef when endpoint testing fails', async (context) => {
  const current = await fixture(context);
  current.adapter.transport = async () => { throw new Error('offline'); };
  const created = await current.connections.create(WORKSPACE_ID, 'tester', connectionInput({ name: 'Core S3 offline' }));
  const tested = await current.connections.test(WORKSPACE_ID, created.id, 'tester');
  assert.equal(tested.result.status, 'failure');
  assert.equal((await current.secretStore.list(WORKSPACE_ID))[0].lastValidatedAt, null);
  assert.equal((await current.controlDatabase.repository('connection').get(WORKSPACE_ID, created.id)).secretRefIds[0], created.secretRefIds[0]);
});

test('publishes an encrypted full S3 RecoveryPoint without locator or credential disclosure', async (context) => {
  const current = await fixture(context);
  const created = await current.connections.create(WORKSPACE_ID, 'tester', connectionInput());
  const tested = await current.connections.test(WORKSPACE_ID, created.id, 'tester');
  const source = await new DatabaseSourceService({ controlDatabase: current.controlDatabase, adapterRegistry: current.registry, deviceId: DEVICE_ID }).save(WORKSPACE_ID, 'tester', {
    name: 'Core S3 node protection', connectionId: created.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: CONSISTENCY_METHODS['atomic-snapshot'], backupMethod: 'physical', backupMode: 'full', captureCoordinates: false },
    physicalExecution: { consistencyMode: 'atomic-snapshot', confirmationText: CONSISTENCY_CONFIRMATIONS['atomic-snapshot'] }
  });
  assert.equal(source.physicalExecution.objectStore, 's3');
  assert.equal(source.physicalExecution.nodeId, NODE_ID);
  assert.equal(JSON.stringify(source.physicalExecution).includes('core-production-data'), false);
  assert.equal(JSON.stringify(source.physicalExecution).includes(created.secretRefIds[0]), false);

  const temporaryRoot = path.join(current.root, 'source-temp');
  const reader = new InfluxDb3CoreSourceReaderService({ controlDatabase: current.controlDatabase, deviceId: DEVICE_ID, adapterRegistry: current.registry, adapter: current.adapter, connectionService: current.connections, temporaryRoot });
  const repositoryRoot = path.join(current.root, 'repository'); await fs.mkdir(repositoryRoot);
  const repository = await current.controlDatabase.repository('repository').create({ workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Core S3 repository', connectionId: null, adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION, location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null, encryption: { algorithm: 'aes-256-gcm', keyVersion: 'core-s3-key-v1' }, workerAffinity: [`device:${DEVICE_ID}`], health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } } });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot }); await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter }); const masterKey = Buffer.alloc(32, 19); await engine.ensureRepository({}, { repositoryId: repository.id });
  const jobs = new BackupJobService({ controlDatabase: current.controlDatabase, deviceId: DEVICE_ID });
  await assert.rejects(jobs.create(WORKSPACE_ID, 'tester', { name: 'Core S3 incremental', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'incremental' }), /incremental physical jobs require/i);
  const { job } = await jobs.create(WORKSPACE_ID, 'tester', { name: 'Core S3 full', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full', verifyAfterBackup: true });
  const router = new BackupSourceReaderRouter({ controlDatabase: current.controlDatabase, fileReader: new FileSourceReaderService({ controlDatabase: current.controlDatabase, secretStore: {}, deviceId: DEVICE_ID }), databaseReaders: { [ADAPTER_ID]: reader } });
  const service = new ManualBackupService({ controlDatabase: current.controlDatabase, sourceReader: router, checkpointStore: new RunCheckpointStore({ rootPath: path.join(current.root, 'checkpoints') }), deviceId: DEVICE_ID, openRepository: async () => ({ repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'core-s3-key-v1' }) });
  const started = await service.start(WORKSPACE_ID, 'tester', job.id); await service.wait(started.id);
  const completed = await current.controlDatabase.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  const [point] = await current.controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  const artifact = (await current.controlDatabase.repository('artifact').list(WORKSPACE_ID, { limit: 20 })).find((item) => item.metadata?.kind === 'influxdb3-core-s3-full');
  assert.equal(point.type, 'full');
  assert.equal(point.consistency, 'application');
  assert.ok(artifact);
  assert.equal(artifact.metadata.artifact.restoreSupported, true);
  assert.deepEqual(artifact.metadata.capture.copyOrder, ['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint']);
  assert.equal(artifact.metadata.nativeMedia.fileCount, 5);
  assert.match(artifact.metadata.nativeMedia.mediaFingerprint, /^sha256:[0-9a-f]{64}$/);
  const publicEvidence = JSON.stringify({ point, artifact, run: completed });
  for (const privateValue of [ACCESS_KEY, SECRET_KEY, 'core-production-data', 'production/']) assert.equal(publicEvidence.includes(privateValue), false, `Public evidence disclosed ${privateValue}.`);
  assert.equal(JSON.stringify({ point, artifact }).includes(created.secretRefIds[0]), false);
  const snapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey });
  assert.equal(snapshot.manifest.files.some((file) => file.path.includes('table-snapshots')), false);
  assert.equal(snapshot.manifest.files.some((file) => file.path.endsWith('/_catalog_checkpoint')), true);
  assert.deepEqual(await fs.readdir(temporaryRoot), []);

  const target = await current.connections.create(WORKSPACE_ID, 'tester', connectionInput({ name: 'Core S3 alternate', host: '127.0.0.2', objectStoreBucket: 'core-alternate-data', objectStorePrefix: 'alternate' }));
  const testedTarget = await current.connections.test(WORKSPACE_ID, target.id, 'tester');
  assert.notEqual(testedTarget.connection.trust.fingerprint, tested.connection.trust.fingerprint);
  current.client('core-alternate-data').objects.clear(); current.stopHost('127.0.0.2');
  const openRepository = async () => ({ repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'core-s3-key-v1' });
  const restoreService = new InfluxDb3CoreRestoreService({ controlDatabase: current.controlDatabase, deviceId: DEVICE_ID, adapter: current.adapter, connectionService: current.connections, openRepository, temporaryRoot: path.join(current.root, 'restore-temp') });
  const preview = await restoreService.preview(WORKSPACE_ID, { recoveryPointId: point.id, targetConnectionId: target.id });
  assert.equal(preview.objectStore, 's3'); assert.equal(preview.targetStopped, true); assert.equal(preview.targetNodeAbsent, true); assert.equal(preview.ownershipReviewRequired, false); assert.equal(preview.operatorReviewRequired, true);
  const restoreStarted = await restoreService.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, targetConnectionId: target.id, mode: 'alternate', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const restored = await restoreService.wait(WORKSPACE_ID, restoreStarted.id);
  assert.equal(restored.state, 'succeeded', JSON.stringify(restored.result));
  assert.equal(restored.target.operation, 'influxdb3-core-alternate-s3-restore');
  assert.equal(restored.target.targetMutationStarted, true); assert.equal(restored.target.filesystemMutationStarted, false);
  assert.equal(restored.result.objectStore, 's3'); assert.equal(restored.result.targetStopped, true); assert.equal(restored.result.ownershipReviewRequired, false); assert.equal(restored.result.operatorReviewRequired, true); assert.equal(restored.result.rollbackClaimed, false);
  assert.equal(current.client('core-alternate-data').objects.size, 5);

  const drillTarget = await current.connections.create(WORKSPACE_ID, 'tester', connectionInput({ name: 'Core S3 drill', host: '127.0.0.3', objectStoreBucket: 'core-drill-data', objectStorePrefix: 'drill' }));
  await current.connections.test(WORKSPACE_ID, drillTarget.id, 'tester');
  current.client('core-drill-data').objects.clear(); current.stopHost('127.0.0.3');
  const recoveryTests = new InfluxDb3CoreRecoveryTestService({ controlDatabase: current.controlDatabase, adapter: current.adapter, connectionService: current.connections, restoreService, deviceId: DEVICE_ID });
  const metadataStarted = await recoveryTests.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: METADATA_MODE });
  const metadataRun = await recoveryTests.wait(WORKSPACE_ID, metadataStarted.id);
  assert.equal(metadataRun.state, 'succeeded', JSON.stringify(metadataRun.result)); assert.equal(metadataRun.evidence.objectStore, 's3'); assert.equal(metadataRun.evidence.fullRestorePerformed, false);
  const drillStarted = await recoveryTests.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: DRILL_MODE, targetConnectionId: drillTarget.id, confirmed: true, confirmationText: DRILL_CONFIRMATION });
  const drillRun = await recoveryTests.wait(WORKSPACE_ID, drillStarted.id);
  assert.equal(drillRun.state, 'succeeded', JSON.stringify(drillRun.result)); assert.equal(drillRun.evidence.objectStore, 's3'); assert.equal(drillRun.evidence.operatorReviewRequired, true); assert.equal(drillRun.evidence.cleanupPerformed, false); assert.equal(drillRun.evidence.rollbackPerformed, false);
  assert.equal(current.client('core-drill-data').objects.size, 5);

  const failedTarget = await current.connections.create(WORKSPACE_ID, 'tester', connectionInput({ name: 'Core S3 partial', host: '127.0.0.4', objectStoreBucket: 'core-partial-data', objectStorePrefix: 'partial' }));
  await current.connections.test(WORKSPACE_ID, failedTarget.id, 'tester');
  const failedClient = current.client('core-partial-data'); failedClient.objects.clear(); failedClient.failPutKey = `partial/${NODE_ID}/wal/0001/wal.log`; current.stopHost('127.0.0.4');
  const failedStarted = await restoreService.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, targetConnectionId: failedTarget.id, mode: 'alternate', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const failedRestore = await restoreService.wait(WORKSPACE_ID, failedStarted.id);
  assert.equal(failedRestore.state, 'interrupted'); assert.equal(failedRestore.target.targetMutationStarted, true); assert.equal(failedRestore.result.targetPreserved, true); assert.equal(failedRestore.result.rollbackClaimed, false);
  assert.equal(failedClient.objects.has(`partial/${NODE_ID}/_catalog_checkpoint`), true); assert.equal(failedClient.objects.has(`partial/${NODE_ID}/catalog/0001/catalog.log`), true);
  const boundedEvidence = JSON.stringify({ preview, restored, metadataRun, drillRun, failedRestore });
  for (const privateValue of [ACCESS_KEY, SECRET_KEY, target.secretRefIds[0], drillTarget.secretRefIds[0], failedTarget.secretRefIds[0], 'core-alternate-data', 'core-drill-data', 'core-partial-data', 'alternate/', 'drill/', 'partial/']) assert.equal(boundedEvidence.includes(privateValue), false, `Recovery evidence disclosed ${privateValue}.`);
});
