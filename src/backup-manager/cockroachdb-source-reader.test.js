const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID, ADAPTER_VERSION } = require('./cockroachdb');
const { digestJson } = require('./database-adapter');
const { normalizeDestination } = require('./cockroachdb-native');
const {
  ARTIFACT_PATH,
  CockroachDbSourceReaderService,
  admitCockroachDbSource,
  buildPublishedMetadata,
  normalizePublishedMetadata,
  selectionFromSelector
} = require('./cockroachdb-source-reader');

const CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const CHECKED_AT = '2026-08-05T12:00:00.000Z';
const COMPLETED_AT = '2026-08-05T12:00:03.000Z';
const DEPLOYMENT = `sha256:${'1'.repeat(64)}`;
const TOPOLOGY = `sha256:${'2'.repeat(64)}`;
const INVENTORY = `sha256:${'3'.repeat(64)}`;
const JOB_EVIDENCE = `sha256:${'4'.repeat(64)}`;
const DESTINATION = normalizeDestination({ type: 'external-connection', externalConnectionName: 'backup_archive' });

function rawDestination() {
  return { type: 'external-connection', localities: DESTINATION.localities.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName })) };
}

function selector(scope = 'database') {
  const value = {
    allDatabases: scope === 'cluster',
    includeGlobalObjects: scope === 'cluster',
    databases: { include: [], exclude: [] },
    schemas: { include: [], exclude: [] },
    tables: { include: [], exclude: [] },
    digest: `sha256:${'5'.repeat(64)}`
  };
  if (scope === 'database') value.databases.include = [{ name: 'app' }];
  if (scope === 'table') {
    value.databases.include = [{ name: 'app' }];
    value.tables.include = [{ database: 'app', schema: 'public', name: 'events' }];
  }
  return value;
}

function consistency() {
  return {
    requestedLevel: 'application',
    backupMethod: 'physical',
    backupMode: 'full',
    method: 'cockroachdb-native-backup',
    captureCoordinates: true
  };
}

function connection() {
  return {
    id: 'connection-a',
    revision: 7,
    kind: 'database',
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    workerAffinity: ['device:device-a'],
    endpoint: {
      expectedClusterId: CLUSTER_ID,
      expectedDeploymentFingerprint: DEPLOYMENT,
      expectedTopologyFingerprint: TOPOLOGY,
      expectedInventoryFingerprint: INVENTORY
    },
    trust: {
      clusterId: CLUSTER_ID,
      fingerprint: DEPLOYMENT,
      topologyFingerprint: TOPOLOGY,
      inventoryFingerprint: INVENTORY
    },
    lastTest: {
      status: 'success',
      endpointIdentity: {
        clusterId: CLUSTER_ID,
        deploymentFingerprint: DEPLOYMENT,
        topologyFingerprint: TOPOLOGY,
        inventoryFingerprint: INVENTORY
      }
    },
    cockroachdbInventory: {
      clusterId: CLUSTER_ID,
      deploymentFingerprint: DEPLOYMENT,
      topologyFingerprint: TOPOLOGY,
      inventoryFingerprint: INVENTORY,
      externalConnections: [{ name: 'backup_archive', owner: 'backup_user' }],
      capabilities: {
        backupIntoSyntax: true,
        detachedJobs: true,
        jobsVisible: true,
        externalConnectionsVisible: true,
        privilegeEvidenceVisible: true,
        systemPrivileges: { BACKUP: true, VIEWJOB: true, CONTROLJOB: true }
      }
    },
    cockroachdbBackupDestinationTrust: {
      version: 1,
      connectionRevision: 7,
      clusterId: CLUSTER_ID,
      deploymentFingerprint: DEPLOYMENT,
      topologyFingerprint: TOPOLOGY,
      inventoryFingerprint: INVENTORY,
      destination: rawDestination(),
      destinationFingerprint: DESTINATION.destinationFingerprint,
      localityFingerprint: DESTINATION.localityFingerprint,
      checkedAt: CHECKED_AT
    }
  };
}

function source(record = connection(), scope = 'database') {
  const selected = selector(scope);
  const physicalExecution = admitCockroachDbSource({ connection: record, selector: selected, consistency: consistency(), input: { asOfLagSeconds: 10 }, deviceId: 'device-a' });
  return {
    id: 'source-a',
    revision: 3,
    connectionId: record.id,
    sourceType: 'database',
    adapterId: ADAPTER_ID,
    enabled: true,
    selector: selected,
    consistency: consistency(),
    physicalExecution
  };
}

function nativeResult(enrolled, {
  backupMode = 'full',
  executionId = 'run-full',
  rootExecutionId = executionId,
  incrementalCount = backupMode === 'full' ? 0 : 1,
  asOfTimestamp = backupMode === 'full' ? '2026-08-05T12:00:00.000Z' : '2026-08-05T12:10:00.000Z'
} = {}) {
  return {
    backupMode,
    asOfTimestamp,
    revisionHistory: enrolled.physicalExecution.revisionHistory,
    selection: enrolled.physicalExecution.selection,
    binding: enrolled.physicalExecution.binding,
    collection: DESTINATION,
    chain: {
      version: 1,
      rootExecutionId,
      headExecutionId: executionId,
      incrementalCount,
      lastAsOfTimestamp: asOfTimestamp,
      clusterId: CLUSTER_ID,
      deploymentFingerprint: DEPLOYMENT,
      topologyFingerprint: TOPOLOGY,
      destinationFingerprint: DESTINATION.destinationFingerprint,
      localityFingerprint: DESTINATION.localityFingerprint,
      selectionFingerprint: enrolled.physicalExecution.selection.fingerprint,
      revisionHistory: enrolled.physicalExecution.revisionHistory,
      encryptionMode: 'none'
    },
    job: {
      jobId: '918273645',
      jobType: 'BACKUP',
      currentUser: 'backup_user',
      status: 'succeeded',
      createdAt: CHECKED_AT,
      startedAt: '2026-08-05T12:00:01.000Z',
      finishedAt: '2026-08-05T12:00:02.000Z',
      modifiedAt: '2026-08-05T12:00:02.000Z',
      fractionCompleted: 1,
      coordinatorId: 1,
      hasError: false,
      terminal: true,
      evidenceFingerprint: JOB_EVIDENCE
    },
    ownership: { version: 1, jobId: '918273645', currentUser: 'backup_user', submittedAt: CHECKED_AT },
    completedAt: COMPLETED_AT
  };
}

function publishedFull(enrolled, jobId = 'backup-job-a') {
  return buildPublishedMetadata({
    plan: { admission: { productVersion: '25.2.3', clusterVersion: '25.2' } },
    result: nativeResult(enrolled),
    parent: null,
    source: enrolled,
    jobId
  });
}

function resign(metadata) {
  const copy = structuredClone(metadata);
  delete copy.publication;
  return { ...copy, publication: { version: 1, state: 'ready', metadataDigest: `sha256:${digestJson(copy)}` } };
}

function readerFixture({ controller, recoveryPoints = [], artifacts = [], openRepository = null } = {}) {
  const record = connection();
  const enrolled = source(record);
  let run = null;
  const controlDatabase = {
    repository(kind) {
      if (kind === 'source') return { get: async (_workspaceId, id) => id === enrolled.id ? enrolled : null };
      if (kind === 'connection') return { get: async (_workspaceId, id) => id === record.id ? record : null };
      if (kind === 'recoveryPoint') return { list: async () => recoveryPoints };
      if (kind === 'artifact') return { list: async () => artifacts };
      if (kind === 'run') return { get: async (_workspaceId, id) => run?.id === id ? run : null };
      throw new Error(`Unexpected repository: ${kind}`);
    },
    async transaction(callback) {
      return callback({
        get: (kind, _workspaceId, id) => kind === 'run' && run?.id === id ? run : null,
        projectExecution: (_kind, _workspaceId, _id, patch) => { run = { ...run, ...patch, revision: run.revision + 1 }; }
      });
    }
  };
  const connectionService = {
    config: () => ({ protectedConnectionConfig: true }),
    withExecution: async (_workspaceId, _connection, signal, callback) => callback({ signal }, { protectedConnectionConfig: true })
  };
  const reader = new CockroachDbSourceReaderService({
    controlDatabase,
    deviceId: 'device-a',
    connectionService,
    controller,
    openRepository,
    adapterRegistry: { manifest: () => ({ sourceEnrollmentReady: true }) },
    clock: () => '2026-08-05T13:00:00.000Z'
  });
  return { reader, record, enrolled, setRun: (value) => { run = value; }, getRun: () => run };
}

test('admits exact cluster, database, and whole-table selections and rejects unsupported selector rules', () => {
  assert.equal(selectionFromSelector(selector('cluster')).scope, 'cluster');
  assert.equal(selectionFromSelector(selector('database')).database, 'app');
  assert.deepEqual(selectionFromSelector(selector('table')).tables, [{ database: 'app', schema: 'public', name: 'events' }]);
  const excluded = selector('database');
  excluded.databases.exclude.push({ name: 'system' });
  assert.throws(() => selectionFromSelector(excluded), /exclusion rules/);
  const partialTable = selector('table');
  partialTable.schemas.include.push({ database: 'app', name: 'public' });
  assert.throws(() => selectionFromSelector(partialTable), /schema selection/);
});

test('binds enrollment to tested cluster, topology, inventory, revision, privileges, and destination', () => {
  const admitted = admitCockroachDbSource({ connection: connection(), selector: selector(), consistency: consistency(), deviceId: 'device-a' });
  assert.equal(admitted.binding.clusterId, CLUSTER_ID);
  assert.equal(admitted.destination.destinationFingerprint, DESTINATION.destinationFingerprint);
  const cases = [
    (value) => { value.trust.clusterId = '22222222-2222-4222-8222-222222222222'; },
    (value) => { value.cockroachdbInventory.topologyFingerprint = `sha256:${'8'.repeat(64)}`; },
    (value) => { value.cockroachdbInventory.inventoryFingerprint = `sha256:${'8'.repeat(64)}`; },
    (value) => { value.revision += 1; },
    (value) => { value.cockroachdbInventory.capabilities.systemPrivileges.VIEWJOB = false; },
    (value) => { value.cockroachdbBackupDestinationTrust.destinationFingerprint = `sha256:${'8'.repeat(64)}`; }
  ];
  for (const mutate of cases) {
    const changed = connection();
    mutate(changed);
    assert.throws(() => admitCockroachDbSource({ connection: changed, selector: selector(), consistency: consistency(), deviceId: 'device-a' }));
  }
});

test('publishes strict bounded metadata without native job, connection, URI, SQL, credential, description, or error data', () => {
  const enrolled = source();
  const metadata = publishedFull(enrolled);
  assert.equal(normalizePublishedMetadata(metadata, {
    sourceId: enrolled.id,
    jobId: 'backup-job-a',
    selectionFingerprint: enrolled.physicalExecution.selection.fingerprint,
    destinationFingerprint: DESTINATION.destinationFingerprint,
    topologyFingerprint: TOPOLOGY,
    inventoryFingerprint: INVENTORY,
    connectionRevision: 7
  }).jobId, 'backup-job-a');
  const serialized = JSON.stringify(metadata);
  for (const secret of ['backup_archive', 'external://', 'backup_user', '918273645', 'password', 'description', 'statement']) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(metadata.job.evidenceFingerprint, JOB_EVIDENCE);
  assert.equal(metadata.nativeChain.headExecutionId, 'run-full');

  const changedBinding = structuredClone(metadata);
  changedBinding.binding.topologyFingerprint = `sha256:${'8'.repeat(64)}`;
  changedBinding.nativeChain.topologyFingerprint = changedBinding.binding.topologyFingerprint;
  assert.throws(() => normalizePublishedMetadata(resign(changedBinding), { topologyFingerprint: TOPOLOGY }), (error) => error.code === 'COCKROACH_PUBLISHED_METADATA_CHANGED');
  const changedJob = structuredClone(metadata);
  changedJob.job.hasError = true;
  assert.throws(() => normalizePublishedMetadata(resign(changedJob)), (error) => error.code === 'COCKROACH_PUBLISHED_METADATA_INVALID');
  const privateField = structuredClone(metadata);
  privateField.nativeJobId = '918273645';
  assert.throws(() => normalizePublishedMetadata(resign(privateField)), (error) => error.code === 'COCKROACH_PUBLISHED_METADATA_INVALID');
});

test('persists private detached ownership before polling and publishes only the redacted full-backup artifact', async () => {
  const events = [];
  let request;
  const controller = {
    async planBackup(_context, value) {
      request = value;
      return { admission: { productVersion: '25.2.3', clusterVersion: '25.2' } };
    },
    async executeBackup(context) {
      events.push('submitted');
      await context.onOwnership({ version: 1, jobId: '918273645', submittedAt: CHECKED_AT });
      events.push('poll');
      return nativeResult(value.enrolled, { executionId: request.execution.executionId });
    }
  };
  const value = readerFixture({ controller });
  const leases = [];
  const files = await value.reader.files('workspace-a', value.enrolled.id, {
    executionId: 'run-full',
    jobId: 'backup-job-a',
    backupMode: 'full',
    onSourceLease: async (lease) => { events.push(`lease:${lease.state}`); leases.push(lease); }
  });
  assert.equal(events.indexOf('lease:active') < events.indexOf('poll'), true);
  assert.equal(leases[0].ownership.jobId, '918273645');
  assert.equal(files.manifest.artifactPath, ARTIFACT_PATH);
  const entries = [];
  for await (const entry of files.create()) {
    const chunks = [];
    for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
    entries.push({ entry, metadata: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry.path, ARTIFACT_PATH);
  assert.equal(entries[0].metadata.jobId, 'backup-job-a');
  assert.equal(JSON.stringify(entries[0].metadata).includes('918273645'), false);
  assert.equal(await value.reader.release('workspace-a', 'run-full'), true);
  assert.equal(leases.at(-1).state, 'released');
  assert.equal(leases.at(-1).releasedAt, '2026-08-05T13:00:00.000Z');
});

test('authenticates the exact full parent artifact before admitting an incremental chain', async () => {
  const record = connection();
  const enrolled = source(record);
  const fullMetadata = publishedFull(enrolled, 'backup-job-a');
  const sizeBytes = Buffer.byteLength(JSON.stringify(fullMetadata));
  const copy = { repositoryId: 'repository-a', state: 'available', engineSnapshotId: 'snapshot-full', manifestLocator: 'manifest-full', manifestChecksum: { digest: 'sha256:manifest' } };
  const fullPoint = {
    id: 'recovery-full',
    runId: 'run-full',
    sourceId: enrolled.id,
    jobId: 'backup-job-a',
    type: 'full',
    consistency: 'application',
    verification: { state: 'succeeded' },
    retention: { deletionEligible: false },
    chainRootId: 'recovery-full',
    parentRecoveryPointId: null,
    repositoryCopies: [copy]
  };
  const artifact = {
    recoveryPointId: fullPoint.id,
    repositoryId: copy.repositoryId,
    kind: 'metadata',
    locator: `repository-a#${encodeURIComponent(ARTIFACT_PATH)}`,
    sizeBytes,
    checksum: { digest: 'sha256:file' },
    metadata: fullMetadata
  };
  const snapshot = {
    summary: { manifestKey: copy.manifestLocator, manifestChecksum: copy.manifestChecksum },
    manifest: { files: [{ path: ARTIFACT_PATH, type: 'file', sizeBytes, contentDigest: artifact.checksum, metadata: { artifactKind: 'metadata', externalNativeMedia: true, database: fullMetadata } }] }
  };
  let request;
  let value;
  const controller = {
    async planBackup(_context, input) { request = input; return { admission: { productVersion: '25.2.3', clusterVersion: '25.2' } }; },
    async executeBackup(context) {
      await context.onOwnership({ version: 1, jobId: '918273646', submittedAt: CHECKED_AT });
      return nativeResult(value.enrolled, { backupMode: 'incremental', executionId: request.execution.executionId, rootExecutionId: 'run-full', incrementalCount: 1 });
    }
  };
  value = readerFixture({
    controller,
    recoveryPoints: [fullPoint],
    artifacts: [artifact],
    openRepository: async () => ({ engine: { openSnapshot: async () => snapshot }, masterKey: Buffer.alloc(32) })
  });
  const files = await value.reader.files('workspace-a', value.enrolled.id, {
    executionId: 'run-incremental',
    jobId: 'backup-job-a',
    backupMode: 'incremental',
    previousRecoveryPoint: fullPoint,
    repositoryIds: ['repository-a'],
    onSourceLease: async () => {}
  });
  assert.equal(request.parentChain.headExecutionId, 'run-full');
  assert.deepEqual(files.manifest.database.chain.ancestorRecoveryPointIds, ['recovery-full']);
  assert.equal(files.manifest.database.chain.parentRecoveryPointId, 'recovery-full');

  artifact.locator = 'repository-a#wrong.json';
  await assert.rejects(value.reader.files('workspace-a', value.enrolled.id, {
    executionId: 'run-wrong-parent',
    jobId: 'backup-job-a',
    backupMode: 'incremental',
    previousRecoveryPoint: fullPoint,
    repositoryIds: ['repository-a'],
    onSourceLease: async () => {}
  }), (error) => error.code === 'COCKROACH_INCREMENTAL_ARTIFACT_CHANGED');
});

test('reconciles, pauses, resumes, and cancels only exact run-owned native jobs', async () => {
  const calls = [];
  const response = (operation, status) => ({ operation, job: { status, terminal: status === 'succeeded', fractionCompleted: status === 'succeeded' ? 1 : 0.5 }, controlledAt: CHECKED_AT });
  const controller = {
    reconcile: async (_context, input) => { calls.push(['reconcile', input.ownership.jobId]); return { terminal: true, job: { status: 'succeeded' }, reconciledAt: CHECKED_AT }; },
    pause: async (_context, input) => { calls.push(['pause', input.ownership.jobId]); return response('pause', 'paused'); },
    resume: async (_context, input) => { calls.push(['resume', input.ownership.jobId]); return response('resume', 'running'); },
    cancel: async (_context, input) => { calls.push(['cancel', input.ownership.jobId]); return response('cancel', 'canceled'); }
  };
  const value = readerFixture({ controller });
  value.setRun({
    id: 'run-owned',
    revision: 4,
    configSnapshot: { source: { adapterId: ADAPTER_ID } },
    sourceLease: {
      version: 1,
      kind: 'cockroachdb-native-job',
      state: 'active',
      workspaceId: 'workspace-a',
      sourceId: value.enrolled.id,
      executionId: 'run-owned',
      connectionId: value.record.id,
      ownership: { jobId: '918273645' },
      updatedAt: CHECKED_AT
    }
  });
  const reconciled = await value.reader.reconcileRun('workspace-a', { id: 'run-owned' });
  assert.equal(reconciled.proven, true);
  assert.equal(reconciled.sourceLease.state, 'released');
  for (const [method, operation] of [['pauseRun', 'pause'], ['resumeRun', 'resume'], ['cancelRun', 'cancel']]) {
    const result = await value.reader[method]('workspace-a', 'run-owned');
    assert.equal(result.operation, operation);
    assert.equal(JSON.stringify(result).includes('918273645'), false);
  }
  assert.deepEqual(calls, [['reconcile', '918273645'], ['pause', '918273645'], ['resume', '918273645'], ['cancel', '918273645']]);
  value.setRun({ ...value.getRun(), sourceLease: { ...value.getRun().sourceLease, state: 'released' } });
  await assert.rejects(value.reader.pauseRun('workspace-a', 'run-owned'), (error) => error.code === 'COCKROACH_OWNED_RUN_INVALID');
});
