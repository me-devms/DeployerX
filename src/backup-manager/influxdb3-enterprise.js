const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');

const ADAPTER_ID = 'deployerx.database.influxdb3-enterprise';
const ADAPTER_VERSION = '0.1.0';
const NATIVE_CONSISTENCY_METHOD = 'influxdb3-enterprise-native-backup';
const LEGACY_CONSISTENCY_METHOD = 'influxdb3-enterprise-legacy-copy';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TLS_FILE_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_VALUES = 10000;
const MAX_JSON_TEXT = 4096;
const MAX_NODES = 1000;
const MAX_ROLES = 16;
const MAX_BACKUPS = 1000;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 2048;
const NODES_QUERY = 'SELECT node_id, node_catalog_id, instance_id, mode, state FROM system.nodes ORDER BY node_catalog_id';
const ALLOWED_ROLES = new Set(['all', 'compact', 'compactor', 'core', 'ingest', 'process', 'query']);
const STORAGE_ENGINES = new Set(['upgraded', 'legacy-parquet', 'unknown']);

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
  const input = requiredText(value, 'InfluxDB 3 Enterprise host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('InfluxDB 3 Enterprise host must be a hostname or IP address without a URI scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('InfluxDB 3 Enterprise host is invalid.');
  return ascii;
}

function normalizeBasePath(value) {
  const raw = optionalText(value, 'InfluxDB 3 Enterprise base path', 512);
  if (!raw || raw === '/') return '';
  if (!raw.startsWith('/') || raw.endsWith('/') || /[?#\\\s]/.test(raw) || raw.includes('//')) throw new TypeError('InfluxDB 3 Enterprise base path is invalid.');
  const segments = raw.slice(1).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) throw new TypeError('InfluxDB 3 Enterprise base path is invalid.');
  return `/${segments.join('/')}`;
}

function normalizeAbsolutePath(value, label) {
  const input = requiredText(value, label, 4096);
  if (!path.isAbsolute(input)) throw new TypeError(`${label} must be absolute.`);
  return path.resolve(input);
}

function safeIdentity(value, label, maximumLength = 128) {
  const raw = typeof value === 'string' ? value : '';
  const text = raw.trim();
  if (!text || raw !== text || text.length > maximumLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid endpoint identity.', { category: 'integrity' });
  return text;
}

function optionalConfigIdentity(value, label) {
  const text = optionalText(value, label, 128);
  if (text && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalFingerprint(value, label) {
  const text = optionalText(value, label, 80);
  if (text && !/^sha256:[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
}

function endpointUrl(config) {
  const host = net.isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  const value = `${config.protocol}://${host}:${config.port}${config.basePath}`;
  if (value.length > MAX_URL_LENGTH) throw new TypeError('InfluxDB 3 Enterprise endpoint URL is too long.');
  return value;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise connection configuration must be an object.');
  const allowed = [
    'protocol', 'allowInsecureHttp', 'host', 'port', 'basePath', 'caFile', 'timeoutMs', 'adminTokenSecretRefId',
    'expectedVersion', 'expectedStorageEngine', 'expectedClusterId', 'expectedNodeId', 'expectedNodeCatalogId', 'expectedInstanceId', 'expectedRoleFingerprint',
    'expectedDeploymentFingerprint', 'expectedCapabilityFingerprint'
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError('InfluxDB 3 Enterprise connection configuration contains an unsupported field.');
  const protocol = String(input.protocol || 'https').toLowerCase();
  if (!['https', 'http'].includes(protocol)) throw new TypeError('InfluxDB 3 Enterprise protocol is invalid.');
  const allowInsecureHttp = input.allowInsecureHttp === true;
  if (protocol === 'http' && !allowInsecureHttp) throw new TypeError('InfluxDB 3 Enterprise HTTP requires explicit insecure-transport approval.');
  if (protocol === 'https' && allowInsecureHttp) throw new TypeError('InfluxDB 3 Enterprise insecure-transport approval is valid only for HTTP.');
  if (protocol === 'http' && input.caFile) throw new TypeError('InfluxDB 3 Enterprise HTTP cannot use a TLS CA file.');
  const port = Number(input.port ?? 8181);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('InfluxDB 3 Enterprise port must be between 1 and 65535.');
  const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('InfluxDB 3 Enterprise timeout must be between 1 and 300 seconds.');
  const expectedStorageEngine = optionalText(input.expectedStorageEngine, 'Expected InfluxDB 3 Enterprise storage engine', 40);
  if (expectedStorageEngine && !STORAGE_ENGINES.has(expectedStorageEngine)) throw new TypeError('Expected InfluxDB 3 Enterprise storage engine is invalid.');
  const expectedNodeCatalogId = input.expectedNodeCatalogId === undefined || input.expectedNodeCatalogId === null ? null : Number(input.expectedNodeCatalogId);
  if (expectedNodeCatalogId !== null && (!Number.isInteger(expectedNodeCatalogId) || expectedNodeCatalogId < 0 || expectedNodeCatalogId > 0xffffffff)) throw new TypeError('Expected InfluxDB 3 Enterprise node catalog ID is invalid.');
  const config = Object.freeze({
    protocol,
    allowInsecureHttp,
    host: normalizeHost(input.host),
    port,
    basePath: normalizeBasePath(input.basePath),
    caFile: input.caFile ? normalizeAbsolutePath(input.caFile, 'InfluxDB 3 Enterprise TLS CA file') : null,
    timeoutMs,
    adminTokenSecretRefId: optionalConfigIdentity(input.adminTokenSecretRefId, 'InfluxDB 3 Enterprise admin-token SecretRef ID'),
    expectedVersion: input.expectedVersion === undefined || input.expectedVersion === null || input.expectedVersion === '' ? null : parseVersion(input.expectedVersion).text,
    expectedStorageEngine,
    expectedClusterId: optionalConfigIdentity(input.expectedClusterId, 'Expected InfluxDB 3 Enterprise cluster ID'),
    expectedNodeId: optionalConfigIdentity(input.expectedNodeId, 'Expected InfluxDB 3 Enterprise node ID'),
    expectedNodeCatalogId,
    expectedInstanceId: optionalConfigIdentity(input.expectedInstanceId, 'Expected InfluxDB 3 Enterprise instance ID'),
    expectedRoleFingerprint: optionalFingerprint(input.expectedRoleFingerprint, 'Expected InfluxDB 3 Enterprise role fingerprint'),
    expectedDeploymentFingerprint: optionalFingerprint(input.expectedDeploymentFingerprint, 'Expected InfluxDB 3 Enterprise deployment fingerprint'),
    expectedCapabilityFingerprint: optionalFingerprint(input.expectedCapabilityFingerprint, 'Expected InfluxDB 3 Enterprise capability fingerprint')
  });
  if (!config.adminTokenSecretRefId) throw new TypeError('InfluxDB 3 Enterprise admin-token SecretRef ID is invalid.');
  endpointUrl(config);
  return config;
}

function parseVersion(value) {
  const raw = typeof value === 'string' ? value : '';
  const text = raw.trim();
  const match = /^(3)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match || raw !== text || text.length > 100) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_VERSION_UNSUPPORTED', 'The endpoint is not a supported InfluxDB 3 Enterprise 3.x release.', { category: 'compatibility' });
  return Object.freeze({ text, major: 3, minor: Number(match[2]), patch: Number(match[3]) });
}

function authorizationHeader(value) {
  const token = String(value ?? '');
  if (!token || token !== token.trim() || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES || /[\u0000-\u001f\u007f]/.test(token)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_TOKEN_INVALID', 'The InfluxDB 3 Enterprise admin-token SecretRef is unavailable or invalid.', { category: 'authentication' });
  return `Bearer ${token}`;
}

async function readTlsFile(file) {
  if (!file) return undefined;
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_TLS_FILE_BYTES) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_TLS_FILE_INVALID', 'The InfluxDB 3 Enterprise TLS CA file is unavailable or invalid.', { category: 'configuration' });
  return fs.readFile(file);
}

function apiPath(config, suffix) {
  const value = `${config.basePath}${suffix}`;
  if (value.length > MAX_URL_LENGTH || !value.startsWith('/') || value.includes('?') || value.includes('#')) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_URL_INVALID', 'The InfluxDB 3 Enterprise API path is invalid.', { category: 'configuration' });
  return value;
}

const TRANSPORT_ERRORS = Object.freeze({
  INFLUXDB3_ENTERPRISE_CANCELED: ['The InfluxDB 3 Enterprise operation was canceled.', 'canceled', false],
  INFLUXDB3_ENTERPRISE_TIMEOUT: ['The InfluxDB 3 Enterprise request timed out.', 'timeout', true],
  INFLUXDB3_ENTERPRISE_TLS_FAILED: ['The InfluxDB 3 Enterprise TLS connection could not be authenticated.', 'connectivity', true],
  INFLUXDB3_ENTERPRISE_TLS_FILE_INVALID: ['The InfluxDB 3 Enterprise TLS CA file is unavailable or invalid.', 'configuration', false],
  INFLUXDB3_ENTERPRISE_TOKEN_INVALID: ['The InfluxDB 3 Enterprise admin-token SecretRef is unavailable or invalid.', 'authentication', false],
  INFLUXDB3_ENTERPRISE_URL_INVALID: ['The InfluxDB 3 Enterprise API path is invalid.', 'configuration', false],
  INFLUXDB3_ENTERPRISE_RESPONSE_TOO_LARGE: ['InfluxDB 3 Enterprise returned an oversized response.', 'integrity', false],
  INFLUXDB3_ENTERPRISE_UNREACHABLE: ['The InfluxDB 3 Enterprise endpoint is unreachable.', 'connectivity', true]
});

function safeTransportError(error) {
  const entry = TRANSPORT_ERRORS[error?.code];
  if (entry) return new DatabaseAdapterError(error.code, entry[0], { category: entry[1], retryable: entry[2] });
  return new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_UNREACHABLE', TRANSPORT_ERRORS.INFLUXDB3_ENTERPRISE_UNREACHABLE[0], { category: 'connectivity', retryable: true });
}

async function defaultTransport({ config, method, apiPath: requestPath, body = null, signal, resolveSecret }) {
  if (typeof resolveSecret !== 'function') throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_TOKEN_INVALID', TRANSPORT_ERRORS.INFLUXDB3_ENTERPRISE_TOKEN_INVALID[0], { category: 'authentication' });
  let authorization;
  try { authorization = authorizationHeader(await resolveSecret(config.adminTokenSecretRefId)); }
  catch { throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_TOKEN_INVALID', TRANSPORT_ERRORS.INFLUXDB3_ENTERPRISE_TOKEN_INVALID[0], { category: 'authentication' }); }
  const ca = config.protocol === 'https' ? await readTlsFile(config.caFile) : undefined;
  const client = config.protocol === 'https' ? https : http;
  const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
  if (!['GET', 'POST', 'DELETE'].includes(method) || typeof requestPath !== 'string' || requestPath.length > MAX_URL_LENGTH || !requestPath.startsWith('/') || requestPath.includes('?') || requestPath.includes('#')) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_URL_INVALID', 'The InfluxDB 3 Enterprise API path is invalid.', { category: 'configuration' });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const headers = { accept: 'application/json', authorization };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const request = client.request({
      protocol: `${config.protocol}:`, hostname: config.host, port: config.port, method, path: requestPath, headers, agent: false,
      ...(config.protocol === 'https' ? { ca, rejectUnauthorized: true, servername: net.isIP(config.host) ? undefined : config.host } : {})
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_RESPONSE_TOO_LARGE', TRANSPORT_ERRORS.INFLUXDB3_ENTERPRISE_RESPONSE_TOO_LARGE[0], { category: 'integrity' }));
        else chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, { statusCode: Number(response.statusCode || 0), headers: response.headers || {}, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.setTimeout(config.timeoutMs, () => request.destroy(new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_TIMEOUT', TRANSPORT_ERRORS.INFLUXDB3_ENTERPRISE_TIMEOUT[0], { category: 'timeout', retryable: true })));
    request.on('error', (error) => {
      if (error instanceof DatabaseAdapterError) return finish(reject, error);
      const tlsFailure = /^(?:CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(String(error?.code || ''));
      return finish(reject, new DatabaseAdapterError(tlsFailure ? 'INFLUXDB3_ENTERPRISE_TLS_FAILED' : 'INFLUXDB3_ENTERPRISE_UNREACHABLE', tlsFailure ? TRANSPORT_ERRORS.INFLUXDB3_ENTERPRISE_TLS_FAILED[0] : TRANSPORT_ERRORS.INFLUXDB3_ENTERPRISE_UNREACHABLE[0], { category: 'connectivity', retryable: true }));
    });
    const onAbort = () => request.destroy(new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_CANCELED', TRANSPORT_ERRORS.INFLUXDB3_ENTERPRISE_CANCELED[0], { category: 'canceled' }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (payload) request.write(payload);
    request.end();
  });
}

function responseText(response) {
  const raw = Buffer.isBuffer(response?.body) ? response.body : Buffer.from(String(response?.body ?? ''), 'utf8');
  if (raw.length > MAX_RESPONSE_BYTES) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_RESPONSE_TOO_LARGE', TRANSPORT_ERRORS.INFLUXDB3_ENTERPRISE_RESPONSE_TOO_LARGE[0], { category: 'integrity' });
  return raw.toString('utf8');
}

function assertBoundedJson(root) {
  const pending = [{ value: root, depth: 0 }];
  let values = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    values += 1;
    if (values > MAX_JSON_VALUES || depth > MAX_JSON_DEPTH) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned invalid bounded JSON.', { category: 'integrity' });
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned invalid bounded JSON.', { category: 'integrity' });
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_JSON_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned invalid bounded JSON.', { category: 'integrity' });
      continue;
    }
    if (!value || typeof value !== 'object') throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned invalid bounded JSON.', { category: 'integrity' });
    if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
      continue;
    }
    const entries = Object.entries(value);
    for (const [key, item] of entries) {
      if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned invalid bounded JSON.', { category: 'integrity' });
      pending.push({ value: item, depth: depth + 1 });
    }
  }
  return root;
}

function parseJsonResponse(response) {
  let text;
  try { text = responseText(response); }
  catch (error) {
    if (error instanceof DatabaseAdapterError) throw error;
    throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned invalid bounded JSON.', { category: 'integrity' });
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned invalid bounded JSON.', { category: 'integrity' }); }
  return assertBoundedJson(parsed);
}

function headerValue(headers, name, required = true) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const raw = entry?.[1];
  if (Array.isArray(raw) && raw.length !== 1) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid endpoint identity.', { category: 'integrity' });
  const value = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  if ((!value && required) || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid endpoint identity.', { category: 'integrity' });
  return value;
}

function requireClusterHeader(response, expectedClusterId = null) {
  const clusterId = safeIdentity(headerValue(response?.headers, 'cluster-uuid'), 'InfluxDB 3 Enterprise cluster UUID');
  if (expectedClusterId && clusterId !== expectedClusterId) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_CLUSTER_CHANGED', 'InfluxDB 3 Enterprise cluster identity changed during discovery.', { category: 'integrity' });
  return clusterId;
}

function parseProductIdentity(response) {
  if (response?.statusCode !== 200) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_PING_FAILED', 'InfluxDB 3 Enterprise did not accept the product identity request.', { category: response?.statusCode >= 500 ? 'unavailable' : 'connectivity', retryable: response?.statusCode >= 500 });
  const body = parseJsonResponse(response);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid endpoint identity.', { category: 'integrity' });
  if (headerValue(response.headers, 'x-influxdb-build').toLowerCase() !== 'enterprise') throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_PRODUCT_UNSUPPORTED', 'The endpoint is not InfluxDB 3 Enterprise.', { category: 'compatibility' });
  const headerVersion = parseVersion(headerValue(response.headers, 'x-influxdb-version'));
  const version = parseVersion(body.version);
  if (version.text !== headerVersion.text) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned inconsistent version identity.', { category: 'integrity' });
  if (body.product_name !== undefined && body.product_name !== null && body.product_name !== '' && String(body.product_name).trim().toLowerCase() !== 'influxdb 3 enterprise') throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_PRODUCT_UNSUPPORTED', 'The endpoint is not InfluxDB 3 Enterprise.', { category: 'compatibility' });
  const revisionRaw = body.revision === undefined || body.revision === null ? '' : body.revision;
  if (typeof revisionRaw !== 'string' || revisionRaw.length > 200 || revisionRaw !== revisionRaw.trim()) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid endpoint identity.', { category: 'integrity' });
  const revision = revisionRaw || null;
  const processId = safeIdentity(body.process_id, 'InfluxDB 3 Enterprise process ID');
  const clusterId = requireClusterHeader(response);
  return Object.freeze({ product: 'influxdb3-enterprise', build: 'Enterprise', version, revision, processId, clusterId });
}

function responseStatusError(response, operation) {
  const statusCode = Number(response?.statusCode || 0);
  if (statusCode === 401) return new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_AUTHENTICATION_FAILED', `InfluxDB 3 Enterprise rejected the admin token during ${operation}.`, { category: 'authentication' });
  if (statusCode === 403) return new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_ADMIN_REQUIRED', `InfluxDB 3 Enterprise requires an authorized admin token for ${operation}.`, { category: 'authorization' });
  return new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_DISCOVERY_FAILED', `InfluxDB 3 Enterprise could not complete ${operation}.`, { category: statusCode >= 500 ? 'unavailable' : 'compatibility', retryable: statusCode >= 500 });
}

function normalizeRoles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROLES) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid node-role identity.', { category: 'integrity' });
  const roles = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw || raw.length > 40 || raw !== raw.trim()) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid node-role identity.', { category: 'integrity' });
    const role = raw.toLowerCase();
    if (!ALLOWED_ROLES.has(role)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid node-role identity.', { category: 'integrity' });
    roles.push(role === 'compactor' ? 'compact' : role);
  }
  return [...new Set(roles)].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function parseNodesResponse(response, expected = {}) {
  if (response?.statusCode !== 200) throw responseStatusError(response, 'node discovery');
  const clusterId = requireClusterHeader(response, expected.clusterId);
  const parsed = parseJsonResponse(response);
  const rows = Array.isArray(parsed) ? parsed : parsed && !Array.isArray(parsed) ? parsed.nodes : null;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_NODES) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned an invalid bounded node collection.', { category: 'integrity' });
  const nodeIds = new Set();
  const nodeCatalogIds = new Set();
  const instanceIds = new Set();
  const matches = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned an invalid bounded node collection.', { category: 'integrity' });
    const nodeId = safeIdentity(row.node_id, 'InfluxDB 3 Enterprise node ID');
    const nodeCatalogId = Number(row.node_catalog_id);
    const instanceId = safeIdentity(row.instance_id, 'InfluxDB 3 Enterprise instance ID');
    if (!Number.isInteger(nodeCatalogId) || nodeCatalogId < 0 || nodeCatalogId > 0xffffffff || nodeIds.has(nodeId) || nodeCatalogIds.has(nodeCatalogId) || instanceIds.has(instanceId)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned duplicate or invalid node identity.', { category: 'integrity' });
    nodeIds.add(nodeId);
    nodeCatalogIds.add(nodeCatalogId);
    instanceIds.add(instanceId);
    const roles = normalizeRoles(row.mode);
    if (typeof row.state !== 'string' || !row.state || row.state.length > 20 || row.state !== row.state.trim()) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid node state.', { category: 'integrity' });
    const state = row.state.toLowerCase();
    if (!['running', 'stopped'].includes(state)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise returned invalid node state.', { category: 'integrity' });
    if (instanceId === expected.processId) matches.push({ nodeId, nodeCatalogId, instanceId, roles, state });
  }
  if (matches.length !== 1 || matches[0].state !== 'running') throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_CURRENT_NODE_UNPROVEN', 'InfluxDB 3 Enterprise current-node identity could not be proven.', { category: 'integrity' });
  const current = matches[0];
  const compactorCapable = current.roles.includes('compact') || current.roles.includes('all');
  return Object.freeze({ clusterId, nodeId: current.nodeId, nodeCatalogId: current.nodeCatalogId, instanceId: current.instanceId, roles: Object.freeze(current.roles), roleFingerprint: stableDigest(current.roles), compactorCapable, nodeCount: rows.length });
}

function parseBackupCapabilityResponse(response, node, expectedClusterId) {
  const clusterId = requireClusterHeader(response, expectedClusterId);
  const statusCode = Number(response?.statusCode || 0);
  responseText(response);
  if (statusCode === 200) {
    const parsed = parseJsonResponse(response);
    const backups = parsed && !Array.isArray(parsed) && Array.isArray(parsed.backups) ? parsed.backups : null;
    if (!Array.isArray(backups) || backups.length > MAX_BACKUPS) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_BACKUP_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned an invalid bounded backup collection.', { category: 'integrity' });
    if (!node.compactorCapable) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_CAPABILITY_INCONSISTENT', 'InfluxDB 3 Enterprise returned inconsistent backup and node-role capability.', { category: 'integrity' });
    return Object.freeze({ clusterId, statusCode, storageEngine: 'upgraded', upgradedStorageEngine: true, legacyParquetEngine: false, nativeBackupAvailable: true, unavailableReason: null, observedBackupCount: backups.length });
  }
  if (statusCode === 404) {
    const ingestOnly = node.roles.length === 1 && node.roles[0] === 'ingest';
    const legacyParquetEngine = node.compactorCapable;
    return Object.freeze({
      clusterId, statusCode, storageEngine: legacyParquetEngine ? 'legacy-parquet' : 'unknown', upgradedStorageEngine: false, legacyParquetEngine,
      nativeBackupAvailable: false, unavailableReason: legacyParquetEngine ? 'legacy-parquet-engine' : ingestOnly ? 'ingest-only-node' : 'legacy-engine-or-ingest-only-node', observedBackupCount: null
    });
  }
  if (statusCode === 503) {
    if (node.compactorCapable) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_CAPABILITY_INCONSISTENT', 'InfluxDB 3 Enterprise returned inconsistent backup and node-role capability.', { category: 'integrity' });
    return Object.freeze({ clusterId, statusCode, storageEngine: 'unknown', upgradedStorageEngine: false, legacyParquetEngine: false, nativeBackupAvailable: false, unavailableReason: 'query-only-node', observedBackupCount: null });
  }
  throw responseStatusError(response, 'native backup capability discovery');
}

function assertExpectedIdentity(config, identity) {
  if (config.expectedVersion && config.expectedVersion !== identity.version.text) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_VERSION_CHANGED', 'InfluxDB 3 Enterprise version changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedStorageEngine && config.expectedStorageEngine !== identity.storageEngine) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_STORAGE_ENGINE_CHANGED', 'InfluxDB 3 Enterprise storage engine changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedClusterId && config.expectedClusterId !== identity.clusterId) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_CLUSTER_CHANGED', 'InfluxDB 3 Enterprise cluster identity changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedNodeId && config.expectedNodeId !== identity.nodeId) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_CHANGED', 'InfluxDB 3 Enterprise node identity changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedNodeCatalogId !== null && config.expectedNodeCatalogId !== identity.nodeCatalogId) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_CATALOG_CHANGED', 'InfluxDB 3 Enterprise node catalog identity changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedInstanceId && config.expectedInstanceId !== identity.instanceId) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NODE_INSTANCE_CHANGED', 'InfluxDB 3 Enterprise node instance identity changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedRoleFingerprint && config.expectedRoleFingerprint !== identity.roleFingerprint) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_ROLE_CHANGED', 'InfluxDB 3 Enterprise node role changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedDeploymentFingerprint && config.expectedDeploymentFingerprint !== identity.deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_DEPLOYMENT_CHANGED', 'InfluxDB 3 Enterprise endpoint binding changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedCapabilityFingerprint && config.expectedCapabilityFingerprint !== identity.capabilityFingerprint) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_CAPABILITY_CHANGED', 'InfluxDB 3 Enterprise native backup capability changed since the connection was tested.', { category: 'integrity' });
}

function persistedEndpoint(config) {
  return {
    protocol: config.protocol, allowInsecureHttp: config.allowInsecureHttp, host: config.host, port: config.port, basePath: config.basePath, caFile: config.caFile, timeoutMs: config.timeoutMs,
    expectedVersion: config.expectedVersion, expectedStorageEngine: config.expectedStorageEngine, expectedClusterId: config.expectedClusterId, expectedNodeId: config.expectedNodeId,
    expectedNodeCatalogId: config.expectedNodeCatalogId, expectedInstanceId: config.expectedInstanceId,
    expectedRoleFingerprint: config.expectedRoleFingerprint, expectedDeploymentFingerprint: config.expectedDeploymentFingerprint, expectedCapabilityFingerprint: config.expectedCapabilityFingerprint
  };
}

function normalizeNativeBackupExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise native backup execution must be an object.');
  const allowed = [
    'version', 'engine', 'tier', 'productVersion', 'clusterId', 'storageEngine', 'nodeId', 'nodeCatalogId', 'instanceId',
    'roleFingerprint', 'deploymentFingerprint', 'capabilityFingerprint', 'compactorCapable', 'nativeBackupAvailable',
    'connectionRevision', 'workspaceId', 'sourceId', 'executionId'
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError('InfluxDB 3 Enterprise native backup execution contains an unsupported field.');
  const version = Number(input.version ?? 1);
  const engine = String(input.engine || 'influxdb3-enterprise').toLowerCase();
  const tier = String(input.tier || 'upgraded-native').toLowerCase();
  const storageEngine = requiredText(input.storageEngine, 'InfluxDB 3 Enterprise native storage engine', 40);
  const nodeCatalogId = Number(input.nodeCatalogId);
  const connectionRevision = Number(input.connectionRevision);
  const roleFingerprint = optionalFingerprint(input.roleFingerprint, 'InfluxDB 3 Enterprise role fingerprint');
  const deploymentFingerprint = optionalFingerprint(input.deploymentFingerprint, 'InfluxDB 3 Enterprise deployment fingerprint');
  const capabilityFingerprint = optionalFingerprint(input.capabilityFingerprint, 'InfluxDB 3 Enterprise capability fingerprint');
  if (version !== 1 || engine !== 'influxdb3-enterprise' || tier !== 'upgraded-native' || storageEngine !== 'upgraded' || input.compactorCapable !== true || input.nativeBackupAvailable !== true) throw new TypeError('InfluxDB 3 Enterprise native backup requires a proven upgraded-engine compactor endpoint.');
  if (!Number.isInteger(nodeCatalogId) || nodeCatalogId < 0 || nodeCatalogId > 0xffffffff || !Number.isInteger(connectionRevision) || connectionRevision < 1) throw new TypeError('InfluxDB 3 Enterprise native backup execution identity is invalid.');
  if (!roleFingerprint || !deploymentFingerprint || !capabilityFingerprint) throw new TypeError('InfluxDB 3 Enterprise native backup execution fingerprints are invalid.');
  const clusterId = optionalConfigIdentity(input.clusterId, 'InfluxDB 3 Enterprise execution cluster ID');
  const nodeId = optionalConfigIdentity(input.nodeId, 'InfluxDB 3 Enterprise execution node ID');
  const instanceId = optionalConfigIdentity(input.instanceId, 'InfluxDB 3 Enterprise execution instance ID');
  if (!clusterId || !nodeId || !instanceId) throw new TypeError('InfluxDB 3 Enterprise native backup execution identity is incomplete.');
  return Object.freeze({
    version: 1,
    engine,
    tier: 'upgraded-native',
    productVersion: parseVersion(input.productVersion).text,
    clusterId,
    storageEngine,
    nodeId,
    nodeCatalogId,
    instanceId,
    roleFingerprint,
    deploymentFingerprint,
    capabilityFingerprint,
    compactorCapable: true,
    nativeBackupAvailable: true,
    connectionRevision,
    workspaceId: input.workspaceId === undefined || input.workspaceId === null ? null : requiredText(input.workspaceId, 'InfluxDB 3 Enterprise execution workspace ID', 200),
    sourceId: input.sourceId === undefined || input.sourceId === null ? null : requiredText(input.sourceId, 'InfluxDB 3 Enterprise execution Source ID', 200),
    executionId: input.executionId === undefined || input.executionId === null ? null : requiredText(input.executionId, 'InfluxDB 3 Enterprise execution run ID', 200)
  });
}

function nativeBackupName(workspaceId, sourceId, executionId) {
  const digest = crypto.createHash('sha256').update(`${requiredText(workspaceId, 'InfluxDB 3 Enterprise execution workspace ID', 200)}\0${requiredText(sourceId, 'InfluxDB 3 Enterprise execution Source ID', 200)}\0${requiredText(executionId, 'InfluxDB 3 Enterprise execution run ID', 200)}`).digest('hex');
  return `deployerx-${digest.slice(0, 48)}`;
}

function wholeClusterSelector(selector) {
  const empty = (rules) => !rules?.include?.length && !rules?.exclude?.length;
  return selector?.kind === 'database-objects' && selector.allDatabases === true && empty(selector.databases) && empty(selector.schemas) && empty(selector.tables) && selector.includeGlobalObjects !== true;
}

function assertNativeExecutionConnection(config, execution) {
  const matches = config.expectedVersion === execution.productVersion
    && config.expectedStorageEngine === execution.storageEngine
    && config.expectedClusterId === execution.clusterId
    && config.expectedNodeId === execution.nodeId
    && config.expectedNodeCatalogId === execution.nodeCatalogId
    && config.expectedInstanceId === execution.instanceId
    && config.expectedRoleFingerprint === execution.roleFingerprint
    && config.expectedDeploymentFingerprint === execution.deploymentFingerprint
    && config.expectedCapabilityFingerprint === execution.capabilityFingerprint;
  if (!matches) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_BINDING_CHANGED', 'The InfluxDB 3 Enterprise native backup binding does not match the fully tested connection.', { category: 'integrity' });
}

function assertNativeExecutionIdentity(execution, identity) {
  const matches = identity.version?.text === execution.productVersion
    && identity.storageEngine === execution.storageEngine
    && identity.clusterId === execution.clusterId
    && identity.nodeId === execution.nodeId
    && identity.nodeCatalogId === execution.nodeCatalogId
    && identity.instanceId === execution.instanceId
    && identity.roleFingerprint === execution.roleFingerprint
    && identity.deploymentFingerprint === execution.deploymentFingerprint
    && identity.capabilityFingerprint === execution.capabilityFingerprint
    && identity.upgradedStorageEngine === true
    && identity.compactorCapable === true
    && identity.nativeBackupAvailable === true;
  if (!matches) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_IDENTITY_CHANGED', 'InfluxDB 3 Enterprise upgraded-engine backup identity changed after Source enrollment.', { category: 'integrity' });
}

function nativePublicIdentity(identity) {
  return Object.freeze({
    productVersion: identity.version.text,
    clusterId: identity.clusterId,
    storageEngine: identity.storageEngine,
    nodeId: identity.nodeId,
    nodeCatalogId: identity.nodeCatalogId,
    instanceId: identity.instanceId,
    roleFingerprint: identity.roleFingerprint,
    deploymentFingerprint: identity.deploymentFingerprint,
    capabilityFingerprint: identity.capabilityFingerprint,
    compactorCapable: true,
    nativeBackupAvailable: true
  });
}

class InfluxDb3EnterpriseAdapter {
  constructor({ transport = defaultTransport, clock = () => new Date().toISOString(), now = () => Date.now(), nativeController = null } = {}) {
    this.transport = transport;
    this.clock = clock;
    this.now = now;
    this.nativeController = nativeController;
  }

  manifest() {
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      displayName: 'InfluxDB 3 Enterprise',
      engine: 'influxdb3-enterprise',
      executionReady: true,
      sourceEnrollmentReady: true,
      serverVersionRange: 'InfluxDB 3 Enterprise 3.x upgraded-native or proven legacy-compactor tiers',
      restoreVersionRange: 'Native restore exists at the controller layer but is not published through Source execution',
      capabilities: {
        backupMethods: ['physical'],
        backupModes: ['full'],
        selection: { database: true, schema: false, table: false, globalObjects: false },
        consistencyStrategies: [
          { id: NATIVE_CONSISTENCY_METHOD, produces: 'application', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: true },
          { id: 'influxdb3-enterprise-legacy-stopped-copy', produces: 'application', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: true, capturesCoordinates: false },
          { id: 'influxdb3-enterprise-legacy-atomic-snapshot-copy', produces: 'application', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: false },
          { id: LEGACY_CONSISTENCY_METHOD, produces: 'crash', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: false }
        ],
        transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null },
        streaming: { backup: false, restore: false, compression: false, encryption: false },
        restore: { alternateTarget: false, offlineBundle: false, originalTarget: false, nativeValidation: false },
        replicaAware: true
      },
      requiredTools: [],
      requiredPrivileges: [{ id: 'admin-token', operations: ['discovery', 'backup'], required: true, safeDescription: 'An InfluxDB 3 Enterprise admin token is required for authenticated discovery and native backup execution.' }]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }
  validateConfig(input) { try { normalizeConfig(input); return []; } catch (error) { return [{ path: '', code: 'INFLUXDB3_ENTERPRISE_CONFIG_INVALID', severity: 'error', message: error.message }]; } }

  async request(context, config, method, requestPath, body = null) {
    try { return await this.transport({ config, method, apiPath: requestPath, body, signal: context.signal, resolveSecret: context.resolveSecret }); }
    catch (error) { throw safeTransportError(error); }
  }

  async readIdentity(context = {}, input = {}) {
    const config = normalizeConfig(input);
    const ping = parseProductIdentity(await this.request(context, config, 'GET', apiPath(config, '/ping')));
    const [nodesResponse, backupResponse] = await Promise.all([
      this.request(context, config, 'POST', apiPath(config, '/api/v3/query_sql'), { db: '_internal', q: NODES_QUERY, format: 'json', params: null }),
      this.request(context, config, 'GET', apiPath(config, '/api/v3/enterprise/backup'))
    ]);
    const node = parseNodesResponse(nodesResponse, { clusterId: ping.clusterId, processId: ping.processId });
    const capability = parseBackupCapabilityResponse(backupResponse, node, ping.clusterId);
    const deploymentFingerprint = stableDigest({ product: ping.product, version: ping.version.text, endpoint: endpointUrl(config), clusterId: ping.clusterId, nodeId: node.nodeId, nodeCatalogId: node.nodeCatalogId });
    const capabilityFingerprint = stableDigest({ storageEngine: capability.storageEngine, roles: node.roles, probeStatus: capability.statusCode, nativeBackupAvailable: capability.nativeBackupAvailable, unavailableReason: capability.unavailableReason });
    const identity = Object.freeze({
      ...ping,
      clusterId: ping.clusterId,
      nodeId: node.nodeId,
      nodeCatalogId: node.nodeCatalogId,
      instanceId: node.instanceId,
      roles: node.roles,
      roleFingerprint: node.roleFingerprint,
      compactorCapable: node.compactorCapable,
      nodeCount: node.nodeCount,
      storageEngine: capability.storageEngine,
      upgradedStorageEngine: capability.upgradedStorageEngine,
      legacyParquetEngine: capability.legacyParquetEngine,
      nativeBackupAvailable: capability.nativeBackupAvailable,
      unavailableReason: capability.unavailableReason,
      probeStatus: capability.statusCode,
      observedBackupCount: capability.observedBackupCount,
      deploymentFingerprint,
      capabilityFingerprint
    });
    assertExpectedIdentity(config, identity);
    return identity;
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const identity = await this.readIdentity(context, input);
      return normalizeConnectionTestResult({
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'success',
        checks: [
          { id: 'product-version', status: 'pass', safeMessage: `InfluxDB 3 Enterprise ${identity.version.text} identity was authenticated through /ping.` },
          { id: 'cluster-node', status: 'pass', safeMessage: `Stable cluster and current-node identity were correlated with the authenticated node catalog.` },
          { id: 'compactor-role', status: identity.compactorCapable ? 'pass' : 'warning', safeMessage: identity.compactorCapable ? 'The endpoint node is compactor-capable.' : 'The endpoint node is not proven to be compactor-capable.' },
          { id: 'native-backup', status: identity.nativeBackupAvailable ? 'pass' : 'warning', safeMessage: identity.nativeBackupAvailable ? 'The upgraded storage engine native backup endpoint is available.' : 'The native backup endpoint is unavailable for this storage-engine or node-role combination.' }
        ],
        remotePlatform: { engine: 'influxdb3-enterprise', version: identity.version.text, distribution: 'enterprise' },
        endpointIdentity: {
          version: identity.version.text,
          storageEngine: identity.storageEngine,
          clusterId: identity.clusterId,
          nodeId: identity.nodeId,
          nodeCatalogId: identity.nodeCatalogId,
          instanceId: identity.instanceId,
          roleFingerprint: identity.roleFingerprint,
          compactorCapable: identity.compactorCapable,
          nativeBackupAvailable: identity.nativeBackupAvailable,
          deploymentFingerprint: identity.deploymentFingerprint,
          capabilityFingerprint: identity.capabilityFingerprint,
          unavailableReason: identity.unavailableReason
        },
        error: null
      }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    } catch (error) {
      const safe = error instanceof DatabaseAdapterError ? error : new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_DISCOVERY_FAILED', 'DeployerX could not validate InfluxDB 3 Enterprise.', { category: 'connectivity', retryable: true });
      return normalizeConnectionTestResult({
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'failure',
        checks: [],
        error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: {}, causeFingerprint: null }
      }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    }
  }

  async *discover(context = {}, request = {}) {
    if (!['all', 'node', 'capability'].includes(String(request.kind || 'all').toLowerCase())) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_DISCOVERY_KIND_UNSUPPORTED', 'InfluxDB 3 Enterprise discovery kind is unsupported.', { category: 'compatibility' });
    const identity = await this.readIdentity(context, request.connection);
    yield Object.freeze({
      nextCursor: null,
      product: identity.product,
      version: identity.version,
      clusterId: identity.clusterId,
      deploymentFingerprint: identity.deploymentFingerprint,
      capabilityFingerprint: identity.capabilityFingerprint,
      items: [Object.freeze({
        id: identity.nodeId,
        name: identity.nodeId,
        nodeCatalogId: identity.nodeCatalogId,
        instanceId: identity.instanceId,
        selectable: false,
        roles: identity.roles,
        roleFingerprint: identity.roleFingerprint,
        compactorCapable: identity.compactorCapable,
        storageEngine: identity.storageEngine,
        upgradedStorageEngine: identity.upgradedStorageEngine,
        legacyParquetEngine: identity.legacyParquetEngine,
        nativeBackupAvailable: identity.nativeBackupAvailable,
        unavailableReason: identity.unavailableReason,
        probeStatus: identity.probeStatus
      })],
      capabilities: Object.freeze({
        discoveryOnly: false,
        stableClusterIdentity: true,
        stableNodeIdentity: true,
        compactorRoleProven: identity.compactorCapable,
        upgradedStorageEngineProven: identity.upgradedStorageEngine,
        nativeBackupAvailable: identity.nativeBackupAvailable,
        fullBackupAvailable: identity.nativeBackupAvailable,
        incrementalBackupAvailable: false,
        restoreExecutionAvailable: false
      })
    });
  }

  unsupportedOperation() { throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_OPERATION_UNSUPPORTED', 'This InfluxDB 3 Enterprise operation is not published through the adapter.', { category: 'compatibility' }); }

  async preflight(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const execution = normalizeNativeBackupExecution(request.execution);
    if (!wholeClusterSelector(request.selector)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_SELECTION_INVALID', 'InfluxDB 3 Enterprise native backup requires exact whole-cluster selection.', { category: 'compatibility' });
    if (request.consistency?.backupMode === 'incremental') throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_INCREMENTAL_WIRE_CONTRACT_UNAVAILABLE', 'InfluxDB 3 Enterprise incremental backup creation is disabled until the provider publishes an exact versioned HTTP request contract.', { category: 'compatibility' });
    if (request.consistency?.backupMethod !== 'physical' || request.consistency?.backupMode !== 'full' || !['auto', NATIVE_CONSISTENCY_METHOD].includes(request.consistency?.method) || request.consistency?.requestedLevel !== 'application' || request.consistency?.captureCoordinates !== true || request.consistency?.allowDowngrade === true) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_CONSISTENCY_INVALID', 'InfluxDB 3 Enterprise native backup requires application-consistent physical full backup with coordinate capture.', { category: 'compatibility' });
    assertNativeExecutionConnection(config, execution);
    const identity = await this.readIdentity(context, config);
    assertNativeExecutionIdentity(execution, identity);
    return {
      checkedAt: this.clock(),
      serverVersion: identity.version.text,
      serverVersionSupported: true,
      serverIdentityFingerprint: identity.deploymentFingerprint,
      consistency: [{ method: NATIVE_CONSISTENCY_METHOD, verified: true, produces: 'application' }],
      tools: [],
      privileges: [{ id: 'admin-token', allowed: true, evidence: 'Authenticated upgraded-engine backup inventory and compactor admission succeeded.' }],
      coordinateCaptureVerified: true,
      warnings: [],
      metadata: { nativeIdentity: nativePublicIdentity(identity), externalNativeMedia: true, fullBackupOnly: true }
    };
  }

  async planBackup(_context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const execution = normalizeNativeBackupExecution(request.execution);
    if (!execution.workspaceId || !execution.sourceId || !execution.executionId) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_EXECUTION_IDENTITY_REQUIRED', 'InfluxDB 3 Enterprise native backup requires workspace, Source, and run identity.', { category: 'integrity' });
    if (!wholeClusterSelector(request.selector)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_SELECTION_INVALID', 'InfluxDB 3 Enterprise native backup requires exact whole-cluster selection.', { category: 'compatibility' });
    if (request.consistency?.proven !== true || request.consistency?.method !== NATIVE_CONSISTENCY_METHOD || request.consistency?.achievedLevel !== 'application' || request.consistency?.backupMethod !== 'physical' || request.consistency?.backupMode !== 'full' || request.consistency?.captureCoordinates !== true) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_PLAN_INVALID', 'InfluxDB 3 Enterprise native backup requires a proven application-consistent full-backup plan.', { category: 'integrity' });
    assertNativeExecutionConnection(config, execution);
    const evidence = request.consistency.evidence?.metadata?.nativeIdentity;
    if (!evidence || evidence.productVersion !== execution.productVersion || evidence.clusterId !== execution.clusterId || evidence.storageEngine !== 'upgraded' || evidence.nodeId !== execution.nodeId || evidence.nodeCatalogId !== execution.nodeCatalogId || evidence.instanceId !== execution.instanceId || evidence.roleFingerprint !== execution.roleFingerprint || evidence.deploymentFingerprint !== execution.deploymentFingerprint || evidence.capabilityFingerprint !== execution.capabilityFingerprint || evidence.compactorCapable !== true || evidence.nativeBackupAvailable !== true) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_PLAN_IDENTITY_CHANGED', 'InfluxDB 3 Enterprise preflight identity does not match the enrolled Source binding.', { category: 'integrity' });
    return {
      version: 1,
      operation: NATIVE_CONSISTENCY_METHOD,
      connection: config,
      execution,
      selector: request.selector,
      consistency: request.consistency,
      backupName: nativeBackupName(execution.workspaceId, execution.sourceId, execution.executionId),
      backupType: 'full',
      identity: evidence,
      artifact: { kind: 'metadata', path: 'influxdb3-enterprise/native-backup-metadata.json', mediaType: 'application/vnd.deployerx.influxdb3-enterprise-native-backup+json' },
      externalNativeMedia: true,
      authoritativeOwner: 'influxdb3-enterprise',
      resumable: false
    };
  }

  async executeBackup(context = {}, plan = {}) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.operation !== NATIVE_CONSISTENCY_METHOD || plan.backupType !== 'full') throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_PLAN_INVALID', 'InfluxDB 3 Enterprise native backup plan is invalid.', { category: 'integrity' });
    const config = normalizeConfig(plan.connection);
    const execution = normalizeNativeBackupExecution(plan.execution);
    assertNativeExecutionConnection(config, execution);
    if (plan.backupName !== nativeBackupName(execution.workspaceId, execution.sourceId, execution.executionId)) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_PLAN_INVALID', 'InfluxDB 3 Enterprise native backup name does not match the run identity.', { category: 'integrity' });
    if (plan.artifact?.kind !== 'metadata' || plan.artifact?.path !== 'influxdb3-enterprise/native-backup-metadata.json' || plan.artifact?.mediaType !== 'application/vnd.deployerx.influxdb3-enterprise-native-backup+json') throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_NATIVE_PLAN_INVALID', 'InfluxDB 3 Enterprise native backup publication plan is invalid.', { category: 'integrity' });
    if (typeof context.onOwnership !== 'function') throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_CALLBACK_REQUIRED', 'A durable InfluxDB 3 Enterprise backup ownership callback is required before starting a backup.', { category: 'configuration' });
    const NativeController = require('./influxdb3-enterprise-native').InfluxDb3EnterpriseNativeController;
    const controller = this.nativeController || new NativeController({ adapter: this });
    const result = await controller.createBackup(context, { connection: config, name: plan.backupName, type: 'full' });
    const backup = result?.backup;
    const identity = result?.identity;
    if (!backup || backup.name !== plan.backupName || backup.type !== 'full' || backup.parentName !== null || backup.status !== 'completed' || backup.watermark === null || !identity || identity.version !== execution.productVersion || identity.clusterId !== execution.clusterId || identity.storageEngine !== 'upgraded' || identity.nodeId !== execution.nodeId || identity.nodeCatalogId !== execution.nodeCatalogId || identity.instanceId !== execution.instanceId || identity.roleFingerprint !== execution.roleFingerprint || identity.deploymentFingerprint !== execution.deploymentFingerprint || identity.capabilityFingerprint !== execution.capabilityFingerprint) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_BACKUP_RESULT_INVALID', 'InfluxDB 3 Enterprise did not return an exact completed full backup with a persisted-data watermark.', { category: 'integrity' });
    return {
      version: 1,
      kind: 'influxdb3-enterprise-native-backup',
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      engine: 'influxdb3-enterprise',
      backupMethod: 'physical',
      backupMode: 'full',
      sourceId: execution.sourceId,
      selectionDigest: plan.selector.digest,
      consistency: { level: 'application', method: NATIVE_CONSISTENCY_METHOD, persistedDataWatermark: backup.watermark },
      source: { product: 'InfluxDB 3 Enterprise', productVersion: identity.version, clusterId: identity.clusterId, storageEngine: identity.storageEngine, nodeId: identity.nodeId, nodeCatalogId: identity.nodeCatalogId, instanceId: identity.instanceId, roleFingerprint: identity.roleFingerprint, deploymentFingerprint: identity.deploymentFingerprint, capabilityFingerprint: identity.capabilityFingerprint, compactorCapable: true },
      operation: { backupName: backup.name, backupType: backup.type, status: backup.status, watermark: backup.watermark, createdAt: backup.createdAt, completedAt: backup.completedAt },
      publication: { artifactKind: 'metadata', path: 'influxdb3-enterprise/native-backup-metadata.json', mediaType: 'application/vnd.deployerx.influxdb3-enterprise-native-backup+json' },
      externalNativeMedia: { managedByServer: true, authoritativeOwner: 'influxdb3-enterprise', includedInRepository: false, deletionIssued: false },
      restoreSupported: false
    };
  }

  async planRestore() { return this.unsupportedOperation(); }
  async executeRestore() { return this.unsupportedOperation(); }
  async validateRestore() { return this.unsupportedOperation(); }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

function expectedEndpoint(endpoint, identity) {
  return {
    ...endpoint,
    expectedVersion: identity.version,
    expectedStorageEngine: identity.storageEngine,
    expectedClusterId: identity.clusterId,
    expectedNodeId: identity.nodeId,
    expectedNodeCatalogId: identity.nodeCatalogId,
    expectedInstanceId: identity.instanceId,
    expectedRoleFingerprint: identity.roleFingerprint,
    expectedDeploymentFingerprint: identity.deploymentFingerprint,
    expectedCapabilityFingerprint: identity.capabilityFingerprint
  };
}

class InfluxDb3EnterpriseConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new InfluxDb3EnterpriseAdapter() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { includeDeleted: false, limit: 1000 }))
      .filter((record) => record.adapterId === ADAPTER_ID)
      .map((record) => ({ ...record, capabilities: this.adapter.manifest().capabilities, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'InfluxDB 3 Enterprise connection name', 200);
    const token = String(input.token ?? '');
    authorizationHeader(token);
    const baseConfig = {
      protocol: input.protocol, allowInsecureHttp: input.allowInsecureHttp, host: input.host, port: input.port, basePath: input.basePath,
      caFile: input.caFile, timeoutMs: input.timeoutMs, adminTokenSecretRefId: 'sec_validation_placeholder'
    };
    normalizeConfig(baseConfig);
    let tokenRef = null;
    try {
      tokenRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} admin token`, secretType: 'token', value: token, scope: 'device' });
      const config = normalizeConfig({ ...baseConfig, adminTokenSecretRefId: tokenRef.id });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(tokenRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant,
          actorId: actor,
          name,
          kind: 'database',
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          scope: 'device',
          endpoint: persistedEndpoint(config),
          secretRefIds: [tokenRef.id],
          trust: { mode: config.protocol, fingerprint: null },
          workerAffinity: [`device:${this.deviceId}`],
          lastTest: null,
          influxdb3EnterpriseInventory: null
        });
      });
    } catch {
      if (tokenRef) await this.secretStore.delete({ workspaceId: tenant, id: tokenRef.id }).catch(() => {});
      throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_CONNECTION_CREATE_FAILED', 'The InfluxDB 3 Enterprise connection could not be saved.', { category: 'internal' });
    }
  }

  config(connection) {
    const secretRefIds = Array.isArray(connection?.secretRefIds) ? connection.secretRefIds : [];
    if (secretRefIds.length !== 1) throw new TypeError('InfluxDB 3 Enterprise connections require exactly one admin-token SecretRef.');
    return normalizeConfig({ ...connection.endpoint, adminTokenSecretRefId: secretRefIds[0] });
  }

  async test(workspaceId, connectionId, actorId = 'system', signal) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('InfluxDB 3 Enterprise connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This InfluxDB 3 Enterprise connection belongs to another device.');
    const context = { resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal };
    const result = await this.adapter.testConnection(context, this.config(current));
    let endpoint = current.endpoint;
    let trust = current.trust;
    let inventory = current.influxdb3EnterpriseInventory || null;
    if (result.status === 'success') {
      endpoint = expectedEndpoint(current.endpoint, result.endpointIdentity);
      const pages = [];
      for await (const page of this.adapter.discover(context, { connection: this.config({ ...current, endpoint }), kind: 'all' })) pages.push(page);
      if (pages.length !== 1 || pages[0].capabilityFingerprint !== result.endpointIdentity.capabilityFingerprint || pages[0].deploymentFingerprint !== result.endpointIdentity.deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB3_ENTERPRISE_DISCOVERY_CHANGED', 'InfluxDB 3 Enterprise identity changed while the connection was being tested.', { category: 'integrity' });
      const item = pages[0].items[0];
      inventory = {
        version: 1,
        capturedAt: result.testedAt,
        product: pages[0].product,
        productVersion: pages[0].version.text,
        clusterId: pages[0].clusterId,
        deploymentFingerprint: pages[0].deploymentFingerprint,
        capabilityFingerprint: pages[0].capabilityFingerprint,
        node: item,
        capabilities: pages[0].capabilities
      };
      trust = {
        mode: current.endpoint.protocol,
        fingerprint: result.endpointIdentity.deploymentFingerprint,
        clusterId: result.endpointIdentity.clusterId,
        nodeId: result.endpointIdentity.nodeId,
        nodeCatalogId: result.endpointIdentity.nodeCatalogId,
        instanceId: result.endpointIdentity.instanceId,
        roleFingerprint: result.endpointIdentity.roleFingerprint,
        capabilityFingerprint: result.endpointIdentity.capabilityFingerprint,
        observedAt: result.testedAt
      };
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { endpoint, trust, lastTest: result, influxdb3EnterpriseInventory: inventory, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('InfluxDB 3 Enterprise connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This InfluxDB 3 Enterprise connection belongs to another device.');
    if (current.lastTest?.status !== 'success' || current.trust?.fingerprint !== current.endpoint?.expectedDeploymentFingerprint || current.trust?.capabilityFingerprint !== current.endpoint?.expectedCapabilityFingerprint) throw new Error('Test the InfluxDB 3 Enterprise connection successfully before discovery.');
    const pages = [];
    for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current), kind: input.kind || 'all' })) pages.push(page);
    if (pages.length !== 1) throw new Error('InfluxDB 3 Enterprise discovery returned an invalid page count.');
    return pages[0];
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  LEGACY_CONSISTENCY_METHOD,
  NATIVE_CONSISTENCY_METHOD,
  InfluxDb3EnterpriseAdapter,
  InfluxDb3EnterpriseConnectionService,
  MAX_BACKUPS,
  MAX_NODES,
  MAX_RESPONSE_BYTES,
  apiPath,
  authorizationHeader,
  endpointUrl,
  nativeBackupName,
  normalizeConfig,
  normalizeNativeBackupExecution,
  parseJsonResponse,
  parseBackupCapabilityResponse,
  parseNodesResponse,
  parseProductIdentity,
  parseVersion,
  requireClusterHeader,
  responseText
};
