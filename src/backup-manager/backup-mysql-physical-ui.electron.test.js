const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-mysql-physical-ui-'));
  const window = new BrowserWindow({ show: false, width: 390, height: 844, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await window.webContents.executeJavaScript(`(async () => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.getElementById('setupModal')?.classList.add('hidden');
      window.__physicalRestorePayloads = [];
      window.__physicalRestoreCancellations = [];
      const physicalSources = [
        { id: 'source_mysql_physical', name: 'Production MySQL physical', sourceType: 'database', adapterId: 'deployerx.database.mysql.logical', connectionName: 'Production MySQL', executionConnectionName: 'Production Linux', selection: { allDatabases: true }, requestedConsistency: { backupMethod: 'physical' }, readiness: { ready: true, message: 'Ready' } },
        { id: 'source_mysql_alternate', name: 'Recovery MySQL physical', sourceType: 'database', adapterId: 'deployerx.database.mysql.logical', connectionName: 'Recovery MySQL', executionConnectionName: 'Recovery Linux', selection: { allDatabases: true }, requestedConsistency: { backupMethod: 'physical' }, readiness: { ready: true, message: 'Ready' } }
      ];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        getBackupJobReadiness: async () => ({ sources: physicalSources, repositories: [] }),
        startBackupMysqlPhysicalRestore: async (payload) => { window.__physicalRestorePayloads.push(structuredClone(payload)); return { id: 'restore-physical', state: 'queued', target: { engine: 'mysql', operation: 'physical' } }; },
        waitBackupMysqlPhysicalRestore: async () => ({ id: 'restore-physical', state: 'succeeded', target: { engine: 'mysql', operation: 'physical', mode: 'alternate' }, progress: { bytesWritten: 16777216 }, result: { bytesRestored: 16777216, preparedToLsn: '240', targetServerUuid: 'new-uuid' }, validation: { nativeIntegrityValidation: true } }),
        cancelBackupMysqlPhysicalRestore: async (restoreRunId) => { window.__physicalRestoreCancellations.push(restoreRunId); return { id: restoreRunId, state: 'canceled', target: { engine: 'mysql', operation: 'physical' } }; },
        listBackupJobs: async () => [], listBackupRuns: async () => [], listBackupRestoreRuns: async () => [], listBackupMysqlRestoreRuns: async () => [], listBackupMysqlPhysicalRestoreRuns: async () => [], listBackupMariadbRestoreRuns: async () => [], listBackupMysqlPitrRuns: async () => [], listBackupMariadbPitrRuns: async () => [], listBackupPostgresqlRestoreRuns: async () => [], listBackupVerificationRuns: async () => []
      }});
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [{
        id: 'rp-inc-2', jobId: 'job-physical', jobName: 'MySQL physical protection', sourceId: 'source_mysql_physical', sourceName: 'Production MySQL physical', sourceConnectionId: 'mysql-production',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.mysql.logical', backupMethod: 'physical', type: 'incremental', consistency: 'application', capturedTo: '2026-08-04T12:00:00.000Z', availableCopyCount: 1, totalCopyCount: 1,
        physical: { backupMode: 'incremental', fromLsn: '180', toLsn: '240', serverVersion: '8.4.6', datadir: '/var/lib/mysql' }, verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'], deletionEligible: false }, repositoryCopies: [{ repositoryId: 'repo', repositoryName: 'Archive', state: 'available' }]
      }];
      state.backupRecovery.totalPoints = 1;
      state.backupRecovery.selectedPointId = 'rp-inc-2';
      showView('backup'); setBackupManagerTab('recovery'); renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const summary = document.getElementById('backupRecoveryEntryList').innerText;
      const action = document.getElementById('backupRecoveryRestoreButton').innerText;
      await openBackupMysqlRestore();
      document.getElementById('backupMysqlRestoreModeAlternate').checked = true;
      syncBackupMysqlRestoreMode();
      document.getElementById('backupMysqlRestoreTarget').value = 'source_mysql_alternate';
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      const completedStatus = document.getElementById('backupMysqlRestoreStatus').innerText;
      state.backupRecovery.activeRestore = { id: 'restore-cancel', state: 'running', target: { engine: 'mysql', operation: 'physical' } };
      await cancelOrCloseBackupMysqlRestore();
      const cancellation = { ids: window.__physicalRestoreCancellations.slice(), state: state.backupRecovery.activeRestore.state, status: document.getElementById('backupMysqlRestoreStatus').innerText };
      document.getElementById('backupMysqlRestoreStatus').innerText = completedStatus;
      const modal = document.querySelector('#backupMysqlRestoreModal .modal-card').getBoundingClientRect();
      state.backupJobWizard = { step: 1, sourceId: 'source_mysql_physical', repositoryIds: [], readiness: { sources: physicalSources, repositories: [] } };
      renderBackupJobChoices(); syncBackupJobModeForSource();
      return {
        summary, action,
        title: document.getElementById('backupMysqlRestoreTitle').innerText,
        newDatabaseHidden: document.getElementById('backupMysqlRestoreModeNewDatabase').closest('label').classList.contains('hidden'),
        targetLabel: document.getElementById('backupMysqlRestoreTargetField').innerText,
        status: completedStatus,
        cancellation,
        payload: window.__physicalRestorePayloads[0],
        incrementalEnabled: !document.querySelector('input[name="backupJobMode"][value="incremental"]').disabled,
        sourceDetail: document.getElementById('backupJobSources').innerText,
        contained: modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    const screenshotPath = path.join(captureRoot, 'mysql-physical-restore-mobile.png');
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
    const ok = result.summary.includes('XtraBackup incremental') && result.summary.includes('LSN 180 through 240')
      && result.action.includes('Restore physical backup') && result.title === 'Restore MySQL physical backup'
      && result.newDatabaseHidden && result.targetLabel.includes('Target physical Source')
      && result.status.includes('LSN 240') && result.status.includes('validation passed')
      && result.cancellation.ids[0] === 'restore-cancel' && result.cancellation.state === 'canceled' && result.cancellation.status.includes('canceled')
      && result.payload.mode === 'alternate' && result.payload.targetSourceId === 'source_mysql_alternate'
      && result.incrementalEnabled && result.sourceDetail.includes('whole instance') && result.sourceDetail.includes('Production Linux')
      && result.contained && !result.horizontalOverflow;
    process.stdout.write(`${JSON.stringify({ ok, result, screenshotPath })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
