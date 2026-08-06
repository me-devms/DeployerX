const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('registers the workspace Uptime IPC and isolated preload surface', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8')
  ]);
  const handlers = [
    'uptime:monitors:list',
    'uptime:monitors:get',
    'uptime:monitors:create',
    'uptime:monitors:update',
    'uptime:monitors:delete',
    'uptime:monitors:test',
    'uptime:monitors:run-now',
    'uptime:checks:list',
    'uptime:incidents:list',
    'uptime:incidents:acknowledge',
    'uptime:maintenance:list',
    'uptime:maintenance:create',
    'uptime:maintenance:update',
    'uptime:maintenance:delete',
    'uptime:worker:status',
    'uptime:settings:get',
    'uptime:settings:update',
    'uptime:reports:get',
    'uptime:reports:export-csv',
    'uptime:reports:export-pdf'
  ];
  for (const channel of handlers) assert.equal(mainSource.includes(`uptimeIpcMain.handle('${channel}'`), true, `${channel} coded main handler`);

  const preloadMethods = [
    'listUptimeMonitors',
    'getUptimeMonitor',
    'createUptimeMonitor',
    'updateUptimeMonitor',
    'deleteUptimeMonitor',
    'testUptimeMonitor',
    'runUptimeMonitorNow',
    'listUptimeChecks',
    'listUptimeIncidents',
    'acknowledgeUptimeIncident',
    'listUptimeMaintenance',
    'createUptimeMaintenance',
    'updateUptimeMaintenance',
    'deleteUptimeMaintenance',
    'getUptimeWorkerStatus',
    'getUptimeMonitoringSettings',
    'updateUptimeMonitoringSettings',
    'getUptimeReport',
    'exportUptimeCsv',
    'exportUptimePdf'
  ];
  for (const method of preloadMethods) assert.equal(preloadSource.includes(`${method}:`), true, `${method} preload method`);
  assert.equal(mainSource.includes('wrapUptimeIpc(handler)'), true, 'main IPC result envelope');
  assert.equal(preloadSource.includes('unwrapUptimeIpc(await ipcRenderer.invoke(channel, ...args))'), true, 'preload coded error reconstruction');
  assert.equal(preloadSource.includes("require('./uptime-monitor/ipc-contract')"), false, 'sandboxed preload has no local module import');
  assert.equal(preloadSource.includes("ipcRenderer.on('uptime:navigate'"), true);
});

test('starts the durable worker control plane and routes notification clicks to Uptime', async () => {
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.equal(mainSource.includes('await initializeUptimeControlPlane({ startWorker: true });'), true);
  assert.equal(mainSource.includes('await uptimeScheduledWorkerService.start(context.workspaceId'), true);
  assert.equal(mainSource.includes("mainWindow.webContents.send('uptime:navigate', target)"), true);
  assert.equal(mainSource.includes('parseUptimeNavigationArgument()'), true);
  assert.equal(mainSource.includes('serviceStatus.processId'), true);
  assert.equal(mainSource.includes('uptimeWindowCloseDisposition({'), true);
  assert.equal(mainSource.includes('if (disposition.hideWindow) mainWindow.hide()'), true);
  assert.equal(mainSource.includes('tray.displayBalloon('), false);
  assert.equal(mainSource.includes('const child = execFile(process.execPath, buildWorkerArgs()'), true);
  assert.equal(mainSource.includes('child.unref()'), true);
});
