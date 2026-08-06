const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

const REQUIRED_HOOKS = [
  'openBackupCockroachDbRestore', 'previewBackupCockroachDbRestore', 'startBackupCockroachDbRestore',
  'openBackupCockroachDbRetention', 'previewBackupCockroachDbRetention', 'executeBackupCockroachDbRetention',
  'openBackupCockroachDbSchedule', 'previewBackupCockroachDbSchedule', 'createBackupCockroachDbSchedule',
  'startBackupCockroachDbMetadataTest', 'cancelOrCloseBackupCockroachDbRestore', 'loadBackupActivity', 'openBackupActivityDetail'
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
      confirmDangerousAction = async () => true;

      window.__private = {
        dataRoot: 'C:\\\\private\\\\cockroach-data', repository: 's3://private-cockroach-repository',
        stage: 'C:\\\\private\\\\cockroach-stage', host: 'cockroach-private.internal.example',
        credential: 'PRIVATE_COCKROACHDB_PASSWORD', proof: 'sha256:' + 'b'.repeat(64)
      };
      window.__calls = { restore: null, restoreCancel: null, retention: null, schedule: null, verifications: [], verificationCancel: null };
      window.__restores = [];
      window.__verifications = [];
      window.__point = {
        id: 'point-cockroach-native', jobName: 'Production CockroachDB protection', sourceId: 'source-cockroach',
        sourceName: 'Production CockroachDB', sourceConnectionId: 'connection-cockroach-source', sourceType: 'database',
        sourceAdapterId: 'deployerx.database.cockroachdb', backupMethod: 'physical', type: 'full', consistency: 'application',
        capturedTo: '2026-08-05T02:00:00.000Z', availableCopyCount: 1, totalCopyCount: 1, verification: { state: 'succeeded' },
        chainRootId: 'point-cockroach-native', repositoryCopies: [{ repositoryId: 'repo-cockroach-metadata', state: 'available' }],
        cockroachdb: { clusterId: 'cluster-production', revisionHistory: true, backupId: 'native-backup-001', dataRoot: window.__private.dataRoot, repository: window.__private.repository, proof: window.__private.proof }
      };
      window.__connections = [{
        id: 'connection-cockroach-alternate', name: 'Isolated CockroachDB recovery cluster', currentDevice: true,
        adapterId: 'deployerx.database.cockroachdb', adapterVersion: '1.0.0', revision: 1,
        lastTest: { status: 'success', testedAt: '2026-08-05T02:30:00.000Z', endpointIdentity: { clusterId: 'cluster-recovery' }, host: window.__private.host, credential: window.__private.credential }
      }];
      window.__restorePlan = {
        recoveryPointId: 'point-cockroach-native', targetConnectionId: 'connection-cockroach-alternate', targetDatabase: 'recovered_accounts',
        targetEmpty: true, chainRecoveryPointIds: ['point-cockroach-native'], restoreTimestamp: null,
        confirmationText: 'RECOVER COCKROACHDB ALTERNATE DATABASE', planDigest: window.__private.proof
      };
      window.__retentionPlan = {
        planId: 'retention-cockroach-1', eligible: true,
        chain: { deletionOrder: 'descendant-first deletion order verified', descendantsAdded: 1 },
        summary: { repositoryCopies: 2, bytesReviewed: 4096 }, repository: window.__private.repository
      };
      const completedRestore = () => ({
        id: 'restore-cockroach-1', state: 'succeeded', recoveryPointIds: ['point-cockroach-native'],
        createdAt: '2026-08-05T03:00:00.000Z', startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z',
        target: { engine: 'cockroachdb', mode: 'alternate', targetConnectionId: 'connection-cockroach-alternate', targetDatabase: 'recovered_accounts', nativeStatus: 'succeeded', repository: window.__private.repository },
        progress: { phase: 'complete', itemsTotal: 1, itemsCompleted: 1, itemsSkipped: 0, bytesTotal: 4096, bytesWritten: 4096, startedAt: '2026-08-05T03:00:01.000Z', updatedAt: '2026-08-05T03:00:21.000Z' },
        validation: { nativeIntegrityValidation: true }, result: { targetPreserved: true, chainRecoveryPointIds: ['point-cockroach-native'], stage: window.__private.stage }
      });
      const completedVerification = (payload, id) => ({
        id, state: 'succeeded', mode: payload.mode, recoveryPointId: 'point-cockroach-native', restoreRunId: payload.mode === 'cockroachdb-full-drill' ? 'restore-cockroach-1' : undefined,
        createdAt: '2026-08-05T03:10:00.000Z', startedAt: '2026-08-05T03:10:01.000Z', updatedAt: '2026-08-05T03:10:11.000Z', completedAt: '2026-08-05T03:10:11.000Z',
        progress: { phase: 'complete', startedAt: '2026-08-05T03:10:01.000Z', updatedAt: '2026-08-05T03:10:11.000Z' },
        evidence: { artifactCount: 3, chainRecoveryPointIds: ['point-cockroach-native'], sourceIdentityVerified: true, destinationIdentityVerified: true, nativeIntegrityValidation: true, targetDatabase: payload.targetDatabase, targetPreserved: payload.mode === 'cockroachdb-full-drill', repository: window.__private.repository, proof: window.__private.proof },
        result: { targetPreserved: payload.mode === 'cockroachdb-full-drill' }
      });
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        previewBackupCockroachDbRestore: async (payload) => { window.__calls.restorePreview = structuredClone(payload); return structuredClone(window.__restorePlan); },
        startBackupCockroachDbRestore: async (payload) => { window.__calls.restore = structuredClone(payload); return { id: 'restore-cockroach-1', state: 'queued', target: { engine: 'cockroachdb', mode: 'alternate' } }; },
        waitBackupCockroachDbRestore: async () => { const run = completedRestore(); window.__restores = [run]; return structuredClone(run); },
        pauseBackupCockroachDbRestore: async (id) => ({ id, status: 'paused', terminal: false }),
        resumeBackupCockroachDbRestore: async (id) => ({ id, status: 'running', terminal: false }),
        cancelBackupCockroachDbRestore: async (id) => { window.__calls.restoreCancel = id; return { id, status: 'canceled', terminal: true }; },
        previewBackupCockroachDbRetention: async (payload) => { window.__calls.retentionPreview = structuredClone(payload); return structuredClone(window.__retentionPlan); },
        executeBackupCockroachDbRetention: async (payload) => { window.__calls.retention = structuredClone(payload); return { repositoryCopiesPruned: 2 }; },
        listBackupCockroachDbSchedules: async () => [],
        previewBackupCockroachDbSchedule: async (payload) => { window.__calls.schedulePreview = structuredClone(payload); return { mode: payload.policy.mode, schedules: [{ id: 'native-schedule-full' }, { id: 'native-schedule-incremental' }] }; },
        createBackupCockroachDbSchedule: async (payload) => { window.__calls.schedule = structuredClone(payload); return { id: 'schedule-cockroach-1', jobId: payload.jobId, state: 'owned', policy: payload.policy, projection: { state: 'active' } }; },
        startBackupCockroachDbVerification: async (payload) => { const id = 'verification-cockroach-' + (window.__calls.verifications.length + 1); window.__calls.verifications.push(structuredClone(payload)); return { id, state: 'queued', mode: payload.mode }; },
        waitBackupCockroachDbVerification: async (id) => { const payload = window.__calls.verifications.find((item, index) => id.endsWith(String(index + 1))); const run = completedVerification(payload, id); window.__verifications = [run, ...window.__verifications.filter((item) => item.id !== id)]; return structuredClone(run); },
        cancelBackupCockroachDbVerification: async (id) => { window.__calls.verificationCancel = id; const run = { id, state: 'canceled', mode: 'cockroachdb-full-drill', evidence: { targetPreserved: true }, result: { state: 'canceled', targetPreserved: true, cleanupPerformed: false, rollbackPerformed: false } }; window.__verifications = [run, ...window.__verifications.filter((item) => item.id !== id)]; return structuredClone(run); },
        listBackupJobs: async () => [{ id: 'job-cockroach', name: 'Production CockroachDB protection', sourceId: 'source-cockroach', sourceAdapterId: 'deployerx.database.cockroachdb' }],
        listBackupRuns: async () => [], listBackupRestoreRuns: async () => [], listBackupCockroachDbRestoreRuns: async () => structuredClone(window.__restores),
        listBackupVerificationRuns: async () => [], listBackupCockroachDbVerificationRuns: async () => structuredClone(window.__verifications),
        getBackupWorkerStatus: async () => ({ online: true, state: 'online' })
      }});
      loadBackupRecoveryPoints = async () => {};
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [structuredClone(window.__point)];
      state.backupRecovery.totalPoints = 1;
      state.backupRecovery.selectedPointId = 'point-cockroach-native';
      state.backupCockroachDbConnections = structuredClone(window.__connections);
      state.backupJobs = [{ id: 'job-cockroach', name: 'Production CockroachDB protection', sourceId: 'source-cockroach', sourceAdapterId: 'deployerx.database.cockroachdb' }];
      true;
    `);

    const workflow = await window.webContents.executeJavaScript(`(async () => {
      const missing = ${JSON.stringify(REQUIRED_HOOKS)}.filter((name) => typeof window[name] !== 'function');
      const requiredIds = ['backupCockroachDbRestoreModal', 'backupCockroachDbRetentionModal', 'backupCockroachDbScheduleModal', 'backupActivityDetailModal'];
      if (missing.length || requiredIds.some((id) => !document.getElementById(id))) return { ready: false, missing, missingIds: requiredIds.filter((id) => !document.getElementById(id)) };
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const recovery = { action: els.backupRecoveryRestoreButton.innerText, entries: els.backupRecoveryEntryList.innerText };

      await openBackupCockroachDbRestore();
      els.backupCockroachDbRestoreDatabase.value = 'recovered_accounts';
      await previewBackupCockroachDbRestore();
      const restorePreview = els.backupCockroachDbRestorePreview.innerText;
      const restoreConfirmation = els.backupCockroachDbRestoreConfirmationText.innerText;
      els.backupCockroachDbRestoreConfirmation.value = restoreConfirmation;
      els.backupCockroachDbRestoreConfirmation.dispatchEvent(new Event('input', { bubbles: true }));
      await startBackupCockroachDbRestore(new Event('submit', { cancelable: true }));
      const restoreStatus = els.backupCockroachDbRestoreStatus.innerText;

      await openBackupCockroachDbRetention();
      await previewBackupCockroachDbRetention();
      const retentionPreview = els.backupCockroachDbRetentionPreview.innerText;
      els.backupCockroachDbRetentionConfirmation.value = 'DELETE COCKROACHDB REPOSITORY COPIES';
      els.backupCockroachDbRetentionConfirmation.dispatchEvent(new Event('input', { bubbles: true }));
      await executeBackupCockroachDbRetention(new Event('submit', { cancelable: true }));
      const retentionStatus = els.backupCockroachDbRetentionStatus.innerText;

      await openBackupCockroachDbSchedule('job-cockroach');
      await previewBackupCockroachDbSchedule();
      const schedulePreview = els.backupCockroachDbSchedulePreview.innerText;
      const schedulePreviewPolicy = structuredClone(window.__calls.schedulePreview.policy);
      await createBackupCockroachDbSchedule(new Event('submit', { cancelable: true }));
      const scheduleStatus = els.backupCockroachDbScheduleStatus.innerText;

      await startBackupCockroachDbMetadataTest();
      const metadataToast = els.toast.innerText;
      await openBackupCockroachDbRestore();
      els.backupCockroachDbRestoreDatabase.value = 'recovery_drill_accounts';
      await previewBackupCockroachDbRestore();
      els.backupCockroachDbRestoreAsTest.checked = true;
      els.backupCockroachDbRestoreAsTest.dispatchEvent(new Event('change', { bubbles: true }));
      const drillConfirmation = els.backupCockroachDbRestoreConfirmationText.innerText;
      els.backupCockroachDbRestoreConfirmation.value = drillConfirmation;
      els.backupCockroachDbRestoreConfirmation.dispatchEvent(new Event('input', { bubbles: true }));
      await startBackupCockroachDbRestore(new Event('submit', { cancelable: true }));
      const drillStatus = els.backupCockroachDbRestoreStatus.innerText;

      state.backupRecovery.activeVerification = { id: 'verification-cockroach-cancel', state: 'running', mode: 'cockroachdb-full-drill' };
      await cancelOrCloseBackupCockroachDbRestore();
      const drillCancelStatus = els.backupCockroachDbRestoreStatus.innerText;
      state.backupRecovery.activeRestore = { id: 'restore-cockroach-cancel', state: 'running', target: { engine: 'cockroachdb', mode: 'alternate' } };
      await controlBackupCockroachDbRestore('cancel');
      const restoreCancelState = state.backupRecovery.activeRestore.state;
      const restoreCancelStatus = els.backupCockroachDbRestoreStatus.innerText;

      await loadBackupActivity();
      const activityText = els.backupActivityList.innerText;
      await openBackupActivityDetail('restore', 'restore-cockroach-1');
      const restoreDetail = els.backupActivityDetailModal.innerText;
      closeBackupActivityDetail();
      await openBackupActivityDetail('verification', 'verification-cockroach-2');
      const drillDetail = els.backupActivityDetailModal.innerText;
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
      return { ready: true, recovery, restorePreview, restoreConfirmation, restoreStatus, restoreCancelState, restoreCancelStatus, retentionPreview, retentionStatus, schedulePreview, schedulePreviewPolicy, scheduleStatus, metadataToast, drillConfirmation, drillStatus, drillCancelStatus, activityText, restoreDetail, drillDetail, calls: structuredClone(window.__calls), duplicateIds: ids.length - new Set(ids).size };
    })()`);
    if (!workflow.ready) throw new Error(`Missing CockroachDB renderer hooks: ${[...workflow.missing, ...workflow.missingIds].join(', ')}`);

    const desktop = await window.webContents.executeJavaScript(`(() => {
      const box = (id) => { const rect = document.getElementById(id).querySelector('.modal-card').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
      return { width: innerWidth, height: innerHeight, restore: box('backupCockroachDbRestoreModal'), retention: box('backupCockroachDbRetentionModal'), schedule: box('backupCockroachDbScheduleModal'), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    window.setSize(390, 844);
    await wait(150);
    const mobile = await window.webContents.executeJavaScript(`(async () => {
      const box = (id) => { const rect = document.getElementById(id).querySelector('.modal-card').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
      await openBackupCockroachDbRestore();
      const restoreBody = els.backupCockroachDbRestoreModal.querySelector('.modal-body');
      const restore = box('backupCockroachDbRestoreModal');
      els.backupCockroachDbRestoreModal.classList.add('hidden');
      await openBackupCockroachDbRetention();
      const retentionBody = els.backupCockroachDbRetentionModal.querySelector('.modal-body');
      const retention = box('backupCockroachDbRetentionModal');
      els.backupCockroachDbRetentionModal.classList.add('hidden');
      await openBackupCockroachDbSchedule('job-cockroach');
      const scheduleBody = els.backupCockroachDbScheduleModal.querySelector('.modal-body');
      const schedule = box('backupCockroachDbScheduleModal');
      els.toast.classList.remove('visible'); els.toast.style.display = 'none';
      return { width: innerWidth, height: innerHeight, restore, retention, schedule, restoreScrollable: restoreBody.scrollHeight > restoreBody.clientHeight, retentionScrollable: retentionBody.scrollHeight > retentionBody.clientHeight, scheduleScrollable: scheduleBody.scrollHeight > scheduleBody.clientHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);

    const publicText = JSON.stringify({ workflow: { recovery: workflow.recovery, restorePreview: workflow.restorePreview, restoreStatus: workflow.restoreStatus, retentionPreview: workflow.retentionPreview, retentionStatus: workflow.retentionStatus, schedulePreview: workflow.schedulePreview, scheduleStatus: workflow.scheduleStatus, metadataToast: workflow.metadataToast, drillStatus: workflow.drillStatus, activityText: workflow.activityText, restoreDetail: workflow.restoreDetail, drillDetail: workflow.drillDetail } });
    const secrets = ['C:\\private\\cockroach-data', 's3://private-cockroach-repository', 'C:\\private\\cockroach-stage', 'cockroach-private.internal.example', 'PRIVATE_COCKROACHDB_PASSWORD', 'sha256:' + 'b'.repeat(64)];
    const redacted = !secrets.some((secret) => publicText.includes(secret));
    const restorePayload = workflow.calls.restore;
    const [metadataPayload, drillPayload] = workflow.calls.verifications;
    const valid = workflow.recovery.action.includes('Recover alternate CockroachDB') && workflow.recovery.entries.includes('authenticated native chain')
      && workflow.restorePreview.includes('Validated 1 recovery point') && workflow.restorePreview.includes('target database is empty') && workflow.restoreConfirmation === 'RECOVER COCKROACHDB ALTERNATE DATABASE'
      && restorePayload?.recoveryPointId === 'point-cockroach-native' && restorePayload?.targetConnectionId === 'connection-cockroach-alternate' && restorePayload?.targetDatabase === 'recovered_accounts' && restorePayload?.mode === 'alternate' && restorePayload?.confirmed === true && restorePayload?.confirmationText === 'RECOVER COCKROACHDB ALTERNATE DATABASE'
      && workflow.restoreStatus.includes('complete') && workflow.restoreStatus.includes('native job succeeded') && workflow.restoreStatus.includes('alternate target preserved')
      && workflow.calls.retentionPreview?.sourceId === 'source-cockroach' && workflow.calls.retention?.planId === 'retention-cockroach-1' && workflow.retentionPreview.includes('descendant-first deletion order verified') && workflow.retentionStatus.includes('2 metadata copies pruned')
      && workflow.calls.schedulePreview?.jobId === 'job-cockroach' && workflow.calls.schedule?.jobId === 'job-cockroach' && workflow.schedulePreview.includes('2 schedule record(s)') && workflow.scheduleStatus.includes('Native schedule created')
      && JSON.stringify(workflow.schedulePreviewPolicy) === JSON.stringify(workflow.calls.schedule.policy)
      && metadataPayload?.mode === 'cockroachdb-metadata' && metadataPayload?.recoveryPointId === 'point-cockroach-native' && !Object.hasOwn(metadataPayload, 'targetDatabase')
      && drillPayload?.mode === 'cockroachdb-full-drill' && drillPayload?.targetDatabase === 'recovery_drill_accounts' && drillPayload?.confirmed === true && drillPayload?.confirmationText === 'RUN COCKROACHDB RECOVERY DRILL' && workflow.drillStatus.includes('full alternate-target recovery test')
      && workflow.calls.verificationCancel === 'verification-cockroach-cancel' && workflow.drillCancelStatus.includes('Recovery test canceled') && workflow.drillCancelStatus.includes('cleanup and rollback are not claimed')
      && workflow.calls.restoreCancel === 'restore-cockroach-cancel' && workflow.restoreCancelState === 'canceled' && workflow.restoreCancelStatus.includes('canceled')
      && workflow.metadataToast.includes('metadata recovery test passed') && workflow.activityText.includes('CockroachDB') && workflow.restoreDetail.includes('recovered_accounts') && workflow.drillDetail.includes('recovery_drill_accounts')
      && redacted && workflow.duplicateIds === 0 && !desktop.overflow && contained(desktop.restore, desktop) && contained(desktop.retention, desktop) && contained(desktop.schedule, desktop)
      && mobile.width <= 390 && !mobile.overflow && contained(mobile.restore, mobile) && contained(mobile.retention, mobile) && contained(mobile.schedule, mobile);
    process.stdout.write(`${JSON.stringify({ ok: valid, workflow: { ...workflow, calls: { restore: Boolean(workflow.calls.restore), restoreCancel: Boolean(workflow.calls.restoreCancel), retention: Boolean(workflow.calls.retention), schedule: Boolean(workflow.calls.schedule), verificationCount: workflow.calls.verifications.length, verificationCancel: Boolean(workflow.calls.verificationCancel) } }, desktop, mobile, redacted })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode || 0);
  }
});
