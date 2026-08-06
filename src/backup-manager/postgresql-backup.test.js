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
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { ADAPTER_ID, PostgresqlConnectionService, PostgresqlLogicalAdapter } = require('./postgresql-logical');
const { PostgresqlRestoreService, RESTORE_CONFIRMATION, RESTORE_CONFIRMATIONS } = require('./postgresql-restore');
const { PostgresqlSourceReaderService } = require('./postgresql-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const { BackupSecretStore } = require('./secrets');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'postgresql-backup-device';
const PASSWORD = 'postgresql-private-password';

function secureStorage() {
  return { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, '') };
}

class Runner {
  constructor() { this.streamCalls = 0; this.restoreCalls = 0; this.restored = Buffer.alloc(0); this.dumpDatabases = []; this.databases = ['accounts', 'orders', 'postgres']; this.restorePrivileges = false; }
  async run(input) {
    if (input.args.includes('--version')) return { stdout: `${path.basename(input.executable)} (PostgreSQL) 16.4`, exitCode: 0, stderr: '' };
    const query = input.args.find((argument) => argument.startsWith('--command='))?.slice(10) || '';
    if (query === 'SELECT 1;') return { stdout: '1\n', exitCode: 0, stderr: '' };
    if (query.includes('FROM pg_database')) return { stdout: `${this.databases.join('\n')}\n`, exitCode: 0, stderr: '' };
    if (query.startsWith('CREATE DATABASE')) {
      const name = query.match(/"((?:[^"]|"")+)"/)?.[1]?.replace(/""/g, '"');
      if (name && !this.databases.includes(name)) this.databases.push(name);
      return { stdout: '', exitCode: 0, stderr: '' };
    }
    if (query.includes('has_database_privilege')) return { stdout: 't\t0\t0\t0\n', exitCode: 0, stderr: '' };
    if (query.includes('rolcreatedb OR rolsuper')) return { stdout: this.restorePrivileges ? 't\tf\n' : 'f\tf\n', exitCode: 0, stderr: '' };
    if (query.includes("current_setting('server_encoding')")) return { stdout: '16.4\t160004\t7395820012345678901\tUTF8\ten_US.UTF-8\ten_US.UTF-8\n', exitCode: 0, stderr: '' };
    if (query.startsWith("SELECT 'schema'")) return { stdout: 'schema\tpublic\t\tschema\tt\nrelation\tpublic\titems\ttable\tt\nindex\tpublic\titems_pkey\tindex\tt\n', exitCode: 0, stderr: '' };
    return { stdout: '16.4\t160004\t7395820012345678901\n', exitCode: 0, stderr: '' };
  }
  stream(input) {
    this.streamCalls += 1;
    this.dumpDatabases.push(input.env.PGDATABASE);
    const dump = Buffer.from(`-- dump ${input.env.PGDATABASE}\nDROP DATABASE IF EXISTS "${input.env.PGDATABASE}";\nCREATE DATABASE "${input.env.PGDATABASE}";\n\\connect "${input.env.PGDATABASE}"\nCREATE TABLE public.items(id integer);\n`);
    return { stdout: Readable.from(dump), completion: Promise.resolve({ exitCode: 0, stderr: '' }), cancel() {} };
  }
  async consume(input) {
    const chunks = [];
    for await (const chunk of input.stdin) chunks.push(Buffer.from(chunk));
    this.restoreCalls += 1;
    this.restored = Buffer.concat(chunks);
    for (const name of [...this.restored.toString().matchAll(/\\connect\s+"((?:[^"]|"")+)"/g)].map((match) => match[1].replace(/""/g, '"'))) {
      if (!this.databases.includes(name)) this.databases.push(name);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

async function fixture(context, protectedDatabases = ['orders', 'accounts']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-postgresql-backup-test-'));
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
  const adapter = new PostgresqlLogicalAdapter({ processRunner: runner, temporaryRoot: credentialRoot });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new PostgresqlConnectionService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter });
  const created = await connections.create(WORKSPACE_ID, 'tester', { name: 'Production PostgreSQL', host: 'pg.example.com', username: 'backup', maintenanceDatabase: 'postgres', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection } = await connections.test(WORKSPACE_ID, created.id, 'tester');
  const source = await new DatabaseSourceService({ controlDatabase: database, adapterRegistry: registry }).save(WORKSPACE_ID, 'tester', {
    name: 'Business databases', connectionId: connection.id, selector: { databases: { include: protectedDatabases.map((name) => ({ name })) } }, consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' }
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
  const masterKey = Buffer.alloc(32, 11);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const openRepository = async (_workspaceId, repositoryId) => {
    assert.equal(repositoryId, repository.id);
    return { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'test-key-v1' };
  };
  const { job } = await new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', { name: 'PostgreSQL protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full', verifyAfterBackup: true });
  const databaseReader = new PostgresqlSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, temporaryRoot: dumpRoot });
  const sourceReader = new BackupSourceReaderRouter({ controlDatabase: database, fileReader: new FileSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID }), databaseReaders: { [ADAPTER_ID]: databaseReader } });
  const backupService = new ManualBackupService({ controlDatabase: database, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID, openRepository });
  return { root, credentialRoot, dumpRoot, database, secretStore, runner, adapter, connections, connection, source, repository, engine, masterKey, job, backupService, openRepository };
}

test('persists PostgreSQL credentials only as SecretRefs and publishes one combined logical artifact', async (context) => {
  const { root, credentialRoot, dumpRoot, database, secretStore, runner, connection, source, job, backupService } = await fixture(context);
  assert.equal(await secretStore.resolve({ workspaceId: WORKSPACE_ID, id: connection.secretRefIds[0] }), PASSWORD);
  assert.equal((await fs.readFile(path.join(root, 'control', 'control.db'))).includes(Buffer.from(PASSWORD)), false);
  const started = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(started.id);
  const completed = await database.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(source.adapterId, ADAPTER_ID);
  assert.equal(runner.streamCalls, 2);
  assert.deepEqual(runner.dumpDatabases, ['accounts', 'orders']);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  assert.equal(point.consistency, 'application');
  const artifacts = await database.repository('artifact').list(WORKSPACE_ID, { limit: 20 });
  assert.equal(artifacts.filter((artifact) => artifact.kind === 'database-dump').length, 1);
  assert.deepEqual(await fs.readdir(credentialRoot), []);
  assert.deepEqual(await fs.readdir(dumpRoot), []);
});

test('publishes encrypted PostgreSQL base-backup and WAL artifacts with an exact chain', async (context) => {
  const { root, database, secretStore, adapter, connection, source, repository, engine, masterKey, openRepository } = await fixture(context);
  const sshSecret = await secretStore.create({ workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'PostgreSQL SSH key', secretType: 'private-key', value: 'postgresql-ssh-secret' });
  await database.repository('secretRef').create({ ...sshSecret, workspaceId: WORKSPACE_ID, actorId: 'tester' });
  const sshConnection = await database.repository('connection').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Production PostgreSQL Linux', kind: 'ssh', adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0',
    endpoint: { host: 'pg.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 }, secretRefIds: [sshSecret.id],
    trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' }, workerAffinity: [`device:${DEVICE_ID}`], lastTest: { status: 'success' }
  });
  const physicalSource = await new DatabaseSourceService({ controlDatabase: database, adapterRegistry: new DatabaseAdapterRegistry([adapter]), deviceId: DEVICE_ID }).save(WORKSPACE_ID, 'tester', {
    id: source.id, revision: source.revision, name: 'Production PostgreSQL physical', connectionId: connection.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full' },
    physicalExecution: { sshConnectionId: sshConnection.id, remoteTemporaryDirectory: '/var/tmp', dataDirectory: '/var/lib/postgresql/data', walArchiveDirectory: '/var/lib/postgresql/wal-archive', serviceName: 'postgresql', postgresOwner: 'postgres', postgresGroup: 'postgres' }
  });
  const { job } = await new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', {
    name: 'PostgreSQL physical protection', sourceId: physicalSource.id, repositoryIds: [repository.id], backupMode: 'incremental', verifyAfterBackup: true
  });
  const payloads = [];
  const physicalBackupService = {
    async prepare(_workspaceId, _executionId, plan, options) {
      const incremental = options.backupMode === 'incremental';
      const bytes = Buffer.from(incremental ? 'postgresql-wal-tar' : 'postgresql-basebackup-tar');
      const artifactPath = incremental ? 'postgresql-wal/000000010000000000000004-000000010000000000000005.tar' : 'postgresql-physical/base.tar';
      payloads.push({ incremental, previousRecoveryPointId: options.previousRecoveryPoint?.id || null, bytes, artifactPath });
      return {
        artifactPath,
        databaseManifest: {
          version: 1, kind: incremental ? 'postgresql-wal' : 'postgresql-basebackup', adapterId: ADAPTER_ID, adapterVersion: plan.manifest.adapterVersion, engine: 'postgresql',
          backupMethod: 'physical', backupMode: incremental ? 'incremental' : 'full', selection: plan.source.selector, selectionDigest: plan.source.selector.digest,
          consistency: { requestedLevel: 'application', achievedLevel: 'application', backupMethod: 'physical', backupMode: incremental ? 'incremental' : 'full', proven: true },
          server: { systemIdentifier: '7395820012345678901', major: 16, version: '16.4', dataDirectory: '/var/lib/postgresql/data' },
          source: { sourceId: plan.source.id, jobId: options.jobId },
          wal: incremental
            ? { timeline: 1, startLsn: '0/3000000', endLsn: '0/6000000', firstSegment: '000000010000000000000004', lastSegment: '000000010000000000000005', segmentSizeBytes: 16777216, files: [{ name: '000000010000000000000004', sizeBytes: 16777216, kind: 'segment' }, { name: '000000010000000000000005', sizeBytes: 16777216, kind: 'segment' }] }
            : { timeline: 1, startLsn: '0/2000000', endLsn: '0/3000000', endSegment: '000000010000000000000003', lastSegment: '000000010000000000000003', segmentSizeBytes: 16777216 },
          chain: { chainRootRecoveryPointId: incremental ? options.previousRecoveryPoint.chainRootId || options.previousRecoveryPoint.id : null, parentRecoveryPointId: incremental ? options.previousRecoveryPoint.id : null },
          artifact: { kind: incremental ? 'transaction-log' : 'physical-backup', path: artifactPath, mediaType: 'application/x-tar' }
        },
        content: () => Readable.from([bytes])
      };
    },
    async release() { return true; }
  };
  const registry = new DatabaseAdapterRegistry([adapter]);
  const databaseReader = new PostgresqlSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, physicalBackupService });
  const sourceReader = new BackupSourceReaderRouter({ controlDatabase: database, fileReader: new FileSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID }), databaseReaders: { [ADAPTER_ID]: databaseReader } });
  const service = new ManualBackupService({ controlDatabase: database, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'postgresql-physical-checkpoints') }), deviceId: DEVICE_ID, openRepository });
  const fullRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(fullRun.id);
  assert.equal((await database.repository('run').get(WORKSPACE_ID, fullRun.id)).state, 'succeeded');
  const walRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(walRun.id);
  assert.equal((await database.repository('run').get(WORKSPACE_ID, walRun.id)).state, 'succeeded');
  const points = (await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 })).filter((point) => point.jobId === job.id);
  const anchor = points.find((point) => point.type === 'full');
  const walPoint = points.find((point) => point.type === 'log');
  assert.ok(anchor);
  assert.equal(walPoint.parentRecoveryPointId, anchor.id);
  assert.equal(walPoint.chainRootId, anchor.id);
  assert.equal(walPoint.pointInTime.lastSegment, '000000010000000000000005');
  assert.deepEqual(payloads.map((payload) => payload.incremental), [false, true]);
  assert.equal(payloads[1].previousRecoveryPointId, anchor.id);
  const artifacts = (await database.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).filter((artifact) => [anchor.id, walPoint.id].includes(artifact.recoveryPointId) && ['physical-backup', 'transaction-log'].includes(artifact.kind));
  assert.deepEqual(artifacts.map((artifact) => artifact.kind).sort(), ['physical-backup', 'transaction-log']);
  for (const [point, payload] of [[anchor, payloads[0]], [walPoint, payloads[1]]]) {
    const snapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey });
    const file = snapshot.manifest.files.find((item) => item.path === payload.artifactPath);
    const chunks = [];
    for await (const chunk of engine.streamFile({}, { repositoryId: repository.id, manifest: snapshot.manifest, masterKey, path: file.path })) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).equals(payload.bytes), true);
  }
});

test('restores the authenticated PostgreSQL script only to the pinned original cluster', async (context) => {
  const { database, secretStore, runner, adapter, connection, job, backupService, openRepository } = await fixture(context);
  const backup = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(backup.id);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  const service = new PostgresqlRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository });
  await assert.rejects(service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id }), (error) => error.code === 'POSTGRESQL_RESTORE_CONFIRMATION_REQUIRED');
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.validation.connectivity, 'pass');
  assert.equal(completed.validation.expectedObjects, 'pass');
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(runner.restoreCalls, 1);
  assert.match(runner.restored.toString(), /dump accounts[\s\S]*dump orders/);
  const current = await database.repository('connection').get(WORKSPACE_ID, connection.id);
  await database.repository('connection').update(WORKSPACE_ID, current.id, { trust: { ...current.trust, fingerprint: 'sha256:changed-cluster' } }, { expectedRevision: current.revision, actorId: 'tester' });
  const mismatch = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const failed = await service.wait(WORKSPACE_ID, mismatch.id);
  assert.equal(failed.result.error.code, 'POSTGRESQL_RESTORE_SERVER_MISMATCH');
  assert.equal(runner.restoreCalls, 1);
});

test('restores PostgreSQL databases to an alternate verified cluster', async (context) => {
  const { database, secretStore, runner, adapter, connections, job, backupService, openRepository } = await fixture(context);
  const backup = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(backup.id);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  const targetDraft = await connections.create(WORKSPACE_ID, 'tester', { name: 'Recovery PostgreSQL', host: 'recovery-pg.example.com', username: 'backup', maintenanceDatabase: 'postgres', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection: target } = await connections.test(WORKSPACE_ID, targetDraft.id, 'tester');
  runner.restorePrivileges = true;
  runner.databases = ['postgres'];
  const service = new PostgresqlRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository });
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'alternate', targetConnectionId: target.id, conflictPolicy: 'fail', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.targetConnectionId, target.id);
  assert.equal(completed.target.collisionCount, 0);
  assert.equal(completed.validation.nativeIntegrityValidation, true);
});

test('restores one PostgreSQL database under a new name and validates the mapped inventory', async (context) => {
  const { database, secretStore, runner, adapter, connections, job, backupService, openRepository } = await fixture(context, ['orders']);
  const backup = await backupService.start(WORKSPACE_ID, 'tester', job.id);
  await backupService.wait(backup.id);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  const targetDraft = await connections.create(WORKSPACE_ID, 'tester', { name: 'Clone PostgreSQL', host: 'clone-pg.example.com', username: 'backup', maintenanceDatabase: 'postgres', password: PASSWORD, tlsMode: 'verify-identity' });
  const { connection: target } = await connections.test(WORKSPACE_ID, targetDraft.id, 'tester');
  runner.restorePrivileges = true;
  runner.databases = ['postgres'];
  const service = new PostgresqlRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository });
  const started = await service.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, mode: 'new-database', targetConnectionId: target.id, targetDatabase: 'orders_restore', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS['new-database'] });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.target.sourceDatabase, 'orders');
  assert.equal(completed.target.targetDatabase, 'orders_restore');
  assert.match(runner.restored.toString(), /CREATE DATABASE "orders_restore"/);
  assert.match(runner.restored.toString(), /\\connect "orders_restore"/);
  assert.equal(completed.validation.expectedObjects, 'pass');
});
