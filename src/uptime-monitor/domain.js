const crypto = require('node:crypto');

const MONITOR_TYPES = Object.freeze(['http', 'tcp', 'tls']);
const MONITOR_STATES = Object.freeze(['enabled', 'paused', 'disabled']);
const CHECK_OUTCOMES = Object.freeze(['up', 'warning', 'down', 'unknown', 'maintenance']);
const INCIDENT_STATES = Object.freeze(['open', 'acknowledged', 'resolved']);
const INCIDENT_SEVERITIES = Object.freeze(['warning', 'critical']);
const HTTP_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ASSERTION_OPERATORS = Object.freeze(['equals', 'not-equals', 'contains', 'not-contains', 'matches', 'exists', 'not-exists']);
const SENSITIVE_HTTP_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);

class UptimeValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UptimeValidationError';
    this.code = code;
    this.category = 'validation';
    this.details = details;
  }
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

function requiredText(value, label, maximum = 500) {
  const text = String(value ?? '').trim();
  if (!text) throw new UptimeValidationError('UPTIME_INPUT_REQUIRED', `${label} is required.`, { field: label });
  if (text.length > maximum) throw new UptimeValidationError('UPTIME_INPUT_TOO_LONG', `${label} cannot exceed ${maximum} characters.`, { field: label, maximum });
  return text;
}

function optionalText(value, maximum = 500) {
  const text = String(value ?? '').trim();
  if (text.length > maximum) throw new UptimeValidationError('UPTIME_INPUT_TOO_LONG', `Value cannot exceed ${maximum} characters.`, { maximum });
  return text;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new UptimeValidationError('UPTIME_NUMBER_INVALID', `${label} must be between ${minimum} and ${maximum}.`, { field: label, minimum, maximum });
  }
  return candidate;
}

function isoTime(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new UptimeValidationError('UPTIME_TIME_INVALID', `${label} is invalid.`, { field: label });
  return date.toISOString();
}

function uniqueTextList(values, { maximumItems = 100, maximumLength = 200, lowerCase = false, label = 'Values' } = {}) {
  const source = Array.isArray(values) ? values : values == null || values === '' ? [] : String(values).split(',');
  const normalized = source
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .map((value) => lowerCase ? value.toLowerCase() : value);
  if (normalized.length > maximumItems || normalized.some((value) => value.length > maximumLength)) {
    throw new UptimeValidationError('UPTIME_LIST_INVALID', `${label} contains too many or overly long values.`, { field: label, maximumItems, maximumLength });
  }
  return [...new Set(normalized)];
}

function normalizeHeaders(headers) {
  if (headers == null) return {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new UptimeValidationError('UPTIME_HTTP_HEADERS_INVALID', 'HTTP headers must be an object.');
  }
  const entries = Object.entries(headers).map(([key, value]) => [
    requiredText(key, 'HTTP header name', 200).toLowerCase(),
    requiredText(value, `HTTP header ${key}`, 8000)
  ]);
  if (entries.length > 100) throw new UptimeValidationError('UPTIME_HTTP_HEADERS_INVALID', 'HTTP requests support at most 100 headers.');
  if (entries.some(([key]) => SENSITIVE_HTTP_HEADERS.has(key))) {
    throw new UptimeValidationError('UPTIME_HTTP_SECRET_REQUIRED', 'Sensitive HTTP headers must use encrypted secret references.');
  }
  return Object.fromEntries(entries);
}

function normalizeSecretHeaderRefs(values) {
  if (values == null) return {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new UptimeValidationError('UPTIME_HTTP_SECRET_REFS_INVALID', 'Sensitive HTTP header references must be an object.');
  }
  const entries = Object.entries(values).map(([key, value]) => [
    requiredText(key, 'Sensitive HTTP header name', 200).toLowerCase(),
    requiredText(value, `Secret reference for ${key}`, 200)
  ]);
  if (entries.length > 20 || entries.some(([key]) => !SENSITIVE_HTTP_HEADERS.has(key))) {
    throw new UptimeValidationError('UPTIME_HTTP_SECRET_REFS_INVALID', 'Only supported sensitive HTTP headers can use secret references.');
  }
  return Object.fromEntries(entries);
}

function normalizeStatusRanges(values) {
  const source = Array.isArray(values) ? values : values == null || values === '' ? ['200-299'] : String(values).split(',');
  const ranges = source.map((value) => {
    if (typeof value === 'number') return { minimum: value, maximum: value };
    if (value && typeof value === 'object') return { minimum: Number(value.minimum), maximum: Number(value.maximum ?? value.minimum) };
    const match = String(value).trim().match(/^(\d{3})(?:\s*-\s*(\d{3}))?$/);
    if (!match) return null;
    return { minimum: Number(match[1]), maximum: Number(match[2] || match[1]) };
  });
  if (!ranges.length || ranges.some((range) => !range || range.minimum < 100 || range.maximum > 599 || range.minimum > range.maximum)) {
    throw new UptimeValidationError('UPTIME_HTTP_STATUS_INVALID', 'Expected HTTP statuses must be valid codes or ranges from 100 through 599.');
  }
  return ranges;
}

function normalizeAssertion(input, index) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const target = requiredText(source.target, `Assertion ${index + 1} target`, 40);
  if (!['body', 'header', 'jsonpath'].includes(target)) {
    throw new UptimeValidationError('UPTIME_ASSERTION_TARGET_INVALID', `Assertion ${index + 1} target is unsupported.`);
  }
  const operator = requiredText(source.operator || 'equals', `Assertion ${index + 1} operator`, 40);
  if (!ASSERTION_OPERATORS.includes(operator)) {
    throw new UptimeValidationError('UPTIME_ASSERTION_OPERATOR_INVALID', `Assertion ${index + 1} operator is unsupported.`);
  }
  const selector = target === 'body' ? '' : requiredText(source.selector, `Assertion ${index + 1} selector`, 1000);
  const expected = ['exists', 'not-exists'].includes(operator) ? '' : optionalText(source.expected, 8000);
  return { target, operator, selector, expected, caseSensitive: Boolean(source.caseSensitive) };
}

function normalizeHttpConfig(config = {}) {
  const urlText = requiredText(config.url, 'URL', 4096);
  let url;
  try { url = new URL(urlText); }
  catch { throw new UptimeValidationError('UPTIME_HTTP_URL_INVALID', 'Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new UptimeValidationError('UPTIME_HTTP_URL_INVALID', 'HTTP monitor URLs must use HTTP or HTTPS and cannot contain credentials or fragments.');
  }
  const method = String(config.method || 'GET').trim().toUpperCase();
  if (!HTTP_METHODS.includes(method)) throw new UptimeValidationError('UPTIME_HTTP_METHOD_INVALID', 'HTTP method is unsupported.');
  const assertions = Array.isArray(config.assertions) ? config.assertions.map(normalizeAssertion) : [];
  if (assertions.length > 50) throw new UptimeValidationError('UPTIME_ASSERTIONS_INVALID', 'HTTP monitors support at most 50 assertions.');
  const body = optionalText(config.body, 1024 * 1024);
  if (['GET', 'HEAD'].includes(method) && body) throw new UptimeValidationError('UPTIME_HTTP_BODY_INVALID', `${method} monitors cannot send a request body.`);
  return {
    url: url.toString(),
    method,
    headers: normalizeHeaders(config.headers),
    secretHeaderRefs: normalizeSecretHeaderRefs(config.secretHeaderRefs),
    body,
    followRedirects: config.followRedirects !== false,
    maximumRedirects: boundedInteger(config.maximumRedirects, 5, 0, 20, 'Maximum redirects'),
    verifyTls: config.verifyTls !== false,
    expectedStatusRanges: normalizeStatusRanges(config.expectedStatusRanges || config.expectedStatusCodes),
    assertions
  };
}

function normalizeTcpConfig(config = {}) {
  return {
    host: requiredText(config.host, 'TCP host', 253),
    port: boundedInteger(config.port, 80, 1, 65535, 'TCP port')
  };
}

function normalizeTlsConfig(config = {}) {
  return {
    host: requiredText(config.host, 'TLS host', 253),
    port: boundedInteger(config.port, 443, 1, 65535, 'TLS port'),
    serverName: optionalText(config.serverName || config.host, 253),
    verifyTls: config.verifyTls !== false,
    expiryWarningDays: boundedInteger(config.expiryWarningDays, 30, 1, 3650, 'TLS expiry warning days'),
    expiryCriticalDays: boundedInteger(config.expiryCriticalDays, 7, 0, 3650, 'TLS expiry critical days')
  };
}

function normalizeAlertPolicy(policy = {}) {
  const failureThreshold = boundedInteger(policy.failureThreshold, 2, 1, 20, 'Failure threshold');
  const recoveryThreshold = boundedInteger(policy.recoveryThreshold, 1, 1, 20, 'Recovery threshold');
  return {
    failureThreshold,
    recoveryThreshold,
    repeatEveryMinutes: boundedInteger(policy.repeatEveryMinutes, 0, 0, 10080, 'Repeat alert interval'),
    latencyWarningMs: boundedInteger(policy.latencyWarningMs, 0, 0, 120000, 'Latency warning threshold'),
    latencyCriticalMs: boundedInteger(policy.latencyCriticalMs, 0, 0, 120000, 'Latency critical threshold'),
    notifyOnWarning: policy.notifyOnWarning !== false,
    notifyOnRecovery: policy.notifyOnRecovery !== false
  };
}

function normalizeMonitorRuntime(runtime = {}) {
  const status = String(runtime.status || 'unknown').toLowerCase();
  if (!['unknown', 'up', 'warning', 'down', 'maintenance', 'paused'].includes(status)) {
    throw new UptimeValidationError('UPTIME_RUNTIME_STATUS_INVALID', 'Monitor runtime status is unsupported.');
  }
  const nullableTime = (value, label) => value ? isoTime(value, label) : null;
  return {
    status,
    consecutiveFailures: boundedInteger(runtime.consecutiveFailures, 0, 0, 1000000, 'Consecutive failures'),
    consecutiveSuccesses: boundedInteger(runtime.consecutiveSuccesses, 0, 0, 1000000, 'Consecutive successes'),
    lastCheckAt: nullableTime(runtime.lastCheckAt, 'Last check time'),
    lastSuccessAt: nullableTime(runtime.lastSuccessAt, 'Last success time'),
    lastFailureAt: nullableTime(runtime.lastFailureAt, 'Last failure time'),
    lastLatencyMs: runtime.lastLatencyMs == null ? null : Math.max(0, Number(runtime.lastLatencyMs) || 0),
    lastSummary: optionalText(runtime.lastSummary, 1000),
    activeIncidentId: optionalText(runtime.activeIncidentId, 200) || null
  };
}

function normalizeMonitorInput(input = {}) {
  const type = String(input.type || 'http').trim().toLowerCase();
  if (!MONITOR_TYPES.includes(type)) throw new UptimeValidationError('UPTIME_MONITOR_TYPE_INVALID', 'Monitor type is unsupported.');
  const state = String(input.state || (input.enabled === false ? 'paused' : 'enabled')).trim().toLowerCase();
  if (!MONITOR_STATES.includes(state)) throw new UptimeValidationError('UPTIME_MONITOR_STATE_INVALID', 'Monitor state is unsupported.');
  const config = type === 'tcp' ? normalizeTcpConfig(input.config || input.tcp) : type === 'tls' ? normalizeTlsConfig(input.config || input.tls) : normalizeHttpConfig(input.config || input.http);
  return {
    name: requiredText(input.name, 'Monitor name', 200),
    projectId: optionalText(input.projectId, 200) || null,
    group: optionalText(input.group, 200),
    tags: uniqueTextList(input.tags, { maximumItems: 50, maximumLength: 100, lowerCase: true, label: 'Tags' }),
    type,
    state,
    intervalSec: boundedInteger(input.intervalSec, 60, 30, 86400, 'Check interval'),
    timeoutMs: boundedInteger(input.timeoutMs, 10000, 1000, 120000, 'Check timeout'),
    probeId: optionalText(input.probeId, 200) || 'local-windows',
    config,
    alertPolicy: normalizeAlertPolicy(input.alertPolicy),
    notificationRouteIds: uniqueTextList(input.notificationRouteIds, { maximumItems: 50, maximumLength: 200, label: 'Notification routes' }),
    runtime: normalizeMonitorRuntime(input.runtime)
  };
}

function normalizeCheckInput(input = {}) {
  const outcome = requiredText(input.outcome, 'Check outcome', 40).toLowerCase();
  if (!CHECK_OUTCOMES.includes(outcome)) throw new UptimeValidationError('UPTIME_CHECK_OUTCOME_INVALID', 'Check outcome is unsupported.');
  const latencyMs = input.latencyMs == null ? null : Number(input.latencyMs);
  if (latencyMs != null && (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 86400000)) {
    throw new UptimeValidationError('UPTIME_CHECK_LATENCY_INVALID', 'Check latency is invalid.');
  }
  const statusCode = input.statusCode == null ? null : boundedInteger(input.statusCode, null, 100, 999, 'Status code');
  return {
    id: optionalText(input.id, 200) || createId('check'),
    monitorId: requiredText(input.monitorId, 'Monitor ID', 200),
    probeId: optionalText(input.probeId, 200) || 'local-windows',
    scheduledAt: isoTime(input.scheduledAt || input.startedAt || input.completedAt, 'Scheduled time'),
    startedAt: isoTime(input.startedAt || input.completedAt, 'Check start time'),
    completedAt: isoTime(input.completedAt, 'Check completion time'),
    outcome,
    latencyMs,
    statusCode,
    failureCategory: optionalText(input.failureCategory, 100),
    summary: optionalText(input.summary, 1000),
    details: input.details && typeof input.details === 'object' && !Array.isArray(input.details) ? structuredClone(input.details) : {}
  };
}

function normalizeIncidentInput(input = {}) {
  const state = String(input.state || 'open').toLowerCase();
  const severity = String(input.severity || 'critical').toLowerCase();
  if (!INCIDENT_STATES.includes(state)) throw new UptimeValidationError('UPTIME_INCIDENT_STATE_INVALID', 'Incident state is unsupported.');
  if (!INCIDENT_SEVERITIES.includes(severity)) throw new UptimeValidationError('UPTIME_INCIDENT_SEVERITY_INVALID', 'Incident severity is unsupported.');
  return {
    id: optionalText(input.id, 200) || createId('incident'),
    monitorId: requiredText(input.monitorId, 'Monitor ID', 200),
    state,
    severity,
    openedAt: isoTime(input.openedAt, 'Incident open time'),
    acknowledgedAt: input.acknowledgedAt ? isoTime(input.acknowledgedAt, 'Incident acknowledgement time') : null,
    resolvedAt: input.resolvedAt ? isoTime(input.resolvedAt, 'Incident resolution time') : null,
    summary: requiredText(input.summary, 'Incident summary', 1000),
    failureCategory: optionalText(input.failureCategory, 100),
    consecutiveFailures: boundedInteger(input.consecutiveFailures, 1, 1, 100000, 'Consecutive failures'),
    events: Array.isArray(input.events) ? structuredClone(input.events).slice(-500) : []
  };
}

module.exports = {
  ASSERTION_OPERATORS,
  CHECK_OUTCOMES,
  HTTP_METHODS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  MONITOR_STATES,
  MONITOR_TYPES,
  UptimeValidationError,
  boundedInteger,
  createId,
  isoTime,
  normalizeAlertPolicy,
  normalizeCheckInput,
  normalizeHeaders,
  normalizeHttpConfig,
  normalizeIncidentInput,
  normalizeMonitorInput,
  normalizeMonitorRuntime,
  normalizeStatusRanges,
  requiredText
};
