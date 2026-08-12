const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const result = await window.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      state.setup.mode = 'offline';
      state.setup.complete = true;
      state.projects = [normalizeProject({
        id: 'layout-server',
        name: 'Layout Server',
        group: 'Production',
        serverType: 'ubuntu',
        ssh: { host: 'server.example.test', port: 22, username: 'root', password: 'secret' }
      })];
      reconcileServerMonitoringEntries();
      Object.assign(state.serverMonitoring.entries['layout-server'], {
        status: 'live',
        sessionId: 'monitor-layout',
        terminalSessionId: 'terminal-layout',
        sample: {
          cpu: { usagePercent: 39.8, cores: 4 },
          memory: { usagePercent: 49.1, usedBytes: 8053063680, totalBytes: 16106127360 },
          storage: [{ mount: '/', usagePercent: 60, usedBytes: 157840048128, totalBytes: 267361714176 }],
          system: { uptimeSeconds: 51120, hostname: 'server.example.test' }
        }
      });
      showView('server-monitoring');
      renderServerMonitoring();
      const card = document.querySelector('.server-monitoring-card');
      const rows = [...card.querySelectorAll('.server-monitoring-card-metric')];
      const bounds = rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      });
      const alignment = rows.map((row) => {
        const rowRect = row.getBoundingClientRect();
        const valueRect = row.querySelector('strong').getBoundingClientRect();
        const detailRect = row.querySelector('small').getBoundingClientRect();
        return {
          valueRightGap: rowRect.right - valueRect.right,
          detailBeforeValue: detailRect.right <= valueRect.left,
          detailRightAligned: getComputedStyle(row.querySelector('small')).textAlign === 'right'
        };
      });
      return {
        labels: rows.map((row) => row.querySelector('span')?.textContent.trim()),
        bounds,
        alignment,
        cardWidth: card.getBoundingClientRect().width,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
