const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

async function prepare(window) {
  return window.webContents.executeJavaScript(`(() => {
    document.head.insertAdjacentHTML('beforeend', '<style id="backupUiTestOverrides">#startupLoader{display:none!important}.app-shell{display:grid!important}</style>');
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    window.databaseRestorePayloads = [];
    window.pitrPayloads = [];
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listBackupMariadbConnections: async () => [
        { id: 'connection_mariadb', name: 'Production MariaDB', currentDevice: true, lastTest: { status: 'success' } },
        { id: 'connection_mariadb_recovery', name: 'Recovery MariaDB', currentDevice: true, lastTest: { status: 'success' } }
      ],
      startBackupMariadbRestore: async (payload) => { window.databaseRestorePayloads.push(payload); return { id: 'restore_mariadb_ui', state: 'queued', target: { engine: 'mariadb' } }; },
      waitBackupMariadbRestore: async () => ({ id: 'restore_mariadb_ui', state: 'succeeded', target: { engine: 'mariadb' }, result: { restoredItems: 1, bytesRestored: 6291456, warnings: [] }, validation: { connectivity: 'pass', expectedObjects: 'pass', nativeIntegrityValidation: true } }),
      startBackupMariadbPitr: async (payload) => { window.pitrPayloads.push(payload); return { id: 'restore_mariadb_pitr_ui', state: 'queued', target: { engine: 'mariadb', operation: 'point-in-time' } }; },
      waitBackupMariadbPitr: async () => ({ id: 'restore_mariadb_pitr_ui', state: 'succeeded', target: { engine: 'mariadb', operation: 'point-in-time' }, result: { replayedFiles: 1, bytesRestored: 1048576, warnings: [] }, validation: { connectivity: 'pass', expectedObjects: 'pass', nativeIntegrityValidation: true } }),
      listBackupJobs: async () => [], listBackupRuns: async () => [], listBackupRestoreRuns: async () => [],
      listBackupMysqlRestoreRuns: async () => [], listBackupMariadbRestoreRuns: async () => [], listBackupMariadbPitrRuns: async () => [], listBackupVerificationRuns: async () => []
    }});
    state.backupRecovery = blankBackupRecovery();
    state.backupRecovery.points = [{
      id: 'point_mariadb', jobId: 'job_mariadb', jobName: 'Production MariaDB protection',
      sourceId: 'source_mariadb', sourceName: 'Orders MariaDB', sourceConnectionId: 'connection_mariadb',
      sourceType: 'database', sourceAdapterId: 'deployerx.database.mariadb.logical', type: 'full', consistency: 'application',
      capturedTo: '2026-08-04T09:30:00.000Z', availableCopyCount: 2, totalCopyCount: 2,
      verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'], deletionEligible: false },
      repositoryCopies: [{ repositoryId: 'repo_primary', repositoryName: 'Primary archive', state: 'available' }]
    }];
    state.backupRecovery.totalPoints = 1;
    state.backupRecovery.selectedPointId = 'point_mariadb';
    showView('backup');
    setBackupManagerTab('recovery');
    renderBackupRecoveryPoints();
    renderBackupRecoveryEntries();
    els.toast?.classList.remove('visible');
    return true;
  })()`);
}

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => ({
    summary: document.getElementById('backupRecoveryEntryList').innerText,
    result: document.getElementById('backupRecoveryResultCount').innerText,
    searchHidden: document.getElementById('backupRecoverySearchForm').classList.contains('hidden'),
    toastVisible: els.toast?.classList.contains('visible') ?? false,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }))()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-mariadb-recovery-ui-'));
  const window = new BrowserWindow({ show: false, width: 390, height: 844, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);
    const sourceModal = await window.webContents.executeJavaScript(`(() => {
      openBackupMysqlModal(null, 'mariadb');
      const result = { title: document.getElementById('backupMysqlModalTitle').innerText, subtitle: document.getElementById('backupMysqlModalSubtitle').innerText, help: document.getElementById('backupMysqlSelectionHelp').innerText, pitrVisible: !document.getElementById('backupMysqlPitrOption').classList.contains('hidden') };
      closeBackupMysqlModal();
      return result;
    })()`);
    const recovery = await measure(window);
    const opened = await window.webContents.executeJavaScript(`(async () => { await openBackupMysqlRestore(); return { visible: !document.getElementById('backupMysqlRestoreModal').classList.contains('hidden'), title: document.getElementById('backupMysqlRestoreTitle').innerText, warning: document.getElementById('backupMysqlRestoreWarning').innerText }; })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const visualReady = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('startupLoader')?.remove();
      document.getElementById('setupModal')?.classList.add('hidden');
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.getElementById('backupMysqlRestoreModal')?.classList.remove('hidden');
      return { startupPresent: Boolean(document.getElementById('startupLoader')), modalDisplay: getComputedStyle(document.getElementById('backupMysqlRestoreModal')).display };
    })()`);
    const screenshotPath = path.join(captureRoot, 'mariadb-restore-mobile.png');
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
    window.hide();
    const completed = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('backupMysqlRestoreModeAlternate').checked = true;
      document.getElementById('backupMysqlRestoreConflictPolicy').value = 'overwrite';
      syncBackupMysqlRestoreMode();
      document.getElementById('backupMysqlRestoreTarget').value = 'connection_mariadb_recovery';
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      return { state: state.backupRecovery.activeRestore.state, status: document.getElementById('backupMysqlRestoreStatus').innerText, payload: window.databaseRestorePayloads[0], conflictVisible: !document.getElementById('backupMysqlRestoreConflictField').classList.contains('hidden') };
    })()`);
    const modalBounds = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('#backupMysqlRestoreModal .modal-card').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; })()`);
    const pitr = await window.webContents.executeJavaScript(`(async () => {
      closeBackupMysqlRestore();
      state.backupRecovery.points = [{
        id: 'point_mariadb_log', jobId: 'job_mariadb', jobName: 'Production MariaDB protection', sourceId: 'source_mariadb', sourceName: 'Orders MariaDB', sourceConnectionId: 'connection_mariadb',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.mariadb.logical', type: 'log', consistency: 'application', capturedTo: '2026-08-04T10:30:00.000Z', availableCopyCount: 1, totalCopyCount: 1,
        pointInTime: {
          earliest: '2026-08-04T09:30:00.000Z', latest: '2026-08-04T10:30:00.000Z',
          earliestCoordinate: { version: 1, engine: 'mariadb', file: 'mariadb-bin.000010', position: 4096, capturedAt: '2026-08-04T09:30:00.000Z', serverIdentityFingerprint: 'sha256:server' },
          latestCoordinate: { version: 1, engine: 'mariadb', file: 'mariadb-bin.000010', position: 9000, capturedAt: '2026-08-04T10:30:00.000Z', serverIdentityFingerprint: 'sha256:server' }
        }, verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'], deletionEligible: false }, repositoryCopies: [{ repositoryId: 'repo_primary', repositoryName: 'Primary archive', state: 'available' }]
      }];
      state.backupRecovery.selectedPointId = 'point_mariadb_log'; renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      await openBackupMysqlRestore();
      document.getElementById('backupMysqlPitrTimestamp').value = '2026-08-04T10:00:00';
      syncBackupMysqlRestoreMode();
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      const rect = document.querySelector('#backupMysqlRestoreModal .modal-card').getBoundingClientRect();
      return { title: document.getElementById('backupMysqlRestoreTitle').innerText, stopVisible: !document.getElementById('backupMysqlPitrStop').classList.contains('hidden'), status: document.getElementById('backupMysqlRestoreStatus').innerText, payload: window.pitrPayloads[0], contained: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    const pitrScreenshotPath = path.join(captureRoot, 'mariadb-pitr-mobile.png');
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fs.writeFile(pitrScreenshotPath, (await window.webContents.capturePage()).toPNG());
    window.hide();
    const ok = sourceModal.title === 'Add MariaDB source' && sourceModal.subtitle.includes('MariaDB 10.6') && sourceModal.help.includes('exact tables and views') && sourceModal.pitrVisible
      && recovery.summary.includes('Full MariaDB backup') && recovery.result.includes('Application-consistent') && recovery.searchHidden && !recovery.toastVisible && !recovery.horizontalOverflow
      && opened.visible && opened.title === 'Restore MariaDB backup' && opened.warning.includes('original server identity')
      && !visualReady.startupPresent && visualReady.modalDisplay !== 'none'
      && completed.state === 'succeeded' && completed.status.includes('6.0 MB restored') && completed.status.includes('native integrity validation passed')
      && completed.conflictVisible && completed.payload.mode === 'alternate' && completed.payload.targetConnectionId === 'connection_mariadb_recovery' && completed.payload.conflictPolicy === 'overwrite'
      && modalBounds.left >= 0 && modalBounds.right <= 390 && modalBounds.top >= 0 && modalBounds.bottom <= 844
      && pitr.title.includes('Recover MariaDB to point in time') && pitr.stopVisible && pitr.status.includes('1 binary-log file replayed') && pitr.payload.terminalRecoveryPointId === 'point_mariadb_log' && pitr.payload.stop.timestamp === '2026-08-04T10:00:00.000Z' && pitr.contained && !pitr.horizontalOverflow;
    process.stdout.write(`${JSON.stringify({ ok, sourceModal, recovery, opened, visualReady, completed, modalBounds, pitr, screenshotPath, pitrScreenshotPath })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
