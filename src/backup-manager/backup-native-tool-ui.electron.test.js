const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-tool-ui-'));
  const window = new BrowserWindow({ show: false, width: 390, height: 844, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const offered = await window.webContents.executeJavaScript(`(async () => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.getElementById('toast')?.remove();
      window.__nativeToolInstalls = [];
      window.__nativeToolRetries = 0;
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        getBackupNativeToolStatus: async (engine) => ({ engine, label: 'MySQL', packageLabel: 'MySQL 8.4 client tools', version: '8.4.6', supported: true, installed: false, downloadBytes: 260772595 }),
        installBackupNativeTools: async (engine) => { window.__nativeToolInstalls.push(engine); return { engine, installed: true }; }
      }});
      const handled = await offerBackupNativeToolSetup({ code: 'MYSQL_NATIVE_TOOL_NOT_FOUND' }, async () => { window.__nativeToolRetries += 1; });
      renderBackupNativeToolProgress({ receivedBytes: 125000000, totalBytes: 260772595, percent: 47.93 });
      const modal = document.querySelector('#backupNativeToolModal .modal-card').getBoundingClientRect();
      return {
        handled,
        visible: !document.getElementById('backupNativeToolModal').classList.contains('hidden'),
        title: document.getElementById('backupNativeToolTitle').innerText,
        packageText: document.querySelector('.backup-native-tool-package').innerText,
        action: document.getElementById('backupNativeToolInstallButton').innerText,
        progressVisible: !document.getElementById('backupNativeToolProgressGroup').classList.contains('hidden'),
        progressPercent: document.getElementById('backupNativeToolProgressPercent').innerText,
        progressBytes: document.getElementById('backupNativeToolProgressBytes').innerText,
        contained: modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const screenshotPath = path.join(captureRoot, 'mysql-tool-setup-mobile.png');
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
    const installed = await window.webContents.executeJavaScript(`(async () => {
      await installBackupNativeTools();
      return {
        installs: window.__nativeToolInstalls.slice(),
        retries: window.__nativeToolRetries,
        hidden: document.getElementById('backupNativeToolModal').classList.contains('hidden')
      };
    })()`);
      const ok = offered.handled && offered.visible && offered.title === 'Set up MySQL tools'
      && offered.packageText.includes('MySQL 8.4 client tools') && offered.packageText.includes('249 MB download')
      && offered.action.includes('Download and set up') && offered.progressVisible && offered.progressPercent === '48%'
      && offered.progressBytes === '119 MB of 249 MB' && offered.contained && !offered.horizontalOverflow
      && installed.installs[0] === 'mysql' && installed.retries === 1 && installed.hidden;
    const report = { ok, offered, installed, screenshotPath };
    await fs.writeFile(path.join(captureRoot, 'result.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
