const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-top-ssh-navigation-'));
  const window = new BrowserWindow({
    show: false,
    width: 1600,
    height: 900,
    backgroundColor: '#11111b',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  let exitCode = 0;

  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const result = await window.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('setupModal')?.classList.add('hidden');
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.documentElement.dataset.theme = 'catppuccin-mocha';
      activeThemeId = 'catppuccin-mocha';
      state.setup.mode = 'offline';
      state.setup.complete = true;
      state.projects = [
        { id: 'windows-server', name: 'Windows Server', group: 'Production', serverType: 'windows', rdp: { host: '192.0.2.20', port: 3389 }, ssh: {}, ftp: {}, commands: [] },
        { id: 'ssh-server', name: 'Production SSH', group: 'Production', serverType: 'ubuntu', pinned: true, ssh: { host: '192.0.2.10', port: 22, username: 'deploy' }, ftp: {}, commands: [] }
      ];
      state.activeProject = null;
      showView('dashboard');
      renderProjects();
      document.getElementById('topSshButton').click();
      document.querySelectorAll('.toast').forEach((toast) => toast.classList.add('hidden'));
      return {
        buttonText: document.getElementById('topSshButton').innerText.trim(),
        buttonActive: document.getElementById('topSshButton').classList.contains('active'),
        currentView: state.currentView,
        activeProjectId: state.activeProject?.id,
        activeProjectTab: state.activeProjectTab,
        projectVisible: !document.getElementById('projectView').classList.contains('hidden'),
        sshVisible: !document.getElementById('sshWorkspace').classList.contains('hidden')
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 220));
    window.webContents.invalidate();
    await window.webContents.capturePage();
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const screenshotPath = path.join(captureRoot, 'top-ssh-terminal.png');
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

    const valid = result.buttonText === 'SSH'
      && result.buttonActive
      && result.currentView === 'project'
      && result.activeProjectId === 'ssh-server'
      && result.activeProjectTab === 'ssh'
      && result.projectVisible
      && result.sshVisible;
    process.stdout.write(`${JSON.stringify({ ok: valid, result, screenshotPath })}\n`);
    if (!valid) exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
