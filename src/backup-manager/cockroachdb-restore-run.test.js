const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID, ADAPTER_VERSION } = require('./cockroachdb');
const { normalizeDestination } = require('./cockroachdb-native');
const { ARTIFACT_PATH, admitCockroachDbSource, buildPublishedMetadata } = require('./cockroachdb-source-reader');
const { RESTORE_CONFIRMATION } = require('./cockroachdb-restore');
const { CockroachDbRestoreRunService } = require('./cockroachdb-restore-run');

const CLOCK = '2026-08-05T13:00:00.000Z';
const SOURCE_CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_CLUSTER_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_DEPLOYMENT = `sha256:${'1'.repeat(64)}`;
const SOURCE_TOPOLOGY = `sha256:${'2'.repeat(64)}`;
const SOURCE_INVENTORY = `sha256:${'3'.repeat(64)}`;
const TARGET_DEPLOYMENT = `sha256:${'4'.repeat(64)}`;
const TARGET_TOPOLOGY = `sha256:${'5'.repeat(64)}`;
const TARGET_INVENTORY = `sha256:${'6'.repeat(64)}`;
const JOB_EVIDENCE = `sha256:${'7'.repeat(64)}`;
const PLAN_DIGEST = `sha256:${'8'.repeat(64)}`;
const DESTINATION = normalizeDestination({ type: 'external-connection', externalConnectionName: 'backup_archive' });

function rawDestination() {
  return { type: 'external-connection', localities: DESTINATION.localities.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName })) };
}

function trustedConnection({ id, clusterId, deployment, topology, inventory, source = false }) {
  const capabilities = {
    backupIntoSyntax: true,
    restoreSyntax: true,
    detachedJobs: true,
    jobsVisible: true,
    externalConnectionsVisible: true,
    privilegeEvidenceVisible: true,
    systemPrivileges: { BACKUP: true, RESTORE: true, VIEWJOB: true, CONTROLJOB: true }
  };
  return {
    id,
    revision: 7,
    kind: 'database',
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    workerAffinity: ['device:device-a'],
    endpoint: {
      executionMode: 'local', authMode: 'password', host: `${source ? 'source' : 'target'}.example.com`, port: 26257,
      username: source ? 'backup_user' : 'restore_user', database: 'defaultdb', sqlPath: 'cockroach',
      expectedClusterId: clusterId, expectedDeploymentFingerprint: deployment,
      expectedTopologyFingerprint: topology, expectedInventoryFingerprint: inventory
    },
    secretRefIds: [source ? 'sec-source' : 'sec-target'],
    trust: { clusterId, fingerprint: deployment, topologyFingerprint: topology, inventoryFingerprint: inventory },
    lastTest: { status: 'success', endpointIdentity: { clusterId, deploymentFingerprint: deployment, topologyFingerprint: topology, inventoryFingerprint: inventory } },
    cockroachdbInventory: {
      clusterId, deploymentFingerprint: deployment, topologyFingerprint: topology, inventoryFingerprint: inventory,
      nodes: [{ nodeId: 1, locality: 'region=us-east1,zone=a' }],
      externalConnections: [{ name: 'backup_archive', owner: source ? 'backup_user' : 'restore_user' }],
      capabilities
    },
    cockroachdbBackupDestinationTrust: {
      version: 1, connectionRevision: 7, clusterId, deploymentFingerprint: deployment,
      topologyFingerprint: topology, inventoryFingerprint: inventory, destination: rawDestination(),
      destinationFingerprint: DESTINATION.destinationFingerprint, localityFingerprint: DESTINATION.localityFingerprint,
      checkedAt: '2026-08-05T12:00:00.000Z'
    }
  };
}

function selector() {
  return {
    allDatabases: false,
    includeGlobalObjects: false,
    databases: { include: [{ name: 'app' }], exclude: [] },
    schemas: { include: [], exclude: [] },
    tables: { include: [], exclude: [] },
    digest: `sha256:${'9'.repeat(64)}`
  };
}

function sourceRecord(connection) {
  const consistency = { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full', method: 'cockroachdb-native-backup', captureCoordinates: true };
  const selected = selector();
  return {
    id: 'source-a', revision: 3, connectionId: connection.id, sourceType: 'database', adapterId: ADAPTER_ID,
    enabled: true, selector: selected, consistency,
    physicalExecution: admitCockroachDbSource({ connection, selector: selected, consistency, input: { asOfLagSeconds: 10, revisionHistory: true }, deviceId: 'device-a' })
  };
}

function nativeResult(source, { backupMode, executionId, rootExecutionId, incrementalCount, asOfTimestamp }) {
  return {
    backupMode,
    asOfTimestamp,
    revisionHistory: true,
    selection: source.physicalExecution.selection,
    binding: source.physicalExecution.binding,
    collection: DESTINATION,
    chain: {
      version: 1, rootExecutionId, headExecutionId: executionId, incrementalCount, lastAsOfTimestamp: asOfTimestamp,
      clusterId: SOURCE_CLUSTER_ID, deploymentFingerprint: SOURCE_DEPLOYMENT, topologyFingerprint: SOURCE_TOPOLOGY,
      destinationFingerprint: DESTINATION.destinationFingerprint, localityFingerprint: DESTINATION.localityFingerprint,
      selectionFingerprint: source.physicalExecution.selection.fingerprint, revisionHistory: true, encryptionMode: 'none'
    },
    job: {
      jobId: 'native-backup-job', jobType: 'BACKUP', currentUser: 'backup_user', status: 'succeeded',
      createdAt: '2026-08-05T11:00:00.000Z', startedAt: '2026-08-05T11:00:01.000Z',
      finishedAt: '2026-08-05T11:00:02.000Z', modifiedAt: '2026-08-05T11:00:02.000Z',
      fractionCompleted: 1, coordinatorId: 1, hasError: false, terminal: true, evidenceFingerprint: JOB_EVIDENCE
    },
    ownership: { version: 1, jobId: 'private-native-backup-job', currentUser: 'backup_user', submittedAt: '2026-08-05T11:00:00.000Z' },
    completedAt: '2026-08-05T12:00:00.000Z'
  };
}

function repositoryEntry({ pointId, runId, source, backupMode, incrementalCount, asOfTimestamp, parent }) {
  const metadata = buildPublishedMetadata({
    plan: { admission: { productVersion: '25.2.3', clusterVersion: '25.2' } },
    result: nativeResult(source, { backupMode, executionId: runId, rootExecutionId: 'run-full', incrementalCount, asOfTimestamp }),
    parent,
    source,
    jobId: 'backup-job-a'
  });
  const sizeBytes = Buffer.byteLength(JSON.stringify(metadata));
  const copy = {
    repositoryId: 'repository-a', state: 'available', engineSnapshotId: `snapshot-${pointId}`,
    manifestLocator: `manifest-${pointId}`, manifestChecksum: { digest: `sha256:${backupMode === 'full' ? 'a' : 'b'}`.padEnd(71, backupMode === 'full' ? 'a' : 'b') }
  };
  const point = {
    id: pointId, runId, sourceId: source.id, jobId: 'backup-job-a', type: backupMode,
    consistency: 'application', verification: { state: 'succeeded' }, retention: { deletionEligible: false },
    chainRootId: 'rp-full', parentRecoveryPointId: backupMode === 'full' ? null : 'rp-full', repositoryCopies: [copy]
  };
  const artifact = {
    id: `artifact-${pointId}`, recoveryPointId: pointId, repositoryId: 'repository-a', kind: 'metadata',
    locator: `repository-a#${encodeURIComponent(ARTIFACT_PATH)}`, sizeBytes,
    checksum: { digest: `sha256:${backupMode === 'full' ? 'c' : 'd'}`.padEnd(71, backupMode === 'full' ? 'c' : 'd') }, metadata
  };
  const snapshot = {
    summary: { manifestKey: copy.manifestLocator, manifestChecksum: copy.manifestChecksum },
    manifest: { files: [{ path: ARTIFACT_PATH, type: 'file', sizeBytes, contentDigest: artifact.checksum, metadata: { artifactKind: 'metadata', externalNativeMedia: true, database: metadata } }] }
  };
  return { point, artifact, snapshot };
}

function fixture({ controller: controllerOverride } = {}) {
  const sourceConnection = trustedConnection({ id: 'connection-source', clusterId: SOURCE_CLUSTER_ID, deployment: SOURCE_DEPLOYMENT, topology: SOURCE_TOPOLOGY, inventory: SOURCE_INVENTORY, source: true });
  const targetConnection = trustedConnection({ id: 'connection-target', clusterId: TARGET_CLUSTER_ID, deployment: TARGET_DEPLOYMENT, topology: TARGET_TOPOLOGY, inventory: TARGET_INVENTORY });
  const source = sourceRecord(sourceConnection);
  const full = repositoryEntry({ pointId: 'rp-full', runId: 'run-full', source, backupMode: 'full', incrementalCount: 0, asOfTimestamp: '2026-08-05T11:00:00.000Z', parent: null });
  const incremental = repositoryEntry({
    pointId: 'rp-inc', runId: 'run-inc', source, backupMode: 'incremental', incrementalCount: 1,
    asOfTimestamp: '2026-08-05T11:50:00.000Z',
    parent: { parentRecoveryPointId: 'rp-full', chainRootRecoveryPointId: 'rp-full', ancestorRecoveryPointIds: ['rp-full'] }
  });
  const points = [full.point, incremental.point];
  const artifacts = [full.artifact, incremental.artifact];
  const snapshots = new Map([[full.copy?.engineSnapshotId || full.point.repositoryCopies[0].engineSnapshotId, full.snapshot], [incremental.point.repositoryCopies[0].engineSnapshotId, incremental.snapshot]]);
  const restoreRuns = new Map();
  let nextRestoreId = 1;
  const controlDatabase = {
    repository(kind) {
      if (kind === 'source') return { get: async (_workspaceId, id) => id === source.id ? source : null };
      if (kind === 'connection') return { get: async (_workspaceId, id) => id === sourceConnection.id ? sourceConnection : id === targetConnection.id ? targetConnection : null };
      if (kind === 'recoveryPoint') return {
        get: async (_workspaceId, id) => points.find((item) => item.id === id) || null,
        list: async () => points
      };
      if (kind === 'artifact') return { list: async () => artifacts };
      if (kind === 'restoreRun') return {
        create: async (input) => {
          const record = { ...structuredClone(input), id: `restore-${nextRestoreId++}`, revision: 1 };
          restoreRuns.set(record.id, record);
          return structuredClone(record);
        },
        get: async (_workspaceId, id) => structuredClone(restoreRuns.get(id) || null),
        list: async () => [...restoreRuns.values()].map(structuredClone)
      };
      throw new Error(`Unexpected repository: ${kind}`);
    },
    async transaction(callback) {
      return callback({
        get: (kind, _workspaceId, id) => kind === 'restoreRun' ? structuredClone(restoreRuns.get(id) || null) : null,
        projectExecution: (_kind, _workspaceId, id, changes) => {
          const current = restoreRuns.get(id);
          const updated = { ...current, ...structuredClone(changes), revision: current.revision + 1 };
          restoreRuns.set(id, updated);
          return structuredClone(updated);
        }
      });
    }
  };
  const events = [];
  const controller = controllerOverride || {
    async planRestore(_context, request) {
      events.push('plan');
      return { request: { ...request, restoreTimestamp: request.restoreTimestamp || request.recovery.asOfTimestamp }, admission: { targetVersion: '25.2.3', targetDatabaseAbsent: true }, planDigest: PLAN_DIGEST };
    },
    async executeRestore(context, plan) {
      events.push('submitted');
      await context.onOwnership({ version: 1, restoreRunId: plan.request.execution.restoreRunId, jobId: 'private-native-restore-job', submittedAt: CLOCK });
      events.push('ownership-returned');
      events.push('poll');
      return {
        targetDatabase: plan.request.targetDatabase,
        restoreTimestamp: plan.request.restoreTimestamp,
        job: { jobId: 'private-native-restore-job', jobType: 'RESTORE', status: 'succeeded', createdAt: CLOCK, startedAt: CLOCK, finishedAt: CLOCK, modifiedAt: CLOCK, fractionCompleted: 1, hasError: false, terminal: true, evidenceFingerprint: JOB_EVIDENCE },
        validation: { nativeDescriptorRead: true, dependenciesValid: true, unresolvedDependencyCount: 0, descriptorFingerprint: SOURCE_DEPLOYMENT }
      };
    }
  };
  const connectionService = {
    config: (connection) => ({ connectionId: connection.id }),
    withExecution: async (_workspaceId, connection, signal, callback) => callback({ signal }, { connectionId: connection.id })
  };
  const service = new CockroachDbRestoreRunService({
    controlDatabase, deviceId: 'device-a', connectionService, controller,
    openRepository: async () => ({ engine: { openSnapshot: async (_context, input) => snapshots.get(input.snapshotId) }, masterKey: Buffer.alloc(32) }),
    clock: () => CLOCK
  });
  return { service, events, points, artifacts, snapshots, restoreRuns, source, sourceConnection, targetConnection };
}

function request(overrides = {}) {
  return {
    recoveryPointId: 'rp-inc', targetConnectionId: 'connection-target', targetDatabase: 'app_restored',
    restoreTimestamp: '2026-08-05T11:25:00.000Z', mode: 'alternate', confirmed: true,
    confirmationText: RESTORE_CONFIRMATION, ...overrides
  };
}

test('authenticates the exact full and incremental artifacts from one complete repository chain', async () => {
  const value = fixture();
  const authenticated = await value.service.authenticateRecoveryPoint('workspace-a', 'rp-inc');
  assert.equal(authenticated.repositoryId, 'repository-a');
  assert.deepEqual(authenticated.entries.map((entry) => entry.point.id), ['rp-full', 'rp-inc']);
  assert.equal(authenticated.entries.at(-1).file.path, ARTIFACT_PATH);
  assert.equal(authenticated.metadata.restoreSupported, true);

  value.artifacts[0].locator = 'repository-a#wrong.json';
  await assert.rejects(value.service.authenticateRecoveryPoint('workspace-a', 'rp-inc'), (error) => error.code === 'COCKROACH_RESTORE_ARTIFACT_CHANGED');
});

test('rejects a missing authenticated ancestor before native planning', async () => {
  const value = fixture();
  value.points.splice(0, 1);
  await assert.rejects(value.service.preview('workspace-a', request()), (error) => error.code === 'COCKROACH_RESTORE_CHAIN_INCOMPLETE');
  assert.equal(value.events.includes('plan'), false);
});

test('previews an authenticated revision-history timestamp and exact alternate target', async () => {
  const value = fixture();
  const preview = await value.service.preview('workspace-a', request());
  assert.deepEqual(preview.chainRecoveryPointIds, ['rp-full', 'rp-inc']);
  assert.equal(preview.restoreTimestamp, '2026-08-05T11:25:00.000Z');
  assert.equal(preview.restorableFrom, '2026-08-05T11:00:00.000Z');
  assert.equal(preview.restorableTo, '2026-08-05T11:50:00.000Z');
  assert.deepEqual(preview.requiredRegions, ['us-east1']);
  assert.equal(preview.targetEmpty, true);
  assert.equal(preview.nativeValidation, true);
});

test('persists private native ownership before polling and publishes a redacted successful RestoreRun', async () => {
  const value = fixture();
  const queued = await value.service.start('workspace-a', 'actor-a', request());
  const completed = await value.service.wait('workspace-a', queued.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(value.events.indexOf('ownership-returned') < value.events.indexOf('poll'), true);
  const privateRecord = value.restoreRuns.get(queued.id);
  assert.equal(privateRecord.target.nativeOwnership.jobId, 'private-native-restore-job');
  assert.equal(completed.target.nativeOwnership, undefined);
  assert.equal(completed.result.job.jobId, undefined);
  assert.equal(completed.result.rollbackClaimed, false);
  const published = JSON.stringify(completed);
  for (const secret of ['private-native-restore-job', 'backup_archive', 'external://', 'sec-target']) assert.equal(published.includes(secret), false, secret);
});

test('preserves a partial alternate target after submission without leaking native failures or claiming rollback', async () => {
  const secret = 'provider token secret-native-error';
  const base = fixture();
  const failing = {
    async planRestore(_context, nativeRequest) {
      return { request: { ...nativeRequest, restoreTimestamp: nativeRequest.restoreTimestamp }, admission: { targetVersion: '25.2.3', targetDatabaseAbsent: true }, planDigest: PLAN_DIGEST };
    },
    async executeRestore(context, plan) {
      await context.onOwnership({ version: 1, restoreRunId: plan.request.execution.restoreRunId, jobId: 'private-native-restore-job', submittedAt: CLOCK });
      throw new Error(secret);
    }
  };
  const value = fixture({ controller: failing });
  const queued = await value.service.start('workspace-a', 'actor-a', request());
  const completed = await value.service.wait('workspace-a', queued.id);
  assert.equal(completed.state, 'interrupted');
  assert.equal(completed.result.partialTargetPreserved, true);
  assert.equal(completed.result.rollbackClaimed, false);
  assert.equal(JSON.stringify(completed).includes(secret), false);
  assert.equal(JSON.stringify(completed).includes('private-native-restore-job'), false);
  assert.equal(base.restoreRuns.size, 0);
});
