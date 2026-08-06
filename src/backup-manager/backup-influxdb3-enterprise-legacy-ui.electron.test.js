const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

const REQUIRED_RENDERER_HOOKS = Object.freeze([
  'openBackupInfluxDb3EnterpriseLegacyStopBinding',
  'openBackupInfluxDb3EnterpriseLegacyRestore',
  'previewBackupInfluxDb3EnterpriseLegacyRestore',
  'startBackupInfluxDb3EnterpriseLegacyRestore',
  'openBackupInfluxDb3EnterpriseLegacyVerification',
  'startBackupInfluxDb3EnterpriseLegacyVerification',
  'syncBackupInfluxDb3EnterpriseLegacyVerificationMode',
  'renderBackupActivity',
  'openBackupActivityDetail'
]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function contained(box, viewport) {
  return box.left >= 0 && box.right <= viewport.width && box.top >= 0 && box.bottom <= viewport.height;
}

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
    await wait(200);
    await window.webContents.executeJavaScript(`
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.getElementById('setupModal')?.classList.add('hidden');
      confirmDangerousAction = async () => true;

      window.__legacyPrivate = {
        dataRoot: 'C:\\\\private\\\\enterprise-legacy-target',
        host: 'legacy-private.internal.example',
        sshConnectionId: 'ssh-private-compactor',
        systemdUnit: 'influxdb3-enterprise-private.service',
        credential: 'PRIVATE_LEGACY_PASSWORD',
        proofDigest: 'hmac-sha256:' + 'a'.repeat(64),
        repositoryPath: 'C:\\\\private\\\\enterprise-legacy-repository',
        stagePath: 'C:\\\\private\\\\enterprise-legacy-stage'
      };
      window.__legacyBindingPayload = null;
      window.__legacyRestorePreviewPayload = null;
      window.__legacyRestorePayload = null;
      window.__legacyVerificationPayloads = [];
      window.__legacyApiCalls = [];
      window.__unexpectedRestoreOrVerificationApiCalls = [];
      window.__legacyBindings = [];
      window.__legacyConnections = [{
        id: 'connection-enterprise-target', name: 'Isolated legacy recovery cluster', currentDevice: true,
        adapterId: 'deployerx.database.influxdb3-enterprise', adapterVersion: '1.0.0', revision: 1,
        lastTest: { status: 'success', adapterId: 'deployerx.database.influxdb3-enterprise', adapterVersion: '1.0.0', testedAt: '2026-08-05T02:30:00.000Z', endpointIdentity: {
          product: 'influxdb3-enterprise', version: '3.5.0', storageEngine: 'legacy-parquet', legacyParquetEngine: true,
          nativeBackupAvailable: false, compactorCapable: true, clusterId: 'cluster-legacy-production', nodeId: 'compactor-01'
        }}
      }];
      window.__legacySshConnections = ['compactor-01', 'data-01', 'data-02'].map((nodeId) => ({
        id: nodeId === 'compactor-01' ? window.__legacyPrivate.sshConnectionId : 'ssh-private-' + nodeId,
        name: nodeId + ' stop transport', currentDevice: true, adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0', revision: 1,
        lastTest: { status: 'success', adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0', testedAt: '2026-08-05T02:30:00.000Z' }
      }));
      window.__legacyPoint = {
        id: 'point-enterprise-legacy', jobName: 'Enterprise legacy protection', sourceId: 'source-enterprise-legacy',
        sourceName: 'Production Enterprise legacy cluster', sourceConnectionId: 'connection-enterprise-source', sourceType: 'database',
        sourceAdapterId: 'deployerx.database.influxdb3-enterprise', backupMethod: 'physical', type: 'full', consistency: 'application',
        capturedTo: '2026-08-05T02:00:00.000Z', retention: { deletionEligible: false }, verification: { state: 'succeeded' },
        availableCopyCount: 1, totalCopyCount: 1, repositoryCopies: [{ repositoryId: 'repo-primary', state: 'available' }],
        influxdb3Enterprise: {
          tier: 'legacy-filesystem', productVersion: '3.5.0', storageEngine: 'legacy-parquet', clusterId: 'cluster-legacy-production',
          compactorNodeId: 'compactor-01', dataNodeIds: ['data-01', 'data-02'], consistencyMode: 'stopped', fileCount: 16,
          directoryCount: 21, totalBytes: 24576, completeMediaAuthenticated: true, restoreSupported: true,
          metadata: { capture: { completeMediaAuthenticated: true, achievedConsistency: 'application' } }
        }
      };
      window.__legacyPlan = {
        mode: 'alternate', recoveryPointId: 'point-enterprise-legacy', targetConnectionId: 'connection-enterprise-target', engine: 'influxdb3-enterprise',
        tier: 'legacy-filesystem', consistency: 'application', clusterId: 'cluster-legacy-production', compactorNodeId: 'compactor-01',
        dataNodeIds: ['data-01', 'data-02'], fileCount: 16, directoryCount: 21, totalBytes: 24576, completeMediaAuthenticated: true,
        targetEmpty: true, targetStopped: true, separateAlternateStorage: true, originalStorageProtected: true,
        partialTargetPreservedOnFailure: true, rollbackAvailable: false, automaticStartup: false, ownershipReviewRequired: true,
        licenseReviewRequired: true, confirmationText: 'RESTORE LEGACY INFLUXDB 3 ENTERPRISE TO EMPTY ALTERNATE STORAGE'
      };
      window.__legacyTarget = {
        kind: 'local-filesystem', dataRoot: window.__legacyPrivate.dataRoot, clusterId: 'cluster-legacy-production',
        compactorNodeId: 'compactor-01', dataNodeIds: ['data-01', 'data-02']
      };
      window.__legacyRestoreInterrupted = {
        id: 'legacy-restore-interrupted', state: 'interrupted', mode: 'alternate', recoveryPointIds: ['point-enterprise-legacy'],
        createdAt: '2026-08-05T03:00:00.000Z', startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:20.000Z',
        target: { engine: 'influxdb3-enterprise', tier: 'legacy-filesystem', mode: 'alternate', targetConnectionId: 'connection-enterprise-target', targetMutationStarted: true, filesystemMutationStarted: true },
        progress: { phase: 'operator-action-required', itemsTotal: 16, itemsCompleted: 8, bytesTotal: 24576, bytesWritten: 12288 },
        result: { targetPreserved: true, partialTargetPreserved: true, targetDeletionAttempted: false, rollbackClaimed: false,
          error: { safeMessage: 'Authenticated cluster stop proof was lost after filesystem mutation. The partial alternate target is preserved for inspection and no rollback is claimed.' } }
      };
      const metadata = (id) => ({
        id, state: 'succeeded', mode: 'influxdb3-enterprise-legacy-metadata', recoveryPointId: 'point-enterprise-legacy',
        createdAt: '2026-08-05T03:10:00.000Z', updatedAt: '2026-08-05T03:10:05.000Z',
        evidence: { verificationClass: 'influxdb3-enterprise-legacy-metadata', repositoryManifestAuthenticated: true, metadataArtifactAuthenticated: true,
          completeMediaAuthenticated: true, fullRestorePerformed: false, consistency: 'application', clusterId: 'cluster-legacy-production', nativeFileCount: 16, nativeDirectoryCount: 21, sizeBytes: 24576 },
        result: { state: 'succeeded', targetPreserved: false }
      });
      const drill = (id) => ({
        id, state: 'interrupted', mode: 'influxdb3-enterprise-legacy-full-drill', recoveryPointId: 'point-enterprise-legacy', restoreRunId: 'legacy-restore-interrupted',
        createdAt: '2026-08-05T03:15:00.000Z', updatedAt: '2026-08-05T03:15:30.000Z', progress: { phase: 'operator-action-required' },
        evidence: { clusterId: 'cluster-legacy-production', nativeFileCount: 16, nativeDirectoryCount: 21, targetStopped: true, targetPreserved: true, rollbackClaimed: false },
        result: { targetPreserved: true, targetCleanupAttempted: false, rollbackPerformed: false,
          error: { safeMessage: 'Fresh cluster stop proof was lost after target mutation. The isolated stopped target is preserved for inspection; no cleanup or rollback is claimed.' } }
      });
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listBackupInfluxDb3EnterpriseConnections: async () => structuredClone(window.__legacyConnections),
        listBackupSshConnections: async () => structuredClone(window.__legacySshConnections),
        listBackupInfluxDb3EnterpriseLegacyStopBindings: async () => structuredClone(window.__legacyBindings),
        createBackupInfluxDb3EnterpriseLegacyStopBinding: async (payload) => {
          window.__legacyBindingPayload = structuredClone(payload);
          const binding = { id: 'binding-enterprise-target', revision: 1, name: payload.name, currentDevice: true,
            targetConnectionId: payload.targetConnectionId, clusterId: payload.clusterId, targetNodeId: 'compactor-01', nodes: payload.nodes };
          window.__legacyBindings = [binding]; return structuredClone(binding);
        },
        previewBackupInfluxDb3EnterpriseLegacyRestore: async (payload) => { window.__legacyApiCalls.push('preview-restore'); window.__legacyRestorePreviewPayload = structuredClone(payload); return structuredClone(window.__legacyPlan); },
        listBackupInfluxDb3EnterpriseLegacyRestoreRuns: async () => { window.__legacyApiCalls.push('list-restores'); return [structuredClone(window.__legacyRestoreInterrupted)]; },
        startBackupInfluxDb3EnterpriseLegacyRestore: async (payload) => { window.__legacyApiCalls.push('start-restore'); window.__legacyRestorePayload = structuredClone(payload); return { id: 'legacy-restore-interrupted', state: 'queued' }; },
        waitBackupInfluxDb3EnterpriseLegacyRestore: async () => { window.__legacyApiCalls.push('wait-restore'); return structuredClone(window.__legacyRestoreInterrupted); },
        cancelBackupInfluxDb3EnterpriseLegacyRestore: async () => { window.__legacyApiCalls.push('cancel-restore'); return structuredClone(window.__legacyRestoreInterrupted); },
        listBackupInfluxDb3EnterpriseLegacyVerificationRuns: async () => { window.__legacyApiCalls.push('list-verifications'); return [metadata('legacy-verification-1'), drill('legacy-verification-2')]; },
        startBackupInfluxDb3EnterpriseLegacyVerification: async (payload) => { window.__legacyApiCalls.push('start-verification'); window.__legacyVerificationPayloads.push(structuredClone(payload)); return { id: 'legacy-verification-' + window.__legacyVerificationPayloads.length, state: 'queued', mode: payload.mode }; },
        waitBackupInfluxDb3EnterpriseLegacyVerification: async (id) => { window.__legacyApiCalls.push('wait-verification'); return structuredClone(id.endsWith('-2') ? drill(id) : metadata(id)); },
        cancelBackupInfluxDb3EnterpriseLegacyVerification: async (id) => { window.__legacyApiCalls.push('cancel-verification'); return structuredClone(drill(id)); },
        previewBackupInfluxDbRestore: async () => { window.__unexpectedRestoreOrVerificationApiCalls.push('previewBackupInfluxDbRestore'); throw new Error('Generic InfluxDB restore API must not receive legacy Enterprise requests.'); },
        startBackupInfluxDbRestore: async () => { window.__unexpectedRestoreOrVerificationApiCalls.push('startBackupInfluxDbRestore'); throw new Error('Generic InfluxDB restore API must not receive legacy Enterprise requests.'); },
        previewBackupInfluxDb3CoreRestore: async () => { window.__unexpectedRestoreOrVerificationApiCalls.push('previewBackupInfluxDb3CoreRestore'); throw new Error('Core restore API must not receive legacy Enterprise requests.'); },
        startBackupInfluxDb3CoreRestore: async () => { window.__unexpectedRestoreOrVerificationApiCalls.push('startBackupInfluxDb3CoreRestore'); throw new Error('Core restore API must not receive legacy Enterprise requests.'); },
        previewBackupInfluxDb3EnterpriseRestore: async () => { window.__unexpectedRestoreOrVerificationApiCalls.push('previewBackupInfluxDb3EnterpriseRestore'); throw new Error('Native Enterprise restore API must not receive legacy Enterprise requests.'); },
        startBackupInfluxDb3EnterpriseRestore: async () => { window.__unexpectedRestoreOrVerificationApiCalls.push('startBackupInfluxDb3EnterpriseRestore'); throw new Error('Native Enterprise restore API must not receive legacy Enterprise requests.'); },
        startBackupInfluxDbVerification: async () => { window.__unexpectedRestoreOrVerificationApiCalls.push('startBackupInfluxDbVerification'); throw new Error('Generic InfluxDB verification API must not receive legacy Enterprise requests.'); },
        startBackupInfluxDb3CoreVerification: async () => { window.__unexpectedRestoreOrVerificationApiCalls.push('startBackupInfluxDb3CoreVerification'); throw new Error('Core verification API must not receive legacy Enterprise requests.'); },
        listBackupJobs: async () => [], listBackupRuns: async () => [], listBackupRestoreRuns: async () => [],
        listBackupVerificationRuns: async () => [], listBackupInfluxDb3EnterpriseRestoreRuns: async () => [], getBackupWorkerStatus: async () => ({ online: true, state: 'online' })
      }});
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [structuredClone(window.__legacyPoint)];
      state.backupRecovery.totalPoints = 1;
      state.backupRecovery.selectedPointId = 'point-enterprise-legacy';
      true;
    `);

    const enrollment = await window.webContents.executeJavaScript(`(async () => {
      const missing = ${JSON.stringify(REQUIRED_RENDERER_HOOKS)}.filter((name) => typeof window[name] !== 'function');
      const requiredIds = ['backupInfluxDb3EnterpriseLegacyStopBindingModal', 'backupInfluxDb3EnterpriseLegacyStopBindingForm', 'backupInfluxDb3EnterpriseLegacyStopBindingName', 'backupInfluxDb3EnterpriseLegacyStopBindingTarget', 'backupInfluxDb3EnterpriseLegacyStopBindingClusterId', 'backupInfluxDb3EnterpriseLegacyStopBindingNodes', 'backupInfluxDb3EnterpriseLegacyRestoreModal', 'backupInfluxDb3EnterpriseLegacyRestoreTarget', 'backupInfluxDb3EnterpriseLegacyRestoreDataRoot', 'backupInfluxDb3EnterpriseLegacyRestorePreview', 'backupInfluxDb3EnterpriseLegacyRestoreStatus', 'backupInfluxDb3EnterpriseLegacyRestoreError', 'backupInfluxDb3EnterpriseLegacyVerificationModal', 'backupInfluxDb3EnterpriseLegacyVerificationForm', 'backupInfluxDb3EnterpriseLegacyVerificationTarget', 'backupInfluxDb3EnterpriseLegacyVerificationDataRoot', 'backupInfluxDb3EnterpriseLegacyVerificationStatus', 'backupInfluxDb3EnterpriseLegacyVerificationError'];
      const missingIds = requiredIds.filter((id) => !document.getElementById(id));
      if (missing.length || missingIds.length) return { ready: false, missing, missingIds };
      await openBackupInfluxDb3EnterpriseLegacyStopBinding();
      const form = document.getElementById('backupInfluxDb3EnterpriseLegacyStopBindingForm');
      document.getElementById('backupInfluxDb3EnterpriseLegacyStopBindingName').value = 'Production legacy stop proof';
      document.getElementById('backupInfluxDb3EnterpriseLegacyStopBindingTarget').value = 'connection-enterprise-target';
      document.getElementById('backupInfluxDb3EnterpriseLegacyStopBindingClusterId').value = 'cluster-legacy-production';
      for (const node of form.querySelectorAll('[data-legacy-stop-binding-node]')) {
        const nodeId = node.dataset.legacyStopBindingNode;
        node.querySelector('[data-field="ssh-connection"]').value = nodeId === 'compactor-01' ? window.__legacyPrivate.sshConnectionId : 'ssh-private-' + nodeId;
        node.querySelector('[data-field="systemd-unit"]').value = window.__legacyPrivate.systemdUnit;
      }
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const payload = window.__legacyBindingPayload;
      return { ready: true, modalText: document.getElementById('backupInfluxDb3EnterpriseLegacyStopBindingModal').innerText, payloadValid: payload?.name === 'Production legacy stop proof' && payload?.targetConnectionId === 'connection-enterprise-target' && payload?.clusterId === 'cluster-legacy-production' && payload?.nodes?.length === 3 && payload.nodes.every((node) => node.systemdUnit === window.__legacyPrivate.systemdUnit) };
    })()`);
    if (!enrollment.ready) throw new Error(`Missing legacy Enterprise renderer hooks: ${[...enrollment.missing, ...enrollment.missingIds].join(', ')}`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      await openBackupInfluxDb3EnterpriseLegacyRestore();
      els.backupInfluxDb3EnterpriseLegacyRestoreTarget.value = 'connection-enterprise-target';
      els.backupInfluxDb3EnterpriseLegacyRestoreDataRoot.value = window.__legacyPrivate.dataRoot;
      await previewBackupInfluxDb3EnterpriseLegacyRestore();
      const preview = els.backupInfluxDb3EnterpriseLegacyRestorePreview.innerText;
      await startBackupInfluxDb3EnterpriseLegacyRestore(new Event('submit', { cancelable: true }));
      const restoreError = els.backupInfluxDb3EnterpriseLegacyRestoreError.innerText;
      const restoreModalText = els.backupInfluxDb3EnterpriseLegacyRestoreModal.innerText;
      els.backupInfluxDb3EnterpriseLegacyRestoreModal.classList.add('hidden');
      await openBackupInfluxDb3EnterpriseLegacyVerification();
      await startBackupInfluxDb3EnterpriseLegacyVerification(new Event('submit', { cancelable: true }));
      const metadataStatus = els.backupInfluxDb3EnterpriseLegacyVerificationStatus.innerText;
      const metadataModalText = els.backupInfluxDb3EnterpriseLegacyVerificationModal.innerText;
      els.backupInfluxDb3EnterpriseLegacyVerificationModal.classList.add('hidden');
      await openBackupInfluxDb3EnterpriseLegacyVerification();
      const drillMode = els.backupInfluxDb3EnterpriseLegacyVerificationForm.querySelector('input[value="influxdb3-enterprise-legacy-full-drill"]');
      drillMode.checked = true;
      els.backupInfluxDb3EnterpriseLegacyVerificationTarget.value = 'connection-enterprise-target';
      els.backupInfluxDb3EnterpriseLegacyVerificationDataRoot.value = window.__legacyPrivate.dataRoot;
      syncBackupInfluxDb3EnterpriseLegacyVerificationMode();
      await startBackupInfluxDb3EnterpriseLegacyVerification(new Event('submit', { cancelable: true }));
      return { points: els.backupRecoveryPointList.innerText, entries: els.backupRecoveryEntryList.innerText, action: els.backupRecoveryRestoreButton.innerText, preview, restoreError, restoreModalText, metadataStatus, metadataModalText,
        drillError: els.backupInfluxDb3EnterpriseLegacyVerificationError.innerText, drillModalText: els.backupInfluxDb3EnterpriseLegacyVerificationModal.innerText, restorePreviewPayload: window.__legacyRestorePreviewPayload, restorePayload: window.__legacyRestorePayload, verificationPayloads: window.__legacyVerificationPayloads, unexpectedApiCalls: window.__unexpectedRestoreOrVerificationApiCalls };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      await loadBackupActivity();
      const listing = els.backupActivityList.innerText;
      const rows = [...els.backupActivityList.querySelectorAll('.backup-activity-row')].map((row) => row.innerText);
      await openBackupActivityDetail('restore', 'legacy-restore-interrupted');
      const restoreMetrics = els.backupActivityDetailMetrics.innerText;
      const restoreModalText = els.backupActivityDetailModal.innerText;
      closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'legacy-verification-1');
      const metadataMetrics = els.backupActivityDetailMetrics.innerText;
      const metadataModalText = els.backupActivityDetailModal.innerText;
      closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'legacy-verification-2');
      const drillMetrics = els.backupActivityDetailMetrics.innerText;
      const drillModalText = els.backupActivityDetailModal.innerText;
      return { listing, rows, restoreMetrics, restoreModalText, metadataMetrics, metadataModalText, drillMetrics, drillModalText, legacyApiCalls: [...window.__legacyApiCalls], unexpectedApiCalls: [...window.__unexpectedRestoreOrVerificationApiCalls] };
    })()`);

    const desktop = await window.webContents.executeJavaScript(`(() => {
      const box = (id) => { const rect = document.getElementById(id).querySelector('.modal-card').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
      return { width: innerWidth, height: innerHeight, enrollment: box('backupInfluxDb3EnterpriseLegacyStopBindingModal'), verification: box('backupInfluxDb3EnterpriseLegacyVerificationModal'), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, duplicateIds: ids.length - new Set(ids).size };
    })()`);
    window.setSize(390, 844);
    await wait(150);
    const mobile = await window.webContents.executeJavaScript(`(async () => {
      const box = (id) => { const rect = document.getElementById(id).querySelector('.modal-card').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
      await openBackupInfluxDb3EnterpriseLegacyStopBinding();
      const enrollmentBody = document.getElementById('backupInfluxDb3EnterpriseLegacyStopBindingModal').querySelector('.modal-body');
      document.getElementById('backupInfluxDb3EnterpriseLegacyVerificationModal').classList.add('hidden');
      await openBackupInfluxDb3EnterpriseLegacyVerification();
      const verificationBody = els.backupInfluxDb3EnterpriseLegacyVerificationModal.querySelector('.modal-body');
      els.toast.classList.remove('visible'); els.toast.style.display = 'none';
      return { width: innerWidth, height: innerHeight, enrollment: box('backupInfluxDb3EnterpriseLegacyStopBindingModal'), verification: box('backupInfluxDb3EnterpriseLegacyVerificationModal'),
        enrollmentScrollable: enrollmentBody.scrollHeight > enrollmentBody.clientHeight, verificationScrollable: verificationBody.scrollHeight > verificationBody.clientHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);

    const publicEvidence = JSON.stringify({
      enrollment: { modalText: enrollment.modalText },
      recovery: {
        points: recovery.points, entries: recovery.entries, action: recovery.action, preview: recovery.preview, restoreError: recovery.restoreError,
        restoreModalText: recovery.restoreModalText, metadataStatus: recovery.metadataStatus, metadataModalText: recovery.metadataModalText,
        drillError: recovery.drillError, drillModalText: recovery.drillModalText
      },
      activity: {
        listing: activity.listing, rows: activity.rows, restoreMetrics: activity.restoreMetrics, restoreModalText: activity.restoreModalText,
        metadataMetrics: activity.metadataMetrics, metadataModalText: activity.metadataModalText, drillMetrics: activity.drillMetrics, drillModalText: activity.drillModalText
      }
    });
    const redacted = ![
      'C:\\private\\enterprise-legacy-target', 'legacy-private.internal.example', 'ssh-private', 'influxdb3-enterprise-private.service',
      'PRIVATE_LEGACY_PASSWORD', 'hmac-sha256:' + 'a'.repeat(64), 'C:\\private\\enterprise-legacy-repository', 'C:\\private\\enterprise-legacy-stage',
      'dataRoot', 'repositoryPath', 'stagePath', 'proofDigest'
    ].some((secret) => publicEvidence.includes(secret));
    const expectedTarget = {
      kind: 'local-filesystem', dataRoot: 'C:\\private\\enterprise-legacy-target', clusterId: 'cluster-legacy-production',
      compactorNodeId: 'compactor-01', dataNodeIds: ['data-01', 'data-02']
    };
    const restorePayload = recovery.restorePayload;
    const [metadataPayload, drillPayload] = recovery.verificationPayloads;
    const exactTarget = (payload) => JSON.stringify(payload?.target) === JSON.stringify(expectedTarget);
    const metadataHasNoTarget = metadataPayload && !Object.prototype.hasOwnProperty.call(metadataPayload, 'target')
      && !Object.prototype.hasOwnProperty.call(metadataPayload, 'targetConnectionId')
      && !Object.prototype.hasOwnProperty.call(metadataPayload, 'dataRoot');
    const valid = enrollment.payloadValid
      && recovery.points.includes('Enterprise legacy filesystem') && recovery.action.includes('Recover stopped legacy cluster')
      && recovery.preview.includes('16 files / 21 directories') && recovery.preview.includes('Empty') && recovery.preview.includes('Stopped') && recovery.preview.includes('Separate alternate storage') && recovery.preview.includes('Unavailable')
      && recovery.restorePreviewPayload?.recoveryPointId === 'point-enterprise-legacy' && recovery.restorePreviewPayload?.targetConnectionId === 'connection-enterprise-target' && exactTarget(recovery.restorePreviewPayload)
      && restorePayload?.recoveryPointId === 'point-enterprise-legacy' && restorePayload?.targetConnectionId === 'connection-enterprise-target' && exactTarget(restorePayload) && restorePayload?.confirmed === true && restorePayload?.confirmationText === 'RESTORE LEGACY INFLUXDB 3 ENTERPRISE TO EMPTY ALTERNATE STORAGE'
      && recovery.restoreError.includes('preserved for inspection') && recovery.restoreError.includes('no rollback is claimed')
      && metadataPayload?.mode === 'influxdb3-enterprise-legacy-metadata' && metadataPayload?.recoveryPointId === 'point-enterprise-legacy' && metadataPayload?.confirmed !== true && metadataHasNoTarget
      && drillPayload?.mode === 'influxdb3-enterprise-legacy-full-drill' && drillPayload?.targetConnectionId === 'connection-enterprise-target' && exactTarget(drillPayload) && drillPayload?.confirmed === true && drillPayload?.confirmationText === 'RUN INFLUXDB3 ENTERPRISE LEGACY RECOVERY DRILL'
      && recovery.metadataStatus.includes('16 files and 21 directories authenticated') && recovery.drillError.includes('preserved for inspection') && recovery.drillError.includes('no cleanup or rollback is claimed')
      && activity.legacyApiCalls.includes('preview-restore') && activity.legacyApiCalls.includes('start-restore') && activity.legacyApiCalls.includes('wait-restore') && activity.legacyApiCalls.filter((name) => name === 'start-verification').length === 2 && activity.legacyApiCalls.filter((name) => name === 'wait-verification').length === 2 && activity.legacyApiCalls.includes('list-restores') && activity.legacyApiCalls.includes('list-verifications') && recovery.unexpectedApiCalls.length === 0 && activity.unexpectedApiCalls.length === 0
      && activity.listing.includes('Enterprise legacy') && activity.restoreMetrics.includes('Target data') && activity.restoreMetrics.includes('Preserved for inspection') && activity.restoreMetrics.includes('Cleanup and rollback') && activity.restoreMetrics.includes('Not claimed') && activity.metadataMetrics.includes('Full restore performed') && activity.metadataMetrics.includes('No') && activity.drillMetrics.includes('Full stopped-cluster Enterprise legacy drill') && activity.drillMetrics.includes('Target service') && activity.drillMetrics.includes('Stopped') && activity.drillMetrics.includes('Cleanup and rollback') && activity.drillMetrics.includes('Not claimed')
      && redacted && desktop.duplicateIds === 0 && !desktop.overflow && contained(desktop.enrollment, desktop) && contained(desktop.verification, desktop)
      && mobile.width <= 390 && !mobile.overflow && contained(mobile.enrollment, mobile) && contained(mobile.verification, mobile);
    process.stdout.write(`${JSON.stringify({ ok: valid, enrollment, recovery: { ...recovery, restorePayloadValid: Boolean(restorePayload) }, activity, desktop, mobile, redacted })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode || 0);
  }
});
