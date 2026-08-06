const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID } = require('./neo4j');
const { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, Neo4jRecoveryTestService } = require('./neo4j-verification');

const WORKSPACE_ID = 'workspace-neo4j-verification';
const DEVICE_ID = 'device-neo4j-verification';
const DEPLOYMENT = `sha256:${'1'.repeat(64)}`;
const TOPOLOGY = `sha256:${'2'.repeat(64)}`;

function fixture(options = {}) {
  let sequence = 0;
  const records = {
    connection: new Map([['connection-source', {
      id: 'connection-source', adapterId: ADAPTER_ID, endpoint: {}, secretRefIds: [],
      trust: { fingerprint: DEPLOYMENT }, workerAffinity: [`device:${DEVICE_ID}`], lastTest: { status: 'success' }
    }]]),
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
      projectExecution: (name, _workspaceId, id, changes) => {
        const current = records[name].get(id);
        const updated = { ...current, ...changes, revision: current.revision + 1 };
        records[name].set(id, updated);
        return updated;
      }
    })
  };
  const metadata = {
    kind: 'neo4j-enterprise-backup', adapterId: ADAPTER_ID, edition: 'enterprise', productVersion: '5.26.2',
    source: { deploymentFingerprint: DEPLOYMENT, topologyFingerprint: TOPOLOGY },
    database: { name: 'neo4j', databaseId: 'db-neo4j' }, backupMode: 'differential',
    artifact: { storeFormat: 'aligned' }
  };
  const selected = {
    point: { id: 'point-diff', sourceId: 'source-neo4j' },
    source: { id: 'source-neo4j', connectionId: 'connection-source' },
    repositoryId: 'repository-a', metadata, totalBytes: 4096,
    entries: [{ point: { id: 'point-full' } }, { point: { id: 'point-diff' } }]
  };
  const restoreCalls = [];
  const restoreService = {
    authenticateRecoveryPoint: async () => selected,
    start: async (_workspaceId, _actorId, input) => { restoreCalls.push(input); return { id: 'restore-neo4j', state: 'queued' }; },
    wait: async () => ({ id: 'restore-neo4j', state: 'succeeded', validation: { nativeIntegrityValidation: true }, result: { serviceStarted: false, targetDatabase: 'drill_neo4j', storeFormat: 'aligned', consistencyCheckDigest: `sha256:${'3'.repeat(64)}`, artifactCount: 2, bytesRestored: 4096, chainRecoveryPointIds: ['point-full', 'point-diff'] } }),
    cancel: async () => ({ state: 'canceled' })
  };
  const identity = options.changedIdentity ? `sha256:${'9'.repeat(64)}` : DEPLOYMENT;
  const adapter = {
    testConnection: async () => ({ status: 'success', endpointIdentity: { deploymentFingerprint: identity, topologyFingerprint: TOPOLOGY } }),
    discover: async function* () { yield { deploymentFingerprint: identity, topologyFingerprint: TOPOLOGY, edition: 'enterprise', version: { text: '5.26.2' }, databases: [{ name: 'neo4j', databaseId: 'db-neo4j' }], servers: [{ id: 'server-a' }] }; }
  };
  const connectionService = { withExecution: async (_workspaceId, _connection, signal, callback) => callback({ signal }, {}) };
  const notifications = [];
  const service = new Neo4jRecoveryTestService({ controlDatabase, adapter, connectionService, restoreService, deviceId: DEVICE_ID, notificationService: { notifyVerificationRun: async (_workspaceId, run) => notifications.push(run.state) }, clock: () => '2026-08-05T15:00:00.000Z' });
  return { service, records, restoreCalls, notifications };
}

test('authenticates the complete Neo4j chain and current source without mutating a DBMS', async () => {
  const data = fixture();
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-diff', mode: METADATA_MODE });
  assert.deepEqual(started.recoveryPointIds, ['point-full', 'point-diff']);
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.evidence.completeChainAuthenticated, true);
  assert.equal(completed.evidence.sourceIdentityVerified, true);
  assert.equal(completed.evidence.fullRestorePerformed, false);
  assert.deepEqual(completed.evidence.chainRecoveryPointIds, ['point-full', 'point-diff']);
  assert.equal(data.restoreCalls.length, 0);
  assert.deepEqual(data.notifications, ['succeeded']);
});

test('fails metadata verification when the current source deployment identity changed', async () => {
  const data = fixture({ changedIdentity: true });
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-diff', mode: METADATA_MODE });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'NEO4J_VERIFICATION_SOURCE_CHANGED');
  assert.equal(data.restoreCalls.length, 0);
});

test('runs a confirmed full drill through alternate-target restore and preserves the stopped target', async () => {
  const data = fixture();
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-diff', mode: DRILL_MODE, targetConnectionId: 'connection-target', targetDatabase: 'drill_neo4j', confirmed: true, confirmationText: DRILL_CONFIRMATION });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.restoreRunId, 'restore-neo4j');
  assert.equal(completed.evidence.nativeIntegrityValidation, true);
  assert.equal(completed.evidence.serviceStarted, false);
  assert.equal(completed.evidence.targetPreserved, true);
  assert.equal(completed.evidence.cleanupPerformed, false);
  assert.equal(data.restoreCalls[0].confirmationText, 'RESTORE NEO4J ALTERNATE');
});

test('requires full-drill confirmation and reconciles orphaned runs without claiming rollback', async () => {
  const data = fixture();
  await assert.rejects(data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-diff', mode: DRILL_MODE, targetConnectionId: 'connection-target', targetDatabase: 'drill_neo4j' }), (error) => error.code === 'NEO4J_DRILL_CONFIRMATION_REQUIRED');
  data.records.verificationRun.set('verification-orphan', { id: 'verification-orphan', revision: 1, state: 'running', mode: DRILL_MODE, progress: { phase: 'restoring-alternate-database' } });
  const [reconciled] = await data.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(reconciled.state, 'interrupted');
  assert.equal(reconciled.progress.phase, 'operator-action-required');
  assert.equal(reconciled.result.rollbackPerformed, false);
  assert.match(reconciled.result.error.safeMessage, /No rollback is claimed/i);
});
