const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { FileSourceReaderService } = require('./file-source-reader');
const { LocalFolderRepositoryAdapter, ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { NativeProcessError } = require('./native-process');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const { ADAPTER_ID, IDENTITY_SQL, SQLITE_HEADER, SqliteConnectionService, SqliteNativeAdapter, digestFile, parseIdentity, restoreStagePath } = require('./sqlite');
const { RESTORE_CONFIRMATIONS: SQLITE_RESTORE_CONFIRMATIONS, SqliteRestoreService } = require('./sqlite-restore');
const { SqliteSourceReaderService, preparationPrefix } = require('./sqlite-source-reader');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'sqlite-device';
const SEP = '\x1f';

function hex(value) { return Buffer.from(String(value), 'utf8').toString('hex').toUpperCase(); }

function identityOutput(databasePath, options = {}) {
  const lines = [
    ['DX_SQLITE_META', options.version || '3.45.1', options.journalMode || 'wal', '4096', '128', '3', '17', '4', '42'],
    ['DX_SQLITE_DATABASE', '0', hex('main'), hex(databasePath)],
    ...((options.attached || []).map((item, index) => ['DX_SQLITE_DATABASE', String(index + 1), hex(item.name), hex(item.file)])),
    ['DX_SQLITE_OBJECT', 'index', hex('orders_created_at'), hex('orders'), hex('CREATE INDEX orders_created_at ON orders(created_at)')],
    ['DX_SQLITE_OBJECT', 'table', hex('orders'), hex('orders'), hex('CREATE TABLE orders(id INTEGER PRIMARY KEY, created_at TEXT)')],
    ['DX_SQLITE_CHECK', options.quickCheck || 'ok']
  ];
  return `${lines.map((row) => row.join(SEP)).join('\n')}\n`;
}

async function sqliteFile(context, contents = SQLITE_HEADER) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-sqlite-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'orders.sqlite3');
  await fs.writeFile(databasePath, Buffer.concat([Buffer.from(contents), Buffer.alloc(128)]));
  return { root, databasePath };
}

function runnerFor(databasePath, options = {}) {
  const calls = [];
  return {
    calls,
    async run(input) {
      calls.push(structuredClone({ ...input, signal: undefined }));
      assert.equal(input.executable, 'sqlite3');
      assert.deepEqual(input.args.slice(0, 6), ['-batch', '-readonly', '-noheader', '-separator', SEP, databasePath]);
      assert.equal(input.args[6], IDENTITY_SQL);
      assert.equal(input.args.some((argument) => argument.includes(`'${databasePath}'`)), false, 'database path must remain a structured process argument');
      return { exitCode: 0, stdout: identityOutput(databasePath, options), stderr: '' };
    }
  };
}

test('registers SQLite online backup execution without advertising unfinished restore support', () => {
  const adapter = new SqliteNativeAdapter({ processRunner: { async run() { throw new Error('unused'); } } });
  const manifest = new DatabaseAdapterRegistry([adapter]).manifest(ADAPTER_ID);
  assert.equal(manifest.engine, 'sqlite');
  assert.equal(manifest.executionReady, true);
  assert.deepEqual(manifest.capabilities.backupModes, ['full']);
  assert.equal(manifest.capabilities.consistencyStrategies[0].id, 'sqlite-online-backup');
});

function backupRunner() {
  const calls = [];
  return {
    calls,
    async run(input) {
      const databasePath = input.args[5];
      calls.push({ type: 'identity', databasePath, args: [...input.args] });
      return { exitCode: 0, stdout: identityOutput(databasePath), stderr: '' };
    },
    async consume(input) {
      const script = Buffer.from(input.stdin).toString('utf8');
      const match = script.match(/^\.backup main "([^"]+)"\n$/);
      assert.ok(match, `unexpected SQLite backup script: ${script}`);
      const destination = path.normalize(match[1]);
      calls.push({ type: 'backup', args: [...input.args], script, destination });
      await fs.writeFile(destination, Buffer.concat([SQLITE_HEADER, Buffer.alloc(4096, 7)]), { flag: 'wx', mode: 0o600 });
      return { exitCode: 0, stdout: '' };
    }
  };
}

test('tests a canonical WAL database with bounded header, runtime, schema, and quick-check evidence', async (context) => {
  const { databasePath } = await sqliteFile(context);
  const runner = runnerFor(databasePath);
  let now = 1000;
  const adapter = new SqliteNativeAdapter({ processRunner: runner, now: () => { now += 25; return now; }, clock: () => '2026-08-04T12:00:00.000Z' });
  const result = await adapter.testConnection({}, { databasePath, sqliteExecutable: 'sqlite3' });
  assert.equal(result.status, 'success');
  assert.equal(result.remotePlatform.version, '3.45.1');
  assert.equal(result.endpointIdentity.journalMode, 'wal');
  assert.equal(result.endpointIdentity.pageSize, 4096);
  assert.equal(result.endpointIdentity.pageCount, 128);
  assert.equal(result.endpointIdentity.objectCount, 2);
  assert.match(result.endpointIdentity.databaseFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(runner.calls.length, 1);
});

test('discovers the complete main database and exposes objects only as non-selectable validation inventory', async (context) => {
  const { databasePath } = await sqliteFile(context);
  const adapter = new SqliteNativeAdapter({ processRunner: runnerFor(databasePath) });
  const databasePages = [];
  for await (const page of adapter.discover({}, { connection: { databasePath }, kind: 'database' })) databasePages.push(page);
  assert.deepEqual(databasePages[0].items, [{ name: 'main', kind: 'database', selectable: true, path: databasePath, objectCount: 2 }]);
  const objectPages = [];
  for await (const page of adapter.discover({}, { connection: { databasePath }, kind: 'table' })) objectPages.push(page);
  assert.deepEqual(objectPages[0].items.map((item) => ({ name: item.name, type: item.objectType, selectable: item.selectable })), [
    { name: 'orders_created_at', type: 'index', selectable: false },
    { name: 'orders', type: 'table', selectable: false }
  ].filter((item) => ['table', 'view'].includes(item.type)));
});

test('rejects encrypted or non-SQLite headers before invoking the native runtime', async (context) => {
  const { databasePath } = await sqliteFile(context, Buffer.from('encrypted-header!'));
  const runner = runnerFor(databasePath);
  const adapter = new SqliteNativeAdapter({ processRunner: runner });
  const result = await adapter.testConnection({}, { databasePath });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'SQLITE_HEADER_INVALID');
  assert.equal(result.error.category, 'compatibility');
  assert.equal(runner.calls.length, 0);
});

test('fails closed on attached databases and integrity divergence', async (context) => {
  const { databasePath, root } = await sqliteFile(context);
  const attachedPath = path.join(root, 'audit.sqlite3');
  assert.throws(() => parseIdentity(identityOutput(databasePath, { attached: [{ name: 'audit', file: attachedPath }] }), databasePath), (error) => error.code === 'SQLITE_ATTACHED_DATABASES_UNSUPPORTED');
  assert.throws(() => parseIdentity(identityOutput(databasePath, { quickCheck: 'database disk image is malformed' }), databasePath), (error) => error.code === 'SQLITE_INTEGRITY_CHECK_FAILED');
  assert.throws(() => parseIdentity(identityOutput(databasePath, { version: '3.37.2' }), databasePath), (error) => error.code === 'SQLITE_VERSION_UNSUPPORTED');
});

test('persists, tests, and discovers a device-scoped SQLite connection without SecretRefs', async (context) => {
  const { root, databasePath } = await sqliteFile(context);
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const runner = runnerFor(databasePath);
  const adapter = new SqliteNativeAdapter({ processRunner: runner, clock: () => '2026-08-04T12:00:00.000Z' });
  const service = new SqliteConnectionService({ controlDatabase, deviceId: DEVICE_ID, adapter });
  const plaintextMarker = 'must-not-persist-sqlite-secret';
  const created = await service.create(WORKSPACE_ID, 'tester', { name: 'Orders SQLite', databasePath, password: plaintextMarker, token: plaintextMarker, secretRefIds: [plaintextMarker] });
  assert.equal(created.adapterId, ADAPTER_ID);
  assert.deepEqual(created.secretRefIds, []);
  assert.doesNotMatch(JSON.stringify(created), new RegExp(plaintextMarker));
  assert.deepEqual(created.workerAffinity, [`device:${DEVICE_ID}`]);
  const tested = await service.test(WORKSPACE_ID, created.id, 'tester');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.trust.fingerprint, tested.result.endpointIdentity.databaseFingerprint);
  const discovered = await service.discover(WORKSPACE_ID, created.id);
  assert.equal(discovered.items[0].name, 'main');
  const [listed] = await service.list(WORKSPACE_ID);
  assert.equal(listed.currentDevice, true);
  assert.equal(listed.endpoint.databasePath, databasePath);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(plaintextMarker));
});

test('creates one fsynced validated online image, reuses it across reads, and publishes an encrypted recovery point', async (context) => {
  const { root, databasePath } = await sqliteFile(context);
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control-media') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const runner = backupRunner();
  const adapter = new SqliteNativeAdapter({ processRunner: runner, temporaryRoot: path.join(root, 'adapter-temp'), clock: () => '2026-08-04T12:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new SqliteConnectionService({ controlDatabase, deviceId: DEVICE_ID, adapter });
  const created = await connections.create(WORKSPACE_ID, 'tester', { name: 'Orders SQLite', databasePath });
  const { connection } = await connections.test(WORKSPACE_ID, created.id, 'tester');
  const source = await new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, deviceId: DEVICE_ID }).save(WORKSPACE_ID, 'tester', {
    name: 'Orders SQLite', connectionId: connection.id, selector: { databases: { include: [{ name: 'main' }] } },
    consistency: { requestedLevel: 'application', method: 'sqlite-online-backup', backupMethod: 'logical', backupMode: 'full' }
  });
  const temporaryRoot = path.join(root, 'source-temp');
  const reader = new SqliteSourceReaderService({ controlDatabase, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, temporaryRoot });
  const first = await reader.files(WORKSPACE_ID, source.id, { executionId: 'run-sqlite-1', backupMode: 'full' });
  const firstFiles = [];
  for await (const item of first.create()) {
    const chunks = [];
    for await (const chunk of item.content) chunks.push(Buffer.from(chunk));
    firstFiles.push({ path: item.path, bytes: Buffer.concat(chunks), metadata: item.metadata });
  }
  const second = await reader.files(WORKSPACE_ID, source.id, { executionId: 'run-sqlite-1', backupMode: 'full' });
  for await (const item of second.create()) for await (const _chunk of item.content) {}
  assert.equal(firstFiles.length, 1);
  assert.equal(firstFiles[0].path, 'sqlite/database.sqlite3');
  assert.equal(firstFiles[0].bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER), true);
  assert.match(first.manifest.database.artifact.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.manifest.database.protectedIdentity.quickCheck, 'ok');
  assert.equal(runner.calls.filter((call) => call.type === 'backup').length, 1);
  assert.equal(runner.calls.find((call) => call.type === 'backup').args.includes(databasePath), true);
  await reader.release(WORKSPACE_ID, 'run-sqlite-1');
  assert.deepEqual(await fs.readdir(temporaryRoot), []);

  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot, { recursive: true });
  const repository = await controlDatabase.repository('repository').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'SQLite repository', connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'sqlite-test-key-v1' }, workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 9);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const { job } = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', {
    name: 'SQLite protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full', verifyAfterBackup: true
  });
  const sourceReader = new BackupSourceReaderRouter({
    controlDatabase,
    fileReader: new FileSourceReaderService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID }),
    databaseReaders: { [ADAPTER_ID]: reader }
  });
  const service = new ManualBackupService({
    controlDatabase, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID,
    openRepository: async () => ({ repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'sqlite-test-key-v1' })
  });
  const started = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(started.id);
  const completed = await controlDatabase.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  const [point] = await controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  assert.equal(point.type, 'full');
  assert.equal(point.consistency, 'application');
  const databaseArtifact = (await controlDatabase.repository('artifact').list(WORKSPACE_ID, { limit: 20 })).find((item) => item.kind === 'database-dump');
  assert.ok(databaseArtifact);
  assert.equal(databaseArtifact.metadata.kind, 'sqlite-online-backup');
  const snapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey });
  const chunks = [];
  for await (const chunk of engine.streamFile({}, { repositoryId: repository.id, manifest: snapshot.manifest, masterKey, path: 'sqlite/database.sqlite3' })) chunks.push(Buffer.from(chunk));
  const protectedBytes = Buffer.concat(chunks);
  assert.equal(protectedBytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER), true);
  assert.equal(runner.calls.filter((call) => call.type === 'backup').length, 2);
  assert.deepEqual(await fs.readdir(temporaryRoot), []);

  const restoreService = new SqliteRestoreService({
    controlDatabase, deviceId: DEVICE_ID, adapter,
    openRepository: async () => ({ repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'sqlite-test-key-v1' })
  });
  const targetPath = path.join(root, 'recovered.sqlite3');
  const restore = await restoreService.start(WORKSPACE_ID, 'tester', {
    recoveryPointId: point.id, mode: 'alternate', targetPath, confirmed: true, confirmationText: SQLITE_RESTORE_CONFIRMATIONS.alternate
  });
  const restored = await restoreService.wait(WORKSPACE_ID, restore.id);
  assert.equal(restored.state, 'succeeded', JSON.stringify(restored.result));
  assert.equal(restored.validation.nativeIntegrityValidation, true);
  assert.match(restored.validation.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await fs.readFile(targetPath)).equals(protectedBytes), true);
  assert.equal(await fs.lstat(`${targetPath}.deployerx-sqlite-stage-invalid`).catch(() => null), null);
  await assert.rejects(restoreService.start(WORKSPACE_ID, 'tester', {
    recoveryPointId: point.id, mode: 'alternate', targetPath, confirmed: true, confirmationText: SQLITE_RESTORE_CONFIRMATIONS.alternate
  }), (error) => error.code === 'SQLITE_RESTORE_TARGET_EXISTS');

  let streamStartedResolve;
  const streamStarted = new Promise((resolve) => { streamStartedResolve = resolve; });
  let streamAbortObserved = false;
  const blockingEngine = {
    openSnapshot: (context, input) => engine.openSnapshot(context, input),
    streamFile(context) {
      return (async function* blockedRepositoryStream() {
        streamStartedResolve();
        await new Promise((resolve) => {
          if (context.signal?.aborted) resolve();
          else context.signal?.addEventListener('abort', resolve, { once: true });
        });
        streamAbortObserved = context.signal?.aborted === true;
        throw new Error('repository stream canceled');
      })();
    }
  };
  const cancelRestoreService = new SqliteRestoreService({
    controlDatabase, deviceId: DEVICE_ID, adapter,
    openRepository: async () => ({ repository, adapter: repositoryAdapter, engine: blockingEngine, masterKey, keyVersion: 'sqlite-test-key-v1' })
  });
  const canceledTarget = path.join(root, 'canceled-service.sqlite3');
  const cancelStarted = await cancelRestoreService.start(WORKSPACE_ID, 'tester', {
    recoveryPointId: point.id, mode: 'alternate', targetPath: canceledTarget, confirmed: true, confirmationText: SQLITE_RESTORE_CONFIRMATIONS.alternate
  });
  await streamStarted;
  const canceledRestore = await cancelRestoreService.cancel(WORKSPACE_ID, 'tester', cancelStarted.id);
  assert.equal(streamAbortObserved, true);
  assert.equal(canceledRestore.state, 'canceled');
  assert.equal(canceledRestore.result.error.code, 'SQLITE_RESTORE_CANCELED');
  assert.equal(await fs.lstat(canceledTarget).catch(() => null), null);

  let publicationLinked = false;
  let publicationCleanupFailed = false;
  const uncertainFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'link') return async (stagePath, publishedPath) => {
        await fs.link(stagePath, publishedPath);
        publicationLinked = true;
      };
      if (property === 'rm') return async (filePath, options) => {
        if (publicationLinked && !publicationCleanupFailed && String(filePath).includes('.deployerx-sqlite-stage-')) {
          publicationCleanupFailed = true;
          throw Object.assign(new Error('simulated stage cleanup failure'), { code: 'EIO' });
        }
        return fs.rm(filePath, options);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const uncertainAdapter = new SqliteNativeAdapter({ processRunner: runner, fileSystem: uncertainFileSystem });
  const uncertainRestoreService = new SqliteRestoreService({
    controlDatabase, deviceId: DEVICE_ID, adapter: uncertainAdapter, fileSystem: uncertainFileSystem,
    openRepository: async () => ({ repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'sqlite-test-key-v1' })
  });
  const uncertainTarget = path.join(root, 'uncertain-publication.sqlite3');
  const uncertainStarted = await uncertainRestoreService.start(WORKSPACE_ID, 'tester', {
    recoveryPointId: point.id, mode: 'alternate', targetPath: uncertainTarget, confirmed: true, confirmationText: SQLITE_RESTORE_CONFIRMATIONS.alternate
  });
  const uncertainRestore = await uncertainRestoreService.wait(WORKSPACE_ID, uncertainStarted.id);
  assert.equal(uncertainRestore.state, 'failed');
  assert.equal(uncertainRestore.progress.phase, 'operator-action-required');
  assert.equal(uncertainRestore.result.error.code, 'SQLITE_RESTORE_PUBLICATION_UNCERTAIN');
  assert.equal((await fs.readFile(uncertainTarget)).equals(protectedBytes), true);
  assert.equal(await fs.lstat(restoreStagePath(uncertainTarget, uncertainRestore.id)).catch(() => null), null);

  const interruptedTarget = path.join(root, 'interrupted.sqlite3');
  const interrupted = await controlDatabase.repository('restoreRun').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
    target: { operation: 'alternate-file', mode: 'alternate', engine: 'sqlite', sourceId: source.id, connectionId: connection.id, targetPath: interruptedTarget, targetName: path.basename(interruptedTarget) },
    mode: 'alternate', conflictPolicy: 'fail', workerId: `device:${DEVICE_ID}`, state: 'running',
    progress: { phase: 'running', itemsTotal: 1, itemsCompleted: 0, bytesTotal: protectedBytes.length, bytesWritten: 10, throughputBytesPerSecond: 0, startedAt: '2026-08-04T12:00:00.000Z', updatedAt: '2026-08-04T12:00:00.000Z', warnings: [] }, validation: null, result: null
  });
  const interruptedStage = restoreStagePath(interruptedTarget, interrupted.id);
  await fs.writeFile(interruptedStage, protectedBytes.subarray(0, 10), { flag: 'wx', mode: 0o600 });
  const [reconciled] = await restoreService.reconcile(WORKSPACE_ID, 'tester');
  assert.equal(reconciled.state, 'failed');
  assert.equal(reconciled.progress.phase, 'operator-action-required');
  assert.equal(reconciled.result.error.code, 'SQLITE_RESTORE_PROCESS_INTERRUPTED');
  assert.doesNotMatch(JSON.stringify(reconciled.result), new RegExp(interruptedTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.equal(await fs.lstat(interruptedStage).catch(() => null), null);
  assert.deepEqual(await restoreService.reconcile(WORKSPACE_ID, 'tester'), []);
  assert.equal((await controlDatabase.repository('restoreRun').get(WORKSPACE_ID, restored.id)).revision, restored.revision);

  const pagedTarget = path.join(root, 'paged-interrupted.sqlite3');
  const pagedInterrupted = await controlDatabase.repository('restoreRun').create({
    id: 'restore_000_sqlite_paged', workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
    target: { operation: 'alternate-file', mode: 'alternate', engine: 'sqlite', sourceId: source.id, connectionId: connection.id, targetPath: pagedTarget, targetName: path.basename(pagedTarget) },
    mode: 'alternate', conflictPolicy: 'fail', workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'running' }, validation: null, result: null
  });
  const otherDevice = await controlDatabase.repository('restoreRun').create({
    id: 'restore_yyy_sqlite_other_device', workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
    target: { operation: 'alternate-file', mode: 'alternate', engine: 'sqlite', targetPath: path.join(root, 'other-device.sqlite3'), targetName: 'other-device.sqlite3' },
    mode: 'alternate', conflictPolicy: 'fail', workerId: 'device:another-device', state: 'running', progress: { phase: 'running' }, validation: null, result: null
  });
  await controlDatabase.transaction((transaction) => {
    for (let index = 0; index < 205; index += 1) transaction.create('restoreRun', {
      id: `restore_zzz_foreign_${String(index).padStart(3, '0')}`, workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
      target: { operation: 'database-restore', mode: 'alternate', engine: 'mysql' }, mode: 'alternate', conflictPolicy: 'fail',
      workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'running' }, validation: null, result: null
    });
  });
  const pagedRecovery = await restoreService.reconcile(WORKSPACE_ID, 'tester');
  assert.deepEqual(pagedRecovery.map((record) => record.id), [pagedInterrupted.id]);
  assert.equal((await controlDatabase.repository('restoreRun').get(WORKSPACE_ID, otherDevice.id)).state, 'running');
  assert.equal((await controlDatabase.repository('restoreRun').get(WORKSPACE_ID, 'restore_zzz_foreign_000')).state, 'running');
});

test('preserves a concurrently created restore target and removes only owned staging', async (context) => {
  const { root } = await sqliteFile(context);
  const restoreBytes = Buffer.concat([SQLITE_HEADER, Buffer.alloc(4096, 5)]);
  const targetPath = path.join(root, 'concurrent-target.sqlite3');
  const competingBytes = Buffer.from('created by another process');
  const runner = { async run(input) { return { exitCode: 0, stdout: identityOutput(input.args[5]), stderr: '' }; } };
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'link') return async (stagePath, publishedPath) => {
        await fs.writeFile(publishedPath, competingBytes, { flag: 'wx', mode: 0o600 });
        return fs.link(stagePath, publishedPath);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const adapter = new SqliteNativeAdapter({ processRunner: runner, fileSystem });
  const plan = await adapter.planRestore({}, {
    mode: 'alternate', confirmation: 'RESTORE_SQLITE_ALTERNATE', targetPath, executionId: 'restore-target-race',
    sqliteExecutable: 'sqlite3', timeoutMs: 30000, sizeBytes: restoreBytes.length,
    contentDigest: `sha256:${crypto.createHash('sha256').update(restoreBytes).digest('hex')}`,
    protectedIdentity: { pageSize: 4096, schemaVersion: 17, userVersion: 4, applicationId: 42, objectCount: 2, schemaFingerprint: parseIdentity(identityOutput(targetPath), targetPath).schemaFingerprint }
  });
  const content = async function* concurrentContent() { yield restoreBytes; };
  await assert.rejects(adapter.executeRestore({}, plan, { async open() { return content(); } }), (error) => error.code === 'SQLITE_RESTORE_TARGET_EXISTS');
  assert.deepEqual(await fs.readFile(targetPath), competingBytes);
  assert.equal(await fs.lstat(plan.stagePath).catch(() => null), null);
});

test('does not remove a staging file that the restore execution did not create', async (context) => {
  const { root } = await sqliteFile(context);
  const restoreBytes = Buffer.concat([SQLITE_HEADER, Buffer.alloc(4096, 6)]);
  const targetPath = path.join(root, 'stage-owner-target.sqlite3');
  const foreignStageBytes = Buffer.from('owned by an active recovery');
  const runner = { async run(input) { return { exitCode: 0, stdout: identityOutput(input.args[5]), stderr: '' }; } };
  const adapter = new SqliteNativeAdapter({ processRunner: runner });
  const plan = await adapter.planRestore({}, {
    mode: 'alternate', confirmation: 'RESTORE_SQLITE_ALTERNATE', targetPath, executionId: 'restore-stage-owner',
    sqliteExecutable: 'sqlite3', timeoutMs: 30000, sizeBytes: restoreBytes.length,
    contentDigest: `sha256:${crypto.createHash('sha256').update(restoreBytes).digest('hex')}`,
    protectedIdentity: { pageSize: 4096, schemaVersion: 17, userVersion: 4, applicationId: 42, objectCount: 2, schemaFingerprint: parseIdentity(identityOutput(targetPath), targetPath).schemaFingerprint }
  });
  await fs.writeFile(plan.stagePath, foreignStageBytes, { flag: 'wx', mode: 0o600 });
  await assert.rejects(adapter.executeRestore({}, plan, { async open() { throw new Error('must not read repository media'); } }), (error) => error.code === 'SQLITE_RESTORE_STAGE_BUSY' && error.retryable === true);
  assert.deepEqual(await fs.readFile(plan.stagePath), foreignStageBytes);
  assert.equal(await fs.lstat(targetPath).catch(() => null), null);
});

test('fails closed with safe restore probe, commit-lock, and native-lock diagnostics', async (context) => {
  const { root } = await sqliteFile(context);
  const restoreBytes = Buffer.concat([SQLITE_HEADER, Buffer.alloc(4096, 8)]);
  const digest = `sha256:${crypto.createHash('sha256').update(restoreBytes).digest('hex')}`;
  const requestFor = (targetPath, executionId) => ({
    mode: 'alternate', confirmation: 'RESTORE_SQLITE_ALTERNATE', targetPath, executionId,
    sqliteExecutable: 'sqlite3', timeoutMs: 30000, sizeBytes: restoreBytes.length, contentDigest: digest,
    protectedIdentity: { pageSize: 4096, schemaVersion: 17, userVersion: 4, applicationId: 42, objectCount: 2, schemaFingerprint: parseIdentity(identityOutput(targetPath), targetPath).schemaFingerprint }
  });
  const runner = { async run(input) { return { exitCode: 0, stdout: identityOutput(input.args[5]), stderr: '' }; } };
  const probeTarget = path.join(root, 'private-probe-target.sqlite3');
  const deniedFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstat') return async (filePath) => {
        if (path.normalize(filePath) === path.normalize(probeTarget)) throw Object.assign(new Error(`access denied: ${filePath}`), { code: 'EACCES' });
        return fs.lstat(filePath);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const deniedAdapter = new SqliteNativeAdapter({ processRunner: runner, fileSystem: deniedFileSystem });
  await assert.rejects(deniedAdapter.planRestore({}, requestFor(probeTarget, 'restore-probe-denied')), (error) => {
    assert.equal(error.code, 'SQLITE_RESTORE_PATH_ACCESS_DENIED');
    assert.doesNotMatch(error.message, new RegExp(probeTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    return true;
  });

  const busyTarget = path.join(root, 'busy-link-target.sqlite3');
  const busyFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'link') return async () => { throw Object.assign(new Error('target busy'), { code: 'EBUSY' }); };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const busyAdapter = new SqliteNativeAdapter({ processRunner: runner, fileSystem: busyFileSystem });
  const busyPlan = await busyAdapter.planRestore({}, requestFor(busyTarget, 'restore-link-busy'));
  await assert.rejects(busyAdapter.executeRestore({}, busyPlan, { async open() { return (async function* content() { yield restoreBytes; })(); } }), (error) => error.code === 'SQLITE_RESTORE_TARGET_BUSY' && error.retryable === true);
  assert.equal(await fs.lstat(busyPlan.stagePath).catch(() => null), null);
  assert.equal(await fs.lstat(busyTarget).catch(() => null), null);

  const nativeTarget = path.join(root, 'native-lock-target.sqlite3');
  const nativeRunner = { async run(input) { throw new NativeProcessError('NATIVE_PROCESS_FAILED', 'native failure', { stderr: `Error: database schema is locked: ${input.args[5]}` }); } };
  const nativeAdapter = new SqliteNativeAdapter({ processRunner: nativeRunner });
  const nativePlan = await nativeAdapter.planRestore({}, requestFor(nativeTarget, 'restore-native-locked'));
  await assert.rejects(nativeAdapter.executeRestore({}, nativePlan, { async open() { return (async function* content() { yield restoreBytes; })(); } }), (error) => {
    assert.equal(error.code, 'SQLITE_RESTORE_DATABASE_BUSY');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, new RegExp(nativeTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    return true;
  });
  assert.equal(await fs.lstat(nativePlan.stagePath).catch(() => null), null);
  assert.equal(await fs.lstat(nativeTarget).catch(() => null), null);

  const digestController = new AbortController();
  let digestClosed = false;
  const digestFileSystem = {
    async open() {
      return {
        async read(buffer) {
          buffer.fill(1, 0, 16);
          digestController.abort();
          return { bytesRead: 16 };
        },
        async close() { digestClosed = true; }
      };
    }
  };
  await assert.rejects(digestFile(digestFileSystem, nativeTarget, { signal: digestController.signal, canceledCode: 'SQLITE_RESTORE_CANCELED', canceledMessage: 'The SQLite recovery was canceled.' }), (error) => error.code === 'SQLITE_RESTORE_CANCELED');
  assert.equal(digestClosed, true);
});

test('classifies a locked SQLite source as retryable without leaking native paths', async (context) => {
  const { root, databasePath } = await sqliteFile(context);
  const privatePath = path.join(root, 'private-customer-path.sqlite3');
  const runner = {
    async run(input) { return { exitCode: 0, stdout: identityOutput(input.args[5]), stderr: '' }; },
    async consume(input) {
      const destination = path.normalize(Buffer.from(input.stdin).toString('utf8').match(/^\.backup main "([^"]+)"\n$/)[1]);
      await fs.writeFile(destination, Buffer.concat([SQLITE_HEADER, Buffer.alloc(64)]), { flag: 'wx', mode: 0o600 });
      throw new NativeProcessError('NATIVE_PROCESS_FAILED', 'native failure', { stderr: `Error: database is locked: ${privatePath}` });
    }
  };
  const adapter = new SqliteNativeAdapter({ processRunner: runner });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const prepared = await registry.prepareBackup(ADAPTER_ID, {}, {
    connection: { databasePath }, selector: { databases: { include: [{ name: 'main' }] } },
    consistency: { requestedLevel: 'application', method: 'sqlite-online-backup', backupMethod: 'logical', backupMode: 'full' }
  });
  const destination = path.join(root, 'locked-partial.sqlite3');
  await assert.rejects(adapter.createBackupMedia({}, prepared.adapterPlan, destination), (error) => {
    assert.equal(error.code, 'SQLITE_BACKUP_SOURCE_BUSY');
    assert.equal(error.category, 'conflict');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, new RegExp(privatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    return true;
  });
  assert.equal(await fs.lstat(destination).catch(() => null), null);
});

test('removes partial media on native cancellation and reconciles only exact-owned run directories', async (context) => {
  const { root, databasePath } = await sqliteFile(context);
  const runner = {
    async run(input) { return { exitCode: 0, stdout: identityOutput(input.args[5]), stderr: '' }; },
    async consume(input) {
      const destination = path.normalize(Buffer.from(input.stdin).toString('utf8').match(/^\.backup main "([^"]+)"\n$/)[1]);
      await fs.writeFile(destination, Buffer.concat([SQLITE_HEADER, Buffer.alloc(256)]), { flag: 'wx', mode: 0o600 });
      throw new NativeProcessError('NATIVE_PROCESS_CANCELED', 'canceled', { category: 'canceled' });
    }
  };
  const adapter = new SqliteNativeAdapter({ processRunner: runner, clock: () => '2026-08-04T12:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const prepared = await registry.prepareBackup(ADAPTER_ID, {}, {
    connection: { databasePath }, selector: { databases: { include: [{ name: 'main' }] } },
    consistency: { requestedLevel: 'application', method: 'sqlite-online-backup', backupMethod: 'logical', backupMode: 'full' }
  });
  const destination = path.join(root, 'partial.sqlite3');
  await assert.rejects(adapter.createBackupMedia({}, prepared.adapterPlan, destination), (error) => error.code === 'SQLITE_BACKUP_CANCELED');
  assert.equal(await fs.lstat(destination).catch(() => null), null);

  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control-reconcile') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const temporaryRoot = path.join(root, 'reconcile-temp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const run = { id: 'run-reconcile-1', sourceLease: null };
  const ownedDirectory = await fs.mkdtemp(path.join(temporaryRoot, preparationPrefix(WORKSPACE_ID, run.id)));
  await fs.writeFile(path.join(ownedDirectory, '.owner.json'), JSON.stringify({ version: 1, workspaceId: WORKSPACE_ID, executionId: run.id }));
  const foreignDirectory = await fs.mkdtemp(path.join(temporaryRoot, preparationPrefix(WORKSPACE_ID, run.id)));
  await fs.writeFile(path.join(foreignDirectory, '.owner.json'), JSON.stringify({ version: 1, workspaceId: WORKSPACE_ID, executionId: 'another-run' }));
  const reader = new SqliteSourceReaderService({ controlDatabase, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, temporaryRoot });
  const reconciled = await reader.reconcileRun(WORKSPACE_ID, run);
  assert.equal(reconciled.proven, true);
  assert.equal(reconciled.removedTemporaryDirectories, 1);
  assert.equal(await fs.lstat(ownedDirectory).catch(() => null), null);
  assert.equal((await fs.lstat(foreignDirectory)).isDirectory(), true);

  const restoreBytes = Buffer.concat([SQLITE_HEADER, Buffer.alloc(4096, 3)]);
  const restoreTarget = path.join(root, 'canceled-restore.sqlite3');
  const restoreController = new AbortController();
  const restorePlan = await adapter.planRestore({}, {
    mode: 'alternate', confirmation: 'RESTORE_SQLITE_ALTERNATE', targetPath: restoreTarget, executionId: 'restore-cancel-1',
    sqliteExecutable: 'sqlite3', timeoutMs: 30000, sizeBytes: restoreBytes.length,
    contentDigest: `sha256:${crypto.createHash('sha256').update(restoreBytes).digest('hex')}`,
    protectedIdentity: { pageSize: 4096, schemaVersion: 17, userVersion: 4, applicationId: 42, objectCount: 2, schemaFingerprint: parseIdentity(identityOutput(restoreTarget), restoreTarget).schemaFingerprint }
  });
  const content = async function* canceledContent() {
    yield restoreBytes.subarray(0, 512);
    restoreController.abort();
    yield restoreBytes.subarray(512);
  };
  await assert.rejects(adapter.executeRestore({ signal: restoreController.signal }, restorePlan, { async open() { return content(); } }), (error) => error.code === 'SQLITE_RESTORE_CANCELED');
  assert.equal(await fs.lstat(restoreTarget).catch(() => null), null);
  assert.equal(await fs.lstat(restorePlan.stagePath).catch(() => null), null);
});

test('registers audited desktop IPC, preload APIs, and the SQLite source reader route', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8')
  ]);
  assert.match(mainSource, /new DatabaseAdapterRegistry\(\[[^\]]*sqliteAdapter\]\)/);
  assert.match(mainSource, /new SqliteConnectionService\(\{ controlDatabase, deviceId: backupDeviceId, adapter: sqliteAdapter \}\)/);
  assert.match(mainSource, /\[SQLITE_ADAPTER_ID\]: sqliteSourceReader/);
  for (const operation of ['list', 'create', 'test', 'discover']) {
    assert.equal(mainSource.includes(`ipcMain.handle('backup:connections:sqlite:${operation}'`), true);
  }
  assert.equal(mainSource.includes("action: 'connection.create-sqlite'"), true);
  assert.equal(mainSource.includes("action: 'connection.test-sqlite'"), true);
  const connectionAudit = mainSource.split(/\r?\n/).find((line) => line.includes("action: 'connection.create-sqlite'"));
  assert.doesNotMatch(connectionAudit, /databasePath|sqliteExecutable|password|token|secretRef/i);
  assert.equal(preloadSource.includes("listBackupSqliteConnections: () => ipcRenderer.invoke('backup:connections:sqlite:list')"), true);
  assert.equal(preloadSource.includes("createBackupSqliteConnection: (payload) => ipcRenderer.invoke('backup:connections:sqlite:create', payload)"), true);
  assert.equal(preloadSource.includes("testBackupSqliteConnection: (id) => ipcRenderer.invoke('backup:connections:sqlite:test', { id })"), true);
  assert.equal(preloadSource.includes("discoverBackupSqliteDatabases: (id, payload = {}) => ipcRenderer.invoke('backup:connections:sqlite:discover', { id, ...payload })"), true);
  for (const operation of ['list', 'start', 'wait', 'cancel']) assert.equal(mainSource.includes(`ipcMain.handle('backup:sqlite-restores:${operation}'`), true);
  const restoreAudit = mainSource.split(/\r?\n/).find((line) => line.includes("action: 'restore.start-sqlite-alternate'"));
  assert.match(restoreAudit, /targetName: path\.basename/);
  assert.doesNotMatch(restoreAudit, /targetPath\s*:/);
  assert.equal(preloadSource.includes("startBackupSqliteRestore: (payload) => ipcRenderer.invoke('backup:sqlite-restores:start', payload)"), true);
  assert.equal(preloadSource.includes("cancelBackupSqliteRestore: (restoreRunId) => ipcRenderer.invoke('backup:sqlite-restores:cancel'"), true);
});
