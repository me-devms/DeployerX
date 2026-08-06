const crypto = require('crypto');
const fs = require('fs/promises');
const https = require('https');
const net = require('net');
const path = require('path');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');

const ADAPTER_ID = 'deployerx.database.scylla-manager';
const ADAPTER_VERSION = '0.1.0';
const DEFAULT_BASE_PATH = '/api/v1';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TLS_FILE_BYTES = 1024 * 1024;
const MAX_CLUSTERS = 1000;
const MAX_NODES = 10000;
const MAX_ITEMS = 10000;
const MAX_TASK_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_MODES = new Set(['none', 'basic', 'bearer']);
const TASK_TYPES = new Set(['backup', 'restore']);
const BACKUP_METHODS = new Set(['auto', 'native', 'rclone']);
const LOCATION_SCHEMES = new Set(['s3', 'gcs', 'azure', 'local']);
const SUCCESS_RUN_STATES = new Set(['done', 'success', 'succeeded']);
const FAILED_RUN_STATES = new Set(['aborted', 'error', 'failed', 'stopped']);
const SENSITIVE_CLUSTER_KEY = /(?:auth.?token|password|secret|credential|access.?key|private.?key|user.?cert|user.?key)/i;

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeHost(value) {
  const input = requiredText(value, 'ScyllaDB Manager host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('ScyllaDB Manager host must be a hostname or IP address without a URI scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('ScyllaDB Manager host is invalid.');
  return ascii;
}

function normalizePort(value) {
  const port = Number(value ?? 5080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('ScyllaDB Manager port must be between 1 and 65535.');
  return port;
}

function normalizeBasePath(value) {
  const raw = optionalText(value, 'ScyllaDB Manager API base path', 512) || DEFAULT_BASE_PATH;
  if (!raw.startsWith('/') || raw.endsWith('/') || /[?#\\\s]/.test(raw) || raw.includes('//')) throw new TypeError('ScyllaDB Manager API base path is invalid.');
  const segments = raw.slice(1).split('/');
  for (const segment of segments) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new TypeError('ScyllaDB Manager API base path is invalid.'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\\0]/.test(decoded)) throw new TypeError('ScyllaDB Manager API base path is invalid.');
  }
  return `/${segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join('/')}`;
}

function normalizeAbsoluteFile(value, label) {
  const file = optionalText(value, label);
  if (!file) return null;
  if (!path.isAbsolute(file)) throw new TypeError(`${label} must be absolute.`);
  return path.normalize(file);
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ScyllaDB Manager connection configuration must be an object.');
  const allowed = ['host', 'port', 'basePath', 'authMode', 'username', 'credentialSecretRefId', 'tlsMode', 'caFile', 'clientCertificateFile', 'clientKeyFile', 'timeoutMs', 'managedClusterId', 'expectedManagerVersion', 'expectedDeploymentFingerprint'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown ScyllaDB Manager connection field: ${unknown[0]}.`);
  const authMode = String(input.authMode || 'none').toLowerCase();
  if (!AUTH_MODES.has(authMode)) throw new TypeError('ScyllaDB Manager authentication mode is invalid.');
  const username = optionalText(input.username, 'ScyllaDB Manager username', 256);
  const credentialSecretRefId = optionalText(input.credentialSecretRefId, 'ScyllaDB Manager credential SecretRef ID', 200);
  if (authMode === 'basic' && (!username || !credentialSecretRefId)) throw new TypeError('Basic authentication requires a username and credential SecretRef.');
  if (authMode === 'bearer' && (!credentialSecretRefId || username)) throw new TypeError('Bearer authentication requires only a credential SecretRef.');
  if (authMode === 'none' && (username || credentialSecretRefId)) throw new TypeError('Credentials are not valid when Manager authentication is disabled.');
  const tlsMode = String(input.tlsMode || 'verify-identity').toLowerCase();
  if (tlsMode !== 'verify-identity') throw new TypeError('ScyllaDB Manager protection requires TLS certificate identity verification.');
  const clientCertificateFile = normalizeAbsoluteFile(input.clientCertificateFile, 'Manager TLS client certificate file');
  const clientKeyFile = normalizeAbsoluteFile(input.clientKeyFile, 'Manager TLS client key file');
  if (Boolean(clientCertificateFile) !== Boolean(clientKeyFile)) throw new TypeError('Manager mutual TLS requires both a client certificate and client key file.');
  const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('ScyllaDB Manager timeout must be between 1 and 300 seconds.');
  return {
    host: normalizeHost(input.host), port: normalizePort(input.port), basePath: normalizeBasePath(input.basePath), authMode,
    username: authMode === 'basic' ? username : null, credentialSecretRefId: authMode === 'none' ? null : credentialSecretRefId,
    tlsMode, caFile: normalizeAbsoluteFile(input.caFile, 'Manager TLS CA file'), clientCertificateFile, clientKeyFile, timeoutMs,
    managedClusterId: requiredText(input.managedClusterId, 'Managed ScyllaDB cluster ID', 200),
    expectedManagerVersion: optionalText(input.expectedManagerVersion, 'Expected Manager version', 100),
    expectedDeploymentFingerprint: optionalText(input.expectedDeploymentFingerprint, 'Expected Manager deployment fingerprint', 100)
  };
}

function safeApiPath(config, apiPath, query = {}) {
  const pathname = requiredText(apiPath, 'ScyllaDB Manager API path', 2048);
  if (!pathname.startsWith('/') || /[?#\\\0]/.test(pathname) || pathname.split('/').some((segment) => segment === '.' || segment === '..')) throw new TypeError('ScyllaDB Manager API path is invalid.');
  const parameters = new URLSearchParams();
  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null) continue;
    const key = requiredText(rawKey, 'Manager query key', 100);
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) parameters.append(key, String(value));
  }
  const suffix = parameters.toString();
  return `${config.basePath}${pathname}${suffix ? `?${suffix}` : ''}`;
}

async function readTlsFile(file, label) {
  if (!file) return undefined;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_TLS_FILE_BYTES) throw new Error('invalid TLS file');
    return await fs.readFile(file);
  } catch {
    throw new DatabaseAdapterError('SCYLLA_MANAGER_TLS_FILE_INVALID', `${label} is unavailable or invalid.`, { category: 'configuration' });
  }
}

function authorizationHeader(config, credential) {
  if (config.authMode === 'none') return null;
  const value = String(credential ?? '');
  if (!value || value.includes('\0') || /[\r\n]/.test(value) || value.length > 16384) throw new DatabaseAdapterError('SCYLLA_MANAGER_CREDENTIAL_INVALID', 'Manager credentials cannot be represented safely.', { category: 'authentication' });
  if (config.authMode === 'basic') return `Basic ${Buffer.from(`${config.username}:${value}`, 'utf8').toString('base64')}`;
  if (/\s/.test(value)) throw new DatabaseAdapterError('SCYLLA_MANAGER_CREDENTIAL_INVALID', 'Manager bearer credentials cannot contain whitespace.', { category: 'authentication' });
  return `Bearer ${value}`;
}

async function defaultTransport({ config, method = 'GET', apiPath, query, authorization, body, signal }) {
  const [ca, cert, key] = await Promise.all([
    readTlsFile(config.caFile, 'Manager TLS CA file'), readTlsFile(config.clientCertificateFile, 'Manager TLS client certificate file'), readTlsFile(config.clientKeyFile, 'Manager TLS client key file')
  ]);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const request = https.request({
      protocol: 'https:', hostname: config.host, port: config.port, method, path: safeApiPath(config, apiPath, query),
      headers: { accept: 'application/json', ...(authorization ? { authorization } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
      ca, cert, key, rejectUnauthorized: true, servername: net.isIP(config.host) ? undefined : config.host, agent: false
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new DatabaseAdapterError('SCYLLA_MANAGER_RESPONSE_TOO_LARGE', 'Manager returned an oversized response.', { category: 'integrity' }));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        const statusCode = Number(response.statusCode || 0);
        const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')]));
        if (statusCode >= 300 && statusCode < 400) return finish(reject, new DatabaseAdapterError('SCYLLA_MANAGER_REDIRECT_REFUSED', 'Manager redirects are not allowed.', { category: 'connectivity' }));
        if (statusCode < 200 || statusCode >= 300) {
          const code = statusCode === 401 ? 'SCYLLA_MANAGER_AUTHENTICATION_FAILED' : statusCode === 403 ? 'SCYLLA_MANAGER_PRIVILEGE_MISSING' : statusCode === 404 ? 'SCYLLA_MANAGER_API_UNAVAILABLE' : statusCode === 409 ? 'SCYLLA_MANAGER_CONFLICT' : statusCode === 429 ? 'SCYLLA_MANAGER_RATE_LIMITED' : 'SCYLLA_MANAGER_REQUEST_FAILED';
          const category = statusCode === 401 ? 'authentication' : statusCode === 403 ? 'authorization' : statusCode === 409 ? 'conflict' : statusCode === 429 ? 'unavailable' : 'connectivity';
          return finish(reject, new DatabaseAdapterError(code, 'The authenticated ScyllaDB Manager request failed.', { category, retryable: statusCode === 429 || statusCode >= 500 }));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return finish(resolve, { statusCode, headers, body: null });
        if (!/^application\/(?:json|[^;]+[+]json)(?:;|$)/i.test(headers['content-type'] || '')) return finish(reject, new DatabaseAdapterError('SCYLLA_MANAGER_CONTENT_TYPE_INVALID', 'Manager returned a non-JSON response.', { category: 'integrity' }));
        try { return finish(resolve, { statusCode, headers, body: JSON.parse(text) }); }
        catch { return finish(reject, new DatabaseAdapterError('SCYLLA_MANAGER_RESPONSE_INVALID', 'Manager returned invalid JSON.', { category: 'integrity' })); }
      });
    });
    request.setTimeout(config.timeoutMs, () => request.destroy(new DatabaseAdapterError('SCYLLA_MANAGER_OPERATION_TIMEOUT', 'Manager request timed out.', { category: 'timeout', retryable: true })));
    request.on('error', (error) => finish(reject, error));
    const onAbort = () => request.destroy(new DatabaseAdapterError('SCYLLA_MANAGER_OPERATION_CANCELED', 'Manager request was canceled.', { category: 'canceled' }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (payload) request.write(payload);
    request.end();
  });
}

function parseManagerVersion(value) {
  const text = requiredText(typeof value === 'object' ? value.version : value, 'ScyllaDB Manager version', 100);
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text);
  if (!match) throw new DatabaseAdapterError('SCYLLA_MANAGER_VERSION_INVALID', 'Manager returned an invalid version.', { category: 'compatibility' });
  const version = { text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  if (version.major !== 3) throw new DatabaseAdapterError('SCYLLA_MANAGER_VERSION_UNSUPPORTED', `ScyllaDB Manager ${text} is not supported.`, { category: 'compatibility' });
  return version;
}

function cleanLabels(input) {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DatabaseAdapterError('SCYLLA_MANAGER_LABELS_INVALID', 'Manager task labels are invalid.', { category: 'integrity' });
  const entries = Object.entries(input);
  if (entries.length > 100) throw new DatabaseAdapterError('SCYLLA_MANAGER_LABEL_LIMIT_EXCEEDED', 'Manager returned too many task labels.', { category: 'integrity' });
  return Object.fromEntries(entries.map(([key, value]) => [requiredText(key, 'Manager task label key', 100), requiredText(value, 'Manager task label value', 500)]).sort(([a], [b]) => a.localeCompare(b, 'en-US')));
}

function normalizeCluster(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('SCYLLA_MANAGER_CLUSTER_INVALID', 'Manager returned invalid cluster metadata.', { category: 'integrity' });
  const safe = { id: requiredText(raw.id, 'Managed cluster ID', 200), name: requiredText(raw.name, 'Managed cluster name', 255), host: requiredText(raw.host, 'Managed cluster host', 512), port: Number(raw.port || 10001), labels: cleanLabels(raw.labels) };
  if (!Number.isInteger(safe.port) || safe.port < 1 || safe.port > 65535) throw new DatabaseAdapterError('SCYLLA_MANAGER_CLUSTER_INVALID', 'Manager returned an invalid managed cluster port.', { category: 'integrity' });
  safe.clusterFingerprint = stableDigest(safe);
  return safe;
}

function normalizeClusters(input) {
  if (!Array.isArray(input) || input.length > MAX_CLUSTERS) throw new DatabaseAdapterError('SCYLLA_MANAGER_CLUSTERS_INVALID', 'Manager returned an invalid or oversized cluster inventory.', { category: 'integrity' });
  return input.map(normalizeCluster).sort((left, right) => left.id.localeCompare(right.id, 'en-US'));
}

function normalizeStatus(input, clusterId) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_NODES) throw new DatabaseAdapterError('SCYLLA_MANAGER_STATUS_INVALID', 'Manager returned an invalid or empty agent inventory.', { category: 'integrity' });
  const nodes = input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('SCYLLA_MANAGER_STATUS_INVALID', 'Manager returned invalid agent status.', { category: 'integrity' });
    const node = {
      dc: requiredText(raw.dc, 'Manager node data center', 255), hostId: requiredText(raw.host_id, 'Manager node host ID', 200), host: requiredText(raw.host, 'Manager node host', 512),
      status: requiredText(raw.status, 'Manager agent status', 50).toLowerCase(), cqlStatus: requiredText(raw.cql_status, 'Manager CQL status', 50).toLowerCase(), restStatus: requiredText(raw.rest_status, 'Manager REST status', 50).toLowerCase(),
      scyllaVersion: requiredText(raw.scylla_version, 'ScyllaDB node version', 100), agentVersion: requiredText(raw.agent_version, 'ScyllaDB Manager agent version', 100),
      totalRam: Math.max(0, Number(raw.total_ram || 0)), cpuCount: Math.max(0, Number(raw.cpu_count || 0))
    };
    node.healthy = node.status === 'up' && node.cqlStatus === 'up' && node.restStatus === 'up';
    return node;
  }).sort((left, right) => left.hostId.localeCompare(right.hostId, 'en-US'));
  const dcs = [...new Set(nodes.map((node) => node.dc))].sort();
  return { clusterId, nodes, dataCenters: dcs, healthy: nodes.every((node) => node.healthy), topologyFingerprint: stableDigest(nodes.map((node) => ({ hostId: node.hostId, host: node.host, dc: node.dc, scyllaVersion: node.scyllaVersion, agentVersion: node.agentVersion }))) };
}

function deploymentFingerprint(version, cluster) {
  return stableDigest({ managerVersion: version.text, clusterId: cluster.id, clusterFingerprint: cluster.clusterFingerprint });
}

function normalizeLocation(value) {
  const location = requiredText(value, 'Manager backup location', 2048);
  if (/[\r\n]/.test(location) || /:\/\/[^/@\s]+@/.test(location) || /[?&](?:token|secret|password|key)=/i.test(location)) throw new TypeError('Manager backup location contains unsafe credential material.');
  const match = /^([a-z][a-z0-9+.-]*):(.+)$/.exec(location);
  if (!match || !LOCATION_SCHEMES.has(match[1].toLowerCase()) || !match[2].trim()) throw new TypeError('Manager backup location uses an unsupported or invalid scheme.');
  const normalized = `${match[1].toLowerCase()}:${match[2].replace(/\\/g, '/').replace(/\/+$/, '')}`;
  return { location: normalized, scheme: match[1].toLowerCase(), locationFingerprint: stableDigest(normalized) };
}

function uniqueTextList(input, label, maximum = MAX_ITEMS) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > maximum) throw new TypeError(`${label} must be a bounded array.`);
  return [...new Set(input.map((value) => requiredText(value, `${label} entry`, 512)))].sort((a, b) => a.localeCompare(b, 'en-US'));
}

function nonNegativeInteger(value, label, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 0) throw new DatabaseAdapterError('SCYLLA_MANAGER_RESPONSE_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return number;
}

function normalizeUnits(input, restore = false) {
  if (!Array.isArray(input) || input.length > MAX_ITEMS) throw new DatabaseAdapterError('SCYLLA_MANAGER_UNITS_INVALID', 'Manager returned invalid or oversized backup units.', { category: 'integrity' });
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('SCYLLA_MANAGER_UNITS_INVALID', 'Manager returned invalid backup units.', { category: 'integrity' });
    const tables = (raw.tables || []).map((item) => typeof item === 'string' ? item : item?.table || item?.name).filter(Boolean);
    return { keyspace: requiredText(raw.keyspace, 'Manager unit keyspace', 255), tables: uniqueTextList(tables, 'Manager unit tables'), allTables: restore ? false : raw.all_tables === true, ...(restore ? { size: nonNegativeInteger(raw.size, 'Manager restore unit size') } : {}) };
  }).sort((a, b) => a.keyspace.localeCompare(b.keyspace, 'en-US'));
}

function normalizeBackupTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('SCYLLA_MANAGER_TARGET_INVALID', 'Manager returned an invalid backup target.', { category: 'integrity' });
  const locations = uniqueTextList(raw.location, 'Manager target locations').map(normalizeLocation);
  if (!locations.length) throw new DatabaseAdapterError('SCYLLA_MANAGER_TARGET_INVALID', 'Manager backup target has no storage location.', { category: 'integrity' });
  const target = {
    clusterId: requiredText(raw.cluster_id, 'Manager target cluster ID', 200), dataCenters: uniqueTextList(raw.dc, 'Manager target data centers'), hosts: uniqueTextList(raw.with_hosts, 'Manager target hosts'), locations,
    units: normalizeUnits(raw.units), size: nonNegativeInteger(raw.size, 'Manager backup target size'), retention: nonNegativeInteger(raw.retention, 'Manager backup retention'), retentionDays: nonNegativeInteger(raw.retention_days, 'Manager backup retention days'),
    rateLimit: uniqueTextList(raw.rate_limit, 'Manager backup rate limits'), snapshotParallel: uniqueTextList(raw.snapshot_parallel, 'Manager snapshot parallelism'), uploadParallel: uniqueTextList(raw.upload_parallel, 'Manager upload parallelism'),
    transfers: nonNegativeInteger(raw.transfers, 'Manager backup transfers'), purgeOnly: raw.purge_only === true, skipSchema: raw.skip_schema === true,
    method: requiredText(raw.method || 'auto', 'Manager backup method', 50).toLowerCase(), retentionLockMode: optionalText(raw.retention_lock_mode, 'Manager retention lock mode', 100), overrideRetentionLock: raw.override_retention_lock === true
  };
  if (!BACKUP_METHODS.has(target.method)) throw new DatabaseAdapterError('SCYLLA_MANAGER_TARGET_INVALID', 'Manager resolved an unsupported backup method.', { category: 'compatibility' });
  target.targetFingerprint = stableDigest(target);
  return target;
}

function normalizeRestoreTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('SCYLLA_MANAGER_RESTORE_TARGET_INVALID', 'Manager returned an invalid restore target.', { category: 'integrity' });
  const target = {
    clusterId: requiredText(raw.cluster_id, 'Manager restore cluster ID', 200), snapshotTag: requiredText(raw.snapshot_tag, 'Manager snapshot tag', 255), locations: uniqueTextList(raw.location, 'Manager restore locations').map(normalizeLocation), units: normalizeUnits(raw.units, true),
    size: nonNegativeInteger(raw.size, 'Manager restore size'), batchSize: nonNegativeInteger(raw.batch_size, 'Manager restore batch size'), parallel: nonNegativeInteger(raw.parallel, 'Manager restore parallelism'), transfers: nonNegativeInteger(raw.transfers, 'Manager restore transfers'), rateLimit: uniqueTextList(raw.rate_limit, 'Manager restore rate limits'), allowCompaction: raw.allow_compaction === true, unpinAgentCpu: raw.unpin_agent_cpu === true,
    views: Array.isArray(raw.views) ? raw.views.slice(0, MAX_ITEMS).map((view) => ({ keyspace: optionalText(view?.keyspace, 'Manager restore view keyspace', 255), view: optionalText(view?.view || view?.name, 'Manager restore view name', 255) })) : []
  };
  if (!target.locations.length || !target.units.length) throw new DatabaseAdapterError('SCYLLA_MANAGER_RESTORE_TARGET_INVALID', 'Manager restore target is empty.', { category: 'integrity' });
  target.targetFingerprint = stableDigest(target);
  return target;
}

function normalizeSchedule(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Manager task schedule must be an object.');
  const schedule = {
    cron: optionalText(input.cron, 'Manager schedule cron', 200), timezone: optionalText(input.timezone, 'Manager schedule timezone', 100),
    window: uniqueTextList(input.window, 'Manager schedule windows', 100), start_date: optionalText(input.startDate || input.start_date, 'Manager schedule start date', 100),
    num_retries: nonNegativeInteger(input.numRetries ?? input.num_retries, 'Manager schedule retry count'), retry_wait: optionalText(input.retryWait || input.retry_wait, 'Manager schedule retry wait', 100)
  };
  return Object.fromEntries(Object.entries(schedule).filter(([, value]) => value !== null && (!(Array.isArray(value)) || value.length)));
}

function normalizeBackupExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ScyllaDB Manager backup execution must be an object.');
  const locationValues = Array.isArray(input.locations) ? input.locations.map((item) => typeof item === 'string' ? item : item?.location) : input.locations;
  const locations = uniqueTextList(locationValues, 'Manager backup locations').map(normalizeLocation);
  if (!locations.length) throw new TypeError('ScyllaDB Manager backup execution requires at least one location.');
  const method = String(input.method || 'auto').toLowerCase();
  if (!BACKUP_METHODS.has(method)) throw new TypeError('ScyllaDB Manager backup method is invalid.');
  const execution = {
    engine: 'scylla-manager', managedClusterId: requiredText(input.managedClusterId, 'Managed ScyllaDB cluster ID', 200), locations,
    locationTrusts: Array.isArray(input.locationTrusts) ? input.locationTrusts.map((item) => ({ location: normalizeLocation(item.location).location, locationFingerprint: requiredText(item.locationFingerprint, 'Manager location fingerprint', 100) })) : [],
    dataCenters: uniqueTextList(input.dataCenters, 'Manager backup data centers'), method,
    retention: nonNegativeInteger(input.retention, 'Manager backup retention'), retentionDays: nonNegativeInteger(input.retentionDays, 'Manager backup retention days'), retentionLockMode: optionalText(input.retentionLockMode, 'Manager retention lock mode', 100),
    rateLimit: uniqueTextList(input.rateLimit, 'Manager backup rate limits'), snapshotParallel: uniqueTextList(input.snapshotParallel, 'Manager snapshot parallelism'), uploadParallel: uniqueTextList(input.uploadParallel, 'Manager upload parallelism'), transfers: nonNegativeInteger(input.transfers, 'Manager backup transfers'),
    schedule: normalizeSchedule(input.schedule || {}), executionId: optionalText(input.executionId, 'Manager execution ID', 200), sourceId: optionalText(input.sourceId, 'Manager source ID', 200), workspaceId: optionalText(input.workspaceId, 'Manager workspace ID', 200)
  };
  if (execution.locationTrusts.length && (execution.locationTrusts.length !== execution.locations.length || execution.locations.some((location) => !execution.locationTrusts.some((trust) => trust.location === location.location && trust.locationFingerprint === location.locationFingerprint)))) throw new TypeError('Manager backup location trust does not match the selected locations.');
  return execution;
}

function taskProperties(execution, selector) {
  const include = selector?.databases?.include || [];
  const tableRules = selector?.tables?.include || [];
  const byKeyspace = new Map();
  if (selector?.allDatabases === true) byKeyspace.set('*', ['*']);
  for (const item of include) byKeyspace.set(requiredText(item.name, 'Manager keyspace selection', 255), ['*']);
  const explicitTables = new Map();
  for (const item of tableRules) {
    const keyspace = requiredText(item.database, 'Manager table keyspace', 255);
    const table = requiredText(item.name, 'Manager table selection', 255);
    explicitTables.set(keyspace, [...new Set([...(explicitTables.get(keyspace) || []), table])].sort());
  }
  for (const [keyspace, tables] of explicitTables) byKeyspace.set(keyspace, tables);
  const keyspace = [...byKeyspace.entries()].sort(([a], [b]) => a.localeCompare(b, 'en-US')).flatMap(([name, tables]) => tables.map((table) => `${name}.${table}`));
  if (!keyspace.length) throw new DatabaseAdapterError('SCYLLA_MANAGER_SELECTION_EMPTY', 'Manager backup selection is empty.', { category: 'configuration' });
  return {
    location: execution.locations.map((item) => item.location), keyspace, dc: execution.dataCenters, method: execution.method,
    retention: execution.retention, retention_days: execution.retentionDays, rate_limit: execution.rateLimit, snapshot_parallel: execution.snapshotParallel,
    upload_parallel: execution.uploadParallel, transfers: execution.transfers, skip_schema: false, purge_only: false,
    ...(execution.retentionLockMode ? { retention_lock_mode: execution.retentionLockMode } : {})
  };
}

function taskPath(clusterId, type, taskId, suffix = '') {
  const cluster = encodeURIComponent(requiredText(clusterId, 'Manager cluster ID', 200));
  const taskType = requiredText(type, 'Manager task type', 50).toLowerCase();
  if (!TASK_TYPES.has(taskType)) throw new TypeError('Manager task type is unsupported.');
  return `/cluster/${cluster}/task/${taskType}/${encodeURIComponent(requiredText(taskId, 'Manager task ID', 200))}${suffix}`;
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('SCYLLA_MANAGER_TASK_INVALID', 'Manager returned invalid task metadata.', { category: 'integrity' });
  const type = requiredText(raw.type, 'Manager task type', 50).toLowerCase();
  if (!TASK_TYPES.has(type)) throw new DatabaseAdapterError('SCYLLA_MANAGER_TASK_INVALID', 'Manager returned an unsupported task type.', { category: 'integrity' });
  return { clusterId: requiredText(raw.cluster_id, 'Manager task cluster ID', 200), type, id: requiredText(raw.id, 'Manager task ID', 200), name: requiredText(raw.name, 'Manager task name', 255), labels: cleanLabels(raw.labels), enabled: raw.enabled === true, schedule: raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {}, status: optionalText(raw.status, 'Manager task status', 100), suspended: raw.suspended === true };
}

function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('SCYLLA_MANAGER_RUN_INVALID', 'Manager returned invalid task-run metadata.', { category: 'integrity' });
  return { clusterId: requiredText(raw.cluster_id, 'Manager run cluster ID', 200), type: requiredText(raw.type, 'Manager run type', 50).toLowerCase(), taskId: requiredText(raw.task_id, 'Manager run task ID', 200), id: requiredText(raw.id, 'Manager run ID', 200), status: requiredText(raw.status, 'Manager run status', 100).toLowerCase(), cause: optionalText(raw.cause, 'Manager run cause', 500), startTime: optionalText(raw.start_time, 'Manager run start time', 100), endTime: optionalText(raw.end_time, 'Manager run end time', 100) };
}

function normalizeProgress(raw, type) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('SCYLLA_MANAGER_PROGRESS_INVALID', 'Manager returned invalid progress metadata.', { category: 'integrity' });
  const run = normalizeRun(raw.run);
  const progress = raw.progress;
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) throw new DatabaseAdapterError('SCYLLA_MANAGER_PROGRESS_INVALID', 'Manager returned invalid progress metadata.', { category: 'integrity' });
  const normalized = { snapshotTag: requiredText(progress.snapshot_tag, 'Manager snapshot tag', 255), stage: requiredText(progress.stage, 'Manager progress stage', 100), size: nonNegativeInteger(progress.size, 'Manager progress size'), failed: nonNegativeInteger(progress.failed, 'Manager failed bytes'), startedAt: optionalText(progress.started_at, 'Manager progress start', 100), completedAt: optionalText(progress.completed_at, 'Manager progress completion', 100) };
  if (type === 'backup') Object.assign(normalized, { uploaded: nonNegativeInteger(progress.uploaded, 'Manager uploaded bytes'), skipped: nonNegativeInteger(progress.skipped, 'Manager skipped bytes'), dataCenters: uniqueTextList(progress.dcs, 'Manager progress data centers'), hostCount: Array.isArray(progress.hosts) ? progress.hosts.length : 0, retentionDays: nonNegativeInteger(progress.retention_days, 'Manager progress retention days'), retentionLockMode: optionalText(progress.retention_lock_mode, 'Manager progress retention lock mode', 100) });
  else Object.assign(normalized, { restored: nonNegativeInteger(progress.restored, 'Manager restored bytes'), keyspaceCount: Array.isArray(progress.keyspaces) ? progress.keyspaces.length : 0, hostCount: Array.isArray(progress.hosts) ? progress.hosts.length : 0, viewCount: Array.isArray(progress.views) ? progress.views.length : 0 });
  return { run, progress: normalized };
}

function safeAdapterError(error) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error?.name === 'AbortError') return new DatabaseAdapterError('SCYLLA_MANAGER_OPERATION_CANCELED', 'Manager request was canceled.', { category: 'canceled' });
  if (/certificate|tls|ssl|hostname/i.test(String(error?.code || error?.message || ''))) return new DatabaseAdapterError('SCYLLA_MANAGER_TLS_FAILED', 'Manager TLS certificate identity verification failed.', { category: 'connectivity' });
  return new DatabaseAdapterError('SCYLLA_MANAGER_CONNECT_FAILED', 'DeployerX could not complete the authenticated Manager request.', { category: 'connectivity', retryable: true });
}

class ScyllaManagerAdapter {
  constructor({ transport = defaultTransport, clock = () => new Date().toISOString(), now = () => Date.now(), delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), maximumTaskWaitMs = MAX_TASK_WAIT_MS } = {}) {
    if (typeof transport !== 'function') throw new TypeError('ScyllaDB Manager transport is required.');
    this.transport = transport;
    this.clock = clock;
    this.now = now;
    this.delay = delay;
    this.maximumTaskWaitMs = Math.min(MAX_TASK_WAIT_MS, Math.max(1000, Number(maximumTaskWaitMs) || MAX_TASK_WAIT_MS));
  }

  manifest() {
    return {
      apiVersion: 1, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, displayName: 'ScyllaDB Manager', engine: 'scylla-manager', executionReady: true, sourceEnrollmentReady: true,
      serverVersionRange: 'ScyllaDB Manager 3.x', restoreVersionRange: 'Manager dry-run and ScyllaDB native compatibility gates apply',
      capabilities: {
        backupMethods: ['physical'], backupModes: ['native'], selection: { database: true, schema: false, table: true, globalObjects: false },
        consistencyStrategies: [{ id: 'scylla-manager-backup', produces: 'crash', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: true }],
        transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null }, streaming: { backup: false, restore: false, compression: false, encryption: false },
        restore: { alternateTarget: true, offlineBundle: false, originalTarget: false, nativeValidation: true }, replicaAware: true
      }, requiredTools: [], requiredPrivileges: [
        { id: 'scylla-manager-inventory', operations: ['discovery'], required: true, safeDescription: 'Read Manager version, exact managed-cluster identity, agent health, task inventory, and storage targets.' },
        { id: 'scylla-manager-backup', operations: ['backup'], required: true, safeDescription: 'Dry-run, create, start, monitor, stop, and reconcile exact DeployerX-owned backup tasks.' },
        { id: 'scylla-manager-restore', operations: ['restore'], required: false, safeDescription: 'Dry-run and execute schema/table phases on a separately approved managed cluster.' }
      ]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }
  validateConfig(input) { try { normalizeConfig(input); return []; } catch (error) { return [{ path: '', code: 'SCYLLA_MANAGER_CONFIG_INVALID', severity: 'error', message: error.message }]; } }

  async #request(context, config, apiPath, options = {}) {
    let authorization = null;
    if (config.authMode !== 'none') {
      if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('SCYLLA_MANAGER_SECRET_RESOLVER_MISSING', 'Manager credentials are unavailable.', { category: 'authentication' });
      authorization = authorizationHeader(config, await context.resolveSecret(config.credentialSecretRefId));
    }
    try { return await this.transport({ config, apiPath, method: options.method || 'GET', query: options.query || {}, body: options.body, authorization, signal: context.signal }); }
    catch (error) { throw safeAdapterError(error); }
  }

  async readEnvironment(context = {}, input = {}) {
    const config = normalizeConfig(input);
    const clusterPath = `/cluster/${encodeURIComponent(config.managedClusterId)}`;
    const [versionResponse, clustersResponse, clusterResponse, statusResponse] = await Promise.all([
      this.#request(context, config, '/version'), this.#request(context, config, '/clusters'), this.#request(context, config, clusterPath), this.#request(context, config, `${clusterPath}/status`)
    ]);
    const version = parseManagerVersion(versionResponse.body);
    const clusters = normalizeClusters(clustersResponse.body);
    const cluster = normalizeCluster(clusterResponse.body);
    if (cluster.id !== config.managedClusterId || !clusters.some((item) => item.id === cluster.id && item.clusterFingerprint === cluster.clusterFingerprint)) throw new DatabaseAdapterError('SCYLLA_MANAGER_CLUSTER_IDENTITY_CHANGED', 'The selected managed cluster identity is inconsistent.', { category: 'integrity' });
    const status = normalizeStatus(statusResponse.body, cluster.id);
    const fingerprint = deploymentFingerprint(version, cluster);
    if (config.expectedManagerVersion && config.expectedManagerVersion !== version.text) throw new DatabaseAdapterError('SCYLLA_MANAGER_VERSION_CHANGED', 'Manager version changed after connection approval.', { category: 'integrity' });
    if (config.expectedDeploymentFingerprint && config.expectedDeploymentFingerprint !== fingerprint) throw new DatabaseAdapterError('SCYLLA_MANAGER_DEPLOYMENT_CHANGED', 'Manager or managed-cluster identity changed after connection approval.', { category: 'integrity' });
    return { config, version, clusters, cluster, status, deploymentFingerprint: fingerprint };
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const environment = await this.readEnvironment(context, input);
      return normalizeConnectionTestResult({
        adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'success',
        checks: [
          { id: 'authentication', status: 'pass', safeMessage: 'Authenticated Manager inventory requests succeeded.' },
          { id: 'tls', status: 'pass', safeMessage: 'TLS certificate identity verification is required.' },
          { id: 'manager-version', status: 'pass', safeMessage: `ScyllaDB Manager ${environment.version.text} is supported.` },
          { id: 'managed-cluster', status: 'pass', safeMessage: 'The exact managed ScyllaDB cluster identity was verified.' },
          { id: 'agent-cql-rest-health', status: environment.status.healthy ? 'pass' : 'warning', safeMessage: environment.status.healthy ? 'Every Manager agent, CQL endpoint, and REST endpoint is up.' : 'One or more Manager agent, CQL, or REST checks are not up.' }
        ],
        remotePlatform: { engine: 'scylla-manager', version: environment.version.text, distribution: 'ScyllaDB Manager', platform: null },
        endpointIdentity: { managerVersion: environment.version.text, managedClusterId: environment.cluster.id, managedClusterName: environment.cluster.name, clusterFingerprint: environment.cluster.clusterFingerprint, deploymentFingerprint: environment.deploymentFingerprint, topologyFingerprint: environment.status.topologyFingerprint, clusterCount: environment.clusters.length, nodeCount: environment.status.nodes.length, dataCenters: environment.status.dataCenters, healthy: environment.status.healthy }, error: null
      }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    } catch (error) {
      const safe = safeAdapterError(error);
      return normalizeConnectionTestResult({ adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'failure', checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null } }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    }
  }

  async *discover(context = {}, request = {}) {
    const kind = String(request.kind || 'all').toLowerCase();
    const environment = await this.readEnvironment(context, request.connection);
    const common = { nextCursor: null, managerVersion: environment.version.text, managedClusterId: environment.cluster.id, deploymentFingerprint: environment.deploymentFingerprint, topologyFingerprint: environment.status.topologyFingerprint };
    if (kind === 'clusters') yield { ...common, items: environment.clusters };
    else if (kind === 'nodes') yield { ...common, items: environment.status.nodes };
    else if (kind === 'all') yield { ...common, items: [], cluster: environment.cluster, clusters: environment.clusters, nodes: environment.status.nodes, dataCenters: environment.status.dataCenters, healthy: environment.status.healthy };
    else throw new DatabaseAdapterError('SCYLLA_MANAGER_DISCOVERY_KIND_UNSUPPORTED', 'Manager discovery kind is unsupported.', { category: 'compatibility' });
  }

  async backupTarget(context = {}, input = {}) {
    const config = normalizeConfig(input.connection);
    const taskUpdate = input.taskUpdate;
    const response = await this.#request(context, config, `/cluster/${encodeURIComponent(config.managedClusterId)}/tasks/backup/target`, { method: 'GET', body: taskUpdate });
    const target = normalizeBackupTarget(response.body);
    if (target.clusterId !== config.managedClusterId) throw new DatabaseAdapterError('SCYLLA_MANAGER_TARGET_CLUSTER_CHANGED', 'Manager resolved the backup target for a different cluster.', { category: 'integrity' });
    return target;
  }

  async restoreTarget(context = {}, input = {}) {
    const config = normalizeConfig(input.connection);
    const response = await this.#request(context, config, `/cluster/${encodeURIComponent(config.managedClusterId)}/tasks/restore/target`, { method: 'GET', body: input.taskUpdate });
    const target = normalizeRestoreTarget(response.body);
    if (target.clusterId !== config.managedClusterId) throw new DatabaseAdapterError('SCYLLA_MANAGER_TARGET_CLUSTER_CHANGED', 'Manager resolved the restore target for a different cluster.', { category: 'integrity' });
    return target;
  }

  async verifyBackupTarget(context = {}, input = {}) {
    if (input.taskUpdate?.type !== 'backup' || input.taskUpdate?.properties?.purge_only === true || input.taskUpdate?.properties?.skip_schema === true) throw new DatabaseAdapterError('SCYLLA_MANAGER_TARGET_REQUEST_UNSAFE', 'Manager target verification requires a non-purge backup with schema capture.', { category: 'validation' });
    const environment = await this.readEnvironment(context, input.connection);
    if (!environment.status.healthy) throw new DatabaseAdapterError('SCYLLA_MANAGER_CLUSTER_UNHEALTHY', 'Every selected Manager agent, CQL endpoint, and REST endpoint must be up.', { category: 'unavailable', retryable: true });
    const target = await this.backupTarget(context, input);
    if (target.purgeOnly || target.skipSchema) throw new DatabaseAdapterError('SCYLLA_MANAGER_TARGET_REQUEST_UNSAFE', 'Manager resolved an unsafe purge-only or schema-skipping backup target.', { category: 'integrity' });
    return { version: 1, managedClusterId: environment.cluster.id, managerVersion: environment.version.text, deploymentFingerprint: environment.deploymentFingerprint, topologyFingerprint: environment.status.topologyFingerprint, target, verifiedAt: this.clock() };
  }

  #backupRequest(request = {}) {
    const config = normalizeConfig(request.connection);
    const execution = normalizeBackupExecution(request.execution);
    if (execution.managedClusterId !== config.managedClusterId) throw new DatabaseAdapterError('SCYLLA_MANAGER_EXECUTION_CLUSTER_MISMATCH', 'Manager execution targets a different managed cluster.', { category: 'integrity' });
    const taskUpdate = { name: 'deployerx-target-validation', type: 'backup', labels: { 'deployerx.owner': 'deployerx', 'deployerx.purpose': 'target-validation' }, enabled: false, schedule: execution.schedule, properties: taskProperties(execution, request.selector || {}) };
    return { config, execution, taskUpdate };
  }

  async preflight(context = {}, request = {}) {
    const validated = this.#backupRequest(request);
    const verification = await this.verifyBackupTarget(context, { connection: validated.config, taskUpdate: validated.taskUpdate });
    const trusted = new Map(validated.execution.locationTrusts.map((item) => [item.location, item.locationFingerprint]));
    if (trusted.size && verification.target.locations.some((item) => trusted.get(item.location) !== item.locationFingerprint)) throw new DatabaseAdapterError('SCYLLA_MANAGER_LOCATION_IDENTITY_CHANGED', 'A Manager backup location no longer matches its approved identity.', { category: 'integrity' });
    return {
      checkedAt: this.clock(), serverVersion: verification.managerVersion, serverVersionSupported: true,
      serverIdentityFingerprint: verification.deploymentFingerprint,
      consistency: [{ method: 'scylla-manager-backup', verified: true, produces: 'crash' }], tools: [],
      privileges: [{ id: 'scylla-manager-backup', allowed: true, evidence: 'Manager backup target dry-run succeeded.' }],
      coordinateCaptureVerified: true, warnings: [], metadata: { verification }
    };
  }

  async planBackup(_context = {}, request = {}) {
    const validated = this.#backupRequest(request);
    if (request.consistency?.proven !== true || request.consistency?.method !== 'scylla-manager-backup' || request.consistency?.achievedLevel !== 'crash') throw new DatabaseAdapterError('SCYLLA_MANAGER_CONSISTENCY_PLAN_INVALID', 'Manager backup requires a proven target dry-run and healthy cluster.', { category: 'consistency' });
    const suffix = crypto.createHash('sha256').update(validated.execution.executionId || JSON.stringify(validated.taskUpdate.properties)).digest('hex').slice(0, 20);
    const name = `deployerx-backup-${suffix}`;
    const taskUpdate = { ...validated.taskUpdate, name, labels: { 'deployerx.owner': 'deployerx', 'deployerx.operation': 'backup', 'deployerx.execution': suffix, ...(validated.execution.sourceId ? { 'deployerx.source': validated.execution.sourceId } : {}) } };
    return { version: 1, operation: 'scylla-manager-backup', connection: validated.config, execution: validated.execution, taskUpdate, target: request.consistency.evidence?.metadata?.verification?.target || null, artifact: { kind: 'metadata', path: 'scylla-manager/backup-metadata.json', mediaType: 'application/vnd.deployerx.scylla-manager-backup+json' }, externalNativeMedia: true, authoritativeOwner: 'scylla-manager', resumable: false };
  }

  async getTask(context, input) {
    const config = normalizeConfig(input.connection);
    const response = await this.#request(context, config, taskPath(config.managedClusterId, input.type, input.taskId));
    const task = normalizeTask(response.body);
    if (task.clusterId !== config.managedClusterId) throw new DatabaseAdapterError('SCYLLA_MANAGER_TASK_IDENTITY_CHANGED', 'Manager task belongs to a different cluster.', { category: 'integrity' });
    return task;
  }

  #assertOwnedTask(task, owner = {}) {
    if (task.labels['deployerx.owner'] !== 'deployerx' || (owner.execution && task.labels['deployerx.execution'] !== owner.execution) || (owner.sourceId && task.labels['deployerx.source'] !== owner.sourceId)) throw new DatabaseAdapterError('SCYLLA_MANAGER_TASK_NOT_OWNED', 'Manager task ownership could not be proven.', { category: 'authorization' });
  }

  async createOwnedTask(context, input = {}) {
    const config = normalizeConfig(input.connection);
    const type = requiredText(input.type, 'Manager task type', 50).toLowerCase();
    if (!TASK_TYPES.has(type) || input.taskUpdate?.type !== type || input.taskUpdate?.labels?.['deployerx.owner'] !== 'deployerx' || input.taskUpdate?.enabled !== false) throw new DatabaseAdapterError('SCYLLA_MANAGER_TASK_CREATE_INVALID', 'Manager task creation requires an exact disabled DeployerX-owned task.', { category: 'authorization' });
    const response = await this.#request(context, config, `/cluster/${encodeURIComponent(config.managedClusterId)}/tasks`, { method: 'POST', body: input.taskUpdate });
    const location = requiredText(response.headers?.location, 'Manager task Location header', 2048);
    const match = /\/task\/([^/]+)\/([^/?#]+)$/.exec(location);
    if (!match || decodeURIComponent(match[1]) !== type) throw new DatabaseAdapterError('SCYLLA_MANAGER_TASK_LOCATION_INVALID', 'Manager returned an invalid task location.', { category: 'integrity' });
    const task = await this.getTask(context, { connection: config, type, taskId: decodeURIComponent(match[2]) });
    this.#assertOwnedTask(task, input.owner);
    return task;
  }

  async listTasks(context, input = {}) {
    const config = normalizeConfig(input.connection);
    const type = input.type ? requiredText(input.type, 'Manager task type', 50).toLowerCase() : undefined;
    if (type && !TASK_TYPES.has(type)) throw new TypeError('Manager task type is unsupported.');
    const response = await this.#request(context, config, `/cluster/${encodeURIComponent(config.managedClusterId)}/tasks`, { query: { all: true, type, short: false } });
    if (!Array.isArray(response.body) || response.body.length > MAX_ITEMS) throw new DatabaseAdapterError('SCYLLA_MANAGER_TASKS_INVALID', 'Manager returned an invalid or oversized task list.', { category: 'integrity' });
    return response.body.map(normalizeTask).filter((task) => task.clusterId === config.managedClusterId);
  }

  async startTask(context, input = {}) {
    const config = normalizeConfig(input.connection);
    const task = await this.getTask(context, { connection: config, type: input.type, taskId: input.taskId });
    this.#assertOwnedTask(task, input.owner);
    await this.#request(context, config, taskPath(config.managedClusterId, task.type, task.id, '/start'), { method: 'PUT', query: { continue: input.continue === true } });
    return { taskId: task.id, type: task.type, started: true };
  }

  async stopTask(context, input = {}) {
    const config = normalizeConfig(input.connection);
    const task = await this.getTask({ ...context, signal: undefined }, { connection: config, type: input.type, taskId: input.taskId });
    this.#assertOwnedTask(task, input.owner);
    await this.#request({ ...context, signal: undefined }, config, taskPath(config.managedClusterId, task.type, task.id, '/stop'), { method: 'PUT', query: { disable: input.disable === true } });
    return { taskId: task.id, type: task.type, stopped: true, disabled: input.disable === true };
  }

  async pauseTask(context, input = {}) { return this.stopTask(context, { ...input, disable: false }); }
  async resumeTask(context, input = {}) { return this.startTask(context, { ...input, continue: true }); }

  async taskHistory(context, input = {}) {
    const config = normalizeConfig(input.connection);
    const task = await this.getTask(context, { connection: config, type: input.type, taskId: input.taskId });
    this.#assertOwnedTask(task, input.owner);
    const limit = Math.min(1000, Math.max(1, Number(input.limit) || 20));
    const response = await this.#request(context, config, taskPath(config.managedClusterId, task.type, task.id, '/history'), { query: { limit } });
    if (!Array.isArray(response.body) || response.body.length > limit) throw new DatabaseAdapterError('SCYLLA_MANAGER_HISTORY_INVALID', 'Manager returned invalid or oversized task history.', { category: 'integrity' });
    return response.body.map(normalizeRun).filter((run) => run.clusterId === config.managedClusterId && run.taskId === task.id && run.type === task.type);
  }

  async taskProgress(context, input = {}) {
    const config = normalizeConfig(input.connection);
    const task = await this.getTask(context, { connection: config, type: input.type, taskId: input.taskId });
    this.#assertOwnedTask(task, input.owner);
    const runId = requiredText(input.runId, 'Manager run ID', 200);
    const response = await this.#request(context, config, `${taskPath(config.managedClusterId, task.type, task.id)}/${encodeURIComponent(runId)}`);
    const result = normalizeProgress(response.body, task.type);
    if (result.run.id !== runId || result.run.taskId !== task.id || result.run.clusterId !== config.managedClusterId) throw new DatabaseAdapterError('SCYLLA_MANAGER_RUN_IDENTITY_CHANGED', 'Manager progress belongs to a different task or run.', { category: 'integrity' });
    return result;
  }

  async listBackups(context, input = {}) {
    const config = normalizeConfig(input.connection);
    const response = await this.#request(context, config, `/cluster/${encodeURIComponent(config.managedClusterId)}/backups`, { query: { locations: input.locations, query_cluster_id: input.sourceClusterId, keyspace: input.keyspaces || ['*'], min_date: input.minDate, max_date: input.maxDate } });
    if (!Array.isArray(response.body) || response.body.length > MAX_ITEMS) throw new DatabaseAdapterError('SCYLLA_MANAGER_BACKUPS_INVALID', 'Manager returned an invalid or oversized backup catalog.', { category: 'integrity' });
    return response.body.map((raw) => ({ clusterId: requiredText(raw.cluster_id, 'Manager catalog cluster ID', 200), taskId: requiredText(raw.task_id, 'Manager catalog task ID', 200), units: normalizeUnits(raw.units), snapshots: (Array.isArray(raw.snapshot_info) ? raw.snapshot_info : []).slice(0, MAX_ITEMS).map((snapshot) => ({ snapshotTag: requiredText(snapshot.snapshot_tag, 'Manager catalog snapshot tag', 255), nodes: nonNegativeInteger(snapshot.nodes, 'Manager catalog node count'), size: nonNegativeInteger(snapshot.size, 'Manager catalog size') })) }));
  }

  async reconcileTask(context = {}, input = {}) {
    const config = normalizeConfig(input.connection);
    const owner = input.owner || {};
    if (owner.adapterId !== ADAPTER_ID || owner.managedClusterId !== config.managedClusterId || owner.type !== 'backup' || !owner.taskId) throw new DatabaseAdapterError('SCYLLA_MANAGER_RECONCILIATION_OWNER_INVALID', 'Manager task ownership metadata is invalid.', { category: 'integrity' });
    const task = await this.getTask({ ...context, signal: undefined }, { connection: config, type: 'backup', taskId: owner.taskId });
    this.#assertOwnedTask(task, owner);
    const history = await this.taskHistory({ ...context, signal: undefined }, { connection: config, type: 'backup', taskId: task.id, owner, limit: 20 });
    const run = owner.runId ? history.find((item) => item.id === owner.runId) : history[0];
    if (!run) return { proven: true, taskId: task.id, runId: null, state: 'not-started', stopped: false };
    if (!SUCCESS_RUN_STATES.has(run.status) && !FAILED_RUN_STATES.has(run.status)) {
      await this.stopTask({ ...context, signal: undefined }, { connection: config, type: 'backup', taskId: task.id, owner, disable: false });
      return { proven: true, taskId: task.id, runId: run.id, state: 'stopped', stopped: true };
    }
    return { proven: true, taskId: task.id, runId: run.id, state: run.status, stopped: false };
  }

  async executeBackup(context = {}, plan = {}) {
    if (plan.operation !== 'scylla-manager-backup' || plan.authoritativeOwner !== 'scylla-manager') throw new DatabaseAdapterError('SCYLLA_MANAGER_PLAN_INVALID', 'Manager backup plan is invalid.', { category: 'integrity' });
    const environment = await this.readEnvironment(context, plan.connection);
    if (!environment.status.healthy) throw new DatabaseAdapterError('SCYLLA_MANAGER_CLUSTER_UNHEALTHY', 'Every Manager agent, CQL endpoint, and REST endpoint must be up before backup.', { category: 'unavailable', retryable: true });
    const dryRun = await this.backupTarget(context, { connection: plan.connection, taskUpdate: plan.taskUpdate });
    if (plan.target?.targetFingerprint && dryRun.targetFingerprint !== plan.target.targetFingerprint) throw new DatabaseAdapterError('SCYLLA_MANAGER_TARGET_CHANGED', 'Manager backup target changed after planning.', { category: 'conflict' });
    const owner = { version: 1, adapterId: ADAPTER_ID, managedClusterId: plan.connection.managedClusterId, type: 'backup', execution: plan.taskUpdate.labels['deployerx.execution'], sourceId: plan.execution.sourceId, taskId: null, runId: null };
    const task = await this.createOwnedTask(context, { connection: plan.connection, type: 'backup', taskUpdate: plan.taskUpdate, owner });
    owner.taskId = task.id;
    if (typeof context.onOwnership === 'function') await context.onOwnership({ ...owner });
    await this.startTask(context, { connection: plan.connection, type: 'backup', taskId: task.id, owner, continue: false });
    const deadline = this.now() + this.maximumTaskWaitMs;
    let run = null;
    try {
      while (this.now() <= deadline) {
        if (context.signal?.aborted) throw new DatabaseAdapterError('SCYLLA_MANAGER_OPERATION_CANCELED', 'Manager backup monitoring was canceled.', { category: 'canceled' });
        const history = await this.taskHistory(context, { connection: plan.connection, type: 'backup', taskId: task.id, owner, limit: 20 });
        run = history.find((item) => item.taskId === task.id) || null;
        if (!run) { await this.delay(500); continue; }
        owner.runId = run.id;
        if (typeof context.onOwnership === 'function') await context.onOwnership({ ...owner });
        const current = await this.taskProgress(context, { connection: plan.connection, type: 'backup', taskId: task.id, runId: run.id, owner });
        if (SUCCESS_RUN_STATES.has(current.run.status)) {
          if (current.progress.failed || current.progress.uploaded + current.progress.skipped < current.progress.size) throw new DatabaseAdapterError('SCYLLA_MANAGER_BACKUP_INCOMPLETE', 'Manager completed without proving all backup bytes.', { category: 'integrity' });
          const catalog = await this.listBackups(context, { connection: plan.connection, locations: dryRun.locations.map((item) => item.location), sourceClusterId: plan.connection.managedClusterId, keyspaces: dryRun.units.map((unit) => unit.keyspace) });
          const catalogItem = catalog.find((item) => item.taskId === task.id && item.snapshots.some((snapshot) => snapshot.snapshotTag === current.progress.snapshotTag));
          if (!catalogItem) throw new DatabaseAdapterError('SCYLLA_MANAGER_CATALOG_EVIDENCE_MISSING', 'Manager catalog does not prove the completed task and snapshot tag.', { category: 'integrity' });
          return {
            version: 1, kind: 'scylla-manager-backup', adapterId: ADAPTER_ID, state: 'succeeded', externalNativeMedia: true, authoritativeOwner: 'scylla-manager',
            sourceId: plan.execution.sourceId, workspaceDigest: plan.execution.workspaceId ? stableDigest(plan.execution.workspaceId) : null,
            managerVersion: environment.version.text, managedClusterId: environment.cluster.id, deploymentFingerprint: environment.deploymentFingerprint,
            clusterFingerprint: environment.cluster.clusterFingerprint, topologyFingerprint: environment.status.topologyFingerprint,
            scyllaVersions: [...new Set(environment.status.nodes.map((node) => node.scyllaVersion))].sort(), agentVersions: [...new Set(environment.status.nodes.map((node) => node.agentVersion))].sort(),
            taskId: task.id, runId: run.id, snapshotTag: current.progress.snapshotTag, target: dryRun, progress: current.progress, catalog: catalogItem,
            completedAt: this.clock(), cancellationRollbackSupported: false
          };
        }
        if (FAILED_RUN_STATES.has(current.run.status)) throw new DatabaseAdapterError('SCYLLA_MANAGER_BACKUP_FAILED', 'Manager backup task failed.', { category: 'execution', details: { status: current.run.status } });
        await this.delay(500);
      }
      throw new DatabaseAdapterError('SCYLLA_MANAGER_BACKUP_TIMEOUT', 'Manager backup did not finish before the monitoring deadline.', { category: 'timeout', retryable: true });
    } catch (error) {
      if (error.code === 'SCYLLA_MANAGER_OPERATION_CANCELED') await this.stopTask({ ...context, signal: undefined }, { connection: plan.connection, type: 'backup', taskId: task.id, owner, disable: false }).catch(() => {});
      throw error;
    }
  }

  async planRestore(context = {}, request = {}) {
    if (typeof context.planScyllaManagerRestore !== 'function') throw new DatabaseAdapterError('SCYLLA_MANAGER_RESTORE_ORCHESTRATOR_REQUIRED', 'Manager alternate-cluster restore requires the authenticated recovery orchestrator.', { category: 'compatibility' });
    return context.planScyllaManagerRestore(request);
  }
  async executeRestore(context = {}, plan = {}) {
    if (typeof context.executeScyllaManagerRestore !== 'function') throw new DatabaseAdapterError('SCYLLA_MANAGER_RESTORE_ORCHESTRATOR_REQUIRED', 'Manager alternate-cluster restore requires the authenticated recovery orchestrator.', { category: 'compatibility' });
    return context.executeScyllaManagerRestore(plan);
  }
  async validateRestore(context = {}, result = {}) {
    if (typeof context.validateScyllaManagerRestore !== 'function') throw new DatabaseAdapterError('SCYLLA_MANAGER_RESTORE_ORCHESTRATOR_REQUIRED', 'Manager alternate-cluster restore requires the authenticated recovery orchestrator.', { category: 'compatibility' });
    return context.validateScyllaManagerRestore(result);
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class ScyllaManagerConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new ScyllaManagerAdapter() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { includeDeleted: false, limit: 1000 })).filter((record) => record.adapterId === ADAPTER_ID).map((record) => ({ ...record, capabilities: this.adapter.manifest().capabilities, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'ScyllaDB Manager connection name', 200);
    const authMode = String(input.authMode || 'none').toLowerCase();
    const credential = input.credential === undefined || input.credential === null ? null : String(input.credential);
    if (authMode !== 'none' && (!credential || credential.includes('\0') || /[\r\n]/.test(credential) || credential.length > 16384)) throw new TypeError('ScyllaDB Manager credential is invalid.');
    if (authMode === 'none' && credential) throw new TypeError('A Manager credential is not valid when authentication is disabled.');
    let credentialRef = null;
    try {
      if (authMode !== 'none') credentialRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} Manager credential`, secretType: authMode === 'basic' ? 'password' : 'token', value: credential, scope: 'device' });
      const config = normalizeConfig({ host: input.host, port: input.port, basePath: input.basePath, authMode, username: input.username, credentialSecretRefId: credentialRef?.id, tlsMode: input.tlsMode, caFile: input.caFile, clientCertificateFile: input.clientCertificateFile, clientKeyFile: input.clientKeyFile, timeoutMs: input.timeoutMs, managedClusterId: input.managedClusterId });
      const { credentialSecretRefId: _credentialRef, ...endpoint } = config;
      return await this.controlDatabase.transaction((transaction) => {
        if (credentialRef) transaction.create('secretRef', secretMetadataInput(credentialRef, actor));
        return transaction.create('connection', { workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device', endpoint, secretRefIds: credentialRef ? [credentialRef.id] : [], trust: { mode: config.tlsMode, fingerprint: null }, workerAffinity: [`device:${this.deviceId}`], lastTest: null });
      });
    } catch (error) {
      if (credentialRef) await this.secretStore.delete({ workspaceId: tenant, id: credentialRef.id }).catch(() => {});
      throw error;
    }
  }

  config(connection) { return normalizeConfig({ ...connection.endpoint, credentialSecretRefId: connection.secretRefIds?.[0] || null }); }

  async #connection(workspaceId, connectionId, requireTest = false) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('ScyllaDB Manager connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This ScyllaDB Manager connection belongs to another device.');
    if (requireTest && (current.lastTest?.status !== 'success' || !current.trust?.fingerprint)) throw new Error('Test the ScyllaDB Manager connection successfully before this operation.');
    return { tenant, current };
  }

  context(workspaceId, signal) { return { resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal }; }

  async test(workspaceId, connectionId, actorId = 'system', signal) {
    const { tenant, current } = await this.#connection(workspaceId, connectionId);
    const result = await this.adapter.testConnection(this.context(tenant, signal), this.config(current));
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const endpoint = result.status === 'success' ? { ...current.endpoint, expectedManagerVersion: result.endpointIdentity.managerVersion, expectedDeploymentFingerprint: result.endpointIdentity.deploymentFingerprint } : current.endpoint;
    const trust = result.status === 'success' ? { mode: current.endpoint.tlsMode, fingerprint: result.endpointIdentity.deploymentFingerprint, topologyFingerprint: result.endpointIdentity.topologyFingerprint, observedAt: result.testedAt } : current.trust;
    const clusterInventory = result.status === 'success' ? { version: 1, managedClusterId: result.endpointIdentity.managedClusterId, managedClusterName: result.endpointIdentity.managedClusterName, clusterFingerprint: result.endpointIdentity.clusterFingerprint, topologyFingerprint: result.endpointIdentity.topologyFingerprint, nodeCount: result.endpointIdentity.nodeCount, dataCenters: result.endpointIdentity.dataCenters, healthy: result.endpointIdentity.healthy, observedAt: result.testedAt } : current.clusterInventory || null;
    const connection = await this.controlDatabase.repository('connection').update(tenant, current.id, { endpoint, trust, clusterInventory, lastTest: result, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const { tenant, current } = await this.#connection(workspaceId, connectionId, true);
    const pages = [];
    for await (const page of this.adapter.discover(this.context(tenant, input.signal), { connection: this.config(current), kind: input.kind })) pages.push(page);
    return pages[0] || { items: [], nextCursor: null };
  }

  async verifyTarget(workspaceId, connectionId, input = {}, actorId = 'system') {
    const { tenant, current } = await this.#connection(workspaceId, connectionId, true);
    const verification = await this.adapter.verifyBackupTarget(this.context(tenant, input.signal), { connection: this.config(current), taskUpdate: input.taskUpdate });
    if (verification.deploymentFingerprint !== current.trust.fingerprint) throw new DatabaseAdapterError('SCYLLA_MANAGER_DEPLOYMENT_CHANGED', 'Manager identity changed during target verification.', { category: 'integrity' });
    const targetTrust = {
      managedClusterId: verification.managedClusterId, targetFingerprint: verification.target.targetFingerprint,
      locations: verification.target.locations, units: verification.target.units, dataCenters: verification.target.dataCenters,
      method: verification.target.method, retention: verification.target.retention, retentionDays: verification.target.retentionDays,
      retentionLockMode: verification.target.retentionLockMode, rateLimit: verification.target.rateLimit,
      snapshotParallel: verification.target.snapshotParallel, uploadParallel: verification.target.uploadParallel,
      transfers: verification.target.transfers, purgeOnly: verification.target.purgeOnly, skipSchema: verification.target.skipSchema,
      verifiedAt: verification.verifiedAt
    };
    const connection = await this.controlDatabase.repository('connection').update(tenant, current.id, { managerTargetTrust: targetTrust }, { expectedRevision: current.revision, actorId });
    return { connection, verification };
  }

  async listTasks(workspaceId, connectionId, input = {}) { const { tenant, current } = await this.#connection(workspaceId, connectionId, true); return this.adapter.listTasks(this.context(tenant, input.signal), { connection: this.config(current), type: input.type }); }
  async listBackups(workspaceId, connectionId, input = {}) { const { tenant, current } = await this.#connection(workspaceId, connectionId, true); return this.adapter.listBackups(this.context(tenant, input.signal), { connection: this.config(current), ...input }); }
  async startTask(workspaceId, connectionId, input = {}) { const { tenant, current } = await this.#connection(workspaceId, connectionId, true); return this.adapter.startTask(this.context(tenant, input.signal), { connection: this.config(current), ...input }); }
  async stopTask(workspaceId, connectionId, input = {}) { const { tenant, current } = await this.#connection(workspaceId, connectionId, true); return this.adapter.stopTask(this.context(tenant, input.signal), { connection: this.config(current), ...input }); }
  async history(workspaceId, connectionId, input = {}) { const { tenant, current } = await this.#connection(workspaceId, connectionId, true); return this.adapter.taskHistory(this.context(tenant, input.signal), { connection: this.config(current), ...input }); }
  async progress(workspaceId, connectionId, input = {}) { const { tenant, current } = await this.#connection(workspaceId, connectionId, true); return this.adapter.taskProgress(this.context(tenant, input.signal), { connection: this.config(current), ...input }); }
}

module.exports = {
  ADAPTER_ID, ADAPTER_VERSION, ScyllaManagerAdapter, ScyllaManagerConnectionService, authorizationHeader, defaultTransport, deploymentFingerprint,
  normalizeBackupExecution, normalizeBackupTarget, normalizeCluster, normalizeClusters, normalizeConfig, normalizeProgress, normalizeRestoreTarget, normalizeStatus,
  normalizeTask, normalizeRun, parseManagerVersion, safeApiPath, stableDigest, taskProperties
};
