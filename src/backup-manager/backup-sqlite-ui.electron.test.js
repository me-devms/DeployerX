const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const databasePath = 'C:\\data\\orders.sqlite3';
const targetPath = 'C:\\recovery\\orders-restored.sqlite3';
const encodedPaths = Buffer.from(JSON.stringify({ databasePath, targetPath })).toString('base64');
const successfulTest = {
  adapterId: 'deployerx.database.sqlite.native', adapterVersion: '0.1.0', status: 'success', testedAt: '2026-08-04T12:00:00.000Z', latencyMs: 24,
  remotePlatform: { engine: 'sqlite', version: '3.45.1' },
  endpointIdentity: { journalMode: 'wal', pageSize: 4096, pageCount: 128, objectCount: 2, quickCheck: 'ok', databaseFingerprint: `sha256:${'1'.repeat(64)}` },
  checks: [{ id: 'quick-check', status: 'pass', safeMessage: 'SQLite quick_check passed.' }]
};
const encodedTest = Buffer.from(JSON.stringify(successfulTest)).toString('base64');

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-sqlite-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`));
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await window.webContents.executeJavaScript(`
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.getElementById('setupModal')?.classList.add('hidden');
      window.__sqlitePaths = JSON.parse(atob('${encodedPaths}'));
      window.__sqliteTest = JSON.parse(atob('${encodedTest}'));
      window.__sqliteConnections = [];
      window.__sqliteSourcePayload = null;
      window.__sqliteRestorePayload = null;
      window.__sqliteCanceled = null;
      window.__sqliteRestore = {
        id: 'restore-sqlite', state: 'succeeded', createdAt: '2026-08-04T12:30:00.000Z', startedAt: '2026-08-04T12:30:01.000Z', updatedAt: '2026-08-04T12:30:11.000Z',
        recoveryPointIds: ['point-sqlite'], targetConnectionId: 'connection-sqlite',
        target: { operation: 'alternate-file', mode: 'alternate', engine: 'sqlite', targetPath: window.__sqlitePaths.targetPath, targetName: 'orders-restored.sqlite3' },
        progress: { phase: 'complete', itemsTotal: 1, itemsCompleted: 1, bytesWritten: 524288, startedAt: '2026-08-04T12:30:01.000Z', updatedAt: '2026-08-04T12:30:11.000Z' },
        validation: { state: 'pass', connectivity: 'pass', contentDigest: 'sha256:${'a'.repeat(64)}', expectedObjects: 'pass', nativeIntegrityValidation: true },
        result: { restoredItems: 1, bytesRestored: 524288, targetName: 'orders-restored.sqlite3', completedAt: '2026-08-04T12:30:11.000Z' }
      };
      const empty = async () => [];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupLocalConnections: empty, listBackupSshConnections: empty, listBackupMysqlConnections: empty,
        listBackupMariadbConnections: empty, listBackupPostgresqlConnections: empty, listBackupSqlServerConnections: empty,
        listBackupOracleConnections: empty, listBackupMongoDbConnections: empty,
        listBackupSqliteConnections: async () => structuredClone(window.__sqliteConnections),
        createBackupSqliteConnection: async (payload) => {
          const created = { id: 'connection-sqlite', name: payload.name, currentDevice: true, endpoint: { databasePath: payload.databasePath, sqliteExecutable: payload.sqliteExecutable, timeoutMs: payload.timeoutMs }, trust: { mode: 'local-file-identity', fingerprint: null }, lastTest: null };
          window.__sqliteConnections.push(created);
          return structuredClone(created);
        },
        testBackupSqliteConnection: async (id) => {
          const connection = window.__sqliteConnections.find((candidate) => candidate.id === id);
          connection.lastTest = structuredClone(window.__sqliteTest);
          connection.trust.fingerprint = window.__sqliteTest.endpointIdentity.databaseFingerprint;
          return { connection: structuredClone(connection), result: structuredClone(window.__sqliteTest) };
        },
        discoverBackupSqliteDatabases: async () => ({ items: [{ name: 'main', kind: 'database', selectable: true, path: window.__sqlitePaths.databasePath, objectCount: 2 }], nextCursor: null }),
        saveBackupDatabaseSource: async (payload) => { window.__sqliteSourcePayload = structuredClone(payload); return { id: 'source-sqlite', ...structuredClone(payload) }; },
        listBackupJobs: empty, listBackupRuns: empty, listBackupRestoreRuns: empty, listBackupMysqlRestoreRuns: empty,
        listBackupMysqlPhysicalRestoreRuns: empty, listBackupMariadbRestoreRuns: empty, listBackupMysqlPitrRuns: empty,
        listBackupMariadbPitrRuns: empty, listBackupPostgresqlRestoreRuns: empty, listBackupPostgresqlPitrRuns: empty,
        listBackupSqlServerRestoreRuns: empty, listBackupOracleRestoreRuns: empty, listBackupMongoDbRestoreRuns: empty,
        listBackupSqliteRestoreRuns: async () => [structuredClone(window.__sqliteRestore)], listBackupVerificationRuns: empty,
        startBackupSqliteRestore: async (payload) => { window.__sqliteRestorePayload = structuredClone(payload); return { id: 'restore-sqlite', state: 'queued', target: { operation: 'alternate-file', mode: 'alternate', engine: 'sqlite' } }; },
        waitBackupSqliteRestore: async () => structuredClone(window.__sqliteRestore),
        cancelBackupSqliteRestore: async (id) => { window.__sqliteCanceled = id; return { id, state: 'canceled', target: { operation: 'alternate-file', mode: 'alternate', engine: 'sqlite' } }; }
      }});
      showView('backup');
      setBackupManagerTab('sources');
      true;
    `);

    const source = await window.webContents.executeJavaScript(`(async () => {
      openBackupSqliteModal();
      els.backupSqliteName.value = 'Orders SQLite';
      els.backupSqliteDatabasePath.value = window.__sqlitePaths.databasePath;
      els.backupSqliteExecutable.value = 'sqlite3';
      els.backupSqliteTimeout.value = '30000';
      await discoverBackupSqlite();
      els.backupSqliteSourceName.value = 'Orders application database';
      els.backupSqliteSourceName.dispatchEvent(new Event('input'));
      const beforeSave = {
        selectionVisible: !els.backupSqliteSelection.classList.contains('hidden'),
        mainChecked: els.backupSqliteMainDatabase.checked,
        mainLocked: els.backupSqliteMainDatabase.disabled,
        saveEnabled: !els.backupSqliteSaveSourceButton.disabled,
        evidence: els.backupSqliteEvidence.innerText
      };
      await saveBackupSqliteSource(new Event('submit', { cancelable: true }));
      return { beforeSave, payload: window.__sqliteSourcePayload };
    })()`);

    const job = await window.webContents.executeJavaScript(`(() => {
      state.backupJobWizard = blankBackupJobWizard();
      state.backupJobWizard.readiness.sources = [{
        id: 'source-sqlite', name: 'Orders application database', sourceType: 'database', adapterId: 'deployerx.database.sqlite.native', connectionName: 'Orders SQLite',
        selection: { databases: { include: [{ name: 'main' }] } }, objectKind: 'database', objectCount: 1,
        requestedConsistency: { backupMethod: 'logical', method: 'sqlite-online-backup', backupMode: 'full', captureCoordinates: false }, readiness: { ready: true }
      }];
      state.backupJobWizard.sourceId = 'source-sqlite';
      syncBackupJobModeForSource();
      const incremental = els.backupJobForm.querySelector('input[name="backupJobMode"][value="incremental"]');
      const differential = els.backupJobForm.querySelector('input[name="backupJobMode"][value="differential"]');
      const full = els.backupJobForm.querySelector('input[name="backupJobMode"][value="full"]');
      return { detail: backupJobSourceDetail(state.backupJobWizard.readiness.sources[0]), incrementalDisabled: incremental.disabled, incrementalTitle: incremental.closest('label').title, differentialDisabled: differential.disabled, fullLabel: full.closest('label').innerText };
    })()`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [{
        id: 'point-sqlite', jobId: 'job-sqlite', jobName: 'Orders SQLite protection', sourceId: 'source-sqlite', sourceName: 'Orders application database', sourceConnectionId: 'connection-sqlite',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.sqlite.native', backupMethod: 'logical', type: 'full', consistency: 'application',
        capturedTo: '2026-08-04T12:00:00.000Z', availableCopyCount: 2, totalCopyCount: 2, verification: { state: 'succeeded' }, repositoryCopies: [{ state: 'available' }, { state: 'available' }]
      }];
      state.backupRecovery.selectedPointId = 'point-sqlite';
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const summary = els.backupRecoveryEntryList.innerText;
      const action = els.backupRecoveryRestoreButton.innerText;
      openBackupSqliteRestore();
      els.backupSqliteRestoreTargetPath.value = window.__sqlitePaths.targetPath;
      await startBackupSqliteRestore(new Event('submit', { cancelable: true }));
      const startedPayload = structuredClone(window.__sqliteRestorePayload);
      const completedStatus = els.backupSqliteRestoreStatus.innerText;
      state.backupRecovery.activeRestore = { id: 'restore-sqlite-cancel', state: 'running', target: { operation: 'alternate-file', engine: 'sqlite' } };
      await cancelOrCloseBackupSqliteRestore();
      return { summary, action, startedPayload, completedStatus, canceledId: window.__sqliteCanceled };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      closeBackupSqliteRestore();
      setBackupManagerTab('activity');
      await loadBackupActivity();
      await openBackupActivityDetail('restore', 'restore-sqlite');
      return { row: els.backupActivityList.innerText, metrics: els.backupActivityDetailMetrics.innerText };
    })()`);

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mobile = await window.webContents.executeJavaScript(`(() => {
      closeBackupActivityDetail();
      state.backupRecovery.selectedPointId = 'point-sqlite';
      openBackupSqliteRestore();
      const card = els.backupSqliteRestoreModal.querySelector('.modal-card').getBoundingClientRect();
      return { card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    const screenshotPath = path.join(captureRoot, 'sqlite-recovery-mobile.png');
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

    const valid = source.beforeSave.selectionVisible && source.beforeSave.mainChecked && source.beforeSave.mainLocked && source.beforeSave.saveEnabled
      && source.beforeSave.evidence.includes('quick_check passed') && source.payload?.selector?.databases?.include?.[0]?.name === 'main'
      && source.payload?.consistency?.method === 'sqlite-online-backup' && source.payload?.consistency?.backupMode === 'full' && source.payload?.consistency?.captureCoordinates === false
      && job.detail.includes('complete main database') && job.incrementalDisabled && job.incrementalTitle.includes('full database images') && job.differentialDisabled && job.fullLabel.includes('Online database image')
      && recovery.summary.includes('Complete SQLite main database') && recovery.action.includes('Recover alternate file')
      && recovery.startedPayload?.recoveryPointId === 'point-sqlite' && recovery.startedPayload?.mode === 'alternate' && recovery.startedPayload?.targetPath === targetPath
      && recovery.completedStatus.includes('quick_check passed') && recovery.canceledId === 'restore-sqlite-cancel'
      && activity.row.includes('SQLite alternate file recovery') && activity.metrics.includes('orders-restored.sqlite3') && activity.metrics.includes('sha256:')
      && activity.metrics.includes('Expected objects') && activity.metrics.includes('pass') && activity.metrics.includes('Native validation') && activity.metrics.includes('Passed')
      && !mobile.overflow && mobile.card.left >= 0 && mobile.card.right <= mobile.width && mobile.card.top >= 0 && mobile.card.bottom <= mobile.height;
    process.stdout.write(`${JSON.stringify({ ok: valid, source, job, recovery, activity, mobile, screenshotPath })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
