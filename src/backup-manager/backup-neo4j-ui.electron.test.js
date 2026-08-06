const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-neo4j-ui-'));
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
      window.__neo4jSourcePayload = null;
      window.__neo4jRestorePayload = null;
      window.__neo4jAggregationPayload = null;
      window.__neo4jVerificationPayloads = [];
      window.__neo4jConnections = [{
        id: 'connection-target', name: 'Recovery Graph', currentDevice: true, workerAffinity: ['device:test'],
        endpoint: { address: 'neo4j://recovery.example.com:7687', executionMode: 'local', expectedEdition: 'enterprise', expectedVersion: '2026.04.1' },
        trust: { fingerprint: 'sha256:target-deployment', topologyFingerprint: 'sha256:target-topology' },
        lastTest: { status: 'success', remotePlatform: { version: '2026.04.1' }, endpointIdentity: { edition: 'enterprise', version: '2026.04.1', deploymentFingerprint: 'sha256:target-deployment', topologyFingerprint: 'sha256:target-topology', databaseCount: 1, serverCount: 1 } }
      }];
      window.__neo4jPoint = {
        id: 'point-neo4j-diff', jobName: 'Production graph protection', sourceId: 'source-neo4j', sourceName: 'Production orders graph', sourceConnectionId: 'connection-source',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.neo4j', backupMethod: 'physical', type: 'differential', consistency: 'application', capturedTo: '2026-08-05T02:00:00.000Z',
        neo4j: { edition: 'enterprise', productVersion: '2026.04.1', databaseName: 'orders', databaseId: 'database-orders', deploymentFingerprint: 'sha256:source-deployment', topologyFingerprint: 'sha256:source-topology', backupMode: 'differential', storeFormat: 'aligned', artifactKind: 'neo4j-backup', nativeFileName: 'orders-2.backup', sizeBytes: 8192, lowestTransactionId: 451, highestTransactionId: 780, metadataScope: 'database-store-only-no-rbac', includesRbac: false, aggregated: false, sourceRecoveryPointIds: [], sourceMediaPreserved: false },
        retention: { deletionEligible: false }, availableCopyCount: 1, totalCopyCount: 1, repositoryCopies: [{ repositoryId: 'repo-primary', state: 'available' }]
      };
      window.__neo4jRestore = {
        id: 'restore-neo4j', state: 'succeeded', recoveryPointIds: ['point-neo4j-full', 'point-neo4j-diff'], createdAt: '2026-08-05T03:00:00.000Z', startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z',
        target: { operation: 'neo4j-alternate', mode: 'alternate', engine: 'neo4j', sourceDatabase: 'orders', targetDatabase: 'recovered_orders' },
        progress: { phase: 'complete', itemsTotal: 2, itemsCompleted: 2, itemsSkipped: 0, bytesTotal: 8192, bytesWritten: 8192, startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z' },
        validation: { nativeIntegrityValidation: true },
        result: { targetDatabase: 'recovered_orders', storeFormat: 'aligned', artifactCount: 2, bytesRestored: 8192, chainRecoveryPointIds: ['point-neo4j-full', 'point-neo4j-diff'], serviceStarted: false, cleanupPerformed: false, rollbackPerformed: false, completedAt: '2026-08-05T03:00:21.000Z' }
      };
      window.__neo4jVerifications = [];
      const empty = async () => [];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupLocalConnections: empty, listBackupSshConnections: empty, listBackupMysqlConnections: empty, listBackupMariadbConnections: empty,
        listBackupPostgresqlConnections: empty, listBackupSqlServerConnections: empty, listBackupOracleConnections: empty,
        listBackupMongoDbConnections: empty, listBackupRedisConnections: empty, listBackupSqliteConnections: empty, listBackupSearchSnapshotConnections: empty, listBackupScyllaManagerConnections: empty,
        listBackupNeo4jConnections: async () => structuredClone(window.__neo4jConnections),
        createBackupNeo4jConnection: async (payload) => {
          const connection = { id: 'connection-source', name: payload.name, currentDevice: true, workerAffinity: ['device:test'], adapterId: 'deployerx.database.neo4j', endpoint: { ...payload }, trust: {}, lastTest: null, neo4jInventory: null };
          window.__neo4jConnections.push(connection); return structuredClone(connection);
        },
        testBackupNeo4jConnection: async (id) => {
          const connection = window.__neo4jConnections.find((item) => item.id === id);
          const source = id === 'connection-source';
          const identity = { edition: 'enterprise', version: '2026.04.1', deploymentFingerprint: source ? 'sha256:source-deployment' : 'sha256:target-deployment', topologyFingerprint: source ? 'sha256:source-topology' : 'sha256:target-topology', databaseCount: 2, serverCount: 2 };
          const result = { status: 'success', remotePlatform: { version: '2026.04.1' }, endpointIdentity: identity };
          connection.lastTest = structuredClone(result); connection.trust = { fingerprint: identity.deploymentFingerprint, topologyFingerprint: identity.topologyFingerprint };
          return { connection: structuredClone(connection), result };
        },
        discoverBackupNeo4jResources: async () => ({
          edition: 'enterprise', version: { text: '2026.04.1' }, deploymentFingerprint: 'sha256:source-deployment', topologyFingerprint: 'sha256:source-topology',
          databases: [{ name: 'orders', databaseId: 'database-orders', system: false, selectable: true, currentStatus: 'online', requestedStatus: 'online', writer: true, serverId: 'server-a' }, { name: 'system', databaseId: 'database-system', system: true, selectable: false, currentStatus: 'online', requestedStatus: 'online', writer: true, serverId: 'server-a' }],
          servers: [{ serverId: 'server-a', state: 'enabled', health: 'available' }, { serverId: 'server-b', state: 'enabled', health: 'available' }]
        }),
        saveBackupDatabaseSource: async (payload) => { window.__neo4jSourcePayload = structuredClone(payload); return { id: 'source-neo4j', ...structuredClone(payload) }; },
        previewBackupNeo4jRestore: async (payload) => ({ artifactCount: 2, chainRecoveryPointIds: ['point-neo4j-full', 'point-neo4j-diff'], sourceEdition: 'enterprise', sourceVersion: '2026.04.1', targetEdition: 'enterprise', targetVersion: '2026.04.1', sourceDatabase: 'orders', targetDatabase: payload.targetDatabase, storeFormat: 'aligned' }),
        startBackupNeo4jRestore: async (payload) => { window.__neo4jRestorePayload = structuredClone(payload); return { id: 'restore-neo4j', state: 'queued', target: { engine: 'neo4j' } }; },
        waitBackupNeo4jRestore: async () => structuredClone(window.__neo4jRestore),
        cancelBackupNeo4jRestore: async (id) => ({ id, state: 'canceled', target: { engine: 'neo4j' }, result: { cleanupPerformed: false, rollbackPerformed: false } }),
        listBackupNeo4jRestoreRuns: async () => [structuredClone(window.__neo4jRestore)],
        previewBackupNeo4jAggregation: async () => ({ planId: 'plan-aggregate', artifactCount: 2, sourceBytes: 8192, chainRecoveryPointIds: ['point-neo4j-full', 'point-neo4j-diff'] }),
        startBackupNeo4jAggregation: async (payload) => { window.__neo4jAggregationPayload = structuredClone(payload); return { id: 'aggregation-neo4j', state: 'queued' }; },
        waitBackupNeo4jAggregation: async () => ({ id: 'aggregation-neo4j', state: 'succeeded', result: { sourceRecoveryPointIds: ['point-neo4j-full', 'point-neo4j-diff'], sourceMediaPreserved: true } }),
        startBackupNeo4jVerification: async (payload) => { window.__neo4jVerificationPayloads.push(structuredClone(payload)); return { id: 'verification-' + window.__neo4jVerificationPayloads.length, state: 'queued', mode: payload.mode }; },
        waitBackupNeo4jVerification: async (id) => {
          const payload = window.__neo4jVerificationPayloads[Number(id.split('-').pop()) - 1]; const drill = payload.mode === 'neo4j-full-drill';
          const run = { id, state: 'succeeded', mode: payload.mode, recoveryPointId: 'point-neo4j-diff', restoreRunId: drill ? 'restore-neo4j' : null, createdAt: '2026-08-05T03:10:00.000Z', startedAt: '2026-08-05T03:10:01.000Z', completedAt: '2026-08-05T03:10:11.000Z', progress: { phase: 'complete', startedAt: '2026-08-05T03:10:01.000Z', updatedAt: '2026-08-05T03:10:11.000Z' }, evidence: drill ? { verificationClass: 'neo4j-full-restore-drill', repositoryVerified: true, sourceIdentityVerified: true, completeChainAuthenticated: true, fullRestorePerformed: true, nativeIntegrityValidation: true, targetDatabase: 'drill_orders', storeFormat: 'aligned', artifactCount: 2, bytesRestored: 8192, chainRecoveryPointIds: ['point-neo4j-full', 'point-neo4j-diff'], serviceStarted: false, targetPreserved: true, cleanupPerformed: false, rollbackPerformed: false } : { verificationClass: 'neo4j-metadata-only', repositoryVerified: true, completeChainAuthenticated: true, sourceIdentityVerified: true, topologyVerified: true, databaseIdentityVerified: true, edition: 'enterprise', productVersion: '2026.04.1', databaseName: 'orders', databaseId: 'database-orders', backupMode: 'differential', storeFormat: 'aligned', artifactCount: 2, sizeBytes: 8192, chainRecoveryPointIds: ['point-neo4j-full', 'point-neo4j-diff'], serverCount: 2, fullRestorePerformed: false }, result: { completedAt: '2026-08-05T03:10:11.000Z' } };
          window.__neo4jVerifications.push(run); return structuredClone(run);
        },
        cancelBackupNeo4jVerification: async (id) => ({ id, state: 'canceled', mode: 'neo4j-metadata' }),
        listBackupNeo4jVerificationRuns: async () => structuredClone(window.__neo4jVerifications),
        listBackupRecoveryPoints: async () => ({ items: [structuredClone(window.__neo4jPoint)], nextCursor: null, total: 1 }),
        listBackupJobs: empty, listBackupRuns: empty, listBackupRestoreRuns: empty, listBackupMysqlRestoreRuns: empty,
        listBackupMysqlPhysicalRestoreRuns: empty, listBackupMariadbRestoreRuns: empty, listBackupMysqlPitrRuns: empty,
        listBackupMariadbPitrRuns: empty, listBackupPostgresqlRestoreRuns: empty, listBackupPostgresqlPitrRuns: empty,
        listBackupSqlServerRestoreRuns: empty, listBackupOracleRestoreRuns: empty, listBackupMongoDbRestoreRuns: empty,
        listBackupRedisRestoreRuns: empty, listBackupSqliteRestoreRuns: empty, listBackupSearchSnapshotRestoreRuns: empty,
        listBackupScyllaManagerRestoreRuns: empty, listBackupVerificationRuns: empty, listBackupSearchSnapshotVerificationRuns: empty,
        listBackupScyllaManagerVerificationRuns: empty
      }});
      state.backupRecovery = blankBackupRecovery(); state.backupRecovery.points = [structuredClone(window.__neo4jPoint)]; state.backupRecovery.selectedPointId = 'point-neo4j-diff'; true;
    `);

    const source = await window.webContents.executeJavaScript(`(async () => {
      openBackupNeo4jModal(); els.backupNeo4jName.value = 'Production Graph'; els.backupNeo4jUsername.value = 'backup-user'; els.backupNeo4jPassword.value = 'secret'; await discoverBackupNeo4j();
      els.backupNeo4jSourceName.value = 'Production orders graph'; els.backupNeo4jDatabase.value = 'orders'; els.backupNeo4jMode.value = 'differential'; els.backupNeo4jAddresses.value = 'neo-a.example.com:6362, neo-b.example.com:6362'; syncBackupNeo4jMethod();
      const evidence = els.backupNeo4jEvidence.innerText; await saveBackupNeo4jSource(new Event('submit', { cancelable: true }));
      return { payload: window.__neo4jSourcePayload, evidence, connections: window.__neo4jConnections.length };
    })()`);

    const job = await window.webContents.executeJavaScript(`(() => {
      state.backupJobWizard = { ...blankBackupJobWizard(), sourceId: 'source-neo4j', readiness: { sources: [{ id: 'source-neo4j', name: 'Production orders graph', sourceType: 'database', adapterId: 'deployerx.database.neo4j', connectionName: 'Production Graph', selection: { allDatabases: false, databases: { include: [{ name: 'orders' }] }, includeGlobalObjects: false }, requestedConsistency: { backupMethod: 'physical', backupMode: 'differential' }, physicalExecution: { tier: 'enterprise-online', productVersion: '2026.04.1', preferDiffAsParent: true, backupAddresses: ['neo-a.example.com:6362', 'neo-b.example.com:6362'] }, objectKind: 'database', objectCount: 1, readiness: { ready: true, message: 'Ready' } }], repositories: [] } };
      renderBackupJobChoices(); syncBackupJobModeForSource(); const full = els.backupJobForm.querySelector('input[name="backupJobMode"][value="full"]'); const differential = els.backupJobForm.querySelector('input[name="backupJobMode"][value="differential"]');
      differential.checked = true;
      return { sourceDetail: els.backupJobSources.innerText, fullChecked: full.checked, fullLabel: full.closest('label').innerText, differentialChecked: differential.checked, differentialDisabled: differential.disabled, differentialLabel: differential.closest('label').innerText };
    })()`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries(); const summary = els.backupRecoveryEntryList.innerText; const action = els.backupRecoveryRestoreButton.innerText;
      window.__neo4jPoint.neo4j.includesRbac = true; state.backupRecovery.points[0].neo4j.includesRbac = true; await openBackupNeo4jRestore(); const rbacRestoreBlocked = els.backupNeo4jRestorePreviewButton.disabled && els.backupNeo4jRestoreStartButton.disabled; closeBackupNeo4jRestore(); await openBackupNeo4jVerification(); const rbacDrillBlocked = els.backupNeo4jVerificationForm.querySelector('input[value="neo4j-full-drill"]').disabled; closeBackupNeo4jVerification();
      window.__neo4jPoint.neo4j.includesRbac = false; state.backupRecovery.points[0].neo4j.includesRbac = false; await openBackupNeo4jRestore(); await previewBackupNeo4jRestore(); const preview = els.backupNeo4jRestorePreview.innerText; await startBackupNeo4jRestore(new Event('submit', { cancelable: true }));
      return { summary, action, rbacRestoreBlocked, rbacDrillBlocked, preview, status: els.backupNeo4jRestoreStatus.innerText, restorePayload: window.__neo4jRestorePayload };
    })()`);

    const aggregation = await window.webContents.executeJavaScript(`(async () => {
      await aggregateBackupNeo4jChain(); return { status: els.backupNeo4jRestoreStatus.innerText, payload: window.__neo4jAggregationPayload };
    })()`);

    const verification = await window.webContents.executeJavaScript(`(async () => {
      closeBackupNeo4jRestore(); await openBackupNeo4jVerification(); await startBackupNeo4jVerification(new Event('submit', { cancelable: true })); const metadataStatus = els.backupNeo4jVerificationStatus.innerText;
      closeBackupNeo4jVerification(); await openBackupNeo4jVerification(); els.backupNeo4jVerificationForm.querySelector('input[value="neo4j-full-drill"]').checked = true; syncBackupNeo4jVerificationMode(); await startBackupNeo4jVerification(new Event('submit', { cancelable: true }));
      return { metadataStatus, drillStatus: els.backupNeo4jVerificationStatus.innerText, payloads: window.__neo4jVerificationPayloads };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      closeBackupNeo4jVerification(); await loadBackupActivity(); const testRows = els.backupTestList.innerText;
      await openBackupActivityDetail('restore', 'restore-neo4j'); const restoreMetrics = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'verification-2'); const drillMetrics = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'verification-1'); return { rows: els.backupActivityList.innerText, testRows, restoreMetrics, drillMetrics, metadataMetrics: els.backupActivityDetailMetrics.innerText };
    })()`);

    const desktop = await window.webContents.executeJavaScript(`(() => { const card = els.backupActivityDetailModal.querySelector('.modal-card').getBoundingClientRect(); return { width: innerWidth, height: innerHeight, card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    window.unmaximize(); window.setResizable(true); await new Promise((resolve) => setTimeout(resolve, 50)); window.setContentSize(390, 844); await new Promise((resolve) => setTimeout(resolve, 150));
    const mobile = await window.webContents.executeJavaScript(`(async () => {
      const bounds = (modal) => { const card = modal.querySelector('.modal-card').getBoundingClientRect(); return { left: card.left, right: card.right, top: card.top, bottom: card.bottom }; };
      closeBackupActivityDetail(); await openBackupNeo4jRestore(); const restore = bounds(els.backupNeo4jRestoreModal); closeBackupNeo4jRestore(); await openBackupNeo4jVerification(); const verification = bounds(els.backupNeo4jVerificationModal); closeBackupNeo4jVerification();
      openBackupNeo4jModal(window.__neo4jConnections.find((item) => item.id === 'connection-source')); await discoverBackupNeo4j(); els.backupNeo4jSourceName.value = 'Production orders graph'; els.backupNeo4jAddresses.value = 'neo-a.example.com:6362'; syncBackupNeo4jMethod(); const source = bounds(els.backupNeo4jModal); els.toast.classList.remove('visible'); els.toast.style.display = 'none';
      return { source, restore, verification, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    const screenshotPath = path.join(captureRoot, 'neo4j-source-mobile.png'); await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

    const contained = (box, viewport) => box.left >= 0 && box.right <= viewport.width && box.top >= 0 && box.bottom <= viewport.height;
    const valid = source.connections === 2 && source.payload?.consistency?.method === 'neo4j-native-backup' && source.payload?.consistency?.backupMode === 'differential'
      && source.payload?.selector?.databases?.include?.[0]?.name === 'orders' && source.payload?.physicalExecution?.backupAddresses?.length === 2 && source.evidence.includes('deployment and topology authenticated')
      && job.sourceDetail.includes('Neo4j 2026.04.1 orders') && !job.fullChecked && job.fullLabel.includes('Neo4j full baseline') && job.differentialChecked && !job.differentialDisabled && job.differentialLabel.includes('Neo4j differential')
      && recovery.summary.includes('database-orders') && recovery.summary.includes('Transactions 451 through 780') && recovery.action.includes('Recover alternate Neo4j') && recovery.rbacRestoreBlocked && recovery.rbacDrillBlocked
      && recovery.preview.includes('2 artifacts / 2 recovery points') && recovery.preview.includes('target remains stopped') && recovery.status.includes('database remains stopped') && recovery.restorePayload?.confirmationText === 'RESTORE NEO4J ALTERNATE'
      && aggregation.status.includes('source recovery points remain unchanged') && aggregation.payload?.confirmationText === 'AGGREGATE NEO4J BACKUP CHAIN' && aggregation.payload?.expectedPlanId === 'plan-aggregate'
      && verification.metadataStatus.includes('2 artifacts across 2 recovery points authenticated') && verification.drillStatus.includes('target remains stopped and preserved') && verification.payloads[1]?.confirmationText === 'RUN NEO4J RECOVERY DRILL'
      && activity.rows.includes('Neo4j restore to recovered_orders') && activity.rows.includes('Neo4j chain and source validation') && activity.rows.includes('Neo4j full alternate-target drill')
      && activity.testRows.includes('source identity matched') && activity.testRows.includes('native consistency passed') && activity.restoreMetrics.includes('Rollback and cleanup') && activity.restoreMetrics.includes('Not claimed')
      && activity.drillMetrics.includes('Full alternate-target Neo4j drill') && activity.drillMetrics.includes('Preserved for inspection') && activity.metadataMetrics.includes('Complete chain') && activity.metadataMetrics.includes('2 recovery points')
      && !desktop.overflow && contained(desktop.card, desktop) && mobile.width <= 390 && !mobile.overflow && contained(mobile.source, mobile) && contained(mobile.restore, mobile) && contained(mobile.verification, mobile);
    process.stdout.write(`${JSON.stringify({ ok: valid, source, job, recovery, aggregation, verification, activity, desktop, mobile, screenshotPath })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1;
  } finally {
    window.destroy(); app.exit(process.exitCode || 0);
  }
});
