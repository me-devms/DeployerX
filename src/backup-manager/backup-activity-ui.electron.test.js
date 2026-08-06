const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const activity = {
  jobs: [{ id: 'job_app', name: 'Production application protection' }],
  backups: [{
    id: 'run_backup', jobId: 'job_app', state: 'running', trigger: 'manual', attempt: 1,
    createdAt: '2026-08-03T12:00:00.000Z', startedAt: '2026-08-03T12:00:01.000Z', updatedAt: '2026-08-03T12:00:11.000Z',
    progress: { itemsScanned: 42, sourceBytes: 10485760, bytesRead: 8388608, uploadedBytes: 3145728, reusedBytes: 7340032, throughputBytesPerSecond: 1048576, repositoryCount: 2, committedRepositories: 1 },
    metrics: { scannedItems: 42, scannedBytes: 10485760, readBytes: 8388608, uploadedBytes: 3145728, reusedBytes: 7340032, deduplicationSavingsPercent: 70, throughputBytesPerSecond: 1048576, durationMs: 10000 }
  }],
  restores: [{
    id: 'restore_files', state: 'succeeded', createdAt: '2026-08-03T11:30:00.000Z', startedAt: '2026-08-03T11:30:01.000Z', updatedAt: '2026-08-03T11:30:21.000Z',
    progress: { itemsTotal: 5, itemsCompleted: 5, itemsSkipped: 1, bytesWritten: 5242880, throughputBytesPerSecond: 262144, startedAt: '2026-08-03T11:30:01.000Z', updatedAt: '2026-08-03T11:30:21.000Z' },
    result: { bytesRestored: 5242880, completedAt: '2026-08-03T11:30:21.000Z' }
  }],
  verifications: [{
    id: 'verification_mongodb_drill', state: 'succeeded', mode: 'mongodb-recovery-drill', scopeId: 'job_mongodb', recoveryPointId: 'point_mongodb', restoreRunId: 'restore_mongodb_drill',
    createdAt: '2026-08-03T11:15:00.000Z', startedAt: '2026-08-03T11:15:01.000Z', completedAt: '2026-08-03T11:15:46.000Z', updatedAt: '2026-08-03T11:15:46.000Z', measuredRtoSeconds: 41,
    progress: { phase: 'complete', startedAt: '2026-08-03T11:15:01.000Z', updatedAt: '2026-08-03T11:15:46.000Z' },
    evidence: { isolated: true, serviceExposed: false, targetDestroyed: true, expectedObjects: 'pass', nativeIntegrityValidation: true },
    result: { restoreRunId: 'restore_mongodb_drill', measuredRtoSeconds: 41, completedAt: '2026-08-03T11:15:46.000Z' }
  }, {
    id: 'verification_repo', state: 'warning', mode: 'checksum', createdAt: '2026-08-03T11:00:00.000Z', startedAt: '2026-08-03T11:00:01.000Z', completedAt: '2026-08-03T11:00:31.000Z', updatedAt: '2026-08-03T11:00:31.000Z',
    progress: { recoveryPointsTotal: 3, recoveryPointsVerified: 3, filesTotal: 18, filesVerified: 18, bytesVerified: 12582912, startedAt: '2026-08-03T11:00:01.000Z', updatedAt: '2026-08-03T11:00:31.000Z' }
  }],
  logs: [
    { timestamp: '2026-08-03T12:00:11.000Z', level: 'info', component: 'backup-run', correlationId: 'run_backup', message: 'Repository copy committed.', context: { repositoryId: 'repo_primary', uploadedBytes: 3145728, password: '[REDACTED]' } },
    { timestamp: '2026-08-03T12:00:01.000Z', level: 'info', component: 'backup-run', correlationId: 'run_backup', message: 'Backup run started.', context: { runId: 'run_backup' } }
  ]
};
const encoded = Buffer.from(JSON.stringify(activity)).toString('base64');

async function prepare(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    window.__activity = JSON.parse(atob('${encoded}'));
    window.__logPayload = null;
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listBackupJobs: async () => window.__activity.jobs,
      listBackupRuns: async () => window.__activity.backups,
      listBackupRestoreRuns: async () => window.__activity.restores,
      listBackupVerificationRuns: async () => window.__activity.verifications,
      listBackupLogs: async (payload) => { window.__logPayload = payload; return window.__activity.logs; },
      getBackupWorkerStatus: async () => ({ online: true, state: 'online' })
    }});
    showView('backup');
    await new Promise((resolve) => setTimeout(resolve, 25));
    setBackupManagerTab('activity');
    await new Promise((resolve) => setTimeout(resolve, 25));
    await loadBackupActivity();
    return true;
  })()`);
}

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('backupPanelActivity').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.backup-activity-row')]
      .filter((row) => row.getClientRects().length > 0)
      .map((row) => {
      const rect = row.getBoundingClientRect();
      return { left: rect.left, right: rect.right, text: row.innerText };
      });
    return {
      viewportWidth: innerWidth,
      panel: { left: panel.left, right: panel.right },
      rows,
      summary: document.getElementById('backupActivitySummary').innerText,
      emptyHidden: document.getElementById('backupActivityEmpty').classList.contains('hidden'),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

async function inspectModal(window) {
  return window.webContents.executeJavaScript(`(async () => {
    await openBackupActivityDetail('backup', 'run_backup');
    const modal = document.getElementById('backupActivityDetailModal');
    const card = modal.querySelector('.modal-card').getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
      title: document.getElementById('backupActivityDetailTitle').innerText,
      subtitle: document.getElementById('backupActivityDetailSubtitle').innerText,
      metrics: document.getElementById('backupActivityDetailMetrics').innerText,
      logCount: document.getElementById('backupActivityLogCount').innerText,
      logs: document.getElementById('backupActivityLogList').innerText,
      logPayload: window.__logPayload,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-activity-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`));
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);

    window.setSize(1279, 800);
    window.setSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const desktop = await measure(window);
    const desktopPath = path.join(captureRoot, 'backup-activity-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    const filtered = await window.webContents.executeJavaScript(`(() => {
      const filter = document.getElementById('backupActivityFilter');
      filter.value = 'restore';
      state.backupActivity.filter = 'restore';
      renderBackupActivity();
      const rows = [...document.querySelectorAll('.backup-activity-row')]
        .filter((row) => row.getClientRects().length > 0);
      filter.value = 'all';
      state.backupActivity.filter = 'all';
      renderBackupActivity();
      return { count: rows.length, text: rows[0]?.innerText || '' };
    })()`);
    const desktopModal = await inspectModal(window);

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await window.webContents.executeJavaScript('closeBackupActivityDetail()');
    const mobile = await measure(window);
    const mobilePath = path.join(captureRoot, 'backup-activity-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());
    const mobileModal = await inspectModal(window);
    const mobileModalPath = path.join(captureRoot, 'backup-activity-detail-mobile.png');
    await fs.writeFile(mobileModalPath, (await window.webContents.capturePage()).toPNG());

    const rowsFit = (measurement) => measurement.rows.every((row) => row.left >= measurement.panel.left && row.right <= measurement.panel.right + 1);
    const modalFits = (measurement) => measurement.card.left >= 0 && measurement.card.right <= measurement.viewport.width
      && measurement.card.top >= 0 && measurement.card.bottom <= measurement.viewport.height;
    const backupText = desktop.rows.find((row) => row.text.includes('Production application protection'))?.text || '';
    const drillText = desktop.rows.find((row) => row.text.includes('MongoDB isolated recovery drill'))?.text || '';
    const valid = desktop.rows.length === 4 && mobile.rows.length === 4 && desktop.emptyHidden && mobile.emptyHidden
      && rowsFit(desktop) && rowsFit(mobile) && !desktop.overflow && !mobile.overflow
      && desktop.summary.includes('4') && desktop.summary.includes('1 active') && desktop.summary.includes('8.0 MB') && desktop.summary.includes('7.0 MB')
      && backupText.includes('10 MB') && backupText.includes('3.0 MB') && backupText.includes('1.0 MB/s') && backupText.includes('70.0%') && backupText.includes('10s')
      && drillText.includes('Validated') && drillText.includes('Passed') && drillText.includes('Destroyed') && drillText.includes('41s')
      && filtered.count === 1 && filtered.text.includes('File restore') && filtered.text.includes('5.0 MB')
      && modalFits(desktopModal) && modalFits(mobileModal) && !desktopModal.overflow && !mobileModal.overflow
      && desktopModal.title === 'Production application protection' && desktopModal.metrics.includes('Scanned items') && desktopModal.metrics.includes('42')
      && desktopModal.metrics.includes('Deduplication savings') && desktopModal.metrics.includes('70.0%')
      && desktopModal.logCount === '2 entries' && desktopModal.logs.includes('Backup run started.') && desktopModal.logs.includes('[REDACTED]') && !desktopModal.logs.includes('secret-value')
      && desktopModal.logPayload?.runId === 'run_backup' && desktopModal.logPayload?.component === 'backup-run' && desktopModal.logPayload?.limit === 500;
    process.stdout.write(`${JSON.stringify({ ok: valid, desktop, mobile, filtered, desktopModal, mobileModal, screenshots: { desktopPath, mobilePath, mobileModalPath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
