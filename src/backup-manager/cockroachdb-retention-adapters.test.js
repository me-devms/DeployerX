const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID } = require('./cockroachdb');
const { normalizeDestination, normalizeSelection } = require('./cockroachdb-native');
const { ARTIFACT_PATH, buildPublishedMetadata } = require('./cockroachdb-source-reader');
const { CockroachDbRetentionService } = require('./cockroachdb-retention');
const { createCockroachDbRetentionAdapters } = require('./cockroachdb-retention-adapters');

const NOW = '2026-08-05T15:00:00.000Z';
const SOURCE_ID = 'source-cockroach-retention';
const JOB_ID = 'job-cockroach-retention';
const RUN_ID = 'run-cockroach-full';
const POINT_ID = 'point-cockroach-full';
const REPOSITORY_ID = 'repository-cockroach-retention';
const CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const MANIFEST_ID = `snp_${'1'.repeat(40)}`;
const OTHER_MANIFEST_ID = `snp_${'2'.repeat(40)}`;
const MANIFEST_KEY = `manifests/v1/${MANIFEST_ID}.dxb`;
const OTHER_MANIFEST_KEY = `manifests/v1/${OTHER_MANIFEST_ID}.dxb`;
const MANIFEST_CHECKSUM = `sha256:${'a'.repeat(64)}`;
const FILE_CHECKSUM = `sha256:${'b'.repeat(64)}`;
const DEPLOYMENT = `sha256:${'c'.repeat(64)}`;
const TOPOLOGY = `sha256:${'d'.repeat(64)}`;
const INVENTORY = `sha256:${'e'.repeat(64)}`;
const JOB_EVIDENCE = `sha256:${'9'.repeat(64)}`;
const EXCLUSIVE_CHUNK = 'chunks/v1/aa/exclusive';
const SHARED_CHUNK = 'chunks/v1/bb/shared';
const OTHER_CHUNK = 'chunks/v1/cc/other';

function metadata() {
  const destination = normalizeDestination({ type: 'external-connection', externalConnectionName: 'backup_archive' });
  const binding = {
    clusterId: CLUSTER_ID,
    deploymentFingerprint: DEPLOYMENT,
    topologyFingerprint: TOPOLOGY,
    inventoryFingerprint: INVENTORY,
    connectionRevision: 7
  };
  const selection = normalizeSelection({ scope: 'database', database: 'app' });
  const source = {
    id: SOURCE_ID,
    physicalExecution: { binding, selection, destination, revisionHistory: true, encryptionMode: 'none' }
  };
  return buildPublishedMetadata({
    plan: { admission: { productVersion: '25.2.3', clusterVersion: '25.2' } },
    source,
    jobId: JOB_ID,
    parent: null,
    result: {
      backupMode: 'full',
      asOfTimestamp: '2026-08-05T14:59:30.000Z',
      revisionHistory: true,
      selection,
      binding,
      collection: destination,
      chain: {
        version: 1,
        rootExecutionId: RUN_ID,
        headExecutionId: RUN_ID,
        incrementalCount: 0,
        lastAsOfTimestamp: '2026-08-05T14:59:30.000Z',
        clusterId: CLUSTER_ID,
        deploymentFingerprint: DEPLOYMENT,
        topologyFingerprint: TOPOLOGY,
        destinationFingerprint: destination.destinationFingerprint,
        localityFingerprint: destination.localityFingerprint,
        selectionFingerprint: selection.fingerprint,
        revisionHistory: true,
        encryptionMode: 'none'
      },
      job: {
        status: 'succeeded',
        createdAt: '2026-08-05T14:59:31.000Z',
        startedAt: '2026-08-05T14:59:32.000Z',
        finishedAt: '2026-08-05T14:59:50.000Z',
        modifiedAt: '2026-08-05T14:59:50.000Z',
        fractionCompleted: 1,
        hasError: false,
        terminal: true,
        evidenceFingerprint: JOB_EVIDENCE
      },
      ownership: { version: 1, jobId: 'private-native-job-id', submittedAt: '2026-08-05T14:59:31.000Z' },
      completedAt: '2026-08-05T14:59:50.000Z'
    }
  });
}

function fixture(options = {}) {
  const published = metadata();
  const bytes = Buffer.from(JSON.stringify(published));
  const point = {
    id: POINT_ID,
    revision: 1,
    sourceId: SOURCE_ID,
    jobId: JOB_ID,
    runId: RUN_ID,
    type: 'full',
    consistency: 'application',
    chainRootId: POINT_ID,
    parentRecoveryPointId: null,
    completedAt: '2026-08-05T14:59:50.000Z',
    verification: { state: 'succeeded' },
    retention: { deletionEligible: true, legalHold: false },
    repositoryCopies: [{
      repositoryId: REPOSITORY_ID,
      state: 'available',
      engineSnapshotId: MANIFEST_ID,
      manifestLocator: MANIFEST_KEY,
      manifestChecksum: { digest: MANIFEST_CHECKSUM },
      immutableUntil: null
    }]
  };
  const source = { id: SOURCE_ID, adapterId: ADAPTER_ID, physicalExecution: { engine: 'cockroachdb' } };
  const artifactMetadata = options.tamperArtifact ? { ...published, productVersion: '99.0.0' } : published;
  const artifacts = [{
    id: 'artifact-cockroach-metadata',
    recoveryPointId: POINT_ID,
    repositoryId: REPOSITORY_ID,
    kind: 'metadata',
    locator: `${MANIFEST_KEY}#${encodeURIComponent(ARTIFACT_PATH)}`,
    sizeBytes: bytes.length,
    checksum: { digest: FILE_CHECKSUM },
    metadata: artifactMetadata
  }];
  const data = {
    source: [source],
    repository: [{ id: REPOSITORY_ID, workerAffinity: ['device:device-a'] }],
    recoveryPoint: [point],
    artifact: artifacts,
    run: options.activeRun ? [{ id: 'run-active', jobId: JOB_ID, state: 'running', configSnapshot: { source: { id: SOURCE_ID } } }] : [],
    restoreRun: [],
    verificationRun: []
  };
  const transactions = [];
  const controlDatabase = {
    repository(kind) {
      return {
        get: async (_workspaceId, id) => data[kind].find((record) => record.id === id) || null,
        list: async () => data[kind].map((record) => structuredClone(record))
      };
    },
    async transaction(callback) {
      const result = callback({
        get: (kind, _workspaceId, id) => data[kind].find((record) => record.id === id) || null,
        projectRecoveryPointRepositoryCopies: (_workspaceId, id, copies, projection) => {
          const current = data.recoveryPoint.find((record) => record.id === id);
          assert.equal(current.revision, projection.expectedRevision);
          current.repositoryCopies = structuredClone(copies);
          current.revision += 1;
          transactions.push({ id, projection });
          return structuredClone(current);
        }
      });
      return result;
    }
  };
  const candidateManifest = {
    keyVersion: 1,
    files: [{
      path: ARTIFACT_PATH,
      type: 'file',
      sizeBytes: bytes.length,
      contentDigest: { digest: FILE_CHECKSUM },
      chunks: [{ key: EXCLUSIVE_CHUNK }, { key: SHARED_CHUNK }],
      metadata: { artifactKind: 'metadata', externalNativeMedia: true, database: published }
    }]
  };
  const snapshots = new Map([
    [MANIFEST_ID, { summary: { manifestKey: MANIFEST_KEY, manifestChecksum: { digest: MANIFEST_CHECKSUM } }, manifest: candidateManifest }],
    [OTHER_MANIFEST_ID, { summary: { manifestKey: OTHER_MANIFEST_KEY, manifestChecksum: { digest: `sha256:${'8'.repeat(64)}` } }, manifest: { keyVersion: 1, files: [{ path: 'other/file', type: 'file', chunks: [{ key: SHARED_CHUNK }, { key: OTHER_CHUNK }] }] } }]
  ]);
  const deleted = [];
  const locks = [];
  const adapter = {
    async *list() {
      yield { items: [{ key: MANIFEST_KEY }, { key: OTHER_MANIFEST_KEY }], hasMore: false, nextCursor: null };
    },
    async acquireLock(_context, input) {
      locks.push(['acquire', input]);
      return { id: 'repository-lock' };
    },
    async renewLock(_context, lease) {
      locks.push(['renew', lease]);
      return lease;
    },
    async releaseLock(_context, lease) {
      locks.push(['release', lease]);
    },
    async delete(_context, input) {
      deleted.push(input.key);
      return { deleted: true, absent: false };
    }
  };
  const engine = {
    async openSnapshot(_context, input) { return snapshots.get(input.snapshotId); },
    async readFile() { return bytes; }
  };
  const adapters = createCockroachDbRetentionAdapters({
    controlDatabase,
    openRepository: async () => ({ adapter, engine, masterKey: Buffer.alloc(32, 7) }),
    deviceId: 'device-a',
    randomUUID: () => 'retention-run-id',
    clock: () => NOW
  });
  const service = new CockroachDbRetentionService({ ...adapters, clock: () => NOW });
  return { service, adapters, data, deleted, locks, transactions };
}

function request() {
  return { sourceId: SOURCE_ID, recoveryPointIds: [POINT_ID], repositoryId: REPOSITORY_ID, mediaDomain: 'deployerx-repository' };
}

test('authenticates exact CockroachDB ownership and deletes only the manifest and exclusive chunks under one repository lock', async () => {
  const current = fixture();
  const preview = await current.service.preview('workspace-a', request());
  assert.equal(preview.eligible, true);
  assert.equal(preview.summary.repositoryCopies, 1);
  assert.equal(preview.summary.mediaObjects, 2);
  assert.equal(preview.summary.sharedObjectsPreserved, 1);
  assert.equal(JSON.stringify(preview).includes('private-native-job-id'), false);

  const result = await current.service.execute('workspace-a', 'operator-a', { ...request(), planId: preview.planId });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.mediaObjectsDeleted, 2);
  assert.equal(result.sharedObjectsPreserved, 1);
  assert.deepEqual(current.deleted, [MANIFEST_KEY, EXCLUSIVE_CHUNK]);
  assert.equal(current.deleted.includes(SHARED_CHUNK), false);
  assert.deepEqual(current.locks.map(([operation]) => operation), ['acquire', 'release']);
  assert.equal(current.transactions.length, 1);
  const copy = current.data.recoveryPoint[0].repositoryCopies[0];
  assert.equal(copy.state, 'pruned');
  assert.equal(copy.externalNativeMediaPreserved, true);
  assert.equal(copy.nativeMediaDeletionAttempted, false);
  assert.match(copy.retentionOwnershipFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('blocks retention while an exact Source or Job operation is active', async () => {
  const current = fixture({ activeRun: true });
  const preview = await current.service.preview('workspace-a', request());
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockedReason, 'active-operation');
  assert.deepEqual(preview.activeOperationIds, ['run-active']);
  assert.equal(current.deleted.length, 0);
});

test('fails closed when the control-plane Artifact differs from authenticated repository metadata', async () => {
  const current = fixture({ tamperArtifact: true });
  const preview = await current.service.preview('workspace-a', request());
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockedReason, 'ownership-ambiguous');
  assert.equal(preview.summary.repositoryCopies, 0);
  assert.equal(current.deleted.length, 0);
});

test('repository deletion cannot run without the repository-wide mutation lease', async () => {
  const current = fixture();
  await assert.rejects(current.adapters.repositoryMedia.deleteOwnedCopy({
    workspaceId: 'workspace-a',
    repositoryId: REPOSITORY_ID,
    recoveryPointId: POINT_ID,
    recoveryPointRevision: 1,
    deletionToken: `sha256:${'1'.repeat(64)}`,
    ownershipFingerprint: `sha256:${'2'.repeat(64)}`,
    mediaFingerprint: `sha256:${'3'.repeat(64)}`,
    preserveSharedObjects: true
  }), (error) => error.code === 'COCKROACH_RETENTION_LOCK_REQUIRED');
  assert.equal(current.deleted.length, 0);
});
