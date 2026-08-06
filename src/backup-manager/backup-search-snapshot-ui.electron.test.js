const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-search-snapshot-ui-'));
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
      confirmDangerousAction = async () => true;
      window.__searchSourcePayload = null;
      window.__searchRestorePayload = null;
      window.__searchVerificationPayloads = [];
      window.__searchRetention = null;
      window.__searchCleanup = null;
      window.__searchConnections = [{
        id: 'connection-target', name: 'Recovery search', currentDevice: true,
        endpoint: { host: 'recovery.example.com', port: 9200, expectedProduct: 'elasticsearch' },
        trust: { fingerprint: 'target-fingerprint' },
        lastTest: { status: 'success', remotePlatform: { version: '9.2.0' }, endpointIdentity: { product: 'elasticsearch', clusterName: 'recovery-search', clusterUuid: 'cluster-target' } }
      }];
      window.__searchRestore = {
        id: 'restore-search', state: 'succeeded', createdAt: '2026-08-04T12:30:00.000Z', startedAt: '2026-08-04T12:30:01.000Z', updatedAt: '2026-08-04T12:30:21.000Z',
        target: { operation: 'search-native-alternate', mode: 'alternate', engine: 'search-cluster', renamePrefix: 'dxr-point-search-', preview: [{ sourceName: 'orders', targetName: 'dxr-point-search-orders' }] },
        progress: { phase: 'complete', itemsTotal: 1, itemsCompleted: 1, startedAt: '2026-08-04T12:30:01.000Z', updatedAt: '2026-08-04T12:30:21.000Z' },
        validation: { nativeIntegrityValidation: true, expectedObjects: 'pass', restoredResources: [{ sourceName: 'orders', targetName: 'dxr-point-search-orders', targetUuid: 'target-index-uuid' }] },
        result: { targetClusterUuid: 'cluster-target', renamePrefix: 'dxr-point-search-', cancellationRollbackSupported: false, completedAt: '2026-08-04T12:30:21.000Z' }
      };
      window.__searchVerifications = [];
      const empty = async () => [];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupLocalConnections: empty, listBackupSshConnections: empty, listBackupMysqlConnections: empty, listBackupMariadbConnections: empty,
        listBackupPostgresqlConnections: empty, listBackupSqlServerConnections: empty, listBackupOracleConnections: empty,
        listBackupMongoDbConnections: empty, listBackupRedisConnections: empty, listBackupSqliteConnections: empty,
        listBackupSearchSnapshotConnections: async () => structuredClone(window.__searchConnections),
        createBackupSearchSnapshotConnection: async (payload) => {
          const connection = { id: 'connection-source', name: payload.name, currentDevice: true, endpoint: { ...payload }, trust: {}, lastTest: null };
          window.__searchConnections.push(connection); return structuredClone(connection);
        },
        testBackupSearchSnapshotConnection: async (id) => {
          const connection = window.__searchConnections.find((item) => item.id === id);
          const result = { status: 'success', remotePlatform: { version: '9.1.2' }, endpointIdentity: { product: 'elasticsearch', clusterName: id === 'connection-source' ? 'production-search' : 'recovery-search', clusterUuid: id === 'connection-source' ? 'cluster-source' : 'cluster-target', featureStatesSupported: true } };
          connection.lastTest = structuredClone(result); connection.trust = { fingerprint: id === 'connection-source' ? 'source-fingerprint' : 'target-fingerprint' };
          return { connection: structuredClone(connection), result };
        },
        discoverBackupSearchSnapshotResources: async (_id, kind) => kind === 'repositories'
          ? { items: [{ name: 'archive', type: 's3', readOnly: false, selectable: true, repositoryFingerprint: 'repository-fingerprint' }] }
          : kind === 'features' ? { items: [{ name: 'kibana', description: 'Kibana saved objects' }] }
          : { items: [{ name: 'orders', kind: 'search-index', selectable: true, primaryShards: 3, uuid: 'index-uuid' }, { name: 'events', kind: 'search-data-stream', selectable: true, primaryShards: 2, uuid: 'stream-uuid' }] },
        verifyBackupSearchSnapshotRepository: async () => ({ verification: { repositoryFingerprint: 'repository-fingerprint', clusterUuid: 'cluster-source', writerClusterUuid: 'cluster-source', product: 'elasticsearch' } }),
        saveBackupDatabaseSource: async (payload) => { window.__searchSourcePayload = structuredClone(payload); return { id: 'source-search', ...structuredClone(payload) }; },
        cleanupBackupSearchSnapshotRepository: async (payload) => { window.__searchCleanup = structuredClone(payload); return { deletedBlobs: 2, deletedBytes: 4096 }; },
        previewBackupSearchSnapshotRestore: async (payload) => ({ snapshotName: 'deployerx-snapshot', snapshotUuid: 'snapshot-uuid', renamePrefix: payload.renamePrefix, compatibility: { snapshotVersion: '9.1.2', targetVersion: '9.2.0' }, preview: [{ sourceName: 'orders', targetName: payload.renamePrefix + 'orders' }] }),
        startBackupSearchSnapshotRestore: async (payload) => { window.__searchRestorePayload = structuredClone(payload); return { id: 'restore-search', state: 'queued', target: { engine: 'search-cluster' } }; },
        waitBackupSearchSnapshotRestore: async () => structuredClone(window.__searchRestore),
        cancelBackupSearchSnapshotRestore: async (id) => ({ id, state: 'canceled', target: { engine: 'search-cluster' }, result: { cleanupRequired: true } }),
        listBackupSearchSnapshotRestoreRuns: async () => [structuredClone(window.__searchRestore)],
        planBackupSearchSnapshotRetention: async () => ({ planId: 'retention-plan', repositoryName: 'archive', snapshotName: 'deployerx-snapshot', snapshotUuid: 'snapshot-uuid' }),
        executeBackupSearchSnapshotRetention: async (id, planId) => { window.__searchRetention = { id, planId }; return { recoveryPoint: { retention: { deletionEligible: true, nativeMedia: { state: 'deleted', snapshotName: 'deployerx-snapshot' } } } }; },
        startBackupSearchSnapshotVerification: async (payload) => { window.__searchVerificationPayloads.push(structuredClone(payload)); return { id: 'verification-' + window.__searchVerificationPayloads.length, state: 'queued', mode: payload.mode }; },
        waitBackupSearchSnapshotVerification: async (id) => {
          const payload = window.__searchVerificationPayloads[Number(id.split('-').pop()) - 1];
          const drill = payload.mode === 'search-snapshot-full-drill';
          const run = { id, state: 'succeeded', mode: payload.mode, recoveryPointId: 'point-search', createdAt: '2026-08-04T12:40:00.000Z', startedAt: '2026-08-04T12:40:01.000Z', completedAt: '2026-08-04T12:40:11.000Z', progress: { phase: 'complete', startedAt: '2026-08-04T12:40:01.000Z', updatedAt: '2026-08-04T12:40:11.000Z' }, evidence: drill ? { verificationClass: 'full-restore-drill', nativeIntegrityValidation: true, expectedObjects: 'pass', targetDestroyed: true, restoredResources: [{ targetName: 'dxdrill-orders' }] } : { verificationClass: 'metadata-only', repositoryVerified: true, snapshotState: 'SUCCESS', shards: { total: 5, successful: 5, failed: 0 }, exactMembership: true, fullRestorePerformed: false }, result: { completedAt: '2026-08-04T12:40:11.000Z' } };
          window.__searchVerifications.push(run); return structuredClone(run);
        },
        cancelBackupSearchSnapshotVerification: async (id) => ({ id, state: 'canceled', mode: 'search-snapshot-metadata' }),
        listBackupSearchSnapshotVerificationRuns: async () => structuredClone(window.__searchVerifications),
        listBackupJobs: empty, listBackupRuns: empty, listBackupRestoreRuns: empty, listBackupMysqlRestoreRuns: empty,
        listBackupMysqlPhysicalRestoreRuns: empty, listBackupMariadbRestoreRuns: empty, listBackupMysqlPitrRuns: empty,
        listBackupMariadbPitrRuns: empty, listBackupPostgresqlRestoreRuns: empty, listBackupPostgresqlPitrRuns: empty,
        listBackupSqlServerRestoreRuns: empty, listBackupOracleRestoreRuns: empty, listBackupMongoDbRestoreRuns: empty,
        listBackupRedisRestoreRuns: empty, listBackupSqliteRestoreRuns: empty, listBackupVerificationRuns: empty
      }});
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [{
        id: 'point-search', jobName: 'Production search protection', sourceId: 'source-search', sourceName: 'Production search', sourceConnectionId: 'connection-source',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.search.snapshot', backupMethod: 'native', type: 'full', consistency: 'crash', capturedTo: '2026-08-04T12:00:00.000Z',
        searchSnapshot: { product: 'elasticsearch', serverVersion: '9.1.2', clusterName: 'production-search', clusterUuid: 'cluster-source', repositoryName: 'archive', snapshotName: 'deployerx-snapshot', snapshotUuid: 'snapshot-uuid', snapshotState: 'SUCCESS', startedAt: '2026-08-04T11:59:00.000Z', completedAt: '2026-08-04T12:00:00.000Z', shards: { total: 5, successful: 5, failed: 0 }, resources: [{ name: 'orders', primaryShards: 3 }, { name: 'events', primaryShards: 2 }], featureStates: [], includeGlobalState: false },
        retention: { deletionEligible: true }, availableCopyCount: 1, totalCopyCount: 1, repositoryCopies: [{ state: 'available' }]
      }];
      state.backupRecovery.selectedPointId = 'point-search';
      true;
    `);

    const source = await window.webContents.executeJavaScript(`(async () => {
      openBackupSearchSnapshotModal();
      els.backupSearchSnapshotName.value = 'Production search'; els.backupSearchSnapshotHost.value = 'search.example.com'; els.backupSearchSnapshotCredential.value = 'secret';
      await discoverBackupSearchSnapshot();
      els.backupSearchSnapshotSourceName.value = 'Production search snapshots';
      await saveBackupSearchSnapshotSource(new Event('submit', { cancelable: true }));
      return { payload: window.__searchSourcePayload, connections: window.__searchConnections.length };
    })()`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const summary = els.backupRecoveryEntryList.innerText; const action = els.backupRecoveryRestoreButton.innerText;
      await openBackupSearchSnapshotRestore(); await previewBackupSearchSnapshotRestore();
      const preview = els.backupSearchSnapshotRestorePreview.innerText;
      await startBackupSearchSnapshotRestore(new Event('submit', { cancelable: true }));
      const status = els.backupSearchSnapshotRestoreStatus.innerText;
      await deleteExpiredBackupSearchSnapshot();
      return { summary, action, preview, status, restorePayload: window.__searchRestorePayload, retention: window.__searchRetention };
    })()`);

    const verification = await window.webContents.executeJavaScript(`(async () => {
      closeBackupSearchSnapshotRestore(); await openBackupSearchSnapshotVerification();
      await startBackupSearchSnapshotVerification(new Event('submit', { cancelable: true }));
      const metadataStatus = els.backupSearchSnapshotVerificationStatus.innerText;
      closeBackupSearchSnapshotVerification(); await openBackupSearchSnapshotVerification();
      els.backupSearchSnapshotVerificationForm.querySelector('input[value="search-snapshot-full-drill"]').checked = true; syncBackupSearchSnapshotVerificationMode();
      await startBackupSearchSnapshotVerification(new Event('submit', { cancelable: true }));
      return { metadataStatus, drillStatus: els.backupSearchSnapshotVerificationStatus.innerText, payloads: window.__searchVerificationPayloads };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      closeBackupSearchSnapshotVerification(); await loadBackupActivity();
      await openBackupActivityDetail('restore', 'restore-search'); const restoreMetrics = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'verification-2');
      return { rows: els.backupActivityList.innerText, restoreMetrics, drillMetrics: els.backupActivityDetailMetrics.innerText };
    })()`);

    window.unmaximize();
    window.setResizable(true);
    window.setSize(391, 844);
    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mobile = await window.webContents.executeJavaScript(`(async () => {
      closeBackupActivityDetail(); await openBackupSearchSnapshotRestore();
      const card = els.backupSearchSnapshotRestoreModal.querySelector('.modal-card').getBoundingClientRect();
      return { card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    const screenshotPath = path.join(captureRoot, 'search-snapshot-recovery-mobile.png');
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

    const valid = source.connections === 2 && source.payload?.consistency?.method === 'search-native-snapshot' && source.payload?.consistency?.backupMode === 'native'
      && source.payload?.physicalExecution?.repositoryName === 'archive' && source.payload?.selector?.allDatabases === true
      && recovery.summary.includes('deployerx-snapshot') && recovery.summary.includes('5 of 5 primary shards') && recovery.action.includes('Restore alternate namespace')
      && recovery.preview.includes('9.1.2 to 9.2.0') && recovery.preview.includes('dxr-point-search-orders')
      && recovery.status.includes('1 resources restored and validated') && recovery.restorePayload?.confirmationText === 'RESTORE SEARCH ALTERNATE'
      && recovery.retention?.planId === 'retention-plan' && verification.metadataStatus.includes('5 of 5 primary shards')
      && verification.drillStatus.includes('1 resources restored, validated, and removed') && verification.payloads[1]?.confirmationText === 'RUN SEARCH RECOVERY DRILL'
      && activity.rows.includes('Search native alternate restore') && activity.rows.includes('Search native metadata validation') && activity.rows.includes('Search full restore drill')
      && activity.restoreMetrics.includes('Cancellation rollback') && activity.restoreMetrics.includes('Not supported')
      && activity.drillMetrics.includes('Full alternate restore drill') && activity.drillMetrics.includes('Destroyed')
      && mobile.width <= 390 && !mobile.overflow && mobile.card.left >= 0 && mobile.card.right <= mobile.width && mobile.card.top >= 0 && mobile.card.bottom <= mobile.height;
    process.stdout.write(`${JSON.stringify({ ok: valid, source, recovery, verification, activity, mobile, screenshotPath })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
