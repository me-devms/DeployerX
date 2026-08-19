const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isDeployerXMainProcess,
  normalizeWindowsPath,
  selectDeployerXProcesses
} = require('./process-lifecycle');

test('normalizes Windows executable paths before comparing instances', () => {
  assert.equal(normalizeWindowsPath(' C:/Users/Om/App/DeployerX.exe\\ '), 'c:\\users\\om\\app\\deployerx.exe');
});

test('selects stale DeployerX main processes without selecting Electron children', () => {
  const records = [
    { pid: 100, name: 'DeployerX.exe', executablePath: 'C:\\Current\\DeployerX.exe', commandLine: '"C:\\Current\\DeployerX.exe"' },
    { pid: 101, name: 'DeployerX.exe', executablePath: 'C:\\Old\\DeployerX.exe', commandLine: '"C:\\Old\\DeployerX.exe" --uptime-worker' },
    { pid: 102, parentPid: 101, name: 'DeployerX.exe', executablePath: 'C:\\Old\\DeployerX.exe', commandLine: '"C:\\Old\\DeployerX.exe" --type=renderer' },
    { pid: 103, name: 'Other.exe', executablePath: 'C:\\Old\\Other.exe', commandLine: 'Other.exe' }
  ];

  assert.deepEqual(
    selectDeployerXProcesses(records, { currentPid: 100, currentExecutablePath: 'C:\\Current\\DeployerX.exe' }).map((record) => record.pid),
    [101]
  );
  assert.equal(isDeployerXMainProcess(records[2]), false);
});

test('selects an elevated stale root when Windows hides its path but skips its children', () => {
  const records = [
    { pid: 201, parentPid: 999, name: 'DeployerX.exe', executablePath: '', commandLine: '' },
    { pid: 202, parentPid: 201, name: 'DeployerX.exe', executablePath: '', commandLine: '' }
  ];
  assert.deepEqual(
    selectDeployerXProcesses(records, { currentPid: 100, currentExecutablePath: 'C:\\Current\\DeployerX.exe' }).map((record) => record.pid),
    [201]
  );
});

test('does not treat unrelated Electron fixtures under the repository as DeployerX instances', () => {
  assert.equal(isDeployerXMainProcess({
    pid: 301,
    name: 'electron.exe',
    executablePath: 'C:\\Repo\\DeployerX\\node_modules\\electron\\electron.exe',
    commandLine: 'electron.exe src/renderer/settings-runtime-fixture.js C:\\Temp\\deployerx-settings-fixture'
  }), false);
});

test('update cleanup can include duplicate processes from the current executable path', () => {
  const records = [
    { pid: 100, name: 'DeployerX.exe', executablePath: 'C:\\Current\\DeployerX.exe', commandLine: 'DeployerX.exe' },
    { pid: 101, name: 'DeployerX.exe', executablePath: 'C:\\Current\\DeployerX.exe', commandLine: 'DeployerX.exe' }
  ];
  assert.deepEqual(
    selectDeployerXProcesses(records, { currentPid: 100, currentExecutablePath: 'C:\\Current\\DeployerX.exe', includeCurrentExecutable: true }).map((record) => record.pid),
    [101]
  );
});
