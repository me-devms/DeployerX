const { app } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { LocalConnectionService, loadOrCreateBackupDeviceId } = require('./local-connection');

app.whenReady().then(async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-local-connection-electron-test-'));
  try {
    const controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const deviceId = await loadOrCreateBackupDeviceId(rootPath);
    const service = new LocalConnectionService({ controlDatabase, deviceId });
    const connection = await service.ensure('local', 'electron-test');
    const tested = await service.test('local', connection.id, 'electron-test');
    const listing = await service.browse('local', connection.id, { pageSize: 5 });
    await controlDatabase.close();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      adapterId: connection.adapterId,
      status: tested.result.status,
      scope: connection.scope,
      secretRefs: connection.secretRefIds.length,
      browsePath: listing.path,
      browseItems: listing.items.length,
      browseBounded: listing.items.length <= 5
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
    app.quit();
  }
});
