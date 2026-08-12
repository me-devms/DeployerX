const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  UptimeControlDatabase,
  UptimeControlDatabaseCorruptionError,
  UptimeRevisionConflictError
} = require('./control-database');
const { UptimeValidationError, normalizeMonitorInput } = require('./domain');

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-uptime-control-test-'));
  let currentMs = Date.parse('2026-08-04T08:00:00.000Z');
  const clock = () => new Date(currentMs).toISOString();
  const database = new UptimeControlDatabase({ rootPath, clock });
  await database.initialize();
  context.after(async () => {
    await database.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });
  return {
    database,
    rootPath,
    clock,
    advance(milliseconds) { currentMs += milliseconds; }
  };
}

function httpMonitor(overrides = {}) {
  return {
    name: 'Production API',
    projectId: null,
    group: 'Production',
    tags: ['API', 'Critical', 'api'],
    type: 'http',
    intervalSec: 60,
    timeoutMs: 10000,
    config: {
      url: 'https://example.test/health',
      method: 'GET',
      headers: { Accept: 'application/json' },
      secretHeaderRefs: { Authorization: 'sec_http_authorization' },
      expectedStatusRanges: ['200-299'],
      assertions: [{ target: 'jsonpath', selector: '$.ok', operator: 'equals', expected: 'true' }]
    },
    alertPolicy: { failureThreshold: 2, recoveryThreshold: 1 },
    notificationRouteIds: ['notify_desktop', 'notify_email'],
    ...overrides
  };
}

test('normalizes standalone HTTP monitors and rejects unsafe credentials', () => {
  const normalized = normalizeMonitorInput(httpMonitor());
  assert.equal(normalized.projectId, null);
  assert.deepEqual(normalized.tags, ['api', 'critical']);
  assert.deepEqual(normalized.config.secretHeaderRefs, { authorization: 'sec_http_authorization' });
  assert.deepEqual(normalized.config.expectedStatusRanges, [{ minimum: 200, maximum: 299 }]);
  assert.throws(
    () => normalizeMonitorInput(httpMonitor({ config: { url: 'https://example.test', headers: { Authorization: 'Bearer plaintext' } } })),
    (error) => error instanceof UptimeValidationError && error.code === 'UPTIME_HTTP_SECRET_REQUIRED'
  );
  assert.throws(
    () => normalizeMonitorInput(httpMonitor({ config: { url: 'file:///etc/passwd' } })),
    (error) => error instanceof UptimeValidationError && error.code === 'UPTIME_HTTP_URL_INVALID'
  );
});

test('persists workspace-scoped standalone and server-linked monitors with revisions', async (context) => {
  const { database, rootPath } = await fixture(context);
  const standalone = await database.createMonitor('workspace-a', 'tester', httpMonitor());
  const linked = await database.createMonitor('workspace-a', 'tester', httpMonitor({ name: 'Server health', projectId: 'project-1' }));
  await database.createMonitor('workspace-b', 'tester', httpMonitor());

  assert.equal(standalone.revision, 1);
  assert.equal(linked.projectId, 'project-1');
  assert.equal((await database.listMonitors('workspace-a')).length, 2);
  assert.equal((await database.listMonitors('workspace-b')).length, 1);

  const updated = await database.updateMonitor('workspace-a', 'editor', standalone.id, { intervalSec: 120, state: 'paused' }, standalone.revision);
  assert.equal(updated.intervalSec, 120);
  assert.equal(updated.state, 'paused');
  assert.deepEqual(updated.stateEvents.map((event) => event.state), ['enabled', 'paused']);
  assert.equal(updated.revision, 2);
  assert.equal(updated.updatedBy, 'editor');
  await assert.rejects(
    database.updateMonitor('workspace-a', 'editor', standalone.id, { intervalSec: 180 }, standalone.revision),
    UptimeRevisionConflictError
  );

  await database.close();
  const reopened = new UptimeControlDatabase({ rootPath });
  await reopened.initialize();
  assert.equal((await reopened.getMonitor('workspace-a', standalone.id)).intervalSec, 120);
  await reopened.close();
});

test('reuses the loaded database until another process changes the file', async (context) => {
  const values = await fixture(context);
  await values.database.createMonitor('workspace-a', 'tester', httpMonitor());
  const databasePath = path.join(values.rootPath, 'control.db');
  const originalReadFile = fs.readFile;
  let databaseReads = 0;
  fs.readFile = async (...args) => {
    if (String(args[0]) === databasePath) databaseReads += 1;
    return originalReadFile(...args);
  };
  try {
    await values.database.listMonitors('workspace-a');
    await values.database.listMonitors('workspace-a');
  } finally {
    fs.readFile = originalReadFile;
  }
  assert.equal(databaseReads, 0);

  const externalDatabase = new UptimeControlDatabase({ rootPath: values.rootPath, clock: values.clock });
  await externalDatabase.initialize();
  await externalDatabase.createMonitor('workspace-a', 'tester', httpMonitor({ name: 'Externally added monitor' }));
  await externalDatabase.close();

  databaseReads = 0;
  fs.readFile = async (...args) => {
    if (String(args[0]) === databasePath) databaseReads += 1;
    return originalReadFile(...args);
  };
  let monitors;
  try {
    monitors = await values.database.listMonitors('workspace-a');
  } finally {
    fs.readFile = originalReadFile;
  }
  assert.equal(databaseReads, 1);
  assert.equal(monitors.length, 2);
});

test('imports workspace snapshots without changing shared ids, revisions, or timestamps', async (context) => {
  const { database } = await fixture(context);
  const monitor = await database.upsertMonitorSnapshot('workspace-a', {
    ...httpMonitor(),
    id: 'monitor-shared',
    revision: 7,
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-04T08:00:00.000Z',
    createdBy: 'owner-user',
    updatedBy: 'member-user',
    nextCheckAt: '2026-08-04T08:01:00.000Z',
    runtime: { status: 'down', consecutiveFailures: 2, lastFailureAt: '2026-08-04T08:00:00.000Z' }
  });
  const check = await database.upsertCheckSnapshot('workspace-a', {
    id: 'check-shared', monitorId: monitor.id, probeId: 'device-owner',
    scheduledAt: '2026-08-04T08:00:00.000Z', startedAt: '2026-08-04T08:00:00.000Z', completedAt: '2026-08-04T08:00:01.000Z',
    outcome: 'down', latencyMs: 1000, failureCategory: 'timeout', summary: 'Request timed out.'
  });
  const incident = await database.upsertIncidentSnapshot('workspace-a', {
    id: 'incident-shared', monitorId: monitor.id, state: 'open', severity: 'critical',
    openedAt: '2026-08-04T08:00:01.000Z', summary: 'Request timed out.', consecutiveFailures: 2,
    revision: 3, createdAt: '2026-08-04T08:00:01.000Z', updatedAt: '2026-08-04T08:00:02.000Z',
    createdBy: 'owner-user', updatedBy: 'member-user'
  });
  const maintenance = await database.upsertMaintenanceSnapshot('workspace-a', {
    id: 'maintenance-shared', name: 'Release window', state: 'enabled',
    startsAt: '2026-08-04T09:00:00.000Z', endsAt: '2026-08-04T10:00:00.000Z', timezone: 'UTC', scope: { type: 'workspace' },
    revision: 2, createdAt: '2026-08-03T08:00:00.000Z', updatedAt: '2026-08-04T07:00:00.000Z',
    createdBy: 'owner-user', updatedBy: 'member-user'
  });

  assert.equal(monitor.id, 'monitor-shared');
  assert.equal(monitor.revision, 7);
  assert.equal(monitor.updatedAt, '2026-08-04T08:00:00.000Z');
  assert.equal(check.id, 'check-shared');
  assert.equal(incident.revision, 3);
  assert.equal(maintenance.revision, 2);
  assert.equal((await database.listMonitors('workspace-a')).length, 1);
  assert.equal((await database.listChecks('workspace-a', monitor.id))[0].outcome, 'down');
  assert.equal((await database.listIncidents('workspace-a'))[0].id, incident.id);
  assert.equal((await database.listMaintenanceWindows('workspace-a'))[0].id, maintenance.id);
});

test('records and filters durable checks without crossing workspaces', async (context) => {
  const values = await fixture(context);
  const monitor = await values.database.createMonitor('workspace-a', 'tester', httpMonitor());
  const check = await values.database.recordCheck('workspace-a', {
    id: 'check-1',
    monitorId: monitor.id,
    probeId: 'local-windows:device-a',
    scheduledAt: values.clock(),
    startedAt: values.clock(),
    completedAt: values.clock(),
    outcome: 'up',
    latencyMs: 42.5,
    statusCode: 204,
    summary: 'HTTP 204 in 43 ms',
    details: { responseHeaders: { 'content-type': 'application/json' } }
  });
  values.advance(60000);
  await values.database.recordCheck('workspace-a', {
    id: 'check-2', monitorId: monitor.id, scheduledAt: values.clock(), startedAt: values.clock(), completedAt: values.clock(),
    outcome: 'down', failureCategory: 'timeout', summary: 'Request timed out.'
  });

  assert.equal(check.latencyMs, 42.5);
  assert.equal((await values.database.listChecks('workspace-a', monitor.id)).length, 2);
  assert.equal((await values.database.listChecks('workspace-a', monitor.id, { outcome: 'down' }))[0].id, 'check-2');
  assert.equal((await values.database.listChecks('workspace-b', monitor.id)).length, 0);
  await assert.rejects(
    values.database.recordCheck('workspace-b', { monitorId: monitor.id, scheduledAt: values.clock(), startedAt: values.clock(), completedAt: values.clock(), outcome: 'up' }),
    (error) => error.code === 'UPTIME_MONITOR_NOT_FOUND'
  );
});

test('enforces one active incident per monitor and persists acknowledgement and resolution', async (context) => {
  const values = await fixture(context);
  const monitor = await values.database.createMonitor('local', 'tester', httpMonitor());
  const incident = await values.database.createIncident('local', 'worker', {
    id: 'incident-1', monitorId: monitor.id, state: 'open', severity: 'critical', openedAt: values.clock(), summary: 'Endpoint is down.', failureCategory: 'timeout', consecutiveFailures: 2
  });
  await assert.rejects(
    values.database.createIncident('local', 'worker', { monitorId: monitor.id, state: 'open', severity: 'critical', openedAt: values.clock(), summary: 'Duplicate.', consecutiveFailures: 3 }),
    /UNIQUE constraint failed/
  );
  values.advance(30000);
  const acknowledged = await values.database.updateIncident('local', 'operator', incident.id, { state: 'acknowledged', acknowledgedAt: values.clock(), events: [{ type: 'acknowledged', at: values.clock() }] }, incident.revision);
  assert.equal((await values.database.getActiveIncident('local', monitor.id)).state, 'acknowledged');
  values.advance(30000);
  const resolved = await values.database.updateIncident('local', 'worker', incident.id, { state: 'resolved', resolvedAt: values.clock() }, acknowledged.revision);
  assert.equal(resolved.state, 'resolved');
  assert.equal(await values.database.getActiveIncident('local', monitor.id), null);
});

test('stores maintenance windows, rollups, worker heartbeats, markers, and retention results', async (context) => {
  const values = await fixture(context);
  const monitor = await values.database.createMonitor('local', 'tester', httpMonitor());
  const maintenance = await values.database.createMaintenanceWindow('local', 'tester', {
    name: 'Database upgrade', startsAt: values.clock(), endsAt: new Date(Date.parse(values.clock()) + 3600000).toISOString(),
    timezone: 'Asia/Calcutta', scope: { type: 'monitors', monitorIds: [monitor.id] }, reason: 'Planned release'
  });
  assert.equal((await values.database.listMaintenanceWindows('local', { activeAt: values.clock() }))[0].id, maintenance.id);
  values.advance(1000);
  const updatedMaintenance = await values.database.updateMaintenanceWindow('local', 'editor', maintenance.id, {
    name: 'Extended database upgrade',
    endsAt: new Date(Date.parse(values.clock()) + 7200000).toISOString()
  }, maintenance.revision);
  assert.equal(updatedMaintenance.name, 'Extended database upgrade');
  assert.equal(updatedMaintenance.revision, 2);
  assert.equal(updatedMaintenance.updatedBy, 'editor');
  await assert.rejects(
    values.database.updateMaintenanceWindow('local', 'editor', maintenance.id, { name: 'Stale edit' }, maintenance.revision),
    UptimeRevisionConflictError
  );

  await values.database.upsertDailyRollup('local', monitor.id, '2026-08-04', { eligibleMs: 3600000, upMs: 3540000, downMs: 60000, checkCount: 60, successfulCheckCount: 59, failedCheckCount: 1, latencyCount: 59, latencySumMs: 2950, latencyP50Ms: 45, latencyP95Ms: 90, latencyP99Ms: 120 });
  assert.equal((await values.database.listDailyRollups('local'))[0].upMs, 3540000);

  await values.database.recordWorkerHeartbeat('local', 'local-windows:device-a', { state: 'active', heartbeatAt: values.clock(), processId: 1234, monitorCount: 1 });
  assert.equal((await values.database.listWorkerHeartbeats('local'))[0].monitorCount, 1);
  assert.equal(await values.database.getMigrationMarker('local', 'legacy-v1'), null);
  await values.database.setMigrationMarker('local', 'legacy-v1', { importedMonitors: 1 });
  assert.equal((await values.database.getMigrationMarker('local', 'legacy-v1')).importedMonitors, 1);

  await values.database.recordCheck('local', { monitorId: monitor.id, scheduledAt: values.clock(), startedAt: values.clock(), completedAt: values.clock(), outcome: 'up' });
  values.advance(2 * 86400000);
  assert.equal(await values.database.pruneChecksBefore('local', values.clock()), 1);

  const deletedMaintenance = await values.database.deleteMaintenanceWindow('local', 'tester', maintenance.id, updatedMaintenance.revision);
  assert.equal(deletedMaintenance.deleted, true);
  assert.equal((await values.database.listMaintenanceWindows('local')).length, 0);
  assert.equal((await values.database.listMaintenanceWindows('local', { includeDeleted: true }))[0].deletedAt, values.clock());
});

test('soft deletion preserves history and hides the monitor from active queries', async (context) => {
  const values = await fixture(context);
  const monitor = await values.database.createMonitor('local', 'tester', httpMonitor());
  await values.database.recordCheck('local', { monitorId: monitor.id, scheduledAt: values.clock(), startedAt: values.clock(), completedAt: values.clock(), outcome: 'up' });
  const result = await values.database.deleteMonitor('local', 'tester', monitor.id, monitor.revision);
  assert.equal(result.deleted, true);
  assert.equal(await values.database.getMonitor('local', monitor.id), null);
  assert.equal((await values.database.getMonitor('local', monitor.id, { includeDeleted: true })).state, 'disabled');
  assert.equal((await values.database.listChecks('local', monitor.id)).length, 1);
});

test('detects schema damage instead of silently recreating indexes', async (context) => {
  const values = await fixture(context);
  await values.database.close();
  const bytes = await fs.readFile(path.join(values.rootPath, 'control.db'));
  const initSqlJs = require('sql.js/dist/sql-asm.js');
  const SqlJs = await initSqlJs();
  const raw = new SqlJs.Database(bytes);
  raw.run('DROP INDEX idx_uptime_checks_monitor_completed');
  await fs.writeFile(path.join(values.rootPath, 'control.db'), Buffer.from(raw.export()));
  raw.close();
  const damaged = new UptimeControlDatabase({ rootPath: values.rootPath });
  await assert.rejects(damaged.initialize(), UptimeControlDatabaseCorruptionError);
});
