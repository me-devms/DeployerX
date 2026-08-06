const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID } = require('./influxdb3-enterprise');
const {
  InfluxDb3EnterpriseSourceReaderRouter,
  LEGACY_TIER,
  NATIVE_TIER,
  influxDb3EnterpriseSourceReadiness
} = require('./influxdb3-enterprise-source-router');

function fixture(tier = NATIVE_TIER) {
  const calls = [];
  const source = { id: 'source-1', sourceType: 'database', adapterId: ADAPTER_ID, enabled: true, physicalExecution: { tier } };
  const reader = (name) => ({
    async plan(workspaceId, sourceId) { calls.push([name, 'plan', workspaceId, sourceId]); return { name }; },
    async files(workspaceId, sourceId, options) { calls.push([name, 'files', workspaceId, sourceId, options.executionId]); return { name }; },
    async release(workspaceId, executionId) { calls.push([name, 'release', workspaceId, executionId]); },
    async reconcileRun(workspaceId) { calls.push([name, 'reconcile', workspaceId]); return { applicable: true, proven: true, name }; }
  });
  const controlDatabase = { repository: () => ({ get: async () => source }) };
  const router = new InfluxDb3EnterpriseSourceReaderRouter({ controlDatabase, nativeReader: reader('native'), legacyReader: reader('legacy') });
  return { calls, router, source };
}

test('routes planning, file publication, and release to the enrolled Enterprise tier', async () => {
  const { calls, router, source } = fixture(NATIVE_TIER);
  assert.deepEqual(await router.plan('workspace-1', source.id), { name: 'native' });
  assert.deepEqual(await router.files('workspace-1', source.id, { executionId: 'run-1' }), { name: 'native' });
  source.physicalExecution.tier = LEGACY_TIER;
  await router.release('workspace-1', 'run-1');
  assert.deepEqual(calls, [
    ['native', 'plan', 'workspace-1', 'source-1'],
    ['native', 'files', 'workspace-1', 'source-1', 'run-1'],
    ['native', 'release', 'workspace-1', 'run-1']
  ]);
});

test('broadcasts release when an execution predates the in-memory tier index', async () => {
  const { calls, router } = fixture();
  await router.release('workspace-1', 'run-recovered');
  assert.deepEqual(calls, [
    ['native', 'release', 'workspace-1', 'run-recovered'],
    ['legacy', 'release', 'workspace-1', 'run-recovered']
  ]);
});

test('reconciliation delegates by the durable run tier and fails closed for unknown tiers', async () => {
  const { calls, router } = fixture();
  const nativeRun = { sourceLease: { state: 'active' }, configSnapshot: { source: { adapterId: ADAPTER_ID, physicalExecution: { tier: NATIVE_TIER } } } };
  assert.deepEqual(await router.reconcileRun('workspace-1', nativeRun), { applicable: true, proven: true, name: 'native' });
  const unknownRun = { sourceLease: { state: 'active' }, configSnapshot: { source: { adapterId: ADAPTER_ID, physicalExecution: { tier: 'unknown' } } } };
  assert.deepEqual(await router.reconcileRun('workspace-1', unknownRun), { applicable: true, proven: false, sourceLease: { state: 'active' } });
  assert.deepEqual(calls, [['native', 'reconcile', 'workspace-1']]);
});

test('refuses a Source without an explicit supported Enterprise execution tier', async () => {
  const { router, source } = fixture();
  source.physicalExecution = {};
  await assert.rejects(() => router.plan('workspace-1', source.id), /execution tier is unsupported/);
});

test('readiness accepts only the exact tested upgraded-engine identity and native policy', () => {
  const fingerprint = `sha256:${'1'.repeat(64)}`;
  const capabilityFingerprint = `sha256:${'2'.repeat(64)}`;
  const roleFingerprint = `sha256:${'3'.repeat(64)}`;
  const source = {
    id: 'source-native', sourceType: 'database', adapterId: ADAPTER_ID, enabled: true,
    selector: { kind: 'database-objects', allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false },
    consistency: { backupMethod: 'physical', backupMode: 'full', method: 'influxdb3-enterprise-native-backup', requestedLevel: 'application', captureCoordinates: true, allowDowngrade: false },
    physicalExecution: {
      version: 1, engine: 'influxdb3-enterprise', tier: NATIVE_TIER, productVersion: '3.5.0', clusterId: 'cluster-a', storageEngine: 'upgraded', nodeId: 'node-a', nodeCatalogId: 7,
      instanceId: 'instance-a', roleFingerprint, deploymentFingerprint: fingerprint, capabilityFingerprint, compactorCapable: true, nativeBackupAvailable: true, connectionRevision: 4,
      workspaceId: null, sourceId: null, executionId: null
    }
  };
  const endpointIdentity = {
    version: '3.5.0', clusterId: 'cluster-a', storageEngine: 'upgraded', nodeId: 'node-a', nodeCatalogId: 7, instanceId: 'instance-a', roleFingerprint,
    deploymentFingerprint: fingerprint, capabilityFingerprint, compactorCapable: true, nativeBackupAvailable: true
  };
  const connection = {
    adapterId: ADAPTER_ID, revision: 4, workerAffinity: ['device:device-a'], lastTest: { status: 'success', endpointIdentity },
    endpoint: { expectedDeploymentFingerprint: fingerprint, expectedCapabilityFingerprint: capabilityFingerprint },
    trust: { fingerprint, capabilityFingerprint }
  };
  assert.deepEqual(influxDb3EnterpriseSourceReadiness(source, connection, 'device-a'), { ready: true, reasonCode: null, message: 'Ready' });
  connection.lastTest.endpointIdentity.nativeBackupAvailable = false;
  assert.equal(influxDb3EnterpriseSourceReadiness(source, connection, 'device-a').ready, false);
});
