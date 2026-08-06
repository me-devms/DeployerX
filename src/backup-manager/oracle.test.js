const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const {
  ADAPTER_ID,
  OracleConnectionService,
  OracleRmanAdapter,
  databaseFingerprint,
  normalizeConfig,
  parseIdentity,
  parseServerVersion,
  sqlPlusScript,
  tcpsDescriptor,
  validateIdentity
} = require('./oracle');
const {
  OraclePhysicalBackupService,
  backupType,
  parsePieceInventory,
  parseRedoInventory,
  rmanScript,
  selectedDatabase
} = require('./oracle-physical');

const PASSWORD = 'oracle-password-"value';

function identity(overrides = {}) {
  return {
    dbid: '1234567890',
    databaseName: 'ORDERS',
    databaseUniqueName: 'orders_prod',
    databaseRole: 'PRIMARY',
    openMode: 'READ WRITE',
    logMode: 'ARCHIVELOG',
    cdb: true,
    platformName: 'Linux x86 64-bit',
    instanceName: 'orders1',
    hostName: 'ora01.example.com',
    version: '19.24.0.0.0',
    instanceCount: 1,
    incarnation: 7,
    resetlogsChange: '987654321',
    resetlogsTime: '2026-08-04T09:30:00',
    currentScn: '987700000',
    ...overrides
  };
}

function identityOutput(overrides = {}) {
  const value = identity(overrides);
  return [
    'DX_ORACLE_ID', value.dbid, value.databaseName, value.databaseUniqueName, value.databaseRole,
    value.openMode, value.logMode, value.cdb ? 'YES' : 'NO', value.platformName, value.instanceName,
    value.hostName, value.version, String(value.instanceCount), String(value.incarnation), value.resetlogsChange,
    value.resetlogsTime, value.currentScn
  ].join('\x1f');
}

function nativePreflightOutput(overrides = {}) {
  const value = { spfile: 'YES', encryptedTablespaces: '0', asmDatafiles: '0', ...overrides };
  return ['DX_ORACLE_PREFLIGHT', value.spfile, value.encryptedTablespaces, value.asmDatafiles].join('\x1f');
}

function config(overrides = {}) {
  return {
    host: 'ora01.example.com',
    port: 2484,
    serviceName: 'orders.example.com',
    username: 'backup_operator',
    passwordSecretRefId: 'sec_oracle_password',
    tlsMode: 'verify-identity',
    timeoutMs: 30000,
    sqlplusExecutable: 'sqlplus',
    tnsAdminDirectory: null,
    ...overrides
  };
}

class Runner {
  constructor(output = identityOutput()) {
    this.output = output;
    this.calls = [];
  }

  async consume(input) {
    this.calls.push(input);
    return { exitCode: 0, stdout: `${this.output}\n` };
  }
}

test('Oracle adapter registers exact RMAN capabilities and normalizes TCPS-only connections', () => {
  const adapter = new OracleRmanAdapter({ processRunner: new Runner() });
  const manifest = new DatabaseAdapterRegistry([adapter]).manifest(ADAPTER_ID);
  assert.deepEqual(manifest.capabilities.backupModes, ['differential', 'full', 'incremental', 'native']);
  assert.equal(manifest.capabilities.consistencyStrategies[0].id, 'oracle-rman');
  assert.equal(manifest.capabilities.transactionLogs.type, 'oracle-archived-redo-log');
  assert.deepEqual(normalizeConfig({ host: 'ORA01.EXAMPLE.COM.', serviceName: 'orders.example.com', username: 'backup_operator', passwordSecretRefId: 'sec_oracle_password' }), config({ username: 'BACKUP_OPERATOR' }));
  assert.throws(() => normalizeConfig({ host: 'ora01', serviceName: 'orders', username: 'backup', passwordSecretRefId: 'sec', tlsMode: 'required' }), /certificate identity verification/);
  assert.throws(() => normalizeConfig({ host: 'ora01', serviceName: 'orders)(FAILOVER=ON', username: 'backup', passwordSecretRefId: 'sec' }), /service name is invalid/);
  assert.throws(() => normalizeConfig({ host: 'ora01', serviceName: 'orders', username: 'backup', passwordSecretRefId: 'sec', sqlplusExecutable: 'bash' }), /Only the sqlplus executable/);
  assert.match(tcpsDescriptor(config()), /PROTOCOL=TCPS/);
  assert.match(tcpsDescriptor(config()), /SSL_SERVER_DN_MATCH=YES/);
});

test('Oracle SQL*Plus execution keeps credentials out of arguments and environment', async () => {
  const runner = new Runner();
  const adapter = new OracleRmanAdapter({ processRunner: runner, now: () => 1000, clock: () => '2026-08-04T10:00:00.000Z' });
  const result = await adapter.testConnection({ resolveSecret: async () => PASSWORD }, config());
  assert.equal(result.status, 'success');
  assert.equal(result.remotePlatform.platform, 'linux');
  assert.equal(result.endpointIdentity.dbid, '1234567890');
  assert.equal(result.endpointIdentity.incarnation, 7);
  assert.equal(result.endpointIdentity.databaseFingerprint, databaseFingerprint(identity()));
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0].args, ['-L', '-S', '/nolog']);
  assert.equal(Object.values(runner.calls[0].env).some((value) => String(value).includes(PASSWORD)), false);
  assert.equal(runner.calls[0].args.some((value) => value.includes(PASSWORD)), false);
  assert.match(runner.calls[0].stdin.toString('utf8'), /AS SYSBACKUP/);
  assert.match(runner.calls[0].stdin.toString('utf8'), /oracle-password-""value/);
  assert.doesNotThrow(() => sqlPlusScript(config(), PASSWORD, 'SELECT 1 FROM dual;'));
});

test('Oracle identity parsing preserves DBID, incarnation, and SCN values as authenticated coordinates', () => {
  const parsed = parseIdentity(`SQL*Plus banner\n${identityOutput()}\n`);
  assert.deepEqual(parsed, identity());
  assert.equal(parseServerVersion('21.12.0.0.0').major, 21);
  assert.equal(parseServerVersion('23.5.0.24.7').major, 23);
  assert.throws(() => parseServerVersion('18.0.0.0.0'), (error) => error.code === 'ORACLE_VERSION_UNSUPPORTED');
  assert.throws(() => parseIdentity(identityOutput({ currentScn: '9.5' })), (error) => error.code === 'ORACLE_IDENTITY_INVALID');
});

test('Oracle compatibility gates fail closed for standby, NOARCHIVELOG, RAC, and non-Linux databases', async () => {
  assert.throws(() => validateIdentity(identity({ databaseRole: 'PHYSICAL STANDBY' })), (error) => error.code === 'ORACLE_ROLE_UNSUPPORTED');
  assert.throws(() => validateIdentity(identity({ logMode: 'NOARCHIVELOG' })), (error) => error.code === 'ORACLE_ARCHIVELOG_REQUIRED');
  assert.throws(() => validateIdentity(identity({ instanceCount: 2 })), (error) => error.code === 'ORACLE_RAC_UNSUPPORTED');
  assert.throws(() => validateIdentity(identity({ platformName: 'Microsoft Windows x86 64-bit' })), (error) => error.code === 'ORACLE_PLATFORM_UNSUPPORTED');
  const adapter = new OracleRmanAdapter({ processRunner: new Runner(identityOutput({ logMode: 'NOARCHIVELOG' })), now: () => 0, clock: () => '2026-08-04T10:00:00.000Z' });
  const result = await adapter.testConnection({ resolveSecret: async () => PASSWORD }, config());
  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'ORACLE_ARCHIVELOG_REQUIRED');
  assert.equal(result.error.category, 'consistency');
});

test('Oracle discovery exposes one whole-database selection with recovery lineage', async () => {
  const adapter = new OracleRmanAdapter({ processRunner: new Runner() });
  const pages = [];
  for await (const page of adapter.discover({ resolveSecret: async () => PASSWORD }, { connection: config() })) pages.push(page);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].items, [{
    kind: 'database',
    name: 'orders_prod',
    databaseName: 'ORDERS',
    system: false,
    selectable: true,
    state: 'READ WRITE',
    role: 'PRIMARY',
    recoveryModel: 'ARCHIVELOG',
    version: '19.24.0.0.0',
    dbid: '1234567890',
    incarnation: 7,
    resetlogsChange: '987654321',
    currentScn: '987700000',
    cdb: true,
    reasonCode: null
  }]);
});

test('Oracle connection service persists only SecretRef metadata and requires a successful test before discovery', async () => {
  const records = new Map();
  const secretMetadata = new Map();
  const deletedSecrets = [];
  const connectionRepository = {
    list: async () => [...records.values()],
    get: async (_workspaceId, id) => records.get(id) || null,
    update: async (_workspaceId, id, patch, options) => {
      const current = records.get(id);
      assert.equal(options.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      records.set(id, updated);
      return updated;
    }
  };
  const secretRepository = {
    get: async (_workspaceId, id) => secretMetadata.get(id) || null,
    update: async (_workspaceId, id, patch, options) => {
      const current = secretMetadata.get(id);
      assert.equal(options.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      secretMetadata.set(id, updated);
      return updated;
    }
  };
  const controlDatabase = {
    repository: (name) => name === 'connection' ? connectionRepository : name === 'secretRef' ? secretRepository : null,
    transaction: async (callback) => callback({
      create: (name, input) => {
        if (name === 'secretRef') {
          const record = { ...input, revision: 1 };
          secretMetadata.set(record.id, record);
          return record;
        }
        const record = { ...input, id: 'connection-oracle', revision: 1 };
        records.set(record.id, record);
        return record;
      }
    })
  };
  const secretStore = {
    create: async (input) => ({ id: 'secret-oracle', workspaceId: input.workspaceId, name: input.name, provider: 'local-safe-storage', scope: input.scope, providerKey: 'oracle-key', secretType: input.secretType, version: 1 }),
    resolve: async () => PASSWORD,
    markValidated: async () => ({ lastValidatedAt: '2026-08-04T10:00:00.000Z' }),
    delete: async (input) => deletedSecrets.push(input.id)
  };
  const service = new OracleConnectionService({ controlDatabase, secretStore, deviceId: 'device-a', adapter: new OracleRmanAdapter({ processRunner: new Runner(), now: () => 0, clock: () => '2026-08-04T10:00:00.000Z' }) });
  const created = await service.create('workspace-a', 'actor-a', { name: 'Orders Oracle', host: 'ora01.example.com', serviceName: 'orders.example.com', username: 'backup_operator', password: PASSWORD });
  assert.equal(created.adapterId, ADAPTER_ID);
  assert.deepEqual(created.secretRefIds, ['secret-oracle']);
  assert.equal(created.endpoint.password, undefined);
  assert.equal(JSON.stringify(created).includes(PASSWORD), false);
  await assert.rejects(service.discover('workspace-a', created.id), /Test the Oracle connection successfully/);
  const tested = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(tested.result.status, 'success');
  assert.match(tested.connection.trust.fingerprint, /^sha256:/);
  const discovered = await service.discover('workspace-a', created.id);
  assert.equal(discovered.items[0].dbid, '1234567890');
  const listed = await service.list('workspace-a');
  assert.equal(listed[0].currentDevice, true);
  assert.equal(deletedSecrets.length, 0);
});

test('Oracle Source persistence binds one tested DB_UNIQUE_NAME to pinned SSH execution settings', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-oracle-source-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => '2026-08-04T10:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const oracleConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Orders Oracle', kind: 'database', adapterId: ADAPTER_ID,
    endpoint: { host: 'ora01.example.com', port: 2484, serviceName: 'orders.example.com', username: 'BACKUP_OPERATOR', tlsMode: 'verify-identity', sqlplusExecutable: 'sqlplus' },
    workerAffinity: ['device:device-a'], trust: { fingerprint: 'sha256:oracle-database' },
    lastTest: { status: 'success', remotePlatform: { version: '19.24.0.0.0' }, endpointIdentity: { databaseFingerprint: 'sha256:oracle-database', databaseUniqueName: 'orders_prod', dbid: '1234567890', incarnation: 7 } }
  });
  const sshConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Oracle Linux', kind: 'ssh', adapterId: 'deployerx.connection.ssh',
    workerAffinity: ['device:device-a'], lastTest: { status: 'success' }
  });
  const adapter = new OracleRmanAdapter({ processRunner: new Runner() });
  const service = new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([adapter]), deviceId: 'device-a' });
  const request = {
    name: 'Orders RMAN', connectionId: oracleConnection.id,
    selector: { databases: { include: [{ name: 'orders_prod' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true },
    physicalExecution: { sshConnectionId: sshConnection.id, oracleHome: '/opt/oracle/product/19c/dbhome_1', oracleSid: 'ORDERS', oracleOwner: 'oracle', oracleGroup: 'oinstall' }
  };
  const source = await service.save('workspace-a', 'tester', request);
  assert.equal(source.physicalExecution.engine, 'oracle');
  assert.equal(source.physicalExecution.backupDirectory, '/var/opt/oracle/deployerx-backup');
  assert.equal(source.physicalExecution.dataDirectory, '/u02/oradata');
  assert.equal(source.physicalExecution.rmanExecutable, 'rman');
  assert.equal(source.selector.databases.include[0].name, 'orders_prod');
  assert.equal(JSON.stringify(source).includes('1234567890'), false);
  await assert.rejects(service.save('workspace-a', 'tester', { ...request, name: 'Wrong Oracle', selector: { databases: { include: [{ name: 'other_db' }] } } }), /DB_UNIQUE_NAME/);
  await assert.rejects(service.save('workspace-a', 'tester', { ...request, name: 'Filtered Oracle', selector: { databases: { include: [{ name: 'orders_prod' }] }, schemas: { include: [{ database: 'orders_prod', name: 'APP' }] } } }), /does not support schema selection/);
});

function pieceRow({ set = 1, type = 'I', level = '0', control = 'NO', spfile = 'NO', piece = 1, file, checkpoint = '987700000' }) {
  return ['DX_ORACLE_PIECE', String(600 + set), '700', String(set), type, level, control, spfile, '2026-08-04T10:01:00', '2026-08-04T10:02:00', checkpoint, String(900 + piece), String(piece), `/var/opt/oracle/deployerx-backup/deployerx-oracle-run.ABC123/${file}`, '10', 'NO', 'A'].join('\x1f');
}

function redoRow(sequence = 44, firstChange = '987699000', nextChange = '987701000') {
  return ['DX_ORACLE_REDO', '1', String(sequence), firstChange, nextChange, '2026-08-04T10:00:00', '2026-08-04T10:02:00', '987654321', '2026-08-04T09:30:00'].join('\x1f');
}

function physicalMetadata(type = 'level-0') {
  const lines = [];
  if (type !== 'archived-redo') lines.push(pieceRow({ type: 'I', level: type === 'level-0' ? '0' : '1', file: 'data-A.bkp' }));
  lines.push(pieceRow({ set: 2, type: 'L', level: '', piece: 1, file: 'redo-B.bkp', checkpoint: '' }));
  lines.push(pieceRow({ set: 3, type: 'D', level: '', control: 'YES', piece: 1, file: 'control-C.bkp' }));
  if (type !== 'archived-redo') lines.push(pieceRow({ set: 4, type: 'D', level: '', spfile: 'YES', piece: 1, file: 'spfile-D.bkp', checkpoint: '' }));
  lines.push(redoRow());
  return `${lines.join('\n')}\n`;
}

class OraclePhysicalSession {
  constructor(type = 'level-0') {
    this.type = type;
    this.commands = [];
    this.uploads = [];
    this.closed = false;
  }

  async run(command) {
    this.commands.push(command);
    if (command.includes("'mktemp'")) return { stdout: '/var/opt/oracle/deployerx-backup/deployerx-oracle-run.ABC123\n', stderr: '', exitCode: 0 };
    if (command.includes("'sqlplus' '-V'")) return { stdout: 'SQL*Plus: Release 19.0.0.0.0 - Production\n', stderr: '', exitCode: 0 };
    if (command.includes("'rman' '-version'")) return { stdout: 'Recovery Manager: Release 19.0.0.0.0 - Production\n', stderr: '', exitCode: 0 };
    if (command.includes("'id' '-un'")) return { stdout: 'oracle\n', stderr: '', exitCode: 0 };
    if (command.includes('identity.sql')) return { stdout: `${identityOutput()}\n${nativePreflightOutput()}\n`, stderr: '', exitCode: 0 };
    if (command.includes('metadata.sql')) return { stdout: physicalMetadata(this.type), stderr: '', exitCode: 0 };
    if (command.includes("'stat'")) return { stdout: '10\n', stderr: '', exitCode: 0 };
    if (command.includes("'sha256sum'")) return { stdout: `${'a'.repeat(64)}  piece.bkp\n`, stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async consume(command, content) {
    const chunks = [];
    for await (const chunk of content) chunks.push(Buffer.from(chunk));
    this.uploads.push({ command, content: Buffer.concat(chunks).toString('utf8') });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async stream(command) {
    this.commands.push(command);
    return { stdout: Readable.from([Buffer.from('1234567890123456789012345678901234567890')]), completion: Promise.resolve({ exitCode: 0, stderr: '' }), close() {} };
  }

  close() { this.closed = true; }
}

function physicalPlan() {
  const empty = { include: [], exclude: [] };
  const database = identity();
  return {
    source: {
      id: 'source-oracle', adapterId: ADAPTER_ID,
      selector: { kind: 'database-objects', allDatabases: false, databases: { include: [{ name: 'orders_prod' }], exclude: [] }, schemas: empty, tables: empty, includeGlobalObjects: false, digest: 'oracle-selection' },
      consistency: { backupMethod: 'physical' },
      physicalExecution: { engine: 'oracle', sshConnectionId: 'ssh-oracle', remoteTemporaryDirectory: '/var/tmp', backupDirectory: '/var/opt/oracle/deployerx-backup', oracleHome: '/opt/oracle/product/19c/dbhome_1', oracleSid: 'ORDERS', oracleOwner: 'oracle', oracleGroup: 'oinstall', privilegeMode: 'sudo-noninteractive', anchorMode: 'level-0', sqlplusExecutable: 'sqlplus', rmanExecutable: 'rman', tarExecutable: 'tar', statExecutable: 'stat', sha256sumExecutable: 'sha256sum', rmExecutable: 'rm' }
    },
    connection: { id: 'oracle-connection', revision: 2, workerAffinity: ['device:device-a'], lastTest: { endpointIdentity: { databaseFingerprint: databaseFingerprint(database), instanceFingerprint: 'sha256:oracle-instance', dbid: database.dbid, databaseUniqueName: database.databaseUniqueName, incarnation: database.incarnation, resetlogsChange: database.resetlogsChange } } },
    executionConnection: { id: 'ssh-oracle', revision: 3, adapterId: 'deployerx.connection.ssh', endpoint: { host: 'ora01.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 }, secretRefIds: ['secret-ssh'], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' }, workerAffinity: ['device:device-a'], lastTest: { status: 'success' } },
    manifest: { adapterVersion: '0.1.0' }
  };
}

function physicalDependencies(session, artifacts = []) {
  return {
    controlDatabase: { repository: (name) => ({ list: async () => name === 'artifact' ? artifacts : [], get: async () => null }) },
    secretStore: { resolve: async () => 'ssh-private-key' },
    deviceId: 'device-a',
    sessionFactory: async () => session
  };
}

test('Oracle RMAN statements preserve exact full, level-1, cumulative, and archived-redo semantics', () => {
  assert.equal(backupType('full', 'full'), 'full');
  assert.equal(backupType('full', 'level-0'), 'level-0');
  assert.equal(backupType('incremental'), 'level-1-differential');
  assert.equal(backupType('differential'), 'level-1-cumulative');
  assert.equal(backupType('native'), 'archived-redo');
  assert.match(rmanScript({ type: 'level-0', directory: '/var/opt/oracle/deployerx-backup/run', tag: 'DXABC' }), /INCREMENTAL LEVEL 0 DATABASE/);
  assert.match(rmanScript({ type: 'level-1-cumulative', directory: '/var/opt/oracle/deployerx-backup/run', tag: 'DXABC', startScn: '100' }), /LEVEL 1 CUMULATIVE DATABASE/);
  assert.match(rmanScript({ type: 'archived-redo', directory: '/var/opt/oracle/deployerx-backup/run', tag: 'DXABC', startScn: '100' }), /ARCHIVELOG FROM SCN 100/);
  assert.doesNotMatch(rmanScript({ type: 'archived-redo', directory: '/var/opt/oracle/deployerx-backup/run', tag: 'DXABC', startScn: '100' }), /BACKUP SPFILE|BACKUP AS BACKUPSET DATABASE/);
  assert.equal(selectedDatabase(physicalPlan().source.selector), 'orders_prod');
});

test('Oracle RMAN metadata parsing refuses piece escapes and redo gaps', () => {
  const workspace = '/var/opt/oracle/deployerx-backup/deployerx-oracle-run.ABC123';
  const pieces = parsePieceInventory(physicalMetadata('level-0'), workspace);
  assert.deepEqual(new Set(pieces.map((piece) => piece.kind)), new Set(['datafile', 'archived-redo', 'control-file', 'spfile']));
  const redo = parseRedoInventory(`${redoRow(44, '100', '200')}\n${redoRow(45, '190', '300')}\n`, { resetlogsChange: '987654321' });
  assert.equal(redo.at(-1).nextChange, '300');
  assert.throws(() => parseRedoInventory(`${redoRow(44, '100', '200')}\n${redoRow(46, '300', '400')}\n`, { resetlogsChange: '987654321' }), (error) => error.code === 'ORACLE_ARCHIVED_REDO_GAP');
  assert.throws(() => parsePieceInventory(pieceRow({ file: '../escape.bkp' }), workspace), (error) => error.code === 'ORACLE_REMOTE_PATH_INVALID' || error.code === 'ORACLE_RMAN_PIECE_PATH_INVALID');
});

test('Oracle level-0 backup authenticates identity, inventories every piece, validates natively, and streams one archive', async () => {
  const session = new OraclePhysicalSession('level-0');
  const service = new OraclePhysicalBackupService(physicalDependencies(session));
  const prepared = await service.prepare('workspace-a', 'run-oracle-root', physicalPlan(), { backupMode: 'full', jobId: 'job-oracle' });
  assert.equal(prepared.databaseManifest.backup.type, 'level-0');
  assert.equal(prepared.databaseManifest.backup.pieceCount, 4);
  assert.equal(prepared.databaseManifest.backup.totalPieceBytes, 40);
  assert.equal(prepared.databaseManifest.restore.controlFileIncluded, true);
  assert.equal(prepared.databaseManifest.restore.spfileIncluded, true);
  assert.equal(prepared.databaseManifest.archivedRedo.firstSequence, 44);
  assert.equal(prepared.databaseManifest.pieces.every((piece) => piece.checksum.digest === 'a'.repeat(64)), true);
  const rmanUpload = session.uploads.find((upload) => upload.content.includes('INCREMENTAL LEVEL 0 DATABASE'));
  assert.doesNotMatch(rmanUpload.content, /DELETE INPUT|DELETE OBSOLETE/);
  const validationUpload = session.uploads.find((upload) => upload.content.includes('VALIDATE BACKUPSET'));
  assert.match(validationUpload.content, /VALIDATE BACKUPSET 601;/);
  assert.equal(session.commands.some((command) => command.includes("'-u' 'oracle'")), true);
  const chunks = [];
  for await (const chunk of prepared.content()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).length, 40);
  await service.release(prepared);
  assert.equal(session.closed, true);
  assert.equal(session.commands.some((command) => command.includes("'rm' '-rf'") && command.includes('deployerx-oracle-run.ABC123')), true);
});

test('Oracle level-1 and archived-redo runs require and preserve authenticated chain parents', async () => {
  const rootSession = new OraclePhysicalSession('level-0');
  const rootService = new OraclePhysicalBackupService(physicalDependencies(rootSession));
  const root = await rootService.prepare('workspace-a', 'run-root', physicalPlan(), { backupMode: 'full', jobId: 'job-oracle' });
  const rootArtifact = { recoveryPointId: 'rp-oracle-root', kind: 'physical-backup', metadata: root.databaseManifest };
  await rootService.release(root);

  const incrementalSession = new OraclePhysicalSession('level-1-differential');
  const incrementalService = new OraclePhysicalBackupService(physicalDependencies(incrementalSession, [rootArtifact]));
  const incremental = await incrementalService.prepare('workspace-a', 'run-incremental', physicalPlan(), { backupMode: 'incremental', jobId: 'job-oracle' });
  assert.equal(incremental.databaseManifest.backup.type, 'level-1-differential');
  assert.equal(incremental.databaseManifest.chain.chainRootRecoveryPointId, 'rp-oracle-root');
  assert.equal(incremental.databaseManifest.chain.dataParentRecoveryPointId, 'rp-oracle-root');
  assert.equal(incremental.databaseManifest.chain.redoParentRecoveryPointId, 'rp-oracle-root');
  assert.match(incrementalSession.uploads.find((upload) => upload.content.includes('LEVEL 1 DATABASE')).content, /ARCHIVELOG FROM SCN 987701000/);
  await incrementalService.release(incremental);

  const logSession = new OraclePhysicalSession('archived-redo');
  const logService = new OraclePhysicalBackupService(physicalDependencies(logSession, [rootArtifact]));
  const log = await logService.prepare('workspace-a', 'run-redo', physicalPlan(), { backupMode: 'native', jobId: 'job-oracle' });
  assert.equal(log.databaseManifest.artifact.kind, 'transaction-log');
  assert.equal(log.databaseManifest.restore.spfileIncluded, false);
  assert.equal(log.databaseManifest.chain.parentRecoveryPointId, 'rp-oracle-root');
  await logService.release(log);

  await assert.rejects(new OraclePhysicalBackupService(physicalDependencies(new OraclePhysicalSession('level-1-differential'))).prepare('workspace-a', 'run-no-root', physicalPlan(), { backupMode: 'incremental', jobId: 'job-oracle' }), (error) => error.code === 'ORACLE_LEVEL0_REQUIRED');
});
