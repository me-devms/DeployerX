const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('loads the DeployerX preload and invokes Uptime IPC in an Electron sandbox', async () => {
  const electronPath = require('electron');
  const fixturePath = path.join(__dirname, 'electron-preload-fixture.js');
  const { stdout, stderr } = await execFileAsync(electronPath, [fixturePath], { windowsHide: true, timeout: 15000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.equal(stderr.includes('Unable to load preload script'), false);
  assert.equal(stderr.includes('module not found'), false);
  assert.equal(result.bridgeAvailable, true);
  assert.deepEqual(result.status, { active: true, state: 'active' });
});
