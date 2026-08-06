const { app, BrowserWindow, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { FileRestoreService, LocalRestoreTarget } = require('./file-restore');
const { FileSourceReaderService } = require('./file-source-reader');
const { FileSourceService } = require('./file-selection');
const { LocalConnectionService } = require('./local-connection');
const { ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID, LocalRepositoryService } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { RunCheckpointStore } = require('./run-checkpoint');
const { BackupSecretStore } = require('./secrets');
const { SnapshotBrowserService } = require('./snapshot-browser');

const WORKSPACE_ID = 'local';
const ACTOR_ID = 'file-restore-electron-test';
const DEVICE_ID = 'file-restore-electron-device';

app.whenReady().then(async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-file-restore-electron-'));
  const sourceRoot = path.join(rootPath, 'source');
  const repositoryRoot = path.join(rootPath, 'repository');
  const destinationRoot = path.join(rootPath, 'destination');
  const sourceFile = path.join(sourceRoot, 'nested', 'restore.txt');
  let controlDatabase;
  try {
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.mkdir(destinationRoot, { recursive: true });
    await fs.writeFile(sourceFile, 'authenticated encrypted restore content', 'utf8');
    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({
      rootPath,
      secureStorage: safeStorage,
      isReferenced: async ({ workspaceId, id }) => (await controlDatabase.repository('repository').list(workspaceId, { includeDeleted: true, limit: 1000 }))
        .some((repository) => repository.encryptionKeyRefId === id || (!repository.deletedAt && (repository.secretRefIds || []).includes(id)))
    });
    await secretStore.initialize();
    const localConnections = new LocalConnectionService({ controlDatabase, deviceId: DEVICE_ID });
    const connection = await localConnections.ensure(WORKSPACE_ID, ACTOR_ID);
    await localConnections.test(WORKSPACE_ID, connection.id, ACTOR_ID);
    const source = await new FileSourceService({ controlDatabase }).save(WORKSPACE_ID, ACTOR_ID, {
      name: 'Restore integration source', connectionId: connection.id,
      selector: { roots: [{ path: sourceRoot, type: 'directory' }], includePatterns: [], excludePatterns: [], options: { includeHidden: false, crossMounts: false, followSymbolicLinks: false }, metadataPolicy: { preserve: {} } }
    });
    const localRepositories = new LocalRepositoryService({ controlDatabase, secretStore, deviceId: DEVICE_ID });
    const repository = await localRepositories.create(WORKSPACE_ID, ACTOR_ID, { name: 'Restore integration repository', rootPath: repositoryRoot });
    const created = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, ACTOR_ID, {
      name: 'Restore integration protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'incremental', verifyAfterBackup: true
    });
    const openRepository = async (workspaceId, repositoryId) => {
      const record = await controlDatabase.repository('repository').get(workspaceId, repositoryId);
      if (!record || record.adapterId !== LOCAL_REPOSITORY_ADAPTER_ID) throw new Error('Restore integration repository was not found.');
      return localRepositories.open(workspaceId, repositoryId);
    };
    const manual = new ManualBackupService({
      controlDatabase,
      sourceReader: new FileSourceReaderService({ controlDatabase, secretStore, deviceId: DEVICE_ID }),
      checkpointStore: new RunCheckpointStore({ rootPath: path.join(rootPath, 'checkpoints') }),
      deviceId: DEVICE_ID,
      openRepository
    });
    const backup = await manual.start(WORKSPACE_ID, ACTOR_ID, created.job.id);
    await manual.wait(backup.id);
    const browser = new SnapshotBrowserService({ controlDatabase, openRepository });
    const point = (await browser.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 })).items[0];
    const entry = (await browser.search(WORKSPACE_ID, { recoveryPointId: point.id, query: 'restore.txt', type: 'file' })).items[0];
    const restore = new FileRestoreService({ controlDatabase, snapshotBrowser: browser, deviceId: DEVICE_ID, createTarget: () => new LocalRestoreTarget() });
    const targetPath = new LocalRestoreTarget().alternatePath(destinationRoot, entry.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, 'existing content', 'utf8');

    const failedStart = await restore.start(WORKSPACE_ID, ACTOR_ID, { recoveryPointId: point.id, targetConnectionId: connection.id, mode: 'alternate', destinationPath: destinationRoot, conflictPolicy: 'fail', paths: [entry.path] });
    const failed = await restore.wait(WORKSPACE_ID, failedStart.id);
    const unchanged = await fs.readFile(targetPath, 'utf8');
    const renamedStart = await restore.start(WORKSPACE_ID, ACTOR_ID, { recoveryPointId: point.id, targetConnectionId: connection.id, mode: 'alternate', destinationPath: destinationRoot, conflictPolicy: 'rename', paths: [entry.path] });
    const renamed = await restore.wait(WORKSPACE_ID, renamedStart.id);
    const renamedPath = path.join(path.dirname(targetPath), 'restore (restored 1).txt');
    const restoredContent = await fs.readFile(renamedPath, 'utf8');
    const restoreRuns = await restore.list(WORKSPACE_ID);
    const noWindows = BrowserWindow.getAllWindows().length === 0;
    const ok = failed.state === 'failed' && failed.result.error.code === 'RESTORE_CONFLICT' && unchanged === 'existing content'
      && renamed.state === 'succeeded' && restoredContent === 'authenticated encrypted restore content'
      && renamed.validation.state === 'succeeded' && renamed.result.bytesRestored === Buffer.byteLength(restoredContent)
      && restoreRuns.length === 2 && noWindows;
    process.stdout.write(`${JSON.stringify({ ok, failedState: failed.state, failedCode: failed.result.error.code, unchanged, renamedState: renamed.state, restoredContent, verifiedBytes: renamed.result.bytesRestored, restoreRunCount: restoreRuns.length, noWindows })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await controlDatabase?.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    app.quit();
  }
});
