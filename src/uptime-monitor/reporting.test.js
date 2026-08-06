const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { UptimeControlDatabase } = require('./control-database');
const { UptimeDailyRollupService, buildUptimeReport, percentile, reportToCsv, uptimeReportHtml } = require('./reporting');

const FROM = '2026-08-04T00:00:00.000Z';
const TO = '2026-08-04T01:00:00.000Z';

function monitor(overrides = {}) {
  return {
    id: 'monitor-1', name: 'API', group: 'Production', projectId: null, type: 'http', state: 'enabled', intervalSec: 600,
    createdAt: FROM, stateEvents: [{ state: 'enabled', at: FROM }],
    ...overrides
  };
}

function check(minutes, overrides = {}) {
  const completedAt = new Date(Date.parse(FROM) + minutes * 60000).toISOString();
  return { id: `check-${minutes}`, monitorId: 'monitor-1', completedAt, outcome: 'up', latencyMs: minutes, summary: 'Healthy', probeId: 'local', ...overrides };
}

test('calculates availability only from confirmed covered time and reports gaps as unknown coverage', () => {
  const checks = [check(10), check(20), check(50, { outcome: 'down', failureCategory: 'timeout' }), check(60, { outcome: 'up' })];
  const report = buildUptimeReport({
    monitors: [monitor()],
    checksByMonitor: { 'monitor-1': checks },
    incidents: [{ id: 'incident-1', monitorId: 'monitor-1', state: 'resolved', severity: 'critical', openedAt: check(50).completedAt, resolvedAt: check(60).completedAt, summary: 'Down' }],
    from: FROM,
    to: TO
  });
  assert.equal(Math.round(report.summary.coveragePct), 67);
  assert.equal(Math.round(report.summary.availabilityPct), 75);
  assert.equal(report.summary.unknownMs, 20 * 60000);
  assert.equal(report.summary.downMs, 10 * 60000);
  assert.equal(report.monitors[0].failureCategories.timeout, 1);
});

test('excludes paused and scoped maintenance time from eligible monitoring', () => {
  const pausedAt = new Date(Date.parse(FROM) + 30 * 60000).toISOString();
  const report = buildUptimeReport({
    monitors: [monitor({ state: 'paused', stateEvents: [{ state: 'enabled', at: FROM }, { state: 'paused', at: pausedAt }] })],
    checksByMonitor: { 'monitor-1': [check(10), check(20), check(30)] },
    maintenance: [{ startsAt: check(10).completedAt, endsAt: check(20).completedAt, scope: { type: 'monitors', monitorIds: ['monitor-1'] } }],
    from: FROM,
    to: TO
  });
  assert.equal(report.monitors[0].eligibleMs, 20 * 60000);
  assert.equal(report.monitors[0].maintenanceMs, 10 * 60000);
  assert.equal(report.monitors[0].pausedMs, 30 * 60000);
  assert.equal(report.monitors[0].coveragePct, 100);
});

test('produces deterministic percentiles and explicit CSV datasets', () => {
  assert.equal(percentile([50, 10, 20, 40, 30], 0.95), 50);
  const report = buildUptimeReport({ monitors: [monitor()], checksByMonitor: { 'monitor-1': [check(10)] }, from: FROM, to: TO, filters: { slaTargetPct: 99.9 } });
  assert.equal(report.summary.slaTargetPct, 99.9);
  assert.equal(report.summary.slaMet, true);
  const csv = reportToCsv(report, 'summary');
  assert.match(csv, /^monitorId,name,group/);
  assert.match(csv, /monitor-1,API,Production/);
  assert.throws(() => reportToCsv(report, 'raw-json'), (error) => error.code === 'UPTIME_EXPORT_DATASET_INVALID');
});

test('uses the same report metrics in CSV and printable HTML with explicit filters and safe content', () => {
  const report = buildUptimeReport({
    monitors: [monitor({ name: 'API <primary>', projectId: 'server-1' })],
    checksByMonitor: { 'monitor-1': [check(10), check(20)] },
    incidents: [{ id: 'incident-html', monitorId: 'monitor-1', state: 'resolved', severity: 'critical', openedAt: check(10).completedAt, resolvedAt: check(20).completedAt, summary: '<script>alert(1)</script>' }],
    from: FROM,
    to: TO,
    filters: { monitorId: 'monitor-1', group: 'Production', projectId: 'server-1', slaTargetPct: 99.9 }
  });
  const csv = reportToCsv(report, 'summary');
  const html = uptimeReportHtml(report);
  assert.match(csv, new RegExp(String(report.monitors[0].availabilityPct)));
  assert.match(html, new RegExp(`${report.monitors[0].availabilityPct.toFixed(3)}%`));
  assert.match(html, /Filters: Monitor: monitor-1 \/ Group: Production \/ Server: server-1/);
  assert.match(html, /SLA result<strong>Missed \(99\.9%\)<\/strong>/);
  assert.match(html, /API &lt;primary&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, new RegExp(report.methodology.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('persists completed UTC-day rollups with maintenance, coverage, incidents, percentiles, and workspace isolation', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-uptime-rollup-test-'));
  const database = new UptimeControlDatabase({ rootPath, clock: () => FROM });
  await database.initialize();
  context.after(async () => {
    await database.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  const durableInput = { intervalSec: 600, timeoutMs: 5000, config: { url: 'https://example.test/health' } };
  const storedMonitor = await database.createMonitor('workspace-a', 'tester', monitor(durableInput));
  await database.createMonitor('workspace-b', 'tester', monitor({ ...durableInput, id: 'monitor-b' }));
  const at = (minutes) => new Date(Date.parse(FROM) + minutes * 60000).toISOString();
  for (const [minutes, outcome, latencyMs] of [[10, 'up', 10], [20, 'up', 20], [30, 'warning', 30], [50, 'down', 50], [60, 'up', 100]]) {
    await database.recordCheck('workspace-a', {
      id: `stored-check-${minutes}`,
      monitorId: storedMonitor.id,
      scheduledAt: at(minutes),
      startedAt: at(minutes),
      completedAt: at(minutes),
      outcome,
      latencyMs,
      failureCategory: outcome === 'down' ? 'timeout' : '',
      summary: outcome === 'down' ? 'Request timed out.' : 'Healthy'
    });
  }
  const incident = await database.createIncident('workspace-a', 'worker', {
    id: 'stored-incident',
    monitorId: storedMonitor.id,
    state: 'open',
    severity: 'critical',
    openedAt: at(50),
    summary: 'Request timed out.',
    failureCategory: 'timeout'
  });
  await database.updateIncident('workspace-a', 'worker', incident.id, { state: 'resolved', resolvedAt: at(60) }, incident.revision);
  await database.createMaintenanceWindow('workspace-a', 'tester', {
    name: 'Planned work',
    startsAt: at(10),
    endsAt: at(20),
    scope: { type: 'monitors', monitorIds: [storedMonitor.id] }
  });

  const result = await new UptimeDailyRollupService({ controlDatabase: database }).run('workspace-a', '2026-08-04');
  const [rollup] = await database.listDailyRollups('workspace-a');
  assert.equal(result.monitorCount, 1);
  assert.equal(rollup.eligibleMs, 1430 * 60000);
  assert.equal(rollup.maintenanceMs, 10 * 60000);
  assert.equal(rollup.unknownMs, 1390 * 60000);
  assert.equal(rollup.upMs, 20 * 60000);
  assert.equal(rollup.downMs, 10 * 60000);
  assert.equal(rollup.warningMs, 10 * 60000);
  assert.equal(rollup.checkCount, 5);
  assert.equal(rollup.successfulCheckCount, 3);
  assert.equal(rollup.failedCheckCount, 1);
  assert.equal(rollup.latencyCount, 5);
  assert.equal(rollup.latencySumMs, 210);
  assert.equal(rollup.latencyP50Ms, 30);
  assert.equal(rollup.latencyP95Ms, 100);
  assert.equal(rollup.latencyP99Ms, 100);
  assert.equal(Math.round(rollup.availabilityPct), 75);
  assert.equal(Math.round(rollup.coveragePct), 3);
  assert.deepEqual(await database.listDailyRollups('workspace-b'), []);
});
