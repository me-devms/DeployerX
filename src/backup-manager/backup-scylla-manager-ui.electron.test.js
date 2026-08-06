const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-scylla-manager-ui-'));
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
      window.__managerSourcePayload = null;
      window.__managerTargetPayload = null;
      window.__managerRestorePayload = null;
      window.__managerVerificationPayloads = [];
      window.__managerConnections = [{
        id: 'connection-target', name: 'Recovery ScyllaDB', currentDevice: true,
        endpoint: { host: 'manager-recovery.example.com', port: 5080, basePath: '/api/v1', managedClusterId: 'cluster-target', authMode: 'token', tlsMode: 'verify-identity' },
        trust: { fingerprint: 'target-deployment-fingerprint' }, clusterInventory: { healthy: true },
        lastTest: { status: 'success', remotePlatform: { version: '3.12.0' }, endpointIdentity: { managedClusterId: 'cluster-target', managedClusterName: 'recovery-scylla', healthy: true } }
      }];
      window.__managerRestore = {
        id: 'restore-manager', state: 'succeeded', createdAt: '2026-08-04T12:30:00.000Z', startedAt: '2026-08-04T12:30:01.000Z', updatedAt: '2026-08-04T12:30:21.000Z',
        target: { operation: 'scylla-manager-alternate', mode: 'alternate', engine: 'scylla-manager', sourceManagedClusterId: 'cluster-source', targetManagedClusterId: 'cluster-target', snapshotTag: 'sm_20260804000000UTC', ownedTasks: [{ phase: 'schema', taskId: 'restore-schema' }, { phase: 'tables', taskId: 'restore-tables' }] },
        progress: { phase: 'complete', phasesTotal: 2, phasesCompleted: 2, itemsTotal: 2, itemsCompleted: 2, bytesWritten: 4096, startedAt: '2026-08-04T12:30:01.000Z', updatedAt: '2026-08-04T12:30:21.000Z' },
        validation: { nativeIntegrityValidation: true, schemaPhase: 'pass', tablePhase: 'pass', clusterHealth: 'pass' },
        result: { targetManagedClusterId: 'cluster-target', snapshotTag: 'sm_20260804000000UTC', completedAt: '2026-08-04T12:30:21.000Z', originalClusterModified: false, sourceMediaDeleted: false, rollbackPerformed: false }
      };
      window.__managerVerifications = [];
      const empty = async () => [];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupLocalConnections: empty, listBackupSshConnections: empty, listBackupMysqlConnections: empty, listBackupMariadbConnections: empty,
        listBackupPostgresqlConnections: empty, listBackupSqlServerConnections: empty, listBackupOracleConnections: empty,
        listBackupMongoDbConnections: empty, listBackupRedisConnections: empty, listBackupSqliteConnections: empty, listBackupSearchSnapshotConnections: empty,
        listBackupScyllaManagerConnections: async () => structuredClone(window.__managerConnections),
        createBackupScyllaManagerConnection: async (payload) => {
          const connection = { id: 'connection-source', name: payload.name, currentDevice: true, adapterId: 'deployerx.database.scylla-manager', endpoint: { ...payload }, trust: {}, clusterInventory: null, lastTest: null };
          window.__managerConnections.push(connection); return structuredClone(connection);
        },
        testBackupScyllaManagerConnection: async (id) => {
          const connection = window.__managerConnections.find((item) => item.id === id);
          const source = id === 'connection-source';
          const result = { status: 'success', remotePlatform: { version: source ? '3.11.0' : '3.12.0' }, endpointIdentity: { managedClusterId: source ? 'cluster-source' : 'cluster-target', managedClusterName: source ? 'production-scylla' : 'recovery-scylla', healthy: true } };
          connection.lastTest = structuredClone(result); connection.trust = { fingerprint: source ? 'source-deployment-fingerprint' : 'target-deployment-fingerprint' }; connection.clusterInventory = { healthy: true };
          return { connection: structuredClone(connection), result };
        },
        discoverBackupScyllaManagerResources: async () => ({ managedClusterId: 'cluster-source', managerVersion: '3.11.0', dataCenters: ['dc1'], nodes: [{ hostId: 'node-1' }, { hostId: 'node-2' }, { hostId: 'node-3' }] }),
        verifyBackupScyllaManagerTarget: async (_id, taskUpdate) => {
          window.__managerTargetPayload = structuredClone(taskUpdate);
          return { verification: { target: { locations: [{ location: 's3:company-backups/production', scheme: 's3', locationFingerprint: 'sha256:location' }], units: [{ keyspace: 'orders', tables: ['items', 'payments'], allTables: false }], dataCenters: ['dc1'], retention: 4, retentionDays: 30, retentionLockMode: 'governance', size: 4096 } } };
        },
        saveBackupDatabaseSource: async (payload) => { window.__managerSourcePayload = structuredClone(payload); return { id: 'source-manager', ...structuredClone(payload) }; },
        previewBackupScyllaManagerRestore: async (payload) => ({ snapshotTag: 'sm_20260804000000UTC', sourceManagedClusterId: 'cluster-source', targetManagedClusterId: 'cluster-target', managerCompatibility: true, scyllaCompatibility: true, selection: payload.selectedTables }),
        startBackupScyllaManagerRestore: async (payload) => { window.__managerRestorePayload = structuredClone(payload); return { id: 'restore-manager', state: 'queued', target: { engine: 'scylla-manager' } }; },
        waitBackupScyllaManagerRestore: async () => structuredClone(window.__managerRestore),
        cancelBackupScyllaManagerRestore: async (id) => ({ id, state: 'canceled', target: { engine: 'scylla-manager' }, result: { rollbackPerformed: false } }),
        listBackupScyllaManagerRestoreRuns: async () => [structuredClone(window.__managerRestore)],
        startBackupScyllaManagerVerification: async (payload) => { window.__managerVerificationPayloads.push(structuredClone(payload)); return { id: 'verification-' + window.__managerVerificationPayloads.length, state: 'queued', mode: payload.mode }; },
        waitBackupScyllaManagerVerification: async (id) => {
          const payload = window.__managerVerificationPayloads[Number(id.split('-').pop()) - 1];
          const drill = payload.mode === 'scylla-manager-full-drill';
          const run = { id, state: 'succeeded', mode: payload.mode, recoveryPointId: 'point-manager', restoreRunId: drill ? 'restore-manager' : null, createdAt: '2026-08-04T12:40:00.000Z', startedAt: '2026-08-04T12:40:01.000Z', completedAt: '2026-08-04T12:40:11.000Z', progress: { phase: 'complete', startedAt: '2026-08-04T12:40:01.000Z', updatedAt: '2026-08-04T12:40:11.000Z' }, evidence: drill ? { verificationClass: 'full-restore-drill', targetManagedClusterId: 'cluster-target', schemaPhase: 'pass', tablePhase: 'pass', clusterHealth: 'pass', nativeIntegrityValidation: true, ownedTasks: [{ taskId: 'restore-schema' }, { taskId: 'restore-tables' }], targetPreserved: true } : { verificationClass: 'metadata-only', repositoryVerified: true, exactTaskOwnership: true, taskId: 'backup-task-001', runId: 'backup-run-001', snapshotTag: 'sm_20260804000000UTC', exactCatalog: true, locations: [{ location: 's3:company-backups/production' }], retentionDays: 30, retentionLockMode: 'governance', fullRestorePerformed: false }, result: { completedAt: '2026-08-04T12:40:11.000Z' } };
          window.__managerVerifications.push(run); return structuredClone(run);
        },
        cancelBackupScyllaManagerVerification: async (id) => ({ id, state: 'canceled', mode: 'scylla-manager-metadata' }),
        listBackupScyllaManagerVerificationRuns: async () => structuredClone(window.__managerVerifications),
        listBackupJobs: empty, listBackupRuns: empty, listBackupRestoreRuns: empty, listBackupMysqlRestoreRuns: empty,
        listBackupMysqlPhysicalRestoreRuns: empty, listBackupMariadbRestoreRuns: empty, listBackupMysqlPitrRuns: empty,
        listBackupMariadbPitrRuns: empty, listBackupPostgresqlRestoreRuns: empty, listBackupPostgresqlPitrRuns: empty,
        listBackupSqlServerRestoreRuns: empty, listBackupOracleRestoreRuns: empty, listBackupMongoDbRestoreRuns: empty,
        listBackupRedisRestoreRuns: empty, listBackupSqliteRestoreRuns: empty, listBackupSearchSnapshotRestoreRuns: empty, listBackupVerificationRuns: empty
      }});
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [{
        id: 'point-manager', jobName: 'Production ScyllaDB protection', sourceId: 'source-manager', sourceName: 'Production ScyllaDB', sourceConnectionId: 'connection-source',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.scylla-manager', backupMethod: 'native', type: 'full', consistency: 'crash', capturedTo: '2026-08-04T12:00:00.000Z',
        scyllaManager: { managerVersion: '3.11.0', managedClusterId: 'cluster-source', clusterFingerprint: 'sha256:cluster', topologyFingerprint: 'sha256:topology', scyllaVersions: ['2025.1.3'], taskId: 'backup-task-001', runId: 'backup-run-001', snapshotTag: 'sm_20260804000000UTC', locations: [{ location: 's3:company-backups/production', scheme: 's3', locationFingerprint: 'sha256:location' }], units: [{ keyspace: 'orders', tables: ['items', 'payments'], allTables: false }], dataCenters: ['dc1'], retention: 4, retentionDays: 30, retentionLockMode: 'governance', sizeBytes: 4096, uploadedBytes: 4096, skippedBytes: 0, completedAt: '2026-08-04T12:00:00.000Z' },
        retention: { deletionEligible: false }, availableCopyCount: 1, totalCopyCount: 1, repositoryCopies: [{ state: 'available' }]
      }];
      state.backupRecovery.selectedPointId = 'point-manager';
      true;
    `);

    const source = await window.webContents.executeJavaScript(`(async () => {
      openBackupScyllaManagerModal();
      els.backupScyllaManagerName.value = 'Production Manager'; els.backupScyllaManagerHost.value = 'manager.example.com'; els.backupScyllaManagerClusterId.value = 'cluster-source';
      await discoverBackupScyllaManager();
      els.backupScyllaManagerSourceName.value = 'Production ScyllaDB backups'; els.backupScyllaManagerUnits.value = 'orders.items\\norders.payments'; els.backupScyllaManagerLocations.value = 's3:company-backups/production';
      els.backupScyllaManagerDataCenters.value = 'dc1'; els.backupScyllaManagerRetentionLock.value = 'governance'; els.backupScyllaManagerRateLimit.value = 'dc1:100M'; els.backupScyllaManagerSnapshotParallel.value = 'dc1:2'; els.backupScyllaManagerUploadParallel.value = 'dc1:4'; els.backupScyllaManagerCron.value = '0 2 * * *';
      await verifyBackupScyllaManagerTarget();
      const evidence = els.backupScyllaManagerTargetEvidence.innerText;
      await saveBackupScyllaManagerSource(new Event('submit', { cancelable: true }));
      return { payload: window.__managerSourcePayload, targetPayload: window.__managerTargetPayload, evidence, connections: window.__managerConnections.length };
    })()`);

    const job = await window.webContents.executeJavaScript(`(() => {
      state.backupJobWizard = { ...blankBackupJobWizard(), sourceId: 'source-manager', readiness: { sources: [{ id: 'source-manager', name: 'Production ScyllaDB backups', sourceType: 'database', adapterId: 'deployerx.database.scylla-manager', connectionName: 'Production Manager', selection: { allDatabases: false, databases: { include: [] }, tables: { include: [{ database: 'orders', schema: 'orders', name: 'items' }, { database: 'orders', schema: 'orders', name: 'payments' }] } }, requestedConsistency: { backupMethod: 'physical', backupMode: 'native' }, physicalExecution: { managerVersion: '3.11.0', locations: [{ location: 's3:company-backups/production' }] }, objectCount: 2, readiness: { ready: true, message: 'Ready' } }], repositories: [] } };
      renderBackupJobChoices(); syncBackupJobModeForSource();
      const native = els.backupJobForm.querySelector('input[name="backupJobMode"][value="native"]'); const full = els.backupJobForm.querySelector('input[name="backupJobMode"][value="full"]'); const incremental = els.backupJobForm.querySelector('input[name="backupJobMode"][value="incremental"]');
      return { sourceDetail: els.backupJobSources.innerText, nativeChecked: native.checked, nativeLabel: native.closest('label').innerText, fullDisabled: full.disabled, incrementalDisabled: incremental.disabled };
    })()`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const summary = els.backupRecoveryEntryList.innerText; const action = els.backupRecoveryRestoreButton.innerText;
      await openBackupScyllaManagerRestore(); await previewBackupScyllaManagerRestore();
      const preview = els.backupScyllaManagerRestorePreview.innerText;
      await startBackupScyllaManagerRestore(new Event('submit', { cancelable: true }));
      return { summary, action, preview, status: els.backupScyllaManagerRestoreStatus.innerText, restorePayload: window.__managerRestorePayload };
    })()`);

    const verification = await window.webContents.executeJavaScript(`(async () => {
      closeBackupScyllaManagerRestore(); await openBackupScyllaManagerVerification();
      await startBackupScyllaManagerVerification(new Event('submit', { cancelable: true }));
      const metadataStatus = els.backupScyllaManagerVerificationStatus.innerText;
      closeBackupScyllaManagerVerification(); await openBackupScyllaManagerVerification();
      els.backupScyllaManagerVerificationForm.querySelector('input[value="scylla-manager-full-drill"]').checked = true; syncBackupScyllaManagerVerificationMode();
      await startBackupScyllaManagerVerification(new Event('submit', { cancelable: true }));
      return { metadataStatus, drillStatus: els.backupScyllaManagerVerificationStatus.innerText, payloads: window.__managerVerificationPayloads };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      closeBackupScyllaManagerVerification(); await loadBackupActivity();
      const testRows = els.backupTestList.innerText;
      await openBackupActivityDetail('restore', 'restore-manager'); const restoreMetrics = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'verification-2'); const drillMetrics = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'verification-1');
      return { rows: els.backupActivityList.innerText, testRows, restoreMetrics, drillMetrics, metadataMetrics: els.backupActivityDetailMetrics.innerText };
    })()`);

    const desktop = await window.webContents.executeJavaScript(`(() => { const card = els.backupActivityDetailModal.querySelector('.modal-card').getBoundingClientRect(); return { width: innerWidth, height: innerHeight, card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    window.unmaximize(); window.setResizable(true); window.setSize(391, 844); window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mobile = await window.webContents.executeJavaScript(`(async () => {
      const bounds = (modal) => { const card = modal.querySelector('.modal-card').getBoundingClientRect(); return { left: card.left, right: card.right, top: card.top, bottom: card.bottom }; };
      closeBackupActivityDetail(); await openBackupScyllaManagerRestore(); const restore = bounds(els.backupScyllaManagerRestoreModal); closeBackupScyllaManagerRestore();
      await openBackupScyllaManagerVerification(); const verification = bounds(els.backupScyllaManagerVerificationModal); closeBackupScyllaManagerVerification();
      openBackupScyllaManagerModal(window.__managerConnections.find((item) => item.id === 'connection-source')); await discoverBackupScyllaManager();
      els.backupScyllaManagerUnits.value = 'orders.items\\norders.payments'; els.backupScyllaManagerLocations.value = 's3:company-backups/production';
      const source = bounds(els.backupScyllaManagerModal); els.toast.classList.remove('visible'); els.toast.style.display = 'none';
      return { source, restore, verification, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    const screenshotPath = path.join(captureRoot, 'scylla-manager-source-mobile.png');
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

    const contained = (box, viewport) => box.left >= 0 && box.right <= viewport.width && box.top >= 0 && box.bottom <= viewport.height;
    const valid = source.connections === 2 && source.payload?.consistency?.method === 'scylla-manager-backup' && source.payload?.consistency?.backupMode === 'native'
      && source.payload?.selector?.tables?.include?.length === 2 && source.payload?.physicalExecution?.managedClusterId === 'cluster-source'
      && source.payload?.physicalExecution?.retentionLockMode === 'governance' && source.targetPayload?.properties?.keyspace?.join(',') === 'orders.items,orders.payments'
      && source.targetPayload?.properties?.location?.[0] === 's3:company-backups/production' && source.evidence.includes('Exact target verified')
      && job.sourceDetail.includes('ScyllaDB Manager 3.11.0') && job.nativeChecked && job.nativeLabel.includes('Manager native task') && job.fullDisabled && job.incrementalDisabled
      && recovery.summary.includes('backup-task-001 / run backup-run-001') && recovery.summary.includes('orders.items, orders.payments') && recovery.action.includes('Restore alternate cluster')
      && recovery.preview.includes('cluster-source to cluster-target') && recovery.preview.includes('Not supported; restored data is preserved')
      && recovery.status.includes('restored data remains on the alternate cluster') && recovery.restorePayload?.confirmationText === 'RESTORE SCYLLA MANAGER ALTERNATE'
      && verification.metadataStatus.includes('backup-task-001') && verification.metadataStatus.includes('30-day retention verified')
      && verification.drillStatus.includes('Restored data was preserved for inspection') && verification.payloads[1]?.confirmationText === 'RUN SCYLLA MANAGER RECOVERY DRILL'
      && activity.rows.includes('ScyllaDB Manager alternate restore') && activity.rows.includes('Manager native metadata validation') && activity.rows.includes('Manager full alternate-cluster drill')
      && activity.testRows.includes('task/run/catalog verified') && activity.testRows.includes('restored data preserved')
      && activity.restoreMetrics.includes('Rollback and cleanup') && activity.restoreMetrics.includes('restored data preserved')
      && activity.drillMetrics.includes('Full alternate-cluster Manager drill') && activity.drillMetrics.includes('Preserved for inspection') && activity.drillMetrics.includes('Not claimed')
      && activity.metadataMetrics.includes('Task / run') && activity.metadataMetrics.includes('Authenticated') && activity.metadataMetrics.includes('30 days / governance')
      && !desktop.overflow && contained(desktop.card, desktop) && mobile.width <= 390 && !mobile.overflow && contained(mobile.source, mobile) && contained(mobile.restore, mobile) && contained(mobile.verification, mobile);
    process.stdout.write(`${JSON.stringify({ ok: valid, source, job, recovery, verification, activity, desktop, mobile, screenshotPath })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
