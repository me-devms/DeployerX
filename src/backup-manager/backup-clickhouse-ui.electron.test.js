const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-clickhouse-ui-'));
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
      window.__clickHouseSourcePayload = null;
      window.__clickHouseRestorePayload = null;
      window.__clickHouseVerificationPayloads = [];
      const destinationFingerprint = 'sha256:destination';
      const diskTrust = { version: 1, destinationType: 'disk', diskName: 'backups', diskType: 'local', destinationFingerprint, deploymentFingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology', approvedAt: '2026-08-05T01:00:00.000Z' };
      window.__clickHouseConnections = [{
        id: 'connection-target', name: 'Recovery ClickHouse', currentDevice: true, workerAffinity: ['device:test'], adapterId: 'deployerx.database.clickhouse',
        endpoint: { executionMode: 'local', host: '127.0.0.1', port: 9440, tlsMode: 'required', username: 'default', clientPath: 'clickhouse-client', timeoutMs: 30000, expectedVersion: '25.8.3.66' },
        trust: { fingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology' }, clickhouseDestinationTrust: structuredClone(diskTrust),
        lastTest: { status: 'success', remotePlatform: { version: '25.8.3.66' }, endpointIdentity: { version: '25.8.3.66', deploymentFingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology', databaseCount: 1, tableCount: 2 } }
      }];
      window.__clickHousePoint = {
        id: 'point-clickhouse-incremental', jobName: 'Production analytics protection', sourceId: 'source-clickhouse', sourceName: 'Production analytics', sourceConnectionId: 'connection-source',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.clickhouse', backupMethod: 'physical', type: 'incremental', consistency: 'application', capturedTo: '2026-08-05T02:00:00.000Z',
        clickhouse: { productVersion: '25.8.3.66', databaseName: 'analytics', databaseUuid: '11111111-1111-4111-8111-111111111111', deploymentFingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology', backupMode: 'incremental', wholeDatabase: false, tables: [{ database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'MergeTree' }], tableCount: 1, rowCount: 1000, partCount: 3, partitionCount: 1, diskName: 'backups', destinationFingerprint, operationId: 'deployerx-11111111111111111111111111111111', operationStatus: 'BACKUP_CREATED', files: 4, entries: 1, totalBytes: 4096, baseOperationId: 'deployerx-00000000000000000000000000000000', restoreSupported: true },
        retention: { deletionEligible: false }, availableCopyCount: 1, totalCopyCount: 1, repositoryCopies: [{ repositoryId: 'repo-primary', state: 'available' }]
      };
      window.__clickHouseRestore = {
        id: 'restore-clickhouse', state: 'succeeded', recoveryPointIds: ['point-clickhouse-full', 'point-clickhouse-incremental'], createdAt: '2026-08-05T03:00:00.000Z', startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z',
        target: { operation: 'clickhouse-native-alternate-restore', mode: 'alternate', engine: 'clickhouse', sourceDatabase: 'analytics', targetDatabase: 'recovered_analytics', nativeOperationId: 'deployerx-restore' },
        progress: { phase: 'complete', itemsTotal: 1, itemsCompleted: 1, itemsSkipped: 0, bytesTotal: 4096, bytesWritten: 4096, startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z' },
        validation: { nativeIntegrityValidation: true },
        result: { targetDatabase: 'recovered_analytics', tableMappings: [{ source: 'analytics.events', target: 'recovered_analytics.events' }], chainRecoveryPointIds: ['point-clickhouse-full', 'point-clickhouse-incremental'], nativeOperation: { id: 'deployerx-restore', status: 'RESTORED' }, cleanupPerformed: false, rollbackPerformed: false, completedAt: '2026-08-05T03:00:21.000Z' }
      };
      window.__clickHouseVerifications = [];
      const discovery = { version: { text: '25.8.3.66' }, deploymentFingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology', databases: [{ name: 'analytics', uuid: '11111111-1111-4111-8111-111111111111', engine: 'Atomic', selectable: true }], tables: [{ database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'MergeTree', selectable: true }, { database: 'analytics', name: 'rollup', uuid: '33333333-3333-4333-8333-333333333333', engine: 'AggregatingMergeTree', selectable: true }], disks: [{ name: 'backups', type: 'local', freeBytes: 1000000, totalBytes: 2000000, readOnly: false, writeOnce: false }], clusters: [], replicas: [] };
      const empty = async () => [];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupLocalConnections: empty, listBackupSshConnections: empty, listBackupMysqlConnections: empty, listBackupMariadbConnections: empty,
        listBackupPostgresqlConnections: empty, listBackupSqlServerConnections: empty, listBackupOracleConnections: empty, listBackupMongoDbConnections: empty,
        listBackupNeo4jConnections: empty, listBackupRedisConnections: empty, listBackupSqliteConnections: empty, listBackupSearchSnapshotConnections: empty, listBackupScyllaManagerConnections: empty,
        listBackupClickHouseConnections: async () => structuredClone(window.__clickHouseConnections),
        createBackupClickHouseConnection: async (payload) => { const connection = { id: 'connection-source', name: payload.name, currentDevice: true, workerAffinity: ['device:test'], adapterId: 'deployerx.database.clickhouse', endpoint: { ...payload }, trust: {}, lastTest: null, clickhouseDestinationTrust: null }; window.__clickHouseConnections.push(connection); return structuredClone(connection); },
        testBackupClickHouseConnection: async (id) => { const connection = window.__clickHouseConnections.find((item) => item.id === id); const result = { status: 'success', remotePlatform: { version: '25.8.3.66' }, endpointIdentity: { version: '25.8.3.66', deploymentFingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology', databaseCount: 1, tableCount: 2 } }; connection.lastTest = structuredClone(result); connection.trust = { fingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology' }; return { connection: structuredClone(connection), result }; },
        discoverBackupClickHouseResources: async () => structuredClone(discovery),
        approveBackupClickHouseDestination: async (id, diskName, confirmationText) => { window.__clickHouseApproval = { id, diskName, confirmationText }; const connection = window.__clickHouseConnections.find((item) => item.id === id); connection.clickhouseDestinationTrust = structuredClone(diskTrust); return { connection: structuredClone(connection), destinationTrust: structuredClone(diskTrust) }; },
        saveBackupDatabaseSource: async (payload) => { window.__clickHouseSourcePayload = structuredClone(payload); return { id: 'source-clickhouse', ...structuredClone(payload) }; },
        previewBackupClickHouseRestore: async (payload) => ({ sourceDatabase: 'analytics', targetDatabase: payload.targetDatabase, sourceVersion: '25.8.3.66', targetVersion: '25.8.3.66', backupMode: 'incremental', tableCount: 1, chainRecoveryPointIds: ['point-clickhouse-full', 'point-clickhouse-incremental'], targetEmpty: true, nativeValidation: true }),
        startBackupClickHouseRestore: async (payload) => { window.__clickHouseRestorePayload = structuredClone(payload); return { id: 'restore-clickhouse', state: 'queued', target: { engine: 'clickhouse' } }; },
        waitBackupClickHouseRestore: async () => structuredClone(window.__clickHouseRestore), cancelBackupClickHouseRestore: async (id) => ({ id, state: 'canceled', target: { engine: 'clickhouse' } }),
        listBackupClickHouseRestoreRuns: async () => [structuredClone(window.__clickHouseRestore)],
        startBackupClickHouseVerification: async (payload) => { window.__clickHouseVerificationPayloads.push(structuredClone(payload)); return { id: 'clickhouse-verification-' + window.__clickHouseVerificationPayloads.length, state: 'queued', mode: payload.mode }; },
        waitBackupClickHouseVerification: async (id) => { const payload = window.__clickHouseVerificationPayloads[Number(id.split('-').pop()) - 1]; const drill = payload.mode === 'clickhouse-full-drill'; const run = { id, state: 'succeeded', mode: payload.mode, recoveryPointId: 'point-clickhouse-incremental', restoreRunId: drill ? 'restore-clickhouse' : null, createdAt: '2026-08-05T03:10:00.000Z', startedAt: '2026-08-05T03:10:01.000Z', completedAt: '2026-08-05T03:10:11.000Z', progress: { phase: 'complete', startedAt: '2026-08-05T03:10:01.000Z', updatedAt: '2026-08-05T03:10:11.000Z' }, evidence: drill ? { verificationClass: 'clickhouse-full-restore-drill', repositoryVerified: true, sourceIdentityVerified: true, completeChainAuthenticated: true, fullRestorePerformed: true, nativeIntegrityValidation: true, targetDatabase: 'drill_analytics', tableCount: 1, nativeOperationId: 'deployerx-restore', chainRecoveryPointIds: ['point-clickhouse-full', 'point-clickhouse-incremental'], targetPreserved: true, cleanupPerformed: false, rollbackPerformed: false } : { verificationClass: 'clickhouse-metadata-only', repositoryVerified: true, completeChainAuthenticated: true, sourceIdentityVerified: true, topologyVerified: true, selectionIdentityVerified: true, destinationIdentityVerified: true, productVersion: '25.8.3.66', databaseName: 'analytics', databaseUuid: '11111111-1111-4111-8111-111111111111', backupMode: 'incremental', tableCount: 1, rowCount: 1000, partCount: 3, artifactCount: 2, chainRecoveryPointIds: ['point-clickhouse-full', 'point-clickhouse-incremental'], fullRestorePerformed: false }, result: { completedAt: '2026-08-05T03:10:11.000Z' } }; window.__clickHouseVerifications.push(run); return structuredClone(run); },
        cancelBackupClickHouseVerification: async (id) => ({ id, state: 'canceled', mode: 'clickhouse-metadata' }), listBackupClickHouseVerificationRuns: async () => structuredClone(window.__clickHouseVerifications),
        listBackupRecoveryPoints: async () => ({ items: [structuredClone(window.__clickHousePoint)], nextCursor: null, total: 1 }), listBackupJobs: empty, listBackupRuns: empty, listBackupRestoreRuns: empty,
        listBackupMysqlRestoreRuns: empty, listBackupMysqlPhysicalRestoreRuns: empty, listBackupMariadbRestoreRuns: empty, listBackupMysqlPitrRuns: empty, listBackupMariadbPitrRuns: empty,
        listBackupPostgresqlRestoreRuns: empty, listBackupPostgresqlPitrRuns: empty, listBackupSqlServerRestoreRuns: empty, listBackupOracleRestoreRuns: empty, listBackupMongoDbRestoreRuns: empty,
        listBackupNeo4jRestoreRuns: empty, listBackupRedisRestoreRuns: empty, listBackupSqliteRestoreRuns: empty, listBackupSearchSnapshotRestoreRuns: empty, listBackupScyllaManagerRestoreRuns: empty,
        listBackupVerificationRuns: empty, listBackupNeo4jVerificationRuns: empty, listBackupSearchSnapshotVerificationRuns: empty, listBackupScyllaManagerVerificationRuns: empty
      }});
      state.backupRecovery = blankBackupRecovery(); state.backupRecovery.points = [structuredClone(window.__clickHousePoint)]; state.backupRecovery.selectedPointId = 'point-clickhouse-incremental'; true;
    `);

    const source = await window.webContents.executeJavaScript(`(async () => {
      openBackupClickHouseModal(); els.backupClickHouseName.value = 'Production ClickHouse'; els.backupClickHousePassword.value = 'secret'; await discoverBackupClickHouse();
      els.backupClickHouseSourceName.value = 'Production analytics'; els.backupClickHouseAllTables.checked = false; syncBackupClickHouseSelection(); els.backupClickHouseTables.querySelector('input[value="events"]').checked = true; await approveBackupClickHouseDisk(); syncBackupClickHouseSelection();
      const evidence = els.backupClickHouseEvidence.innerText; await saveBackupClickHouseSource(new Event('submit', { cancelable: true }));
      return { payload: window.__clickHouseSourcePayload, approval: window.__clickHouseApproval, evidence, connections: window.__clickHouseConnections.length };
    })()`);

    const job = await window.webContents.executeJavaScript(`(() => {
      state.backupJobWizard = { ...blankBackupJobWizard(), sourceId: 'source-clickhouse', readiness: { sources: [{ id: 'source-clickhouse', name: 'Production analytics', sourceType: 'database', adapterId: 'deployerx.database.clickhouse', connectionName: 'Production ClickHouse', selection: { allDatabases: false, databases: { include: [{ name: 'analytics' }] }, tables: { include: [{ database: 'analytics', schema: 'analytics', name: 'events' }] } }, requestedConsistency: { backupMethod: 'physical', backupMode: 'full' }, physicalExecution: { productVersion: '25.8.3.66', diskName: 'backups', executionMode: 'asynchronous' }, objectKind: 'table', objectCount: 1, readiness: { ready: true, message: 'Ready' } }], repositories: [] } };
      renderBackupJobChoices(); syncBackupJobModeForSource(); const full = els.backupJobForm.querySelector('input[name="backupJobMode"][value="full"]'); const incremental = els.backupJobForm.querySelector('input[name="backupJobMode"][value="incremental"]'); incremental.checked = true;
      return { sourceDetail: els.backupJobSources.innerText, fullLabel: full.closest('label').innerText, incrementalChecked: incremental.checked, incrementalDisabled: incremental.disabled, incrementalLabel: incremental.closest('label').innerText };
    })()`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries(); const summary = els.backupRecoveryEntryList.innerText; const action = els.backupRecoveryRestoreButton.innerText;
      await openBackupClickHouseRestore(); await previewBackupClickHouseRestore(); const preview = els.backupClickHouseRestorePreview.innerText; await startBackupClickHouseRestore(new Event('submit', { cancelable: true }));
      return { summary, action, preview, status: els.backupClickHouseRestoreStatus.innerText, payload: window.__clickHouseRestorePayload };
    })()`);

    const verification = await window.webContents.executeJavaScript(`(async () => {
      closeBackupClickHouseRestore(); await openBackupClickHouseVerification(); await startBackupClickHouseVerification(new Event('submit', { cancelable: true })); const metadataStatus = els.backupClickHouseVerificationStatus.innerText;
      closeBackupClickHouseVerification(); await openBackupClickHouseVerification(); els.backupClickHouseVerificationForm.querySelector('input[value="clickhouse-full-drill"]').checked = true; syncBackupClickHouseVerificationMode(); await startBackupClickHouseVerification(new Event('submit', { cancelable: true }));
      return { metadataStatus, drillStatus: els.backupClickHouseVerificationStatus.innerText, payloads: window.__clickHouseVerificationPayloads };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      closeBackupClickHouseVerification(); await loadBackupActivity(); const tests = els.backupTestList.innerText;
      await openBackupActivityDetail('restore', 'restore-clickhouse'); const restore = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'clickhouse-verification-2'); const drill = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'clickhouse-verification-1'); return { rows: els.backupActivityList.innerText, tests, restore, drill, metadata: els.backupActivityDetailMetrics.innerText };
    })()`);

    const desktop = await window.webContents.executeJavaScript(`(() => { const card = els.backupActivityDetailModal.querySelector('.modal-card').getBoundingClientRect(); return { width: innerWidth, height: innerHeight, card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    window.unmaximize(); window.setResizable(true); await new Promise((resolve) => setTimeout(resolve, 50)); window.setContentSize(390, 844); await new Promise((resolve) => setTimeout(resolve, 150));
    const mobile = await window.webContents.executeJavaScript(`(async () => { const bounds = (modal) => { const card = modal.querySelector('.modal-card').getBoundingClientRect(); return { left: card.left, right: card.right, top: card.top, bottom: card.bottom }; }; closeBackupActivityDetail(); await openBackupClickHouseRestore(); const restore = bounds(els.backupClickHouseRestoreModal); closeBackupClickHouseRestore(); await openBackupClickHouseVerification(); const verification = bounds(els.backupClickHouseVerificationModal); closeBackupClickHouseVerification(); openBackupClickHouseModal(window.__clickHouseConnections.find((item) => item.id === 'connection-source')); await discoverBackupClickHouse(); const source = bounds(els.backupClickHouseModal); els.toast.classList.remove('visible'); els.toast.style.display = 'none'; return { source, restore, verification, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const screenshotPath = path.join(captureRoot, 'clickhouse-source-mobile.png'); await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

    const contained = (box, viewport) => box.left >= 0 && box.right <= viewport.width && box.top >= 0 && box.bottom <= viewport.height;
    const valid = source.connections === 2 && source.approval?.confirmationText === 'USE CLICKHOUSE BACKUP DISK' && source.payload?.consistency?.method === 'clickhouse-native-backup' && source.payload?.physicalExecution?.executionMode === 'asynchronous'
      && source.payload?.selector?.databases?.include?.[0]?.name === 'analytics' && source.payload?.selector?.tables?.include?.[0]?.name === 'events' && source.evidence.includes('deployment and topology authenticated')
      && job.sourceDetail.includes('ClickHouse 25.8.3.66 analytics') && job.fullLabel.includes('ClickHouse full baseline') && job.incrementalChecked && !job.incrementalDisabled && job.incrementalLabel.includes('ClickHouse incremental')
      && recovery.summary.includes('11111111-1111-4111-8111-111111111111') && recovery.summary.includes('1000 rows') && recovery.action.includes('Recover alternate ClickHouse') && recovery.preview.includes('2 recovery points') && recovery.preview.includes('Not claimed after native submission')
      && recovery.status.includes('target is preserved for inspection') && recovery.payload?.confirmationText === 'RESTORE CLICKHOUSE ALTERNATE'
      && verification.metadataStatus.includes('2 artifacts across 2 recovery points authenticated') && verification.drillStatus.includes('target remains preserved for inspection') && verification.payloads[1]?.confirmationText === 'RUN CLICKHOUSE RECOVERY DRILL'
      && activity.rows.includes('ClickHouse restore to recovered_analytics') && activity.rows.includes('ClickHouse chain, source, and disk validation') && activity.rows.includes('ClickHouse full alternate-database drill')
      && activity.tests.includes('source and disk identity matched') && activity.tests.includes('native integrity passed') && activity.restore.includes('Rollback and cleanup') && activity.restore.includes('Not claimed; target preserved')
      && activity.drill.includes('Full alternate-database ClickHouse drill') && activity.drill.includes('Preserved for inspection') && activity.metadata.includes('Backup disk identity') && activity.metadata.includes('Matched')
      && !desktop.overflow && contained(desktop.card, desktop) && mobile.width <= 390 && !mobile.overflow && contained(mobile.source, mobile) && contained(mobile.restore, mobile) && contained(mobile.verification, mobile);
    process.stdout.write(`${JSON.stringify({ ok: valid, source, job, recovery, verification, activity, desktop, mobile, screenshotPath })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1;
  } finally {
    window.destroy(); app.exit(process.exitCode || 0);
  }
});
