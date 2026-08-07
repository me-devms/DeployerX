const DATABASE_MANAGER_EVENT_VERSION = 1;

const EVENT_STATES = Object.freeze({
  'access-manager-state': new Set(['launching', 'active', 'focused', 'closed', 'exited', 'failed']),
  'connection-status': new Set(['testing', 'tested', 'opening', 'ready', 'closing', 'closed', 'failed']),
  'query-progress': new Set(['running', 'succeeded', 'failed', 'cancelled']),
  'batch-completion': new Set(['succeeded', 'failed', 'cancelled']),
  'schema-change': new Set(['loading', 'loaded', 'changed', 'failed', 'cancelled']),
  'task-state': new Set(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted']),
  'plugin-state': new Set(['catalog-refreshed', 'installed', 'enabled', 'disabled', 'removed', 'ready', 'warning', 'crashed'])
});

function eventError(message) {
  return Object.assign(new TypeError(message), { code: 'DATABASE_MANAGER_EVENT_INVALID' });
}

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw eventError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 200) {
  if (value === null || value === undefined || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function optionalCount(value, label) {
  if (value === null || value === undefined) return null;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw eventError(`${label} is invalid.`);
  return count;
}

function optionalCode(value, label) {
  const code = optionalText(value, label, 120);
  if (code !== null && !/^[A-Za-z0-9_.-]+$/.test(code)) throw eventError(`${label} is invalid.`);
  return code;
}

function normalizePayload(type, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw eventError('Database Manager event payload is invalid.');
  const states = EVENT_STATES[type];
  if (!states) throw eventError('Database Manager event type is invalid.');
  const state = requiredText(input.state, 'Database Manager event state', 40).toLowerCase();
  if (!states.has(state)) throw eventError('Database Manager event state is invalid.');

  if (type === 'access-manager-state') return Object.freeze({
    profileId: requiredText(input.profileId, 'Database profile ID'),
    state,
    reason: optionalText(input.reason, 'DB Access Manager event reason', 120)
  });
  if (type === 'connection-status') return Object.freeze({
    profileId: requiredText(input.profileId, 'Database profile ID'),
    state,
    operation: optionalText(input.operation, 'Database connection operation', 80),
    code: optionalCode(input.code, 'Database connection error code')
  });
  if (type === 'query-progress' || type === 'batch-completion') return Object.freeze({
    requestId: requiredText(input.requestId, 'Database query request ID'),
    profileId: requiredText(input.profileId, 'Database profile ID'),
    state,
    statementCount: optionalCount(input.statementCount, 'Database statement count'),
    rowCount: optionalCount(input.rowCount, 'Database row count'),
    code: optionalCode(input.code, 'Database query error code')
  });
  if (type === 'schema-change') return Object.freeze({
    requestId: optionalText(input.requestId, 'Database schema request ID'),
    profileId: requiredText(input.profileId, 'Database profile ID'),
    taskId: optionalText(input.taskId, 'Database task ID'),
    state,
    operation: optionalText(input.operation, 'Database schema operation', 80),
    code: optionalCode(input.code, 'Database schema error code')
  });
  if (type === 'task-state') {
    const percent = input.percent === null || input.percent === undefined ? null : Number(input.percent);
    if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) throw eventError('Database task percentage is invalid.');
    return Object.freeze({
      taskId: requiredText(input.taskId, 'Database task ID'),
      profileId: requiredText(input.profileId, 'Database profile ID'),
      state,
      phase: optionalText(input.phase, 'Database task phase', 100),
      percent
    });
  }
  return Object.freeze({
    pluginId: optionalText(input.pluginId, 'Database plugin ID'),
    state,
    code: optionalCode(input.code, 'Database plugin error code')
  });
}

function createDatabaseManagerEvent(type, workspaceId, payload, options = {}) {
  const eventType = requiredText(type, 'Database Manager event type', 80).toLowerCase();
  const sequence = Number(options.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw eventError('Database Manager event sequence is invalid.');
  const occurredAt = String(options.occurredAt || new Date().toISOString());
  if (!Number.isFinite(Date.parse(occurredAt))) throw eventError('Database Manager event timestamp is invalid.');
  return Object.freeze({
    databaseManagerEventVersion: DATABASE_MANAGER_EVENT_VERSION,
    sequence,
    type: eventType,
    workspaceId: requiredText(workspaceId, 'Workspace ID'),
    occurredAt,
    payload: normalizePayload(eventType, payload)
  });
}

module.exports = {
  DATABASE_MANAGER_EVENT_VERSION,
  EVENT_STATES,
  createDatabaseManagerEvent
};
