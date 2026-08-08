const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('uses one backend-driven workflow for destinations and reusable connections', async () => {
  const [html, renderer, styles, preload, main] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8')
  ]);

  assert.match(html, /id="backupAddDestinationButton"/);
  assert.match(html, /id="backupDestinationsListTab"[\s\S]*?id="backupDestinationConnectionsTab"/);
  assert.match(html, /id="backupDestinationModal"[\s\S]*?1\. Backend type[\s\S]*?2\. Reusable connection[\s\S]*?3\. Storage location/);
  assert.doesNotMatch(html, /id="backupAdd(?:Local|Sftp|S3)RepositoryButton"/);
  assert.doesNotMatch(html, /id="backupJobCreate(?:Local|Sftp|S3)RepositoryButton"/);
  assert.doesNotMatch(html, /id="backup(?:Local|Sftp|S3)RepositoryModal"/);

  assert.match(renderer, /loadBackupStorageBackends\(\)[\s\S]*?loadBackupRepositories\(\)[\s\S]*?loadBackupDestinationConnections\(\)/);
  assert.match(renderer, /storageConnectionsForBackend[\s\S]*?backend\?\.connection\?\.adapterIds/);
  assert.match(renderer, /allowsInlineConnection && state\.backupDestinationDraft\.connectionId === '__new__'/);
  assert.match(renderer, /backupAddDestinationButton\.addEventListener\('click'[\s\S]*?openBackupDestinationModal/);
  assert.match(renderer, /backupJobCreateDestinationButton\.addEventListener\('click'[\s\S]*?suspendBackupJobForDependency\('destination'\)/);
  assert.match(renderer, /data-destination-new-connection[\s\S]*?captureBackupDestinationDraft[\s\S]*?awaitingSsh = true/);
  assert.match(renderer, /testBackupDestination\(testButton\.dataset\.backupRepositoryTest/);
  assert.match(renderer, /removeBackupDestination\(button\.dataset\.backupRepositoryDelete/);
  assert.doesNotMatch(renderer, /backup(?:Add|JobCreate)(?:Local|Sftp|S3)RepositoryButton/);
  assert.doesNotMatch(renderer, /(?:open|create|remove)Backup(?:Local|Sftp|S3)Repository/);

  assert.match(styles, /\.backup-destination-tabs\s*\{/);
  assert.match(styles, /\.backup-destination-modal-card\s*\{/);
  assert.match(styles, /\.backup-destination-backends\s*\{[\s\S]*?grid-template-columns: repeat\(3/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.backup-destination-backends,[\s\S]*?grid-template-columns: 1fr/);

  assert.match(preload, /listBackupStorageBackends: \(\) => ipcRenderer\.invoke\('backup:storage-backends:list'/);
  assert.match(preload, /listBackupStorageConnections: \(\) => ipcRenderer\.invoke\('backup:storage-connections:list'/);
  assert.match(preload, /createBackupStorageConnection: \(backendId, input\) => ipcRenderer\.invoke\('backup:storage-connections:create'/);
  assert.match(preload, /createBackupDestination: \(payload\) => ipcRenderer\.invoke\('backup:destinations:create'/);
  assert.match(main, /ipcMain\.handle\('backup:storage-connections:create'[\s\S]*?getBackupStorageConnectionService\(\)\.create/);
  assert.match(main, /ipcMain\.handle\('backup:destinations:create'[\s\S]*?getBackupDestinationService\(\)\.create/);
});
