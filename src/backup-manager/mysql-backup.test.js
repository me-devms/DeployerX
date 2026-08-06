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
const { MysqlPointInTimeRestoreService } = require('./mysql-family-pitr');
const { MysqlRestoreService } = require('./mysql-restore');
const { BackupSourceReaderRouter, MysqlSourceReaderService } = require('./mysql-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const { BackupSecretStore } = require('./secrets');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'mysql-device';

function secureStorage() {
  return { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, '') };
}

class Runner {
  constructor(options = {}) {
    this.streamCalls = 0;
    this.streamInputs = [];
    this.consumeCalls = 0;
    this.pitr = Boolean(options.pitr);
    this.serverVersion = options.mysqlVersion || '8.0.36';
    this.status = 'mysql-bin.000043\t7000\t\t\tuuid:1-30\n';
    this.dump = Buffer.from(`${this.pitr ? "-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='mysql-bin.000042', SOURCE_LOG_POS=8192;\n" : '-- consistent MySQL logical dump\n'}CREATE DATABASE \`orders\`;\nUSE \`orders\`;\nCREATE TABLE \`items\` (\`id\` int);\n`);
  }
  async run(input) {
    if (input.args.includes('--version')) return { stdout: `${path.basename(input.executable)} Ver 8.0.36`, exitCode: 0, stderr: '' };
    if (path.basename(input.executable).toLowerCase().startsWith('mysqlbinlog') && input.args.includes('--raw')) {
      const destination = input.args.find((argument) => argument.startsWith('--result-file=')).slice('--result-file='.length);
      await fs.writeFile(path.join(destination, input.args.at(-1)), Buffer.alloc(12000, 5));
      return { stdout: '', exitCode: 0, stderr: '' };
    }
    const query = input.args.find((argument) => argument.startsWith('--execute='))?.slice(10) || '';
    if (query.startsWith('SHOW GRANTS')) return { stdout: `GRANT SELECT, SHOW VIEW, TRIGGER, EVENT${this.pitr ? ', RELOAD, REPLICATION CLIENT, REPLICATION SLAVE' : ''} ON *.* TO \`backup\`@\`%\`\n`, exitCode: 0, stderr: '' };
    if (query.includes('@@global.log_bin')) return { stdout: '1\tROW\tFULL\tCRC32\n', exitCode: 0, stderr: '' };
    if (query === 'SHOW BINARY LOG STATUS;') return { stdout: this.status, exitCode: 0, stderr: '' };
    if (query === 'SHOW BINARY LOGS;') return { stdout: 'mysql-bin.000042\t10000\nmysql-bin.000043\t9000\n', exitCode: 0, stderr: '' };
    if (query.startsWith('CHECK TABLE')) return { stdout: 'orders.items\tcheck\tstatus\tOK\n', exitCode: 0, stderr: '' };
    if (query === 'SELECT 1;') return { stdout: '1\n', exitCode: 0, stderr: '' };
    if (query.startsWith('SELECT SCHEMA_NAME')) return { stdout: 'orders\t\tdatabase\t\norders\titems\trelation\ttable\n', exitCode: 0, stderr: '' };
    if (query.includes('information_schema.tables')) return { stdout: '0\n', exitCode: 0, stderr: '' };
    if (query.includes('@@character_set_server')) return { stdout: `${this.serverVersion}\tuuid-backup\tMySQL Community Server\tutf8mb4\tutf8mb4_0900_ai_ci\n`, exitCode: 0, stderr: '' };
    return { stdout: `${this.serverVersion}\tuuid-backup\tMySQL Community Server\n`, exitCode: 0, stderr: '' };
  }
  stream(input) { this.streamCalls += 1; this.streamInputs.push(input); return { stdout: Readable.from(this.dump), completion: Promise.resolve({ exitCode: 0, stderr: '' }), cancel() {} }; }
  async consume(input) { this.consumeCalls += 1; if (input.stdin) for await (const _chunk of input.stdin) {} return { exitCode: 0, stdout: '', stderr: '' }; }
}

async function fixture(context, repositoryCount = 2, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mysql-backup-test-'));
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
  const adapter = new MysqlLogicalAdapter({ processRunner: runner, temporaryRoot: credentialRoot });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new MysqlConnectionService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter });
  const createdConnection = await connections.create(WORKSPACE_ID, 'tester', { name: 'Production MySQL', host: 'db.example.com', username: 'backup', password: 'secret-value', tlsMode: 'verify-identity' });
  const { connection } = await connections.test(WORKSPACE_ID, createdConnection.id, 'tester');
  const sourceService = new DatabaseSourceService({ controlDatabase: database, adapterRegistry: registry });
  const source = await sourceService.save(WORKSPACE_ID, 'tester', { name: 'Orders', connectionId: connection.id, selector: { databases: { include: [{ name: 'orders' }] } }, consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full', captureCoordinates: Boolean(options.pitr) } });

  const openedRepositories = new Map();
  const repositories = [];
  for (let index = 0; index < repositoryCount; index += 1) {
    const repositoryRoot = path.join(root, `repository-${index}`);
    await fs.mkdir(repositoryRoot, { recursive: true });
    const repository = await database.repository('repository').create({
      workspaceId: WORKSPACE_ID, actorId: 'tester', name: `Repository ${index + 1}`, connectionId: null,
      adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
      location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null,
      encryption: { algorithm: 'aes-256-gcm', keyVersion: 'test-key-v1' }, workerAffinity: [`device:${DEVICE_ID}`],
      health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
    });
    const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
    await repositoryAdapter.initialize();
    const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
    const masterKey = Buffer.alloc(32, index + 1);
    await engine.ensureRepository({}, { repositoryId: repository.id });
    openedRepositories.set(repository.id, { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'test-key-v1' });
    repositories.push(repository);
  }
  const jobs = new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID });
  const { job } = await jobs.create(WORKSPACE_ID, 'tester', { name: 'Orders protection', sourceId: source.id, repositoryIds: repositories.map((item) => item.id), backupMode: options.backupMode || 'full', verifyAfterBackup: true });
  const mysqlReader = new MysqlSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, temporaryRoot: dumpRoot });
  const fileReader = new FileSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID });
  const sourceReader = new BackupSourceReaderRouter({ controlDatabase: database, fileReader, databaseReaders: { [ADAPTER_ID]: mysqlReader } });
  const openRepository = async (_workspaceId, repositoryId) => openedRepositories.get(repositoryId);
  const service = new ManualBackupService({ controlDatabase: database, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID, openRepository });
  return { root, dumpRoot, database, secretStore, runner, adapter, source, connection, repositories, openedRepositories, job, service, sourceReader, openRepository };
}

test('runs one application-consistent MySQL dump into identical encrypted repository copies', async (context) => {
  const { dumpRoot, database, runner, repositories, openedRepositories, job, service } = await fixture(context, 2);
  const started = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(started.id);
  const run = await database.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(run.state, 'succeeded');
  assert.equal(runner.streamCalls, 1);
  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  assert.equal(point.type, 'full');
  assert.equal(point.consistency, 'application');
  assert.equal(point.repositoryCopies.length, 2);
  const artifacts = await database.repository('artifact').list(WORKSPACE_ID, { limit: 20 });
  assert.equal(artifacts.filter((artifact) => artifact.kind === 'manifest').length, 2);
  assert.equal(artifacts.filter((artifact) => artifact.kind === 'database-dump').length, 2);
  assert.equal(artifacts.some((artifact) => JSON.stringify(artifact).includes('secret-value')), false);
  const restored = [];
  for (const copy of point.repositoryCopies) {
    const opened = openedRepositories.get(copy.repositoryId);
    const snapshot = await opened.engine.openSnapshot({}, { repositoryId: copy.repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
    const chunks = [];
    for await (const chunk of opened.engine.streamFile({}, { repositoryId: copy.repositoryId, manifest: snapshot.manifest, masterKey: opened.masterKey, path: 'mysql/logical-dump.sql' })) chunks.push(Buffer.from(chunk));
    restored.push(Buffer.concat(chunks));
  }
  assert.equal(restored[0].equals(restored[1]), true);
  assert.equal(restored[0].equals(runner.dump), true);
  assert.deepEqual(await fs.readdir(dumpRoot), []);
  assert.deepEqual(point.repositoryCopies.map((copy) => copy.repositoryId).sort(), repositories.map((repository) => repository.id).sort());
});

test('rejects incremental MySQL job mode before creating policy records', async (context) => {
  const { database, source, repositories } = await fixture(context, 1);
  const before = await database.repository('policy').list(WORKSPACE_ID);
  const jobs = new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID });
  await assert.rejects(jobs.create(WORKSPACE_ID, 'tester', { name: 'Invalid incremental database', sourceId: source.id, repositoryIds: [repositories[0].id], backupMode: 'incremental' }), /PITR-enabled source/);
  assert.equal((await database.repository('policy').list(WORKSPACE_ID)).length, before.length);
});

test('publishes a full MySQL anchor, linked log point, and no empty point', async (context) => {
  const { database, runner, job, service, openedRepositories } = await fixture(context, 1, { pitr: true, backupMode: 'incremental' });
  const firstRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(firstRun.id);
  let points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  const anchor = points.find((point) => point.type === 'full');
  assert.ok(anchor);
  assert.equal(anchor.pointInTime.anchorCoordinate.position, 8192);
  const anchorArtifacts = (await database.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).filter((artifact) => artifact.recoveryPointId === anchor.id);
  assert.equal(anchorArtifacts.find((artifact) => artifact.kind === 'database-dump').metadata.binaryLog.anchorCoordinate.position, 8192);

  const secondRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(secondRun.id);
  points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  const logPoint = points.find((point) => point.type === 'log');
  assert.ok(logPoint);
  assert.equal(logPoint.parentRecoveryPointId, anchor.id);
  assert.equal(logPoint.chainRootId, anchor.id);
  assert.equal(logPoint.pointInTime.startCoordinate.position, 8192);
  assert.equal(logPoint.pointInTime.endCoordinate.position, 7000);
  const logArtifacts = (await database.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).filter((artifact) => artifact.recoveryPointId === logPoint.id && artifact.kind === 'transaction-log');
  assert.equal(logArtifacts.length, 2);
  const opened = openedRepositories.get(logPoint.repositoryCopies[0].repositoryId);
  const snapshot = await opened.engine.openSnapshot({}, { repositoryId: opened.repository.id, snapshotId: logPoint.repositoryCopies[0].engineSnapshotId, masterKey: opened.masterKey });
  assert.deepEqual(snapshot.manifest.files.map((file) => file.path).sort(), ['mysql/binary-logs/mysql-bin.000042', 'mysql/binary-logs/mysql-bin.000043']);

  runner.status = 'mysql-bin.000043\t7000\t\t\tuuid:1-30\n';
  const thirdRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(thirdRun.id);
  const thirdCompleted = await database.repository('run').get(WORKSPACE_ID, thirdRun.id);
  assert.equal(thirdCompleted.state, 'succeeded', JSON.stringify(thirdCompleted.result));
  assert.equal(thirdCompleted.result.noChange, true);
  assert.equal((await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 })).length, 2);
});

test('publishes encrypted full and incremental physical xbstream artifacts with an exact chain', async (context) => {
  const { root, database, secretStore, adapter, connection, source, repositories, openedRepositories, openRepository } = await fixture(context, 1, { mysqlVersion: '8.4.6' });
  const sshSecret = await secretStore.create({ workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Physical SSH key', secretType: 'private-key', value: 'physical-ssh-secret' });
  await database.repository('secretRef').create({ ...sshSecret, workspaceId: WORKSPACE_ID, actorId: 'tester' });
  const sshConnection = await database.repository('connection').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Production Linux', kind: 'ssh', adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0',
    endpoint: { host: 'db.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 }, secretRefIds: [sshSecret.id],
    trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' }, workerAffinity: [`device:${DEVICE_ID}`], lastTest: { status: 'success' }
  });
  const sourceService = new DatabaseSourceService({ controlDatabase: database, adapterRegistry: new DatabaseAdapterRegistry([adapter]), deviceId: DEVICE_ID });
  const physicalSource = await sourceService.save(WORKSPACE_ID, 'tester', {
    id: source.id, revision: source.revision, name: 'Production MySQL physical', connectionId: connection.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full' },
    physicalExecution: { sshConnectionId: sshConnection.id, remoteTemporaryDirectory: '/var/tmp', dataDirectory: '/var/lib/mysql', serviceName: 'mysql', mysqlOwner: 'mysql', mysqlGroup: 'mysql', privilegeMode: 'sudo-noninteractive' }
  });
  const { job } = await new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', {
    name: 'Physical protection', sourceId: physicalSource.id, repositoryIds: [repositories[0].id], backupMode: 'incremental', verifyAfterBackup: true
  });
  const payloads = [];
  const physicalBackupService = {
    async prepare(_workspaceId, _executionId, plan, options) {
      const incremental = options.backupMode === 'incremental';
      const fromLsn = incremental ? '100' : '0';
      const toLsn = incremental ? '180' : '100';
      const bytes = Buffer.from(incremental ? 'incremental-xbstream' : 'full-xbstream');
      payloads.push({ incremental, previousRecoveryPointId: options.previousRecoveryPoint?.id || null, bytes });
      return {
        artifactPath: `mysql-physical/${incremental ? 'incremental' : 'full'}-${toLsn}.xbstream`,
        databaseManifest: {
          version: 1, kind: 'mysql-xtrabackup', adapterId: ADAPTER_ID, adapterVersion: plan.manifest.adapterVersion, engine: 'mysql',
          backupMethod: 'physical', backupMode: incremental ? 'incremental' : 'full', selection: plan.source.selector, selectionDigest: plan.source.selector.digest,
          consistency: { requestedLevel: 'application', achievedLevel: 'application', backupMethod: 'physical', backupMode: incremental ? 'incremental' : 'full', proven: true },
          server: { serverUuid: 'uuid-backup' }, source: { sourceId: plan.source.id, jobId: options.jobId },
          checkpoints: { backupType: incremental ? 'incremental' : 'full-backuped', fromLsn, toLsn, lastLsn: String(Number(toLsn) + 10) },
          chain: { chainRootRecoveryPointId: incremental ? options.previousRecoveryPoint.chainRootId || options.previousRecoveryPoint.id : null, parentRecoveryPointId: incremental ? options.previousRecoveryPoint.id : null },
          artifact: { kind: 'physical-backup', path: `mysql-physical/${incremental ? 'incremental' : 'full'}-${toLsn}.xbstream`, mediaType: 'application/x-xbstream' }
        },
        content: () => Readable.from([bytes])
      };
    },
    async release() { return true; }
  };
  const registry = new DatabaseAdapterRegistry([adapter]);
  const mysqlReader = new MysqlSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, physicalBackupService });
  const sourceReader = new BackupSourceReaderRouter({
    controlDatabase: database,
    fileReader: new FileSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID }),
    databaseReaders: { [ADAPTER_ID]: mysqlReader }
  });
  const service = new ManualBackupService({ controlDatabase: database, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'physical-checkpoints') }), deviceId: DEVICE_ID, openRepository });
  const fullRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(fullRun.id);
  const fullCompleted = await database.repository('run').get(WORKSPACE_ID, fullRun.id);
  assert.equal(fullCompleted.state, 'succeeded', JSON.stringify({ result: fullCompleted.result, payloads }));
  const incrementalRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(incrementalRun.id);
  const incrementalCompleted = await database.repository('run').get(WORKSPACE_ID, incrementalRun.id);
  assert.equal(incrementalCompleted.state, 'succeeded', JSON.stringify(incrementalCompleted.result));

  const points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  const physicalPoints = points.filter((point) => point.jobId === job.id);
  const anchor = physicalPoints.find((point) => point.type === 'full');
  const incremental = physicalPoints.find((point) => point.type === 'incremental');
  assert.ok(anchor);
  assert.equal(incremental.parentRecoveryPointId, anchor.id);
  assert.equal(incremental.chainRootId, anchor.id);
  assert.deepEqual(payloads.map((item) => item.incremental), [false, true]);
  assert.equal(payloads[1].previousRecoveryPointId, anchor.id);
  const artifacts = (await database.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).filter((artifact) => artifact.kind === 'physical-backup' && [anchor.id, incremental.id].includes(artifact.recoveryPointId));
  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts.map((artifact) => artifact.metadata.checkpoints.toLsn).sort(), ['100', '180']);
  const opened = openedRepositories.get(repositories[0].id);
  for (const point of [anchor, incremental]) {
    const snapshot = await opened.engine.openSnapshot({}, { repositoryId: opened.repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey: opened.masterKey });
    const file = snapshot.manifest.files.find((item) => item.metadata?.artifactKind === 'physical-backup');
    const chunks = [];
    for await (const chunk of opened.engine.streamFile({}, { repositoryId: opened.repository.id, manifest: snapshot.manifest, masterKey: opened.masterKey, path: file.path })) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).equals(payloads[point.type === 'full' ? 0 : 1].bytes), true);
  }
});

test('restores a MySQL chain to an exact authenticated binary-log coordinate', async (context) => {
  const { root, database, secretStore, runner, adapter, connection, job, service, openRepository } = await fixture(context, 1, { pitr: true, backupMode: 'incremental' });
  const anchorRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(anchorRun.id);
  const logRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(logRun.id);
  const points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  const logPoint = points.find((point) => point.type === 'log');
  const logArtifact = (await database.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).find((artifact) => artifact.recoveryPointId === logPoint.id && artifact.kind === 'transaction-log');
  const baseRestoreService = new MysqlRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository });
  const temporaryRoot = path.join(root, 'pitr');
  await fs.mkdir(temporaryRoot);
  const pitr = new MysqlPointInTimeRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, baseRestoreService, openRepository, temporaryRoot });
  const started = await pitr.start(WORKSPACE_ID, 'tester', { terminalRecoveryPointId: logPoint.id, mode: 'original', stop: { coordinate: logArtifact.metadata.binaryLog.endCoordinate }, confirmed: true, confirmationText: 'RECOVER MYSQL TO POINT IN TIME' });
  const completed = await pitr.wait(WORKSPACE_ID, started.id);
  const restoreRuns = await database.repository('restoreRun').list(WORKSPACE_ID, { limit: 20 });
  assert.equal(completed.state, 'succeeded', JSON.stringify({ pitr: completed.result, restoreRuns: restoreRuns.map((run) => ({ id: run.id, state: run.state, target: run.target, result: run.result })) }));
  assert.equal(completed.result.fullAnchorRecoveryPointId, points.find((point) => point.type === 'full').id);
  assert.equal(completed.result.replayedFiles, 2);
  assert.equal(completed.result.stop.type, 'coordinate');
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.match(completed.result.anchorRestoreRunId, /^restore_/);
  assert.equal(runner.consumeCalls >= 2, true);
  const timestamp = logArtifact.metadata.binaryLog.endCoordinate.capturedAt;
  const timestampStarted = await pitr.start(WORKSPACE_ID, 'tester', { terminalRecoveryPointId: logPoint.id, mode: 'original', stop: { timestamp }, confirmed: true, confirmationText: 'RECOVER MYSQL TO POINT IN TIME' });
  const timestampCompleted = await pitr.wait(WORKSPACE_ID, timestampStarted.id);
  assert.equal(timestampCompleted.state, 'succeeded', JSON.stringify(timestampCompleted.result));
  assert.equal(timestampCompleted.result.stop.type, 'timestamp');
  assert.equal(timestampCompleted.result.stop.timestamp, timestamp);
  assert.ok(runner.streamInputs.some((input) => input.args?.includes(`--stop-datetime=${timestamp.replace('T', ' ').replace(/[.]\d{3}Z$/, '')}`) && input.env?.TZ === 'UTC'));
  assert.equal((await baseRestoreService.list(WORKSPACE_ID, { limit: 20 })).every((run) => run.target?.operation !== 'point-in-time'), true);
  assert.equal((await pitr.list(WORKSPACE_ID, { limit: 20 })).length, 2);
  assert.deepEqual(await fs.readdir(temporaryRoot), []);

  const abandoned = await database.repository('restoreRun').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [logPoint.id], targetConnectionId: connection.id,
    target: { ...completed.target, operation: 'point-in-time' }, mode: 'original', conflictPolicy: 'overwrite',
    workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'replaying-logs' }
  });
  const reconciled = await pitr.reconcile(WORKSPACE_ID, 'reconciler');
  const interrupted = reconciled.find((record) => record.id === abandoned.id);
  assert.equal(interrupted.state, 'failed');
  assert.equal(interrupted.result.error.code, 'MYSQL_PITR_PROCESS_INTERRUPTED');
  assert.equal(interrupted.result.error.retryable, true);
});
