const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-sqlserver-ui-'));
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
      document.getElementById('toast')?.style.setProperty('display', 'none', 'important');
      window.__sqlServerSourcePayloads = [];
      window.__sqlServerRestorePayloads = [];
      window.__sqlServerCancellations = [];
      const sources = [
        { id: 'source-sql-primary', name: 'Orders SQL Server', sourceType: 'database', adapterId: 'deployerx.database.sqlserver.native', connectionName: 'Production SQL', executionConnectionName: 'Production Linux', selection: { allDatabases: false, databases: { include: [{ name: 'orders' }] } }, requestedConsistency: { backupMethod: 'physical' }, readiness: { ready: true, message: 'Ready' } },
        { id: 'source-sql-alternate', name: 'Recovery SQL Server', sourceType: 'database', adapterId: 'deployerx.database.sqlserver.native', connectionName: 'Recovery SQL', executionConnectionName: 'Recovery Linux', selection: { allDatabases: false, databases: { include: [{ name: 'orders_restore' }] } }, requestedConsistency: { backupMethod: 'physical' }, readiness: { ready: true, message: 'Ready' } }
      ];
      const completedRun = {
        id: 'restore-sqlserver', state: 'succeeded', createdAt: '2026-08-04T12:01:00.000Z', startedAt: '2026-08-04T12:01:00.000Z', updatedAt: '2026-08-04T12:02:00.000Z',
        target: { engine: 'sqlserver', operation: 'sqlserver-native', mode: 'original', database: 'orders', recoveryTarget: { type: 'latest', value: null }, tailMode: 'online' },
        recoveryPointIds: ['rp-sql-log'], progress: { itemsTotal: 3, itemsCompleted: 3, bytesWritten: 50331648 },
        result: { database: 'orders', bytesRestored: 50331648, restoredRecoveryPointIds: ['rp-sql-full', 'rp-sql-log', 'rp-sql-tail'], tailRecoveryPointId: 'rp-sql-tail', recoveryTarget: { type: 'latest', value: null }, completedAt: '2026-08-04T12:02:00.000Z' },
        validation: { nativeIntegrityValidation: true }
      };
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        getSetup: async () => ({ complete: false, mode: null }),
        getBackupJobReadiness: async () => ({ sources, repositories: [] }),
        saveBackupDatabaseSource: async (payload) => { window.__sqlServerSourcePayloads.push(structuredClone(payload)); return { id: 'source-created' }; },
        listBackupLocalConnections: async () => [], listBackupSshConnections: async () => [], listBackupMysqlConnections: async () => [], listBackupMariadbConnections: async () => [], listBackupPostgresqlConnections: async () => [], listBackupSqlServerConnections: async () => [],
        startBackupSqlServerRestore: async (payload) => { window.__sqlServerRestorePayloads.push(structuredClone(payload)); return { id: completedRun.id, state: 'queued', target: { engine: 'sqlserver', operation: 'sqlserver-native' } }; },
        waitBackupSqlServerRestore: async () => structuredClone(completedRun),
        cancelBackupSqlServerRestore: async (id) => { window.__sqlServerCancellations.push(id); return { id, state: 'canceled', target: { engine: 'sqlserver', operation: 'sqlserver-native' } }; },
        listBackupJobs: async () => [], listBackupRuns: async () => [], listBackupRestoreRuns: async () => [], listBackupMysqlRestoreRuns: async () => [], listBackupMysqlPhysicalRestoreRuns: async () => [], listBackupMariadbRestoreRuns: async () => [], listBackupMysqlPitrRuns: async () => [], listBackupMariadbPitrRuns: async () => [], listBackupPostgresqlRestoreRuns: async () => [], listBackupPostgresqlPitrRuns: async () => [], listBackupSqlServerRestoreRuns: async () => [structuredClone(completedRun)], listBackupVerificationRuns: async () => []
      }});

      const sqlConnection = { id: 'connection-sql', name: 'Production SQL', connectionKind: 'sqlserver', endpoint: { host: 'sql01.example.com', port: 1433, username: 'backup', tlsMode: 'verify-identity' }, lastTest: { status: 'success', remotePlatform: { version: '16.0.4175.1' } }, currentDevice: true };
      state.backupSshConnections = [{ id: 'ssh-sql', name: 'Production Linux', currentDevice: true, lastTest: { status: 'success' } }];
      openBackupMysqlModal(sqlConnection);
      state.backupMysqlDatabases = [{ name: 'orders', selectable: true }, { name: 'warehouse', selectable: true }];
      renderBackupMysqlDatabases();
      const orderInput = document.querySelector('[data-backup-mysql-database][value="orders"]');
      orderInput.checked = true;
      orderInput.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('backupMysqlSourceName').value = 'Orders native protection';
      const sourceDefaults = {
        title: document.getElementById('backupMysqlModalTitle').innerText,
        physicalVisible: !document.getElementById('backupMysqlPhysicalFields').classList.contains('hidden'),
        backupDirectory: document.getElementById('backupSqlServerBackupDirectory').value,
        dataDirectory: document.getElementById('backupMysqlPhysicalDataDirectory').value,
        logDirectory: document.getElementById('backupSqlServerLogDirectory').value,
        sqlcmd: document.getElementById('backupSqlServerSqlcmdExecutable').value,
        selectionModeDisabled: document.getElementById('backupDatabaseSelectionMode').disabled
      };
      await saveBackupMysqlSource(new Event('submit', { cancelable: true }));

      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [{
        id: 'rp-sql-log', jobId: 'job-sql', jobName: 'Orders protection', sourceId: 'source-sql-primary', sourceName: 'Orders SQL Server', sourceConnectionId: 'connection-sql', sourceType: 'database', sourceAdapterId: 'deployerx.database.sqlserver.native', backupMethod: 'physical', type: 'log', consistency: 'application', chainRootId: 'rp-sql-full', parentRecoveryPointId: 'rp-sql-full', capturedFrom: '2026-08-04T10:00:00.000Z', capturedTo: '2026-08-04T12:00:00.000Z', availableCopyCount: 1, totalCopyCount: 1,
        pointInTime: { type: 'sql-server-lsn', database: 'orders', recoveryModel: 'FULL', firstLsn: '190', lastLsn: '300', recoveryForkId: 'fork-a' },
        physical: { backupMode: 'incremental', fromLsn: '190', toLsn: '300', serverVersion: '16.0.4175.1', engine: 'sqlserver', database: 'orders', recoveryModel: 'FULL', recoveryForkId: 'fork-a' },
        verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'], deletionEligible: false }, repositoryCopies: [{ repositoryId: 'repo', repositoryName: 'Archive', state: 'available' }]
      }, { id: 'rp-sql-full', jobId: 'job-sql', jobName: 'Orders protection', sourceId: 'source-sql-primary', sourceName: 'Orders SQL Server', sourceType: 'database', sourceAdapterId: 'deployerx.database.sqlserver.native', backupMethod: 'physical', type: 'full', consistency: 'application', chainRootId: 'rp-sql-full', capturedFrom: '2026-08-04T09:00:00.000Z', capturedTo: '2026-08-04T09:05:00.000Z', availableCopyCount: 1, totalCopyCount: 1, physical: { database: 'orders', recoveryModel: 'FULL', fromLsn: '100', toLsn: '180', recoveryForkId: 'fork-a' }, repositoryCopies: [] }];
      state.backupRecovery.totalPoints = 2;
      state.backupRecovery.selectedPointId = 'rp-sql-log';
      showView('backup'); setBackupManagerTab('recovery'); renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const summary = document.getElementById('backupRecoveryEntryList').innerText;
      const pointSummary = document.getElementById('backupRecoveryPointList').innerText;
      await openBackupMysqlRestore();
      document.getElementById('backupSqlServerDeepValidation').checked = true;
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      const status = document.getElementById('backupMysqlRestoreStatus').innerText;
      const activityText = document.getElementById('backupActivityList').innerText;
      openBackupActivityDetail('restore', completedRun.id);
      const activityDetail = document.getElementById('backupActivityDetailMetrics').innerText;
      document.getElementById('backupActivityDetailModal').classList.add('hidden');
      state.backupRecovery.activeRestore = { id: 'restore-sql-cancel', state: 'running', target: { engine: 'sqlserver', operation: 'sqlserver-native' } };
      await cancelOrCloseBackupMysqlRestore();
      document.getElementById('backupMysqlRestoreStatus').innerText = status;
      state.backupJobWizard = { step: 1, sourceId: 'source-sql-primary', repositoryIds: [], readiness: { sources, repositories: [] } };
      renderBackupJobChoices(); syncBackupJobModeForSource();
      const modal = document.querySelector('#backupMysqlRestoreModal .modal-card').getBoundingClientRect();
      return {
        sourceDefaults, sourcePayload: window.__sqlServerSourcePayloads[0], summary, pointSummary,
        title: document.getElementById('backupMysqlRestoreTitle').innerText,
        sqlOptionsVisible: !document.getElementById('backupSqlServerRecoveryOptions').classList.contains('hidden'),
        tailMode: document.getElementById('backupSqlServerTailMode').value,
        status, activityText, activityDetail, restorePayload: window.__sqlServerRestorePayloads[0], cancellations: window.__sqlServerCancellations.slice(),
        incrementalLabel: document.querySelector('input[name="backupJobMode"][value="incremental"]').closest('label').innerText,
        incrementalEnabled: !document.querySelector('input[name="backupJobMode"][value="incremental"]').disabled,
        differentialEnabled: !document.querySelector('input[name="backupJobMode"][value="differential"]').disabled,
        sourceDetail: document.getElementById('backupJobSources').innerText,
        addButton: document.getElementById('backupAddSqlServerConnectionButton').innerText,
        contained: modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    const screenshotPath = path.join(captureRoot, 'sqlserver-native-recovery-mobile.png');
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
    const ok = result.sourceDefaults.title === 'Add SQL Server source' && result.sourceDefaults.physicalVisible && result.sourceDefaults.selectionModeDisabled
      && result.sourceDefaults.backupDirectory === '/var/opt/mssql/backup' && result.sourceDefaults.dataDirectory === '/var/opt/mssql/data' && result.sourceDefaults.logDirectory === '/var/opt/mssql/data' && result.sourceDefaults.sqlcmd === 'sqlcmd'
      && result.sourcePayload.selector.databases.include[0].name === 'orders' && result.sourcePayload.consistency.backupMethod === 'physical' && result.sourcePayload.physicalExecution.engine === undefined
      && result.sourcePayload.physicalExecution.backupDirectory === '/var/opt/mssql/backup' && result.sourcePayload.physicalExecution.logDirectory === '/var/opt/mssql/data'
      && result.summary.includes('Transaction log') && result.summary.includes('LSN 190 through 300') && result.summary.includes('fork fork-a') && result.pointSummary.includes('Transaction log')
      && result.title === 'Recover SQL Server native backup' && result.sqlOptionsVisible && result.tailMode === 'online'
      && result.restorePayload.recoveryPointId === 'rp-sql-log' && result.restorePayload.mode === 'original' && result.restorePayload.targetDatabase === 'orders' && result.restorePayload.recoveryTarget.type === 'latest' && result.restorePayload.tailMode === 'online' && result.restorePayload.deepValidation === true
      && result.status.includes('orders') && result.status.includes('validation passed') && result.activityText.includes('SQL Server point-in-time recovery to orders') && result.activityDetail.includes('Tail-log point') && result.activityDetail.includes('rp-sql-tail')
      && result.cancellations[0] === 'restore-sql-cancel' && result.incrementalLabel.includes('Transaction log') && result.incrementalEnabled && result.differentialEnabled
      && result.sourceDetail.includes('SQL Server orders') && result.addButton.includes('SQL Server') && result.contained && !result.horizontalOverflow;
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
