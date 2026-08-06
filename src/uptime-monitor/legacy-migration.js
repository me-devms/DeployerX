const fs = require('node:fs/promises');
const path = require('node:path');

const LEGACY_MIGRATION_MARKER = 'legacy-project-ndjson-v1';
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);

async function readNdjson(filePath) {
  let raw;
  try { raw = await fs.readFile(filePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; }
    catch { return []; }
  });
}

function legacyAssertions(http = {}) {
  const assertions = [];
  for (const value of Array.isArray(http.bodyMustContain) ? http.bodyMustContain : []) {
    if (String(value || '').trim()) assertions.push({ target: 'body', operator: 'contains', expected: String(value).trim() });
  }
  for (const value of Array.isArray(http.bodyMustNotContain) ? http.bodyMustNotContain : []) {
    if (String(value || '').trim()) assertions.push({ target: 'body', operator: 'not-contains', expected: String(value).trim() });
  }
  for (const assertion of Array.isArray(http.headerAssertions) ? http.headerAssertions : []) {
    const selector = String(assertion.key || assertion.name || '').trim();
    const expected = String(assertion.expected || assertion.value || '').trim();
    if (selector && expected) assertions.push({ target: 'header', selector, operator: assertion.mode === 'contains' ? 'contains' : 'equals', expected });
  }
  return assertions;
}

function legacyStatusRanges(values) {
  const statuses = Array.isArray(values) ? values.map(Number).filter((value) => Number.isInteger(value) && value >= 100 && value <= 599) : [200];
  return statuses.length ? statuses : [200];
}

async function normalizeLegacyMonitor(project, monitor, importSecret) {
  const type = monitor.type === 'tcp' ? 'tcp' : 'http';
  let config;
  if (type === 'tcp') {
    config = { host: String(monitor.tcp?.host || monitor.host || '').trim(), port: Number(monitor.tcp?.port || monitor.port || 80) };
  } else {
    const http = monitor.http || monitor.config || monitor;
    const headers = {};
    const secretHeaderRefs = {};
    for (const [name, value] of Object.entries(http.headers || {})) {
      const key = String(name || '').trim().toLowerCase();
      if (!key || value == null || value === '') continue;
      if (SENSITIVE_HEADERS.has(key)) secretHeaderRefs[key] = await importSecret({ monitor, project, headerName: key, value: String(value) });
      else headers[key] = String(value);
    }
    config = {
      url: String(http.url || monitor.url || '').trim(),
      method: String(http.method || monitor.method || 'GET').toUpperCase(),
      headers,
      secretHeaderRefs,
      expectedStatusRanges: legacyStatusRanges(http.expectedStatusCodes || monitor.expectedStatusCodes),
      assertions: legacyAssertions(http),
      followRedirects: true,
      verifyTls: true
    };
  }
  return {
    id: String(monitor.id || '').trim() || undefined,
    name: String(monitor.name || '').trim() || `${type.toUpperCase()} monitor`,
    projectId: String(project.id || '').trim() || null,
    group: String(project.group || '').trim(),
    tags: ['legacy-import'],
    type,
    state: monitor.enabled === false ? 'paused' : 'enabled',
    intervalSec: Number(monitor.intervalSec || 300),
    timeoutMs: Number(monitor.timeoutMs || 10000),
    config,
    alertPolicy: {
      failureThreshold: 2,
      recoveryThreshold: 1,
      latencyCriticalMs: Number(monitor.latencyBudgetMs || 0),
      notifyOnWarning: true,
      notifyOnRecovery: true
    },
    notificationRouteIds: []
  };
}

function incidentRecords(events, monitorId) {
  const grouped = new Map();
  for (const event of events) {
    const id = String(event.incidentId || '').trim();
    if (!id) continue;
    const current = grouped.get(id) || { id, monitorId, openedAt: null, resolvedAt: null, events: [] };
    const at = event.at || event.occurredAt;
    if (event.event === 'opened' && !current.openedAt) current.openedAt = at;
    if (event.event === 'resolved') current.resolvedAt = at;
    current.events.push({ type: event.event || 'legacy', at, summary: String(event.message || '').slice(0, 1000) });
    current.summary = String(event.message || current.summary || 'Legacy uptime incident.').slice(0, 1000);
    grouped.set(id, current);
  }
  return [...grouped.values()].filter((incident) => incident.openedAt).map((incident) => ({
    ...incident,
    state: incident.resolvedAt ? 'resolved' : 'open',
    severity: 'critical',
    summary: incident.summary || 'Legacy uptime incident.',
    failureCategory: 'legacy',
    consecutiveFailures: 2
  }));
}

async function migrateLegacyUptime({ workspaceId, actorId, projects = [], legacyRootPath, controlDatabase, importSecret = async () => { throw new Error('Secret importer is required.'); } } = {}) {
  if (!controlDatabase) throw new TypeError('Uptime control database is required.');
  const existingMarker = await controlDatabase.getMigrationMarker(workspaceId, LEGACY_MIGRATION_MARKER);
  if (existingMarker) return { ...existingMarker, alreadyCompleted: true };
  const summary = { importedMonitors: 0, skippedMonitors: 0, importedChecks: 0, importedIncidents: 0, warnings: [] };
  for (const project of Array.isArray(projects) ? projects : []) {
    for (const legacy of Array.isArray(project.uptimeMonitors) ? project.uptimeMonitors : []) {
      try {
        const id = String(legacy.id || '').trim();
        let stored = id ? await controlDatabase.getMonitor(workspaceId, id, { includeDeleted: true }) : null;
        if (!stored) {
          const normalized = await normalizeLegacyMonitor(project, legacy, importSecret);
          stored = await controlDatabase.createMonitor(workspaceId, actorId, normalized);
          summary.importedMonitors += 1;
        } else summary.skippedMonitors += 1;
        const monitorRoot = path.join(legacyRootPath, 'projects', String(project.id), String(legacy.id));
        const history = await readNdjson(path.join(monitorRoot, 'history.ndjson'));
        const existingChecks = new Set((await controlDatabase.listChecks(workspaceId, stored.id, { limit: 100000 })).map((check) => check.id));
        for (const check of history) {
          const checkId = String(check.id || '').trim();
          if (checkId && existingChecks.has(checkId)) continue;
          try {
            await controlDatabase.recordCheck(workspaceId, {
              id: checkId || undefined,
              monitorId: stored.id,
              probeId: 'legacy-local',
              scheduledAt: check.at,
              startedAt: check.at,
              completedAt: check.at,
              outcome: check.ok ? (check.status === 'degraded' ? 'warning' : 'up') : 'down',
              latencyMs: check.latencyMs,
              statusCode: check.details?.statusCode,
              failureCategory: check.ok ? '' : 'legacy',
              summary: check.summary || check.error || 'Legacy check.',
              details: { imported: true, legacyStatus: check.status || null }
            });
            summary.importedChecks += 1;
          } catch (error) {
            summary.warnings.push(`Check ${checkId || 'without ID'} for ${stored.name}: ${error.message}`);
          }
        }
        const legacyIncidents = await readNdjson(path.join(monitorRoot, 'incidents.ndjson'));
        const existingIncidents = new Set((await controlDatabase.listIncidents(workspaceId, { monitorId: stored.id, limit: 10000 })).map((incident) => incident.id));
        for (const incident of incidentRecords(legacyIncidents, stored.id)) {
          if (existingIncidents.has(incident.id)) continue;
          try { await controlDatabase.createIncident(workspaceId, actorId, incident); summary.importedIncidents += 1; }
          catch (error) { summary.warnings.push(`Incident ${incident.id} for ${stored.name}: ${error.message}`); }
        }
      } catch (error) {
        summary.skippedMonitors += 1;
        summary.warnings.push(`Monitor ${legacy.name || legacy.id || 'unknown'}: ${error.message}`);
      }
    }
  }
  return controlDatabase.setMigrationMarker(workspaceId, LEGACY_MIGRATION_MARKER, summary);
}

module.exports = {
  LEGACY_MIGRATION_MARKER,
  incidentRecords,
  legacyAssertions,
  migrateLegacyUptime,
  normalizeLegacyMonitor,
  readNdjson
};
