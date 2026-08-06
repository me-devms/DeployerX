const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-influxdb-ui-'));
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
      window.__influxDbSourcePayload = null;
      window.__influxDbCreatePayload = null;
      window.__influxDbRestorePayload = null;
      window.__influxDbVerificationPayloads = [];
      const sourceDeployment = 'sha256:' + 'a'.repeat(64);
      const targetDeployment = 'sha256:' + 'b'.repeat(64);
      const inventoryFingerprint = 'sha256:' + 'c'.repeat(64);
      const organizations = [{ id: '0123456789abcdef', name: 'Production', status: 'active', selectable: true }];
      const buckets = [
        { id: '1111111111111111', organizationId: '0123456789abcdef', name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: 604800, shardGroupDurationSeconds: 86400 }], selectable: true },
        { id: '2222222222222222', organizationId: '0123456789abcdef', name: '_monitoring', type: 'system', schemaType: 'implicit', retentionRules: [], selectable: false }
      ];
      window.__influxDbConnections = [{
        id: 'connection-target', name: 'Recovery InfluxDB', currentDevice: true, workerAffinity: ['device:test'], adapterId: 'deployerx.database.influxdb',
        endpoint: { protocol: 'https', host: 'recovery.example.com', port: 8086, basePath: '', caFile: null, cliPath: 'influx', timeoutMs: 30000, expectedVersion: '2.7.11', expectedCliVersion: '2.7.5', expectedDeploymentFingerprint: targetDeployment },
        trust: { fingerprint: targetDeployment, inventoryFingerprint }, influxdbInventory: { organizations: [], buckets: [] },
        lastTest: { status: 'success', remotePlatform: { version: '2.7.11' }, endpointIdentity: { product: 'influxdb-oss-v2', version: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: targetDeployment, inventoryFingerprint, organizationCount: 0, bucketCount: 0, userBucketCount: 0, recoveryBoundary: 'hash-only-plaintext-unrecoverable' } }
      }];
      window.__influxDbPoint = {
        id: 'point-influxdb-full', jobName: 'Production metrics protection', sourceId: 'source-influxdb', sourceName: 'Production metrics', sourceConnectionId: 'connection-source',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.influxdb', backupMethod: 'physical', type: 'full', consistency: 'application', capturedTo: '2026-08-05T02:00:00.000Z',
        influxdb: { productVersion: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: sourceDeployment, inventoryFingerprint, backupMode: 'full', scope: 'bucket', organizationId: '0123456789abcdef', organizationName: 'Production', bucketId: '1111111111111111', bucketName: 'metrics', buckets: [{ id: '1111111111111111', name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: 604800, shardGroupDurationSeconds: 86400 }] }], bucketCount: 1, fileCount: 3, totalBytes: 8192, mediaFingerprint: 'sha256:' + 'd'.repeat(64), tokenRecovery: 'hash-only-plaintext-unrecoverable', restoreSupported: true },
        retention: { deletionEligible: false }, verification: { state: 'succeeded' }, availableCopyCount: 1, totalCopyCount: 1, repositoryCopies: [{ repositoryId: 'repo-primary', state: 'available' }]
      };
      window.__influxDbRestore = {
        id: 'restore-influxdb', state: 'succeeded', recoveryPointIds: ['point-influxdb-full'], createdAt: '2026-08-05T03:00:00.000Z', startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z',
        target: { operation: 'influxdb-oss-v2-alternate-restore', mode: 'alternate', engine: 'influxdb', targetConnectionId: 'connection-target', nativeMutationStarted: true },
        progress: { phase: 'complete', itemsTotal: 3, itemsCompleted: 3, itemsSkipped: 0, bytesTotal: 8192, bytesWritten: 8192, startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z' },
        validation: { nativeIntegrityValidation: true },
        result: { organization: { id: '0123456789abcdef', name: 'Production' }, buckets: [{ id: '1111111111111111', name: 'metrics' }], targetPreserved: true, rollbackClaimed: false, completedAt: '2026-08-05T03:00:21.000Z' }
      };
      window.__influxDbVerifications = [];
      const discovery = { product: 'influxdb-oss-v2', version: { text: '2.7.11' }, cliVersion: { text: '2.7.5' }, deploymentFingerprint: sourceDeployment, inventoryFingerprint, tokenRecovery: 'hash-only-plaintext-unrecoverable', organizations, buckets, capabilities: { nativeBackupAvailable: true, nativeRestoreAvailable: true, plaintextTokenRecovery: false } };
      const empty = async () => [];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupLocalConnections: empty, listBackupSshConnections: empty, listBackupMysqlConnections: empty, listBackupMariadbConnections: empty,
        listBackupPostgresqlConnections: empty, listBackupSqlServerConnections: empty, listBackupOracleConnections: empty, listBackupMongoDbConnections: empty,
        listBackupNeo4jConnections: empty, listBackupClickHouseConnections: empty, listBackupRedisConnections: empty, listBackupSqliteConnections: empty,
        listBackupSearchSnapshotConnections: empty, listBackupScyllaManagerConnections: empty,
        listBackupInfluxDbConnections: async () => structuredClone(window.__influxDbConnections),
        createBackupInfluxDbConnection: async (payload) => { window.__influxDbCreatePayload = structuredClone(payload); const connection = { id: 'connection-source', name: payload.name, currentDevice: true, workerAffinity: ['device:test'], adapterId: 'deployerx.database.influxdb', endpoint: { ...payload, expectedVersion: null, expectedCliVersion: null, expectedDeploymentFingerprint: null }, trust: {}, lastTest: null, influxdbInventory: null }; delete connection.endpoint.token; window.__influxDbConnections.push(connection); return structuredClone(connection); },
        testBackupInfluxDbConnection: async (id) => { const connection = window.__influxDbConnections.find((item) => item.id === id); const deploymentFingerprint = id === 'connection-source' ? sourceDeployment : targetDeployment; const result = { status: 'success', remotePlatform: { version: '2.7.11' }, endpointIdentity: { product: 'influxdb-oss-v2', version: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint, inventoryFingerprint, organizationCount: id === 'connection-source' ? 1 : 0, bucketCount: id === 'connection-source' ? 2 : 0, userBucketCount: id === 'connection-source' ? 1 : 0, recoveryBoundary: 'hash-only-plaintext-unrecoverable' } }; connection.lastTest = structuredClone(result); connection.trust = { fingerprint: deploymentFingerprint, inventoryFingerprint }; connection.endpoint.expectedVersion = '2.7.11'; connection.endpoint.expectedCliVersion = '2.7.5'; connection.endpoint.expectedDeploymentFingerprint = deploymentFingerprint; connection.influxdbInventory = id === 'connection-source' ? { organizations: structuredClone(organizations), buckets: structuredClone(buckets), deploymentFingerprint, inventoryFingerprint } : { organizations: [], buckets: [], deploymentFingerprint, inventoryFingerprint }; return { connection: structuredClone(connection), result }; },
        discoverBackupInfluxDbResources: async () => structuredClone(discovery),
        saveBackupDatabaseSource: async (payload) => { window.__influxDbSourcePayload = structuredClone(payload); return { id: 'source-influxdb', ...structuredClone(payload) }; },
        previewBackupInfluxDbRestore: async (payload) => ({ mode: 'alternate', recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, scope: 'bucket', organization: { id: '0123456789abcdef', name: 'Production' }, bucket: { id: '1111111111111111', name: 'metrics' }, sourceVersion: '2.7.11', targetVersion: '2.7.11', fileCount: 3, totalBytes: 8192, targetEmpty: true, originalTargetReplacement: false, nativeValidation: true }),
        startBackupInfluxDbRestore: async (payload) => { window.__influxDbRestorePayload = structuredClone(payload); return { id: 'restore-influxdb', state: 'queued', target: { engine: 'influxdb' } }; },
        waitBackupInfluxDbRestore: async () => structuredClone(window.__influxDbRestore), cancelBackupInfluxDbRestore: async (id) => ({ id, state: 'canceled', target: { engine: 'influxdb' } }),
        listBackupInfluxDbRestoreRuns: async () => [structuredClone(window.__influxDbRestore)],
        startBackupInfluxDbVerification: async (payload) => { window.__influxDbVerificationPayloads.push(structuredClone(payload)); return { id: 'influxdb-verification-' + window.__influxDbVerificationPayloads.length, state: 'queued', mode: payload.mode }; },
        waitBackupInfluxDbVerification: async (id) => { const payload = window.__influxDbVerificationPayloads[Number(id.split('-').pop()) - 1]; const drill = payload.mode === 'influxdb-full-drill'; const run = { id, state: 'succeeded', mode: payload.mode, recoveryPointId: 'point-influxdb-full', restoreRunId: drill ? 'restore-influxdb' : null, createdAt: '2026-08-05T03:10:00.000Z', startedAt: '2026-08-05T03:10:01.000Z', completedAt: '2026-08-05T03:10:11.000Z', progress: { phase: 'complete', startedAt: '2026-08-05T03:10:01.000Z', updatedAt: '2026-08-05T03:10:11.000Z' }, evidence: drill ? { verificationClass: 'influxdb-full-restore-drill', repositoryVerified: true, completeMediaAuthenticated: true, sourceIdentityVerified: true, fullRestorePerformed: true, nativeIntegrityValidation: true, organization: { id: '0123456789abcdef', name: 'Production' }, bucketCount: 1, nativeFileCount: 3, sizeBytes: 8192, targetPreserved: true, cleanupPerformed: false, rollbackPerformed: false } : { verificationClass: 'influxdb-metadata-only', repositoryVerified: true, completeMediaAuthenticated: true, sourceIdentityVerified: true, inventoryVerified: true, retentionRulesVerified: true, productVersion: '2.7.11', cliVersion: '2.7.5', scope: 'bucket', organizationId: '0123456789abcdef', organizationName: 'Production', bucketCount: 1, nativeFileCount: 3, sizeBytes: 8192, tokenRecovery: 'hash-only-plaintext-unrecoverable', fullRestorePerformed: false }, result: { completedAt: '2026-08-05T03:10:11.000Z' } }; window.__influxDbVerifications.push(run); return structuredClone(run); },
        cancelBackupInfluxDbVerification: async (id) => ({ id, state: 'canceled', mode: 'influxdb-metadata' }), listBackupInfluxDbVerificationRuns: async () => structuredClone(window.__influxDbVerifications),
        listBackupRecoveryPoints: async () => ({ items: [structuredClone(window.__influxDbPoint)], nextCursor: null, total: 1 }), listBackupJobs: empty, listBackupRuns: empty, listBackupRestoreRuns: empty,
        listBackupMysqlRestoreRuns: empty, listBackupMysqlPhysicalRestoreRuns: empty, listBackupMariadbRestoreRuns: empty, listBackupMysqlPitrRuns: empty, listBackupMariadbPitrRuns: empty,
        listBackupPostgresqlRestoreRuns: empty, listBackupPostgresqlPitrRuns: empty, listBackupSqlServerRestoreRuns: empty, listBackupOracleRestoreRuns: empty, listBackupMongoDbRestoreRuns: empty,
        listBackupNeo4jRestoreRuns: empty, listBackupClickHouseRestoreRuns: empty, listBackupRedisRestoreRuns: empty, listBackupSqliteRestoreRuns: empty, listBackupSearchSnapshotRestoreRuns: empty, listBackupScyllaManagerRestoreRuns: empty,
        listBackupVerificationRuns: empty, listBackupNeo4jVerificationRuns: empty, listBackupClickHouseVerificationRuns: empty, listBackupSearchSnapshotVerificationRuns: empty, listBackupScyllaManagerVerificationRuns: empty
      }});
      state.backupRecovery = blankBackupRecovery(); state.backupRecovery.points = [structuredClone(window.__influxDbPoint)]; state.backupRecovery.selectedPointId = 'point-influxdb-full'; true;
    `);

    const source = await window.webContents.executeJavaScript(`(async () => {
      openBackupInfluxDbModal(); els.backupInfluxDbName.value = 'Production InfluxDB'; els.backupInfluxDbProtocol.value = 'http'; syncBackupInfluxDbProtocol(); els.backupInfluxDbAllowInsecure.checked = true; els.backupInfluxDbHost.value = 'influx.example.com'; els.backupInfluxDbToken.value = 'secret-token'; await discoverBackupInfluxDb();
      els.backupInfluxDbSourceName.value = 'Production metrics'; els.backupInfluxDbBucket.value = '1111111111111111'; syncBackupInfluxDbSelection(); const evidence = els.backupInfluxDbEvidence.innerText + ' ' + els.backupInfluxDbScopeEvidence.innerText; await saveBackupInfluxDbSource(new Event('submit', { cancelable: true }));
      return { payload: window.__influxDbSourcePayload, createPayload: window.__influxDbCreatePayload, evidence, connections: window.__influxDbConnections.length };
    })()`);

    const job = await window.webContents.executeJavaScript(`(() => {
      state.backupJobWizard = { ...blankBackupJobWizard(), sourceId: 'source-influxdb', readiness: { sources: [{ id: 'source-influxdb', name: 'Production metrics', sourceType: 'database', adapterId: 'deployerx.database.influxdb', connectionName: 'Production InfluxDB', selection: { allDatabases: false, databases: { include: [{ name: 'Production' }] }, tables: { include: [{ database: 'Production', schema: 'Production', name: 'metrics' }] } }, requestedConsistency: { backupMethod: 'physical', backupMode: 'full', method: 'influxdb-v2-native-backup' }, physicalExecution: { organizationName: 'Production' }, objectKind: 'table', objectCount: 1, readiness: { ready: true, message: 'Ready' } }], repositories: [] } };
      renderBackupJobChoices(); syncBackupJobModeForSource(); const full = els.backupJobForm.querySelector('input[name="backupJobMode"][value="full"]'); const incremental = els.backupJobForm.querySelector('input[name="backupJobMode"][value="incremental"]');
      return { sourceDetail: els.backupJobSources.innerText, fullLabel: full.closest('label').innerText, fullChecked: full.checked, incrementalDisabled: incremental.disabled, incrementalTitle: incremental.closest('label').title };
    })()`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries(); const summary = els.backupRecoveryEntryList.innerText; const action = els.backupRecoveryRestoreButton.innerText;
      await openBackupInfluxDbRestore(); await previewBackupInfluxDbRestore(); const preview = els.backupInfluxDbRestorePreview.innerText; await startBackupInfluxDbRestore(new Event('submit', { cancelable: true }));
      return { summary, action, preview, status: els.backupInfluxDbRestoreStatus.innerText, payload: window.__influxDbRestorePayload };
    })()`);

    const verification = await window.webContents.executeJavaScript(`(async () => {
      closeBackupInfluxDbRestore(); await openBackupInfluxDbVerification(); await startBackupInfluxDbVerification(new Event('submit', { cancelable: true })); const metadataStatus = els.backupInfluxDbVerificationStatus.innerText;
      closeBackupInfluxDbVerification(); await openBackupInfluxDbVerification(); els.backupInfluxDbVerificationForm.querySelector('input[value="influxdb-full-drill"]').checked = true; syncBackupInfluxDbVerificationMode(); await startBackupInfluxDbVerification(new Event('submit', { cancelable: true }));
      return { metadataStatus, drillStatus: els.backupInfluxDbVerificationStatus.innerText, payloads: window.__influxDbVerificationPayloads };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      closeBackupInfluxDbVerification(); await loadBackupActivity(); const tests = els.backupTestList.innerText;
      await openBackupActivityDetail('restore', 'restore-influxdb'); const restore = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'influxdb-verification-2'); const drill = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'influxdb-verification-1'); return { rows: els.backupActivityList.innerText, tests, restore, drill, metadata: els.backupActivityDetailMetrics.innerText };
    })()`);

    const desktop = await window.webContents.executeJavaScript(`(() => { const card = els.backupActivityDetailModal.querySelector('.modal-card').getBoundingClientRect(); return { width: innerWidth, height: innerHeight, card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    window.unmaximize(); window.setResizable(true); await new Promise((resolve) => setTimeout(resolve, 50)); window.setContentSize(390, 844); await new Promise((resolve) => setTimeout(resolve, 150));
    const mobile = await window.webContents.executeJavaScript(`(async () => { const bounds = (modal) => { const card = modal.querySelector('.modal-card').getBoundingClientRect(); return { left: card.left, right: card.right, top: card.top, bottom: card.bottom }; }; closeBackupActivityDetail(); await openBackupInfluxDbRestore(); const restore = bounds(els.backupInfluxDbRestoreModal); closeBackupInfluxDbRestore(); await openBackupInfluxDbVerification(); const verification = bounds(els.backupInfluxDbVerificationModal); closeBackupInfluxDbVerification(); openBackupInfluxDbModal(window.__influxDbConnections.find((item) => item.id === 'connection-source')); await discoverBackupInfluxDb(); const source = bounds(els.backupInfluxDbModal); const token = els.backupInfluxDbToken.value; const connectionFieldsHidden = els.backupInfluxDbConnectionFields.classList.contains('hidden'); els.toast.classList.remove('visible'); els.toast.style.display = 'none'; return { source, restore, verification, token, connectionFieldsHidden, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const screenshotPath = path.join(captureRoot, 'influxdb-source-mobile.png'); await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

    const contained = (box, viewport) => box.left >= 0 && box.right <= viewport.width && box.top >= 0 && box.bottom <= viewport.height;
    const serialized = JSON.stringify({ sourceEvidence: source.evidence, sourcePayload: source.payload, recovery, verification, activity });
    const valid = source.connections === 2 && source.createPayload?.protocol === 'http' && source.createPayload?.allowInsecureHttp === true && source.createPayload?.token === 'secret-token'
      && source.payload?.consistency?.method === 'influxdb-v2-native-backup' && source.payload?.consistency?.backupMode === 'full' && source.payload?.selector?.databases?.include?.[0]?.name === 'Production' && source.payload?.selector?.tables?.include?.[0]?.name === 'metrics'
      && source.evidence.includes('deployment and inventory authenticated') && source.evidence.includes('plaintext token recovery unavailable')
      && job.sourceDetail.includes('InfluxDB OSS v2 Production / metrics') && job.fullLabel.includes('InfluxDB full recovery point') && job.fullChecked && job.incrementalDisabled && job.incrementalTitle.includes('full recovery points only')
      && recovery.summary.includes('InfluxDB OSS 2.7.11') && recovery.summary.includes('604800s retention') && recovery.summary.includes('plaintext unavailable') && recovery.action.includes('Recover alternate InfluxDB')
      && recovery.preview.includes('3 members') && recovery.preview.includes('Original replacement') && recovery.preview.includes('Not claimed after native submission') && recovery.status.includes('target is preserved for inspection') && recovery.payload?.confirmationText === 'RESTORE INFLUXDB ALTERNATE'
      && verification.metadataStatus.includes('3 native members authenticated') && verification.metadataStatus.includes('token-recovery boundaries match') && verification.drillStatus.includes('target remains preserved for inspection') && verification.payloads[1]?.confirmationText === 'RUN INFLUXDB RECOVERY DRILL'
      && activity.rows.includes('InfluxDB alternate restore') && activity.rows.includes('InfluxDB media, source, scope, and retention validation') && activity.rows.includes('InfluxDB full alternate-instance drill')
      && activity.tests.includes('source, scope, inventory, and retention matched') && activity.tests.includes('native integrity passed') && activity.restore.includes('Rollback and cleanup') && activity.restore.includes('Not claimed; target preserved')
      && activity.drill.includes('Full alternate-instance InfluxDB drill') && activity.drill.includes('Preserved for inspection') && activity.metadata.includes('Token recovery') && activity.metadata.includes('Plaintext unavailable')
      && !serialized.includes('secret-token') && !serialized.includes('secretRef') && !serialized.includes('repositoryPath') && !serialized.includes('staging')
      && !desktop.overflow && contained(desktop.card, desktop) && mobile.width <= 390 && !mobile.overflow && mobile.token === '' && mobile.connectionFieldsHidden && contained(mobile.source, mobile) && contained(mobile.restore, mobile) && contained(mobile.verification, mobile);
    process.stdout.write(`${JSON.stringify({ ok: valid, source, job, recovery, verification, activity, desktop, mobile, screenshotPath })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1;
  } finally {
    window.destroy(); app.exit(process.exitCode || 0);
  }
});
