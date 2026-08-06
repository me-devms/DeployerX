const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const readiness = {
  checkedAt: '2026-08-03T12:00:00.000Z',
  sources: [
    { id: 'src_ready', name: 'Production application', revision: 3, sourceType: 'files', adapterId: 'deployerx.files.ssh', connectionName: 'Production server', rootCount: 3, readiness: { ready: true, message: 'Ready' } },
    { id: 'src_blocked', name: 'Retired server files', revision: 1, sourceType: 'files', adapterId: 'deployerx.files.ssh', connectionName: 'Retired server', rootCount: 1, readiness: { ready: false, message: 'Test the source connection successfully before creating a job.' } }
  ],
  repositories: [
    { id: 'repo_primary', name: 'Primary local archive', revision: 2, adapterId: 'deployerx.repository.local-folder', adapterVersion: '1.0.0', engineId: 'deployerx.file-repository', engineVersion: '1.0.0', location: { path: 'D:\\Backups' }, capacity: { reporting: 'exact', freeBytes: 536870912000 }, health: { status: 'ready', lockState: { status: 'available' } }, readiness: { ready: true, message: 'Ready' } },
    { id: 'repo_copy', name: 'Offsite object archive', revision: 4, adapterId: 'deployerx.repository.s3', adapterVersion: '1.0.0', engineId: 'deployerx.file-repository', engineVersion: '1.0.0', location: { bucket: 'production-backups', prefix: 'applications' }, capacity: { reporting: 'unavailable', freeBytes: null }, health: { status: 'ready', lockState: { status: 'available' } }, readiness: { ready: true, message: 'Ready' } },
    { id: 'repo_blocked', name: 'Unavailable SFTP archive', revision: 1, adapterId: 'deployerx.repository.sftp', location: { path: '/srv/backups' }, health: { status: 'needs-attention', lockState: { status: 'unavailable' } }, readiness: { ready: false, message: 'Test the repository successfully before creating a job.' } }
  ]
};
const readinessEncoded = Buffer.from(JSON.stringify(readiness)).toString('base64');

async function prepare(window) {
  return window.webContents.executeJavaScript(`
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    window.__createdBackupJobPayload = null;
    window.__backupJobRows = [];
    window.__backupRuns = [];
    window.__jobLifecycleCalls = [];
    window.__runLifecycleCalls = [];
    window.__backupWorkerStatus = { online: true, state: 'online', heartbeatAt: '2026-08-03T12:00:00.000Z', nextRunAt: '2026-08-04T01:30:00.000Z' };
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      getBackupJobReadiness: async () => JSON.parse(atob('${readinessEncoded}')),
      listBackupJobs: async () => window.__backupJobRows,
      listBackupRuns: async () => window.__backupRuns,
      getBackupWorkerStatus: async () => window.__backupWorkerStatus,
      runBackupJob: async (jobId) => {
        const run = {
          id: 'run_active', jobId, state: 'running', attempt: 1, resumable: false, createdAt: '2026-08-03T12:01:00.000Z',
          progress: { phase: 'transferring', sourceBytes: 10485760, bytesRead: 5242880, throughputBytesPerSecond: 1048576, bandwidthLimitBytesPerSecond: 2097152, throttleWaitMilliseconds: 2500, repositoryCount: 2, committedRepositories: 1 }
        };
        window.__backupRuns = [run];
        return run;
      },
      resumeBackupRun: async (runId) => {
        const run = {
          id: 'run_resumed', jobId: 'job_created', state: 'queued', priority: 'high', attempt: 2, parentRunId: runId, resumable: false, createdAt: '2026-08-03T12:02:00.000Z',
          progress: { phase: 'queued', sourceBytes: 10485760, bytesRead: 5242880, throughputBytesPerSecond: 0, repositoryCount: 2, committedRepositories: 1 }
        };
        window.__backupRuns = [run, ...window.__backupRuns];
        return run;
      },
      cancelBackupRun: async (runId) => {
        window.__runLifecycleCalls.push({ command: 'cancel', runId });
        const current = window.__backupRuns.find((run) => run.id === runId);
        const run = { ...current, state: 'canceled', resumable: false, finishedAt: '2026-08-03T12:03:00.000Z', progress: { ...current.progress, phase: 'canceled' }, cancellation: { requestedAt: '2026-08-03T12:03:00.000Z', requestedBy: 'tester', acknowledgedAt: '2026-08-03T12:03:00.000Z' } };
        window.__backupRuns = [run, ...window.__backupRuns.filter((candidate) => candidate.id !== runId)];
        return run;
      },
      retryBackupRun: async (runId) => {
        window.__runLifecycleCalls.push({ command: 'retry', runId });
        const run = { id: 'run_retry', jobId: 'job_created', state: 'queued', trigger: 'retry', retryOfRunId: runId, priority: 'high', attempt: 1, resumable: false, createdAt: '2026-08-03T12:04:00.000Z', progress: { phase: 'queued', sourceBytes: 0, bytesRead: 0, repositoryCount: 2, committedRepositories: 0 } };
        window.__backupRuns = [run, ...window.__backupRuns];
        return run;
      },
      pauseBackupJob: async (id, revision) => {
        window.__jobLifecycleCalls.push({ command: 'pause', id, revision });
        const row = window.__backupJobRows.find((candidate) => candidate.id === id);
        Object.assign(row, { state: 'paused', revision: revision + 1 });
        return structuredClone(row);
      },
      resumeBackupJob: async (id, revision) => {
        window.__jobLifecycleCalls.push({ command: 'resume', id, revision });
        const row = window.__backupJobRows.find((candidate) => candidate.id === id);
        Object.assign(row, { state: 'enabled', revision: revision + 1 });
        return structuredClone(row);
      },
      cloneBackupJob: async (id, revision, name) => {
        window.__jobLifecycleCalls.push({ command: 'clone', id, revision, name: name || null });
        const original = window.__backupJobRows.find((candidate) => candidate.id === id);
        const row = { ...structuredClone(original), id: 'job_clone', revision: 1, name: name || original.name + ' copy', state: 'enabled', nextRunAt: '2026-08-04T01:30:00.000Z' };
        window.__backupJobRows.push(row);
        return { job: structuredClone(row), policy: structuredClone(row.policy) };
      },
      disableBackupJob: async (id, revision) => {
        window.__jobLifecycleCalls.push({ command: 'disable', id, revision });
        const row = window.__backupJobRows.find((candidate) => candidate.id === id);
        Object.assign(row, { state: 'disabled', revision: revision + 1 });
        return structuredClone(row);
      },
      deleteBackupJob: async (id, revision) => {
        window.__jobLifecycleCalls.push({ command: 'delete', id, revision });
        window.__backupJobRows = window.__backupJobRows.filter((candidate) => candidate.id !== id);
        return { id, deleted: true, policyDeleted: true };
      },
      createBackupJob: async (payload) => {
        window.__createdBackupJobPayload = payload;
        const row = {
          id: 'job_created', revision: 1, name: payload.name, state: 'enabled', ready: true,
          source: { name: 'Production application' }, policy: { backupMode: payload.backupMode, schedule: payload.schedule, retention: payload.retention },
          repositories: payload.repositoryIds.map((repositoryId, index) => ({ repositoryId, role: index ? 'copy' : 'primary' })),
          nextRunAt: '2026-08-04T01:30:00.000Z'
        };
        window.__backupJobRows = [row];
        return { job: row, policy: row.policy };
      }
    }});
    showView('backup');
    true;
  `);
}

async function measureEmptyJobs(window) {
  return window.webContents.executeJavaScript(`(async () => {
    setBackupManagerTab('jobs');
    await loadBackupJobs();
    const content = document.querySelector('.backup-manager-content').getBoundingClientRect();
    const panel = document.getElementById('backupPanelJobs').getBoundingClientRect();
    const heading = document.querySelector('#backupPanelJobs > .backup-panel-heading').getBoundingClientRect();
    const empty = document.getElementById('backupJobsEmpty').getBoundingClientRect();
    document.getElementById('toast')?.classList.remove('visible');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      content: { top: content.top, bottom: content.bottom, height: content.height },
      panel: { top: panel.top, bottom: panel.bottom, height: panel.height },
      heading: { top: heading.top, bottom: heading.bottom, height: heading.height },
      empty: { top: empty.top, bottom: empty.bottom, height: empty.height },
      emptyVisible: !document.getElementById('backupJobsEmpty').classList.contains('hidden'),
      listHidden: document.getElementById('backupJobList').classList.contains('hidden'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

async function completeToReview(window) {
  return window.webContents.executeJavaScript(`(async () => {
    await openBackupJobModal();
    advanceBackupJobStep();
    const emptyBlocked = !document.getElementById('backupJobError').classList.contains('hidden') && state.backupJobWizard.step === 0;
    document.getElementById('backupJobName').value = 'Production application protection';
    advanceBackupJobStep();
    document.querySelector('[data-backup-job-source][value="src_ready"]').checked = true;
    advanceBackupJobStep();
    document.querySelector('[data-backup-job-repository][value="repo_primary"]').checked = true;
    document.querySelector('[data-backup-job-repository][value="repo_copy"]').checked = true;
    advanceBackupJobStep();
    document.querySelector('input[name="backupJobMode"][value="incremental"]').checked = true;
    document.getElementById('backupJobKeepLast').value = '14';
    document.getElementById('backupJobKeepHourly').value = '24';
    document.getElementById('backupJobKeepDaily').value = '14';
    document.getElementById('backupJobKeepWeekly').value = '8';
    document.getElementById('backupJobKeepMonthly').value = '12';
    document.getElementById('backupJobKeepYearly').value = '7';
    document.getElementById('backupJobCompression').value = 'fast';
    document.getElementById('backupJobPriority').value = 'high';
    document.getElementById('backupJobRpoMinutes').value = '60';
    document.getElementById('backupJobRtoMinutes').value = '30';
    document.getElementById('backupJobRetryAttempts').value = '5';
    document.getElementById('backupJobRetryBackoff').value = 'linear';
    document.getElementById('backupJobRetryInitialDelay').value = '45';
    document.getElementById('backupJobRetryMaximumDelay').value = '600';
    document.getElementById('backupJobRetryJitter').value = '10';
    document.getElementById('backupJobBandwidthLimit').value = '2';
    document.getElementById('backupJobBandwidthWindowEnabled').checked = true;
    document.getElementById('backupJobBandwidthStart').value = '23:00';
    document.getElementById('backupJobBandwidthEnd').value = '06:00';
    document.getElementById('backupJobBandwidthWindowLimit').value = '0.5';
    document.getElementById('backupJobVerify').checked = true;
    const scheduleType = document.getElementById('backupJobScheduleType');
    const scheduleTypeCount = scheduleType.options.length;
    scheduleType.value = 'weekly';
    syncBackupJobScheduleFields();
    const weeklyVisible = !document.getElementById('backupJobScheduleWeekly').classList.contains('hidden');
    scheduleType.value = 'daily';
    document.getElementById('backupJobDailyTime').value = '01:30';
    document.getElementById('backupJobTimezone').value = 'America/New_York';
    document.getElementById('backupJobDstNonexistent').value = 'skip';
    document.getElementById('backupJobDstAmbiguous').value = 'second';
    document.getElementById('backupJobMissedRun').value = 'run-latest';
    document.getElementById('backupJobMissedGrace').value = '20';
    document.getElementById('backupJobMaintenanceEnabled').checked = true;
    document.getElementById('backupJobMaintenanceStart').value = '22:00';
    document.getElementById('backupJobMaintenanceEnd').value = '04:00';
    document.getElementById('backupJobMaintenanceBehavior').value = 'defer';
    document.getElementById('backupJobBlackoutEnabled').checked = true;
    document.getElementById('backupJobBlackoutStart').value = '2026-12-24T00:00';
    document.getElementById('backupJobBlackoutEnd').value = '2026-12-26T00:00';
    document.getElementById('backupJobBlackoutBehavior').value = 'skip';
    syncBackupJobScheduleFields();
    const dstVisible = !document.getElementById('backupJobDstPolicy').classList.contains('hidden');
    const maintenanceVisible = !document.getElementById('backupJobMaintenanceFields').classList.contains('hidden');
    const blackoutVisible = !document.getElementById('backupJobBlackoutFields').classList.contains('hidden');
    const bandwidthVisible = !document.getElementById('backupJobBandwidthWindowFields').classList.contains('hidden');
    advanceBackupJobStep();
    return {
      emptyBlocked,
      step: state.backupJobWizard.step,
      scheduleTypeCount,
      weeklyVisible,
      timezoneCount: document.getElementById('backupJobTimezone').options.length,
      dstVisible,
      maintenanceVisible,
      blackoutVisible,
      bandwidthVisible,
      disabledSource: document.querySelector('[data-backup-job-source][value="src_blocked"]').disabled,
      disabledRepository: document.querySelector('[data-backup-job-repository][value="repo_blocked"]').disabled,
      reviewText: document.getElementById('backupJobReview').innerText,
      readinessText: document.getElementById('backupJobReadiness').innerText
    };
  })()`);
}

async function measureModal(window) {
  return window.webContents.executeJavaScript(`(() => {
    const modal = document.getElementById('backupJobModal');
    const card = modal.querySelector('.modal-card').getBoundingClientRect();
    const controls = [...modal.querySelectorAll('input, select, button')].filter((control) => {
      const style = getComputedStyle(control);
      return style.display !== 'none' && control.getBoundingClientRect().width > 0;
    }).map((control) => {
      const rect = control.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
      controls,
      bodyScrollable: modal.querySelector('.modal-body').scrollHeight > modal.querySelector('.modal-body').clientHeight,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

async function measureJobRow(window) {
  return window.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('backupPanelJobs').getBoundingClientRect();
    const row = document.querySelector('#backupJobList .backup-job-row');
    const bounds = row?.getBoundingClientRect();
    const action = row?.querySelector('.backup-job-actions button');
    const actionBounds = action?.getBoundingClientRect();
    const buttons = [...(row?.querySelectorAll('.backup-job-actions button') || [])].map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, disabled: button.disabled, label: button.getAttribute('aria-label') };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      panel: { left: panel.left, right: panel.right },
      row: bounds ? { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom } : null,
      action: actionBounds ? { left: actionBounds.left, right: actionBounds.right, top: actionBounds.top, bottom: actionBounds.bottom, disabled: action.disabled } : null,
      buttons,
      text: row?.innerText || '',
      progressVisible: Boolean(row?.querySelector('.backup-job-progress')),
      workerText: document.getElementById('backupWorkerStatus')?.innerText || '',
      workerOnline: document.getElementById('backupWorkerStatus')?.classList.contains('online') || false,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-jobs-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`));
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);
    window.setSize(1279, 800);
    window.setSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const emptyDesktop = await measureEmptyJobs(window);
    const emptyDesktopPath = path.join(captureRoot, 'backup-jobs-empty-desktop.png');
    await fs.writeFile(emptyDesktopPath, (await window.webContents.capturePage()).toPNG());
    const review = await completeToReview(window);
    window.setSize(1279, 800);
    window.setSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const desktop = await measureModal(window);
    const desktopPath = path.join(captureRoot, 'backup-job-review-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    window.setSize(390, 844);
    window.setSize(389, 844);
    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mobile = await measureModal(window);
    const mobilePath = path.join(captureRoot, 'backup-job-review-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    const weeklyMobile = await window.webContents.executeJavaScript(`(() => {
      state.backupJobWizard.step = 3;
      renderBackupJobStep();
      const type = document.getElementById('backupJobScheduleType');
      type.value = 'weekly';
      syncBackupJobScheduleFields();
      const body = document.querySelector('#backupJobModal .modal-body');
      body.scrollTop = body.scrollHeight;
      const card = document.getElementById('backupJobModal').querySelector('.modal-card').getBoundingClientRect();
      const editor = document.querySelector('.backup-job-schedule-editor').getBoundingClientRect();
      const controls = [...document.querySelectorAll('[data-backup-job-step="3"] input, [data-backup-job-step="3"] select')].filter((control) => {
        const style = getComputedStyle(control);
        return style.display !== 'none' && control.getBoundingClientRect().width > 0;
      }).map((control) => {
        const rect = control.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      return {
        visible: !document.getElementById('backupJobScheduleWeekly').classList.contains('hidden'),
        card: { left: card.left, right: card.right }, editor: { left: editor.left, right: editor.right }, controls,
        weekdayCount: document.querySelectorAll('[data-backup-job-weekday]').length,
        maintenanceDayCount: document.querySelectorAll('[data-backup-job-maintenance-day]').length,
        bandwidthDayCount: document.querySelectorAll('[data-backup-job-bandwidth-day]').length,
        dstVisible: !document.getElementById('backupJobDstPolicy').classList.contains('hidden'),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    const weeklyMobilePath = path.join(captureRoot, 'backup-job-weekly-mobile.png');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await fs.writeFile(weeklyMobilePath, (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`
      document.getElementById('backupJobScheduleType').value = 'daily';
      document.getElementById('backupJobDailyTime').value = '01:30';
      syncBackupJobScheduleFields();
      state.backupJobWizard.step = 4;
      renderBackupJobStep();
    `);

    const submitted = await window.webContents.executeJavaScript(`(async () => {
      await createBackupJob(new Event('submit', { cancelable: true }));
      const row = document.querySelector('#backupJobList .backup-source-row');
      return {
        payload: window.__createdBackupJobPayload,
        modalClosed: document.getElementById('backupJobModal').classList.contains('hidden'),
        jobsTabActive: document.getElementById('backupTabJobs').classList.contains('active'),
        rowText: row?.innerText || '',
        emptyHidden: document.getElementById('backupJobsEmpty').classList.contains('hidden'),
        rowBounds: row ? { left: row.getBoundingClientRect().left, right: row.getBoundingClientRect().right } : null,
        panelBounds: { left: document.getElementById('backupPanelJobs').getBoundingClientRect().left, right: document.getElementById('backupPanelJobs').getBoundingClientRect().right },
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);

    await window.webContents.executeJavaScript(`runBackupJob('job_created')`);
    window.setSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const activeDesktop = await measureJobRow(window);
    const activeDesktopPath = path.join(captureRoot, 'backup-job-running-desktop.png');
    await fs.writeFile(activeDesktopPath, (await window.webContents.capturePage()).toPNG());
    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await window.webContents.executeJavaScript(`
      document.getElementById('toast')?.classList.remove('visible');
      document.querySelector('.app-topbar')?.style.setProperty('display', 'none', 'important');
      document.querySelector('.sidebar')?.style.setProperty('display', 'none', 'important');
      document.querySelector('#backupManagerView > .view-header')?.style.setProperty('display', 'none', 'important');
    `);
    window.setSize(389, 844);
    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const activeMobile = await measureJobRow(window);
    const activeMobilePath = path.join(captureRoot, 'backup-job-running-mobile.png');
    await fs.writeFile(activeMobilePath, (await window.webContents.capturePage()).toPNG());

    const resumed = await window.webContents.executeJavaScript(`(async () => {
      window.__backupRuns[0] = { ...window.__backupRuns[0], state: 'interrupted', resumable: true, retryState: { notBefore: '2026-08-03T12:10:00.000Z', nextAttempt: 2 }, progress: { ...window.__backupRuns[0].progress, phase: 'interrupted' } };
      await loadBackupJobs();
      const resumeBefore = document.querySelector('[data-backup-resume-run]')?.title || '';
      const interruptedText = document.querySelector('#backupJobList .backup-job-row')?.innerText || '';
      await resumeBackupRun('run_active');
      const row = document.querySelector('#backupJobList .backup-job-row');
      return { resumeBefore, interruptedText, text: row?.innerText || '', actionDisabled: Boolean(row?.querySelector('[data-backup-run-job]')?.disabled) };
    })()`);

    const deferred = await window.webContents.executeJavaScript(`(async () => {
      window.__backupJobRows[0].scheduleState = {
        lastCalendarDecision: { action: 'defer', reasonCode: 'OUTSIDE_MAINTENANCE_WINDOW' },
        nextDispatchAttemptAt: '2026-08-05T02:00:00.000Z'
      };
      await loadBackupJobs();
      return document.querySelector('#backupJobList .backup-job-row')?.innerText || '';
    })()`);

    const offline = await window.webContents.executeJavaScript(`(async () => {
      window.__backupWorkerStatus = { online: false, state: 'offline', heartbeatAt: '2026-08-03T11:59:00.000Z', nextRunAt: '2026-08-04T01:30:00.000Z' };
      await loadBackupJobs();
      const status = document.getElementById('backupWorkerStatus');
      return { text: status?.innerText || '', offline: status?.classList.contains('offline') || false, online: status?.classList.contains('online') || false };
    })()`);

    const lifecycle = await window.webContents.executeJavaScript(`(async () => {
      confirmDangerousAction = async () => true;
      await cancelBackupRun('run_resumed');
      const canceledText = document.querySelector('[data-backup-job-id="job_created"]')?.innerText || '';
      const retryVisible = Boolean(document.querySelector('[data-backup-retry-run="run_resumed"]'));
      await retryBackupRun('run_resumed');
      const retryText = document.querySelector('[data-backup-job-id="job_created"]')?.innerText || '';
      window.__backupRuns[0] = { ...window.__backupRuns[0], state: 'succeeded', finishedAt: '2026-08-03T12:05:00.000Z', progress: { ...window.__backupRuns[0].progress, phase: 'completed' } };
      await changeBackupJobState('job_created', 'pause');
      const pausedText = document.querySelector('[data-backup-job-id="job_created"]')?.innerText || '';
      await changeBackupJobState('job_created', 'resume');
      await cloneBackupJob('job_created');
      const cloneText = document.querySelector('[data-backup-job-id="job_clone"]')?.innerText || '';
      await disableBackupJob('job_created');
      const disabledRow = document.querySelector('[data-backup-job-id="job_created"]');
      const disabledText = disabledRow?.innerText || '';
      const deleteEnabled = !disabledRow?.querySelector('[data-backup-job-delete]')?.disabled;
      const pauseDisabled = Boolean(disabledRow?.querySelector('[data-backup-job-pause]')?.disabled);
      const beforeDeleteCount = window.__backupJobRows.length;
      await deleteBackupJob('job_created');
      return {
        canceledText, retryVisible, retryText, pausedText, cloneText, disabledText, deleteEnabled, pauseDisabled, beforeDeleteCount,
        afterDeleteCount: window.__backupJobRows.length,
        originalVisible: Boolean(document.querySelector('[data-backup-job-id="job_created"]')),
        cloneVisible: Boolean(document.querySelector('[data-backup-job-id="job_clone"]')),
        jobCalls: structuredClone(window.__jobLifecycleCalls), runCalls: structuredClone(window.__runLifecycleCalls)
      };
    })()`);

    const modalFits = (measurement) => measurement.card.left >= 0 && measurement.card.right <= measurement.viewport.width
      && measurement.card.top >= 0 && measurement.card.bottom <= measurement.viewport.height
      && measurement.controls.every((control) => control.left >= measurement.card.left && control.right <= measurement.card.right + 1)
      && !measurement.horizontalOverflow;
    const valid = emptyDesktop.emptyVisible && emptyDesktop.listHidden && !emptyDesktop.horizontalOverflow
      && emptyDesktop.empty.top <= emptyDesktop.heading.bottom + 1
      && Math.abs(emptyDesktop.empty.bottom - emptyDesktop.panel.bottom) <= 1
      && emptyDesktop.empty.height >= emptyDesktop.panel.height - emptyDesktop.heading.height - 1
      && emptyDesktop.panel.bottom <= emptyDesktop.content.bottom + 1
      && emptyDesktop.empty.height >= 360
      && review.emptyBlocked && review.step === 4 && review.disabledSource && review.disabledRepository
      && review.reviewText.includes('Production application protection') && review.reviewText.includes('Primary local archive, Offsite object archive')
      && review.reviewText.includes('Incremental, keep 14 recovery points') && review.reviewText.includes('Daily at 01:30 America/New_York')
      && review.reviewText.includes('Retain last 14, 24 hourly, 14 daily, 8 weekly, 12 monthly, 7 yearly (America/New_York)')
      && review.reviewText.includes('high priority, 5 attempts, linear backoff') && review.reviewText.includes('2 MiB/s default, weekly limit enabled')
      && review.reviewText.includes('run latest, 20m grace - maintenance window - blackout')
      && review.readinessText.includes('2 repositories are ready') && review.scheduleTypeCount === 7 && review.weeklyVisible
      && review.timezoneCount > 100 && review.dstVisible && review.maintenanceVisible && review.blackoutVisible && review.bandwidthVisible
      && modalFits(desktop) && modalFits(mobile)
      && weeklyMobile.visible && weeklyMobile.weekdayCount === 7 && weeklyMobile.maintenanceDayCount === 7 && weeklyMobile.bandwidthDayCount === 7 && weeklyMobile.dstVisible && !weeklyMobile.overflow
      && weeklyMobile.editor.left >= weeklyMobile.card.left && weeklyMobile.editor.right <= weeklyMobile.card.right + 1
      && weeklyMobile.controls.every((control) => control.left >= weeklyMobile.card.left && control.right <= weeklyMobile.card.right + 1)
      && submitted.payload?.name === 'Production application protection'
      && submitted.payload?.sourceId === 'src_ready'
      && JSON.stringify(submitted.payload?.repositoryIds) === JSON.stringify(['repo_primary', 'repo_copy'])
      && submitted.payload?.keepLast === 14 && submitted.payload?.compression === 'fast' && submitted.payload?.verifyAfterBackup === true
      && submitted.payload?.rpoMinutes === 60 && submitted.payload?.rtoMinutes === 30
      && submitted.payload?.retention?.keepLast === 14 && submitted.payload?.retention?.hourly === 24 && submitted.payload?.retention?.daily === 14
      && submitted.payload?.retention?.weekly === 8 && submitted.payload?.retention?.monthly === 12 && submitted.payload?.retention?.yearly === 7
      && submitted.payload?.retention?.timezone === 'America/New_York'
      && submitted.payload?.priority === 'high' && submitted.payload?.retry?.maximumAttempts === 5 && submitted.payload?.retry?.backoff === 'linear'
      && submitted.payload?.retry?.initialDelaySeconds === 45 && submitted.payload?.retry?.maximumDelaySeconds === 600 && submitted.payload?.retry?.jitterPercent === 10
      && submitted.payload?.bandwidth?.timezone === 'America/New_York' && submitted.payload?.bandwidth?.defaultLimitBytesPerSecond === 2097152
      && submitted.payload?.bandwidth?.windows?.[0]?.startTime === '23:00' && submitted.payload?.bandwidth?.windows?.[0]?.endTime === '06:00' && submitted.payload?.bandwidth?.windows?.[0]?.limitBytesPerSecond === 524288
      && submitted.payload?.schedule?.type === 'daily' && submitted.payload?.schedule?.time === '01:30'
      && submitted.payload?.schedule?.timezone === 'America/New_York'
      && submitted.payload?.schedule?.dstBehavior?.nonexistentTime === 'skip' && submitted.payload?.schedule?.dstBehavior?.ambiguousTime === 'second'
      && submitted.payload?.schedule?.missedRun?.behavior === 'run-latest' && submitted.payload?.schedule?.missedRun?.graceMinutes === 20
      && submitted.payload?.schedule?.executionCalendar?.maintenanceWindows?.[0]?.startTime === '22:00'
      && submitted.payload?.schedule?.executionCalendar?.blackouts?.[0]?.startsAt === '2026-12-24T00:00:00.000Z'
      && submitted.payload?.schedule?.executionCalendar?.blackoutBehavior === 'skip'
      && submitted.modalClosed && submitted.jobsTabActive && submitted.emptyHidden
      && submitted.rowText.includes('Production application protection') && submitted.rowText.includes('2 destinations') && submitted.rowText.includes('Retain last 14, 24 hourly, 14 daily, 8 weekly, 12 monthly, 7 yearly') && submitted.rowText.includes('Daily at 01:30 America/New_York') && submitted.rowText.includes('Next ')
      && submitted.rowBounds?.left >= submitted.panelBounds.left && submitted.rowBounds?.right <= submitted.panelBounds.right + 1 && !submitted.horizontalOverflow
      && activeDesktop.progressVisible && activeMobile.progressVisible
      && activeDesktop.text.includes('Running - 5.0 MB - 1.0 MB/s - Limited to 2.0 MB/s - 1 of 2 destinations')
      && activeDesktop.text.includes('Next ') && activeMobile.text.includes('Next ')
      && activeDesktop.workerOnline && activeMobile.workerOnline
      && activeDesktop.workerText.includes('Background worker online') && activeDesktop.workerText.includes('Next ')
      && activeMobile.workerText.includes('Background worker online') && activeMobile.workerText.includes('Next ')
      && activeDesktop.buttons.length === 5 && activeMobile.buttons.length === 5
      && activeDesktop.buttons[0]?.label === 'Cancel backup' && !activeDesktop.buttons[0]?.disabled
      && activeMobile.buttons[0]?.label === 'Cancel backup' && !activeMobile.buttons[0]?.disabled
      && activeDesktop.buttons.every((button) => button.left >= activeDesktop.row.left && button.right <= activeDesktop.row.right + 1)
      && activeMobile.buttons.every((button) => button.left >= activeMobile.row.left && button.right <= activeMobile.row.right + 1 && button.top >= 0 && button.bottom <= activeMobile.viewport.height)
      && activeDesktop.row?.left >= activeDesktop.panel.left && activeDesktop.row?.right <= activeDesktop.panel.right + 1 && !activeDesktop.overflow
      && activeMobile.row?.left >= activeMobile.panel.left && activeMobile.row?.right <= activeMobile.panel.right + 1 && !activeMobile.overflow
      && resumed.resumeBefore === 'Resume interrupted backup' && resumed.interruptedText.includes('Retry ') && resumed.text.includes('Queued - High priority - 5.0 MB - 1 of 2 destinations') && !resumed.actionDisabled
      && deferred.includes('Deferred until') && deferred.includes('Daily at 01:30 America/New_York')
      && offline.text === 'Background worker offline' && offline.offline && !offline.online
      && lifecycle.canceledText.includes('Canceled') && lifecycle.retryVisible && lifecycle.retryText.includes('Queued')
      && lifecycle.pausedText.includes('Paused') && lifecycle.cloneText.includes('Production application protection copy')
      && lifecycle.disabledText.includes('Disabled') && lifecycle.deleteEnabled && lifecycle.pauseDisabled
      && lifecycle.beforeDeleteCount === 2 && lifecycle.afterDeleteCount === 1 && !lifecycle.originalVisible && lifecycle.cloneVisible
      && JSON.stringify(lifecycle.runCalls) === JSON.stringify([{ command: 'cancel', runId: 'run_resumed' }, { command: 'retry', runId: 'run_resumed' }])
      && JSON.stringify(lifecycle.jobCalls) === JSON.stringify([
        { command: 'pause', id: 'job_created', revision: 1 }, { command: 'resume', id: 'job_created', revision: 2 },
        { command: 'clone', id: 'job_created', revision: 3, name: null }, { command: 'disable', id: 'job_created', revision: 3 },
        { command: 'delete', id: 'job_created', revision: 4 }
      ]);
    process.stdout.write(`${JSON.stringify({ ok: valid, emptyDesktop, review, desktop, mobile, weeklyMobile, submitted, activeDesktop, activeMobile, resumed, deferred, offline, lifecycle, screenshots: { emptyDesktopPath, desktopPath, mobilePath, weeklyMobilePath, activeDesktopPath, activeMobilePath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
