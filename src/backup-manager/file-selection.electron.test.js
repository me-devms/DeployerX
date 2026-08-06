const { app } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { FileSourceService } = require('./file-selection');

app.whenReady().then(async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-file-selection-electron-test-'));
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const connection = await controlDatabase.repository('connection').create({
      workspaceId: 'local', actorId: 'electron-test', name: 'Local', kind: 'local',
      adapterId: 'deployerx.connection.local', endpoint: { platform: 'windows', architecture: 'x64' }
    });
    const service = new FileSourceService({ controlDatabase });
    const source = await service.save('local', 'electron-test', {
      name: 'Electron files',
      connectionId: connection.id,
      selector: {
        roots: [{ path: 'C:\\Users\\Test\\Documents', type: 'directory' }],
        includePatterns: ['**/*.docx'],
        excludePatterns: ['**/~$*'],
        options: { includeHidden: false, crossMounts: false }
      }
    });
    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const persisted = await controlDatabase.repository('source').get('local', source.id);
    const metadataPolicyPersisted = persisted.selector.metadataPolicy?.preserve?.timestamps === true
      && persisted.selector.metadataPolicy?.preserve?.hardLinks === true
      && persisted.selector.metadataPolicy?.preserve?.permissions === false
      && persisted.platform?.metadataCapabilities?.hardLinks === true;
    process.stdout.write(`${JSON.stringify({
      ok: metadataPolicyPersisted,
      adapterId: persisted.adapterId,
      rootCount: persisted.selector.roots.length,
      includePatterns: persisted.selector.includePatterns.length,
      excludePatterns: persisted.selector.excludePatterns.length,
      digestLength: persisted.selector.digest.length,
      includeHidden: persisted.selector.options.includeHidden,
      crossMounts: persisted.selector.options.crossMounts,
      metadataPolicyPersisted
    })}\n`);
    if (!metadataPolicyPersisted) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await controlDatabase?.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    app.quit();
  }
});
