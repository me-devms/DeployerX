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
const { ADAPTER_ID, MysqlConnectionService, MysqlLogicalAdapter } = require('./mysql-logical');
const { MysqlRestoreService, RESTORE_CONFIRMATION, RESTORE_CONFIRMATIONS } = require('./mysql-restore');
const { BackupSourceReaderRouter, MysqlSourceReaderService } = require('./mysql-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const { BackupSecretStore } = require('./secrets');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'mysql-restore-device';
const PASSWORD = 'mysql-restore-private-password';

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, '')
  };
}

class Runner {
  constructor() {
    this.dump = Buffer.from('-- authenticated logical dump\nCREATE DATABASE `orders`;\nUSE `orders`;\nCREATE TABLE `items` (`id` int);\n');
    this.restoreCalls = 0;
    this.restored = Buffer.alloc(0);
    this.databases = ['orders'];
    this.validationDatabase = 'orders';
    this.restorePrivileges = false;
  }

  async run(input) {
    if (input.args.includes('--version')) return { stdout: `${path.basename(input.executable)} Ver 8.0.36`, exitCode: 0, stderr: '' };
    const query = input.args.find((argument) => argument.startsWith('--execute='))?.slice(10) || '';
    if (query === 'SELECT 1;') return { stdout: '1\n', exitCode: 0, stderr: '' };
    if (query === 'SHOW DATABASES;') return { stdout: `${this.databases.join('\n')}${this.databases.length ? '\n' : ''}`, exitCode: 0, stderr: '' };
    if (query.startsWith('CREATE DATABASE')) {
      const name = query.match(/`((?:[^`]|``)+)`/)?.[1]?.replace(/``/g, '`');
      if (name && !this.databases.includes(name)) this.databases.push(name);
      this.validationDatabase = name || this.validationDatabase;
      return { stdout: '', exitCode: 0, stderr: '' };
    }
    if (query.startsWith('SHOW GRANTS')) return { stdout: this.restorePrivileges ? 'GRANT ALL PRIVILEGES ON *.* TO `backup`@`%`\n' : 'GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON *.* TO `backup`@`%`\n', exitCode: 0, stderr: '' };
    if (query.startsWith("SELECT SCHEMA_NAME, '', 'database'")) return { stdout: `${this.validationDatabase}\t\tdatabase\t\n${this.validationDatabase}\titems\trelation\ttable\n`, exitCode: 0, stderr: '' };
    if (query.includes('information_schema.tables')) return { stdout: '0\n', exitCode: 0, stderr: '' };
    if (query.startsWith('CHECK TABLE')) return { stdout: `${this.validationDatabase}.items\tcheck\tstatus\tOK\n`, exitCode: 0, stderr: '' };
    if (query.includes('@@character_set_server')) return { stdout: '8.0.36\tuuid-restore\tMySQL Community Server\tutf8mb4\tutf8mb4_0900_ai_ci\n', exitCode: 0, stderr: '' };
    return { stdout: '8.0.36\tuuid-restore\tMySQL Community Server\n', exitCode: 0, stderr: '' };
  }

  stream() {
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

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mysql-restore-test-'));
  const database = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await database.initialize();
  const secretStore = new BackupSecretStore({ rootPath: path.join(root, 'secrets'), secureStorage: secureStorage(), isReferenced: async () => false });
  await secretStore.initialize();
  context.after(async () => { await database.close(); await fs.rm(root, { recursive: true, force: true }); });

  const runner = new Runner();
  const credentialRoot = path.join(root, 'credentials');
  const dumpRoot = path.join(root, 'dumps');
  await fs.mkdir(credentialRoot, { recursive: true });
  await fs.mkdir(dumpRoot, { recursive: true });
  const adapter = new MysqlLogicalAdapter({ processRunner: runner, temporaryRoot: credentialRoot });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connectionService = new MysqlConnectionService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter });
  const createdConnection = await connectionService.create(WORKSPACE_ID, 'tester', { name: 'Production MySQL', host: 'db.example.com', username: 'backup', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection } = await connectionService.test(WORKSPACE_ID, createdConnection.id, 'tester');
  const source = await new DatabaseSourceService({ controlDatabase: database, adapterRegistry: registry }).save(WORKSPACE_ID, 'tester', {
    name: 'Orders', connectionId: connection.id,
    selector: { databases: { include: [{ name: 'orders' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' }
  });

  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot, { recursive: true });
  const repository = await database.repository('repository').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Repository', connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'test-key-v1' }, workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 7);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const opened = { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'test-key-v1' };
  const openRepository = async (_workspaceId, repositoryId) => {
    assert.equal(repositoryId, repository.id);
    return opened;
  };

  const { job } = await new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', {
    name: 'Orders protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full', verifyAfterBackup: true
  });
  const mysqlReader = new MysqlSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, temporaryRoot: dumpRoot });
  const fileReader = new FileSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID });
  const sourceReader = new BackupSourceReaderRouter({ controlDatabase: database, fileReader, databaseReaders: { [ADAPTER_ID]: mysqlReader } });
  const backupService = new ManualBackupService({ controlDatabase: database, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID, openRepository });
  const backup = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(backup.id);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  const service = new MysqlRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository });
  return { root, credentialRoot, database, runner, adapter, connectionService, connection, point, service };
}

test('requires explicit confirmation and complete MySQL target fields', async (context) => {
  const { service, point } = await fixture(context);
  await assert.rejects(service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id }), (error) => error.code === 'MYSQL_RESTORE_CONFIRMATION_REQUIRED');
  await assert.rejects(service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'alternate', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate }), /Target connection ID is invalid/);
  assert.equal((await service.list(WORKSPACE_ID)).length, 0);
});

test('streams an authenticated dump into mysql and records native validation success', async (context) => {
  const { root, credentialRoot, database, runner, point, service } = await fixture(context);
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.validation.connectivity, 'pass');
  assert.equal(completed.validation.expectedObjects, 'pass');
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(completed.validation.checks.find((check) => check.id === 'native-integrity').status, 'pass');
  assert.equal(completed.result.bytesRestored, runner.dump.length);
  assert.equal(runner.restoreCalls, 1);
  assert.equal(runner.restored.equals(runner.dump), true);
  assert.equal(JSON.stringify(await service.list(WORKSPACE_ID)).includes(PASSWORD), false);
  assert.equal((await fs.readFile(path.join(root, 'control', 'control.db'))).includes(Buffer.from(PASSWORD)), false);
  assert.deepEqual(await fs.readdir(credentialRoot), []);
  const artifacts = await database.repository('artifact').list(WORKSPACE_ID, { limit: 20 });
  assert.equal(artifacts.filter((artifact) => artifact.kind === 'database-dump').length, 1);
});

test('restores to an alternate verified MySQL server and records immutable target evidence', async (context) => {
  const { database, runner, connectionService, connection, point, service } = await fixture(context);
  const alternateDraft = await connectionService.create(WORKSPACE_ID, 'tester', { name: 'Recovery MySQL', host: 'recovery.example.com', username: 'backup', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection: alternate } = await connectionService.test(WORKSPACE_ID, alternateDraft.id, 'tester');
  assert.notEqual(alternate.trust.fingerprint, connection.trust.fingerprint);
  runner.restorePrivileges = true;
  runner.databases = [];
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'alternate', targetConnectionId: alternate.id, conflictPolicy: 'fail', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.mode, 'alternate');
  assert.equal(completed.targetConnectionId, alternate.id);
  assert.equal(completed.target.serverIdentityFingerprint, alternate.trust.fingerprint);
  assert.equal(completed.target.collisionCount, 0);
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(runner.restored.equals(runner.dump), true);
  assert.equal((await database.repository('restoreRun').get(WORKSPACE_ID, started.id)).target.connectionId, alternate.id);
});

test('restores a whole MySQL backup to a genuinely new database with remapped validation', async (context) => {
  const { runner, connectionService, point, service } = await fixture(context);
  const targetDraft = await connectionService.create(WORKSPACE_ID, 'tester', { name: 'Clone MySQL', host: 'clone.example.com', username: 'backup', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection: target } = await connectionService.test(WORKSPACE_ID, targetDraft.id, 'tester');
  runner.restorePrivileges = true;
  runner.databases = [];
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'new-database', targetConnectionId: target.id, targetDatabase: 'orders_restore', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS['new-database'] });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.target.sourceDatabase, 'orders');
  assert.equal(completed.target.targetDatabase, 'orders_restore');
  assert.equal(completed.validation.connectivity, 'pass');
  assert.equal(completed.validation.expectedObjects, 'pass');
  assert.match(runner.restored.toString(), /CREATE DATABASE `orders_restore`/);
  assert.match(runner.restored.toString(), /USE `orders_restore`/);
  assert.doesNotMatch(runner.restored.toString(), /USE `orders`/);
});

test('fails closed when an alternate MySQL database collides without overwrite approval', async (context) => {
  const { runner, connectionService, point, service } = await fixture(context);
  const targetDraft = await connectionService.create(WORKSPACE_ID, 'tester', { name: 'Occupied MySQL', host: 'occupied.example.com', username: 'backup', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection: target } = await connectionService.test(WORKSPACE_ID, targetDraft.id, 'tester');
  runner.restorePrivileges = true;
  runner.databases = ['orders'];
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'alternate', targetConnectionId: target.id, conflictPolicy: 'fail', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'MYSQL_ALTERNATE_TARGET_CONFLICT');
  assert.equal(runner.restoreCalls, 0);
});

test('records a compatibility warning when a recovery point has no validation inventory', async (context) => {
  const { adapter, point, service } = await fixture(context);
  adapter.validateRestore = async () => ({
    status: 'warning', valid: true, nativeIntegrityValidation: false,
    checks: [{ id: 'connectivity', status: 'pass' }, { id: 'expected-objects', status: 'warning' }],
    warnings: [{ code: 'MYSQL_VALIDATION_INVENTORY_UNAVAILABLE', safeMessage: 'Only connectivity could be validated.' }]
  });
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'warning');
  assert.equal(completed.validation.expectedObjects, 'warning');
  assert.equal(completed.result.warnings[0].code, 'MYSQL_VALIDATION_INVENTORY_UNAVAILABLE');
});

test('persists failed native validation evidence in the restore run', async (context) => {
  const { adapter, point, service } = await fixture(context);
  adapter.validateRestore = async () => ({
    status: 'failed', valid: false, nativeIntegrityValidation: true,
    checks: [{ id: 'connectivity', status: 'pass' }, { id: 'expected-objects', status: 'pass' }, { id: 'native-integrity', status: 'fail', failureCount: 1 }], warnings: []
  });
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'MYSQL_RESTORE_NATIVE_VALIDATION_FAILED');
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(completed.validation.checks.find((check) => check.id === 'native-integrity').status, 'fail');
});

test('pins original-server identity and reconciles an abandoned restore', async (context) => {
  const { database, runner, connection, point, service } = await fixture(context);
  await database.repository('connection').update(WORKSPACE_ID, connection.id, { trust: { ...connection.trust, fingerprint: 'sha256:changed-server' } }, { expectedRevision: connection.revision, actorId: 'tester' });
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const failed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result.error.code, 'MYSQL_RESTORE_SERVER_MISMATCH');
  assert.equal(runner.restoreCalls, 0);

  const abandoned = await database.repository('restoreRun').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
    target: { mode: 'original', engine: 'mysql', sourceId: point.sourceId }, mode: 'original',
    conflictPolicy: 'replace-database-objects', workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'running' }
  });
  const reconciled = await service.reconcile(WORKSPACE_ID, 'reconciler');
  assert.equal(reconciled.some((record) => record.id === abandoned.id && record.state === 'failed' && record.result.error.code === 'MYSQL_RESTORE_PROCESS_INTERRUPTED'), true);
});
