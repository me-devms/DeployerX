const assert = require('node:assert/strict');
const test = require('node:test');
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
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { ADAPTER_ID, Neo4jAdapter, Neo4jConnectionService } = require('./neo4j');
const { AGGREGATION_CONFIRMATION, Neo4jAggregationService } = require('./neo4j-aggregation');
const { Neo4jRestoreService, RESTORE_CONFIRMATION } = require('./neo4j-restore');
const { Neo4jSourceReaderService, preparationPrefix } = require('./neo4j-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'neo4j-device';
const DUMP_BYTES = Buffer.from('authenticated-neo4j-community-offline-dump');

function databaseOutput(status = 'offline') {
  return [
    'name\ttype\taccess\tcurrentStatus\trequestedStatus\trole\twriter\tdefault\thome\tdatabaseID\tserverID\tconstituents',
    `neo4j\tstandard\tread-write\t${status}\t${status}\tprimary\ttrue\ttrue\ttrue\tdb-neo4j\tserver-a\tnull`,
    'system\tsystem\tread-write\tonline\tonline\tprimary\ttrue\tfalse\tfalse\tdb-system\tserver-a\tnull'
  ].join('\n');
}

function nativeRunner(state = {}) {
  const calls = [];
  const run = async ({ executable, args }) => {
    const name = String(executable).replace(/\\/g, '/').split('/').at(-1);
    calls.push({ name, args: args.slice() });
    if (name === 'neo4j') return { stdout: 'neo4j 5.26.2\n', stderr: '', exitCode: 0 };
    if (name === 'neo4j-admin') {
      if (args[0] === '--version') return { stdout: 'neo4j-admin 5.26.2\n', stderr: '', exitCode: 0 };
      if (args[0] === 'database' && args[1] === 'dump') {
        const directory = args.find((item) => item.startsWith('--to-path=')).slice('--to-path='.length);
        await fs.writeFile(path.join(directory, `${args[2]}.dump`), DUMP_BYTES, { flag: 'wx', mode: 0o600 });
        return { stdout: 'Dump completed successfully\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'database' && args[1] === 'info') return { stdout: `Database name: ${args.at(-1)}\nStore format: aligned\n`, stderr: '', exitCode: 0 };
    }
    if (name !== 'cypher-shell') throw new Error(`Unexpected executable: ${name}`);
    const statement = args.at(-1);
    if (statement.startsWith('CALL dbms.components')) return { stdout: 'name\tversion\tedition\nNeo4j Kernel\t5.26.2\tcommunity\n', stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW DATABASES')) return { stdout: `${databaseOutput(state.databaseStatus || 'offline')}\n`, stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW SERVERS')) throw Object.assign(new Error('unsupported'), { exitCode: 1 });
    throw new Error(`Unexpected Cypher statement: ${statement}`);
  };
  run.calls = calls;
  return run;
}

function enterpriseOnlineRunner(results, aggregateResult = null) {
  const calls = [];
  let backupIndex = 0;
  const byName = new Map([...results, ...(aggregateResult ? [aggregateResult] : [])].map((result) => [result.fileName, result]));
  const run = async ({ executable, args }) => {
    const name = String(executable).replace(/\\/g, '/').split('/').at(-1);
    calls.push({ name, args: args.slice() });
    if (name === 'neo4j') return { stdout: 'neo4j 2026.06.1\n', stderr: '', exitCode: 0 };
    if (name === 'neo4j-admin') {
      if (args[0] === '--version') return { stdout: 'neo4j-admin 2026.06.1\n', stderr: '', exitCode: 0 };
      if (args[0] === 'backup' && args[1] === 'aggregate') {
        if (!aggregateResult) throw new Error('Unexpected Neo4j aggregation.');
        const directory = args.find((item) => item.startsWith('--from-path=')).slice('--from-path='.length);
        assert.equal(args.includes('--keep-old-backup=true'), true);
        assert.equal(args.some((item) => item.startsWith('--temp-path=')), true);
        assert.deepEqual((await fs.readdir(directory)).filter((entry) => entry.endsWith('.backup')).sort(), ['neo4j-diff-002.backup', 'neo4j-full-001.backup']);
        await fs.writeFile(path.join(directory, aggregateResult.fileName), aggregateResult.bytes, { flag: 'wx', mode: 0o600 });
        return { stdout: 'Aggregation completed successfully\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'database' && args[1] === 'backup' && args.some((item) => item.startsWith('--inspect-path='))) {
        const inspectedPath = args.find((item) => item.startsWith('--inspect-path=')).slice('--inspect-path='.length);
        const result = byName.get(path.basename(inspectedPath));
        if (!result) throw new Error(`Unexpected inspected backup: ${inspectedPath}`);
        return { stdout: [
          'Database name: neo4j',
          'Database ID: db-neo4j',
          `Backup type: ${result.type}`,
          `Backup time: ${result.backupTime}`,
          `Lowest transaction ID: ${result.lowest}`,
          `Highest transaction ID: ${result.highest}`,
          'Store format: aligned'
        ].join('\n'), stderr: '', exitCode: 0 };
      }
      if (args[0] === 'database' && args[1] === 'backup') {
        const result = results[backupIndex++];
        if (!result) throw new Error('Unexpected extra Neo4j online backup.');
        const directory = args.find((item) => item.startsWith('--to-path=')).slice('--to-path='.length);
        const existing = (await fs.readdir(directory)).filter((entry) => entry.endsWith('.backup'));
        assert.equal(existing.length, result.expectedParents);
        assert.equal(args.includes(`--type=${result.requestedType}`), true);
        assert.equal(args.includes('--from=neo-a.example.com:6362'), true);
        assert.equal(args.includes('--prefer-diff-as-parent'), result.requestedType === 'DIFF');
        await fs.writeFile(path.join(directory, result.fileName), result.bytes, { flag: 'wx', mode: 0o600 });
        return { stdout: 'Backup completed successfully\n', stderr: '', exitCode: 0 };
      }
    }
    if (name !== 'cypher-shell') throw new Error(`Unexpected executable: ${name}`);
    const statement = args.at(-1);
    if (statement.startsWith('CALL dbms.components')) return { stdout: 'name\tversion\tedition\nNeo4j Kernel\t2026.06.1\tenterprise\n', stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW DATABASES')) return { stdout: `${databaseOutput('online')}\n`, stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW SERVERS')) return { stdout: 'serverId\tname\taddress\tstate\thealth\thosting\nserver-a\tneo-a\t10.0.0.1:7688\tenabled\tavailable\t[neo4j, system]\n', stderr: '', exitCode: 0 };
    throw new Error(`Unexpected Cypher statement: ${statement}`);
  };
  run.calls = calls;
  run.backupCount = () => backupIndex;
  return run;
}

function alternateTargetRunner() {
  const calls = [];
  const run = async ({ executable, args }) => {
    const name = String(executable).replace(/\\/g, '/').split('/').at(-1);
    calls.push({ name, args: args.slice() });
    if (name === 'neo4j') return { stdout: 'neo4j 5.26.2\n', stderr: '', exitCode: 0 };
    if (name === 'neo4j-admin') {
      if (args[0] === '--version') return { stdout: 'neo4j-admin 5.26.2\n', stderr: '', exitCode: 0 };
      if (args[0] === 'database' && args[1] === 'info') return { stdout: `Database name: ${args.at(-1)}\nStore format: aligned\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'database' && args[1] === 'load') return { stdout: 'Load completed successfully\n', stderr: '', exitCode: 0 };
      if (args[0] === 'database' && args[1] === 'check') return { stdout: 'Consistency check successful\n', stderr: '', exitCode: 0 };
    }
    if (name !== 'cypher-shell') throw new Error(`Unexpected executable: ${name}`);
    const statement = args.at(-1);
    if (statement.startsWith('CALL dbms.components')) return { stdout: 'name\tversion\tedition\nNeo4j Kernel\t5.26.2\tcommunity\n', stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW DATABASES')) return { stdout: 'name\ttype\taccess\tcurrentStatus\trequestedStatus\trole\twriter\tdefault\thome\tdatabaseID\tserverID\tconstituents\nsystem\tsystem\tread-write\tonline\tonline\tprimary\ttrue\tfalse\tfalse\tdb-target-system\tserver-target\tnull\n', stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW SERVERS')) throw Object.assign(new Error('unsupported'), { exitCode: 1 });
    throw new Error(`Unexpected target statement: ${statement}`);
  };
  run.calls = calls;
  return run;
}

function enterpriseAlternateTargetRunner(results) {
  const calls = [];
  const byName = new Map(results.map((result) => [result.fileName, result]));
  const run = async ({ executable, args }) => {
    const name = String(executable).replace(/\\/g, '/').split('/').at(-1);
    calls.push({ name, args: args.slice() });
    if (name === 'neo4j') return { stdout: 'neo4j 2026.06.1\n', stderr: '', exitCode: 0 };
    if (name === 'neo4j-admin') {
      if (args[0] === '--version') return { stdout: 'neo4j-admin 2026.06.1\n', stderr: '', exitCode: 0 };
      if (args[0] === 'database' && args[1] === 'backup' && args.some((item) => item.startsWith('--inspect-path='))) {
        const inspectedPath = args.find((item) => item.startsWith('--inspect-path=')).slice('--inspect-path='.length);
        const result = byName.get(path.basename(inspectedPath));
        if (!result) throw new Error(`Unexpected Enterprise restore inspection: ${inspectedPath}`);
        return { stdout: [
          'Database name: neo4j', 'Database ID: db-neo4j', `Backup type: ${result.type}`, `Backup time: ${result.backupTime}`,
          `Lowest transaction ID: ${result.lowest}`, `Highest transaction ID: ${result.highest}`, 'Store format: aligned'
        ].join('\n'), stderr: '', exitCode: 0 };
      }
      if (args[0] === 'database' && args[1] === 'restore') {
        const directory = args.find((item) => item.startsWith('--from-path=')).slice('--from-path='.length);
        const files = (await fs.readdir(directory)).filter((entry) => entry.endsWith('.backup')).sort();
        assert.equal(JSON.stringify(files) === JSON.stringify(['neo4j-diff-002.backup', 'neo4j-full-001.backup']) || JSON.stringify(files) === JSON.stringify(['neo4j-aggregate-005.backup']), true);
        assert.equal(args.includes('--overwrite-destination=false'), true);
        assert.equal(args.at(-1), 'neo4j');
        return { stdout: 'Restore completed successfully\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'database' && args[1] === 'check') return { stdout: 'Consistency check successful\n', stderr: '', exitCode: 0 };
    }
    if (name !== 'cypher-shell') throw new Error(`Unexpected executable: ${name}`);
    const statement = args.at(-1);
    if (statement.startsWith('CALL dbms.components')) return { stdout: 'name\tversion\tedition\nNeo4j Kernel\t2026.06.1\tenterprise\n', stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW DATABASES')) return { stdout: 'name\ttype\taccess\tcurrentStatus\trequestedStatus\trole\twriter\tdefault\thome\tdatabaseID\tserverID\tconstituents\nsystem\tsystem\tread-write\tonline\tonline\tprimary\ttrue\tfalse\tfalse\tdb-target-system\tserver-target\tnull\n', stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW SERVERS')) return { stdout: 'serverId\tname\taddress\tstate\thealth\thosting\nserver-target\tneo-target\t10.0.1.1:7688\tenabled\tavailable\t[system]\n', stderr: '', exitCode: 0 };
    throw new Error(`Unexpected Enterprise target statement: ${statement}`);
  };
  run.calls = calls;
  return run;
}

test('publishes one authenticated stopped-database dump through the shared repository engine', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-neo4j-source-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const runner = nativeRunner();
  const adapter = new Neo4jAdapter({ temporaryRoot: path.join(root, 'adapter-temp'), clock: () => '2026-08-05T12:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new Neo4jConnectionService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID, adapter, localCommandRunner: runner });
  const created = await connections.create(WORKSPACE_ID, 'tester', { name: 'Community Neo4j', expectedEdition: 'community', executionMode: 'local', address: 'neo4j://127.0.0.1:7687' });
  const tested = await connections.test(WORKSPACE_ID, created.id, 'tester');
  assert.equal(tested.result.status, 'success');
  const source = await new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, deviceId: DEVICE_ID }).save(WORKSPACE_ID, 'tester', {
    name: 'Neo4j offline database',
    connectionId: created.id,
    selector: { databases: { include: [{ name: 'neo4j' }] } },
    consistency: { requestedLevel: 'application', method: 'offline', backupMethod: 'physical', backupMode: 'full', captureCoordinates: false }
  });
  assert.equal(source.enabled, true);
  assert.equal(source.physicalExecution, null);

  const temporaryRoot = path.join(root, 'source-temp');
  const reader = new Neo4jSourceReaderService({ controlDatabase, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, connectionService: connections, temporaryRoot });
  const planned = await reader.files(WORKSPACE_ID, source.id, { executionId: 'run-neo4j-1', backupMode: 'full' });
  const files = [];
  for await (const item of planned.create()) {
    const chunks = [];
    for await (const chunk of item.content) chunks.push(Buffer.from(chunk));
    files.push({ path: item.path, bytes: Buffer.concat(chunks), metadata: item.metadata });
  }
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'neo4j/neo4j.dump');
  assert.equal(files[0].bytes.equals(DUMP_BYTES), true);
  assert.equal(files[0].metadata.database.kind, 'neo4j-offline-dump');
  assert.equal(planned.manifest.database.database.databaseId, 'db-neo4j');
  assert.equal(planned.manifest.database.metadataScope, 'database-store-only-no-rbac');
  assert.match(planned.manifest.database.artifact.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(planned.manifest.database.artifact.storeFormat, 'aligned');
  const second = await reader.files(WORKSPACE_ID, source.id, { executionId: 'run-neo4j-1', backupMode: 'full' });
  for await (const item of second.create()) for await (const _chunk of item.content) {}
  assert.equal(runner.calls.filter((call) => call.name === 'neo4j-admin' && call.args[1] === 'dump').length, 1);
  await reader.release(WORKSPACE_ID, 'run-neo4j-1');
  assert.deepEqual(await fs.readdir(temporaryRoot), []);

  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot, { recursive: true });
  const repository = await controlDatabase.repository('repository').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Neo4j repository', connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'neo4j-test-key-v1' }, workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 17);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const { job } = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', {
    name: 'Neo4j offline protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full', verifyAfterBackup: true
  });
  const sourceReader = new BackupSourceReaderRouter({
    controlDatabase,
    fileReader: new FileSourceReaderService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID }),
    databaseReaders: { [ADAPTER_ID]: reader }
  });
  const service = new ManualBackupService({
    controlDatabase, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID,
    openRepository: async () => ({ repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'neo4j-test-key-v1' })
  });
  const started = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(started.id);
  const completed = await controlDatabase.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  const [point] = await controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  assert.equal(point.type, 'full');
  assert.equal(point.consistency, 'application');
  const artifact = (await controlDatabase.repository('artifact').list(WORKSPACE_ID, { limit: 20 })).find((item) => item.kind === 'database-dump');
  assert.ok(artifact);
  assert.equal(artifact.metadata.kind, 'neo4j-offline-dump');
  assert.equal(artifact.metadata.database.databaseId, 'db-neo4j');
  const snapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey });
  const chunks = [];
  for await (const chunk of engine.streamFile({}, { repositoryId: repository.id, manifest: snapshot.manifest, masterKey, path: 'neo4j/neo4j.dump' })) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).equals(DUMP_BYTES), true);
  assert.deepEqual(await fs.readdir(temporaryRoot), []);

  const targetRunner = alternateTargetRunner();
  const targetConnections = new Neo4jConnectionService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID, adapter, localCommandRunner: targetRunner });
  const targetConnection = await targetConnections.create(WORKSPACE_ID, 'tester', { name: 'Empty alternate Neo4j', expectedEdition: 'community', executionMode: 'local', address: 'neo4j://127.0.0.1:7688' });
  assert.equal((await targetConnections.test(WORKSPACE_ID, targetConnection.id, 'tester')).result.status, 'success');
  const restoreService = new Neo4jRestoreService({
    controlDatabase, deviceId: DEVICE_ID, adapter, connectionService: targetConnections,
    openRepository: async () => ({ repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'neo4j-test-key-v1' })
  });
  const restore = await restoreService.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, targetConnectionId: targetConnection.id, targetDatabase: 'recovered', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const restored = await restoreService.wait(WORKSPACE_ID, restore.id);
  assert.equal(restored.state, 'succeeded', JSON.stringify(restored.result));
  assert.equal(restored.validation.nativeIntegrityValidation, true);
  assert.equal(restored.result.bytesRestored, DUMP_BYTES.length);
  assert.equal(restored.result.serviceStarted, false);
  assert.equal(targetRunner.calls.some((call) => call.name === 'neo4j-admin' && call.args[1] === 'load'), true);
  assert.equal(targetRunner.calls.some((call) => call.name === 'neo4j-admin' && call.args[1] === 'check'), true);
});

test('publishes authenticated Enterprise full/differential chains and reclassifies native full fallback', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-neo4j-enterprise-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const results = [
    { requestedType: 'FULL', type: 'FULL', fileName: 'neo4j-full-001.backup', bytes: Buffer.from('neo4j-enterprise-full-001'), lowest: 1, highest: 10, backupTime: '2026-08-05T12:00:00.000Z', expectedParents: 0 },
    { requestedType: 'DIFF', type: 'DIFF', fileName: 'neo4j-diff-002.backup', bytes: Buffer.from('neo4j-enterprise-diff-002'), lowest: 5, highest: 15, backupTime: '2026-08-05T13:00:00.000Z', expectedParents: 1 },
    { requestedType: 'DIFF', type: 'FULL', fileName: 'neo4j-full-003.backup', bytes: Buffer.from('neo4j-enterprise-full-fallback-003'), lowest: 1, highest: 18, backupTime: '2026-08-05T14:00:00.000Z', expectedParents: 2 },
    { requestedType: 'DIFF', type: 'DIFF', fileName: 'neo4j-empty-004.backup', bytes: Buffer.from('neo4j-enterprise-empty-diff-004'), lowest: 0, highest: 0, backupTime: '2026-08-05T15:00:00.000Z', expectedParents: 1 }
  ];
  const aggregateResult = { type: 'FULL', fileName: 'neo4j-aggregate-005.backup', bytes: Buffer.from('neo4j-enterprise-aggregate-005'), lowest: 1, highest: 15, backupTime: '2026-08-05T13:00:00.000Z' };
  const runner = enterpriseOnlineRunner(results, aggregateResult);
  const adapter = new Neo4jAdapter({ temporaryRoot: path.join(root, 'adapter-temp'), clock: () => '2026-08-05T12:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new Neo4jConnectionService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID, adapter, localCommandRunner: runner });
  const created = await connections.create(WORKSPACE_ID, 'tester', { name: 'Enterprise Neo4j', expectedEdition: 'enterprise', executionMode: 'local', address: 'neo4j://127.0.0.1:7687' });
  assert.equal((await connections.test(WORKSPACE_ID, created.id, 'tester')).result.status, 'success');
  const source = await new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, deviceId: DEVICE_ID }).save(WORKSPACE_ID, 'tester', {
    name: 'Neo4j Enterprise online database',
    connectionId: created.id,
    selector: { databases: { include: [{ name: 'neo4j' }] }, includeGlobalObjects: false },
    consistency: { requestedLevel: 'application', method: 'neo4j-native-backup', backupMethod: 'physical', backupMode: 'differential', captureCoordinates: true },
    physicalExecution: { backupAddresses: ['neo-a.example.com:6362'] }
  });
  assert.equal(source.physicalExecution.tier, 'enterprise-online');
  assert.equal(source.physicalExecution.metadataPolicy, 'none');
  assert.equal(source.physicalExecution.databaseId, 'db-neo4j');

  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot, { recursive: true });
  const repository = await controlDatabase.repository('repository').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Neo4j Enterprise repository', connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'neo4j-enterprise-key-v1' }, workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 29);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const openRepository = async () => ({ repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'neo4j-enterprise-key-v1' });
  const reader = new Neo4jSourceReaderService({ controlDatabase, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, connectionService: connections, openRepository, temporaryRoot: path.join(root, 'source-temp') });
  const { job } = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', {
    name: 'Neo4j Enterprise differential protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'differential', verifyAfterBackup: true
  });
  const sourceReader = new BackupSourceReaderRouter({
    controlDatabase,
    fileReader: new FileSourceReaderService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID }),
    databaseReaders: { [ADAPTER_ID]: reader }
  });
  const service = new ManualBackupService({
    controlDatabase, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID, openRepository
  });
  const execute = async () => {
    const started = await service.start(WORKSPACE_ID, 'tester', job.id);
    await service.wait(started.id);
    return controlDatabase.repository('run').get(WORKSPACE_ID, started.id);
  };
  const baselineRun = await execute();
  assert.equal(baselineRun.state, 'succeeded', JSON.stringify({ result: baselineRun.result, progress: baselineRun.progress, backupCount: runner.backupCount(), calls: runner.calls }));
  const differentialRun = await execute();
  assert.equal(differentialRun.state, 'succeeded', JSON.stringify(differentialRun.result));
  const fallbackRun = await execute();
  assert.equal(fallbackRun.state, 'succeeded', JSON.stringify(fallbackRun.result));
  const noChangeRun = await execute();
  assert.equal(noChangeRun.state, 'succeeded', JSON.stringify(noChangeRun.result));
  assert.equal(noChangeRun.result.noChange, true);
  assert.equal(runner.backupCount(), 4);

  const points = await controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  assert.equal(points.length, 3);
  const baseline = points.find((point) => point.id === baselineRun.result.recoveryPointIds[0]);
  const differential = points.find((point) => point.id === differentialRun.result.recoveryPointIds[0]);
  const fallback = points.find((point) => point.id === fallbackRun.result.recoveryPointIds[0]);
  assert.equal(baseline.type, 'full');
  assert.equal(differential.type, 'differential');
  assert.equal(differential.parentRecoveryPointId, baseline.id);
  assert.equal(differential.chainRootId, baseline.id);
  assert.equal(fallback.type, 'full');
  assert.equal(fallback.parentRecoveryPointId, null);
  assert.equal(fallback.chainRootId, fallback.id);
  const nativeArtifacts = (await controlDatabase.repository('artifact').list(WORKSPACE_ID, { limit: 50 })).filter((artifact) => artifact.kind === 'physical-backup' && artifact.metadata?.kind === 'neo4j-enterprise-backup');
  assert.equal(nativeArtifacts.length, 3);
  assert.deepEqual(nativeArtifacts.map((artifact) => artifact.metadata.backupMode).sort(), ['differential', 'full', 'full']);
  assert.equal(nativeArtifacts.find((artifact) => artifact.recoveryPointId === differential.id).metadata.chain.materializedParentRecoveryPointIds[0], baseline.id);
  assert.equal(nativeArtifacts.find((artifact) => artifact.recoveryPointId === fallback.id).metadata.chain.parentRecoveryPointId, null);

  const targetRunner = enterpriseAlternateTargetRunner([...results, aggregateResult]);
  const targetConnections = new Neo4jConnectionService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID, adapter, localCommandRunner: targetRunner });
  const targetConnection = await targetConnections.create(WORKSPACE_ID, 'tester', { name: 'Empty alternate Enterprise Neo4j', expectedEdition: 'enterprise', executionMode: 'local', address: 'neo4j://127.0.0.1:7690' });
  assert.equal((await targetConnections.test(WORKSPACE_ID, targetConnection.id, 'tester')).result.status, 'success');
  const restoreService = new Neo4jRestoreService({ controlDatabase, deviceId: DEVICE_ID, adapter, connectionService: targetConnections, openRepository });
  const preview = await restoreService.preview(WORKSPACE_ID, { recoveryPointId: differential.id, targetConnectionId: targetConnection.id, targetDatabase: 'neo4j' });
  assert.equal(preview.artifactCount, 2);
  assert.deepEqual(preview.chainRecoveryPointIds, [baseline.id, differential.id]);
  assert.equal(preview.sizeBytes, results[0].bytes.length + results[1].bytes.length);
  const startedRestore = await restoreService.start(WORKSPACE_ID, 'tester', { recoveryPointId: differential.id, targetConnectionId: targetConnection.id, targetDatabase: 'neo4j', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const restored = await restoreService.wait(WORKSPACE_ID, startedRestore.id);
  assert.equal(restored.state, 'succeeded', JSON.stringify(restored.result));
  assert.deepEqual(restored.recoveryPointIds, [baseline.id, differential.id]);
  assert.deepEqual(restored.result.chainRecoveryPointIds, [baseline.id, differential.id]);
  assert.equal(restored.result.artifactCount, 2);
  assert.equal(restored.result.bytesRestored, results[0].bytes.length + results[1].bytes.length);
  assert.equal(targetRunner.calls.some((call) => call.name === 'neo4j-admin' && call.args[1] === 'restore'), true);
  assert.equal(targetRunner.calls.some((call) => call.name === 'neo4j-admin' && call.args[1] === 'load'), false);

  const aggregationService = new Neo4jAggregationService({ controlDatabase, deviceId: DEVICE_ID, adapter, connectionService: connections, chainService: restoreService, openRepository, temporaryRoot: path.join(root, 'aggregation-temp') });
  const aggregatePreview = await aggregationService.preview(WORKSPACE_ID, { recoveryPointId: differential.id, repositoryId: repository.id });
  assert.deepEqual(aggregatePreview.chainRecoveryPointIds, [baseline.id, differential.id]);
  assert.equal(aggregatePreview.preservesSourceChain, true);
  await assert.rejects(aggregationService.start(WORKSPACE_ID, 'tester', { recoveryPointId: differential.id, repositoryId: repository.id, expectedPlanId: aggregatePreview.planId }), (error) => error.code === 'NEO4J_AGGREGATE_CONFIRMATION_REQUIRED');
  await assert.rejects(aggregationService.start(WORKSPACE_ID, 'tester', { recoveryPointId: differential.id, repositoryId: repository.id, expectedPlanId: 'neo4j_aggregate_stale', confirmed: true, confirmationText: AGGREGATION_CONFIRMATION }), (error) => error.code === 'NEO4J_AGGREGATE_PLAN_STALE');
  const aggregationRun = await aggregationService.start(WORKSPACE_ID, 'tester', { recoveryPointId: differential.id, repositoryId: repository.id, expectedPlanId: aggregatePreview.planId, confirmed: true, confirmationText: AGGREGATION_CONFIRMATION });
  const aggregatedRun = await aggregationService.wait(WORKSPACE_ID, aggregationRun.id);
  assert.equal(aggregatedRun.state, 'succeeded', JSON.stringify(aggregatedRun.result));
  assert.equal(aggregatedRun.result.aggregateBytes, aggregateResult.bytes.length);
  const aggregatePoint = await controlDatabase.repository('recoveryPoint').get(WORKSPACE_ID, aggregatedRun.result.recoveryPointIds[0]);
  assert.equal(aggregatePoint.type, 'full');
  assert.equal(aggregatePoint.chainRootId, aggregatePoint.id);
  assert.equal(aggregatePoint.parentRecoveryPointId, null);
  assert.equal(aggregatePoint.repositoryCopies[0].state, 'available');
  const aggregateSnapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: aggregatePoint.repositoryCopies[0].engineSnapshotId, masterKey });
  assert.equal(aggregateSnapshot.summary.parentSnapshotId, null);
  const aggregateArtifact = (await controlDatabase.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).find((artifact) => artifact.recoveryPointId === aggregatePoint.id && artifact.kind === 'physical-backup');
  assert.equal(aggregateArtifact.metadata.aggregation.sourceRecoveryPointId, differential.id);
  assert.deepEqual(aggregateArtifact.metadata.aggregation.sourceRecoveryPointIds, [baseline.id, differential.id]);
  assert.equal(aggregateArtifact.metadata.aggregation.sourceMediaPreserved, true);
  assert.equal((await controlDatabase.repository('recoveryPoint').get(WORKSPACE_ID, baseline.id)).repositoryCopies[0].state, 'available');
  assert.equal((await controlDatabase.repository('recoveryPoint').get(WORKSPACE_ID, differential.id)).repositoryCopies[0].state, 'available');
  const aggregateRestore = await restoreService.start(WORKSPACE_ID, 'tester', { recoveryPointId: aggregatePoint.id, targetConnectionId: targetConnection.id, targetDatabase: 'neo4j', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const aggregateRestored = await restoreService.wait(WORKSPACE_ID, aggregateRestore.id);
  assert.equal(aggregateRestored.state, 'succeeded', JSON.stringify(aggregateRestored.result));
  assert.deepEqual(aggregateRestored.result.chainRecoveryPointIds, [aggregatePoint.id]);
  assert.equal(aggregateRestored.result.bytesRestored, aggregateResult.bytes.length);
  assert.deepEqual(await fs.readdir(path.join(root, 'source-temp')), []);
  assert.deepEqual(await fs.readdir(path.join(root, 'aggregation-temp')), []);
});

test('reconciles only exact run-owned Neo4j staging directories', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-neo4j-reconcile-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const adapter = new Neo4jAdapter();
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new Neo4jConnectionService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID, adapter, localCommandRunner: nativeRunner() });
  const temporaryRoot = path.join(root, 'staging');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const run = { id: 'run-reconcile-neo4j', sourceLease: null };
  const owned = await fs.mkdtemp(path.join(temporaryRoot, preparationPrefix(WORKSPACE_ID, run.id)));
  await fs.writeFile(path.join(owned, '.owner.json'), JSON.stringify({ version: 1, workspaceId: WORKSPACE_ID, executionId: run.id }));
  const foreign = await fs.mkdtemp(path.join(temporaryRoot, preparationPrefix(WORKSPACE_ID, run.id)));
  await fs.writeFile(path.join(foreign, '.owner.json'), JSON.stringify({ version: 1, workspaceId: WORKSPACE_ID, executionId: 'another-run' }));
  const reader = new Neo4jSourceReaderService({ controlDatabase, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, connectionService: connections, temporaryRoot });
  const result = await reader.reconcileRun(WORKSPACE_ID, run);
  assert.equal(result.proven, true);
  assert.equal(result.removedTemporaryDirectories, 1);
  assert.equal(await fs.lstat(owned).catch(() => null), null);
  assert.equal((await fs.lstat(foreign)).isDirectory(), true);
});

test('streams SSH dump media locally and removes only the exact remote owned directory', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-neo4j-ssh-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const ssh = {
    id: 'ssh-neo4j-test', workspaceId: WORKSPACE_ID, name: 'Neo4j SSH', kind: 'ssh', adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0', scope: 'device',
    endpoint: { host: 'neo4j.example.com', port: 22, username: 'backup', authType: 'password', timeoutMs: 30000 },
    secretRefIds: ['ssh-secret-ref'], trust: { fingerprint: `SHA256:${'A'.repeat(43)}`, algorithm: 'ssh-ed25519' }, workerAffinity: [`device:${DEVICE_ID}`],
    lastTest: { status: 'success' }
  };
  const controlDatabase = { repository: (kind) => {
    assert.equal(kind, 'connection');
    return { get: async (_workspaceId, id) => id === ssh.id ? ssh : null };
  } };
  const commands = [];
  const session = {
    closed: false,
    async run(command) {
      commands.push(command);
      if (command.includes("'mktemp'")) return { stdout: '/tmp/deployerx-neo4j-AbC123xyz0\n', stderr: '', exitCode: 0 };
      if (command.includes("'neo4j' '--version'")) return { stdout: 'neo4j 5.26.2\n', stderr: '', exitCode: 0 };
      if (command.includes("'neo4j-admin' '--version'")) return { stdout: 'neo4j-admin 5.26.2\n', stderr: '', exitCode: 0 };
      if (command.includes('CALL dbms.components')) return { stdout: 'name\tversion\tedition\nNeo4j Kernel\t5.26.2\tcommunity\n', stderr: '', exitCode: 0 };
      if (command.includes('SHOW DATABASES')) return { stdout: `${databaseOutput('offline')}\n`, stderr: '', exitCode: 0 };
      if (command.includes('SHOW SERVERS')) throw Object.assign(new Error('unsupported'), { exitCode: 1 });
      if (command.includes("'database' 'dump'")) return { stdout: 'Dump completed successfully\n', stderr: '', exitCode: 0 };
      if (command.includes("'database' 'info'")) return { stdout: 'Database name: neo4j\nStore format: aligned\n', stderr: '', exitCode: 0 };
      if (command.includes("'rm' '-rf' '--' '/tmp/deployerx-neo4j-AbC123xyz0'")) return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`Unexpected SSH command: ${command}`);
    },
    async stream(command) {
      commands.push(command);
      assert.match(command, /'cat' '--' '\/tmp\/deployerx-neo4j-AbC123xyz0\/neo4j[.]dump'/);
      return { stdout: Readable.from([DUMP_BYTES]), completion: Promise.resolve({ exitCode: 0 }) };
    },
    close() { this.closed = true; }
  };
  const adapter = new Neo4jAdapter();
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new Neo4jConnectionService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID, adapter, sessionFactory: async () => session });
  const connection = {
    endpoint: { expectedEdition: 'community', executionMode: 'ssh', sshConnectionId: ssh.id, address: 'neo4j://127.0.0.1:7687', username: null, neo4jPath: 'neo4j', neo4jAdminPath: 'neo4j-admin', cypherShellPath: 'cypher-shell', timeoutMs: 30000, expectedVersion: null, expectedDeploymentFingerprint: null, expectedTopologyFingerprint: null },
    secretRefIds: []
  };
  const destination = path.join(root, 'remote.dump');
  await connections.withExecution(WORKSPACE_ID, connection, null, async (execution, config) => {
    const prepared = await registry.prepareBackup(ADAPTER_ID, execution, {
      connection: config,
      selector: { databases: { include: [{ name: 'neo4j' }] } },
      consistency: { requestedLevel: 'application', method: 'offline', backupMethod: 'physical', backupMode: 'full', captureCoordinates: false }
    });
    await adapter.createBackupMedia(execution, prepared.adapterPlan, destination);
  });
  assert.equal((await fs.readFile(destination)).equals(DUMP_BYTES), true);
  assert.equal(commands.filter((command) => command.includes("'rm' '-rf'")).length, 1);
  assert.equal(session.closed, true);
});
