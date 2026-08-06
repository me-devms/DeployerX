const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MysqlPhysicalBackupService,
  grantsSatisfyXtrabackup,
  parseCheckpoints,
  parseMysql84Version,
  parseXtrabackupVersion,
  validateIncrementalPredecessor,
  validatePhysicalSelection
} = require('./mysql-physical');

function physicalPlan() {
  const empty = { include: [], exclude: [] };
  return {
    source: {
      id: 'source-mysql', adapterId: 'deployerx.database.mysql.logical',
      selector: { kind: 'database-objects', allDatabases: true, databases: empty, schemas: empty, tables: empty, includeGlobalObjects: false, digest: 'selection-digest' },
      consistency: { backupMethod: 'physical' },
      physicalExecution: { sshConnectionId: 'ssh-1', remoteTemporaryDirectory: '/var/tmp', dataDirectory: '/var/lib/mysql', serviceName: 'mysql', mysqlOwner: 'mysql', mysqlGroup: 'mysql', privilegeMode: 'sudo-noninteractive', xtrabackupExecutable: 'xtrabackup', xbstreamExecutable: 'xbstream', mysqlExecutable: 'mysql' }
    },
    connection: { id: 'mysql-1', revision: 3, secretRefIds: ['sec_mysqlpass'], trust: { fingerprint: 'sha256:mysql' }, lastTest: { endpointIdentity: { serverUuid: 'server-uuid' } } },
    connectionConfig: { host: 'db.example.com', port: 3306, username: 'backup', passwordSecretRefId: 'sec_mysqlpass', tlsMode: 'required', timeoutMs: 30000, mysqlExecutable: 'mysql', mysqldumpExecutable: 'mysqldump', mysqlbinlogExecutable: 'mysqlbinlog' },
    manifest: { adapterVersion: '1.4.0' }
  };
}

class FakePhysicalSession {
  constructor(options = {}) {
    this.commands = [];
    this.uploads = [];
    this.closed = false;
    this.checkpoints = options.checkpoints || 'backup_type = full-backuped\nfrom_lsn = 0\nto_lsn = 900\nlast_lsn = 910\n';
    this.serverUuid = options.serverUuid || 'server-uuid';
  }
  async run(command) {
    this.commands.push(command);
    if (command.includes("'mktemp'")) return { stdout: '/var/tmp/deployerx-xtrabackup-run-1.ABC123\n', stderr: '', exitCode: 0 };
    if (command.includes("'xtrabackup' '--version'")) return { stdout: 'xtrabackup version 8.4.0-1', stderr: '', exitCode: 0 };
    if (command.includes("'xbstream' '--version'")) return { stdout: 'xbstream version 8.4.0-1', stderr: '', exitCode: 0 };
    if (command.includes('SELECT VERSION()')) return { stdout: `8.4.6\t${this.serverUuid}\t/var/lib/mysql/\n`, stderr: '', exitCode: 0 };
    if (command.includes('SHOW GRANTS')) return { stdout: 'GRANT BACKUP_ADMIN, PROCESS, RELOAD, LOCK TABLES, REPLICATION CLIENT ON *.* TO backup\n', stderr: '', exitCode: 0 };
    if (command.includes('xtrabackup_checkpoints')) return { stdout: this.checkpoints, stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  async writeFile(remotePath, content, options) { this.uploads.push({ remotePath, content: String(content), options }); }
  async stream(command) {
    this.commands.push(command);
    return { stdout: (async function* () { yield Buffer.from('xbstream-data'); })(), completion: Promise.resolve({ exitCode: 0, stderr: '' }), close() {} };
  }
  close() { this.closed = true; }
}

test('XtraBackup and MySQL compatibility is limited to the 8.4 line', () => {
  assert.equal(parseXtrabackupVersion('xtrabackup version 8.4.0-1 based on MySQL server 8.4.0').version, '8.4.0');
  assert.equal(parseMysql84Version('8.4.6').patch, 6);
  assert.throws(() => parseXtrabackupVersion('xtrabackup version 8.0.35'), (error) => error.code === 'MYSQL_PHYSICAL_TOOL_UNSUPPORTED');
  assert.throws(() => parseMysql84Version('8.0.42'), (error) => error.code === 'MYSQL_PHYSICAL_SERVER_UNSUPPORTED');
});

test('authenticated checkpoint parsing refuses malformed and reversed LSNs', () => {
  assert.deepEqual(parseCheckpoints('backup_type = incremental\nfrom_lsn = 120\nto_lsn = 180\nlast_lsn = 190\n'), { backupType: 'incremental', fromLsn: '120', toLsn: '180', lastLsn: '190' });
  assert.throws(() => parseCheckpoints('backup_type = incremental\nfrom_lsn = 180\nto_lsn = 120\nlast_lsn = 190\n'), (error) => error.code === 'MYSQL_PHYSICAL_CHECKPOINT_INVALID');
  assert.throws(() => parseCheckpoints('backup_type = incremental\nfrom_lsn = nope\nto_lsn = 180\nlast_lsn = 190\n'), (error) => error.code === 'MYSQL_PHYSICAL_LSN_INVALID');
});

test('whole-instance selection and XtraBackup grants fail closed', () => {
  validatePhysicalSelection({ kind: 'database-objects', allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false });
  assert.throws(() => validatePhysicalSelection({ kind: 'database-objects', allDatabases: false, databases: { include: [{ name: 'orders' }], exclude: [] } }), (error) => error.code === 'MYSQL_PHYSICAL_SELECTION_UNSUPPORTED');
  assert.equal(grantsSatisfyXtrabackup('GRANT BACKUP_ADMIN, PROCESS, RELOAD, LOCK TABLES, REPLICATION CLIENT ON *.* TO `backup`@`%`'), true);
  assert.equal(grantsSatisfyXtrabackup('GRANT SELECT ON *.* TO `backup`@`%`'), false);
});

test('incremental chains bind server, source, job, root, and exact preceding LSN', () => {
  const result = validateIncrementalPredecessor({
    kind: 'mysql-xtrabackup',
    server: { serverUuid: 'uuid-a' },
    source: { sourceId: 'source-a', jobId: 'job-a' },
    checkpoints: { toLsn: '1234' },
    chain: { chainRootRecoveryPointId: 'rp-root' }
  }, { serverUuid: 'uuid-a', sourceId: 'source-a', jobId: 'job-a', previousRecoveryPointId: 'rp-parent' });
  assert.deepEqual(result, { toLsn: '1234', chainRootRecoveryPointId: 'rp-root' });
  assert.throws(() => validateIncrementalPredecessor({ kind: 'mysql-xtrabackup', server: { serverUuid: 'other' }, source: { sourceId: 'source-a', jobId: 'job-a' }, checkpoints: { toLsn: '1234' } }, { serverUuid: 'uuid-a', sourceId: 'source-a', jobId: 'job-a' }), (error) => error.code === 'MYSQL_PHYSICAL_CHAIN_MISMATCH');
});

test('physical service pairs tested identities, hides credentials, and streams one xbstream artifact', async () => {
  const session = new FakePhysicalSession();
  const sshConnection = {
    id: 'ssh-1', revision: 4, adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0',
    endpoint: { host: 'db.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 },
    secretRefIds: ['sec_sshkey'], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' },
    workerAffinity: ['device:device-a'], lastTest: { status: 'success' }
  };
  const service = new MysqlPhysicalBackupService({
    controlDatabase: { repository: (name) => ({
      get: async () => name === 'connection' ? sshConnection : null,
      list: async () => []
    }) },
    secretStore: { resolve: async ({ id }) => id === 'sec_mysqlpass' ? 'mysql-password-value' : 'ssh-private-key-value' },
    deviceId: 'device-a',
    sessionFactory: async () => session
  });
  const prepared = await service.prepare('workspace-a', 'run-1', physicalPlan(), { backupMode: 'full', jobId: 'job-a' });
  assert.equal(prepared.databaseManifest.checkpoints.toLsn, '900');
  assert.equal(prepared.databaseManifest.artifact.kind, 'physical-backup');
  const chunks = [];
  for await (const chunk of prepared.content()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'xbstream-data');
  assert.equal(session.uploads[0].options.mode, 0o600);
  assert.match(session.uploads[0].content, /mysql-password-value/);
  assert.equal(session.commands.some((command) => command.includes('mysql-password-value') || command.includes('ssh-private-key-value')), false);
  await service.release(prepared);
  assert.equal(session.closed, true);
  assert.equal(session.commands.some((command) => command.includes("'rm' '-rf' '--' '/var/tmp/deployerx-xtrabackup-run-1.ABC123'")), true);
});

test('physical service executes an incremental from the authenticated preceding LSN', async () => {
  const session = new FakePhysicalSession({ checkpoints: 'backup_type = incremental\nfrom_lsn = 900\nto_lsn = 1200\nlast_lsn = 1210\n' });
  const sshConnection = {
    id: 'ssh-1', revision: 4, adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0',
    endpoint: { host: 'db.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 },
    secretRefIds: ['sec_sshkey'], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' },
    workerAffinity: ['device:device-a'], lastTest: { status: 'success' }
  };
  const precedingMetadata = {
    kind: 'mysql-xtrabackup', server: { serverUuid: 'server-uuid' },
    source: { sourceId: 'source-mysql', jobId: 'job-a' }, checkpoints: { toLsn: '900' },
    chain: { chainRootRecoveryPointId: null }
  };
  const service = new MysqlPhysicalBackupService({
    controlDatabase: { repository: (name) => ({
      get: async () => name === 'connection' ? sshConnection : null,
      list: async () => name === 'artifact' ? [{ recoveryPointId: 'rp-full', kind: 'physical-backup', metadata: precedingMetadata }] : []
    }) },
    secretStore: { resolve: async ({ id }) => id === 'sec_mysqlpass' ? 'mysql-password-value' : 'ssh-private-key-value' },
    deviceId: 'device-a', sessionFactory: async () => session
  });
  const prepared = await service.prepare('workspace-a', 'run-2', physicalPlan(), {
    backupMode: 'incremental', jobId: 'job-a', previousRecoveryPoint: { id: 'rp-full', sourceId: 'source-mysql', jobId: 'job-a', type: 'full' }
  });
  assert.equal(prepared.databaseManifest.backupMode, 'incremental');
  assert.deepEqual(prepared.databaseManifest.checkpoints, { backupType: 'incremental', fromLsn: '900', toLsn: '1200', lastLsn: '1210' });
  assert.deepEqual(prepared.databaseManifest.chain, { chainRootRecoveryPointId: 'rp-full', parentRecoveryPointId: 'rp-full' });
  assert.equal(prepared.artifactPath, 'mysql-physical/incremental-1200.xbstream');
  assert.equal(session.commands.some((command) => command.includes("'--incremental-lsn=900'")), true);
  await service.release(prepared);
});

test('physical service refuses an SSH host that reaches a different MySQL server', async () => {
  const session = new FakePhysicalSession({ serverUuid: 'different-server-uuid' });
  const sshConnection = {
    id: 'ssh-1', revision: 4, adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0',
    endpoint: { host: 'db.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 },
    secretRefIds: ['sec_sshkey'], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' },
    workerAffinity: ['device:device-a'], lastTest: { status: 'success' }
  };
  const service = new MysqlPhysicalBackupService({
    controlDatabase: { repository: () => ({ get: async () => sshConnection, list: async () => [] }) },
    secretStore: { resolve: async () => 'secret' }, deviceId: 'device-a', sessionFactory: async () => session
  });
  await assert.rejects(service.prepare('workspace-a', 'run-mismatch', physicalPlan(), { backupMode: 'full', jobId: 'job-a' }), (error) => error.code === 'MYSQL_PHYSICAL_SERVER_PAIR_MISMATCH');
  assert.equal(session.closed, true);
  assert.equal(session.commands.some((command) => command.includes("'rm' '-rf' '--' '/var/tmp/deployerx-xtrabackup-run-1.ABC123'")), true);
});
