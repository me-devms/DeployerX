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
const { ADAPTER_ID, BIND_CONFIRMATION, CONSISTENCY_CONFIRMATIONS, CONSISTENCY_METHODS, RESTORE_CONFIRMATION, RESTORE_PHASES, InfluxDb3CoreAdapter, InfluxDb3CoreConnectionService } = require('./influxdb3-core');
const { InfluxDb3CoreRestoreService, RESTORE_OPERATION } = require('./influxdb3-core-restore');
const { InfluxDb3CoreSourceReaderService } = require('./influxdb3-core-source-reader');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'influxdb3-core-restore-device';
const NODE_ID = 'node-production-01';

function pingResponse(version = '3.11.0') { return { statusCode: 200, headers: { 'x-influxdb-build': 'Core', 'x-influxdb-version': version }, body: JSON.stringify({ version, revision: 'restore-test', process_id: '1234' }) }; }

async function createLayout(dataRoot, marker) {
  const node = path.join(dataRoot, NODE_ID);
  for (const directory of ['snapshots/0001/empty', 'dbs/db-a', 'wal/0001', 'catalog/0001', 'table-snapshots/regenerable']) await fs.mkdir(path.join(node, directory), { recursive: true });
  await fs.writeFile(path.join(node, 'snapshots/0001/snapshot.parquet'), `${marker}-snapshot`);
  await fs.writeFile(path.join(node, 'dbs/db-a/data.parquet'), `${marker}-database`);
  await fs.writeFile(path.join(node, 'wal/0001/wal.log'), `${marker}-wal`);
  await fs.writeFile(path.join(node, 'catalog/0001/catalog.log'), `${marker}-catalog`);
  await fs.writeFile(path.join(node, '_catalog_checkpoint'), `${marker}-checkpoint`);
  await fs.writeFile(path.join(node, 'table-snapshots/regenerable/derived.parquet'), `${marker}-excluded`);
  return node;
}

async function fixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-restore-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDataRoot = path.join(root, 'source-data'); const targetDataRoot = path.join(root, 'target-data');
  const sourceNode = await createLayout(sourceDataRoot, 'protected'); const targetNode = await createLayout(targetDataRoot, 'empty-target');
  const onlineRoots = new Set([sourceDataRoot, targetDataRoot]); const phaseEvents = [];
  class ObservedAdapter extends InfluxDb3CoreAdapter {
    async executeRestore(executionContext, plan) {
      try { return await super.executeRestore({ ...executionContext, onProgress: async (event) => { phaseEvents.push(event.component); await executionContext.onProgress?.(event); } }, plan); }
      catch (error) { this.lastRestoreError = error; throw error; }
    }
  }
  const transport = async ({ config }) => { if (onlineRoots.has(config.dataRoot)) return pingResponse(options.targetVersion && config.dataRoot === targetDataRoot ? options.targetVersion : '3.11.0'); const error = new Error('offline'); error.category = 'connectivity'; throw error; };
  const adapter = new ObservedAdapter({ transport, clock: () => '2026-08-05T15:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]); const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') }); await controlDatabase.initialize(); context.after(() => controlDatabase.close());
  const connections = new InfluxDb3CoreConnectionService({ controlDatabase, deviceId: DEVICE_ID, adapter });
  const sourceConnection = await connections.create(WORKSPACE_ID, 'tester', { name: 'Core source', protocol: 'http', allowInsecureHttp: true, host: 'source.local', port: 8181, dataRoot: sourceDataRoot, nodeId: NODE_ID, confirmationText: BIND_CONFIRMATION });
  const targetConnection = await connections.create(WORKSPACE_ID, 'tester', { name: 'Core alternate target', protocol: 'http', allowInsecureHttp: true, host: 'target.local', port: 8181, dataRoot: targetDataRoot, nodeId: options.targetNodeId || NODE_ID, confirmationText: BIND_CONFIRMATION });
  const testedSource = (await connections.test(WORKSPACE_ID, sourceConnection.id, 'tester')).connection;
  const testedTarget = (await connections.test(WORKSPACE_ID, targetConnection.id, 'tester')).connection;
  const source = await new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, deviceId: DEVICE_ID }).save(WORKSPACE_ID, 'tester', { name: 'Core source', connectionId: testedSource.id, selector: { allDatabases: true }, consistency: { requestedLevel: 'application', method: CONSISTENCY_METHODS['atomic-snapshot'], backupMethod: 'physical', backupMode: 'full', captureCoordinates: false }, physicalExecution: { consistencyMode: 'atomic-snapshot', confirmationText: CONSISTENCY_CONFIRMATIONS['atomic-snapshot'] } });
  const repositoryRoot = path.join(root, 'repository'); await fs.mkdir(repositoryRoot);
  const repository = await controlDatabase.repository('repository').create({ workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Core repository', connectionId: null, adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION, location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null, encryption: { algorithm: 'aes-256-gcm', keyVersion: 'restore-key-v1' }, workerAffinity: [`device:${DEVICE_ID}`], health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } } });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot }); await repositoryAdapter.initialize(); const engine = new FileRepositoryEngine({ adapter: repositoryAdapter }); const masterKey = Buffer.alloc(32, 17); await engine.ensureRepository({}, { repositoryId: repository.id });
  const reader = new InfluxDb3CoreSourceReaderService({ controlDatabase, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, connectionService: connections, temporaryRoot: path.join(root, 'backup-temp') });
  const { job } = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', { name: 'Core protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full', verifyAfterBackup: true });
  const router = new BackupSourceReaderRouter({ controlDatabase, fileReader: new FileSourceReaderService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID }), databaseReaders: { [ADAPTER_ID]: reader } });
  const opened = { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'restore-key-v1' };
  const backupService = new ManualBackupService({ controlDatabase, sourceReader: router, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID, openRepository: async () => opened });
  const started = await backupService.start(WORKSPACE_ID, 'tester', job.id); await backupService.wait(started.id); const [point] = await controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  await fs.rm(targetNode, { recursive: true, force: true }); onlineRoots.delete(targetDataRoot);
  const openRepository = options.openRepository || (async () => opened);
  const restoreService = new InfluxDb3CoreRestoreService({ controlDatabase, deviceId: DEVICE_ID, adapter, connectionService: connections, openRepository, temporaryRoot: path.join(root, 'restore-temp'), clock: () => '2026-08-05T15:00:00.000Z' });
  return { root, sourceDataRoot, sourceNode, targetDataRoot, targetNode, onlineRoots, phaseEvents, adapter, registry, controlDatabase, connections, source, testedSource, testedTarget, repository, repositoryAdapter, engine, masterKey, opened, point, restoreService };
}

test('previews and restores authenticated media to an exact stopped alternate target in documented order', async (context) => {
  const value = await fixture(context);
  const preview = await value.restoreService.preview(WORKSPACE_ID, { recoveryPointId: value.point.id, targetConnectionId: value.testedTarget.id });
  assert.equal(preview.targetStopped, true); assert.equal(preview.targetNodeAbsent, true); assert.equal(preview.originalTargetReplacement, false); assert.equal(preview.automaticStartup, false); assert.equal(preview.ownershipReviewRequired, true); assert.equal(preview.confirmationText, RESTORE_CONFIRMATION);
  const started = await value.restoreService.start(WORKSPACE_ID, 'tester', { recoveryPointId: value.point.id, targetConnectionId: value.testedTarget.id, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await value.restoreService.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify({ result: completed.result, adapterError: value.adapter.lastRestoreError && { code: value.adapter.lastRestoreError.code, message: value.adapter.lastRestoreError.message, stack: value.adapter.lastRestoreError.stack } }));
  assert.deepEqual(value.phaseEvents, RESTORE_PHASES.map((phase) => phase.name));
  assert.equal(completed.validation.nativeIntegrityValidation, true); assert.equal(completed.result.targetStopped, true); assert.equal(completed.result.automaticStartup, false); assert.equal(completed.result.ownershipReviewRequired, true); assert.equal(completed.result.rollbackClaimed, false);
  assert.equal(await fs.readFile(path.join(value.targetNode, 'snapshots/0001/snapshot.parquet'), 'utf8'), 'protected-snapshot');
  assert.equal(await fs.readFile(path.join(value.targetNode, '_catalog_checkpoint'), 'utf8'), 'protected-checkpoint');
  assert.equal((await fs.lstat(path.join(value.targetNode, 'snapshots/0001/empty'))).isDirectory(), true);
  assert.equal(await fs.lstat(path.join(value.targetNode, 'table-snapshots')).catch(() => null), null);
  assert.equal((await fs.readdir(value.targetDataRoot)).some((name) => name.startsWith('.deployerx-influxdb3-core-restore-')), false);
  const serialized = JSON.stringify(completed);
  assert.equal(serialized.includes(value.targetDataRoot), false); assert.equal(serialized.includes('snapshots/0001/snapshot.parquet'), false); assert.equal(serialized.includes('.deployerx-influxdb3-core-restore-'), false);

  const interrupted = await value.controlDatabase.repository('restoreRun').create({ workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [value.point.id], targetConnectionId: value.testedTarget.id, target: { ...completed.target, filesystemMutationStarted: true }, mode: 'alternate', conflictPolicy: 'fail', workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'restoring', itemsTotal: 5, itemsCompleted: 5, bytesTotal: completed.result.bytesRestored, bytesWritten: completed.result.bytesRestored, updatedAt: '2026-08-05T15:00:00.000Z' }, validation: null, result: null });
  const reconciled = await value.restoreService.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.find((item) => item.id === interrupted.id).state, 'succeeded');
  assert.equal(reconciled.find((item) => item.id === interrupted.id).result.reconciledAfterRestart, true);
});

test('rejects a running, occupied, same-deployment, or wrong-version target before mutation', async (context) => {
  const running = await fixture(context);
  const authenticated = await running.restoreService.authenticateRecoveryPoint(WORKSPACE_ID, running.point.id);
  const targetConfig = running.connections.config(running.testedTarget);
  const targetIdentity = { version: running.testedTarget.lastTest.endpointIdentity.version, deploymentFingerprint: running.testedTarget.lastTest.endpointIdentity.deploymentFingerprint, dataRootFingerprint: running.testedTarget.lastTest.endpointIdentity.dataRootFingerprint };
  await assert.rejects(running.adapter.planRestore({}, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection: { ...targetConfig, nodeId: 'wrong-node' }, source: authenticated.sourceEvidence, targetIdentity, executionId: 'wrong-node-test' }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_VERSION_INCOMPATIBLE');
  await assert.rejects(running.adapter.planRestore({}, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection: targetConfig, source: authenticated.sourceEvidence, targetIdentity: { ...targetIdentity, version: '3.10.0' }, executionId: 'wrong-version-test' }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_VERSION_INCOMPATIBLE');
  running.onlineRoots.add(running.targetDataRoot);
  await assert.rejects(running.restoreService.preview(WORKSPACE_ID, { recoveryPointId: running.point.id, targetConnectionId: running.testedTarget.id }), (error) => error.code === 'INFLUXDB3_CORE_NODE_STILL_RUNNING');
  running.onlineRoots.delete(running.targetDataRoot); await fs.mkdir(running.targetNode);
  await assert.rejects(running.restoreService.preview(WORKSPACE_ID, { recoveryPointId: running.point.id, targetConnectionId: running.testedTarget.id }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_TARGET_EXISTS');
  await fs.rm(running.targetNode, { recursive: true, force: true });
  let current = await running.controlDatabase.repository('connection').get(WORKSPACE_ID, running.testedTarget.id);
  const sourceFingerprint = running.testedSource.lastTest.endpointIdentity.deploymentFingerprint;
  current = await running.controlDatabase.repository('connection').update(WORKSPACE_ID, current.id, { endpoint: { ...current.endpoint, expectedDeploymentFingerprint: sourceFingerprint }, trust: { ...current.trust, fingerprint: sourceFingerprint }, lastTest: { ...current.lastTest, endpointIdentity: { ...current.lastTest.endpointIdentity, deploymentFingerprint: sourceFingerprint } } }, { expectedRevision: current.revision, actorId: 'tester' });
  await assert.rejects(running.restoreService.preview(WORKSPACE_ID, { recoveryPointId: running.point.id, targetConnectionId: running.testedTarget.id }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_TARGET_CONNECTION_INVALID');
  const targetFingerprint = running.testedTarget.lastTest.endpointIdentity.deploymentFingerprint;
  const changed = { ...current.lastTest, endpointIdentity: { ...current.lastTest.endpointIdentity, deploymentFingerprint: targetFingerprint, version: '3.10.0' } };
  await running.controlDatabase.repository('connection').update(WORKSPACE_ID, current.id, { endpoint: { ...current.endpoint, expectedDeploymentFingerprint: targetFingerprint }, trust: { ...current.trust, fingerprint: targetFingerprint }, lastTest: changed }, { expectedRevision: current.revision, actorId: 'tester' });
  await assert.rejects(running.restoreService.preview(WORKSPACE_ID, { recoveryPointId: running.point.id, targetConnectionId: running.testedTarget.id }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_TARGET_CONNECTION_INVALID');
});

test('detects corrupted encrypted member streaming before target mutation', async (context) => {
  const value = await fixture(context);
  const corruptedEngine = Object.create(value.engine);
  corruptedEngine.streamFile = function streamFile(contextValue, request) {
    if (String(request.path).includes('/snapshots/')) return (async function* corrupted() { yield Buffer.from('corrupted-protected-member'); })();
    return value.engine.streamFile(contextValue, request);
  };
  const service = new InfluxDb3CoreRestoreService({ controlDatabase: value.controlDatabase, deviceId: DEVICE_ID, adapter: value.adapter, connectionService: value.connections, openRepository: async () => ({ ...value.opened, engine: corruptedEngine }), temporaryRoot: path.join(value.root, 'corrupt-restore-temp') });
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: value.point.id, targetConnectionId: value.testedTarget.id, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed'); assert.equal(completed.target.filesystemMutationStarted, false); assert.equal(completed.result.error.code, 'INFLUXDB3_CORE_RESTORE_MEDIA_INVALID');
  assert.equal(await fs.lstat(value.targetNode).catch(() => null), null);
  assert.equal((await fs.readdir(value.targetDataRoot)).some((name) => name.startsWith('.deployerx-influxdb3-core-restore-')), false);
});

test('cancellation after target mutation preserves the owned target stage and claims no rollback', async (context) => {
  const value = await fixture(context); let phaseStartedResolve; const phaseStarted = new Promise((resolve) => { phaseStartedResolve = resolve; }); let blocked = false;
  const cancelAdapter = Object.create(value.adapter);
  cancelAdapter.executeRestore = (executionContext, plan) => value.adapter.executeRestore({ ...executionContext, onProgress: async (event) => { await executionContext.onProgress?.(event); if (!blocked) { blocked = true; phaseStartedResolve(); await new Promise((resolve) => executionContext.signal.addEventListener('abort', resolve, { once: true })); } } }, plan);
  const service = new InfluxDb3CoreRestoreService({ controlDatabase: value.controlDatabase, deviceId: DEVICE_ID, adapter: cancelAdapter, connectionService: value.connections, openRepository: async () => value.opened, temporaryRoot: path.join(value.root, 'cancel-restore-temp') });
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: value.point.id, targetConnectionId: value.testedTarget.id, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  await phaseStarted;
  const canceled = await service.cancel(WORKSPACE_ID, 'tester', started.id);
  assert.equal(canceled.state, 'interrupted'); assert.equal(canceled.target.filesystemMutationStarted, true); assert.equal(canceled.result.targetPreserved, true); assert.equal(canceled.result.rollbackClaimed, false); assert.equal(canceled.result.error.code, 'INFLUXDB3_CORE_RESTORE_TARGET_REQUIRES_INSPECTION');
  assert.equal(await fs.lstat(value.targetNode).catch(() => null), null);
  const stages = (await fs.readdir(value.targetDataRoot)).filter((name) => name.startsWith('.deployerx-influxdb3-core-restore-'));
  assert.equal(stages.length, 1); assert.equal((await fs.lstat(path.join(value.targetDataRoot, stages[0]))).isDirectory(), true);
  await assert.rejects(service.preview(WORKSPACE_ID, { recoveryPointId: value.point.id, targetConnectionId: value.testedTarget.id }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_STAGE_EXISTS');
});

test('registers bounded audited restore APIs and keeps source member paths out of persisted evidence', async () => {
  const [mainSource, preloadSource] = await Promise.all([fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8'), fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8')]);
  for (const operation of ['preview', 'list', 'start', 'wait', 'cancel']) {
    assert.match(mainSource, new RegExp(`ipcMain[.]handle\\('backup:influxdb3-core-restores:${operation}'`));
    assert.match(preloadSource, new RegExp(`ipcRenderer[.]invoke\\('backup:influxdb3-core-restores:${operation}'`));
  }
  assert.match(mainSource, /action: 'restore\.start-influxdb3-core-alternate'[\s\S]{0,900}getBackupInfluxDb3CoreRestoreService\(\)\.start/);
  assert.equal(RESTORE_OPERATION, 'influxdb3-core-alternate-filesystem-restore');
});
