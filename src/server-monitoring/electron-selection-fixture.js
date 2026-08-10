const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const result = await window.webContents.executeJavaScript(`(async () => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      state.setup.mode = 'offline';
      state.setup.complete = true;
      state.activeProject = null;
      state.serverMonitoring.selectedProjectId = '';
      state.sidebarOrder = {
        groups: ['Client India', 'Client Non India'],
        projects: ['elite', 'bob']
      };
      state.projects = [
        normalizeProject({ id: 'bob', name: 'BobBoy', group: 'Client Non India', serverType: 'ubuntu', ssh: { host: '72.61.195.120', username: 'root', password: 'secret' } }),
        normalizeProject({ id: 'elite', name: 'Elite Fragrances', group: 'Client India', serverType: 'ubuntu', ssh: { host: '167.71.231.157', username: 'root', password: 'secret' } })
      ];
      window.__monitoringTest = { terminalProjects: [] };
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        stopServerMonitoring: async () => {},
        startServerMonitoring: async () => {},
        startTerminal: async ({ sessionId, project }) => {
          window.__monitoringTest.terminalProjects.push(project.id);
          return { sessionId };
        }
      }});

      showView('server-monitoring');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const firstVisible = document.querySelector('#projectList .project-item-open');
      const selectedBeforeConnect = state.serverMonitoring.selectedProjectId;
      const selectedRowBeforeConnect = document.querySelector('#projectList .project-item.active .project-item-open')?.getAttribute('aria-label') || '';
      document.getElementById('serverMonitoringConnectButton').click();
      await new Promise((resolve) => setTimeout(resolve, 30));

      return {
        firstVisible: firstVisible?.getAttribute('aria-label') || '',
        selectedBeforeConnect,
        selectedRowBeforeConnect,
        terminalProjects: [...window.__monitoringTest.terminalProjects],
        status: state.serverMonitoring.status
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
