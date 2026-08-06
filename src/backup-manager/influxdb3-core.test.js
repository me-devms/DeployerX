const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { FileSourceReaderService } = require('./file-source-reader');
const { LocalFolderRepositoryAdapter, ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const {
  ADAPTER_ID,
  BIND_CONFIRMATION,
  CONSISTENCY_CONFIRMATIONS,
  CONSISTENCY_METHODS,
  COPY_PHASES,
  InfluxDb3CoreAdapter,
  InfluxDb3CoreConnectionService,
  inspectNodeLayout,
  normalizeBackupExecution,
  normalizeConfig,
  parsePing,
  parseVersion
} = require('./influxdb3-core');
const { InfluxDb3CoreSourceReaderService, preparationPrefix } = require('./influxdb3-core-source-reader');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'influxdb3-core-device';
const NODE_ID = 'node-production-01';

function pingResponse(version = '3.11.0') {
  return { statusCode: 200, headers: { 'x-influxdb-build': 'Core', 'x-influxdb-version': version }, body: JSON.stringify({ version, revision: 'abc123def', process_id: '1234' }) };
}

async function coreLayout(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'influx-data');
  const node = path.join(dataRoot, NODE_ID);
  for (const directory of ['snapshots/0001', 'dbs/db-a', 'wal/0001', 'catalog/0001', 'table-snapshots/regenerable']) await fs.mkdir(path.join(node, directory), { recursive: true });
  await fs.writeFile(path.join(node, 'snapshots/0001/snapshot.parquet'), 'snapshot-bytes');
  await fs.writeFile(path.join(node, 'dbs/db-a/data.parquet'), 'database-bytes');
  await fs.writeFile(path.join(node, 'wal/0001/wal.log'), 'wal-bytes');
  await fs.writeFile(path.join(node, 'catalog/0001/catalog.log'), 'catalog-bytes');
  await fs.writeFile(path.join(node, '_catalog_checkpoint'), 'checkpoint-bytes');
  await fs.writeFile(path.join(node, 'table-snapshots/regenerable/derived.parquet'), 'excluded-bytes');
  return { root, dataRoot, node };
}

function config(dataRoot, overrides = {}) {
  return { protocol: 'http', allowInsecureHttp: true, host: '127.0.0.1', port: 8181, dataRoot, nodeId: NODE_ID, filesystemBindingConfirmed: true, ...overrides };
}

test('normalizes a filesystem-only Core binding and validates /ping product identity', async (context) => {
  const { dataRoot } = await coreLayout(context);
  assert.deepEqual(normalizeConfig(config(dataRoot)), {
    protocol: 'http', allowInsecureHttp: true, host: '127.0.0.1', port: 8181, basePath: '', caFile: null, timeoutMs: 30000,
    dataRoot, nodeId: NODE_ID, filesystemBindingConfirmed: true, expectedVersion: null, expectedDeploymentFingerprint: null, expectedStorageFingerprint: null
  });
  assert.deepEqual(parseVersion('v3.11.0'), { text: '3.11.0', major: 3, minor: 11, patch: 0 });
  assert.equal(parsePing(pingResponse()).product, 'influxdb3-core');
  assert.throws(() => normalizeConfig({ ...config(dataRoot), protocol: 'http', allowInsecureHttp: false }), /explicit insecure-transport approval/);
  assert.throws(() => normalizeConfig({ ...config(dataRoot), nodeId: '../other' }), /node ID is invalid/);
  assert.throws(() => parseVersion('2.7.11'), (error) => error.code === 'INFLUXDB3_CORE_VERSION_UNSUPPORTED');
  assert.throws(() => parsePing({ ...pingResponse(), headers: { 'x-influxdb-build': 'Enterprise', 'x-influxdb-version': '3.11.0' } }), (error) => error.code === 'INFLUXDB3_CORE_PRODUCT_UNSUPPORTED');
});

test('inspects the exact safe node layout and excludes regenerable table snapshots', async (context) => {
  const { dataRoot, node } = await coreLayout(context);
  const inspected = await inspectNodeLayout(config(dataRoot));
  assert.deepEqual(inspected.phases.map((phase) => phase.phase), COPY_PHASES.map((phase) => phase.name));
  assert.deepEqual(inspected.excluded, ['table-snapshots/']);
  assert.equal(inspected.fileCount, 5);
  assert.equal(inspected.phases.some((phase) => phase.files.some((file) => file.relativePath.includes('table-snapshots'))), false);
  const unsafe = path.join(node, 'wal', 'unsafe-link');
  try {
    await fs.symlink(path.join(node, '_catalog_checkpoint'), unsafe);
    await assert.rejects(inspectNodeLayout(config(dataRoot)), (error) => error.code === 'INFLUXDB3_CORE_LINK_REFUSED');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
});

test('advertises full object-store backup and binds every consistency proof honestly', async (context) => {
  const { dataRoot } = await coreLayout(context);
  const adapter = new InfluxDb3CoreAdapter({ transport: async () => pingResponse(), clock: () => '2026-08-05T12:00:00.000Z' });
  const manifest = new DatabaseAdapterRegistry([adapter]).manifest(ADAPTER_ID);
  assert.equal(manifest.executionReady, true);
  assert.deepEqual(manifest.capabilities.backupModes, ['full']);
  assert.equal(manifest.capabilities.restore.alternateTarget, true);
  assert.equal(manifest.capabilities.restore.originalTarget, false);
  assert.equal(manifest.requiredTools.length, 0);
  assert.equal(manifest.capabilities.consistencyStrategies.find((item) => item.id === CONSISTENCY_METHODS['ordered-live-copy']).produces, 'crash');
  const identity = await adapter.readIdentity({}, config(dataRoot));
  for (const consistencyMode of Object.keys(CONSISTENCY_CONFIRMATIONS)) {
    const execution = normalizeBackupExecution({ consistencyMode, confirmationText: CONSISTENCY_CONFIRMATIONS[consistencyMode], nodeId: NODE_ID, deploymentFingerprint: identity.deploymentFingerprint, storageFingerprint: identity.layout.storageFingerprint, connectionRevision: 1 });
    assert.equal(execution.consistencyMethod, CONSISTENCY_METHODS[consistencyMode]);
    assert.equal(execution.operatorAttestation, consistencyMode);
  }
  assert.throws(() => normalizeBackupExecution({ consistencyMode: 'atomic-snapshot', confirmationText: 'yes', nodeId: NODE_ID, deploymentFingerprint: identity.deploymentFingerprint, storageFingerprint: identity.layout.storageFingerprint, connectionRevision: 1 }), /exact operator confirmation/);
});

test('copies every regular member in documented order with hashes and no table snapshots', async (context) => {
  const { root, dataRoot } = await coreLayout(context);
  const progress = [];
  const adapter = new InfluxDb3CoreAdapter({ transport: async () => pingResponse(), clock: () => '2026-08-05T12:00:00.000Z' });
  const identity = await adapter.readIdentity({}, config(dataRoot));
  const execution = normalizeBackupExecution({ consistencyMode: 'atomic-snapshot', confirmationText: CONSISTENCY_CONFIRMATIONS['atomic-snapshot'], nodeId: NODE_ID, deploymentFingerprint: identity.deploymentFingerprint, storageFingerprint: identity.layout.storageFingerprint, connectionRevision: 1 });
  const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, { onProgress: (event) => progress.push(event) }, {
    connection: config(dataRoot, { expectedVersion: identity.version.text, expectedDeploymentFingerprint: identity.deploymentFingerprint, expectedStorageFingerprint: identity.layout.storageFingerprint }),
    selector: { allDatabases: true }, consistency: { requestedLevel: 'application', method: CONSISTENCY_METHODS['atomic-snapshot'], backupMethod: 'physical', backupMode: 'full', captureCoordinates: false }, execution
  });
  const destination = path.join(root, 'capture');
  const media = await adapter.createBackupMedia({ onProgress: (event) => progress.push(event) }, prepared.adapterPlan, destination);
  assert.deepEqual(progress.filter((event) => event.component).map((event) => event.component), COPY_PHASES.map((phase) => phase.name));
  assert.equal(media.achievedConsistency, 'application');
  assert.equal(media.driftPhases.length, 0);
  assert.equal(media.files.length, 5);
  assert.equal(media.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.contentDigest)), true);
  assert.equal(media.files.some((file) => file.relativePath.includes('table-snapshots')), false);
  assert.equal(await fs.lstat(path.join(destination, 'table-snapshots')).catch(() => null), null);
  assert.equal((await fs.readFile(path.join(destination, '_catalog_checkpoint'), 'utf8')), 'checkpoint-bytes');
});

test('requires an unreachable endpoint for stopped-node proof', async (context) => {
  const { dataRoot } = await coreLayout(context);
  let online = true;
  const adapter = new InfluxDb3CoreAdapter({ transport: async () => { if (online) return pingResponse(); const error = new Error('offline'); error.category = 'connectivity'; throw error; } });
  const identity = await adapter.readIdentity({}, config(dataRoot));
  const connection = config(dataRoot, { expectedVersion: identity.version.text, expectedDeploymentFingerprint: identity.deploymentFingerprint, expectedStorageFingerprint: identity.layout.storageFingerprint });
  const execution = normalizeBackupExecution({ consistencyMode: 'stopped', confirmationText: CONSISTENCY_CONFIRMATIONS.stopped, nodeId: NODE_ID, deploymentFingerprint: identity.deploymentFingerprint, storageFingerprint: identity.layout.storageFingerprint, connectionRevision: 1 });
  const request = { operation: 'backup', connection, execution };
  await assert.rejects(adapter.preflight({}, request), (error) => error.code === 'INFLUXDB3_CORE_NODE_STILL_RUNNING');
  online = false;
  const preflight = await adapter.preflight({}, request);
  assert.equal(preflight.consistency[0].produces, 'application');
  assert.match(preflight.warnings[0], /operator attested/);
});

test('fails application-consistent capture on drift but records live-copy drift as crash consistency', async (context) => {
  const { root, dataRoot, node } = await coreLayout(context);
  const adapter = new InfluxDb3CoreAdapter({ transport: async () => pingResponse() });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const identity = await adapter.readIdentity({}, config(dataRoot));
  const connection = config(dataRoot, { expectedVersion: identity.version.text, expectedDeploymentFingerprint: identity.deploymentFingerprint, expectedStorageFingerprint: identity.layout.storageFingerprint });
  const prepare = (consistencyMode, requestedLevel) => registry.prepareBackup(ADAPTER_ID, {}, {
    connection, selector: { allDatabases: true },
    consistency: { requestedLevel, method: CONSISTENCY_METHODS[consistencyMode], backupMethod: 'physical', backupMode: 'full', captureCoordinates: false },
    execution: normalizeBackupExecution({ consistencyMode, confirmationText: CONSISTENCY_CONFIRMATIONS[consistencyMode], nodeId: NODE_ID, deploymentFingerprint: identity.deploymentFingerprint, storageFingerprint: identity.layout.storageFingerprint, connectionRevision: 1 })
  });
  const atomic = await prepare('atomic-snapshot', 'application');
  let changed = false;
  await assert.rejects(adapter.createBackupMedia({ onProgress: async (event) => { if (!changed && event.component === 'dbs') { changed = true; await fs.appendFile(path.join(node, 'snapshots/0001/snapshot.parquet'), '-changed'); } } }, atomic.adapterPlan, path.join(root, 'atomic-drift')), (error) => error.code === 'INFLUXDB3_CORE_SOURCE_CHANGED');
  assert.equal(await fs.lstat(path.join(root, 'atomic-drift')).catch(() => null), null);
  await assert.rejects(prepare('ordered-live-copy', 'application'), (error) => error.code === 'DATABASE_CONSISTENCY_DOWNGRADE_REFUSED');
  const live = await prepare('ordered-live-copy', 'crash');
  changed = false;
  const media = await adapter.createBackupMedia({ onProgress: async (event) => { if (!changed && event.component === 'dbs') { changed = true; await fs.appendFile(path.join(node, 'snapshots/0001/snapshot.parquet'), '-live-change'); } } }, live.adapterPlan, path.join(root, 'live-drift'));
  assert.equal(media.achievedConsistency, 'crash');
  assert.deepEqual(media.driftPhases, ['snapshots']);
});

test('enrolls a Source and publishes the complete ordered node through the encrypted repository', async (context) => {
  const { root, dataRoot } = await coreLayout(context);
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const adapter = new InfluxDb3CoreAdapter({ transport: async () => pingResponse(), clock: () => '2026-08-05T12:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new InfluxDb3CoreConnectionService({ controlDatabase, deviceId: DEVICE_ID, adapter });
  const created = await connections.create(WORKSPACE_ID, 'tester', { name: 'Core production', protocol: 'http', allowInsecureHttp: true, host: '127.0.0.1', port: 8181, dataRoot, nodeId: NODE_ID, confirmationText: BIND_CONFIRMATION });
  assert.deepEqual(created.secretRefIds, []);
  const tested = await connections.test(WORKSPACE_ID, created.id, 'tester');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.influxdb3CoreInventory.nodes[0].objectStore, 'file');
  const source = await new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, deviceId: DEVICE_ID }).save(WORKSPACE_ID, 'tester', {
    name: 'Core node protection', connectionId: created.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: CONSISTENCY_METHODS['atomic-snapshot'], backupMethod: 'physical', backupMode: 'full', captureCoordinates: false },
    physicalExecution: { consistencyMode: 'atomic-snapshot', confirmationText: CONSISTENCY_CONFIRMATIONS['atomic-snapshot'] }
  });
  assert.equal(source.physicalExecution.objectStore, 'file');
  assert.equal(source.physicalExecution.operatorAttestation, 'atomic-snapshot');
  const temporaryRoot = path.join(root, 'source-temp');
  const reader = new InfluxDb3CoreSourceReaderService({ controlDatabase, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, connectionService: connections, temporaryRoot });
  const sourcePlan = await reader.files(WORKSPACE_ID, source.id, { executionId: 'core-reader-1', backupMode: 'full' });
  const paths = [];
  for await (const item of sourcePlan.create()) { paths.push(item.path); for await (const _chunk of item.content) {} }
  assert.equal(paths[0], 'influxdb3-core/backup-metadata.json');
  assert.equal(paths.includes(`influxdb3-core/node/${NODE_ID}/_catalog_checkpoint`), true);
  assert.equal(paths.some((item) => item.includes('table-snapshots')), false);
  await reader.release(WORKSPACE_ID, 'core-reader-1');
  assert.deepEqual(await fs.readdir(temporaryRoot), []);

  const repositoryRoot = path.join(root, 'repository'); await fs.mkdir(repositoryRoot);
  const repository = await controlDatabase.repository('repository').create({ workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Core repository', connectionId: null, adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION, location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null, encryption: { algorithm: 'aes-256-gcm', keyVersion: 'core-key-v1' }, workerAffinity: [`device:${DEVICE_ID}`], health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } } });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot }); await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter }); const masterKey = Buffer.alloc(32, 11); await engine.ensureRepository({}, { repositoryId: repository.id });
  const { job } = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', { name: 'Core full backup', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full', verifyAfterBackup: true });
  const router = new BackupSourceReaderRouter({ controlDatabase, fileReader: new FileSourceReaderService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID }), databaseReaders: { [ADAPTER_ID]: reader } });
  const service = new ManualBackupService({ controlDatabase, sourceReader: router, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID, openRepository: async () => ({ repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'core-key-v1' }) });
  const started = await service.start(WORKSPACE_ID, 'tester', job.id); await service.wait(started.id);
  const completed = await controlDatabase.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  const [point] = await controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  assert.equal(point.type, 'full'); assert.equal(point.consistency, 'application');
  const artifact = (await controlDatabase.repository('artifact').list(WORKSPACE_ID, { limit: 20 })).find((item) => item.metadata?.kind === 'influxdb3-core-filesystem-full');
  assert.ok(artifact);
  assert.equal(artifact.metadata.kind, 'influxdb3-core-filesystem-full');
  assert.equal(artifact.metadata.capture.achievedConsistency, 'application');
  assert.equal(artifact.metadata.artifact.restoreSupported, true);
  assert.equal(artifact.metadata.nativeMedia.directories.includes('snapshots'), true);
  assert.match(artifact.metadata.nativeMedia.directoryFingerprint, /^sha256:[0-9a-f]{64}$/);
  const snapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey });
  const memberPath = `influxdb3-core/node/${NODE_ID}/snapshots/0001/snapshot.parquet`;
  const chunks = []; for await (const chunk of engine.streamFile({}, { repositoryId: repository.id, manifest: snapshot.manifest, masterKey, path: memberPath })) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'snapshot-bytes');
  assert.equal(snapshot.manifest.files.some((file) => file.path.includes('table-snapshots')), false);
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
});

test('reconciles only an exact ownership-fenced staging directory', async (context) => {
  const { root } = await coreLayout(context); const temporaryRoot = path.join(root, 'reconcile'); await fs.mkdir(temporaryRoot);
  const executionId = 'run-reconcile-1'; const prefix = preparationPrefix(WORKSPACE_ID, executionId);
  const owned = await fs.mkdtemp(path.join(temporaryRoot, prefix)); const unrelated = await fs.mkdtemp(path.join(temporaryRoot, prefix));
  await fs.writeFile(path.join(owned, '.owner.json'), JSON.stringify({ version: 1, workspaceId: WORKSPACE_ID, executionId }));
  await fs.writeFile(path.join(unrelated, '.owner.json'), JSON.stringify({ version: 1, workspaceId: 'other', executionId }));
  const reader = new InfluxDb3CoreSourceReaderService({ controlDatabase: {}, deviceId: DEVICE_ID, adapterRegistry: {}, adapter: {}, connectionService: {}, temporaryRoot });
  const result = await reader.reconcileRun(WORKSPACE_ID, { id: executionId });
  assert.equal(result.removedTemporaryDirectories, 1);
  assert.equal(await fs.lstat(owned).catch(() => null), null);
  assert.equal((await fs.lstat(unrelated)).isDirectory(), true);
});

test('registers separate audited Core connection APIs without changing OSS v2 channels', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8')
  ]);
  for (const operation of ['list', 'create', 'test', 'discover']) {
    assert.match(mainSource, new RegExp(`ipcMain[.]handle\\('backup:connections:influxdb3-core:${operation}'`));
    assert.match(preloadSource, new RegExp(`ipcRenderer[.]invoke\\('backup:connections:influxdb3-core:${operation}'`));
  }
  const createHandlerStart = mainSource.indexOf("ipcMain.handle('backup:connections:influxdb3-core:create'");
  const createHandlerEnd = mainSource.indexOf('\nipcMain.handle(', createHandlerStart + 1);
  const createHandler = mainSource.slice(createHandlerStart, createHandlerEnd);
  assert.match(createHandler, /action: 'connection\.create-influxdb3-core'/);
  assert.match(createHandler, /getBackupInfluxDb3CoreConnectionService\(\)\.create/);
  assert.match(createHandler, /\['file', 's3', 'azure', 'google'\]/);
  assert.match(createHandler, /azureBindingConfirmed: payload\.confirmationText === 'BIND INFLUXDB CORE AZURE'/);
  assert.match(createHandler, /gcsBindingConfirmed: payload\.confirmationText === 'BIND INFLUXDB CORE GCS'/);
  assert.match(mainSource, /action: 'connection\.test-influxdb3-core'[\s\S]{0,700}getBackupInfluxDb3CoreConnectionService\(\)\.test/);
  assert.match(mainSource, /\[INFLUXDB3_CORE_ADAPTER_ID\]: influxDb3CoreSourceReader/);
  assert.match(preloadSource, /backup:connections:influxdb:list/);
});
