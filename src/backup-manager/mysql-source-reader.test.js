const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { MysqlConnectionService, MysqlLogicalAdapter } = require('./mysql-logical');
const { MysqlSourceReaderService } = require('./mysql-source-reader');
const { BackupSecretStore } = require('./secrets');

function secureStorage() {
  return { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, '') };
}

class MysqlRunner {
  constructor(options = {}) { this.streamCalls = 0; this.captureCoordinates = Boolean(options.captureCoordinates); this.serverVersion = options.mysqlVersion || '8.0.36'; this.dump = Buffer.from(this.captureCoordinates ? "-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='mysql-bin.000042', SOURCE_LOG_POS=8192;\nCREATE DATABASE `orders`;\n" : '-- one consistent dump\nCREATE DATABASE `orders`;\n'); }
  async run(input) {
    if (input.args.includes('--version')) return { stdout: `${path.basename(input.executable)} Ver 8.0.36`, exitCode: 0, stderr: '' };
    const query = input.args.find((argument) => argument.startsWith('--execute='))?.slice(10) || '';
    if (query.startsWith('SHOW GRANTS')) return { stdout: `GRANT SELECT, SHOW VIEW, TRIGGER, EVENT${this.captureCoordinates ? ', RELOAD, REPLICATION CLIENT, REPLICATION SLAVE' : ''} ON *.* TO \`backup\`@\`%\`\n`, exitCode: 0, stderr: '' };
    if (query.includes('@@global.log_bin')) return { stdout: '1\tROW\tFULL\tCRC32\n', exitCode: 0, stderr: '' };
    if (query.startsWith('SELECT SCHEMA_NAME')) return { stdout: 'orders\t\tdatabase\t\norders\titems\trelation\ttable\n', exitCode: 0, stderr: '' };
    if (query.includes('information_schema.tables')) return { stdout: '0\n', exitCode: 0, stderr: '' };
    if (query.includes('@@character_set_server')) return { stdout: `${this.serverVersion}\tuuid-source\tMySQL Community Server\tutf8mb4\tutf8mb4_0900_ai_ci\n`, exitCode: 0, stderr: '' };
    return { stdout: `${this.serverVersion}\tuuid-source\tMySQL Community Server\n`, exitCode: 0, stderr: '' };
  }
  stream() { this.streamCalls += 1; return { stdout: Readable.from(this.dump), completion: Promise.resolve({ exitCode: 0, stderr: '' }), cancel() {} }; }
  async consume() { return { exitCode: 0, stdout: '', stderr: '' }; }
}

async function fixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mysql-reader-test-'));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  const secretStore = new BackupSecretStore({ rootPath: path.join(root, 'secrets'), secureStorage: secureStorage(), isReferenced: async () => false });
  await secretStore.initialize();
  context.after(async () => { await controlDatabase.close(); await fs.rm(root, { recursive: true, force: true }); });
  const runner = new MysqlRunner(options);
  const adapter = new MysqlLogicalAdapter({ processRunner: runner, temporaryRoot: path.join(root, 'credentials') });
  await fs.mkdir(path.join(root, 'credentials'), { recursive: true });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connectionService = new MysqlConnectionService({ controlDatabase, secretStore, deviceId: 'device-a', adapter });
  const connection = await connectionService.create('workspace-a', 'tester', { name: 'Production MySQL', host: 'db.example.com', username: 'backup', password: 'not-persisted', tlsMode: 'verify-identity' });
  const tested = await connectionService.test('workspace-a', connection.id, 'tester');
  const sourceService = new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, deviceId: 'device-a' });
  const source = await sourceService.save('workspace-a', 'tester', { name: 'Orders database', connectionId: connection.id, selector: { databases: { include: [{ name: 'orders' }] } }, consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full', captureCoordinates: Boolean(options.captureCoordinates) } });
  const dumpRoot = path.join(root, 'dumps');
  await fs.mkdir(dumpRoot, { recursive: true });
  const reader = new MysqlSourceReaderService({ controlDatabase, secretStore, deviceId: 'device-a', adapterRegistry: registry, adapter, temporaryRoot: dumpRoot });
  return { root, dumpRoot, controlDatabase, secretStore, runner, adapter, registry, connection: tested.connection, sourceService, source, reader };
}

async function collectFiles(sourceFiles) {
  const entries = [];
  for await (const entry of sourceFiles.create()) {
    const chunks = [];
    for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
    entries.push({ ...entry, content: Buffer.concat(chunks) });
  }
  return entries;
}

test('persists MySQL credentials only as SecretRefs and captures server identity on test', async (context) => {
  const { root, controlDatabase, secretStore, connection } = await fixture(context);
  assert.equal(connection.kind, 'database');
  assert.equal(connection.lastTest.status, 'success');
  assert.match(connection.trust.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(connection.secretRefIds.length, 1);
  assert.equal(await secretStore.resolve({ workspaceId: 'workspace-a', id: connection.secretRefIds[0] }), 'not-persisted');
  const databaseBytes = await fs.readFile(path.join(root, 'control', 'control.db'));
  assert.equal(databaseBytes.includes(Buffer.from('not-persisted')), false);
});

test('authenticates the native snapshot coordinate in a PITR-enabled full dump manifest', async (context) => {
  const { source, reader } = await fixture(context, { captureCoordinates: true });
  const files = await reader.files('workspace-a', source.id, { executionId: 'run_anchor' });
  const [entry] = await collectFiles(files);
  assert.equal(files.manifest.consistency.captureCoordinates, true);
  assert.equal(entry.metadata.database.binaryLog.anchorCoordinate.file, 'mysql-bin.000042');
  assert.equal(entry.metadata.database.binaryLog.anchorCoordinate.position, 8192);
  assert.deepEqual(entry.metadata.database.binaryLog.settings, { enabled: true, format: 'ROW', rowImage: 'FULL', checksum: 'CRC32', privilegesVerified: true, toolVerified: true });
});

test('spools one proven MySQL dump per run and reuses identical bytes for every repository', async (context) => {
  const { dumpRoot, runner, source, reader } = await fixture(context);
  const events = [];
  const first = await reader.files('workspace-a', source.id, { executionId: 'run_one', onProgress: async (event) => events.push(event) });
  const second = await reader.files('workspace-a', source.id, { executionId: 'run_one' });
  const [firstFile] = await collectFiles(first);
  const [secondFile] = await collectFiles(second);
  assert.equal(runner.streamCalls, 1);
  assert.equal(firstFile.content.toString(), secondFile.content.toString());
  assert.equal(first.manifest.consistency.achievedLevel, 'application');
  assert.equal(firstFile.metadata.artifactKind, 'database-dump');
  assert.equal(firstFile.metadata.database.server.serverVersion, '8.0.36');
  assert.equal(events.some((event) => event.bytesRead > 0), true);
  assert.equal((await fs.readdir(dumpRoot)).length, 1);
  await reader.release('workspace-a', 'run_one');
  assert.deepEqual(await fs.readdir(dumpRoot), []);
});

test('refuses a changed MySQL server identity before producing dump bytes', async (context) => {
  const { controlDatabase, connection, source, reader, runner } = await fixture(context);
  await controlDatabase.repository('connection').update('workspace-a', connection.id, { trust: { ...connection.trust, fingerprint: 'sha256:changed-server' } }, { expectedRevision: connection.revision, actorId: 'tester' });
  await assert.rejects(reader.files('workspace-a', source.id, { executionId: 'run_changed' }), (error) => error.code === 'MYSQL_SERVER_IDENTITY_CHANGED');
  assert.equal(runner.streamCalls, 0);
});

test('persists a tested current-device physical Source and reuses one prepared xbstream per run', async (context) => {
  const { controlDatabase, secretStore, adapter, registry, connection, sourceService } = await fixture(context, { mysqlVersion: '8.4.6' });
  const sshSecret = await secretStore.create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'Production SSH key', secretType: 'private-key', value: 'ssh-private-key-not-persisted' });
  await controlDatabase.repository('secretRef').create({ ...sshSecret, workspaceId: 'workspace-a', actorId: 'tester' });
  const sshConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Production Linux', kind: 'ssh',
    adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0',
    endpoint: { host: 'db.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 },
    secretRefIds: [sshSecret.id], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' },
    workerAffinity: ['device:device-a'], lastTest: { status: 'success', testedAt: '2026-08-04T12:00:00.000Z' }
  });
  const execution = {
    sshConnectionId: sshConnection.id, remoteTemporaryDirectory: '/var/tmp/', dataDirectory: '/var/lib/mysql/', serviceName: 'mysql',
    mysqlOwner: 'mysql', mysqlGroup: 'mysql', privilegeMode: 'sudo-noninteractive', xtrabackupExecutable: 'xtrabackup', xbstreamExecutable: 'xbstream', mysqlExecutable: 'mysql'
  };
  const unsupportedConnection = await controlDatabase.repository('connection').update('workspace-a', connection.id, {
    lastTest: { ...connection.lastTest, remotePlatform: { ...connection.lastTest.remotePlatform, version: '8.0.42' } }
  }, { expectedRevision: connection.revision, actorId: 'tester' });
  await assert.rejects(sourceService.save('workspace-a', 'tester', {
    name: 'Unsupported MySQL physical', connectionId: connection.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full' }, physicalExecution: execution
  }), /MySQL 8\.4/);
  await controlDatabase.repository('connection').update('workspace-a', connection.id, {
    lastTest: { ...connection.lastTest, remotePlatform: { ...connection.lastTest.remotePlatform, version: '8.4.6' } }
  }, { expectedRevision: unsupportedConnection.revision, actorId: 'tester' });
  const physicalSource = await sourceService.save('workspace-a', 'tester', {
    name: 'Production MySQL physical', connectionId: connection.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full' }, physicalExecution: execution
  });
  assert.equal(physicalSource.selector.allDatabases, true);
  assert.equal(physicalSource.physicalExecution.remoteTemporaryDirectory, '/var/tmp');
  assert.equal(physicalSource.physicalExecution.dataDirectory, '/var/lib/mysql');
  await assert.rejects(sourceService.save('workspace-a', 'tester', {
    name: 'Invalid partial physical', connectionId: connection.id, selector: { databases: { include: [{ name: 'orders' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full' }, physicalExecution: execution
  }), /whole instance/);

  let prepareCalls = 0;
  let releaseCalls = 0;
  const physicalBackupService = {
    async prepare() {
      prepareCalls += 1;
      return {
        artifactPath: 'mysql-physical/full-100.xbstream',
        databaseManifest: {
          kind: 'mysql-xtrabackup', backupMethod: 'physical', backupMode: 'full',
          consistency: { achievedLevel: 'application', backupMethod: 'physical', backupMode: 'full', proven: true },
          artifact: { kind: 'physical-backup', path: 'mysql-physical/full-100.xbstream' }
        },
        content: () => Readable.from([Buffer.from('xbstream-once')])
      };
    },
    async release() { releaseCalls += 1; return true; }
  };
  const reader = new MysqlSourceReaderService({ controlDatabase, secretStore, deviceId: 'device-a', adapterRegistry: registry, adapter, physicalBackupService });
  const first = await reader.files('workspace-a', physicalSource.id, { executionId: 'run-physical', backupMode: 'full', jobId: 'job-a' });
  const second = await reader.files('workspace-a', physicalSource.id, { executionId: 'run-physical', backupMode: 'full', jobId: 'job-a' });
  const [firstFile] = await collectFiles(first);
  const [secondFile] = await collectFiles(second);
  assert.equal(prepareCalls, 1);
  assert.equal(firstFile.metadata.artifactKind, 'physical-backup');
  assert.equal(firstFile.content.toString(), 'xbstream-once');
  assert.equal(secondFile.content.toString(), 'xbstream-once');
  await reader.release('workspace-a', 'run-physical');
  assert.equal(releaseCalls, 1);
});
