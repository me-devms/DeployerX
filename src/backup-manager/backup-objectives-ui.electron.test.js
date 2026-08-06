const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const report = {
  checkedAt: '2026-08-03T12:00:00.000Z',
  summary: {
    totalJobs: 5,
    monitoredJobs: 3,
    healthyJobs: 1,
    warningJobs: 1,
    criticalJobs: 1,
    rpoConfiguredJobs: 3,
    rpoOverdueJobs: 1,
    rtoConfiguredJobs: 3,
    rtoOverTargetJobs: 1,
    rtoUnmeasuredJobs: 1,
    recoveryPointCount: 7
  },
  jobs: [
    {
      jobId: 'job-critical', jobName: 'Payments database', jobState: 'enabled', policyId: 'policy-critical', policyEnabled: true,
      nextRunAt: '2026-08-03T12:30:00.000Z', recoveryPointCount: 3, overallState: 'critical',
      rpo: { state: 'overdue', targetMinutes: 60, ageMinutes: 120, consumptionPercent: 200, baselineAt: '2026-08-03T10:00:00.000Z', deadlineAt: '2026-08-03T11:00:00.000Z', remainingMinutes: -60, lastSuccessfulRunId: 'run-critical' },
      rto: { state: 'over-target', targetMinutes: 15, consumptionPercent: 133.3, measurement: { restoreRunId: 'restore-critical', observedAt: '2026-08-03T11:50:00.000Z', observedMinutes: 20, resultState: 'succeeded', coverage: 'observed-file-restore', destinationPath: 'C:\\private\\restore', selectedPaths: ['/secret/payments'] } }
    },
    {
      jobId: 'job-warning', jobName: 'Application files', jobState: 'enabled', policyId: 'policy-warning', policyEnabled: true,
      nextRunAt: null, recoveryPointCount: 1, overallState: 'warning',
      rpo: { state: 'at-risk', targetMinutes: 60, ageMinutes: 50, consumptionPercent: 83.3, baselineAt: '2026-08-03T11:10:00.000Z', deadlineAt: '2026-08-03T12:10:00.000Z', remainingMinutes: 10, lastSuccessfulRunId: 'run-warning' },
      rto: { state: 'unmeasured', targetMinutes: 30, consumptionPercent: null, measurement: null }
    },
    {
      jobId: 'job-healthy', jobName: 'Customer uploads', jobState: 'enabled', policyId: 'policy-healthy', policyEnabled: true,
      nextRunAt: '2026-08-03T13:00:00.000Z', recoveryPointCount: 2, overallState: 'healthy',
      rpo: { state: 'healthy', targetMinutes: 120, ageMinutes: 30, consumptionPercent: 25, baselineAt: '2026-08-03T11:30:00.000Z', deadlineAt: '2026-08-03T13:30:00.000Z', remainingMinutes: 90, lastSuccessfulRunId: 'run-healthy' },
      rto: { state: 'within-target', targetMinutes: 60, consumptionPercent: 41.7, measurement: { restoreRunId: 'restore-healthy', observedAt: '2026-08-03T11:25:00.000Z', observedMinutes: 25, resultState: 'succeeded', coverage: 'observed-file-restore' } }
    },
    {
      jobId: 'job-inactive', jobName: 'Retired service', jobState: 'disabled', policyId: 'policy-inactive', policyEnabled: false,
      nextRunAt: null, recoveryPointCount: 1, overallState: 'inactive',
      rpo: { state: 'healthy', targetMinutes: 1440, ageMinutes: 60, consumptionPercent: 4.2, baselineAt: '2026-08-03T11:00:00.000Z', deadlineAt: '2026-08-04T11:00:00.000Z', remainingMinutes: 1380, lastSuccessfulRunId: 'run-inactive' },
      rto: { state: 'unmeasured', targetMinutes: 240, consumptionPercent: null, measurement: null }
    },
    {
      jobId: 'job-none', jobName: 'Unclassified data', jobState: 'enabled', policyId: 'policy-none', policyEnabled: true,
      nextRunAt: null, recoveryPointCount: 0, overallState: 'not-configured',
      rpo: { state: 'not-configured', targetMinutes: null, ageMinutes: null, consumptionPercent: null, baselineAt: null, deadlineAt: null, remainingMinutes: null, lastSuccessfulRunId: null },
      rto: { state: 'not-configured', targetMinutes: null, consumptionPercent: null, measurement: null }
    }
  ]
};
const encoded = Buffer.from(JSON.stringify(report)).toString('base64');

async function prepare(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    window.__objectiveReport = JSON.parse(atob('${encoded}'));
    window.__objectiveCalls = 0;
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      getBackupObjectiveStatus: async () => { window.__objectiveCalls += 1; return structuredClone(window.__objectiveReport); }
    }});
    showView('backup');
    setBackupManagerTab('overview');
    await loadBackupObjectives();
    return true;
  })()`);
}

async function inspect(window) {
  return window.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('backupPanelOverview').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.backup-objective-row')].map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        text: row.innerText,
        progress: [...row.querySelectorAll('.backup-objective-progress > span')].map((bar) => bar.style.width),
        overall: row.querySelector('.backup-objective-overall')?.innerText || ''
      };
    });
    return {
      viewportWidth: innerWidth,
      panel: { left: panel.left, right: panel.right },
      cards: {
        monitored: document.getElementById('backupOverviewMonitored').innerText,
        monitoredDetail: document.getElementById('backupOverviewMonitoredDetail').innerText,
        rpo: document.getElementById('backupOverviewRpo').innerText,
        rpoDetail: document.getElementById('backupOverviewRpoDetail').innerText,
        rto: document.getElementById('backupOverviewRto').innerText,
        rtoDetail: document.getElementById('backupOverviewRtoDetail').innerText,
        recoveryPoints: document.getElementById('backupOverviewRecoveryPoints').innerText,
        checkedAt: document.getElementById('backupOverviewCheckedAt').innerText
      },
      rows,
      emptyHidden: document.getElementById('backupObjectiveStatusEmpty').classList.contains('hidden'),
      panelText: document.getElementById('backupPanelOverview').innerText,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

async function refresh(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const before = window.__objectiveCalls;
    await loadBackupObjectives();
    return { before, after: window.__objectiveCalls };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-objectives-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`));
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);

    window.setSize(1279, 800);
    window.setSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const desktop = await inspect(window);
    const desktopPath = path.join(captureRoot, 'backup-objectives-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());
    const refreshResult = await refresh(window);

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mobile = await inspect(window);
    await window.webContents.executeJavaScript("document.getElementById('backupObjectiveStatusList').scrollIntoView({ block: 'start' })");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const mobilePath = path.join(captureRoot, 'backup-objectives-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    const rowsFit = (measurement) => measurement.rows.every((row) => row.left >= measurement.panel.left && row.right <= measurement.panel.right + 1);
    const exactCards = JSON.stringify(desktop.cards) === JSON.stringify({
      monitored: '3', monitoredDetail: '1 healthy, 1 attention, 1 breached',
      rpo: '2 / 3', rpoDetail: '1 overdue', rto: '2 / 3', rtoDetail: '1 over target, 1 unmeasured',
      recoveryPoints: '7', checkedAt: 'Checked 8/3/2026, 5:30:00 PM'
    });
    const [critical, warning, healthy, inactive, unconfigured] = desktop.rows;
    const valid = exactCards && desktop.rows.length === 5 && mobile.rows.length === 5 && desktop.emptyHidden && mobile.emptyHidden
      && critical.overall === 'Breached' && critical.text.includes('RPO 1h') && critical.text.includes('1h overdue')
      && critical.text.includes('RTO 15m') && critical.text.includes('Over target') && JSON.stringify(critical.progress) === JSON.stringify(['100%', '100%'])
      && warning.overall === 'Attention' && warning.text.includes('At risk') && warning.text.includes('Unmeasured') && warning.text.includes('No completed restore measurement')
      && JSON.stringify(warning.progress) === JSON.stringify(['83.3%', '0%'])
      && healthy.overall === 'Healthy' && healthy.text.includes('RPO 2h') && healthy.text.includes('RTO 1h') && healthy.text.includes('Within target')
      && JSON.stringify(healthy.progress) === JSON.stringify(['25%', '41.7%'])
      && inactive.overall === 'Inactive' && inactive.text.includes('RPO 1d')
      && unconfigured.overall === 'Not configured' && unconfigured.text.includes('No RPO target') && unconfigured.text.includes('No RTO target')
      && !desktop.panelText.includes('C:\\private\\restore') && !desktop.panelText.includes('/secret/payments')
      && refreshResult.after === refreshResult.before + 1
      && rowsFit(desktop) && rowsFit(mobile) && !desktop.overflow && !mobile.overflow;
    process.stdout.write(`${JSON.stringify({ ok: valid, desktop, mobile, refreshResult, screenshots: { desktopPath, mobilePath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
