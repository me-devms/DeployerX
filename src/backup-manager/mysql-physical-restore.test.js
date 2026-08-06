const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const { ADAPTER_ID } = require('./mysql-logical');
const { MysqlPhysicalRestoreService, RESTORE_CONFIRMATIONS, normalizeRequest, validateChain } = require('./mysql-physical-restore');

function point(id, type, parentRecoveryPointId, chainRootId = 'rp-full') {
  return { id, type, parentRecoveryPointId, chainRootId, sourceId: 'source-a', jobId: 'job-a' };
}

function metadata(backupType, fromLsn, toLsn, parentRecoveryPointId = null) {
  return {
    kind: 'mysql-xtrabackup',
    server: { serverUuid: 'server-a' },
    source: { sourceId: 'source-a', jobId: 'job-a' },
    checkpoints: { backupType, fromLsn, toLsn, lastLsn: String(BigInt(toLsn) + 10n) },
    chain: { chainRootRecoveryPointId: 'rp-full', parentRecoveryPointId }
  };
}

test('physical restore requires exact mode-specific destructive confirmation', () => {
  assert.deepEqual(normalizeRequest({ recoveryPointId: 'rp-1', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original }), { recoveryPointId: 'rp-1', mode: 'original', targetSourceId: null });
  assert.equal(normalizeRequest({ recoveryPointId: 'rp-1', mode: 'alternate', targetSourceId: 'source-b', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate }).targetSourceId, 'source-b');
  assert.throws(() => normalizeRequest({ recoveryPointId: 'rp-1', mode: 'original', confirmed: true, confirmationText: 'RESTORE MYSQL' }), (error) => error.code === 'MYSQL_PHYSICAL_RESTORE_CONFIRMATION_REQUIRED');
});

test('physical restore authenticates an exact acyclic full and incremental LSN chain', () => {
  const points = [point('rp-full', 'full', null), point('rp-inc-1', 'incremental', 'rp-full'), point('rp-inc-2', 'incremental', 'rp-inc-1')];
  const metadataByPoint = new Map([
    ['rp-full', metadata('full-backuped', '0', '100')],
    ['rp-inc-1', metadata('incremental', '100', '180', 'rp-full')],
    ['rp-inc-2', metadata('incremental', '180', '240', 'rp-inc-1')]
  ]);
  const chain = validateChain(points, metadataByPoint, 'rp-inc-2');
  assert.deepEqual(chain.chain.map((item) => item.id), ['rp-full', 'rp-inc-1', 'rp-inc-2']);
  assert.equal(chain.toLsn, '240');
  metadataByPoint.set('rp-inc-2', metadata('incremental', '181', '240', 'rp-inc-1'));
  assert.throws(() => validateChain(points, metadataByPoint, 'rp-inc-2'), (error) => error.code === 'MYSQL_PHYSICAL_RESTORE_LSN_GAP');
});

test('physical restore refuses chain cycles and cross-server metadata', () => {
  const cycle = [point('rp-full', 'full', 'rp-inc'), point('rp-inc', 'incremental', 'rp-full')];
  const metadataByPoint = new Map([['rp-full', metadata('full-backuped', '0', '100')], ['rp-inc', metadata('incremental', '100', '150')]]);
  assert.throws(() => validateChain(cycle, metadataByPoint, 'rp-inc'), (error) => error.code === 'MYSQL_PHYSICAL_RESTORE_CHAIN_CYCLE');
  const points = [point('rp-full', 'full', null), point('rp-inc', 'incremental', 'rp-full')];
  metadataByPoint.get('rp-inc').server.serverUuid = 'server-b';
  assert.throws(() => validateChain(points, metadataByPoint, 'rp-inc'), (error) => error.code === 'MYSQL_PHYSICAL_RESTORE_CHAIN_MISMATCH');
});

class MemoryControlDatabase {
  constructor(records) {
    this.records = Object.fromEntries(Object.entries(records).map(([name, values]) => [name, new Map(values.map((value) => [value.id, { ...value }]))]));
  }

  repository(name) {
    const records = this.records[name] || (this.records[name] = new Map());
    return {
      get: async (_workspaceId, id) => records.get(id) || null,
      list: async () => [...records.values()],
      create: async (value) => {
        const created = { ...value, id: value.id || `restore-${records.size + 1}`, revision: 1 };
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
        const updated = { ...current, ...changes, revision: current.revision + 1 };
        this.records[name].set(id, updated);
        return updated;
      }
    });
  }
}

class RestoreSession {
  constructor(options = {}) {
    this.commands = [];
    this.consumed = [];
    this.closed = false;
    this.datadirEmpty = options.datadirEmpty !== false;
    this.unsafeArchive = Boolean(options.unsafeArchive);
    this.blockConsume = Boolean(options.blockConsume);
    this.consumeEntered = new Promise((resolve) => { this.markConsumeEntered = resolve; });
    this.serviceChecks = 0;
  }

  async run(command) {
    this.commands.push(command);
    if (command.includes("'xtrabackup' '--version'")) return { stdout: 'xtrabackup version 8.4.0-1', stderr: '', exitCode: 0 };
    if (command.includes("'xbstream' '--version'")) return { stdout: 'xbstream version 8.4.0-1', stderr: '', exitCode: 0 };
    if (command.includes("'mktemp'")) return { stdout: '/var/tmp/deployerx-xtrabackup-restore-restore-1.ABC123\n', stderr: '', exitCode: 0 };
    if (command.includes('xtrabackup_checkpoints')) return { stdout: 'backup_type = full-prepared\nfrom_lsn = 0\nto_lsn = 100\nlast_lsn = 110\n', stderr: '', exitCode: 0 };
    if (command.includes("'systemctl' 'show'")) {
      this.serviceChecks += 1;
      return { stdout: this.serviceChecks === 1 ? 'inactive\n' : 'active\n', stderr: '', exitCode: 0 };
    }
    if (command.includes('if find') && this.unsafeArchive) throw Object.assign(new Error('unsafe'), { code: 'SSH_COMMAND_FAILED', exitCode: 42 });
    if (command.includes('test -z') && !this.datadirEmpty) throw Object.assign(new Error('not empty'), { code: 'SSH_COMMAND_FAILED' });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async consume(command, content) {
    this.commands.push(command);
    this.markConsumeEntered();
    if (this.blockConsume) {
      await new Promise((resolve) => this.signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('canceled'), { code: 'SSH_EXECUTION_CANCELED', category: 'canceled' });
    }
    const chunks = [];
    for await (const chunk of content) chunks.push(Buffer.from(chunk));
    this.consumed.push(Buffer.concat(chunks));
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  close() { this.closed = true; }
}

function restoreFixture(options = {}) {
  const source = {
    id: 'source-a', sourceType: 'database', adapterId: ADAPTER_ID, connectionId: 'mysql-a',
    consistency: { backupMethod: 'physical' },
    physicalExecution: {
      sshConnectionId: 'ssh-a', remoteTemporaryDirectory: '/var/tmp', dataDirectory: '/var/lib/mysql',
      serviceName: 'mysql', mysqlOwner: 'mysql', mysqlGroup: 'mysql', privilegeMode: 'sudo-noninteractive',
      xtrabackupExecutable: 'xtrabackup', xbstreamExecutable: 'xbstream', mysqlExecutable: 'mysql'
    }
  };
  const recoveryPoint = { ...point('rp-full', 'full', null), repositoryCopies: [{ repositoryId: 'repo-a', engineSnapshotId: 'snapshot-a', state: 'available' }] };
  const digest = 'a'.repeat(64);
  const artifact = { id: 'artifact-a', kind: 'physical-backup', recoveryPointId: recoveryPoint.id, repositoryId: 'repo-a', sizeBytes: 14, checksum: { algorithm: 'sha256', digest }, metadata: metadata('full-backuped', '0', '100') };
  const mysqlConnection = {
    id: 'mysql-a', adapterId: ADAPTER_ID, endpoint: { host: 'db.example.com', port: 3306, username: 'backup', tlsMode: 'required' },
    secretRefIds: ['sec-mysql'], trust: { fingerprint: 'sha256:mysql' }, workerAffinity: ['device:device-a'],
    lastTest: { status: 'success', endpointIdentity: { serverUuid: 'server-a' } }
  };
  const sshConnection = {
    id: 'ssh-a', adapterId: 'deployerx.connection.ssh', endpoint: { host: 'db.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 },
    secretRefIds: ['sec-ssh'], trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' },
    workerAffinity: ['device:device-a'], lastTest: { status: 'success' }
  };
  const controlDatabase = new MemoryControlDatabase({
    source: [source], connection: [mysqlConnection, sshConnection], recoveryPoint: [recoveryPoint], artifact: [artifact], restoreRun: []
  });
  const session = new RestoreSession(options);
  const repository = {
    engine: {
      openSnapshot: async () => ({ manifest: { files: [{ path: 'mysql/physical-backup.xbstream', type: 'file', sizeBytes: 14, contentDigest: { algorithm: 'sha256', digest }, metadata: { artifactKind: 'physical-backup', database: metadata('full-backuped', '0', '100') } }] } }),
      streamFile: () => Readable.from([Buffer.from('physical-bytes')])
    },
    masterKey: Buffer.alloc(32, 1)
  };
  const mysqlAdapter = {
    normalizeConfig: (config) => config,
    testConnection: async () => ({ status: 'success', endpointIdentity: { serverUuid: 'server-a' } })
  };
  const service = new MysqlPhysicalRestoreService({
    controlDatabase, secretStore: { resolve: async () => 'secret' }, deviceId: 'device-a', mysqlAdapter,
    openRepository: async () => repository, sessionFactory: async ({ signal }) => { session.signal = signal; return session; },
    clock: () => '2026-08-04T12:00:00.000Z'
  });
  return { controlDatabase, service, session };
}

test('physical restore streams, prepares, copies back, repairs ownership, restarts, and validates in order', async () => {
  const { service, session } = restoreFixture();
  const started = await service.start('workspace-a', 'tester', { recoveryPointId: 'rp-full', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original });
  const completed = await service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.result.preparedToLsn, '100');
  assert.equal(session.consumed[0].toString(), 'physical-bytes');
  const index = (fragment) => session.commands.findIndex((command) => command.includes(fragment));
  assert.ok(index("'xtrabackup' '--prepare'") < index("'systemctl' 'stop'"));
  assert.ok(index("'systemctl' 'stop'") < index('test -z'));
  assert.ok(index('test -z') < index("'xtrabackup' '--copy-back'"));
  assert.ok(index("'xtrabackup' '--copy-back'") < index("'chown' '-hR'"));
  assert.ok(index("'chown' '-hR'") < index("'systemctl' 'start'"));
  assert.equal(session.closed, true);
  assert.equal(session.commands.some((command) => command.includes("'rm' '-rf' '--' '/var/tmp/deployerx-xtrabackup-restore-restore-1.ABC123'")), true);
});

test('physical restore refuses a non-empty datadir before copy-back', async () => {
  const { service, session } = restoreFixture({ datadirEmpty: false });
  const started = await service.start('workspace-a', 'tester', { recoveryPointId: 'rp-full', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original });
  const completed = await service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'MYSQL_PHYSICAL_DATADIR_NOT_EMPTY');
  assert.equal(session.commands.some((command) => command.includes("'xtrabackup' '--copy-back'")), false);
  assert.equal(session.closed, true);
});

test('physical restore refuses unsafe extracted file types before prepare', async () => {
  const { service, session } = restoreFixture({ unsafeArchive: true });
  const started = await service.start('workspace-a', 'tester', { recoveryPointId: 'rp-full', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original });
  const completed = await service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'MYSQL_PHYSICAL_ARCHIVE_UNSAFE');
  assert.equal(session.commands.some((command) => command.includes("'xtrabackup' '--prepare'")), false);
  assert.equal(session.commands.some((command) => command.includes("'systemctl' 'stop'")), false);
});

test('physical restore cancellation aborts the active SSH operation and cleans its workspace', async () => {
  const { service, session } = restoreFixture({ blockConsume: true });
  const started = await service.start('workspace-a', 'tester', { recoveryPointId: 'rp-full', mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original });
  await session.consumeEntered;
  const canceled = await service.cancel('workspace-a', 'tester', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.error.code, 'MYSQL_PHYSICAL_RESTORE_CANCELED');
  assert.equal(session.closed, true);
  assert.equal(session.commands.some((command) => command.includes("'rm' '-rf' '--' '/var/tmp/deployerx-xtrabackup-restore-restore-1.ABC123'")), true);
});

test('physical restore reconciles an abandoned run after process restart', async () => {
  const { controlDatabase, service } = restoreFixture();
  const abandoned = await controlDatabase.repository('restoreRun').create({
    workspaceId: 'workspace-a', actorId: 'tester', recoveryPointIds: ['rp-full'], targetConnectionId: 'mysql-a',
    target: { operation: 'physical', mode: 'original', engine: 'mysql', sourceId: 'source-a' }, mode: 'original',
    conflictPolicy: 'overwrite', workerId: 'device:device-a', state: 'running', progress: { phase: 'copy-back' }
  });
  const reconciled = await service.reconcile('workspace-a', 'reconciler');
  const failed = reconciled.find((record) => record.id === abandoned.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result.error.code, 'MYSQL_PHYSICAL_RESTORE_INTERRUPTED');
  assert.equal(failed.result.error.retryable, false);
});
