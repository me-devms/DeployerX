const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

async function waitFor(window, expression, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for renderer state: ${expression}`);
}

async function prepare(window) {
  return window.webContents.executeJavaScript(`
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');

    window.__pruneCalls = [];
    window.__repositoryReloads = 0;
    window.__recoveryReloads = 0;
    window.__pruneRepositories = [
      {
        id: 'repo_prunable', revision: 3, name: 'Primary local archive', currentDevice: true,
        location: { path: 'D:\\DeployerX Backups' },
        capacity: { reporting: 'exact', totalBytes: 1099511627776, freeBytes: 549755813888, usedBytes: 549755813888 },
        health: { status: 'ready', repositoryFormatVersion: 1, lockState: { status: 'available' } }
      },
      {
        id: 'repo_protected', revision: 2, name: 'Protected chain archive', currentDevice: true,
        location: { path: 'E:\\Protected Backups' },
        capacity: { reporting: 'exact', totalBytes: 536870912000, freeBytes: 268435456000, usedBytes: 268435456000 },
        health: { status: 'ready', repositoryFormatVersion: 1, lockState: { status: 'available' } }
      }
    ];

    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listBackupLocalRepositories: async () => {
        window.__repositoryReloads += 1;
        return window.__pruneRepositories;
      },
      listBackupSftpRepositories: async () => [],
      listBackupS3Repositories: async () => [],
      listBackupRecoveryPoints: async () => {
        window.__recoveryReloads += 1;
        return { items: [], nextCursor: null, total: 0 };
      },
      planBackupRepositoryPrune: async (repositoryId) => {
        window.__pruneCalls.push({ operation: 'plan', repositoryId });
        if (repositoryId === 'repo_protected') {
          return {
            planId: 'prune_plan_protected', repositoryId,
            summary: { eligibleCopies: 0, blockedCopies: 3, manifestsToDelete: 0, chunksToDelete: 0 },
            protected: [{ reason: 'incremental-chain-ancestor', count: 2 }, { reason: 'active-restore', count: 1 }]
          };
        }
        return {
          planId: 'prune_plan_reviewed_1', repositoryId,
          summary: { eligibleCopies: 2, blockedCopies: 1, manifestsToDelete: 2, chunksToDelete: 3 },
          protected: [{ reason: 'incremental-chain-ancestor', count: 1 }]
        };
      },
      pruneBackupRepository: async (repositoryId, planId) => {
        window.__pruneCalls.push({ operation: 'apply', repositoryId, planId });
        if (repositoryId !== 'repo_prunable' || planId !== 'prune_plan_reviewed_1') throw new Error('The reviewed prune plan was not preserved.');
        return { copies: [{ recoveryPointId: 'point_expired_1' }, { recoveryPointId: 'point_expired_2' }] };
      }
    }});

    state.backupLocalRepositories = window.__pruneRepositories;
    state.backupSftpRepositories = [];
    state.backupS3Repositories = [];
    showView('backup');
    setBackupManagerTab('repositories');
    renderBackupRepositories();
    document.getElementById('toast').textContent = '';
    document.getElementById('toast').classList.remove('visible', 'error');
    true;
  `);
}

async function openPruneReview(window) {
  await window.webContents.executeJavaScript(`
    document.querySelector('[data-backup-repository-prune="repo_prunable"]').click();
    true;
  `);
  await waitFor(window, `!document.getElementById('confirmModal').classList.contains('hidden')`);
  return window.webContents.executeJavaScript(`(() => {
    const modal = document.getElementById('confirmModal');
    const card = modal.querySelector('.modal-card').getBoundingClientRect();
    const buttons = [...modal.querySelectorAll('button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { id: button.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
      buttons,
      title: document.getElementById('confirmModalTitle').textContent,
      detail: document.getElementById('confirmModalDetail').textContent,
      label: document.getElementById('confirmModalConfirmLabel').textContent,
      tone: modal.dataset.tone,
      danger: document.getElementById('confirmModalConfirmButton').classList.contains('danger'),
      focusedId: document.activeElement?.id || '',
      calls: structuredClone(window.__pruneCalls),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-pruning-ui-'));
  const window = new BrowserWindow({ show: false, width: 390, height: 844, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    const preloadSource = await fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8');
    const preloadContract = preloadSource.includes("planBackupRepositoryPrune: (repositoryId) => ipcRenderer.invoke('backup:repositories:prune-plan', { repositoryId })")
      && preloadSource.includes("pruneBackupRepository: (repositoryId, planId) => ipcRenderer.invoke('backup:repositories:prune', { repositoryId, planId })");

    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);
    window.setSize(391, 844);
    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const firstReview = await openPruneReview(window);
    const reviewPath = path.join(captureRoot, 'repository-prune-review-mobile.png');
    await fs.writeFile(reviewPath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript(`document.getElementById('confirmModalCancelButton').click(); true;`);
    await waitFor(window, `document.getElementById('confirmModal').classList.contains('hidden')`);
    const canceled = await window.webContents.executeJavaScript(`({
      calls: structuredClone(window.__pruneCalls),
      modalHidden: document.getElementById('confirmModal').classList.contains('hidden')
    })`);

    const secondReview = await openPruneReview(window);
    await window.webContents.executeJavaScript(`document.getElementById('confirmModalConfirmButton').click(); true;`);
    await waitFor(window, `window.__pruneCalls.some((call) => call.operation === 'apply') && document.getElementById('toast').textContent.includes('2 recovery point copies pruned.')`);
    const applied = await window.webContents.executeJavaScript(`({
      calls: structuredClone(window.__pruneCalls),
      toast: document.getElementById('toast').textContent,
      repositoryReloads: window.__repositoryReloads,
      recoveryReloads: window.__recoveryReloads,
      modalHidden: document.getElementById('confirmModal').classList.contains('hidden')
    })`);

    await window.webContents.executeJavaScript(`document.querySelector('[data-backup-repository-prune="repo_protected"]').click(); true;`);
    await waitFor(window, `document.getElementById('toast').textContent.includes('No recovery points can be pruned. 3 are protected.')`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const protectedStatus = await window.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('backupPanelRepositories').getBoundingClientRect();
      const toastElement = document.getElementById('toast');
      const toast = toastElement.getBoundingClientRect();
      const toastStyle = getComputedStyle(toastElement);
      const rows = [...document.querySelectorAll('#backupRepositoryList .backup-source-row')].map((row) => {
        const rect = row.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
        toastRect: { left: toast.left, right: toast.right, top: toast.top, bottom: toast.bottom },
        toast: toastElement.textContent,
        toastVisible: toastElement.classList.contains('visible'),
        toastOpacity: toastStyle.opacity,
        toastBackground: toastStyle.backgroundColor,
        modalHidden: document.getElementById('confirmModal').classList.contains('hidden'),
        rows,
        calls: structuredClone(window.__pruneCalls),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    const protectedPath = path.join(captureRoot, 'repository-prune-protected-mobile.png');
    await fs.writeFile(protectedPath, (await window.webContents.capturePage()).toPNG());

    const fits = (rect, viewport) => rect.left >= 0 && rect.right <= viewport.width && rect.top >= 0 && rect.bottom <= viewport.height;
    const firstApplyCalls = canceled.calls.filter((call) => call.operation === 'apply');
    const finalApplyCalls = protectedStatus.calls.filter((call) => call.operation === 'apply');
    const protectedPlanCalls = protectedStatus.calls.filter((call) => call.operation === 'plan' && call.repositoryId === 'repo_protected');
    const valid = preloadContract
      && firstReview.title === 'Prune expired recovery points?' && firstReview.label === 'Prune repository'
      && firstReview.detail.includes('2 manifests and 3 unreferenced chunks will be removed.')
      && firstReview.detail.includes('1 protected copy will remain.')
      && firstReview.tone === 'danger' && firstReview.danger && firstReview.focusedId === 'confirmModalCancelButton'
      && firstReview.calls.length === 1 && firstReview.calls[0].operation === 'plan'
      && fits(firstReview.card, firstReview.viewport) && firstReview.buttons.every((button) => fits(button, firstReview.viewport)) && !firstReview.horizontalOverflow
      && canceled.modalHidden && firstApplyCalls.length === 0
      && secondReview.calls.filter((call) => call.operation === 'plan').length === 2
      && applied.modalHidden && applied.toast === '2 recovery point copies pruned.'
      && applied.repositoryReloads >= 1 && applied.recoveryReloads === 1
      && applied.calls.some((call) => call.operation === 'apply' && call.repositoryId === 'repo_prunable' && call.planId === 'prune_plan_reviewed_1')
      && protectedPlanCalls.length === 1 && finalApplyCalls.length === 1
      && protectedStatus.modalHidden && protectedStatus.toastVisible
      && protectedStatus.toastOpacity === '1' && protectedStatus.toastBackground === 'rgb(24, 24, 27)'
      && protectedStatus.toast === 'No recovery points can be pruned. 3 are protected.'
      && fits(protectedStatus.toastRect, protectedStatus.viewport)
      && protectedStatus.rows.length === 2 && protectedStatus.rows.every((row) => row.left >= protectedStatus.panel.left && row.right <= protectedStatus.panel.right + 1)
      && !protectedStatus.horizontalOverflow;

    process.stdout.write(`${JSON.stringify({ ok: valid, preloadContract, firstReview, canceled, applied, protectedStatus, screenshots: { reviewPath, protectedPath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
