const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('delivers a native Windows notification through Electron', { skip: process.platform !== 'win32' }, async () => {
  const electronPath = require('electron');
  const fixturePath = path.join(__dirname, 'electron-notification-fixture.js');
  const { stdout } = await execFileAsync(electronPath, [fixturePath], { windowsHide: true, timeout: 15000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.equal(result.supported, true);
  assert.equal(result.shown, true, result.reason || 'Windows did not report the notification as shown.');
});
