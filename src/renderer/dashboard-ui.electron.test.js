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
    state.featureFlags.databaseManager = true;
    syncDatabaseManagerFeatureVisibility();
    state.terminalSessions = { 'server-1': { sessionId: 'ssh-1', connected: true } };
    state.terminalSessionProjectIds = { 'ssh-1': 'server-1' };
    window.__dashboardCalls = { listDatabaseProfiles: 0, listDatabaseConnectionStatuses: 0 };
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
      listDatabaseProfiles: async () => {
        window.__dashboardCalls.listDatabaseProfiles += 1;
        return [{ id: 'db-prod', name: 'Production PostgreSQL', driverId: 'postgresql' }, { id: 'db-reporting', name: 'Reporting replica', driverId: 'mysql' }];
      },
      listDatabaseConnectionStatuses: async () => {
        window.__dashboardCalls.listDatabaseConnectionStatuses += 1;
        return [{ profileId: 'db-prod', state: 'ready' }, { profileId: 'db-reporting', state: 'failed' }];
      }
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
      cards: document.querySelectorAll('.dashboard-operations-panel').length,
      databaseSurfacesAvailable: !document.getElementById('topDatabasesButton').hidden
        && document.querySelector('[data-settings-tab="database"]').hidden
        && !document.querySelector('[data-settings-panel="database"]').hidden
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

    const hiddenDatabase = await window.webContents.executeJavaScript(`(async () => {
      const before = { ...window.__dashboardCalls };
      state.featureFlags.databaseManager = false;
      syncDatabaseManagerFeatureVisibility();
      showView('database');
      const blockedDatabaseView = state.currentView;
      setSettingsTab('database');
      const blockedDatabaseSettings = state.settingsTab;
      showView('dashboard');
      await refreshDashboardOperations();
      renderProjects();
      return {
        before,
        after: { ...window.__dashboardCalls },
        stats: document.getElementById('dashboardStatsGrid').innerText,
        database: document.getElementById('dashboardDatabaseStatus').innerText,
        cards: document.querySelectorAll('.dashboard-operations-panel:not(.hidden)').length,
        databasePanelHidden: document.querySelector('.dashboard-database-panel')?.classList.contains('hidden'),
        topNavigationHidden: document.getElementById('topDatabasesButton').hidden,
        settingsNavigationHidden: document.querySelector('[data-settings-tab="database"]').hidden,
        settingsPanelHidden: document.querySelector('[data-settings-panel="database"]').hidden,
        blockedDatabaseView,
        blockedDatabaseSettings,
        layout: (() => {
          const grid = document.querySelector('.dashboard-operations-grid');
          const gridRect = grid.getBoundingClientRect();
          const visibleCards = [...grid.querySelectorAll('.dashboard-operations-panel:not(.hidden)')].map((card) => card.getBoundingClientRect());
          const statsGrid = document.getElementById('dashboardStatsGrid');
          const statsRect = statsGrid.getBoundingClientRect();
          const statCards = [...statsGrid.querySelectorAll('.dashboard-stat-card')].map((card) => card.getBoundingClientRect());
          return {
            databaseHiddenClass: grid.classList.contains('database-hidden'),
            cardWidths: visibleCards.map((card) => card.width),
            rightGap: gridRect.right - visibleCards.at(-1).right,
            statsDatabaseHiddenClass: statsGrid.classList.contains('database-hidden'),
            statWidths: statCards.map((card) => card.width),
            statsRightGap: statsRect.right - statCards.at(-1).right
          };
        })()
      };
    })()`);

    await window.webContents.executeJavaScript(`showView('dashboard')`);
    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const mobile = await measure(window);
    const mobilePath = path.join(captureRoot, 'dashboard-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    const normalizedText = {
      stats: text.stats.toLowerCase(),
      uptime: text.uptime.toLowerCase(),
      backup: text.backup.toLowerCase(),
      database: text.database.toLowerCase(),
      hiddenStats: hiddenDatabase.stats.toLowerCase()
    };
    const valid = text.cards === 3 && text.databaseSurfacesAvailable
      && normalizedText.stats.includes('uptime alerts') && normalizedText.stats.includes('active backups') && normalizedText.stats.includes('databases')
      && normalizedText.uptime.includes('api health') && normalizedText.uptime.includes('http 503 from upstream')
      && normalizedText.backup.includes('1 backup in progress') && normalizedText.backup.includes('nightly production')
      && normalizedText.database.includes('1 of 2 profiles connected') && normalizedText.database.includes('connection failed')
      && navigation.uptime.view === 'uptime' && navigation.uptime.tab === 'incidents'
      && navigation.backup.view === 'backup' && navigation.backup.tab === 'jobs'
      && navigation.databaseView === 'database'
      && hiddenDatabase.cards === 2
      && hiddenDatabase.databasePanelHidden === true
      && hiddenDatabase.topNavigationHidden === true
      && hiddenDatabase.settingsNavigationHidden === true
      && hiddenDatabase.settingsPanelHidden === true
      && hiddenDatabase.blockedDatabaseView === 'dashboard'
      && hiddenDatabase.blockedDatabaseSettings === 'workspace'
      && hiddenDatabase.layout.databaseHiddenClass === true
      && Math.abs(hiddenDatabase.layout.cardWidths[0] - hiddenDatabase.layout.cardWidths[1]) <= 1
      && hiddenDatabase.layout.rightGap <= 1
      && hiddenDatabase.layout.statsDatabaseHiddenClass === true
      && hiddenDatabase.layout.statWidths.length === 5
      && hiddenDatabase.layout.statWidths.every((width) => Math.abs(width - hiddenDatabase.layout.statWidths[0]) <= 1)
      && hiddenDatabase.layout.statsRightGap <= 1
      && !normalizedText.hiddenStats.includes('databases')
      && hiddenDatabase.database === ''
      && hiddenDatabase.after.listDatabaseProfiles === hiddenDatabase.before.listDatabaseProfiles
      && hiddenDatabase.after.listDatabaseConnectionStatuses === hiddenDatabase.before.listDatabaseConnectionStatuses
      && [desktop, mobile].every((result) => !result.overflow && result.cards.every((card) => card.left >= 0 && card.right <= result.viewport.width + 1));
    process.stdout.write(`${JSON.stringify({ ok: valid, text, navigation, hiddenDatabase, desktop, mobile, screenshots: { desktopPath, mobilePath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
