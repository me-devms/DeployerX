const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

const REQUIRED_HOOKS = [
  'openBackupInfluxDb3EnterpriseRestore', 'previewBackupInfluxDb3EnterpriseRestore', 'startBackupInfluxDb3EnterpriseRestore',
  'openBackupInfluxDb3EnterpriseVerification', 'startBackupInfluxDb3EnterpriseVerification', 'cancelOrCloseBackupInfluxDb3EnterpriseVerification',
  'openBackupInfluxDb3EnterpriseRetention', 'previewBackupInfluxDb3EnterpriseRetention', 'executeBackupInfluxDb3EnterpriseRetention',
  'loadBackupActivity', 'openBackupActivityDetail'
];

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
      loadBackupRecoveryPoints = async () => {};

      window.__enterprisePrivate = {
        backupFull: 'PRIVATE_ENTERPRISE_NATIVE_FULL', backupIncremental: 'PRIVATE_ENTERPRISE_NATIVE_INCREMENTAL',
        endpoint: 'https://enterprise-private.internal.example:8181', token: 'PRIVATE_ENTERPRISE_ADMIN_TOKEN',
        secretRef: 'SecretRef:enterprise-private', locator: 'provider://enterprise-private-locator',
        ownership: 'sha256:' + 'a'.repeat(64), nativeRestoreId: 'private-native-restore-991'
      };
      window.__enterpriseCalls = { restore: null, verification: null, verificationCancel: null, retentionPreviews: [], retention: null, verificationLists: 0, verificationListPayloads: [] };
      window.__enterpriseVerifications = [];
      window.__enterprisePoint = {
        id: 'point-enterprise-native', jobName: 'Enterprise cluster protection', sourceId: 'source-enterprise', sourceName: 'Production Enterprise cluster', sourceConnectionId: 'connection-enterprise',
        sourceType: 'database', sourceAdapterId: 'deployerx.database.influxdb3-enterprise', backupMethod: 'physical', type: 'full', consistency: 'application', capturedTo: '2026-08-05T02:00:00.000Z',
        influxdb3Enterprise: { tier: 'upgraded-native', productVersion: '3.6.1', clusterId: 'cluster-production-private', storageEngine: 'upgraded', backupName: window.__enterprisePrivate.backupFull, backupType: 'full', backupWatermark: 'private-wal:9001', rowDeleteStateCapturedByBackup: false, rowDeletesMayPersist: true },
        retention: { deletionEligible: true }, verification: { state: 'succeeded' }, availableCopyCount: 1, totalCopyCount: 1, repositoryCopies: [{ repositoryId: 'repo-primary', state: 'available' }]
      };
      window.__enterpriseRestorePlan = {
        mode: 'in-place', recoveryPointId: 'point-enterprise-native', sourceId: 'source-enterprise', targetConnectionId: 'connection-enterprise', engine: 'influxdb3-enterprise', tier: 'upgraded-native',
        backupName: window.__enterprisePrivate.backupFull, backupType: 'full', backupWatermark: 'private-wal:9001', consistency: 'application', productVersion: '3.6.1', clusterId: 'cluster-production-private', storageEngine: 'upgraded',
        identity: { clusterId: 'cluster-production-private', endpoint: window.__enterprisePrivate.endpoint }, destructive: true, liveCluster: true, wholeCluster: true, originalClusterModified: true, rollbackAvailable: false, providerRestoreConflictScope: 'cluster',
        rowDeleteStateCapturedByBackup: false, rowDeletesMayPersist: true, confirmationText: 'RESTORE ENTERPRISE LIVE CLUSTER', warnings: ['The provider backup does not capture row-delete state. Row deletes may persist after restore.'], planDigest: window.__enterprisePrivate.ownership
      };
      window.__enterpriseRestoreRun = {
        id: 'restore-enterprise', state: 'succeeded', recoveryPointIds: ['point-enterprise-native'], createdAt: '2026-08-05T03:00:00.000Z', startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z',
        target: { engine: 'influxdb3-enterprise', tier: 'upgraded-native', mode: 'in-place', targetConnectionId: 'connection-enterprise', backupName: window.__enterprisePrivate.backupFull, backupWatermark: 'private-wal:9001', clusterId: 'cluster-production-private', targetMutationStarted: true, nativeRestoreId: window.__enterprisePrivate.nativeRestoreId },
        progress: { phase: 'complete', itemsTotal: 1, itemsCompleted: 1, itemsSkipped: 0, bytesTotal: 0, bytesWritten: 0, startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z' },
        validation: { nativeRestoreStatus: 'completed', identityRevalidated: true },
        result: { restoreId: window.__enterprisePrivate.nativeRestoreId, completedAt: '2026-08-05T03:00:21.000Z', evidence: { clusterId: 'cluster-production-private', backupName: window.__enterprisePrivate.backupFull, backupWatermark: 'private-wal:9001', backupWatermarkApplied: true, walTruncatedToBackupWatermark: true, rowDeleteStateCapturedByBackup: false, rowDeletesMayPersist: true }, warnings: ['The provider backup does not capture row-delete state. Row deletes may persist after restore.'] }
      };
      window.__completedEnterpriseVerification = {
        id: 'verification-enterprise-1', state: 'succeeded', mode: 'influxdb3-enterprise-metadata', createdAt: '2026-08-05T03:10:00.000Z', completedAt: '2026-08-05T03:10:09.000Z',
        progress: { phase: 'complete', startedAt: '2026-08-05T03:10:01.000Z', updatedAt: '2026-08-05T03:10:09.000Z' },
        evidence: { verificationClass: 'influxdb3-enterprise-upgraded-native-metadata', repositoryManifestAuthenticated: true, repositoryArtifactAuthenticated: true, retainedNativeChainAuthenticated: true, nativeChainLength: 2, ownedNativeBackupCompleted: true, ownedNativeBackupWatermarkAuthenticated: true, sourceIdentityFreshlyRevalidated: true, productIdentityVerified: true, upgradedStorageEngineVerified: true, protectedClusterIdentityVerified: true, deploymentIdentityVerified: true, capabilityIdentityVerified: true, compactorIdentityVerified: true, externalNativeMediaManagedByServer: true, repositoryContainsMetadataArtifactOnly: true, rowDeleteStateCapturedByBackup: false, rowDeletesMayPersist: true, destructiveLiveDrillAvailable: false, fullRestorePerformed: false, nativeLocator: window.__enterprisePrivate.locator, ownershipProof: window.__enterprisePrivate.ownership },
        result: { state: 'succeeded', fullRestorePerformed: false, productionClusterModified: false, completedAt: '2026-08-05T03:10:09.000Z' }
      };
      window.__blockedEnterpriseRetentionPlan = {
        planId: 'influxdb3_enterprise_retention_' + 'b'.repeat(64), evaluatedAt: '2026-08-05T03:20:00.000Z', recoveryPointId: 'point-enterprise-native', tier: 'upgraded-native', mediaDomain: 'influxdb3-enterprise-native',
        identity: { clusterId: 'cluster-production-private', endpoint: window.__enterprisePrivate.endpoint }, backupName: window.__enterprisePrivate.backupFull,
        eligible: false, blockedReason: 'native-ownership-incomplete', activeOperationIds: [],
        closure: [{ recoveryPointId: null, backupName: window.__enterprisePrivate.backupIncremental, type: 'incremental', parentName: window.__enterprisePrivate.backupFull, status: 'completed', ownershipAuthenticated: false }, { recoveryPointId: 'point-enterprise-native', backupName: window.__enterprisePrivate.backupFull, type: 'full', parentName: null, status: 'completed', ownershipAuthenticated: true }],
        deletionOrder: [window.__enterprisePrivate.backupIncremental, window.__enterprisePrivate.backupFull], closureFingerprint: window.__enterprisePrivate.ownership, cascadeCount: 1, providerCascade: true,
        ownership: { recoveryPointArtifactAuthenticated: true, targetNativeOwnershipAuthenticated: true, completeClosureAuthenticated: false }, confirmationText: 'DELETE INFLUXDB 3 ENTERPRISE NATIVE BACKUP AND ALL DESCENDANTS', previewOnly: true, deleteIssued: false
      };
      window.__eligibleEnterpriseRetentionPlan = structuredClone(window.__blockedEnterpriseRetentionPlan);
      window.__eligibleEnterpriseRetentionPlan.planId = 'influxdb3_enterprise_retention_' + 'c'.repeat(64);
      window.__eligibleEnterpriseRetentionPlan.eligible = true;
      window.__eligibleEnterpriseRetentionPlan.blockedReason = null;
      window.__eligibleEnterpriseRetentionPlan.closure[0].ownershipAuthenticated = true;
      window.__eligibleEnterpriseRetentionPlan.ownership.completeClosureAuthenticated = true;

      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        previewBackupInfluxDb3EnterpriseRestore: async () => structuredClone(window.__enterpriseRestorePlan),
        listBackupInfluxDb3EnterpriseRestoreRuns: async () => [structuredClone(window.__enterpriseRestoreRun)],
        startBackupInfluxDb3EnterpriseRestore: async (payload) => { window.__enterpriseCalls.restore = structuredClone(payload); return { id: 'restore-enterprise', state: 'queued', target: { engine: 'influxdb3-enterprise', tier: 'upgraded-native', mode: 'in-place' } }; },
        waitBackupInfluxDb3EnterpriseRestore: async () => structuredClone(window.__enterpriseRestoreRun),
        cancelBackupInfluxDb3EnterpriseRestore: async (id) => ({ id, state: 'canceled', target: { engine: 'influxdb3-enterprise', tier: 'upgraded-native', mode: 'in-place' }, result: { cancellationConfirmed: true, rowDeletesMayPersist: true } }),
        listBackupInfluxDb3EnterpriseVerificationRuns: async (payload = {}) => { window.__enterpriseCalls.verificationLists += 1; window.__enterpriseCalls.verificationListPayloads.push(structuredClone(payload)); return structuredClone(window.__enterpriseVerifications); },
        startBackupInfluxDb3EnterpriseVerification: async (payload) => { window.__enterpriseCalls.verification = structuredClone(payload); return { id: 'verification-enterprise-1', state: 'queued', mode: payload.mode, progress: { phase: 'queued' } }; },
        waitBackupInfluxDb3EnterpriseVerification: async () => { const run = structuredClone(window.__completedEnterpriseVerification); window.__enterpriseVerifications = [run]; return run; },
        cancelBackupInfluxDb3EnterpriseVerification: async (id) => { window.__enterpriseCalls.verificationCancel = id; const run = { id, state: 'canceled', mode: 'influxdb3-enterprise-metadata', completedAt: '2026-08-05T03:12:00.000Z', evidence: { rowDeleteStateCapturedByBackup: false, rowDeletesMayPersist: true, destructiveLiveDrillAvailable: false, fullRestorePerformed: false }, result: { state: 'canceled', fullRestorePerformed: false, productionClusterModified: false } }; window.__enterpriseVerifications = [run, ...window.__enterpriseVerifications]; return structuredClone(run); },
        previewBackupInfluxDb3EnterpriseRetention: async (payload) => { window.__enterpriseCalls.retentionPreviews.push(structuredClone(payload)); return structuredClone(window.__enterpriseCalls.retentionPreviews.length === 1 ? window.__blockedEnterpriseRetentionPlan : window.__eligibleEnterpriseRetentionPlan); },
        executeBackupInfluxDb3EnterpriseRetention: async (payload) => { window.__enterpriseCalls.retention = structuredClone(payload); return { planId: payload.planId, state: 'succeeded', nativeBackupsDeleted: 2, deletionConfirmed: true, repositoryMetadataPreserved: true }; },
        listBackupJobs: async () => [{ id: 'job-enterprise', name: 'Enterprise cluster protection', sourceId: 'source-enterprise', sourceAdapterId: 'deployerx.database.influxdb3-enterprise' }],
        listBackupRuns: async () => [], listBackupRestoreRuns: async () => [], listBackupVerificationRuns: async () => []
      }});
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [structuredClone(window.__enterprisePoint)];
      state.backupRecovery.totalPoints = 1;
      state.backupRecovery.selectedPointId = 'point-enterprise-native';
      state.backupJobs = [{ id: 'job-enterprise', name: 'Enterprise cluster protection', sourceId: 'source-enterprise', sourceAdapterId: 'deployerx.database.influxdb3-enterprise' }];
      true;
    `);

    const workflow = await window.webContents.executeJavaScript(`(async () => {
      const missing = ${JSON.stringify(REQUIRED_HOOKS)}.filter((name) => typeof window[name] !== 'function');
      const requiredIds = ['backupInfluxDb3EnterpriseRestoreModal', 'backupInfluxDb3EnterpriseVerificationModal', 'backupInfluxDb3EnterpriseRetentionModal', 'backupActivityDetailModal'];
      if (missing.length || requiredIds.some((id) => !document.getElementById(id))) return { ready: false, missing, missingIds: requiredIds.filter((id) => !document.getElementById(id)) };
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const projection = els.backupRecoveryEntryList.innerText;
      const restoreAction = els.backupRecoveryRestoreButton.innerText;
      const retentionAction = els.backupInfluxDb3EnterpriseRetentionButton.innerText;

      await openBackupInfluxDb3EnterpriseRestore(); await previewBackupInfluxDb3EnterpriseRestore();
      const restorePreview = els.backupInfluxDb3EnterpriseRestorePreview.innerText;
      els.backupInfluxDb3EnterpriseRestoreConfirmation.value = window.__enterpriseRestorePlan.confirmationText;
      els.backupInfluxDb3EnterpriseRestoreConfirmation.dispatchEvent(new Event('input', { bubbles: true }));
      await startBackupInfluxDb3EnterpriseRestore(new Event('submit', { cancelable: true }));
      const restoreStatus = els.backupInfluxDb3EnterpriseRestoreStatus.innerText;
      els.backupInfluxDb3EnterpriseRestoreModal.classList.add('hidden');

      els.backupRecoveryVerifyButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const verificationRouted = !els.backupInfluxDb3EnterpriseVerificationModal.classList.contains('hidden');
      const verificationSummary = els.backupInfluxDb3EnterpriseVerificationSummary.innerText;
      await startBackupInfluxDb3EnterpriseVerification(new Event('submit', { cancelable: true }));
      const verificationEvidence = els.backupInfluxDb3EnterpriseVerificationEvidence.innerText;
      const verificationStatus = els.backupInfluxDb3EnterpriseVerificationStatus.innerText;
      state.backupRecovery.activeVerification = { id: 'verification-enterprise-cancel', state: 'running', mode: 'influxdb3-enterprise-metadata' };
      await cancelOrCloseBackupInfluxDb3EnterpriseVerification();
      const verificationCancelStatus = els.backupInfluxDb3EnterpriseVerificationStatus.innerText;
      els.backupInfluxDb3EnterpriseVerificationModal.classList.add('hidden');

      openBackupInfluxDb3EnterpriseRetention();
      await previewBackupInfluxDb3EnterpriseRetention();
      const blockedRetentionPreview = els.backupInfluxDb3EnterpriseRetentionPreview.innerText;
      const blockedRetentionDisabled = els.backupInfluxDb3EnterpriseRetentionConfirmation.disabled && els.backupInfluxDb3EnterpriseRetentionExecuteButton.disabled;
      await previewBackupInfluxDb3EnterpriseRetention();
      const eligibleRetentionPreview = els.backupInfluxDb3EnterpriseRetentionPreview.innerText;
      const retentionConfirmation = els.backupInfluxDb3EnterpriseRetentionConfirmationText.innerText;
      els.backupInfluxDb3EnterpriseRetentionConfirmation.value = retentionConfirmation;
      els.backupInfluxDb3EnterpriseRetentionConfirmation.dispatchEvent(new Event('input', { bubbles: true }));
      const retentionEnabled = !els.backupInfluxDb3EnterpriseRetentionExecuteButton.disabled;
      await executeBackupInfluxDb3EnterpriseRetention(new Event('submit', { cancelable: true }));
      const retentionStatus = els.backupInfluxDb3EnterpriseRetentionStatus.innerText;
      els.backupInfluxDb3EnterpriseRetentionModal.classList.add('hidden');

      await loadBackupActivity();
      const activityText = els.backupActivityList.innerText;
      const testsText = els.backupTestList.innerText;
      await openBackupActivityDetail('verification', 'verification-enterprise-1');
      const verificationDetail = els.backupActivityDetailModal.innerText;
      closeBackupActivityDetail();
      await openBackupActivityDetail('restore', 'restore-enterprise');
      const restoreDetail = els.backupActivityDetailModal.innerText;
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
      return { ready: true, projection, restoreAction, retentionAction, restorePreview, restoreStatus, verificationRouted, verificationSummary, verificationEvidence, verificationStatus, verificationCancelStatus, blockedRetentionPreview, blockedRetentionDisabled, eligibleRetentionPreview, retentionConfirmation, retentionEnabled, retentionStatus, activityText, testsText, verificationDetail, restoreDetail, calls: structuredClone(window.__enterpriseCalls), duplicateIds: ids.length - new Set(ids).size };
    })()`);
    if (!workflow.ready) throw new Error(`Missing Enterprise renderer hooks: ${[...workflow.missing, ...workflow.missingIds].join(', ')}`);

    const desktop = await window.webContents.executeJavaScript(`(async () => {
      const box = (id) => { const rect = document.getElementById(id).querySelector('.modal-card').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      await openBackupInfluxDb3EnterpriseRestore(); const restore = box('backupInfluxDb3EnterpriseRestoreModal'); els.backupInfluxDb3EnterpriseRestoreModal.classList.add('hidden');
      await openBackupInfluxDb3EnterpriseVerification(); const verification = box('backupInfluxDb3EnterpriseVerificationModal'); els.backupInfluxDb3EnterpriseVerificationModal.classList.add('hidden');
      openBackupInfluxDb3EnterpriseRetention(); const retention = box('backupInfluxDb3EnterpriseRetentionModal');
      return { width: innerWidth, height: innerHeight, restore, verification, retention, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    window.setSize(390, 844);
    await wait(150);
    const mobile = await window.webContents.executeJavaScript(`(async () => {
      const details = (id) => { const modal = document.getElementById(id); const rect = modal.querySelector('.modal-card').getBoundingClientRect(); const body = modal.querySelector('.modal-body'); return { box: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, bodyScrollable: body.scrollHeight > body.clientHeight }; };
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      await openBackupInfluxDb3EnterpriseRestore(); const restore = details('backupInfluxDb3EnterpriseRestoreModal'); els.backupInfluxDb3EnterpriseRestoreModal.classList.add('hidden');
      await openBackupInfluxDb3EnterpriseVerification(); const verification = details('backupInfluxDb3EnterpriseVerificationModal'); els.backupInfluxDb3EnterpriseVerificationModal.classList.add('hidden');
      openBackupInfluxDb3EnterpriseRetention(); await previewBackupInfluxDb3EnterpriseRetention(); const retention = details('backupInfluxDb3EnterpriseRetentionModal');
      els.toast.classList.remove('visible'); els.toast.style.display = 'none';
      return { width: innerWidth, height: innerHeight, restore, verification, retention, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);

    const publicText = JSON.stringify({ projection: workflow.projection, restorePreview: workflow.restorePreview, restoreStatus: workflow.restoreStatus, verificationSummary: workflow.verificationSummary, verificationEvidence: workflow.verificationEvidence, verificationStatus: workflow.verificationStatus, verificationCancelStatus: workflow.verificationCancelStatus, blockedRetentionPreview: workflow.blockedRetentionPreview, eligibleRetentionPreview: workflow.eligibleRetentionPreview, retentionStatus: workflow.retentionStatus, activityText: workflow.activityText, testsText: workflow.testsText, verificationDetail: workflow.verificationDetail, restoreDetail: workflow.restoreDetail });
    const secrets = ['PRIVATE_ENTERPRISE_NATIVE_FULL', 'PRIVATE_ENTERPRISE_NATIVE_INCREMENTAL', 'enterprise-private.internal.example', 'PRIVATE_ENTERPRISE_ADMIN_TOKEN', 'SecretRef:enterprise-private', 'provider://enterprise-private-locator', 'sha256:' + 'a'.repeat(64), 'private-native-restore-991', 'private-wal:9001', 'cluster-production-private'];
    const redacted = !secrets.some((secret) => publicText.includes(secret));
    const verificationPayload = workflow.calls.verification;
    const retentionPayload = workflow.calls.retention;
    const valid = workflow.projection.includes('InfluxDB 3 Enterprise 3.6.1') && workflow.projection.includes('Destructive live-cluster restore') && workflow.projection.includes('row deletes may persist')
      && workflow.restoreAction.includes('Restore original live cluster') && workflow.retentionAction.includes('Review native retention')
      && workflow.restorePreview.includes('Whole live cluster, in place') && workflow.restorePreview.includes('Not captured; row deletes may persist') && workflow.restoreStatus.includes('authenticated backup boundary')
      && workflow.verificationRouted && workflow.calls.verificationLists > 0 && workflow.calls.verificationListPayloads.some((payload) => payload?.limit === 100 && payload?.recoveryPointId === 'point-enterprise-native') && workflow.verificationSummary.includes('metadata evidence only')
      && verificationPayload?.recoveryPointId === 'point-enterprise-native' && verificationPayload?.mode === 'influxdb3-enterprise-metadata'
      && workflow.verificationEvidence.includes('Row-delete state captured by backupNo') && workflow.verificationEvidence.includes('Row deletes may persistYes') && workflow.verificationEvidence.includes('Destructive live drill availableNo') && workflow.verificationEvidence.includes('Full restore performedNo')
      && workflow.verificationStatus.includes('no full restore was performed') && workflow.calls.verificationCancel === 'verification-enterprise-cancel' && workflow.verificationCancelStatus.includes('production cluster modified: no')
      && workflow.blockedRetentionDisabled && workflow.blockedRetentionPreview.includes('native-ownership-incomplete') && workflow.blockedRetentionPreview.includes('Complete closure ownershipNot proven')
      && workflow.eligibleRetentionPreview.includes('Plan IDinfluxdb3_enterprise_retention_') && workflow.eligibleRetentionPreview.includes('Closure2 native backup members') && workflow.eligibleRetentionPreview.includes('1. incremental descendant') && workflow.eligibleRetentionPreview.includes('2. full chain root, selected backup') && workflow.eligibleRetentionPreview.includes('Cascade1 descendant; provider cascade required') && workflow.eligibleRetentionPreview.includes('Block reasonnone') && workflow.eligibleRetentionPreview.includes('Complete closure ownershipAuthenticated')
      && workflow.retentionConfirmation === 'DELETE INFLUXDB 3 ENTERPRISE NATIVE BACKUP AND ALL DESCENDANTS' && workflow.retentionEnabled
      && retentionPayload?.recoveryPointId === 'point-enterprise-native' && retentionPayload?.confirmed === true;
    const payloadValid = retentionPayload?.planId === 'influxdb3_enterprise_retention_' + 'c'.repeat(64) && retentionPayload?.confirmationText === workflow.retentionConfirmation && workflow.retentionStatus.includes('2 reviewed native backup members deleted') && workflow.retentionStatus.includes('Repository metadata was preserved');
    const activityValid = workflow.activityText.includes('InfluxDB 3 Enterprise upgraded-native metadata recovery test') && !workflow.activityText.includes('Repository verification') && !workflow.activityText.includes('null restore')
      && workflow.testsText.includes('row-delete state not captured') && workflow.testsText.includes('destructive live drill unavailable') && workflow.verificationDetail.includes('Destructive live drill available\nNo') && workflow.verificationDetail.includes('Full restore performed\nNo') && workflow.restoreDetail.includes('Original protected live whole cluster') && !workflow.restoreDetail.includes('Native restore ID');
    const containmentValid = !desktop.overflow && contained(desktop.restore, desktop) && contained(desktop.verification, desktop) && contained(desktop.retention, desktop)
      && mobile.width <= 390 && !mobile.overflow && contained(mobile.restore.box, mobile) && contained(mobile.verification.box, mobile) && contained(mobile.retention.box, mobile);
    const ok = valid && payloadValid && activityValid && redacted && workflow.duplicateIds === 0 && containmentValid;
    process.stdout.write(`${JSON.stringify({ ok, workflow: { ...workflow, calls: { restore: Boolean(workflow.calls.restore), verification: Boolean(workflow.calls.verification), verificationCancel: Boolean(workflow.calls.verificationCancel), retentionPreviewCount: workflow.calls.retentionPreviews.length, retention: Boolean(workflow.calls.retention) } }, desktop, mobile, redacted, payloadValid, activityValid, containmentValid })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode || 0);
  }
});
