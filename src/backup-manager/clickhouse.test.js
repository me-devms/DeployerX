const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { ADAPTER_ID, DESTINATION_CONFIRMATION, RESTORE_CONFIRMATION, ClickHouseAdapter, ClickHouseConnectionService, QUERIES, clientConfigContents, destinationFingerprint, normalizeConfig, parseJsonRows, parseVersion, readDiscovery } = require('./clickhouse');

function lines(rows) { return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''); }

function outputs(overrides = {}) {
  return {
    [QUERIES.identity]: lines([{ version: '25.8.3.66', timezone: 'UTC', host_name: 'clickhouse-a', current_user: 'backup_user' }]),
    [QUERIES.databases]: lines([{ name: 'analytics', uuid: '11111111-1111-4111-8111-111111111111', engine: 'Atomic', data_path: '/var/lib/clickhouse/' }]),
    [QUERIES.tables]: lines([
      { database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'ReplicatedMergeTree', is_temporary: 0 },
      { database: 'analytics', name: 'daily', uuid: '33333333-3333-4333-8333-333333333333', engine: 'MaterializedView', is_temporary: 0 }
    ]),
    [QUERIES.clusters]: lines([{ cluster: 'production', shard_num: 1, shard_weight: 1, replica_num: 1, host_name: 'clickhouse-a', host_address: '10.0.0.1', port: 9440, is_local: 1, errors_count: 0, estimated_recovery_time: 0 }]),
    [QUERIES.replicas]: lines([{ database: 'analytics', table: 'events', zookeeper_path: '/clickhouse/tables/01/events', replica_name: 'clickhouse-a', is_readonly: 0, is_session_expired: 0, future_parts: 0, queue_size: 0, absolute_delay: 0, total_replicas: 2, active_replicas: 2 }]),
    [QUERIES.partitions]: lines([{ database: 'analytics', table: 'events', partition: '202608', part_count: 3, row_count: 1000, bytes_on_disk: 4096 }]),
    [QUERIES.disks]: lines([{ name: 'backups', type: 'local', path: '/var/lib/clickhouse/backups/', free_space: 100000, total_space: 200000, keep_free_space: 1000, is_read_only: 0, is_write_once: 0 }]),
    [QUERIES.namedCollections]: lines([{ name: 'backup_s3' }]),
    [QUERIES.grants]: lines([{ access_type: 'BACKUP', database: 'analytics', table: '*' }, { access_type: 'RESTORE', database: '*', table: '*' }, { access_type: 'SELECT', database: 'analytics', table: '*' }]),
    [QUERIES.backups]: lines([{ row_count: 2 }]),
    ...overrides
  };
}

function standaloneOutputs(overrides = {}) {
  return outputs({
    [QUERIES.tables]: lines([
      { database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'MergeTree', is_temporary: 0 },
      { database: 'analytics', name: 'daily', uuid: '33333333-3333-4333-8333-333333333333', engine: 'MaterializedView', is_temporary: 0 }
    ]),
    [QUERIES.clusters]: '',
    [QUERIES.replicas]: '',
    ...overrides
  });
}

function runner(resultMap, observations = []) {
  return async ({ executable, args }) => {
    const query = args.at(-1);
    observations.push({ executable, args: [...args], query });
    if (!(query in resultMap)) throw new Error(`Unexpected query: ${query}`);
    const value = resultMap[query];
    if (value instanceof Error) throw value;
    return { stdout: value, stderr: '', exitCode: 0 };
  };
}

const CONNECTION = { executionMode: 'local', host: 'clickhouse.example.com', port: 9440, tlsMode: 'required', username: 'backup_user', clientPath: 'clickhouse-client' };
const CONTEXT = { clickhouseConfigPath: 'C:\\protected\\client.xml' };

test('registers native full/incremental backup and alternate-target restore execution', async () => {
  const adapter = new ClickHouseAdapter();
  const manifest = new DatabaseAdapterRegistry([adapter]).manifest(ADAPTER_ID);
  assert.equal(manifest.executionReady, true);
  assert.equal(manifest.sourceEnrollmentReady, true);
  assert.deepEqual(manifest.capabilities.backupModes, ['full', 'incremental']);
  assert.equal(manifest.capabilities.restore.alternateTarget, true);
  assert.equal(manifest.capabilities.restore.nativeValidation, true);
  await assert.rejects(adapter.planRestore(), (error) => error.code === 'CLICKHOUSE_RESTORE_MODE_UNSUPPORTED');
});

test('normalizes local and SSH bindings without accepting inline credentials or unsafe endpoints', () => {
  assert.deepEqual(normalizeConfig(CONNECTION), { ...CONNECTION, sshConnectionId: null, passwordSecretRefId: null, timeoutMs: 30000, expectedVersion: null, expectedDeploymentFingerprint: null, expectedTopologyFingerprint: null });
  assert.equal(normalizeConfig({ executionMode: 'ssh', sshConnectionId: 'ssh-1', host: '10.0.0.2', tlsMode: 'disabled' }).port, 9000);
  assert.throws(() => normalizeConfig({ ...CONNECTION, password: 'plaintext' }), /Unknown ClickHouse connection field/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, host: 'https://clickhouse.example.com' }), /host is invalid/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, port: 70000 }), /port is invalid/);
});

test('parses supported ClickHouse releases and rejects malformed or unsupported versions', () => {
  assert.deepEqual(parseVersion('25.8.3.66'), { text: '25.8.3.66', major: 25, minor: 8, patch: 3, revision: 66 });
  assert.deepEqual(parseVersion('ClickHouse client version 23.12.2.59'), { text: '23.12.2.59', major: 23, minor: 12, patch: 2, revision: 59 });
  assert.throws(() => parseVersion('22.8.1.1'), (error) => error.code === 'CLICKHOUSE_VERSION_UNSUPPORTED');
  assert.throws(() => parseVersion('latest'), (error) => error.code === 'CLICKHOUSE_VERSION_INVALID');
});

test('parses bounded JSONEachRow output and rejects malformed or excessive rows', () => {
  assert.deepEqual(parseJsonRows('{"name":"analytics"}\n', 'test'), [{ name: 'analytics' }]);
  assert.throws(() => parseJsonRows('{bad}\n', 'test'), (error) => error.code === 'CLICKHOUSE_OUTPUT_INVALID');
  assert.throws(() => parseJsonRows('{}\n'.repeat(10001), 'test'), (error) => error.code === 'CLICKHOUSE_ROW_LIMIT');
});

test('escapes protected client configuration without placing passwords in command arguments', async () => {
  const config = normalizeConfig({ ...CONNECTION, username: 'backup<&user', passwordSecretRefId: 'secret-1' });
  const xml = clientConfigContents(config, 'pa<&ssword');
  assert.match(xml, /backup&lt;&amp;user/);
  assert.match(xml, /pa&lt;&amp;ssword/);
  const observations = [];
  await readDiscovery({ ...CONTEXT, runNativeCommand: runner(outputs(), observations) }, config);
  assert.equal(observations.length, Object.keys(QUERIES).length);
  assert.equal(observations.every((item) => item.executable === 'clickhouse-client' && item.args[0] === '--config-file=C:\\protected\\client.xml'), true);
  assert.equal(observations.some((item) => item.args.join(' ').includes('pa<&ssword')), false);
});

test('discovers bounded database, table, partition, storage, grant, and topology identities', async () => {
  const discovered = await readDiscovery({ ...CONTEXT, runNativeCommand: runner(outputs()) }, CONNECTION);
  assert.equal(discovered.version.text, '25.8.3.66');
  assert.equal(discovered.databases[0].uuid, '11111111-1111-4111-8111-111111111111');
  assert.equal(discovered.tables[0].engine, 'ReplicatedMergeTree');
  assert.equal(discovered.partitions[0].rowCount, 1000);
  assert.equal(discovered.disks[0].name, 'backups');
  assert.deepEqual(discovered.namedCollections, ['backup_s3']);
  assert.equal(discovered.grants[0].accessType, 'BACKUP');
  assert.equal(discovered.backupCatalogAvailable, true);
  assert.match(discovered.deploymentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(discovered.topologyFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('pins deployment and topology identity and reports optional catalog visibility safely', async () => {
  const first = await readDiscovery({ ...CONTEXT, runNativeCommand: runner(outputs()) }, CONNECTION);
  const pinned = { ...CONNECTION, expectedVersion: first.version.text, expectedDeploymentFingerprint: first.deploymentFingerprint, expectedTopologyFingerprint: first.topologyFingerprint };
  await readDiscovery({ ...CONTEXT, runNativeCommand: runner(outputs()) }, pinned);
  const changed = outputs({ [QUERIES.tables]: lines([{ database: 'analytics', name: 'events_v2', uuid: '44444444-4444-4444-8444-444444444444', engine: 'MergeTree', is_temporary: 0 }]) });
  await assert.rejects(readDiscovery({ ...CONTEXT, runNativeCommand: runner(changed) }, pinned), (error) => error.code === 'CLICKHOUSE_DEPLOYMENT_CHANGED');
  const optionalUnavailable = outputs({ [QUERIES.namedCollections]: new Error('denied'), [QUERIES.grants]: new Error('denied'), [QUERIES.backups]: new Error('missing') });
  const partial = await readDiscovery({ ...CONTEXT, runNativeCommand: runner(optionalUnavailable) }, CONNECTION);
  assert.deepEqual(partial.namedCollections, []);
  assert.deepEqual(partial.grants, []);
  assert.equal(partial.backupCatalogAvailable, false);
});

test('returns bounded diagnostics and discovery pages for the tested inventory', async () => {
  const adapter = new ClickHouseAdapter({ clock: () => '2026-08-05T12:00:00.000Z', now: (() => { let value = 1000; return () => value += 5; })() });
  const observations = [];
  const context = { ...CONTEXT, runNativeCommand: runner(outputs(), observations) };
  const result = await adapter.testConnection(context, CONNECTION);
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.backupCatalogAvailable, true);
  assert.equal(result.endpointIdentity.tableCount, 2);
  const pages = [];
  for await (const page of adapter.discover(context, { connection: CONNECTION, kind: 'all' })) pages.push(page);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].identity.currentUser, 'backup_user');
  assert.equal(pages[0].replicas[0].coordinationPath, '/clickhouse/tables/01/events');
});

async function nativeFixture(executionMode = 'asynchronous') {
  const adapter = new ClickHouseAdapter({ clock: () => '2026-08-05T12:00:00.000Z', now: () => 1000, delay: async () => {}, maximumBackupWaitMs: 1000 });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const base = standaloneOutputs();
  const observations = [];
  let expectedName = null;
  let statusRows = null;
  const runNativeCommand = async ({ executable, args }) => {
    const query = args.at(-1);
    observations.push({ executable, args: [...args], query });
    if (query in base) return { stdout: base[query], stderr: '', exitCode: 0 };
    if (query.startsWith('BACKUP ')) return { stdout: '', stderr: '', exitCode: 0 };
    if (query.includes('FROM system.backups WHERE id = ')) return { stdout: lines(statusRows || [{ id: /WHERE id = '([^']+)'/.exec(query)?.[1], name: expectedName, status: 'BACKUP_CREATED', error: '', start_time: '2026-08-05 12:00:00', end_time: '2026-08-05 12:00:01', num_files: 4, total_size: 100, num_entries: 2, uncompressed_size: 200, compressed_size: 100, files_read: 4, bytes_read: 200 }]), stderr: '', exitCode: 0 };
    throw new Error(`Unexpected query: ${query}`);
  };
  const context = { ...CONTEXT, runNativeCommand };
  const discovery = await readDiscovery(context, CONNECTION);
  const connection = { ...CONNECTION, expectedVersion: discovery.version.text, expectedDeploymentFingerprint: discovery.deploymentFingerprint, expectedTopologyFingerprint: discovery.topologyFingerprint };
  const disk = discovery.disks[0];
  const prepared = await registry.prepareBackup(ADAPTER_ID, context, {
    connection,
    selector: { databases: { include: [{ name: 'analytics' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full', method: 'clickhouse-native-backup', captureCoordinates: true },
    execution: { destinationType: 'disk', diskName: disk.name, destinationFingerprint: destinationFingerprint(disk), executionMode, executionId: 'run-1', sourceId: 'source-1', workspaceId: 'workspace-a' }
  });
  expectedName = prepared.adapterPlan.destinationName;
  return { adapter, registry, connection, context, disk, discovery, prepared, observations, setExpectedName: (name) => { expectedName = name; }, setStatusRows: (rows) => { statusRows = rows; } };
}

test('plans and executes an exact asynchronous ClickHouse native full backup', async () => {
  const fixture = await nativeFixture('asynchronous');
  assert.match(fixture.prepared.adapterPlan.statement, /^BACKUP DATABASE `analytics` TO Disk\('backups', 'deployerx\/[0-9a-f]{16}\/deployerx-[0-9a-f]{32}\.zip'\) SETTINGS id = 'deployerx-[0-9a-f]{32}' ASYNC$/);
  assert.equal(fixture.prepared.adapterPlan.selector.databases.include[0].name, 'analytics');
  const ownership = [];
  const result = await fixture.adapter.executeBackup({ ...fixture.context, planDigest: fixture.prepared.planDigest, onOwnership: async (owner) => ownership.push(owner) }, fixture.prepared.adapterPlan);
  assert.equal(result.kind, 'clickhouse-native-backup');
  assert.equal(result.externalNativeMedia, true);
  assert.equal(result.restoreSupported, true);
  assert.deepEqual(result.selection.statistics, [
    { database: 'analytics', table: 'daily', partCount: 0, rowCount: 0, partitionCount: 0 },
    { database: 'analytics', table: 'events', partCount: 3, rowCount: 1000, partitionCount: 1 }
  ]);
  assert.equal(result.operation.status, 'BACKUP_CREATED');
  assert.equal(ownership[0].operationId, fixture.prepared.adapterPlan.operationId);
  const submission = fixture.observations.find((item) => item.query.startsWith('BACKUP '));
  assert.equal(submission.args.includes(`--query_id=${fixture.prepared.adapterPlan.operationId}`), true);
  const statusQueries = fixture.observations.filter((item) => item.query.includes('FROM system.backups WHERE id = '));
  assert.equal(statusQueries.length, 1);
  assert.match(statusQueries[0].query, /LIMIT 2 FORMAT JSONEachRow$/);
});

test('authenticates an exact native base and constructs incremental BACKUP without persisted SQL', async () => {
  const fixture = await nativeFixture('asynchronous');
  const baseBackup = {
    version: 1, operationId: fixture.prepared.adapterPlan.operationId, relativePath: fixture.prepared.adapterPlan.relativePath,
    parentRecoveryPointId: 'point-full', chainRootRecoveryPointId: 'point-full', ancestorRecoveryPointIds: ['point-full'],
    selectionDigest: fixture.prepared.selector.digest, destinationFingerprint: destinationFingerprint(fixture.disk),
    deploymentFingerprint: fixture.discovery.deploymentFingerprint, topologyFingerprint: fixture.discovery.topologyFingerprint,
    metadataDigest: `sha256:${'1'.repeat(64)}`
  };
  const incremental = await fixture.registry.prepareBackup(ADAPTER_ID, fixture.context, {
    connection: fixture.connection,
    selector: { databases: { include: [{ name: 'analytics' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'incremental', method: 'clickhouse-native-backup', captureCoordinates: true },
    execution: { destinationType: 'disk', diskName: fixture.disk.name, destinationFingerprint: destinationFingerprint(fixture.disk), executionMode: 'asynchronous', executionId: 'run-2', sourceId: 'source-1', workspaceId: 'workspace-a', jobId: 'job-1', baseBackup }
  });
  assert.equal(incremental.adapterPlan.operation, 'clickhouse-native-incremental');
  assert.match(incremental.adapterPlan.statement, /SETTINGS id = 'deployerx-[0-9a-f]{32}', base_backup = Disk\('backups', 'deployerx\/[0-9a-f]{16}\/deployerx-[0-9a-f]{32}[.]zip'\) ASYNC$/);
  assert.equal(incremental.adapterPlan.statement.includes(fixture.prepared.adapterPlan.statement), false);
  fixture.setExpectedName(incremental.adapterPlan.destinationName);
  const result = await fixture.adapter.executeBackup({ ...fixture.context, planDigest: incremental.planDigest }, incremental.adapterPlan);
  assert.equal(result.backupMode, 'incremental');
  assert.equal(result.chain.parentRecoveryPointId, 'point-full');
  assert.equal(result.chain.baseOperationId, fixture.prepared.adapterPlan.operationId);

  await assert.rejects(fixture.registry.prepareBackup(ADAPTER_ID, fixture.context, {
    connection: fixture.connection,
    selector: { databases: { include: [{ name: 'analytics' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'incremental', method: 'clickhouse-native-backup', captureCoordinates: true },
    execution: { destinationType: 'disk', diskName: fixture.disk.name, destinationFingerprint: destinationFingerprint(fixture.disk), executionMode: 'asynchronous', executionId: 'run-3', sourceId: 'source-1', workspaceId: 'workspace-a', jobId: 'job-1', baseBackup: { ...baseBackup, selectionDigest: '0'.repeat(64) } }
  }), (error) => error.code === 'CLICKHOUSE_BASE_IDENTITY_CHANGED');
  fixture.setStatusRows([]);
  await assert.rejects(fixture.registry.prepareBackup(ADAPTER_ID, fixture.context, {
    connection: fixture.connection,
    selector: { databases: { include: [{ name: 'analytics' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'incremental', method: 'clickhouse-native-backup', captureCoordinates: true },
    execution: { destinationType: 'disk', diskName: fixture.disk.name, destinationFingerprint: destinationFingerprint(fixture.disk), executionMode: 'asynchronous', executionId: 'run-4', sourceId: 'source-1', workspaceId: 'workspace-a', jobId: 'job-1', baseBackup }
  }), (error) => error.code === 'CLICKHOUSE_BACKUP_STATUS_AMBIGUOUS');
});

test('supports synchronous native backup and rejects failed or ambiguous exact operation status', async () => {
  const synchronous = await nativeFixture('synchronous');
  assert.equal(synchronous.prepared.adapterPlan.statement.endsWith(' ASYNC'), false);
  await synchronous.adapter.executeBackup({ ...synchronous.context, planDigest: synchronous.prepared.planDigest }, synchronous.prepared.adapterPlan);

  const failed = await nativeFixture();
  failed.setStatusRows([{ id: failed.prepared.adapterPlan.operationId, name: failed.prepared.adapterPlan.destinationName, status: 'BACKUP_FAILED', error: 'disk full', start_time: '', end_time: '', num_files: 0, total_size: 0, num_entries: 0, uncompressed_size: 0, compressed_size: 0, files_read: 0, bytes_read: 0 }]);
  await assert.rejects(failed.adapter.executeBackup({ ...failed.context, planDigest: failed.prepared.planDigest }, failed.prepared.adapterPlan), (error) => error.code === 'CLICKHOUSE_BACKUP_FAILED' && !error.message.includes('disk full'));

  const ambiguous = await nativeFixture();
  const row = { id: ambiguous.prepared.adapterPlan.operationId, name: ambiguous.prepared.adapterPlan.destinationName, status: 'BACKUP_CREATED', error: '', start_time: '', end_time: '', num_files: 1, total_size: 1, num_entries: 1, uncompressed_size: 1, compressed_size: 1, files_read: 1, bytes_read: 1 };
  ambiguous.setStatusRows([row, row]);
  await assert.rejects(ambiguous.adapter.executeBackup({ ...ambiguous.context, planDigest: ambiguous.prepared.planDigest }, ambiguous.prepared.adapterPlan), (error) => error.code === 'CLICKHOUSE_BACKUP_STATUS_AMBIGUOUS');
});

test('preserves ownership on cancellation and rejects missing status or post-backup deployment drift', async () => {
  const missing = await nativeFixture();
  missing.setStatusRows([]);
  await assert.rejects(missing.adapter.executeBackup({ ...missing.context, planDigest: missing.prepared.planDigest }, missing.prepared.adapterPlan), (error) => error.code === 'CLICKHOUSE_BACKUP_STATUS_AMBIGUOUS');

  const canceled = await nativeFixture();
  const ownership = [];
  await assert.rejects(canceled.adapter.executeBackup({ ...canceled.context, signal: { aborted: true }, planDigest: canceled.prepared.planDigest, onOwnership: async (owner) => ownership.push(owner) }, canceled.prepared.adapterPlan), (error) => error.code === 'CLICKHOUSE_OPERATION_CANCELED');
  assert.equal(ownership.length, 1);
  assert.equal(ownership[0].operationId, canceled.prepared.adapterPlan.operationId);

  const drifted = await nativeFixture();
  const baseRunner = drifted.context.runNativeCommand;
  let submitted = false;
  drifted.context.runNativeCommand = async (input) => {
    const query = input.args.at(-1);
    if (query.startsWith('BACKUP ')) submitted = true;
    if (submitted && query === QUERIES.tables) return { stdout: lines([{ database: 'analytics', name: 'events', uuid: '44444444-4444-4444-8444-444444444444', engine: 'MergeTree', is_temporary: 0 }]), stderr: '', exitCode: 0 };
    return baseRunner(input);
  };
  await assert.rejects(drifted.adapter.executeBackup({ ...drifted.context, planDigest: drifted.prepared.planDigest }, drifted.prepared.adapterPlan), (error) => error.code === 'CLICKHOUSE_DEPLOYMENT_CHANGED');
});

async function restoreFixture() {
  const backup = await nativeFixture();
  const metadata = await backup.adapter.executeBackup({ ...backup.context, planDigest: backup.prepared.planDigest }, backup.prepared.adapterPlan);
  const initial = standaloneOutputs();
  const restored = standaloneOutputs({
    [QUERIES.databases]: lines([
      { name: 'analytics', uuid: '11111111-1111-4111-8111-111111111111', engine: 'Atomic', data_path: '/var/lib/clickhouse/' },
      { name: 'analytics_restore', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', engine: 'Atomic', data_path: '/var/lib/clickhouse/' }
    ]),
    [QUERIES.tables]: lines([
      { database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'MergeTree', is_temporary: 0 },
      { database: 'analytics', name: 'daily', uuid: '33333333-3333-4333-8333-333333333333', engine: 'MaterializedView', is_temporary: 0 },
      { database: 'analytics_restore', name: 'events', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', engine: 'MergeTree', is_temporary: 0 },
      { database: 'analytics_restore', name: 'daily', uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', engine: 'MaterializedView', is_temporary: 0 }
    ]),
    [QUERIES.partitions]: lines([
      { database: 'analytics', table: 'events', partition: '202608', part_count: 3, row_count: 1000, bytes_on_disk: 4096 },
      { database: 'analytics_restore', table: 'events', partition: '202608', part_count: 3, row_count: 1000, bytes_on_disk: 4096 }
    ])
  });
  const observations = [];
  let submitted = false;
  let restoreRows = null;
  const runNativeCommand = async ({ executable, args }) => {
    const query = args.at(-1);
    observations.push({ executable, args: [...args], query });
    if (query.startsWith('RESTORE ')) { submitted = true; return { stdout: '', stderr: '', exitCode: 0 }; }
    if (query.includes('FROM system.backups WHERE id = ')) return { stdout: lines(restoreRows || [{ id: /WHERE id = '([^']+)'/.exec(query)?.[1], name: metadata.destination.backupName, status: 'RESTORED', error: '', start_time: '2026-08-05 12:00:00', end_time: '2026-08-05 12:00:01', num_files: 4, total_size: 100, num_entries: 2, uncompressed_size: 200, compressed_size: 100, files_read: 4, bytes_read: 200 }]), stderr: '', exitCode: 0 };
    if (query.startsWith('SELECT count() AS sample_count FROM ')) return { stdout: lines([{ sample_count: 1 }]), stderr: '', exitCode: 0 };
    const source = submitted ? restored : initial;
    if (query in source) return { stdout: source[query], stderr: '', exitCode: 0 };
    throw new Error(`Unexpected query: ${query}`);
  };
  const adapter = new ClickHouseAdapter({ now: () => 1000, delay: async () => {}, maximumRestoreWaitMs: 1000 });
  const context = { ...CONTEXT, runNativeCommand };
  const targetDiscovery = await readDiscovery(context, CONNECTION);
  const connection = { ...CONNECTION, expectedVersion: targetDiscovery.version.text, expectedDeploymentFingerprint: targetDiscovery.deploymentFingerprint, expectedTopologyFingerprint: targetDiscovery.topologyFingerprint };
  const source = { kind: metadata.kind, adapterId: metadata.adapterId, productVersion: metadata.productVersion, deploymentFingerprint: metadata.deploymentFingerprint, topologyFingerprint: metadata.topologyFingerprint, destination: metadata.destination, operation: metadata.operation, selection: metadata.selection };
  const operationId = `deployerx-restore-${'a'.repeat(32)}`;
  return { adapter, context, connection, source, metadata, observations, operationId, setRows: (rows) => { restoreRows = rows; } };
}

test('plans, monitors, and validates one exact native full restore into an empty alternate database', async () => {
  const fixture = await restoreFixture();
  const plan = await fixture.adapter.planRestore(fixture.context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: fixture.operationId, connection: fixture.connection, targetDatabase: 'analytics_restore', source: fixture.source });
  assert.match(plan.statement, /^RESTORE DATABASE `analytics` AS `analytics_restore` FROM Disk\('backups', 'deployerx\/[0-9a-f]{16}\/deployerx-[0-9a-f]{32}[.]zip'\) SETTINGS id = 'deployerx-restore-[0-9a-f]{32}' ASYNC$/);
  const boundaries = [];
  const restored = await fixture.adapter.executeRestore({ ...fixture.context, onMutationStarted: async (owner) => boundaries.push(owner) }, plan);
  const validation = await fixture.adapter.validateRestore(fixture.context, restored);
  assert.equal(validation.valid, true);
  assert.equal(validation.mappings.length, 2);
  assert.equal(validation.mappings.find((item) => item.targetTable === 'events').rowCount, 1000);
  assert.deepEqual(boundaries.map((item) => item.operationId), [fixture.operationId]);
  const submission = fixture.observations.find((item) => item.query.startsWith('RESTORE '));
  assert.equal(submission.args.includes(`--query_id=${fixture.operationId}`), true);
  assert.equal(fixture.observations.filter((item) => item.query.includes('FROM system.backups WHERE id = ')).length, 1);
  assert.equal(fixture.observations.filter((item) => item.query.startsWith('SELECT count() AS sample_count FROM ')).length, 2);
});

test('refuses unsafe restore targets and preserves post-submission cancellation evidence', async () => {
  const collision = await restoreFixture();
  await assert.rejects(collision.adapter.planRestore(collision.context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: collision.operationId, connection: collision.connection, targetDatabase: 'analytics', source: collision.source }), (error) => error.code === 'CLICKHOUSE_RESTORE_SOURCE_TARGET_COLLISION');

  const occupied = await restoreFixture();
  await assert.rejects(occupied.adapter.planRestore(occupied.context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: occupied.operationId, connection: occupied.connection, targetDatabase: 'analytics', source: { ...occupied.source, deploymentFingerprint: `sha256:${'f'.repeat(64)}` } }), (error) => error.code === 'CLICKHOUSE_RESTORE_TARGET_NOT_EMPTY');

  const canceled = await restoreFixture();
  const plan = await canceled.adapter.planRestore(canceled.context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: canceled.operationId, connection: canceled.connection, targetDatabase: 'analytics_restore', source: canceled.source });
  const boundaries = [];
  await assert.rejects(canceled.adapter.executeRestore({ ...canceled.context, signal: { aborted: true }, onMutationStarted: async (owner) => boundaries.push(owner) }, plan), (error) => error.code === 'CLICKHOUSE_RESTORE_CANCELED');
  assert.equal(boundaries.length, 1);
});

test('fails closed for changed media, ambiguous or failed native status, and restored count drift', async () => {
  const media = await restoreFixture();
  await assert.rejects(media.adapter.planRestore(media.context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: media.operationId, connection: media.connection, targetDatabase: 'analytics_restore', source: { ...media.source, destination: { ...media.source.destination, destinationFingerprint: `sha256:${'f'.repeat(64)}` } } }), (error) => error.code === 'CLICKHOUSE_RESTORE_MEDIA_UNAVAILABLE');

  const ambiguous = await restoreFixture();
  const ambiguousPlan = await ambiguous.adapter.planRestore(ambiguous.context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: ambiguous.operationId, connection: ambiguous.connection, targetDatabase: 'analytics_restore', source: ambiguous.source });
  const row = { id: ambiguous.operationId, name: ambiguous.metadata.destination.backupName, status: 'RESTORED', error: '', start_time: '', end_time: '', num_files: 1, total_size: 1, num_entries: 1, uncompressed_size: 1, compressed_size: 1, files_read: 1, bytes_read: 1 };
  ambiguous.setRows([row, row]);
  await assert.rejects(ambiguous.adapter.executeRestore(ambiguous.context, ambiguousPlan), (error) => error.code === 'CLICKHOUSE_RESTORE_STATUS_AMBIGUOUS');

  const failed = await restoreFixture();
  const failedPlan = await failed.adapter.planRestore(failed.context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: failed.operationId, connection: failed.connection, targetDatabase: 'analytics_restore', source: failed.source });
  failed.setRows([{ ...row, id: failed.operationId, name: failed.metadata.destination.backupName, status: 'RESTORE_FAILED', error: 'private target detail', num_entries: 0, files_read: 0, bytes_read: 0 }]);
  await assert.rejects(failed.adapter.executeRestore(failed.context, failedPlan), (error) => error.code === 'CLICKHOUSE_RESTORE_FAILED' && !error.message.includes('private target detail'));

  const drift = await restoreFixture();
  const driftSource = { ...drift.source, selection: { ...drift.source.selection, statistics: drift.source.selection.statistics.map((item) => item.table === 'events' ? { ...item, rowCount: item.rowCount + 1 } : item) } };
  const driftPlan = await drift.adapter.planRestore(drift.context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: drift.operationId, connection: drift.connection, targetDatabase: 'analytics_restore', source: driftSource });
  const restored = await drift.adapter.executeRestore(drift.context, driftPlan);
  await assert.rejects(drift.adapter.validateRestore(drift.context, restored), (error) => error.code === 'CLICKHOUSE_RESTORE_COUNT_MISMATCH');
});

test('approves one current writable ClickHouse disk and invalidates stale approval on retest', async (context) => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'deployerx-clickhouse-approval-'));
  context.after(() => fsp.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const discovery = await readDiscovery({ ...CONTEXT, runNativeCommand: runner(standaloneOutputs()) }, CONNECTION);
  const connection = await controlDatabase.repository('connection').create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'ClickHouse', kind: 'database', adapterId: ADAPTER_ID, endpoint: { ...CONNECTION, expectedVersion: discovery.version.text, expectedDeploymentFingerprint: discovery.deploymentFingerprint, expectedTopologyFingerprint: discovery.topologyFingerprint }, secretRefIds: [], workerAffinity: ['device:device-a'], lastTest: { status: 'success', endpointIdentity: { deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint } }, trust: { fingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint } });
  const service = new ClickHouseConnectionService({ controlDatabase, secretStore: {}, deviceId: 'device-a', clock: () => '2026-08-05T12:00:00.000Z' });
  service.withExecution = async (_workspaceId, _connection, _signal, callback) => callback({ ...CONTEXT, runNativeCommand: runner(standaloneOutputs()) }, { ...connection.endpoint });
  await assert.rejects(service.approveDestination('workspace-a', connection.id, { diskName: 'backups', confirmationText: 'wrong' }, 'tester'), /USE CLICKHOUSE BACKUP DISK/);
  const approved = await service.approveDestination('workspace-a', connection.id, { diskName: 'backups', confirmationText: DESTINATION_CONFIRMATION }, 'tester');
  assert.equal(approved.destinationTrust.diskName, 'backups');
  assert.match(approved.destinationTrust.destinationFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(approved.destinationTrust.path, undefined);
  const changedStorage = standaloneOutputs({ [QUERIES.disks]: lines([{ name: 'backups', type: 'local', path: '/var/lib/clickhouse/backups/', free_space: 100000, total_space: 300000, keep_free_space: 1000, is_read_only: 0, is_write_once: 0 }]) });
  service.withExecution = async (_workspaceId, current, _signal, callback) => callback({ ...CONTEXT, runNativeCommand: runner(changedStorage) }, service.config(current));
  const retested = await service.test('workspace-a', connection.id, 'tester');
  assert.equal(retested.connection.clickhouseDestinationTrust, null);
});

test('registers audited ClickHouse desktop discovery, destination, and restore APIs', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const channel of ['backup:connections:clickhouse:list', 'backup:connections:clickhouse:create', 'backup:connections:clickhouse:test', 'backup:connections:clickhouse:discover', 'backup:connections:clickhouse:approve-destination', 'backup:clickhouse-restores:preview', 'backup:clickhouse-restores:list', 'backup:clickhouse-restores:start', 'backup:clickhouse-restores:wait', 'backup:clickhouse-restores:cancel']) {
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(main, /ClickHouseSourceReaderService/);
  assert.match(preload, /approveBackupClickHouseDestination/);
  assert.match(main, /ClickHouseRestoreService/);
  assert.match(preload, /startBackupClickHouseRestore/);
});
