const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupJobService } = require('./backup-job');
const { StructuredLogStore } = require('./audit');
const { BackupControlDatabase } = require('./control-database');
const { FileSourceReaderService } = require('./file-source-reader');
const { LocalFolderRepositoryAdapter, ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID } = require('./local-repository');
const { ManualBackupError, ManualBackupService, publicRun } = require('./manual-backup');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'test-device';
const ACTOR_ID = 'tester';

async function fixture(context, repositoryCount = 1, options = {}) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-manual-backup-test-'));
  const controlRoot = path.join(rootPath, 'control');
  const sourceRoot = path.join(rootPath, 'source');
  await fs.mkdir(path.join(sourceRoot, 'nested'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'nested', 'report.txt'), 'manual backup payload', 'utf8');
  const database = new BackupControlDatabase({ rootPath: controlRoot });
  await database.initialize();
  context.after(async () => {
    await database.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  const connection = await database.repository('connection').create({
    workspaceId: WORKSPACE_ID,
    name: 'This computer',
    kind: 'local',
    adapterId: 'deployerx.connection.local',
    adapterVersion: '1.0.0',
    secretRefIds: [],
    workerAffinity: [`device:${DEVICE_ID}`],
    lastTest: { status: 'success' }
  });
  const source = await database.repository('source').create({
    workspaceId: WORKSPACE_ID,
    name: 'Application files',
    connectionId: connection.id,
    sourceType: 'files',
    adapterId: 'deployerx.files.local',
    enabled: true,
    selector: {
      version: 1,
      kind: 'file-paths',
      roots: [{ path: sourceRoot, type: 'directory' }],
      includePatterns: [],
      excludePatterns: [],
      options: { includeHidden: false, crossMounts: false, followSymbolicLinks: false },
      metadataPolicy: { preserve: {} },
      digest: 'source-selection-digest'
    },
    platform: { os: process.platform === 'win32' ? 'windows' : 'linux', metadataCapabilities: {} }
  });

  const openedRepositories = new Map();
  const repositories = [];
  for (let index = 0; index < repositoryCount; index += 1) {
    const repositoryRoot = path.join(rootPath, `repository-${index + 1}`);
    await fs.mkdir(repositoryRoot, { recursive: true });
    const repository = await database.repository('repository').create({
      workspaceId: WORKSPACE_ID,
      name: `Archive ${index + 1}`,
      connectionId: null,
      adapterId: LOCAL_REPOSITORY_ADAPTER_ID,
      adapterVersion: '1.0.0',
      engineId: ENGINE_ID,
      engineVersion: ENGINE_VERSION,
      location: { path: repositoryRoot },
      secretRefIds: [],
      encryptionKeyRefId: null,
      encryption: { algorithm: 'aes-256-gcm', keyVersion: 'test-key-v1' },
      workerAffinity: [`device:${DEVICE_ID}`],
      health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
    });
    const adapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
    await adapter.initialize();
    const engine = new FileRepositoryEngine({ adapter });
    const masterKey = Buffer.alloc(32, index + 1);
    await engine.ensureRepository({}, { repositoryId: repository.id });
    openedRepositories.set(repository.id, { repository, adapter, engine, masterKey, keyVersion: 'test-key-v1' });
    repositories.push(repository);
  }

  const jobs = new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID });
  const created = await jobs.create(WORKSPACE_ID, ACTOR_ID, {
    name: 'Application protection',
    sourceId: source.id,
    repositoryIds: repositories.map((repository) => repository.id),
    backupMode: 'incremental',
    verifyAfterBackup: true
  });
  const sourceReader = new FileSourceReaderService({
    controlDatabase: database,
    secretStore: { resolve: async () => { throw new Error('Local sources do not resolve credentials.'); } },
    deviceId: DEVICE_ID
  });
  const checkpointStore = new RunCheckpointStore({ rootPath: path.join(rootPath, 'checkpoints') });
  const logStore = new StructuredLogStore({ rootPath: path.join(rootPath, 'logs') });
  const openRepository = async (workspaceId, repositoryId) => {
    if (workspaceId !== WORKSPACE_ID || !openedRepositories.has(repositoryId)) throw new Error('Repository was not found.');
    return openedRepositories.get(repositoryId);
  };
  const service = new ManualBackupService({ controlDatabase: database, sourceReader, checkpointStore, deviceId: DEVICE_ID, openRepository, logStore, notificationService: options.notificationService });
  return { rootPath, sourceRoot, database, service, checkpointStore, logStore, openRepository, openedRepositories, connection, source, repositories, job: created.job };
}

test('projects stable run metrics for history without exposing configuration snapshots', () => {
  const projected = publicRun({
    id: 'run_metrics', executionGroupId: 'group_metrics', jobId: 'job_metrics', jobRevision: 3, state: 'running', trigger: 'manual', attempt: 1,
    progress: { itemsScanned: 12, sourceBytes: 1000, bytesRead: 900, uploadedBytes: 250, reusedBytes: 750, throughputBytesPerSecond: 125, updatedAt: '2026-08-03T12:00:08.000Z' },
    configSnapshot: { password: 'must-not-project', policy: { performance: { priority: 'high' } } },
    startedAt: '2026-08-03T12:00:00.000Z', finishedAt: null, result: null, retryState: null,
    createdAt: '2026-08-03T11:59:59.000Z', updatedAt: '2026-08-03T12:00:08.000Z', revision: 4, checkpoint: { available: false }
  });

  assert.deepEqual(projected.metrics, {
    scannedItems: 12, scannedBytes: 1000, readBytes: 900, uploadedBytes: 250, reusedBytes: 750,
    deduplicationSavingsPercent: 75, throughputBytesPerSecond: 125, durationMs: 8000
  });
  assert.equal(projected.priority, 'high');
  assert.equal('configSnapshot' in projected, false);
  assert.equal(JSON.stringify(projected).includes('must-not-project'), false);
});

test('cancels an active run atomically and retries it as a fresh execution', async (context) => {
  const { database, service, job } = await fixture(context);
  const queued = await database.transaction((transaction) => {
    const group = transaction.create('executionGroup', {
      workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, jobId: job.id, jobRevision: job.revision,
      trigger: 'manual', scheduledFor: null, idempotencyKey: 'cancel-me', state: 'pending', latestRunId: null, terminalRunId: null
    });
    const run = transaction.create('run', {
      workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, jobId: job.id, jobRevision: job.revision,
      executionGroupId: group.id, scheduledFor: null, idempotencyKey: 'cancel-me:attempt:1', trigger: 'manual',
      workerId: `device:${DEVICE_ID}`, state: 'queued', attempt: 1, parentRunId: null, configSnapshot: {},
      progress: { phase: 'queued', updatedAt: '2026-08-03T12:00:00.000Z' }, lease: null, startedAt: null, finishedAt: null, result: null
    });
    transaction.projectExecution('executionGroup', WORKSPACE_ID, group.id, { latestRunId: run.id }, { expectedRevision: group.revision, actorId: ACTOR_ID });
    return run;
  });

  const canceled = await service.cancel(WORKSPACE_ID, 'operator', queued.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.progress.phase, 'canceled');
  assert.equal(canceled.cancellation.requestedBy, 'operator');
  assert.equal(canceled.result.safeErrorCode, 'BACKUP_RUN_CANCELED');
  const [canceledGroup] = await database.repository('executionGroup').list(WORKSPACE_ID);
  assert.equal(canceledGroup.state, 'canceled');
  assert.equal(canceledGroup.terminalRunId, queued.id);
  await assert.rejects(service.cancel(WORKSPACE_ID, 'operator', queued.id), /active backup run/);

  const retried = await service.retry(WORKSPACE_ID, 'operator', queued.id);
  assert.equal(retried.state, 'queued');
  assert.equal(retried.trigger, 'retry');
  assert.equal(retried.retryOfRunId, queued.id);
  assert.notEqual(retried.executionGroupId, canceledGroup.id);
  await service.wait(retried.id);
  const completed = await database.repository('run').get(WORKSPACE_ID, retried.id);
  assert.equal(completed.state, 'succeeded');
});

test('fences a running executor from publishing after cancellation', async (context) => {
  const { database, service, job } = await fixture(context);
  const originalFiles = service.sourceReader.files.bind(service.sourceReader);
  let releaseSource;
  let sourceEntered;
  const entered = new Promise((resolve) => { sourceEntered = resolve; });
  const released = new Promise((resolve) => { releaseSource = resolve; });
  service.sourceReader.files = async (...args) => {
    const sourceFiles = await originalFiles(...args);
    return {
      create: async function* create() {
        for await (const entry of sourceFiles.create()) {
          sourceEntered();
          await released;
          yield entry;
        }
      }
    };
  };

  const started = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await entered;
  const cancellation = service.cancel(WORKSPACE_ID, 'operator', started.id);
  releaseSource();
  const canceled = await cancellation;
  assert.equal(canceled.state, 'canceled');
  await service.wait(started.id);
  const persisted = await database.repository('run').get(WORKSPACE_ID, started.id);
  const group = await database.repository('executionGroup').get(WORKSPACE_ID, persisted.executionGroupId);
  assert.equal(persisted.state, 'canceled');
  assert.equal(group.state, 'canceled');
  assert.equal((await database.repository('recoveryPoint').list(WORKSPACE_ID)).length, 0);
  assert.equal((await database.repository('artifact').list(WORKSPACE_ID)).length, 0);
});

test('runs a manual file backup and atomically publishes progress and recovery records', async (context) => {
  const { database, service, logStore, job, repositories } = await fixture(context);
  const started = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  assert.equal(started.state, 'queued');
  assert.equal((await database.repository('executionGroup').list(WORKSPACE_ID)).length, 1);
  assert.equal((await database.repository('run').list(WORKSPACE_ID)).length, 1);

  await service.wait(started.id);
  const [completed] = await service.list(WORKSPACE_ID, { jobId: job.id });
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.progress.files, 1);
  assert.ok(completed.progress.directories >= 2);
  assert.equal(completed.progress.committedRepositories, 1);
  assert.equal(completed.result.recoveryPointIds.length, 1);
  assert.ok(completed.progress.bytesRead > 0);

  const [point] = await database.repository('recoveryPoint').list(WORKSPACE_ID);
  const [artifact] = await database.repository('artifact').list(WORKSPACE_ID);
  const [group] = await database.repository('executionGroup').list(WORKSPACE_ID);
  assert.equal(point.runId, completed.id);
  assert.equal(point.repositoryCopies[0].repositoryId, repositories[0].id);
  assert.deepEqual(point.retention.ruleMatches, ['last-n']);
  assert.equal(point.retention.deletionEligible, false);
  assert.equal(artifact.recoveryPointId, point.id);
  assert.equal(group.state, 'succeeded');
  assert.equal(group.terminalRunId, completed.id);

  assert.equal(completed.metrics.scannedItems, completed.progress.itemsScanned);
  assert.equal(completed.metrics.scannedBytes, completed.result.sourceBytes);
  assert.equal(completed.metrics.uploadedBytes, completed.result.uploadedBytes);
  assert.equal(completed.metrics.reusedBytes, completed.result.reusedBytes);
  assert.ok(completed.metrics.durationMs >= 0);
  const logs = await logStore.list(WORKSPACE_ID, { correlationId: completed.id, component: 'backup-run', limit: 20 });
  assert.ok(logs.some((entry) => entry.message === 'Backup run started.'));
  assert.ok(logs.some((entry) => entry.message === 'Repository copy committed.'));
  assert.ok(logs.some((entry) => entry.message === 'Backup run completed.'));
  assert.ok(logs.every((entry) => entry.correlationId === completed.id && entry.component === 'backup-run'));
});

test('preserves an earlier authenticated RecoveryPoint after ransomware-style mass source changes', async (context) => {
  const { database, service, openRepository, sourceRoot, job, repositories } = await fixture(context);
  const documentRoot = path.join(sourceRoot, 'documents');
  await fs.mkdir(documentRoot, { recursive: true });
  const cleanFiles = new Map();
  for (let index = 0; index < 12; index += 1) {
    const filePath = path.join(documentRoot, `document-${String(index).padStart(2, '0')}.txt`);
    const body = Buffer.from(`clean-business-record-${index}\n`.repeat(128), 'utf8');
    await fs.writeFile(filePath, body);
    cleanFiles.set(filePath.replace(/\\/g, '/'), body);
  }

  const cleanStarted = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(cleanStarted.id);
  const cleanRun = await database.repository('run').get(WORKSPACE_ID, cleanStarted.id);
  assert.equal(cleanRun.state, 'succeeded');
  const cleanPoint = await database.repository('recoveryPoint').get(WORKSPACE_ID, cleanRun.result.recoveryPointIds[0]);
  const cleanCopy = structuredClone(cleanPoint.repositoryCopies[0]);
  const openedRepository = await openRepository(WORKSPACE_ID, repositories[0].id);
  const readObject = async (key) => {
    const parts = [];
    for await (const part of await openedRepository.adapter.read({}, { key })) parts.push(Buffer.from(part));
    return Buffer.concat(parts);
  };
  const cleanManifestCiphertext = await readObject(cleanCopy.manifestLocator);
  const cleanSnapshot = await openedRepository.engine.openSnapshot({}, {
    repositoryId: repositories[0].id,
    snapshotId: cleanCopy.engineSnapshotId,
    masterKey: openedRepository.masterKey
  });

  await fs.rm(path.join(sourceRoot, 'nested'), { recursive: true, force: true });
  const paths = [...cleanFiles.keys()].map((archiveName) => archiveName.replace(/\//g, path.sep));
  for (let index = 0; index < paths.length; index += 1) {
    if (index < 4) {
      await fs.rm(paths[index]);
      continue;
    }
    const target = index < 8 ? `${paths[index]}.locked` : paths[index];
    if (target !== paths[index]) await fs.rename(paths[index], target);
    await fs.writeFile(target, Buffer.alloc(4096 + index, 0xa0 + index));
  }

  const changedStarted = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(changedStarted.id);
  const changedRun = await database.repository('run').get(WORKSPACE_ID, changedStarted.id);
  assert.equal(changedRun.state, 'succeeded');
  const changedPoint = await database.repository('recoveryPoint').get(WORKSPACE_ID, changedRun.result.recoveryPointIds[0]);
  assert.notEqual(changedPoint.id, cleanPoint.id);
  assert.notEqual(changedPoint.repositoryCopies[0].engineSnapshotId, cleanCopy.engineSnapshotId);

  const retainedPoint = await database.repository('recoveryPoint').get(WORKSPACE_ID, cleanPoint.id);
  assert.ok(retainedPoint);
  assert.deepEqual(retainedPoint.repositoryCopies[0], cleanCopy);
  assert.deepEqual(await readObject(cleanCopy.manifestLocator), cleanManifestCiphertext);

  const reopenedClean = await openedRepository.engine.openSnapshot({}, {
    repositoryId: repositories[0].id,
    snapshotId: cleanCopy.engineSnapshotId,
    masterKey: openedRepository.masterKey
  });
  assert.deepEqual(reopenedClean.manifest, cleanSnapshot.manifest);
  for (const [archiveName, expected] of cleanFiles) {
    const restored = await openedRepository.engine.readFile({}, {
      repositoryId: repositories[0].id,
      manifest: reopenedClean.manifest,
      path: archiveName,
      masterKey: openedRepository.masterKey
    });
    assert.deepEqual(restored, expected);
  }
});

test('notifies terminal backup success and failure without changing run outcomes', async (context) => {
  const notifications = [];
  const notificationService = { async notifyBackupRun(workspaceId, run) { notifications.push({ workspaceId, run }); } };
  const { database, service, job, repositories, openedRepositories } = await fixture(context, 1, { notificationService });
  const succeeded = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(succeeded.id);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].workspaceId, WORKSPACE_ID);
  assert.equal(notifications[0].run.state, 'succeeded');

  const policy = await database.repository('policy').get(WORKSPACE_ID, job.policyId);
  await database.repository('policy').update(WORKSPACE_ID, policy.id, {
    retry: { ...policy.retry, maximumAttempts: 1 }
  }, { expectedRevision: policy.revision, actorId: ACTOR_ID });
  const opened = openedRepositories.get(repositories[0].id);
  const openSnapshot = opened.engine.openSnapshot.bind(opened.engine);
  opened.engine.openSnapshot = async (...args) => {
    const result = await openSnapshot(...args);
    result.summary.manifestChecksum.digest = '0'.repeat(64);
    return result;
  };
  const failed = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(failed.id);
  const interrupted = (await service.list(WORKSPACE_ID, { jobId: job.id })).find((run) => run.id === failed.id);
  assert.equal(interrupted.state, 'interrupted');
  await service.failInterrupted(WORKSPACE_ID, ACTOR_ID, failed.id, { safeErrorCode: 'BACKUP_RETRY_LIMIT_REACHED', safeMessage: 'Retry limit reached.', category: 'execution' });
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].run.state, 'failed');
  assert.equal((await service.list(WORKSPACE_ID, { jobId: job.id }))[0].state, 'failed');
});

test('atomically reclassifies older recovery points against the immutable retention snapshot', async (context) => {
  const { database, service, job } = await fixture(context);
  const policy = await database.repository('policy').get(WORKSPACE_ID, job.policyId);
  await database.repository('policy').update(WORKSPACE_ID, policy.id, {
    retention: { version: 1, timezone: 'UTC', keepLast: 1, hourly: 0, daily: 0, weekly: 0, monthly: 0, yearly: 0, legalHold: false }
  }, { expectedRevision: policy.revision, actorId: ACTOR_ID });
  const first = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(first.id);
  const second = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(second.id);
  const points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 10 });
  assert.equal(points.length, 2);
  const newest = points.slice().sort((left, right) => String(right.capturedTo).localeCompare(String(left.capturedTo)) || right.id.localeCompare(left.id, 'en-US'))[0];
  const oldest = points.find((point) => point.id !== newest.id);
  assert.deepEqual(newest.retention.ruleMatches, ['last-n']);
  assert.equal(newest.retention.deletionEligible, false);
  assert.deepEqual(oldest.retention.ruleMatches, []);
  assert.equal(oldest.retention.deletionEligible, true);
  assert.ok(Number.isFinite(Date.parse(oldest.retention.expireAt)));
  assert.equal(oldest.retention.policyRevision, 2);
});

test('resumes a partial multi-repository run without rewriting a committed repository', async (context) => {
  const { database, service, job, repositories, openedRepositories } = await fixture(context, 2);
  const primary = openedRepositories.get(repositories[0].id);
  const copy = openedRepositories.get(repositories[1].id);
  const primaryCreateSnapshot = primary.engine.createSnapshot.bind(primary.engine);
  let primaryCreates = 0;
  primary.engine.createSnapshot = async (...args) => {
    primaryCreates += 1;
    return primaryCreateSnapshot(...args);
  };
  const copyCreateSnapshot = copy.engine.createSnapshot.bind(copy.engine);
  copy.engine.createSnapshot = async () => {
    throw new ManualBackupError('BACKUP_DESTINATION_TEMPORARILY_UNAVAILABLE', 'The copy repository is temporarily unavailable.', { retryable: true });
  };

  const first = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(first.id);
  const interrupted = (await service.list(WORKSPACE_ID, { jobId: job.id })).find((run) => run.id === first.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.resumable, true);
  assert.equal(interrupted.progress.committedRepositories, 1);
  assert.equal(primaryCreates, 1);

  copy.engine.createSnapshot = copyCreateSnapshot;
  const resumed = await service.resume(WORKSPACE_ID, ACTOR_ID, interrupted.id);
  await service.wait(resumed.id);
  const completed = (await service.list(WORKSPACE_ID, { jobId: job.id })).find((run) => run.id === resumed.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.attempt, 2);
  assert.equal(completed.parentRunId, interrupted.id);
  assert.equal(completed.progress.committedRepositories, 2);
  assert.equal(primaryCreates, 1);
  assert.equal((await database.repository('recoveryPoint').list(WORKSPACE_ID)).length, 1);
});

test('refuses to publish a recovery point when manifest verification fails', async (context) => {
  const { database, service, job, repositories, openedRepositories } = await fixture(context);
  const opened = openedRepositories.get(repositories[0].id);
  const openSnapshot = opened.engine.openSnapshot.bind(opened.engine);
  let calls = 0;
  opened.engine.openSnapshot = async (...args) => {
    const result = await openSnapshot(...args);
    calls += 1;
    if (calls === 1) result.summary.manifestChecksum.digest = '0'.repeat(64);
    return result;
  };
  const started = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(started.id);
  const [interrupted] = await service.list(WORKSPACE_ID, { jobId: job.id });
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.result.safeErrorCode, 'BACKUP_MANIFEST_VERIFICATION_FAILED');
  assert.equal((await database.repository('recoveryPoint').list(WORKSPACE_ID)).length, 0);
});

test('fails closed when an advertised encrypted checkpoint is missing', async (context) => {
  const { service, checkpointStore, job, repositories, openedRepositories } = await fixture(context);
  const opened = openedRepositories.get(repositories[0].id);
  const openSnapshot = opened.engine.openSnapshot.bind(opened.engine);
  opened.engine.openSnapshot = async (...args) => {
    const result = await openSnapshot(...args);
    result.summary.manifestChecksum.digest = '0'.repeat(64);
    return result;
  };
  const started = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(started.id);
  const [interrupted] = await service.list(WORKSPACE_ID, { jobId: job.id });
  assert.equal(interrupted.resumable, true);
  await checkpointStore.remove(WORKSPACE_ID, interrupted.id);
  await assert.rejects(
    service.resume(WORKSPACE_ID, ACTOR_ID, interrupted.id),
    (error) => error.code === 'BACKUP_RUN_CHECKPOINT_INVALID'
  );
});

test('checks live capacity under the mutation lease before writing repository objects', async (context) => {
  const { database, service, job, repositories, openedRepositories } = await fixture(context);
  const repository = repositories[0];
  const updatedRepository = await database.repository('repository').update(WORKSPACE_ID, repository.id, {
    storagePolicy: { version: 1, quotaBytes: null, reserveBytes: 0, reservePercent: 5, warningPercent: 15, criticalPercent: 5, minimumBackupBytes: 1, requireCapacityProof: true }
  }, { expectedRevision: repository.revision, actorId: ACTOR_ID });
  const opened = openedRepositories.get(repository.id);
  opened.repository = updatedRepository;
  opened.adapter.getCapacity = async () => ({ reporting: 'unavailable', measuredAt: '2026-08-03T12:00:00.000Z' });
  let snapshotCalls = 0;
  const createSnapshot = opened.engine.createSnapshot.bind(opened.engine);
  opened.engine.createSnapshot = async (...args) => { snapshotCalls += 1; return createSnapshot(...args); };

  const started = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  await service.wait(started.id);
  const failed = await database.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(failed.state, 'interrupted');
  assert.equal(failed.result.safeErrorCode, 'BACKUP_REPOSITORY_CAPACITY_BLOCKED');
  assert.equal(failed.result.category, 'capacity');
  assert.equal(snapshotCalls, 0);

  const lease = await opened.adapter.acquireLock({ masterKey: opened.masterKey }, {
    repositoryId: repository.id, operation: 'test', scope: `repository:${repository.id}:mutation`, workerId: 'test-worker', runId: 'test-run', ttlMs: 5000
  });
  await opened.adapter.releaseLock({ masterKey: opened.masterKey }, lease);
});

test('captures connection credential versions and rejects other-device execution', async (context) => {
  const { database, service, connection, job } = await fixture(context);
  const updated = await database.repository('connection').update(WORKSPACE_ID, connection.id, {
    workerAffinity: ['device:another-device']
  }, { expectedRevision: connection.revision, actorId: ACTOR_ID });
  await assert.rejects(service.start(WORKSPACE_ID, ACTOR_ID, job.id), (error) => error.code === 'FILE_SOURCE_OTHER_DEVICE');
  await database.repository('connection').update(WORKSPACE_ID, updated.id, {
    workerAffinity: [`device:${DEVICE_ID}`]
  }, { expectedRevision: updated.revision, actorId: ACTOR_ID });
  const started = await service.start(WORKSPACE_ID, ACTOR_ID, job.id);
  const persisted = await database.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(persisted.configSnapshot.connection.id, connection.id);
  assert.equal(persisted.configSnapshot.connection.revision, updated.revision + 1);
  await service.wait(started.id);
});

test('reconciles a queued run left behind by a stopped process', async (context) => {
  const { database, service, job } = await fixture(context);
  const records = await database.transaction((transaction) => {
    const group = transaction.create('executionGroup', {
      workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, jobId: job.id, jobRevision: job.revision,
      trigger: 'manual', idempotencyKey: 'manual:orphan', state: 'pending'
    });
    const run = transaction.create('run', {
      workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, jobId: job.id, jobRevision: job.revision,
      executionGroupId: group.id, idempotencyKey: 'manual:orphan:attempt:1', trigger: 'manual',
      workerId: `device:${DEVICE_ID}`, state: 'queued', attempt: 1, configSnapshot: {}, progress: {}, checkpoint: { available: false }
    });
    return { group, run };
  });
  const reconciled = await service.reconcile(WORKSPACE_ID, 'system', { force: true });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, records.run.id);
  assert.equal(reconciled[0].state, 'interrupted');
  assert.equal(reconciled[0].result.safeErrorCode, 'BACKUP_RUN_PROCESS_INTERRUPTED');
});

test('creates exactly one Run for duplicate scheduled occurrence delivery', async (context) => {
  const { database, service, job } = await fixture(context);
  const scheduledFor = '2026-08-03T13:00:00.000Z';
  const [first, duplicate] = await Promise.all([
    service.startScheduled(WORKSPACE_ID, 'backup-worker', job.id, scheduledFor),
    service.startScheduled(WORKSPACE_ID, 'backup-worker', job.id, scheduledFor)
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal([first.occurrenceCreated, duplicate.occurrenceCreated].filter(Boolean).length, 1);
  assert.equal((await database.repository('executionGroup').list(WORKSPACE_ID)).length, 1);
  assert.equal((await database.repository('run').list(WORKSPACE_ID)).length, 1);
  await service.wait(first.id);
});
