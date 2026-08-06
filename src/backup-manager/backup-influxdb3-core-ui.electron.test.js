const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-influxdb3-core-ui-'));
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
      window.__coreCreatePayload = null;
      window.__coreSourcePayload = null;
      window.__coreRestorePayload = null;
      window.__coreVerificationPayloads = [];
      const sourceDeployment = 'sha256:' + 'a'.repeat(64);
      const targetDeployment = 'sha256:' + 'b'.repeat(64);
      const storageFingerprint = 'sha256:' + 'c'.repeat(64);
      const directoryFingerprint = 'sha256:' + 'd'.repeat(64);
      const mediaFingerprint = 'sha256:' + 'e'.repeat(64);
      const privateBucket = 'private-core-target-bucket';
      const testedTarget = {
        id: 'connection-core-target', name: 'Stopped Core recovery node', currentDevice: true, workerAffinity: ['device:test'], adapterId: 'deployerx.database.influxdb3-core',
        endpoint: { protocol: 'https', host: 'core-recovery.example.com', port: 8181, basePath: '', caFile: null, timeoutMs: 30000, objectStore: 's3', objectStoreRegion: 'us-east-1', objectStoreBucket: privateBucket, objectStorePrefix: 'recovery', nodeId: 'node-a' },
        trust: { fingerprint: targetDeployment, storageFingerprint },
        lastTest: { status: 'success', endpointIdentity: { product: 'influxdb3-core', version: '3.0.3', nodeId: 'node-a', objectStore: 's3', deploymentFingerprint: targetDeployment, storageFingerprint, endpointReachable: false, restoreSupported: true } }
      };
      window.__coreConnections = [testedTarget];
      window.__corePoint = {
        id: 'point-core-full', jobName: 'Production Core protection', sourceId: 'source-core', sourceName: 'Production Core node', sourceConnectionId: 'connection-core-source',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.influxdb3-core', backupMethod: 'physical', type: 'full', consistency: 'application', capturedTo: '2026-08-05T02:00:00.000Z',
        influxdb3Core: { productVersion: '3.0.3', nodeId: 'node-a', deploymentFingerprint: sourceDeployment, storageFingerprint, objectStore: 's3', consistencyMode: 'stopped', copyOrder: ['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint'], excluded: ['table-snapshots'], fileCount: 5, directoryCount: 7, totalBytes: 12288, mediaFingerprint, directoryFingerprint, restoreSupported: true, operatorReviewRequired: true, manualStartupRequired: true },
        retention: { deletionEligible: false }, verification: { state: 'succeeded' }, availableCopyCount: 1, totalCopyCount: 1, repositoryCopies: [{ repositoryId: 'repo-primary', state: 'available' }]
      };
      window.__coreRestore = {
        id: 'restore-core', state: 'succeeded', recoveryPointIds: ['point-core-full'], createdAt: '2026-08-05T03:00:00.000Z', startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z',
        target: { operation: 'influxdb3-core-alternate-s3-restore', mode: 'alternate', engine: 'influxdb3-core', targetConnectionId: 'connection-core-target', targetMutationStarted: true, restoreEvidence: { target: { objectStore: 's3' }, source: { nodeId: 'node-a' } } },
        progress: { phase: 'complete', itemsTotal: 5, itemsCompleted: 5, itemsSkipped: 0, bytesTotal: 12288, bytesWritten: 12288, startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z' },
        validation: { nativeIntegrityValidation: true },
        result: { nodeId: 'node-a', objectStore: 's3', nativeFileCount: 5, nativeDirectoryCount: 7, bytesRestored: 12288, targetStopped: true, targetPreserved: true, operatorReviewRequired: true, manualStartupRequired: true, cleanupPerformed: false, rollbackClaimed: false, completedAt: '2026-08-05T03:00:21.000Z' }
      };
      window.__coreVerifications = [];
      const empty = async () => [];
      const listConnections = async () => structuredClone(window.__coreConnections);
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupLocalConnections: empty, listBackupSshConnections: empty, listBackupMysqlConnections: empty, listBackupMariadbConnections: empty,
        listBackupPostgresqlConnections: empty, listBackupSqlServerConnections: empty, listBackupOracleConnections: empty, listBackupMongoDbConnections: empty,
        listBackupNeo4jConnections: empty, listBackupClickHouseConnections: empty, listBackupInfluxDbConnections: empty, listBackupRedisConnections: empty,
        listBackupSearchSnapshotConnections: empty, listBackupScyllaManagerConnections: empty, listBackupSqliteConnections: empty,
        listBackupInfluxDb3CoreConnections: listConnections,
        createBackupInfluxDb3CoreConnection: async (payload) => {
          window.__coreCreatePayload = structuredClone(payload);
          const { accessKeyId, secretAccessKey, sessionToken, confirmationText, ...endpoint } = payload;
          const connection = { id: 'connection-core-source', name: payload.name, currentDevice: true, workerAffinity: ['device:test'], adapterId: 'deployerx.database.influxdb3-core', endpoint, trust: {}, lastTest: null };
          window.__coreConnections.push(connection); return structuredClone(connection);
        },
        testBackupInfluxDb3CoreConnection: async (id) => {
          const connection = window.__coreConnections.find((item) => item.id === id);
          const source = id === 'connection-core-source';
          const identity = { product: 'influxdb3-core', version: '3.0.3', nodeId: 'node-a', objectStore: 's3', deploymentFingerprint: source ? sourceDeployment : targetDeployment, storageFingerprint, endpointReachable: false, restoreSupported: true };
          connection.lastTest = { status: 'success', endpointIdentity: identity };
          connection.trust = { fingerprint: identity.deploymentFingerprint, storageFingerprint };
          return { connection: structuredClone(connection), result: structuredClone(connection.lastTest) };
        },
        discoverBackupInfluxDb3CoreResources: async () => ({ product: 'influxdb3-core', version: { text: '3.0.3' }, deploymentFingerprint: sourceDeployment, storageFingerprint, items: [{ id: 'node-a', name: 'node-a', selectable: true, objectStore: 's3', fileCount: 5, directoryCount: 7, totalBytes: 12288 }] }),
        saveBackupDatabaseSource: async (payload) => { window.__coreSourcePayload = structuredClone(payload); return { id: 'source-core', ...structuredClone(payload) }; },
        previewBackupInfluxDb3CoreRestore: async (payload) => ({ mode: 'alternate', recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, nodeId: 'node-a', objectStore: 's3', sourceVersion: '3.0.3', targetVersion: '3.0.3', fileCount: 5, directoryCount: 7, totalBytes: 12288, targetStopped: true, targetNodeAbsent: true, nativeValidation: true }),
        startBackupInfluxDb3CoreRestore: async (payload) => { window.__coreRestorePayload = structuredClone(payload); return { id: 'restore-core', state: 'queued', target: { engine: 'influxdb3-core' } }; },
        waitBackupInfluxDb3CoreRestore: async () => structuredClone(window.__coreRestore),
        cancelBackupInfluxDb3CoreRestore: async (id) => ({ id, state: 'canceled', target: { engine: 'influxdb3-core' } }),
        listBackupInfluxDb3CoreRestoreRuns: async () => [structuredClone(window.__coreRestore)],
        startBackupInfluxDb3CoreVerification: async (payload) => { window.__coreVerificationPayloads.push(structuredClone(payload)); return { id: 'core-verification-' + window.__coreVerificationPayloads.length, state: 'queued', mode: payload.mode }; },
        waitBackupInfluxDb3CoreVerification: async (id) => {
          const payload = window.__coreVerificationPayloads[Number(id.split('-').pop()) - 1];
          const drill = payload.mode === 'influxdb3-core-full-drill';
          const run = { id, state: 'succeeded', mode: payload.mode, recoveryPointId: 'point-core-full', restoreRunId: drill ? 'restore-core' : null, createdAt: '2026-08-05T03:10:00.000Z', startedAt: '2026-08-05T03:10:01.000Z', completedAt: '2026-08-05T03:10:11.000Z', progress: { phase: 'complete', startedAt: '2026-08-05T03:10:01.000Z', updatedAt: '2026-08-05T03:10:11.000Z' }, evidence: drill ? { verificationClass: 'influxdb3-core-full-drill', objectStore: 's3', repositoryVerified: true, completeMediaAuthenticated: true, sourceIdentityVerified: true, storageIdentityVerified: true, consistencyProofVerified: true, fullRestorePerformed: true, nativeIntegrityValidation: true, productVersion: '3.0.3', nodeId: 'node-a', nativeFileCount: 5, nativeDirectoryCount: 7, sizeBytes: 12288, targetStopped: true, targetPreserved: true, operatorReviewRequired: true, manualStartupRequired: true, cleanupPerformed: false, rollbackPerformed: false } : { verificationClass: 'influxdb3-core-metadata-only', objectStore: 's3', repositoryVerified: true, completeMediaAuthenticated: true, sourceIdentityVerified: true, storageIdentityVerified: true, consistencyProofVerified: true, productVersion: '3.0.3', nodeId: 'node-a', nativeFileCount: 5, nativeDirectoryCount: 7, sizeBytes: 12288, fullRestorePerformed: false }, result: { objectStore: 's3', completedAt: '2026-08-05T03:10:11.000Z' } };
          window.__coreVerifications.push(run); return structuredClone(run);
        },
        cancelBackupInfluxDb3CoreVerification: async (id) => ({ id, state: 'canceled', mode: 'influxdb3-core-metadata' }),
        listBackupInfluxDb3CoreVerificationRuns: async () => structuredClone(window.__coreVerifications),
        listBackupJobs: empty, listBackupRuns: empty, listBackupRestoreRuns: empty, listBackupVerificationRuns: empty
      }});
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [structuredClone(window.__corePoint)];
      state.backupRecovery.selectedPointId = 'point-core-full';
      true;
    `);

    const source = await window.webContents.executeJavaScript(`(async () => {
      openBackupInfluxDb3CoreModal();
      els.backupInfluxDb3CoreName.value = 'Production Core'; els.backupInfluxDb3CoreProtocol.value = 'http'; syncBackupInfluxDb3CoreProtocol(); els.backupInfluxDb3CoreAllowInsecure.checked = true;
      els.backupInfluxDb3CoreHost.value = 'core.example.com'; els.backupInfluxDb3CoreObjectStore.value = 's3'; syncBackupInfluxDb3CoreObjectStore();
      els.backupInfluxDb3CoreObjectStoreEndpoint.value = 'http://private-objects.example.com'; syncBackupInfluxDb3CoreObjectStore(); els.backupInfluxDb3CoreAllowInsecureObjectStoreEndpoint.checked = true;
      els.backupInfluxDb3CoreObjectStoreRegion.value = 'us-east-1'; els.backupInfluxDb3CoreObjectStoreBucket.value = 'private-core-source-bucket'; els.backupInfluxDb3CoreObjectStorePrefix.value = 'production'; els.backupInfluxDb3CoreObjectStoreForcePathStyle.checked = true;
      els.backupInfluxDb3CoreAccessKeyId.value = 'PRIVATE_ACCESS_KEY'; els.backupInfluxDb3CoreSecretAccessKey.value = 'PRIVATE_SECRET_KEY'; els.backupInfluxDb3CoreSessionToken.value = 'PRIVATE_SESSION_TOKEN'; els.backupInfluxDb3CoreNodeId.value = 'node-a'; els.backupInfluxDb3CoreBindConfirmation.checked = true;
      await discoverBackupInfluxDb3Core(); const evidence = els.backupInfluxDb3CoreEvidence.innerText;
      els.backupInfluxDb3CoreSourceName.value = 'Production Core node'; els.backupInfluxDb3CoreConsistency.value = 'ordered-live-copy'; syncBackupInfluxDb3CoreConsistency();
      await saveBackupInfluxDb3CoreSource(new Event('submit', { cancelable: true }));
      const created = window.__coreConnections.find((connection) => connection.id === 'connection-core-source'); openBackupInfluxDb3CoreModal(created);
      const credentialsRedisplayed = [els.backupInfluxDb3CoreAccessKeyId.value, els.backupInfluxDb3CoreSecretAccessKey.value, els.backupInfluxDb3CoreSessionToken.value].some(Boolean); closeBackupInfluxDb3CoreModal();
      return { createPayload: window.__coreCreatePayload, payload: window.__coreSourcePayload, evidence, credentialsRedisplayed, modalClosed: els.backupInfluxDb3CoreModal.classList.contains('hidden'), connectionCount: window.__coreConnections.length };
    })()`);

    const job = await window.webContents.executeJavaScript(`(() => {
      state.backupJobWizard = { ...blankBackupJobWizard(), sourceId: 'source-core', readiness: { sources: [{ id: 'source-core', name: 'Production Core node', sourceType: 'database', adapterId: 'deployerx.database.influxdb3-core', connectionName: 'Production Core', selection: { allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] } }, requestedConsistency: { backupMethod: 'physical', backupMode: 'full', method: 'influxdb3-core-ordered-copy' }, physicalExecution: { objectStore: 's3', nodeId: 'node-a', consistencyMode: 'ordered-live-copy' }, objectKind: 'database', objectCount: 1, readiness: { ready: true, message: 'Ready' } }], repositories: [] } };
      renderBackupJobChoices(); syncBackupJobModeForSource(); const full = els.backupJobForm.querySelector('input[name="backupJobMode"][value="full"]'); const incremental = els.backupJobForm.querySelector('input[name="backupJobMode"][value="incremental"]');
      return { sourceDetail: els.backupJobSources.innerText, fullLabel: full.closest('label').innerText, fullChecked: full.checked, incrementalDisabled: incremental.disabled, incrementalTitle: incremental.closest('label').title };
    })()`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      let step = 'render';
      try {
        renderBackupRecoveryPoints(); renderBackupRecoveryEntries(); const summary = els.backupRecoveryEntryList.innerText; const action = els.backupRecoveryRestoreButton.innerText;
        step = 'open'; await openBackupInfluxDbRestore();
        step = 'preview'; await previewBackupInfluxDbRestore(); const preview = els.backupInfluxDbRestorePreview.innerText;
        step = 'start'; await startBackupInfluxDbRestore(new Event('submit', { cancelable: true }));
        return { summary, action, preview, status: els.backupInfluxDbRestoreStatus.innerText, payload: window.__coreRestorePayload };
      } catch (error) { throw new Error(step + ': ' + (error.stack || error.message)); }
    })()`);

    const verification = await window.webContents.executeJavaScript(`(async () => {
      closeBackupInfluxDbRestore(); await openBackupInfluxDbVerification(); await startBackupInfluxDbVerification(new Event('submit', { cancelable: true })); const metadataStatus = els.backupInfluxDbVerificationStatus.innerText;
      closeBackupInfluxDbVerification(); await openBackupInfluxDbVerification(); els.backupInfluxDbVerificationForm.querySelector('input[value="influxdb3-core-full-drill"]').checked = true; syncBackupInfluxDbVerificationMode(); await startBackupInfluxDbVerification(new Event('submit', { cancelable: true }));
      return { metadataStatus, drillStatus: els.backupInfluxDbVerificationStatus.innerText, payloads: window.__coreVerificationPayloads };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      closeBackupInfluxDbVerification(); await loadBackupActivity(); const tests = els.backupTestList.innerText;
      await openBackupActivityDetail('restore', 'restore-core'); const restore = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'core-verification-2'); const drill = els.backupActivityDetailMetrics.innerText; closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'core-verification-1'); return { rows: els.backupActivityList.innerText, tests, restore, drill, metadata: els.backupActivityDetailMetrics.innerText };
    })()`);

    const desktop = await window.webContents.executeJavaScript(`(() => { const card = els.backupActivityDetailModal.querySelector('.modal-card').getBoundingClientRect(); const ids = [...document.querySelectorAll('[id]')].map((node) => node.id); return { width: innerWidth, height: innerHeight, card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, duplicateIds: ids.length - new Set(ids).size }; })()`);
    window.webContents.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: 390, height: 844 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 }); await new Promise((resolve) => setTimeout(resolve, 250));
    const mobile = await window.webContents.executeJavaScript(`(async () => { const bounds = (modal) => { const card = modal.querySelector('.modal-card').getBoundingClientRect(); return { left: card.left, right: card.right, top: card.top, bottom: card.bottom }; }; closeBackupActivityDetail(); await openBackupInfluxDbRestore(); const restore = bounds(els.backupInfluxDbRestoreModal); closeBackupInfluxDbRestore(); await openBackupInfluxDbVerification(); const verification = bounds(els.backupInfluxDbVerificationModal); closeBackupInfluxDbVerification(); openBackupInfluxDb3CoreModal(); els.backupInfluxDb3CoreObjectStore.value = 's3'; syncBackupInfluxDb3CoreObjectStore(); els.backupInfluxDb3CoreSelection.classList.remove('hidden'); const source = bounds(els.backupInfluxDb3CoreModal); const body = els.backupInfluxDb3CoreModal.querySelector('.modal-body'); els.toast.classList.remove('visible'); els.toast.style.display = 'none'; return { source, restore, verification, sourceScrollable: body.scrollHeight > body.clientHeight, s3FieldsVisible: !els.backupInfluxDb3CoreS3Fields.classList.contains('hidden'), connectionFieldsHidden: els.backupInfluxDb3CoreConnectionFields.classList.contains('hidden'), width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const screenshotPath = path.join(captureRoot, 'influxdb3-core-s3-source-mobile.png'); await fs.writeFile(screenshotPath, (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG());

    const contained = (box, viewport) => box.left >= 0 && box.right <= viewport.width && box.top >= 0 && box.bottom <= viewport.height;
    const publicEvidence = JSON.stringify({ recovery, verification, activity });
    const valid = source.connectionCount === 2 && source.modalClosed && !source.credentialsRedisplayed && source.createPayload?.protocol === 'http' && source.createPayload?.allowInsecureHttp === true && source.createPayload?.objectStore === 's3' && source.createPayload?.objectStoreEndpoint === 'http://private-objects.example.com' && source.createPayload?.objectStoreRegion === 'us-east-1' && source.createPayload?.objectStoreBucket === 'private-core-source-bucket' && source.createPayload?.objectStorePrefix === 'production' && source.createPayload?.objectStoreForcePathStyle === true && source.createPayload?.allowInsecureObjectStoreEndpoint === true && source.createPayload?.objectStoreTimeoutMs === 30000 && source.createPayload?.accessKeyId === 'PRIVATE_ACCESS_KEY' && source.createPayload?.secretAccessKey === 'PRIVATE_SECRET_KEY' && source.createPayload?.sessionToken === 'PRIVATE_SESSION_TOKEN' && source.createPayload?.confirmationText === 'BIND INFLUXDB CORE S3'
      && source.payload?.selector?.allDatabases === true && source.payload?.selector?.databases?.include?.length === 0 && source.payload?.consistency?.method === 'influxdb3-core-ordered-copy' && source.payload?.consistency?.requestedLevel === 'crash' && source.payload?.consistency?.backupMode === 'full' && source.payload?.physicalExecution?.confirmationText === 'ACCEPT CRASH CONSISTENCY'
      && source.evidence.includes('5 objects') && source.evidence.includes('7 directories') && source.evidence.includes('S3 identity authenticated') && source.evidence.includes('table snapshots excluded')
      && job.sourceDetail.includes('InfluxDB 3 Core node-a') && job.sourceDetail.includes('S3 full backup') && job.fullLabel.includes('Core S3 recovery point') && job.fullChecked && job.incrementalDisabled && job.incrementalTitle.includes('S3 protection') && job.incrementalTitle.includes('full recovery points only')
      && recovery.summary.includes('InfluxDB 3 Core 3.0.3') && recovery.summary.includes('operator review and manual startup required') && recovery.summary.includes('create-only writes preserve partial target objects') && recovery.action.includes('Recover stopped Core target')
      && recovery.preview.includes('5 objects / 7 directories') && recovery.preview.includes('Stopped, unreachable, exact node prefix empty') && recovery.preview.includes('Conditional create-only writes') && recovery.preview.includes('Manual after operator review') && recovery.preview.includes('Partial target objects preserved') && recovery.status.includes('complete operator review before manual startup') && recovery.payload?.confirmationText === 'RESTORE INFLUXDB3 CORE ALTERNATE'
      && verification.metadataStatus.includes('5 objects and 7 directories authenticated') && verification.metadataStatus.includes('consistency proof match') && verification.drillStatus.includes('stopped target is preserved') && verification.drillStatus.includes('operator review and manual startup remain required') && verification.payloads[0]?.mode === 'influxdb3-core-metadata' && verification.payloads[1]?.confirmationText === 'RUN INFLUXDB3 CORE RECOVERY DRILL'
      && activity.rows.includes('InfluxDB 3 Core S3 restore') && activity.rows.includes('InfluxDB 3 Core S3 media and source validation') && activity.rows.includes('InfluxDB 3 Core stopped-target S3 drill')
      && activity.tests.includes('5 objects / 7 directories') && activity.tests.includes('source, storage, and consistency proof matched') && activity.tests.includes('stopped target preserved') && activity.restore.includes('Operator review') && activity.restore.includes('Required before startup')
      && activity.drill.includes('Full stopped-target InfluxDB 3 Core S3 drill') && activity.drill.includes('S3 objects') && activity.drill.includes('Automatic startup') && activity.metadata.includes('Storage identity') && activity.metadata.includes('Full restore')
      && !publicEvidence.includes('private-core') && !publicEvidence.includes('private-objects') && !publicEvidence.includes('PRIVATE_') && !publicEvidence.includes('objectStoreEndpoint') && !publicEvidence.includes('objectStoreBucket') && !publicEvidence.includes('objectStorePrefix') && !publicEvidence.includes('accessKeyId') && !publicEvidence.includes('secretAccessKey') && !publicEvidence.includes('sessionToken') && !publicEvidence.includes('memberPath') && !publicEvidence.includes('stagePath') && !publicEvidence.includes('repositoryPath')
      && desktop.duplicateIds === 0 && !desktop.overflow && contained(desktop.card, desktop) && mobile.width <= 390 && !mobile.overflow && mobile.sourceScrollable && mobile.s3FieldsVisible && !mobile.connectionFieldsHidden && contained(mobile.source, mobile) && contained(mobile.restore, mobile) && contained(mobile.verification, mobile);
    process.stdout.write(`${JSON.stringify({ ok: valid, source, job, recovery, verification, activity, desktop, mobile, screenshotPath })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1;
  } finally {
    window.destroy(); app.exit(process.exitCode || 0);
  }
});
