const { app, BrowserWindow, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DateTime } = require('luxon');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { FileSourceReaderService } = require('./file-source-reader');
const { FileSourceService } = require('./file-selection');
const { LocalConnectionService } = require('./local-connection');
const { ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID, LocalRepositoryService } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { RunCheckpointStore } = require('./run-checkpoint');
const { ScheduledBackupWorkerService } = require('./scheduled-backup-worker');
const { nextOccurrence } = require('./schedule');
const { BackupSecretStore } = require('./secrets');

const WORKSPACE_ID = 'local';
const ACTOR_ID = 'electron-scheduled-worker-test';
const DEVICE_ID = 'electron-scheduled-worker-device';
const CHILD_ARGUMENT = '--scheduled-worker-child';

function createSecretStore(rootPath, controlDatabase) {
  return new BackupSecretStore({
    rootPath,
    secureStorage: safeStorage,
    isReferenced: async ({ workspaceId, id }) => (await controlDatabase.repository('repository').list(workspaceId, { includeDeleted: true, limit: 1000 }))
      .some((repository) => repository.encryptionKeyRefId === id || (!repository.deletedAt && (repository.secretRefIds || []).includes(id)))
  });
}

async function createExecutionServices(rootPath, controlDatabase) {
  const secretStore = createSecretStore(rootPath, controlDatabase);
  await secretStore.initialize();
  const localRepositories = new LocalRepositoryService({ controlDatabase, secretStore, deviceId: DEVICE_ID });
  const sourceReader = new FileSourceReaderService({ controlDatabase, secretStore, deviceId: DEVICE_ID });
  const checkpointStore = new RunCheckpointStore({ rootPath: path.join(rootPath, 'checkpoints') });
  const openRepository = async (workspaceId, repositoryId) => {
    const repository = await controlDatabase.repository('repository').get(workspaceId, repositoryId);
    if (!repository || repository.adapterId !== LOCAL_REPOSITORY_ADAPTER_ID) throw new Error('Scheduled worker test repository was not found.');
    return localRepositories.open(workspaceId, repositoryId);
  };
  const manualBackupService = new ManualBackupService({ controlDatabase, sourceReader, checkpointStore, deviceId: DEVICE_ID, openRepository });
  return { localRepositories, manualBackupService };
}

async function runChild(rootPath) {
  let controlDatabase;
  let worker;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const { manualBackupService } = await createExecutionServices(rootPath, controlDatabase);
    worker = new ScheduledBackupWorkerService({
      controlDatabase,
      manualBackupService,
      deviceId: DEVICE_ID,
      autoTimers: false
    });
    await worker.start(WORKSPACE_ID, ACTOR_ID);
    const [started] = await manualBackupService.list(WORKSPACE_ID, { limit: 10 });
    if (!started) throw new Error('The due scheduled occurrence was not dispatched.');
    await manualBackupService.wait(started.id);
    await worker.tick();
    const [run] = await manualBackupService.list(WORKSPACE_ID, { limit: 10 });
    const recoveryPoints = await controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 10 });
    const noWindows = BrowserWindow.getAllWindows().length === 0;
    const ok = run?.state === 'succeeded' && run.trigger === 'schedule' && recoveryPoints.length === 1 && noWindows;
    process.stdout.write(`${JSON.stringify({ ok, phase: 'worker', runId: run?.id || null, runState: run?.state || null, trigger: run?.trigger || null, recoveryPointCount: recoveryPoints.length, noWindows })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await worker?.stop({ drain: true }).catch(() => {});
    await controlDatabase?.close().catch(() => {});
    app.quit();
  }
}

function spawnWorker(rootPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, CHILD_ARGUMENT, rootPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runParent() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-scheduled-worker-electron-test-'));
  const sourceRoot = path.join(rootPath, 'source');
  const repositoryRoot = path.join(rootPath, 'repository');
  let controlDatabase;
  try {
    await fs.mkdir(path.join(sourceRoot, 'nested'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'nested', 'scheduled.txt'), 'persistent scheduled backup payload', 'utf8');
    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const { localRepositories } = await createExecutionServices(rootPath, controlDatabase);
    const localConnections = new LocalConnectionService({ controlDatabase, deviceId: DEVICE_ID });
    const connection = await localConnections.ensure(WORKSPACE_ID, ACTOR_ID);
    await localConnections.test(WORKSPACE_ID, connection.id, ACTOR_ID);
    const source = await new FileSourceService({ controlDatabase }).save(WORKSPACE_ID, ACTOR_ID, {
      name: 'Scheduled local files',
      connectionId: connection.id,
      selector: {
        roots: [{ path: sourceRoot, type: 'directory' }],
        includePatterns: [],
        excludePatterns: [],
        options: { includeHidden: false, crossMounts: false, followSymbolicLinks: false },
        metadataPolicy: { preserve: {} }
      }
    });
    const repository = await localRepositories.create(WORKSPACE_ID, ACTOR_ID, { name: 'Scheduled local archive', rootPath: repositoryRoot });
    const dueDate = new Date(Date.now() - 60000);
    const dueAt = dueDate.toISOString();
    const timezone = 'America/New_York';
    const localDue = DateTime.fromJSDate(dueDate, { zone: timezone });
    const dailyTime = `${String(localDue.hour).padStart(2, '0')}:${String(localDue.minute).padStart(2, '0')}`;
    const created = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, ACTOR_ID, {
      name: 'Persistent scheduled backup',
      sourceId: source.id,
      repositoryIds: [repository.id],
      backupMode: 'incremental',
      verifyAfterBackup: true,
      schedule: {
        type: 'daily', time: dailyTime, timezone,
        dstBehavior: { nonexistentTime: 'shift-forward', ambiguousTime: 'both' },
        missedRun: { behavior: 'run-latest', graceMinutes: 15 }
      }
    });
    const expectedNextRunAt = nextOccurrence(created.policy.schedule, dueAt);
    await controlDatabase.repository('backupJob').update(WORKSPACE_ID, created.job.id, { nextRunAt: dueAt }, { expectedRevision: created.job.revision, actorId: ACTOR_ID });
    await controlDatabase.close();
    controlDatabase = null;

    const child = await spawnWorker(rootPath);
    if (child.code !== 0) throw new Error(`Scheduled worker child failed (${child.code}).\n${child.stderr || child.stdout}`);
    const childResult = child.stdout.trim().split(/\r?\n/).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((entry) => entry?.phase === 'worker');

    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const [run] = await controlDatabase.repository('run').list(WORKSPACE_ID, { limit: 10 });
    const recoveryPoints = await controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 10 });
    const job = await controlDatabase.repository('backupJob').get(WORKSPACE_ID, created.job.id);
    const noWindows = BrowserWindow.getAllWindows().length === 0;
    const ok = childResult?.ok === true && run?.state === 'succeeded' && run.trigger === 'schedule'
      && recoveryPoints.length === 1 && recoveryPoints[0].runId === run.id && job.nextRunAt === expectedNextRunAt && noWindows;
    process.stdout.write(`${JSON.stringify({ ok, child: childResult, persistedRunState: run?.state || null, persistedTrigger: run?.trigger || null, recoveryPointCount: recoveryPoints.length, timezone: created.policy.schedule.timezone, nextRunAt: job.nextRunAt, expectedNextRunAt, noWindows })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await controlDatabase?.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    app.quit();
  }
}

app.whenReady().then(() => process.argv.includes(CHILD_ARGUMENT)
  ? runChild(process.argv[process.argv.indexOf(CHILD_ARGUMENT) + 1])
  : runParent());
