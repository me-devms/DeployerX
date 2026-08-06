const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { BackupSecretStore } = require('./secrets');
const { LocalRepositoryService, STORE_DIRECTORY } = require('./local-repository');

app.whenReady().then(async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-local-repository-electron-test-'));
  const destinationPath = path.join(rootPath, 'repository-folder');
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({
      rootPath,
      secureStorage: safeStorage,
      isReferenced: async ({ workspaceId, id }) => (await controlDatabase.repository('repository').list(workspaceId, { includeDeleted: true, limit: 1000 }))
        .some((repository) => repository.encryptionKeyRefId === id || (!repository.deletedAt && (repository.secretRefIds || []).includes(id)))
    });
    await secretStore.initialize();
    let service = new LocalRepositoryService({ controlDatabase, secretStore, deviceId: 'device-electron' });
    const repository = await service.create('local', 'electron-test', { name: 'Electron local archive', rootPath: destinationPath });
    const opened = await service.open('local', repository.id);
    const plaintext = Buffer.from('electron local repository plaintext');
    const sourcePath = '/electron/private.txt';
    const snapshot = await opened.engine.createSnapshot({}, {
      repositoryId: repository.id,
      keyVersion: opened.keyVersion,
      masterKey: opened.masterKey,
      idempotencyKey: 'electron-local-run',
      files: [{ path: sourcePath, type: 'file', metadata: null, content: plaintext }]
    });

    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    service = new LocalRepositoryService({ controlDatabase, secretStore, deviceId: 'device-electron' });
    const reopened = await service.open('local', repository.id);
    const manifest = await reopened.engine.openSnapshot({}, { repositoryId: repository.id, snapshotId: snapshot.snapshotId, masterKey: reopened.masterKey });
    const restored = await reopened.engine.readFile({}, { repositoryId: repository.id, manifest: manifest.manifest, path: sourcePath, masterKey: reopened.masterKey });
    const manifestPath = path.join(destinationPath, STORE_DIRECTORY, 'objects', ...snapshot.manifestKey.split('/'));
    const persistedManifest = await fs.readFile(manifestPath);
    const removed = await service.remove('local', 'electron-test', repository.id, (await service.list('local'))[0].revision);
    const dataRetained = (await fs.stat(manifestPath)).isFile() && removed.dataRetainedAt === destinationPath;
    const ok = repository.health.status === 'ready'
      && restored.equals(plaintext)
      && !persistedManifest.includes(plaintext)
      && !persistedManifest.includes(Buffer.from(sourcePath))
      && dataRetained
      && (await service.list('local')).length === 0
      && (await secretStore.list('local')).length === 1
      && removed.encryptionKeyRetained;
    process.stdout.write(`${JSON.stringify({ ok, adapterId: repository.adapterId, health: repository.health.status, snapshotId: snapshot.snapshotId, restored: restored.equals(plaintext), encrypted: !persistedManifest.includes(plaintext), dataRetained, encryptionKeyRetained: removed.encryptionKeyRetained })}\n`);
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
