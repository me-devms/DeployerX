const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    backgroundColor: '#f7f8fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
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
      loadBackupActivity = async () => {};

      window.__legacyPrivate = {
        dataRoot: 'C:\\\\private\\\\enterprise-legacy-target',
        host: 'legacy-private.internal.example',
        sshConnectionId: 'ssh-private-compactor',
        systemdUnit: 'influxdb3-enterprise-private.service',
        credential: 'PRIVATE_LEGACY_PASSWORD'
      };
      window.__legacyTarget = {
        kind: 'local-filesystem',
        dataRoot: window.__legacyPrivate.dataRoot,
        clusterId: 'cluster-legacy-production',
        compactorNodeId: 'compactor-01',
        dataNodeIds: ['data-01', 'data-02']
      };
      window.__legacyPoint = {
        id: 'point-enterprise-legacy',
        jobName: 'Enterprise legacy protection',
        sourceId: 'source-enterprise-legacy',
        sourceName: 'Production Enterprise legacy cluster',
        sourceConnectionId: 'connection-enterprise-source',
        sourceType: 'database',
        sourceAdapterId: 'deployerx.database.influxdb3-enterprise',
        backupMethod: 'physical',
        type: 'full',
        consistency: 'application',
        capturedTo: '2026-08-05T02:00:00.000Z',
        influxdb3Enterprise: {
          tier: 'legacy-filesystem',
          productVersion: '3.5.0',
          storageEngine: 'legacy-parquet',
          clusterId: 'cluster-legacy-production',
          compactorNodeId: 'compactor-01',
          dataNodeIds: ['data-01', 'data-02'],
          consistencyMode: 'stopped',
          fileCount: 16,
          directoryCount: 21,
          totalBytes: 24576,
          completeMediaAuthenticated: true,
          restoreSupported: true,
          metadata: {
            source: { productVersion: '3.5.0', storageEngine: 'legacy-parquet', clusterId: 'cluster-legacy-production', compactorNodeId: 'compactor-01', dataNodeIds: ['data-01', 'data-02'] },
            nativeMedia: { fileCount: 16, directoryCount: 21, totalBytes: 24576 },
            capture: { completeMediaAuthenticated: true, achievedConsistency: 'application' }
          }
        },
        retention: { deletionEligible: false },
        verification: { state: 'succeeded' },
        availableCopyCount: 1,
        totalCopyCount: 1,
        repositoryCopies: [{ repositoryId: 'repo-primary', state: 'available' }]
      };
      window.__legacyConnections = [{
        id: 'connection-enterprise-target',
        name: 'Isolated legacy recovery cluster',
        currentDevice: true,
        adapterId: 'deployerx.database.influxdb3-enterprise',
        endpoint: { host: window.__legacyPrivate.host, port: 8181 },
        lastTest: {
          status: 'success',
          testedAt: '2026-08-05T02:30:00.000Z',
          endpointIdentity: {
            product: 'influxdb3-enterprise', version: '3.5.0', storageEngine: 'legacy-parquet', legacyParquetEngine: true,
            nativeBackupAvailable: false, compactorCapable: true, clusterId: 'cluster-legacy-production', nodeId: 'compactor-01',
            deploymentFingerprint: 'sha256:' + '1'.repeat(64), capabilityFingerprint: 'sha256:' + '2'.repeat(64)
          }
        }
      }];
      window.__legacyBindings = [{
        id: 'binding-enterprise-target',
        name: 'Production legacy stop proof',
        revision: 1,
        currentDevice: true,
        targetConnectionId: 'connection-enterprise-target',
        clusterId: 'cluster-legacy-production',
        targetNodeId: 'compactor-01',
        nodes: [
          { nodeId: 'compactor-01', sshConnectionId: window.__legacyPrivate.sshConnectionId, systemdUnit: window.__legacyPrivate.systemdUnit },
          { nodeId: 'data-01', sshConnectionId: 'ssh-private-data-01', systemdUnit: window.__legacyPrivate.systemdUnit },
          { nodeId: 'data-02', sshConnectionId: 'ssh-private-data-02', systemdUnit: window.__legacyPrivate.systemdUnit }
        ]
      }];
      window.__legacyRestorePayload = null;
      window.__legacyVerificationPayloads = [];
      window.__legacyPlan = {
        mode: 'alternate', recoveryPointId: 'point-enterprise-legacy', targetConnectionId: 'connection-enterprise-target', engine: 'influxdb3-enterprise', tier: 'legacy-filesystem',
        consistency: 'application', clusterId: 'cluster-legacy-production', compactorNodeId: 'compactor-01', dataNodeIds: ['data-01', 'data-02'],
        fileCount: 16, directoryCount: 21, totalBytes: 24576, completeMediaAuthenticated: true, targetEmpty: true, targetStopped: true,
        clusterStopEvidence: { version: 1, checkCount: 1, firstIssuedAt: '2026-08-05T03:00:00.000Z', lastIssuedAt: '2026-08-05T03:00:00.000Z', finalProofDigest: 'hmac-sha256:' + '3'.repeat(64), nodeCount: 3, nodeSetDigest: 'sha256:' + '4'.repeat(64), proofChainDigest: 'sha256:' + '5'.repeat(64) },
        separateAlternateStorage: true, originalStorageProtected: true, partialTargetPreservedOnFailure: true, rollbackAvailable: false,
        automaticStartup: false, ownershipReviewRequired: true, licenseReviewRequired: true,
        confirmationText: 'RESTORE INFLUXDB3 ENTERPRISE LEGACY ALTERNATE', warnings: [], planDigest: 'sha256:' + '6'.repeat(64)
      };
      window.__legacyRestoreInterrupted = {
        id: 'legacy-restore-interrupted', state: 'interrupted', mode: 'alternate', recoveryPointIds: ['point-enterprise-legacy'],
        target: { engine: 'influxdb3-enterprise', tier: 'legacy-filesystem', mode: 'alternate', targetConnectionId: 'connection-enterprise-target', targetMutationStarted: true, filesystemMutationStarted: true },
        progress: { phase: 'operator-action-required', itemsTotal: 16, itemsCompleted: 8, bytesTotal: 24576, bytesWritten: 12288 },
        result: {
          error: { code: 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_REQUIRES_INSPECTION', category: 'restore', retryable: false, safeMessage: 'Authenticated cluster stop proof was lost after filesystem mutation. The partial alternate target is preserved for inspection and no rollback is claimed.' },
          targetPreserved: true, partialTargetPreserved: true, targetDeletionAttempted: false, rollbackClaimed: false, stagingCleanupProven: true
        }
      };
      const metadataVerification = (id) => ({
        id, state: 'succeeded', mode: 'influxdb3-enterprise-legacy-metadata', recoveryPointId: 'point-enterprise-legacy',
        evidence: { verificationClass: 'influxdb3-enterprise-legacy-metadata', repositoryManifestAuthenticated: true, metadataArtifactAuthenticated: true, completeMediaAuthenticated: true, fullRestorePerformed: false, consistency: 'application', clusterId: 'cluster-legacy-production', nativeFileCount: 16, nativeDirectoryCount: 21, sizeBytes: 24576 },
        result: { state: 'succeeded', mode: 'influxdb3-enterprise-legacy-metadata', recoveryPointId: 'point-enterprise-legacy', targetPreserved: false }
      });
      const interruptedDrill = (id) => ({
        id, state: 'interrupted', mode: 'influxdb3-enterprise-legacy-full-drill', recoveryPointId: 'point-enterprise-legacy', restoreRunId: 'legacy-restore-interrupted',
        progress: { phase: 'operator-action-required' },
        result: {
          state: 'interrupted', recoveryPointId: 'point-enterprise-legacy', restoreRunId: 'legacy-restore-interrupted', targetPreserved: true,
          targetCleanupAttempted: false, rollbackPerformed: false,
          error: { code: 'INFLUXDB3_ENTERPRISE_LEGACY_DRILL_TARGET_REQUIRES_INSPECTION', category: 'verification', retryable: false, safeMessage: 'Fresh cluster stop proof was lost after target mutation. The isolated stopped target is preserved for inspection; no cleanup or rollback is claimed.' }
        }
      });

      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupInfluxDb3EnterpriseConnections: async () => structuredClone(window.__legacyConnections),
        listBackupInfluxDb3EnterpriseLegacyStopBindings: async () => structuredClone(window.__legacyBindings),
        listBackupInfluxDb3EnterpriseLegacyRestoreRuns: async () => [],
        previewBackupInfluxDb3EnterpriseLegacyRestore: async (payload) => {
          window.__legacyRestorePreviewPayload = structuredClone(payload);
          return structuredClone(window.__legacyPlan);
        },
        startBackupInfluxDb3EnterpriseLegacyRestore: async (payload) => {
          window.__legacyRestorePayload = structuredClone(payload);
          return { id: 'legacy-restore-interrupted', state: 'queued', target: { engine: 'influxdb3-enterprise', tier: 'legacy-filesystem', mode: 'alternate' } };
        },
        waitBackupInfluxDb3EnterpriseLegacyRestore: async () => structuredClone(window.__legacyRestoreInterrupted),
        cancelBackupInfluxDb3EnterpriseLegacyRestore: async () => structuredClone(window.__legacyRestoreInterrupted),
        listBackupInfluxDb3EnterpriseLegacyVerificationRuns: async () => [],
        startBackupInfluxDb3EnterpriseLegacyVerification: async (payload) => {
          window.__legacyVerificationPayloads.push(structuredClone(payload));
          return { id: 'legacy-verification-' + window.__legacyVerificationPayloads.length, state: 'queued', mode: payload.mode };
        },
        waitBackupInfluxDb3EnterpriseLegacyVerification: async (id) => {
          const payload = window.__legacyVerificationPayloads[Number(id.split('-').pop()) - 1];
          return structuredClone(payload.mode.endsWith('full-drill') ? interruptedDrill(id) : metadataVerification(id));
        },
        cancelBackupInfluxDb3EnterpriseLegacyVerification: async (id) => interruptedDrill(id)
      }});
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [structuredClone(window.__legacyPoint)];
      state.backupRecovery.totalPoints = 1;
      state.backupRecovery.selectedPointId = 'point-enterprise-legacy';
      true;
    `);

    const projection = await window.webContents.executeJavaScript(`(() => {
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      return { points: els.backupRecoveryPointList.innerText, entry: els.backupRecoveryEntryList.innerText, action: els.backupRecoveryRestoreButton.innerText };
    })()`);

    const restore = await window.webContents.executeJavaScript(`(async () => {
      await openBackupInfluxDb3EnterpriseLegacyRestore();
      els.backupInfluxDb3EnterpriseLegacyRestoreDataRoot.value = window.__legacyPrivate.dataRoot;
      await previewBackupInfluxDb3EnterpriseLegacyRestore();
      const summary = els.backupInfluxDb3EnterpriseLegacyRestoreSummary.innerText;
      const preview = els.backupInfluxDb3EnterpriseLegacyRestorePreview.innerText;
      const targetOptions = els.backupInfluxDb3EnterpriseLegacyRestoreTarget.innerText;
      await startBackupInfluxDb3EnterpriseLegacyRestore(new Event('submit', { cancelable: true }));
      const payload = window.__legacyRestorePayload;
      return {
        summary, preview, targetOptions,
        status: els.backupInfluxDb3EnterpriseLegacyRestoreStatus.innerText,
        error: els.backupInfluxDb3EnterpriseLegacyRestoreError.innerText,
        payloadValid: payload?.recoveryPointId === 'point-enterprise-legacy'
          && payload?.targetConnectionId === 'connection-enterprise-target'
          && payload?.target?.kind === 'local-filesystem'
          && payload?.target?.dataRoot === window.__legacyPrivate.dataRoot
          && payload?.target?.clusterId === 'cluster-legacy-production'
          && payload?.target?.compactorNodeId === 'compactor-01'
          && JSON.stringify(payload?.target?.dataNodeIds) === JSON.stringify(['data-01', 'data-02'])
          && payload?.mode === 'alternate'
          && payload?.confirmed === true
          && payload?.confirmationText === 'RESTORE LEGACY INFLUXDB 3 ENTERPRISE TO EMPTY ALTERNATE STORAGE'
      };
    })()`);

    const verification = await window.webContents.executeJavaScript(`(async () => {
      closeBackupInfluxDb3EnterpriseLegacyRestore();
      await openBackupInfluxDb3EnterpriseLegacyVerification();
      await startBackupInfluxDb3EnterpriseLegacyVerification(new Event('submit', { cancelable: true }));
      const metadataStatus = els.backupInfluxDb3EnterpriseLegacyVerificationStatus.innerText;
      closeBackupInfluxDb3EnterpriseLegacyVerification();
      await openBackupInfluxDb3EnterpriseLegacyVerification();
      const drillMode = els.backupInfluxDb3EnterpriseLegacyVerificationForm.querySelector('input[value="influxdb3-enterprise-legacy-full-drill"]');
      drillMode.checked = true;
      els.backupInfluxDb3EnterpriseLegacyVerificationDataRoot.value = window.__legacyPrivate.dataRoot;
      syncBackupInfluxDb3EnterpriseLegacyVerificationMode();
      await startBackupInfluxDb3EnterpriseLegacyVerification(new Event('submit', { cancelable: true }));
      const payloads = window.__legacyVerificationPayloads;
      const drillPayload = payloads[1];
      return {
        metadataStatus,
        drillStatus: els.backupInfluxDb3EnterpriseLegacyVerificationStatus.innerText,
        drillError: els.backupInfluxDb3EnterpriseLegacyVerificationError.innerText,
        modesValid: payloads[0]?.mode === 'influxdb3-enterprise-legacy-metadata' && drillPayload?.mode === 'influxdb3-enterprise-legacy-full-drill',
        drillPayloadValid: drillPayload?.targetConnectionId === 'connection-enterprise-target'
          && drillPayload?.target?.dataRoot === window.__legacyPrivate.dataRoot
          && drillPayload?.target?.clusterId === 'cluster-legacy-production'
          && drillPayload?.confirmed === true
          && drillPayload?.confirmationText === 'RUN INFLUXDB3 ENTERPRISE LEGACY RECOVERY DRILL'
      };
    })()`);

    const desktop = await window.webContents.executeJavaScript(`(() => {
      const bounds = (modal) => { const card = modal.querySelector('.modal-card').getBoundingClientRect(); return { left: card.left, right: card.right, top: card.top, bottom: card.bottom }; };
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
      return { width: innerWidth, height: innerHeight, verification: bounds(els.backupInfluxDb3EnterpriseLegacyVerificationModal), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, duplicateIds: ids.length - new Set(ids).size };
    })()`);

    window.webContents.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: 390, height: 844 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const mobile = await window.webContents.executeJavaScript(`(async () => {
      const bounds = (modal) => { const card = modal.querySelector('.modal-card').getBoundingClientRect(); return { left: card.left, right: card.right, top: card.top, bottom: card.bottom }; };
      closeBackupInfluxDb3EnterpriseLegacyVerification();
      await openBackupInfluxDb3EnterpriseLegacyRestore();
      els.backupInfluxDb3EnterpriseLegacyRestoreDataRoot.value = window.__legacyPrivate.dataRoot;
      await previewBackupInfluxDb3EnterpriseLegacyRestore();
      const restore = bounds(els.backupInfluxDb3EnterpriseLegacyRestoreModal);
      const restoreBody = els.backupInfluxDb3EnterpriseLegacyRestoreModal.querySelector('.modal-body');
      closeBackupInfluxDb3EnterpriseLegacyRestore();
      await openBackupInfluxDb3EnterpriseLegacyVerification();
      const drillMode = els.backupInfluxDb3EnterpriseLegacyVerificationForm.querySelector('input[value="influxdb3-enterprise-legacy-full-drill"]');
      drillMode.checked = true;
      els.backupInfluxDb3EnterpriseLegacyVerificationDataRoot.value = window.__legacyPrivate.dataRoot;
      syncBackupInfluxDb3EnterpriseLegacyVerificationMode();
      const verification = bounds(els.backupInfluxDb3EnterpriseLegacyVerificationModal);
      const verificationBody = els.backupInfluxDb3EnterpriseLegacyVerificationModal.querySelector('.modal-body');
      els.toast.classList.remove('visible'); els.toast.style.display = 'none';
      return {
        width: innerWidth, height: innerHeight, restore, verification,
        restoreScrollable: restoreBody.scrollHeight > restoreBody.clientHeight,
        verificationScrollable: verificationBody.scrollHeight > verificationBody.clientHeight,
        restoreOverflowY: getComputedStyle(restoreBody).overflowY,
        verificationOverflowY: getComputedStyle(verificationBody).overflowY,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);

    const contained = (box, viewport) => box.left >= 0 && box.right <= viewport.width && box.top >= 0 && box.bottom <= viewport.height;
    const publicEvidence = JSON.stringify({ projection, restore: { summary: restore.summary, preview: restore.preview, targetOptions: restore.targetOptions, status: restore.status, error: restore.error }, verification: { metadataStatus: verification.metadataStatus, drillStatus: verification.drillStatus, drillError: verification.drillError } });
    const redacted = !publicEvidence.includes('C:\\\\private')
      && !publicEvidence.includes('legacy-private.internal.example')
      && !publicEvidence.includes('PRIVATE_LEGACY_PASSWORD')
      && !publicEvidence.includes('ssh-private')
      && !publicEvidence.includes('influxdb3-enterprise-private.service')
      && !publicEvidence.includes('dataRoot')
      && !publicEvidence.includes('repositoryPath')
      && !publicEvidence.includes('stagePath')
      && !publicEvidence.includes('proofDigest');
    const valid = projection.points.includes('Enterprise legacy filesystem')
      && projection.entry.includes('legacy')
      && projection.entry.includes('Separate legacy recovery boundary')
      && projection.action.includes('Recover stopped legacy cluster')
      && restore.summary.includes('cluster-legacy-production')
      && restore.targetOptions.includes('Isolated legacy recovery cluster')
      && restore.preview.includes('16 files / 21 directories')
      && restore.preview.includes('3 nodes')
      && restore.preview.toLowerCase().includes('stopped')
      && restore.preview.includes('Separate alternate storage')
      && restore.preview.includes('Unavailable')
      && restore.payloadValid
      && restore.error.includes('stop proof was lost after filesystem mutation')
      && restore.error.includes('preserved for inspection')
      && restore.error.includes('no rollback is claimed')
      && verification.metadataStatus.includes('16 files and 21 directories authenticated')
      && verification.metadataStatus.includes('complete media')
      && verification.modesValid
      && verification.drillPayloadValid
      && verification.drillError.includes('stop proof was lost after target mutation')
      && verification.drillError.includes('preserved for inspection')
      && verification.drillError.includes('no cleanup or rollback is claimed')
      && redacted
      && desktop.duplicateIds === 0
      && !desktop.overflow
      && contained(desktop.verification, desktop)
      && mobile.width <= 390
      && !mobile.overflow
      && ['auto', 'scroll'].includes(mobile.restoreOverflowY)
      && ['auto', 'scroll'].includes(mobile.verificationOverflowY)
      && contained(mobile.restore, mobile)
      && contained(mobile.verification, mobile);
    process.stdout.write(`${JSON.stringify({ ok: valid, projection, restore: { ...restore, payloadValid: restore.payloadValid }, verification, desktop, mobile, redacted })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode || 0);
  }
});
