const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { BackupJobService } = require('./backup-job');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { LocalFolderRepositoryAdapter, ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RepositoryPruningService } = require('./repository-pruning');
const { RunCheckpointStore } = require('./run-checkpoint');
const { ADAPTER_ID, ADAPTER_VERSION, RESTORE_CONFIRMATION, ClickHouseAdapter, QUERIES, destinationFingerprint, readDiscovery } = require('./clickhouse');
const { ClickHouseRestoreService } = require('./clickhouse-restore');
const { ClickHouseSourceReaderService, preparationPrefix } = require('./clickhouse-source-reader');

function lines(rows) { return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''); }

function discoveryOutputs(overrides = {}) {
  return {
    [QUERIES.identity]: lines([{ version: '25.8.3.66', timezone: 'UTC', host_name: 'clickhouse-a', current_user: 'backup_user' }]),
    [QUERIES.databases]: lines([{ name: 'analytics', uuid: '11111111-1111-4111-8111-111111111111', engine: 'Atomic', data_path: '/var/lib/clickhouse/' }]),
    [QUERIES.tables]: lines([{ database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'MergeTree', is_temporary: 0 }]),
    [QUERIES.clusters]: '',
    [QUERIES.replicas]: '',
    [QUERIES.partitions]: lines([{ database: 'analytics', table: 'events', partition: '202608', part_count: 3, row_count: 1000, bytes_on_disk: 4096 }]),
    [QUERIES.disks]: lines([{ name: 'backups', type: 'local', path: '/var/lib/clickhouse/backups/', free_space: 100000, total_space: 200000, keep_free_space: 1000, is_read_only: 0, is_write_once: 0 }]),
    [QUERIES.namedCollections]: '',
    [QUERIES.grants]: lines([{ access_type: 'BACKUP', database: 'analytics', table: '*' }, { access_type: 'RESTORE', database: '*', table: '*' }]),
    [QUERIES.backups]: lines([{ row_count: 0 }]),
    ...overrides
  };
}

function nativeRunner(outputs, observations = [], status = 'BACKUP_CREATED', catalog = new Map()) {
  return async ({ args }) => {
    const query = args.at(-1);
    observations.push({ args: [...args], query });
    if (query in outputs) return { stdout: outputs[query], stderr: '', exitCode: 0 };
    if (query.startsWith('BACKUP ')) {
      const destinationName = / TO (Disk\(.+?\)) SETTINGS id = /.exec(query)?.[1] || null;
      const operationId = /SETTINGS id = '([^']+)'/.exec(query)?.[1] || null;
      if (operationId && destinationName) catalog.set(operationId, { destinationName, status });
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (query.includes('FROM system.backups WHERE id = ')) {
      const operationId = /WHERE id = '([^']+)'/.exec(query)?.[1];
      const record = catalog.get(operationId);
      if (!record) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: lines([{ id: operationId, name: record.destinationName, status: record.status, error: '', start_time: '2026-08-05 12:00:00', end_time: record.status === 'BACKUP_CREATED' ? '2026-08-05 12:00:01' : '', num_files: record.status === 'BACKUP_CREATED' ? 4 : 0, total_size: record.status === 'BACKUP_CREATED' ? 100 : 0, num_entries: record.status === 'BACKUP_CREATED' ? 2 : 0, uncompressed_size: record.status === 'BACKUP_CREATED' ? 200 : 0, compressed_size: record.status === 'BACKUP_CREATED' ? 100 : 0, files_read: record.status === 'BACKUP_CREATED' ? 4 : 0, bytes_read: record.status === 'BACKUP_CREATED' ? 200 : 0 }]), stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected query: ${query}`);
  };
}

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-clickhouse-source-'));
  const preparationRoot = path.join(rootPath, 'preparations');
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const outputs = discoveryOutputs();
  const baseConfig = { executionMode: 'local', host: 'clickhouse.example.com', port: 9440, tlsMode: 'required', username: 'backup_user', clientPath: 'clickhouse-client' };
  const discovery = await readDiscovery({ clickhouseConfigPath: 'C:\\protected\\client.xml', runNativeCommand: nativeRunner(outputs) }, baseConfig);
  const endpoint = { ...baseConfig, timeoutMs: 30000, expectedVersion: discovery.version.text, expectedDeploymentFingerprint: discovery.deploymentFingerprint, expectedTopologyFingerprint: discovery.topologyFingerprint };
  const disk = discovery.disks[0];
  const destinationTrust = { version: 1, destinationType: 'disk', diskName: disk.name, diskType: disk.type, pathFingerprint: 'sha256:path', totalBytes: disk.totalBytes, destinationFingerprint: destinationFingerprint(disk), deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint, approvedAt: '2026-08-05T12:00:00.000Z' };
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'ClickHouse', kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, endpoint, secretRefIds: [], workerAffinity: ['device:device-a'],
    lastTest: { status: 'success', endpointIdentity: { deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint } },
    trust: { fingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint },
    clickhouseInventory: { version: 1, productVersion: discovery.version.text, deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint, databases: discovery.databases, tables: discovery.tables, clusters: discovery.clusters, replicas: discovery.replicas, partitions: discovery.partitions, disks: discovery.disks, grants: discovery.grants },
    clickhouseDestinationTrust: destinationTrust
  });
  const adapter = new ClickHouseAdapter({ clock: () => '2026-08-05T12:00:00.000Z', now: () => 1000, delay: async () => {}, maximumBackupWaitMs: 1000 });
  const adapterRegistry = new DatabaseAdapterRegistry([adapter]);
  const sourceService = new DatabaseSourceService({ controlDatabase, adapterRegistry, deviceId: 'device-a', clock: () => '2026-08-05T12:00:00.000Z' });
  const source = await sourceService.save('workspace-a', 'tester', {
    name: 'Analytics native backup', connectionId: connection.id, adapterId: ADAPTER_ID,
    selector: { databases: { include: [{ name: 'analytics' }] }, tables: { include: [{ database: 'analytics', schema: 'analytics', name: 'events' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full', method: 'clickhouse-native-backup', captureCoordinates: true },
    physicalExecution: { executionMode: 'asynchronous' }
  });
  const observations = [];
  const nativeCatalog = new Map();
  const executionRunner = nativeRunner(outputs, observations, 'BACKUP_CREATED', nativeCatalog);
  const connectionService = {
    config: () => endpoint,
    withExecution: async (_workspaceId, _connection, signal, callback) => callback({ signal, clickhouseConfigPath: 'C:\\protected\\client.xml', runNativeCommand: executionRunner }, endpoint)
  };
  const reader = new ClickHouseSourceReaderService({ controlDatabase, deviceId: 'device-a', adapterRegistry, adapter, connectionService, temporaryRoot: preparationRoot });
  return { adapter, adapterRegistry, connection, connectionService, controlDatabase, destinationTrust, discovery, nativeCatalog, observations, outputs, preparationRoot, reader, rootPath, source, sourceService };
}

test('admits exact standalone ClickHouse Sources and rejects stale destinations or unsupported table engines', async (context) => {
  const value = await fixture(context);
  assert.equal(value.source.physicalExecution.diskName, 'backups');
  assert.equal(value.source.physicalExecution.executionMode, 'asynchronous');
  assert.equal(value.source.enabled, true);

  let current = await value.controlDatabase.repository('connection').get('workspace-a', value.connection.id);
  current = await value.controlDatabase.repository('connection').update('workspace-a', current.id, { clickhouseDestinationTrust: { ...current.clickhouseDestinationTrust, destinationFingerprint: `sha256:${'0'.repeat(64)}` } }, { expectedRevision: current.revision, actorId: 'tester' });
  await assert.rejects(value.sourceService.save('workspace-a', 'tester', { name: 'Stale target', connectionId: current.id, adapterId: ADAPTER_ID, selector: { databases: { include: [{ name: 'analytics' }] } }, consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full', method: 'clickhouse-native-backup', captureCoordinates: true }, physicalExecution: {} }), /Approve one writable ClickHouse backup disk/);

  current = await value.controlDatabase.repository('connection').update('workspace-a', current.id, { clickhouseDestinationTrust: value.destinationTrust, clickhouseInventory: { ...current.clickhouseInventory, tables: current.clickhouseInventory.tables.map((table) => ({ ...table, engine: 'Kafka' })) } }, { expectedRevision: current.revision, actorId: 'tester' });
  await assert.rejects(value.sourceService.save('workspace-a', 'tester', { name: 'Unsafe engine', connectionId: current.id, adapterId: ADAPTER_ID, selector: { databases: { include: [{ name: 'analytics' }] } }, consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full', method: 'clickhouse-native-backup', captureCoordinates: true }, physicalExecution: {} }), /unsupported engine/);
});

test('publishes bounded ClickHouse native-media metadata through the Source reader', async (context) => {
  const value = await fixture(context);
  const files = await value.reader.files('workspace-a', value.source.id, { executionId: 'run-1', backupMode: 'full' });
  assert.equal(files.manifest.externalNativeMedia, true);
  assert.equal(files.manifest.artifactPath, 'clickhouse/backup-metadata.json');
  const entries = [];
  for await (const entry of files.create()) {
    const chunks = [];
    for await (const chunk of entry.content) chunks.push(chunk);
    entries.push({ entry, bytes: Buffer.concat(chunks) });
  }
  assert.equal(entries.length, 1);
  const metadata = JSON.parse(entries[0].bytes.toString('utf8'));
  assert.equal(metadata.kind, 'clickhouse-native-backup');
  assert.equal(metadata.operation.status, 'BACKUP_CREATED');
  assert.equal(metadata.destination.backupName.startsWith("Disk('backups'"), true);
  assert.equal(value.observations.some((item) => item.query.startsWith('BACKUP TABLE `analytics`.`events` TO Disk(')), true);
  await value.reader.release('workspace-a', 'run-1');
  assert.deepEqual(await fs.readdir(value.preparationRoot), []);
});

test('commits an authenticated full and incremental ClickHouse chain through the encrypted repository engine', async (context) => {
  const value = await fixture(context);
  const repositoryRoot = path.join(value.rootPath, 'repository');
  await fs.mkdir(repositoryRoot, { recursive: true });
  const repository = await value.controlDatabase.repository('repository').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Encrypted metadata repository', connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null, encryption: { algorithm: 'aes-256-gcm', keyVersion: 'test-key-v1' },
    workerAffinity: ['device:device-a'], health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 19);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const openRepository = async (_workspaceId, repositoryId) => {
    assert.equal(repositoryId, repository.id);
    return { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'test-key-v1' };
  };
  value.reader.openRepository = openRepository;
  const { job } = await new BackupJobService({ controlDatabase: value.controlDatabase, deviceId: 'device-a' }).create('workspace-a', 'tester', { name: 'ClickHouse protection', sourceId: value.source.id, repositoryIds: [repository.id], backupMode: 'incremental', verifyAfterBackup: true });
  const router = new BackupSourceReaderRouter({ controlDatabase: value.controlDatabase, fileReader: {}, databaseReaders: { [ADAPTER_ID]: value.reader } });
  const service = new ManualBackupService({ controlDatabase: value.controlDatabase, sourceReader: router, checkpointStore: new RunCheckpointStore({ rootPath: path.join(value.rootPath, 'checkpoints') }), deviceId: 'device-a', openRepository });
  const fullRun = await service.start('workspace-a', 'tester', job.id);
  await service.wait(fullRun.id);
  assert.equal((await value.controlDatabase.repository('run').get('workspace-a', fullRun.id)).state, 'succeeded');
  const incrementalRun = await service.start('workspace-a', 'tester', job.id);
  await service.wait(incrementalRun.id);
  assert.equal((await value.controlDatabase.repository('run').get('workspace-a', incrementalRun.id)).state, 'succeeded');
  const points = await value.controlDatabase.repository('recoveryPoint').list('workspace-a', { limit: 10 });
  const fullPoint = points.find((point) => point.type === 'full');
  const incrementalPoint = points.find((point) => point.type === 'incremental');
  assert.ok(fullPoint);
  assert.equal(incrementalPoint.parentRecoveryPointId, fullPoint.id);
  assert.equal(incrementalPoint.chainRootId, fullPoint.id);
  const metadataByPoint = new Map();
  for (const point of [fullPoint, incrementalPoint]) {
    const snapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey });
    const file = snapshot.manifest.files.find((item) => item.path === 'clickhouse/backup-metadata.json');
    assert.ok(file);
    const chunks = [];
    for await (const chunk of engine.streamFile({}, { repositoryId: repository.id, manifest: snapshot.manifest, masterKey, path: file.path })) chunks.push(Buffer.from(chunk));
    metadataByPoint.set(point.id, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  const fullMetadata = metadataByPoint.get(fullPoint.id);
  const incrementalMetadata = metadataByPoint.get(incrementalPoint.id);
  assert.equal(fullMetadata.backupMode, 'full');
  assert.equal(incrementalMetadata.backupMode, 'incremental');
  assert.equal(incrementalMetadata.chain.parentRecoveryPointId, fullPoint.id);
  assert.deepEqual(incrementalMetadata.chain.ancestorRecoveryPointIds, [fullPoint.id]);
  assert.equal(incrementalMetadata.chain.baseOperationId, fullMetadata.operation.id);
  const backupStatements = value.observations.filter((item) => item.query.startsWith('BACKUP ')).map((item) => item.query);
  assert.equal(backupStatements.length, 2);
  assert.equal(backupStatements[0].includes('base_backup'), false);
  assert.match(backupStatements[1], /SETTINGS id = 'deployerx-[0-9a-f]{32}', base_backup = Disk\('backups', 'deployerx\/[0-9a-f]{16}\/deployerx-[0-9a-f]{32}[.]zip'\) ASYNC$/);
  const targetBefore = discoveryOutputs({
    [QUERIES.identity]: lines([{ version: '25.8.3.66', timezone: 'UTC', host_name: 'clickhouse-recovery', current_user: 'restore_user' }]),
    [QUERIES.databases]: lines([{ name: 'recovery', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', engine: 'Atomic', data_path: '/var/lib/clickhouse/' }]),
    [QUERIES.tables]: '',
    [QUERIES.partitions]: '',
    [QUERIES.grants]: lines([{ access_type: 'RESTORE', database: '*', table: '*' }])
  });
  const targetAfter = discoveryOutputs({
    [QUERIES.identity]: lines([{ version: '25.8.3.66', timezone: 'UTC', host_name: 'clickhouse-recovery', current_user: 'restore_user' }]),
    [QUERIES.databases]: lines([{ name: 'recovery', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', engine: 'Atomic', data_path: '/var/lib/clickhouse/' }]),
    [QUERIES.tables]: lines([{ database: 'recovery', name: 'events', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', engine: 'MergeTree', is_temporary: 0 }]),
    [QUERIES.partitions]: lines([{ database: 'recovery', table: 'events', partition: '202608', part_count: 3, row_count: 1000, bytes_on_disk: 4096 }]),
    [QUERIES.grants]: lines([{ access_type: 'RESTORE', database: '*', table: '*' }])
  });
  const targetBaseConfig = { executionMode: 'local', host: 'clickhouse-recovery.example.com', port: 9440, tlsMode: 'required', username: 'restore_user', clientPath: 'clickhouse-client' };
  const targetDiscovery = await readDiscovery({ clickhouseConfigPath: 'C:\\protected\\target.xml', runNativeCommand: nativeRunner(targetBefore) }, targetBaseConfig);
  const targetEndpoint = { ...targetBaseConfig, timeoutMs: 30000, expectedVersion: targetDiscovery.version.text, expectedDeploymentFingerprint: targetDiscovery.deploymentFingerprint, expectedTopologyFingerprint: targetDiscovery.topologyFingerprint };
  const targetConnection = await value.controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'ClickHouse recovery', kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, endpoint: targetEndpoint, secretRefIds: [], workerAffinity: ['device:device-a'],
    lastTest: { status: 'success', endpointIdentity: { deploymentFingerprint: targetDiscovery.deploymentFingerprint, topologyFingerprint: targetDiscovery.topologyFingerprint } },
    trust: { fingerprint: targetDiscovery.deploymentFingerprint, topologyFingerprint: targetDiscovery.topologyFingerprint },
    clickhouseDestinationTrust: { ...value.destinationTrust, deploymentFingerprint: targetDiscovery.deploymentFingerprint, topologyFingerprint: targetDiscovery.topologyFingerprint }
  });
  let restoreSubmitted = false;
  const restoreObservations = [];
  const restoreConnectionService = {
    config: (connection) => connection.endpoint,
    withExecution: async (_workspaceId, connection, signal, callback) => callback({ signal, clickhouseConfigPath: 'C:\\protected\\target.xml', runNativeCommand: async ({ args }) => {
      const query = args.at(-1);
      restoreObservations.push(query);
      if (query.startsWith('RESTORE ')) { restoreSubmitted = true; return { stdout: '', stderr: '', exitCode: 0 }; }
      if (query.includes('FROM system.backups WHERE id = ')) return { stdout: lines([{ id: /WHERE id = '([^']+)'/.exec(query)?.[1], name: incrementalMetadata.destination.backupName, status: 'RESTORED', error: '', start_time: '2026-08-05 12:00:00', end_time: '2026-08-05 12:00:01', num_files: 4, total_size: 100, num_entries: 1, uncompressed_size: 200, compressed_size: 100, files_read: 4, bytes_read: 200 }]), stderr: '', exitCode: 0 };
      if (query.startsWith('SELECT count() AS sample_count FROM ')) return { stdout: lines([{ sample_count: 1 }]), stderr: '', exitCode: 0 };
      const selectedOutputs = restoreSubmitted ? targetAfter : targetBefore;
      if (query in selectedOutputs) return { stdout: selectedOutputs[query], stderr: '', exitCode: 0 };
      throw new Error(`Unexpected restore query: ${query}`);
    } }, connection.endpoint)
  };
  const restoreService = new ClickHouseRestoreService({ controlDatabase: value.controlDatabase, deviceId: 'device-a', adapter: value.adapter, connectionService: restoreConnectionService, openRepository, clock: () => '2026-08-05T12:00:00.000Z' });
  const preview = await restoreService.preview('workspace-a', { recoveryPointId: incrementalPoint.id, targetConnectionId: targetConnection.id, targetDatabase: 'recovery' });
  assert.deepEqual(preview.chainRecoveryPointIds, [fullPoint.id, incrementalPoint.id]);
  assert.equal(preview.backupMode, 'incremental');
  const restoreRun = await restoreService.start('workspace-a', 'tester', { recoveryPointId: incrementalPoint.id, targetConnectionId: targetConnection.id, targetDatabase: 'recovery', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const restoredRun = await restoreService.wait('workspace-a', restoreRun.id);
  assert.equal(restoredRun.state, 'succeeded');
  assert.equal(restoredRun.target.nativeMutationStarted, true);
  assert.equal(restoredRun.result.tableMappings[0].rowCount, 1000);
  assert.equal(restoreObservations.filter((query) => query.startsWith('RESTORE TABLE `analytics`.`events` AS `recovery`.`events` FROM ')).length, 1);
  const interruptedRun = await value.controlDatabase.repository('restoreRun').create({
    workspaceId: 'workspace-a', actorId: 'tester', recoveryPointIds: [fullPoint.id, incrementalPoint.id], targetConnectionId: targetConnection.id,
    target: { ...restoredRun.target, nativeOperationId: `deployerx-restore-${'d'.repeat(32)}`, nativeMutationStarted: true }, mode: 'alternate', conflictPolicy: 'fail', workerId: 'device:device-a', state: 'running',
    progress: { phase: 'restoring', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 200, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: '2026-08-05T12:00:00.000Z', updatedAt: '2026-08-05T12:00:00.000Z', warnings: [] }, validation: null, result: null
  });
  const reconciledRuns = await restoreService.reconcile('workspace-a', 'tester');
  const reconciledRun = reconciledRuns.find((item) => item.id === interruptedRun.id);
  assert.equal(reconciledRun.state, 'succeeded');
  assert.equal(reconciledRun.result.reconciledAfterRestart, true);
  const currentFull = await value.controlDatabase.repository('recoveryPoint').get('workspace-a', fullPoint.id);
  await value.controlDatabase.transaction((transaction) => transaction.projectRecoveryPointRetention('workspace-a', currentFull.id, { ...currentFull.retention, deletionEligible: true, expireAt: '2026-08-05T12:00:00.000Z' }, { expectedRevision: currentFull.revision, actorId: 'tester' }));
  await assert.rejects(restoreService.preview('workspace-a', { recoveryPointId: incrementalPoint.id, targetConnectionId: targetConnection.id, targetDatabase: 'recovery_2' }), (error) => error.code === 'CLICKHOUSE_RECOVERY_POINT_INVALID');
  const rejectedRun = await service.start('workspace-a', 'tester', job.id);
  await service.wait(rejectedRun.id);
  const rejected = await value.controlDatabase.repository('run').get('workspace-a', rejectedRun.id);
  assert.equal(rejected.state, 'failed');
  assert.equal(rejected.result.safeErrorCode, 'CLICKHOUSE_INCREMENTAL_CHAIN_UNAVAILABLE');
  const prunePlan = await new RepositoryPruningService({ controlDatabase: value.controlDatabase, openRepository, deviceId: 'device-a', clock: () => '2026-08-06T12:00:00.000Z' }).plan('workspace-a', repository.id);
  assert.deepEqual(prunePlan.blocked, [{ recoveryPointId: fullPoint.id, reason: 'dependency' }]);
  assert.deepEqual(prunePlan.protection.chainDependencies, [{ recoveryPointId: fullPoint.id, protectedByRecoveryPointIds: [incrementalPoint.id] }]);
  const storedPaths = await fs.readdir(repositoryRoot, { recursive: true });
  const storedFiles = [];
  for (const relativePath of storedPaths.slice(0, 10000)) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const stat = await fs.stat(absolutePath);
    if (stat.isFile()) storedFiles.push(await fs.readFile(absolutePath));
  }
  assert.equal(Buffer.concat(storedFiles).includes(Buffer.from('clickhouse-native-backup')), false);
});

test('reconciles an exact terminal native operation without deleting ClickHouse media', async (context) => {
  const value = await fixture(context);
  const executionId = 'run-interrupted';
  await fs.mkdir(value.preparationRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(value.preparationRoot, preparationPrefix('workspace-a', executionId)));
  const operationId = 'deployerx-11111111111111111111111111111111';
  const destinationName = "Disk('backups', 'deployerx/test.zip')";
  await fs.writeFile(path.join(directory, '.owner.json'), JSON.stringify({ version: 1, workspaceId: 'workspace-a', executionId, connectionId: value.connection.id, clickhouseBackup: { version: 1, adapterId: ADAPTER_ID, operationId, destinationName, ownershipFingerprint: `sha256:${'1'.repeat(64)}` } }), { mode: 0o600 });
  value.connectionService.withExecution = async (_workspaceId, _connection, signal, callback) => callback({ signal, clickhouseConfigPath: 'C:\\protected\\client.xml', runNativeCommand: async ({ args }) => {
    const query = args.at(-1);
    if (!query.includes('FROM system.backups WHERE id = ')) throw new Error(`Unexpected query: ${query}`);
    return { stdout: lines([{ id: operationId, name: destinationName, status: 'BACKUP_FAILED', error: 'preserved', start_time: '', end_time: '', num_files: 0, total_size: 0, num_entries: 0, uncompressed_size: 0, compressed_size: 0, files_read: 0, bytes_read: 0 }]), stderr: '', exitCode: 0 };
  } }, value.connection.endpoint);
  const reconciled = await value.reader.reconcileRun('workspace-a', { id: executionId, sourceLease: { token: 'lease' } });
  assert.deepEqual(reconciled, { applicable: true, proven: true, removedTemporaryDirectories: 1, reconciledOperations: 1, nativeMediaDeleted: false, sourceLease: { token: 'lease' } });
  assert.equal(await fs.stat(directory).then(() => true, () => false), false);
});
