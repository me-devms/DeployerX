const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { BackupJobService } = require('./backup-job');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { ADAPTER_ID, ScyllaManagerAdapter, ScyllaManagerConnectionService, stableDigest } = require('./scylla-manager');
const { ScyllaManagerSourceReaderService, preparationPrefix } = require('./scylla-manager-source-reader');

const CLUSTER_ID = '8c3fd8a0-148f-4c6d-a67c-876543210abc';

class LifecycleTransport {
  constructor() {
    this.calls = [];
    this.created = null;
  }

  async request(input) {
    this.calls.push({ apiPath: input.apiPath, method: input.method, body: structuredClone(input.body), authorization: input.authorization });
    if (input.apiPath === '/version') return this.#json({ version: '3.11.0' });
    if (input.apiPath === '/clusters') return this.#json([this.#cluster()]);
    if (input.apiPath === `/cluster/${CLUSTER_ID}`) return this.#json(this.#cluster());
    if (input.apiPath === `/cluster/${CLUSTER_ID}/status`) return this.#json([this.#status()]);
    if (input.apiPath === `/cluster/${CLUSTER_ID}/tasks/backup/target`) return this.#json(this.#target());
    if (input.apiPath === `/cluster/${CLUSTER_ID}/tasks` && input.method === 'POST') {
      this.created = { id: 'manager-task-001', body: structuredClone(input.body) };
      return { statusCode: 201, headers: { location: `/api/v1/cluster/${CLUSTER_ID}/task/backup/${this.created.id}` }, body: null };
    }
    if (input.apiPath === `/cluster/${CLUSTER_ID}/task/backup/manager-task-001`) return this.#json({ cluster_id: CLUSTER_ID, type: 'backup', id: this.created.id, name: this.created.body.name, labels: this.created.body.labels, enabled: false, schedule: {}, properties: this.created.body.properties, status: 'DONE' });
    if (input.apiPath === `/cluster/${CLUSTER_ID}/task/backup/manager-task-001/start`) return { statusCode: 200, headers: {}, body: null };
    if (input.apiPath === `/cluster/${CLUSTER_ID}/task/backup/manager-task-001/history`) return this.#json([{ cluster_id: CLUSTER_ID, type: 'backup', task_id: 'manager-task-001', id: 'manager-run-001', status: 'DONE', cause: 'user', start_time: '2026-08-04T00:00:00Z', end_time: '2026-08-04T00:01:00Z' }]);
    if (input.apiPath === `/cluster/${CLUSTER_ID}/task/backup/manager-task-001/manager-run-001`) return this.#json({ run: { cluster_id: CLUSTER_ID, type: 'backup', task_id: 'manager-task-001', id: 'manager-run-001', status: 'DONE', cause: 'user', start_time: '2026-08-04T00:00:00Z', end_time: '2026-08-04T00:01:00Z' }, progress: { snapshot_tag: 'sm_20260804000000UTC', dcs: ['dc1'], hosts: [{}], stage: 'DONE', size: 4096, uploaded: 4096, skipped: 0, failed: 0, started_at: '2026-08-04T00:00:00Z', completed_at: '2026-08-04T00:01:00Z', retention_days: 30, retention_lock_mode: 'none' } });
    if (input.apiPath === `/cluster/${CLUSTER_ID}/backups`) return this.#json([{ cluster_id: CLUSTER_ID, task_id: 'manager-task-001', units: this.#target().units, snapshot_info: [{ snapshot_tag: 'sm_20260804000000UTC', nodes: 1, size: 4096 }] }]);
    throw new Error(`Unexpected Manager API request: ${input.method} ${input.apiPath}`);
  }

  #cluster() { return { id: CLUSTER_ID, name: 'production-scylla', host: '10.0.0.11', port: 10001, labels: { environment: 'production' }, password: 'must-not-escape' }; }
  #status() { return { dc: 'dc1', host_id: '11111111-1111-1111-1111-111111111111', host: '10.0.0.11', status: 'UP', cql_status: 'UP', rest_status: 'UP', scylla_version: '2025.1.3', agent_version: '3.11.0', total_ram: 68719476736, cpu_count: 16 }; }
  #target() { return { cluster_id: CLUSTER_ID, host: '10.0.0.11', dc: ['dc1'], with_hosts: ['10.0.0.11'], location: ['s3:company-backups/production'], retention: 4, retention_days: 30, rate_limit: ['dc1:100M'], snapshot_parallel: ['dc1:2'], upload_parallel: ['dc1:4'], units: [{ keyspace: 'orders', tables: ['items', 'payments'], all_tables: false }], size: 4096, transfers: 4, purge_only: false, skip_schema: false, method: 'native', retention_lock_mode: 'none', override_retention_lock: false }; }
  #json(body) { return { statusCode: 200, headers: { 'content-type': 'application/json' }, body }; }
}

function secretStore() {
  return { create: async () => { throw new Error('No secret should be created for authMode none.'); }, resolve: async () => { throw new Error('No secret should be resolved for authMode none.'); }, markValidated: async () => { throw new Error('No secret should be validated for authMode none.'); }, delete: async () => {} };
}

async function setup(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-manager-source-reader-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const transport = new LifecycleTransport();
  const adapter = new ScyllaManagerAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z', now: () => 1000, delay: async () => {} });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const secrets = secretStore();
  const connections = new ScyllaManagerConnectionService({ controlDatabase, secretStore: secrets, deviceId: 'device-manager', adapter });
  const created = await connections.create('workspace-manager', 'actor-manager', { name: 'Production Manager', host: 'manager01.example.com', port: 5080, authMode: 'none', tlsMode: 'verify-identity', managedClusterId: CLUSTER_ID });
  const tested = await connections.test('workspace-manager', created.id, 'actor-manager');
  const taskUpdate = { name: 'verify-orders', type: 'backup', labels: { 'deployerx.owner': 'deployerx', 'deployerx.purpose': 'target-validation' }, enabled: false, schedule: {}, properties: { location: ['s3:company-backups/production'], keyspace: ['orders.items', 'orders.payments'], dc: ['dc1'], method: 'native', retention: 4, retention_days: 30, rate_limit: ['dc1:100M'], snapshot_parallel: ['dc1:2'], upload_parallel: ['dc1:4'], transfers: 4, skip_schema: false, purge_only: false } };
  const verified = await connections.verifyTarget('workspace-manager', created.id, { taskUpdate }, 'actor-manager');
  const sourceService = new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, deviceId: 'device-manager', clock: () => '2026-08-04T00:00:00.000Z' });
  const source = await sourceService.save('workspace-manager', 'actor-manager', {
    name: 'Orders Manager Backup', connectionId: created.id, adapterId: ADAPTER_ID,
    selector: { allDatabases: false, databases: { include: [{ name: 'orders' }] }, tables: { include: [{ database: 'orders', schema: 'orders', name: 'items' }, { database: 'orders', schema: 'orders', name: 'payments' }] } },
    consistency: { requestedLevel: 'crash', method: 'scylla-manager-backup', backupMethod: 'physical', backupMode: 'native', captureCoordinates: true },
    physicalExecution: { managedClusterId: CLUSTER_ID, locations: ['s3:company-backups/production'], dataCenters: ['dc1'], method: 'native', retention: 4, retentionDays: 30, retentionLockMode: 'none', rateLimit: ['dc1:100M'], snapshotParallel: ['dc1:2'], uploadParallel: ['dc1:4'], transfers: 4 }
  });
  const reader = new ScyllaManagerSourceReaderService({ controlDatabase, secretStore: secrets, deviceId: 'device-manager', adapterRegistry: registry, adapter, temporaryRoot: path.join(root, 'staging') });
  return { root, controlDatabase, transport, adapter, registry, connections, created, tested, verified, source, reader };
}

test('enrolls only the tested exact Manager target and admits metadata-only source planning', async (context) => {
  const fixture = await setup(context);
  assert.equal(fixture.source.platform.engine, 'scylla-manager');
  assert.equal(fixture.source.physicalExecution.managedClusterId, CLUSTER_ID);
  assert.equal(fixture.source.physicalExecution.targetFingerprint, fixture.verified.verification.target.targetFingerprint);
  assert.deepEqual(fixture.source.physicalExecution.locations.map((item) => item.location), ['s3:company-backups/production']);
  assert.equal(fixture.source.physicalExecution.deploymentFingerprint, fixture.tested.result.endpointIdentity.deploymentFingerprint);
  const planned = await fixture.reader.plan('workspace-manager', fixture.source.id);
  assert.equal(planned.manifest.adapterId, ADAPTER_ID);
  const connection = await fixture.controlDatabase.repository('connection').get('workspace-manager', fixture.created.id);
  await fixture.controlDatabase.repository('connection').update('workspace-manager', connection.id, { managerTargetTrust: null }, { expectedRevision: connection.revision, actorId: 'actor-manager' });
  await assert.rejects(fixture.reader.plan('workspace-manager', fixture.source.id), (error) => error.code === 'SCYLLA_MANAGER_TARGET_TRUST_CHANGED');
});

test('runs one owned Manager task and streams only the authenticated metadata artifact', async (context) => {
  const fixture = await setup(context);
  const executionId = 'run-manager-source-001';
  const files = await fixture.reader.files('workspace-manager', fixture.source.id, { executionId, backupMode: 'native' });
  const entries = [];
  for await (const entry of files.create()) {
    const chunks = [];
    for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
    entries.push({ path: entry.path, metadata: entry.metadata, bytes: Buffer.concat(chunks) });
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'scylla-manager/backup-metadata.json');
  assert.equal(entries[0].metadata.externalNativeMedia, true);
  const manifest = JSON.parse(entries[0].bytes.toString('utf8'));
  assert.equal(manifest.kind, 'scylla-manager-backup');
  assert.equal(manifest.adapterId, ADAPTER_ID);
  assert.equal(manifest.state, 'succeeded');
  assert.equal(manifest.snapshotTag, 'sm_20260804000000UTC');
  assert.equal(manifest.taskId, 'manager-task-001');
  assert.equal(manifest.runId, 'manager-run-001');
  assert.equal(manifest.externalNativeMedia, true);
  assert.equal(manifest.workspaceDigest, stableDigest('workspace-manager'));
  assert.equal(JSON.stringify(manifest).includes('must-not-escape'), false);
  assert.equal(fixture.transport.calls.some((call) => call.method === 'DELETE'), false);
  assert.equal(await fixture.reader.release('workspace-manager', executionId), true);
  assert.deepEqual(await fs.readdir(path.join(fixture.root, 'staging')), []);
});

test('reconciles a persisted exact task owner without deleting Manager backup media', async (context) => {
  const fixture = await setup(context);
  const executionId = 'run-manager-reconcile-001';
  await fixture.reader.files('workspace-manager', fixture.source.id, { executionId, backupMode: 'native' });
  const entries = await fs.readdir(path.join(fixture.root, 'staging'), { withFileTypes: true });
  const directory = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(preparationPrefix('workspace-manager', executionId)));
  assert.ok(directory);
  const reconciled = await fixture.reader.reconcileRun('workspace-manager', { id: executionId, sourceLease: { id: 'lease-manager' } });
  assert.equal(reconciled.proven, true);
  assert.equal(reconciled.reconciledTasks, 1);
  assert.equal(fixture.transport.calls.some((call) => call.method === 'DELETE'), false);
  assert.equal(await fs.stat(path.join(fixture.root, 'staging', directory.name)).catch(() => null), null);
});

test('admits a native backup job for an unchanged verified Manager Source', async (context) => {
  const fixture = await setup(context);
  const repository = await fixture.controlDatabase.repository('repository').create({
    workspaceId: 'workspace-manager', name: 'Manager metadata repository', adapterId: 'deployerx.repository.local-folder', adapterVersion: '1.0.0',
    engineId: 'deployerx.file-repository', engineVersion: '1.0.0', workerAffinity: ['device:device-manager'],
    health: { status: 'ready', lockState: { status: 'available' } }, location: { path: 'C:\\backup' }
  });
  const jobs = new BackupJobService({ controlDatabase: fixture.controlDatabase, deviceId: 'device-manager', clock: () => '2026-08-04T00:00:00.000Z' });
  const readiness = await jobs.readiness('workspace-manager');
  assert.equal(readiness.sources.find((item) => item.id === fixture.source.id).readiness.ready, true);
  const created = await jobs.create('workspace-manager', 'actor-manager', { name: 'Manager native protection', sourceId: fixture.source.id, repositoryIds: [repository.id], backupMode: 'native' });
  assert.equal(created.policy.backupMode, 'native');
  assert.equal(created.job.sourceId, fixture.source.id);
});
