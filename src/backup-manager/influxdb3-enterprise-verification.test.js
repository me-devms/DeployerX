const assert = require('node:assert/strict');
const test = require('node:test');
const {
  METADATA_MODE,
  UNSUPPORTED_LIVE_DRILL_MODE,
  InfluxDb3EnterpriseRecoveryTestService,
  authenticatedChain
} = require('./influxdb3-enterprise-verification');
const { METADATA_PATH, SOURCE_LEASE_KIND } = require('./influxdb3-enterprise-source-reader');

const WORKSPACE_ID = 'workspace-1';
const DEVICE_ID = 'verification-device';
const PRIVATE_TOKEN = 'secret-token-very-private';
const PRIVATE_BACKUP = 'native-backup-private-name';
const PRIVATE_ENDPOINT = 'https://private.influx.example:8181';
const IDENTITY = {
  productVersion: '3.11.0',
  storageEngine: 'upgraded',
  clusterId: 'private-cluster',
  nodeId: 'private-compactor',
  nodeCatalogId: 3,
  instanceId: 'private-instance',
  roleFingerprint: 'sha256:role-private',
  deploymentFingerprint: 'sha256:deployment-private',
  capabilityFingerprint: 'sha256:capability-private',
  connectionRevision: 1,
  compactorCapable: true,
  nativeBackupAvailable: true
};

function metadata(overrides = {}) {
  return {
    kind: SOURCE_LEASE_KIND,
    engine: 'influxdb3-enterprise',
    backupMethod: 'physical',
    backupMode: 'full',
    sourceId: 'source-private-id',
    publication: { artifactKind: 'metadata', path: METADATA_PATH },
    externalNativeMedia: { managedByServer: true, authoritativeOwner: 'influxdb3-enterprise', includedInRepository: false, deletionIssued: false },
    source: { productVersion: IDENTITY.productVersion, storageEngine: IDENTITY.storageEngine, clusterId: IDENTITY.clusterId, nodeId: IDENTITY.nodeId, nodeCatalogId: IDENTITY.nodeCatalogId, instanceId: IDENTITY.instanceId, roleFingerprint: IDENTITY.roleFingerprint, deploymentFingerprint: IDENTITY.deploymentFingerprint, capabilityFingerprint: IDENTITY.capabilityFingerprint, compactorCapable: true },
    operation: { backupName: PRIVATE_BACKUP, backupType: 'full', status: 'completed', watermark: 'wal-private-42' },
    ...overrides
  };
}

function authenticated(overrides = {}) {
  const value = metadata(overrides.metadata);
  return {
    point: { id: 'recovery-point-private-id', revision: 1, sourceId: 'source-private-id' },
    source: { id: 'source-private-id', revision: 1, connectionId: 'connection-private-id' },
    execution: { ...IDENTITY },
    repositoryId: 's3://private-provider-locator',
    metadata: value,
    metadataDigest: 'sha256:metadata-private',
    ...overrides
  };
}

function preview(overrides = {}) {
  return {
    mode: 'in-place',
    engine: 'influxdb3-enterprise',
    tier: 'upgraded-native',
    destructive: true,
    liveCluster: true,
    backupName: PRIVATE_BACKUP,
    backupType: 'full',
    backupWatermark: 'wal-private-42',
    productVersion: IDENTITY.productVersion,
    clusterId: IDENTITY.clusterId,
    storageEngine: 'upgraded',
    identity: { ...IDENTITY },
    rowDeleteStateCapturedByBackup: false,
    rowDeletesMayPersist: true,
    endpoint: PRIVATE_ENDPOINT,
    token: PRIVATE_TOKEN,
    secretRef: 'SecretRef/private-admin-token',
    ...overrides
  };
}

function controlFixture() {
  let sequence = 0;
  const data = {
    verificationRun: [],
    recoveryPoint: [{ id: 'recovery-point-private-id', revision: 1, sourceId: 'source-private-id' }],
    source: [{ id: 'source-private-id', revision: 1, connectionId: 'connection-private-id' }],
    connection: [{ id: 'connection-private-id', revision: 1 }]
  };
  return {
    data,
    repository(type) {
      return {
        create: async (input) => {
          const record = { ...structuredClone(input), id: `verification-${++sequence}`, revision: 1 };
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
        create: (type, input) => {
          const record = { ...structuredClone(input), id: `verification-${++sequence}`, revision: 1 };
          data[type].push(record);
          return structuredClone(record);
        },
        projectExecution: (type, _workspaceId, id, changes) => {
          const index = data[type].findIndex((record) => record.id === id);
          data[type][index] = { ...data[type][index], ...structuredClone(changes), revision: data[type][index].revision + 1 };
          return structuredClone(data[type][index]);
        }
      });
    }
  };
}

function serviceFixture(options = {}) {
  const controlDatabase = controlFixture();
  const calls = { authenticate: 0, preview: 0, notifications: [] };
  const restoreService = {
    authenticateRecoveryPoint: async () => {
      calls.authenticate += 1;
      if (options.authenticateError) throw options.authenticateError;
      if (options.onAuthenticate) return options.onAuthenticate(calls.authenticate);
      return authenticated(options.authenticated);
    },
    preview: async (...args) => {
      calls.preview += 1;
      if (options.onPreview) return options.onPreview(...args);
      return preview(options.preview);
    }
  };
  const service = new InfluxDb3EnterpriseRecoveryTestService({
    controlDatabase,
    restoreService,
    deviceId: DEVICE_ID,
    notificationService: { notifyVerificationRun: async (_workspaceId, run) => calls.notifications.push(run) },
    clock: () => '2026-08-05T18:00:00.000Z'
  });
  return { service, controlDatabase, calls };
}

test('authenticates retained native metadata, fresh protected identity, watermark, and bounded limitation evidence without exposing private data', async () => {
  const value = serviceFixture();
  const started = await value.service.start(WORKSPACE_ID, 'actor-private', { recoveryPointId: 'recovery-point-private-id' });
  const completed = await value.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.mode, METADATA_MODE);
  assert.equal(completed.evidence.retainedNativeChainAuthenticated, true);
  assert.equal(completed.evidence.nativeChainLength, 1);
  assert.equal(completed.evidence.ownedNativeBackupCompleted, true);
  assert.equal(completed.evidence.ownedNativeBackupWatermarkAuthenticated, true);
  assert.equal(completed.evidence.sourceIdentityFreshlyRevalidated, true);
  assert.equal(completed.evidence.compactorIdentityVerified, true);
  assert.equal(completed.evidence.rowDeleteStateCapturedByBackup, false);
  assert.equal(completed.evidence.rowDeletesMayPersist, true);
  assert.equal(completed.evidence.fullRestorePerformed, false);
  assert.equal(completed.evidence.destructiveLiveDrillAvailable, false);
  assert.equal(completed.result.productionClusterModified, false);
  assert.equal(value.calls.authenticate, 3);
  assert.equal(value.calls.preview, 1);
  assert.equal(value.calls.notifications.length, 1);
  const serialized = JSON.stringify({ started, completed, notification: value.calls.notifications[0] });
  for (const forbidden of [PRIVATE_TOKEN, PRIVATE_BACKUP, PRIVATE_ENDPOINT, 'SecretRef', 'private-provider-locator', 'actor-private', 'recovery-point-private-id', 'source-private-id', IDENTITY.clusterId]) assert.equal(serialized.includes(forbidden), false);
});

test('rejects an unadvertised BM-411 destructive live drill before native restore interaction', async () => {
  const value = serviceFixture();
  await assert.rejects(value.service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'recovery-point-private-id', mode: UNSUPPORTED_LIVE_DRILL_MODE, confirmed: true }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LIVE_DRILL_UNSAFE_BM411');
  assert.equal(value.calls.authenticate, 0);
  assert.equal(value.calls.preview, 0);
});

test('atomically rejects verification admission after retention claims the RecoveryPoint', async () => {
  const value = serviceFixture();
  value.controlDatabase.data.recoveryPoint[0].retention = {
    nativeMediaDeletionClaim: { version: 1, claimId: `influxdb3_enterprise_retention_${'b'.repeat(64)}`, state: 'claimed' }
  };
  await assert.rejects(
    value.service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'recovery-point-private-id' }),
    (error) => error.code === 'INFLUXDB3_ENTERPRISE_NATIVE_MEDIA_DELETION_ACTIVE'
  );
  assert.equal(value.controlDatabase.data.verificationRun.length, 0);
  assert.equal(value.calls.preview, 0);
});

test('cancellation wins before terminal publication and reconciliation preserves the non-mutating boundary', async () => {
  let previewStarted;
  let releasePreview;
  const previewGate = new Promise((resolve) => { releasePreview = resolve; });
  const value = serviceFixture({
    onPreview: async () => {
      previewStarted();
      await previewGate;
      return preview();
    }
  });
  const startedGate = new Promise((resolve) => { previewStarted = resolve; });
  const started = await value.service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'recovery-point-private-id' });
  await startedGate;
  const cancel = value.service.cancel(WORKSPACE_ID, 'actor', started.id);
  releasePreview();
  const canceled = await cancel;
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.productionClusterModified, false);
  assert.equal(canceled.result.fullRestorePerformed, false);

  const raw = await value.controlDatabase.repository('verificationRun').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'private-owner',
    mode: METADATA_MODE,
    workerId: `device:${DEVICE_ID}`,
    privateVerificationBinding: { metadataDigest: 'sha256:private', chainDigest: 'sha256:chain', sourceId: 'source-private-id' },
    state: 'running',
    progress: { phase: 'authenticating-retained-native-chain', updatedAt: '2026-08-05T17:00:00.000Z' },
    result: null
  });
  const reconciled = await value.service.reconcile(WORKSPACE_ID);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, raw.id);
  assert.equal(reconciled[0].state, 'interrupted');
  assert.equal(reconciled[0].result.productionClusterModified, false);
  assert.equal(JSON.stringify(reconciled[0]).includes('private-owner'), false);
});

test('validates an exact full-to-incremental leaf chain without returning native backup names', () => {
  const chain = authenticatedChain({ nativeChain: [
    { name: 'private-full', type: 'full', parentName: null, status: 'completed', watermark: 4 },
    { name: 'private-incremental', type: 'incremental', parentName: 'private-full', status: 'completed', watermark: 9 }
  ] }, { backupName: 'private-incremental', backupType: 'incremental', watermark: 9 });
  assert.equal(chain.length, 2);
  assert.throws(() => authenticatedChain({ nativeChain: [{ name: 'private-incremental', type: 'incremental', parentName: 'missing', status: 'completed', watermark: 9 }] }, { backupName: 'private-incremental', backupType: 'incremental', watermark: 9 }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_VERIFICATION_CHAIN_INVALID');
});

test('fails closed when the authenticated artifact binding changes after admission', async () => {
  const changed = authenticated({
    metadata: metadata({ operation: { backupName: PRIVATE_BACKUP, backupType: 'full', status: 'completed', watermark: 'wal-private-changed' } }),
    metadataDigest: 'sha256:metadata-changed'
  });
  const value = serviceFixture({ onAuthenticate: (call) => call === 1 ? authenticated() : changed });
  const started = await value.service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'recovery-point-private-id' });
  const completed = await value.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.productionClusterModified, false);
  assert.equal(value.calls.preview, 0);
  assert.equal(JSON.stringify(completed).includes('wal-private-changed'), false);
});

test('scopes listed verification history to the requested RecoveryPoint before public projection', async () => {
  const value = serviceFixture();
  const repository = value.controlDatabase.repository('verificationRun');
  const first = await repository.create({
    workspaceId: WORKSPACE_ID,
    mode: METADATA_MODE,
    workerId: `device:${DEVICE_ID}`,
    recoveryPointId: 'recovery-point-a',
    privateVerificationBinding: { recoveryPointId: 'recovery-point-a' },
    state: 'succeeded'
  });
  const second = await repository.create({
    workspaceId: WORKSPACE_ID,
    mode: METADATA_MODE,
    workerId: `device:${DEVICE_ID}`,
    recoveryPointId: 'recovery-point-b',
    privateVerificationBinding: { recoveryPointId: 'recovery-point-b' },
    state: 'running'
  });
  const scoped = await value.service.list(WORKSPACE_ID, { recoveryPointId: 'recovery-point-b', limit: 1 });
  assert.deepEqual(scoped.map((run) => run.id), [second.id]);
  assert.equal(scoped.some((run) => run.id === first.id), false);
  assert.equal(JSON.stringify(scoped).includes('recovery-point-b'), false);
});

test('rejects success when RecoveryPoint, Source, or connection revision changes at commit time', async () => {
  for (const type of ['recoveryPoint', 'source', 'connection']) {
    let value;
    value = serviceFixture({
      onPreview: async () => {
        value.controlDatabase.data[type][0].revision += 1;
        return preview();
      }
    });
    const started = await value.service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'recovery-point-private-id' });
    const completed = await value.service.wait(WORKSPACE_ID, started.id);
    assert.equal(completed.state, 'failed', type);
    assert.equal(completed.result.error.code, 'INFLUXDB3_ENTERPRISE_VERIFICATION_BINDING_CHANGED', type);
    assert.equal(completed.result.productionClusterModified, false, type);
  }
});
