const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const { ADAPTER_ID } = require('./postgresql-logical');
const { PostgresqlPitrRestoreService, RESTORE_CONFIRMATIONS, normalizeRequest, recoveryConfiguration, validateChain, validateTarListing } = require('./postgresql-pitr-restore');

const SEGMENT_SIZE = 16 * 1024 * 1024;

function point(id, type, parentRecoveryPointId, chainRootId = 'rp-full') { return { id, type, parentRecoveryPointId, chainRootId, sourceId: 'source-a', jobId: 'job-a' }; }

function baseMetadata() {
  return { kind: 'postgresql-basebackup', server: { systemIdentifier: '7420000000000000001', major: 16 }, source: { sourceId: 'source-a', jobId: 'job-a' }, wal: { timeline: 1, endSegment: '000000010000000000000003', lastSegment: '000000010000000000000003', segmentSizeBytes: SEGMENT_SIZE }, artifact: { kind: 'physical-backup', path: 'postgresql-physical/base.tar' } };
}

function walMetadata() {
  return { kind: 'postgresql-wal', server: { systemIdentifier: '7420000000000000001', major: 16 }, source: { sourceId: 'source-a', jobId: 'job-a' }, wal: { timeline: 1, firstSegment: '000000010000000000000004', lastSegment: '000000010000000000000005', segmentSizeBytes: SEGMENT_SIZE, files: [{ name: '000000010000000000000004', sizeBytes: SEGMENT_SIZE, kind: 'segment' }, { name: '000000010000000000000005', sizeBytes: SEGMENT_SIZE, kind: 'segment' }] }, artifact: { kind: 'transaction-log', path: 'postgresql-wal/4-5.tar' } };
}

test('PITR requests require exact confirmation and one normalized recovery target', () => {
  assert.equal(normalizeRequest({ recoveryPointId: 'rp', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original, recoveryTarget: { type: 'time', value: '2026-08-04T10:30:00+05:30' } }).recoveryTarget.value, '2026-08-04T05:00:00.000Z');
  assert.equal(normalizeRequest({ recoveryPointId: 'rp', mode: 'alternate', targetSourceId: 'source-b', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate, recoveryTarget: { type: 'lsn', value: '0/40000a0', inclusive: false, timeline: '1' } }).recoveryTarget.inclusive, false);
  assert.throws(() => normalizeRequest({ recoveryPointId: 'rp', mode: 'original', confirmed: true, confirmationText: 'RESTORE POSTGRESQL', recoveryTarget: {} }), (error) => error.code === 'POSTGRESQL_PITR_CONFIRMATION_REQUIRED');
  assert.throws(() => normalizeRequest({ recoveryPointId: 'rp', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original, recoveryTarget: { type: 'time', value: '2026-08-04 10:30:00' } }), (error) => error.code === 'POSTGRESQL_PITR_TIME_INVALID');
});

test('PITR chain authenticates one full anchor and exact WAL continuity', () => {
  const points = [point('rp-full', 'full', null), point('rp-log', 'log', 'rp-full')];
  const metadata = new Map([['rp-full', baseMetadata()], ['rp-log', walMetadata()]]);
  const chain = validateChain(points, metadata, 'rp-log');
  assert.deepEqual(chain.chain.map((item) => item.id), ['rp-full', 'rp-log']);
  assert.equal(chain.lastSegment, '000000010000000000000005');
  metadata.get('rp-log').wal.firstSegment = '000000010000000000000006';
  assert.throws(() => validateChain(points, metadata, 'rp-log'), (error) => error.code === 'POSTGRESQL_PITR_WAL_GAP');
});

test('recovery configuration maps targets without accepting arbitrary configuration text', () => {
  const configuration = recoveryConfiguration({ type: 'lsn', value: '0/40000A0', inclusive: false, timeline: 'latest' }, '/var/tmp/deployerx-postgresql-restore-1/wal', 16, true);
  assert.match(configuration, /recovery_target_lsn = '0\/40000A0'/);
  assert.match(configuration, /recovery_target_inclusive = off/);
  assert.match(configuration, /recovery_target_action = 'promote'/);
  assert.match(configuration, /archive_command = ''/);
  assert.equal(configuration.includes('archive_library'), true);
});

test('tar listing validation refuses traversal, links, missing WAL, and duplicates', () => {
  assert.equal(validateTarListing('-rw------- user/group 10 2026-08-04 00:00 ./PG_VERSION\ndrwx------ user/group 0 2026-08-04 00:00 ./base/', 'base'), true);
  assert.throws(() => validateTarListing('lrwxrwxrwx user/group 0 2026-08-04 00:00 ./escape -> /etc', 'base'), (error) => error.code === 'POSTGRESQL_PITR_ARCHIVE_UNSAFE');
  const names = ['000000010000000000000004', '000000010000000000000005'];
  const listing = names.map((name) => `-rw------- user/group 16777216 2026-08-04 00:00 ${name}`).join('\n');
  assert.equal(validateTarListing(listing, 'wal', names), true);
  assert.throws(() => validateTarListing(`${listing}\n${listing.split('\n')[0]}`, 'wal', names), (error) => error.code === 'POSTGRESQL_PITR_WAL_ARCHIVE_INVALID');
});

class MemoryControlDatabase {
  constructor(records) { this.records = Object.fromEntries(Object.entries(records).map(([name, values]) => [name, new Map(values.map((value) => [value.id, { ...value }]))])); }
  repository(name) { const records = this.records[name] || (this.records[name] = new Map()); return { get: async (_workspaceId, id) => records.get(id) || null, list: async () => [...records.values()], create: async (value) => { const created = { ...value, id: value.id || `restore-${records.size + 1}`, revision: 1 }; records.set(created.id, created); return created; } }; }
  async transaction(operation) { return operation({ get: (name, _workspaceId, id) => this.records[name].get(id), projectExecution: (name, _workspaceId, id, changes) => { const current = this.records[name].get(id); const updated = { ...current, ...changes, revision: current.revision + 1 }; this.records[name].set(id, updated); return updated; } }); }
}

class RestoreSession {
  constructor(options = {}) { this.commands = []; this.uploads = []; this.consumed = []; this.closed = false; this.datadirEmpty = options.datadirEmpty !== false; this.serviceChecks = 0; }
  async run(command) {
    this.commands.push(command);
    if (command.includes("'--version'")) { const tool = ['pg_verifybackup', 'pg_waldump', 'psql'].find((name) => command.includes(`'${name}'`)); return { stdout: `${tool} (PostgreSQL) 16.4\n`, stderr: '', exitCode: 0 }; }
    if (command.includes("'mktemp'")) return { stdout: '/var/tmp/deployerx-postgresql-restore-restore-1.ABC123\n', stderr: '', exitCode: 0 };
    if (command.includes("'tar' '--list'")) return { stdout: '-rw------- user/group 2 2026-08-04 00:00 ./PG_VERSION\n-rw------- user/group 200 2026-08-04 00:00 ./backup_manifest\n', stderr: '', exitCode: 0 };
    if (command.includes("'systemctl' 'show'")) { this.serviceChecks += 1; return { stdout: this.serviceChecks === 1 ? 'inactive\n' : 'active\n', stderr: '', exitCode: 0 }; }
    if (command.includes('test -z') && !this.datadirEmpty) throw Object.assign(new Error('not empty'), { code: 'SSH_COMMAND_FAILED' });
    if (command.includes('pg_is_in_recovery')) return { stdout: 'f\t0/40000A0\t2\t7420000000000000001\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  async consume(command, content) { this.commands.push(command); const chunks = []; for await (const chunk of content) chunks.push(Buffer.from(chunk)); this.consumed.push(Buffer.concat(chunks)); return { stdout: '', stderr: '', exitCode: 0 }; }
  async writeFile(remotePath, content, options) { this.uploads.push({ remotePath, content: String(content), options }); }
  close() { this.closed = true; }
}

function fixture(options = {}) {
  const source = { id: 'source-a', sourceType: 'database', adapterId: ADAPTER_ID, connectionId: 'postgresql-a', consistency: { backupMethod: 'physical' }, physicalExecution: { engine: 'postgresql', sshConnectionId: 'ssh-a', remoteTemporaryDirectory: '/var/tmp', dataDirectory: '/var/lib/postgresql/data', walArchiveDirectory: '/var/lib/postgresql/wal-archive', serviceName: 'postgresql', postgresOwner: 'postgres', postgresGroup: 'postgres', privilegeMode: 'sudo-noninteractive', pgVerifybackupExecutable: 'pg_verifybackup', pgWaldumpExecutable: 'pg_waldump', psqlExecutable: 'psql', tarExecutable: 'tar' } };
  const recoveryPoint = { ...point('rp-full', 'full', null), repositoryCopies: [{ repositoryId: 'repo-a', engineSnapshotId: 'snapshot-a', state: 'available' }] };
  const digest = 'a'.repeat(64); const metadata = baseMetadata();
  const artifact = { id: 'artifact-a', kind: 'physical-backup', recoveryPointId: recoveryPoint.id, repositoryId: 'repo-a', sizeBytes: 14, checksum: { algorithm: 'sha256', digest }, metadata };
  const databaseConnection = { id: 'postgresql-a', adapterId: ADAPTER_ID, endpoint: { host: 'db.example.com', port: 5432, username: 'backup', maintenanceDatabase: 'postgres', tlsMode: 'required' }, secretRefIds: ['sec-postgresql'], trust: { fingerprint: 'sha256:postgresql' }, workerAffinity: ['device:device-a'], lastTest: { status: 'success', endpointIdentity: { systemIdentifier: '7420000000000000001' } } };
  const sshConnection = { id: 'ssh-a', adapterId: 'deployerx.connection.ssh', endpoint: { host: 'db.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 }, secretRefIds: ['sec-ssh'], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' }, workerAffinity: ['device:device-a'], lastTest: { status: 'success' } };
  const controlDatabase = new MemoryControlDatabase({ source: [source], connection: [databaseConnection, sshConnection], recoveryPoint: [recoveryPoint], artifact: [artifact], restoreRun: [] });
  const session = new RestoreSession(options);
  const repository = { engine: { openSnapshot: async () => ({ manifest: { files: [{ path: metadata.artifact.path, type: 'file', sizeBytes: 14, contentDigest: { algorithm: 'sha256', digest }, metadata: { artifactKind: 'physical-backup', database: metadata } }] } }), streamFile: () => Readable.from([Buffer.from('physical-bytes')]) }, masterKey: Buffer.alloc(32, 1) };
  const service = new PostgresqlPitrRestoreService({ controlDatabase, secretStore: { resolve: async () => 'secret' }, deviceId: 'device-a', adapter: { normalizeConfig: (config) => ({ timeoutMs: 30000, ...config }) }, openRepository: async () => repository, sessionFactory: async ({ signal }) => { session.signal = signal; return session; }, clock: () => '2026-08-04T12:00:00.000Z', delay: async () => {} });
  return { controlDatabase, service, session };
}

test('physical recovery verifies before stop, requires an empty datadir, promotes, and validates identity', async () => {
  const { service, session } = fixture();
  const started = await service.start('workspace-a', 'tester', { recoveryPointId: 'rp-full', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original, recoveryTarget: { type: 'immediate' } });
  const completed = await service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.result.systemIdentifier, '7420000000000000001');
  assert.equal(completed.result.timeline, 2);
  const index = (fragment) => session.commands.findIndex((command) => command.includes(fragment));
  assert.ok(index("'pg_verifybackup'") < index("'systemctl' 'stop'"));
  assert.ok(index("'systemctl' 'stop'") < index('test -z'));
  assert.ok(index('test -z') < index("'cp' '-a'"));
  assert.ok(index("'touch'") < index("'systemctl' 'start'"));
  assert.equal(session.closed, true);
});

test('physical recovery refuses a non-empty PostgreSQL datadir before copy-back', async () => {
  const { service, session } = fixture({ datadirEmpty: false });
  const started = await service.start('workspace-a', 'tester', { recoveryPointId: 'rp-full', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original, recoveryTarget: { type: 'latest' } });
  const completed = await service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'POSTGRESQL_PITR_DATADIR_NOT_EMPTY');
  assert.equal(session.commands.some((command) => command.includes("'cp' '-a'")), false);
});

test('startup reconciliation fails an abandoned physical restore without changing terminal runs', async () => {
  const { controlDatabase, service } = fixture();
  controlDatabase.records.restoreRun.set('restore-interrupted', {
    id: 'restore-interrupted', revision: 1, state: 'running', target: { engine: 'postgresql', operation: 'postgresql-pitr' }, progress: { phase: 'copy-back' }
  });
  controlDatabase.records.restoreRun.set('restore-complete', {
    id: 'restore-complete', revision: 1, state: 'succeeded', target: { engine: 'postgresql', operation: 'postgresql-pitr' }, result: { completedAt: '2026-08-04T11:00:00.000Z' }
  });

  const reconciled = await service.reconcile('workspace-a');

  assert.deepEqual(reconciled.map((record) => record.id), ['restore-interrupted']);
  assert.equal(reconciled[0].state, 'failed');
  assert.equal(reconciled[0].progress.phase, 'failed');
  assert.equal(reconciled[0].result.error.code, 'POSTGRESQL_PITR_INTERRUPTED');
  assert.match(reconciled[0].result.error.safeMessage, /Inspect the target datadir/);
  assert.equal(controlDatabase.records.restoreRun.get('restore-complete').revision, 1);
  assert.equal(controlDatabase.records.restoreRun.get('restore-complete').state, 'succeeded');
});
