const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-supabase-ui-'));
  const window = new BrowserWindow({ show: false, width: 390, height: 844, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await window.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.getElementById('setupModal')?.classList.add('hidden');
      window.__supabaseConnections = [];
      window.__supabaseCreatePayloads = [];
      window.__supabaseSourcePayloads = [];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupLocalConnections: async () => [],
        listBackupSshConnections: async () => [],
        listBackupPostgresqlConnections: async () => structuredClone(window.__supabaseConnections),
        listBackupDatabaseAdapters: async () => [{ adapterId: 'deployerx.database.postgresql.logical' }],
        createBackupPostgresqlConnection: async (payload) => {
          window.__supabaseCreatePayloads.push(structuredClone(payload));
          const connection = {
            id: 'supabase-' + window.__supabaseCreatePayloads.length,
            name: payload.name,
            adapterId: 'deployerx.database.postgresql.logical',
            currentDevice: true,
            endpoint: { ...payload, password: undefined },
            lastTest: { status: 'success', remotePlatform: { version: '16.4' } }
          };
          window.__supabaseConnections.push(connection);
          return structuredClone(connection);
        },
        testBackupPostgresqlConnection: async (id) => ({ connection: window.__supabaseConnections.find((item) => item.id === id), result: { status: 'success', endpointIdentity: { version: '16.4' } } }),
        discoverBackupPostgresqlDatabases: async () => ({ items: [{ kind: 'database', name: 'postgres', selectable: true }] }),
        saveBackupDatabaseSource: async (payload) => { window.__supabaseSourcePayloads.push(structuredClone(payload)); return { id: 'source-' + window.__supabaseSourcePayloads.length }; }
      }});
      return true;
    })()`);

    const initial = await window.webContents.executeJavaScript(`(() => {
      openBackupMysqlModal(null, 'postgresql');
      return {
        entryCount: document.querySelectorAll('[data-backup-database-adapter-id="deployerx.database.postgresql.logical"]').length,
        entryText: document.getElementById('backupAddPostgresqlConnectionButton').innerText,
        profileVisible: !document.getElementById('backupPostgresqlDeploymentProfileField').classList.contains('hidden'),
        supabaseFieldsHidden: document.getElementById('backupSupabaseProjectRefField').classList.contains('hidden'),
        port: document.getElementById('backupMysqlPort').value,
        tlsEnabled: !document.getElementById('backupMysqlTlsMode').disabled,
        physicalVisible: !document.getElementById('backupMysqlPhysicalOption').classList.contains('hidden'),
        title: document.getElementById('backupMysqlModalTitle').innerText
      };
    })()`);

    const postgresqlCreate = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('backupMysqlName').value = 'Production PostgreSQL';
      document.getElementById('backupMysqlHost').value = 'postgres.example.com';
      document.getElementById('backupMysqlUsername').value = 'backup';
      document.getElementById('backupMysqlPassword').value = 'secret-value';
      await discoverBackupMysql();
      const payload = structuredClone(window.__supabaseCreatePayloads.at(-1));
      closeBackupMysqlModal();
      return payload;
    })()`);

    const direct = await window.webContents.executeJavaScript(`(async () => {
      openBackupMysqlModal(null, 'postgresql');
      const profile = document.getElementById('backupPostgresqlDeploymentProfile');
      profile.value = 'supabase';
      profile.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('backupSupabaseProjectRef').value = 'abcdefghijklmnopqrst';
      document.getElementById('backupSupabaseProjectRef').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('backupMysqlName').value = 'Production Supabase';
      document.getElementById('backupMysqlHost').value = 'db.abcdefghijklmnopqrst.supabase.co';
      document.getElementById('backupMysqlUsername').value = 'postgres';
      document.getElementById('backupMysqlPassword').value = 'secret-value';
      const before = {
        projectVisible: !document.getElementById('backupSupabaseProjectRefField').classList.contains('hidden'),
        modeVisible: !document.getElementById('backupSupabaseConnectionModeField').classList.contains('hidden'),
        port: document.getElementById('backupMysqlPort').value,
        tls: document.getElementById('backupMysqlTlsMode').value,
        tlsDisabled: document.getElementById('backupMysqlTlsMode').disabled,
        maintenance: document.getElementById('backupPostgresqlMaintenanceDatabase').value,
        maintenanceDisabled: document.getElementById('backupPostgresqlMaintenanceDatabase').disabled,
        physicalHidden: document.getElementById('backupMysqlPhysicalOption').classList.contains('hidden'),
        walHidden: document.getElementById('backupPostgresqlWalArchiveField').classList.contains('hidden'),
        subtitle: document.getElementById('backupMysqlModalSubtitle').innerText,
        help: document.getElementById('backupMysqlSelectionHelp').innerText
      };
      await discoverBackupMysql();
      document.querySelector('[data-backup-mysql-database]').click();
      document.getElementById('backupMysqlSourceName').value = 'Supabase PostgreSQL data';
      syncBackupDatabaseObjectSelection();
      const sourceEnabled = !document.getElementById('backupMysqlSaveSourceButton').disabled;
      await saveBackupMysqlSource(new Event('submit', { cancelable: true }));
      return { before, sourceEnabled };
    })()`);

    const session = await window.webContents.executeJavaScript(`(async () => {
      openBackupMysqlModal(null, 'postgresql');
      const profile = document.getElementById('backupPostgresqlDeploymentProfile');
      profile.value = 'supabase';
      profile.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('backupSupabaseProjectRef').value = 'abcdefghijklmnopqrst';
      const mode = document.getElementById('backupSupabaseConnectionMode');
      mode.value = 'session-pooler';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('backupMysqlName').value = 'Supabase Session';
      document.getElementById('backupMysqlHost').value = 'aws-0-us-east-1.pooler.supabase.com';
      document.getElementById('backupMysqlUsername').value = 'postgres.abcdefghijklmnopqrst';
      document.getElementById('backupMysqlPassword').value = 'secret-value';
      await discoverBackupMysql();
      document.querySelector('[data-backup-mysql-database]').click();
      document.getElementById('backupMysqlSourceName').value = 'Supabase session data';
      syncBackupDatabaseObjectSelection();
      const sourceEnabled = !document.getElementById('backupMysqlSaveSourceButton').disabled;
      await saveBackupMysqlSource(new Event('submit', { cancelable: true }));
      return { port: window.__supabaseCreatePayloads.at(-1).port, sourceEnabled };
    })()`);

    const transaction = await window.webContents.executeJavaScript(`(async () => {
      openBackupMysqlModal(null, 'postgresql');
      const profile = document.getElementById('backupPostgresqlDeploymentProfile');
      profile.value = 'supabase';
      profile.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('backupSupabaseProjectRef').value = 'abcdefghijklmnopqrst';
      const mode = document.getElementById('backupSupabaseConnectionMode');
      mode.value = 'transaction-pooler';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      state.backupMysqlDatabases = [{ kind: 'database', name: 'postgres', selectable: true }];
      renderBackupMysqlDatabases();
      document.querySelector('[data-backup-mysql-database]').click();
      document.getElementById('backupMysqlSourceName').value = 'Blocked transaction source';
      syncBackupDatabaseObjectSelection();
      const beforeSaveCount = window.__supabaseSourcePayloads.length;
      await saveBackupMysqlSource(new Event('submit', { cancelable: true }));
      state.backupDatabaseAdapterIds = new Set(['deployerx.database.postgresql.logical']);
      state.backupPostgresqlConnections.push({ id: 'supabase-transaction', name: 'Transaction pooler', adapterId: 'deployerx.database.postgresql.logical', currentDevice: true, endpoint: { deploymentProfile: 'supabase', projectRef: 'abcdefghijklmnopqrst', connectionMode: 'transaction-pooler', host: 'pooler.supabase.com', port: 6543, username: 'postgres.abcdefghijklmnopqrst' }, lastTest: { status: 'success' } });
      renderBackupConnections();
      const rowButton = document.querySelector('[data-backup-connection-browse="supabase-transaction"]');
      const modal = document.querySelector('#backupMysqlModal .modal-card').getBoundingClientRect();
      return {
        port: document.getElementById('backupMysqlPort').value,
        restrictionVisible: !document.getElementById('backupSupabaseSourceRestriction').classList.contains('hidden'),
        sourceDisabled: document.getElementById('backupMysqlSaveSourceButton').disabled,
        physicalHidden: document.getElementById('backupMysqlPhysicalOption').classList.contains('hidden'),
        physicalDisabled: document.getElementById('backupMysqlPhysicalEnabled').disabled,
        walHidden: document.getElementById('backupPostgresqlWalArchiveField').classList.contains('hidden'),
        saveBlocked: window.__supabaseSourcePayloads.length === beforeSaveCount,
        error: document.getElementById('backupMysqlError').innerText,
        rowDisabled: rowButton.disabled,
        rowTitle: rowButton.title,
        contained: modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);

    const payloads = await window.webContents.executeJavaScript(`({ creates: window.__supabaseCreatePayloads, sources: window.__supabaseSourcePayloads })`);
    await window.webContents.executeJavaScript(`document.getElementById('toast')?.classList.remove('visible')`);
    const screenshotPath = path.join(captureRoot, 'supabase-transaction-pooler-mobile.png');
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

    const directPayload = payloads.creates.find((payload) => payload.connectionMode === 'direct');
    const sessionPayload = payloads.creates.find((payload) => payload.connectionMode === 'session-pooler');
    const ok = initial.entryCount === 1 && initial.entryText.includes('PostgreSQL') && initial.entryText.includes('Supabase')
      && initial.profileVisible && initial.supabaseFieldsHidden && initial.port === '5432' && initial.tlsEnabled && initial.physicalVisible && initial.title === 'Add PostgreSQL source'
      && postgresqlCreate.deploymentProfile === 'postgresql' && postgresqlCreate.connectionMode === undefined && postgresqlCreate.projectRef === undefined
      && direct.before.projectVisible && direct.before.modeVisible && direct.before.port === '5432' && direct.before.tls === 'verify-identity' && direct.before.tlsDisabled
      && direct.before.maintenance === 'postgres' && direct.before.maintenanceDisabled && direct.before.physicalHidden && direct.before.walHidden
      && direct.before.subtitle.includes('data and schema') && direct.before.help.includes('Storage objects') && direct.sourceEnabled
      && directPayload.deploymentProfile === 'supabase' && directPayload.projectRef === 'abcdefghijklmnopqrst' && directPayload.connectionMode === 'direct' && directPayload.port === 5432 && directPayload.tlsMode === 'verify-identity' && directPayload.maintenanceDatabase === 'postgres'
      && session.port === 5432 && session.sourceEnabled && sessionPayload.connectionMode === 'session-pooler' && sessionPayload.port === 5432
      && payloads.sources.length === 2
      && transaction.port === '6543' && transaction.restrictionVisible && transaction.sourceDisabled && transaction.physicalHidden && transaction.physicalDisabled && transaction.walHidden
      && transaction.saveBlocked && transaction.error.includes('cannot create backup Sources') && transaction.rowDisabled && transaction.rowTitle.includes('transaction poolers')
      && transaction.contained && !transaction.overflow;
    process.stdout.write(`${JSON.stringify({ ok, initial, direct, session, transaction, payloads, screenshotPath })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
