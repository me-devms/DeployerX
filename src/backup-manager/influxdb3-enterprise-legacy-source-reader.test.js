const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ADAPTER_ID } = require('./influxdb3-enterprise');
const {
  CONSISTENCY_CONFIRMATIONS,
  CONSISTENCY_METHODS,
  inspectLegacyClusterLayout
} = require('./influxdb3-enterprise-legacy');
const {
  ARTIFACT_KIND,
  InfluxDb3EnterpriseLegacySourceReaderService,
  MEDIA_PREFIX,
  METADATA_PATH,
  SOURCE_TIER,
  STAGE_KIND,
  isLegacyFilesystemSource,
  normalizeLegacySourceExecution,
  preparationPrefix
} = require('./influxdb3-enterprise-legacy-source-reader');
const { LocalFolderRepositoryAdapter } = require('./local-repository');
const { FileRepositoryEngine } = require('./repository-engine');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'legacy-filesystem-device';
const CLUSTER_ID = 'cluster-001';
const COMPACTOR_ID = 'compactor-01';
const DATA_NODE_IDS = ['data-02', 'data-01'];

async function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function makeLegacyStorage(root) {
  await write(root, `${CLUSTER_ID}/catalog/0001/catalog.log`, 'catalog-plaintext');
  await write(root, `${CLUSTER_ID}/_catalog_checkpoint`, 'checkpoint-plaintext');
  await write(root, `${CLUSTER_ID}/enterprise`, 'enterprise-plaintext');
  await write(root, `${CLUSTER_ID}/commercial_license`, 'license-plaintext');
  for (const nodeId of [...DATA_NODE_IDS, COMPACTOR_ID]) {
    await write(root, `${nodeId}/snapshots/0001/snapshot.parquet`, `${nodeId}-snapshot-plaintext`);
    await write(root, `${nodeId}/dbs/db-a/table-a/data.parquet`, `${nodeId}-database-plaintext`);
    await write(root, `${nodeId}/wal/0001/wal.log`, `${nodeId}-wal-plaintext`);
    await write(root, `${nodeId}/table-snapshots/db-a/derived`, 'excluded-plaintext');
  }
  await write(root, `${COMPACTOR_ID}/cs/summary`, 'compaction-summary-plaintext');
  await write(root, `${COMPACTOR_ID}/cd/detail`, 'compaction-detail-plaintext');
  await write(root, `${COMPACTOR_ID}/c/generation/data.parquet`, 'compaction-generation-plaintext');
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

function endpointIdentity() {
  return {
    version: '3.8.1',
    storageEngine: 'legacy-parquet',
    legacyParquetEngine: true,
    compactorCapable: true,
    clusterId: CLUSTER_ID,
    nodeId: COMPACTOR_ID,
    deploymentFingerprint: `sha256:${'b'.repeat(64)}`,
    capabilityFingerprint: `sha256:${'c'.repeat(64)}`
  };
}

function execution(layout, consistencyMode = 'stopped') {
  return {
    tier: SOURCE_TIER,
    consistencyMode,
    consistencyMethod: CONSISTENCY_METHODS[consistencyMode],
    confirmationText: CONSISTENCY_CONFIRMATIONS[consistencyMode],
    operatorAttestation: consistencyMode,
    clusterId: CLUSTER_ID,
    compactorNodeId: COMPACTOR_ID,
    dataNodeIds: DATA_NODE_IDS,
    topologyFingerprint: layout.topologyFingerprint,
    storageFingerprint: layout.storageFingerprint,
    connectionRevision: 3
  };
}

function consistency(consistencyMode = 'stopped') {
  return {
    requestedLevel: consistencyMode === 'ordered-live-copy' ? 'crash' : 'application',
    method: CONSISTENCY_METHODS[consistencyMode],
    backupMethod: 'physical',
    backupMode: 'full',
    captureCoordinates: false,
    allowDowngrade: false
  };
}

function controlDatabase(records) {
  return {
    repository(type) {
      return {
        async get(workspaceId, id) {
          return workspaceId === WORKSPACE_ID ? structuredClone(records[type]?.get(id) || null) : null;
        }
      };
    }
  };
}

async function fixture(context, consistencyMode = 'stopped') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-enterprise-legacy-source-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'protected-data');
  await fs.mkdir(dataRoot);
  await makeLegacyStorage(dataRoot);
  const layout = await inspectLegacyClusterLayout({ dataRoot, clusterId: CLUSTER_ID, compactorNodeId: COMPACTOR_ID, dataNodeIds: DATA_NODE_IDS });
  const connection = {
    id: 'connection-legacy',
    workspaceId: WORKSPACE_ID,
    revision: 3,
    adapterId: ADAPTER_ID,
    adapterVersion: '0.1.0',
    secretRefIds: ['secret-admin-token'],
    workerAffinity: [`device:${DEVICE_ID}`],
    trust: { fingerprint: endpointIdentity().deploymentFingerprint, capabilityFingerprint: endpointIdentity().capabilityFingerprint },
    lastTest: { status: 'success', endpointIdentity: endpointIdentity() }
  };
  const source = {
    id: 'source-legacy',
    workspaceId: WORKSPACE_ID,
    revision: 5,
    sourceType: 'database',
    adapterId: ADAPTER_ID,
    connectionId: connection.id,
    enabled: true,
    selector: selector(),
    consistency: consistency(consistencyMode),
    physicalExecution: execution(layout, consistencyMode),
    legacyFilesystem: { kind: 'local-filesystem', dataRoot }
  };
  const records = { source: new Map([[source.id, source]]), connection: new Map([[connection.id, connection]]) };
  const temporaryRoot = path.join(root, 'source-stages');
  const reader = new InfluxDb3EnterpriseLegacySourceReaderService({
    controlDatabase: controlDatabase(records),
    deviceId: DEVICE_ID,
    adapterRegistry: { manifest: () => ({ adapterId: ADAPTER_ID, adapterVersion: '0.1.0' }) },
    temporaryRoot,
    assertClusterStopped: async () => ({ stopped: true }),
    clock: () => '2026-08-05T12:00:00.000Z'
  });
  return { root, dataRoot, layout, connection, source, records, temporaryRoot, reader };
}

async function repository(context, root) {
  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot);
  const adapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await adapter.initialize();
  const engine = new FileRepositoryEngine({ adapter });
  const repositoryId = 'repository-legacy';
  const masterKey = Buffer.alloc(32, 47);
  await engine.ensureRepository({}, { repositoryId });
  return { repositoryRoot, adapter, engine, repositoryId, masterKey };
}

async function allFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files;
}

test('requires the exact legacy tier and exact confirmation for every filesystem proof mode', async (context) => {
  const current = await fixture(context);
  assert.equal(isLegacyFilesystemSource(current.source), true);
  assert.equal(isLegacyFilesystemSource({ ...current.source, physicalExecution: { ...current.source.physicalExecution, tier: 'native' } }), false);
  for (const mode of ['stopped', 'atomic-snapshot', 'ordered-live-copy']) {
    const normalized = normalizeLegacySourceExecution(execution(current.layout, mode));
    assert.equal(normalized.tier, SOURCE_TIER);
    assert.equal(normalized.consistencyMode, mode);
    assert.equal(normalized.confirmationText, CONSISTENCY_CONFIRMATIONS[mode]);
    assert.throws(() => normalizeLegacySourceExecution({ ...execution(current.layout, mode), confirmationText: 'confirmed' }), /exact operator confirmation/);
  }
  assert.throws(() => normalizeLegacySourceExecution({ ...execution(current.layout), tier: 'upgraded-native' }), /legacy-filesystem tier/);
});

test('publishes a complete encrypted full RecoveryPoint without exposing local paths', async (context) => {
  const current = await fixture(context, 'stopped');
  let stopProofs = 0;
  current.reader.assertClusterStopped = async ({ clusterId, nodeIds }) => {
    stopProofs += 1;
    assert.equal(clusterId, CLUSTER_ID);
    assert.deepEqual(nodeIds, ['data-01', 'data-02', COMPACTOR_ID]);
    return { stopped: true };
  };
  const files = await current.reader.files(WORKSPACE_ID, current.source.id, { executionId: 'run-encrypted', backupMode: 'full', requestedBackupMode: 'full' });
  assert.equal(files.manifest.database.kind, ARTIFACT_KIND);
  assert.equal(files.manifest.database.tier, SOURCE_TIER);
  assert.equal(files.manifest.database.capture.completeMediaAuthenticated, true);
  assert.equal(files.manifest.database.publication.localPathsPublished, false);
  assert.equal(JSON.stringify(files.manifest).includes(current.dataRoot), false);
  assert.equal(JSON.stringify(files.manifest).includes(current.temporaryRoot), false);
  assert.equal(files.manifest.database.nativeMedia.fileCount, 16);
  assert.equal(stopProofs, 11);

  const opened = await repository(context, current.root);
  const snapshotSummary = await opened.engine.createSnapshot({}, {
    repositoryId: opened.repositoryId,
    masterKey: opened.masterKey,
    keyVersion: 'legacy-key-v1',
    idempotencyKey: 'legacy-full-publication',
    files: files.create()
  });
  const snapshot = await opened.engine.openSnapshot({}, { repositoryId: opened.repositoryId, snapshotId: snapshotSummary.snapshotId, masterKey: opened.masterKey });
  assert.equal(snapshot.manifest.files.length, 17);
  assert.equal(snapshot.manifest.files.some((file) => file.path === METADATA_PATH), true);
  assert.equal(snapshot.manifest.files.filter((file) => file.path.startsWith(MEDIA_PREFIX)).length, 16);
  assert.deepEqual(opened.engine.manifest().encryption, { algorithm: 'aes-256-gcm', clientSide: true, authenticated: true });
  assert.equal(snapshot.manifest.files.every((file) => file.chunks.every((chunk) => chunk.keyVersion === 'legacy-key-v1')), true);
  const metadata = JSON.parse((await opened.engine.readFile({}, { repositoryId: opened.repositoryId, manifest: snapshot.manifest, path: METADATA_PATH, masterKey: opened.masterKey })).toString('utf8'));
  assert.equal(metadata.nativeMedia.mediaFingerprint, current.layout ? files.manifest.database.nativeMedia.mediaFingerprint : null);
  assert.equal(JSON.stringify(metadata).includes(current.dataRoot), false);
  assert.equal(JSON.stringify(metadata).includes(current.temporaryRoot), false);
  const storedBytes = await Promise.all((await allFiles(opened.repositoryRoot)).map((file) => fs.readFile(file)));
  for (const plaintext of ['catalog-plaintext', 'checkpoint-plaintext', 'compaction-generation-plaintext']) {
    assert.equal(storedBytes.some((bytes) => bytes.includes(Buffer.from(plaintext))), false, `Repository disclosed ${plaintext}.`);
  }
  assert.equal(await current.reader.release(WORKSPACE_ID, 'run-encrypted'), true);
  assert.deepEqual(await fs.readdir(current.temporaryRoot), []);
});

test('rejects non-full Jobs, loose consistency, and changed legacy storage identity', async (context) => {
  const current = await fixture(context, 'atomic-snapshot');
  await assert.rejects(current.reader.files(WORKSPACE_ID, current.source.id, { executionId: 'run-incremental', backupMode: 'incremental', requestedBackupMode: 'incremental' }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_MODE_UNSUPPORTED');
  current.source.consistency.method = 'auto';
  await assert.rejects(current.reader.plan(WORKSPACE_ID, current.source.id), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_CONSISTENCY_INVALID');
  current.source.consistency = consistency('atomic-snapshot');
  await fs.rename(current.dataRoot, `${current.dataRoot}-old`);
  await fs.mkdir(current.dataRoot);
  await makeLegacyStorage(current.dataRoot);
  await assert.rejects(current.reader.plan(WORKSPACE_ID, current.source.id), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STORAGE_CHANGED');
});

test('detects staged-media tampering and removes only an exactly owned stage', async (context) => {
  const current = await fixture(context, 'ordered-live-copy');
  const files = await current.reader.files(WORKSPACE_ID, current.source.id, { executionId: 'run-tamper', backupMode: 'full', requestedBackupMode: 'full' });
  const [stageName] = await fs.readdir(current.temporaryRoot);
  const stage = path.join(current.temporaryRoot, stageName);
  await fs.appendFile(path.join(stage, 'media', CLUSTER_ID, '_catalog_checkpoint'), '-tampered');
  await assert.rejects(async () => {
    for await (const file of files.create()) {
      for await (const _chunk of file.content) {}
    }
  }, (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID');
  await fs.writeFile(path.join(stage, '.owner.json'), JSON.stringify({ version: 1, kind: STAGE_KIND, state: 'prepared', workspaceId: 'other', executionId: 'run-tamper', sourceId: current.source.id }));
  assert.equal(await current.reader.release(WORKSPACE_ID, 'run-tamper'), false);
  assert.equal(Boolean(await fs.lstat(stage).catch(() => null)), true);

  const invalid = path.join(current.temporaryRoot, `${preparationPrefix(WORKSPACE_ID, 'run-reconcile')}invalid`);
  await fs.mkdir(invalid);
  await fs.writeFile(path.join(invalid, '.owner.json'), JSON.stringify({ version: 1, kind: STAGE_KIND, state: 'prepared', workspaceId: 'other', executionId: 'run-reconcile' }));
  const reconciled = await current.reader.reconcileRun(WORKSPACE_ID, { id: 'run-reconcile' });
  assert.deepEqual(reconciled, { applicable: true, proven: false, removedTemporaryDirectories: 0, sourceMediaDeleted: false, repositoryMediaDeleted: false, sourceLease: null });
  assert.equal(Boolean(await fs.lstat(invalid).catch(() => null)), true);
});
