const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');
const { ADAPTER_ID, databaseFingerprint } = require('./oracle');
const {
  RESETLOGS_CONFIRMATION,
  RESTORE_CONFIRMATIONS,
  OracleRestoreService,
  alternateRestoreScript,
  bootstrapPfile,
  normalizeAlternateTargetProfile,
  normalizeRecoveryTarget,
  normalizeRequest,
  originalRestoreScript,
  validateChain,
  validateTarListing
} = require('./oracle-restore');

const WORKSPACE_ID = 'workspace-a';
const SEPARATOR = String.fromCharCode(31);

function identity(overrides = {}) {
  return {
    dbid: '1234567890', databaseName: 'ORDERS', databaseUniqueName: 'ORDERS_PROD', databaseRole: 'PRIMARY',
    openMode: 'READ WRITE', logMode: 'ARCHIVELOG', cdb: true, platformName: 'Linux x86 64-bit', instanceName: 'ORDERS',
    hostName: 'ora01.example.com', version: '19.24.0.0.0', instanceCount: 1, incarnation: 7,
    resetlogsChange: '900', resetlogsTime: '2026-08-01T00:00:00', currentScn: '1500', ...overrides
  };
}

function point(id, type, parentRecoveryPointId, chainRootId = 'rp-full') {
  return { id, type, parentRecoveryPointId, chainRootId, sourceId: 'source-a', jobId: 'job-a' };
}

function piece(fileName, kind) {
  return { fileName, kind, sizeBytes: 10, checksum: { algorithm: 'sha256', digest: 'a'.repeat(64) } };
}

function metadata(type, options = {}) {
  const startScn = options.startScn || '1000';
  const endScn = options.endScn || '1100';
  return {
    kind: 'oracle-rman',
    server: { major: 19, databaseFingerprint: databaseFingerprint(identity()) },
    database: {
      dbid: '1234567890', name: 'ORDERS', uniqueName: 'ORDERS_PROD', cdb: true, incarnation: 7, resetlogsChange: '900',
      encryptedTablespaces: 0, asmDatafiles: 0
    },
    source: { sourceId: 'source-a', jobId: 'job-a' },
    backup: { type, checkpointScn: options.checkpointScn || startScn },
    archivedRedo: {
      thread: 1, firstSequence: options.firstSequence || '10', lastSequence: options.lastSequence || '11',
      startScn, endScn, startedAt: options.startedAt || '2026-08-04T10:00:00.000Z',
      completedAt: options.completedAt || '2026-08-04T10:10:00.000Z', resetlogsChange: '900'
    },
    pieces: options.pieces || [piece(`data-${type}.bkp`, 'datafile'), piece(`redo-${type}.bkp`, 'archived-redo'), piece(`control-${type}.bkp`, 'control-file'), piece(`spfile-${type}.bkp`, 'spfile')],
    chain: {
      chainRootRecoveryPointId: 'rp-full', parentRecoveryPointId: options.redoParent || null,
      redoParentRecoveryPointId: options.redoParent || null, dataParentRecoveryPointId: options.dataParent || null
    },
    restore: { controlFileIncluded: true, spfileIncluded: true },
    artifact: { kind: type === 'archived-redo' ? 'transaction-log' : 'physical-backup', path: `oracle-rman/${type}.tar`, mediaType: 'application/x-tar' }
  };
}

function request(overrides = {}) {
  return {
    recoveryPointId: 'rp-full', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original,
    resetlogsConfirmed: true, resetlogsConfirmationText: RESETLOGS_CONFIRMATION, recoveryTarget: { type: 'latest' }, ...overrides
  };
}

function alternateProfile(overrides = {}) {
  return {
    sshConnectionId: 'ssh-b', oracleSid: 'ORDALT', databaseUniqueName: 'orders_alt', oracleHome: '/opt/oracle/product/19c/dbhome_1',
    remoteTemporaryDirectory: '/var/tmp', dataDirectory: '/u02/oradata/ORDALT', recoveryAreaDirectory: '/u03/fast_recovery_area/ORDALT',
    redoDirectory: '/u04/oraredo/ORDALT', recoveryAreaSizeBytes: 50 * 1024 ** 3, oracleOwner: 'oracle', oracleGroup: 'oinstall',
    privilegeMode: 'sudo-noninteractive', sqlplusExecutable: 'sqlplus', rmanExecutable: 'rman', lsnrctlExecutable: 'lsnrctl',
    tarExecutable: 'tar', statExecutable: 'stat', sha256sumExecutable: 'sha256sum', rmExecutable: 'rm', ...overrides
  };
}

test('Oracle restore requires independent destructive and OPEN RESETLOGS confirmations', () => {
  assert.deepEqual(normalizeRequest(request()).recoveryTarget, { type: 'latest', value: null });
  assert.throws(() => normalizeRequest(request({ confirmationText: 'RESTORE ORACLE' })), (error) => error.code === 'ORACLE_RESTORE_CONFIRMATION_REQUIRED');
  assert.throws(() => normalizeRequest(request({ resetlogsConfirmationText: 'OPEN RESETLOGS' })), (error) => error.code === 'ORACLE_RESETLOGS_CONFIRMATION_REQUIRED');
  assert.equal(normalizeRequest(request({ mode: 'alternate', confirmationText: RESTORE_CONFIRMATIONS.alternate, targetProfile: alternateProfile() })).targetProfile.oracleSid, 'ORDALT');
  assert.throws(() => normalizeAlternateTargetProfile(alternateProfile({ redoDirectory: '/u02/oradata/ORDALT/redo' })), (error) => error.code === 'ORACLE_ALTERNATE_ROOTS_OVERLAP');
});

test('Oracle recovery targets normalize explicit SCN, sequence, and UTC-time coordinates', () => {
  assert.deepEqual(normalizeRecoveryTarget({ type: 'scn', value: '001234' }), { type: 'scn', value: '1234' });
  assert.deepEqual(normalizeRecoveryTarget({ type: 'sequence', value: 42 }), { type: 'sequence', value: '42' });
  assert.deepEqual(normalizeRecoveryTarget({ type: 'time', value: '2026-08-04T12:30:00+05:30' }), { type: 'time', value: '2026-08-04T07:00:00.000Z' });
  assert.throws(() => normalizeRecoveryTarget({ type: 'time', value: '2026-08-04 12:30:00' }), (error) => error.code === 'ORACLE_RECOVERY_TIME_INVALID');
});

test('Oracle restore authenticates DBID, incarnation, resetlogs, data parents, and continuous redo', () => {
  const points = [point('rp-full', 'full', null), point('rp-inc', 'incremental', 'rp-full'), point('rp-redo', 'log', 'rp-inc')];
  const metadataByPoint = new Map([
    ['rp-full', metadata('level-0')],
    ['rp-inc', metadata('level-1-differential', { startScn: '1100', endScn: '1200', firstSequence: '11', lastSequence: '12', redoParent: 'rp-full', dataParent: 'rp-full' })],
    ['rp-redo', metadata('archived-redo', { startScn: '1200', endScn: '1300', firstSequence: '12', lastSequence: '13', redoParent: 'rp-inc', pieces: [piece('redo-only.bkp', 'archived-redo'), piece('control-redo.bkp', 'control-file')] })]
  ]);
  const chain = validateChain(points, metadataByPoint, 'rp-redo', { type: 'scn', value: '1250' });
  assert.deepEqual(chain.chain.map((item) => item.id), ['rp-full', 'rp-inc', 'rp-redo']);
  metadataByPoint.get('rp-inc').chain.dataParentRecoveryPointId = 'rp-missing';
  assert.throws(() => validateChain(points, metadataByPoint, 'rp-redo'), (error) => error.code === 'ORACLE_CHAIN_DATA_PARENT_INVALID');
  metadataByPoint.get('rp-inc').chain.dataParentRecoveryPointId = 'rp-full';
  metadataByPoint.get('rp-redo').archivedRedo.startScn = '1201';
  assert.throws(() => validateChain(points, metadataByPoint, 'rp-redo'), (error) => error.code === 'ORACLE_CHAIN_REDO_GAP');
  metadataByPoint.get('rp-redo').archivedRedo.startScn = '1200';
  metadataByPoint.get('rp-redo').database.dbid = '999';
  assert.throws(() => validateChain(points, metadataByPoint, 'rp-redo'), (error) => error.code === 'ORACLE_CHAIN_IDENTITY_MISMATCH');
});

test('Oracle restore rejects missing redo parents and recovery coordinates outside the chain', () => {
  const points = [point('rp-full', 'full', null), point('rp-redo', 'log', 'rp-missing')];
  const metadataByPoint = new Map([
    ['rp-full', metadata('full')],
    ['rp-redo', metadata('archived-redo', { startScn: '1100', endScn: '1200', redoParent: 'rp-missing' })]
  ]);
  assert.throws(() => validateChain(points, metadataByPoint, 'rp-redo'), (error) => error.code === 'ORACLE_CHAIN_REDO_PARENT_MISSING');
  assert.throws(() => validateChain([points[0]], new Map([['rp-full', metadata('full')]]), 'rp-full', { type: 'sequence', value: '99' }), (error) => error.code === 'ORACLE_RECOVERY_SEQUENCE_OUTSIDE_CHAIN');
});

test('Oracle tar inventory accepts only the exact safe authenticated piece set', () => {
  const pieces = [piece('data-a.bkp', 'datafile'), piece('redo-a.bkp', 'archived-redo')];
  const listing = '-rw------- oracle/oinstall 10 2026-08-04 12:00 data-a.bkp\n-rw------- oracle/oinstall 10 2026-08-04 12:01 redo-a.bkp\n';
  assert.equal(validateTarListing(listing, pieces), true);
  assert.throws(() => validateTarListing(`${listing}-rw------- oracle/oinstall 1 2026-08-04 12:02 ../escape.bkp\n`, pieces), (error) => error.code === 'ORACLE_RESTORE_ARCHIVE_UNSAFE');
  assert.throws(() => validateTarListing(listing, [piece('../data-a.bkp', 'datafile')]), (error) => error.code === 'ORACLE_RESTORE_PIECE_METADATA_UNSAFE');
  assert.throws(() => validateTarListing(listing, [piece('data-a.bkp', 'datafile'), piece('data-a.bkp', 'datafile')]), (error) => error.code === 'ORACLE_RESTORE_PIECE_METADATA_UNSAFE');
});

test('Oracle original restore script bootstraps DBID, SPFILE, control file, catalog, recovery, and RESETLOGS in order', () => {
  const metadataByPoint = new Map([['rp-full', metadata('full')]]);
  const chain = validateChain([point('rp-full', 'full', null)], metadataByPoint, 'rp-full');
  const script = originalRestoreScript(chain, '/var/tmp/dx/media', { type: 'scn', value: '1050' });
  const ordered = ['SET DBID 1234567890;', 'STARTUP FORCE NOMOUNT;', "RESTORE SPFILE FROM '/var/tmp/dx/media/spfile-full.bkp';", 'SHUTDOWN IMMEDIATE;', 'STARTUP NOMOUNT;', "RESTORE CONTROLFILE FROM '/var/tmp/dx/media/control-full.bkp';", 'ALTER DATABASE MOUNT;', "CATALOG START WITH '/var/tmp/dx/media/' NOPROMPT;", 'SET UNTIL SCN 1050;', 'RESTORE DATABASE;', 'RECOVER DATABASE;', 'SQL "ALTER DATABASE OPEN RESETLOGS";'];
  for (let index = 1; index < ordered.length; index += 1) assert.ok(script.indexOf(ordered[index - 1]) < script.indexOf(ordered[index]));
  assert.match(originalRestoreScript(chain, '/var/tmp/dx/media', { type: 'time', value: '2026-08-04T10:05:00.000Z' }), /TO_TIMESTAMP_TZ\('2026-08-04 10:05:00 \+00:00'.*AT LOCAL TIME ZONE AS DATE/);
});

test('Oracle alternate restore uses an auxiliary PFILE, OMF-only destinations, and RMAN backup-based duplication', () => {
  const metadataByPoint = new Map([['rp-full', metadata('full')]]);
  const chain = validateChain([point('rp-full', 'full', null)], metadataByPoint, 'rp-full');
  const profile = normalizeAlternateTargetProfile(alternateProfile());
  const pfile = bootstrapPfile(profile, chain);
  const script = alternateRestoreScript(chain, '/var/tmp/dx/media', { type: 'scn', value: '1050' }, '/var/tmp/dx/initORDALT.ora', profile);
  assert.match(pfile, /db_name='ORDALT'/);
  assert.match(pfile, /enable_pluggable_database=true/);
  assert.match(script, /STARTUP FORCE NOMOUNT PFILE='\/var\/tmp\/dx\/initORDALT[.]ora';/);
  assert.match(script, /DUPLICATE DATABASE TO ORDALT/);
  assert.match(script, /BACKUP LOCATION '\/var\/tmp\/dx\/media'/);
  assert.match(script, /SET db_create_file_dest '\/u02\/oradata\/ORDALT'/);
  assert.match(script, /SET db_create_online_log_dest_1 '\/u04\/oraredo\/ORDALT'/);
  assert.doesNotMatch(script, /NOFILENAMECHECK/);
});

class MemoryControlDatabase {
  constructor(records) {
    this.records = Object.fromEntries(Object.entries(records).map(([name, values]) => [name, new Map(values.map((value) => [value.id, structuredClone(value)]))]));
  }

  repository(name) {
    const records = this.records[name] || (this.records[name] = new Map());
    return {
      get: async (_workspaceId, id) => records.get(id) || null,
      list: async () => [...records.values()],
      create: async (value) => {
        const created = { ...structuredClone(value), id: value.id || `restore-${records.size + 1}`, revision: 1 };
        records.set(created.id, created);
        return created;
      }
    };
  }

  async transaction(operation) {
    return operation({
      get: (name, _workspaceId, id) => this.records[name].get(id),
      projectExecution: (name, _workspaceId, id, changes) => {
        const current = this.records[name].get(id);
        const updated = { ...current, ...structuredClone(changes), revision: current.revision + 1 };
        this.records[name].set(id, updated);
        return updated;
      }
    });
  }
}

class RestoreSession {
  constructor(options = {}) {
    this.options = options;
    this.commands = [];
    this.writes = new Map();
    this.closed = false;
    this.blockArchive = Boolean(options.blockArchive);
    this.archiveEntered = new Promise((resolve) => { this.markArchiveEntered = resolve; });
  }

  async run(command) {
    this.commands.push(command);
    if (command.includes("'sqlplus' '-V'")) return { stdout: 'SQL*Plus: Release 19.0.0.0.0', stderr: '', exitCode: 0 };
    if (command.includes("'rman' '-version'")) return { stdout: 'Recovery Manager: Release 19.0.0.0.0', stderr: '', exitCode: 0 };
    if (command.includes("'id' '-un'")) return { stdout: 'oracle\n', stderr: '', exitCode: 0 };
    if (command.includes("'mktemp'")) return { stdout: '/var/tmp/deployerx-oracle-restore-restore1.ABC123\n', stderr: '', exitCode: 0 };
    if (command.includes("'/bin/sh'") && command.includes('alternate-preflight.sh') && this.options.collisionExitCode) throw Object.assign(new Error('collision'), { exitCode: this.options.collisionExitCode });
    if (command.includes("'stat' '--format=%s'") && command.includes('.tar')) return { stdout: '13\n', stderr: '', exitCode: 0 };
    if (command.includes("'stat' '--format=%s'")) return { stdout: '10\n', stderr: '', exitCode: 0 };
    if (command.includes("'tar' '--list'")) {
      return { stdout: ['data-full.bkp', 'redo-full.bkp', 'control-full.bkp', 'spfile-full.bkp'].map((name) => `-rw------- oracle/oinstall 10 2026-08-04 12:00 ${name}`).join('\n'), stderr: '', exitCode: 0 };
    }
    if (command.includes("'sha256sum'")) return { stdout: `${'a'.repeat(64)}  piece.bkp\n`, stderr: '', exitCode: 0 };
    if (command.includes("'lsnrctl' 'status'")) return { stdout: 'Service "orders_alt" has 1 instance(s).', stderr: '', exitCode: 0 };
    if (command.includes("'sqlplus' '-L' '-S' '/nolog'") && command.includes('identity.sql')) return { stdout: identityOutput(this.options.alternate ? identity({ dbid: '987654321', databaseName: 'ORDALT', databaseUniqueName: 'orders_alt', instanceName: 'ORDALT', hostName: 'ora02.example.com', incarnation: 1, resetlogsChange: '1600', currentScn: '1601' }) : identity({ incarnation: 8, resetlogsChange: '1600', currentScn: '1601' })), stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async consume(command, content) {
    this.commands.push(command);
    if (command.includes('.tar')) {
      this.markArchiveEntered();
      if (this.blockArchive) {
        await new Promise((resolve) => this.signal.addEventListener('abort', resolve, { once: true }));
        throw Object.assign(new Error('canceled'), { code: 'SSH_EXECUTION_CANCELED' });
      }
    }
    const chunks = [];
    for await (const chunk of content) chunks.push(Buffer.from(chunk));
    this.writes.set(command, Buffer.concat(chunks));
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  close() { this.closed = true; }
}

function identityOutput(value) {
  return ['DX_ORACLE_ID', value.dbid, value.databaseName, value.databaseUniqueName, value.databaseRole, value.openMode, value.logMode, value.cdb ? 'YES' : 'NO', value.platformName, value.instanceName, value.hostName, value.version, String(value.instanceCount), String(value.incarnation), value.resetlogsChange, value.resetlogsTime, value.currentScn].join(SEPARATOR);
}

function restoreFixture(options = {}) {
  const backupMetadata = metadata('full');
  const source = {
    id: 'source-a', sourceType: 'database', adapterId: ADAPTER_ID, connectionId: 'oracle-a', consistency: { backupMethod: 'physical' },
    physicalExecution: {
      engine: 'oracle', sshConnectionId: 'ssh-a', oracleHome: '/opt/oracle/product/19c/dbhome_1', oracleSid: 'ORDERS', oracleOwner: 'oracle', oracleGroup: 'oinstall',
      privilegeMode: 'sudo-noninteractive', remoteTemporaryDirectory: '/var/tmp', sqlplusExecutable: 'sqlplus', rmanExecutable: 'rman',
      statExecutable: 'stat', tarExecutable: 'tar', sha256sumExecutable: 'sha256sum', rmExecutable: 'rm'
    }
  };
  const recoveryPoint = { ...point('rp-full', 'full', null), repositoryCopies: [{ repositoryId: 'repo-a', engineSnapshotId: 'snapshot-a', state: 'available' }] };
  const artifact = { id: 'artifact-a', kind: 'physical-backup', recoveryPointId: 'rp-full', repositoryId: 'repo-a', sizeBytes: 13, checksum: { algorithm: 'sha256', digest: 'b'.repeat(64) }, metadata: backupMetadata };
  const endpointIdentity = { ...identity(), databaseFingerprint: databaseFingerprint(identity()) };
  const oracleConnection = { id: 'oracle-a', adapterId: ADAPTER_ID, endpoint: { host: 'ora01.example.com', port: 2484, serviceName: 'orders.example.com', username: 'BACKUP', tlsMode: 'verify-full', caCertificate: 'cert' }, secretRefIds: ['sec-oracle'], workerAffinity: ['device:device-a'], lastTest: { status: 'success', endpointIdentity } };
  const sshConnection = { id: 'ssh-a', adapterId: 'deployerx.connection.ssh', endpoint: { host: 'ora01.example.com', port: 22, username: 'deployer', authType: 'private-key', timeoutMs: 20000 }, secretRefIds: ['sec-ssh'], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' }, workerAffinity: ['device:device-a'], lastTest: { status: 'success' } };
  const alternateSshConnection = { ...structuredClone(sshConnection), id: 'ssh-b', endpoint: { ...sshConnection.endpoint, host: 'ora02.example.com' } };
  const controlDatabase = new MemoryControlDatabase({ source: [source], connection: [oracleConnection, sshConnection, alternateSshConnection], recoveryPoint: [recoveryPoint], artifact: [artifact], restoreRun: options.restoreRuns || [] });
  const session = new RestoreSession(options);
  const repositoryMetadata = options.tamperManifest ? { ...backupMetadata, database: { ...backupMetadata.database, dbid: '999' } } : backupMetadata;
  const repository = {
    engine: {
      openSnapshot: async () => ({ manifest: { files: [{ path: backupMetadata.artifact.path, type: 'file', sizeBytes: 13, contentDigest: { algorithm: 'sha256', digest: 'b'.repeat(64) }, metadata: { artifactKind: 'physical-backup', database: repositoryMetadata } }] } }),
      streamFile: () => Readable.from([Buffer.from('archive-bytes')])
    },
    masterKey: Buffer.alloc(32, 1)
  };
  const adapter = {
    normalizeConfig: (config) => config,
    testConnection: async () => ({ status: 'success', endpointIdentity: { ...identity({ incarnation: 8, resetlogsChange: '1600' }), databaseFingerprint: databaseFingerprint(identity()) } })
  };
  const service = new OracleRestoreService({
    controlDatabase, secretStore: { resolve: async () => 'secret' }, deviceId: 'device-a', adapter,
    openRepository: async () => repository, sessionFactory: async ({ signal }) => { session.signal = signal; return session; },
    clock: () => '2026-08-04T12:00:00.000Z'
  });
  return { controlDatabase, service, session };
}

test('Oracle original restore materializes authenticated RMAN media, restores, validates, and cleans up', async () => {
  const { service, session } = restoreFixture();
  const started = await service.start(WORKSPACE_ID, 'tester', request({ deepValidation: true }));
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify({ result: completed.result, commands: session.commands }));
  assert.equal(completed.result.dbid, '1234567890');
  assert.equal(completed.result.incarnation, 8);
  assert.equal(completed.validation.checks.some((check) => check.id === 'rman-check-logical'), true);
  const restoreWrite = [...session.writes.entries()].find(([command]) => command.includes('restore.rman'));
  assert.match(restoreWrite[1].toString(), /SET DBID 1234567890;/);
  assert.match(restoreWrite[1].toString(), /ALTER DATABASE OPEN RESETLOGS/);
  assert.equal(session.closed, true);
  assert.equal(session.commands.some((command) => command.includes("'rm' '-rf' '--' '/var/tmp/deployerx-oracle-restore-restore1.ABC123'")), true);
});

test('Oracle alternate restore proves absence, duplicates to OMF destinations, and validates the listener', async () => {
  const { service, session } = restoreFixture({ alternate: true });
  const started = await service.start(WORKSPACE_ID, 'tester', request({ mode: 'alternate', confirmationText: RESTORE_CONFIRMATIONS.alternate, targetProfile: alternateProfile(), deepValidation: true }));
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify({ result: completed.result, commands: session.commands }));
  assert.equal(completed.result.sourceDbid, '1234567890');
  assert.equal(completed.result.dbid, '987654321');
  assert.equal(completed.target.targetProfile.dataDirectory, '/u02/oradata/ORDALT');
  assert.equal(completed.validation.checks.some((check) => check.id === 'listener-registration'), true);
  const preflight = session.commands.findIndex((command) => command.includes('alternate-preflight.sh'));
  const createDestination = session.commands.findIndex((command) => command.includes("'mkdir' '-m' '0750' '--' '/u02/oradata/ORDALT'"));
  const runRman = session.commands.findIndex((command) => command.includes("'rman' 'auxiliary' '/'"));
  assert.ok(preflight >= 0 && preflight < createDestination && createDestination < runRman);
  const restoreWrite = [...session.writes.entries()].find(([command]) => command.includes('restore.rman'));
  assert.match(restoreWrite[1].toString(), /DUPLICATE DATABASE TO ORDALT/);
});

test('Oracle alternate restore refuses an existing destination before creating roots or running RMAN', async () => {
  const { service, session } = restoreFixture({ alternate: true, collisionExitCode: 41 });
  const started = await service.start(WORKSPACE_ID, 'tester', request({ mode: 'alternate', confirmationText: RESTORE_CONFIRMATIONS.alternate, targetProfile: alternateProfile() }));
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'ORACLE_ALTERNATE_DESTINATION_EXISTS');
  assert.equal(session.commands.some((command) => command.includes("'mkdir' '-m' '0750' '--' '/u02/oradata/ORDALT'")), false);
  assert.equal(session.commands.some((command) => command.includes("'rman' 'auxiliary' '/'")), false);
});

test('Oracle restore fails before RMAN when repository metadata differs from its authenticated manifest', async () => {
  const { service, session } = restoreFixture({ tamperManifest: true });
  const started = await service.start(WORKSPACE_ID, 'tester', request());
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'ORACLE_RESTORE_ARTIFACT_INVALID');
  assert.equal(session.commands.some((command) => command.includes("'rman' 'target'")), false);
});

test('Oracle restore cancellation aborts staging and reconciles interrupted runs', async () => {
  const { service, session } = restoreFixture({ blockArchive: true });
  const started = await service.start(WORKSPACE_ID, 'tester', request());
  await session.archiveEntered;
  const canceled = await service.cancel(WORKSPACE_ID, 'tester', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.error.code, 'ORACLE_RESTORE_CANCELED');
  assert.equal(session.closed, true);

  const interrupted = { id: 'restore-interrupted', revision: 1, state: 'running', target: { operation: 'oracle-rman' }, progress: { phase: 'restoring' } };
  const fixture = restoreFixture({ restoreRuns: [interrupted] });
  const reconciled = await fixture.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].state, 'failed');
  assert.equal(reconciled[0].result.error.code, 'ORACLE_RESTORE_INTERRUPTED');
});
