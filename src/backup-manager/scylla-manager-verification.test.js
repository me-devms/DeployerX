const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID, stableDigest } = require('./scylla-manager');
const { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, ScyllaManagerRecoveryTestService } = require('./scylla-manager-verification');

const WORKSPACE_ID = 'workspace-manager-verification';
const SOURCE_CLUSTER_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_CLUSTER_ID = '22222222-2222-2222-2222-222222222222';

function metadata() {
  return {
    version: 1, kind: 'scylla-manager-backup', adapterId: ADAPTER_ID, state: 'succeeded', externalNativeMedia: true, authoritativeOwner: 'scylla-manager',
    sourceId: 'source-manager', workspaceDigest: stableDigest(WORKSPACE_ID), managerVersion: '3.11.0', managedClusterId: SOURCE_CLUSTER_ID,
    deploymentFingerprint: `sha256:${'a'.repeat(64)}`, clusterFingerprint: `sha256:${'b'.repeat(64)}`, topologyFingerprint: `sha256:${'c'.repeat(64)}`,
    scyllaVersions: ['2025.1.3'], agentVersions: ['3.11.0'], taskId: 'backup-task-001', runId: 'backup-run-001', snapshotTag: 'sm_20260804000000UTC',
    target: { clusterId: SOURCE_CLUSTER_ID, locations: [{ location: 's3:company-backups/production', scheme: 's3', locationFingerprint: `sha256:${'d'.repeat(64)}` }], units: [{ keyspace: 'orders', tables: ['items', 'payments'], allTables: false }] },
    catalog: { clusterId: SOURCE_CLUSTER_ID, taskId: 'backup-task-001', units: [{ keyspace: 'orders', tables: ['items', 'payments'], allTables: false }], snapshots: [{ snapshotTag: 'sm_20260804000000UTC', nodes: 3, size: 4096 }] },
    progress: { snapshotTag: 'sm_20260804000000UTC', stage: 'DONE', size: 4096, failed: 0, startedAt: '2026-08-04T00:00:00Z', completedAt: '2026-08-04T00:01:00Z', uploaded: 4096, skipped: 0, dataCenters: ['dc1'], hostCount: 3, retentionDays: 30, retentionLockMode: 'none' }
  };
}

class MemoryDatabase {
  constructor() {
    this.sequence = 0;
    this.records = new Map();
    this.put('connection', { id: 'connection-source', workspaceId: WORKSPACE_ID, adapterId: ADAPTER_ID, endpoint: { host: 'manager.example.com', port: 5080, basePath: '/api/v1', authMode: 'none', tlsMode: 'verify-identity', managedClusterId: SOURCE_CLUSTER_ID }, secretRefIds: [], workerAffinity: ['device:device-manager'], trust: { fingerprint: `sha256:${'a'.repeat(64)}` }, lastTest: { status: 'success' }, clusterInventory: { healthy: true } });
    this.put('source', { id: 'source-manager', workspaceId: WORKSPACE_ID, sourceType: 'database', adapterId: ADAPTER_ID, connectionId: 'connection-source' });
    this.put('recoveryPoint', { id: 'point-manager', workspaceId: WORKSPACE_ID, sourceId: 'source-manager', runId: 'run-manager', type: 'native', consistency: 'crash', repositoryCopies: [{ repositoryId: 'repository-metadata', engineSnapshotId: 'snapshot-metadata', state: 'available' }] });
  }

  put(type, record) { this.records.set(`${type}:${record.id}`, { revision: 1, ...structuredClone(record) }); }

  repository(type) {
    return {
      get: async (workspaceId, id) => { const value = this.records.get(`${type}:${id}`); return value?.workspaceId === workspaceId ? structuredClone(value) : null; },
      list: async (workspaceId) => [...this.records.entries()].filter(([key, value]) => key.startsWith(`${type}:`) && value.workspaceId === workspaceId).map(([, value]) => structuredClone(value)),
      create: async (input) => { const record = { id: input.id || `${type}-${++this.sequence}`, revision: 1, ...structuredClone(input) }; this.records.set(`${type}:${record.id}`, record); return structuredClone(record); }
    };
  }

  async transaction(callback) {
    return callback({
      get: (type, workspaceId, id) => { const value = this.records.get(`${type}:${id}`); return value?.workspaceId === workspaceId ? structuredClone(value) : null; },
      projectExecution: (type, workspaceId, id, changes) => { const current = this.records.get(`${type}:${id}`); assert.equal(current.workspaceId, workspaceId); const next = { ...current, ...structuredClone(changes), revision: current.revision + 1 }; this.records.set(`${type}:${id}`, next); return structuredClone(next); }
    });
  }
}

function snapshotBrowser(database, value = metadata()) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { openAuthenticatedSnapshot: async () => ({ copy: { repositoryId: 'repository-metadata' }, manifest: { files: [{ type: 'file', path: 'scylla-manager/backup-metadata.json', sizeBytes: bytes.length, metadata: { externalNativeMedia: true, database: { adapterId: ADAPTER_ID } } }] }, engine: { streamFile: async function* () { yield bytes; } }, masterKey: Buffer.alloc(32) }) };
}

class FakeAdapter {
  constructor(options = {}) { this.options = options; }
  normalizeConfig(value) { return structuredClone(value); }
  async readEnvironment() { return { version: { text: '3.11.0' }, cluster: { id: SOURCE_CLUSTER_ID, clusterFingerprint: `sha256:${'b'.repeat(64)}` }, deploymentFingerprint: `sha256:${'a'.repeat(64)}`, status: { healthy: true, topologyFingerprint: `sha256:${'c'.repeat(64)}`, nodes: [] } }; }
  async getTask() { return { id: 'backup-task-001', labels: { 'deployerx.owner': 'deployerx', 'deployerx.operation': 'backup', 'deployerx.execution': 'owner-001', 'deployerx.source': 'source-manager' } }; }
  async taskHistory() { return [{ id: 'backup-run-001', status: 'done' }]; }
  async taskProgress() { return { run: { id: 'backup-run-001', status: 'done' }, progress: metadata().progress }; }
  async listBackups() { const item = metadata().catalog; return [{ ...item, ...(this.options.changedCatalog ? { snapshots: [{ ...item.snapshots[0], size: 8192 }] } : {}) }]; }
}

class FakeRestoreService {
  constructor(options = {}) { this.options = options; this.started = []; this.canceled = []; this.release = null; }
  async start(workspaceId, actorId, input) { this.started.push({ workspaceId, actorId, input: structuredClone(input) }); return { id: 'restore-manager', state: 'queued' }; }
  async wait() {
    if (this.options.block) await new Promise((resolve) => { this.release = resolve; });
    return { id: 'restore-manager', state: this.options.canceled ? 'canceled' : 'succeeded', target: { ownedTasks: [{ phase: 'schema', taskId: 'task-schema', runId: 'run-schema' }, { phase: 'tables', taskId: 'task-tables', runId: 'run-tables' }] }, validation: { nativeIntegrityValidation: true, schemaPhase: 'pass', tablePhase: 'pass', clusterHealth: 'pass' }, result: { targetManagedClusterId: TARGET_CLUSTER_ID, snapshotTag: 'sm_20260804000000UTC', originalClusterModified: false, sourceMediaDeleted: false, rollbackPerformed: false } };
  }
  async cancel(_workspaceId, _actorId, id) { this.canceled.push(id); this.options.canceled = true; this.release?.(); return { id, state: 'canceled' }; }
}

function fixture(options = {}) {
  const database = new MemoryDatabase();
  const adapter = new FakeAdapter(options);
  const restoreService = new FakeRestoreService(options);
  const service = new ScyllaManagerRecoveryTestService({ controlDatabase: database, secretStore: { resolve: async () => 'secret' }, snapshotBrowser: snapshotBrowser(database), adapter, restoreService, deviceId: 'device-manager', clock: () => '2026-08-04T03:00:00.000Z' });
  return { database, adapter, restoreService, service };
}

test('authenticates exact Manager task, run, snapshot, catalog, location, and retention evidence', async () => {
  const current = fixture();
  const started = await current.service.start(WORKSPACE_ID, 'actor-manager', { recoveryPointId: 'point-manager', mode: METADATA_MODE });
  const completed = await current.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.evidence.repositoryVerified, true);
  assert.equal(completed.evidence.exactTaskOwnership, true);
  assert.equal(completed.evidence.snapshotTag, 'sm_20260804000000UTC');
  assert.equal(completed.evidence.retentionDays, 30);
  assert.equal(completed.evidence.fullRestorePerformed, false);
});

test('fails closed when the live Manager catalog differs from authenticated metadata', async () => {
  const current = fixture({ changedCatalog: true });
  const started = await current.service.start(WORKSPACE_ID, 'actor-manager', { recoveryPointId: 'point-manager', mode: METADATA_MODE });
  const completed = await current.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'SCYLLA_MANAGER_VERIFICATION_CATALOG_CHANGED');
});

test('runs a full alternate-cluster drill and preserves restored data for inspection', async () => {
  const current = fixture();
  await assert.rejects(current.service.start(WORKSPACE_ID, 'actor-manager', { recoveryPointId: 'point-manager', mode: DRILL_MODE, targetConnectionId: 'connection-target' }), (error) => error.code === 'SCYLLA_MANAGER_DRILL_CONFIRMATION_REQUIRED');
  const started = await current.service.start(WORKSPACE_ID, 'actor-manager', { recoveryPointId: 'point-manager', mode: DRILL_MODE, targetConnectionId: 'connection-target', confirmed: true, confirmationText: DRILL_CONFIRMATION });
  const completed = await current.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.evidence.targetPreserved, true);
  assert.equal(completed.evidence.cleanupPerformed, false);
  assert.equal(completed.evidence.rollbackPerformed, false);
  assert.deepEqual(completed.evidence.ownedTasks.map((item) => item.phase), ['schema', 'tables']);
  assert.equal(current.restoreService.started[0].input.confirmationText, 'RESTORE SCYLLA MANAGER ALTERNATE');
});

test('cancellation delegates only to the exact owned RestoreRun and records no cleanup claim', async () => {
  const current = fixture({ block: true });
  const started = await current.service.start(WORKSPACE_ID, 'actor-manager', { recoveryPointId: 'point-manager', mode: DRILL_MODE, targetConnectionId: 'connection-target', confirmed: true, confirmationText: DRILL_CONFIRMATION });
  while (!current.restoreService.started.length) await new Promise((resolve) => setImmediate(resolve));
  const canceled = await current.service.cancel(WORKSPACE_ID, 'actor-manager', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.deepEqual(current.restoreService.canceled, ['restore-manager']);
  assert.equal(canceled.result.targetPreserved, true);
  assert.equal(canceled.result.cleanupPerformed, false);
});

test('reconciliation interrupts orphaned drills and requires alternate-cluster inspection', async () => {
  const current = fixture();
  await current.database.repository('verificationRun').create({ id: 'verification-orphan', workspaceId: WORKSPACE_ID, scopeType: 'recovery-point', scopeId: 'point-manager', recoveryPointId: 'point-manager', mode: DRILL_MODE, state: 'running', progress: { phase: 'restoring' } });
  const reconciled = await current.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled[0].state, 'interrupted');
  assert.equal(reconciled[0].result.targetPreserved, true);
  assert.equal(reconciled[0].result.cleanupPerformed, false);
  assert.match(reconciled[0].result.error.safeMessage, /inspect the alternate cluster/);
});
