const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PostgresqlPhysicalBackupService,
  nextWalSegment,
  parseArchiveInventory,
  parseBackupManifest,
  parsePostgresqlToolVersion,
  parseWalSegmentSize,
  selectWalFiles,
  validatePhysicalSelection,
  walSegmentForLsn
} = require('./postgresql-physical');

const SEGMENT_SIZE = 16 * 1024 * 1024;

function physicalPlan() {
  const empty = { include: [], exclude: [] };
  return {
    source: {
      id: 'source-postgresql', adapterId: 'deployerx.database.postgresql.logical',
      selector: { kind: 'database-objects', allDatabases: true, databases: empty, schemas: empty, tables: empty, includeGlobalObjects: false, digest: 'selection-digest' },
      consistency: { backupMethod: 'physical' },
      physicalExecution: {
        engine: 'postgresql', sshConnectionId: 'ssh-1', remoteTemporaryDirectory: '/var/tmp', dataDirectory: '/var/lib/postgresql/data',
        walArchiveDirectory: '/var/lib/postgresql/wal-archive', serviceName: 'postgresql', postgresOwner: 'postgres', postgresGroup: 'postgres',
        privilegeMode: 'sudo-noninteractive', pgBasebackupExecutable: 'pg_basebackup', pgVerifybackupExecutable: 'pg_verifybackup',
        pgWaldumpExecutable: 'pg_waldump', psqlExecutable: 'psql', tarExecutable: 'tar'
      }
    },
    connection: { id: 'postgresql-1', revision: 3, secretRefIds: ['sec_pgpass'], trust: { fingerprint: 'sha256:postgresql' }, lastTest: { endpointIdentity: { systemIdentifier: '7420000000000000001' } } },
    executionConnection: { id: 'ssh-1', revision: 4 },
    connectionConfig: { host: 'db.example.com', port: 5432, username: 'backup', maintenanceDatabase: 'postgres', passwordSecretRefId: 'sec_pgpass', tlsMode: 'required', timeoutMs: 30000 },
    manifest: { adapterVersion: '1.4.0' }
  };
}

function backupManifest() {
  return JSON.stringify({
    'PostgreSQL-Backup-Manifest-Version': 2,
    'System-Identifier': '7420000000000000001',
    'WAL-Ranges': [{ Timeline: 1, 'Start-LSN': '0/2000028', 'End-LSN': '0/3000000' }],
    'Manifest-Checksum': 'SHA256:fixture'
  });
}

class FakePostgresqlPhysicalSession {
  constructor(options = {}) {
    this.commands = [];
    this.uploads = [];
    this.closed = false;
    this.systemIdentifier = options.systemIdentifier || '7420000000000000001';
    this.walMode = Boolean(options.walMode);
  }

  async run(command) {
    this.commands.push(command);
    if (command.includes("'mktemp'")) return { stdout: '/var/tmp/deployerx-postgresql-run-1.ABC123\n', stderr: '', exitCode: 0 };
    if (command.includes("'--version'")) {
      const tool = ['pg_basebackup', 'pg_verifybackup', 'pg_waldump', 'psql'].find((name) => command.includes(`'${name}'`));
      return { stdout: `${tool} (PostgreSQL) 16.4\n`, stderr: '', exitCode: 0 };
    }
    if (command.includes('pg_control_system')) return { stdout: `16.4\t${this.systemIdentifier}\t/var/lib/postgresql/data\tf\treplica\ton\t10\ton\ttest ! -f /var/lib/postgresql/wal-archive/%f && cp %p /var/lib/postgresql/wal-archive/%f\t\t16MB\t0\tt\n`, stderr: '', exitCode: 0 };
    if (command.includes('pg_switch_wal')) return { stdout: '000000010000000000000005\n', stderr: '', exitCode: 0 };
    if (command.includes("'find'")) return { stdout: '000000010000000000000004\t16777216\tf\n000000010000000000000005\t16777216\tf\n00000002.history\t42\tf\n', stderr: '', exitCode: 0 };
    if (command.includes('backup_manifest')) return { stdout: backupManifest(), stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async writeFile(remotePath, content, options) { this.uploads.push({ remotePath, content: String(content), options }); }

  async stream(command) {
    this.commands.push(command);
    return { stdout: (async function* () { yield Buffer.from('postgresql-tar-data'); })(), completion: Promise.resolve({ exitCode: 0, stderr: '' }), close() {} };
  }

  close() { this.closed = true; }
}

function dependencies(session, artifacts = []) {
  const sshConnection = {
    id: 'ssh-1', revision: 4, adapterId: 'deployerx.connection.ssh',
    endpoint: { host: 'db.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 },
    secretRefIds: ['sec_sshkey'], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' },
    workerAffinity: ['device:device-a'], lastTest: { status: 'success' }
  };
  return {
    controlDatabase: { repository: (name) => ({ get: async () => name === 'connection' ? sshConnection : null, list: async () => name === 'artifact' ? artifacts : [] }) },
    secretStore: { resolve: async ({ id }) => id === 'sec_pgpass' ? 'postgres-password-value' : 'ssh-private-key-value' },
    deviceId: 'device-a', sessionFactory: async () => session, delay: async () => {}
  };
}

test('PostgreSQL physical compatibility and whole-cluster selection fail closed', () => {
  assert.equal(parsePostgresqlToolVersion('pg_basebackup (PostgreSQL) 14.12', 'pg_basebackup').major, 14);
  assert.equal(parsePostgresqlToolVersion('pg_verifybackup (PostgreSQL) 18.1', 'pg_verifybackup').major, 18);
  assert.throws(() => parsePostgresqlToolVersion('pg_basebackup (PostgreSQL) 13.9', 'pg_basebackup'), (error) => error.code === 'POSTGRESQL_PHYSICAL_TOOL_UNSUPPORTED');
  assert.equal(parseWalSegmentSize('16MB'), SEGMENT_SIZE);
  assert.throws(() => parseWalSegmentSize('3MB'), (error) => error.code === 'POSTGRESQL_WAL_SEGMENT_SIZE_INVALID');
  validatePhysicalSelection(physicalPlan().source.selector);
  assert.throws(() => validatePhysicalSelection({ ...physicalPlan().source.selector, allDatabases: false }), (error) => error.code === 'POSTGRESQL_PHYSICAL_SELECTION_UNSUPPORTED');
});

test('backup manifests and WAL segment arithmetic preserve exact boundaries', () => {
  const parsed = parseBackupManifest(backupManifest());
  assert.equal(parsed.systemIdentifier, '7420000000000000001');
  assert.equal(parsed.timeline, 1);
  assert.equal(parsed.endLsn, '0/3000000');
  assert.equal(walSegmentForLsn(parsed.endLsn, parsed.timeline, SEGMENT_SIZE), '000000010000000000000003');
  assert.equal(nextWalSegment('0000000100000000000000FF', SEGMENT_SIZE), '000000010000000100000000');
  assert.throws(() => parseBackupManifest('{"WAL-Ranges":[]}'), (error) => error.code === 'POSTGRESQL_BACKUP_MANIFEST_INVALID');
});

test('archive selection requires exact same-timeline continuity and segment sizes', () => {
  const inventory = parseArchiveInventory('000000010000000000000004\t16777216\tf\n000000010000000000000005\t16777216\tf\n00000002.history\t42\tf\nunsafe\t4\tf\n');
  const selected = selectWalFiles(inventory, '000000010000000000000003', '000000010000000000000005', SEGMENT_SIZE);
  assert.deepEqual(selected.map((file) => file.name), ['00000002.history', '000000010000000000000004', '000000010000000000000005']);
  assert.throws(() => selectWalFiles(inventory.filter((file) => !file.name.endsWith('0004')), '000000010000000000000003', '000000010000000000000005', SEGMENT_SIZE), (error) => error.code === 'POSTGRESQL_WAL_ARCHIVE_GAP');
  assert.throws(() => selectWalFiles(inventory, '000000010000000000000003', '000000020000000000000005', SEGMENT_SIZE), (error) => error.code === 'POSTGRESQL_WAL_TIMELINE_CHANGED');
});

test('full physical service verifies a same-major base backup and streams one protected artifact', async () => {
  const session = new FakePostgresqlPhysicalSession();
  const service = new PostgresqlPhysicalBackupService(dependencies(session));
  const prepared = await service.prepare('workspace-a', 'run-1', physicalPlan(), { backupMode: 'full', jobId: 'job-a' });
  assert.equal(prepared.databaseManifest.kind, 'postgresql-basebackup');
  assert.equal(prepared.databaseManifest.wal.endSegment, '000000010000000000000003');
  assert.equal(prepared.databaseManifest.artifact.kind, 'physical-backup');
  assert.equal(session.commands.some((command) => command.includes("'--manifest-checksums=SHA256'") && command.includes("'--wal-method=stream'")), true);
  assert.equal(session.commands.some((command) => command.includes("'pg_verifybackup'")), true);
  const chunks = [];
  for await (const chunk of prepared.content()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'postgresql-tar-data');
  assert.match(session.uploads[0].content, /postgres-password-value/);
  assert.equal(session.commands.some((command) => command.includes('postgres-password-value')), false);
  await service.release(prepared);
  assert.equal(session.closed, true);
});

test('incremental physical service publishes contiguous archived WAL with an authenticated parent', async () => {
  const session = new FakePostgresqlPhysicalSession({ walMode: true });
  const previousMetadata = {
    kind: 'postgresql-basebackup', server: { systemIdentifier: '7420000000000000001', major: 16 }, source: { sourceId: 'source-postgresql', jobId: 'job-a' },
    wal: { lastSegment: '000000010000000000000003', segmentSizeBytes: SEGMENT_SIZE }, chain: { chainRootRecoveryPointId: null }
  };
  const service = new PostgresqlPhysicalBackupService(dependencies(session, [{ recoveryPointId: 'rp-full', kind: 'physical-backup', metadata: previousMetadata }]));
  const prepared = await service.prepare('workspace-a', 'run-2', physicalPlan(), {
    backupMode: 'incremental', jobId: 'job-a', previousRecoveryPoint: { id: 'rp-full', chainRootId: 'rp-full', sourceId: 'source-postgresql', jobId: 'job-a', type: 'full' }
  });
  assert.equal(prepared.databaseManifest.kind, 'postgresql-wal');
  assert.equal(prepared.databaseManifest.artifact.kind, 'transaction-log');
  assert.equal(prepared.databaseManifest.wal.firstSegment, '000000010000000000000004');
  assert.equal(prepared.databaseManifest.wal.lastSegment, '000000010000000000000005');
  assert.deepEqual(prepared.databaseManifest.chain, { chainRootRecoveryPointId: 'rp-full', parentRecoveryPointId: 'rp-full' });
  assert.match(session.uploads.at(-1).content, /000000010000000000000004/);
  assert.equal(session.commands.some((command) => command.includes("'pg_waldump' '--quiet'")), true);
  await service.release(prepared);
});

test('physical service refuses a paired SSH host that reaches a different PostgreSQL cluster', async () => {
  const session = new FakePostgresqlPhysicalSession({ systemIdentifier: '7420000000000000999' });
  const service = new PostgresqlPhysicalBackupService(dependencies(session));
  await assert.rejects(service.prepare('workspace-a', 'run-mismatch', physicalPlan(), { backupMode: 'full', jobId: 'job-a' }), (error) => error.code === 'POSTGRESQL_PHYSICAL_CLUSTER_PAIR_MISMATCH');
  assert.equal(session.closed, true);
  assert.equal(session.commands.some((command) => command.includes("'rm' '-rf' '--' '/var/tmp/deployerx-postgresql-run-1.ABC123'")), true);
});
