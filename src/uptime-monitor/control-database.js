const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const initSqlJs = require('sql.js/dist/sql-asm.js');
const {
  CHECK_OUTCOMES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  MONITOR_STATES,
  MONITOR_TYPES,
  UptimeValidationError,
  createId,
  isoTime,
  normalizeCheckInput,
  normalizeIncidentInput,
  normalizeMonitorInput,
  requiredText
} = require('./domain');

const CONTROL_DATABASE_VERSION = 1;
const DATABASE_FILE_NAME = 'control.db';
const DATABASE_LOCK_FILE_NAME = 'control.db.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 30000;
const DEFAULT_LOCK_RETRY_MS = 10;
const SQL = initSqlJs();

const REQUIRED_INDEXES = Object.freeze([
  'idx_uptime_monitors_workspace_state_due',
  'idx_uptime_monitors_workspace_project',
  'idx_uptime_checks_monitor_completed',
  'idx_uptime_checks_workspace_completed',
  'idx_uptime_incidents_workspace_state_opened',
  'idx_uptime_incidents_monitor_opened',
  'idx_uptime_maintenance_workspace_time',
  'idx_uptime_rollups_workspace_date'
]);

const SCHEMA_SQL = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE monitors (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    name TEXT NOT NULL,
    monitor_type TEXT NOT NULL CHECK (monitor_type IN ('http','tcp','tls')),
    state TEXT NOT NULL CHECK (state IN ('enabled','paused','disabled')),
    probe_id TEXT NOT NULL,
    next_check_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    deleted_at TEXT,
    data_json TEXT NOT NULL,
    UNIQUE (workspace_id, id)
  );
  CREATE UNIQUE INDEX uq_uptime_monitors_active_name ON monitors(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
  CREATE INDEX idx_uptime_monitors_workspace_state_due ON monitors(workspace_id, state, next_check_at) WHERE deleted_at IS NULL;
  CREATE INDEX idx_uptime_monitors_workspace_project ON monitors(workspace_id, project_id) WHERE deleted_at IS NULL;

  CREATE TABLE checks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    monitor_id TEXT NOT NULL,
    probe_id TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('up','warning','down','unknown','maintenance')),
    latency_ms REAL,
    status_code INTEGER,
    failure_category TEXT,
    data_json TEXT NOT NULL,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, id) ON DELETE RESTRICT
  );
  CREATE INDEX idx_uptime_checks_monitor_completed ON checks(workspace_id, monitor_id, completed_at DESC);
  CREATE INDEX idx_uptime_checks_workspace_completed ON checks(workspace_id, completed_at DESC);

  CREATE TABLE incidents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    monitor_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','acknowledged','resolved')),
    severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
    opened_at TEXT NOT NULL,
    acknowledged_at TEXT,
    resolved_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    data_json TEXT NOT NULL,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, id) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX uq_uptime_incidents_active_monitor ON incidents(workspace_id, monitor_id) WHERE state IN ('open','acknowledged');
  CREATE INDEX idx_uptime_incidents_workspace_state_opened ON incidents(workspace_id, state, opened_at DESC);
  CREATE INDEX idx_uptime_incidents_monitor_opened ON incidents(workspace_id, monitor_id, opened_at DESC);

  CREATE TABLE maintenance_windows (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('enabled','disabled')),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    timezone TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    deleted_at TEXT,
    data_json TEXT NOT NULL,
    UNIQUE (workspace_id, id)
  );
  CREATE INDEX idx_uptime_maintenance_workspace_time ON maintenance_windows(workspace_id, state, starts_at, ends_at) WHERE deleted_at IS NULL;

  CREATE TABLE daily_rollups (
    workspace_id TEXT NOT NULL,
    monitor_id TEXT NOT NULL,
    date_utc TEXT NOT NULL,
    eligible_ms INTEGER NOT NULL DEFAULT 0,
    up_ms INTEGER NOT NULL DEFAULT 0,
    down_ms INTEGER NOT NULL DEFAULT 0,
    warning_ms INTEGER NOT NULL DEFAULT 0,
    unknown_ms INTEGER NOT NULL DEFAULT 0,
    maintenance_ms INTEGER NOT NULL DEFAULT 0,
    paused_ms INTEGER NOT NULL DEFAULT 0,
    check_count INTEGER NOT NULL DEFAULT 0,
    successful_check_count INTEGER NOT NULL DEFAULT 0,
    failed_check_count INTEGER NOT NULL DEFAULT 0,
    latency_count INTEGER NOT NULL DEFAULT 0,
    latency_sum_ms REAL NOT NULL DEFAULT 0,
    latency_p50_ms REAL,
    latency_p95_ms REAL,
    latency_p99_ms REAL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, monitor_id, date_utc),
    FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, id) ON DELETE RESTRICT
  );
  CREATE INDEX idx_uptime_rollups_workspace_date ON daily_rollups(workspace_id, date_utc DESC);

  CREATE TABLE worker_heartbeats (
    workspace_id TEXT NOT NULL,
    probe_id TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('starting','active','stopping','offline','error')),
    process_id INTEGER,
    data_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, probe_id)
  );

  CREATE TABLE monitor_notification_routes (
    workspace_id TEXT NOT NULL,
    monitor_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, monitor_id, route_id),
    FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, id) ON DELETE CASCADE
  );

  CREATE TABLE migration_markers (
    workspace_id TEXT NOT NULL,
    marker_key TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, marker_key)
  );
`;

class UptimeControlDatabaseError extends Error {
  constructor(message, code = 'UPTIME_CONTROL_DB_ERROR', options = {}) {
    super(message, options);
    this.name = 'UptimeControlDatabaseError';
    this.code = code;
  }
}

class UptimeControlDatabaseCorruptionError extends UptimeControlDatabaseError {
  constructor(message, options = {}) {
    super(message, 'UPTIME_CONTROL_DB_CORRUPT', options);
    this.name = 'UptimeControlDatabaseCorruptionError';
  }
}

class UptimeControlDatabaseCompatibilityError extends UptimeControlDatabaseError {
  constructor(message) {
    super(message, 'UPTIME_CONTROL_DB_INCOMPATIBLE');
    this.name = 'UptimeControlDatabaseCompatibilityError';
  }
}

class UptimeRevisionConflictError extends UptimeControlDatabaseError {
  constructor(resource, id) {
    super(`${resource} changed before this operation completed. Refresh and try again.`, 'UPTIME_REVISION_CONFLICT');
    this.name = 'UptimeRevisionConflictError';
    this.resource = resource;
    this.resourceId = id;
  }
}

function processIsRunning(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value < 1) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rows(database, sql, parameters = []) {
  const statement = database.prepare(sql);
  try {
    statement.bind(parameters);
    const values = [];
    while (statement.step()) values.push(statement.getAsObject());
    return values;
  } finally {
    statement.free();
  }
}

function oneValue(database, sql, parameters = []) {
  const [row] = rows(database, sql, parameters);
  return row ? Object.values(row)[0] : undefined;
}

function parseObject(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new UptimeControlDatabaseCorruptionError(`Uptime Monitor ${label} contains invalid JSON.`, { cause: error });
  }
}

function workspaceId(value) {
  return requiredText(value, 'Workspace ID', 200);
}

function actorId(value) {
  return requiredText(value || 'system', 'Actor ID', 200);
}

function publicMonitor(row) {
  if (!row) return null;
  const record = parseObject(row.data_json, 'monitor record');
  return {
    ...record,
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id || null,
    name: row.name,
    type: row.monitor_type,
    state: row.state,
    probeId: row.probe_id,
    nextCheckAt: row.next_check_at || null,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at || null
  };
}

function publicCheck(row) {
  if (!row) return null;
  return {
    ...parseObject(row.data_json, 'check record'),
    id: row.id,
    workspaceId: row.workspace_id,
    monitorId: row.monitor_id,
    probeId: row.probe_id,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outcome: row.outcome,
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    statusCode: row.status_code == null ? null : Number(row.status_code),
    failureCategory: row.failure_category || ''
  };
}

function publicIncident(row) {
  if (!row) return null;
  return {
    ...parseObject(row.data_json, 'incident record'),
    id: row.id,
    workspaceId: row.workspace_id,
    monitorId: row.monitor_id,
    state: row.state,
    severity: row.severity,
    openedAt: row.opened_at,
    acknowledgedAt: row.acknowledged_at || null,
    resolvedAt: row.resolved_at || null,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by
  };
}

function publicMaintenance(row) {
  if (!row) return null;
  return {
    ...parseObject(row.data_json, 'maintenance-window record'),
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    state: row.state,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at || null
  };
}

function normalizeMaintenanceInput(input = {}) {
  const startsAt = isoTime(input.startsAt, 'Maintenance start time');
  const endsAt = isoTime(input.endsAt, 'Maintenance end time');
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new UptimeValidationError('UPTIME_MAINTENANCE_RANGE_INVALID', 'Maintenance must end after it starts.');
  const state = String(input.state || 'enabled').toLowerCase();
  if (!['enabled', 'disabled'].includes(state)) throw new UptimeValidationError('UPTIME_MAINTENANCE_STATE_INVALID', 'Maintenance state is unsupported.');
  const scope = input.scope && typeof input.scope === 'object' && !Array.isArray(input.scope) ? structuredClone(input.scope) : { type: 'workspace' };
  if (!['workspace', 'group', 'project', 'monitors'].includes(scope.type)) throw new UptimeValidationError('UPTIME_MAINTENANCE_SCOPE_INVALID', 'Maintenance scope is unsupported.');
  return {
    name: requiredText(input.name, 'Maintenance name', 200),
    state,
    startsAt,
    endsAt,
    timezone: requiredText(input.timezone || 'UTC', 'Maintenance timezone', 100),
    reason: String(input.reason || '').trim().slice(0, 1000),
    scope,
    recurrence: input.recurrence && typeof input.recurrence === 'object' && !Array.isArray(input.recurrence) ? structuredClone(input.recurrence) : null
  };
}

class UptimeControlDatabase {
  constructor({ rootPath, clock = () => new Date().toISOString(), lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, lockRetryMs = DEFAULT_LOCK_RETRY_MS } = {}) {
    this.rootPath = requiredText(rootPath, 'Uptime control database root path', 4096);
    this.databasePath = path.join(this.rootPath, DATABASE_FILE_NAME);
    this.lockPath = path.join(this.rootPath, DATABASE_LOCK_FILE_NAME);
    this.clock = clock;
    this.lockTimeoutMs = Number(lockTimeoutMs);
    this.lockRetryMs = Number(lockRetryMs);
    if (!Number.isInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 100 || this.lockTimeoutMs > 120000) throw new TypeError('Uptime control database lock timeout is invalid.');
    if (!Number.isInteger(this.lockRetryMs) || this.lockRetryMs < 1 || this.lockRetryMs > 1000) throw new TypeError('Uptime control database lock retry interval is invalid.');
    this.database = null;
    this.initialized = false;
    this.operationQueue = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return this;
    await fs.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    return this.#withFileLock(async () => {
      const SqlJs = await SQL;
      let existingBytes = null;
      try { existingBytes = await fs.readFile(this.databasePath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { this.database = existingBytes ? new SqlJs.Database(existingBytes) : new SqlJs.Database(); }
      catch (error) { throw new UptimeControlDatabaseCorruptionError('Uptime Monitor control.db is not a readable SQLite database.', { cause: error }); }
      this.database.run('PRAGMA foreign_keys = ON');
      try {
        this.#verifyIntegrity();
        const currentVersion = Number(oneValue(this.database, 'PRAGMA user_version') || 0);
        if (currentVersion > CONTROL_DATABASE_VERSION) throw new UptimeControlDatabaseCompatibilityError(`Uptime Monitor control.db schema ${currentVersion} is newer than supported schema ${CONTROL_DATABASE_VERSION}.`);
        if (currentVersion < CONTROL_DATABASE_VERSION) {
          if (existingBytes) await this.#createMigrationBackup(currentVersion);
          await this.#migrate(currentVersion);
        } else this.#verifySchema();
        this.initialized = true;
        return this;
      } catch (error) {
        try { this.database.close(); } catch {}
        this.database = null;
        throw error;
      }
    });
  }

  createMonitor(workspace, actor, input = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const user = actorId(actor);
      const normalized = normalizeMonitorInput(input);
      const now = this.clock();
      const record = {
        ...normalized,
        id: String(input.id || createId('monitor')),
        workspaceId: tenant,
        revision: 1,
        nextCheckAt: input.nextCheckAt ? isoTime(input.nextCheckAt, 'Next check time') : null,
        stateEvents: [{ state: normalized.state, at: now, actorId: user }],
        createdAt: now,
        updatedAt: now,
        createdBy: user,
        updatedBy: user,
        deletedAt: null
      };
      database.run(`INSERT INTO monitors(id,workspace_id,project_id,name,monitor_type,state,probe_id,next_check_at,revision,created_at,updated_at,created_by,updated_by,deleted_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        record.id, tenant, record.projectId, record.name, record.type, record.state, record.probeId, record.nextCheckAt,
        record.revision, now, now, user, user, null, JSON.stringify(record)
      ]);
      this.#replaceMonitorRoutes(database, record);
      return publicMonitor(rows(database, 'SELECT * FROM monitors WHERE workspace_id = ? AND id = ?', [tenant, record.id])[0]);
    });
  }

  getMonitor(workspace, id, options = {}) {
    return this.#read((database) => publicMonitor(rows(database, `SELECT * FROM monitors WHERE workspace_id = ? AND id = ? ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'}`, [workspaceId(workspace), requiredText(id, 'Monitor ID', 200)])[0]));
  }

  listMonitors(workspace, options = {}) {
    return this.#read((database) => {
      const clauses = ['workspace_id = ?', options.includeDeleted ? '1 = 1' : 'deleted_at IS NULL'];
      const parameters = [workspaceId(workspace)];
      if (options.state) { clauses.push('state = ?'); parameters.push(requiredText(options.state, 'Monitor state', 40)); }
      if (options.projectId) { clauses.push('project_id = ?'); parameters.push(requiredText(options.projectId, 'Project ID', 200)); }
      if (options.dueBefore) { clauses.push("state = 'enabled' AND (next_check_at IS NULL OR next_check_at <= ?)"); parameters.push(isoTime(options.dueBefore, 'Due-before time')); }
      const limit = Math.max(1, Math.min(10000, Number(options.limit) || 1000));
      return rows(database, `SELECT * FROM monitors WHERE ${clauses.join(' AND ')} ORDER BY name COLLATE NOCASE, id LIMIT ?`, [...parameters, limit]).map(publicMonitor);
    });
  }

  upsertMonitorSnapshot(workspace, input = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const normalized = normalizeMonitorInput(input);
      const id = requiredText(input.id, 'Monitor ID', 200);
      const revision = Math.max(1, Number(input.revision) || 1);
      const createdAt = isoTime(input.createdAt || this.clock(), 'Monitor creation time');
      const updatedAt = isoTime(input.updatedAt || createdAt, 'Monitor update time');
      const deletedAt = input.deletedAt ? isoTime(input.deletedAt, 'Monitor deletion time') : null;
      const createdBy = actorId(input.createdBy);
      const updatedBy = actorId(input.updatedBy || input.createdBy);
      const nextCheckAt = input.nextCheckAt ? isoTime(input.nextCheckAt, 'Next check time') : null;
      const record = {
        ...structuredClone(input),
        ...normalized,
        id,
        workspaceId: tenant,
        revision,
        nextCheckAt,
        createdAt,
        updatedAt,
        createdBy,
        updatedBy,
        deletedAt
      };
      const current = publicMonitor(rows(database, 'SELECT * FROM monitors WHERE workspace_id = ? AND id = ?', [tenant, id])[0]);
      if (current && Date.parse(current.updatedAt) > Date.parse(updatedAt)) return current;
      database.run(`INSERT INTO monitors(id,workspace_id,project_id,name,monitor_type,state,probe_id,next_check_at,revision,created_at,updated_at,created_by,updated_by,deleted_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,project_id=excluded.project_id,name=excluded.name,monitor_type=excluded.monitor_type,state=excluded.state,probe_id=excluded.probe_id,next_check_at=excluded.next_check_at,revision=excluded.revision,created_at=excluded.created_at,updated_at=excluded.updated_at,created_by=excluded.created_by,updated_by=excluded.updated_by,deleted_at=excluded.deleted_at,data_json=excluded.data_json`, [
        id, tenant, record.projectId, record.name, record.type, record.state, record.probeId, nextCheckAt,
        revision, createdAt, updatedAt, createdBy, updatedBy, deletedAt, JSON.stringify(record)
      ]);
      this.#replaceMonitorRoutes(database, record);
      return publicMonitor(rows(database, 'SELECT * FROM monitors WHERE workspace_id = ? AND id = ?', [tenant, id])[0]);
    });
  }

  updateMonitor(workspace, actor, id, changes = {}, expectedRevision) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const monitorId = requiredText(id, 'Monitor ID', 200);
      const current = publicMonitor(rows(database, 'SELECT * FROM monitors WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [tenant, monitorId])[0]);
      if (!current) return null;
      const revision = Number(expectedRevision ?? changes.revision);
      if (!Number.isInteger(revision) || revision !== current.revision) throw new UptimeRevisionConflictError('Monitor', monitorId);
      const normalized = normalizeMonitorInput({ ...current, ...structuredClone(changes), config: changes.config || current.config, alertPolicy: { ...current.alertPolicy, ...(changes.alertPolicy || {}) } });
      const now = this.clock();
      const updatedBy = actorId(actor);
      const stateEvents = normalized.state === current.state
        ? [...(current.stateEvents || [])]
        : [...(current.stateEvents || []), { state: normalized.state, at: now, actorId: updatedBy }].slice(-1000);
      const next = { ...current, ...normalized, stateEvents, nextCheckAt: changes.nextCheckAt === null ? null : changes.nextCheckAt ? isoTime(changes.nextCheckAt, 'Next check time') : current.nextCheckAt, revision: current.revision + 1, updatedAt: now, updatedBy };
      database.run(`UPDATE monitors SET project_id=?,name=?,monitor_type=?,state=?,probe_id=?,next_check_at=?,revision=?,updated_at=?,updated_by=?,data_json=? WHERE workspace_id=? AND id=? AND revision=? AND deleted_at IS NULL`, [
        next.projectId, next.name, next.type, next.state, next.probeId, next.nextCheckAt, next.revision, now, next.updatedBy, JSON.stringify(next), tenant, monitorId, current.revision
      ]);
      if (database.getRowsModified() !== 1) throw new UptimeRevisionConflictError('Monitor', monitorId);
      this.#replaceMonitorRoutes(database, next);
      return publicMonitor(rows(database, 'SELECT * FROM monitors WHERE workspace_id = ? AND id = ?', [tenant, monitorId])[0]);
    });
  }

  deleteMonitor(workspace, actor, id, expectedRevision) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const monitorId = requiredText(id, 'Monitor ID', 200);
      const current = publicMonitor(rows(database, 'SELECT * FROM monitors WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [tenant, monitorId])[0]);
      if (!current) return { id: monitorId, deleted: false, absent: true };
      if (Number(expectedRevision ?? current.revision) !== current.revision) throw new UptimeRevisionConflictError('Monitor', monitorId);
      const now = this.clock();
      const updatedBy = actorId(actor);
      const next = { ...current, state: 'disabled', stateEvents: [...(current.stateEvents || []), { state: 'disabled', at: now, actorId: updatedBy }].slice(-1000), revision: current.revision + 1, updatedAt: now, updatedBy, deletedAt: now };
      database.run(`UPDATE monitors SET state='disabled',revision=?,updated_at=?,updated_by=?,deleted_at=?,data_json=? WHERE workspace_id=? AND id=? AND revision=? AND deleted_at IS NULL`, [next.revision, now, next.updatedBy, now, JSON.stringify(next), tenant, monitorId, current.revision]);
      if (database.getRowsModified() !== 1) throw new UptimeRevisionConflictError('Monitor', monitorId);
      return { id: monitorId, deleted: true, absent: false };
    });
  }

  recordCheck(workspace, input = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const check = normalizeCheckInput(input);
      const monitor = publicMonitor(rows(database, 'SELECT * FROM monitors WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [tenant, check.monitorId])[0]);
      if (!monitor) throw new UptimeControlDatabaseError('Monitor was not found.', 'UPTIME_MONITOR_NOT_FOUND');
      database.run(`INSERT INTO checks(id,workspace_id,monitor_id,probe_id,scheduled_at,started_at,completed_at,outcome,latency_ms,status_code,failure_category,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
        check.id, tenant, check.monitorId, check.probeId, check.scheduledAt, check.startedAt, check.completedAt, check.outcome, check.latencyMs, check.statusCode, check.failureCategory || null, JSON.stringify({ ...check, workspaceId: tenant })
      ]);
      return publicCheck(rows(database, 'SELECT * FROM checks WHERE workspace_id = ? AND id = ?', [tenant, check.id])[0]);
    });
  }

  listChecks(workspace, monitorId, options = {}) {
    return this.#read((database) => {
      const clauses = ['workspace_id = ?', 'monitor_id = ?'];
      const parameters = [workspaceId(workspace), requiredText(monitorId, 'Monitor ID', 200)];
      if (options.from) { clauses.push('completed_at >= ?'); parameters.push(isoTime(options.from, 'Check range start')); }
      if (options.to) { clauses.push('completed_at <= ?'); parameters.push(isoTime(options.to, 'Check range end')); }
      if (options.outcome) { clauses.push('outcome = ?'); parameters.push(requiredText(options.outcome, 'Check outcome', 40)); }
      const limit = Math.max(1, Math.min(100000, Number(options.limit) || 500));
      return rows(database, `SELECT * FROM checks WHERE ${clauses.join(' AND ')} ORDER BY completed_at DESC, id DESC LIMIT ?`, [...parameters, limit]).map(publicCheck);
    });
  }

  upsertCheckSnapshot(workspace, input = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const check = normalizeCheckInput(input);
      const monitor = publicMonitor(rows(database, 'SELECT * FROM monitors WHERE workspace_id = ? AND id = ?', [tenant, check.monitorId])[0]);
      if (!monitor) throw new UptimeControlDatabaseError('Monitor was not found.', 'UPTIME_MONITOR_NOT_FOUND');
      database.run(`INSERT INTO checks(id,workspace_id,monitor_id,probe_id,scheduled_at,started_at,completed_at,outcome,latency_ms,status_code,failure_category,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,monitor_id=excluded.monitor_id,probe_id=excluded.probe_id,scheduled_at=excluded.scheduled_at,started_at=excluded.started_at,completed_at=excluded.completed_at,outcome=excluded.outcome,latency_ms=excluded.latency_ms,status_code=excluded.status_code,failure_category=excluded.failure_category,data_json=excluded.data_json`, [
        check.id, tenant, check.monitorId, check.probeId, check.scheduledAt, check.startedAt, check.completedAt, check.outcome, check.latencyMs, check.statusCode, check.failureCategory || null, JSON.stringify({ ...check, workspaceId: tenant })
      ]);
      return publicCheck(rows(database, 'SELECT * FROM checks WHERE workspace_id = ? AND id = ?', [tenant, check.id])[0]);
    });
  }

  createIncident(workspace, actor, input = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const user = actorId(actor);
      const incident = normalizeIncidentInput(input);
      if (!rows(database, 'SELECT id FROM monitors WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [tenant, incident.monitorId]).length) throw new UptimeControlDatabaseError('Monitor was not found.', 'UPTIME_MONITOR_NOT_FOUND');
      const now = this.clock();
      const record = { ...incident, workspaceId: tenant, revision: 1, createdAt: now, updatedAt: now, createdBy: user, updatedBy: user };
      database.run(`INSERT INTO incidents(id,workspace_id,monitor_id,state,severity,opened_at,acknowledged_at,resolved_at,revision,created_at,updated_at,created_by,updated_by,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        record.id, tenant, record.monitorId, record.state, record.severity, record.openedAt, record.acknowledgedAt, record.resolvedAt, 1, now, now, user, user, JSON.stringify(record)
      ]);
      return publicIncident(rows(database, 'SELECT * FROM incidents WHERE workspace_id = ? AND id = ?', [tenant, record.id])[0]);
    });
  }

  getActiveIncident(workspace, monitorId) {
    return this.#read((database) => publicIncident(rows(database, `SELECT * FROM incidents WHERE workspace_id = ? AND monitor_id = ? AND state IN ('open','acknowledged') ORDER BY opened_at DESC LIMIT 1`, [workspaceId(workspace), requiredText(monitorId, 'Monitor ID', 200)])[0]));
  }

  listIncidents(workspace, options = {}) {
    return this.#read((database) => {
      const clauses = ['workspace_id = ?'];
      const parameters = [workspaceId(workspace)];
      if (options.monitorId) { clauses.push('monitor_id = ?'); parameters.push(requiredText(options.monitorId, 'Monitor ID', 200)); }
      if (options.state) { clauses.push('state = ?'); parameters.push(requiredText(options.state, 'Incident state', 40)); }
      if (options.from) { clauses.push('opened_at >= ?'); parameters.push(isoTime(options.from, 'Incident range start')); }
      if (options.to) { clauses.push('opened_at <= ?'); parameters.push(isoTime(options.to, 'Incident range end')); }
      const limit = Math.max(1, Math.min(10000, Number(options.limit) || 500));
      return rows(database, `SELECT * FROM incidents WHERE ${clauses.join(' AND ')} ORDER BY opened_at DESC, id DESC LIMIT ?`, [...parameters, limit]).map(publicIncident);
    });
  }

  upsertIncidentSnapshot(workspace, input = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const normalized = normalizeIncidentInput(input);
      const id = requiredText(input.id, 'Incident ID', 200);
      const revision = Math.max(1, Number(input.revision) || 1);
      const createdAt = isoTime(input.createdAt || input.openedAt || this.clock(), 'Incident creation time');
      const updatedAt = isoTime(input.updatedAt || createdAt, 'Incident update time');
      const createdBy = actorId(input.createdBy);
      const updatedBy = actorId(input.updatedBy || input.createdBy);
      const record = { ...structuredClone(input), ...normalized, id, workspaceId: tenant, revision, createdAt, updatedAt, createdBy, updatedBy };
      const current = publicIncident(rows(database, 'SELECT * FROM incidents WHERE workspace_id = ? AND id = ?', [tenant, id])[0]);
      if (current && Date.parse(current.updatedAt) > Date.parse(updatedAt)) return current;
      database.run(`INSERT INTO incidents(id,workspace_id,monitor_id,state,severity,opened_at,acknowledged_at,resolved_at,revision,created_at,updated_at,created_by,updated_by,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,monitor_id=excluded.monitor_id,state=excluded.state,severity=excluded.severity,opened_at=excluded.opened_at,acknowledged_at=excluded.acknowledged_at,resolved_at=excluded.resolved_at,revision=excluded.revision,created_at=excluded.created_at,updated_at=excluded.updated_at,created_by=excluded.created_by,updated_by=excluded.updated_by,data_json=excluded.data_json`, [
        id, tenant, record.monitorId, record.state, record.severity, record.openedAt, record.acknowledgedAt, record.resolvedAt,
        revision, createdAt, updatedAt, createdBy, updatedBy, JSON.stringify(record)
      ]);
      return publicIncident(rows(database, 'SELECT * FROM incidents WHERE workspace_id = ? AND id = ?', [tenant, id])[0]);
    });
  }

  updateIncident(workspace, actor, id, changes = {}, expectedRevision) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const incidentId = requiredText(id, 'Incident ID', 200);
      const current = publicIncident(rows(database, 'SELECT * FROM incidents WHERE workspace_id = ? AND id = ?', [tenant, incidentId])[0]);
      if (!current) return null;
      if (Number(expectedRevision ?? changes.revision) !== current.revision) throw new UptimeRevisionConflictError('Incident', incidentId);
      const normalized = normalizeIncidentInput({ ...current, ...structuredClone(changes) });
      const now = this.clock();
      const next = { ...current, ...normalized, revision: current.revision + 1, updatedAt: now, updatedBy: actorId(actor) };
      database.run(`UPDATE incidents SET state=?,severity=?,acknowledged_at=?,resolved_at=?,revision=?,updated_at=?,updated_by=?,data_json=? WHERE workspace_id=? AND id=? AND revision=?`, [next.state, next.severity, next.acknowledgedAt, next.resolvedAt, next.revision, now, next.updatedBy, JSON.stringify(next), tenant, incidentId, current.revision]);
      if (database.getRowsModified() !== 1) throw new UptimeRevisionConflictError('Incident', incidentId);
      return publicIncident(rows(database, 'SELECT * FROM incidents WHERE workspace_id = ? AND id = ?', [tenant, incidentId])[0]);
    });
  }

  createMaintenanceWindow(workspace, actor, input = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const user = actorId(actor);
      const normalized = normalizeMaintenanceInput(input);
      const now = this.clock();
      const record = { ...normalized, id: String(input.id || createId('maintenance')), workspaceId: tenant, revision: 1, createdAt: now, updatedAt: now, createdBy: user, updatedBy: user, deletedAt: null };
      database.run(`INSERT INTO maintenance_windows(id,workspace_id,name,state,starts_at,ends_at,timezone,revision,created_at,updated_at,created_by,updated_by,deleted_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [record.id, tenant, record.name, record.state, record.startsAt, record.endsAt, record.timezone, 1, now, now, user, user, null, JSON.stringify(record)]);
      return publicMaintenance(rows(database, 'SELECT * FROM maintenance_windows WHERE workspace_id = ? AND id = ?', [tenant, record.id])[0]);
    });
  }

  listMaintenanceWindows(workspace, options = {}) {
    return this.#read((database) => {
      const clauses = ['workspace_id = ?', options.includeDeleted ? '1 = 1' : 'deleted_at IS NULL'];
      const parameters = [workspaceId(workspace)];
      if (options.activeAt) { const at = isoTime(options.activeAt, 'Active maintenance time'); clauses.push("state = 'enabled' AND starts_at <= ? AND ends_at > ?"); parameters.push(at, at); }
      const limit = Math.max(1, Math.min(10000, Number(options.limit) || 1000));
      return rows(database, `SELECT * FROM maintenance_windows WHERE ${clauses.join(' AND ')} ORDER BY starts_at DESC, id DESC LIMIT ?`, [...parameters, limit]).map(publicMaintenance);
    });
  }

  upsertMaintenanceSnapshot(workspace, input = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const normalized = normalizeMaintenanceInput(input);
      const id = requiredText(input.id, 'Maintenance window ID', 200);
      const revision = Math.max(1, Number(input.revision) || 1);
      const createdAt = isoTime(input.createdAt || this.clock(), 'Maintenance creation time');
      const updatedAt = isoTime(input.updatedAt || createdAt, 'Maintenance update time');
      const deletedAt = input.deletedAt ? isoTime(input.deletedAt, 'Maintenance deletion time') : null;
      const createdBy = actorId(input.createdBy);
      const updatedBy = actorId(input.updatedBy || input.createdBy);
      const record = { ...structuredClone(input), ...normalized, id, workspaceId: tenant, revision, createdAt, updatedAt, createdBy, updatedBy, deletedAt };
      const current = publicMaintenance(rows(database, 'SELECT * FROM maintenance_windows WHERE workspace_id = ? AND id = ?', [tenant, id])[0]);
      if (current && Date.parse(current.updatedAt) > Date.parse(updatedAt)) return current;
      database.run(`INSERT INTO maintenance_windows(id,workspace_id,name,state,starts_at,ends_at,timezone,revision,created_at,updated_at,created_by,updated_by,deleted_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,name=excluded.name,state=excluded.state,starts_at=excluded.starts_at,ends_at=excluded.ends_at,timezone=excluded.timezone,revision=excluded.revision,created_at=excluded.created_at,updated_at=excluded.updated_at,created_by=excluded.created_by,updated_by=excluded.updated_by,deleted_at=excluded.deleted_at,data_json=excluded.data_json`, [
        id, tenant, record.name, record.state, record.startsAt, record.endsAt, record.timezone, revision,
        createdAt, updatedAt, createdBy, updatedBy, deletedAt, JSON.stringify(record)
      ]);
      return publicMaintenance(rows(database, 'SELECT * FROM maintenance_windows WHERE workspace_id = ? AND id = ?', [tenant, id])[0]);
    });
  }

  updateMaintenanceWindow(workspace, actor, id, changes = {}, expectedRevision) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const maintenanceId = requiredText(id, 'Maintenance window ID', 200);
      const current = publicMaintenance(rows(database, 'SELECT * FROM maintenance_windows WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [tenant, maintenanceId])[0]);
      if (!current) return null;
      const revision = Number(expectedRevision ?? changes.revision);
      if (!Number.isInteger(revision) || revision !== current.revision) throw new UptimeRevisionConflictError('Maintenance window', maintenanceId);
      const normalized = normalizeMaintenanceInput({ ...current, ...structuredClone(changes) });
      const now = this.clock();
      const next = { ...current, ...normalized, revision: current.revision + 1, updatedAt: now, updatedBy: actorId(actor) };
      database.run(`UPDATE maintenance_windows SET name=?,state=?,starts_at=?,ends_at=?,timezone=?,revision=?,updated_at=?,updated_by=?,data_json=? WHERE workspace_id=? AND id=? AND revision=? AND deleted_at IS NULL`, [
        next.name, next.state, next.startsAt, next.endsAt, next.timezone, next.revision, now, next.updatedBy, JSON.stringify(next), tenant, maintenanceId, current.revision
      ]);
      if (database.getRowsModified() !== 1) throw new UptimeRevisionConflictError('Maintenance window', maintenanceId);
      return publicMaintenance(rows(database, 'SELECT * FROM maintenance_windows WHERE workspace_id = ? AND id = ?', [tenant, maintenanceId])[0]);
    });
  }

  deleteMaintenanceWindow(workspace, actor, id, expectedRevision) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const maintenanceId = requiredText(id, 'Maintenance window ID', 200);
      const current = publicMaintenance(rows(database, 'SELECT * FROM maintenance_windows WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [tenant, maintenanceId])[0]);
      if (!current) return { id: maintenanceId, deleted: false, absent: true };
      if (Number(expectedRevision ?? current.revision) !== current.revision) throw new UptimeRevisionConflictError('Maintenance window', maintenanceId);
      const now = this.clock();
      const next = { ...current, state: 'disabled', revision: current.revision + 1, updatedAt: now, updatedBy: actorId(actor), deletedAt: now };
      database.run(`UPDATE maintenance_windows SET state='disabled',revision=?,updated_at=?,updated_by=?,deleted_at=?,data_json=? WHERE workspace_id=? AND id=? AND revision=? AND deleted_at IS NULL`, [
        next.revision, now, next.updatedBy, now, JSON.stringify(next), tenant, maintenanceId, current.revision
      ]);
      if (database.getRowsModified() !== 1) throw new UptimeRevisionConflictError('Maintenance window', maintenanceId);
      return { id: maintenanceId, deleted: true, absent: false };
    });
  }

  upsertDailyRollup(workspace, monitorId, dateUtc, metrics = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const id = requiredText(monitorId, 'Monitor ID', 200);
      const date = requiredText(dateUtc, 'Rollup date', 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UptimeValidationError('UPTIME_ROLLUP_DATE_INVALID', 'Rollup date must use YYYY-MM-DD.');
      const numeric = (name) => Math.max(0, Number(metrics[name]) || 0);
      const record = { ...structuredClone(metrics), workspaceId: tenant, monitorId: id, dateUtc: date };
      database.run(`INSERT INTO daily_rollups(workspace_id,monitor_id,date_utc,eligible_ms,up_ms,down_ms,warning_ms,unknown_ms,maintenance_ms,paused_ms,check_count,successful_check_count,failed_check_count,latency_count,latency_sum_ms,latency_p50_ms,latency_p95_ms,latency_p99_ms,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,monitor_id,date_utc) DO UPDATE SET eligible_ms=excluded.eligible_ms,up_ms=excluded.up_ms,down_ms=excluded.down_ms,warning_ms=excluded.warning_ms,unknown_ms=excluded.unknown_ms,maintenance_ms=excluded.maintenance_ms,paused_ms=excluded.paused_ms,check_count=excluded.check_count,successful_check_count=excluded.successful_check_count,failed_check_count=excluded.failed_check_count,latency_count=excluded.latency_count,latency_sum_ms=excluded.latency_sum_ms,latency_p50_ms=excluded.latency_p50_ms,latency_p95_ms=excluded.latency_p95_ms,latency_p99_ms=excluded.latency_p99_ms,data_json=excluded.data_json`, [
        tenant, id, date, numeric('eligibleMs'), numeric('upMs'), numeric('downMs'), numeric('warningMs'), numeric('unknownMs'), numeric('maintenanceMs'), numeric('pausedMs'), numeric('checkCount'), numeric('successfulCheckCount'), numeric('failedCheckCount'), numeric('latencyCount'), numeric('latencySumMs'), metrics.latencyP50Ms == null ? null : numeric('latencyP50Ms'), metrics.latencyP95Ms == null ? null : numeric('latencyP95Ms'), metrics.latencyP99Ms == null ? null : numeric('latencyP99Ms'), JSON.stringify(record)
      ]);
      return record;
    });
  }

  listDailyRollups(workspace, options = {}) {
    return this.#read((database) => {
      const clauses = ['workspace_id = ?'];
      const parameters = [workspaceId(workspace)];
      if (options.monitorId) { clauses.push('monitor_id = ?'); parameters.push(requiredText(options.monitorId, 'Monitor ID', 200)); }
      if (options.fromDate) { clauses.push('date_utc >= ?'); parameters.push(requiredText(options.fromDate, 'Rollup start date', 10)); }
      if (options.toDate) { clauses.push('date_utc <= ?'); parameters.push(requiredText(options.toDate, 'Rollup end date', 10)); }
      return rows(database, `SELECT * FROM daily_rollups WHERE ${clauses.join(' AND ')} ORDER BY date_utc DESC, monitor_id`, parameters).map((row) => ({ ...parseObject(row.data_json, 'daily rollup'), workspaceId: row.workspace_id, monitorId: row.monitor_id, dateUtc: row.date_utc }));
    });
  }

  recordWorkerHeartbeat(workspace, probeId, input = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const probe = requiredText(probeId, 'Probe ID', 200);
      const state = String(input.state || 'active').toLowerCase();
      if (!['starting', 'active', 'stopping', 'offline', 'error'].includes(state)) throw new UptimeValidationError('UPTIME_WORKER_STATE_INVALID', 'Worker state is unsupported.');
      const record = { ...structuredClone(input), workspaceId: tenant, probeId: probe, state, heartbeatAt: isoTime(input.heartbeatAt || this.clock(), 'Worker heartbeat time'), processId: input.processId == null ? null : Number(input.processId) };
      database.run(`INSERT INTO worker_heartbeats(workspace_id,probe_id,heartbeat_at,state,process_id,data_json) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,probe_id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,state=excluded.state,process_id=excluded.process_id,data_json=excluded.data_json`, [tenant, probe, record.heartbeatAt, state, Number.isInteger(record.processId) ? record.processId : null, JSON.stringify(record)]);
      return record;
    });
  }

  listWorkerHeartbeats(workspace) {
    return this.#read((database) => rows(database, 'SELECT * FROM worker_heartbeats WHERE workspace_id = ? ORDER BY probe_id', [workspaceId(workspace)]).map((row) => ({ ...parseObject(row.data_json, 'worker heartbeat'), workspaceId: row.workspace_id, probeId: row.probe_id, heartbeatAt: row.heartbeat_at, state: row.state, processId: row.process_id == null ? null : Number(row.process_id) })));
  }

  getMigrationMarker(workspace, key) {
    return this.#read((database) => {
      const row = rows(database, 'SELECT * FROM migration_markers WHERE workspace_id = ? AND marker_key = ?', [workspaceId(workspace), requiredText(key, 'Migration marker key', 200)])[0];
      return row ? { ...parseObject(row.data_json, 'migration marker'), workspaceId: row.workspace_id, key: row.marker_key, completedAt: row.completed_at } : null;
    });
  }

  setMigrationMarker(workspace, key, details = {}) {
    return this.#transaction((database) => {
      const tenant = workspaceId(workspace);
      const markerKey = requiredText(key, 'Migration marker key', 200);
      const record = { ...structuredClone(details), workspaceId: tenant, key: markerKey, completedAt: this.clock() };
      database.run('INSERT OR REPLACE INTO migration_markers(workspace_id,marker_key,completed_at,data_json) VALUES (?,?,?,?)', [tenant, markerKey, record.completedAt, JSON.stringify(record)]);
      return record;
    });
  }

  pruneChecksBefore(workspace, cutoff) {
    return this.#transaction((database) => {
      database.run('DELETE FROM checks WHERE workspace_id = ? AND completed_at < ?', [workspaceId(workspace), isoTime(cutoff, 'Check retention cutoff')]);
      return database.getRowsModified();
    });
  }

  pruneDailyRollupsBefore(workspace, cutoffDate) {
    return this.#transaction((database) => {
      const date = requiredText(cutoffDate, 'Rollup retention cutoff', 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UptimeValidationError('UPTIME_ROLLUP_DATE_INVALID', 'Rollup retention cutoff must use YYYY-MM-DD.');
      database.run('DELETE FROM daily_rollups WHERE workspace_id = ? AND date_utc < ?', [workspaceId(workspace), date]);
      return database.getRowsModified();
    });
  }

  async close() {
    await this.operationQueue;
    if (this.database) this.database.close();
    this.database = null;
    this.initialized = false;
  }

  #replaceMonitorRoutes(database, monitor) {
    database.run('DELETE FROM monitor_notification_routes WHERE workspace_id = ? AND monitor_id = ?', [monitor.workspaceId, monitor.id]);
    for (const [position, routeId] of monitor.notificationRouteIds.entries()) {
      database.run('INSERT INTO monitor_notification_routes(workspace_id,monitor_id,route_id,position) VALUES (?,?,?,?)', [monitor.workspaceId, monitor.id, routeId, position]);
    }
  }

  #read(operation) {
    return this.#enqueue(async () => {
      this.#assertInitialized();
      return this.#withFileLock(async () => {
        await this.#reload();
        return operation(this.database);
      });
    });
  }

  #transaction(operation) {
    return this.#enqueue(async () => {
      this.#assertInitialized();
      return this.#withFileLock(async () => {
        await this.#reload();
        const SqlJs = await SQL;
        const before = this.database.export();
        this.database.run('BEGIN IMMEDIATE');
        try {
          const result = await operation(this.database);
          this.#assertForeignKeys();
          this.database.run('COMMIT');
          await this.#persist();
          return result;
        } catch (error) {
          try { this.database.run('ROLLBACK'); } catch {}
          try { this.database.close(); } catch {}
          this.database = new SqlJs.Database(before);
          this.database.run('PRAGMA foreign_keys = ON');
          throw error;
        }
      });
    });
  }

  #enqueue(operation) {
    const pending = this.operationQueue.then(operation, operation);
    this.operationQueue = pending.catch(() => {});
    return pending;
  }

  async #migrate(currentVersion) {
    if (currentVersion !== 0) throw new UptimeControlDatabaseCompatibilityError(`No migration path exists from Uptime Monitor schema ${currentVersion}.`);
    const before = this.database.export();
    this.database.run('BEGIN IMMEDIATE');
    try {
      this.database.run(SCHEMA_SQL);
      this.database.run('INSERT INTO schema_migrations(version,description,applied_at) VALUES (?,?,?)', [1, 'Create the Uptime Monitor control-plane schema.', this.clock()]);
      this.database.run('PRAGMA user_version = 1');
      this.#verifySchema();
      this.database.run('COMMIT');
      await this.#persist();
    } catch (error) {
      try { this.database.run('ROLLBACK'); } catch {}
      const SqlJs = await SQL;
      try { this.database.close(); } catch {}
      this.database = new SqlJs.Database(before);
      this.database.run('PRAGMA foreign_keys = ON');
      throw error;
    }
  }

  #verifyIntegrity() {
    const result = oneValue(this.database, 'PRAGMA integrity_check');
    if (result !== 'ok') throw new UptimeControlDatabaseCorruptionError(`Uptime Monitor control.db integrity check failed: ${result || 'unknown error'}.`);
  }

  #assertForeignKeys() {
    const [violation] = rows(this.database, 'PRAGMA foreign_key_check');
    if (violation) throw new UptimeControlDatabaseCorruptionError(`Uptime Monitor control.db contains an invalid foreign key in ${violation.table}.`);
  }

  #verifySchema() {
    this.#assertForeignKeys();
    const indexes = new Set(rows(this.database, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name));
    for (const indexName of REQUIRED_INDEXES) {
      if (!indexes.has(indexName)) throw new UptimeControlDatabaseCorruptionError(`Uptime Monitor control.db is missing required index ${indexName}.`);
    }
    const sample = rows(this.database, 'SELECT data_json FROM monitors LIMIT 1')[0];
    if (sample) parseObject(sample.data_json, 'monitor record');
  }

  async #createMigrationBackup(version) {
    const stamp = this.clock().replace(/[^0-9]/g, '').slice(0, 17);
    const backupName = `${DATABASE_FILE_NAME}.pre-migration-v${version}-${stamp}-${crypto.randomBytes(3).toString('hex')}.bak`;
    await fs.copyFile(this.databasePath, path.join(this.rootPath, backupName), fs.constants.COPYFILE_EXCL);
  }

  async #persist() {
    const temporaryPath = path.join(this.rootPath, `.${DATABASE_FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporaryPath, 'wx', 0o600);
      try { await handle.writeFile(Buffer.from(this.database.export())); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporaryPath, this.databasePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async #reload() {
    let bytes;
    try { bytes = await fs.readFile(this.databasePath); }
    catch (error) {
      if (error.code === 'ENOENT') throw new UptimeControlDatabaseCorruptionError('Uptime Monitor control.db disappeared after initialization.');
      throw error;
    }
    const SqlJs = await SQL;
    let next;
    try { next = new SqlJs.Database(bytes); }
    catch (error) { throw new UptimeControlDatabaseCorruptionError('Uptime Monitor control.db is not readable.', { cause: error }); }
    next.run('PRAGMA foreign_keys = ON');
    const previous = this.database;
    this.database = next;
    try {
      this.#verifyIntegrity();
      const version = Number(oneValue(this.database, 'PRAGMA user_version') || 0);
      if (version !== CONTROL_DATABASE_VERSION) throw new UptimeControlDatabaseCompatibilityError(`Uptime Monitor control.db schema ${version} does not match supported schema ${CONTROL_DATABASE_VERSION}.`);
      this.#verifySchema();
    } catch (error) {
      this.database = previous;
      next.close();
      throw error;
    }
    if (previous) previous.close();
  }

  async #withFileLock(operation) {
    const token = crypto.randomUUID();
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() })); }
        finally { await handle.close(); }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner = null;
        try { owner = JSON.parse(await fs.readFile(this.lockPath, 'utf8')); } catch {}
        if (!processIsRunning(owner?.pid)) {
          await fs.rm(this.lockPath, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) throw new UptimeControlDatabaseError('Timed out waiting for the Uptime Monitor control database lock.', 'UPTIME_CONTROL_DB_LOCK_TIMEOUT');
        await delay(this.lockRetryMs);
      }
    }
    try { return await operation(); }
    finally {
      try {
        const owner = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
        if (owner.token === token) await fs.rm(this.lockPath, { force: true });
      } catch {}
    }
  }

  #assertInitialized() {
    if (!this.initialized || !this.database) throw new UptimeControlDatabaseError('Uptime Monitor control database is not initialized.', 'UPTIME_CONTROL_DB_NOT_INITIALIZED');
  }
}

module.exports = {
  CHECK_OUTCOMES,
  CONTROL_DATABASE_VERSION,
  DATABASE_FILE_NAME,
  DATABASE_LOCK_FILE_NAME,
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  MONITOR_STATES,
  MONITOR_TYPES,
  UptimeControlDatabase,
  UptimeControlDatabaseCompatibilityError,
  UptimeControlDatabaseCorruptionError,
  UptimeControlDatabaseError,
  UptimeRevisionConflictError,
  normalizeMaintenanceInput
};
