const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-oracle-ui-'));
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
      window.__oracleSourcePayloads = [];
      window.__oracleRestorePayloads = [];
      window.__oracleCancellations = [];
      window.__oracleRestoreMode = 'original';
      const sources = [{
        id: 'source-oracle', name: 'Orders Oracle', sourceType: 'database', adapterId: 'deployerx.database.oracle.rman',
        connectionName: 'Production Oracle', executionConnectionName: 'Production Linux',
        selection: { allDatabases: false, databases: { include: [{ name: 'ORDERS_PROD' }] } }, objectKind: 'database', objectCount: 1,
        requestedConsistency: { backupMethod: 'physical' }, readiness: { ready: true, message: 'Ready' }
      }];
      const completedRun = {
        id: 'restore-oracle', state: 'succeeded', createdAt: '2026-08-04T12:01:00.000Z', startedAt: '2026-08-04T12:01:00.000Z', updatedAt: '2026-08-04T12:02:00.000Z',
        target: { engine: 'oracle', operation: 'oracle-rman', mode: 'original', recoveryTarget: { type: 'scn', value: '1250' } },
        recoveryPointIds: ['rp-oracle-redo'], progress: { itemsTotal: 3, itemsCompleted: 3, bytesWritten: 67108864 },
        result: { dbid: '1234567890', databaseName: 'ORDERS', databaseUniqueName: 'ORDERS_PROD', incarnation: 8, bytesRestored: 67108864, restoredRecoveryPointIds: ['rp-oracle-full', 'rp-oracle-inc', 'rp-oracle-redo'], recoveryTarget: { type: 'scn', value: '1250' }, completedAt: '2026-08-04T12:02:00.000Z' },
        validation: { nativeIntegrityValidation: true }
      };
      const alternateRun = {
        ...structuredClone(completedRun), id: 'restore-oracle-alternate',
        target: { engine: 'oracle', operation: 'oracle-rman', mode: 'alternate', oracleSid: 'ORDALT', databaseUniqueName: 'orders_alt', recoveryTarget: { type: 'latest', value: null } },
        result: { ...structuredClone(completedRun.result), sourceDbid: '1234567890', dbid: '987654321', databaseName: 'ORDALT', databaseUniqueName: 'orders_alt', incarnation: 1, recoveryTarget: { type: 'latest', value: null } }
      };
      const alternateSsh = { id: 'ssh-alternate', name: 'Oracle Recovery Linux', currentDevice: true, lastTest: { status: 'success' } };
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        getSetup: async () => ({ complete: false, mode: null }),
        getBackupJobReadiness: async () => ({ sources, repositories: [] }),
        saveBackupDatabaseSource: async (payload) => { window.__oracleSourcePayloads.push(structuredClone(payload)); return { id: 'source-created' }; },
        listBackupLocalConnections: async () => [], listBackupSshConnections: async () => [structuredClone(alternateSsh)], listBackupMysqlConnections: async () => [], listBackupMariadbConnections: async () => [], listBackupPostgresqlConnections: async () => [], listBackupSqlServerConnections: async () => [], listBackupOracleConnections: async () => [],
        startBackupOracleRestore: async (payload) => { window.__oracleRestoreMode = payload.mode; window.__oracleRestorePayloads.push(structuredClone(payload)); return { id: payload.mode === 'alternate' ? alternateRun.id : completedRun.id, state: 'queued', target: { engine: 'oracle', operation: 'oracle-rman' } }; },
        waitBackupOracleRestore: async () => structuredClone(window.__oracleRestoreMode === 'alternate' ? alternateRun : completedRun),
        cancelBackupOracleRestore: async (id) => { window.__oracleCancellations.push(id); return { id, state: 'canceled', target: { engine: 'oracle', operation: 'oracle-rman' } }; },
        listBackupJobs: async () => [], listBackupRuns: async () => [], listBackupRestoreRuns: async () => [], listBackupMysqlRestoreRuns: async () => [], listBackupMysqlPhysicalRestoreRuns: async () => [], listBackupMariadbRestoreRuns: async () => [], listBackupMysqlPitrRuns: async () => [], listBackupMariadbPitrRuns: async () => [], listBackupPostgresqlRestoreRuns: async () => [], listBackupPostgresqlPitrRuns: async () => [], listBackupSqlServerRestoreRuns: async () => [], listBackupOracleRestoreRuns: async () => [structuredClone(alternateRun), structuredClone(completedRun)], listBackupVerificationRuns: async () => []
      }});

      const oracleConnection = { id: 'connection-oracle', name: 'Production Oracle', connectionKind: 'oracle', endpoint: { host: 'ora01.example.com', port: 2484, serviceName: 'orders.example.com', username: 'BACKUP', tlsMode: 'verify-identity', tnsAdminDirectory: 'C:/Oracle/network/admin' }, lastTest: { status: 'success', remotePlatform: { version: '19.24.0.0.0' }, endpointIdentity: { instanceName: 'ORDERS', dbid: '1234567890' } }, currentDevice: true };
      state.backupSshConnections = [{ id: 'ssh-oracle', name: 'Production Linux', currentDevice: true, lastTest: { status: 'success' } }];
      openBackupMysqlModal(oracleConnection);
      state.backupMysqlDatabases = [{ name: 'ORDERS_PROD', selectable: true }];
      renderBackupMysqlDatabases();
      const databaseInput = document.querySelector('[data-backup-mysql-database][value="ORDERS_PROD"]');
      databaseInput.checked = true;
      databaseInput.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('backupMysqlSourceName').value = 'Orders RMAN protection';
      const sourceDefaults = {
        title: document.getElementById('backupMysqlModalTitle').innerText,
        physicalVisible: !document.getElementById('backupMysqlPhysicalFields').classList.contains('hidden'),
        service: document.getElementById('backupOracleServiceName').value,
        oracleHome: document.getElementById('backupOracleHome').value,
        oracleSid: document.getElementById('backupOracleSid').value,
        backupDirectory: document.getElementById('backupOracleBackupDirectory').value,
        selectionModeDisabled: document.getElementById('backupDatabaseSelectionMode').disabled
      };
      await saveBackupMysqlSource(new Event('submit', { cancelable: true }));

      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [{
        id: 'rp-oracle-redo', jobId: 'job-oracle', jobName: 'Orders RMAN', sourceId: 'source-oracle', sourceName: 'Orders Oracle', sourceConnectionId: 'connection-oracle', sourceType: 'database', sourceAdapterId: 'deployerx.database.oracle.rman', backupMethod: 'physical', type: 'log', consistency: 'application', chainRootId: 'rp-oracle-full', parentRecoveryPointId: 'rp-oracle-inc', capturedFrom: '2026-08-04T10:00:00.000Z', capturedTo: '2026-08-04T12:00:00.000Z', availableCopyCount: 1, totalCopyCount: 1,
        pointInTime: { type: 'oracle-scn', database: 'ORDERS', databaseUniqueName: 'ORDERS_PROD', dbid: '1234567890', incarnation: 7, resetlogsChange: '900', backupType: 'archived-redo', checkpointScn: '1200', startScn: '1200', endScn: '1300', firstSequence: '44', lastSequence: '45' },
        physical: { engine: 'oracle', database: 'ORDERS', databaseUniqueName: 'ORDERS_PROD', dbid: '1234567890', incarnation: 7, resetlogsChange: '900', checkpointScn: '1200', fromScn: '1200', toScn: '1300', firstSequence: '44', lastSequence: '45', controlFileIncluded: true, spfileIncluded: false },
        verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'], deletionEligible: false }, repositoryCopies: [{ repositoryId: 'repo', repositoryName: 'Archive', state: 'available' }]
      }, { id: 'rp-oracle-full', jobId: 'job-oracle', jobName: 'Orders RMAN', sourceId: 'source-oracle', sourceName: 'Orders Oracle', sourceType: 'database', sourceAdapterId: 'deployerx.database.oracle.rman', backupMethod: 'physical', type: 'full', consistency: 'application', chainRootId: 'rp-oracle-full', capturedFrom: '2026-08-04T09:00:00.000Z', capturedTo: '2026-08-04T09:05:00.000Z', availableCopyCount: 1, totalCopyCount: 1, pointInTime: { type: 'oracle-scn', checkpointScn: '1000', startScn: '1000', endScn: '1100' }, physical: { engine: 'oracle', dbid: '1234567890', incarnation: 7 }, repositoryCopies: [] }];
      state.backupRecovery.totalPoints = 2;
      state.backupRecovery.selectedPointId = 'rp-oracle-redo';
      showView('backup'); setBackupManagerTab('recovery'); renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const summary = document.getElementById('backupRecoveryEntryList').innerText;
      const pointSummary = document.getElementById('backupRecoveryPointList').innerText;
      await openBackupMysqlRestore();
      document.getElementById('backupOracleRecoveryTarget').value = 'scn';
      syncBackupOracleRecoveryTarget();
      document.getElementById('backupOracleRecoveryValue').value = '1250';
      document.getElementById('backupOracleDeepValidation').checked = true;
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      const status = document.getElementById('backupMysqlRestoreStatus').innerText;
      await openBackupMysqlRestore();
      document.getElementById('backupMysqlRestoreModeAlternate').checked = true;
      syncBackupMysqlRestoreMode();
      const alternateProfileVisible = !document.getElementById('backupOracleAlternateProfile').classList.contains('hidden');
      const alternateTargetText = document.getElementById('backupMysqlRestoreTarget').innerText;
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      const alternateStatus = document.getElementById('backupMysqlRestoreStatus').innerText;
      const activityText = document.getElementById('backupActivityList').innerText;
      openBackupActivityDetail('restore', completedRun.id);
      const activityDetail = document.getElementById('backupActivityDetailMetrics').innerText;
      document.getElementById('backupActivityDetailModal').classList.add('hidden');
      state.backupRecovery.activeRestore = { id: 'restore-oracle-cancel', state: 'running', target: { engine: 'oracle', operation: 'oracle-rman' } };
      await cancelOrCloseBackupMysqlRestore();
      state.backupJobWizard = { step: 1, sourceId: 'source-oracle', repositoryIds: [], readiness: { sources, repositories: [] } };
      renderBackupJobChoices(); syncBackupJobModeForSource();
      const modal = document.querySelector('#backupMysqlRestoreModal .modal-card').getBoundingClientRect();
      return {
        sourceDefaults, sourcePayload: window.__oracleSourcePayloads[0], summary, pointSummary,
        title: document.getElementById('backupMysqlRestoreTitle').innerText,
        oracleOptionsVisible: !document.getElementById('backupOracleRecoveryOptions').classList.contains('hidden'),
        alternateDisabled: document.getElementById('backupMysqlRestoreModeAlternate').disabled,
        alternateProfileVisible, alternateTargetText, alternateStatus,
        status, activityText, activityDetail, restorePayload: window.__oracleRestorePayloads[0], alternateRestorePayload: window.__oracleRestorePayloads[1], cancellations: window.__oracleCancellations.slice(),
        incrementalLabel: document.querySelector('input[name="backupJobMode"][value="incremental"]').closest('label').innerText,
        differentialLabel: document.querySelector('input[name="backupJobMode"][value="differential"]').closest('label').innerText,
        nativeVisible: !document.querySelector('input[name="backupJobMode"][value="native"]').closest('label').classList.contains('hidden'),
        sourceDetail: document.getElementById('backupJobSources').innerText,
        addButton: document.getElementById('backupAddOracleConnectionButton').innerText,
        contained: modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    const screenshotPath = path.join(captureRoot, 'oracle-rman-recovery-mobile.png');
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
    const source = result.sourcePayload?.physicalExecution;
    const ok = result.sourceDefaults.title === 'Add Oracle source' && result.sourceDefaults.physicalVisible && result.sourceDefaults.selectionModeDisabled
      && result.sourceDefaults.service === 'orders.example.com' && result.sourceDefaults.oracleHome === '/opt/oracle/product/19c/dbhome_1' && result.sourceDefaults.oracleSid === 'ORDERS' && result.sourceDefaults.backupDirectory === '/var/opt/oracle/deployerx-backup'
      && result.sourcePayload.selector.databases.include[0].name === 'ORDERS_PROD' && result.sourcePayload.consistency.backupMethod === 'physical'
      && source.oracleHome === '/opt/oracle/product/19c/dbhome_1' && source.oracleSid === 'ORDERS' && source.oracleOwner === 'oracle' && source.oracleGroup === 'oinstall' && source.anchorMode === 'level-0' && source.rmanExecutable === 'rman'
      && result.summary.includes('DBID 1234567890') && result.summary.includes('SCN 1200 through 1300') && result.pointSummary.includes('Archived redo')
      && result.title === 'Recover Oracle RMAN backup' && result.oracleOptionsVisible && !result.alternateDisabled && result.alternateProfileVisible && result.alternateTargetText.includes('Oracle Recovery Linux')
      && result.restorePayload.recoveryPointId === 'rp-oracle-redo' && result.restorePayload.mode === 'original' && result.restorePayload.recoveryTarget.type === 'scn' && result.restorePayload.recoveryTarget.value === '1250' && result.restorePayload.deepValidation === true
      && result.alternateRestorePayload.mode === 'alternate' && result.alternateRestorePayload.targetProfile.sshConnectionId === 'ssh-alternate' && result.alternateRestorePayload.targetProfile.oracleSid === 'ORDALT'
      && result.alternateRestorePayload.targetProfile.databaseUniqueName === 'orders_alt' && result.alternateRestorePayload.targetProfile.dataDirectory === '/u02/oradata/ORDALT' && result.alternateRestorePayload.targetProfile.recoveryAreaSizeBytes === 53687091200
      && result.alternateStatus.includes('DBID 987654321')
      && result.status.includes('DBID 1234567890') && result.status.includes('incarnation 8') && result.activityText.includes('Oracle RMAN recovery') && result.activityDetail.includes('DBID') && result.activityDetail.includes('1234567890')
      && result.cancellations[0] === 'restore-oracle-cancel' && result.incrementalLabel.includes('Level 1 differential') && result.differentialLabel.includes('Level 1 cumulative') && result.nativeVisible
      && result.sourceDetail.includes('Oracle ORDERS_PROD') && result.addButton.includes('Oracle') && result.contained && !result.horizontalOverflow;
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
