const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { ADAPTER_ID } = require('./influxdb3-enterprise');
const {
  CONSISTENCY_CONFIRMATIONS,
  CONSISTENCY_METHODS,
  RESTORE_CONFIRMATION,
  inspectLegacyClusterLayout
} = require('./influxdb3-enterprise-legacy');
const {
  InfluxDb3EnterpriseLegacyRestoreService,
  RESTORE_OPERATION,
  RESTORE_STAGE_KIND,
  containsAbsolutePath,
  normalizeRestoreRequest,
  restorePrefix
} = require('./influxdb3-enterprise-legacy-restore');
const {
  MEDIA_PREFIX,
  METADATA_PATH,
  SOURCE_TIER,
  InfluxDb3EnterpriseLegacySourceReaderService
} = require('./influxdb3-enterprise-legacy-source-reader');
const { ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID, LocalFolderRepositoryAdapter } = require('./local-repository');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'enterprise-legacy-restore-device';
const CLUSTER_ID = 'cluster-001';
const COMPACTOR_ID = 'compactor-01';
const DATA_NODE_IDS = ['data-02', 'data-01'];

async function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function makeLegacyStorage(root) {
  await write(root, `${CLUSTER_ID}/catalog/0001/catalog.log`, 'catalog-protected');
  await write(root, `${CLUSTER_ID}/_catalog_checkpoint`, 'checkpoint-protected');
  await write(root, `${CLUSTER_ID}/enterprise`, 'enterprise-protected');
  await write(root, `${CLUSTER_ID}/commercial_license`, 'license-protected');
  for (const nodeId of [...DATA_NODE_IDS, COMPACTOR_ID]) {
    await write(root, `${nodeId}/snapshots/0001/snapshot.parquet`, `${nodeId}-snapshot-protected`);
    await write(root, `${nodeId}/dbs/db-a/table-a/data.parquet`, `${nodeId}-database-protected`);
    await write(root, `${nodeId}/wal/0001/wal.log`, `${nodeId}-wal-protected`);
    await write(root, `${nodeId}/table-snapshots/db-a/derived`, 'excluded-protected');
  }
  await write(root, `${COMPACTOR_ID}/cs/summary`, 'compaction-summary-protected');
  await write(root, `${COMPACTOR_ID}/cd/detail`, 'compaction-detail-protected');
  await write(root, `${COMPACTOR_ID}/c/generation/data.parquet`, 'compaction-generation-protected');
}

function endpointIdentity(fingerprint) {
  return {
    version: '3.8.1',
    storageEngine: 'legacy-parquet',
    legacyParquetEngine: true,
    compactorCapable: true,
    nativeBackupAvailable: false,
    clusterId: CLUSTER_ID,
    nodeId: COMPACTOR_ID,
    deploymentFingerprint: fingerprint,
    capabilityFingerprint: `sha256:${'c'.repeat(64)}`
  };
}

function authenticatedStopProof(request, sequence = 1) {
  const timestamp = '2026-08-05T15:00:00.000Z';
  return {
    stopped: true,
    nodes: [...request.nodeIds].sort((left, right) => left.localeCompare(right, 'en-US')).map((nodeId) => ({
      nodeId,
      unitName: nodeId === COMPACTOR_ID ? 'influxdb3-compactor.service' : 'influxdb3-data.service',
      checkedAt: timestamp,
      recheckedAt: timestamp
    })),
    issuedAt: timestamp,
    proofDigest: `hmac-sha256:${sequence.toString(16).padStart(64, '0')}`
  };
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

function targetInput(root) {
  return { kind: 'local-filesystem', dataRoot: root, clusterId: CLUSTER_ID, compactorNodeId: COMPACTOR_ID, dataNodeIds: DATA_NODE_IDS };
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-enterprise-legacy-restore-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control'), clock: () => '2026-08-05T15:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const sourceDataRoot = path.join(root, 'protected-data');
  const targetDataRoot = path.join(root, 'alternate-target');
  await fs.mkdir(sourceDataRoot);
  await fs.mkdir(targetDataRoot);
  await makeLegacyStorage(sourceDataRoot);
  const layout = await inspectLegacyClusterLayout({ dataRoot: sourceDataRoot, clusterId: CLUSTER_ID, compactorNodeId: COMPACTOR_ID, dataNodeIds: DATA_NODE_IDS });
  const sourceFingerprint = `sha256:${'b'.repeat(64)}`;
  const targetFingerprint = `sha256:${'d'.repeat(64)}`;
  const sourceIdentity = endpointIdentity(sourceFingerprint);
  const targetIdentity = endpointIdentity(targetFingerprint);
  const sourceConnection = await controlDatabase.repository('connection').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Legacy protected compactor',
    kind: 'database',
    adapterId: ADAPTER_ID,
    adapterVersion: '0.1.0',
    scope: 'device',
    endpoint: { protocol: 'https', host: 'source.example.test', port: 8181 },
    secretRefIds: [],
    workerAffinity: [`device:${DEVICE_ID}`],
    lastTest: { status: 'success', endpointIdentity: sourceIdentity },
    trust: { fingerprint: sourceFingerprint, capabilityFingerprint: sourceIdentity.capabilityFingerprint }
  });
  const targetConnection = await controlDatabase.repository('connection').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Legacy alternate compactor',
    kind: 'database',
    adapterId: ADAPTER_ID,
    adapterVersion: '0.1.0',
    scope: 'device',
    endpoint: { protocol: 'https', host: 'target.example.test', port: 8181 },
    secretRefIds: [],
    workerAffinity: [`device:${DEVICE_ID}`],
    lastTest: { status: 'success', endpointIdentity: targetIdentity },
    trust: { fingerprint: targetFingerprint, capabilityFingerprint: targetIdentity.capabilityFingerprint }
  });
  const source = await controlDatabase.repository('source').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Legacy whole cluster',
    connectionId: sourceConnection.id,
    sourceType: 'database',
    adapterId: ADAPTER_ID,
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
      connectionRevision: sourceConnection.revision
    },
    legacyFilesystem: { kind: 'local-filesystem', dataRoot: sourceDataRoot }
  });
  const policy = await controlDatabase.repository('policy').create({ workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Legacy full policy', enabled: true, backupMode: 'full', notificationRouteIds: [] });
  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot);
  const repository = await controlDatabase.repository('repository').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Encrypted legacy repository',
    connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID,
    adapterVersion: '1.0.0',
    engineId: ENGINE_ID,
    engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot },
    secretRefIds: [],
    encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'legacy-restore-key-v1' },
    workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 61);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const backupTemporaryRoot = path.join(root, 'backup-stages');
  const reader = new InfluxDb3EnterpriseLegacySourceReaderService({
    controlDatabase,
    deviceId: DEVICE_ID,
    adapterRegistry: { manifest: () => ({ adapterId: ADAPTER_ID, adapterVersion: '0.1.0' }) },
    temporaryRoot: backupTemporaryRoot,
    assertClusterStopped: async () => ({ stopped: true }),
    clock: () => '2026-08-05T15:00:00.000Z'
  });
  const sourceFiles = await reader.files(WORKSPACE_ID, source.id, { executionId: 'legacy-publication-run', backupMode: 'full', requestedBackupMode: 'full' });
  const summary = await engine.createSnapshot({}, {
    repositoryId: repository.id,
    masterKey,
    keyVersion: 'legacy-restore-key-v1',
    idempotencyKey: 'legacy-restore-fixture',
    files: sourceFiles.create()
  });
  const snapshot = await engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: summary.snapshotId, masterKey });
  const metadataFile = snapshot.manifest.files.find((file) => file.path === METADATA_PATH);
  assert.ok(metadataFile);
  assert.equal(await reader.release(WORKSPACE_ID, 'legacy-publication-run'), true);
  const job = await controlDatabase.repository('backupJob').create({ workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Legacy full Job', sourceId: source.id, policyId: policy.id, state: 'enabled', repositoryBindings: [{ repositoryId: repository.id, role: 'primary' }] });
  const { run } = await controlDatabase.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId: WORKSPACE_ID, actorId: 'tester', jobId: job.id, jobRevision: job.revision, trigger: 'manual', idempotencyKey: 'legacy-restore-fixture', state: 'pending' });
    return { run: transaction.create('run', { workspaceId: WORKSPACE_ID, actorId: 'tester', jobId: job.id, jobRevision: job.revision, executionGroupId: group.id, idempotencyKey: 'legacy-restore-fixture:1', trigger: 'manual', workerId: `device:${DEVICE_ID}`, state: 'queued', attempt: 1, configSnapshot: {} }) };
  });
  const recoveryPointId = 'rp_019fc700-0000-7000-8000-000000000411';
  const point = await controlDatabase.repository('recoveryPoint').create({
    id: recoveryPointId,
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    jobId: job.id,
    sourceId: source.id,
    runId: run.id,
    type: 'full',
    consistency: 'application',
    chainRootId: recoveryPointId,
    parentRecoveryPointId: null,
    capturedFrom: '2026-08-05T14:59:00.000Z',
    capturedTo: '2026-08-05T15:00:00.000Z',
    repositoryCopies: [{ repositoryId: repository.id, engineSnapshotId: summary.snapshotId, state: 'available', manifestLocator: summary.manifestKey, manifestChecksum: summary.manifestChecksum, immutableUntil: null }],
    verification: { mode: 'manifest-checksum', state: 'succeeded', verifiedAt: '2026-08-05T15:00:00.000Z', verificationRunId: null },
    retention: { deletionEligible: false }
  });
  const artifact = await controlDatabase.repository('artifact').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    recoveryPointId: point.id,
    repositoryId: repository.id,
    kind: 'metadata',
    locator: `${summary.manifestKey}#${encodeURIComponent(METADATA_PATH)}`,
    sizeBytes: metadataFile.sizeBytes,
    checksum: metadataFile.contentDigest,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'legacy-restore-key-v1' },
    compression: { mode: 'balanced' },
    metadata: sourceFiles.manifest.database
  });
  const opened = { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'legacy-restore-key-v1' };
  const restoreTemporaryRoot = path.join(root, 'restore-stages');
  const stopProofs = [];
  const stopBindingResolutions = [];
  let proofSequence = 0;
  const createService = ({ assertClusterStopped = async (request) => { stopProofs.push(request); return authenticatedStopProof(request, ++proofSequence); }, verifyClusterStopProof = async () => true, openRepository = async () => opened, temporaryRoot = restoreTemporaryRoot } = {}) => {
    const stopProofService = {
      async resolveBindings(workspaceId) {
        stopBindingResolutions.push(workspaceId);
        return [];
      },
      async assertClusterStopped(request) {
        await this.resolveBindings(request.workspaceId);
        return assertClusterStopped(request);
      },
      async verifyClusterStopProof(request) {
        return verifyClusterStopProof(request);
      }
    };
    return new InfluxDb3EnterpriseLegacyRestoreService({
      controlDatabase,
      deviceId: DEVICE_ID,
      openRepository,
      stopProofService,
      temporaryRoot,
      clock: () => '2026-08-05T15:00:00.000Z',
      randomUUID: () => '11111111-2222-4333-8444-555555555555'
    });
  };
  return { root, controlDatabase, sourceDataRoot, targetDataRoot, layout, sourceConnection, targetConnection, source, repository, repositoryAdapter, engine, masterKey, opened, summary, snapshot, metadataFile, point, artifact, restoreTemporaryRoot, stopProofs, stopBindingResolutions, createService };
}

test('previews and restores a completely authenticated Artifact to an exact empty stopped alternate target', async (context) => {
  const current = await fixture(context);
  const service = current.createService();
  const request = { recoveryPointId: current.point.id, targetConnectionId: current.targetConnection.id, target: targetInput(current.targetDataRoot) };
  const preview = await service.preview(WORKSPACE_ID, request);
  assert.equal(preview.completeMediaAuthenticated, true);
  assert.equal(preview.targetEmpty, true);
  assert.equal(preview.targetStopped, true);
  assert.equal(preview.clusterStopEvidence.checkCount, 1);
  assert.match(preview.clusterStopEvidence.finalProofDigest, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.equal(preview.separateAlternateStorage, true);
  assert.equal(preview.rollbackAvailable, false);
  assert.equal(preview.confirmationText, RESTORE_CONFIRMATION);
  assert.equal(JSON.stringify(preview).includes(current.sourceDataRoot), false);
  assert.equal(JSON.stringify(preview).includes(current.targetDataRoot), false);

  const started = await service.start(WORKSPACE_ID, 'tester', { ...request, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  assert.equal(completed.validation.completeMediaAuthenticated, true);
  assert.equal(completed.validation.clusterStopEvidence.checkCount >= 10, true);
  assert.equal(completed.validation.clusterStopEvidence.nodeCount, 3);
  assert.match(completed.validation.clusterStopEvidence.proofChainDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(completed.result.targetStopped, true);
  assert.equal(completed.result.automaticStartup, false);
  assert.equal(completed.result.originalStoreCleared, false);
  assert.equal(completed.result.rollbackClaimed, false);
  assert.equal(completed.result.stagingCleanupProven, true);
  assert.equal(await fs.readFile(path.join(current.targetDataRoot, CLUSTER_ID, '_catalog_checkpoint'), 'utf8'), 'checkpoint-protected');
  assert.equal(await fs.readFile(path.join(current.targetDataRoot, COMPACTOR_ID, 'c', 'generation', 'data.parquet'), 'utf8'), 'compaction-generation-protected');
  assert.equal(await fs.lstat(path.join(current.targetDataRoot, 'data-01', 'table-snapshots')).catch(() => null), null);
  assert.deepEqual(await fs.readdir(current.restoreTemporaryRoot), []);
  const evidence = JSON.stringify(completed);
  for (const privatePath of [current.sourceDataRoot, current.targetDataRoot, current.restoreTemporaryRoot]) assert.equal(evidence.includes(privatePath), false);
  assert.equal(evidence.includes(`${CLUSTER_ID}/_catalog_checkpoint`), false);
  assert.equal(evidence.includes('influxdb3-data.service'), false);
  assert.equal(evidence.includes('ssh-'), false);
  assert.equal(current.stopProofs.length >= 13, true);
  assert.equal(current.stopProofs.every((proof) => proof.workspaceId === WORKSPACE_ID && proof.targetConnectionId === current.targetConnection.id && proof.clusterId === CLUSTER_ID), true);
  assert.deepEqual(current.stopBindingResolutions, current.stopProofs.map(() => WORKSPACE_ID));
});

test('requires exact confirmation and refuses occupied, overlapping, wrong-topology, or running targets before mutation', async (context) => {
  const current = await fixture(context);
  const service = current.createService();
  const request = { recoveryPointId: current.point.id, targetConnectionId: current.targetConnection.id, target: targetInput(current.targetDataRoot) };
  await assert.rejects(service.start(WORKSPACE_ID, 'tester', request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CONFIRMATION_REQUIRED');
  await fs.writeFile(path.join(current.targetDataRoot, 'occupied'), 'keep');
  await assert.rejects(service.preview(WORKSPACE_ID, request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_NOT_EMPTY');
  assert.equal(await fs.readFile(path.join(current.targetDataRoot, 'occupied'), 'utf8'), 'keep');
  await fs.rm(path.join(current.targetDataRoot, 'occupied'));
  await assert.rejects(service.preview(WORKSPACE_ID, { ...request, target: targetInput(current.sourceDataRoot) }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_INVALID');
  await assert.rejects(service.preview(WORKSPACE_ID, { ...request, target: { ...targetInput(current.targetDataRoot), dataNodeIds: ['different-node'] } }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TOPOLOGY_INVALID');
  const runningService = current.createService({ assertClusterStopped: async () => ({ stopped: false }), temporaryRoot: path.join(current.root, 'running-stages') });
  await assert.rejects(runningService.preview(WORKSPACE_ID, request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_CLUSTER_RUNNING');
  assert.deepEqual(await fs.readdir(current.targetDataRoot), []);
  assert.equal(containsAbsolutePath({ repositoryPath: `${MEDIA_PREFIX}${CLUSTER_ID}/catalog/file` }), false);
  assert.equal(containsAbsolutePath({ dataRoot: current.targetDataRoot }), true);
  assert.throws(() => normalizeRestoreRequest({ ...request, confirmed: true, confirmationText: `${RESTORE_CONFIRMATION} ` }), /exact destructive-operation confirmation/);

  const malformedService = current.createService({ assertClusterStopped: async (proofRequest) => ({ ...authenticatedStopProof(proofRequest, 9), privateHost: 'must-not-be-accepted' }), temporaryRoot: path.join(current.root, 'malformed-proof-stages') });
  await assert.rejects(malformedService.preview(WORKSPACE_ID, request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID');

  const forgedProofService = current.createService({ verifyClusterStopProof: async () => false, temporaryRoot: path.join(current.root, 'forged-proof-stages') });
  await assert.rejects(forgedProofService.preview(WORKSPACE_ID, request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID');
});

test('rejects corrupted encrypted repository bytes before target mutation', async (context) => {
  const current = await fixture(context);
  const corruptedEngine = Object.create(current.engine);
  corruptedEngine.streamFile = function streamFile(contextValue, request) {
    if (String(request.path).startsWith(MEDIA_PREFIX)) return (async function* corrupted() { yield Buffer.from('corrupted-member'); })();
    return current.engine.streamFile(contextValue, request);
  };
  const service = current.createService({ openRepository: async () => ({ ...current.opened, engine: corruptedEngine }), temporaryRoot: path.join(current.root, 'corrupt-stages') });
  const request = { recoveryPointId: current.point.id, targetConnectionId: current.targetConnection.id, target: targetInput(current.targetDataRoot) };
  await assert.rejects(service.preview(WORKSPACE_ID, request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID');
  assert.deepEqual(await fs.readdir(current.targetDataRoot), []);
  assert.equal(await fs.lstat(path.join(current.root, 'corrupt-stages')).catch(() => null), null);
});

test('cancellation after filesystem mutation preserves the partial target and claims no rollback', async (context) => {
  const current = await fixture(context);
  let mutationResolve;
  const mutationObserved = new Promise((resolve) => { mutationResolve = resolve; });
  let blocked = false;
  const service = current.createService({
    temporaryRoot: path.join(current.root, 'cancel-stages'),
    assertClusterStopped: async (proofRequest) => {
      const { signal } = proofRequest;
      const mutated = (await fs.readdir(current.targetDataRoot)).length > 0;
      if (mutated && !blocked) {
        blocked = true;
        mutationResolve();
        await new Promise((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', resolve, { once: true });
        });
        const error = new Error('canceled after target mutation');
        error.code = 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CANCELED';
        error.category = 'canceled';
        throw error;
      }
      return authenticatedStopProof(proofRequest, 42);
    }
  });
  const request = { recoveryPointId: current.point.id, targetConnectionId: current.targetConnection.id, target: targetInput(current.targetDataRoot), confirmed: true, confirmationText: RESTORE_CONFIRMATION };
  const started = await service.start(WORKSPACE_ID, 'tester', request);
  await mutationObserved;
  const canceled = await service.cancel(WORKSPACE_ID, 'tester', started.id);
  assert.equal(canceled.state, 'interrupted');
  assert.equal(canceled.target.filesystemMutationStarted, true);
  assert.equal(canceled.result.targetPreserved, true);
  assert.equal(canceled.result.partialTargetPreserved, true);
  assert.equal(canceled.result.targetDeletionAttempted, false);
  assert.equal(canceled.result.rollbackClaimed, false);
  assert.equal(canceled.result.error.code, 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_REQUIRES_INSPECTION');
  assert.equal((await fs.readdir(current.targetDataRoot)).length > 0, true);
  assert.deepEqual(await fs.readdir(path.join(current.root, 'cancel-stages')), []);
  const evidence = JSON.stringify(canceled);
  assert.equal(evidence.includes(current.targetDataRoot), false);
  assert.equal(evidence.includes(current.sourceDataRoot), false);
});

test('reconciles an interrupted owned stage without touching or rolling back the target', async (context) => {
  const current = await fixture(context);
  const service = current.createService({ temporaryRoot: path.join(current.root, 'reconcile-stages') });
  const run = await current.controlDatabase.repository('restoreRun').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    recoveryPointIds: [current.point.id],
    targetConnectionId: current.targetConnection.id,
    target: {
      operation: RESTORE_OPERATION,
      mode: 'alternate',
      engine: 'influxdb3-enterprise',
      tier: SOURCE_TIER,
      sourceId: current.source.id,
      targetConnectionId: current.targetConnection.id,
      targetTopologyFingerprint: current.layout.topologyFingerprint,
      targetStorageBindingDigest: `sha256:${'e'.repeat(64)}`,
      targetPlanDigest: `sha256:${'f'.repeat(64)}`,
      restoreExecutionId: 'interrupted-execution',
      targetMutationStarted: true,
      filesystemMutationStarted: true,
      mutationStartedAt: '2026-08-05T15:00:00.000Z',
      restoreEvidence: {}
    },
    mode: 'alternate',
    conflictPolicy: 'fail',
    workerId: `device:${DEVICE_ID}`,
    state: 'running',
    progress: { phase: 'restoring', itemsTotal: 16, itemsCompleted: 1, bytesTotal: 100, bytesWritten: 10, updatedAt: '2026-08-05T15:00:00.000Z' },
    validation: null,
    result: null
  });
  const temporaryRoot = path.join(current.root, 'reconcile-stages');
  await fs.mkdir(temporaryRoot);
  const stage = path.join(temporaryRoot, `${restorePrefix(WORKSPACE_ID, run.id)}owned`);
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, '.owner.json'), JSON.stringify({ version: 1, kind: RESTORE_STAGE_KIND, state: 'restoring', workspaceId: WORKSPACE_ID, restoreRunId: run.id, recoveryPointId: current.point.id }));
  await fs.writeFile(path.join(stage, 'temporary-member'), 'owned-stage-only');
  await fs.writeFile(path.join(current.targetDataRoot, 'partial-target-state'), 'preserve-me');
  const [reconciled] = await service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.id, run.id);
  assert.equal(reconciled.state, 'interrupted');
  assert.equal(reconciled.result.targetPreserved, true);
  assert.equal(reconciled.result.partialTargetPreserved, true);
  assert.equal(reconciled.result.targetDeletionAttempted, false);
  assert.equal(reconciled.result.rollbackClaimed, false);
  assert.equal(reconciled.result.stagingCleanupProven, true);
  assert.equal(reconciled.result.removedOwnedStagingDirectories, 1);
  assert.equal(await fs.readFile(path.join(current.targetDataRoot, 'partial-target-state'), 'utf8'), 'preserve-me');
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
  assert.equal(JSON.stringify(reconciled).includes(current.targetDataRoot), false);
});
