const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  ScyllaManagerAdapter,
  authorizationHeader,
  normalizeBackupTarget,
  normalizeConfig,
  normalizeRestoreTarget,
  normalizeStatus,
  parseManagerVersion,
  safeApiPath,
  stableDigest,
  taskProperties
} = require('./scylla-manager');

const CREDENTIAL = 'manager-secret-value';
const CLUSTER_ID = '8c3fd8a0-148f-4c6d-a67c-876543210abc';

function connectionConfig(overrides = {}) {
  return {
    host: 'manager01.example.com',
    port: 5080,
    basePath: '/api/v1',
    authMode: 'bearer',
    credentialSecretRefId: 'sec_manager123',
    tlsMode: 'verify-identity',
    managedClusterId: CLUSTER_ID,
    ...overrides
  };
}

function cluster(overrides = {}) {
  return {
    id: CLUSTER_ID,
    name: 'production-scylla',
    host: 'scylla-seed.internal',
    port: 10001,
    labels: { environment: 'production' },
    username: 'must-not-escape',
    password: 'must-not-escape',
    auth_token: 'must-not-escape',
    ...overrides
  };
}

function status(overrides = {}) {
  return [{
    dc: 'dc1',
    host_id: '11111111-1111-1111-1111-111111111111',
    host: '10.0.0.11',
    status: 'UP',
    cql_status: 'UP',
    rest_status: 'UP',
    scylla_version: '2025.1.3',
    agent_version: '3.11.0',
    total_ram: 68719476736,
    cpu_count: 16,
    ...overrides
  }];
}

function backupTarget(overrides = {}) {
  return {
    cluster_id: CLUSTER_ID,
    host: '10.0.0.11',
    dc: ['dc1'],
    with_hosts: ['10.0.0.11'],
    location: ['s3:company-backups/production'],
    retention: 4,
    retention_days: 30,
    rate_limit: ['dc1:100M'],
    snapshot_parallel: ['dc1:2'],
    upload_parallel: ['dc1:4'],
    units: [{ keyspace: 'orders', tables: ['items', 'payments'], all_tables: false }],
    size: 4096,
    transfers: 4,
    purge_only: false,
    skip_schema: false,
    method: 'native',
    retention_lock_mode: 'none',
    override_retention_lock: false,
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    cluster_id: CLUSTER_ID,
    type: 'backup',
    id: 'task-backup-001',
    name: 'deployerx-backup-1234567890',
    labels: { 'deployerx.owner': 'deployerx', 'deployerx.operation': 'backup', 'deployerx.execution': 'execution123' },
    enabled: false,
    schedule: {},
    properties: {},
    status: 'RUNNING',
    ...overrides
  };
}

class Transport {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  async request(input) {
    this.calls.push(input);
    return this.handler(input, this.calls.length);
  }
}

function json(body, headers = {}) {
  return { statusCode: 200, headers: { 'content-type': 'application/json', ...headers }, body };
}

function environmentTransport(overrides = {}) {
  return new Transport(async (input) => {
    if (input.apiPath === '/version') return json({ version: overrides.version || '3.11.0' });
    if (input.apiPath === '/clusters') return json(overrides.clusters || [cluster()]);
    if (input.apiPath === `/cluster/${CLUSTER_ID}`) return json(overrides.cluster || cluster());
    if (input.apiPath === `/cluster/${CLUSTER_ID}/status`) return json(overrides.status || status());
    if (input.apiPath === `/cluster/${CLUSTER_ID}/tasks/backup/target`) return json(overrides.target || backupTarget());
    throw new Error(`Unexpected Manager request: ${input.method} ${input.apiPath}`);
  });
}

test('normalizes only verified HTTPS Manager settings and SecretRef authentication', () => {
  const normalized = normalizeConfig(connectionConfig({ clientCertificateFile: 'C:\\certs\\manager.crt', clientKeyFile: 'C:\\certs\\manager.key' }));
  assert.equal(normalized.host, 'manager01.example.com');
  assert.equal(normalized.basePath, '/api/v1');
  assert.equal(safeApiPath(normalized, `/cluster/${CLUSTER_ID}/tasks`, { all: true, type: ['backup', 'restore'] }), `/api/v1/cluster/${CLUSTER_ID}/tasks?all=true&type=backup&type=restore`);
  assert.equal(authorizationHeader(normalized, CREDENTIAL), `Bearer ${CREDENTIAL}`);
  assert.equal(authorizationHeader(normalizeConfig(connectionConfig({ authMode: 'none', credentialSecretRefId: null })), null), null);
  assert.throws(() => normalizeConfig(connectionConfig({ host: 'https://manager.example.com' })), /without a URI scheme/);
  assert.throws(() => normalizeConfig(connectionConfig({ tlsMode: 'disabled' })), /TLS certificate identity verification/);
  assert.throws(() => normalizeConfig(connectionConfig({ basePath: '/../admin' })), /base path is invalid/);
  assert.throws(() => normalizeConfig(connectionConfig({ authMode: 'basic', username: null })), /username and credential SecretRef/);
  assert.throws(() => normalizeConfig(connectionConfig({ clientCertificateFile: 'C:\\certs\\manager.crt' })), /both a client certificate/);
});

test('accepts supported Manager 3.x versions and rejects other major versions', () => {
  assert.deepEqual(parseManagerVersion({ version: '3.11.0' }), { text: '3.11.0', major: 3, minor: 11, patch: 0 });
  assert.equal(parseManagerVersion('v3.9.2-build7').major, 3);
  assert.throws(() => parseManagerVersion('2.6.2'), (error) => error.code === 'SCYLLA_MANAGER_VERSION_UNSUPPORTED');
  assert.throws(() => parseManagerVersion('development'), (error) => error.code === 'SCYLLA_MANAGER_VERSION_INVALID');
});

test('tests exact Manager and cluster identity without exposing Manager cluster credentials', async () => {
  const transport = environmentTransport();
  const adapter = new ScyllaManagerAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z', now: () => 10 });
  const result = await adapter.testConnection({ resolveSecret: async () => CREDENTIAL }, connectionConfig());
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.managerVersion, '3.11.0');
  assert.equal(result.endpointIdentity.managedClusterId, CLUSTER_ID);
  assert.equal(result.endpointIdentity.nodeCount, 1);
  assert.equal(result.endpointIdentity.healthy, true);
  assert.match(result.endpointIdentity.deploymentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
  assert.equal(JSON.stringify(result).includes(CREDENTIAL), false);
  assert.equal(transport.calls.length, 4);
  for (const call of transport.calls) assert.equal(call.authorization, `Bearer ${CREDENTIAL}`);
});

test('marks unhealthy agent, CQL, or REST state as a diagnostic warning and blocks target verification', async () => {
  const transport = environmentTransport({ status: status({ rest_status: 'DOWN' }) });
  const adapter = new ScyllaManagerAdapter({ transport: transport.request.bind(transport) });
  const result = await adapter.testConnection({ resolveSecret: async () => CREDENTIAL }, connectionConfig());
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.healthy, false);
  assert.equal(result.checks.find((check) => check.id === 'agent-cql-rest-health').status, 'warning');
  await assert.rejects(adapter.verifyBackupTarget({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), taskUpdate: { type: 'backup', properties: {} } }), (error) => error.code === 'SCYLLA_MANAGER_CLUSTER_UNHEALTHY');
});

test('pins Manager deployment identity and refuses changed cluster inventory', async () => {
  const initial = environmentTransport();
  const adapter = new ScyllaManagerAdapter({ transport: initial.request.bind(initial) });
  const result = await adapter.testConnection({ resolveSecret: async () => CREDENTIAL }, connectionConfig());
  const changed = environmentTransport({ cluster: cluster({ name: 'replacement-cluster' }), clusters: [cluster({ name: 'replacement-cluster' })] });
  const changedAdapter = new ScyllaManagerAdapter({ transport: changed.request.bind(changed) });
  const second = await changedAdapter.testConnection({ resolveSecret: async () => CREDENTIAL }, connectionConfig({ expectedManagerVersion: '3.11.0', expectedDeploymentFingerprint: result.endpointIdentity.deploymentFingerprint }));
  assert.equal(second.status, 'failure');
  assert.equal(second.error.code, 'SCYLLA_MANAGER_DEPLOYMENT_CHANGED');
});

test('normalizes bounded status, backup targets, and restore targets with stable location identities', () => {
  const topology = normalizeStatus(status(), CLUSTER_ID);
  assert.equal(topology.healthy, true);
  assert.deepEqual(topology.dataCenters, ['dc1']);
  assert.match(topology.topologyFingerprint, /^sha256:/);
  const backup = normalizeBackupTarget(backupTarget());
  assert.equal(backup.locations[0].scheme, 's3');
  assert.match(backup.locations[0].locationFingerprint, /^sha256:/);
  assert.deepEqual(backup.units[0].tables, ['items', 'payments']);
  assert.match(backup.targetFingerprint, /^sha256:/);
  const restore = normalizeRestoreTarget({
    cluster_id: CLUSTER_ID,
    location: ['s3:company-backups/production'],
    snapshot_tag: 'sm_20260804000000UTC',
    units: [{ keyspace: 'orders', size: 4096, tables: [{ table: 'items' }, { table: 'payments' }] }],
    size: 4096,
    views: [],
    batch_size: 2,
    parallel: 4,
    transfers: 4,
    rate_limit: ['dc1:100M'],
    allow_compaction: false,
    unpin_agent_cpu: false
  });
  assert.equal(restore.snapshotTag, 'sm_20260804000000UTC');
  assert.deepEqual(restore.units[0].tables, ['items', 'payments']);
  assert.throws(() => normalizeBackupTarget(backupTarget({ location: ['ftp://user:password@example.com/backup'] })), /unsafe credential material|unsupported/);
});

test('builds exact keyspace and table target properties without schema aliases', () => {
  const properties = taskProperties({
    locations: [{ location: 's3:company-backups/production' }],
    dataCenters: ['dc1'],
    method: 'native',
    retention: 4,
    retentionDays: 30,
    rateLimit: ['dc1:100M'],
    snapshotParallel: ['dc1:2'],
    uploadParallel: ['dc1:4'],
    transfers: 4,
    retentionLockMode: null
  }, {
    allDatabases: false,
    databases: { include: [{ name: 'orders' }, { name: 'customers' }] },
    tables: { include: [{ database: 'orders', schema: 'orders', name: 'items' }, { database: 'orders', schema: 'orders', name: 'payments' }] }
  });
  assert.deepEqual(properties.keyspace, ['customers.*', 'orders.items', 'orders.payments']);
  assert.equal(properties.skip_schema, false);
  assert.equal(properties.purge_only, false);
});

test('registers Manager as a separate native physical adapter', () => {
  const registry = new DatabaseAdapterRegistry([new ScyllaManagerAdapter({ transport: async () => json(null) })]);
  const manifest = registry.manifest(ADAPTER_ID);
  assert.equal(manifest.engine, 'scylla-manager');
  assert.deepEqual(manifest.capabilities.backupModes, ['native']);
  assert.deepEqual(manifest.capabilities.consistencyStrategies.map((item) => item.id), ['scylla-manager-backup']);
  assert.equal(manifest.capabilities.streaming.backup, false);
  assert.equal(manifest.capabilities.restore.alternateTarget, true);
  assert.equal(manifest.capabilities.restore.originalTarget, false);
});

test('dry-runs the exact backup target through DatabaseAdapterRegistry planning', async () => {
  const transport = environmentTransport();
  const adapter = new ScyllaManagerAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const plan = await registry.prepareBackup(ADAPTER_ID, { resolveSecret: async () => CREDENTIAL }, {
    connection: connectionConfig(),
    selector: { allDatabases: false, databases: { include: [{ name: 'orders' }] }, tables: { include: [{ database: 'orders', schema: 'orders', name: 'items' }, { database: 'orders', schema: 'orders', name: 'payments' }] } },
    consistency: { backupMethod: 'physical', backupMode: 'native', requestedLevel: 'crash', method: 'scylla-manager-backup', captureCoordinates: true },
    execution: { managedClusterId: CLUSTER_ID, locations: ['s3:company-backups/production'], dataCenters: ['dc1'], method: 'native', retention: 4, retentionDays: 30, rateLimit: ['dc1:100M'], snapshotParallel: ['dc1:2'], uploadParallel: ['dc1:4'], transfers: 4, executionId: 'execution-001', sourceId: 'source-001' }
  });
  assert.equal(plan.adapterPlan.operation, 'scylla-manager-backup');
  assert.equal(plan.adapterPlan.authoritativeOwner, 'scylla-manager');
  assert.equal(plan.adapterPlan.externalNativeMedia, true);
  assert.equal(plan.adapterPlan.target.targetFingerprint, normalizeBackupTarget(backupTarget()).targetFingerprint);
  assert.deepEqual(plan.adapterPlan.taskUpdate.properties.keyspace, ['orders.items', 'orders.payments']);
  assert.equal(plan.consistency.coordinateCaptureVerified, undefined);
  assert.equal(transport.calls.filter((call) => call.apiPath.endsWith('/tasks/backup/target')).length, 1);
});

test('refuses purge-only and schema-skipping Manager target verification', async () => {
  const transport = environmentTransport();
  const adapter = new ScyllaManagerAdapter({ transport: transport.request.bind(transport) });
  await assert.rejects(adapter.verifyBackupTarget({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), taskUpdate: { type: 'backup', properties: { purge_only: true } } }), (error) => error.code === 'SCYLLA_MANAGER_TARGET_REQUEST_UNSAFE');
  await assert.rejects(adapter.verifyBackupTarget({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), taskUpdate: { type: 'backup', properties: { skip_schema: true } } }), (error) => error.code === 'SCYLLA_MANAGER_TARGET_REQUEST_UNSAFE');
  assert.equal(transport.calls.length, 0);
});

test('creates, starts, monitors, and reconciles only the exact owned backup task', async () => {
  const ownedTask = task();
  let historyReads = 0;
  const transport = new Transport(async (input) => {
    if (input.apiPath === '/version') return json({ version: '3.11.0' });
    if (input.apiPath === '/clusters') return json([cluster()]);
    if (input.apiPath === `/cluster/${CLUSTER_ID}`) return json(cluster());
    if (input.apiPath === `/cluster/${CLUSTER_ID}/status`) return json(status());
    if (input.apiPath === `/cluster/${CLUSTER_ID}/tasks/backup/target`) return json(backupTarget());
    if (input.apiPath === `/cluster/${CLUSTER_ID}/tasks` && input.method === 'POST') return { statusCode: 201, headers: { location: `/api/v1/cluster/${CLUSTER_ID}/task/backup/${ownedTask.id}` }, body: null };
    if (input.apiPath === `/cluster/${CLUSTER_ID}/task/backup/${ownedTask.id}`) return json(ownedTask);
    if (input.apiPath === `/cluster/${CLUSTER_ID}/task/backup/${ownedTask.id}/start`) return { statusCode: 200, headers: {}, body: null };
    if (input.apiPath === `/cluster/${CLUSTER_ID}/task/backup/${ownedTask.id}/history`) {
      historyReads += 1;
      return json([{ cluster_id: CLUSTER_ID, type: 'backup', task_id: ownedTask.id, id: 'run-backup-001', status: historyReads > 1 ? 'DONE' : 'RUNNING', cause: 'user', start_time: '2026-08-04T00:00:00Z', end_time: historyReads > 1 ? '2026-08-04T00:01:00Z' : null }]);
    }
    if (input.apiPath === `/cluster/${CLUSTER_ID}/task/backup/${ownedTask.id}/run-backup-001`) {
      const done = historyReads > 1;
      return json({ run: { cluster_id: CLUSTER_ID, type: 'backup', task_id: ownedTask.id, id: 'run-backup-001', status: done ? 'DONE' : 'RUNNING', cause: 'user', start_time: '2026-08-04T00:00:00Z', end_time: done ? '2026-08-04T00:01:00Z' : null }, progress: { snapshot_tag: 'sm_20260804000000UTC', dcs: ['dc1'], hosts: [{}], stage: done ? 'DONE' : 'UPLOAD', size: 4096, uploaded: done ? 4096 : 2048, skipped: 0, failed: 0, started_at: '2026-08-04T00:00:00Z', completed_at: done ? '2026-08-04T00:01:00Z' : null, retention_days: 30, retention_lock_mode: 'none' } });
    }
    if (input.apiPath === `/cluster/${CLUSTER_ID}/backups`) return json([{ cluster_id: CLUSTER_ID, task_id: ownedTask.id, units: backupTarget().units, snapshot_info: [{ snapshot_tag: 'sm_20260804000000UTC', nodes: 1, size: 4096 }] }]);
    throw new Error(`Unexpected Manager request: ${input.method} ${input.apiPath}`);
  });
  let now = 0;
  const ownership = [];
  const adapter = new ScyllaManagerAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:01:00.000Z', now: () => now, delay: async () => { now += 500; }, maximumTaskWaitMs: 5000 });
  const target = normalizeBackupTarget(backupTarget());
  const plan = {
    version: 1,
    operation: 'scylla-manager-backup',
    connection: connectionConfig(),
    execution: { sourceId: null },
    taskUpdate: { name: ownedTask.name, type: 'backup', labels: ownedTask.labels, enabled: false, schedule: {}, properties: {} },
    target,
    externalNativeMedia: true,
    authoritativeOwner: 'scylla-manager'
  };
  const result = await adapter.executeBackup({ resolveSecret: async () => CREDENTIAL, planDigest: stableDigest(plan), onOwnership: async (item) => ownership.push(item) }, plan);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.taskId, ownedTask.id);
  assert.equal(result.runId, 'run-backup-001');
  assert.equal(result.snapshotTag, 'sm_20260804000000UTC');
  assert.equal(result.authoritativeOwner, 'scylla-manager');
  assert.equal(result.externalNativeMedia, true);
  assert.equal(result.progress.uploaded, 4096);
  assert.equal(ownership[0].taskId, ownedTask.id);
  assert.equal(ownership.at(-1).runId, 'run-backup-001');
  const create = transport.calls.find((call) => call.apiPath.endsWith('/tasks') && call.method === 'POST');
  assert.equal(create.body.enabled, false);
  assert.equal(create.body.labels['deployerx.owner'], 'deployerx');
  assert.equal(transport.calls.some((call) => call.method === 'DELETE'), false);
});

test('refuses to start or stop an unowned Manager task', async () => {
  const transport = new Transport(async (input) => {
    if (input.apiPath === `/cluster/${CLUSTER_ID}/task/backup/foreign-task`) return json(task({ id: 'foreign-task', labels: { owner: 'operator' } }));
    throw new Error(`Unexpected Manager request: ${input.method} ${input.apiPath}`);
  });
  const adapter = new ScyllaManagerAdapter({ transport: transport.request.bind(transport) });
  await assert.rejects(adapter.startTask({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), type: 'backup', taskId: 'foreign-task' }), (error) => error.code === 'SCYLLA_MANAGER_TASK_NOT_OWNED');
  await assert.rejects(adapter.stopTask({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), type: 'backup', taskId: 'foreign-task' }), (error) => error.code === 'SCYLLA_MANAGER_TASK_NOT_OWNED');
  assert.equal(transport.calls.some((call) => call.apiPath.endsWith('/start') || call.apiPath.endsWith('/stop')), false);
});

test('registers Manager connection, source-reader, task, backup-catalog, and audited restore desktop APIs', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8')
  ]);
  assert.match(mainSource, /new DatabaseAdapterRegistry\(\[[^\]]*scyllaManagerAdapter[^\]]*\]\)/);
  assert.match(mainSource, /new ScyllaManagerConnectionService\(\{ controlDatabase, secretStore: getBackupSecretStore\(\), deviceId: backupDeviceId, adapter: scyllaManagerAdapter \}\)/);
  assert.match(mainSource, /new ScyllaManagerSourceReaderService\(\{ controlDatabase, secretStore: getBackupSecretStore\(\), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: scyllaManagerAdapter \}\)/);
  assert.match(mainSource, /\[SCYLLA_MANAGER_ADAPTER_ID\]: scyllaManagerSourceReader/);
  assert.match(mainSource, /new ScyllaManagerRestoreService\(\{ controlDatabase, secretStore: getBackupSecretStore\(\), snapshotBrowser: backupSnapshotBrowserService, adapter: scyllaManagerAdapter, deviceId: backupDeviceId \}\)/);
  for (const operation of ['list', 'create', 'test', 'discover', 'verify-target']) assert.equal(mainSource.includes(`ipcMain.handle('backup:connections:scylla-manager:${operation}'`), true);
  for (const operation of ['list', 'start', 'stop', 'history', 'progress']) assert.equal(mainSource.includes(`ipcMain.handle('backup:scylla-manager:tasks:${operation}'`), true);
  assert.equal(mainSource.includes("ipcMain.handle('backup:scylla-manager:backups:list'"), true);
  for (const operation of ['preview', 'list', 'start', 'wait', 'cancel']) assert.equal(mainSource.includes(`ipcMain.handle('backup:scylla-manager-restores:${operation}'`), true);
  for (const action of ['connection.create-scylla-manager', 'connection.test-scylla-manager', 'connection.verify-scylla-manager-target', 'task.start-scylla-manager', 'task.stop-scylla-manager', 'restore.start-scylla-manager-alternate', 'restore.cancel-scylla-manager']) assert.equal(mainSource.includes(`action: '${action}'`), true);
  assert.equal(mainSource.includes("const confirmed = String(payload.confirmationText || '').trim() === SCYLLA_MANAGER_RESTORE_CONFIRMATION"), true);
  for (const api of ['listBackupScyllaManagerConnections', 'createBackupScyllaManagerConnection', 'testBackupScyllaManagerConnection', 'discoverBackupScyllaManagerResources', 'verifyBackupScyllaManagerTarget', 'listBackupScyllaManagerTasks', 'startBackupScyllaManagerTask', 'stopBackupScyllaManagerTask', 'getBackupScyllaManagerTaskHistory', 'getBackupScyllaManagerTaskProgress', 'listBackupScyllaManagerBackups', 'previewBackupScyllaManagerRestore', 'listBackupScyllaManagerRestoreRuns', 'startBackupScyllaManagerRestore', 'waitBackupScyllaManagerRestore', 'cancelBackupScyllaManagerRestore']) assert.equal(preloadSource.includes(`${api}:`), true);
});
