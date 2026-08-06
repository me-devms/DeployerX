const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ADAPTER_ID, RESTORE_CONFIRMATION } = require('./influxdb3-core');
const { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, InfluxDb3CoreRecoveryTestService } = require('./influxdb3-core-verification');
const { publicRecoveryPoint } = require('./snapshot-browser');

const WORKSPACE_ID = 'workspace-influxdb3-core-verification';
const DEVICE_ID = 'device-influxdb3-core-verification';
const DEPLOYMENT = `sha256:${'1'.repeat(64)}`;
const STORAGE = `sha256:${'2'.repeat(64)}`;
const MEDIA = `sha256:${'3'.repeat(64)}`;
const DIRECTORIES = `sha256:${'4'.repeat(64)}`;
const NODE_ID = 'node-a';

function fixture(options = {}) {
  let sequence = 0;
  const objectStore = options.objectStore || 'file';
  const kind = { file: 'influxdb3-core-filesystem-full', s3: 'influxdb3-core-s3-full', azure: 'influxdb3-core-azure-full', google: 'influxdb3-core-gcs-full' }[objectStore];
  const restoreSupported = options.restoreSupported !== false;
  const endpoint = { objectStore, nodeId: NODE_ID, expectedVersion: '3.6.2', expectedDeploymentFingerprint: DEPLOYMENT, expectedStorageFingerprint: STORAGE };
  const execution = { engine: 'influxdb3-core', objectStore, nodeId: NODE_ID, consistencyMode: 'stopped', consistencyMethod: 'influxdb3-core-stopped', operatorAttestation: 'stopped', deploymentFingerprint: DEPLOYMENT, storageFingerprint: STORAGE, connectionRevision: 2 };
  const source = { id: 'source-core', connectionId: 'connection-source', physicalExecution: execution };
  const connection = {
    id: 'connection-source', adapterId: ADAPTER_ID, endpoint, workerAffinity: [`device:${DEVICE_ID}`],
    trust: { fingerprint: DEPLOYMENT, storageFingerprint: STORAGE, objectStore },
    lastTest: { status: 'success', endpointIdentity: { version: '3.6.2', nodeId: NODE_ID, objectStore, deploymentFingerprint: DEPLOYMENT, storageFingerprint: STORAGE, restoreSupported: true } }
  };
  const records = { connection: new Map([[connection.id, connection]]), restoreRun: new Map(), verificationRun: new Map() };
  const repository = (name) => ({
    get: async (_workspaceId, id) => records[name]?.get(id) || null,
    list: async () => [...(records[name]?.values() || [])],
    create: async (input) => { const record = { ...input, id: `verification-${++sequence}`, revision: 1 }; records[name].set(record.id, record); return record; }
  });
  const controlDatabase = {
    repository,
    transaction: async (callback) => callback({
      get: (name, _workspaceId, id) => records[name].get(id) || null,
      projectExecution: (name, _workspaceId, id, changes) => { const current = records[name].get(id); const updated = { ...current, ...changes, revision: current.revision + 1 }; records[name].set(id, updated); return updated; }
    })
  };
  const metadata = {
    kind, adapterId: ADAPTER_ID, backupMethod: 'physical', backupMode: 'full',
    source: { product: 'influxdb3-core', productVersion: '3.6.2', nodeId: NODE_ID, objectStore, deploymentFingerprint: DEPLOYMENT, storageFingerprint: STORAGE },
    capture: { consistencyMode: 'stopped', achievedConsistency: 'application', copyOrder: ['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint'], excluded: ['table-snapshots/'] },
    nativeMedia: { fileCount: 5, directoryCount: 9, totalBytes: 8192, mediaFingerprint: MEDIA, directoryFingerprint: DIRECTORIES, members: [{ path: 'private-member-path' }], directories: ['private-directory'] },
    artifact: { restoreSupported }
  };
  const selected = { point: { id: 'point-core', sourceId: source.id, consistency: 'application' }, source, repositoryId: 'repository-a', artifact: { metadata: structuredClone(metadata) }, metadata };
  let mediaVerificationCount = 0;
  const restoreCalls = [];
  const restoreService = {
    authenticateRecoveryPoint: async () => selected,
    verifyRecoveryPointMedia: async () => { mediaVerificationCount += 1; return { fileCount: 5, directoryCount: 9, totalBytes: 8192, mediaFingerprint: MEDIA, directoryFingerprint: DIRECTORIES }; },
    start: async (_workspaceId, _actorId, input) => { restoreCalls.push(input); return { id: 'restore-core', state: 'queued' }; },
    wait: async () => ({ id: 'restore-core', state: 'succeeded', validation: { nativeIntegrityValidation: true }, result: { nodeId: NODE_ID, objectStore, targetStopped: true, ownershipReviewRequired: objectStore === 'file', operatorReviewRequired: true } }),
    cancel: async () => ({ state: 'canceled' })
  };
  const preflight = {
    serverVersion: '3.6.2', serverIdentityFingerprint: DEPLOYMENT,
    consistency: [{ method: 'influxdb3-core-stopped', verified: true, produces: 'application' }],
    metadata: { product: 'influxdb3-core', objectStore, nodeId: NODE_ID, consistencyMode: 'stopped', storageFingerprint: options.changedStorage ? `sha256:${'9'.repeat(64)}` : STORAGE }
  };
  const adapter = { preflight: async () => preflight };
  const connectionService = { withExecution: async (_workspaceId, _connection, signal, callback) => callback({ signal }, endpoint) };
  const notifications = [];
  const service = new InfluxDb3CoreRecoveryTestService({ controlDatabase, adapter, connectionService, restoreService, deviceId: DEVICE_ID, notificationService: { notifyVerificationRun: async (_workspaceId, run) => notifications.push(run.state) }, clock: () => '2026-08-05T18:00:00.000Z' });
  return { service, records, metadata, restoreCalls, notifications, get mediaVerificationCount() { return mediaVerificationCount; } };
}

test('authenticates complete Core media and revalidates the protected stopped Source without restoring', async () => {
  const data = fixture();
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-core', mode: METADATA_MODE });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.evidence.completeMediaAuthenticated, true);
  assert.equal(completed.evidence.storageIdentityVerified, true);
  assert.equal(completed.evidence.endpointProof, 'stopped-unreachable');
  assert.equal(completed.evidence.nativeFileCount, 5);
  assert.equal(completed.evidence.nativeDirectoryCount, 9);
  assert.equal(data.mediaVerificationCount, 1);
  assert.equal(data.restoreCalls.length, 0);
  assert.deepEqual(data.notifications, ['succeeded']);
});

test('fails Core metadata validation when the protected storage identity changes', async () => {
  const data = fixture({ changedStorage: true });
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-core', mode: METADATA_MODE });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'INFLUXDB3_CORE_VERIFICATION_SOURCE_CHANGED');
  assert.equal(data.restoreCalls.length, 0);
});

test('refuses metadata validation and full drills when authenticated Artifact restore support is false', async () => {
  const metadata = fixture({ objectStore: 'azure', restoreSupported: false });
  await assert.rejects(metadata.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-core', mode: METADATA_MODE }), (error) => error.code === 'INFLUXDB3_CORE_VERIFICATION_RESTORE_UNSUPPORTED');
  assert.equal(metadata.mediaVerificationCount, 0);
  assert.equal(metadata.records.verificationRun.size, 0);

  const drill = fixture({ objectStore: 'google', restoreSupported: false });
  await assert.rejects(drill.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-core', mode: DRILL_MODE, targetConnectionId: 'connection-target', confirmed: true, confirmationText: DRILL_CONFIRMATION }), (error) => error.code === 'INFLUXDB3_CORE_VERIFICATION_RESTORE_UNSUPPORTED');
  assert.equal(drill.restoreCalls.length, 0);
  assert.equal(drill.records.verificationRun.size, 0);
});

test('runs a confirmed full Core stopped-target drill and preserves the installed node', async () => {
  const data = fixture();
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-core', mode: DRILL_MODE, targetConnectionId: 'connection-target', confirmed: true, confirmationText: DRILL_CONFIRMATION });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.restoreRunId, 'restore-core');
  assert.equal(completed.evidence.nativeIntegrityValidation, true);
  assert.equal(completed.evidence.targetPreserved, true);
  assert.equal(completed.evidence.targetStopped, true);
  assert.equal(completed.evidence.ownershipReviewRequired, true);
  assert.equal(completed.evidence.automaticStartup, false);
  assert.equal(completed.evidence.rollbackPerformed, false);
  assert.equal(data.restoreCalls[0].confirmationText, RESTORE_CONFIRMATION);
});

test('runs bounded Azure and GCS metadata validation and full drills for restore-approved Artifacts', async () => {
  for (const objectStore of ['azure', 'google']) {
    const metadata = fixture({ objectStore });
    const metadataStarted = await metadata.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-core', mode: METADATA_MODE });
    const metadataCompleted = await metadata.service.wait(WORKSPACE_ID, metadataStarted.id);
    assert.equal(metadataCompleted.state, 'succeeded');
    assert.equal(metadataCompleted.evidence.objectStore, objectStore);
    assert.equal(metadataCompleted.evidence.fullRestorePerformed, false);
    assert.equal(metadata.restoreCalls.length, 0);

    const drill = fixture({ objectStore });
    const drillStarted = await drill.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-core', mode: DRILL_MODE, targetConnectionId: 'connection-target', confirmed: true, confirmationText: DRILL_CONFIRMATION });
    const drillCompleted = await drill.service.wait(WORKSPACE_ID, drillStarted.id);
    assert.equal(drillCompleted.state, 'succeeded');
    assert.equal(drillCompleted.evidence.objectStore, objectStore);
    assert.equal(drillCompleted.evidence.fullRestorePerformed, true);
    assert.equal(drillCompleted.evidence.ownershipReviewRequired, false);
    assert.equal(drill.restoreCalls.length, 1);
    const projected = JSON.stringify({ metadataCompleted, drillCompleted });
    for (const privateValue of ['private-member-path', 'private-directory', 'SecretRef', 'credential', 'locator']) assert.equal(projected.includes(privateValue), false);
  }
});

test('requires drill confirmation and reconciles orphaned Core drills without rollback claims', async () => {
  const data = fixture();
  await assert.rejects(data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-core', mode: DRILL_MODE, targetConnectionId: 'connection-target' }), (error) => error.code === 'INFLUXDB3_CORE_DRILL_CONFIRMATION_REQUIRED');
  data.records.restoreRun.set('restore-orphan', { id: 'restore-orphan', target: { filesystemMutationStarted: true }, result: { targetPreserved: true } });
  data.records.verificationRun.set('verification-orphan', { id: 'verification-orphan', revision: 1, state: 'running', mode: DRILL_MODE, restoreRunId: 'restore-orphan', progress: { phase: 'restoring-stopped-alternate-target' } });
  const [reconciled] = await data.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.state, 'interrupted');
  assert.equal(reconciled.progress.phase, 'operator-action-required');
  assert.equal(reconciled.result.targetPreserved, true);
  assert.equal(reconciled.result.rollbackPerformed, false);
  assert.match(reconciled.result.error.safeMessage, /No rollback or target cleanup is claimed/i);
  data.records.verificationRun.set('verification-before-restore', { id: 'verification-before-restore', revision: 1, state: 'queued', mode: DRILL_MODE, progress: { phase: 'queued' } });
  const [beforeRestore] = await data.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(beforeRestore.id, 'verification-before-restore');
  assert.equal(beforeRestore.result.targetPreserved, false);
  assert.equal(beforeRestore.progress.phase, 'interrupted');
});

test('projects bounded Core RecoveryPoint evidence without paths or native member inventories', () => {
  const data = fixture();
  const point = { id: 'point-core', jobId: 'job-core', sourceId: 'source-core', runId: 'run-core', type: 'full', consistency: 'application', chainRootId: 'point-core', capturedFrom: '2026-08-05T17:00:00.000Z', capturedTo: '2026-08-05T17:05:00.000Z', repositoryCopies: [], verification: { state: 'succeeded' }, retention: {} };
  const artifact = { kind: 'metadata', metadata: data.metadata };
  const projected = publicRecoveryPoint(point, { sources: new Map([['source-core', { id: 'source-core', name: 'Core node', sourceType: 'database', adapterId: ADAPTER_ID }]]), jobs: new Map([['job-core', { name: 'Core full' }]]), points: new Map([['point-core', point]]), artifacts: new Map([['point-core', [artifact]]]), repositories: new Map() });
  assert.equal(projected.backupMethod, 'physical');
  assert.equal(projected.influxdb3Core.nodeId, NODE_ID);
  assert.equal(projected.influxdb3Core.fileCount, 5);
  assert.equal(projected.influxdb3Core.ownershipReviewRequired, true);
  const serialized = JSON.stringify(projected.influxdb3Core);
  assert.equal(serialized.includes('private-member-path'), false);
  assert.equal(serialized.includes('private-directory'), false);
  assert.equal(serialized.includes('dataRoot'), false);
});

test('registers audited Core recovery-test APIs and startup reconciliation', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const operation of ['list', 'start', 'wait', 'cancel']) {
    assert.match(main, new RegExp(`backup:influxdb3-core-verifications:${operation}`));
    assert.match(preload, new RegExp(`backup:influxdb3-core-verifications:${operation}`));
  }
  assert.match(main, /verification\.start-influxdb3-core/);
  assert.match(main, /verification\.cancel-influxdb3-core/);
  assert.match(main, /backupInfluxDb3CoreRecoveryTestService\.reconcile/);
  assert.match(main, /INFLUXDB3_CORE_DRILL_CONFIRMATION/);
});
