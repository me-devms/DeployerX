const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('offers a confirmed remove action for backup source connections', async () => {
  const [renderer, preload, main] = await Promise.all([
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8')
  ]);

  assert.match(renderer, /data-backup-connection-delete=/);
  assert.match(renderer, /async function removeBackupConnection[\s\S]*?confirmDangerousAction[\s\S]*?deleteBackupConnection/);
  assert.match(renderer, /closest\('\[data-backup-connection-delete\]'\)[\s\S]*?removeBackupConnection/);
  assert.match(preload, /deleteBackupConnection: \(id, revision\) => ipcRenderer\.invoke\('backup:connections:delete'/);
  assert.match(main, /ipcMain\.handle\('backup:connections:delete'[\s\S]*?repository\.softDelete/);
});
