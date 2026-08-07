const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

async function inspectNavigation(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    els.toast?.classList.remove('visible');

    setSettingsTab('backup');
    showView('team');
    const settingsBefore = {
      viewVisible: !document.getElementById('teamView').classList.contains('hidden'),
      panelVisible: !document.getElementById('settingsBackupPanel').classList.contains('hidden'),
      backupViewHidden: document.getElementById('backupManagerView').classList.contains('hidden')
    };

    document.getElementById('topBackupsButton').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const managerView = document.getElementById('backupManagerView');
    const managerShell = managerView.querySelector('.backup-manager-shell');
    const managerBounds = managerView.getBoundingClientRect();
    const shellBounds = managerShell.getBoundingClientRect();
    const managerAfterClick = {
      viewVisible: !managerView.classList.contains('hidden'),
      settingsHidden: document.getElementById('teamView').classList.contains('hidden'),
      settingsPanelRendered: document.getElementById('settingsBackupPanel').getClientRects().length > 0,
      navActive: document.getElementById('topBackupsButton').classList.contains('active'),
      heading: document.querySelector('#backupManagerView h1')?.textContent.trim(),
      selectedTab: document.querySelector('[data-backup-tab].active')?.dataset.backupTab,
      repeatedPanelHeadings: [...managerView.querySelectorAll('.backup-manager-panel:not([data-backup-panel="overview"]) > .backup-panel-heading h2, .backup-manager-panel:not([data-backup-panel="overview"]) > .backup-panel-heading p')].map((element) => element.textContent.trim()),
      retainedPanelControls: ['backupWorkerStatus', 'backupSourceAddButton', 'backupAddLocalRepositoryButton', 'backupRecoveryRefreshButton', 'backupActivityFilter', 'backupTestsRefreshButton'].every((id) => Boolean(document.getElementById(id))),
      settingsPanelStillPresent: Boolean(document.getElementById('settingsBackupPanel')),
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      viewBounds: { left: managerBounds.left, right: managerBounds.right },
      shellBounds: { left: shellBounds.left, right: shellBounds.right },
      toastVisible: els.toast?.classList.contains('visible') ?? false,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };

    showView('team');
    setSettingsTab('backup');
    const settingsAfterReturn = {
      viewVisible: !document.getElementById('teamView').classList.contains('hidden'),
      panelVisible: !document.getElementById('settingsBackupPanel').classList.contains('hidden'),
      managerHidden: document.getElementById('backupManagerView').classList.contains('hidden'),
      managerNavInactive: !document.getElementById('topBackupsButton').classList.contains('active'),
      heading: document.querySelector('#settingsBackupPanel h1, #settingsBackupPanel h2')?.textContent.trim()
    };

    return { settingsBefore, managerAfterClick, settingsAfterReturn };
  })()`);
}

async function showManagerForCapture(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.getElementById('topBackupsButton').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    els.toast?.classList.remove('visible');
    return !document.getElementById('backupManagerView').classList.contains('hidden')
      && document.getElementById('teamView').classList.contains('hidden');
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-navigation-ui-'));
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    backgroundColor: '#f7f8fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`);
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const desktop = await inspectNavigation(window);
    const desktopCaptureReady = await showManagerForCapture(window);
    const desktopPath = path.join(captureRoot, 'backup-navigation-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mobile = await inspectNavigation(window);
    const mobileWindowBounds = window.getBounds();
    const mobileCaptureReady = await showManagerForCapture(window);
    const mobilePath = path.join(captureRoot, 'backup-navigation-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    const contained = (bounds, viewport) => bounds.left >= 0 && bounds.right <= viewport.width + 1;
    const validNavigation = (result) => result.settingsBefore.viewVisible
      && result.settingsBefore.panelVisible
      && result.settingsBefore.backupViewHidden
      && result.managerAfterClick.viewVisible
      && result.managerAfterClick.settingsHidden
      && !result.managerAfterClick.settingsPanelRendered
      && result.managerAfterClick.navActive
      && result.managerAfterClick.heading === 'Backup Manager'
      && result.managerAfterClick.selectedTab === 'overview'
      && result.managerAfterClick.repeatedPanelHeadings.length === 0
      && result.managerAfterClick.retainedPanelControls
      && result.managerAfterClick.settingsPanelStillPresent
      && contained(result.managerAfterClick.viewBounds, result.managerAfterClick.viewport)
      && contained(result.managerAfterClick.shellBounds, result.managerAfterClick.viewport)
      && !result.managerAfterClick.toastVisible
      && !result.managerAfterClick.horizontalOverflow
      && result.settingsAfterReturn.viewVisible
      && result.settingsAfterReturn.panelVisible
      && result.settingsAfterReturn.managerHidden
      && result.settingsAfterReturn.managerNavInactive
      && result.settingsAfterReturn.heading === 'Backup & Restore';
    const valid = validNavigation(desktop) && validNavigation(mobile)
      && mobileWindowBounds.width === 390 && mobileWindowBounds.height === 844
      && desktopCaptureReady && mobileCaptureReady;
    process.stdout.write(`${JSON.stringify({ ok: valid, desktop, mobile, mobileWindowBounds, screenshots: { desktopPath, mobilePath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
