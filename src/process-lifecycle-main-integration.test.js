const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('cleans stale desktop instances during startup and update installation', () => {
  assert.match(mainSource, /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*await cleanupDeployerXProcesses\(\{ allowElevation: true \}\)/);
  assert.match(mainSource, /async function cleanupDeployerXProcesses\(\{[\s\S]*?\}\s*=\s*\{\}\) \{[\s\S]*?if \(isWorkerMode\(\)\) return \[\];/);
  assert.match(mainSource, /async function prepareForUpdateInstall\(\)[\s\S]*stopDetachedUptimeWorker\(\{ force: true \}\)[\s\S]*cleanupDeployerXProcesses\(\{ includeCurrentExecutable: true, allowElevation: true \}\)/);
  assert.match(mainSource, /prepareForUpdateInstall\(\)[\s\S]*autoUpdater\.quitAndInstall\(false, true\)/);
});

test('quits cleanly after startup or renderer failure', () => {
  assert.match(mainSource, /app\.whenReady\(\)[\s\S]*\.catch\(handleApplicationStartupFailure\)/);
  assert.match(mainSource, /mainWindow\.webContents\.on\('render-process-gone'[\s\S]*handleApplicationStartupFailure/);
  assert.match(mainSource, /mainWindow\.webContents\.on\('did-fail-load'[\s\S]*handleApplicationStartupFailure/);
  assert.match(mainSource, /async function handleApplicationStartupFailure\(error\)[\s\S]*await stopDetachedUptimeWorker[\s\S]*await cleanupDeployerXProcesses[\s\S]*app\.quit\(\)/);
});

test('tracks the detached worker so update and failure cleanup can stop it', () => {
  assert.match(mainSource, /let detachedUptimeWorkerPid = 0/);
  assert.match(mainSource, /child\.once\('spawn'[\s\S]*detachedUptimeWorkerPid = Number\(child\.pid/);
  assert.match(mainSource, /async function stopDetachedUptimeWorker[\s\S]*terminateProcessTree\(pid\)/);
});
