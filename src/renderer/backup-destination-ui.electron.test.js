const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();

const backends = [
  {
    apiVersion: 1, backendId: 'deployerx.repository.local', version: '1.0.0', displayName: 'Local folder',
    description: 'Store backups in a folder available to this device.', icon: 'folder-open',
    connection: { required: true, adapterIds: ['deployerx.connection.local'], fields: [], creation: { mode: 'automatic' } },
    location: { label: 'Folder', fields: [{ id: 'rootPath', label: 'Folder', type: 'path', required: true, placeholder: 'Choose a folder' }] },
    capabilities: { capacityReporting: true, immutability: false, sharedConnection: true }
  },
  {
    apiVersion: 1, backendId: 'deployerx.repository.sftp', version: '1.0.0', displayName: 'SFTP',
    description: 'Store backups on a reusable SSH server connection.', icon: 'server',
    connection: { required: true, adapterIds: ['deployerx.connection.ssh'], fields: [], creation: { mode: 'external', handlerId: 'ssh' } },
    location: { label: 'Remote folder', fields: [{ id: 'rootPath', label: 'Remote folder', type: 'path', required: true, placeholder: '/srv/backups' }] },
    capabilities: { capacityReporting: true, immutability: false, sharedConnection: true }
  },
  {
    apiVersion: 1, backendId: 'deployerx.repository.s3-compatible', version: '1.0.0', displayName: 'S3-compatible storage',
    description: 'Store backups in S3, Wasabi, Backblaze B2, or another compatible service.', icon: 'cloud',
    connection: {
      required: true, adapterIds: ['deployerx.storage-connection.s3-compatible'], creation: { mode: 'form' },
      fields: [
        { id: 'name', label: 'Connection name', type: 'text', required: true },
        { id: 'endpoint', label: 'Endpoint', type: 'text', required: false, placeholder: 'Default AWS endpoint' },
        { id: 'accessKeyId', label: 'Access key ID', type: 'text', required: true },
        { id: 'secretAccessKey', label: 'Secret access key', type: 'secret', required: true }
      ]
    },
    location: {
      label: 'Bucket location', fields: [
        { id: 'region', label: 'Region', type: 'text', required: true, defaultValue: 'us-east-1' },
        { id: 'bucket', label: 'Bucket', type: 'text', required: true },
        { id: 'prefix', label: 'Prefix', type: 'path', required: false, placeholder: 'team/production' }
      ]
    },
    capabilities: { capacityReporting: false, immutability: true, sharedConnection: true }
  }
];

const destinations = [{
  id: 'destination-1', revision: 1, name: 'Production archive', backendId: 'deployerx.repository.s3-compatible', backend: backends[2],
  connectionId: 'connection-s3', connectionName: 'Production object storage', currentDevice: true,
  location: { region: 'us-east-1', bucket: 'production-archive', prefix: 'daily' },
  capacity: null, capacityStatus: { status: 'healthy' }, health: { status: 'ready', lockState: { status: 'available' } }
}];

const connections = [
  { id: 'connection-local', revision: 1, name: 'This computer', adapterId: 'deployerx.connection.local', backendId: backends[0].backendId, backend: backends[0], currentDevice: true, endpoint: { platform: 'win32', architecture: 'x64' } },
  { id: 'connection-ssh', revision: 1, name: 'Archive server', adapterId: 'deployerx.connection.ssh', backendId: backends[1].backendId, backend: backends[1], currentDevice: true, endpoint: { host: 'backup.example.com', port: 22, username: 'backup' } },
  { id: 'connection-s3', revision: 1, name: 'Production object storage', adapterId: 'deployerx.storage-connection.s3-compatible', backendId: backends[2].backendId, backend: backends[2], currentDevice: true, endpoint: { endpoint: 'https://objects.example.com' } }
];

async function prepare(window) {
  await window.webContents.executeJavaScript(`
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.getElementById('toast')?.classList.add('hidden');
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    state.setup.mode = 'offline';
    state.setup.complete = true;
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listBackupStorageBackends: async () => ${JSON.stringify(backends)},
      listBackupDestinations: async () => ${JSON.stringify(destinations)},
      listBackupStorageConnections: async () => ${JSON.stringify(connections)},
      selectLocalFolder: async () => 'C:\\\\Backups'
    }});
    showView('backup');
    setBackupManagerTab('repositories');
  `);
  await window.webContents.executeJavaScript(`Promise.all([loadBackupStorageBackends(), loadBackupRepositories(), loadBackupDestinationConnections()])`);
}

async function settle(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function measureModal(window) {
  return window.webContents.executeJavaScript(`(() => {
    const modal = document.getElementById('backupDestinationModal');
    const card = modal.querySelector('.backup-destination-modal-card');
    const rect = card.getBoundingClientRect();
    return {
      hidden: modal.classList.contains('hidden'),
      viewport: { width: innerWidth, height: innerHeight },
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      sections: modal.querySelectorAll('.backup-destination-section').length,
      backends: modal.querySelectorAll('.backup-destination-backend-option').length,
      labels: [...modal.querySelectorAll('.backup-destination-section legend')].map((legend) => legend.textContent.trim()),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || card.scrollWidth > card.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-destination-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, backgroundColor: '#f6f8fc', webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    await prepare(window);
    await window.webContents.executeJavaScript(`openBackupDestinationModal()`);
    await settle(window);
    const desktop = await measureModal(window);
    const desktopModalPath = path.join(captureRoot, 'destination-modal-desktop.png');
    await fs.writeFile(desktopModalPath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript(`document.querySelector('input[name="backupDestinationBackend"][value="deployerx.repository.s3-compatible"]').click()`);
    await settle(window);
    await window.webContents.executeJavaScript(`(() => { const select = document.getElementById('backupDestinationConnectionSelect'); select.value = '__new__'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await settle(window);
    const s3State = await window.webContents.executeJavaScript(`({
      connectionFields: document.querySelectorAll('#backupDestinationConnectionFields [data-destination-scope="connection"]').length,
      locationFields: document.querySelectorAll('#backupDestinationLocationFields [data-destination-scope="location"]').length,
      createsConnection: document.getElementById('backupDestinationConnectionSelect').value === '__new__',
      overflow: document.querySelector('.backup-destination-modal-card').scrollWidth > document.querySelector('.backup-destination-modal-card').clientWidth
    })`);
    await window.webContents.executeJavaScript(`document.querySelector('input[name="backupDestinationBackend"][value="deployerx.repository.sftp"]').click()`);
    await settle(window);
    const sftpState = await window.webContents.executeJavaScript(`({
      selectedConnection: document.getElementById('backupDestinationConnectionSelect').value,
      hasExternalCreateAction: Boolean(document.querySelector('[data-destination-new-connection="ssh"]'))
    })`);

    await window.webContents.executeJavaScript(`closeBackupDestinationModal(); setBackupDestinationPanel('connections')`);
    await settle(window);
    const connectionState = await window.webContents.executeJavaScript(`({ rows: document.querySelectorAll('#backupDestinationConnectionList .backup-source-row').length, text: document.getElementById('backupDestinationConnectionsPanel').innerText, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`);
    const desktopConnectionsPath = path.join(captureRoot, 'destination-connections-desktop.png');
    await fs.writeFile(desktopConnectionsPath, (await window.webContents.capturePage()).toPNG());

    window.setSize(390, 844);
    await settle(window);
    await window.webContents.executeJavaScript(`openBackupDestinationModal()`);
    await settle(window);
    const mobile = await measureModal(window);
    const mobileModalPath = path.join(captureRoot, 'destination-modal-mobile.png');
    await fs.writeFile(mobileModalPath, (await window.webContents.capturePage()).toPNG());

    const framed = (result) => !result.hidden && !result.overflow && result.rect.left >= 0 && result.rect.right <= result.viewport.width + 1 && result.rect.top >= 0 && result.rect.bottom <= result.viewport.height + 1;
    const valid = framed(desktop) && framed(mobile)
      && desktop.sections === 3 && desktop.backends === 3
      && desktop.labels.join('|') === '1. Backend type|2. Reusable connection|3. Storage location'
      && s3State.connectionFields === 4 && s3State.locationFields === 3 && s3State.createsConnection && !s3State.overflow
      && sftpState.selectedConnection === 'connection-ssh' && sftpState.hasExternalCreateAction
      && connectionState.rows === 3 && connectionState.text.includes('1 destination') && !connectionState.overflow;
    process.stdout.write(`${JSON.stringify({ ok: valid, desktop, mobile, s3State, sftpState, connectionState, screenshots: { desktopModalPath, desktopConnectionsPath, mobileModalPath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
