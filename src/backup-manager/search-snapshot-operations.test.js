const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');
const { ADAPTER_ID } = require('./search-snapshot');
const {
  DRILL_MODE, METADATA_MODE, RESTORE_CONFIRMATION, DRILL_CONFIRMATION,
  SearchSnapshotMaintenanceService, SearchSnapshotRecoveryTestService, SearchSnapshotRestoreService
} = require('./search-snapshot-operations');

const WORKSPACE_ID = 'workspace-search-operations';
const SECRET = 'search-operation-secret';

function workspaceDigest() {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(WORKSPACE_ID)).digest('hex')}`;
}

function metadata() {
  return {
    kind: 'search-native-snapshot', adapterId: ADAPTER_ID, product: 'elasticsearch', serverVersion: '9.1.2', clusterUuid: 'cluster-source', sourceId: 'source-search', workspaceDigest: workspaceDigest(),
    repository: { repositoryName: 'archive', repositoryFingerprint: `sha256:${'a'.repeat(64)}`, locationIdentity: `sha256:${'b'.repeat(64)}`, type: 's3', readOnly: false },
    snapshot: { name: 'deployerx-snapshot', uuid: 'snapshot-uuid', state: 'SUCCESS', version: '9.1.2', shards: { total: 2, successful: 2, failed: 0 } },
    selectedResources: [{ kind: 'search-index', name: 'orders', uuid: 'orders-source-uuid', primaryShards: 2, aliases: ['orders-current'] }],
    featureStates: [], includeGlobalState: false, planDigest: `sha256:${'c'.repeat(64)}`
  };
}

class MemoryDatabase {
  constructor() {
    this.sequence = 0;
    this.records = new Map();
    const put = (type, record) => this.records.set(`${type}:${record.id}`, { revision: 1, ...structuredClone(record) });
    put('connection', { id: 'connection-source', workspaceId: WORKSPACE_ID, adapterId: ADAPTER_ID, endpoint: { host: 'source.example.com', expectedClusterUuid: 'cluster-source', expectedProduct: 'elasticsearch' }, secretRefIds: ['secret-source'], workerAffinity: ['device:device-search'], trust: { fingerprint: 'source-trust' }, lastTest: { status: 'success' } });
    put('connection', { id: 'connection-target', workspaceId: WORKSPACE_ID, adapterId: ADAPTER_ID, endpoint: { host: 'target.example.com', expectedClusterUuid: 'cluster-target', expectedProduct: 'elasticsearch' }, secretRefIds: ['secret-target'], workerAffinity: ['device:device-search'], trust: { fingerprint: 'target-trust' }, lastTest: { status: 'success' } });
    put('source', { id: 'source-search', workspaceId: WORKSPACE_ID, adapterId: ADAPTER_ID, connectionId: 'connection-source' });
    put('recoveryPoint', { id: 'point-search', workspaceId: WORKSPACE_ID, sourceId: 'source-search', runId: 'run-search', type: 'full', consistency: 'crash', retention: { deletionEligible: true }, repositoryCopies: [{ repositoryId: 'repository-metadata', engineSnapshotId: 'engine-snapshot', state: 'available' }] });
  }

  repository(type) {
    return {
      get: async (_workspaceId, id) => structuredClone(this.records.get(`${type}:${id}`) || null),
      list: async () => [...this.records.entries()].filter(([key]) => key.startsWith(`${type}:`)).map(([, value]) => structuredClone(value)),
      create: async (input) => {
        const id = input.id || `${type}-${++this.sequence}`;
        const record = { id, revision: 1, ...structuredClone(input) };
        this.records.set(`${type}:${id}`, record);
        return structuredClone(record);
      }
    };
  }

  async transaction(callback) {
    const project = (type, workspaceId, id, changes) => {
      const current = this.records.get(`${type}:${id}`);
      assert.equal(current.workspaceId, workspaceId);
      const next = { ...current, ...structuredClone(changes), revision: current.revision + 1 };
      this.records.set(`${type}:${id}`, next);
      return structuredClone(next);
    };
    return callback({
      get: (type, workspaceId, id) => {
        const value = this.records.get(`${type}:${id}`);
        return value?.workspaceId === workspaceId ? structuredClone(value) : null;
      },
      projectExecution: (type, workspaceId, id, changes) => project(type, workspaceId, id, changes),
      projectRecoveryPointRetention: (workspaceId, id, retention) => project('recoveryPoint', workspaceId, id, { retention })
    });
  }
}

function snapshotBrowser(database) {
  const bytes = Buffer.from(JSON.stringify(metadata()));
  return {
    openAuthenticatedSnapshot: async (_workspaceId, pointId) => ({
      point: await database.repository('recoveryPoint').get(WORKSPACE_ID, pointId),
      copy: { repositoryId: 'repository-metadata' },
      manifest: { files: [{ type: 'file', path: 'search/snapshot-metadata.json', sizeBytes: bytes.length, metadata: { externalNativeMedia: true, database: { adapterId: ADAPTER_ID } } }] },
      engine: { streamFile: async function* () { yield bytes; } }, masterKey: Buffer.alloc(32)
    })
  };
}

class FakeAdapter {
  constructor() { this.deletedSnapshot = false; this.cleaned = false; this.drillDeleted = false; this.secrets = []; this.blockRestore = false; this.blockInspection = false; }
  normalizeConfig(input) { return structuredClone(input); }
  async #resolve(context, config) { this.secrets.push(await context.resolveSecret(config.credentialSecretRefId)); }
  async planRestore(context, request) {
    await this.#resolve(context, request.connection);
    const prefix = request.renamePrefix;
    return {
      version: 1, operation: 'search-native-alternate-restore', connection: request.connection, metadata: request.metadata,
      product: 'elasticsearch', sourceClusterUuid: 'cluster-source', targetClusterUuid: 'cluster-target', repositoryName: 'archive', repositoryLocationIdentity: request.metadata.repository.locationIdentity,
      snapshotName: request.metadata.snapshot.name, snapshotUuid: request.metadata.snapshot.uuid, compatibility: { snapshotVersion: '9.1.2', targetVersion: '9.1.2', sameMajor: true },
      renamePrefix: prefix, selection: ['orders'], preview: [{ kind: 'search-index', sourceName: 'orders', targetName: `${prefix}orders`, primaryShards: 2, aliases: [`${prefix}orders-current`] }], featureStates: [], includeGlobalState: false,
      planDigest: `sha256:${crypto.createHash('sha256').update(prefix).digest('hex')}`
    };
  }
  async executeRestore(context, plan) {
    await this.#resolve(context, plan.connection);
    if (this.blockRestore) await this.#waitForAbort(context.signal);
    return { state: 'succeeded', planDigest: plan.planDigest, targetClusterUuid: plan.targetClusterUuid, health: { unassignedShards: 0 } };
  }
  async validateRestore(_context, { plan }) { return { state: 'succeeded', nativeIntegrityValidation: true, expectedObjects: 'pass', targetClusterUuid: plan.targetClusterUuid, restoredResources: plan.preview.map((item) => ({ ...item, targetUuid: 'restored-uuid' })) }; }
  async inspectRecoverySnapshot(context, input) {
    await this.#resolve(context, input.connection);
    if (this.blockInspection) await this.#waitForAbort(context.signal);
    return { identity: { clusterUuid: input.connection.expectedClusterUuid }, repository: { name: 'archive', readOnly: false, repositoryFingerprint: metadata().repository.repositoryFingerprint }, snapshot: { snapshot: 'deployerx-snapshot', uuid: 'snapshot-uuid', state: 'SUCCESS', shards: { total: 2, successful: 2, failed: 0 } } };
  }
  async deleteRecoverySnapshot(context, input) { await this.#resolve(context, input.connection); this.deletedSnapshot = true; return { deleted: true, absent: true, snapshotName: input.metadata.snapshot.name, deletedAt: '2026-08-04T02:00:00.000Z' }; }
  async cleanupRepository(context, input) { await this.#resolve(context, input.connection); this.cleaned = true; return { repositoryName: input.repositoryName, deletedBytes: 10, deletedBlobs: 1, completedAt: '2026-08-04T02:00:00.000Z' }; }
  async deleteDrillResources(context, input) { await this.#resolve(context, input.connection); this.drillDeleted = true; return { deleted: true, resources: input.resources.map((item) => item.targetName) }; }
  async #waitForAbort(signal) {
    if (signal?.aborted) throw Object.assign(new Error('Canceled'), { code: 'SEARCH_OPERATION_CANCELED', category: 'canceled' });
    await new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('Canceled'), { code: 'SEARCH_OPERATION_CANCELED', category: 'canceled' })), { once: true }));
  }
}

function services() {
  const database = new MemoryDatabase();
  const browser = snapshotBrowser(database);
  const adapter = new FakeAdapter();
  const secrets = { resolve: async () => SECRET };
  const restore = new SearchSnapshotRestoreService({ controlDatabase: database, secretStore: secrets, snapshotBrowser: browser, adapter, deviceId: 'device-search', clock: () => '2026-08-04T02:00:00.000Z' });
  const maintenance = new SearchSnapshotMaintenanceService({ controlDatabase: database, secretStore: secrets, snapshotBrowser: browser, adapter, deviceId: 'device-search', clock: () => '2026-08-04T02:00:00.000Z' });
  const verification = new SearchSnapshotRecoveryTestService({ controlDatabase: database, secretStore: secrets, snapshotBrowser: browser, adapter, restoreService: restore, deviceId: 'device-search', clock: () => '2026-08-04T02:00:00.000Z' });
  return { database, adapter, restore, maintenance, verification };
}

test('persists and completes an alternate search RestoreRun without persisting credentials', async () => {
  const fixture = services();
  const preview = await fixture.restore.preview(WORKSPACE_ID, { recoveryPointId: 'point-search', targetConnectionId: 'connection-target', renamePrefix: 'dxr-orders-' });
  assert.deepEqual(preview.preview.map((item) => item.targetName), ['dxr-orders-orders']);
  const started = await fixture.restore.start(WORKSPACE_ID, 'actor-search', { recoveryPointId: 'point-search', targetConnectionId: 'connection-target', renamePrefix: 'dxr-orders-', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await fixture.restore.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(completed.result.cancellationRollbackSupported, false);
  assert.equal(JSON.stringify(completed).includes(SECRET), false);
  assert.ok(fixture.adapter.secrets.every((value) => value === SECRET));
});

test('native retention requires a stable dry-run plan and records confirmed external-media deletion', async () => {
  const fixture = services();
  const plan = await fixture.maintenance.planRetention(WORKSPACE_ID, 'point-search');
  await assert.rejects(fixture.maintenance.executeRetention(WORKSPACE_ID, 'actor-search', 'point-search', 'stale-plan'), (error) => error.code === 'SEARCH_RETENTION_PLAN_STALE');
  const completed = await fixture.maintenance.executeRetention(WORKSPACE_ID, 'actor-search', 'point-search', plan.planId);
  assert.equal(fixture.adapter.deletedSnapshot, true);
  assert.equal(completed.recoveryPoint.retention.nativeMedia.state, 'deleted');
  assert.equal(completed.recoveryPoint.retention.nativeMedia.snapshotName, 'deployerx-snapshot');
  await assert.rejects(fixture.maintenance.planRetention(WORKSPACE_ID, 'point-search'), (error) => error.code === 'SEARCH_RETENTION_POINT_PROTECTED');
});

test('cancel aborts an active alternate restore without waiting for normal completion', async () => {
  const fixture = services();
  fixture.adapter.blockRestore = true;
  const started = await fixture.restore.start(WORKSPACE_ID, 'actor-search', { recoveryPointId: 'point-search', targetConnectionId: 'connection-target', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const canceled = await fixture.restore.cancel(WORKSPACE_ID, 'actor-search', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.cleanupRequired, true);
});

test('cancel aborts active metadata verification cluster inspection', async () => {
  const fixture = services();
  fixture.adapter.blockInspection = true;
  const started = await fixture.verification.start(WORKSPACE_ID, 'actor-search', { recoveryPointId: 'point-search', mode: METADATA_MODE });
  const canceled = await fixture.verification.cancel(WORKSPACE_ID, 'actor-search', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.state, 'canceled');
});

test('labels metadata verification separately from a full restore drill and cleans only drill-owned resources', async () => {
  const fixture = services();
  const metadataRun = await fixture.verification.start(WORKSPACE_ID, 'actor-search', { recoveryPointId: 'point-search', mode: METADATA_MODE });
  const metadataResult = await fixture.verification.wait(WORKSPACE_ID, metadataRun.id);
  assert.equal(metadataResult.state, 'succeeded');
  assert.equal(metadataResult.evidence.verificationClass, 'metadata-only');
  assert.equal(metadataResult.evidence.fullRestorePerformed, false);
  const drillRun = await fixture.verification.start(WORKSPACE_ID, 'actor-search', { recoveryPointId: 'point-search', targetConnectionId: 'connection-target', mode: DRILL_MODE, confirmed: true, confirmationText: DRILL_CONFIRMATION });
  const drillResult = await fixture.verification.wait(WORKSPACE_ID, drillRun.id);
  assert.equal(drillResult.state, 'succeeded');
  assert.equal(drillResult.evidence.verificationClass, 'full-restore-drill');
  assert.equal(drillResult.evidence.targetDestroyed, true);
  assert.equal(fixture.adapter.drillDeleted, true);
});
