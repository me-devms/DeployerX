const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { RESTORE_CONFIRMATION } = require('./influxdb3-enterprise-legacy');
const { ARTIFACT_KIND, SOURCE_TIER } = require('./influxdb3-enterprise-legacy-source-reader');
const {
  DRILL_CONFIRMATION,
  DRILL_MODE,
  METADATA_MODE,
  InfluxDb3EnterpriseLegacyRecoveryTestService,
  exactOwner,
  normalizeClusterStopEvidence,
  normalizeIsolationEvidence,
  targetDigest
} = require('./influxdb3-enterprise-legacy-verification');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'legacy-verification-device';
const POINT_ID = 'rp-legacy-full';
const REPOSITORY_ID = 'repository-legacy';
const TARGET_CONNECTION_ID = 'target-connection';
const TARGET = { kind: 'local-filesystem', dataRoot: 'C:\\private\\legacy-drill-target', clusterId: 'cluster-001', compactorNodeId: 'compactor-01', dataNodeIds: ['data-02', 'data-01'] };

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function clusterStopEvidence(sequence, checkCount = 1) {
  const timestamp = '2026-08-05T16:00:00.000Z';
  return {
    version: 1,
    checkCount,
    firstIssuedAt: timestamp,
    lastIssuedAt: timestamp,
    finalProofDigest: `hmac-sha256:${sequence.toString(16).padStart(64, '0')}`,
    nodeCount: 3,
    nodeSetDigest: stableDigest(['compactor-01', 'data-01', 'data-02']),
    proofChainDigest: `sha256:${(sequence + 100).toString(16).padStart(64, '0')}`
  };
}

function selected() {
  const metadata = {
    kind: ARTIFACT_KIND,
    tier: SOURCE_TIER,
    artifact: { restoreSupported: true },
    capture: { completeMediaAuthenticated: true },
    publication: { localPathsPublished: false }
  };
  return {
    point: { id: POINT_ID, consistency: 'application' },
    repositoryId: REPOSITORY_ID,
    metadata,
    artifact: { metadata: structuredClone(metadata) },
    media: {
      clusterId: 'cluster-001',
      topologyFingerprint: `sha256:${'1'.repeat(64)}`,
      fileCount: 16,
      directoryCount: 24,
      totalBytes: 4096,
      mediaFingerprint: `sha256:${'2'.repeat(64)}`,
      directoryFingerprint: `sha256:${'3'.repeat(64)}`
    }
  };
}

function controlFixture() {
  let sequence = 0;
  const data = { verificationRun: [], restoreRun: [] };
  return {
    data,
    repository(type) {
      return {
        create: async (input) => {
          const record = { ...structuredClone(input), id: `${type}-${++sequence}`, revision: 1 };
          data[type].push(record);
          return structuredClone(record);
        },
        get: async (_workspaceId, id) => structuredClone(data[type].find((record) => record.id === id) || null),
        list: async (_workspaceId, options = {}) => structuredClone(data[type].slice(0, options.limit || data[type].length))
      };
    },
    async transaction(operation) {
      return operation({
        get: (type, _workspaceId, id) => structuredClone(data[type].find((record) => record.id === id) || null),
        projectExecution: (type, _workspaceId, id, changes) => {
          const index = data[type].findIndex((record) => record.id === id);
          data[type][index] = { ...data[type][index], ...structuredClone(changes), revision: data[type][index].revision + 1 };
          return structuredClone(data[type][index]);
        }
      });
    }
  };
}

function restoreFixture(controlDatabase, options = {}) {
  const calls = { authenticate: 0, preview: [], assertStopped: [], start: [], wait: [], cancel: [], reconcile: 0 };
  let restoreStartedResolve;
  const restoreStarted = new Promise((resolve) => { restoreStartedResolve = resolve; });
  let waitResolve;
  const blockedWait = new Promise((resolve) => { waitResolve = resolve; });
  let startResolve;
  const blockedStart = new Promise((resolve) => { startResolve = resolve; });
  return {
    calls,
    restoreStarted,
    releaseStart: () => startResolve?.(),
    async authenticateRecoveryPoint(_workspaceId, recoveryPointId, signal) {
      calls.authenticate += 1;
      assert.equal(recoveryPointId, POINT_ID);
      if (signal?.aborted) throw signal.reason;
      return selected();
    },
    async preview(_workspaceId, input) {
      calls.preview.push(structuredClone({ ...input, signal: undefined }));
      return { completeMediaAuthenticated: true, targetEmpty: true, targetStopped: true, clusterStopEvidence: clusterStopEvidence(1), separateAlternateStorage: true, originalStorageProtected: true };
    },
    async assertTargetStopped(_workspaceId, input) {
      calls.assertStopped.push(structuredClone({ ...input, signal: undefined, target: undefined }));
      if (options.failStopAt === calls.assertStopped.length) throw Object.assign(new Error('The dynamic stop binding no longer proves every target node is stopped.'), { code: 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_INVALID', category: 'integrity', retryable: true });
      return clusterStopEvidence(10 + calls.assertStopped.length);
    },
    async start(_workspaceId, _actorId, input) {
      calls.start.push(structuredClone({ ...input, signal: undefined }));
      assert.equal(input.confirmationText, RESTORE_CONFIRMATION);
      assert.equal(input.confirmed, true);
      const record = {
        id: `restore-${calls.start.length}`,
        state: 'running',
        target: { targetMutationStarted: options.mutated === true, filesystemMutationStarted: options.mutated === true },
        result: null
      };
      controlDatabase.data.restoreRun.push(record);
      restoreStartedResolve(record);
      if (options.blockStart) await blockedStart;
      return structuredClone(record);
    },
    async wait(_workspaceId, id) {
      calls.wait.push(id);
      if (options.blockWait) return blockedWait;
      const record = controlDatabase.data.restoreRun.find((candidate) => candidate.id === id);
      Object.assign(record, {
        state: 'succeeded',
        target: { ...record.target, targetMutationStarted: true, filesystemMutationStarted: true },
        validation: { completeMediaAuthenticated: true, clusterStopped: true, clusterStopEvidence: clusterStopEvidence(20, 12) },
        result: { targetStopped: true, targetPreserved: true, rollbackClaimed: false, automaticStartup: false }
      });
      return structuredClone(record);
    },
    async cancel(_workspaceId, _actorId, id) {
      calls.cancel.push(id);
      const record = controlDatabase.data.restoreRun.find((candidate) => candidate.id === id);
      Object.assign(record, { state: record.target.filesystemMutationStarted ? 'interrupted' : 'canceled', result: { targetPreserved: record.target.filesystemMutationStarted, rollbackClaimed: false } });
      waitResolve?.(structuredClone(record));
      return structuredClone(record);
    },
    async reconcile() {
      calls.reconcile += 1;
      return [];
    }
  };
}

function serviceFixture(options = {}) {
  const controlDatabase = controlFixture();
  const restoreService = restoreFixture(controlDatabase, options);
  const isolationCalls = [];
  const assertTargetIsolated = async (request) => {
    isolationCalls.push(structuredClone({ ...request, signal: undefined, target: undefined }));
    return {
      owner: request.owner,
      targetId: 'isolated-target-001',
      controllerId: 'legacy-isolation-controller',
      bindingFingerprint: `sha256:${'4'.repeat(64)}`,
      targetDigest: request.targetDigest,
      isolated: true,
      serviceExposed: false
    };
  };
  const service = new InfluxDb3EnterpriseLegacyRecoveryTestService({ controlDatabase, restoreService, assertTargetIsolated, deviceId: DEVICE_ID, clock: () => '2026-08-05T16:00:00.000Z' });
  return { controlDatabase, restoreService, isolationCalls, service };
}

test('authenticates repository metadata and complete media without performing a restore', async () => {
  const current = serviceFixture();
  const started = await current.service.start(WORKSPACE_ID, 'tester', { recoveryPointId: POINT_ID, mode: METADATA_MODE });
  const completed = await current.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.evidence.repositoryManifestAuthenticated, true);
  assert.equal(completed.evidence.metadataArtifactAuthenticated, true);
  assert.equal(completed.evidence.completeMediaAuthenticated, true);
  assert.equal(completed.evidence.fullRestorePerformed, false);
  assert.equal(completed.evidence.nativeFileCount, 16);
  assert.equal(completed.result.targetPreserved, false);
  assert.equal(current.restoreService.calls.authenticate, 2);
  assert.equal(current.restoreService.calls.start.length, 0);
  assert.equal(JSON.stringify(completed).includes('C:\\private'), false);
});

test('runs a full isolated alternate-storage drill and preserves bounded target evidence', async () => {
  const current = serviceFixture();
  const started = await current.service.start(WORKSPACE_ID, 'tester', { recoveryPointId: POINT_ID, mode: DRILL_MODE, targetConnectionId: TARGET_CONNECTION_ID, target: TARGET, confirmed: true, confirmationText: DRILL_CONFIRMATION });
  const completed = await current.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.evidence.fullRestorePerformed, true);
  assert.equal(completed.evidence.installedMediaAuthenticated, true);
  assert.equal(completed.evidence.isolated, true);
  assert.equal(completed.evidence.serviceExposed, false);
  assert.equal(completed.evidence.targetPreserved, true);
  assert.equal(completed.evidence.clusterStopEvidence.checkCount, 16);
  assert.equal(completed.evidence.clusterStopEvidence.nodeCount, 3);
  assert.match(completed.evidence.clusterStopEvidence.finalProofDigest, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.equal(completed.evidence.targetCleanupAttempted, false);
  assert.equal(completed.evidence.rollbackPerformed, false);
  assert.equal(completed.result.targetPreserved, true);
  assert.equal(current.isolationCalls.length, 2);
  assert.deepEqual(current.isolationCalls.map((call) => call.phase), ['before-restore', 'after-restore']);
  assert.equal(current.restoreService.calls.preview.length, 1);
  assert.equal(current.restoreService.calls.assertStopped.length, 3);
  assert.equal(current.restoreService.calls.start.length, 1);
  assert.equal(current.restoreService.calls.start[0].target.dataRoot, TARGET.dataRoot);
  const evidence = JSON.stringify(completed);
  assert.equal(evidence.includes(TARGET.dataRoot), false);
  assert.equal(evidence.includes('catalog/'), false);
  assert.equal(evidence.includes('.service'), false);
  assert.equal(evidence.includes('ssh'), false);
  assert.match(completed.targetDigest, /^sha256:[0-9a-f]{64}$/);
});

test('fails before mutation or preserves an interrupted target when a fresh dynamic stop proof is lost', async (context) => {
  await context.test('before mutation', async () => {
    const current = serviceFixture({ failStopAt: 1 });
    const started = await current.service.start(WORKSPACE_ID, 'tester', { recoveryPointId: POINT_ID, mode: DRILL_MODE, targetConnectionId: TARGET_CONNECTION_ID, target: TARGET, confirmed: true, confirmationText: DRILL_CONFIRMATION });
    const completed = await current.service.wait(WORKSPACE_ID, started.id);
    assert.equal(completed.state, 'failed');
    assert.equal(completed.result.targetPreserved, false);
    assert.equal(current.restoreService.calls.start.length, 0);
  });
  await context.test('after mutation', async () => {
    const current = serviceFixture({ failStopAt: 2 });
    const started = await current.service.start(WORKSPACE_ID, 'tester', { recoveryPointId: POINT_ID, mode: DRILL_MODE, targetConnectionId: TARGET_CONNECTION_ID, target: TARGET, confirmed: true, confirmationText: DRILL_CONFIRMATION });
    const completed = await current.service.wait(WORKSPACE_ID, started.id);
    assert.equal(completed.state, 'interrupted');
    assert.equal(completed.result.targetPreserved, true);
    assert.equal(completed.result.targetCleanupAttempted, false);
    assert.equal(completed.result.rollbackPerformed, false);
    assert.equal(completed.result.error.code, 'INFLUXDB3_ENTERPRISE_LEGACY_DRILL_TARGET_REQUIRES_INSPECTION');
    assert.equal(current.restoreService.calls.assertStopped.length, 2);
  });
});

test('requires exact drill confirmation and exact isolation identity', async () => {
  const current = serviceFixture();
  await assert.rejects(current.service.start(WORKSPACE_ID, 'tester', { recoveryPointId: POINT_ID, mode: DRILL_MODE, targetConnectionId: TARGET_CONNECTION_ID, target: TARGET, confirmed: true, confirmationText: `${DRILL_CONFIRMATION} ` }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_DRILL_CONFIRMATION_REQUIRED');
  const owner = exactOwner(WORKSPACE_ID, 'verification-1');
  const digest = targetDigest(TARGET);
  assert.throws(() => normalizeIsolationEvidence({ owner: 'other', targetId: 'target', controllerId: 'controller', bindingFingerprint: `sha256:${'4'.repeat(64)}`, targetDigest: digest, isolated: true, serviceExposed: false }, owner, digest), /isolation could not be proven/);
  assert.throws(() => normalizeIsolationEvidence({ owner, targetId: 'target', controllerId: 'controller', bindingFingerprint: `sha256:${'4'.repeat(64)}`, targetDigest: digest, isolated: true, serviceExposed: true }, owner, digest), /isolation could not be proven/);
  assert.throws(() => normalizeClusterStopEvidence({ ...clusterStopEvidence(1), privateHost: 'must-not-be-published' }, TARGET), /bounded cluster stop-proof evidence is invalid/);
});

test('cancellation after restore mutation interrupts the drill and preserves the target', async () => {
  const current = serviceFixture({ blockWait: true, mutated: true });
  const started = await current.service.start(WORKSPACE_ID, 'tester', { recoveryPointId: POINT_ID, mode: DRILL_MODE, targetConnectionId: TARGET_CONNECTION_ID, target: TARGET, confirmed: true, confirmationText: DRILL_CONFIRMATION });
  await current.restoreService.restoreStarted;
  const canceled = await current.service.cancel(WORKSPACE_ID, 'tester', started.id);
  assert.equal(canceled.state, 'interrupted');
  assert.equal(canceled.result.targetPreserved, true);
  assert.equal(canceled.result.targetCleanupAttempted, false);
  assert.equal(canceled.result.rollbackPerformed, false);
  assert.equal(canceled.result.error.code, 'INFLUXDB3_ENTERPRISE_LEGACY_DRILL_TARGET_REQUIRES_INSPECTION');
  assert.deepEqual(current.restoreService.calls.cancel, ['restore-1']);
  assert.equal(JSON.stringify(canceled).includes(TARGET.dataRoot), false);
});

test('cancels a restore that is created while full-drill cancellation is pending', async () => {
  const current = serviceFixture({ blockStart: true });
  const started = await current.service.start(WORKSPACE_ID, 'tester', { recoveryPointId: POINT_ID, mode: DRILL_MODE, targetConnectionId: TARGET_CONNECTION_ID, target: TARGET, confirmed: true, confirmationText: DRILL_CONFIRMATION });
  await current.restoreService.restoreStarted;
  const cancellation = current.service.cancel(WORKSPACE_ID, 'tester', started.id);
  current.restoreService.releaseStart();
  const canceled = await cancellation;
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.targetPreserved, false);
  assert.deepEqual(current.restoreService.calls.cancel, ['restore-1']);
});

test('reconciles an interrupted drill without cleanup or rollback claims', async () => {
  const current = serviceFixture();
  current.controlDatabase.data.restoreRun.push({ id: 'restore-interrupted', state: 'interrupted', target: { targetMutationStarted: true, filesystemMutationStarted: true }, result: { targetPreserved: true } });
  current.controlDatabase.data.verificationRun.push({
    id: 'verification-interrupted', revision: 1, mode: DRILL_MODE, state: 'running', recoveryPointId: POINT_ID, recoveryPointIds: [POINT_ID], repositoryId: REPOSITORY_ID,
    restoreRunId: 'restore-interrupted', progress: { phase: 'restoring' }
  });
  const [reconciled] = await current.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.state, 'interrupted');
  assert.equal(reconciled.result.targetPreserved, true);
  assert.equal(reconciled.result.targetCleanupAttempted, false);
  assert.equal(reconciled.result.rollbackPerformed, false);
  assert.equal(reconciled.result.isolationRecheckPossible, false);
  assert.equal(current.restoreService.calls.reconcile, 1);
});
