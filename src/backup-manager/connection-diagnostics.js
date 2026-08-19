const crypto = require('crypto');

const MAX_CHECKS = 20;
const MAX_DETAILS = 12;
const MAX_LATENCY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_CATEGORIES = new Set([
  'authentication',
  'authorization',
  'canceled',
  'compatibility',
  'configuration',
  'connectivity',
  'integrity',
  'internal',
  'timeout',
  'unavailable'
]);
const ALLOWED_CHECK_STATUSES = new Set(['pass', 'fail', 'warning', 'skipped']);
const UNSAFE_KEY = /(?:authorization|cookie|credential|passphrase|password|private.?key|secret|stack|stderr|stdout|token|raw.?response|environment|command)/i;
const UNSAFE_VALUE = /(?:-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----|\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}|\b(?:password|passphrase|secret|token|api.?key)\s*[:=]\s*\S+)/i;

const NEXT_ACTIONS = Object.freeze({
  LOCAL_SOURCE_READ_DENIED: 'Grant DeployerX read access to the selected local paths, then run the test again.',
  LOCAL_TEST_CANCELED: 'Run the connection test again when you are ready.',
  SSH_HOST_KEY_MISMATCH: 'Stop and verify the server fingerprint through a trusted channel before approving a new host key.',
  SSH_TEST_CANCELED: 'Run the connection test again when you are ready.',
  SSH_CONNECTION_TIMEOUT: 'Confirm the host, port, firewall, and SSH service, then run the test again.',
  SSH_AUTHENTICATION_FAILED: 'Update the SSH username or credential, then run the test again.',
  SSH_CONNECT_FAILED: 'Confirm the host, port, firewall, DNS, and SSH service, then run the test again.',
  SSH_NOT_LINUX: 'Choose a Linux SSH source or use an adapter that supports this operating system.',
  SSH_SFTP_UNAVAILABLE: 'Enable the SFTP subsystem for this SSH account, then run the test again.',
  SSH_PLATFORM_PROBE_FAILED: 'Allow the SSH account to run the platform probe and verify the server response, then run the test again.',
  MYSQL_AUTHENTICATION_FAILED: 'Update the MySQL username or password, then run the test again.',
  MYSQL_TLS_FAILED: 'Verify the MySQL certificate and TLS mode, then run the test again.',
  MYSQL_CONNECT_FAILED: 'Confirm the MySQL host, port, firewall, and service, then run the test again.',
  MYSQL_NATIVE_TOOL_NOT_FOUND: 'Use the in-app setup to download and configure the MySQL client tools, then run the test again.',
  MYSQL_SERVER_VERSION_UNSUPPORTED: 'Use a supported MySQL 8 server or install a compatible adapter.',
  MYSQL_OPERATION_TIMEOUT: 'Check MySQL availability and network latency, then run the test again.',
  CONNECTION_TEST_INVALID_RESULT: 'Review the connection adapter output and run the test again.'
});

function boundedText(value, maximumLength, fallback = '') {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!text) return fallback;
  const safe = UNSAFE_VALUE.test(text) ? '[redacted]' : text;
  return safe.slice(0, maximumLength);
}

function safeIdentifier(value, fallback, maximumLength = 100) {
  const normalized = boundedText(value, maximumLength, fallback);
  return /^[A-Za-z0-9._:-]+$/.test(normalized) ? normalized : fallback;
}

function safeUtcTimestamp(value, fallback) {
  let parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) parsed = new Date(fallback);
  if (Number.isNaN(parsed.getTime())) parsed = new Date();
  return parsed.toISOString();
}

function safeNumber(value, minimum, maximum, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function sanitizePrimitiveObject(input, maximumEntries = MAX_DETAILS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(input).slice(0, maximumEntries)) {
    const key = safeIdentifier(rawKey, '', 80);
    if (!key) continue;
    if (UNSAFE_KEY.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    if (rawValue === null || typeof rawValue === 'boolean') output[key] = rawValue;
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) output[key] = rawValue;
    else if (typeof rawValue === 'string') output[key] = boundedText(rawValue, 240);
  }
  return output;
}

function nextActionFor(error) {
  if (!error) return 'No action is required.';
  return NEXT_ACTIONS[error.code]
    || (error.retryable
      ? 'Check the connection settings and service availability, then run the test again.'
      : 'Review the connection settings and resolve the reported issue before testing again.');
}

function normalizeError(input, invalidResult = false) {
  const error = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const code = invalidResult
    ? 'CONNECTION_TEST_INVALID_RESULT'
    : safeIdentifier(error.code, 'CONNECTION_TEST_FAILED', 80).toUpperCase();
  const category = ALLOWED_CATEGORIES.has(error.category) ? error.category : 'internal';
  const retryable = Boolean(error.retryable);
  const retryAfterSeconds = retryable && error.retryAfterSeconds !== null && error.retryAfterSeconds !== undefined
    ? safeNumber(error.retryAfterSeconds, 0, 86400, 0)
    : null;
  const normalized = {
    code,
    category,
    retryable,
    safeMessage: boundedText(
      invalidResult ? 'The connection adapter returned an invalid diagnostic result.' : error.safeMessage,
      500,
      'The connection test failed without a safe diagnostic message.'
    ),
    retryAfterSeconds,
    details: sanitizePrimitiveObject(error.details),
    causeFingerprint: error.causeFingerprint ? safeIdentifier(error.causeFingerprint, null, 128) : null
  };
  normalized.nextAction = nextActionFor(normalized);
  return normalized;
}

function diagnosticFingerprint(result) {
  const stable = JSON.stringify({
    adapterId: result.adapterId,
    adapterVersion: result.adapterVersion,
    status: result.status,
    code: result.error?.code || null,
    category: result.error?.category || null,
    checks: result.checks.map((check) => [check.id, check.status])
  });
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function buildSupportSummary(result) {
  const lines = [
    'DeployerX Backup Manager connection diagnostic',
    `Diagnostic: ${result.diagnosticFingerprint}`,
    `Adapter: ${result.adapterId} ${result.adapterVersion}`,
    `Outcome: ${result.status}`,
    `Tested: ${result.testedAt}`,
    `Latency: ${result.latencyMs} ms`
  ];
  if (result.error) {
    lines.push(`Error: ${result.error.code} (${result.error.category})`);
    lines.push(`Message: ${result.error.safeMessage}`);
    lines.push(`Next action: ${result.error.nextAction}`);
    lines.push(`Retryable: ${result.error.retryable ? 'yes' : 'no'}`);
  }
  for (const check of result.checks) lines.push(`Check ${check.id}: ${check.status} - ${check.safeMessage}`);
  return boundedText(lines.join('\n'), 4000);
}

function normalizeConnectionTestResult(input, options = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const now = typeof options.clock === 'function' ? options.clock() : new Date().toISOString();
  const validStatus = source.status === 'success' || source.status === 'failure';
  const status = validStatus ? source.status : 'failure';
  const checks = Array.isArray(source.checks)
    ? source.checks.slice(0, MAX_CHECKS).map((check, index) => {
      const candidate = check && typeof check === 'object' && !Array.isArray(check) ? check : {};
      const checkStatus = ALLOWED_CHECK_STATUSES.has(candidate.status) ? candidate.status : 'fail';
      return {
        id: safeIdentifier(candidate.id, `check-${index + 1}`, 80),
        status: checkStatus,
        safeMessage: boundedText(candidate.safeMessage, 300, 'No safe check details were provided.')
      };
    })
    : [];
  const result = {
    testedAt: safeUtcTimestamp(source.testedAt, now),
    latencyMs: safeNumber(source.latencyMs, 0, MAX_LATENCY_MS),
    adapterId: safeIdentifier(source.adapterId, options.adapterId || 'unknown.adapter', 120),
    adapterVersion: safeIdentifier(source.adapterVersion, options.adapterVersion || '0.0.0', 40),
    endpointIdentity: sanitizePrimitiveObject(source.endpointIdentity),
    status,
    checks,
    error: status === 'failure' ? normalizeError(source.error, !validStatus) : null
  };
  if (source.remotePlatform) result.remotePlatform = sanitizePrimitiveObject(source.remotePlatform, 6);
  result.diagnosticFingerprint = diagnosticFingerprint(result);
  result.supportSummary = buildSupportSummary(result);
  return result;
}

module.exports = {
  ALLOWED_CATEGORIES,
  MAX_CHECKS,
  MAX_DETAILS,
  MAX_LATENCY_MS,
  buildSupportSummary,
  normalizeConnectionTestResult,
  sanitizePrimitiveObject
};
