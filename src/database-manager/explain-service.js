const crypto = require('node:crypto');
const { classifySql, enforceSqlPolicy } = require('./sql-safety');

const MAX_EXPLAIN_QUERY_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_NODES = 2000;
const MAX_PLAN_TEXT = 1200;

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw Object.assign(new Error(`${label} is invalid.`), { code: 'DATABASE_MANAGER_EXPLAIN_INVALID', category: 'database-manager' });
  return text;
}

function normalizeDriver(value) {
  const driver = String(value || '').trim().toLowerCase();
  if (!['postgresql', 'mysql', 'sqlite'].includes(driver)) throw Object.assign(new Error('EXPLAIN is not supported for this database driver.'), { code: 'DATABASE_MANAGER_EXPLAIN_UNSUPPORTED', category: 'database-manager' });
  return driver;
}

function normalizeQuery(query) {
  const value = String(query ?? '').trim().replace(/;\s*$/, '').trim();
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_EXPLAIN_QUERY_BYTES || value.includes('\0')) throw Object.assign(new Error('The EXPLAIN query is empty or too large.'), { code: 'DATABASE_MANAGER_EXPLAIN_INVALID', category: 'database-manager' });
  const classification = classifySql(value);
  if (classification.statementCount !== 1 || classification.malformed || classification.kind !== 'read') {
    throw Object.assign(new Error('EXPLAIN accepts one read-only SQL statement.'), { code: 'DATABASE_MANAGER_EXPLAIN_READ_ONLY_REQUIRED', category: 'database-manager' });
  }
  return value;
}

function buildExplainQuery(driverValue, queryValue) {
  const driver = normalizeDriver(driverValue);
  const query = normalizeQuery(queryValue);
  if (driver === 'postgresql') return `EXPLAIN (FORMAT JSON, ANALYZE false, BUFFERS false, VERBOSE false) ${query}`;
  if (driver === 'mysql') return `EXPLAIN FORMAT=JSON ${query}`;
  return `EXPLAIN QUERY PLAN ${query}`;
}

function parseJsonValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizePlanValue(value, state, depth = 0) {
  if (state.nodes >= MAX_PLAN_NODES || depth > 20) return '[plan truncated]';
  state.nodes += 1;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > MAX_PLAN_TEXT ? `${value.slice(0, MAX_PLAN_TEXT)}...` : value;
  if (Array.isArray(value)) return value.slice(0, MAX_PLAN_NODES).map((item) => normalizePlanValue(item, state, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).slice(0, 100)) result[String(key).slice(0, 200)] = normalizePlanValue(value[key], state, depth + 1);
    return result;
  }
  return String(value).slice(0, MAX_PLAN_TEXT);
}

function normalizePlan(driverValue, result = {}) {
  const driver = normalizeDriver(driverValue);
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const rawRows = rows.map((row) => Array.isArray(row) ? row : []);
  let plan = null;
  if (driver === 'postgresql') plan = parseJsonValue(rawRows[0]?.[0]) || parseJsonValue(rawRows[0]?.[1]);
  else if (driver === 'mysql') plan = parseJsonValue(rawRows[0]?.[0]) || parseJsonValue(rawRows[0]?.[1]);
  else {
    plan = rawRows.map((row) => ({
      id: Number(row[0]) || 0,
      parentId: Number(row[1]) || 0,
      detail: String(row[3] ?? row[2] ?? '')
    }));
  }
  const state = { nodes: 0 };
  plan = plan === null ? null : normalizePlanValue(plan, state);
  return Object.freeze({
    driverId: driver,
    columns: Object.freeze(columns.map((column) => typeof column === 'string' ? column : String(column?.name || ''))),
    rows: Object.freeze(rawRows.map((row) => Object.freeze(row))),
    plan,
    executionTimeMs: Number(result.executionTimeMs || 0),
    warnings: Object.freeze(Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 100) : [])
  });
}

class DatabaseExplainService {
  constructor({ profileService, queryService, taskService } = {}) {
    if (!profileService?.get) throw new TypeError('DatabaseExplainService requires a profile service.');
    if (!queryService?.execute || !queryService?.cancel) throw new TypeError('DatabaseExplainService requires a query service.');
    if (!taskService?.create || !taskService?.start || !taskService?.complete) throw new TypeError('DatabaseExplainService requires a task service.');
    this.profileService = profileService;
    this.queryService = queryService;
    this.taskService = taskService;
  }

  async execute(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const profileId = requiredText(input.profileId, 'Database profile ID');
    const profile = await this.profileService.get(tenant, profileId);
    if (!profile) throw Object.assign(new Error('Database profile was not found.'), { code: 'DATABASE_MANAGER_PROFILE_NOT_FOUND', category: 'database-manager' });
    const query = normalizeQuery(input.query);
    const explainQuery = buildExplainQuery(profile.driverId, query);
    const classification = classifySql(explainQuery);
    enforceSqlPolicy({ profile, classification, approval: { confirmed: true }, batch: false });
    const requestId = requiredText(input.requestId || `dbx_${crypto.randomUUID()}`, 'EXPLAIN request ID');
    const task = await this.taskService.create(tenant, actor, { profileId, type: 'explain', label: `Explain ${query.slice(0, 160)}`, canCancel: true });
    let current = await this.taskService.start(tenant, actor, task.id, task.revision);
    const unregister = this.taskService.registerCancellation(tenant, task.id, () => this.queryService.cancel(tenant, actor, requestId));
    try {
      const execution = await this.queryService.execute(tenant, actor, { profileId, requestId, query: explainQuery, page: 1, pageSize: 5000, batch: false, source: 'explain', approval: { confirmed: true } });
      const result = normalizePlan(profile.driverId, execution.result);
      current = await this.taskService.complete(tenant, actor, task.id, { expectedRevision: current.revision });
      return Object.freeze({ requestId, profileId, query, explainQuery, task: current, result });
    } catch (error) {
      const latest = await this.taskService.get(tenant, task.id);
      if (latest && ['queued', 'running', 'interrupted'].includes(latest.state)) await this.taskService.complete(tenant, actor, task.id, { state: 'failed', safeMessage: 'EXPLAIN failed.', expectedRevision: latest.revision });
      throw error;
    } finally { unregister(); }
  }

  cancel(workspaceId, actorId, requestId) {
    return this.queryService.cancel(requiredText(workspaceId, 'Workspace ID'), requiredText(actorId || 'system', 'Actor ID'), requiredText(requestId, 'EXPLAIN request ID'));
  }
}

module.exports = { DatabaseExplainService, MAX_PLAN_NODES, buildExplainQuery, normalizePlan, normalizeQuery };
