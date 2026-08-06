const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const originalConnection = {
  id: 'connection-mongodb-original', name: 'Production MongoDB', currentDevice: true,
  endpoint: { username: 'backup', host: 'mongo.example.com', port: 27017, authSource: 'admin', replicaSet: 'orders-rs', expectedTopology: 'replica-set', tlsMode: 'verify-identity', caFile: 'C:\\certs\\mongo-ca.pem' },
  trust: { mode: 'verify-identity', fingerprint: 'sha256:mongodb-original' },
  lastTest: { status: 'success', remotePlatform: { engine: 'mongodb', version: '8.0.4' }, endpointIdentity: { topology: 'replica-set', setName: 'orders-rs', replicaSetId: 'replica-set-id', deploymentFingerprint: 'sha256:mongodb-original' } }
};
const alternateConnection = {
  id: 'connection-mongodb-alternate', name: 'Recovery MongoDB', currentDevice: true,
  endpoint: { username: 'restore', host: 'mongo-recovery.example.com', port: 27017, authSource: 'admin', expectedTopology: 'standalone', tlsMode: 'verify-identity' },
  trust: { mode: 'verify-identity', fingerprint: 'sha256:mongodb-alternate' },
  lastTest: { status: 'success', remotePlatform: { engine: 'mongodb', version: '8.0.4' }, endpointIdentity: { topology: 'standalone', deploymentFingerprint: 'sha256:mongodb-alternate' } }
};
const encodedConnections = Buffer.from(JSON.stringify([originalConnection, alternateConnection])).toString('base64');

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-mongodb-ui-'));
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
      window.__mongoConnections = JSON.parse(atob('${encodedConnections}'));
      window.__mongoSourcePayload = null;
      window.__mongoRestorePayload = null;
      window.__mongoCanceled = null;
      window.__mongoRestore = {
        id: 'restore-mongodb', state: 'succeeded', createdAt: '2026-08-04T10:30:00.000Z', startedAt: '2026-08-04T10:30:01.000Z', updatedAt: '2026-08-04T10:30:31.000Z',
        recoveryPointIds: ['point-mongodb-anchor', 'point-mongodb-oplog'],
        target: { operation: 'point-in-time', mode: 'alternate', engine: 'mongodb', connectionId: 'connection-mongodb-alternate', stop: { type: 'coordinate', coordinate: { timestamp: { $timestamp: { t: 275, i: 4 } } } } },
        progress: { itemsTotal: 2, itemsCompleted: 2, bytesWritten: 5242880, startedAt: '2026-08-04T10:30:01.000Z', updatedAt: '2026-08-04T10:30:31.000Z' },
        validation: { connectivity: 'pass', expectedObjects: 'pass', nativeIntegrityValidation: true },
        result: { bytesRestored: 5242880, replayedRecoveryPointIds: ['point-mongodb-oplog'], recoveryTarget: { type: 'coordinate', coordinate: { timestamp: { $timestamp: { t: 275, i: 4 } } } }, completedAt: '2026-08-04T10:30:31.000Z' }
      };
      const empty = async () => [];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupLocalConnections: empty, listBackupSshConnections: empty, listBackupMysqlConnections: empty,
        listBackupMariadbConnections: empty, listBackupPostgresqlConnections: empty, listBackupSqlServerConnections: empty, listBackupOracleConnections: empty,
        listBackupMongoDbConnections: async () => structuredClone(window.__mongoConnections),
        createBackupMongoDbConnection: async (payload) => {
          const created = { ...structuredClone(window.__mongoConnections[0]), id: 'connection-mongodb-created', name: payload.name, endpoint: { ...structuredClone(window.__mongoConnections[0].endpoint), ...payload }, lastTest: null, trust: { mode: 'verify-identity', fingerprint: null } };
          window.__mongoConnections.push(created);
          return structuredClone(created);
        },
        testBackupMongoDbConnection: async (id) => {
          const connection = window.__mongoConnections.find((candidate) => candidate.id === id);
          connection.lastTest = structuredClone(window.__mongoConnections[0].lastTest);
          connection.trust = structuredClone(window.__mongoConnections[0].trust);
          return { connection: structuredClone(connection), result: structuredClone(connection.lastTest) };
        },
        discoverBackupMongoDbDatabases: async () => ({ items: [{ name: 'analytics' }, { name: 'orders' }], nextCursor: null }),
        saveBackupDatabaseSource: async (payload) => { window.__mongoSourcePayload = structuredClone(payload); return { id: 'source-mongodb', ...structuredClone(payload) }; },
        listBackupJobs: empty, listBackupRuns: empty, listBackupRestoreRuns: empty, listBackupMongoDbRestoreRuns: async () => [structuredClone(window.__mongoRestore)], listBackupVerificationRuns: empty,
        startBackupMongoDbRestore: async (payload) => { window.__mongoRestorePayload = structuredClone(payload); return { id: 'restore-mongodb', state: 'queued', target: { operation: 'point-in-time', mode: payload.mode, engine: 'mongodb' } }; },
        waitBackupMongoDbRestore: async () => structuredClone(window.__mongoRestore),
        cancelBackupMongoDbRestore: async (id) => { window.__mongoCanceled = id; return { id, state: 'canceled', target: { operation: 'point-in-time', engine: 'mongodb' } }; }
      }});
      showView('backup');
      setBackupManagerTab('sources');
      true;
    `);

    const source = await window.webContents.executeJavaScript(`(async () => {
      openBackupMysqlModal(null, 'mongodb');
      els.backupMysqlName.value = 'MongoDB reporting';
      els.backupMysqlHost.value = 'reporting.example.com';
      els.backupMysqlUsername.value = 'backup';
      els.backupMysqlPassword.value = 'secret';
      els.backupMongoDbAuthSource.value = 'admin';
      els.backupMongoDbTopology.value = 'replica-set';
      els.backupMongoDbReplicaSet.value = 'orders-rs';
      els.backupMongoDbCaFile.value = 'C:\\certs\\mongo-ca.pem';
      await discoverBackupMysql();
      const beforeSave = {
        databaseCount: document.querySelectorAll('[data-backup-mysql-database]').length,
        allIncluded: [...document.querySelectorAll('[data-backup-mysql-database]')].every((input) => input.checked && input.disabled),
        pitrLocked: els.backupMysqlPitrEnabled.checked && els.backupMysqlPitrEnabled.disabled,
        physicalHidden: els.backupMysqlPhysicalOption.classList.contains('hidden'),
        objectControlsHidden: els.backupDatabaseObjectControls.classList.contains('hidden'),
        saveEnabled: !els.backupMysqlSaveSourceButton.disabled,
        help: els.backupMysqlSelectionHelp.innerText
      };
      await saveBackupMysqlSource(new Event('submit', { cancelable: true }));
      return { beforeSave, payload: window.__mongoSourcePayload };
    })()`);

    const job = await window.webContents.executeJavaScript(`(() => {
      state.backupJobWizard = blankBackupJobWizard();
      state.backupJobWizard.readiness.sources = [{
        id: 'source-mongodb', name: 'Production MongoDB replica set', sourceType: 'database', adapterId: 'deployerx.database.mongodb.native', connectionName: 'Production MongoDB',
        selection: { allDatabases: true }, requestedConsistency: { backupMethod: 'logical', method: 'mongodb-oplog-dump', captureCoordinates: true }, readiness: { ready: true }
      }];
      state.backupJobWizard.sourceId = 'source-mongodb';
      syncBackupJobModeForSource();
      const incremental = els.backupJobForm.querySelector('input[name="backupJobMode"][value="incremental"]');
      const differential = els.backupJobForm.querySelector('input[name="backupJobMode"][value="differential"]');
      const full = els.backupJobForm.querySelector('input[name="backupJobMode"][value="full"]');
      return {
        sourceDetail: backupJobSourceDetail(state.backupJobWizard.readiness.sources[0]),
        incrementalDisabled: incremental.disabled,
        incrementalLabel: incremental.closest('label').innerText,
        differentialDisabled: differential.disabled,
        fullLabel: full.closest('label').innerText
      };
    })()`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [{
        id: 'point-mongodb-oplog', jobId: 'job-mongodb', jobName: 'Production MongoDB protection', sourceId: 'source-mongodb', sourceName: 'Production MongoDB replica set', sourceConnectionId: 'connection-mongodb-original',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.mongodb.native', backupMethod: 'logical', type: 'log', consistency: 'application', chainRootId: 'point-mongodb-anchor', parentRecoveryPointId: 'point-mongodb-anchor',
        capturedTo: '2026-08-04T10:00:00.000Z', availableCopyCount: 2, totalCopyCount: 2,
        pointInTime: { type: 'mongodb-oplog', earliest: '2026-08-04T09:00:00.000Z', latest: '2026-08-04T10:00:00.000Z', replicaSetId: 'replica-set-id',
          earliestCoordinate: { version: 1, engine: 'mongodb', timestamp: { $timestamp: { t: 200, i: 1 } }, capturedAt: '2026-08-04T09:00:00.000Z', serverIdentityFingerprint: 'sha256:mongodb-original', replicaSetId: 'replica-set-id' },
          latestCoordinate: { version: 1, engine: 'mongodb', timestamp: { $timestamp: { t: 300, i: 2 } }, capturedAt: '2026-08-04T10:00:00.000Z', serverIdentityFingerprint: 'sha256:mongodb-original', replicaSetId: 'replica-set-id' } },
        verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n'] }, repositoryCopies: [{ state: 'available' }, { state: 'available' }]
      }];
      state.backupRecovery.selectedPointId = 'point-mongodb-oplog';
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const summary = els.backupRecoveryEntryList.innerText;
      await openBackupMysqlRestore();
      els.backupMysqlRestoreModeAlternate.checked = true;
      syncBackupMysqlRestoreMode();
      els.backupMysqlRestoreTarget.value = 'connection-mongodb-alternate';
      els.backupMongoDbPitrCoordinate.checked = true;
      els.backupMongoDbPitrSeconds.value = '275';
      els.backupMongoDbPitrIncrement.value = '4';
      syncBackupMongoDbPitrMode();
      await startBackupMysqlRestore(new Event('submit', { cancelable: true }));
      const startedPayload = structuredClone(window.__mongoRestorePayload);
      state.backupRecovery.activeRestore = { id: 'restore-mongodb-cancel', state: 'running', target: { operation: 'point-in-time', engine: 'mongodb' } };
      await cancelOrCloseBackupMysqlRestore();
      return {
        summary,
        mongoStopVisible: !els.backupMongoDbPitrStop.classList.contains('hidden'),
        mysqlStopHidden: els.backupMysqlPitrStop.classList.contains('hidden'),
        newDatabaseHidden: els.backupMysqlRestoreModeNewDatabase.closest('label').classList.contains('hidden'),
        coordinateFieldsVisible: !els.backupMongoDbPitrCoordinateFields.classList.contains('hidden'),
        startedPayload,
        canceledId: window.__mongoCanceled
      };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      closeBackupMysqlRestore();
      setBackupManagerTab('activity');
      await loadBackupActivity();
      await openBackupActivityDetail('restore', 'restore-mongodb');
      return { row: els.backupActivityList.innerText, metrics: els.backupActivityDetailMetrics.innerText };
    })()`);

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mobile = await window.webContents.executeJavaScript(`(() => {
      closeBackupActivityDetail();
      state.backupRecovery.selectedPointId = 'point-mongodb-oplog';
      return openBackupMysqlRestore().then(() => {
        const card = els.backupMysqlRestoreModal.querySelector('.modal-card').getBoundingClientRect();
        return { card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      });
    })()`);
    const screenshotPath = path.join(captureRoot, 'mongodb-recovery-mobile.png');
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

    const valid = source.beforeSave.databaseCount === 2 && source.beforeSave.allIncluded && source.beforeSave.pitrLocked && source.beforeSave.physicalHidden
      && source.beforeSave.objectControlsHidden && source.beforeSave.saveEnabled && source.beforeSave.help.includes('All user databases')
      && source.payload?.selector?.allDatabases === true && source.payload?.consistency?.method === 'mongodb-oplog-dump'
      && source.payload?.consistency?.backupMethod === 'logical' && source.payload?.consistency?.captureCoordinates === true && !source.payload?.physicalExecution
      && !job.incrementalDisabled && job.differentialDisabled && job.incrementalLabel.includes('Continuous oplog') && job.fullLabel.includes('Full logical anchor') && job.sourceDetail.includes('whole replica set')
      && recovery.summary.includes('MongoDB oplog') && recovery.summary.includes('300:2') && recovery.mongoStopVisible && recovery.mysqlStopHidden && recovery.newDatabaseHidden && recovery.coordinateFieldsVisible
      && recovery.startedPayload?.mode === 'alternate' && recovery.startedPayload?.targetConnectionId === 'connection-mongodb-alternate' && recovery.startedPayload?.conflictPolicy === 'fail'
      && recovery.startedPayload?.stop?.type === 'coordinate' && recovery.startedPayload?.stop?.coordinate?.timestamp?.$timestamp?.t === 275 && recovery.startedPayload?.stop?.coordinate?.timestamp?.$timestamp?.i === 4
      && recovery.canceledId === 'restore-mongodb-cancel'
      && activity.row.includes('MongoDB alternate point-in-time recovery') && activity.metrics.includes('Recovery boundary') && activity.metrics.includes('275:4') && activity.metrics.includes('Native validation') && activity.metrics.includes('Passed')
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
