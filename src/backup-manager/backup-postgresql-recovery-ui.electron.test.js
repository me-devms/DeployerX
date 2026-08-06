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
    window.databaseRestorePayloads = [];
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listBackupPostgresqlConnections: async () => [
        { id: 'connection_postgresql', name: 'Production PostgreSQL', currentDevice: true, lastTest: { status: 'success' } },
        { id: 'connection_postgresql_recovery', name: 'Recovery PostgreSQL', currentDevice: true, lastTest: { status: 'success' } }
      ],
      startBackupPostgresqlRestore: async (payload) => { window.databaseRestorePayloads.push(payload); return { id: 'restore_postgresql_ui', state: 'queued', target: { engine: 'postgresql' } }; },
      waitBackupPostgresqlRestore: async () => ({ id: 'restore_postgresql_ui', state: 'succeeded', target: { engine: 'postgresql' }, result: { restoredItems: 1, bytesRestored: 7340032, warnings: [] }, validation: { connectivity: 'pass', expectedObjects: 'pass', nativeIntegrityValidation: true } }),
      listBackupJobs: async () => [], listBackupRuns: async () => [], listBackupRestoreRuns: async () => [], listBackupMysqlRestoreRuns: async () => [],
      listBackupMariadbRestoreRuns: async () => [], listBackupPostgresqlRestoreRuns: async () => [], listBackupVerificationRuns: async () => []
    }});
    state.backupRecovery = blankBackupRecovery();
    state.backupRecovery.points = [{
      id: 'point_postgresql', jobId: 'job_postgresql', jobName: 'Production PostgreSQL protection',
      sourceId: 'source_postgresql', sourceName: 'Orders and accounts', sourceConnectionId: 'connection_postgresql',
      sourceType: 'database', sourceAdapterId: 'deployerx.database.postgresql.logical', type: 'full', consistency: 'application',
      capturedTo: '2026-08-04T10:30:00.000Z', availableCopyCount: 2, totalCopyCount: 2,
      verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'], deletionEligible: false },
      repositoryCopies: [{ repositoryId: 'repo_primary', repositoryName: 'Primary archive', state: 'available' }]
    }];
    state.backupRecovery.totalPoints = 1;
    state.backupRecovery.selectedPointId = 'point_postgresql';
    showView('backup');
    setBackupManagerTab('recovery');
    renderBackupRecoveryPoints();
    renderBackupRecoveryEntries();
    return true;
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-postgresql-recovery-ui-'));
  const window = new BrowserWindow({ show: false, width: 390, height: 844, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);
    const sourceModal = await window.webContents.executeJavaScript(`(() => {
      openBackupMysqlModal(null, 'postgresql');
      const result = {
        title: document.getElementById('backupMysqlModalTitle').innerText,
        subtitle: document.getElementById('backupMysqlModalSubtitle').innerText,
        port: document.getElementById('backupMysqlPort').value,
        maintenanceVisible: !document.getElementById('backupPostgresqlMaintenanceField').classList.contains('hidden'),
        maintenanceDatabase: document.getElementById('backupPostgresqlMaintenanceDatabase').value
      };
      closeBackupMysqlModal();
      return result;
    })()`);
    const recovery = await window.webContents.executeJavaScript(`(() => ({ summary: document.getElementById('backupRecoveryEntryList').innerText, result: document.getElementById('backupRecoveryResultCount').innerText, searchHidden: document.getElementById('backupRecoverySearchForm').classList.contains('hidden'), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }))()`);
    const opened = await window.webContents.executeJavaScript(`(async () => { await openBackupMysqlRestore(); return { visible: !document.getElementById('backupMysqlRestoreModal').classList.contains('hidden'), title: document.getElementById('backupMysqlRestoreTitle').innerText, warning: document.getElementById('backupMysqlRestoreWarning').innerText }; })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const visualReady = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('startupLoader')?.remove();
      document.getElementById('setupModal')?.classList.add('hidden');
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.getElementById('backupMysqlRestoreModal')?.classList.remove('hidden');
      return { startupPresent: Boolean(document.getElementById('startupLoader')), modalDisplay: getComputedStyle(document.getElementById('backupMysqlRestoreModal')).display };
    })()`);
    const newDatabaseVisual = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('backupMysqlRestoreModeNewDatabase').checked = true;
      syncBackupMysqlRestoreMode();
      document.getElementById('backupMysqlRestoreTarget').value = 'connection_postgresql_recovery';
      document.getElementById('backupMysqlRestoreDatabase').value = 'orders_restore';
      syncBackupMysqlRestoreMode();
      return { target: document.getElementById('backupMysqlRestoreTarget').value, database: document.getElementById('backupMysqlRestoreDatabase').value, warning: document.getElementById('backupMysqlRestoreWarning').innerText, startText: document.getElementById('backupMysqlRestoreStartButton').innerText };
    })()`);
    const screenshotPath = path.join(captureRoot, 'postgresql-restore-mobile.png');
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
    window.hide();
    const completed = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('backupMysqlRestoreModeNewDatabase').checked = true;
      syncBackupMysqlRestoreMode();
      document.getElementById('backupMysqlRestoreTarget').value = 'connection_postgresql_recovery';
      document.getElementById('backupMysqlRestoreDatabase').value = 'orders_restore';
      syncBackupMysqlRestoreMode();
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      return { state: state.backupRecovery.activeRestore.state, status: document.getElementById('backupMysqlRestoreStatus').innerText, payload: window.databaseRestorePayloads[0], alternateLabel: document.getElementById('backupMysqlRestoreModeAlternate').nextElementSibling.innerText };
    })()`);
    const modalBounds = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('#backupMysqlRestoreModal .modal-card').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; })()`);
    const ok = sourceModal.title === 'Add PostgreSQL source' && sourceModal.subtitle.includes('PostgreSQL 14') && sourceModal.port === '5432' && sourceModal.maintenanceVisible && sourceModal.maintenanceDatabase === 'postgres'
      && recovery.summary.includes('Full PostgreSQL backup') && recovery.result.includes('Application-consistent') && recovery.searchHidden && !recovery.horizontalOverflow
      && opened.visible && opened.title === 'Restore PostgreSQL backup' && opened.warning.includes('original cluster identity')
      && !visualReady.startupPresent && visualReady.modalDisplay !== 'none'
      && newDatabaseVisual.target === 'connection_postgresql_recovery' && newDatabaseVisual.database === 'orders_restore' && newDatabaseVisual.warning.includes('must be absent') && newDatabaseVisual.startText === 'Create and restore'
      && completed.state === 'succeeded' && completed.status.includes('7.0 MB restored') && completed.status.includes('native integrity validation passed')
      && completed.alternateLabel === 'Alternate cluster' && completed.payload.mode === 'new-database' && completed.payload.targetConnectionId === 'connection_postgresql_recovery' && completed.payload.targetDatabase === 'orders_restore'
      && modalBounds.left >= 0 && modalBounds.right <= 390 && modalBounds.top >= 0 && modalBounds.bottom <= 844;
    process.stdout.write(`${JSON.stringify({ ok, sourceModal, recovery, opened, visualReady, newDatabaseVisual, completed, modalBounds, screenshotPath })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
