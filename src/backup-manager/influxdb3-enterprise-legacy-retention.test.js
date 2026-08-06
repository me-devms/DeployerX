const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ADAPTER_ID } = require('./influxdb3-enterprise');
const { CONSISTENCY_CONFIRMATIONS, CONSISTENCY_METHODS, inspectLegacyClusterLayout } = require('./influxdb3-enterprise-legacy');
const {
  InfluxDb3EnterpriseLegacyRetentionService
} = require('./influxdb3-enterprise-legacy-retention');
const {
  METADATA_PATH,
  SOURCE_TIER,
  InfluxDb3EnterpriseLegacySourceReaderService
} = require('./influxdb3-enterprise-legacy-source-reader');
const { DRILL_MODE, METADATA_MODE } = require('./influxdb3-enterprise-legacy-verification');
const { LocalFolderRepositoryAdapter } = require('./local-repository');
const { FileRepositoryEngine } = require('./repository-engine');

const NOW = '2026-08-05T17:00:00.000Z';
const WORKSPACE_ID = 'local';
const DEVICE_ID = 'legacy-retention-device';
const REPOSITORY_ID = 'legacy-retention-repository';
const POINT_ID = 'rp-legacy-delete';
const CLUSTER_ID = 'cluster-001';
const COMPACTOR_ID = 'compactor-01';
const DATA_NODE_IDS = ['data-02', 'data-01'];

async function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function makeLegacyStorage(root) {
  await write(root, `${CLUSTER_ID}/catalog/0001/catalog.log`, 'catalog-retention');
  await write(root, `${CLUSTER_ID}/_catalog_checkpoint`, 'checkpoint-retention');
  await write(root, `${CLUSTER_ID}/enterprise`, 'enterprise-retention');
  await write(root, `${CLUSTER_ID}/commercial_license`, 'license-retention');
  for (const nodeId of [...DATA_NODE_IDS, COMPACTOR_ID]) {
    await write(root, `${nodeId}/snapshots/0001/snapshot.parquet`, `${nodeId}-snapshot-retention`);
    await write(root, `${nodeId}/dbs/db-a/table-a/data.parquet`, `${nodeId}-database-retention`);
    await write(root, `${nodeId}/wal/0001/wal.log`, `${nodeId}-wal-retention`);
    await write(root, `${nodeId}/table-snapshots/db-a/derived`, 'excluded-retention');
  }
  await write(root, `${COMPACTOR_ID}/cs/summary`, 'compaction-summary-retention');
  await write(root, `${COMPACTOR_ID}/cd/detail`, 'compaction-detail-retention');
  await write(root, `${COMPACTOR_ID}/c/generation/data.parquet`, 'compaction-generation-retention');
}

function selector() {
  return {
    version: 1,
    kind: 'database-objects',
    allDatabases: true,
    databases: { include: [], exclude: [] },
    schemas: { include: [], exclude: [] },
    tables: { include: [], exclude: [] },
    includeGlobalObjects: false,
    digest: `sha256:${'a'.repeat(64)}`
  };
}

function controlFixture(data) {
  return {
    data,
    repository(type) {
      return {
        get: async (_workspaceId, id) => structuredClone(data[type].find((record) => record.id === id) || null),
        list: async (_workspaceId, options = {}) => structuredClone(data[type].slice(0, options.limit || data[type].length))
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-enterprise-legacy-retention-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'protected-data');
  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(dataRoot);
  await fs.mkdir(repositoryRoot);
  await makeLegacyStorage(dataRoot);
  const layout = await inspectLegacyClusterLayout({ dataRoot, clusterId: CLUSTER_ID, compactorNodeId: COMPACTOR_ID, dataNodeIds: DATA_NODE_IDS });
  const deploymentFingerprint = `sha256:${'b'.repeat(64)}`;
  const capabilityFingerprint = `sha256:${'c'.repeat(64)}`;
  const connection = {
    id: 'connection-legacy',
    revision: 3,
    adapterId: ADAPTER_ID,
    adapterVersion: '0.1.0',
    workerAffinity: [`device:${DEVICE_ID}`],
    trust: { fingerprint: deploymentFingerprint, capabilityFingerprint },
    lastTest: { status: 'success', endpointIdentity: { version: '3.8.1', storageEngine: 'legacy-parquet', legacyParquetEngine: true, compactorCapable: true, clusterId: CLUSTER_ID, nodeId: COMPACTOR_ID, deploymentFingerprint, capabilityFingerprint } }
  };
  const source = {
    id: 'source-legacy',
    revision: 5,
    name: 'Legacy full source',
    sourceType: 'database',
    adapterId: ADAPTER_ID,
    connectionId: connection.id,
    enabled: true,
    selector: selector(),
    consistency: { requestedLevel: 'application', method: CONSISTENCY_METHODS.stopped, backupMethod: 'physical', backupMode: 'full', captureCoordinates: false, allowDowngrade: false },
    physicalExecution: {
      tier: SOURCE_TIER,
      consistencyMode: 'stopped',
      consistencyMethod: CONSISTENCY_METHODS.stopped,
      confirmationText: CONSISTENCY_CONFIRMATIONS.stopped,
      operatorAttestation: 'stopped',
      clusterId: CLUSTER_ID,
      compactorNodeId: COMPACTOR_ID,
      dataNodeIds: DATA_NODE_IDS,
      topologyFingerprint: layout.topologyFingerprint,
      storageFingerprint: layout.storageFingerprint,
      connectionRevision: connection.revision
    },
    legacyFilesystem: { kind: 'local-filesystem', dataRoot }
  };
  const repository = { id: REPOSITORY_ID, workerAffinity: [`device:${DEVICE_ID}`] };
  const data = { repository: [repository], source: [source], connection: [connection], recoveryPoint: [], artifact: [], restoreRun: [], verificationRun: [] };
  const controlDatabase = controlFixture(data);
  const adapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot, clock: () => NOW });
  await adapter.initialize();
  const engine = new FileRepositoryEngine({ adapter, clock: () => NOW });
  const masterKey = Buffer.alloc(32, 71);
  await engine.ensureRepository({}, { repositoryId: REPOSITORY_ID });
  const reader = new InfluxDb3EnterpriseLegacySourceReaderService({ controlDatabase, deviceId: DEVICE_ID, adapterRegistry: { manifest: () => ({ adapterId: ADAPTER_ID, adapterVersion: '0.1.0' }) }, temporaryRoot: path.join(root, 'backup-stages'), assertClusterStopped: async () => ({ stopped: true }), clock: () => NOW });

  async function publish(executionId, idempotencyKey) {
    const sourceFiles = await reader.files(WORKSPACE_ID, source.id, { executionId, backupMode: 'full', requestedBackupMode: 'full' });
    const summary = await engine.createSnapshot({}, { repositoryId: REPOSITORY_ID, masterKey, keyVersion: 'legacy-retention-key-v1', idempotencyKey, files: sourceFiles.create() });
    const snapshot = await engine.openSnapshot({}, { repositoryId: REPOSITORY_ID, snapshotId: summary.snapshotId, masterKey });
    await reader.release(WORKSPACE_ID, executionId);
    return { sourceFiles, summary, snapshot };
  }

  const published = await publish('run-delete', 'legacy-retention-delete');
  const point = {
    id: POINT_ID,
    revision: 1,
    sourceId: source.id,
    type: 'full',
    consistency: 'application',
    chainRootId: POINT_ID,
    parentRecoveryPointId: null,
    retention: { deletionEligible: true, legalHold: false },
    repositoryCopies: [{ repositoryId: REPOSITORY_ID, engineSnapshotId: published.summary.snapshotId, manifestLocator: published.summary.manifestKey, manifestChecksum: published.summary.manifestChecksum, state: 'available', immutableUntil: null }]
  };
  data.recoveryPoint.push(point);
  const metadataFile = published.snapshot.manifest.files.find((file) => file.path === METADATA_PATH);
  const manifestStat = await adapter.stat({}, published.summary.manifestKey);
  data.artifact.push(
    { id: 'artifact-manifest', recoveryPointId: point.id, repositoryId: REPOSITORY_ID, kind: 'manifest', locator: published.summary.manifestKey, sizeBytes: manifestStat.sizeBytes, checksum: published.summary.manifestChecksum, encryption: { algorithm: 'aes-256-gcm', keyVersion: 'legacy-retention-key-v1' } },
    { id: 'artifact-metadata', recoveryPointId: point.id, repositoryId: REPOSITORY_ID, kind: 'metadata', locator: `${published.summary.manifestKey}#${encodeURIComponent(METADATA_PATH)}`, sizeBytes: metadataFile.sizeBytes, checksum: metadataFile.contentDigest, encryption: { algorithm: 'aes-256-gcm', keyVersion: 'legacy-retention-key-v1' }, metadata: published.sourceFiles.manifest.database }
  );
  const opened = { adapter, engine, masterKey };
  const service = new InfluxDb3EnterpriseLegacyRetentionService({ controlDatabase, openRepository: async () => opened, deviceId: DEVICE_ID, clock: () => NOW, randomUUID: () => '11111111-2222-4333-8444-555555555555' });
  return { root, dataRoot, repositoryRoot, data, controlDatabase, adapter, engine, masterKey, reader, publish, published, point, opened, service };
}

test('deletes an exactly owned standalone full legacy copy under a fresh reviewed plan', async (context) => {
  const current = await fixture(context);
  const candidateChunk = current.published.snapshot.manifest.files[0].chunks[0].key;
  const plan = await current.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID);
  assert.equal(plan.eligible, true);
  assert.equal(plan.blockedReason, null);
  assert.equal(plan.ownership.repositoryOwnerDevice, true);
  assert.equal(plan.ownership.uniqueManifestOwner, true);
  assert.equal(plan.ownership.encryptedMetadataArtifact, true);
  assert.equal(plan.ownership.completeMemberSet, true);
  assert.equal(plan.chain.standaloneFullRoot, true);
  assert.equal(plan.summary.manifestsToDelete, 1);
  assert.equal(plan.summary.chunksToDelete > 0, true);
  const deleted = await current.service.executeDeletion(WORKSPACE_ID, 'tester', POINT_ID, REPOSITORY_ID, plan.planId);
  assert.equal(deleted.copyState, 'pruned');
  assert.equal(deleted.manifestDeletionConfirmed, true);
  assert.equal(deleted.chunksDeleted, plan.summary.chunksToDelete);
  assert.equal(await current.adapter.stat({}, current.published.summary.manifestKey), null);
  assert.equal(await current.adapter.stat({}, candidateChunk), null);
  assert.equal(current.data.recoveryPoint[0].repositoryCopies[0].state, 'pruned');
});

test('blocks active restores, active or interrupted drills, and stale execution plans', async (context) => {
  const current = await fixture(context);
  current.data.restoreRun.push({ id: 'restore-active', state: 'running', recoveryPointIds: [POINT_ID] });
  let plan = await current.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID);
  assert.equal(plan.eligible, false);
  assert.equal(plan.blockedReason, 'active-operation');
  assert.deepEqual(plan.activeOperationIds, ['restore-active']);
  current.data.restoreRun[0].state = 'failed';
  current.data.verificationRun.push({ id: 'drill-interrupted', state: 'interrupted', mode: DRILL_MODE, recoveryPointId: POINT_ID, recoveryPointIds: [POINT_ID] });
  plan = await current.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID);
  assert.equal(plan.blockedReason, 'active-operation');
  assert.deepEqual(plan.activeOperationIds, ['drill-interrupted']);
  current.data.verificationRun[0].state = 'failed';
  const reviewed = await current.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID);
  current.data.verificationRun.push({ id: 'metadata-active', state: 'running', mode: METADATA_MODE, recoveryPointId: POINT_ID });
  await assert.rejects(current.service.executeDeletion(WORKSPACE_ID, 'tester', POINT_ID, REPOSITORY_ID, reviewed.planId), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_PLAN_STALE');
  assert.ok(await current.adapter.stat({}, current.published.summary.manifestKey));
});

test('fails closed for incomplete chain evidence and blocks known descendants', async (context) => {
  const incomplete = await fixture(context);
  incomplete.data.recoveryPoint[0].parentRecoveryPointId = 'missing-parent';
  await assert.rejects(incomplete.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_CHAIN_INCOMPLETE');
  assert.ok(await incomplete.adapter.stat({}, incomplete.published.summary.manifestKey));

  const dependent = await fixture(context);
  dependent.data.recoveryPoint.push({ id: 'rp-descendant', revision: 1, sourceId: dependent.point.sourceId, type: 'incremental', chainRootId: POINT_ID, parentRecoveryPointId: POINT_ID, retention: { deletionEligible: false }, repositoryCopies: [{ repositoryId: 'other-repository', state: 'available', engineSnapshotId: 'snapshot-other', manifestLocator: 'manifest-other', manifestChecksum: { digest: `sha256:${'9'.repeat(64)}` } }] });
  const plan = await dependent.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID);
  assert.equal(plan.eligible, false);
  assert.equal(plan.blockedReason, 'dependency');
  assert.deepEqual(plan.chain.dependencyIds, ['rp-descendant']);
});

test('refuses missing Artifact ownership and unowned repository manifests', async (context) => {
  const missingArtifact = await fixture(context);
  missingArtifact.data.artifact = missingArtifact.data.artifact.filter((artifact) => artifact.kind !== 'metadata');
  await assert.rejects(missingArtifact.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE');
  assert.ok(await missingArtifact.adapter.stat({}, missingArtifact.published.summary.manifestKey));

  const orphan = await fixture(context);
  const orphanFiles = await orphan.reader.files(WORKSPACE_ID, orphan.data.source[0].id, { executionId: 'run-orphan', backupMode: 'full', requestedBackupMode: 'full' });
  await orphan.engine.createSnapshot({}, { repositoryId: REPOSITORY_ID, masterKey: orphan.masterKey, keyVersion: 'legacy-retention-key-v1', idempotencyKey: 'orphan-manifest', files: orphanFiles.create() });
  await orphan.reader.release(WORKSPACE_ID, 'run-orphan');
  await assert.rejects(orphan.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE');
});

test('blocks retention policy, legal hold, and immutable-copy violations', async (context) => {
  const current = await fixture(context);
  current.data.recoveryPoint[0].retention.deletionEligible = false;
  let plan = await current.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID);
  assert.equal(plan.blockedReason, 'retention-not-eligible');
  current.data.recoveryPoint[0].retention.deletionEligible = true;
  current.data.recoveryPoint[0].retention.legalHold = true;
  plan = await current.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID);
  assert.equal(plan.blockedReason, 'legal-hold');
  current.data.recoveryPoint[0].retention.legalHold = false;
  current.data.recoveryPoint[0].repositoryCopies[0].immutableUntil = '2026-08-06T00:00:00.000Z';
  plan = await current.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID);
  assert.equal(plan.blockedReason, 'immutable');
  assert.ok(await current.adapter.stat({}, current.published.summary.manifestKey));
});

test('deletes only the candidate manifest when retained media shares every encrypted chunk', async (context) => {
  const current = await fixture(context);
  const retained = await current.publish('run-retained', 'legacy-retention-retained');
  current.data.recoveryPoint.push({
    id: 'rp-retained', revision: 1, sourceId: current.point.sourceId, type: 'full', consistency: 'application', chainRootId: 'rp-retained', parentRecoveryPointId: null,
    retention: { deletionEligible: false },
    repositoryCopies: [{ repositoryId: REPOSITORY_ID, engineSnapshotId: retained.summary.snapshotId, manifestLocator: retained.summary.manifestKey, manifestChecksum: retained.summary.manifestChecksum, state: 'available', immutableUntil: null }]
  });
  const sharedChunk = current.published.snapshot.manifest.files[0].chunks[0].key;
  const plan = await current.service.planDeletion(WORKSPACE_ID, POINT_ID, REPOSITORY_ID);
  assert.equal(plan.eligible, true);
  assert.equal(plan.summary.chunksToDelete, 0);
  await current.service.executeDeletion(WORKSPACE_ID, 'tester', POINT_ID, REPOSITORY_ID, plan.planId);
  assert.equal(await current.adapter.stat({}, current.published.summary.manifestKey), null);
  assert.ok(await current.adapter.stat({}, retained.summary.manifestKey));
  assert.ok(await current.adapter.stat({}, sharedChunk));
});
