const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

app.disableHardwareAcceleration();

async function prepare(window) {
  return window.webContents.executeJavaScript(`
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    state.setup.mode = 'offline';
    state.setup.complete = true;
    state.projects = [
      { id: 'server-1', name: 'API edge', group: 'Production', serverType: 'ubuntu', ssh: { host: 'api.example.com', username: 'root', port: 22 }, ftp: {}, commands: [], uptimeMonitors: [] },
      { id: 'server-2', name: 'Worker east', group: 'Production', serverType: 'ubuntu', ssh: { host: 'worker.example.com', username: 'root', port: 22 }, ftp: {}, commands: [], uptimeMonitors: [] }
    ];
    state.terminalSessions = { 'server-1': { sessionId: 'ssh-1', connected: true } };
    state.terminalSessionProjectIds = { 'ssh-1': 'server-1' };
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listUptimeMonitors: async () => [
        { id: 'monitor-api', name: 'API health', state: 'enabled', runtime: { status: 'down' } },
        { id: 'monitor-worker', name: 'Worker health', state: 'enabled', runtime: { status: 'up' } }
      ],
      listUptimeIncidents: async () => [{ id: 'incident-api', monitorId: 'monitor-api', state: 'open', severity: 'critical', summary: 'HTTP 503 from upstream', openedAt: '2026-08-06T10:00:00.000Z' }],
      getUptimeWorkerStatus: async () => ({ active: true }),
      listBackupJobs: async () => [{ id: 'backup-job', name: 'Nightly production' }],
      listBackupRuns: async () => [
        { id: 'backup-run-active', jobId: 'backup-job', state: 'running', createdAt: '2026-08-06T10:05:00.000Z' },
        { id: 'backup-run-success', jobId: 'backup-job', state: 'succeeded', createdAt: '2026-08-05T10:05:00.000Z', completedAt: '2026-08-05T10:22:00.000Z' }
      ],
      getBackupWorkerStatus: async () => ({ online: true, nextRunAt: '2026-08-06T11:00:00.000Z' }),
      listDatabaseProfiles: async () => [{ id: 'db-prod', name: 'Production PostgreSQL', driverId: 'postgresql' }, { id: 'db-reporting', name: 'Reporting replica', driverId: 'mysql' }],
      listDatabaseConnectionStatuses: async () => [{ profileId: 'db-prod', state: 'ready' }, { profileId: 'db-reporting', state: 'failed' }]
    }});
    true;
  `);
}

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('.dashboard-operations-panel')].map((card) => {
      const rect = card.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    });
    const grid = document.querySelector('.dashboard-operations-grid');
    const gridStyle = getComputedStyle(grid);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      cards,
      columns: gridStyle.gridTemplateColumns,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-dashboard-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, backgroundColor: '#f6f8fc', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    await prepare(window);
    await window.webContents.executeJavaScript(`(async () => { showView('dashboard'); await refreshDashboardOperations(); renderProjects(); })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const text = await window.webContents.executeJavaScript(`({
      stats: document.getElementById('dashboardStatsGrid').innerText,
      uptime: document.getElementById('dashboardUptimeAlerts').innerText,
      backup: document.getElementById('dashboardBackupStatus').innerText,
      database: document.getElementById('dashboardDatabaseStatus').innerText,
      cards: document.querySelectorAll('.dashboard-operations-panel').length
    })`);
    const desktop = await measure(window);
    const desktopPath = path.join(captureRoot, 'dashboard-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    const navigation = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-dashboard-uptime-incident]')?.click();
      const uptime = { view: state.currentView, tab: state.uptime.activeTab };
      showView('dashboard');
      document.querySelector('[data-dashboard-backup-run]')?.click();
      const backup = { view: state.currentView, tab: state.backupManagerTab };
      showView('dashboard');
      document.querySelector('[data-dashboard-database-profile]')?.click();
      return { uptime, backup, databaseView: state.currentView };
    })()`);

    await window.webContents.executeJavaScript(`showView('dashboard')`);
    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const mobile = await measure(window);
    const mobilePath = path.join(captureRoot, 'dashboard-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    const valid = text.cards === 3
      && text.stats.includes('UPTIME ALERTS') && text.stats.includes('ACTIVE BACKUPS') && text.stats.includes('DATABASES')
      && text.uptime.includes('API health') && text.uptime.includes('HTTP 503 from upstream')
      && text.backup.includes('1 backup in progress') && text.backup.includes('Nightly production')
      && text.database.includes('1 of 2 profiles connected') && text.database.includes('Connection failed')
      && navigation.uptime.view === 'uptime' && navigation.uptime.tab === 'incidents'
      && navigation.backup.view === 'backup' && navigation.backup.tab === 'jobs'
      && navigation.databaseView === 'database'
      && [desktop, mobile].every((result) => !result.overflow && result.cards.every((card) => card.left >= 0 && card.right <= result.viewport.width + 1));
    process.stdout.write(`${JSON.stringify({ ok: valid, text, navigation, desktop, mobile, screenshots: { desktopPath, mobilePath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
