const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { FileSourceReaderService } = require('./file-source-reader');
const { LocalFolderRepositoryAdapter, ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { ADAPTER_ID, MariadbConnectionService, MariadbLogicalAdapter } = require('./mariadb-logical');
const { MariadbPointInTimeRestoreService } = require('./mysql-family-pitr');
const { MariadbRestoreService, RESTORE_CONFIRMATION, RESTORE_CONFIRMATIONS } = require('./mariadb-restore');
const { MariadbSourceReaderService } = require('./mariadb-source-reader');
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const { BackupSecretStore } = require('./secrets');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'mariadb-backup-device';
const PASSWORD = 'mariadb-private-password';

function secureStorage() {
  return { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, '') };
}

class Runner {
  constructor(options = {}) {
    this.pitr = Boolean(options.pitr);
    this.status = 'mariadb-bin.000008\t7000\t\t\t0-42-30\n';
    this.dump = Buffer.from(`${this.pitr ? "-- CHANGE MASTER TO MASTER_LOG_FILE='mariadb-bin.000007', MASTER_LOG_POS=8192;\n" : '-- authenticated MariaDB logical dump\n'}CREATE DATABASE \`orders\`;\nUSE \`orders\`;\nCREATE TABLE \`items\` (\`id\` int);\n`);
    this.streamCalls = 0;
    this.restoreCalls = 0;
    this.restored = Buffer.alloc(0);
    this.databases = ['information_schema', 'orders', 'mysql'];
    this.validationDatabase = 'orders';
    this.restorePrivileges = false;
  }

  async run(input) {
    if (input.args.includes('--version')) return { stdout: `${path.basename(input.executable)} Ver 15.1 Distrib 10.11.6-MariaDB`, exitCode: 0, stderr: '' };
    if (path.basename(input.executable).toLowerCase().startsWith('mariadb-binlog') && input.args.includes('--raw')) {
      const destination = input.args.find((argument) => argument.startsWith('--result-file=')).slice('--result-file='.length);
      await fs.writeFile(path.join(destination, input.args.at(-1)), Buffer.alloc(12000, 6));
      return { stdout: '', exitCode: 0, stderr: '' };
    }
    const query = input.args.find((argument) => argument.startsWith('--execute='))?.slice(10) || '';
    if (query === 'SELECT 1;') return { stdout: '1\n', exitCode: 0, stderr: '' };
    if (query === 'SHOW DATABASES;') return { stdout: `${this.databases.join('\n')}\n`, exitCode: 0, stderr: '' };
    if (query.startsWith('CREATE DATABASE')) {
      const name = query.match(/`((?:[^`]|``)+)`/)?.[1]?.replace(/``/g, '`');
      if (name && !this.databases.includes(name)) this.databases.push(name);
      this.validationDatabase = name || this.validationDatabase;
      return { stdout: '', exitCode: 0, stderr: '' };
    }
    if (query.startsWith('SHOW GRANTS')) return { stdout: this.restorePrivileges ? 'GRANT ALL PRIVILEGES ON *.* TO `backup`@`%`\n' : `GRANT SELECT, SHOW VIEW, TRIGGER, EVENT${this.pitr ? ', RELOAD, BINLOG MONITOR, REPLICATION SLAVE' : ''} ON *.* TO \`backup\`@\`%\`\n`, exitCode: 0, stderr: '' };
    if (query.includes('@@global.log_bin')) return { stdout: '1\tROW\tFULL\tCRC32\n', exitCode: 0, stderr: '' };
    if (query === 'SHOW MASTER STATUS;') return { stdout: this.status, exitCode: 0, stderr: '' };
    if (query === 'SHOW BINARY LOGS;') return { stdout: 'mariadb-bin.000007\t10000\nmariadb-bin.000008\t9000\n', exitCode: 0, stderr: '' };
    if (query.startsWith('CHECK TABLE')) return { stdout: `${this.validationDatabase}.items\tcheck\tstatus\tOK\n`, exitCode: 0, stderr: '' };
    if (query.startsWith('SELECT SCHEMA_NAME')) return { stdout: `${this.validationDatabase}\t\tdatabase\t\n${this.validationDatabase}\titems\trelation\ttable\n`, exitCode: 0, stderr: '' };
    if (query.includes('information_schema.tables')) return { stdout: '0\n', exitCode: 0, stderr: '' };
    if (query.includes('@@character_set_server')) return { stdout: '10.11.6-MariaDB\t42\tdb-node-a\tMariaDB Server\tutf8mb4\tutf8mb4_general_ci\n', exitCode: 0, stderr: '' };
    return { stdout: '10.11.6-MariaDB\t42\tdb-node-a\tMariaDB Server\n', exitCode: 0, stderr: '' };
  }

  stream() {
    this.streamCalls += 1;
    return { stdout: Readable.from(this.dump), completion: Promise.resolve({ exitCode: 0, stderr: '' }), cancel() {} };
  }

  async consume(input) {
    const chunks = [];
    for await (const chunk of input.stdin) chunks.push(Buffer.from(chunk));
    this.restoreCalls += 1;
    this.restored = Buffer.concat(chunks);
    const selectedDatabase = this.restored.toString().match(/USE `((?:[^`]|``)+)`;/)?.[1]?.replace(/``/g, '`');
    if (selectedDatabase) {
      this.validationDatabase = selectedDatabase;
      if (!this.databases.includes(selectedDatabase)) this.databases.push(selectedDatabase);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

async function fixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mariadb-backup-test-'));
  const database = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await database.initialize();
  const secretStore = new BackupSecretStore({ rootPath: path.join(root, 'secrets'), secureStorage: secureStorage(), isReferenced: async () => false });
  await secretStore.initialize();
  context.after(async () => { await database.close(); await fs.rm(root, { recursive: true, force: true }); });

  const runner = new Runner(options);
  const credentialRoot = path.join(root, 'credentials');
  const dumpRoot = path.join(root, 'dumps');
  await fs.mkdir(credentialRoot, { recursive: true });
  await fs.mkdir(dumpRoot, { recursive: true });
  const adapter = new MariadbLogicalAdapter({ processRunner: runner, temporaryRoot: credentialRoot });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new MariadbConnectionService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter });
  const created = await connections.create(WORKSPACE_ID, 'tester', { name: 'Production MariaDB', host: 'db.example.com', username: 'backup', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection } = await connections.test(WORKSPACE_ID, created.id, 'tester');
  const discovered = await connections.discover(WORKSPACE_ID, connection.id);
  const source = await new DatabaseSourceService({ controlDatabase: database, adapterRegistry: registry }).save(WORKSPACE_ID, 'tester', {
    name: 'Orders MariaDB', connectionId: connection.id, selector: { databases: { include: [{ name: 'orders' }] } }, consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full', captureCoordinates: Boolean(options.pitr) }
  });
  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot, { recursive: true });
  const repository = await database.repository('repository').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Repository', connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null, encryption: { algorithm: 'aes-256-gcm', keyVersion: 'test-key-v1' },
    workerAffinity: [`device:${DEVICE_ID}`], health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 9);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const openRepository = async (_workspaceId, repositoryId) => {
    assert.equal(repositoryId, repository.id);
    return { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'test-key-v1' };
  };
  const { job } = await new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', { name: 'MariaDB protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: options.backupMode || 'full', verifyAfterBackup: true });
  const mariadbReader = new MariadbSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, temporaryRoot: dumpRoot });
  const sourceReader = new BackupSourceReaderRouter({ controlDatabase: database, fileReader: new FileSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID }), databaseReaders: { [ADAPTER_ID]: mariadbReader } });
  const backupService = new ManualBackupService({ controlDatabase: database, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID, openRepository });
  return { root, credentialRoot, dumpRoot, database, secretStore, runner, adapter, connections, connection, discovered, source, job, backupService, openRepository };
}

test('stores MariaDB credentials only as SecretRefs and produces one application-consistent dump', async (context) => {
  const fixtureState = await fixture(context);
  const { root, credentialRoot, dumpRoot, database, secretStore, runner, connection, discovered, source, job, backupService } = fixtureState;
  assert.deepEqual(discovered.items.map((item) => item.name), ['orders']);
  assert.equal(await secretStore.resolve({ workspaceId: WORKSPACE_ID, id: connection.secretRefIds[0] }), PASSWORD);
  assert.equal((await fs.readFile(path.join(root, 'control', 'control.db'))).includes(Buffer.from(PASSWORD)), false);
  const started = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(started.id);
  const completed = await database.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(runner.streamCalls, 1);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  assert.equal(source.adapterId, ADAPTER_ID);
  assert.equal(point.consistency, 'application');
  assert.deepEqual(await fs.readdir(credentialRoot), []);
  assert.deepEqual(await fs.readdir(dumpRoot), []);
});

test('restores an authenticated MariaDB dump only to the pinned original server', async (context) => {
  const fixtureState = await fixture(context);
  const { database, secretStore, runner, adapter, connection, job, backupService, openRepository } = fixtureState;
  const backup = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(backup.id);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  const service = new MariadbRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository });
  await assert.rejects(service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id }), (error) => error.code === 'MARIADB_RESTORE_CONFIRMATION_REQUIRED');
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.validation.connectivity, 'pass');
  assert.equal(completed.validation.expectedObjects, 'pass');
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(runner.restoreCalls, 1);
  assert.equal(runner.restored.equals(runner.dump), true);
  const current = await database.repository('connection').get(WORKSPACE_ID, connection.id);
  await database.repository('connection').update(WORKSPACE_ID, current.id, { trust: { ...current.trust, fingerprint: 'sha256:changed-server' } }, { expectedRevision: current.revision, actorId: 'tester' });
  const mismatch = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const failed = await service.wait(WORKSPACE_ID, mismatch.id);
  assert.equal(failed.result.error.code, 'MARIADB_RESTORE_SERVER_MISMATCH');
  assert.equal(runner.restoreCalls, 1);
});

test('restores MariaDB to an alternate server and a mapped new database', async (context) => {
  const fixtureState = await fixture(context);
  const { database, secretStore, runner, adapter, connections, job, backupService, openRepository } = fixtureState;
  const backup = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(backup.id);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  const service = new MariadbRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository });
  const alternateDraft = await connections.create(WORKSPACE_ID, 'tester', { name: 'Recovery MariaDB', host: 'recovery-mariadb.example.com', username: 'backup', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection: alternate } = await connections.test(WORKSPACE_ID, alternateDraft.id, 'tester');
  runner.restorePrivileges = true;
  runner.databases = ['information_schema', 'mysql'];
  const alternateRun = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'alternate', targetConnectionId: alternate.id, conflictPolicy: 'fail', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate });
  const alternateCompleted = await service.wait(WORKSPACE_ID, alternateRun.id);
  assert.equal(alternateCompleted.state, 'succeeded');
  assert.equal(alternateCompleted.targetConnectionId, alternate.id);
  assert.equal(alternateCompleted.validation.nativeIntegrityValidation, true);

  const cloneDraft = await connections.create(WORKSPACE_ID, 'tester', { name: 'Clone MariaDB', host: 'clone-mariadb.example.com', username: 'backup', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection: clone } = await connections.test(WORKSPACE_ID, cloneDraft.id, 'tester');
  runner.databases = ['information_schema', 'mysql'];
  const cloneRun = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'new-database', targetConnectionId: clone.id, targetDatabase: 'orders_restore', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS['new-database'] });
  const cloneCompleted = await service.wait(WORKSPACE_ID, cloneRun.id);
  assert.equal(cloneCompleted.state, 'succeeded');
  assert.equal(cloneCompleted.target.targetDatabase, 'orders_restore');
  assert.match(runner.restored.toString(), /USE `orders_restore`/);
  assert.equal(cloneCompleted.validation.expectedObjects, 'pass');
});

test('reconciles abandoned MariaDB restore runs after process restart', async (context) => {
  const { root, database, secretStore, adapter, connection, job, backupService, openRepository } = await fixture(context);
  const backup = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(backup.id);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  const restoreRuns = database.repository('restoreRun');
  const ordinary = await restoreRuns.create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
    target: { mode: 'original', engine: 'mariadb', sourceId: point.sourceId, connectionId: connection.id }, mode: 'original',
    conflictPolicy: 'overwrite', workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'running' }
  });
  const pointInTime = await restoreRuns.create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
    target: { operation: 'point-in-time', mode: 'original', engine: 'mariadb', sourceId: point.sourceId, connectionId: connection.id }, mode: 'original',
    conflictPolicy: 'overwrite', workerId: `device:${DEVICE_ID}`, state: 'preparing', progress: { phase: 'preparing' }
  });

  const restartedRestoreService = new MariadbRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository });
  const [ordinaryResult] = await restartedRestoreService.reconcile(WORKSPACE_ID, 'reconciler');
  assert.equal(ordinaryResult.id, ordinary.id);
  assert.equal(ordinaryResult.state, 'failed');
  assert.equal(ordinaryResult.progress.phase, 'failed');
  assert.equal(ordinaryResult.result.error.code, 'MARIADB_RESTORE_PROCESS_INTERRUPTED');
  assert.equal((await restoreRuns.get(WORKSPACE_ID, pointInTime.id)).state, 'preparing');

  const restartedPitrService = new MariadbPointInTimeRestoreService({
    controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, baseRestoreService: restartedRestoreService,
    openRepository, temporaryRoot: path.join(root, 'pitr-reconcile')
  });
  const [pointInTimeResult] = await restartedPitrService.reconcile(WORKSPACE_ID, 'reconciler');
  assert.equal(pointInTimeResult.id, pointInTime.id);
  assert.equal(pointInTimeResult.state, 'failed');
  assert.equal(pointInTimeResult.progress.phase, 'failed');
  assert.equal(pointInTimeResult.result.error.code, 'MARIADB_PITR_PROCESS_INTERRUPTED');
  assert.deepEqual(await restartedRestoreService.reconcile(WORKSPACE_ID, 'reconciler'), []);
  assert.deepEqual(await restartedPitrService.reconcile(WORKSPACE_ID, 'reconciler'), []);
});

test('captures and restores a MariaDB binary-log chain to a native coordinate', async (context) => {
  const { root, database, secretStore, runner, adapter, job, backupService, openRepository } = await fixture(context, { pitr: true, backupMode: 'incremental' });
  const anchorRun = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(anchorRun.id);
  const logRun = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(logRun.id);
  const points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  const anchor = points.find((point) => point.type === 'full');
  const logPoint = points.find((point) => point.type === 'log');
  assert.ok(anchor.pointInTime.anchorCoordinate);
  assert.ok(logPoint.pointInTime.endCoordinate);
  assert.equal(logPoint.parentRecoveryPointId, anchor.id);
  const logArtifacts = (await database.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).filter((artifact) => artifact.recoveryPointId === logPoint.id && artifact.kind === 'transaction-log');
  assert.equal(logArtifacts.length, 2);
  const baseRestoreService = new MariadbRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository });
  const temporaryRoot = path.join(root, 'pitr');
  await fs.mkdir(temporaryRoot);
  const pitr = new MariadbPointInTimeRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, baseRestoreService, openRepository, temporaryRoot });
  const started = await pitr.start(WORKSPACE_ID, 'tester', { terminalRecoveryPointId: logPoint.id, mode: 'original', stop: { coordinate: logArtifacts[0].metadata.binaryLog.endCoordinate }, confirmed: true, confirmationText: 'RECOVER MARIADB TO POINT IN TIME' });
  const completed = await pitr.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  assert.equal(completed.result.replayedFiles, 2);
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(runner.restoreCalls >= 2, true);
  assert.equal((await baseRestoreService.list(WORKSPACE_ID, { limit: 20 })).every((run) => run.target?.operation !== 'point-in-time'), true);
  assert.equal((await pitr.list(WORKSPACE_ID, { limit: 20 })).length, 1);
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
});
