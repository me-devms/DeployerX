const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalFolderRepositoryAdapter } = require('./local-repository');
const { FileRepositoryEngine } = require('./repository-engine');
const { RepositoryPruningService } = require('./repository-pruning');

const NOW = '2026-08-03T12:00:00.000Z';
const WORKSPACE_ID = 'local';
const REPOSITORY_ID = 'repo-prune-test';

function controlFixture(points) {
  const repository = { id: REPOSITORY_ID, workerAffinity: ['device:test-device'] };
  const data = { repository: [repository], recoveryPoint: points, run: [], restoreRun: [], verificationRun: [] };
  return {
    data,
    repository(type) {
      return {
        get: async (_workspaceId, id) => data[type].find((record) => record.id === id) || null,
        list: async () => structuredClone(data[type])
      };
    },
    async transaction(operation) {
      return operation({
        get: (type, _workspaceId, id) => structuredClone(data[type].find((record) => record.id === id) || null),
        projectRecoveryPointRepositoryCopies: (_workspaceId, id, copies) => {
          const index = data.recoveryPoint.findIndex((point) => point.id === id);
          data.recoveryPoint[index] = { ...data.recoveryPoint[index], repositoryCopies: structuredClone(copies), revision: data.recoveryPoint[index].revision + 1 };
          return structuredClone(data.recoveryPoint[index]);
        }
      });
    }
  };
}

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-prune-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const adapter = new LocalFolderRepositoryAdapter({ rootPath, clock: () => NOW });
  await adapter.initialize();
  const engine = new FileRepositoryEngine({ adapter, clock: () => NOW });
  const masterKey = Buffer.alloc(32, 7);
  await engine.ensureRepository({}, { repositoryId: REPOSITORY_ID });
  const payload = Buffer.from('shared repository chunk');
  const first = await engine.createSnapshot({}, { repositoryId: REPOSITORY_ID, masterKey, keyVersion: 'key-v1', idempotencyKey: 'first', files: [{ path: '/data.txt', type: 'file', content: payload }] });
  const second = await engine.createSnapshot({}, { repositoryId: REPOSITORY_ID, masterKey, keyVersion: 'key-v1', idempotencyKey: 'second', parentSnapshotId: first.snapshotId, files: [{ path: '/data.txt', type: 'file', content: payload }] });
  const point = (id, summary, eligible, parentRecoveryPointId = null) => ({
    id, revision: 1, parentRecoveryPointId, retention: { deletionEligible: eligible, legalHold: false },
    repositoryCopies: [{ repositoryId: REPOSITORY_ID, engineSnapshotId: summary.snapshotId, manifestLocator: summary.manifestKey, state: 'available', immutableUntil: null }]
  });
  const points = [point('rp-old', first, true), point('rp-new', second, false, 'rp-old')];
  const controlDatabase = controlFixture(points);
  const service = new RepositoryPruningService({ controlDatabase, openRepository: async () => ({ adapter, engine, masterKey }), deviceId: 'test-device', clock: () => NOW });
  return { adapter, engine, masterKey, first, second, controlDatabase, service };
}

test('dry-run protects a retained incremental ancestor and active recovery operations', async (context) => {
  const { controlDatabase, service } = await fixture(context);
  let plan = await service.plan(WORKSPACE_ID, REPOSITORY_ID);
  assert.equal(plan.summary.eligibleCopies, 0);
  assert.deepEqual(plan.blocked, [{ recoveryPointId: 'rp-old', reason: 'dependency' }]);
  assert.deepEqual(plan.protection.chainDependencies, [{ recoveryPointId: 'rp-old', protectedByRecoveryPointIds: ['rp-new'] }]);

  controlDatabase.data.recoveryPoint[1].parentRecoveryPointId = null;
  controlDatabase.data.restoreRun.push({ id: 'restore-1', state: 'running', recoveryPointIds: ['rp-old'], target: { engine: 'influxdb', operation: 'influxdb-oss-v2-alternate-restore' } });
  plan = await service.plan(WORKSPACE_ID, REPOSITORY_ID);
  assert.deepEqual(plan.blocked, [{ recoveryPointId: 'rp-old', reason: 'active-operation' }]);
  assert.deepEqual(plan.protection.activeOperations.recoveryPoints, [{ recoveryPointId: 'rp-old', operationIds: ['restore-1'] }]);

  controlDatabase.data.restoreRun.length = 0;
  controlDatabase.data.run.push({ id: 'run-1', state: 'verifying', configSnapshot: { repositories: [{ id: REPOSITORY_ID }] } });
  plan = await service.plan(WORKSPACE_ID, REPOSITORY_ID);
  assert.deepEqual(plan.blocked, [{ recoveryPointId: 'rp-old', reason: 'active-operation' }]);
  assert.deepEqual(plan.protection.activeOperations.repositoryWideOperationIds, ['run-1']);

  controlDatabase.data.run.length = 0;
  controlDatabase.data.verificationRun.push({ id: 'verify-1', state: 'running', mode: 'influxdb-metadata', scopeType: 'recovery-point', scopeId: 'rp-old', recoveryPointId: 'rp-old' });
  plan = await service.plan(WORKSPACE_ID, REPOSITORY_ID);
  assert.deepEqual(plan.blocked, [{ recoveryPointId: 'rp-old', reason: 'active-operation' }]);
  assert.deepEqual(plan.protection.activeOperations.recoveryPoints, [{ recoveryPointId: 'rp-old', operationIds: ['verify-1'] }]);

  controlDatabase.data.verificationRun[0] = { id: 'verify-1', state: 'running', scopeType: 'recovery-point', scopeId: 'rp-new', recoveryPointId: 'rp-new', recoveryPointIds: ['rp-old', 'rp-new'] };
  plan = await service.plan(WORKSPACE_ID, REPOSITORY_ID);
  assert.deepEqual(plan.protection.activeOperations.recoveryPoints, [
    { recoveryPointId: 'rp-new', operationIds: ['verify-1'] },
    { recoveryPointId: 'rp-old', operationIds: ['verify-1'] }
  ]);
});

test('prunes a manifest but preserves its chunk while a retained manifest still references it', async (context) => {
  const { adapter, engine, masterKey, first, second, controlDatabase, service } = await fixture(context);
  controlDatabase.data.recoveryPoint[1].parentRecoveryPointId = null;
  const opened = await engine.openSnapshot({}, { repositoryId: REPOSITORY_ID, snapshotId: first.snapshotId, masterKey });
  const sharedChunkKey = opened.manifest.files[0].chunks[0].key;
  const plan = await service.plan(WORKSPACE_ID, REPOSITORY_ID);
  assert.equal(plan.summary.manifestsToDelete, 1);
  assert.equal(plan.summary.chunksToDelete, 0);

  const result = await service.execute(WORKSPACE_ID, 'tester', REPOSITORY_ID, plan.planId);
  assert.equal(result.copies[0].state, 'pruned');
  assert.equal(await adapter.stat({}, first.manifestKey), null);
  assert.ok(await adapter.stat({}, second.manifestKey));
  assert.ok(await adapter.stat({}, sharedChunkKey));
  assert.equal(controlDatabase.data.recoveryPoint[0].repositoryCopies[0].state, 'pruned');
});

test('fails closed for legal hold, immutability, and a stale dry-run plan', async (context) => {
  const { controlDatabase, service } = await fixture(context);
  controlDatabase.data.recoveryPoint[1].parentRecoveryPointId = null;
  controlDatabase.data.recoveryPoint[0].retention.legalHold = true;
  let plan = await service.plan(WORKSPACE_ID, REPOSITORY_ID);
  assert.deepEqual(plan.blocked, [{ recoveryPointId: 'rp-old', reason: 'legal-hold' }]);

  controlDatabase.data.recoveryPoint[0].retention.legalHold = false;
  controlDatabase.data.recoveryPoint[0].repositoryCopies[0].immutableUntil = '2026-08-04T00:00:00.000Z';
  plan = await service.plan(WORKSPACE_ID, REPOSITORY_ID);
  assert.deepEqual(plan.blocked, [{ recoveryPointId: 'rp-old', reason: 'immutable' }]);

  controlDatabase.data.recoveryPoint[0].repositoryCopies[0].immutableUntil = 'not-a-timestamp';
  plan = await service.plan(WORKSPACE_ID, REPOSITORY_ID);
  assert.deepEqual(plan.blocked, [{ recoveryPointId: 'rp-old', reason: 'immutable' }]);
  await assert.rejects(service.execute(WORKSPACE_ID, 'tester', REPOSITORY_ID, 'prune_stale'), (error) => error.code === 'REPOSITORY_PRUNE_PLAN_STALE');
});
