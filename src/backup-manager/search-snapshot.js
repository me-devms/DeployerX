const crypto = require('crypto');
const fs = require('fs/promises');
const https = require('https');
const net = require('net');
const path = require('path');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');

const ADAPTER_ID = 'deployerx.database.search.snapshot';
const ADAPTER_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TLS_FILE_BYTES = 1024 * 1024;
const MAX_REPOSITORIES = 1000;
const MAX_RESOURCES = 10000;
const MAX_SNAPSHOT_WAIT_MS = 24 * 60 * 60 * 1000;
const MAX_RESTORE_PREFIX_LENGTH = 48;
const AUTH_MODES = new Set(['basic', 'api-key', 'bearer']);
const EXPECTED_PRODUCTS = new Set(['auto', 'elasticsearch', 'opensearch']);
const UNSAFE_REPOSITORY_KEY = /(?:access|authorization|credential|password|private.?key|secret|session|token)/i;
const UNSAFE_REPOSITORY_VALUE = /(?:\b(?:basic|bearer|apikey)\s+[A-Za-z0-9+/=_-]{8,}|:\/\/[^/@\s]+@|\b(?:password|secret|token|api.?key)\s*[:=]\s*\S+)/i;

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function normalizeHost(value) {
  const input = requiredText(value, 'Search cluster host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('Search cluster host must be a hostname or IP address without a URI scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('Search cluster host is invalid.');
  return ascii;
}

function normalizePort(value) {
  const port = Number(value ?? 9200);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Search cluster port must be between 1 and 65535.');
  return port;
}

function normalizeBasePath(value) {
  const raw = optionalText(value, 'Search cluster base path', 512);
  if (!raw || raw === '/') return '';
  if (!raw.startsWith('/') || raw.endsWith('/') || /[?#\\\s]/.test(raw) || raw.includes('//')) throw new TypeError('Search cluster base path is invalid.');
  const segments = raw.slice(1).split('/');
  for (const segment of segments) {
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch { throw new TypeError('Search cluster base path is invalid.'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\\0]/.test(decoded)) throw new TypeError('Search cluster base path is invalid.');
  }
  return `/${segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join('/')}`;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('Search cluster timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeAbsoluteFile(value, label) {
  const file = optionalText(value, label);
  if (!file) return null;
  if (!path.isAbsolute(file)) throw new TypeError(`${label} must be absolute.`);
  return path.normalize(file);
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Search snapshot connection configuration must be an object.');
  const allowed = ['host', 'port', 'basePath', 'authMode', 'username', 'credentialSecretRefId', 'tlsMode', 'caFile', 'clientCertificateFile', 'clientKeyFile', 'timeoutMs', 'expectedProduct', 'expectedClusterUuid'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown search snapshot connection field: ${unknown[0]}.`);
  const authMode = String(input.authMode || 'basic').toLowerCase();
  if (!AUTH_MODES.has(authMode)) throw new TypeError('Search cluster authentication mode is invalid.');
  const username = optionalText(input.username, 'Search cluster username', 256);
  if (authMode === 'basic' && !username) throw new TypeError('Basic authentication requires a username.');
  if (authMode !== 'basic' && username) throw new TypeError('A username is only valid with Basic authentication.');
  const tlsMode = String(input.tlsMode || 'verify-identity').toLowerCase();
  if (tlsMode !== 'verify-identity') throw new TypeError('Search snapshot protection requires TLS certificate identity verification.');
  const clientCertificateFile = normalizeAbsoluteFile(input.clientCertificateFile, 'Search TLS client certificate file');
  const clientKeyFile = normalizeAbsoluteFile(input.clientKeyFile, 'Search TLS client key file');
  if (Boolean(clientCertificateFile) !== Boolean(clientKeyFile)) throw new TypeError('Search mutual TLS requires both a client certificate and client key file.');
  const expectedProduct = String(input.expectedProduct || 'auto').toLowerCase();
  if (!EXPECTED_PRODUCTS.has(expectedProduct)) throw new TypeError('Expected search product is invalid.');
  return {
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    basePath: normalizeBasePath(input.basePath),
    authMode,
    username: authMode === 'basic' ? username : null,
    credentialSecretRefId: requiredText(input.credentialSecretRefId, 'Search credential SecretRef ID', 200),
    tlsMode,
    caFile: normalizeAbsoluteFile(input.caFile, 'Search TLS CA file'),
    clientCertificateFile,
    clientKeyFile,
    timeoutMs: normalizeTimeout(input.timeoutMs),
    expectedProduct,
    expectedClusterUuid: optionalText(input.expectedClusterUuid, 'Expected search cluster UUID', 200)
  };
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function safeApiPath(config, apiPath, query = {}) {
  const pathname = requiredText(apiPath, 'Search API path', 1024);
  if (!pathname.startsWith('/') || /[?#\\\0]/.test(pathname) || pathname.split('/').some((segment) => segment === '.' || segment === '..')) throw new TypeError('Search API path is invalid.');
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
  const suffix = entries.length ? `?${new URLSearchParams(entries.map(([key, value]) => [requiredText(key, 'Search query key', 100), String(value)])).toString()}` : '';
  return `${config.basePath}${pathname}${suffix}`;
}

async function readTlsFile(file, label) {
  if (!file) return undefined;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_TLS_FILE_BYTES) throw new Error('invalid TLS file');
    return await fs.readFile(file);
  } catch {
    throw new DatabaseAdapterError('SEARCH_TLS_FILE_INVALID', `${label} is unavailable or invalid.`, { category: 'configuration' });
  }
}

function authorizationHeader(config, credential) {
  const value = String(credential ?? '');
  if (!value || value.includes('\0') || /[\r\n]/.test(value) || value.length > 16384) throw new DatabaseAdapterError('SEARCH_CREDENTIAL_INVALID', 'Search cluster credentials cannot be represented safely.', { category: 'authentication' });
  if (config.authMode === 'basic') return `Basic ${Buffer.from(`${config.username}:${value}`, 'utf8').toString('base64')}`;
  if (/\s/.test(value)) throw new DatabaseAdapterError('SEARCH_CREDENTIAL_INVALID', 'Search cluster token credentials cannot contain whitespace.', { category: 'authentication' });
  return `${config.authMode === 'api-key' ? 'ApiKey' : 'Bearer'} ${value}`;
}

async function defaultTransport({ config, method = 'GET', apiPath, query, authorization, body, signal }) {
  const [ca, cert, key] = await Promise.all([
    readTlsFile(config.caFile, 'Search TLS CA file'),
    readTlsFile(config.clientCertificateFile, 'Search TLS client certificate file'),
    readTlsFile(config.clientKeyFile, 'Search TLS client key file')
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
      protocol: 'https:', hostname: config.host, port: config.port, method,
      path: safeApiPath(config, apiPath, query),
      headers: {
        accept: 'application/json',
        authorization,
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {})
      },
      ca, cert, key, rejectUnauthorized: true, servername: net.isIP(config.host) ? undefined : config.host, agent: false
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new DatabaseAdapterError('SEARCH_RESPONSE_TOO_LARGE', 'Search cluster returned an oversized response.', { category: 'integrity' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const statusCode = Number(response.statusCode || 0);
        const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')]));
        if (statusCode >= 300 && statusCode < 400) return finish(reject, new DatabaseAdapterError('SEARCH_REDIRECT_REFUSED', 'Search cluster redirects are not allowed.', { category: 'connectivity' }));
        if (statusCode < 200 || statusCode >= 300) {
          const code = statusCode === 401 ? 'SEARCH_AUTHENTICATION_FAILED' : statusCode === 403 ? 'SEARCH_PRIVILEGE_MISSING' : statusCode === 404 ? 'SEARCH_API_UNAVAILABLE' : statusCode === 429 ? 'SEARCH_RATE_LIMITED' : 'SEARCH_REQUEST_FAILED';
          const category = statusCode === 401 ? 'authentication' : statusCode === 403 ? 'authorization' : statusCode === 429 ? 'unavailable' : 'connectivity';
          return finish(reject, new DatabaseAdapterError(code, statusCode === 401 ? 'Search cluster authentication failed.' : statusCode === 403 ? 'The search account lacks a required snapshot privilege.' : statusCode === 429 ? 'The search cluster is temporarily rate limited.' : 'The search cluster request failed.', { category, retryable: statusCode === 429 || statusCode >= 500 }));
        }
        const contentType = headers['content-type'] || '';
        if (!/^application\/(?:json|[^;]+[+]json)(?:;|$)/i.test(contentType)) return finish(reject, new DatabaseAdapterError('SEARCH_CONTENT_TYPE_INVALID', 'Search cluster returned a non-JSON response.', { category: 'integrity' }));
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); }
        catch { return finish(reject, new DatabaseAdapterError('SEARCH_RESPONSE_INVALID', 'Search cluster returned invalid JSON.', { category: 'integrity' })); }
        return finish(resolve, { statusCode, headers, body: parsed });
      });
    });
    request.setTimeout(config.timeoutMs, () => request.destroy(new DatabaseAdapterError('SEARCH_OPERATION_TIMEOUT', 'Search cluster request timed out.', { category: 'timeout', retryable: true })));
    request.on('error', (error) => finish(reject, error));
    const onAbort = () => request.destroy(new DatabaseAdapterError('SEARCH_OPERATION_CANCELED', 'Search cluster request was canceled.', { category: 'canceled' }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (payload) request.write(payload);
    request.end();
  });
}

function parseVersion(value, product) {
  const text = requiredText(value, 'Search server version', 100);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text);
  if (!match) throw new DatabaseAdapterError('SEARCH_VERSION_INVALID', 'Search cluster returned an invalid server version.', { category: 'compatibility' });
  const version = { text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  const supported = product === 'elasticsearch' ? version.major >= 7 && (version.major > 7 || version.minor >= 17) && version.major < 10 : version.major >= 1 && version.major < 4;
  if (!supported) throw new DatabaseAdapterError('SEARCH_VERSION_UNSUPPORTED', `${product === 'elasticsearch' ? 'Elasticsearch' : 'OpenSearch'} ${text} is not supported.`, { category: 'compatibility' });
  return version;
}

function detectProduct(root, headers = {}) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new DatabaseAdapterError('SEARCH_IDENTITY_INVALID', 'Search cluster returned an invalid identity response.', { category: 'integrity' });
  const distribution = String(root.version?.distribution || '').toLowerCase();
  const tagline = String(root.tagline || '');
  if (distribution === 'opensearch' || /OpenSearch Project/i.test(tagline)) return 'opensearch';
  if (String(headers['x-elastic-product'] || '').toLowerCase() === 'elasticsearch' || /You Know, for Search/i.test(tagline) || String(root.version?.build_flavor || '').toLowerCase() === 'default') return 'elasticsearch';
  throw new DatabaseAdapterError('SEARCH_PRODUCT_UNSUPPORTED', 'The endpoint is not a supported Elasticsearch or OpenSearch cluster.', { category: 'compatibility' });
}

function safeRepositorySettings(value, depth = 0) {
  if (depth > 8 || value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.length <= 1024 && !UNSAFE_REPOSITORY_VALUE.test(value) ? value : undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeRepositorySettings(item, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.keys(value).sort().slice(0, 100).filter((key) => !UNSAFE_REPOSITORY_KEY.test(key)).map((key) => [key, safeRepositorySettings(value[key], depth + 1)]).filter(([, item]) => item !== undefined));
}

function normalizeRepositories(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DatabaseAdapterError('SEARCH_REPOSITORIES_INVALID', 'Search repository discovery returned an invalid response.', { category: 'integrity' });
  const entries = Object.entries(input);
  if (entries.length > MAX_REPOSITORIES) throw new DatabaseAdapterError('SEARCH_REPOSITORY_LIMIT_EXCEEDED', 'Search cluster exposes too many snapshot repositories.', { category: 'integrity' });
  return entries.map(([rawName, raw]) => {
    const name = requiredText(rawName, 'Search repository name', 255);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('SEARCH_REPOSITORIES_INVALID', 'Search repository discovery returned invalid repository metadata.', { category: 'integrity' });
    const type = requiredText(raw.type, 'Search repository type', 100).toLowerCase();
    const settings = safeRepositorySettings(raw.settings || {}) || {};
    const readOnly = settings.readonly === true || String(settings.readonly || settings.read_only || '').toLowerCase() === 'true';
    const settingsFingerprint = stableDigest(settings);
    return {
      kind: 'snapshot-repository', name, type, readOnly, selectable: !readOnly,
      settingsFingerprint,
      repositoryFingerprint: stableDigest({ name, type, readOnly, settingsFingerprint }),
      settingsKeys: Object.keys(settings).slice(0, 100),
      locationIdentity: stableDigest({ type, location: settings.location || null, bucket: settings.bucket || null, container: settings.container || null, basePath: settings.base_path || null })
    };
  }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
}

function normalizeHealth(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DatabaseAdapterError('SEARCH_HEALTH_INVALID', 'Search cluster returned invalid health metadata.', { category: 'integrity' });
  const status = String(input.status || '').toLowerCase();
  if (!['green', 'yellow', 'red'].includes(status) || input.timed_out === true) throw new DatabaseAdapterError('SEARCH_HEALTH_INVALID', 'Search cluster health could not be verified.', { category: 'integrity' });
  const integer = (value, label) => {
    const number = Number(value ?? 0);
    if (!Number.isSafeInteger(number) || number < 0) throw new DatabaseAdapterError('SEARCH_HEALTH_INVALID', `${label} is invalid.`, { category: 'integrity' });
    return number;
  };
  return {
    status,
    nodeCount: integer(input.number_of_nodes, 'Search node count'),
    dataNodeCount: integer(input.number_of_data_nodes, 'Search data-node count'),
    activePrimaryShards: integer(input.active_primary_shards, 'Search active primary-shard count'),
    initializingShards: integer(input.initializing_shards, 'Search initializing-shard count'),
    unassignedShards: integer(input.unassigned_shards, 'Search unassigned-shard count')
  };
}

function normalizeSnapshotStatus(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.snapshots)) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_STATUS_INVALID', 'Search snapshot status could not be verified.', { category: 'integrity' });
  if (input.snapshots.length > 1000) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_STATUS_INVALID', 'Search cluster reports too many active snapshots.', { category: 'integrity' });
  return {
    activeSnapshots: input.snapshots.length,
    items: input.snapshots.map((item) => ({
      repository: requiredText(item?.repository, 'Active snapshot repository', 255),
      snapshot: requiredText(item?.snapshot, 'Active snapshot name', 255),
      state: optionalText(item?.state, 'Active snapshot state', 40)?.toUpperCase() || 'IN_PROGRESS'
    }))
  };
}

function normalizeIndexSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DatabaseAdapterError('SEARCH_RESOURCES_INVALID', 'Search index settings discovery returned an invalid response.', { category: 'integrity' });
  if (Object.keys(input).length > MAX_RESOURCES) throw new DatabaseAdapterError('SEARCH_RESOURCE_LIMIT_EXCEEDED', 'Search cluster exposes too many indices.', { category: 'integrity' });
  return Object.fromEntries(Object.entries(input).map(([rawName, raw]) => {
    const name = requiredText(rawName, 'Search index name', 255);
    const settings = raw?.settings || {};
    const value = (key) => settings[key] ?? settings.index?.[key.replace(/^index[.]/, '')];
    const uuid = requiredText(value('index.uuid'), 'Search index UUID', 255);
    const shards = Number(value('index.number_of_shards'));
    if (!Number.isInteger(shards) || shards < 1 || shards > 100000) throw new DatabaseAdapterError('SEARCH_RESOURCES_INVALID', 'Search index shard metadata is invalid.', { category: 'integrity' });
    return [name, {
      uuid,
      primaryShards: shards,
      creationDateMs: optionalText(value('index.creation_date'), 'Search index creation date', 40),
      hidden: String(value('index.hidden') || '').toLowerCase() === 'true'
    }];
  }));
}

function normalizeResolvedResources(resolved, rawSettings, product) {
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved) || !Array.isArray(resolved.indices) || !Array.isArray(resolved.data_streams)) throw new DatabaseAdapterError('SEARCH_RESOURCES_INVALID', 'Search resource discovery returned an invalid response.', { category: 'integrity' });
  const settings = normalizeIndexSettings(rawSettings);
  if (resolved.indices.length + resolved.data_streams.length > MAX_RESOURCES) throw new DatabaseAdapterError('SEARCH_RESOURCE_LIMIT_EXCEEDED', 'Search cluster exposes too many selectable resources.', { category: 'integrity' });
  const items = [];
  const seen = new Set();
  for (const raw of resolved.indices) {
    const name = requiredText(raw?.name, 'Search index name', 255);
    const metadata = settings[name];
    if (!metadata) throw new DatabaseAdapterError('SEARCH_RESOURCES_INVALID', 'Search index UUID metadata is incomplete.', { category: 'integrity' });
    const attributes = Array.isArray(raw.attributes) ? raw.attributes.slice(0, 20).map((item) => String(item).toLowerCase()) : [];
    const dataStream = optionalText(raw.data_stream, 'Search backing data-stream name', 255);
    const system = name.startsWith('.');
    const closed = attributes.includes('closed');
    const selectable = !system && !closed && !dataStream;
    const key = `index\0${name}`;
    if (seen.has(key)) throw new DatabaseAdapterError('SEARCH_RESOURCES_INVALID', 'Search resource discovery returned duplicate indices.', { category: 'integrity' });
    seen.add(key);
    items.push({
      kind: 'search-index', name, uuid: metadata.uuid, primaryShards: metadata.primaryShards,
      creationDateMs: metadata.creationDateMs, aliases: Array.isArray(raw.aliases) ? [...new Set(raw.aliases.map((item) => requiredText(item, 'Search alias name', 255)))].sort() : [],
      hidden: metadata.hidden || attributes.includes('hidden'), system, closed, dataStream, selectable,
      state: closed ? 'closed' : selectable ? 'available' : dataStream ? 'backing-index' : product === 'elasticsearch' ? 'feature-state-required' : 'system-excluded'
    });
  }
  for (const raw of resolved.data_streams) {
    const name = requiredText(raw?.name, 'Search data-stream name', 255);
    const backingIndices = Array.isArray(raw.backing_indices) ? raw.backing_indices.map((item) => requiredText(typeof item === 'string' ? item : item?.name, 'Search backing index name', 255)) : items.filter((item) => item.dataStream === name).map((item) => item.name);
    if (!backingIndices.length || backingIndices.some((index) => !settings[index])) throw new DatabaseAdapterError('SEARCH_RESOURCES_INVALID', 'Search data-stream backing-index metadata is incomplete.', { category: 'integrity' });
    const key = `data-stream\0${name}`;
    if (seen.has(key)) throw new DatabaseAdapterError('SEARCH_RESOURCES_INVALID', 'Search resource discovery returned duplicate data streams.', { category: 'integrity' });
    seen.add(key);
    items.push({
      kind: 'search-data-stream', name, uuid: stableDigest({ name, backingIndices: backingIndices.map((index) => settings[index].uuid) }),
      primaryShards: backingIndices.reduce((total, index) => total + settings[index].primaryShards, 0),
      backingIndices: backingIndices.slice().sort(), hidden: name.startsWith('.'), system: name.startsWith('.'), closed: false,
      selectable: !name.startsWith('.'), state: name.startsWith('.') ? product === 'elasticsearch' ? 'feature-state-required' : 'system-excluded' : 'available'
    });
  }
  return items.sort((left, right) => left.name.localeCompare(right.name, 'en-US') || left.kind.localeCompare(right.kind, 'en-US'));
}

function normalizeFeatureStates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.features)) throw new DatabaseAdapterError('SEARCH_FEATURES_INVALID', 'Search feature-state discovery returned an invalid response.', { category: 'integrity' });
  if (input.features.length > 1000) throw new DatabaseAdapterError('SEARCH_FEATURES_INVALID', 'Search cluster exposes too many feature states.', { category: 'integrity' });
  return input.features.map((item) => ({ kind: 'feature-state', name: requiredText(item?.name, 'Search feature-state name', 255), description: optionalText(item?.description, 'Search feature-state description', 500), selectable: true })).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
}

function normalizeExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DatabaseAdapterError('SEARCH_EXECUTION_INVALID', 'Search snapshot execution settings are invalid.', { category: 'configuration' });
  const repositoryName = requiredText(input.repositoryName, 'Search snapshot repository name', 255);
  const repositoryFingerprint = requiredText(input.repositoryFingerprint, 'Search snapshot repository fingerprint', 100);
  if (!/^sha256:[0-9a-f]{64}$/.test(repositoryFingerprint)) throw new DatabaseAdapterError('SEARCH_EXECUTION_INVALID', 'Search snapshot repository fingerprint is invalid.', { category: 'configuration' });
  const featureStates = Array.isArray(input.featureStates) ? [...new Set(input.featureStates.map((item) => requiredText(item, 'Search feature-state name', 255)))].sort() : [];
  if (featureStates.length > 1000) throw new DatabaseAdapterError('SEARCH_EXECUTION_INVALID', 'Too many search feature states are selected.', { category: 'configuration' });
  return {
    repositoryName,
    repositoryFingerprint,
    includeGlobalState: Boolean(input.includeGlobalState),
    featureStates,
    executionId: optionalText(input.executionId, 'Search snapshot execution ID', 200),
    sourceId: optionalText(input.sourceId, 'Search snapshot Source ID', 200),
    workspaceId: optionalText(input.workspaceId, 'Search snapshot workspace ID', 200)
  };
}

function normalizeRestorePrefix(value) {
  const prefix = requiredText(value, 'Search restore prefix', MAX_RESTORE_PREFIX_LENGTH).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*-$/.test(prefix) || prefix === '.' || prefix === '..') throw new DatabaseAdapterError('SEARCH_RESTORE_PREFIX_INVALID', 'Search restore prefix must use lowercase letters, numbers, hyphens, or underscores and end with a hyphen.', { category: 'validation' });
  return prefix;
}

function selectedSnapshotNames(metadata = {}) {
  if (!Array.isArray(metadata.selectedResources) || !metadata.selectedResources.length || metadata.selectedResources.length > MAX_RESOURCES) throw new DatabaseAdapterError('SEARCH_RECOVERY_METADATA_INVALID', 'Search recovery metadata does not contain a bounded resource selection.', { category: 'integrity' });
  return [...new Set(metadata.selectedResources.map((item) => requiredText(item?.name, 'Search recovery resource name', 255)))].sort();
}

function exactSnapshotMembership(metadata = {}) {
  const resources = Array.isArray(metadata.selectedResources) ? metadata.selectedResources : [];
  return {
    indices: [...new Set(resources.flatMap((item) => item?.kind === 'search-data-stream' ? (item.backingIndices || []) : [item?.name]).map((name) => requiredText(name, 'Search snapshot index', 255)))].sort(),
    dataStreams: [...new Set(resources.filter((item) => item?.kind === 'search-data-stream').map((item) => requiredText(item.name, 'Search snapshot data stream', 255)))].sort()
  };
}

function assertRecoverySnapshot(record, metadata = {}, options = {}) {
  const snapshot = metadata.snapshot || {};
  const repository = metadata.repository || {};
  if (record.state !== 'SUCCESS' || record.snapshot !== snapshot.name || (snapshot.uuid && record.uuid !== snapshot.uuid)) throw new DatabaseAdapterError('SEARCH_RECOVERY_SNAPSHOT_CHANGED', 'The native search snapshot no longer matches the selected recovery point.', { category: 'integrity' });
  const expected = exactSnapshotMembership(metadata);
  const featureStates = Array.isArray(metadata.featureStates) ? metadata.featureStates.slice().sort() : [];
  if (JSON.stringify(record.indices) !== JSON.stringify(expected.indices) || JSON.stringify(record.dataStreams) !== JSON.stringify(expected.dataStreams) || JSON.stringify(record.featureStates) !== JSON.stringify(featureStates) || record.includeGlobalState !== Boolean(metadata.includeGlobalState)) throw new DatabaseAdapterError('SEARCH_RECOVERY_SNAPSHOT_CHANGED', 'The native search snapshot membership no longer matches the authenticated recovery metadata.', { category: 'integrity' });
  if (record.shards.total < 1 || record.shards.successful !== record.shards.total || record.shards.failed !== 0 || record.failures !== 0) throw new DatabaseAdapterError('SEARCH_RECOVERY_SNAPSHOT_INCOMPLETE', 'The native search snapshot does not contain every expected primary shard.', { category: 'integrity' });
  if (record.metadata?.deployerx_adapter !== ADAPTER_ID || record.metadata?.deployerx_plan_digest !== metadata.planDigest) throw new DatabaseAdapterError('SEARCH_RECOVERY_SNAPSHOT_OWNERSHIP_CHANGED', 'The native search snapshot ownership metadata does not match the recovery point.', { category: 'integrity' });
  if (options.executionId && record.metadata?.deployerx_run_id !== options.executionId) throw new DatabaseAdapterError('SEARCH_RECOVERY_SNAPSHOT_OWNERSHIP_CHANGED', 'The native search snapshot run identity does not match the recovery point.', { category: 'integrity' });
  if (options.sourceId && record.metadata?.deployerx_source_id !== options.sourceId) throw new DatabaseAdapterError('SEARCH_RECOVERY_SNAPSHOT_OWNERSHIP_CHANGED', 'The native search snapshot Source identity does not match the recovery point.', { category: 'integrity' });
  if (options.workspaceId && record.metadata?.deployerx_workspace_digest !== stableDigest(options.workspaceId)) throw new DatabaseAdapterError('SEARCH_RECOVERY_SNAPSHOT_OWNERSHIP_CHANGED', 'The native search snapshot workspace identity does not match the recovery point.', { category: 'integrity' });
  if (!repository.repositoryName || !repository.locationIdentity || !repository.type) throw new DatabaseAdapterError('SEARCH_RECOVERY_METADATA_INVALID', 'Search recovery repository metadata is incomplete.', { category: 'integrity' });
  return record;
}

function restoreCompatibility(product, snapshotVersion, targetVersion) {
  if (product !== targetVersion.product) throw new DatabaseAdapterError('SEARCH_RESTORE_PRODUCT_INCOMPATIBLE', 'Cross-product Elasticsearch and OpenSearch restore is unavailable.', { category: 'compatibility' });
  const snapshot = parseVersion(snapshotVersion, product);
  if (targetVersion.major < snapshot.major || targetVersion.major > snapshot.major + 1) throw new DatabaseAdapterError('SEARCH_RESTORE_VERSION_INCOMPATIBLE', 'The target search version is outside the supported native snapshot restore range.', { category: 'compatibility' });
  return { snapshotVersion: snapshot.text, targetVersion: targetVersion.text, sameMajor: snapshot.major === targetVersion.major };
}

function normalizeResolveResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DatabaseAdapterError('SEARCH_RESTORE_CONFLICT_PROBE_INVALID', 'Search target conflict discovery returned an invalid response.', { category: 'integrity' });
  const names = [];
  for (const key of ['indices', 'aliases', 'data_streams']) {
    const values = input[key];
    if (!Array.isArray(values)) throw new DatabaseAdapterError('SEARCH_RESTORE_CONFLICT_PROBE_INVALID', 'Search target conflict discovery returned incomplete results.', { category: 'integrity' });
    for (const item of values) names.push(requiredText(item?.name, 'Search target conflict name', 255));
  }
  return [...new Set(names)].sort();
}

function normalizeSnapshotRecord(input, expected = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.snapshots) || input.snapshots.length !== 1) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_IDENTITY_INVALID', 'Search snapshot lookup returned an invalid result.', { category: 'integrity' });
  const raw = input.snapshots[0];
  const snapshot = requiredText(raw?.snapshot, 'Search snapshot name', 255);
  if (expected.snapshot && snapshot !== expected.snapshot) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_IDENTITY_CHANGED', 'Search snapshot identity changed during execution.', { category: 'integrity' });
  const state = requiredText(raw?.state, 'Search snapshot state', 40).toUpperCase();
  const indices = Array.isArray(raw.indices) ? [...new Set(raw.indices.map((item) => requiredText(item, 'Search snapshot index', 255)))].sort() : [];
  const dataStreams = Array.isArray(raw.data_streams) ? [...new Set(raw.data_streams.map((item) => requiredText(item, 'Search snapshot data stream', 255)))].sort() : [];
  const featureStates = Array.isArray(raw.feature_states) ? [...new Set(raw.feature_states.map((item) => requiredText(typeof item === 'string' ? item : item?.feature_name, 'Search snapshot feature state', 255)))].sort() : [];
  const shards = raw.shards || {};
  const shardNumber = (value, label) => {
    const number = Number(value ?? 0);
    if (!Number.isSafeInteger(number) || number < 0) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_IDENTITY_INVALID', `${label} is invalid.`, { category: 'integrity' });
    return number;
  };
  return {
    snapshot,
    uuid: optionalText(raw.uuid, 'Search snapshot UUID', 255),
    state,
    version: optionalText(raw.version, 'Search snapshot version', 100),
    indices,
    dataStreams,
    featureStates,
    includeGlobalState: Boolean(raw.include_global_state),
    metadata: raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? raw.metadata : {},
    shards: { total: shardNumber(shards.total, 'Search snapshot total shard count'), successful: shardNumber(shards.successful, 'Search snapshot successful shard count'), failed: shardNumber(shards.failed, 'Search snapshot failed shard count') },
    startTimeMs: shardNumber(raw.start_time_in_millis, 'Search snapshot start time'),
    endTimeMs: shardNumber(raw.end_time_in_millis, 'Search snapshot end time'),
    failures: Array.isArray(raw.failures) ? raw.failures.length : 0
  };
}

function snapshotName(executionId, timestamp) {
  const id = requiredText(executionId, 'Search snapshot execution ID', 200);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new DatabaseAdapterError('SEARCH_EXECUTION_INVALID', 'Search snapshot execution timestamp is invalid.', { category: 'integrity' });
  const stamp = date.toISOString().replace(/[-:.]/g, '').replace(/[.]\d{3}Z$/, 'z').toLowerCase();
  return `deployerx-${stamp}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
}

function globalMetadataWriteBlocked(input) {
  const globalBlocks = input && typeof input === 'object' && !Array.isArray(input) ? input.blocks?.global : null;
  if (!globalBlocks || typeof globalBlocks !== 'object' || Array.isArray(globalBlocks)) return false;
  return Object.values(globalBlocks).some((block) => Array.isArray(block?.levels) && block.levels.some((level) => ['all', 'write', 'metadata_write'].includes(String(level).toLowerCase())));
}

function deploymentFingerprint(identity) {
  return stableDigest({ product: identity.product, clusterUuid: identity.clusterUuid, clusterName: identity.clusterName });
}

function validateIdentity(config, identity) {
  if (config.expectedProduct !== 'auto' && config.expectedProduct !== identity.product) throw new DatabaseAdapterError('SEARCH_PRODUCT_MISMATCH', 'The endpoint product does not match the approved search connection.', { category: 'integrity' });
  if (config.expectedClusterUuid && config.expectedClusterUuid !== identity.clusterUuid) throw new DatabaseAdapterError('SEARCH_CLUSTER_IDENTITY_CHANGED', 'The search cluster UUID no longer matches the approved connection.', { category: 'integrity' });
  return identity;
}

function safeAdapterError(error) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error?.name === 'AbortError') return new DatabaseAdapterError('SEARCH_OPERATION_CANCELED', 'Search cluster request was canceled.', { category: 'canceled' });
  if (/certificate|tls|ssl|hostname/i.test(String(error?.code || error?.message || ''))) return new DatabaseAdapterError('SEARCH_TLS_FAILED', 'Search cluster TLS certificate identity verification failed.', { category: 'connectivity' });
  return new DatabaseAdapterError('SEARCH_CONNECT_FAILED', 'DeployerX could not complete the authenticated search cluster request.', { category: 'connectivity', retryable: true });
}

class SearchSnapshotAdapter {
  constructor({ transport = defaultTransport, clock = () => new Date().toISOString(), now = () => Date.now(), delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), maximumSnapshotWaitMs = MAX_SNAPSHOT_WAIT_MS } = {}) {
    if (typeof transport !== 'function') throw new TypeError('Search snapshot transport is required.');
    this.transport = transport;
    this.clock = clock;
    this.now = now;
    this.delay = delay;
    this.maximumSnapshotWaitMs = Math.min(MAX_SNAPSHOT_WAIT_MS, Math.max(1000, Number(maximumSnapshotWaitMs) || MAX_SNAPSHOT_WAIT_MS));
  }

  manifest() {
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      displayName: 'Elasticsearch / OpenSearch Snapshot',
      engine: 'search-cluster',
      executionReady: true,
      serverVersionRange: 'Elasticsearch >=7.17 <10; OpenSearch >=1 <4',
      restoreVersionRange: 'Native snapshot compatibility gates apply',
      capabilities: {
        backupMethods: ['physical'],
        backupModes: ['native'],
        selection: { database: true, schema: false, table: false, globalObjects: true },
        consistencyStrategies: [{ id: 'search-native-snapshot', produces: 'crash', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: true }],
        transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null },
        streaming: { backup: false, restore: false, compression: false, encryption: false },
        restore: { alternateTarget: true, nativeValidation: true },
        replicaAware: true
      },
      requiredTools: [],
      requiredPrivileges: [
        { id: 'search-snapshot-monitor', operations: ['discovery'], required: true, safeDescription: 'List native snapshot repositories and current snapshot status.' },
        { id: 'search-repository-verify', operations: ['backup'], required: true, safeDescription: 'Verify and use the selected native snapshot repository.' },
        { id: 'search-snapshot-manage', operations: ['backup', 'restore'], required: false, safeDescription: 'Create, monitor, delete, and restore owned native snapshots.' }
      ]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'SEARCH_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async #request(context, config, apiPath, options = {}) {
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('SEARCH_SECRET_RESOLVER_MISSING', 'Search cluster credentials are unavailable.', { category: 'authentication' });
    const credential = await context.resolveSecret(config.credentialSecretRefId);
    try {
      return await this.transport({ config, apiPath, method: options.method || 'GET', query: options.query || {}, body: options.body, authorization: authorizationHeader(config, credential), signal: context.signal });
    } catch (error) { throw safeAdapterError(error); }
  }

  async readIdentity(context = {}, input = {}) {
    const config = normalizeConfig(input);
    const [rootResponse, healthResponse, repositoriesResponse, snapshotStatusResponse, blocksResponse] = await Promise.all([
      this.#request(context, config, '/'),
      this.#request(context, config, '/_cluster/health', { query: { filter_path: 'cluster_name,status,timed_out,number_of_nodes,number_of_data_nodes,active_primary_shards,initializing_shards,unassigned_shards' } }),
      this.#request(context, config, '/_snapshot/_all'),
      this.#request(context, config, '/_snapshot/_status'),
      this.#request(context, config, '/_cluster/state/blocks', { query: { filter_path: 'cluster_uuid,blocks.global' } })
    ]);
    const product = detectProduct(rootResponse.body, rootResponse.headers);
    const version = parseVersion(rootResponse.body?.version?.number, product);
    const clusterUuid = requiredText(rootResponse.body?.cluster_uuid, 'Search cluster UUID', 200);
    if (clusterUuid === '_na_') throw new DatabaseAdapterError('SEARCH_CLUSTER_IDENTITY_INVALID', 'Search cluster UUID is unavailable.', { category: 'integrity' });
    const clusterName = requiredText(rootResponse.body?.cluster_name, 'Search cluster name', 255);
    const identity = {
      product,
      version,
      clusterUuid,
      clusterName,
      health: normalizeHealth(healthResponse.body),
      repositories: normalizeRepositories(repositoriesResponse.body),
      snapshotStatus: normalizeSnapshotStatus(snapshotStatusResponse.body),
      globalMetadataWriteBlocked: globalMetadataWriteBlocked(blocksResponse.body),
      capabilities: { featureStates: product === 'elasticsearch' && (version.major > 7 || version.minor >= 12), dataStreams: true, repositoryAnalysis: product === 'elasticsearch' }
    };
    return validateIdentity(config, identity);
  }

  async readResources(context = {}, input = {}) {
    const config = normalizeConfig(input);
    const identity = await this.readIdentity(context, config);
    const [resolved, settings] = await Promise.all([
      this.#request(context, config, '/_resolve/index/*', { query: { expand_wildcards: 'all' } }),
      this.#request(context, config, '/_all/_settings/index.uuid,index.creation_date,index.number_of_shards,index.hidden', { query: { expand_wildcards: 'all', flat_settings: 'true' } })
    ]);
    return { identity, resources: normalizeResolvedResources(resolved.body, settings.body, identity.product) };
  }

  async readFeatureStates(context = {}, input = {}) {
    const config = normalizeConfig(input);
    const identity = await this.readIdentity(context, config);
    if (!identity.capabilities.featureStates) throw new DatabaseAdapterError('SEARCH_FEATURE_STATES_UNAVAILABLE', 'Feature-state discovery is unavailable for this search product or version.', { category: 'compatibility' });
    const response = await this.#request(context, config, '/_features');
    return { identity, features: normalizeFeatureStates(response.body) };
  }

  async verifyRepository(context = {}, input = {}) {
    const config = normalizeConfig(input.connection);
    const repositoryName = requiredText(input.repositoryName, 'Search snapshot repository name', 255);
    const identity = await this.readIdentity(context, config);
    const repository = identity.repositories.find((item) => item.name === repositoryName);
    if (!repository) throw new DatabaseAdapterError('SEARCH_REPOSITORY_MISSING', 'The selected search snapshot repository is unavailable.', { category: 'configuration' });
    if (repository.readOnly) throw new DatabaseAdapterError('SEARCH_REPOSITORY_READ_ONLY', 'The selected search snapshot repository is read-only.', { category: 'configuration' });
    if (input.repositoryFingerprint && repository.repositoryFingerprint !== input.repositoryFingerprint) throw new DatabaseAdapterError('SEARCH_REPOSITORY_IDENTITY_CHANGED', 'The search snapshot repository identity changed.', { category: 'integrity' });
    const response = await this.#request(context, config, `/_snapshot/${encodeURIComponent(repositoryName)}/_verify`, { method: 'POST' });
    if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body) || !response.body.nodes || typeof response.body.nodes !== 'object' || Array.isArray(response.body.nodes)) throw new DatabaseAdapterError('SEARCH_REPOSITORY_VERIFICATION_INVALID', 'Search repository verification returned an invalid response.', { category: 'integrity' });
    const nodes = Object.entries(response.body.nodes);
    if (!nodes.length || nodes.length > 1000) throw new DatabaseAdapterError('SEARCH_REPOSITORY_VERIFICATION_FAILED', 'Search repository verification did not succeed on any cluster node.', { category: 'unavailable', retryable: true });
    return {
      version: 1,
      repositoryName,
      repositoryFingerprint: repository.repositoryFingerprint,
      settingsFingerprint: repository.settingsFingerprint,
      locationIdentity: repository.locationIdentity,
      type: repository.type,
      readOnly: false,
      clusterUuid: identity.clusterUuid,
      product: identity.product,
      writerClusterUuid: identity.clusterUuid,
      verifiedAt: this.clock(),
      verificationNodeCount: nodes.length,
      verificationNodeFingerprint: stableDigest(nodes.map(([id, node]) => [id, optionalText(node?.name, 'Search verification node name', 255)]).sort())
    };
  }

  async #resolveSelection(context, config, selector, execution) {
    const { identity, resources } = await this.readResources(context, config);
    const childRules = (selector?.schemas?.include?.length || 0) + (selector?.schemas?.exclude?.length || 0) + (selector?.tables?.include?.length || 0) + (selector?.tables?.exclude?.length || 0);
    if (childRules) throw new DatabaseAdapterError('SEARCH_SELECTION_INVALID', 'Search snapshot selection does not support schema or table rules.', { category: 'compatibility' });
    const selectable = new Map(resources.filter((item) => item.selectable).map((item) => [item.name, item]));
    const includeNames = selector?.allDatabases === true ? [...selectable.keys()] : (selector?.databases?.include || []).map((item) => item.name);
    const excluded = new Set((selector?.databases?.exclude || []).map((item) => item.name));
    const selectedNames = [...new Set(includeNames)].filter((name) => !excluded.has(name)).sort();
    if (!selectedNames.length) throw new DatabaseAdapterError('SEARCH_SELECTION_EMPTY', 'Search snapshot selection does not contain any open regular resources.', { category: 'configuration' });
    const missing = selectedNames.find((name) => !selectable.has(name));
    if (missing) throw new DatabaseAdapterError('SEARCH_SELECTION_CHANGED', 'A selected search index or data stream is unavailable, closed, or requires feature-state protection.', { category: 'integrity' });
    const selectedResources = selectedNames.map((name) => selectable.get(name));
    let featureStates = [];
    if (execution.featureStates.length) {
      if (!identity.capabilities.featureStates) throw new DatabaseAdapterError('SEARCH_FEATURE_STATES_UNAVAILABLE', 'Feature states are unavailable for this search product or version.', { category: 'compatibility' });
      const discovered = await this.#request(context, config, '/_features');
      const available = new Set(normalizeFeatureStates(discovered.body).map((item) => item.name));
      if (execution.featureStates.some((name) => !available.has(name))) throw new DatabaseAdapterError('SEARCH_FEATURE_SELECTION_CHANGED', 'A selected Elasticsearch feature state is unavailable.', { category: 'integrity' });
      featureStates = execution.featureStates.slice();
    }
    if (execution.includeGlobalState && identity.product === 'opensearch') throw new DatabaseAdapterError('SEARCH_GLOBAL_STATE_UNAVAILABLE', 'OpenSearch global state is excluded by the BM-409 security contract.', { category: 'compatibility' });
    return { identity, selectedResources, featureStates };
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const config = normalizeConfig(input);
      const identity = await this.readIdentity(context, config);
      const productName = identity.product === 'elasticsearch' ? 'Elasticsearch' : 'OpenSearch';
      return {
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'success',
        checks: [
          { id: 'authentication', status: 'pass', safeMessage: 'Search cluster authentication and snapshot discovery succeeded.' },
          { id: 'tls', status: 'pass', safeMessage: 'TLS certificate identity verification is required.' },
          { id: 'product-version', status: 'pass', safeMessage: `${productName} ${identity.version.text} is supported.` },
          { id: 'cluster-identity', status: 'pass', safeMessage: 'The authenticated cluster UUID was verified.' },
          { id: 'cluster-health', status: identity.health.status === 'green' ? 'pass' : 'warning', safeMessage: identity.health.status === 'green' ? 'Cluster health is green.' : `Cluster health is ${identity.health.status}; backup preflight will require all selected primary shards.` },
          { id: 'snapshot-privileges', status: 'pass', safeMessage: 'Snapshot repository listing and status probes succeeded.' },
          { id: 'global-metadata', status: identity.globalMetadataWriteBlocked ? 'warning' : 'pass', safeMessage: identity.globalMetadataWriteBlocked ? 'Global metadata writes are currently blocked.' : 'Global metadata is not write-blocked.' }
        ],
        remotePlatform: { engine: identity.product, version: identity.version.text, distribution: productName, platform: null },
        endpointIdentity: {
          deploymentFingerprint: deploymentFingerprint(identity),
          product: identity.product,
          clusterUuid: identity.clusterUuid,
          clusterName: identity.clusterName,
          health: identity.health.status,
          nodeCount: identity.health.nodeCount,
          dataNodeCount: identity.health.dataNodeCount,
          repositoryCount: identity.repositories.length,
          activeSnapshots: identity.snapshotStatus.activeSnapshots,
          featureStatesSupported: identity.capabilities.featureStates,
          repositoryAnalysisSupported: identity.capabilities.repositoryAnalysis
        },
        error: null
      };
    } catch (error) {
      const safe = safeAdapterError(error);
      return { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'failure', checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null } };
    }
  }

  async *discover(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const kind = String(request.kind || 'repositories').toLowerCase();
    if (kind === 'repositories') {
      const identity = await this.readIdentity(context, config);
      yield { items: identity.repositories, nextCursor: null, clusterUuid: identity.clusterUuid, product: identity.product };
      return;
    }
    if (kind === 'features') {
      const { identity, features } = await this.readFeatureStates(context, config);
      yield { items: features, nextCursor: null, clusterUuid: identity.clusterUuid, product: identity.product };
      return;
    }
    if (kind === 'resources') {
      const { identity, resources } = await this.readResources(context, config);
      yield { items: resources, nextCursor: null, clusterUuid: identity.clusterUuid, product: identity.product };
      return;
    }
    throw new DatabaseAdapterError('SEARCH_DISCOVERY_KIND_UNSUPPORTED', 'Search discovery kind is unsupported.', { category: 'compatibility' });
  }

  async preflight(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const execution = normalizeExecution(request.execution);
    const repositoryTrust = await this.verifyRepository(context, { connection: config, repositoryName: execution.repositoryName, repositoryFingerprint: execution.repositoryFingerprint });
    const resolved = await this.#resolveSelection(context, config, request.selector || {}, execution);
    const identity = resolved.identity;
    if (identity.health.status === 'red') throw new DatabaseAdapterError('SEARCH_CLUSTER_RED', 'Search cluster health is red; snapshot execution is unsafe.', { category: 'unavailable', retryable: true });
    if (identity.globalMetadataWriteBlocked) throw new DatabaseAdapterError('SEARCH_GLOBAL_METADATA_BLOCKED', 'Search cluster global metadata writes are blocked.', { category: 'configuration' });
    if (identity.snapshotStatus.items.some((item) => item.repository === execution.repositoryName)) throw new DatabaseAdapterError('SEARCH_REPOSITORY_BUSY', 'The selected search snapshot repository already has an active snapshot.', { category: 'unavailable', retryable: true });
    return {
      checkedAt: this.clock(),
      serverVersion: identity.version.text,
      serverVersionSupported: true,
      serverIdentityFingerprint: deploymentFingerprint(identity),
      consistency: [{ method: 'search-native-snapshot', verified: true, produces: 'crash' }],
      tools: [],
      privileges: [
        { id: 'search-snapshot-monitor', allowed: true, evidence: 'Repository listing and current snapshot status succeeded.' },
        { id: 'search-repository-verify', allowed: true, evidence: `Repository verification succeeded on ${repositoryTrust.verificationNodeCount} nodes.` }
      ],
      coordinateCaptureVerified: true,
      warnings: identity.health.status === 'yellow' ? ['Cluster health is yellow; selected primary shards are available, but replica allocation is incomplete.'] : [],
      metadata: {
        product: identity.product,
        clusterUuid: identity.clusterUuid,
        clusterName: identity.clusterName,
        health: identity.health,
        repository: repositoryTrust,
        selectedResources: resolved.selectedResources,
        featureStates: resolved.featureStates,
        includeGlobalState: execution.includeGlobalState,
        snapshotSemantics: { logicallyFull: true, physicallyIncremental: true, partial: false }
      }
    };
  }

  async planBackup(_context = {}, request = {}) {
    if (request.consistency?.proven !== true || request.consistency?.method !== 'search-native-snapshot' || request.consistency?.achievedLevel !== 'crash' || request.consistency?.backupMethod !== 'physical' || request.consistency?.backupMode !== 'native' || request.consistency?.captureCoordinates !== true) throw new DatabaseAdapterError('SEARCH_CONSISTENCY_PLAN_INVALID', 'Search backup requires a proven native snapshot plan with start/end coordinates.', { category: 'integrity' });
    const execution = normalizeExecution(request.execution);
    if (!execution.executionId) throw new DatabaseAdapterError('SEARCH_EXECUTION_INVALID', 'Search snapshot execution requires a run identity.', { category: 'integrity' });
    const metadata = request.consistency.evidence?.metadata || {};
    if (metadata.repository?.repositoryFingerprint !== execution.repositoryFingerprint || metadata.clusterUuid !== request.connection.expectedClusterUuid) throw new DatabaseAdapterError('SEARCH_PLAN_IDENTITY_INVALID', 'Search snapshot plan identity does not match the approved connection and repository.', { category: 'integrity' });
    const name = snapshotName(execution.executionId, request.consistency.evidence.checkedAt);
    return {
      version: 1,
      operation: 'search-native-snapshot',
      connection: normalizeConfig(request.connection),
      execution,
      selector: request.selector,
      consistency: request.consistency,
      repository: metadata.repository,
      product: metadata.product,
      clusterUuid: metadata.clusterUuid,
      selectedResources: metadata.selectedResources,
      featureStates: metadata.featureStates || [],
      includeGlobalState: metadata.includeGlobalState === true,
      snapshotName: name,
      snapshotPlanFingerprint: stableDigest({ clusterUuid: metadata.clusterUuid, repository: metadata.repository.repositoryFingerprint, name, selectedResources: metadata.selectedResources.map((item) => [item.kind, item.name, item.uuid]), featureStates: metadata.featureStates || [], includeGlobalState: metadata.includeGlobalState === true }),
      artifact: { kind: 'metadata', path: 'search/snapshot-metadata.json', mediaType: 'application/vnd.deployerx.search-snapshot+json' },
      resumable: false
    };
  }

  async #readSnapshot(context, config, repositoryName, name) {
    const response = await this.#request(context, config, `/_snapshot/${encodeURIComponent(repositoryName)}/${encodeURIComponent(name)}`);
    return normalizeSnapshotRecord(response.body, { snapshot: name });
  }

  #assertOwnedSnapshot(record, plan, planDigest) {
    if (record.metadata?.deployerx_run_id !== plan.execution.executionId || record.metadata?.deployerx_plan_digest !== planDigest || record.metadata?.deployerx_adapter !== ADAPTER_ID) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_OWNERSHIP_CHANGED', 'Search snapshot ownership metadata does not match this run.', { category: 'integrity' });
    if (plan.execution.sourceId && record.metadata?.deployerx_source_id !== plan.execution.sourceId) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_OWNERSHIP_CHANGED', 'Search snapshot Source ownership metadata does not match this run.', { category: 'integrity' });
    if (plan.execution.workspaceId && record.metadata?.deployerx_workspace_digest !== stableDigest(plan.execution.workspaceId)) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_OWNERSHIP_CHANGED', 'Search snapshot workspace ownership metadata does not match this run.', { category: 'integrity' });
  }

  async #deleteOwnedSnapshot(context, plan, planDigest) {
    let record;
    try { record = await this.#readSnapshot({ ...context, signal: undefined }, plan.connection, plan.execution.repositoryName, plan.snapshotName); }
    catch (error) {
      if (error.code === 'SEARCH_API_UNAVAILABLE') return { absent: true };
      throw error;
    }
    this.#assertOwnedSnapshot(record, plan, planDigest);
    await this.#request({ ...context, signal: undefined }, plan.connection, `/_snapshot/${encodeURIComponent(plan.execution.repositoryName)}/${encodeURIComponent(plan.snapshotName)}`, { method: 'DELETE' });
    const deadline = this.now() + Math.min(this.maximumSnapshotWaitMs, 5 * 60 * 1000);
    while (this.now() <= deadline) {
      try {
        const current = await this.#readSnapshot({ ...context, signal: undefined }, plan.connection, plan.execution.repositoryName, plan.snapshotName);
        this.#assertOwnedSnapshot(current, plan, planDigest);
      } catch (error) {
        if (error.code === 'SEARCH_API_UNAVAILABLE') return { absent: true };
        throw error;
      }
      await this.delay(250);
    }
    throw new DatabaseAdapterError('SEARCH_SNAPSHOT_CLEANUP_UNPROVEN', 'Search snapshot deletion could not be proven.', { category: 'integrity' });
  }

  async executeBackup(context = {}, plan = {}) {
    if (plan.operation !== 'search-native-snapshot') throw new DatabaseAdapterError('SEARCH_PLAN_INVALID', 'Search snapshot execution plan is invalid.', { category: 'integrity' });
    const planDigest = requiredText(context.planDigest, 'Search snapshot plan digest', 100);
    const identity = await this.readIdentity(context, plan.connection);
    if (deploymentFingerprint(identity) !== plan.consistency.evidence.serverIdentityFingerprint || identity.clusterUuid !== plan.clusterUuid) throw new DatabaseAdapterError('SEARCH_CLUSTER_IDENTITY_CHANGED', 'Search cluster identity changed before snapshot creation.', { category: 'integrity' });
    const repository = identity.repositories.find((item) => item.name === plan.execution.repositoryName);
    if (!repository || repository.readOnly || repository.repositoryFingerprint !== plan.execution.repositoryFingerprint) throw new DatabaseAdapterError('SEARCH_REPOSITORY_IDENTITY_CHANGED', 'Search snapshot repository identity changed before execution.', { category: 'integrity' });
    if (identity.snapshotStatus.items.some((item) => item.repository === plan.execution.repositoryName)) throw new DatabaseAdapterError('SEARCH_REPOSITORY_BUSY', 'The selected search snapshot repository already has an active snapshot.', { category: 'unavailable', retryable: true });
    const owner = {
      version: 1, adapterId: ADAPTER_ID, clusterUuid: plan.clusterUuid,
      repositoryName: plan.execution.repositoryName, repositoryFingerprint: plan.execution.repositoryFingerprint,
      snapshotName: plan.snapshotName, executionId: plan.execution.executionId, sourceId: plan.execution.sourceId,
      workspaceId: plan.execution.workspaceId, planDigest
    };
    if (typeof context.onOwnership === 'function') await context.onOwnership(owner);
    let created = false;
    try {
      const indices = plan.selectedResources.map((item) => item.name).join(',');
      const body = {
        indices,
        ignore_unavailable: false,
        include_global_state: plan.includeGlobalState,
        partial: false,
        metadata: {
          deployerx_run_id: plan.execution.executionId,
          deployerx_plan_digest: planDigest,
          deployerx_adapter: ADAPTER_ID,
          deployerx_snapshot_plan: plan.snapshotPlanFingerprint,
          ...(plan.execution.sourceId ? { deployerx_source_id: plan.execution.sourceId } : {}),
          ...(plan.execution.workspaceId ? { deployerx_workspace_digest: stableDigest(plan.execution.workspaceId) } : {})
        },
        ...(plan.featureStates.length ? { feature_states: plan.featureStates } : {})
      };
      const response = await this.#request(context, plan.connection, `/_snapshot/${encodeURIComponent(plan.execution.repositoryName)}/${encodeURIComponent(plan.snapshotName)}`, { method: 'PUT', query: { wait_for_completion: 'false' }, body });
      if (response.body?.accepted !== true) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_NOT_ACCEPTED', 'Search cluster did not accept the native snapshot.', { category: 'execution' });
      created = true;
      const deadline = this.now() + this.maximumSnapshotWaitMs;
      let record = null;
      while (this.now() <= deadline) {
        if (context.signal?.aborted) throw new DatabaseAdapterError('SEARCH_OPERATION_CANCELED', 'Search snapshot execution was canceled.', { category: 'canceled' });
        record = await this.#readSnapshot(context, plan.connection, plan.execution.repositoryName, plan.snapshotName);
        this.#assertOwnedSnapshot(record, plan, planDigest);
        if (record.state === 'SUCCESS') break;
        if (['PARTIAL', 'FAILED', 'INCOMPATIBLE'].includes(record.state)) throw new DatabaseAdapterError(`SEARCH_SNAPSHOT_${record.state}`, `Search snapshot ended in ${record.state} state.`, { category: record.state === 'INCOMPATIBLE' ? 'compatibility' : 'integrity' });
        if (!['IN_PROGRESS', 'STARTED'].includes(record.state)) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_STATE_INVALID', 'Search snapshot entered an unsupported state.', { category: 'integrity' });
        await this.delay(500);
      }
      if (!record || record.state !== 'SUCCESS') throw new DatabaseAdapterError('SEARCH_SNAPSHOT_TIMEOUT', 'Search snapshot did not complete before the operation deadline.', { category: 'timeout', retryable: true });
      if (record.shards.total < 1 || record.shards.successful !== record.shards.total || record.shards.failed !== 0 || record.failures !== 0) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_SHARDS_INCOMPLETE', 'Search snapshot did not protect every selected primary shard.', { category: 'integrity' });
      const expectedIndices = plan.selectedResources.flatMap((item) => item.kind === 'search-data-stream' ? item.backingIndices : [item.name]).sort();
      const expectedDataStreams = plan.selectedResources.filter((item) => item.kind === 'search-data-stream').map((item) => item.name).sort();
      if (JSON.stringify(record.indices) !== JSON.stringify(expectedIndices) || JSON.stringify(record.dataStreams) !== JSON.stringify(expectedDataStreams) || JSON.stringify(record.featureStates) !== JSON.stringify(plan.featureStates.slice().sort()) || record.includeGlobalState !== plan.includeGlobalState) throw new DatabaseAdapterError('SEARCH_SNAPSHOT_MEMBERSHIP_MISMATCH', 'Search snapshot membership does not match the immutable plan.', { category: 'integrity' });
      const finalIdentity = await this.readIdentity(context, plan.connection);
      if (deploymentFingerprint(finalIdentity) !== plan.consistency.evidence.serverIdentityFingerprint) throw new DatabaseAdapterError('SEARCH_CLUSTER_IDENTITY_CHANGED', 'Search cluster identity changed after snapshot creation.', { category: 'integrity' });
      const result = {
        version: 1,
        kind: 'search-native-snapshot',
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        product: plan.product,
        serverVersion: identity.version.text,
        clusterUuid: plan.clusterUuid,
        clusterName: identity.clusterName,
        repository: plan.repository,
        snapshot: { name: record.snapshot, uuid: record.uuid, state: record.state, version: record.version, startTimeMs: record.startTimeMs, endTimeMs: record.endTimeMs, shards: record.shards },
        selectedResources: plan.selectedResources,
        featureStates: plan.featureStates,
        includeGlobalState: plan.includeGlobalState,
        sourceId: plan.execution.sourceId,
        workspaceDigest: plan.execution.workspaceId ? stableDigest(plan.execution.workspaceId) : null,
        consistency: plan.consistency,
        snapshotSemantics: { logicallyFull: true, physicallyIncremental: true, partial: false },
        planDigest,
        snapshotPlanFingerprint: plan.snapshotPlanFingerprint,
        nativeResponseDigest: stableDigest({ snapshot: record.snapshot, uuid: record.uuid, state: record.state, version: record.version, indices: record.indices, dataStreams: record.dataStreams, featureStates: record.featureStates, includeGlobalState: record.includeGlobalState, shards: record.shards, startTimeMs: record.startTimeMs, endTimeMs: record.endTimeMs, metadata: record.metadata }),
        warnings: plan.consistency.evidence.warnings || []
      };
      if (typeof context.onOwnership === 'function') await context.onOwnership(null);
      return result;
    } catch (error) {
      if (created) {
        try { await this.#deleteOwnedSnapshot(context, plan, planDigest); if (typeof context.onOwnership === 'function') await context.onOwnership(null); }
        catch { throw new DatabaseAdapterError('SEARCH_SNAPSHOT_CLEANUP_UNPROVEN', 'Search snapshot failed and owned cleanup could not be proven.', { category: 'integrity' }); }
      } else if (typeof context.onOwnership === 'function') await context.onOwnership(null);
      throw safeAdapterError(error);
    }
  }

  async reconcileSnapshot(context = {}, input = {}) {
    const owner = input.owner || {};
    const connection = normalizeConfig(input.connection);
    const plan = {
      operation: 'search-native-snapshot', connection, clusterUuid: requiredText(owner.clusterUuid, 'Search owner cluster UUID', 200),
      execution: {
        repositoryName: requiredText(owner.repositoryName, 'Search owner repository', 255),
        repositoryFingerprint: requiredText(owner.repositoryFingerprint, 'Search owner repository fingerprint', 100),
        executionId: requiredText(owner.executionId, 'Search owner execution ID', 200),
        sourceId: optionalText(owner.sourceId, 'Search owner Source ID', 200),
        workspaceId: optionalText(owner.workspaceId, 'Search owner workspace ID', 200)
      },
      snapshotName: requiredText(owner.snapshotName, 'Search owner snapshot name', 255)
    };
    if (connection.expectedClusterUuid !== plan.clusterUuid) throw new DatabaseAdapterError('SEARCH_CLUSTER_IDENTITY_CHANGED', 'Search reconciliation connection does not match the owned cluster.', { category: 'integrity' });
    return this.#deleteOwnedSnapshot(context, plan, requiredText(owner.planDigest, 'Search owner plan digest', 100));
  }

  async inspectRecoverySnapshot(context = {}, input = {}) {
    const connection = normalizeConfig(input.connection);
    const metadata = input.metadata || {};
    const identity = await this.readIdentity(context, connection);
    if (identity.product !== metadata.product) throw new DatabaseAdapterError('SEARCH_RESTORE_PRODUCT_INCOMPATIBLE', 'Cross-product Elasticsearch and OpenSearch restore is unavailable.', { category: 'compatibility' });
    const repository = identity.repositories.find((item) => item.name === metadata.repository?.repositoryName);
    if (!repository || repository.type !== metadata.repository?.type || repository.locationIdentity !== metadata.repository?.locationIdentity) throw new DatabaseAdapterError('SEARCH_RECOVERY_REPOSITORY_CHANGED', 'The target cluster does not expose the exact native snapshot repository.', { category: 'integrity' });
    const record = await this.#readSnapshot(context, connection, repository.name, requiredText(metadata.snapshot?.name, 'Search recovery snapshot name', 255));
    assertRecoverySnapshot(record, metadata, input.owner || {});
    return { identity, repository, snapshot: record };
  }

  async deleteRecoverySnapshot(context = {}, input = {}) {
    const inspected = await this.inspectRecoverySnapshot(context, input);
    if (inspected.repository.readOnly) throw new DatabaseAdapterError('SEARCH_REPOSITORY_READ_ONLY', 'The native search repository is read-only on the deletion cluster.', { category: 'configuration' });
    if (inspected.identity.clusterUuid !== input.metadata?.clusterUuid) throw new DatabaseAdapterError('SEARCH_RETENTION_WRITER_CHANGED', 'Native snapshot retention must run on the approved writer cluster.', { category: 'authorization' });
    await this.#request({ ...context, signal: undefined }, normalizeConfig(input.connection), `/_snapshot/${encodeURIComponent(inspected.repository.name)}/${encodeURIComponent(inspected.snapshot.snapshot)}`, { method: 'DELETE' });
    try {
      await this.#readSnapshot({ ...context, signal: undefined }, normalizeConfig(input.connection), inspected.repository.name, inspected.snapshot.snapshot);
    } catch (error) {
      if (error.code === 'SEARCH_API_UNAVAILABLE') return { deleted: true, absent: true, snapshotName: inspected.snapshot.snapshot, deletedAt: this.clock() };
      throw error;
    }
    throw new DatabaseAdapterError('SEARCH_RETENTION_DELETE_UNCONFIRMED', 'The native search snapshot deletion was not confirmed.', { category: 'integrity', retryable: true });
  }

  async cleanupRepository(context = {}, input = {}) {
    const connection = normalizeConfig(input.connection);
    const repositoryName = requiredText(input.repositoryName, 'Search snapshot repository name', 255);
    if (input.confirmationText !== 'CLEANUP SEARCH REPOSITORY') throw new DatabaseAdapterError('SEARCH_REPOSITORY_CLEANUP_CONFIRMATION_REQUIRED', 'Confirm native search repository cleanup before continuing.', { category: 'conflict' });
    const identity = await this.readIdentity(context, connection);
    if (identity.snapshotStatus.activeSnapshots) throw new DatabaseAdapterError('SEARCH_REPOSITORY_BUSY', 'Native repository cleanup requires no active snapshots.', { category: 'unavailable', retryable: true });
    const verification = await this.verifyRepository(context, { connection, repositoryName, repositoryFingerprint: input.repositoryFingerprint });
    const response = await this.#request(context, connection, `/_snapshot/${encodeURIComponent(repositoryName)}/_cleanup`, { method: 'POST' });
    const deletedBytes = Number(response.body?.results?.deleted_bytes ?? response.body?.deleted_bytes ?? 0);
    const deletedBlobs = Number(response.body?.results?.deleted_blobs ?? response.body?.deleted_blobs ?? 0);
    if (!Number.isSafeInteger(deletedBytes) || deletedBytes < 0 || !Number.isSafeInteger(deletedBlobs) || deletedBlobs < 0) throw new DatabaseAdapterError('SEARCH_REPOSITORY_CLEANUP_INVALID', 'Native repository cleanup returned invalid evidence.', { category: 'integrity' });
    return { repositoryName, repositoryFingerprint: verification.repositoryFingerprint, deletedBytes, deletedBlobs, completedAt: this.clock() };
  }

  async planRestore(context = {}, request = {}) {
    const connection = normalizeConfig(request.connection);
    const metadata = request.metadata || {};
    const prefix = normalizeRestorePrefix(request.renamePrefix);
    const inspected = await this.inspectRecoverySnapshot(context, { connection, metadata, owner: request.owner });
    if (!inspected.repository.readOnly) throw new DatabaseAdapterError('SEARCH_RESTORE_REPOSITORY_WRITABLE', 'Register the native repository read-only on the alternate restore cluster.', { category: 'authorization' });
    if (inspected.identity.clusterUuid === metadata.clusterUuid) throw new DatabaseAdapterError('SEARCH_RESTORE_TARGET_NOT_ALTERNATE', 'Search recovery requires a separately tested alternate cluster.', { category: 'conflict' });
    const compatibility = restoreCompatibility(metadata.product, metadata.snapshot?.version || metadata.serverVersion, { ...inspected.identity.version, product: inspected.identity.product });
    const allNames = selectedSnapshotNames(metadata);
    const requestedNames = request.selectedResources === undefined ? allNames : [...new Set((Array.isArray(request.selectedResources) ? request.selectedResources : []).map((name) => requiredText(name, 'Search restore selection', 255)))].sort();
    if (!requestedNames.length || requestedNames.some((name) => !allNames.includes(name))) throw new DatabaseAdapterError('SEARCH_RESTORE_SELECTION_INVALID', 'Search restore selection is empty or outside the recovery point.', { category: 'validation' });
    const resources = metadata.selectedResources.filter((item) => requestedNames.includes(item.name));
    const preview = resources.map((item) => {
      const targetName = `${prefix}${item.name}`;
      if (targetName.length > 255) throw new DatabaseAdapterError('SEARCH_RESTORE_TARGET_NAME_INVALID', 'A renamed search restore target exceeds the native name limit.', { category: 'validation' });
      return { kind: item.kind, sourceName: item.name, targetName, primaryShards: Number(item.primaryShards || 0), aliases: (item.aliases || []).map((alias) => `${prefix}${alias}`) };
    });
    const conflictNames = [...new Set(preview.flatMap((item) => [item.targetName, ...item.aliases]))].sort();
    const conflictsResponse = await this.#request(context, connection, `/_resolve/index/${encodeURIComponent(conflictNames.join(','))}`, { query: { expand_wildcards: 'all' } });
    const conflicts = normalizeResolveResult(conflictsResponse.body);
    if (conflicts.length) throw new DatabaseAdapterError('SEARCH_RESTORE_TARGET_CONFLICT', 'One or more renamed search restore targets already exist.', { category: 'conflict', details: { firstConflict: conflicts[0], conflictCount: conflicts.length } });
    const featureStates = Array.isArray(request.featureStates) ? [...new Set(request.featureStates.map((name) => requiredText(name, 'Search restore feature state', 255)))].sort() : [];
    const availableFeatures = Array.isArray(metadata.featureStates) ? metadata.featureStates : [];
    if (featureStates.some((name) => !availableFeatures.includes(name)) || (inspected.identity.product === 'opensearch' && featureStates.length)) throw new DatabaseAdapterError('SEARCH_RESTORE_FEATURE_STATE_INVALID', 'The selected search feature state cannot be restored to this target.', { category: 'compatibility' });
    return {
      version: 1, operation: 'search-native-alternate-restore', connection, product: inspected.identity.product,
      sourceClusterUuid: metadata.clusterUuid, targetClusterUuid: inspected.identity.clusterUuid,
      repositoryName: inspected.repository.name, repositoryLocationIdentity: inspected.repository.locationIdentity,
      snapshotName: inspected.snapshot.snapshot, snapshotUuid: inspected.snapshot.uuid, metadata, compatibility,
      renamePrefix: prefix, selection: requestedNames, preview, featureStates, includeGlobalState: false,
      planDigest: stableDigest({ targetClusterUuid: inspected.identity.clusterUuid, repositoryLocationIdentity: inspected.repository.locationIdentity, snapshotUuid: inspected.snapshot.uuid, prefix, selection: requestedNames, featureStates })
    };
  }

  async executeRestore(context = {}, plan = {}) {
    if (plan.operation !== 'search-native-alternate-restore') throw new DatabaseAdapterError('SEARCH_RESTORE_PLAN_INVALID', 'Search restore plan is invalid.', { category: 'integrity' });
    const fresh = await this.planRestore(context, { connection: plan.connection, metadata: plan.metadata, renamePrefix: plan.renamePrefix, selectedResources: plan.selection, featureStates: plan.featureStates, owner: context.owner });
    if (fresh.planDigest !== plan.planDigest) throw new DatabaseAdapterError('SEARCH_RESTORE_PLAN_CHANGED', 'Search restore target state changed after planning.', { category: 'conflict' });
    const body = {
      indices: plan.selection.join(','), ignore_unavailable: false, include_global_state: false,
      include_aliases: plan.product === 'elasticsearch', rename_pattern: '(.+)', rename_replacement: `${plan.renamePrefix}$1`,
      ...(plan.product === 'elasticsearch' ? { rename_alias_pattern: '(.+)', rename_alias_replacement: `${plan.renamePrefix}$1` } : {}),
      ...(plan.featureStates.length ? { feature_states: plan.featureStates } : {})
    };
    const response = await this.#request(context, plan.connection, `/_snapshot/${encodeURIComponent(plan.repositoryName)}/${encodeURIComponent(plan.snapshotName)}/_restore`, { method: 'POST', query: { wait_for_completion: 'false' }, body });
    if (response.body?.accepted !== true && response.body?.acknowledged !== true) throw new DatabaseAdapterError('SEARCH_RESTORE_NOT_ACCEPTED', 'The alternate search cluster did not accept the native restore.', { category: 'execution' });
    const deadline = this.now() + this.maximumSnapshotWaitMs;
    while (this.now() <= deadline) {
      if (context.signal?.aborted) throw new DatabaseAdapterError('SEARCH_RESTORE_CANCELED', 'Search restore monitoring was canceled; already-created target indices were not deleted.', { category: 'canceled', details: { createdTargets: plan.preview.map((item) => item.targetName).join(',') } });
      const healthResponse = await this.#request(context, plan.connection, `/_cluster/health/${encodeURIComponent(plan.preview.map((item) => item.targetName).join(','))}`, { query: { wait_for_status: 'yellow', wait_for_no_initializing_shards: 'true', timeout: '5s' } });
      const health = normalizeHealth(healthResponse.body);
      if (health.status !== 'red' && health.initializingShards === 0) {
        return { version: 1, state: health.unassignedShards ? 'warning' : 'succeeded', planDigest: plan.planDigest, accepted: true, targetClusterUuid: plan.targetClusterUuid, preview: plan.preview, health, completedAt: this.clock(), cancellationRollbackSupported: false };
      }
      await this.delay(500);
    }
    throw new DatabaseAdapterError('SEARCH_RESTORE_TIMEOUT', 'Search restore did not recover every expected primary shard before the deadline.', { category: 'timeout', retryable: true });
  }

  async validateRestore(context = {}, request = {}) {
    const plan = request.plan || {};
    const result = request.result || {};
    if (!['succeeded', 'warning'].includes(result.state) || result.planDigest !== plan.planDigest || result.targetClusterUuid !== plan.targetClusterUuid) throw new DatabaseAdapterError('SEARCH_RESTORE_RESULT_INVALID', 'Search restore result does not match the immutable plan.', { category: 'integrity' });
    const discovered = await this.readResources(context, plan.connection);
    if (discovered.identity.clusterUuid !== plan.targetClusterUuid) throw new DatabaseAdapterError('SEARCH_CLUSTER_IDENTITY_CHANGED', 'Search restore target identity changed during validation.', { category: 'integrity' });
    const byName = new Map(discovered.resources.map((item) => [item.name, item]));
    for (const expected of plan.preview) {
      const actual = byName.get(expected.targetName);
      if (!actual || actual.kind !== expected.kind || actual.primaryShards !== expected.primaryShards) throw new DatabaseAdapterError('SEARCH_RESTORE_VALIDATION_FAILED', 'Restored search membership or primary-shard counts do not match the recovery plan.', { category: 'integrity' });
    }
    return {
      state: result.state, nativeIntegrityValidation: true, expectedObjects: 'pass', targetClusterUuid: plan.targetClusterUuid,
      restoredResources: plan.preview.map((item) => ({ kind: item.kind, sourceName: item.sourceName, targetName: item.targetName, primaryShards: item.primaryShards, targetUuid: byName.get(item.targetName).uuid })),
      aliases: plan.product === 'elasticsearch' ? 'renamed' : 'excluded', featureStates: plan.featureStates, globalStateRestored: false,
      replicaAllocation: result.health?.unassignedShards ? 'warning' : 'pass', validatedAt: this.clock()
    };
  }

  async deleteDrillResources(context = {}, input = {}) {
    const connection = normalizeConfig(input.connection);
    const expectedClusterUuid = requiredText(input.targetClusterUuid, 'Search drill target cluster UUID', 200);
    const resources = Array.isArray(input.resources) ? input.resources : [];
    if (!resources.length || resources.length > MAX_RESOURCES) throw new DatabaseAdapterError('SEARCH_DRILL_CLEANUP_INVALID', 'Search recovery drill cleanup has no bounded owned resource set.', { category: 'integrity' });
    const identity = await this.readResources(context, connection);
    if (identity.identity.clusterUuid !== expectedClusterUuid) throw new DatabaseAdapterError('SEARCH_CLUSTER_IDENTITY_CHANGED', 'Search recovery drill target identity changed before cleanup.', { category: 'integrity' });
    const byName = new Map(identity.resources.map((item) => [item.name, item]));
    for (const expected of resources) {
      const name = requiredText(expected.targetName, 'Search drill resource name', 255);
      const current = byName.get(name);
      if (!current || current.kind !== expected.kind || current.uuid !== expected.targetUuid) throw new DatabaseAdapterError('SEARCH_DRILL_CLEANUP_OWNERSHIP_CHANGED', 'Search recovery drill resource ownership could not be proven; no cleanup was attempted.', { category: 'authorization' });
    }
    const indices = resources.filter((item) => item.kind === 'search-index').map((item) => item.targetName).sort();
    const streams = resources.filter((item) => item.kind === 'search-data-stream').map((item) => item.targetName).sort();
    if (indices.length) await this.#request({ ...context, signal: undefined }, connection, `/${encodeURIComponent(indices.join(','))}`, { method: 'DELETE' });
    if (streams.length) await this.#request({ ...context, signal: undefined }, connection, `/_data_stream/${encodeURIComponent(streams.join(','))}`, { method: 'DELETE' });
    const names = resources.map((item) => item.targetName).sort();
    const response = await this.#request({ ...context, signal: undefined }, connection, `/_resolve/index/${encodeURIComponent(names.join(','))}`, { query: { expand_wildcards: 'all' } });
    if (normalizeResolveResult(response.body).length) throw new DatabaseAdapterError('SEARCH_DRILL_CLEANUP_UNPROVEN', 'Search recovery drill resource deletion could not be proven.', { category: 'cleanup', retryable: true });
    return { deleted: true, targetClusterUuid: expectedClusterUuid, resources: names, completedAt: this.clock() };
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class SearchSnapshotConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new SearchSnapshotAdapter() } = {}) {
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
    const name = requiredText(input.name, 'Search connection name', 200);
    const credential = String(input.credential ?? '');
    if (!credential || credential.includes('\0') || /[\r\n]/.test(credential) || credential.length > 16384) throw new TypeError('Search credential is invalid.');
    let credentialRef = null;
    try {
      credentialRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} search credential`, secretType: input.authMode === 'basic' ? 'password' : 'token', value: credential, scope: 'device' });
      const config = normalizeConfig({
        host: input.host, port: input.port, basePath: input.basePath, authMode: input.authMode, username: input.username,
        credentialSecretRefId: credentialRef.id, tlsMode: input.tlsMode, caFile: input.caFile,
        clientCertificateFile: input.clientCertificateFile, clientKeyFile: input.clientKeyFile,
        timeoutMs: input.timeoutMs, expectedProduct: input.expectedProduct, expectedClusterUuid: input.expectedClusterUuid
      });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(credentialRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device',
          endpoint: {
            host: config.host, port: config.port, basePath: config.basePath, authMode: config.authMode, username: config.username,
            tlsMode: config.tlsMode, caFile: config.caFile, clientCertificateFile: config.clientCertificateFile,
            clientKeyFile: config.clientKeyFile, timeoutMs: config.timeoutMs, expectedProduct: config.expectedProduct,
            expectedClusterUuid: config.expectedClusterUuid
          },
          secretRefIds: [credentialRef.id],
          trust: { mode: config.tlsMode, fingerprint: null },
          workerAffinity: [`device:${this.deviceId}`],
          lastTest: null
        });
      });
    } catch (error) {
      if (credentialRef) await this.secretStore.delete({ workspaceId: tenant, id: credentialRef.id }).catch(() => {});
      throw error;
    }
  }

  config(connection) {
    const [credentialSecretRefId] = connection.secretRefIds || [];
    return normalizeConfig({ ...connection.endpoint, credentialSecretRefId });
  }

  async test(workspaceId, connectionId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Search snapshot connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This search snapshot connection belongs to another device.');
    const result = normalizeConnectionTestResult(await this.adapter.testConnection({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }) }, this.config(current)), { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const endpoint = result.status === 'success' ? { ...current.endpoint, expectedProduct: result.endpointIdentity.product, expectedClusterUuid: result.endpointIdentity.clusterUuid } : current.endpoint;
    const trust = result.status === 'success' ? { mode: current.endpoint.tlsMode, fingerprint: result.endpointIdentity.deploymentFingerprint || null, observedAt: result.testedAt } : current.trust;
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { endpoint, lastTest: result, trust, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection, result };
  }

  async verifyRepository(workspaceId, connectionId, repositoryName, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Search snapshot connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This search snapshot connection belongs to another device.');
    if (current.lastTest?.status !== 'success' || !current.trust?.fingerprint) throw new Error('Test the search snapshot connection successfully before verifying a repository.');
    const verification = await this.adapter.verifyRepository({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }) }, { connection: this.config(current), repositoryName });
    if (verification.clusterUuid !== current.endpoint.expectedClusterUuid || current.trust.fingerprint !== stableDigest({ product: verification.product, clusterUuid: verification.clusterUuid, clusterName: current.lastTest.endpointIdentity.clusterName })) throw new DatabaseAdapterError('SEARCH_CLUSTER_IDENTITY_CHANGED', 'Search cluster identity changed during repository verification.', { category: 'integrity' });
    const repositoryTrusts = [...(Array.isArray(current.repositoryTrusts) ? current.repositoryTrusts : []).filter((item) => item.repositoryName !== verification.repositoryName), verification].sort((left, right) => left.repositoryName.localeCompare(right.repositoryName, 'en-US'));
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { repositoryTrusts }, { expectedRevision: current.revision, actorId });
    return { connection, verification };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Search snapshot connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This search snapshot connection belongs to another device.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the search snapshot connection successfully before discovery.');
    const pages = [];
    for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current), kind: input.kind })) pages.push(page);
    return pages[0] || { items: [], nextCursor: null };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SearchSnapshotAdapter,
  SearchSnapshotConnectionService,
  authorizationHeader,
  deploymentFingerprint,
  detectProduct,
  normalizeConfig,
  normalizeRepositories,
  parseVersion,
  safeApiPath
};
