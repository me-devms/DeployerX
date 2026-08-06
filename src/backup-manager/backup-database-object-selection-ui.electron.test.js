const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

async function prepare(window) {
  return window.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    const postgresqlConnection = { id: 'connection_postgresql', name: 'Production PostgreSQL', connectionKind: 'postgresql', endpoint: { maintenanceDatabase: 'postgres' }, lastTest: { status: 'success' } };
    const mysqlConnection = { id: 'connection_mysql', name: 'Production MySQL', connectionKind: 'mysql', endpoint: {}, lastTest: { status: 'success' } };
    window.__databaseObjectPayloads = [];
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listBackupLocalConnections: async () => [],
      listBackupSshConnections: async () => [{ id: 'connection_ssh', name: 'Production Linux', currentDevice: true, lastTest: { status: 'success' } }],
      listBackupMysqlConnections: async () => [mysqlConnection],
      listBackupMariadbConnections: async () => [],
      listBackupPostgresqlConnections: async () => [postgresqlConnection],
      testBackupPostgresqlConnection: async () => ({ connection: postgresqlConnection, result: { status: 'success' } }),
      testBackupMysqlConnection: async () => ({ connection: mysqlConnection, result: { status: 'success' } }),
      discoverBackupPostgresqlDatabases: async (_id, request = {}) => {
        if (request.kind === 'schema') return { items: [{ kind: 'schema', database: 'orders', name: 'audit', objectType: 'schema', selectable: true }, { kind: 'schema', database: 'orders', name: 'public', objectType: 'schema', selectable: true }] };
        if (request.kind === 'table') return { items: [{ kind: 'table', database: 'orders', schema: 'audit', name: 'events', objectType: 'table', selectable: true }, { kind: 'table', database: 'orders', schema: 'public', name: 'invoice_view', objectType: 'view', selectable: true }] };
        return { items: [{ kind: 'database', name: 'accounts', selectable: true }, { kind: 'database', name: 'orders', selectable: true }] };
      },
      discoverBackupMysqlDatabases: async (_id, request = {}) => request.kind === 'table'
        ? { items: [{ kind: 'table', database: 'orders', schema: 'orders', name: 'invoices', objectType: 'table', selectable: true }] }
        : { items: [{ kind: 'database', name: 'orders', selectable: true }] },
      saveBackupDatabaseSource: async (payload) => { window.__databaseObjectPayloads.push(structuredClone(payload)); return { id: 'source_saved' }; }
    }});
    window.__postgresqlConnection = postgresqlConnection;
    window.__mysqlConnection = mysqlConnection;
    state.backupSshConnections = [{ id: 'connection_ssh', name: 'Production Linux', currentDevice: true, lastTest: { status: 'success' } }];
    return true;
  })()`);
}

async function selectDatabase(window, name) {
  await window.webContents.executeJavaScript(`(() => {
    const input = Array.from(document.querySelectorAll('[data-backup-mysql-database]')).find((candidate) => candidate.value === ${JSON.stringify(name)});
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-database-object-ui-'));
  const window = new BrowserWindow({ show: false, width: 390, height: 844, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);

    await window.webContents.executeJavaScript(`(async () => { openBackupMysqlModal(window.__postgresqlConnection, 'postgresql'); await discoverBackupMysql(); })()`);
    await selectDatabase(window, 'orders');
    await window.webContents.executeJavaScript(`(async () => {
      const mode = document.getElementById('backupDatabaseSelectionMode');
      mode.value = 'schemas';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      await discoverBackupDatabaseObjects();
      document.querySelector('[data-backup-database-object]').click();
      await saveBackupMysqlSource(new Event('submit', { cancelable: true }));
    })()`);

    await window.webContents.executeJavaScript(`(async () => { openBackupMysqlModal(window.__mysqlConnection, 'mysql'); await discoverBackupMysql(); })()`);
    const physicalVisual = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('backupMysqlPhysicalEnabled').click();
      document.getElementById('backupMysqlPhysicalTemporaryDirectory').value = '/srv/deployerx-tmp';
      document.getElementById('backupMysqlPhysicalDataDirectory').value = '/var/lib/mysql';
      syncBackupDatabaseObjectSelection();
      const before = {
        fieldsVisible: !document.getElementById('backupMysqlPhysicalFields').classList.contains('hidden'),
        scopeDisabled: document.getElementById('backupDatabaseSelectionMode').disabled,
        saveDisabled: document.getElementById('backupMysqlSaveSourceButton').disabled,
        requirement: document.getElementById('backupMysqlPhysicalRequirement').innerText
      };
      await saveBackupMysqlSource(new Event('submit', { cancelable: true }));
      return before;
    })()`);

    await window.webContents.executeJavaScript(`(async () => { openBackupMysqlModal(window.__mysqlConnection, 'mysql'); await discoverBackupMysql(); })()`);
    await selectDatabase(window, 'orders');
    await window.webContents.executeJavaScript(`(async () => {
      const mode = document.getElementById('backupDatabaseSelectionMode');
      mode.value = 'tables';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      await discoverBackupDatabaseObjects();
      document.querySelector('[data-backup-database-object]').click();
      await saveBackupMysqlSource(new Event('submit', { cancelable: true }));
    })()`);

    await window.webContents.executeJavaScript(`(async () => { openBackupMysqlModal(window.__postgresqlConnection, 'postgresql'); await discoverBackupMysql(); })()`);
    await selectDatabase(window, 'orders');
    await window.webContents.executeJavaScript(`(async () => {
      const mode = document.getElementById('backupDatabaseSelectionMode');
      mode.value = 'tables';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      await discoverBackupDatabaseObjects();
      document.querySelectorAll('[data-backup-database-object]').forEach((input) => input.click());
    })()`);
    const visual = await window.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('#backupMysqlModal .modal-body');
      body.scrollTop = body.scrollHeight;
      const modal = document.querySelector('#backupMysqlModal .modal-card').getBoundingClientRect();
      const list = document.getElementById('backupDatabaseObjectList').getBoundingClientRect();
      const footer = document.querySelector('#backupMysqlModal .modal-footer').getBoundingClientRect();
      return {
        title: document.getElementById('backupMysqlModalTitle').innerText,
        mode: document.getElementById('backupDatabaseSelectionMode').value,
        objectText: document.getElementById('backupDatabaseObjectList').innerText,
        status: document.getElementById('backupDatabaseObjectStatus').innerText,
        saveDisabled: document.getElementById('backupMysqlSaveSourceButton').disabled,
        selectedDatabases: selectedBackupDatabaseNames(),
        selectedObjects: selectedBackupDatabaseObjects().map((object) => object.name),
        loadedDatabase: state.backupDatabaseObjectsDatabase,
        modal: { left: modal.left, right: modal.right, top: modal.top, bottom: modal.bottom },
        list: { left: list.left, right: list.right },
        footer: { left: footer.left, right: footer.right, top: footer.top, bottom: footer.bottom },
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    const payloads = await window.webContents.executeJavaScript('window.__databaseObjectPayloads');
    await window.webContents.executeJavaScript("document.getElementById('toast').classList.remove('visible')");
    const screenshotPath = path.join(captureRoot, 'database-object-selection-mobile.png');
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
    window.hide();

    const schemaPayload = payloads[0];
    const physicalPayload = payloads[1];
    const mysqlPayload = payloads[2];
    const ok = payloads.length === 3
      && schemaPayload.selector.databases.include[0].name === 'orders'
      && schemaPayload.selector.schemas.include[0].name === 'audit'
      && !schemaPayload.selector.tables
      && mysqlPayload.selector.tables.include[0].schema === 'orders'
      && mysqlPayload.selector.tables.include[0].name === 'invoices'
      && physicalPayload.selector.allDatabases === true
      && physicalPayload.consistency.backupMethod === 'physical'
      && physicalPayload.physicalExecution.sshConnectionId === 'connection_ssh'
      && physicalPayload.physicalExecution.remoteTemporaryDirectory === '/srv/deployerx-tmp'
      && physicalVisual.fieldsVisible && physicalVisual.scopeDisabled && !physicalVisual.saveDisabled && physicalVisual.requirement.includes('Production Linux')
      && visual.title === 'Add PostgreSQL source'
      && visual.mode === 'tables'
      && visual.objectText.includes('audit.events')
      && visual.objectText.includes('public.invoice_view')
      && !visual.saveDisabled
      && visual.modal.left >= 0 && visual.modal.right <= 390 && visual.modal.top >= 0 && visual.modal.bottom <= 844
      && visual.list.left >= visual.modal.left && visual.list.right <= visual.modal.right
      && visual.footer.left >= visual.modal.left && visual.footer.right <= visual.modal.right && visual.footer.top >= visual.modal.top && visual.footer.bottom <= visual.modal.bottom
      && !visual.overflow;
    process.stdout.write(`${JSON.stringify({ ok, payloads, visual, physicalVisual, screenshotPath })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
