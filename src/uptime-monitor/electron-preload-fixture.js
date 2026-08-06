const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

async function main() {
  await app.whenReady();
  ipcMain.handle('uptime:worker:status', () => ({
    uptimeIpcVersion: 1,
    ok: true,
    value: { active: true, state: 'active' }
  }));

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  try {
    await window.loadURL('data:text/html,<title>Sandboxed preload acceptance</title>');
    const result = await window.webContents.executeJavaScript(`(async () => ({
      bridgeAvailable: typeof window.deployerx === 'object',
      status: await window.deployerx.getUptimeWorkerStatus()
    }))()`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    window.destroy();
    app.quit();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  app.exit(1);
});
