const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  CONSISTENCY_CONFIRMATIONS,
  CONSISTENCY_METHODS,
  RESTORE_CONFIRMATION,
  authenticateLegacyFilesystem,
  captureLegacyFilesystem,
  capturePhaseDefinitions,
  inspectLegacyClusterLayout,
  normalizeBackupExecution,
  normalizeLegacyTopology,
  restoreLegacyFilesystem,
  restorePhaseDefinitions
} = require('./influxdb3-enterprise-legacy');

const CLUSTER_ID = 'cluster-001';
const COMPACTOR_ID = 'compactor-01';
const DATA_NODE_IDS = ['data-02', 'data-01'];

async function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function legacyFixture(context, name = 'source') {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-enterprise-legacy-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const dataRoot = path.join(temporaryRoot, name);
  await fs.mkdir(dataRoot, { recursive: true });
  await write(dataRoot, `${CLUSTER_ID}/catalog/0001/catalog.log`, 'catalog');
  await write(dataRoot, `${CLUSTER_ID}/_catalog_checkpoint`, 'checkpoint');
  await write(dataRoot, `${CLUSTER_ID}/enterprise`, 'enterprise-config');
  await write(dataRoot, `${CLUSTER_ID}/commercial_license`, 'commercial-license');
  for (const nodeId of [...DATA_NODE_IDS, COMPACTOR_ID]) {
    await write(dataRoot, `${nodeId}/snapshots/0001/snapshot.parquet`, `${nodeId}-snapshot`);
    await write(dataRoot, `${nodeId}/dbs/db-a/table-a/2026-08-05/data.parquet`, `${nodeId}-database`);
    await write(dataRoot, `${nodeId}/wal/0001/wal.log`, `${nodeId}-wal`);
    await write(dataRoot, `${nodeId}/table-snapshots/db-a/table-a/derived`, 'excluded');
  }
  await write(dataRoot, `${COMPACTOR_ID}/cs/summary`, 'compaction-summary');
  await write(dataRoot, `${COMPACTOR_ID}/cd/detail`, 'compaction-detail');
  await write(dataRoot, `${COMPACTOR_ID}/c/generation/data.parquet`, 'compaction-generation');
  return { temporaryRoot, dataRoot, clusterId: CLUSTER_ID, compactorNodeId: COMPACTOR_ID, dataNodeIds: DATA_NODE_IDS };
}

function topologyInput(fixture, overrides = {}) {
  return {
    dataRoot: fixture.dataRoot,
    clusterId: fixture.clusterId,
    compactorNodeId: fixture.compactorNodeId,
    dataNodeIds: fixture.dataNodeIds,
    ...overrides
  };
}

function execution(layout, consistencyMode = 'stopped') {
  return normalizeBackupExecution({
    consistencyMode,
    consistencyMethod: CONSISTENCY_METHODS[consistencyMode],
    confirmationText: CONSISTENCY_CONFIRMATIONS[consistencyMode],
    clusterId: layout.clusterId,
    compactorNodeId: layout.compactorNodeId,
    dataNodeIds: layout.dataNodeIds,
    topologyFingerprint: layout.topologyFingerprint,
    storageFingerprint: layout.storageFingerprint,
    connectionRevision: 1
  });
}

test('normalizes an exact legacy topology and preserves the documented copy and restore order', async (context) => {
  const fixture = await legacyFixture(context);
  const topology = normalizeLegacyTopology(topologyInput(fixture));
  assert.deepEqual(topology.dataNodeIds, ['data-01', 'data-02']);
  assert.deepEqual(topology.allNodeIds, ['data-01', 'data-02', COMPACTOR_ID]);
  assert.deepEqual(capturePhaseDefinitions(topology).map((phase) => phase.phase), [
    'compactor-cs', 'compactor-cd', 'compactor-c', 'nodes-snapshots', 'nodes-dbs', 'nodes-wal',
    'cluster-catalog', 'cluster-checkpoint', 'cluster-enterprise', 'cluster-licenses'
  ]);
  assert.deepEqual(restorePhaseDefinitions(topology).map((phase) => phase.phase), [
    'cluster-checkpoint', 'cluster-catalog', 'cluster-enterprise', 'cluster-licenses',
    'nodes-snapshots', 'nodes-dbs', 'nodes-wal', 'compactor-cs', 'compactor-cd', 'compactor-c'
  ]);
  assert.throws(() => normalizeLegacyTopology(topologyInput(fixture, { dataNodeIds: ['data-01', 'data-01'] })), /unique/);
  assert.throws(() => normalizeLegacyTopology(topologyInput(fixture, { dataNodeIds: [COMPACTOR_ID] })), /compactor separate/);
  assert.throws(() => normalizeLegacyTopology(topologyInput(fixture, { dataRoot: path.parse(fixture.dataRoot).root })), /filesystem root/);
});

test('requires exact operator confirmation and rejects an attestation-field bypass', async (context) => {
  const fixture = await legacyFixture(context);
  const layout = await inspectLegacyClusterLayout(topologyInput(fixture));
  const base = {
    consistencyMode: 'stopped',
    consistencyMethod: CONSISTENCY_METHODS.stopped,
    clusterId: layout.clusterId,
    compactorNodeId: layout.compactorNodeId,
    dataNodeIds: layout.dataNodeIds,
    topologyFingerprint: layout.topologyFingerprint,
    storageFingerprint: layout.storageFingerprint,
    connectionRevision: 1
  };
  assert.throws(() => normalizeBackupExecution(base), /exact operator confirmation/);
  assert.throws(() => normalizeBackupExecution({ ...base, operatorAttestation: 'stopped' }), /exact operator confirmation/);
});

test('inspects every required legacy member and excludes regenerable table snapshots', async (context) => {
  const fixture = await legacyFixture(context);
  const layout = await inspectLegacyClusterLayout(topologyInput(fixture));
  assert.equal(layout.fileCount, 16);
  assert.equal(layout.totalBytes > 0, true);
  assert.deepEqual(layout.excluded, [
    'data-01/table-snapshots/', 'data-02/table-snapshots/', `${COMPACTOR_ID}/table-snapshots/`
  ]);
  assert.equal(layout.phases.flatMap((phase) => phase.files).some((file) => file.relativePath.includes('table-snapshots')), false);
  assert.match(layout.storageFingerprint, /^sha256:[0-9a-f]{64}$/);
  await write(fixture.dataRoot, 'data-01/unknown/state', 'unknown');
  await assert.rejects(inspectLegacyClusterLayout(topologyInput(fixture)), (caught) => caught.code === 'INFLUXDB3_ENTERPRISE_LEGACY_LAYOUT_UNSUPPORTED');
});

test('captures the complete filesystem cluster in official order with repeated stop proof', async (context) => {
  const fixture = await legacyFixture(context);
  const layout = await inspectLegacyClusterLayout(topologyInput(fixture));
  const destination = path.join(fixture.temporaryRoot, 'capture');
  const progress = [];
  let stopProofs = 0;
  const media = await captureLegacyFilesystem({
    assertClusterStopped: async ({ nodeIds }) => { stopProofs += 1; assert.deepEqual(nodeIds, ['data-01', 'data-02', COMPACTOR_ID]); return { stopped: true }; },
    onProgress: (event) => progress.push(event.component)
  }, topologyInput(fixture), execution(layout), destination);
  assert.deepEqual(progress, media.copyOrder);
  assert.equal(stopProofs, media.copyOrder.length + 1);
  assert.equal(media.fileCount, 16);
  assert.equal(media.consistency, 'application');
  assert.deepEqual(media.driftPhases, []);
  assert.equal(media.members.some((member) => member.relativePath.includes('table-snapshots')), false);
  assert.equal(await fs.readFile(path.join(destination, CLUSTER_ID, '_catalog_checkpoint'), 'utf8'), 'checkpoint');
  const authenticated = await authenticateLegacyFilesystem(destination, media);
  assert.equal(authenticated.files.length, media.fileCount);
});

test('fails application-consistent capture on phase drift but records ordered live-copy drift', async (context) => {
  const atomicFixture = await legacyFixture(context, 'atomic-source');
  const atomicLayout = await inspectLegacyClusterLayout(topologyInput(atomicFixture));
  const atomicDestination = path.join(atomicFixture.temporaryRoot, 'atomic-capture');
  let atomicChanged = false;
  await assert.rejects(captureLegacyFilesystem({ onProgress: async ({ component }) => {
    if (!atomicChanged && component === 'nodes-dbs') {
      atomicChanged = true;
      await fs.appendFile(path.join(atomicFixture.dataRoot, COMPACTOR_ID, 'cs', 'summary'), '-changed');
    }
  } }, topologyInput(atomicFixture), execution(atomicLayout, 'atomic-snapshot'), atomicDestination), (caught) => caught.code === 'INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED');
  assert.equal(await fs.lstat(atomicDestination).catch(() => null), null);

  const liveFixture = await legacyFixture(context, 'live-source');
  const liveLayout = await inspectLegacyClusterLayout(topologyInput(liveFixture));
  let liveChanged = false;
  const live = await captureLegacyFilesystem({ onProgress: async ({ component }) => {
    if (!liveChanged && component === 'nodes-dbs') {
      liveChanged = true;
      await fs.appendFile(path.join(liveFixture.dataRoot, COMPACTOR_ID, 'cs', 'summary'), '-changed');
    }
  } }, topologyInput(liveFixture), execution(liveLayout, 'ordered-live-copy'), path.join(liveFixture.temporaryRoot, 'live-capture'));
  assert.equal(live.consistency, 'crash');
  assert.deepEqual(live.driftPhases, ['compactor-cs']);
});

test('authenticates all recovery bytes and refuses tampered media', async (context) => {
  const fixture = await legacyFixture(context);
  const layout = await inspectLegacyClusterLayout(topologyInput(fixture));
  const destination = path.join(fixture.temporaryRoot, 'capture');
  const media = await captureLegacyFilesystem({}, topologyInput(fixture), execution(layout, 'ordered-live-copy'), destination);
  await fs.appendFile(path.join(destination, 'data-01', 'wal', '0001', 'wal.log'), '-tampered');
  await assert.rejects(authenticateLegacyFilesystem(destination, media), (caught) => caught.code === 'INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID');
});

test('restores only to empty alternate storage in reverse dependency order and leaves startup manual', async (context) => {
  const fixture = await legacyFixture(context);
  const layout = await inspectLegacyClusterLayout(topologyInput(fixture));
  const captureRoot = path.join(fixture.temporaryRoot, 'capture');
  const media = await captureLegacyFilesystem({}, topologyInput(fixture), execution(layout, 'ordered-live-copy'), captureRoot);
  const targetRoot = path.join(fixture.temporaryRoot, 'target');
  await fs.mkdir(targetRoot);
  const progress = [];
  let stopProofs = 0;
  const result = await restoreLegacyFilesystem({ assertClusterStopped: async () => { stopProofs += 1; return true; }, onProgress: (event) => progress.push(event.component) }, captureRoot, media, {
    dataRoot: targetRoot, clusterId: CLUSTER_ID, compactorNodeId: COMPACTOR_ID, dataNodeIds: DATA_NODE_IDS, confirmationText: RESTORE_CONFIRMATION
  });
  assert.deepEqual(progress, result.restoreOrder);
  assert.equal(stopProofs, (result.restoreOrder.length * 2) + 1);
  assert.equal(result.originalStoreCleared, false);
  assert.equal(result.partialStatePreservedOnFailure, true);
  assert.equal(result.ownershipReviewRequired, true);
  assert.equal(result.licenseReviewRequired, true);
  assert.equal(result.manualStartupRequired, true);
  assert.equal(await fs.readFile(path.join(targetRoot, COMPACTOR_ID, 'c', 'generation', 'data.parquet'), 'utf8'), 'compaction-generation');
  assert.equal(await fs.lstat(path.join(targetRoot, 'data-01', 'table-snapshots')).catch(() => null), null);
  const installed = await authenticateLegacyFilesystem(targetRoot, media);
  assert.equal(installed.media.mediaFingerprint, media.mediaFingerprint);
});

test('refuses a non-empty restore target before mutation and preserves partial writes after a stop-proof loss', async (context) => {
  const fixture = await legacyFixture(context);
  const layout = await inspectLegacyClusterLayout(topologyInput(fixture));
  const captureRoot = path.join(fixture.temporaryRoot, 'capture');
  const media = await captureLegacyFilesystem({}, topologyInput(fixture), execution(layout, 'ordered-live-copy'), captureRoot);
  const occupied = path.join(fixture.temporaryRoot, 'occupied');
  await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, 'unrelated'), 'keep');
  await assert.rejects(restoreLegacyFilesystem({ assertClusterStopped: async () => true }, captureRoot, media, {
    dataRoot: occupied, clusterId: CLUSTER_ID, compactorNodeId: COMPACTOR_ID, dataNodeIds: DATA_NODE_IDS, confirmationText: RESTORE_CONFIRMATION
  }), (caught) => caught.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_NOT_EMPTY');
  assert.equal(await fs.readFile(path.join(occupied, 'unrelated'), 'utf8'), 'keep');

  const partial = path.join(fixture.temporaryRoot, 'partial');
  await fs.mkdir(partial);
  let proofs = 0;
  await assert.rejects(restoreLegacyFilesystem({ assertClusterStopped: async () => ({ stopped: ++proofs < 3 }) }, captureRoot, media, {
    dataRoot: partial, clusterId: CLUSTER_ID, compactorNodeId: COMPACTOR_ID, dataNodeIds: DATA_NODE_IDS, confirmationText: RESTORE_CONFIRMATION
  }), (caught) => caught.code === 'INFLUXDB3_ENTERPRISE_LEGACY_CLUSTER_RUNNING' && caught.details.partialStatePreserved === true);
  assert.equal((await fs.readdir(partial)).length > 0, true);
});

test('rejects recovery media drift after authentication before mutating the alternate target', async (context) => {
  const fixture = await legacyFixture(context);
  const layout = await inspectLegacyClusterLayout(topologyInput(fixture));
  const captureRoot = path.join(fixture.temporaryRoot, 'capture');
  const media = await captureLegacyFilesystem({}, topologyInput(fixture), execution(layout, 'ordered-live-copy'), captureRoot);
  const targetRoot = path.join(fixture.temporaryRoot, 'drift-target');
  await fs.mkdir(targetRoot);
  let changed = false;
  await assert.rejects(restoreLegacyFilesystem({
    assertClusterStopped: async () => true,
    onProgress: async ({ component }) => {
      if (!changed && component === 'cluster-checkpoint') {
        changed = true;
        await fs.appendFile(path.join(captureRoot, CLUSTER_ID, '_catalog_checkpoint'), '-changed-after-auth');
      }
    }
  }, captureRoot, media, {
    dataRoot: targetRoot, clusterId: CLUSTER_ID, compactorNodeId: COMPACTOR_ID, dataNodeIds: DATA_NODE_IDS, confirmationText: RESTORE_CONFIRMATION
  }), (caught) => caught.code === 'INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED' && caught.details.partialStatePreserved !== true && JSON.stringify(caught.details).includes(targetRoot) === false);
  assert.deepEqual(await fs.readdir(targetRoot), []);
});

test('refuses unsafe links when the platform permits link creation', async (context) => {
  const fixture = await legacyFixture(context);
  const link = path.join(fixture.dataRoot, 'data-01', 'wal', 'unsafe-link');
  try {
    await fs.symlink(path.join(fixture.dataRoot, CLUSTER_ID, '_catalog_checkpoint'), link);
    await assert.rejects(inspectLegacyClusterLayout(topologyInput(fixture)), (caught) => caught.code === 'INFLUXDB3_ENTERPRISE_LEGACY_LINK_REFUSED');
  } catch (caught) {
    if (!['EPERM', 'EACCES'].includes(caught.code)) throw caught;
  }
});
