const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UptimeControlDatabase } = require('./control-database');
const { LEGACY_MIGRATION_MARKER, migrateLegacyUptime } = require('./legacy-migration');

test('imports legacy monitors, full NDJSON history, incidents, and sensitive headers once', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-uptime-migration-test-'));
  const databaseRoot = path.join(rootPath, 'database');
  const legacyRoot = path.join(rootPath, 'uptime');
  const monitorRoot = path.join(legacyRoot, 'projects', 'project-1', 'legacy-monitor-1');
  await fs.mkdir(monitorRoot, { recursive: true });
  await fs.writeFile(path.join(monitorRoot, 'history.ndjson'), [
    JSON.stringify({ id: 'legacy-check-1', at: '2026-08-01T10:00:00.000Z', ok: false, status: 'down', latencyMs: 1000, summary: 'HTTP 503' }),
    '{malformed',
    JSON.stringify({ id: 'legacy-check-2', at: '2026-08-01T10:05:00.000Z', ok: true, status: 'up', latencyMs: 50, summary: 'HTTP 200' })
  ].join('\n'));
  await fs.writeFile(path.join(monitorRoot, 'incidents.ndjson'), [
    JSON.stringify({ incidentId: 'legacy-incident-1', event: 'opened', at: '2026-08-01T10:00:00.000Z', message: 'Down' }),
    JSON.stringify({ incidentId: 'legacy-incident-1', event: 'resolved', at: '2026-08-01T10:05:00.000Z', message: 'Recovered' })
  ].join('\n'));
  const database = new UptimeControlDatabase({ rootPath: databaseRoot, clock: () => '2026-08-04T12:00:00.000Z' });
  await database.initialize();
  context.after(async () => { await database.close(); await fs.rm(rootPath, { recursive: true, force: true }); });
  const secrets = [];
  const projects = [{
    id: 'project-1', name: 'API Server', group: 'Production', uptimeMonitors: [{
      id: 'legacy-monitor-1', name: 'Legacy API', type: 'http', enabled: true, intervalSec: 300, timeoutMs: 10000, latencyBudgetMs: 2000,
      http: { url: 'https://api.example.test/health', method: 'GET', headers: { Authorization: 'Bearer legacy-secret', Accept: 'application/json' }, expectedStatusCodes: [200, 204], bodyMustContain: ['ok'] }
    }]
  }];
  const first = await migrateLegacyUptime({
    workspaceId: 'local', actorId: 'migration', projects, legacyRootPath: legacyRoot, controlDatabase: database,
    importSecret: async (input) => { secrets.push(input); return 'sec-imported-authorization'; }
  });
  assert.equal(first.importedMonitors, 1);
  assert.equal(first.importedChecks, 2);
  assert.equal(first.importedIncidents, 1);
  assert.equal(secrets[0].value, 'Bearer legacy-secret');
  const stored = await database.getMonitor('local', 'legacy-monitor-1');
  assert.equal(stored.projectId, 'project-1');
  assert.equal(stored.parentGroup, 'API Server');
  assert.equal(stored.config.headers.accept, 'application/json');
  assert.equal(stored.config.secretHeaderRefs.authorization, 'sec-imported-authorization');
  assert.equal(JSON.stringify(stored).includes('legacy-secret'), false);
  assert.equal((await database.listChecks('local', stored.id)).length, 2);
  assert.equal((await database.listIncidents('local', { monitorId: stored.id }))[0].state, 'resolved');
  assert.ok(await database.getMigrationMarker('local', LEGACY_MIGRATION_MARKER));

  const second = await migrateLegacyUptime({ workspaceId: 'local', actorId: 'migration', projects, legacyRootPath: legacyRoot, controlDatabase: database, importSecret: async () => 'duplicate' });
  assert.equal(second.alreadyCompleted, true);
  assert.equal((await database.listMonitors('local')).length, 1);
  assert.equal((await database.listChecks('local', stored.id)).length, 2);
});
