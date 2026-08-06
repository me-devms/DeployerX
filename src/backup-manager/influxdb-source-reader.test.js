const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { BackupJobService, sourceReadiness } = require('./backup-job');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { ADAPTER_ID, ADAPTER_VERSION, RESTORE_CONFIRMATION, InfluxDbConnectionService, InfluxDbOssV2Adapter } = require('./influxdb');
const { InfluxDbRestoreService } = require('./influxdb-restore');
const { InfluxDbSourceReaderService } = require('./influxdb-source-reader');
const { LocalFolderRepositoryAdapter } = require('./local-repository');
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { ManualBackupService } = require('./manual-backup');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, MIN_CHUNK_SIZE_BYTES, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');

const TOKEN = 'source-reader-token';
const SECRET_REF_ID = 'sec_influx_source';
const ORG_ID = '0123456789abcdef';
const BUCKET_ID = 'fedcba9876543210';
const OTHER_BUCKET_ID = '1111111111111111';

class MemoryRepositoryAdapter {
  constructor() { this.objects = new Map(); this.sessions = new Map(); this.sequence = 0; }
  async stat(_context, key) { const body = this.objects.get(key); return body ? { key, sizeBytes: body.length } : null; }
  async read(_context, request) { const body = this.objects.get(request.key); if (!body) throw new Error('missing'); return Buffer.from(body); }
  async write(_context, request) { const session = { id: `write-${++this.sequence}`, ...request }; this.sessions.set(session.id, session); return session; }
  async commit(_context, session) { this.objects.set(session.key, Buffer.from(session.body)); this.sessions.delete(session.id); return { key: session.key, sizeBytes: session.body.length, checksum: session.checksum }; }
  async abort(_context, session) { this.sessions.delete(session.id); }
}

function transport({ apiPath, authorization }) {
  assert.equal(authorization, `Token ${TOKEN}`);
  if (apiPath === '/health') return Promise.resolve({ body: { name: 'influxdb', status: 'pass', version: '2.7.11' } });
  if (apiPath === '/api/v2/orgs') return Promise.resolve({ body: { orgs: [{ id: ORG_ID, name: 'Production', status: 'active' }], total: 1 } });
  if (apiPath === '/api/v2/buckets') return Promise.resolve({ body: { buckets: [
    { id: BUCKET_ID, orgID: ORG_ID, name: 'metrics', type: 'user', retentionRules: [{ type: 'expire', everySeconds: 86400, shardGroupDurationSeconds: 3600 }] },
    { id: OTHER_BUCKET_ID, orgID: ORG_ID, name: 'logs', type: 'user', retentionRules: [] }
  ], total: 2 } });
  throw new Error(`Unexpected API path: ${apiPath}`);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  t.after(() => controlDatabase.close());
  const commands = [];
  const adapter = new InfluxDbOssV2Adapter({
    transport,
    commandRunner: async (input) => {
      commands.push({ args: [...input.args], env: input.env });
      if (input.args[0] === 'version') return { stdout: 'Influx CLI 2.7.5', stderr: '', exitCode: 0 };
      const destination = input.args.at(-1);
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, '20260805T120000Z.manifest'), '{"version":1,"scope":"bucket"}');
      await fs.writeFile(path.join(destination, '20260805T120000Z.tar.gz'), 'protected-influxdb-bucket');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    clock: () => '2026-08-05T12:00:00.000Z'
  });
  const secretStore = {
    resolve: async ({ id }) => {
      assert.equal(id, SECRET_REF_ID);
      return TOKEN;
    }
  };
  const config = { protocol: 'https', host: 'influx.example.com', port: 8086, tokenSecretRefId: SECRET_REF_ID, cliPath: 'influx' };
  const identity = await adapter.readIdentity({ resolveSecret: () => TOKEN }, config);
  await controlDatabase.repository('secretRef').create({
    id: SECRET_REF_ID, workspaceId: 'workspace-a', actorId: 'tester', name: 'InfluxDB API token', provider: 'electron-safe-storage',
    scope: 'device', providerKey: SECRET_REF_ID, secretType: 'token', version: 1
  });
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Production InfluxDB', kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION,
    endpoint: { protocol: 'https', allowInsecureHttp: false, host: 'influx.example.com', port: 8086, basePath: '', caFile: null, cliPath: 'influx', timeoutMs: 30000, expectedVersion: identity.version.text, expectedCliVersion: identity.cliVersion.text, expectedDeploymentFingerprint: identity.deploymentFingerprint },
    secretRefIds: [SECRET_REF_ID], workerAffinity: ['device:device-a'], lastTest: { status: 'success', endpointIdentity: { product: identity.product, version: identity.version.text, cliVersion: identity.cliVersion.text, deploymentFingerprint: identity.deploymentFingerprint, inventoryFingerprint: identity.inventoryFingerprint } },
    trust: { mode: 'https', fingerprint: identity.deploymentFingerprint, inventoryFingerprint: identity.inventoryFingerprint },
    influxdbInventory: { version: 1, product: identity.product, productVersion: identity.version.text, cliVersion: identity.cliVersion.text, deploymentFingerprint: identity.deploymentFingerprint, inventoryFingerprint: identity.inventoryFingerprint, organizations: identity.organizations, buckets: identity.buckets, tokenRecovery: identity.tokenRecovery }
  });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connectionService = new InfluxDbConnectionService({ controlDatabase, secretStore, deviceId: 'device-a', adapter });
  return { root, controlDatabase, adapter, registry, connectionService, connection, secretStore, commands };
}

test('enrolls one exact bucket and streams authenticated native members through the Source reader', async (t) => {
  const item = await fixture(t);
  const sources = new DatabaseSourceService({ controlDatabase: item.controlDatabase, adapterRegistry: item.registry, deviceId: 'device-a', clock: () => '2026-08-05T12:00:00.000Z' });
  const source = await sources.save('workspace-a', 'tester', {
    name: 'Production metrics', connectionId: item.connection.id,
    selector: { databases: { include: [{ name: 'Production' }] }, tables: { include: [{ database: 'Production', schema: 'Production', name: 'metrics' }] } },
    consistency: { requestedLevel: 'application', method: 'influxdb-v2-native-backup', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true }
  });
  assert.equal(source.enabled, true);
  assert.equal(source.physicalExecution.scope, 'bucket');
  assert.equal(source.physicalExecution.organizationId, ORG_ID);
  assert.equal(source.physicalExecution.bucketId, BUCKET_ID);
  assert.deepEqual(sourceReadiness(source, item.connection, 'device-a'), { ready: true, reasonCode: null, message: 'Ready' });
  const changedConnection = { ...item.connection, influxdbInventory: { ...item.connection.influxdbInventory, inventoryFingerprint: `sha256:${'0'.repeat(64)}` } };
  assert.equal(sourceReadiness(source, changedConnection, 'device-a').reasonCode, 'INFLUXDB_SOURCE_IDENTITY_CHANGED');
  const temporaryRoot = path.join(item.root, 'temporary');
  const reader = new InfluxDbSourceReaderService({ controlDatabase: item.controlDatabase, secretStore: item.secretStore, deviceId: 'device-a', adapterRegistry: item.registry, adapter: item.adapter, connectionService: item.connectionService, temporaryRoot });
  const opened = await reader.files('workspace-a', source.id, { executionId: 'run-influx-1', backupMode: 'full' });
  assert.equal(opened.manifest.database.kind, 'influxdb-oss-v2-native-backup');
  assert.deepEqual(opened.manifest.artifactPaths, ['influxdb/backup-metadata.json']);
  const files = [];
  for await (const file of opened.create()) {
    const chunks = [];
    for await (const chunk of file.content) chunks.push(Buffer.from(chunk));
    files.push({ path: file.path, metadata: file.metadata, bytes: Buffer.concat(chunks) });
  }
  assert.deepEqual(files.map((file) => file.path), ['influxdb/backup-metadata.json', 'influxdb/native/20260805T120000Z.manifest', 'influxdb/native/20260805T120000Z.tar.gz']);
  const metadata = JSON.parse(files[0].bytes.toString('utf8'));
  assert.equal(metadata.scope.bucketId, BUCKET_ID);
  assert.equal(metadata.nativeMedia.members.length, 2);
  assert.equal(metadata.tokenRecovery, 'hash-only-plaintext-unrecoverable');
  assert.equal(JSON.stringify(metadata).includes(TOKEN), false);
  assert.equal(files[2].bytes.toString('utf8'), 'protected-influxdb-bucket');
  const backup = item.commands.find((command) => command.args[0] === 'backup');
  assert.equal(backup.env.INFLUX_TOKEN, TOKEN);
  assert.equal(backup.args.some((argument) => argument.includes(TOKEN)), false);
  const repositoryAdapter = new MemoryRepositoryAdapter();
  const repository = new FileRepositoryEngine({ adapter: repositoryAdapter, clock: () => '2026-08-05T12:01:00.000Z' });
  const masterKey = Buffer.alloc(32, 0x41);
  const snapshot = await repository.createSnapshot({}, { repositoryId: 'repo-influx', keyVersion: 'key-v1', masterKey, idempotencyKey: 'run-influx-1', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: opened.create() });
  const persistedBytes = Buffer.concat([...repositoryAdapter.objects.values()]);
  assert.equal(persistedBytes.includes(Buffer.from('protected-influxdb-bucket')), false);
  assert.equal(persistedBytes.includes(Buffer.from('Production')), false);
  const authenticated = await repository.openSnapshot({}, { repositoryId: 'repo-influx', snapshotId: snapshot.snapshotId, masterKey });
  const restoredMetadata = JSON.parse((await repository.readFile({}, { repositoryId: 'repo-influx', manifest: authenticated.manifest, path: 'influxdb/backup-metadata.json', masterKey })).toString('utf8'));
  assert.equal(restoredMetadata.nativeMedia.mediaFingerprint, metadata.nativeMedia.mediaFingerprint);
  assert.equal((await repository.readFile({}, { repositoryId: 'repo-influx', manifest: authenticated.manifest, path: 'influxdb/native/20260805T120000Z.tar.gz', masterKey })).toString('utf8'), 'protected-influxdb-bucket');
  assert.equal(await reader.release('workspace-a', 'run-influx-1'), true);
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
});

test('publishes and restores an encrypted native backup to a validated alternate instance', async (t) => {
  const item = await fixture(t);
  const sources = new DatabaseSourceService({ controlDatabase: item.controlDatabase, adapterRegistry: item.registry, deviceId: 'device-a', clock: () => '2026-08-05T12:00:00.000Z' });
  const source = await sources.save('workspace-a', 'tester', {
    name: 'Production metrics restore', connectionId: item.connection.id,
    selector: { databases: { include: [{ name: 'Production' }] }, tables: { include: [{ database: 'Production', schema: 'Production', name: 'metrics' }] } },
    consistency: { requestedLevel: 'application', method: 'influxdb-v2-native-backup', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true }
  });
  const repositoryRoot = path.join(item.root, 'repository');
  await fs.mkdir(repositoryRoot);
  const repository = await item.controlDatabase.repository('repository').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'InfluxDB encrypted repository', connectionId: null,
    adapterId: 'deployerx.repository.local-folder', adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null, encryption: { algorithm: 'aes-256-gcm', keyVersion: 'test-key-v1' },
    workerAffinity: ['device:device-a'], health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter, clock: () => '2026-08-05T12:01:00.000Z' });
  const masterKey = Buffer.alloc(32, 0x41);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const openRepository = async (_workspaceId, repositoryId) => {
    assert.equal(repositoryId, repository.id);
    return { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'test-key-v1' };
  };
  const reader = new InfluxDbSourceReaderService({ controlDatabase: item.controlDatabase, secretStore: item.secretStore, deviceId: 'device-a', adapterRegistry: item.registry, adapter: item.adapter, connectionService: item.connectionService, temporaryRoot: path.join(item.root, 'backup-stage') });
  const { job } = await new BackupJobService({ controlDatabase: item.controlDatabase, deviceId: 'device-a' }).create('workspace-a', 'tester', { name: 'InfluxDB native protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full', verifyAfterBackup: true });
  const router = new BackupSourceReaderRouter({ controlDatabase: item.controlDatabase, fileReader: {}, databaseReaders: { [ADAPTER_ID]: reader } });
  const backupService = new ManualBackupService({ controlDatabase: item.controlDatabase, sourceReader: router, checkpointStore: new RunCheckpointStore({ rootPath: path.join(item.root, 'checkpoints') }), deviceId: 'device-a', openRepository });
  const backupRun = await backupService.start('workspace-a', 'tester', job.id);
  await backupService.wait(backupRun.id);
  const completedBackupRun = await item.controlDatabase.repository('run').get('workspace-a', backupRun.id);
  assert.equal(completedBackupRun.state, 'succeeded', JSON.stringify(completedBackupRun.result));
  const [point] = await item.controlDatabase.repository('recoveryPoint').list('workspace-a', { limit: 10 });
  assert.ok(point);

  const targetOrgId = 'aaaaaaaaaaaaaaaa';
  const targetBucketId = 'bbbbbbbbbbbbbbbb';
  let restored = false;
  let restoredMember = null;
  const targetTransport = async ({ apiPath, authorization }) => {
    assert.equal(authorization, `Token ${TOKEN}`);
    if (apiPath === '/health') return { body: { name: 'influxdb', status: 'pass', version: '2.7.11' } };
    if (apiPath === '/api/v2/orgs') return { body: { orgs: restored ? [{ id: ORG_ID, name: 'Production', status: 'active' }] : [{ id: targetOrgId, name: 'Recovery target', status: 'active' }], total: 1 } };
    if (apiPath === '/api/v2/buckets') return { body: { buckets: restored ? [{ id: BUCKET_ID, orgID: ORG_ID, name: 'metrics', type: 'user', retentionRules: [{ type: 'expire', everySeconds: 86400, shardGroupDurationSeconds: 3600 }] }] : [{ id: targetBucketId, orgID: targetOrgId, name: '_tasks', type: 'system', retentionRules: [] }], total: 1 } };
    throw new Error(`Unexpected target API path: ${apiPath}`);
  };
  const targetCommands = [];
  const targetAdapter = new InfluxDbOssV2Adapter({
    transport: targetTransport,
    commandRunner: async (input) => {
      targetCommands.push({ args: [...input.args], env: input.env });
      if (input.args[0] === 'version') return { stdout: 'Influx CLI 2.7.5', stderr: '', exitCode: 0 };
      assert.equal(input.args[0], 'restore');
      restoredMember = await fs.readFile(path.join(input.args.at(-1), '20260805T120000Z.tar.gz'), 'utf8');
      restored = true;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    clock: () => '2026-08-05T12:02:00.000Z'
  });
  const targetBaseConfig = { protocol: 'https', host: 'recovery.example.com', port: 8086, tokenSecretRefId: SECRET_REF_ID, cliPath: 'influx' };
  const targetIdentity = await targetAdapter.readIdentity({ resolveSecret: () => TOKEN }, targetBaseConfig);
  const targetConnection = await item.controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'InfluxDB recovery', kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION,
    endpoint: { protocol: 'https', allowInsecureHttp: false, host: 'recovery.example.com', port: 8086, basePath: '', caFile: null, cliPath: 'influx', timeoutMs: 30000, expectedVersion: targetIdentity.version.text, expectedCliVersion: targetIdentity.cliVersion.text, expectedDeploymentFingerprint: targetIdentity.deploymentFingerprint },
    secretRefIds: [SECRET_REF_ID], workerAffinity: ['device:device-a'], lastTest: { status: 'success', endpointIdentity: { product: targetIdentity.product, version: targetIdentity.version.text, cliVersion: targetIdentity.cliVersion.text, deploymentFingerprint: targetIdentity.deploymentFingerprint, inventoryFingerprint: targetIdentity.inventoryFingerprint } },
    trust: { mode: 'https', fingerprint: targetIdentity.deploymentFingerprint, inventoryFingerprint: targetIdentity.inventoryFingerprint }
  });
  const targetConnectionService = new InfluxDbConnectionService({ controlDatabase: item.controlDatabase, secretStore: item.secretStore, deviceId: 'device-a', adapter: targetAdapter });
  const restoreRoot = path.join(item.root, 'restore-stage');
  const restoreService = new InfluxDbRestoreService({ controlDatabase: item.controlDatabase, deviceId: 'device-a', adapter: targetAdapter, connectionService: targetConnectionService, openRepository, temporaryRoot: restoreRoot, clock: () => '2026-08-05T12:02:00.000Z' });
  const preview = await restoreService.preview('workspace-a', { recoveryPointId: point.id, targetConnectionId: targetConnection.id });
  assert.equal(preview.scope, 'bucket');
  assert.equal(preview.bucket.id, BUCKET_ID);
  assert.equal(preview.sourceDeploymentProtected, true);
  const restoreRun = await restoreService.start('workspace-a', 'tester', { recoveryPointId: point.id, targetConnectionId: targetConnection.id, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await restoreService.wait('workspace-a', restoreRun.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.target.nativeMutationStarted, true);
  assert.equal(completed.result.organization.id, ORG_ID);
  assert.equal(completed.result.buckets[0].retentionRules[0].everySeconds, 86400);
  assert.equal(completed.result.rollbackClaimed, false);
  assert.equal(restoredMember, 'protected-influxdb-bucket');
  const nativeRestore = targetCommands.find((command) => command.args[0] === 'restore');
  assert.deepEqual(nativeRestore.args.slice(0, -1), ['restore', '--host', 'https://recovery.example.com:8086', '--bucket-id', BUCKET_ID]);
  assert.equal(nativeRestore.env.INFLUX_TOKEN, TOKEN);
  assert.equal(JSON.stringify(completed).includes(nativeRestore.args.at(-1)), false);
  assert.deepEqual(await fs.readdir(restoreRoot), []);

  const interrupted = await item.controlDatabase.repository('restoreRun').create({
    workspaceId: 'workspace-a', actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: targetConnection.id,
    target: { ...completed.target, nativeMutationStarted: true }, mode: 'alternate', conflictPolicy: 'fail', workerId: 'device:device-a', state: 'running',
    progress: { phase: 'restoring', itemsTotal: 2, itemsCompleted: 0, bytesTotal: 100, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: '2026-08-05T12:00:00.000Z', updatedAt: '2026-08-05T12:00:00.000Z', warnings: [] }, validation: null, result: null
  });
  const reconciled = (await restoreService.reconcile('workspace-a', 'tester')).find((record) => record.id === interrupted.id);
  assert.equal(reconciled.state, 'succeeded');
  assert.equal(reconciled.result.reconciledAfterRestart, true);
  assert.equal(JSON.stringify(reconciled).includes('influxdb/native/'), false);
  const manifestPath = path.join(repositoryAdapter.objectsPath, ...point.repositoryCopies[0].manifestLocator.split('/'));
  const encryptedManifest = await fs.readFile(manifestPath);
  encryptedManifest[encryptedManifest.length - 1] ^= 0xff;
  await fs.writeFile(manifestPath, encryptedManifest);
  await assert.rejects(restoreService.authenticateRecoveryPoint('workspace-a', point.id), (error) => error.category === 'integrity');
});

test('refuses ambiguous multiple-bucket and system-shaped Source selections', async (t) => {
  const item = await fixture(t);
  const sources = new DatabaseSourceService({ controlDatabase: item.controlDatabase, adapterRegistry: item.registry, deviceId: 'device-a' });
  const consistency = { requestedLevel: 'application', method: 'influxdb-v2-native-backup', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true };
  await assert.rejects(sources.save('workspace-a', 'tester', {
    name: 'Ambiguous buckets', connectionId: item.connection.id,
    selector: { databases: { include: [{ name: 'Production' }] }, tables: { include: [{ database: 'Production', schema: 'Production', name: 'metrics' }, { database: 'Production', schema: 'Production', name: 'logs' }] } }, consistency
  }), /optional one exact bucket/);
  await assert.rejects(sources.save('workspace-a', 'tester', {
    name: 'System bucket', connectionId: item.connection.id,
    selector: { databases: { include: [{ name: 'Production' }] }, tables: { include: [{ database: 'Production', schema: 'Production', name: '_monitoring' }] } }, consistency
  }), /absent from trusted inventory/);
});
