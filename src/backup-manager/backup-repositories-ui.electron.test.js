const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

async function prepare(window) {
  return window.webContents.executeJavaScript(`
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    state.backupLocalRepositories = [
      {
        id: 'repo_ready', revision: 2, name: 'Primary local archive', currentDevice: true,
        location: { path: 'D:\\\\DeployerX Backups' }, capacity: { reporting: 'exact', totalBytes: 1099511627776, freeBytes: 549755813888, usedBytes: 549755813888, measuredAt: '2026-08-03T12:00:00.000Z' },
        storagePolicy: { quotaBytes: 858993459200, reserveBytes: 10737418240, reservePercent: 5, warningPercent: 15, criticalPercent: 5, minimumBackupBytes: 1073741824, requireCapacityProof: true },
        health: { status: 'ready', repositoryFormatVersion: 1, lockState: { status: 'available' } }
      },
      {
        id: 'repo_remote', revision: 1, name: 'Workstation archive', currentDevice: false,
        location: { path: 'E:\\\\Backups' }, health: { status: 'ready', repositoryFormatVersion: 1 }
      }
    ];
    state.backupSftpRepositories = [
      {
        id: 'repo_sftp', revision: 1, name: 'Offsite SFTP archive', currentDevice: true, connectionName: 'Production archive server',
        location: { path: '/srv/deployerx-backups' }, capacity: { reporting: 'exact', totalBytes: 2147483648, freeBytes: 1073741824, usedBytes: 1073741824, measuredAt: '2026-08-03T12:00:00.000Z' },
        health: { status: 'ready', repositoryFormatVersion: 1, lockState: { status: 'available' } }
      }
    ];
    state.backupS3Repositories = [
      {
        id: 'repo_s3', revision: 1, name: 'Production object archive', currentDevice: true,
        location: { endpoint: 'https://objects.example.com', region: 'us-east-1', bucket: 'deployerx-production', prefix: 'workspace-a' },
        capacity: { reporting: 'unavailable', measuredAt: '2026-08-03T12:00:00.000Z' },
        health: { status: 'ready', repositoryFormatVersion: 1, lockState: { status: 'available' } }
      }
    ];
    state.backupSshConnections = [
      { id: 'conn_ssh', name: 'Production archive server', currentDevice: true, endpoint: { host: 'backup.example.com' }, workerAffinity: ['device:test'] }
    ];
    showView('backup');
    setBackupManagerTab('repositories');
    renderBackupRepositories();
    els.toast?.classList.remove('visible');
    true;
  `);
}

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('backupPanelRepositories').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#backupRepositoryList .backup-source-row')].map((row) => {
      const rect = row.getBoundingClientRect();
      const actions = [...row.querySelectorAll('.backup-source-actions button')].map((button) => {
        const action = button.getBoundingClientRect();
        return { left: action.left, right: action.right };
      });
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height, actions };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight }, panel: { left: panel.left, right: panel.right }, rows,
      readyVisible: document.body.innerText.includes('Primary local archive') && document.body.innerText.includes('Ready'),
      remoteVisible: document.body.innerText.includes('Another device'),
      sftpVisible: document.body.innerText.includes('Offsite SFTP archive') && document.body.innerText.includes('/srv/deployerx-backups'),
      s3Visible: document.body.innerText.includes('Production object archive') && document.body.innerText.includes('s3://deployerx-production/workspace-a'),
      capacityVisible: document.body.innerText.includes('512 GB free of 1.0 TB') && document.body.innerText.includes('Capacity unavailable'),
      testButtonCount: document.querySelectorAll('[data-backup-repository-test]').length,
      emptyHidden: document.getElementById('backupRepositoriesEmpty').classList.contains('hidden'),
      toastVisible: els.toast?.classList.contains('visible') ?? false,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-repositories-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);
    window.setSize(1279, 800);
    window.setSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const desktop = await measure(window);
    const desktopPath = path.join(captureRoot, 'repositories-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mobile = await measure(window);
    const mobilePath = path.join(captureRoot, 'repositories-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    const modal = await window.webContents.executeJavaScript(`(() => {
      openBackupLocalRepositoryModal();
      document.getElementById('backupLocalRepositoryName').value = 'Local archive';
      document.getElementById('backupLocalRepositoryPath').value = 'D:\\\\Backups';
      const card = document.querySelector('#backupLocalRepositoryModal .modal-card').getBoundingClientRect();
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        nameVisible: document.getElementById('backupLocalRepositoryName').value === 'Local archive',
        pathVisible: document.getElementById('backupLocalRepositoryPath').value.includes('Backups'),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const modalPath = path.join(captureRoot, 'repository-modal-mobile.png');
    await fs.writeFile(modalPath, (await window.webContents.capturePage()).toPNG());

    const sftpModal = await window.webContents.executeJavaScript(`(async () => {
      closeBackupLocalRepositoryModal();
      await openBackupSftpRepositoryModal();
      document.getElementById('backupSftpRepositoryName').value = 'Remote archive';
      document.getElementById('backupSftpRepositoryPath').value = '/srv/backups';
      const card = document.querySelector('#backupSftpRepositoryModal .modal-card').getBoundingClientRect();
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        connectionVisible: document.getElementById('backupSftpRepositoryConnection').value === 'conn_ssh',
        pathVisible: document.getElementById('backupSftpRepositoryPath').value === '/srv/backups',
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sftpModalPath = path.join(captureRoot, 'sftp-repository-modal-mobile.png');
    await fs.writeFile(sftpModalPath, (await window.webContents.capturePage()).toPNG());

    const s3Modal = await window.webContents.executeJavaScript(`(() => {
      closeBackupSftpRepositoryModal();
      openBackupS3RepositoryModal();
      document.getElementById('backupS3RepositoryName').value = 'Object archive';
      document.getElementById('backupS3RepositoryEndpoint').value = 'https://objects.example.com';
      document.getElementById('backupS3RepositoryBucket').value = 'deployerx-production';
      document.getElementById('backupS3RepositoryPrefix').value = 'workspace-a';
      document.getElementById('backupS3RepositoryAccessKey').value = 'access-key';
      document.getElementById('backupS3RepositorySecretKey').value = 'secret-key';
      const modal = document.getElementById('backupS3RepositoryModal');
      const card = modal.querySelector('.modal-card').getBoundingClientRect();
      const body = modal.querySelector('.modal-body');
      const controls = [...modal.querySelectorAll('input, button')].map((control) => {
        const rect = control.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, controls,
        fieldCount: modal.querySelectorAll('input').length,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        fieldsVisible: document.getElementById('backupS3RepositoryName').value === 'Object archive'
          && document.getElementById('backupS3RepositoryEndpoint').value === 'https://objects.example.com'
          && document.getElementById('backupS3RepositoryRegion').value === 'us-east-1'
          && document.getElementById('backupS3RepositoryBucket').value === 'deployerx-production'
          && document.getElementById('backupS3RepositoryPrefix').value === 'workspace-a'
          && document.getElementById('backupS3RepositoryAccessKey').value === 'access-key'
          && document.getElementById('backupS3RepositorySecretKey').value === 'secret-key',
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const s3ModalPath = path.join(captureRoot, 's3-repository-modal-mobile.png');
    await fs.writeFile(s3ModalPath, (await window.webContents.capturePage()).toPNG());

    const policyModal = await window.webContents.executeJavaScript(`(() => {
      closeBackupS3RepositoryModal();
      openBackupRepositoryPolicy('repo_ready');
      const modal = document.getElementById('backupRepositoryPolicyModal');
      const card = modal.querySelector('.modal-card').getBoundingClientRect();
      const body = modal.querySelector('.modal-body');
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        valuesVisible: document.getElementById('backupRepositoryQuota').value === '800'
          && document.getElementById('backupRepositoryReserveBytes').value === '10'
          && document.getElementById('backupRepositoryMinimumBackup').value === '1'
          && document.getElementById('backupRepositoryRequireCapacity').checked,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const policyModalPath = path.join(captureRoot, 'repository-policy-modal-mobile.png');
    await fs.writeFile(policyModalPath, (await window.webContents.capturePage()).toPNG());

    const valid = [desktop, mobile].every((result) => result.readyVisible && result.remoteVisible && result.sftpVisible && result.s3Visible && result.capacityVisible && result.testButtonCount === 4 && result.emptyHidden && !result.toastVisible && !result.horizontalOverflow
      && result.rows.length === 4 && result.rows.every((row) => row.left >= result.panel.left && row.right <= result.panel.right + 1 && row.height >= 60
        && row.actions.every((action) => action.left >= row.left && action.right <= row.right + 1)))
      && modal.nameVisible && modal.pathVisible && !modal.horizontalOverflow
      && modal.card.left >= 0 && modal.card.right <= mobile.viewport.width && modal.card.top >= 0 && modal.card.bottom <= mobile.viewport.height
      && sftpModal.connectionVisible && sftpModal.pathVisible && !sftpModal.horizontalOverflow
      && sftpModal.card.left >= 0 && sftpModal.card.right <= mobile.viewport.width && sftpModal.card.top >= 0 && sftpModal.card.bottom <= mobile.viewport.height
      && s3Modal.fieldsVisible && !s3Modal.horizontalOverflow
      && s3Modal.card.left >= 0 && s3Modal.card.right <= mobile.viewport.width && s3Modal.card.top >= 0 && s3Modal.card.bottom <= mobile.viewport.height
      && s3Modal.fieldCount === 10 && s3Modal.bodyScrollable
      && s3Modal.controls.every((control) => control.left >= s3Modal.card.left && control.right <= s3Modal.card.right + 1)
      && policyModal.valuesVisible && !policyModal.horizontalOverflow
      && policyModal.card.left >= 0 && policyModal.card.right <= mobile.viewport.width && policyModal.card.top >= 0 && policyModal.card.bottom <= mobile.viewport.height;
    process.stdout.write(`${JSON.stringify({ ok: valid, desktop, mobile, modal, sftpModal, s3Modal, policyModal, screenshots: { desktopPath, mobilePath, modalPath, sftpModalPath, s3ModalPath, policyModalPath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
