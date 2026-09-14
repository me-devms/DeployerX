const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { setTimeout: delay } = require('node:timers/promises');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const transitionSource = mainSource.slice(
  mainSource.indexOf('async function syncUptimeTransitionToCloud('),
  mainSource.indexOf('async function syncUptimeWorkspaceFromCloud(')
);
const warningSource = mainSource.slice(
  mainSource.indexOf('function setUptimeCloudSyncWarning('),
  mainSource.indexOf('function queueUptimeWorkspaceSync(')
);
const context = { workspaceId: 'team-1' };
const currentWindow = { id: 'window-1', hour: '2026-09-08T10' };
const transition = {
  monitor: { id: 'monitor-1' },
  check: { monitorId: 'monitor-1', probeId: 'probe-1', completedAt: '2026-09-08T10:15:00Z' },
  incident: { id: 'incident-1' },
  maintenance: { id: 'maintenance-1' }
};

function createSync(overrides = {}) {
  const writes = [];
  const state = { syncWarning: '' };
  const sandbox = vm.createContext({
    readSettings: async () => ({ mode: 'cloud' }),
    UPTIME_CLOUD_COLLECTIONS: {
      monitors: 'uptimeMonitors', checks: 'uptimeCheckWindows',
      incidents: 'uptimeIncidents', maintenance: 'uptimeMaintenance'
    },
    getUptimeControlDatabaseV2: () => ({ listChecks: async () => { await delay(30); return []; } }),
    uptimeCheckWindows: () => [currentWindow],
    writeUptimeCloudRecord: async (...args) => { writes.push(args); },
    uptimeWorkerState: state,
    ...overrides
  });
  vm.runInContext(`${transitionSource}\n${warningSource}`, sandbox);
  return { sync: sandbox.syncUptimeTransitionBestEffort, writes, state };
}

test('handles fast permission denial while check history loads without an unhandled rejection', async () => {
  const { sync, state } = createSync({
    writeUptimeCloudRecord: async () => {
      throw Object.assign(new Error('Firestore permissions are blocking cloud data.'), { status: 403 });
    }
  });
  assert.equal(await sync(context, transition), false);
  assert.match(state.syncWarning, /synchronization is pending: Firestore permissions/);
});

test('syncs the monitor, matching check window, incident and maintenance', async () => {
  const { sync, writes, state } = createSync();
  state.syncWarning = 'Workspace uptime synchronization is pending: Previous failure';
  assert.equal(await sync(context, transition), true);
  assert.deepEqual(writes, [
    [context, 'uptimeMonitors', transition.monitor],
    [context, 'uptimeCheckWindows', currentWindow],
    [context, 'uptimeIncidents', transition.incident],
    [context, 'uptimeMaintenance', transition.maintenance]
  ]);
  assert.equal(state.syncWarning, '');
});

test('history read failure leaves no cloud writes running without handlers', async () => {
  const { sync, writes, state } = createSync({
    getUptimeControlDatabaseV2: () => ({
      listChecks: async () => { await delay(30); throw new Error('History unavailable'); }
    })
  });
  assert.equal(await sync(context, transition), false);
  assert.equal(writes.length, 0);
  assert.match(state.syncWarning, /History unavailable/);
});

test('syncs transitions without checks and skips absent check windows', async () => {
  const { sync, writes } = createSync({ uptimeCheckWindows: () => [] });
  assert.equal(await sync(context, { monitor: transition.monitor }), true);
  assert.equal(await sync(context, { check: transition.check }), true);
  assert.equal(writes.length, 1);
});

test('local workspaces do not read history or write cloud records', async () => {
  const { sync, writes } = createSync({
    readSettings: async () => ({ mode: 'local' }),
    getUptimeControlDatabaseV2: () => { throw new Error('Unexpected history read'); }
  });
  assert.equal(await sync(context, transition), true);
  assert.equal(writes.length, 0);
});
