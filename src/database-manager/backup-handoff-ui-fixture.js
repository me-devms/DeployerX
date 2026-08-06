const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

async function waitFor(window, expression, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

app.whenReady().then(async () => {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) throw new Error('Database backup handoff fixture requires an output directory.');
  await fs.mkdir(outputDirectory, { recursive: true });
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
      window.__handoffConnection = null;
      window.__handoffSourceWrites = 0;
      const empty = async () => [];
      const profile = {
        id: 'profile-postgresql', revision: 1, name: 'Production PostgreSQL', driverId: 'postgresql', sharedConnectionId: 'connection-postgresql',
        endpoint: { kind: 'network', host: 'db.example.test', port: 5432 }, database: 'orders', defaultSchema: 'public', environment: 'production', accessMode: 'read-only',
        ssl: { mode: 'verify-full' }, tunnel: { type: 'none' }, settings: { username: 'backup_user' }, credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-password' }]
      };
      const unavailable = { ...profile, id: 'profile-unavailable', name: 'Passwordless PostgreSQL', sharedConnectionId: 'connection-unavailable', credentialSecretRefs: [] };
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        prepareDatabaseProfileBackup: async () => {
          window.__handoffConnection = {
            id: profile.sharedConnectionId, name: profile.name, adapterId: 'deployerx.database.postgresql.logical', adapterVersion: '1.4.0', currentDevice: true,
            endpoint: { host: 'db.example.test', port: 5432, username: 'backup_user', database: 'postgres', maintenanceDatabase: 'postgres', tlsMode: 'verify-identity', timeoutMs: 60000, psqlExecutable: 'psql', pgDumpExecutable: 'pg_dump' },
            workerAffinity: ['device:test-device'], secretRefIds: ['secret-password'], trust: { mode: 'verify-identity', fingerprint: null }, lastTest: null
          };
          return { profileId: profile.id, driverId: 'postgresql', connectionId: profile.sharedConnectionId, connection: structuredClone(window.__handoffConnection) };
        },
        listBackupLocalConnections: empty, listBackupSshConnections: empty, listBackupMysqlConnections: empty, listBackupMariadbConnections: empty,
        listBackupPostgresqlConnections: async () => window.__handoffConnection ? [structuredClone(window.__handoffConnection)] : [],
        listBackupSqlServerConnections: empty, listBackupOracleConnections: empty, listBackupMongoDbConnections: empty, listBackupNeo4jConnections: empty,
        listBackupClickHouseConnections: empty, listBackupInfluxDbConnections: empty, listBackupInfluxDb3CoreConnections: empty, listBackupInfluxDb3EnterpriseConnections: empty,
        listBackupCockroachDbConnections: empty, listBackupRedisConnections: empty, listBackupSearchSnapshotConnections: empty, listBackupScyllaManagerConnections: empty,
        listBackupSqliteConnections: empty, listBackupJobs: empty, listBackupRuns: empty,
        testBackupPostgresqlConnection: async () => {
          window.__handoffConnection.lastTest = { status: 'success', testedAt: '2026-08-05T12:00:00.000Z', latencyMs: 18, remotePlatform: { version: '16.4' }, endpointIdentity: { serverFingerprint: 'sha256:postgres' } };
          return { connection: structuredClone(window.__handoffConnection), result: structuredClone(window.__handoffConnection.lastTest) };
        },
        discoverBackupPostgresqlDatabases: async () => ({ items: [{ name: 'orders', kind: 'database', selectable: true, system: false }], nextCursor: null }),
        saveBackupDatabaseSource: async () => { window.__handoffSourceWrites += 1; }
      }});
      state.setup.mode = 'local';
      state.databaseManager.profiles = [profile, unavailable];
      state.databaseManager.loading = false;
      state.databaseManager.error = '';
      showView('database');
      state.databaseManager.profiles = [profile, unavailable];
      renderDatabaseProfiles();
      true;
    `);
    await window.webContents.executeJavaScript(`(async () => {
      const profile = state.databaseManager.profiles.find((item) => item.id === 'profile-postgresql');
      const button = document.querySelector('[data-database-profile-backup="profile-postgresql"]');
      await protectDatabaseProfileWithBackupManager(profile, button);
    })()`);
    await waitFor(window, `!document.getElementById('backupMysqlModal').classList.contains('hidden') && document.getElementById('backupMysqlDatabaseList').innerText.includes('orders')`, 3000);

    const desktop = await window.webContents.executeJavaScript(`(() => {
      const unavailable = document.querySelector('[data-database-profile-backup="profile-unavailable"]');
      const sourceRows = [...document.querySelectorAll('#backupSourceConnections .backup-source-row')];
      return {
        currentView: state.currentView,
        activeTab: state.backupManagerTab,
        modalVisible: !els.backupMysqlModal.classList.contains('hidden'),
        engine: state.backupDatabaseEngine,
        connectionId: state.backupMysqlConnectionId,
        discoveredText: els.backupMysqlDatabaseList.innerText,
        sourceConnectionVisible: sourceRows.some((row) => row.innerText.includes('Production PostgreSQL')),
        unavailableDisabled: unavailable.disabled,
        unavailableReason: unavailable.title,
        sourceWrites: window.__handoffSourceWrites
      };
    })()`);
    const desktopPath = path.join(outputDirectory, 'database-manager-backup-handoff-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    window.setContentSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mobile = await window.webContents.executeJavaScript(`(() => {
      const card = els.backupMysqlModal.querySelector('.modal-card').getBoundingClientRect();
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        viewport: { width: innerWidth, height: innerHeight },
        bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    })()`);
    const mobilePath = path.join(outputDirectory, 'database-manager-backup-handoff-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());
    process.stdout.write(`${JSON.stringify({ desktop, mobile, desktopPath, mobilePath })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
