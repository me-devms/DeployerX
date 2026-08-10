const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_WORKER_LOCK_LEASE_MS,
  buildLinuxAutostartEntry,
  buildLoginItemSettings,
  buildWorkerLaunchArgs,
  isWorkerLockLeaseActive
} = require('./worker-launch');

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

test('expires a worker lock even when Windows has reused its process ID', () => {
  const now = Date.parse('2026-08-10T08:00:00.000Z');
  const record = { pid: 12356, startedAt: '2026-08-07T15:23:41.128Z' };
  assert.equal(isWorkerLockLeaseActive(record, { now, processRunning: true }), false);
});

test('keeps a recently renewed lock while its worker process is alive', () => {
  const now = Date.parse('2026-08-10T08:00:00.000Z');
  const record = { pid: 4321, startedAt: '2026-08-10T07:00:00.000Z' };
  assert.equal(isWorkerLockLeaseActive(record, {
    now,
    leaseUpdatedAt: new Date(now - DEFAULT_WORKER_LOCK_LEASE_MS + 1).toISOString(),
    processRunning: true
  }), true);
  assert.equal(isWorkerLockLeaseActive(record, { now, leaseUpdatedAt: new Date(now).toISOString(), processRunning: false }), false);
});
