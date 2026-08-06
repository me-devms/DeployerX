const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-postgresql-physical-ui-'));
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
      document.getElementById('toast')?.classList.remove('show');
      if (document.getElementById('toast')) document.getElementById('toast').textContent = '';
      document.getElementById('toast')?.style.setProperty('display', 'none', 'important');
      window.__postgresqlPitrPayloads = [];
      window.__postgresqlPitrCancellations = [];
      const physicalSources = [
        { id: 'source_postgresql_physical', name: 'Production PostgreSQL physical', sourceType: 'database', adapterId: 'deployerx.database.postgresql.logical', connectionName: 'Production PostgreSQL', executionConnectionName: 'Production Linux', selection: { allDatabases: true }, requestedConsistency: { backupMethod: 'physical' }, readiness: { ready: true, message: 'Ready' } },
        { id: 'source_postgresql_alternate', name: 'Recovery PostgreSQL physical', sourceType: 'database', adapterId: 'deployerx.database.postgresql.logical', connectionName: 'Recovery PostgreSQL', executionConnectionName: 'Recovery Linux', selection: { allDatabases: true }, requestedConsistency: { backupMethod: 'physical' }, readiness: { ready: true, message: 'Ready' } }
      ];
      const completedRun = {
        id: 'restore-postgresql-pitr', state: 'succeeded', createdAt: '2026-08-04T12:01:00.000Z', startedAt: '2026-08-04T12:01:00.000Z', updatedAt: '2026-08-04T12:02:00.000Z',
        target: { engine: 'postgresql', operation: 'postgresql-pitr', mode: 'alternate', recoveryTarget: { type: 'time', value: '2026-08-04T10:30:00.000Z', inclusive: false, timeline: '2' } },
        recoveryPointIds: ['rp-wal'], progress: { itemsTotal: 3, itemsCompleted: 3, bytesWritten: 33554432 },
        result: { bytesRestored: 33554432, finalLsn: '0/60000A0', timeline: 2, restoredRecoveryPointIds: ['rp-full', 'rp-wal'], recoveryTarget: { type: 'time', value: '2026-08-04T10:30:00.000Z', inclusive: false, timeline: '2' }, completedAt: '2026-08-04T12:02:00.000Z' },
        validation: { nativeIntegrityValidation: true }
      };
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        getSetup: async () => ({ complete: false, mode: null }),
        getBackupJobReadiness: async () => ({ sources: physicalSources, repositories: [] }),
        startBackupPostgresqlPitr: async (payload) => { window.__postgresqlPitrPayloads.push(structuredClone(payload)); return { id: completedRun.id, state: 'queued', target: { engine: 'postgresql', operation: 'postgresql-pitr' } }; },
        waitBackupPostgresqlPitr: async () => structuredClone(completedRun),
        cancelBackupPostgresqlPitr: async (restoreRunId) => { window.__postgresqlPitrCancellations.push(restoreRunId); return { id: restoreRunId, state: 'canceled', target: { engine: 'postgresql', operation: 'postgresql-pitr' } }; },
        listBackupJobs: async () => [], listBackupRuns: async () => [], listBackupRestoreRuns: async () => [], listBackupMysqlRestoreRuns: async () => [], listBackupMysqlPhysicalRestoreRuns: async () => [], listBackupMariadbRestoreRuns: async () => [], listBackupMysqlPitrRuns: async () => [], listBackupMariadbPitrRuns: async () => [], listBackupPostgresqlRestoreRuns: async () => [], listBackupPostgresqlPitrRuns: async () => [structuredClone(completedRun)], listBackupVerificationRuns: async () => []
      }});
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [{
        id: 'rp-wal', jobId: 'job-postgresql-physical', jobName: 'PostgreSQL physical protection', sourceId: 'source_postgresql_physical', sourceName: 'Production PostgreSQL physical', sourceConnectionId: 'postgresql-production',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.postgresql.logical', backupMethod: 'physical', type: 'log', consistency: 'application', capturedTo: '2026-08-04T12:00:00.000Z', availableCopyCount: 1, totalCopyCount: 1,
        pointInTime: { type: 'postgresql-wal', earliest: '2026-08-04T10:00:00.000Z', latest: '2026-08-04T12:00:00.000Z', timeline: 1, startLsn: '0/2000000', endLsn: '0/6000000', firstSegment: '000000010000000000000004', lastSegment: '000000010000000000000005' },
        physical: { backupMode: 'incremental', fromLsn: '0/2000000', toLsn: '000000010000000000000005', serverVersion: '16.4', datadir: '/var/lib/postgresql/data', engine: 'postgresql', timeline: 1 },
        verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'], deletionEligible: false }, repositoryCopies: [{ repositoryId: 'repo', repositoryName: 'Archive', state: 'available' }]
      }];
      state.backupRecovery.totalPoints = 1;
      state.backupRecovery.selectedPointId = 'rp-wal';
      showView('backup'); setBackupManagerTab('recovery'); renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const summary = document.getElementById('backupRecoveryEntryList').innerText;
      const pointSummary = document.getElementById('backupRecoveryPointList').innerText;
      await openBackupMysqlRestore();
      const targetType = document.getElementById('backupPostgresqlPitrTargetType');
      targetType.value = 'time';
      targetType.dispatchEvent(new Event('change', { bubbles: true }));
      const targetValue = document.getElementById('backupPostgresqlPitrTargetValue');
      targetValue.value = '2026-08-04T10:30:00';
      targetValue.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('backupPostgresqlPitrInclusive').checked = false;
      const timeline = document.getElementById('backupPostgresqlPitrTimeline');
      timeline.value = 'specific';
      timeline.dispatchEvent(new Event('change', { bubbles: true }));
      const timelineValue = document.getElementById('backupPostgresqlPitrTimelineValue');
      timelineValue.value = '2';
      timelineValue.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('backupMysqlRestoreModeAlternate').checked = true;
      document.getElementById('backupMysqlRestoreModeAlternate').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('backupMysqlRestoreTarget').value = 'source_postgresql_alternate';
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      const completedStatus = document.getElementById('backupMysqlRestoreStatus').innerText;
      const activityText = document.getElementById('backupActivityList').innerText;
      openBackupActivityDetail('restore', completedRun.id);
      const activityDetail = document.getElementById('backupActivityDetailMetrics').innerText;
      document.getElementById('backupActivityDetailModal').classList.add('hidden');
      state.backupRecovery.activeRestore = { id: 'restore-postgresql-cancel', state: 'running', target: { engine: 'postgresql', operation: 'postgresql-pitr' } };
      await cancelOrCloseBackupMysqlRestore();
      const cancellation = { ids: window.__postgresqlPitrCancellations.slice(), state: state.backupRecovery.activeRestore.state };
      document.getElementById('backupMysqlRestoreStatus').innerText = completedStatus;
      const modal = document.querySelector('#backupMysqlRestoreModal .modal-card').getBoundingClientRect();
      state.backupJobWizard = { step: 1, sourceId: 'source_postgresql_physical', repositoryIds: [], readiness: { sources: physicalSources, repositories: [] } };
      renderBackupJobChoices(); syncBackupJobModeForSource();
      return {
        summary, pointSummary, activityText, activityDetail,
        title: document.getElementById('backupMysqlRestoreTitle').innerText,
        targetVisible: !document.getElementById('backupPostgresqlPitrTarget').classList.contains('hidden'),
        valueVisible: !document.getElementById('backupPostgresqlPitrTargetValueField').classList.contains('hidden'),
        timelineVisible: !document.getElementById('backupPostgresqlPitrTimelineValueField').classList.contains('hidden'),
        status: completedStatus, cancellation, payload: window.__postgresqlPitrPayloads[0],
        incrementalEnabled: !document.querySelector('input[name="backupJobMode"][value="incremental"]').disabled,
        sourceDetail: document.getElementById('backupJobSources').innerText,
        alertVisible: document.getElementById('toast')?.classList.contains('show') || false,
        contained: modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    const screenshotPath = path.join(captureRoot, 'postgresql-physical-recovery-mobile.png');
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
    const ok = result.summary.includes('Archived WAL') && result.summary.includes('timeline 1') && result.pointSummary.includes('PostgreSQL WAL')
      && result.title === 'Recover PostgreSQL physical backup' && result.targetVisible && result.valueVisible && result.timelineVisible
      && result.status.includes('LSN 0/60000A0') && result.status.includes('timeline 2') && result.status.includes('validation passed')
      && result.payload.recoveryPointId === 'rp-wal' && result.payload.mode === 'alternate' && result.payload.targetSourceId === 'source_postgresql_alternate'
      && result.payload.recoveryTarget.type === 'time' && result.payload.recoveryTarget.value === '2026-08-04T10:30:00.000Z' && result.payload.recoveryTarget.inclusive === false && result.payload.recoveryTarget.timeline === '2'
      && result.activityText.includes('PostgreSQL alternate physical recovery') && result.activityDetail.includes('Final WAL LSN') && result.activityDetail.includes('0/60000A0')
      && result.cancellation.ids[0] === 'restore-postgresql-cancel' && result.cancellation.state === 'canceled'
      && result.incrementalEnabled && result.sourceDetail.includes('PostgreSQL whole cluster') && result.sourceDetail.includes('base backup and WAL')
      && !result.alertVisible && result.contained && !result.horizontalOverflow;
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
