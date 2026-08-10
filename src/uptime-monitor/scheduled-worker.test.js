const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UptimeControlDatabase } = require('./control-database');
const { UptimeIncidentPolicyService } = require('./incident-policy');
const { ScheduledUptimeWorkerService, UptimeRetentionService, executeUptimeMonitorCheck, maintenanceApplies } = require('./scheduled-worker');

async function fixture(context, options = {}) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-uptime-worker-test-'));
  let nowMs = Date.parse('2026-08-04T12:00:00.000Z');
  const clock = () => new Date(nowMs).toISOString();
  const database = new UptimeControlDatabase({ rootPath, clock });
  await database.initialize();
  context.after(async () => { await database.close(); await fs.rm(rootPath, { recursive: true, force: true }); });
  const incidentPolicy = new UptimeIncidentPolicyService({ controlDatabase: database, clock });
  const runs = [];
  let active = 0;
  let maximumActive = 0;
  const checkRunner = options.checkRunner || (async (monitor) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    runs.push(monitor.id);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs || 5));
    active -= 1;
    return { outcome: 'up', ok: true, latencyMs: 10, statusCode: 200, summary: 'Healthy.', details: {}, startedAt: clock(), completedAt: clock() };
  });
  const retentionRuns = [];
  const worker = new ScheduledUptimeWorkerService({
    controlDatabase: database,
    incidentPolicy,
    checkRunner,
    retentionService: { run: async (workspaceId) => { retentionRuns.push(workspaceId); return {}; } },
    clock,
    now: () => nowMs,
    probeId: 'local-windows:test',
    maximumConcurrency: options.maximumConcurrency || 2,
    pollIntervalMs: 100,
    heartbeatIntervalMs: 100
  });
  return { database, worker, runs, retentionRuns, clock, maximumActive: () => maximumActive, advance(milliseconds) { nowMs += milliseconds; } };
}

function monitor(name, overrides = {}) {
  return {
    name,
    type: 'http',
    intervalSec: 60,
    timeoutMs: 1000,
    config: { url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example.test/health`, expectedStatusRanges: ['200-299'] },
    ...overrides
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the scheduled worker.');
}

test('matches workspace, group, project, and monitor maintenance scopes', () => {
  const item = { id: 'monitor-1', group: 'Production', projectId: 'project-1' };
  assert.equal(maintenanceApplies({ scope: { type: 'workspace' } }, item), true);
  assert.equal(maintenanceApplies({ scope: { type: 'group', group: 'Production' } }, item), true);
  assert.equal(maintenanceApplies({ scope: { type: 'project', projectId: 'project-2' } }, item), false);
  assert.equal(maintenanceApplies({ scope: { type: 'monitors', monitorIds: ['monitor-1'] } }, item), true);
});

test('persists the first health result for a newly created monitor', async (context) => {
  const values = await fixture(context);
  const stored = await values.database.createMonitor('local', 'tester', monitor('New target'));
  assert.equal(stored.runtime.status, 'unknown');
  const transition = await executeUptimeMonitorCheck({
    controlDatabase: values.database,
    incidentPolicy: values.worker.incidentPolicy,
    workspaceId: 'local',
    actorId: 'tester',
    monitor: stored,
    checkRunner: async () => ({ outcome: 'up', ok: true, latencyMs: 12, statusCode: 200, summary: 'Healthy.', details: {}, startedAt: values.clock(), completedAt: values.clock() }),
    clock: values.clock,
    probeId: 'local-windows:test'
  });
  assert.equal(transition.monitor.runtime.status, 'up');
  assert.equal((await values.database.getMonitor('local', stored.id)).runtime.status, 'up');
  assert.equal((await values.database.listChecks('local', stored.id)).length, 1);
});

test('dispatches due monitors within bounded concurrency and persists next schedules', async (context) => {
  const values = await fixture(context, { maximumConcurrency: 2, delayMs: 80 });
  const monitors = [];
  for (let index = 0; index < 4; index += 1) monitors.push(await values.database.createMonitor('local', 'tester', monitor(`Monitor ${index + 1}`)));
  values.worker.workspaceId = 'local';
  values.worker.actorId = 'worker';
  await values.worker.tick();
  await values.worker.stop({ drain: true });
  await values.worker.tick();
  await values.worker.stop({ drain: true });
  assert.equal(values.runs.length, 4);
  assert.equal(values.maximumActive(), 2);
  const stored = await values.database.listMonitors('local');
  assert.equal(stored.every((item) => item.nextCheckAt === '2026-08-04T12:01:00.000Z'), true);
  assert.equal(values.retentionRuns.length, 1);
  assert.equal((await values.database.listWorkerHeartbeats('local'))[0].state, 'stopping');
});

test('does not overlap a monitor when ticks and run-now requests race', async (context) => {
  const values = await fixture(context, { maximumConcurrency: 2, delayMs: 50 });
  const stored = await values.database.createMonitor('local', 'tester', monitor('Race target'));
  values.worker.workspaceId = 'local';
  values.worker.actorId = 'worker';
  await values.worker.tick();
  const runNow = await values.worker.runNow(stored.id);
  assert.equal(runNow.running, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(values.runs, [stored.id]);
});

test('runs one missed check after restart and schedules from the current completion time', async (context) => {
  const values = await fixture(context);
  const stored = await values.database.createMonitor('local', 'tester', monitor('Restart target', { nextCheckAt: '2026-08-04T10:00:00.000Z' }));
  values.worker.workspaceId = 'local';
  values.worker.actorId = 'worker';
  await values.worker.tick();
  await values.worker.stop({ drain: true });
  await values.worker.tick();
  await values.worker.stop({ drain: true });
  assert.deepEqual(values.runs, [stored.id]);
  assert.equal((await values.database.getMonitor('local', stored.id)).nextCheckAt, '2026-08-04T12:01:00.000Z');
});

test('continues interval checks until the monitor is paused', async (context) => {
  const values = await fixture(context);
  const stored = await values.database.createMonitor('local', 'tester', monitor('Continuous target'));
  await values.worker.start('local', 'worker');
  await waitFor(() => values.runs.length === 1);

  values.advance(60000);
  await waitFor(() => values.runs.length === 2);

  const current = await values.database.getMonitor('local', stored.id);
  await values.database.updateMonitor('local', 'tester', stored.id, { state: 'paused', nextCheckAt: null }, current.revision);
  values.advance(60000);
  await new Promise((resolve) => setTimeout(resolve, 180));
  await values.worker.stop({ drain: true });

  assert.equal(values.runs.length, 2);
  assert.equal((await values.database.getMonitor('local', stored.id)).nextCheckAt, null);
});

test('isolates a failed monitor task so other due monitors complete', async (context) => {
  const values = await fixture(context, {
    checkRunner: async (item) => {
      if (item.name === 'Failing target') throw new Error('Synthetic runner failure');
      return { outcome: 'up', ok: true, latencyMs: 10, statusCode: 200, summary: 'Healthy.', details: {}, startedAt: '2026-08-04T12:00:00.000Z', completedAt: '2026-08-04T12:00:00.000Z' };
    }
  });
  const failing = await values.database.createMonitor('local', 'tester', monitor('Failing target'));
  const healthy = await values.database.createMonitor('local', 'tester', monitor('Healthy target'));
  values.worker.workspaceId = 'local';
  values.worker.actorId = 'worker';
  await values.worker.tick();
  await values.worker.stop({ drain: true });
  assert.equal((await values.database.listChecks('local', healthy.id)).length, 1);
  assert.equal((await values.database.listChecks('local', failing.id)).length, 0);
  assert.match(values.worker.status().lastError, /Synthetic runner failure/);
});

test('marks failing checks as maintenance when an active scoped window applies', async (context) => {
  const values = await fixture(context, {
    checkRunner: async () => ({ outcome: 'down', ok: false, failureCategory: 'timeout', summary: 'Timed out.', startedAt: '2026-08-04T12:00:00.000Z', completedAt: '2026-08-04T12:00:00.000Z' })
  });
  const stored = await values.database.createMonitor('local', 'tester', monitor('Maintenance target'));
  await values.database.createMaintenanceWindow('local', 'tester', {
    name: 'Release', startsAt: '2026-08-04T11:55:00.000Z', endsAt: '2026-08-04T12:30:00.000Z', timezone: 'UTC', scope: { type: 'monitors', monitorIds: [stored.id] }
  });
  values.worker.workspaceId = 'local';
  values.worker.actorId = 'worker';
  await values.worker.runNow(stored.id);
  assert.equal((await values.database.listChecks('local', stored.id))[0].outcome, 'maintenance');
  assert.equal((await values.database.getMonitor('local', stored.id)).runtime.status, 'maintenance');
  assert.equal(await values.database.getActiveIncident('local', stored.id), null);
});

test('enforces 90-day raw-check and 13-month rollup retention boundaries', async (context) => {
  const values = await fixture(context);
  const stored = await values.database.createMonitor('local', 'tester', monitor('Retention target'));
  await values.database.recordCheck('local', { monitorId: stored.id, scheduledAt: '2026-04-01T00:00:00.000Z', startedAt: '2026-04-01T00:00:00.000Z', completedAt: '2026-04-01T00:00:00.000Z', outcome: 'up' });
  await values.database.recordCheck('local', { monitorId: stored.id, scheduledAt: '2026-08-01T00:00:00.000Z', startedAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-01T00:00:00.000Z', outcome: 'up' });
  await values.database.upsertDailyRollup('local', stored.id, '2025-06-30', { checkCount: 1 });
  await values.database.upsertDailyRollup('local', stored.id, '2025-07-01', { checkCount: 1 });
  const retention = new UptimeRetentionService({ controlDatabase: values.database, now: () => Date.parse('2026-08-04T12:00:00.000Z') });
  const result = await retention.run('local');
  assert.equal(result.checksDeleted, 1);
  assert.equal(result.rollupCutoff, '2025-07-01');
  assert.equal(result.rollupsDeleted, 1);
  assert.equal((await values.database.listChecks('local', stored.id)).length, 1);
  assert.deepEqual((await values.database.listDailyRollups('local')).map((item) => item.dateUtc), ['2025-07-01']);
});
