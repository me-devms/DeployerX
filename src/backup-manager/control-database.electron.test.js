const { app } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');

app.whenReady().then(async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-control-electron-test-'));
  try {
    const control = new BackupControlDatabase({ rootPath });
    await control.initialize();
    const record = await control.repository('connection').create({
      workspaceId: 'local',
      name: 'Electron local computer',
      kind: 'local',
      adapterId: 'deployerx.local',
      adapterVersion: '1.0.0',
      scope: 'device',
      endpoint: {},
      secretRefIds: [],
      trust: {},
      workerAffinity: []
    });
    await control.close();
    process.stdout.write(`${JSON.stringify({ ok: true, idPrefix: record.id.split('_')[0], bytes: (await fs.stat(path.join(rootPath, 'control.db'))).size })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
    app.quit();
  }
});
