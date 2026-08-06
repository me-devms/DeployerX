const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID, stableDigest } = require('./scylla-manager');
const { RESTORE_CONFIRMATION, ScyllaManagerRestoreService, loadRecoveryMetadata } = require('./scylla-manager-restore');

const WORKSPACE_ID = 'workspace-scylla-manager';
const SOURCE_CLUSTER_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_CLUSTER_ID = '22222222-2222-2222-2222-222222222222';

function metadata() {
  return {
    version: 1,
    kind: 'scylla-manager-backup',
    adapterId: ADAPTER_ID,
    state: 'succeeded',
    externalNativeMedia: true,
    authoritativeOwner: 'scylla-manager',
    sourceId: 'source-manager',
    workspaceDigest: stableDigest(WORKSPACE_ID),
    managerVersion: '3.11.0',
    managedClusterId: SOURCE_CLUSTER_ID,
    deploymentFingerprint: `sha256:${'a'.repeat(64)}`,
    clusterFingerprint: `sha256:${'b'.repeat(64)}`,
    topologyFingerprint: `sha256:${'c'.repeat(64)}`,
    scyllaVersions: ['2025.1.3'],
    agentVersions: ['3.11.0'],
    taskId: 'backup-task-001',
    runId: 'backup-run-001',
    snapshotTag: 'sm_20260804000000UTC',
    target: {
      clusterId: SOURCE_CLUSTER_ID,
      locations: [{ location: 's3:company-backups/production', scheme: 's3', locationFingerprint: `sha256:${'d'.repeat(64)}` }],
      units: [{ keyspace: 'orders', tables: ['items', 'payments'], allTables: false }]
    },
    catalog: { clusterId: SOURCE_CLUSTER_ID, taskId: 'backup-task-001', units: [{ keyspace: 'orders', tables: ['items', 'payments'], allTables: false }], snapshots: [{ snapshotTag: 'sm_20260804000000UTC', nodes: 3, size: 4096 }] },
    progress: { snapshotTag: 'sm_20260804000000UTC', size: 4096, uploaded: 4096, skipped: 0, failed: 0 }
  };
}

class MemoryDatabase {
  constructor(options = {}) {
    this.sequence = 0;
    this.records = new Map();
    const put = (type, record) => this.records.set(`${type}:${record.id}`, { revision: 1, ...structuredClone(record) });
    put('connection', {
      id: 'connection-target', workspaceId: WORKSPACE_ID, adapterId: ADAPTER_ID,
      endpoint: { host: 'manager-target.example.com', port: 5080, basePath: '/api/v1', authMode: 'none', tlsMode: 'verify-identity', managedClusterId: options.targetClusterId || TARGET_CLUSTER_ID, expectedManagerVersion: '3.11.0', expectedDeploymentFingerprint: `sha256:${'e'.repeat(64)}` },
      secretRefIds: [], workerAffinity: ['device:device-manager'], trust: { fingerprint: `sha256:${'e'.repeat(64)}` }, lastTest: { status: 'success' }, clusterInventory: { healthy: true }
    });
    put('source', { id: 'source-manager', workspaceId: WORKSPACE_ID, adapterId: ADAPTER_ID, connectionId: 'connection-source' });
    put('recoveryPoint', { id: 'point-manager', workspaceId: WORKSPACE_ID, sourceId: 'source-manager', runId: 'run-manager', type: 'native', consistency: 'crash', repositoryCopies: [{ repositoryId: 'repository-metadata', engineSnapshotId: 'engine-snapshot', state: 'available' }] });
  }

  repository(type) {
    return {
      get: async (workspaceId, id) => {
        const record = this.records.get(`${type}:${id}`);
        return record?.workspaceId === workspaceId ? structuredClone(record) : null;
      },
      list: async (workspaceId) => [...this.records.entries()].filter(([key, value]) => key.startsWith(`${type}:`) && value.workspaceId === workspaceId).map(([, value]) => structuredClone(value)),
      create: async (input) => {
        const id = input.id || `${type}-${++this.sequence}`;
        const record = { id, revision: 1, ...structuredClone(input) };
        this.records.set(`${type}:${id}`, record);
        return structuredClone(record);
      }
    };
  }

  async transaction(callback) {
    return callback({
      get: (type, workspaceId, id) => {
        const record = this.records.get(`${type}:${id}`);
        return record?.workspaceId === workspaceId ? structuredClone(record) : null;
      },
      projectExecution: (type, workspaceId, id, changes) => {
        const current = this.records.get(`${type}:${id}`);
        assert.equal(current.workspaceId, workspaceId);
        const next = { ...current, ...structuredClone(changes), revision: current.revision + 1 };
        this.records.set(`${type}:${id}`, next);
        return structuredClone(next);
      }
    });
  }
}

function snapshotBrowser(database, overrideMetadata = metadata()) {
  const bytes = Buffer.from(JSON.stringify(overrideMetadata));
  return {
    openAuthenticatedSnapshot: async (_workspaceId, pointId) => ({
      point: await database.repository('recoveryPoint').get(WORKSPACE_ID, pointId),
      copy: { repositoryId: 'repository-metadata' },
      manifest: { files: [{ type: 'file', path: 'scylla-manager/backup-metadata.json', sizeBytes: bytes.length, metadata: { externalNativeMedia: true, database: { adapterId: ADAPTER_ID } } }] },
      engine: { streamFile: async function* () { yield bytes; } }, masterKey: Buffer.alloc(32)
    })
  };
}

class FakeAdapter {
  constructor(options = {}) {
    this.options = options;
    this.events = [];
    this.tasks = new Map();
    this.sequence = 0;
    this.stopped = [];
  }

  normalizeConfig(input) { return structuredClone(input); }

  async readEnvironment(_context, config) {
    this.events.push(`environment:${config.managedClusterId}`);
    return {
      version: { text: '3.11.0', major: 3 },
      cluster: { id: config.managedClusterId },
      deploymentFingerprint: config.expectedDeploymentFingerprint,
      status: { healthy: true, topologyFingerprint: `sha256:${'f'.repeat(64)}`, nodes: [{ scyllaVersion: '2025.1.8' }] }
    };
  }

  async restoreTarget(_context, input) {
    const phase = input.taskUpdate.properties.restore_schema ? 'schema' : 'tables';
    this.events.push(`dry-run:${phase}`);
    return { clusterId: input.connection.managedClusterId, snapshotTag: input.taskUpdate.properties.snapshot_tag, locations: [{ location: 's3:company-backups/production' }], units: [{ keyspace: 'orders', tables: ['items', 'payments'], size: 4096 }], size: phase === 'schema' ? 0 : 4096, targetFingerprint: stableDigest({ phase }) };
  }

  async createOwnedTask(_context, input) {
    const id = `restore-task-${++this.sequence}`;
    const phase = input.taskUpdate.labels['deployerx.phase'];
    const task = { clusterId: input.connection.managedClusterId, type: 'restore', id, name: input.taskUpdate.name, labels: structuredClone(input.taskUpdate.labels), enabled: false, schedule: {} };
    this.tasks.set(id, task);
    this.events.push(`create:${phase}`);
    return structuredClone(task);
  }

  async getTask(_context, input) { return structuredClone(this.tasks.get(input.taskId)); }

  async startTask(_context, input) {
    this.events.push(`start:${this.tasks.get(input.taskId).labels['deployerx.phase']}`);
    return { started: true, taskId: input.taskId };
  }

  async taskHistory(context, input) {
    const task = this.tasks.get(input.taskId);
    if (this.options.block && task.labels['deployerx.phase'] === 'schema') {
      if (context.signal?.aborted) throw Object.assign(new Error('Canceled'), { code: 'SCYLLA_MANAGER_RESTORE_CANCELED', category: 'canceled' });
      await new Promise((resolve, reject) => context.signal.addEventListener('abort', () => reject(Object.assign(new Error('Canceled'), { code: 'SCYLLA_MANAGER_RESTORE_CANCELED', category: 'canceled' })), { once: true }));
    }
    return [{ clusterId: input.connection.managedClusterId, type: 'restore', taskId: input.taskId, id: `run-${input.taskId}`, status: 'done', cause: 'user', startTime: '2026-08-04T00:00:00Z', endTime: '2026-08-04T00:01:00Z' }];
  }

  async taskProgress(_context, input) {
    const phase = this.tasks.get(input.taskId).labels['deployerx.phase'];
    const size = phase === 'schema' ? 0 : 4096;
    this.events.push(`progress:${phase}`);
    return { run: { clusterId: input.connection.managedClusterId, type: 'restore', taskId: input.taskId, id: input.runId, status: 'done' }, progress: { snapshotTag: 'sm_20260804000000UTC', stage: 'DONE', size, restored: size, failed: 0 } };
  }

  async stopTask(_context, input) {
    this.stopped.push(input.taskId);
    this.events.push(`stop:${this.tasks.get(input.taskId).labels['deployerx.phase']}`);
    return { stopped: true, taskId: input.taskId };
  }
}

function fixture(options = {}) {
  const database = new MemoryDatabase(options);
  const adapter = new FakeAdapter(options);
  const restore = new ScyllaManagerRestoreService({ controlDatabase: database, secretStore: { resolve: async () => 'secret' }, snapshotBrowser: snapshotBrowser(database, options.metadata || metadata()), adapter, deviceId: 'device-manager', clock: () => '2026-08-04T02:00:00.000Z', now: () => 1000, delay: async () => {}, maximumWaitMs: 5000 });
  return { database, adapter, restore };
}

test('loads only authenticated, bounded Manager metadata with catalog and workspace identity', async () => {
  const current = fixture();
  const loaded = await loadRecoveryMetadata(current.database, snapshotBrowser(current.database), WORKSPACE_ID, 'point-manager');
  assert.equal(loaded.metadata.snapshotTag, 'sm_20260804000000UTC');
  const altered = metadata();
  altered.workspaceDigest = stableDigest('different-workspace');
  await assert.rejects(loadRecoveryMetadata(current.database, snapshotBrowser(current.database, altered), WORKSPACE_ID, 'point-manager'), (error) => error.code === 'SCYLLA_MANAGER_RECOVERY_METADATA_INVALID');
});

test('previews a restore only on a different healthy compatible managed cluster', async () => {
  const current = fixture();
  const preview = await current.restore.preview(WORKSPACE_ID, { recoveryPointId: 'point-manager', targetConnectionId: 'connection-target', selectedTables: ['orders.items'] });
  assert.equal(preview.sourceManagedClusterId, SOURCE_CLUSTER_ID);
  assert.equal(preview.targetManagedClusterId, TARGET_CLUSTER_ID);
  assert.deepEqual(preview.selection, ['orders.items']);
  assert.deepEqual(preview.phases.map((phase) => phase.id), ['schema', 'tables']);
  assert.equal(preview.phases[1].dryRunAfterSchema, true);
  const same = fixture({ targetClusterId: SOURCE_CLUSTER_ID });
  await assert.rejects(same.restore.preview(WORKSPACE_ID, { recoveryPointId: 'point-manager', targetConnectionId: 'connection-target' }), (error) => error.code === 'SCYLLA_MANAGER_RESTORE_TARGET_NOT_ALTERNATE');
});

test('requires explicit confirmation and runs schema before table re-dry-run and restore', async () => {
  const current = fixture();
  await assert.rejects(current.restore.start(WORKSPACE_ID, 'actor-manager', { recoveryPointId: 'point-manager', targetConnectionId: 'connection-target' }), (error) => error.code === 'SCYLLA_MANAGER_RESTORE_CONFIRMATION_REQUIRED');
  const started = await current.restore.start(WORKSPACE_ID, 'actor-manager', { recoveryPointId: 'point-manager', targetConnectionId: 'connection-target', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await current.restore.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(completed.result.originalClusterModified, false);
  assert.equal(completed.result.sourceMediaDeleted, false);
  assert.equal(completed.result.rollbackPerformed, false);
  const ordered = current.adapter.events.filter((event) => /^(create|start|progress|dry-run):/.test(event));
  const createSchema = ordered.indexOf('create:schema');
  const progressSchema = ordered.indexOf('progress:schema');
  const dryRunTables = ordered.indexOf('dry-run:tables');
  const createTables = ordered.indexOf('create:tables');
  assert.ok(createSchema >= 0 && createSchema < progressSchema && progressSchema < dryRunTables && dryRunTables < createTables);
  assert.deepEqual(completed.target.ownedTasks.map((owner) => owner.phase), ['schema', 'tables']);
  assert.ok(completed.target.ownedTasks.every((owner) => owner.taskId && owner.runId));
});

test('cancellation stops only the exact owned Manager restore task and does not claim rollback', async () => {
  const current = fixture({ block: true });
  const started = await current.restore.start(WORKSPACE_ID, 'actor-manager', { recoveryPointId: 'point-manager', targetConnectionId: 'connection-target', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  while (!current.adapter.events.includes('start:schema')) await new Promise((resolve) => setImmediate(resolve));
  const canceled = await current.restore.cancel(WORKSPACE_ID, 'actor-manager', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.rollbackPerformed, false);
  assert.equal(canceled.result.originalClusterModified, false);
  assert.deepEqual(current.adapter.stopped, ['restore-task-1']);
  assert.equal(current.adapter.events.some((event) => event.startsWith('stop:tables')), false);
});
