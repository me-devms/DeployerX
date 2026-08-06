const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID } = require('./clickhouse');
const { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, ClickHouseRecoveryTestService } = require('./clickhouse-verification');

const WORKSPACE_ID = 'workspace-clickhouse-verification';
const DEVICE_ID = 'device-clickhouse-verification';
const DEPLOYMENT = `sha256:${'1'.repeat(64)}`;
const TOPOLOGY = `sha256:${'2'.repeat(64)}`;
const DESTINATION = `sha256:${'3'.repeat(64)}`;

function fixture(options = {}) {
  let sequence = 0;
  const records = {
    connection: new Map([['connection-source', {
      id: 'connection-source', adapterId: ADAPTER_ID, endpoint: {}, secretRefIds: [], trust: { fingerprint: DEPLOYMENT, topologyFingerprint: TOPOLOGY }, workerAffinity: [`device:${DEVICE_ID}`], lastTest: { status: 'success' },
      clickhouseDestinationTrust: { diskName: 'backups', destinationFingerprint: DESTINATION, deploymentFingerprint: DEPLOYMENT, topologyFingerprint: TOPOLOGY }
    }]]),
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
  const metadata = {
    kind: 'clickhouse-native-backup', adapterId: ADAPTER_ID, productVersion: '25.8.3.66', deploymentFingerprint: DEPLOYMENT, topologyFingerprint: TOPOLOGY, backupMode: 'incremental',
    destination: { diskName: 'backups', destinationFingerprint: DESTINATION }, operation: { id: `deployerx-${'4'.repeat(32)}` },
    selection: { database: { name: 'analytics', uuid: '11111111-1111-4111-8111-111111111111', engine: 'Atomic' }, tables: [{ database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'MergeTree' }], statistics: [{ database: 'analytics', table: 'events', rowCount: 1000, partCount: 3, partitionCount: 1 }] }
  };
  const selected = { point: { id: 'point-incremental', sourceId: 'source-clickhouse' }, source: { id: 'source-clickhouse', connectionId: 'connection-source' }, repositoryId: 'repository-a', metadata, totalBytes: 200, entries: [{ point: { id: 'point-full' } }, { point: { id: 'point-incremental' } }] };
  const restoreCalls = [];
  const restoreService = {
    authenticateRecoveryPoint: async () => selected,
    start: async (_workspaceId, _actorId, input) => { restoreCalls.push(input); return { id: 'restore-clickhouse', state: 'queued' }; },
    wait: async () => ({ id: 'restore-clickhouse', state: 'succeeded', validation: { nativeIntegrityValidation: true }, result: { targetDatabase: 'drill_analytics', tableMappings: [{ targetTable: 'events' }], nativeOperation: { id: `deployerx-restore-${'5'.repeat(32)}` }, chainRecoveryPointIds: ['point-full', 'point-incremental'] } }),
    cancel: async () => ({ state: 'canceled' })
  };
  const identity = options.changedIdentity ? `sha256:${'9'.repeat(64)}` : DEPLOYMENT;
  const adapter = {
    testConnection: async () => ({ status: 'success', endpointIdentity: { deploymentFingerprint: identity, topologyFingerprint: TOPOLOGY } }),
    discover: async function* () { yield { deploymentFingerprint: identity, topologyFingerprint: TOPOLOGY, version: { text: '25.8.3.66' }, databases: [{ name: 'analytics', uuid: '11111111-1111-4111-8111-111111111111', engine: 'Atomic' }], tables: [{ database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'MergeTree' }] }; }
  };
  const connectionService = { withExecution: async (_workspaceId, _connection, signal, callback) => callback({ signal }, {}) };
  const notifications = [];
  const service = new ClickHouseRecoveryTestService({ controlDatabase, adapter, connectionService, restoreService, deviceId: DEVICE_ID, notificationService: { notifyVerificationRun: async (_workspaceId, run) => notifications.push(run.state) }, clock: () => '2026-08-05T15:00:00.000Z' });
  return { service, records, restoreCalls, notifications };
}

test('authenticates the complete ClickHouse chain and current source without restoring data', async () => {
  const data = fixture();
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-incremental', mode: METADATA_MODE });
  assert.deepEqual(started.recoveryPointIds, ['point-full', 'point-incremental']);
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.evidence.completeChainAuthenticated, true);
  assert.equal(completed.evidence.selectionIdentityVerified, true);
  assert.equal(completed.evidence.rowCount, 1000);
  assert.equal(completed.evidence.fullRestorePerformed, false);
  assert.equal(data.restoreCalls.length, 0);
  assert.deepEqual(data.notifications, ['succeeded']);
});

test('fails metadata verification when the protected ClickHouse identity changes', async () => {
  const data = fixture({ changedIdentity: true });
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-incremental', mode: METADATA_MODE });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'CLICKHOUSE_VERIFICATION_SOURCE_CHANGED');
  assert.equal(data.restoreCalls.length, 0);
});

test('runs a confirmed full ClickHouse drill through alternate-target restore', async () => {
  const data = fixture();
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-incremental', mode: DRILL_MODE, targetConnectionId: 'connection-target', targetDatabase: 'drill_analytics', confirmed: true, confirmationText: DRILL_CONFIRMATION });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.restoreRunId, 'restore-clickhouse');
  assert.equal(completed.evidence.nativeIntegrityValidation, true);
  assert.equal(completed.evidence.targetPreserved, true);
  assert.equal(completed.evidence.cleanupPerformed, false);
  assert.equal(data.restoreCalls[0].confirmationText, 'RESTORE CLICKHOUSE ALTERNATE');
});

test('requires full-drill confirmation and reconciles orphaned drills without rollback claims', async () => {
  const data = fixture();
  await assert.rejects(data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-incremental', mode: DRILL_MODE, targetConnectionId: 'connection-target', targetDatabase: 'drill_analytics' }), (error) => error.code === 'CLICKHOUSE_DRILL_CONFIRMATION_REQUIRED');
  data.records.verificationRun.set('verification-orphan', { id: 'verification-orphan', revision: 1, state: 'running', mode: DRILL_MODE, progress: { phase: 'restoring-alternate-database' } });
  const [reconciled] = await data.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.state, 'interrupted');
  assert.equal(reconciled.progress.phase, 'operator-action-required');
  assert.equal(reconciled.result.rollbackPerformed, false);
  assert.match(reconciled.result.error.safeMessage, /No rollback is claimed/i);
});
