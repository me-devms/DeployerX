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
const { RepositoryVerificationService } = require('./repository-verification');
const { BackupSecretStore } = require('./secrets');
const { SnapshotBrowserService } = require('./snapshot-browser');

const WORKSPACE_ID = 'local';
const ACTOR_ID = 'repository-verification-electron-test';
const DEVICE_ID = 'repository-verification-electron-device';

app.whenReady().then(async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-repository-verification-electron-'));
  const sourceRoot = path.join(rootPath, 'source');
  const repositoryRoot = path.join(rootPath, 'repository');
  let controlDatabase;
  try {
    await fs.mkdir(path.join(sourceRoot, 'nested'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'first.txt'), 'first authenticated file', 'utf8');
    await fs.writeFile(path.join(sourceRoot, 'nested', 'second.txt'), 'second authenticated file with more bytes', 'utf8');
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
      name: 'Verification integration source', connectionId: connection.id,
      selector: { roots: [{ path: sourceRoot, type: 'directory' }], includePatterns: [], excludePatterns: [], options: { includeHidden: false, crossMounts: false, followSymbolicLinks: false }, metadataPolicy: { preserve: {} } }
    });
    const localRepositories = new LocalRepositoryService({ controlDatabase, secretStore, deviceId: DEVICE_ID });
    const repository = await localRepositories.create(WORKSPACE_ID, ACTOR_ID, { name: 'Verification integration repository', rootPath: repositoryRoot });
    const created = await new BackupJobService({ controlDatabase, deviceId: DEVICE_ID }).create(WORKSPACE_ID, ACTOR_ID, {
      name: 'Verification integration protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'incremental', verifyAfterBackup: true
    });
    const openRepository = async (workspaceId, repositoryId) => {
      const record = await controlDatabase.repository('repository').get(workspaceId, repositoryId);
      if (!record || record.adapterId !== LOCAL_REPOSITORY_ADAPTER_ID) throw new Error('Verification integration repository was not found.');
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
    const verification = new RepositoryVerificationService({ controlDatabase, snapshotBrowser: browser, deviceId: DEVICE_ID });
    const sampleStart = await verification.start(WORKSPACE_ID, ACTOR_ID, { mode: 'sample-restore', recoveryPointId: point.id, repositoryId: repository.id, samplePercent: 100 });
    const sample = await verification.wait(WORKSPACE_ID, sampleStart.id);
    const checksumStart = await verification.start(WORKSPACE_ID, ACTOR_ID, { mode: 'checksum', repositoryId: repository.id });
    const checksum = await verification.wait(WORKSPACE_ID, checksumStart.id);
    const runs = await verification.list(WORKSPACE_ID);
    const noWindows = BrowserWindow.getAllWindows().length === 0;
    const expectedBytes = Buffer.byteLength('first authenticated file') + Buffer.byteLength('second authenticated file with more bytes');
    const ok = sample.state === 'succeeded' && sample.result.filesVerified === 2 && sample.result.bytesVerified === expectedBytes
      && checksum.state === 'succeeded' && checksum.result.recoveryPointsVerified === 1 && checksum.result.filesVerified === 2 && checksum.result.bytesVerified === expectedBytes
      && sample.result.evidenceDigest.digest.length === 64 && checksum.result.evidenceDigest.digest.length === 64
      && runs.length === 2 && noWindows;
    process.stdout.write(`${JSON.stringify({ ok, sampleState: sample.state, sampleFiles: sample.result.filesVerified, checksumState: checksum.state, checksumPoints: checksum.result.recoveryPointsVerified, checksumFiles: checksum.result.filesVerified, verifiedBytes: checksum.result.bytesVerified, verificationRunCount: runs.length, noWindows })}\n`);
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
