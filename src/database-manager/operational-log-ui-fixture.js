const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

async function waitFor(window, expression, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

app.whenReady().then(async () => {
  const outputDirectory = process.argv[2];
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f6f7fb' });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await window.webContents.executeJavaScript(`
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.getElementById('setupModal')?.classList.add('hidden');
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      window.__logCalls = [];
      window.__fixtureLogEntries = [
        { id: 'evidence:c1', category: 'connection', severity: 'success', occurredAt: '2026-08-05T12:05:00.000Z', profileId: 'profile-postgresql', profileName: 'Production PostgreSQL', operation: 'open', state: 'ready', summary: 'Connection open ready', code: null, metrics: {}, endpoint: 'private.internal', password: 'secret' },
        { id: 'evidence:s1', category: 'schema', severity: 'success', occurredAt: '2026-08-05T12:04:00.000Z', profileId: 'profile-postgresql', profileName: 'Production PostgreSQL', operation: 'create-table', state: 'changed', summary: 'Database create-table changed', code: null, metrics: {}, query: 'SELECT * FROM secret_table', path: 'C:\\\\private\\\\database.dump' },
        { id: 'query:q1', category: 'query', severity: 'success', occurredAt: '2026-08-05T12:03:00.000Z', profileId: 'profile-postgresql', profileName: 'Production PostgreSQL', operation: 'editor-query', state: 'succeeded', summary: 'read query succeeded', code: null, metrics: { executionTimeMs: 42, rowCount: 18, affectedRows: 0 } },
        { id: 'task:t1', category: 'task', severity: 'warning', occurredAt: '2026-08-05T12:02:00.000Z', profileId: 'profile-postgresql', profileName: 'Production PostgreSQL', operation: 'export', state: 'interrupted', summary: 'Export customer records', code: null, metrics: { percent: 64, itemsCompleted: 640, bytesCompleted: 1048576 } },
        { id: 'driver:d1', category: 'driver', severity: 'error', occurredAt: '2026-08-05T12:01:00.000Z', profileId: null, profileName: 'Device drivers', operation: 'sidecar-exit', state: 'crashed', summary: 'Driver vendor.db2 crashed', code: 'DATABASE_MANAGER_DRIVER_HOST_EXITED', metrics: { crashCount: 2, protocolErrorCount: 1, stderrEventCount: 3 } }
      ];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listDatabaseProfiles: async () => [{ id: 'profile-postgresql', name: 'Production PostgreSQL', driverId: 'postgresql', environment: 'production', accessMode: 'read-write', tags: [] }],
        listDatabaseConnectionStatuses: async () => [],
        listDatabasePlugins: async () => [],
        listDatabaseOperationalLogs: async (options = {}) => {
          window.__logCalls.push(structuredClone(options));
          const entries = window.__fixtureLogEntries.filter((entry) => (!options.profileId || entry.profileId === options.profileId)
            && (!options.categories?.length || options.categories.includes(entry.category))
            && (!options.severities?.length || options.severities.includes(entry.severity))
            && (!options.search || [entry.profileName, entry.operation, entry.state, entry.summary, entry.code].filter(Boolean).join(' ').toLowerCase().includes(String(options.search).toLowerCase())));
          return { entries: structuredClone(entries), total: entries.length, truncated: false, sources: { profiles: 'fulfilled', queries: 'fulfilled', tasks: 'rejected', drivers: 'fulfilled', evidence: 'fulfilled' } };
        }
      }});
      state.setup.mode = 'local';
      state.projects = [];
      state.databaseManager.profiles = [{ id: 'profile-postgresql', name: 'Production PostgreSQL', driverId: 'postgresql', environment: 'production', accessMode: 'read-write', tags: [] }];
      state.databaseManager.activeTab = 'logs';
      showView('database');
      true;
    `);
    await waitFor(window, `window.__logCalls.length > 0 && document.querySelectorAll('.database-log-entry').length === 5`);
    const desktop = await window.webContents.executeJavaScript(`(() => {
      const entries = [...document.querySelectorAll('.database-log-entry')];
      const boxes = entries.map((entry) => entry.getBoundingClientRect());
      return {
        entryCount: entries.length,
        states: [...document.querySelectorAll('.database-log-state')].map((item) => item.textContent.trim()),
        partialWarning: !document.getElementById('databaseLogsWarning').classList.contains('hidden'),
        rawEvidenceVisible: document.getElementById('databaseLogsPanel').innerText.includes('SELECT * FROM secret_table') || document.getElementById('databaseLogsPanel').innerText.includes('C:\\\\private\\\\database.dump'),
        entriesInsideViewport: boxes.every((box) => box.left >= 0 && box.right <= innerWidth),
        entriesOverlap: boxes.some((box, index) => index > 0 && box.top < boxes[index - 1].bottom)
      };
    })()`);
    const desktopPath = path.join(outputDirectory, 'database-operational-logs-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('databaseLogsCategory');
      select.value = 'schema';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(window, `window.__logCalls.at(-1)?.categories?.[0] === 'schema' && document.querySelectorAll('.database-log-entry').length === 1`);
    const filtered = await window.webContents.executeJavaScript(`({ options: window.__logCalls.at(-1), entryCount: document.querySelectorAll('.database-log-entry').length })`);

    await window.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('databaseLogsCategory');
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(window, `window.__logCalls.at(-1)?.categories?.length === 0 && document.querySelectorAll('.database-log-entry').length === 5`);
    window.setContentSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mobile = await window.webContents.executeJavaScript(`(() => {
      const toolbar = document.querySelector('.database-log-toolbar').getBoundingClientRect();
      const boxes = [...document.querySelectorAll('.database-log-entry')].map((entry) => entry.getBoundingClientRect());
      return {
        bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        toolbarInsideViewport: toolbar.left >= 0 && toolbar.right <= innerWidth,
        entriesInsideViewport: boxes.every((box) => box.left >= 0 && box.right <= innerWidth),
        entriesOverlap: boxes.some((box, index) => index > 0 && box.top < boxes[index - 1].bottom)
      };
    })()`);
    const mobilePath = path.join(outputDirectory, 'database-operational-logs-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());
    process.stdout.write(`${JSON.stringify({ desktop, filtered, mobile, imagePaths: [desktopPath, mobilePath] })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
