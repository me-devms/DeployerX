const assert = require('node:assert/strict');
const test = require('node:test');
const { buildLinuxAutostartEntry, buildLoginItemSettings, buildWorkerLaunchArgs } = require('./worker-launch');

test('builds packaged and development worker arguments', () => {
  assert.deepEqual(buildWorkerLaunchArgs({ isPackaged: true }), ['--uptime-worker']);
  assert.deepEqual(
    buildWorkerLaunchArgs({ defaultApp: true, isPackaged: false, appPath: 'C:\\DeployerX Source' }),
    ['C:\\DeployerX Source', '--uptime-worker']
  );
  assert.throws(() => buildWorkerLaunchArgs({ isPackaged: false }), /application path/i);
});

test('builds explicit enabled and disabled login-item settings', () => {
  const args = ['C:\\DeployerX Source', '--uptime-worker'];
  assert.deepEqual(buildLoginItemSettings({ enabled: true, execPath: 'C:\\Electron.exe', args }), {
    openAtLogin: true,
    openAsHidden: true,
    path: 'C:\\Electron.exe',
    args
  });
  assert.equal(buildLoginItemSettings({ enabled: false, execPath: 'C:\\DeployerX.exe', args: ['--uptime-worker'] }).openAtLogin, false);
});

test('quotes paths and arguments in Linux autostart entries', () => {
  const entry = buildLinuxAutostartEntry({ execPath: '/opt/DeployerX/deployerx', args: ['/tmp/Source Folder', '--uptime-worker'] });
  assert.match(entry, /Exec="\/opt\/DeployerX\/deployerx" "\/tmp\/Source Folder" "--uptime-worker"/);
  assert.match(entry, /X-GNOME-Autostart-enabled=true/);
});
