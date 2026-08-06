const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const points = [
  {
    id: 'point_latest', jobId: 'job_app', jobName: 'Production application protection', sourceId: 'source_app', sourceName: 'Production application', sourceConnectionId: 'connection_local',
    type: 'incremental', capturedTo: '2026-08-03T12:00:00.000Z', availableCopyCount: 2, totalCopyCount: 2,
    verification: { state: 'succeeded' }, retention: { ruleMatches: ['last-n', 'daily', 'weekly'], deletionEligible: false }, repositoryCopies: [{ repositoryId: 'repo_primary', repositoryName: 'Primary archive', state: 'available' }]
  },
  {
    id: 'point_previous', jobId: 'job_app', jobName: 'Production application protection', sourceId: 'source_app', sourceName: 'Production application', sourceConnectionId: 'connection_local',
    type: 'full', capturedTo: '2026-08-02T12:00:00.000Z', availableCopyCount: 2, totalCopyCount: 2,
    verification: { state: 'succeeded' }, retention: { ruleMatches: [], deletionEligible: true }, repositoryCopies: [{ repositoryId: 'repo_primary', repositoryName: 'Primary archive', state: 'available' }]
  }
];
const pointsEncoded = Buffer.from(JSON.stringify(points)).toString('base64');

async function prepare(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    window.__recoveryPoints = JSON.parse(atob('${pointsEncoded}'));
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listBackupJobs: async () => [],
      listBackupRuns: async () => [],
      getBackupWorkerStatus: async () => ({ online: true, state: 'online' }),
      listBackupLocalConnections: async () => [{ id: 'connection_local', name: 'This computer', kind: 'local', currentDevice: true, lastTest: { status: 'success' } }],
      listBackupSshConnections: async () => [{ id: 'connection_ssh', name: 'Production server', kind: 'ssh', currentDevice: true, lastTest: { status: 'success' } }],
      startBackupFileRestore: async (payload) => ({ id: 'restore_ui', state: 'queued', targetConnectionId: payload.targetConnectionId }),
      waitBackupFileRestore: async () => ({ id: 'restore_ui', state: 'succeeded', result: { restoredItems: 1, skippedItems: 0, bytesRestored: 5242880 }, validation: { state: 'succeeded' } }),
      listBackupVerificationRuns: async () => [],
      startBackupVerification: async (payload) => ({ id: 'verify_ui', state: 'queued', mode: payload.mode, recoveryPointId: payload.recoveryPointId, repositoryId: payload.repositoryId }),
      waitBackupVerification: async () => ({ id: 'verify_ui', state: 'succeeded', mode: 'sample-restore', recoveryPointId: 'point_latest', repositoryId: 'repo_primary', result: { filesVerified: 3, bytesVerified: 7340032 } }),
      listBackupRecoveryPoints: async (payload = {}) => payload.cursor
        ? { items: [window.__recoveryPoints[1]], nextCursor: null, total: 2 }
        : { items: [window.__recoveryPoints[0]], nextCursor: 'point-page-2', total: 2 },
      browseBackupSnapshot: async (payload) => {
        const entries = {
          '': [{ path: '/', parentPath: '', name: '/', type: 'directory', sizeBytes: 0, modifiedAt: null, synthetic: true }],
          '/': [{ path: '/srv', parentPath: '/', name: 'srv', type: 'directory', sizeBytes: 0, modifiedAt: null, synthetic: false }],
          '/srv': [{ path: '/srv/app', parentPath: '/srv', name: 'app', type: 'directory', sizeBytes: 0, modifiedAt: null, synthetic: false }],
          '/srv/app': [
            { path: '/srv/app/logs', parentPath: '/srv/app', name: 'logs', type: 'directory', sizeBytes: 0, modifiedAt: '2026-08-03T11:58:00.000Z', synthetic: false },
            { path: '/srv/app/config.json', parentPath: '/srv/app', name: 'config.json', type: 'file', sizeBytes: 2048, modifiedAt: '2026-08-03T11:59:00.000Z', synthetic: false },
            { path: '/srv/app/report.txt', parentPath: '/srv/app', name: 'report.txt', type: 'file', sizeBytes: 5242880, modifiedAt: '2026-08-03T12:00:00.000Z', synthetic: false }
          ]
        };
        const breadcrumbs = payload.path ? (payload.path === '/' ? [{ path: '/', name: '/' }] : payload.path.split('/').filter(Boolean).map((_segment, index, segments) => ({ path: '/' + segments.slice(0, index + 1).join('/'), name: segments[index] }))) : [];
        return { recoveryPoint: window.__recoveryPoints[0], path: payload.path, parentPath: null, breadcrumbs, items: entries[payload.path] || [], nextCursor: null, total: (entries[payload.path] || []).length, repositoryCopy: { repositoryId: 'repo_primary', state: 'available' } };
      },
      searchBackupSnapshot: async (payload) => ({
        recoveryPoint: window.__recoveryPoints[0], query: payload.query, type: payload.type,
        items: [{ path: '/srv/app/report.txt', parentPath: '/srv/app', name: 'report.txt', type: 'file', sizeBytes: 5242880, modifiedAt: '2026-08-03T12:00:00.000Z', synthetic: false }],
        nextCursor: null, total: 1, repositoryCopy: { repositoryId: 'repo_primary', state: 'available' }
      }),
      listBackupFileVersions: async () => ({
        path: '/srv/app/report.txt', examinedRecoveryPoints: 3, truncated: false,
        versions: [
          { recoveryPointId: 'point_latest', capturedTo: '2026-08-03T12:00:00.000Z', availability: 'available', exists: true, change: 'modified', entry: { type: 'file', sizeBytes: 5242880 } },
          { recoveryPointId: 'point_previous', capturedTo: '2026-08-02T12:00:00.000Z', availability: 'available', exists: true, change: 'unchanged', entry: { type: 'file', sizeBytes: 4194304 } },
          { recoveryPointId: 'point_first', capturedTo: '2026-08-01T12:00:00.000Z', availability: 'available', exists: true, change: 'added', entry: { type: 'file', sizeBytes: 4194304 } }
        ]
      })
    }});
    state.backupRecovery = blankBackupRecovery();
    showView('backup');
    setBackupManagerTab('recovery');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await loadBackupRecoveryPoints({ append: true });
    await loadBackupRecoveryDirectory('/srv/app', { resetSearch: true });
    els.toast?.classList.remove('visible');
    return true;
  })()`);
}

async function measureRecovery(window) {
  return window.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('backupPanelRecovery').getBoundingClientRect();
    const workspace = document.getElementById('backupRecoveryWorkspace').getBoundingClientRect();
    const points = [...document.querySelectorAll('.backup-recovery-point')].map((row) => {
      const rect = row.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, text: row.innerText };
    });
    const entries = [...document.querySelectorAll('.backup-recovery-entry')].map((row) => {
      const rect = row.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, text: row.innerText };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      panel: { left: panel.left, right: panel.right },
      workspace: { left: workspace.left, right: workspace.right, top: workspace.top, bottom: workspace.bottom },
      points,
      entries,
      pointCount: document.getElementById('backupRecoveryPointCount').innerText,
      breadcrumbs: document.getElementById('backupRecoveryBreadcrumbs').innerText,
      resultCount: document.getElementById('backupRecoveryResultCount').innerText,
      toastVisible: els.toast?.classList.contains('visible') ?? false,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

async function measureVersions(window) {
  return window.webContents.executeJavaScript(`(() => {
    const modal = document.getElementById('backupFileVersionsModal');
    const card = modal.querySelector('.modal-card').getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
      path: document.getElementById('backupFileVersionsPath').innerText,
      rows: [...document.querySelectorAll('.backup-file-version-row')].map((row) => row.innerText),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

async function measureRestore(window) {
  return window.webContents.executeJavaScript(`(() => {
    const modal = document.getElementById('backupFileRestoreModal');
    const card = modal.querySelector('.modal-card').getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
      summary: document.getElementById('backupFileRestoreSummary').innerText,
      targetOptions: [...document.getElementById('backupFileRestoreTarget').options].map((option) => option.innerText),
      destinationVisible: !document.getElementById('backupFileRestoreDestinationField').classList.contains('hidden'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

async function measureVerification(window) {
  return window.webContents.executeJavaScript(`(() => {
    const modal = document.getElementById('backupVerificationModal');
    const card = modal.querySelector('.modal-card').getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
      summary: document.getElementById('backupVerificationSummary').innerText,
      repository: document.getElementById('backupVerificationRepository').innerText,
      sampleVisible: !document.getElementById('backupVerificationSampleField').classList.contains('hidden'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-recovery-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`));
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);
    window.setSize(1279, 800);
    window.setSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const desktop = await measureRecovery(window);
    const desktopPath = path.join(captureRoot, 'backup-recovery-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mobile = await measureRecovery(window);
    await window.webContents.executeJavaScript(`document.querySelector('.backup-recovery-browser').scrollIntoView({ block: 'start' })`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const mobilePath = path.join(captureRoot, 'backup-recovery-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    const search = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('backupRecoverySearchInput').value = 'report';
      await searchBackupRecovery(new Event('submit', { cancelable: true }));
      return { text: document.getElementById('backupRecoveryEntryList').innerText, breadcrumbs: document.getElementById('backupRecoveryBreadcrumbs').innerText, clearVisible: !document.getElementById('backupRecoveryClearSearchButton').classList.contains('hidden') };
    })()`);
    await window.webContents.executeJavaScript(`openBackupFileVersions('/srv/app/report.txt')`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const versions = await measureVersions(window);
    const versionsPath = path.join(captureRoot, 'backup-file-versions-mobile.png');
    await fs.writeFile(versionsPath, (await window.webContents.capturePage()).toPNG());

    const restore = await window.webContents.executeJavaScript(`(async () => {
      closeBackupFileVersions();
      state.backupRecovery.selectedPaths.add('/srv/app/report.txt');
      renderBackupRecoveryEntries();
      await openBackupFileRestore();
      return !document.getElementById('backupFileRestoreModal').classList.contains('hidden');
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const restoreModal = await measureRestore(window);
    const restorePath = path.join(captureRoot, 'backup-file-restore-mobile.png');
    await fs.writeFile(restorePath, (await window.webContents.capturePage()).toPNG());
    const restoreResult = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('backupFileRestoreDestination').value = 'C:\\\\Restored';
      await startBackupFileRestore(new Event('submit', { cancelable: true }));
      return { status: document.getElementById('backupFileRestoreStatus').innerText, selectedCount: state.backupRecovery.selectedPaths.size };
    })()`);
    const verificationOpen = await window.webContents.executeJavaScript(`(() => {
      closeBackupFileRestore();
      openBackupVerification();
      return !document.getElementById('backupVerificationModal').classList.contains('hidden');
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const verificationModal = await measureVerification(window);
    const verificationPath = path.join(captureRoot, 'backup-verification-mobile.png');
    await fs.writeFile(verificationPath, (await window.webContents.capturePage()).toPNG());
    const verificationResult = await window.webContents.executeJavaScript(`(async () => {
      await startBackupVerification(new Event('submit', { cancelable: true }));
      return { status: document.getElementById('backupVerificationStatus').innerText, pointState: document.querySelector('.backup-recovery-point-state').innerText };
    })()`);

    const inside = (bounds, container) => bounds.left >= container.left && bounds.right <= container.right + 1;
    const valid = desktop.pointCount === '2' && desktop.points.length === 2 && desktop.entries.length === 3
      && desktop.points[0].text.includes('Retained by Last-N, Daily, Weekly') && desktop.points[1].text.includes('Retention elapsed')
      && desktop.breadcrumbs.includes('srv') && desktop.breadcrumbs.includes('app') && desktop.resultCount === '3 items'
      && inside(desktop.workspace, desktop.panel) && desktop.entries.every((entry) => inside(entry, desktop.workspace)) && !desktop.toastVisible && !desktop.horizontalOverflow
      && mobile.pointCount === '2' && mobile.points.length === 2 && mobile.entries.length === 3
      && inside(mobile.workspace, mobile.panel) && mobile.entries.every((entry) => inside(entry, mobile.workspace)) && !mobile.toastVisible && !mobile.horizontalOverflow
      && search.text.includes('report.txt') && search.breadcrumbs.includes('Search: report') && search.clearVisible
      && versions.path === '/srv/app/report.txt' && versions.rows.length === 3
      && versions.rows[0].toLowerCase().includes('modified') && versions.rows[2].toLowerCase().includes('added')
      && versions.card.left >= 0 && versions.card.right <= versions.viewport.width && versions.card.top >= 0 && versions.card.bottom <= versions.viewport.height
      && !versions.horizontalOverflow
      && restore && restoreModal.summary.includes('1 item') && restoreModal.targetOptions.length === 2 && restoreModal.destinationVisible
      && restoreModal.card.left >= 0 && restoreModal.card.right <= restoreModal.viewport.width && restoreModal.card.top >= 0 && restoreModal.card.bottom <= restoreModal.viewport.height
      && !restoreModal.horizontalOverflow && restoreResult.status.includes('1 restored') && restoreResult.selectedCount === 0
      && verificationOpen && verificationModal.summary.includes('Production application protection') && verificationModal.repository.includes('Primary archive') && verificationModal.sampleVisible
      && verificationModal.card.left >= 0 && verificationModal.card.right <= verificationModal.viewport.width && verificationModal.card.top >= 0 && verificationModal.card.bottom <= verificationModal.viewport.height
      && !verificationModal.horizontalOverflow && verificationResult.status.includes('3 files') && verificationResult.pointState.includes('Sample verified');
    process.stdout.write(`${JSON.stringify({ ok: valid, desktop, mobile, search, versions, restoreModal, restoreResult, verificationModal, verificationResult, screenshots: { desktopPath, mobilePath, versionsPath, restorePath, verificationPath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
