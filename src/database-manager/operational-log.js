const LOG_CATEGORIES = Object.freeze(['query', 'task', 'connection', 'schema', 'driver']);
const LOG_SEVERITIES = Object.freeze(['info', 'success', 'warning', 'error']);
const MAX_OPERATIONAL_LOG_ENTRIES = 500;
const QUERY_SOURCES = Object.freeze(['editor', 'notebook', 'grid', 'schema', 'plugin', 'import', 'explain']);
const QUERY_STATES = Object.freeze(['succeeded', 'failed', 'cancelled']);
const QUERY_CLASSIFICATIONS = Object.freeze(['read', 'mutation', 'destructive', 'unknown']);
const TASK_TYPES = Object.freeze(['import', 'dump', 'explain', 'schema', 'administration']);
const TASK_STATES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted']);
const DRIVER_STATES = Object.freeze(['unknown', 'ready', 'warning', 'crashed', 'disabled']);
const DRIVER_EVENTS = Object.freeze(['unknown', 'registered', 'spawn', 'stderr', 'protocol-error', 'exit', 'health-ready', 'health-failed', 'disabled']);
const EVIDENCE_STATES = Object.freeze(['tested', 'ready', 'closed', 'changed', 'failed', 'cancelled']);

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 200) {
  if (value === null || value === undefined || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function safeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9_]{1,120}$/.test(code) ? code : null;
}

function safeTime(value) {
  const text = String(value || '');
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function safeEnum(value, allowed, fallback) {
  const normalized = String(value || '').toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function safeMetric(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.min(number, maximum) : 0;
}

function severityForState(stateValue) {
  const state = String(stateValue || '').toLowerCase();
  if (['succeeded', 'ready', 'tested', 'changed'].includes(state)) return 'success';
  if (['failed', 'crashed'].includes(state)) return 'error';
  if (['warning', 'interrupted', 'cancelled', 'canceled'].includes(state)) return 'warning';
  return 'info';
}

function normalizeOptions(input = {}) {
  const categories = Array.isArray(input.categories) ? [...new Set(input.categories.map((value) => String(value || '').toLowerCase()))] : [];
  const severities = Array.isArray(input.severities) ? [...new Set(input.severities.map((value) => String(value || '').toLowerCase()))] : [];
  if (categories.some((value) => !LOG_CATEGORIES.includes(value))) throw new TypeError('Database operational log category is invalid.');
  if (severities.some((value) => !LOG_SEVERITIES.includes(value))) throw new TypeError('Database operational log severity is invalid.');
  return Object.freeze({
    profileId: optionalText(input.profileId, 'Database profile ID'),
    categories: Object.freeze(categories),
    severities: Object.freeze(severities),
    search: String(input.search || '').trim().toLowerCase().slice(0, 200),
    limit: Math.min(Math.max(Number(input.limit) || 200, 1), MAX_OPERATIONAL_LOG_ENTRIES)
  });
}

function profileName(profiles, profileId) {
  return profiles.get(profileId)?.name || 'Unknown connection';
}

function queryEntry(record, profiles) {
  const state = safeEnum(record.status, QUERY_STATES, 'failed');
  const classification = safeEnum(record.classification, QUERY_CLASSIFICATIONS, 'unknown');
  const source = safeEnum(record.source, QUERY_SOURCES, 'editor');
  return Object.freeze({
    id: `query:${requiredText(record.id, 'Database query history ID')}`,
    category: 'query',
    severity: severityForState(state),
    occurredAt: safeTime(record.createdAt || record.updatedAt),
    profileId: requiredText(record.profileId, 'Database profile ID'),
    profileName: profileName(profiles, record.profileId),
    operation: `${source}-query`.slice(0, 80),
    state,
    summary: `${classification} query ${state}`,
    code: safeCode(record.errorCode),
    metrics: Object.freeze({
      executionTimeMs: safeMetric(record.executionTimeMs),
      rowCount: safeMetric(record.rowCount),
      affectedRows: safeMetric(record.affectedRows)
    })
  });
}

function taskEntry(record, profiles) {
  const state = safeEnum(record.state, TASK_STATES, 'failed');
  const type = safeEnum(record.type, TASK_TYPES, 'task');
  return Object.freeze({
    id: `task:${requiredText(record.id, 'Database task ID')}`,
    category: 'task',
    severity: severityForState(state),
    occurredAt: safeTime(record.completedAt || record.updatedAt || record.startedAt || record.createdAt),
    profileId: requiredText(record.profileId, 'Database profile ID'),
    profileName: profileName(profiles, record.profileId),
    operation: type.slice(0, 80),
    state,
    summary: `Database ${type} task ${state}`,
    code: null,
    metrics: Object.freeze({
      percent: Math.min(100, Math.max(0, Number(record.progress?.percent) || 0)),
      itemsCompleted: safeMetric(record.progress?.itemsCompleted),
      bytesCompleted: safeMetric(record.progress?.bytesCompleted)
    })
  });
}

function driverEntry(record) {
  const state = safeEnum(record.status, DRIVER_STATES, 'unknown');
  const pluginId = requiredText(record.pluginId, 'Database plugin ID', 100);
  const lastEvent = safeEnum(record.lastEvent, DRIVER_EVENTS, 'unknown');
  const occurredAt = safeTime(record.lastEventAt || record.lastCheckedAt || record.lastReadyAt);
  return Object.freeze({
    id: `driver:${pluginId}:${occurredAt || 'unknown'}`,
    category: 'driver',
    severity: severityForState(state),
    occurredAt,
    profileId: null,
    profileName: 'Device drivers',
    operation: lastEvent,
    state,
    summary: `Driver ${pluginId} ${state}`,
    code: safeCode(record.lastErrorCode),
    metrics: Object.freeze({
      crashCount: safeMetric(record.crashCount, 1000000),
      protocolErrorCount: safeMetric(record.protocolErrorCount, 1000000),
      stderrEventCount: safeMetric(record.stderrEventCount, 1000000)
    })
  });
}

function evidenceEntry(record, profiles) {
  const category = String(record.category || '').toLowerCase();
  const state = String(record.state || '').toLowerCase();
  if (!['connection', 'schema'].includes(category)) throw new TypeError('Database operational evidence category is invalid.');
  if (!EVIDENCE_STATES.includes(state)) throw new TypeError('Database operational evidence state is invalid.');
  const operation = requiredText(record.operation, 'Database operational evidence operation', 80).toLowerCase();
  return Object.freeze({
    id: `evidence:${requiredText(record.id, 'Database operational evidence ID')}`,
    category,
    severity: severityForState(state),
    occurredAt: safeTime(record.occurredAt),
    profileId: requiredText(record.profileId, 'Database profile ID'),
    profileName: profileName(profiles, record.profileId),
    operation,
    state,
    summary: category === 'connection' ? `Connection ${operation} ${state}` : `Database ${operation} ${state}`,
    code: safeCode(record.code),
    metrics: Object.freeze({})
  });
}

class DatabaseOperationalLogService {
  constructor({ profileService, queryWorkspaceStore, taskService, pluginHealthStore, operationalEvidenceStore } = {}) {
    if (!profileService?.list) throw new TypeError('Database operational log requires the profile service.');
    if (!queryWorkspaceStore?.listHistory) throw new TypeError('Database operational log requires query history.');
    if (!taskService?.list) throw new TypeError('Database operational log requires database tasks.');
    if (!pluginHealthStore?.list) throw new TypeError('Database operational log requires plugin health.');
    if (!operationalEvidenceStore?.list) throw new TypeError('Database operational log requires operational evidence.');
    this.profileService = profileService;
    this.queryWorkspaceStore = queryWorkspaceStore;
    this.taskService = taskService;
    this.pluginHealthStore = pluginHealthStore;
    this.operationalEvidenceStore = operationalEvidenceStore;
  }

  async list(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const options = normalizeOptions(input);
    const results = await Promise.allSettled([
      this.profileService.list(tenant, { limit: 1000 }),
      this.queryWorkspaceStore.listHistory(tenant, { profileId: options.profileId || undefined, limit: MAX_OPERATIONAL_LOG_ENTRIES }),
      this.taskService.list(tenant, { profileId: options.profileId || undefined, limit: MAX_OPERATIONAL_LOG_ENTRIES }),
      options.profileId ? [] : this.pluginHealthStore.list(),
      this.operationalEvidenceStore.list(tenant, { profileId: options.profileId || undefined, limit: MAX_OPERATIONAL_LOG_ENTRIES })
    ]);
    const values = results.map((result) => result.status === 'fulfilled' ? result.value : []);
    const profiles = new Map((values[0] || []).map((profile) => [profile.id, profile]));
    const entries = [
      ...(values[1] || []).map((record) => queryEntry(record, profiles)),
      ...(values[2] || []).map((record) => taskEntry(record, profiles)),
      ...(values[3] || []).map(driverEntry),
      ...(values[4] || []).map((record) => evidenceEntry(record, profiles))
    ].filter((entry) => (!options.categories.length || options.categories.includes(entry.category))
      && (!options.severities.length || options.severities.includes(entry.severity))
      && (!options.search || [entry.profileName, entry.operation, entry.state, entry.summary, entry.code].filter(Boolean).join(' ').toLowerCase().includes(options.search)))
      .sort((left, right) => (Date.parse(right.occurredAt || 0) || 0) - (Date.parse(left.occurredAt || 0) || 0) || right.id.localeCompare(left.id));
    return Object.freeze({
      entries: Object.freeze(entries.slice(0, options.limit)),
      total: entries.length,
      truncated: entries.length > options.limit,
      sources: Object.freeze({ profiles: results[0].status, queries: results[1].status, tasks: results[2].status, drivers: results[3].status, evidence: results[4].status })
    });
  }
}

module.exports = {
  DatabaseOperationalLogService,
  LOG_CATEGORIES,
  LOG_SEVERITIES,
  MAX_OPERATIONAL_LOG_ENTRIES,
  normalizeOptions,
  queryEntry,
  taskEntry,
  driverEntry,
  evidenceEntry
};
