function maintenanceApplies(window, monitor) {
  const scope = window.scope || { type: 'workspace' };
  if (scope.type === 'workspace') return true;
  if (scope.type === 'group') return String(scope.group || '') === String(monitor.group || '');
  if (scope.type === 'project') return String(scope.projectId || '') === String(monitor.projectId || '');
  if (scope.type === 'monitors') return Array.isArray(scope.monitorIds) && scope.monitorIds.map(String).includes(String(monitor.id));
  return false;
}

function asMs(value, label) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw Object.assign(new Error(`${label} is invalid.`), { code: 'UPTIME_REPORT_RANGE_INVALID' });
  return milliseconds;
}

function clipInterval(start, end, from, to) {
  const clippedStart = Math.max(start, from);
  const clippedEnd = Math.min(end, to);
  return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
}

function mergeIntervals(intervals = []) {
  const sorted = intervals.filter(Boolean).map(([start, end]) => [Number(start), Number(end)]).filter(([start, end]) => end > start).sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval[0] > previous[1]) merged.push([...interval]);
    else previous[1] = Math.max(previous[1], interval[1]);
  }
  return merged;
}

function intervalDuration(intervals = []) {
  return mergeIntervals(intervals).reduce((total, [start, end]) => total + end - start, 0);
}

function intersectIntervals(left = [], right = []) {
  const first = mergeIntervals(left);
  const second = mergeIntervals(right);
  const intersections = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < first.length && rightIndex < second.length) {
    const interval = clipInterval(first[leftIndex][0], first[leftIndex][1], second[rightIndex][0], second[rightIndex][1]);
    if (interval) intersections.push(interval);
    if (first[leftIndex][1] <= second[rightIndex][1]) leftIndex += 1;
    else rightIndex += 1;
  }
  return intersections;
}

function subtractIntervals(base = [], exclusions = []) {
  let result = mergeIntervals(base);
  for (const [excludedStart, excludedEnd] of mergeIntervals(exclusions)) {
    const next = [];
    for (const [start, end] of result) {
      if (excludedEnd <= start || excludedStart >= end) next.push([start, end]);
      else {
        if (excludedStart > start) next.push([start, excludedStart]);
        if (excludedEnd < end) next.push([excludedEnd, end]);
      }
    }
    result = next;
  }
  return result;
}

function percentile(values, percentage) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(percentage * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

function enabledIntervals(monitor, from, to) {
  const createdAt = Math.max(from, asMs(monitor.createdAt || new Date(from).toISOString(), 'Monitor creation time'));
  if (createdAt >= to) return [];
  const events = Array.isArray(monitor.stateEvents) ? monitor.stateEvents
    .map((event) => ({ state: String(event.state || ''), at: Date.parse(event.at) }))
    .filter((event) => Number.isFinite(event.at) && event.at <= to)
    .sort((left, right) => left.at - right.at) : [];
  let state = events.filter((event) => event.at <= createdAt).at(-1)?.state || events[0]?.state || monitor.state || 'enabled';
  let cursor = createdAt;
  const intervals = [];
  for (const event of events) {
    if (event.at <= cursor) { state = event.state; continue; }
    if (state === 'enabled') intervals.push([cursor, Math.min(event.at, to)]);
    cursor = Math.min(event.at, to);
    state = event.state;
    if (cursor >= to) break;
  }
  if (cursor < to && state === 'enabled') intervals.push([cursor, to]);
  return mergeIntervals(intervals);
}

function monitorMetrics({ monitor, checks = [], incidents = [], maintenance = [], from, to }) {
  const firstCheckAt = checks.reduce((earliest, check) => {
    const at = Date.parse(check.completedAt);
    return Number.isFinite(at) ? Math.min(earliest, at) : earliest;
  }, Number.POSITIVE_INFINITY);
  const effectiveMonitor = Number.isFinite(firstCheckAt) && firstCheckAt < Date.parse(monitor.createdAt || '')
    ? { ...monitor, createdAt: new Date(firstCheckAt).toISOString() }
    : monitor;
  const active = enabledIntervals(effectiveMonitor, from, to);
  const maintenanceIntervals = maintenance
    .filter((window) => maintenanceApplies(window, monitor))
    .map((window) => clipInterval(asMs(window.startsAt, 'Maintenance start time'), asMs(window.endsAt, 'Maintenance end time'), from, to));
  const eligible = subtractIntervals(active, maintenanceIntervals);
  const intervalMs = Math.max(30000, Number(monitor.intervalSec || 60) * 1000);
  const relevantChecks = checks.filter((check) => {
    const at = Date.parse(check.completedAt);
    return Number.isFinite(at) && at >= from && at <= to;
  });
  const checkCoverage = relevantChecks.map((check) => {
    const at = Date.parse(check.completedAt);
    return clipInterval(at - intervalMs, at, from, to);
  });
  const covered = intersectIntervals(eligible, checkCoverage);
  const incidentIntervals = incidents.filter((incident) => incident.monitorId === monitor.id).map((incident) => {
    const start = asMs(incident.openedAt, 'Incident open time');
    const end = incident.resolvedAt ? asMs(incident.resolvedAt, 'Incident resolution time') : to;
    return clipInterval(start, end, from, to);
  });
  const downtime = intersectIntervals(covered, incidentIntervals);
  const warningCoverage = intersectIntervals(covered, relevantChecks.filter((check) => check.outcome === 'warning').map((check) => {
    const at = Date.parse(check.completedAt);
    return clipInterval(at - intervalMs, at, from, to);
  }));
  const eligibleMs = intervalDuration(eligible);
  const coveredMs = intervalDuration(covered);
  const downMs = intervalDuration(downtime);
  const warningMs = intervalDuration(subtractIntervals(warningCoverage, downtime));
  const latencies = relevantChecks.map((check) => check.latencyMs).filter((value) => Number.isFinite(Number(value))).map(Number);
  const failures = relevantChecks.filter((check) => check.outcome === 'down');
  return {
    monitorId: monitor.id,
    name: monitor.name,
    group: monitor.group || '',
    projectId: monitor.projectId || null,
    type: monitor.type,
    state: monitor.state,
    eligibleMs,
    coveredMs,
    unknownMs: Math.max(0, eligibleMs - coveredMs),
    maintenanceMs: intervalDuration(intersectIntervals(active, maintenanceIntervals)),
    pausedMs: Math.max(0, to - from - intervalDuration(active)),
    downMs,
    warningMs,
    availabilityPct: coveredMs ? Math.max(0, (coveredMs - downMs) / coveredMs * 100) : null,
    coveragePct: eligibleMs ? Math.min(100, coveredMs / eligibleMs * 100) : null,
    incidentCount: incidentIntervals.filter(Boolean).length,
    checkCount: relevantChecks.length,
    failedCheckCount: failures.length,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    p99LatencyMs: percentile(latencies, 0.99),
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length * 100) / 100 : null,
    failureCategories: Object.fromEntries([...new Set(failures.map((check) => check.failureCategory || 'unknown'))].map((category) => [category, failures.filter((check) => (check.failureCategory || 'unknown') === category).length]))
  };
}

function buildUptimeReport({ monitors = [], checksByMonitor = {}, incidents = [], maintenance = [], from, to, filters = {} } = {}) {
  const fromMs = asMs(from, 'Report start time');
  const toMs = asMs(to, 'Report end time');
  if (toMs <= fromMs) throw Object.assign(new Error('Report end time must be after its start time.'), { code: 'UPTIME_REPORT_RANGE_INVALID' });
  const selected = monitors.filter((monitor) => {
    if (filters.monitorId && monitor.id !== filters.monitorId) return false;
    if (filters.projectId && monitor.projectId !== filters.projectId) return false;
    if (filters.group && monitor.group !== filters.group) return false;
    return true;
  });
  const metrics = selected.map((monitor) => monitorMetrics({ monitor, checks: checksByMonitor[monitor.id] || [], incidents, maintenance, from: fromMs, to: toMs }));
  const eligibleMs = metrics.reduce((total, item) => total + item.eligibleMs, 0);
  const coveredMs = metrics.reduce((total, item) => total + item.coveredMs, 0);
  const downMs = metrics.reduce((total, item) => total + item.downMs, 0);
  const allLatencies = selected.flatMap((monitor) => (checksByMonitor[monitor.id] || []).map((check) => check.latencyMs)).filter((value) => Number.isFinite(Number(value))).map(Number);
  const availabilityPct = coveredMs ? (coveredMs - downMs) / coveredMs * 100 : null;
  const slaTargetPct = Number(filters.slaTargetPct);
  const daily = [];
  for (let cursor = Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), new Date(fromMs).getUTCDate()); cursor < toMs; cursor += 86400000) {
    const dayTo = Math.min(toMs, cursor + 86400000);
    const dayFrom = Math.max(fromMs, cursor);
    const dayMetrics = selected.map((monitor) => monitorMetrics({ monitor, checks: checksByMonitor[monitor.id] || [], incidents, maintenance, from: dayFrom, to: dayTo }));
    const dayEligible = dayMetrics.reduce((total, item) => total + item.eligibleMs, 0);
    const dayCovered = dayMetrics.reduce((total, item) => total + item.coveredMs, 0);
    const dayDown = dayMetrics.reduce((total, item) => total + item.downMs, 0);
    daily.push({
      dateUtc: new Date(cursor).toISOString().slice(0, 10),
      availabilityPct: dayCovered ? (dayCovered - dayDown) / dayCovered * 100 : null,
      coveragePct: dayEligible ? dayCovered / dayEligible * 100 : null,
      downMs: dayDown,
      incidentCount: dayMetrics.reduce((total, item) => total + item.incidentCount, 0),
      checkCount: dayMetrics.reduce((total, item) => total + item.checkCount, 0)
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    period: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    filters: { ...filters },
    summary: {
      monitorCount: metrics.length,
      availabilityPct,
      slaTargetPct: Number.isFinite(slaTargetPct) && slaTargetPct > 0 && slaTargetPct <= 100 ? slaTargetPct : null,
      slaMet: Number.isFinite(slaTargetPct) && availabilityPct != null ? availabilityPct >= slaTargetPct : null,
      coveragePct: eligibleMs ? coveredMs / eligibleMs * 100 : null,
      eligibleMs,
      coveredMs,
      unknownMs: Math.max(0, eligibleMs - coveredMs),
      downMs,
      incidentCount: metrics.reduce((total, item) => total + item.incidentCount, 0),
      checkCount: metrics.reduce((total, item) => total + item.checkCount, 0),
      p50LatencyMs: percentile(allLatencies, 0.5),
      p95LatencyMs: percentile(allLatencies, 0.95),
      p99LatencyMs: percentile(allLatencies, 0.99)
    },
    monitors: metrics,
    daily,
    checks: selected.flatMap((monitor) => (checksByMonitor[monitor.id] || []).map((check) => ({ monitorName: monitor.name, ...check }))).filter((check) => Date.parse(check.completedAt) >= fromMs && Date.parse(check.completedAt) <= toMs),
    incidents: incidents.filter((incident) => selected.some((monitor) => monitor.id === incident.monitorId) && Date.parse(incident.openedAt) <= toMs && (!incident.resolvedAt || Date.parse(incident.resolvedAt) >= fromMs)),
    methodology: 'Availability uses confirmed incident duration during covered, enabled, non-maintenance time. Coverage is reported separately from availability; missing checks remain unknown and never count as uptime.'
  };
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reportToCsv(report, dataset = 'summary') {
  const definitions = {
    summary: {
      headers: ['monitorId', 'name', 'group', 'projectId', 'type', 'state', 'availabilityPct', 'coveragePct', 'downMs', 'unknownMs', 'incidentCount', 'checkCount', 'p50LatencyMs', 'p95LatencyMs', 'p99LatencyMs'],
      rows: report.monitors
    },
    checks: {
      headers: ['monitorId', 'monitorName', 'completedAt', 'outcome', 'latencyMs', 'statusCode', 'failureCategory', 'summary', 'probeId'],
      rows: report.checks
    },
    incidents: {
      headers: ['id', 'monitorId', 'state', 'severity', 'openedAt', 'acknowledgedAt', 'resolvedAt', 'summary', 'failureCategory'],
      rows: report.incidents
    },
    daily: {
      headers: ['dateUtc', 'availabilityPct', 'coveragePct', 'downMs', 'incidentCount', 'checkCount'],
      rows: report.daily
    }
  };
  const definition = definitions[dataset];
  if (!definition) throw Object.assign(new Error('CSV dataset is unsupported.'), { code: 'UPTIME_EXPORT_DATASET_INVALID' });
  return [definition.headers.join(','), ...definition.rows.map((row) => definition.headers.map((header) => csvCell(row[header])).join(','))].join('\r\n');
}

function escapeReportHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function formatReportPercent(value) {
  return value == null ? 'No data' : `${Number(value).toFixed(3)}%`;
}

function uptimeReportHtml(report) {
  const monitorRows = report.monitors.map((monitor) => `<tr><td>${escapeReportHtml(monitor.name)}</td><td>${escapeReportHtml(monitor.type.toUpperCase())}</td><td>${escapeReportHtml(formatReportPercent(monitor.availabilityPct))}</td><td>${escapeReportHtml(formatReportPercent(monitor.coveragePct))}</td><td>${monitor.incidentCount}</td><td>${monitor.p95LatencyMs == null ? '-' : `${monitor.p95LatencyMs} ms`}</td></tr>`).join('');
  const incidentRows = report.incidents.slice(0, 100).map((incident) => `<tr><td>${escapeReportHtml(incident.monitorId)}</td><td>${escapeReportHtml(incident.severity)}</td><td>${escapeReportHtml(incident.openedAt)}</td><td>${escapeReportHtml(incident.resolvedAt || 'Open')}</td><td>${escapeReportHtml(incident.summary)}</td></tr>`).join('');
  const dailyBars = report.daily.map((day) => `<span title="${escapeReportHtml(day.dateUtc)}" style="height:${Math.max(2, Number(day.availabilityPct) || 0)}%"></span>`).join('');
  const slaResult = report.summary.slaTargetPct == null ? 'Not set' : `${report.summary.slaMet ? 'Met' : 'Missed'} (${report.summary.slaTargetPct}%)`;
  const filterSummary = [
    ['Monitor', report.filters?.monitorId],
    ['Group', report.filters?.group],
    ['Server', report.filters?.projectId]
  ].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join(' / ') || 'Entire workspace';
  return `<!doctype html><html><head><meta charset="utf-8"><title>DeployerX Uptime Report</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font:12px Arial,sans-serif;color:#18181b;margin:0}header{border-bottom:2px solid #18181b;padding-bottom:12px;margin-bottom:18px}h1{font-size:24px;margin:0 0 5px}h2{font-size:15px;margin:20px 0 8px}.muted{color:#60646c;line-height:1.5}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:7px}.metric{border:1px solid #d4d4d8;padding:9px}.metric strong{display:block;font-size:15px;margin-top:4px}.trend{display:flex;align-items:end;gap:3px;height:90px;border-bottom:1px solid #a1a1aa;padding-top:8px}.trend span{flex:1;background:#0f8f8c;min-width:2px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border-bottom:1px solid #e4e4e7;text-align:left;padding:7px 5px;vertical-align:top;word-wrap:break-word}th{font-size:10px;text-transform:uppercase;color:#52525b}.method{margin-top:20px;padding:10px;background:#f4f4f5;line-height:1.5}</style></head><body><header><h1>DeployerX Uptime Report</h1><div class="muted">${escapeReportHtml(report.period.from)} to ${escapeReportHtml(report.period.to)} &middot; generated ${escapeReportHtml(report.generatedAt)}<br>Filters: ${escapeReportHtml(filterSummary)}</div></header><section class="metrics"><div class="metric">Availability<strong>${escapeReportHtml(formatReportPercent(report.summary.availabilityPct))}</strong></div><div class="metric">Coverage<strong>${escapeReportHtml(formatReportPercent(report.summary.coveragePct))}</strong></div><div class="metric">SLA result<strong>${escapeReportHtml(slaResult)}</strong></div><div class="metric">Incidents<strong>${report.summary.incidentCount}</strong></div><div class="metric">P95 latency<strong>${report.summary.p95LatencyMs == null ? '-' : `${report.summary.p95LatencyMs} ms`}</strong></div></section><h2>Daily availability trend</h2><div class="trend">${dailyBars}</div><h2>Monitor comparison</h2><table><thead><tr><th>Monitor</th><th>Type</th><th>Availability</th><th>Coverage</th><th>Incidents</th><th>P95 latency</th></tr></thead><tbody>${monitorRows || '<tr><td colspan="6">No monitors matched this report.</td></tr>'}</tbody></table><h2>Incidents</h2><table><thead><tr><th>Monitor ID</th><th>Severity</th><th>Opened</th><th>Resolved</th><th>Summary</th></tr></thead><tbody>${incidentRows || '<tr><td colspan="5">No incidents in this period.</td></tr>'}</tbody></table><div class="method"><strong>Methodology</strong><br>${escapeReportHtml(report.methodology)}</div></body></html>`;
}

class UptimeDailyRollupService {
  constructor({ controlDatabase } = {}) {
    if (!controlDatabase) throw new TypeError('Uptime control database is required.');
    this.controlDatabase = controlDatabase;
  }

  async run(workspaceId, dateUtc) {
    const date = String(dateUtc || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Rollup date must use YYYY-MM-DD.'), { code: 'UPTIME_ROLLUP_DATE_INVALID' });
    const from = `${date}T00:00:00.000Z`;
    const to = new Date(Date.parse(from) + 86400000).toISOString();
    const monitors = await this.controlDatabase.listMonitors(workspaceId, { includeDeleted: true, limit: 10000 });
    const [incidents, maintenance, checks] = await Promise.all([
      this.controlDatabase.listIncidents(workspaceId, { to, limit: 10000 }),
      this.controlDatabase.listMaintenanceWindows(workspaceId, { includeDeleted: true, limit: 10000 }),
      Promise.all(monitors.map(async (monitor) => [monitor.id, await this.controlDatabase.listChecks(workspaceId, monitor.id, { from, to, limit: 100000 })]))
    ]);
    const checksByMonitor = Object.fromEntries(checks);
    const rollups = [];
    for (const monitor of monitors) {
      const report = buildUptimeReport({ monitors: [monitor], checksByMonitor, incidents, maintenance, from, to });
      const metrics = report.monitors[0];
      if (!metrics) continue;
      rollups.push(await this.controlDatabase.upsertDailyRollup(workspaceId, monitor.id, date, {
        eligibleMs: metrics.eligibleMs,
        upMs: Math.max(0, metrics.coveredMs - metrics.downMs - metrics.warningMs),
        downMs: metrics.downMs,
        warningMs: metrics.warningMs,
        unknownMs: metrics.unknownMs,
        maintenanceMs: metrics.maintenanceMs,
        pausedMs: metrics.pausedMs,
        checkCount: metrics.checkCount,
        successfulCheckCount: (checksByMonitor[monitor.id] || []).filter((check) => check.outcome === 'up').length,
        failedCheckCount: metrics.failedCheckCount,
        latencyCount: (checksByMonitor[monitor.id] || []).filter((check) => Number.isFinite(Number(check.latencyMs))).length,
        latencySumMs: (checksByMonitor[monitor.id] || []).reduce((total, check) => total + (Number(check.latencyMs) || 0), 0),
        latencyP50Ms: metrics.p50LatencyMs,
        latencyP95Ms: metrics.p95LatencyMs,
        latencyP99Ms: metrics.p99LatencyMs,
        availabilityPct: metrics.availabilityPct,
        coveragePct: metrics.coveragePct
      }));
    }
    return { workspaceId, dateUtc: date, monitorCount: rollups.length, rollups };
  }
}

module.exports = {
  UptimeDailyRollupService,
  buildUptimeReport,
  enabledIntervals,
  intersectIntervals,
  mergeIntervals,
  maintenanceApplies,
  monitorMetrics,
  percentile,
  reportToCsv,
  subtractIntervals,
  uptimeReportHtml
};
