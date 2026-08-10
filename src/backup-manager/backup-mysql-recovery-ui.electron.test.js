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
    window.pitrPayloads = [];
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listBackupMysqlConnections: async () => [
        { id: 'connection_mysql', name: 'Production MySQL', currentDevice: true, lastTest: { status: 'success' } },
        { id: 'connection_mysql_recovery', name: 'Recovery MySQL', currentDevice: true, lastTest: { status: 'success' } }
      ],
      startBackupMysqlRestore: async (payload) => { window.databaseRestorePayloads.push(payload); return { id: 'restore_mysql_ui', state: 'queued', target: { engine: 'mysql' } }; },
      waitBackupMysqlRestore: async () => ({ id: 'restore_mysql_ui', state: 'succeeded', target: { engine: 'mysql' }, result: { restoredItems: 1, bytesRestored: 8388608, warnings: [] }, validation: { connectivity: 'pass', expectedObjects: 'pass', nativeIntegrityValidation: true } }),
      startBackupMysqlPitr: async (payload) => { window.pitrPayloads.push(payload); return { id: 'restore_mysql_pitr_ui', state: 'queued', target: { engine: 'mysql', operation: 'point-in-time' } }; },
      waitBackupMysqlPitr: async () => ({ id: 'restore_mysql_pitr_ui', state: 'succeeded', target: { engine: 'mysql', operation: 'point-in-time' }, result: { replayedFiles: 2, bytesRestored: 2097152, warnings: [] }, validation: { connectivity: 'pass', expectedObjects: 'pass', nativeIntegrityValidation: true } }),
      listBackupJobs: async () => [], listBackupRuns: async () => [], listBackupRestoreRuns: async () => [],
      listBackupMysqlRestoreRuns: async () => [], listBackupMysqlPitrRuns: async () => [], listBackupVerificationRuns: async () => []
    }});
    state.backupRecovery = blankBackupRecovery();
    state.backupRecovery.points = [{
      id: 'point_mysql', jobId: 'job_mysql', jobName: 'Production MySQL protection',
      sourceId: 'source_mysql', sourceName: 'Orders and analytics', sourceConnectionId: 'connection_mysql',
      sourceType: 'database', sourceAdapterId: 'deployerx.database.mysql.logical', type: 'full', consistency: 'application',
      capturedTo: '2026-08-04T08:30:00.000Z', availableCopyCount: 2, totalCopyCount: 2,
      verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'], deletionEligible: false },
      repositoryCopies: [{ repositoryId: 'repo_primary', repositoryName: 'Primary archive', state: 'available' }]
    }];
    state.backupRecovery.totalPoints = 1;
    state.backupRecovery.selectedPointId = 'point_mysql';
    showView('backup');
    setBackupManagerTab('recovery');
    renderBackupRecoveryPoints();
    renderBackupRecoveryEntries();
    els.toast?.classList.remove('visible');
    return true;
  })()`);
}

async function measureRecovery(window) {
  return window.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('backupPanelRecovery').getBoundingClientRect();
    const workspace = document.getElementById('backupRecoveryWorkspace').getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight }, panel: { left: panel.left, right: panel.right }, workspace: { left: workspace.left, right: workspace.right },
      pointText: document.getElementById('backupRecoveryPointList').innerText,
      summaryText: document.getElementById('backupRecoveryEntryList').innerText,
      resultText: document.getElementById('backupRecoveryResultCount').innerText,
      searchHidden: document.getElementById('backupRecoverySearchForm').classList.contains('hidden'),
      restoreText: document.getElementById('backupRecoveryRestoreButton').innerText,
      toastVisible: els.toast?.classList.contains('visible') ?? false,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-mysql-recovery-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);
    const desktop = await measureRecovery(window);
    const desktopPath = path.join(captureRoot, 'mysql-recovery-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mobile = await measureRecovery(window);
    const openResult = await window.webContents.executeJavaScript(`(async () => { await openBackupMysqlRestore(); return !document.getElementById('backupMysqlRestoreModal').classList.contains('hidden'); })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const modal = await window.webContents.executeJavaScript(`(() => { const card = document.querySelector('#backupMysqlRestoreModal .modal-card'); const rect = card.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, summary: document.getElementById('backupMysqlRestoreSummary').innerText, warning: card.querySelector('.backup-mysql-restore-warning').innerText, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    const mobilePath = path.join(captureRoot, 'mysql-restore-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());
    const completed = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('backupMysqlRestoreModeNewDatabase').checked = true;
      syncBackupMysqlRestoreMode();
      document.getElementById('backupMysqlRestoreTarget').value = 'connection_mysql_recovery';
      document.getElementById('backupMysqlRestoreDatabase').value = 'orders_restore';
      syncBackupMysqlRestoreMode();
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      return { state: state.backupRecovery.activeRestore.state, status: document.getElementById('backupMysqlRestoreStatus').innerText, payload: window.databaseRestorePayloads[0], targetVisible: !document.getElementById('backupMysqlRestoreTargetField').classList.contains('hidden'), databaseVisible: !document.getElementById('backupMysqlRestoreDatabaseField').classList.contains('hidden') };
    })()`);
    const jobMode = await window.webContents.executeJavaScript(`(() => {
      closeBackupMysqlRestore();
      state.backupJobWizard = { step: 1, sourceId: '', repositoryIds: [], readiness: { sources: [{ id: 'source_mysql', name: 'Orders and analytics', sourceType: 'database', objectCount: 2, connectionName: 'Production MySQL', readiness: { ready: true, message: 'Ready' } }], repositories: [] } };
      renderBackupJobChoices();
      syncBackupJobModeForSource();
      const detail = document.getElementById('backupJobSources').innerText;
      const incrementalDisabled = document.querySelector('input[name="backupJobMode"][value="incremental"]').disabled;
      const fullChecked = document.querySelector('input[name="backupJobMode"][value="full"]').checked;
      state.backupJobWizard.readiness.sources = [{ id: 'source_mysql_pitr', name: 'Orders PITR', sourceType: 'database', adapterId: 'deployerx.database.mysql.logical', objectCount: 1, objectKind: 'database', connectionName: 'Production MySQL', selection: { allDatabases: false, databases: { include: [{ name: 'orders' }] }, schemas: { include: [] }, tables: { include: [] } }, requestedConsistency: { captureCoordinates: true }, readiness: { ready: true, message: 'Ready' } }];
      state.backupJobWizard.sourceId = 'source_mysql_pitr';
      renderBackupJobChoices();
      syncBackupJobModeForSource();
      return { detail, incrementalDisabled, fullChecked, pitrIncrementalEnabled: !document.querySelector('input[name="backupJobMode"][value="incremental"]').disabled, pitrDetail: document.getElementById('backupJobSources').innerText };
    })()`);
    const pitr = await window.webContents.executeJavaScript(`(async () => {
      state.backupRecovery.points = [{
        id: 'point_mysql_log', jobId: 'job_mysql', jobName: 'Production MySQL protection', sourceId: 'source_mysql', sourceName: 'Orders and analytics', sourceConnectionId: 'connection_mysql',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.mysql.logical', type: 'log', consistency: 'application', capturedTo: '2026-08-04T09:30:00.000Z', availableCopyCount: 2, totalCopyCount: 2,
        pointInTime: {
          earliest: '2026-08-04T08:30:00.000Z', latest: '2026-08-04T09:30:00.000Z',
          earliestCoordinate: { version: 1, engine: 'mysql', file: 'mysql-bin.000042', position: 8192, capturedAt: '2026-08-04T08:30:00.000Z', serverIdentityFingerprint: 'sha256:server' },
          latestCoordinate: { version: 1, engine: 'mysql', file: 'mysql-bin.000043', position: 7000, capturedAt: '2026-08-04T09:30:00.000Z', serverIdentityFingerprint: 'sha256:server' }
        }, verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'], deletionEligible: false }, repositoryCopies: [{ repositoryId: 'repo_primary', repositoryName: 'Primary archive', state: 'available' }]
      }];
      state.backupRecovery.selectedPointId = 'point_mysql_log';
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const recoveryButton = document.getElementById('backupRecoveryRestoreButton').innerText;
      await openBackupMysqlRestore();
      document.getElementById('backupMysqlPitrStopCoordinate').checked = true;
      syncBackupMysqlPitrStopMode();
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      const rect = document.querySelector('#backupMysqlRestoreModal .modal-card').getBoundingClientRect();
      return {
        recoveryButton, title: document.getElementById('backupMysqlRestoreTitle').innerText,
        stopVisible: !document.getElementById('backupMysqlPitrStop').classList.contains('hidden'), coordinateVisible: !document.getElementById('backupMysqlPitrCoordinateFields').classList.contains('hidden'),
        status: document.getElementById('backupMysqlRestoreStatus').innerText, payload: window.pitrPayloads[0],
        contained: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);

    const valid = [desktop, mobile].every((result) => result.pointText.includes('Production MySQL Protection') && result.summaryText.includes('Orders and analytics') && result.resultText.includes('Application-consistent') && result.searchHidden && result.restoreText.includes('Restore Database') && !result.toastVisible && !result.horizontalOverflow && result.workspace.left >= result.panel.left && result.workspace.right <= result.panel.right + 1)
      && openResult && modal.summary.includes('Orders and analytics') && modal.warning.includes('Original server restore') && modal.left >= 0 && modal.right <= mobile.viewport.width && modal.top >= 0 && modal.bottom <= mobile.viewport.height && !modal.horizontalOverflow
      && completed.state === 'succeeded' && completed.status.includes('8.0 MB restored') && completed.status.includes('native integrity validation passed')
      && completed.targetVisible && completed.databaseVisible && completed.payload.mode === 'new-database' && completed.payload.targetConnectionId === 'connection_mysql_recovery' && completed.payload.targetDatabase === 'orders_restore'
      && jobMode.detail.includes('2 selected databases') && jobMode.incrementalDisabled && jobMode.fullChecked && jobMode.pitrIncrementalEnabled && jobMode.pitrDetail.includes('PITR enabled')
      && pitr.recoveryButton.includes('Recover To Point In Time') && pitr.title.includes('Recover MySQL to point in time') && pitr.stopVisible && pitr.coordinateVisible && pitr.status.includes('2 binary-log files replayed')
      && pitr.payload.terminalRecoveryPointId === 'point_mysql_log' && pitr.payload.stop.coordinate.file === 'mysql-bin.000043' && pitr.payload.stop.coordinate.position === 7000 && pitr.contained && !pitr.horizontalOverflow;
    process.stdout.write(`${JSON.stringify({ ok: valid, desktop, mobile, modal, completed, jobMode, pitr, screenshots: { desktopPath, mobilePath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
