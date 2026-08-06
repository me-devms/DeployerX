const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID } = require('./cockroachdb');
const { RESTORE_CONFIRMATION } = require('./cockroachdb-restore');
const {
  DRILL_CONFIRMATION,
  DRILL_MODE,
  METADATA_MODE,
  CockroachDbRecoveryTestService
} = require('./cockroachdb-verification');

const WORKSPACE_ID = 'workspace-cockroach-verification';
const DEVICE_ID = 'device-cockroach-verification';
const CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT = `sha256:${'1'.repeat(64)}`;
const TOPOLOGY = `sha256:${'2'.repeat(64)}`;
const INVENTORY = `sha256:${'3'.repeat(64)}`;
const DESTINATION = `sha256:${'4'.repeat(64)}`;
const LOCALITY = `sha256:${'5'.repeat(64)}`;
const CLOCK = '2026-08-05T15:00:00.000Z';

function fixture(options = {}) {
  let sequence = 0;
  let releaseRestoreStart = () => {};
  let signalRestoreStart;
  const restoreStartEntered = new Promise((resolve) => { signalRestoreStart = resolve; });
  const connection = {
    id: 'connection-source',
    adapterId: ADAPTER_ID,
    workerAffinity: [`device:${DEVICE_ID}`],
    lastTest: { status: 'success' },
    endpoint: { host: 'private-source.internal', username: 'private-user' },
    secretRefIds: ['secret-private-password'],
    cockroachdbBackupDestinationTrust: {
      clusterId: CLUSTER_ID,
      deploymentFingerprint: DEPLOYMENT,
      topologyFingerprint: TOPOLOGY,
      inventoryFingerprint: INVENTORY,
      destinationFingerprint: DESTINATION,
      localityFingerprint: LOCALITY,
      bindingCount: 1,
      destination: { externalConnectionName: 'private_archive' }
    }
  };
  const records = {
    connection: new Map([[connection.id, connection]]),
    verificationRun: new Map()
  };
  const repository = (name) => ({
    get: async (_workspaceId, id) => records[name]?.get(id) || null,
    list: async () => [...(records[name]?.values() || [])],
    create: async (input) => {
      const record = { ...input, id: `verification-${++sequence}`, revision: 1 };
      records[name].set(record.id, record);
      return record;
    }
  });
  const controlDatabase = {
    repository,
    transaction: async (callback) => callback({
      get: (name, _workspaceId, id) => records[name].get(id) || null,
      projectExecution: (name, _workspaceId, id, changes, projection) => {
        const current = records[name].get(id);
        assert.equal(current.revision, projection.expectedRevision);
        const updated = { ...current, ...changes, revision: current.revision + 1 };
        records[name].set(id, updated);
        return updated;
      }
    })
  };
  const metadata = {
    kind: 'cockroachdb-native-backup',
    adapterId: ADAPTER_ID,
    productVersion: '25.2.3',
    clusterVersion: '25.2',
    backupMode: 'incremental',
    asOfTimestamp: '2026-08-05T14:50:00.000Z',
    revisionHistory: true,
    binding: {
      clusterId: CLUSTER_ID,
      deploymentFingerprint: DEPLOYMENT,
      topologyFingerprint: TOPOLOGY,
      inventoryFingerprint: INVENTORY
    },
    destination: { destinationFingerprint: DESTINATION, localityFingerprint: LOCALITY, bindingCount: 1 },
    selection: { scope: 'database', database: 'app', tables: [] }
  };
  const selected = {
    point: { id: 'point-incremental', sourceId: 'source-cockroach' },
    source: { id: 'source-cockroach', connectionId: connection.id },
    repositoryId: 'repository-a',
    metadata,
    entries: [{ point: { id: 'point-full' } }, { point: { id: 'point-incremental' } }]
  };
  const identity = options.changedIdentity ? `sha256:${'9'.repeat(64)}` : DEPLOYMENT;
  const adapter = {
    testConnection: async () => ({
      status: 'success',
      endpointIdentity: {
        clusterId: CLUSTER_ID,
        deploymentFingerprint: identity,
        topologyFingerprint: TOPOLOGY,
        inventoryFingerprint: INVENTORY
      }
    }),
    discover: async function* () {
      yield {
        clusterId: CLUSTER_ID,
        deploymentFingerprint: identity,
        topologyFingerprint: TOPOLOGY,
        inventoryFingerprint: INVENTORY,
        version: { text: '25.2.3' },
        clusterVersion: { text: '25.2' },
        databases: [{ name: 'app', owner: 'app_owner' }],
        externalConnections: [{ name: 'private_archive', owner: 'private_owner' }],
        capabilities: { jobsVisible: true, externalConnectionsVisible: true, systemPrivileges: { VIEWJOB: true, CONTROLJOB: true } }
      };
    }
  };
  const connectionService = { withExecution: async (_workspaceId, _connection, signal, callback) => callback({ signal }, {}) };
  const restoreCalls = [];
  const cancelCalls = [];
  const restoreService = {
    authenticateRecoveryPoint: async () => selected,
    start: async (_workspaceId, _actorId, input) => {
      restoreCalls.push(input);
      signalRestoreStart();
      if (options.pauseRestoreStart) await new Promise((resolve) => { releaseRestoreStart = resolve; });
      return { id: 'restore-cockroach', state: 'queued' };
    },
    wait: async () => ({
      id: 'restore-cockroach',
      state: 'succeeded',
      validation: { nativeIntegrityValidation: true },
      result: {
        targetDatabase: 'app_drill',
        restoreTimestamp: '2026-08-05T14:45:00.000Z',
        chainRecoveryPointIds: ['point-full', 'point-incremental'],
        job: { status: 'succeeded' }
      }
    }),
    cancel: async (_workspaceId, _actorId, restoreRunId) => {
      cancelCalls.push(restoreRunId);
      return { state: 'canceled' };
    }
  };
  const notifications = [];
  const service = new CockroachDbRecoveryTestService({
    controlDatabase,
    adapter,
    connectionService,
    restoreService,
    deviceId: DEVICE_ID,
    notificationService: { notifyVerificationRun: async (_workspaceId, run) => notifications.push(run.state) },
    clock: () => CLOCK
  });
  return { service, records, restoreCalls, cancelCalls, notifications, restoreStartEntered, releaseRestoreStart: () => releaseRestoreStart() };
}

test('authenticates the complete CockroachDB chain and current protected cluster without restoring data', async () => {
  const current = fixture();
  const started = await current.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-incremental', mode: METADATA_MODE });
  assert.deepEqual(started.recoveryPointIds, ['point-full', 'point-incremental']);
  const completed = await current.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.evidence.completeChainAuthenticated, true);
  assert.equal(completed.evidence.sourceIdentityVerified, true);
  assert.equal(completed.evidence.inventoryVerified, true);
  assert.equal(completed.evidence.selectedDatabaseVisible, true);
  assert.equal(completed.evidence.fullRestorePerformed, false);
  assert.equal(current.restoreCalls.length, 0);
  assert.deepEqual(current.notifications, ['succeeded']);
  const projection = JSON.stringify(completed.evidence);
  for (const privateValue of ['private-source.internal', 'private-user', 'secret-private-password', 'private_archive', 'private_owner']) assert.equal(projection.includes(privateValue), false);
});

test('fails metadata verification when the protected CockroachDB deployment identity changes', async () => {
  const current = fixture({ changedIdentity: true });
  const started = await current.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-incremental', mode: METADATA_MODE });
  const completed = await current.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'COCKROACH_VERIFICATION_SOURCE_CHANGED');
  assert.equal(current.restoreCalls.length, 0);
});

test('runs a confirmed CockroachDB PITR drill through the exact alternate-target restore service', async () => {
  const current = fixture();
  const started = await current.service.start(WORKSPACE_ID, 'actor-a', {
    recoveryPointId: 'point-incremental',
    mode: DRILL_MODE,
    targetConnectionId: 'connection-target',
    targetDatabase: 'app_drill',
    restoreTimestamp: '2026-08-05T14:45:00.000Z',
    confirmed: true,
    confirmationText: DRILL_CONFIRMATION
  });
  const completed = await current.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.restoreRunId, 'restore-cockroach');
  assert.equal(completed.evidence.nativeIntegrityValidation, true);
  assert.equal(completed.evidence.targetPreserved, true);
  assert.equal(completed.evidence.rollbackPerformed, false);
  assert.equal(current.restoreCalls[0].restoreTimestamp, '2026-08-05T14:45:00.000Z');
  assert.equal(current.restoreCalls[0].confirmationText, RESTORE_CONFIRMATION);
});

test('cancels a native restore created after cancellation was requested', async () => {
  const current = fixture({ pauseRestoreStart: true });
  const started = await current.service.start(WORKSPACE_ID, 'actor-a', {
    recoveryPointId: 'point-incremental',
    mode: DRILL_MODE,
    targetConnectionId: 'connection-target',
    targetDatabase: 'app_drill',
    confirmed: true,
    confirmationText: DRILL_CONFIRMATION
  });
  await current.restoreStartEntered;
  const cancellation = current.service.cancel(WORKSPACE_ID, 'actor-a', started.id);
  current.releaseRestoreStart();
  const canceled = await cancellation;
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.targetPreserved, true);
  assert.deepEqual(current.cancelCalls, ['restore-cockroach']);
});

test('requires full-drill confirmation and reconciles orphaned drills without rollback claims', async () => {
  const current = fixture();
  await assert.rejects(current.service.start(WORKSPACE_ID, 'actor-a', {
    recoveryPointId: 'point-incremental', mode: DRILL_MODE, targetConnectionId: 'connection-target', targetDatabase: 'app_drill'
  }), (error) => error.code === 'COCKROACH_DRILL_CONFIRMATION_REQUIRED');
  current.records.verificationRun.set('verification-orphan', { id: 'verification-orphan', revision: 1, state: 'running', mode: DRILL_MODE, progress: { phase: 'restoring-alternate-database' } });
  const [reconciled] = await current.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.state, 'interrupted');
  assert.equal(reconciled.progress.phase, 'operator-action-required');
  assert.equal(reconciled.result.rollbackPerformed, false);
  assert.match(reconciled.result.error.safeMessage, /No rollback is claimed/i);
});
