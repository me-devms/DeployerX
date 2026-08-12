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
  assert.equal(mainSource.includes('async function applyUptimeServerLinkHierarchy(payload, current = null)'), true, 'main process derives monitor hierarchy from Server Link');
  assert.equal(mainSource.includes("payload.parentGroup = String(project.name || '').trim() || 'Untitled Server';"), true, 'linked server name replaces manual parent metadata');
  assert.equal(mainSource.includes('await applyUptimeServerLinkHierarchy(payload, current);'), true, 'server hierarchy is enforced before monitor persistence');
  assert.match(mainSource, /async function createUptimeMonitorOperation[\s\S]*await executeUptimeMonitorCheck\([\s\S]*monitor = transition\.monitor;/, 'new enabled monitors return their first persisted health result');
  assert.match(mainSource, /async function runUptimeMonitorNowOperation[\s\S]*await executeUptimeMonitorCheck\([\s\S]*completed: true/, 'Run now completes and persists a check without depending on the detached worker');
  assert.match(mainSource, /async function updateUptimeMonitorOperation[\s\S]*monitor\.state === 'enabled'[\s\S]*maybeStartDetachedUptimeWorker/, 'enabling a monitor starts the detached worker');
  assert.equal(mainSource.includes('async function syncUptimeWorkspaceBestEffort(context, options = {})'), true, 'cloud sync failures do not block local Uptime operations');
  assert.match(mainSource, /async function listUptimeMonitorsOperation[\s\S]*queueUptimeWorkspaceSync\(context\)[\s\S]*listMonitors/, 'monitor reads return local data while cloud sync continues');
  assert.match(mainSource, /async function createUptimeMonitorOperation[\s\S]*createMonitor[\s\S]*queueUptimeTransitionSync/, 'monitor creation persists locally before cloud sync');
  assert.match(mainSource, /if \(transition\.maintenance\) writes\.push\(writeUptimeCloudRecord/, 'maintenance changes remain cloud synchronized');
  assert.match(mainSource, /const UPTIME_CLOUD_SYNC_INTERVAL_MS = 30000;[\s\S]*uptimeCloudLastSyncAt\.set\(context\.workspaceId, Date\.now\(\)\);/, 'failed cloud reconciliation is throttled between dashboard refreshes');
});

test('starts the durable worker control plane and routes notification clicks to Uptime', async () => {
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.equal(mainSource.includes('await initializeUptimeControlPlane({ startWorker: true });'), true);
  assert.equal(mainSource.includes('await uptimeScheduledWorkerService.start(context.workspaceId'), true);
  assert.match(mainSource, /onTransition: async \(transition\) => queueUptimeTransitionSync\(context, transition\)/, 'worker heartbeats and checks do not wait for cloud writes');
  assert.match(mainSource, /queueUptimeWorkspaceSync\(context\);[\s\S]*await uptimeScheduledWorkerService\.start/, 'worker startup does not wait for cloud reconciliation');
  assert.equal(mainSource.includes("mainWindow.webContents.send('uptime:navigate', target)"), true);
  assert.equal(mainSource.includes('parseUptimeNavigationArgument()'), true);
  assert.equal(mainSource.includes('serviceStatus.processId'), true);
  assert.equal(mainSource.includes('uptimeWindowCloseDisposition({'), true);
  assert.equal(mainSource.includes('if (disposition.hideWindow) mainWindow.hide()'), true);
  assert.equal(mainSource.includes('tray.displayBalloon('), false);
  assert.equal(mainSource.includes('const child = execFile(process.execPath, buildWorkerArgs()'), true);
  assert.equal(mainSource.includes('child.unref()'), true);
  assert.equal(mainSource.includes('isWorkerLockLeaseActive(existing'), true, 'worker ownership uses a renewable lease instead of PID existence alone');
});

test('keeps one interactive desktop instance and restores it on repeated launches', async () => {
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.equal(mainSource.includes('!isWorkerMode() && !isDatabaseManagerPackagedSmokeMode()'), true, 'background worker is exempt from the desktop lock');
  assert.equal(mainSource.includes('app.requestSingleInstanceLock()'), true, 'interactive app acquires an Electron instance lock');
  assert.equal(mainSource.includes("app.on('second-instance'"), true, 'repeated launches are routed to the primary process');
  assert.equal(mainSource.includes('openExistingMainWindow(argv)'), true, 'existing window is restored for repeated launches');
});
