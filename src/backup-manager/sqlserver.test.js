const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('stream');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  SqlServerNativeAdapter,
  normalizeConfig,
  parseJsonResult,
  parseServerVersion
} = require('./sqlserver');
const {
  SqlServerPhysicalBackupService,
  backupStatement,
  normalizeHeader,
  parseSqlcmdVersion,
  selectedDatabase,
  sqlUnicodeLiteral,
  validateHeader
} = require('./sqlserver-physical');
const {
  DAMAGED_TAIL_CONFIRMATION,
  RESTORE_CONFIRMATIONS,
  SqlServerRestoreService,
  TAIL_CONFIRMATION,
  deepValidationQuery,
  fileListQuery,
  normalizeRequest,
  parseFileList,
  relocationPlan,
  restoreStatement,
  validateChain
} = require('./sqlserver-restore');

const PASSWORD = 'sqlserver-password-value';
const INSTANCE_FINGERPRINT = 'sha256:acc1812cb830362e0daa01b20969efa7c7eb36f9e57de86694126da35f471288';

function identity(overrides = {}) {
  return {
    serverName: 'sql01', machineName: 'sql01', instanceName: null, productVersion: '16.0.4175.1', edition: 'Developer Edition', engineEdition: 3,
    hostPlatform: 'Linux', isSysadmin: 1, ...overrides
  };
}

function preflight(overrides = {}) {
  return {
    ...identity(), databaseName: 'orders', databaseState: 'ONLINE', recoveryModel: 'FULL', compatibilityLevel: 160,
    isReadOnly: false, isSnapshot: false, databaseGuid: '11111111-1111-1111-1111-111111111111', familyGuid: '22222222-2222-2222-2222-222222222222',
    inAvailabilityGroup: false, tdeThumbprint: null, ...overrides
  };
}

function header(type = 'full', overrides = {}) {
  const code = { full: 'D', differential: 'I', log: 'L' }[type];
  return {
    databaseName: 'orders', backupTypeCode: code, backupStartTime: '2026-08-04T10:00:00', backupFinishTime: `2026-08-04T10:0${type === 'full' ? 1 : type === 'differential' ? 2 : 3}:00`,
    firstLsn: '10000000001000001', lastLsn: '10000000002000001', checkpointLsn: '10000000001500001', databaseBackupLsn: '10000000001000001',
    differentialBaseLsn: type === 'differential' ? '10000000001000001' : null,
    differentialBaseGuid: type === 'differential' ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : null,
    backupSetGuid: type === 'full' ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : type === 'differential' ? 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' : 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    familyGuid: '22222222-2222-2222-2222-222222222222', firstRecoveryForkId: '33333333-3333-3333-3333-333333333333', recoveryForkId: '33333333-3333-3333-3333-333333333333',
    forkPointLsn: null, recoveryModel: 'FULL', hasBackupChecksums: true, beginsLogChain: false, isCopyOnly: false, hasBulkLoggedData: false, hasIncompleteMetadata: false, isDamaged: false,
    position: 1, serverName: 'sql01', machineName: 'sql01', databaseVersion: 957, compatibilityLevel: 160, softwareMajorVersion: 16, softwareMinorVersion: 0, softwareBuildVersion: 4175,
    mediaFamilyId: '44444444-4444-4444-4444-444444444444', physicalDeviceName: `/var/opt/mssql/backup/test.${type === 'log' ? 'trn' : 'bak'}`, ...overrides
  };
}

class Runner {
  constructor() { this.calls = []; }
  async run(input) {
    this.calls.push(input);
    if (input.args.at(-1).includes('sys.dm_os_host_info')) return { stdout: JSON.stringify(identity()), stderr: '', exitCode: 0 };
    if (input.args.at(-1).includes('FROM sys.databases')) return { stdout: JSON.stringify([{ name: 'orders', state: 'ONLINE', recoveryModel: 'FULL', compatibilityLevel: 160, databaseGuid: null, isReadOnly: false, isSnapshot: false }]), stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

test('SQL Server adapter normalizes a verified-TLS SecretRef connection and registers native capabilities', () => {
  const adapter = new SqlServerNativeAdapter({ processRunner: new Runner() });
  const manifest = new DatabaseAdapterRegistry([adapter]).manifest(ADAPTER_ID);
  assert.deepEqual(manifest.capabilities.backupModes, ['differential', 'full', 'incremental']);
  assert.equal(manifest.capabilities.consistencyStrategies[0].id, 'sql-server-native-backup');
  assert.deepEqual(normalizeConfig({ host: 'SQL.EXAMPLE.COM.', username: 'backup', passwordSecretRefId: 'sec_12345678' }), {
    host: 'sql.example.com', port: 1433, username: 'backup', passwordSecretRefId: 'sec_12345678', tlsMode: 'verify-identity', timeoutMs: 30000, sqlcmdExecutable: 'sqlcmd'
  });
  assert.throws(() => normalizeConfig({ host: 'sql.example.com', username: 'backup', passwordSecretRefId: 'sec_12345678', tlsMode: 'required' }), /certificate identity verification/);
  assert.equal(parseServerVersion('15.0.4435.7').major, 15);
  assert.equal(parseServerVersion('17.0.1000.7').major, 17);
  assert.throws(() => parseServerVersion('14.0.1'), (error) => error.code === 'SQLSERVER_VERSION_UNSUPPORTED');
  assert.equal(parseSqlcmdVersion('Version 18.4.0001.1 Linux').major, 18);
});

test('SQL Server connection tests isolate passwords in the process environment and discover safe user databases', async () => {
  const runner = new Runner();
  const adapter = new SqlServerNativeAdapter({ processRunner: runner, now: () => 1000, clock: () => '2026-08-04T10:00:00.000Z' });
  const config = { host: 'sql01', port: 1433, username: 'backup', passwordSecretRefId: 'sec_12345678', tlsMode: 'verify-identity' };
  const result = await adapter.testConnection({ resolveSecret: async () => PASSWORD }, config);
  assert.equal(result.status, 'success');
  assert.equal(result.remotePlatform.platform, 'linux');
  assert.equal(result.endpointIdentity.instanceFingerprint, INSTANCE_FINGERPRINT);
  const pages = [];
  for await (const page of adapter.discover({ resolveSecret: async () => PASSWORD }, { connection: config })) pages.push(page);
  assert.equal(pages[0].items[0].name, 'orders');
  assert.equal(runner.calls.every((call) => !call.args.some((argument) => argument.includes(PASSWORD))), true);
  assert.equal(runner.calls.every((call) => call.env.SQLCMDPASSWORD === PASSWORD), true);
});

test('SQL Server parsing and generated backup SQL preserve identifiers without interpolation', () => {
  const literal = sqlUnicodeLiteral("sales]; DROP DATABASE master;--");
  assert.match(literal, /^CONVERT\(nvarchar\(max\), 0x[0-9A-F]+\)$/);
  const sql = backupStatement("sales]; DROP DATABASE master;--", '/var/opt/mssql/backup/owned.bak', 'differential');
  assert.doesNotMatch(sql, /sales]; DROP/);
  assert.match(sql, /QUOTENAME\(@db\)/);
  assert.match(sql, /DIFFERENTIAL/);
  assert.deepEqual(parseJsonResult('\n[{"name":"orders"}]\n'), [{ name: 'orders' }]);
  assert.equal(selectedDatabase({ kind: 'database-objects', allDatabases: false, databases: { include: [{ name: 'orders' }], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false }), 'orders');
});

test('SQL Server headers authenticate differential bases and recovery forks', () => {
  const full = normalizeHeader(header('full'));
  const differential = normalizeHeader(header('differential'));
  validateHeader(full, { type: 'full', database: 'orders', mediaPath: full.physicalDeviceName });
  validateHeader(differential, { type: 'differential', database: 'orders', mediaPath: differential.physicalDeviceName, base: { backup: full } });
  assert.throws(() => validateHeader({ ...differential, differentialBaseGuid: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }, { type: 'differential', database: 'orders', mediaPath: differential.physicalDeviceName, base: { backup: full } }), (error) => error.code === 'SQLSERVER_DIFFERENTIAL_BASE_MISMATCH');
  const log = normalizeHeader(header('log'));
  assert.throws(() => validateHeader({ ...log, firstRecoveryForkId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', recoveryForkId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }, { type: 'log', database: 'orders', mediaPath: log.physicalDeviceName, previous: { backup: full } }), (error) => error.code === 'SQLSERVER_LOG_RECOVERY_FORK_MISMATCH');
  assert.throws(() => validateHeader({ ...log, isDamaged: true, hasIncompleteMetadata: true }, { type: 'log', database: 'orders', mediaPath: log.physicalDeviceName, previous: { backup: full } }), (error) => error.code === 'SQLSERVER_BACKUP_HEADER_UNSAFE');
  assert.doesNotThrow(() => validateHeader({ ...log, isDamaged: true, hasIncompleteMetadata: true }, { type: 'log', database: 'orders', mediaPath: log.physicalDeviceName, previous: { backup: full }, allowDamaged: true, allowIncompleteMetadata: true }));
});

class PhysicalSession {
  constructor(type = 'full') { this.type = type; this.commands = []; this.uploads = []; this.closed = false; this.mediaPath = null; }
  async run(command) {
    this.commands.push(command);
    if (command.includes("'mktemp'")) return { stdout: '/var/tmp/deployerx-sqlserver-run.ABC123\n', stderr: '', exitCode: 0 };
    if (command.includes("'sqlcmd' '-?'")) return { stdout: 'Version 18.4.0001.1 Linux\n', stderr: '', exitCode: 0 };
    if (command.includes('sys.availability_databases_cluster')) return { stdout: JSON.stringify(preflight()), stderr: '', exitCode: 0 };
    if (command.includes('BACKUP DATABASE') || command.includes('BACKUP LOG')) {
      const encoded = [...command.matchAll(/0x([0-9A-F]+)/g)].at(-1)[1];
      this.mediaPath = Buffer.from(encoded, 'hex').toString('utf16le');
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command.includes('msdb.dbo.backupset')) return { stdout: JSON.stringify(header(this.type, { physicalDeviceName: this.mediaPath })), stderr: '', exitCode: 0 };
    if (command.includes("'stat'")) return { stdout: '20', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  async writeFile(remotePath, content, options) { this.uploads.push({ remotePath, content: String(content), options }); }
  async stream(command) { this.commands.push(command); return { stdout: Readable.from([Buffer.from('12345678901234567890')]), completion: Promise.resolve({ exitCode: 0, stderr: '' }), close() {} }; }
  close() { this.closed = true; }
}

function plan() {
  const empty = { include: [], exclude: [] };
  return {
    source: { id: 'source-sql', adapterId: ADAPTER_ID, selector: { kind: 'database-objects', allDatabases: false, databases: { include: [{ name: 'orders' }], exclude: [] }, schemas: empty, tables: empty, includeGlobalObjects: false, digest: 'selection' }, consistency: { backupMethod: 'physical' }, physicalExecution: { engine: 'sqlserver', sshConnectionId: 'ssh-1', remoteTemporaryDirectory: '/var/tmp', backupDirectory: '/var/opt/mssql/backup', dataDirectory: '/var/opt/mssql/data', logDirectory: '/var/opt/mssql/data', privilegeMode: 'sudo-noninteractive', sqlcmdExecutable: 'sqlcmd', statExecutable: 'stat', ddExecutable: 'dd', rmExecutable: 'rm' } },
    connection: { id: 'sql-1', revision: 2, secretRefIds: ['sec_sqlpass'], trust: { fingerprint: INSTANCE_FINGERPRINT }, lastTest: { endpointIdentity: { instanceFingerprint: INSTANCE_FINGERPRINT } } },
    executionConnection: { id: 'ssh-1', revision: 3 },
    connectionConfig: { host: 'sql01', port: 1433, username: 'backup', passwordSecretRefId: 'sec_sqlpass', tlsMode: 'verify-identity', timeoutMs: 30000, sqlcmdExecutable: 'sqlcmd' },
    manifest: { adapterVersion: '1.0.0' }
  };
}

function dependencies(session, artifacts = []) {
  const ssh = { id: 'ssh-1', adapterId: 'deployerx.connection.ssh', endpoint: { host: 'sql01', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 }, secretRefIds: ['sec_sshkey'], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' }, workerAffinity: ['device:device-a'], lastTest: { status: 'success' } };
  return { controlDatabase: { repository: (name) => ({ get: async () => name === 'connection' ? ssh : null, list: async () => name === 'artifact' ? artifacts : [] }) }, secretStore: { resolve: async ({ id }) => id === 'sec_sqlpass' ? PASSWORD : 'ssh-key' }, deviceId: 'device-a', sessionFactory: async () => session };
}

function priorArtifact(type, recoveryPointId) {
  const backup = normalizeHeader(header(type));
  return { kind: type === 'log' ? 'transaction-log' : 'physical-backup', recoveryPointId, metadata: { kind: 'sqlserver-native', source: { sourceId: 'source-sql', jobId: 'job-a' }, server: { instanceFingerprint: INSTANCE_FINGERPRINT }, database: { name: 'orders', databaseGuid: '11111111-1111-1111-1111-111111111111', familyGuid: '22222222-2222-2222-2222-222222222222' }, backup } };
}

test('SQL Server full backup verifies native media, streams exact bytes, and removes secrets and media', async () => {
  const session = new PhysicalSession('full');
  const service = new SqlServerPhysicalBackupService(dependencies(session));
  const prepared = await service.prepare('workspace-a', 'run-a', plan(), { backupMode: 'full', jobId: 'job-a' });
  assert.equal(prepared.databaseManifest.backup.type, 'full');
  assert.equal(prepared.databaseManifest.artifact.kind, 'physical-backup');
  assert.equal(session.commands.some((command) => command.includes('RESTORE HEADERONLY')), true);
  assert.equal(session.commands.some((command) => command.includes('RESTORE FILELISTONLY')), true);
  assert.equal(session.commands.some((command) => command.includes('RESTORE VERIFYONLY') && command.includes('CHECKSUM')), true);
  assert.equal(session.commands.every((command) => !command.includes(PASSWORD)), true);
  assert.equal(session.uploads.find((upload) => upload.remotePath.endsWith('sqlcmd-password')).content, `${PASSWORD}\n`);
  const chunks = [];
  for await (const chunk of prepared.content()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).length, 20);
  await service.release(prepared);
  assert.equal(session.closed, true);
  assert.equal(session.commands.some((command) => command.includes("'rm' '-f'") && command.includes('.bak')), true);
});

test('SQL Server differential and log backups require and preserve authenticated parents', async () => {
  const full = priorArtifact('full', 'rp-full');
  const differentialSession = new PhysicalSession('differential');
  const differentialService = new SqlServerPhysicalBackupService(dependencies(differentialSession, [full]));
  const differential = await differentialService.prepare('workspace-a', 'run-diff', plan(), { backupMode: 'differential', jobId: 'job-a' });
  assert.equal(differential.databaseManifest.chain.fullBaseRecoveryPointId, 'rp-full');
  assert.equal(differential.databaseManifest.chain.parentRecoveryPointId, 'rp-full');
  await differentialService.release(differential);
  const logSession = new PhysicalSession('log');
  const logService = new SqlServerPhysicalBackupService(dependencies(logSession, [full]));
  const log = await logService.prepare('workspace-a', 'run-log', plan(), { backupMode: 'incremental', jobId: 'job-a' });
  assert.equal(log.databaseManifest.backup.type, 'log');
  assert.equal(log.databaseManifest.artifact.kind, 'transaction-log');
  assert.equal(log.databaseManifest.chain.chainRootRecoveryPointId, 'rp-full');
  assert.equal(logSession.commands.some((command) => command.includes('BACKUP LOG')), true);
  await logService.release(log);
  await assert.rejects(new SqlServerPhysicalBackupService(dependencies(new PhysicalSession('differential'))).prepare('workspace-a', 'run-no-base', plan(), { backupMode: 'differential', jobId: 'job-a' }), (error) => error.code === 'SQLSERVER_DIFFERENTIAL_BASE_REQUIRED');
});

function point(id, type, parent = null, root = 'rp-full') {
  return { id, type, parentRecoveryPointId: parent, chainRootId: root, sourceId: 'source-sql', jobId: 'job-a' };
}

function chainMetadata(type, overrides = {}) {
  const backup = normalizeHeader(header(type, overrides.backup));
  return { kind: 'sqlserver-native', server: { instanceFingerprint: INSTANCE_FINGERPRINT, major: 16 }, database: { name: 'orders', databaseGuid: '11111111-1111-1111-1111-111111111111', familyGuid: '22222222-2222-2222-2222-222222222222', recoveryModel: 'FULL' }, source: { sourceId: 'source-sql', jobId: 'job-a' }, backup, ...overrides.metadata };
}

test('SQL Server restore chains authenticate differential bases and overlapping log ranges', () => {
  const fullPoint = point('rp-full', 'full');
  const differentialPoint = point('rp-diff', 'differential', 'rp-full');
  const full = chainMetadata('full');
  const differential = chainMetadata('differential');
  const differentialChain = validateChain([fullPoint, differentialPoint], new Map([['rp-full', full], ['rp-diff', differential]]), 'rp-diff');
  assert.deepEqual(differentialChain.chain.map((item) => item.id), ['rp-full', 'rp-diff']);

  const firstLogPoint = point('rp-log-1', 'log', 'rp-full');
  const secondLogPoint = point('rp-log-2', 'log', 'rp-log-1');
  const firstLog = chainMetadata('log', { backup: { firstLsn: '100', lastLsn: '200', backupStartTime: '2026-08-04T10:02:00Z', backupFinishTime: '2026-08-04T10:03:00Z' } });
  const secondLog = chainMetadata('log', { backup: { firstLsn: '190', lastLsn: '300', backupStartTime: '2026-08-04T10:03:00Z', backupFinishTime: '2026-08-04T10:04:00Z' } });
  const logChain = validateChain([fullPoint, firstLogPoint, secondLogPoint], new Map([['rp-full', full], ['rp-log-1', firstLog], ['rp-log-2', secondLog]]), 'rp-log-2', { type: 'time', value: '2026-08-04T10:03:30.000Z' });
  assert.deepEqual(logChain.chain.map((item) => item.id), ['rp-full', 'rp-log-1', 'rp-log-2']);
  assert.throws(() => validateChain([fullPoint, firstLogPoint, secondLogPoint], new Map([['rp-full', full], ['rp-log-1', firstLog], ['rp-log-2', chainMetadata('log', { backup: { firstLsn: '250', lastLsn: '350' } })]]), 'rp-log-2'), (error) => error.code === 'SQLSERVER_CHAIN_LOG_GAP');
  assert.throws(() => validateChain([fullPoint, firstLogPoint], new Map([['rp-full', full], ['rp-log-1', chainMetadata('log', { backup: { firstLsn: '100', lastLsn: '200', hasBulkLoggedData: true, backupStartTime: '2026-08-04T10:02:00Z', backupFinishTime: '2026-08-04T10:03:00Z' } })]]), 'rp-log-1', { type: 'time', value: '2026-08-04T10:02:30.000Z' }), (error) => error.code === 'SQLSERVER_STOPAT_BULK_LOGGED_UNSUPPORTED');
});

test('SQL Server restore plans relocate only data and log files beneath approved roots', () => {
  const files = parseFileList(JSON.stringify([
    { logicalName: "orders'data", type: 'D', fileId: 1, uniqueId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sizeBytes: '1024' },
    { logicalName: 'orders_log', type: 'L', fileId: 2, uniqueId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', sizeBytes: '512' }
  ]));
  const moves = relocationPlan(files, { dataDirectory: '/var/opt/mssql/data', logDirectory: '/var/opt/mssql/log' }, 'restore-a');
  assert.match(moves[0].targetPath, /^\/var\/opt\/mssql\/data\/deployerx-[a-f0-9]{20}-d0[.]mdf$/);
  assert.match(moves[1].targetPath, /^\/var\/opt\/mssql\/log\/deployerx-[a-f0-9]{20}-l0[.]ldf$/);
  const query = fileListQuery('/var/opt/mssql/backup/restore.bak', 1);
  assert.match(query, /RESTORE FILELISTONLY/);
  const sql = restoreStatement("orders]; DROP DATABASE master;--", '/var/opt/mssql/backup/restore.bak', normalizeHeader(header('full', { physicalDeviceName: '/var/opt/mssql/backup/restore.bak' })), { moves, recovery: false });
  assert.doesNotMatch(sql, /orders]; DROP/);
  assert.match(sql, /MOVE/);
  assert.match(sql, /NORECOVERY/);
  const check = deepValidationQuery("orders]; DROP DATABASE master;--");
  assert.doesNotMatch(check, /orders]; DROP/);
  assert.match(check, /QUOTENAME\(@db\)/);
  assert.match(check, /DBCC CHECKDB/);
  assert.throws(() => parseFileList(JSON.stringify([{ logicalName: 'stream', type: 'S', fileId: 1, uniqueId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sizeBytes: '1' }])), (error) => error.code === 'SQLSERVER_FILELIST_UNSUPPORTED');
});

test('SQL Server original restore requires independent tail and damaged-media confirmations', () => {
  const base = { recoveryPointId: 'rp-full', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original, tailMode: 'online', tailConfirmed: true, tailConfirmationText: TAIL_CONFIRMATION };
  assert.equal(normalizeRequest(base).tailMode, 'online');
  assert.throws(() => normalizeRequest({ ...base, tailConfirmed: false }), (error) => error.code === 'SQLSERVER_TAIL_CONFIRMATION_REQUIRED');
  assert.equal(normalizeRequest({ ...base, tailMode: 'damaged', damagedTailConfirmed: true, damagedTailConfirmationText: DAMAGED_TAIL_CONFIRMATION }).tailMode, 'damaged');
  assert.throws(() => normalizeRequest({ ...base, tailMode: 'damaged' }), (error) => error.code === 'SQLSERVER_DAMAGED_TAIL_CONFIRMATION_REQUIRED');
});

class TailControlDatabase {
  constructor(records) {
    this.records = Object.fromEntries(Object.entries(records).map(([type, values]) => [type, new Map(values.map((value) => [value.id, structuredClone(value)]))]));
    this.sequence = 0;
  }

  map(type) { return this.records[type] || (this.records[type] = new Map()); }

  repository(type) {
    const records = this.map(type);
    return { get: async (_workspaceId, id) => records.get(id) || null, list: async () => [...records.values()] };
  }

  async transaction(operation) {
    return operation({
      get: (type, _workspaceId, id) => this.map(type).get(id) || null,
      create: (type, value) => {
        const created = { ...structuredClone(value), id: value.id || `${type}-${++this.sequence}`, revision: 1 };
        this.map(type).set(created.id, created);
        return created;
      },
      projectExecution: (type, _workspaceId, id, changes) => {
        const current = this.map(type).get(id);
        const updated = { ...current, ...structuredClone(changes), revision: current.revision + 1 };
        this.map(type).set(id, updated);
        return updated;
      }
    });
  }
}

test('SQL Server tail publication uses a repository mutation lock and a dedicated execution run', async () => {
  const selectedPoint = {
    id: 'rp-full', jobId: 'job-a', sourceId: 'source-sql', runId: 'run-parent', type: 'full', chainRootId: 'rp-full', parentRecoveryPointId: null,
    repositoryCopies: [{ repositoryId: 'repo-a', engineSnapshotId: 'snapshot-full', state: 'available' }], retention: { ruleMatches: ['last-n'] }
  };
  const controlDatabase = new TailControlDatabase({
    run: [{ id: 'run-parent', revision: 1, jobId: 'job-a', jobRevision: 3, configSnapshot: { source: { id: 'source-sql' } }, planDigest: 'plan-parent', state: 'succeeded' }],
    executionGroup: [], recoveryPoint: [selectedPoint], artifact: [],
    restoreRun: [{ id: 'restore-a', revision: 1, state: 'preparing', recoveryPointIds: ['rp-full'], target: { operation: 'sqlserver-native' } }]
  });
  const locks = [];
  const releasedLocks = [];
  let releasedPrepared = false;
  const digest = 'a'.repeat(64);
  const prepared = {
    artifactPath: 'sqlserver/orders/tail.trn', sizeBytes: 4,
    databaseManifest: {
      kind: 'sqlserver-native', backupMode: 'tail-log',
      backup: { type: 'log', backupStartTime: '2026-08-04T12:00:00.000Z', backupFinishTime: '2026-08-04T12:00:01.000Z', firstLsn: '190', lastLsn: '300', recoveryForkId: 'fork-a' },
      chain: { chainRootRecoveryPointId: 'rp-full', parentRecoveryPointId: 'rp-full' }
    },
    content: async function* () { yield Buffer.from('tail'); }
  };
  const repository = {
    masterKey: Buffer.alloc(32, 1), keyVersion: 'key-1',
    adapter: {
      acquireLock: async (_context, input) => { locks.push(input); return { lockId: 'lock-a' }; },
      releaseLock: async (_context, lease) => { releasedLocks.push(lease); },
      stat: async () => ({ sizeBytes: 100 })
    },
    engine: {
      createSnapshot: async (_context, input) => {
        const files = [];
        for await (const file of input.files) {
          const chunks = [];
          for await (const chunk of file.content) chunks.push(Buffer.from(chunk));
          assert.equal(Buffer.concat(chunks).toString(), 'tail');
          files.push(file);
        }
        return { snapshotId: 'snapshot-tail', manifestKey: 'manifests/tail', manifestChecksum: { algorithm: 'sha256', digest }, keyVersion: 'key-1' };
      },
      openSnapshot: async () => ({ manifest: { files: [{ path: prepared.artifactPath, type: 'file', sizeBytes: 4, contentDigest: { algorithm: 'sha256', digest } }] } })
    }
  };
  const service = new SqlServerRestoreService({
    controlDatabase, secretStore: {}, deviceId: 'device-a', adapter: {}, openRepository: async () => repository,
    physicalBackupService: { prepare: async () => prepared, release: async () => { releasedPrepared = true; } },
    clock: () => '2026-08-04T12:00:02.000Z'
  });
  const point = await service.publishTail('workspace-a', 'tester', 'restore-a', selectedPoint, { id: 'source-sql' }, {}, { tailMode: 'online' });
  assert.notEqual(point.runId, selectedPoint.runId);
  assert.equal(controlDatabase.map('run').get(point.runId).state, 'succeeded');
  assert.equal(controlDatabase.map('executionGroup').get(controlDatabase.map('run').get(point.runId).executionGroupId).state, 'succeeded');
  assert.equal(locks.length, 1);
  assert.equal(locks[0].scope, 'repository:repo-a:mutation');
  assert.equal(locks[0].runId, point.runId);
  assert.equal(releasedLocks.length, 1);
  assert.equal(releasedPrepared, true);
  assert.equal(controlDatabase.map('restoreRun').get('restore-a').target.tailRecoveryPointId, point.id);
});

test('SQL Server native restore authenticates, relocates, restores, and validates a full backup', async () => {
  const fullMetadata = chainMetadata('full');
  fullMetadata.artifact = { kind: 'physical-backup', path: 'sqlserver/orders/full.bak', sizeBytes: 12 };
  const recoveryPoint = { ...point('rp-full', 'full'), runId: 'run-parent', repositoryCopies: [{ repositoryId: 'repo-a', engineSnapshotId: 'snapshot-full', state: 'available' }] };
  const physicalExecution = { engine: 'sqlserver', sshConnectionId: 'ssh-target', remoteTemporaryDirectory: '/var/tmp', backupDirectory: '/var/opt/mssql/backup', dataDirectory: '/var/opt/mssql/data', logDirectory: '/var/opt/mssql/log', privilegeMode: 'sudo-noninteractive', sqlcmdExecutable: 'sqlcmd', statExecutable: 'stat', ddExecutable: 'dd', rmExecutable: 'rm' };
  const source = { id: 'source-sql', sourceType: 'database', adapterId: ADAPTER_ID, connectionId: 'sql-source', consistency: { backupMethod: 'physical' }, physicalExecution: { ...physicalExecution, sshConnectionId: 'ssh-source' } };
  const targetSource = { id: 'source-target', sourceType: 'database', adapterId: ADAPTER_ID, connectionId: 'sql-target', consistency: { backupMethod: 'physical' }, physicalExecution };
  const connection = (id, fingerprint) => ({ id, adapterId: ADAPTER_ID, endpoint: { host: `${id}.example.com`, port: 1433, username: 'backup', tlsMode: 'verify-identity', timeoutMs: 30000, sqlcmdExecutable: 'sqlcmd' }, secretRefIds: [`sec-${id}`], workerAffinity: ['device:device-a'], lastTest: { status: 'success', endpointIdentity: { instanceFingerprint: fingerprint } } });
  const ssh = (id) => ({ id, adapterId: 'deployerx.connection.ssh', endpoint: { host: `${id}.example.com`, port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 }, secretRefIds: [`sec-${id}`], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' }, workerAffinity: ['device:device-a'], lastTest: { status: 'success' } });
  const digest = 'b'.repeat(64);
  const artifact = { id: 'artifact-full', recoveryPointId: recoveryPoint.id, repositoryId: 'repo-a', kind: 'physical-backup', sizeBytes: 12, checksum: { algorithm: 'sha256', digest }, metadata: fullMetadata };
  const controlDatabase = new TailControlDatabase({
    source: [source, targetSource], connection: [connection('sql-source', INSTANCE_FINGERPRINT), connection('sql-target', 'sha256:alternate'), ssh('ssh-source'), ssh('ssh-target')],
    recoveryPoint: [recoveryPoint], artifact: [artifact],
    restoreRun: [{ id: 'restore-full', revision: 1, state: 'queued', recoveryPointIds: [recoveryPoint.id], target: { operation: 'sqlserver-native', mode: 'alternate' }, progress: {} }],
    run: [], executionGroup: []
  });
  const commands = [];
  const consumed = [];
  let closed = false;
  const session = {
    async run(command) {
      commands.push(command);
      if (command.includes("'mktemp'")) return { stdout: '/var/tmp/deployerx-sqlserver-restore-restore-full.ABC123\n', stderr: '', exitCode: 0 };
      if (command.includes('CASE WHEN d.database_id')) return { stdout: JSON.stringify({ productVersion: '16.0.4175.1', databaseExists: false, databaseState: null, inAvailabilityGroup: false, tdeKeyAvailable: true }), stderr: '', exitCode: 0 };
      if (command.includes("'stat'")) return { stdout: '12', stderr: '', exitCode: 0 };
      if (command.includes('CREATE TABLE #files')) return { stdout: JSON.stringify([{ logicalName: 'orders', type: 'D', fileId: 1, uniqueId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sizeBytes: '1024' }, { logicalName: 'orders_log', type: 'L', fileId: 2, uniqueId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', sizeBytes: '512' }]), stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async writeFile() {},
    async consume(command, content) {
      commands.push(command);
      const chunks = [];
      for await (const chunk of content) chunks.push(Buffer.from(chunk));
      consumed.push(Buffer.concat(chunks));
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    close() { closed = true; }
  };
  const repository = {
    masterKey: Buffer.alloc(32, 1),
    engine: {
      openSnapshot: async () => ({ manifest: { files: [{ path: fullMetadata.artifact.path, type: 'file', sizeBytes: 12, contentDigest: { algorithm: 'sha256', digest }, metadata: { database: fullMetadata } }] } }),
      streamFile: () => Readable.from([Buffer.from('backup-bytes')])
    }
  };
  const adapter = {
    normalizeConfig: (value) => value,
    testConnection: async () => ({ status: 'success', endpointIdentity: { instanceFingerprint: 'sha256:alternate' } }),
    runQuery: async () => ({ stdout: JSON.stringify({ name: 'orders_restore', state: 'ONLINE', recoveryModel: 'FULL' }) })
  };
  const service = new SqlServerRestoreService({ controlDatabase, secretStore: { resolve: async () => 'secret' }, deviceId: 'device-a', adapter, openRepository: async () => repository, sessionFactory: async () => session, clock: () => '2026-08-04T12:00:00.000Z' });
  const completed = await service.execute('workspace-a', 'tester', 'restore-full', { recoveryPointId: 'rp-full', mode: 'alternate', targetSourceId: 'source-target', targetDatabase: 'orders_restore', recoveryTarget: { type: 'latest', value: null }, tailMode: 'none', deepValidation: false });
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.result.database, 'orders_restore');
  assert.equal(completed.result.bytesRestored, 12);
  assert.equal(consumed[0].toString(), 'backup-bytes');
  assert.equal(commands.some((command) => command.includes('RESTORE DATABASE') && command.includes('NORECOVERY') === false && command.includes('RECOVERY')), true);
  assert.equal(commands.some((command) => command.includes('MOVE')), true);
  assert.equal(commands.some((command) => command.includes("'rm' '-f'") && command.includes('.bak')), true);
  assert.equal(commands.some((command) => command.includes("'rm' '-rf'") && command.includes('deployerx-sqlserver-restore-')), true);
  assert.equal(closed, true);
});
