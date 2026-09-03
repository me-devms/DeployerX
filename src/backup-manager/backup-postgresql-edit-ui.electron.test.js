const path = require('path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await window.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.classList.add('hidden');
      document.querySelector('.app-shell')?.classList.remove('hidden');
      state.backupPostgresqlConnections = [{
        id: 'conn_postgresql', name: 'Production PostgreSQL', currentDevice: true,
        endpoint: { username: 'backup_user', host: 'postgres.example.com', port: 5432, database: 'postgres', maintenanceDatabase: 'postgres', tlsMode: 'verify-identity', deploymentProfile: 'postgresql', connectionMode: null, projectRef: null },
        lastTest: { status: 'success', remotePlatform: { engine: 'postgresql', version: '16.4.0' }, endpointIdentity: { systemIdentifier: '7395820012345678901' } }
      }];
      state.backupMysqlConnections = [];
      state.backupManagerTab = 'sources';
      showView('backup');
      setBackupManagerTab('sources');
      renderBackupConnections();
      const button = document.querySelector('[data-backup-connection-edit="conn_postgresql"]');
      const editButtonVisible = Boolean(button);
      button?.click();
      const output = {
        editButtonVisible,
        modalOpen: !document.getElementById('backupMysqlModal').classList.contains('hidden'),
        title: document.getElementById('backupMysqlModalTitle').textContent.trim(),
        name: document.getElementById('backupMysqlName').value,
        host: document.getElementById('backupMysqlHost').value,
        port: document.getElementById('backupMysqlPort').value,
        username: document.getElementById('backupMysqlUsername').value,
        maintenanceDatabase: document.getElementById('backupPostgresqlMaintenanceDatabase').value,
        fieldsVisible: !document.getElementById('backupMysqlConnectionFields').classList.contains('hidden'),
        passwordOptional: !document.getElementById('backupMysqlPassword').required,
        sourceSaveHidden: document.getElementById('backupMysqlSaveSourceButton').classList.contains('hidden')
      };
      closeBackupMysqlModal();
      return output;
    })()`);
    const ok = result.editButtonVisible && result.modalOpen && result.title === 'Edit PostgreSQL connection'
      && result.name === 'Production PostgreSQL' && result.host === 'postgres.example.com' && result.port === '5432'
      && result.username === 'backup_user' && result.maintenanceDatabase === 'postgres'
      && result.fieldsVisible && result.passwordOptional && result.sourceSaveHidden;
    process.stdout.write(`${JSON.stringify({ ok, result })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
