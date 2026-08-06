const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID } = require('./influxdb');
const { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, InfluxDbRecoveryTestService } = require('./influxdb-verification');

const WORKSPACE_ID = 'workspace-influxdb-verification';
const DEVICE_ID = 'device-influxdb-verification';
const DEPLOYMENT = `sha256:${'1'.repeat(64)}`;
const INVENTORY = `sha256:${'2'.repeat(64)}`;
const MEDIA = `sha256:${'3'.repeat(64)}`;
const ORG_ID = '0123456789abcdef';
const BUCKET_ID = 'fedcba9876543210';

function fixture(options = {}) {
  let sequence = 0;
  const endpoint = { expectedVersion: '2.7.11', expectedCliVersion: '2.7.5', expectedDeploymentFingerprint: DEPLOYMENT };
  const records = {
    connection: new Map([['connection-source', { id: 'connection-source', adapterId: ADAPTER_ID, endpoint, secretRefIds: [], trust: { fingerprint: DEPLOYMENT }, workerAffinity: [`device:${DEVICE_ID}`], lastTest: { status: 'success', endpointIdentity: { version: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: DEPLOYMENT, inventoryFingerprint: INVENTORY } } }]]),
    verificationRun: new Map()
  };
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
  const bucket = { id: BUCKET_ID, organizationId: ORG_ID, name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: 86400, shardGroupDurationSeconds: 3600 }], selectable: true };
  const metadata = {
    kind: 'influxdb-oss-v2-native-backup', adapterId: ADAPTER_ID, tokenRecovery: 'hash-only-plaintext-unrecoverable',
    source: { product: 'influxdb-oss-v2', productVersion: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: DEPLOYMENT, inventoryFingerprint: INVENTORY },
    scope: { type: 'bucket', organizationId: ORG_ID, organizationName: 'Production', bucketId: BUCKET_ID, bucketName: 'metrics', buckets: [{ id: BUCKET_ID, name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: bucket.retentionRules }] },
    nativeMedia: { fileCount: 2, totalBytes: 4096, mediaFingerprint: MEDIA }
  };
  const selected = { point: { id: 'point-full', sourceId: 'source-influxdb' }, source: { id: 'source-influxdb', connectionId: 'connection-source' }, repositoryId: 'repository-a', metadata, members: [{}, {}], totalBytes: 4096 };
  const restoreCalls = []; let mediaVerificationCount = 0;
  const restoreService = {
    authenticateRecoveryPoint: async () => selected,
    verifyRecoveryPointMedia: async () => { mediaVerificationCount += 1; return { fileCount: 2, totalBytes: 4096, mediaFingerprint: MEDIA }; },
    start: async (_workspaceId, _actorId, input) => { restoreCalls.push(input); return { id: 'restore-influxdb', state: 'queued' }; },
    wait: async () => ({ id: 'restore-influxdb', state: 'succeeded', validation: { nativeIntegrityValidation: true }, result: { organization: { id: ORG_ID, name: 'Production' }, buckets: [{ id: BUCKET_ID, name: 'metrics' }] } }),
    cancel: async () => ({ state: 'canceled' })
  };
  const currentDeployment = options.changedIdentity ? `sha256:${'9'.repeat(64)}` : DEPLOYMENT;
  const adapter = {
    testConnection: async () => ({ status: 'success', endpointIdentity: { version: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: currentDeployment, inventoryFingerprint: INVENTORY } }),
    discover: async function* () { yield { version: { text: '2.7.11' }, cliVersion: { text: '2.7.5' }, deploymentFingerprint: currentDeployment, inventoryFingerprint: INVENTORY, tokenRecovery: 'hash-only-plaintext-unrecoverable', organizations: [{ id: ORG_ID, name: 'Production', status: 'active' }], buckets: [bucket] }; }
  };
  const connectionService = { withExecution: async (_workspaceId, _connection, signal, callback) => callback({ signal }, endpoint) };
  const notifications = [];
  const service = new InfluxDbRecoveryTestService({ controlDatabase, adapter, connectionService, restoreService, deviceId: DEVICE_ID, notificationService: { notifyVerificationRun: async (_workspaceId, run) => notifications.push(run.state) }, clock: () => '2026-08-05T16:00:00.000Z' });
  return { service, records, restoreCalls, notifications, get mediaVerificationCount() { return mediaVerificationCount; } };
}

test('authenticates every native member and current InfluxDB scope without restoring data', async () => {
  const data = fixture();
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-full', mode: METADATA_MODE });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.evidence.completeMediaAuthenticated, true);
  assert.equal(completed.evidence.retentionRulesVerified, true);
  assert.equal(completed.evidence.nativeFileCount, 2);
  assert.equal(completed.evidence.tokenRecovery, 'hash-only-plaintext-unrecoverable');
  assert.equal(data.mediaVerificationCount, 1);
  assert.equal(data.restoreCalls.length, 0);
  assert.deepEqual(data.notifications, ['succeeded']);
});

test('fails metadata verification when the protected InfluxDB identity changes', async () => {
  const data = fixture({ changedIdentity: true });
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-full', mode: METADATA_MODE });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'INFLUXDB_VERIFICATION_SOURCE_CHANGED');
  assert.equal(data.restoreCalls.length, 0);
});

test('runs a confirmed full InfluxDB alternate-instance drill', async () => {
  const data = fixture();
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-full', mode: DRILL_MODE, targetConnectionId: 'connection-target', confirmed: true, confirmationText: DRILL_CONFIRMATION });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.restoreRunId, 'restore-influxdb');
  assert.equal(completed.evidence.nativeIntegrityValidation, true);
  assert.equal(completed.evidence.targetPreserved, true);
  assert.equal(completed.evidence.cleanupPerformed, false);
  assert.equal(data.restoreCalls[0].confirmationText, 'RESTORE INFLUXDB ALTERNATE');
});

test('requires full-drill confirmation and reconciles orphaned drills without rollback claims', async () => {
  const data = fixture();
  await assert.rejects(data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-full', mode: DRILL_MODE, targetConnectionId: 'connection-target' }), (error) => error.code === 'INFLUXDB_DRILL_CONFIRMATION_REQUIRED');
  data.records.verificationRun.set('verification-orphan', { id: 'verification-orphan', revision: 1, state: 'running', mode: DRILL_MODE, progress: { phase: 'restoring-alternate-instance' } });
  const [reconciled] = await data.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.state, 'interrupted');
  assert.equal(reconciled.progress.phase, 'operator-action-required');
  assert.equal(reconciled.result.rollbackPerformed, false);
  assert.match(reconciled.result.error.safeMessage, /No rollback or cleanup is claimed/i);
});
