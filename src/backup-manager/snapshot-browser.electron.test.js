const { app, BrowserWindow, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { FileSourceReaderService } = require('./file-source-reader');
const { FileSourceService } = require('./file-selection');
const { LocalConnectionService } = require('./local-connection');
const { ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID, LocalRepositoryService } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { RunCheckpointStore } = require('./run-checkpoint');
const { BackupSecretStore } = require('./secrets');
const { SnapshotBrowserService } = require('./snapshot-browser');

const WORKSPACE_ID = 'local';
const ACTOR_ID = 'snapshot-browser-electron-test';
const DEVICE_ID = 'snapshot-browser-electron-device';

app.whenReady().then(async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-snapshot-browser-electron-test-'));
  const sourceRoot = path.join(rootPath, 'source');
  const repositoryRoot = path.join(rootPath, 'repository');
  const sourceFile = path.join(sourceRoot, 'nested', 'history.txt');
  let controlDatabase;
  try {
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, 'first protected version', 'utf8');
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
      name: 'Versioned application files',
      connectionId: connection.id,
      selector: {
        roots: [{ path: sourceRoot, type: 'directory' }],
        includePatterns: [],
        excludePatterns: [],
        options: { includeHidden: false, crossMounts: false, followSymbolicLinks: false },
        metadataPolicy: { preserve: {} }
      }
    });
    const localRepositories = new LocalRepositoryService({ controlDatabase, secretStore, deviceId: DEVICE_ID });
    const repository = await localRepositories.create(WORKSPACE_ID, ACTOR_ID, { name: 'Version history archive', rootPath: repositoryRoot });
    const created = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, ACTOR_ID, {
      name: 'Version history protection',
      sourceId: source.id,
      repositoryIds: [repository.id],
      backupMode: 'incremental',
      verifyAfterBackup: true
    });
    const sourceReader = new FileSourceReaderService({ controlDatabase, secretStore, deviceId: DEVICE_ID });
    const checkpointStore = new RunCheckpointStore({ rootPath: path.join(rootPath, 'checkpoints') });
    const openRepository = async (workspaceId, repositoryId) => {
      const record = await controlDatabase.repository('repository').get(workspaceId, repositoryId);
      if (!record || record.adapterId !== LOCAL_REPOSITORY_ADAPTER_ID) throw new Error('Snapshot browser test repository was not found.');
      return localRepositories.open(workspaceId, repositoryId);
    };
    const manual = new ManualBackupService({ controlDatabase, sourceReader, checkpointStore, deviceId: DEVICE_ID, openRepository });
    const first = await manual.start(WORKSPACE_ID, ACTOR_ID, created.job.id);
    await manual.wait(first.id);
    await fs.writeFile(sourceFile, 'second protected version with changed content', 'utf8');
    const second = await manual.start(WORKSPACE_ID, ACTOR_ID, created.job.id);
    await manual.wait(second.id);

    const browser = new SnapshotBrowserService({ controlDatabase, openRepository });
    const catalog = await browser.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
    const latest = catalog.items[0];
    const search = await browser.search(WORKSPACE_ID, { recoveryPointId: latest.id, query: 'history.txt', type: 'file' });
    const entry = search.items[0];
    const directory = await browser.browse(WORKSPACE_ID, { recoveryPointId: latest.id, path: entry.parentPath });
    const versions = await browser.fileVersions(WORKSPACE_ID, { recoveryPointId: latest.id, path: entry.path });
    const noWindows = BrowserWindow.getAllWindows().length === 0;
    const ok = catalog.total === 2 && latest.type === 'incremental'
      && search.total === 1 && entry.name === 'history.txt'
      && directory.items.some((item) => item.path === entry.path)
      && versions.versions.length === 2
      && versions.versions[0].change === 'modified' && versions.versions[1].change === 'added'
      && versions.versions[0].entry.sizeBytes !== versions.versions[1].entry.sizeBytes
      && noWindows;
    process.stdout.write(`${JSON.stringify({ ok, recoveryPointCount: catalog.total, latestType: latest.type, searchCount: search.total, browsedPath: entry.parentPath, versionChanges: versions.versions.map((version) => version.change), noWindows })}\n`);
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
