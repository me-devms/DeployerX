const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { once } = require('events');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { InfluxDb3CoreAzureError, InfluxDb3CoreAzureStore, normalizeAzureCredential, normalizeCoreAzureConfig } = require('./influxdb3-core-azure');
const { InfluxDb3CoreGcsError, InfluxDb3CoreGcsStore, normalizeCoreGcsConfig, normalizeGcsCredential } = require('./influxdb3-core-gcs');
const { InfluxDb3CoreS3Error, InfluxDb3CoreS3Store, normalizeCoreS3Config } = require('./influxdb3-core-s3');
const { normalizeS3Credential } = require('./s3-repository');

const ADAPTER_ID = 'deployerx.database.influxdb3-core';
const ADAPTER_VERSION = '0.6.0';
const BIND_CONFIRMATION = 'BIND INFLUXDB CORE FILESYSTEM';
const S3_BIND_CONFIRMATION = 'BIND INFLUXDB CORE S3';
const AZURE_BIND_CONFIRMATION = 'BIND INFLUXDB CORE AZURE';
const GCS_BIND_CONFIRMATION = 'BIND INFLUXDB CORE GCS';
const RESTORE_CONFIRMATION = 'RESTORE INFLUXDB3 CORE ALTERNATE';
const CONSISTENCY_CONFIRMATIONS = Object.freeze({
  stopped: 'NODE IS STOPPED',
  'atomic-snapshot': 'USE ATOMIC SNAPSHOT',
  'ordered-live-copy': 'ACCEPT CRASH CONSISTENCY'
});
const CONSISTENCY_METHODS = Object.freeze({
  stopped: 'influxdb3-core-stopped',
  'atomic-snapshot': 'influxdb3-core-atomic-snapshot',
  'ordered-live-copy': 'influxdb3-core-ordered-copy'
});
const COPY_PHASES = Object.freeze([
  Object.freeze({ name: 'snapshots', kind: 'directory' }),
  Object.freeze({ name: 'dbs', kind: 'directory' }),
  Object.freeze({ name: 'wal', kind: 'directory' }),
  Object.freeze({ name: 'catalog', kind: 'directory' }),
  Object.freeze({ name: '_catalog_checkpoint', kind: 'file' })
]);
const RESTORE_PHASES = Object.freeze([...COPY_PHASES].reverse());
const MAX_FILES = 100000;
const MAX_DIRECTORIES = 50000;
const MAX_BYTES = 64 * 1024 * 1024 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TLS_FILE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

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
  const input = requiredText(value, 'InfluxDB 3 Core host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('InfluxDB 3 Core host must be a hostname or IP address without a URI scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('InfluxDB 3 Core host is invalid.');
  return ascii;
}

function normalizeBasePath(value) {
  const raw = optionalText(value, 'InfluxDB 3 Core base path', 512);
  if (!raw || raw === '/') return '';
  if (!raw.startsWith('/') || raw.endsWith('/') || /[?#\\\s]/.test(raw) || raw.includes('//')) throw new TypeError('InfluxDB 3 Core base path is invalid.');
  const segments = raw.slice(1).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) throw new TypeError('InfluxDB 3 Core base path is invalid.');
  return `/${segments.join('/')}`;
}

function normalizeAbsolutePath(value, label, options = {}) {
  const input = requiredText(value, label, 4096);
  if (!path.isAbsolute(input)) throw new TypeError(`${label} must be absolute.`);
  const normalized = path.resolve(input);
  if (options.rejectRoot && path.parse(normalized).root === normalized) throw new TypeError(`${label} cannot be a filesystem root.`);
  return normalized;
}

function normalizeNodeId(value) {
  const nodeId = requiredText(value, 'InfluxDB 3 Core node ID', 128);
  if (nodeId === '.' || nodeId === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) throw new TypeError('InfluxDB 3 Core node ID is invalid.');
  return nodeId;
}

function nodeRoot(config) {
  const root = path.resolve(config.dataRoot, config.nodeId);
  if (path.dirname(root) !== config.dataRoot) throw new TypeError('InfluxDB 3 Core node directory escapes the configured data root.');
  return root;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Core connection configuration must be an object.');
  const allowed = ['protocol', 'allowInsecureHttp', 'host', 'port', 'basePath', 'caFile', 'timeoutMs', 'objectStore', 'dataRoot', 'nodeId', 'filesystemBindingConfirmed', 's3BindingConfirmed', 'azureBindingConfirmed', 'gcsBindingConfirmed', 'objectStoreAccountName', 'objectStoreEndpoint', 'objectStoreRegion', 'objectStoreBucket', 'objectStorePrefix', 'objectStoreForcePathStyle', 'allowInsecureObjectStoreEndpoint', 'objectStoreTimeoutMs', 'objectStoreCredentialSecretRefId', 'expectedVersion', 'expectedDeploymentFingerprint', 'expectedStorageFingerprint'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Core connection field: ${unknown[0]}.`);
  const objectStore = String(input.objectStore || 'file').toLowerCase();
  if (!['file', 's3', 'azure', 'google'].includes(objectStore)) throw new TypeError('InfluxDB 3 Core supports only implemented filesystem, S3, Azure Blob, or GCS object-store bindings.');
  const protocol = String(input.protocol || 'https').toLowerCase();
  if (!['https', 'http'].includes(protocol)) throw new TypeError('InfluxDB 3 Core protocol is invalid.');
  const allowInsecureHttp = input.allowInsecureHttp === true;
  if (protocol === 'http' && !allowInsecureHttp) throw new TypeError('InfluxDB 3 Core HTTP requires explicit insecure-transport approval.');
  if (protocol === 'https' && allowInsecureHttp) throw new TypeError('InfluxDB 3 Core insecure-transport approval is valid only for HTTP.');
  const port = Number(input.port ?? 8181);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('InfluxDB 3 Core port must be between 1 and 65535.');
  const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('InfluxDB 3 Core timeout must be between 1 and 300 seconds.');
  const caFile = optionalText(input.caFile, 'InfluxDB 3 Core TLS CA file') ? normalizeAbsolutePath(input.caFile, 'InfluxDB 3 Core TLS CA file') : null;
  const common = {
    protocol, allowInsecureHttp, host: normalizeHost(input.host), port, basePath: normalizeBasePath(input.basePath),
    caFile: protocol === 'https' ? caFile : null, timeoutMs, nodeId: normalizeNodeId(input.nodeId),
    expectedVersion: optionalText(input.expectedVersion, 'Expected InfluxDB 3 Core version', 100),
    expectedDeploymentFingerprint: optionalText(input.expectedDeploymentFingerprint, 'Expected InfluxDB 3 Core deployment fingerprint', 80),
    expectedStorageFingerprint: optionalText(input.expectedStorageFingerprint, 'Expected InfluxDB 3 Core storage fingerprint', 80)
  };
  if (objectStore === 's3') {
    if (input.dataRoot !== undefined || input.filesystemBindingConfirmed !== undefined) throw new TypeError('InfluxDB 3 Core S3 bindings cannot include filesystem fields.');
    if (input.azureBindingConfirmed !== undefined || input.gcsBindingConfirmed !== undefined || input.objectStoreAccountName !== undefined) throw new TypeError('InfluxDB 3 Core S3 bindings cannot include Azure or GCS fields.');
    const storage = normalizeCoreS3Config({
      objectStore: 's3', endpoint: input.objectStoreEndpoint, region: input.objectStoreRegion, bucket: input.objectStoreBucket, prefix: input.objectStorePrefix,
      forcePathStyle: input.objectStoreForcePathStyle, allowInsecureEndpoint: input.allowInsecureObjectStoreEndpoint, timeoutMs: input.objectStoreTimeoutMs,
      credentialSecretRefId: input.objectStoreCredentialSecretRefId, nodeId: common.nodeId
    });
    if (input.s3BindingConfirmed !== true) throw new TypeError('InfluxDB 3 Core S3 binding requires explicit confirmation.');
    return Object.freeze({ ...common, objectStore: 's3', s3BindingConfirmed: true, objectStoreEndpoint: storage.endpoint, objectStoreRegion: storage.region, objectStoreBucket: storage.bucket, objectStorePrefix: storage.prefix, objectStoreForcePathStyle: storage.forcePathStyle, allowInsecureObjectStoreEndpoint: storage.allowInsecureEndpoint, objectStoreTimeoutMs: storage.timeoutMs, objectStoreCredentialSecretRefId: storage.credentialSecretRefId });
  }
  if (objectStore === 'azure') {
    if (input.dataRoot !== undefined || input.filesystemBindingConfirmed !== undefined) throw new TypeError('InfluxDB 3 Core Azure bindings cannot include filesystem fields.');
    if (input.s3BindingConfirmed !== undefined || input.gcsBindingConfirmed !== undefined || input.objectStoreRegion !== undefined || input.objectStoreForcePathStyle !== undefined) throw new TypeError('InfluxDB 3 Core Azure bindings cannot include S3 or GCS fields.');
    const storage = normalizeCoreAzureConfig({
      objectStore: 'azure', accountName: input.objectStoreAccountName, container: input.objectStoreBucket, endpoint: input.objectStoreEndpoint,
      prefix: input.objectStorePrefix, allowInsecureEndpoint: input.allowInsecureObjectStoreEndpoint, timeoutMs: input.objectStoreTimeoutMs,
      credentialSecretRefId: input.objectStoreCredentialSecretRefId, nodeId: common.nodeId
    });
    if (input.azureBindingConfirmed !== true) throw new TypeError('InfluxDB 3 Core Azure binding requires explicit confirmation.');
    return Object.freeze({ ...common, objectStore: 'azure', azureBindingConfirmed: true, objectStoreAccountName: storage.accountName, objectStoreEndpoint: storage.endpoint, objectStoreBucket: storage.container, objectStorePrefix: storage.prefix, allowInsecureObjectStoreEndpoint: storage.allowInsecureEndpoint, objectStoreTimeoutMs: storage.timeoutMs, objectStoreCredentialSecretRefId: storage.credentialSecretRefId });
  }
  if (objectStore === 'google') {
    if (input.dataRoot !== undefined || input.filesystemBindingConfirmed !== undefined) throw new TypeError('InfluxDB 3 Core GCS bindings cannot include filesystem fields.');
    if (input.s3BindingConfirmed !== undefined || input.azureBindingConfirmed !== undefined || input.objectStoreAccountName !== undefined || input.objectStoreEndpoint !== undefined || input.objectStoreRegion !== undefined || input.objectStoreForcePathStyle !== undefined || input.allowInsecureObjectStoreEndpoint !== undefined) throw new TypeError('InfluxDB 3 Core GCS bindings cannot include S3 or Azure fields.');
    const storage = normalizeCoreGcsConfig({
      objectStore: 'google', bucket: input.objectStoreBucket, prefix: input.objectStorePrefix, timeoutMs: input.objectStoreTimeoutMs,
      credentialSecretRefId: input.objectStoreCredentialSecretRefId, nodeId: common.nodeId
    });
    if (input.gcsBindingConfirmed !== true) throw new TypeError('InfluxDB 3 Core GCS binding requires explicit confirmation.');
    return Object.freeze({ ...common, objectStore: 'google', gcsBindingConfirmed: true, objectStoreBucket: storage.bucket, objectStorePrefix: storage.prefix, objectStoreTimeoutMs: storage.timeoutMs, objectStoreCredentialSecretRefId: storage.credentialSecretRefId });
  }
  const objectStoreFields = ['s3BindingConfirmed', 'azureBindingConfirmed', 'gcsBindingConfirmed', 'objectStoreAccountName', 'objectStoreEndpoint', 'objectStoreRegion', 'objectStoreBucket', 'objectStorePrefix', 'objectStoreForcePathStyle', 'allowInsecureObjectStoreEndpoint', 'objectStoreTimeoutMs', 'objectStoreCredentialSecretRefId'];
  if (objectStoreFields.some((field) => input[field] !== undefined)) throw new TypeError('InfluxDB 3 Core filesystem bindings cannot include object-store fields.');
  const config = { ...common, dataRoot: normalizeAbsolutePath(input.dataRoot, 'InfluxDB 3 Core data root', { rejectRoot: true }), filesystemBindingConfirmed: input.filesystemBindingConfirmed === true };
  if (!config.filesystemBindingConfirmed) throw new TypeError('InfluxDB 3 Core filesystem binding requires explicit confirmation.');
  nodeRoot(config);
  return Object.freeze(config);
}

function objectStoreType(config) { return config.objectStore || 'file'; }

function isRemoteObjectStore(objectStore) { return ['s3', 'azure', 'google'].includes(objectStore); }

function restoreSupported(objectStore) { return ['file', 's3', 'azure', 'google'].includes(objectStore); }

const RESTORE_OPERATIONS = Object.freeze({
  file: 'influxdb3-core-alternate-filesystem-restore',
  s3: 'influxdb3-core-alternate-s3-restore',
  azure: 'influxdb3-core-alternate-azure-restore',
  google: 'influxdb3-core-alternate-gcs-restore'
});

function restoreStoreFromOperation(operation) {
  return Object.entries(RESTORE_OPERATIONS).find(([, candidate]) => candidate === operation)?.[0] || null;
}

function objectStoreLabel(objectStore) {
  return objectStore === 's3' ? 'S3' : objectStore === 'azure' ? 'Azure Blob' : objectStore === 'google' ? 'GCS' : 'filesystem';
}

function coreS3StorageConfig(config) {
  return {
    objectStore: 's3', endpoint: config.objectStoreEndpoint, region: config.objectStoreRegion, bucket: config.objectStoreBucket, prefix: config.objectStorePrefix,
    forcePathStyle: config.objectStoreForcePathStyle, allowInsecureEndpoint: config.allowInsecureObjectStoreEndpoint, timeoutMs: config.objectStoreTimeoutMs,
    credentialSecretRefId: config.objectStoreCredentialSecretRefId, nodeId: config.nodeId
  };
}

function coreAzureStorageConfig(config) {
  return {
    objectStore: 'azure', accountName: config.objectStoreAccountName, container: config.objectStoreBucket, endpoint: config.objectStoreEndpoint,
    prefix: config.objectStorePrefix, allowInsecureEndpoint: config.allowInsecureObjectStoreEndpoint, timeoutMs: config.objectStoreTimeoutMs,
    credentialSecretRefId: config.objectStoreCredentialSecretRefId, nodeId: config.nodeId
  };
}

function coreGcsStorageConfig(config) {
  return {
    objectStore: 'google', bucket: config.objectStoreBucket, prefix: config.objectStorePrefix, timeoutMs: config.objectStoreTimeoutMs,
    credentialSecretRefId: config.objectStoreCredentialSecretRefId, nodeId: config.nodeId
  };
}

function databaseObjectStoreError(error, fallbackCode = 'INFLUXDB3_CORE_OBJECT_STORE_OPERATION_FAILED', fallbackMessage = 'The InfluxDB 3 Core object-store operation failed.') {
  if (error instanceof DatabaseAdapterError) return error;
  if (error instanceof InfluxDb3CoreS3Error || error instanceof InfluxDb3CoreAzureError || error instanceof InfluxDb3CoreGcsError) return new DatabaseAdapterError(error.code, error.message, { category: error.category, retryable: error.retryable, details: error.details });
  return new DatabaseAdapterError(fallbackCode, fallbackMessage, { category: error?.category || 'object-store', retryable: Boolean(error?.retryable) });
}

function parseVersion(value) {
  const match = /^v?(3)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(requiredText(value, 'InfluxDB 3 Core version', 100));
  if (!match) throw new DatabaseAdapterError('INFLUXDB3_CORE_VERSION_UNSUPPORTED', 'The endpoint is not a supported InfluxDB 3 Core release.', { category: 'compatibility' });
  return Object.freeze({ text: `${match[1]}.${match[2]}.${match[3]}`, major: 3, minor: Number(match[2]), patch: Number(match[3]) });
}

async function readTlsFile(file) {
  if (!file) return undefined;
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_TLS_FILE_BYTES) throw new DatabaseAdapterError('INFLUXDB3_CORE_TLS_FILE_INVALID', 'The InfluxDB 3 Core TLS CA file is unavailable or invalid.', { category: 'configuration' });
  return fs.readFile(file);
}

function pingPath(config) { return `${config.basePath}/ping`; }

async function defaultTransport({ config, signal }) {
  const ca = config.protocol === 'https' ? await readTlsFile(config.caFile) : undefined;
  const client = config.protocol === 'https' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const request = client.request({ protocol: `${config.protocol}:`, hostname: config.host, port: config.port, method: 'GET', path: pingPath(config), headers: { accept: 'application/json' }, agent: false, ...(config.protocol === 'https' ? { ca, rejectUnauthorized: true, servername: net.isIP(config.host) ? undefined : config.host } : {}) }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new DatabaseAdapterError('INFLUXDB3_CORE_RESPONSE_TOO_LARGE', 'InfluxDB 3 Core returned an oversized response.', { category: 'integrity' }));
        else chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, { statusCode: Number(response.statusCode || 0), headers: response.headers || {}, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.setTimeout(config.timeoutMs, () => request.destroy(new DatabaseAdapterError('INFLUXDB3_CORE_TIMEOUT', 'The InfluxDB 3 Core request timed out.', { category: 'timeout', retryable: true })));
    request.on('error', (error) => finish(reject, error instanceof DatabaseAdapterError ? error : new DatabaseAdapterError('INFLUXDB3_CORE_UNREACHABLE', 'The InfluxDB 3 Core endpoint is unreachable.', { category: 'connectivity', retryable: true })));
    const onAbort = () => request.destroy(new DatabaseAdapterError('INFLUXDB3_CORE_CANCELED', 'The InfluxDB 3 Core operation was canceled.', { category: 'canceled' }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    request.end();
  });
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry ? String(entry[1] ?? '').trim() : '';
}

function parsePing(response) {
  if (response?.statusCode !== 200) throw new DatabaseAdapterError('INFLUXDB3_CORE_PING_FAILED', 'InfluxDB 3 Core did not accept the product identity request.', { category: 'connectivity', retryable: response?.statusCode >= 500 });
  let body;
  try { body = JSON.parse(String(response.body || '')); }
  catch { throw new DatabaseAdapterError('INFLUXDB3_CORE_IDENTITY_INVALID', 'InfluxDB 3 Core returned invalid product identity.', { category: 'integrity' }); }
  const build = headerValue(response.headers, 'x-influxdb-build').toLowerCase();
  if (build !== 'core' || !body || typeof body !== 'object' || Array.isArray(body)) throw new DatabaseAdapterError('INFLUXDB3_CORE_PRODUCT_UNSUPPORTED', 'The endpoint is not InfluxDB 3 Core.', { category: 'compatibility' });
  const headerVersion = headerValue(response.headers, 'x-influxdb-version');
  const version = parseVersion(body.version);
  if (headerVersion && parseVersion(headerVersion).text !== version.text) throw new DatabaseAdapterError('INFLUXDB3_CORE_IDENTITY_INVALID', 'InfluxDB 3 Core returned inconsistent version identity.', { category: 'integrity' });
  return Object.freeze({ product: 'influxdb3-core', build: 'Core', version, revision: optionalText(body.revision, 'InfluxDB 3 Core revision', 200), processIdPresent: Boolean(optionalText(body.process_id, 'InfluxDB 3 Core process ID', 200)) });
}

function storageFingerprint(config, rootStat) {
  return stableDigest({ objectStore: 'file', dataRoot: config.dataRoot, nodeId: config.nodeId, nodeRoot: nodeRoot(config), device: String(rootStat.dev), inode: String(rootStat.ino), birthtimeMs: Math.trunc(rootStat.birthtimeMs || 0) });
}

function dataRootFingerprint(config, dataRootStat) {
  return stableDigest({ objectStore: 'file', dataRoot: config.dataRoot, device: String(dataRootStat.dev), inode: String(dataRootStat.ino), birthtimeMs: Math.trunc(dataRootStat.birthtimeMs || 0) });
}

function safeNodeRelativePath(value, label = 'InfluxDB 3 Core media path') {
  const relative = requiredText(value, label, 8192).replace(/\\/g, '/');
  if (relative.startsWith('/') || relative.endsWith('/') || relative.includes('//') || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..') || path.posix.normalize(relative) !== relative) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core recovery media contains an unsafe path.', { category: 'integrity' });
  if (!COPY_PHASES.some((phase) => relative === phase.name || (phase.kind === 'directory' && relative.startsWith(`${phase.name}/`)))) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core recovery media contains an unsupported component.', { category: 'integrity' });
  return relative;
}

async function phaseInventory(root, phase, counters) {
  const absolute = path.join(root, phase.name);
  const rootStat = await fs.lstat(absolute).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || (phase.kind === 'directory' ? !rootStat.isDirectory() : !rootStat.isFile())) throw new DatabaseAdapterError('INFLUXDB3_CORE_LAYOUT_INVALID', `InfluxDB 3 Core node storage is missing regular ${phase.name}.`, { category: 'integrity' });
  const directories = [];
  const files = [];
  if (phase.kind === 'file') files.push({ relativePath: phase.name, absolutePath: absolute, sizeBytes: rootStat.size, mtimeMs: rootStat.mtimeMs, ctimeMs: rootStat.ctimeMs, dev: String(rootStat.dev), ino: String(rootStat.ino) });
  else {
    directories.push(phase.name);
    const pending = [{ absolutePath: absolute, relativePath: phase.name }];
    while (pending.length) {
      const current = pending.pop();
      const entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US')).reverse()) {
        const child = path.join(current.absolutePath, entry.name);
        const relativePath = path.posix.join(current.relativePath, entry.name);
        const resolved = path.resolve(child);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new DatabaseAdapterError('INFLUXDB3_CORE_LAYOUT_INVALID', 'InfluxDB 3 Core storage contains an escaping path.', { category: 'integrity' });
        const stat = await fs.lstat(child);
        if (stat.isSymbolicLink()) throw new DatabaseAdapterError('INFLUXDB3_CORE_LINK_REFUSED', 'InfluxDB 3 Core filesystem backup refuses symbolic links.', { category: 'integrity' });
        if (stat.isDirectory()) { directories.push(relativePath); pending.push({ absolutePath: child, relativePath }); }
        else if (stat.isFile()) files.push({ relativePath, absolutePath: child, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: String(stat.dev), ino: String(stat.ino) });
        else throw new DatabaseAdapterError('INFLUXDB3_CORE_SPECIAL_FILE_REFUSED', 'InfluxDB 3 Core filesystem backup refuses special files.', { category: 'integrity' });
      }
    }
  }
  counters.directories += directories.length;
  counters.files += files.length;
  counters.bytes += files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (counters.directories > MAX_DIRECTORIES || counters.files > MAX_FILES || counters.bytes > MAX_BYTES) throw new DatabaseAdapterError('INFLUXDB3_CORE_STORAGE_LIMIT', 'InfluxDB 3 Core node storage exceeds the supported backup limits.', { category: 'capacity' });
  directories.sort((left, right) => left.localeCompare(right, 'en-US'));
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  const digest = stableDigest({ directories, files: files.map(({ relativePath, sizeBytes, mtimeMs, ctimeMs, dev, ino }) => ({ relativePath, sizeBytes, mtimeMs, ctimeMs, dev, ino })) });
  return { phase: phase.name, directories, files, digest };
}

async function inspectNodeLayout(configInput) {
  const config = normalizeConfig(configInput);
  const dataRootStat = await fs.lstat(config.dataRoot).catch(() => null);
  if (!dataRootStat || !dataRootStat.isDirectory() || dataRootStat.isSymbolicLink()) throw new DatabaseAdapterError('INFLUXDB3_CORE_LAYOUT_INVALID', 'The InfluxDB 3 Core data root is unavailable or unsafe.', { category: 'configuration' });
  const root = nodeRoot(config);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new DatabaseAdapterError('INFLUXDB3_CORE_LAYOUT_INVALID', 'The exact InfluxDB 3 Core node directory is unavailable or unsafe.', { category: 'configuration' });
  const supportedNames = new Set([...COPY_PHASES.map((phase) => phase.name), 'table-snapshots']);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const stat = await fs.lstat(path.join(root, entry.name));
    if (stat.isSymbolicLink()) throw new DatabaseAdapterError('INFLUXDB3_CORE_LINK_REFUSED', 'InfluxDB 3 Core filesystem backup refuses symbolic links.', { category: 'integrity' });
    if (!stat.isFile() && !stat.isDirectory()) throw new DatabaseAdapterError('INFLUXDB3_CORE_SPECIAL_FILE_REFUSED', 'InfluxDB 3 Core filesystem backup refuses special files.', { category: 'integrity' });
    if (!supportedNames.has(entry.name)) throw new DatabaseAdapterError('INFLUXDB3_CORE_LAYOUT_UNSUPPORTED', 'InfluxDB 3 Core node storage contains an unrecognized top-level component.', { category: 'compatibility', details: { component: entry.name } });
  }
  const tableSnapshots = await fs.lstat(path.join(root, 'table-snapshots')).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (tableSnapshots && (tableSnapshots.isSymbolicLink() || !tableSnapshots.isDirectory())) throw new DatabaseAdapterError('INFLUXDB3_CORE_LAYOUT_INVALID', 'InfluxDB 3 Core table-snapshots must be a regular directory when present.', { category: 'integrity' });
  const counters = { files: 0, directories: 0, bytes: 0 };
  const phases = [];
  for (const phase of COPY_PHASES) phases.push(await phaseInventory(root, phase, counters));
  return Object.freeze({ root, nodeId: config.nodeId, objectStore: 'file', dataRootFingerprint: dataRootFingerprint(config, dataRootStat), storageFingerprint: storageFingerprint(config, rootStat), fileCount: counters.files, directoryCount: counters.directories, totalBytes: counters.bytes, excluded: tableSnapshots ? ['table-snapshots/'] : [], phases, layoutFingerprint: stableDigest(phases.map(({ phase, digest }) => ({ phase, digest }))) });
}

async function inspectCapturedNodeRoot(rootInput) {
  const root = path.resolve(requiredText(rootInput, 'InfluxDB 3 Core captured node root'));
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'The captured InfluxDB 3 Core node root is unavailable or unsafe.', { category: 'integrity' });
  const supportedNames = new Set(COPY_PHASES.map((phase) => phase.name));
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const stat = await fs.lstat(path.join(root, entry.name));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || !supportedNames.has(entry.name)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'The captured InfluxDB 3 Core node contains an unsafe or unsupported component.', { category: 'integrity' });
  }
  const counters = { files: 0, directories: 0, bytes: 0 };
  const phases = [];
  for (const phase of COPY_PHASES) phases.push(await phaseInventory(root, phase, counters));
  return Object.freeze({ root, fileCount: counters.files, directoryCount: counters.directories, totalBytes: counters.bytes, phases });
}

function normalizeRestoreSource(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.product !== 'influxdb3-core' || !['file', 's3', 'azure', 'google'].includes(input.objectStore) || (['azure', 'google'].includes(input.objectStore) && input.restoreSupported !== true)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_SOURCE_INVALID', 'Authenticated InfluxDB 3 Core recovery evidence is invalid or is not approved for provider restore.', { category: 'integrity' });
  const members = Array.isArray(input.nativeMedia?.members) ? input.nativeMedia.members.map((raw) => {
    const relativePath = safeNodeRelativePath(raw.relativePath);
    if (COPY_PHASES.some((phase) => phase.kind === 'directory' && relativePath === phase.name)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core recovery file evidence collides with a required directory.', { category: 'integrity' });
    const sizeBytes = Number(raw.sizeBytes);
    const contentDigest = requiredText(raw.contentDigest, 'InfluxDB 3 Core member digest', 80);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^sha256:[0-9a-f]{64}$/.test(contentDigest)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core recovery member evidence is invalid.', { category: 'integrity' });
    return Object.freeze({ relativePath, sizeBytes, contentDigest });
  }) : [];
  const directories = Array.isArray(input.nativeMedia?.directories) ? input.nativeMedia.directories.map((value) => safeNodeRelativePath(value, 'InfluxDB 3 Core directory path')) : [];
  const directoryPhases = COPY_PHASES.filter((phase) => phase.kind === 'directory');
  if (!members.length || !members.some((item) => item.relativePath === '_catalog_checkpoint') || members.length > MAX_FILES || new Set(members.map((item) => item.relativePath)).size !== members.length || directories.length > MAX_DIRECTORIES || new Set(directories).size !== directories.length || directories.some((relative) => !directoryPhases.some((phase) => relative === phase.name || relative.startsWith(`${phase.name}/`))) || directoryPhases.some((phase) => !directories.includes(phase.name))) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core recovery media inventory is incomplete or duplicated.', { category: 'integrity' });
  members.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  directories.sort((left, right) => left.localeCompare(right, 'en-US'));
  const fileCount = Number(input.nativeMedia.fileCount); const directoryCount = Number(input.nativeMedia.directoryCount); const totalBytes = Number(input.nativeMedia.totalBytes);
  const mediaFingerprint = requiredText(input.nativeMedia.mediaFingerprint, 'InfluxDB 3 Core media fingerprint', 80);
  const directoryFingerprint = requiredText(input.nativeMedia.directoryFingerprint, 'InfluxDB 3 Core directory fingerprint', 80);
  if (fileCount !== members.length || directoryCount !== directories.length || totalBytes !== members.reduce((sum, item) => sum + item.sizeBytes, 0) || totalBytes > MAX_BYTES || mediaFingerprint !== stableDigest(members) || directoryFingerprint !== stableDigest(directories)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core aggregate recovery-media evidence is invalid.', { category: 'integrity' });
  return Object.freeze({ product: 'influxdb3-core', productVersion: parseVersion(input.productVersion).text, objectStore: input.objectStore, nodeId: normalizeNodeId(input.nodeId), deploymentFingerprint: requiredText(input.deploymentFingerprint, 'Protected InfluxDB 3 Core deployment fingerprint', 80), consistency: ['application', 'crash'].includes(input.consistency) ? input.consistency : 'unknown', ...(['azure', 'google'].includes(input.objectStore) ? { restoreSupported: true } : {}), nativeMedia: Object.freeze({ fileCount, directoryCount, totalBytes, mediaFingerprint, directoryFingerprint, members, directories }) });
}

async function authenticateCapturedNode(root, source) {
  const layout = await inspectCapturedNodeRoot(root);
  const actualDirectories = layout.phases.flatMap((phase) => phase.directories).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (actualDirectories.length !== source.nativeMedia.directoryCount || stableDigest(actualDirectories) !== source.nativeMedia.directoryFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core recovery directories failed authentication.', { category: 'integrity' });
  const expected = new Map(source.nativeMedia.members.map((member) => [member.relativePath, member]));
  const actual = [];
  for (const file of layout.phases.flatMap((phase) => phase.files).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'))) {
    const member = expected.get(file.relativePath);
    if (!member || member.sizeBytes !== file.sizeBytes) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core recovery file inventory failed authentication.', { category: 'integrity' });
    const hash = crypto.createHash('sha256'); let sizeBytes = 0;
    for await (const chunk of fsSync.createReadStream(file.absolutePath, { highWaterMark: 1024 * 1024 })) { hash.update(chunk); sizeBytes += chunk.length; }
    const contentDigest = `sha256:${hash.digest('hex')}`;
    if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'An InfluxDB 3 Core recovery member failed content authentication.', { category: 'integrity' });
    actual.push({ relativePath: file.relativePath, sizeBytes, contentDigest });
  }
  if (actual.length !== source.nativeMedia.fileCount || stableDigest(actual) !== source.nativeMedia.mediaFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'The complete InfluxDB 3 Core recovery media set failed authentication.', { category: 'integrity' });
  return Object.freeze({ layout, files: actual, directories: actualDirectories });
}

function restoreStageName(executionId) {
  return `.deployerx-influxdb3-core-restore-${crypto.createHash('sha256').update(requiredText(executionId, 'InfluxDB 3 Core restore execution ID', 200)).digest('hex').slice(0, 32)}`;
}

async function targetDataRootEvidence(config) {
  const stat = await fs.lstat(config.dataRoot).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_INVALID', 'The alternate InfluxDB 3 Core data root is unavailable or unsafe.', { category: 'configuration' });
  return Object.freeze({ fingerprint: dataRootFingerprint(config, stat), device: String(stat.dev), inode: String(stat.ino) });
}

async function assertNoTargetRestoreStage(config) {
  const entries = await fs.readdir(config.dataRoot, { withFileTypes: true });
  if (entries.length > MAX_DIRECTORIES) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_INVALID', 'The alternate InfluxDB 3 Core data root contains too many entries.', { category: 'capacity' });
  if (entries.some((entry) => entry.name.startsWith('.deployerx-influxdb3-core-restore-'))) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_STAGE_EXISTS', 'A preserved InfluxDB 3 Core target-side restore stage requires operator inspection.', { category: 'conflict' });
}

async function syncDirectory(directory) {
  let handle = null;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error?.code)) throw error; }
  finally { await handle?.close().catch(() => {}); }
}

function normalizeBackupExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Core backup execution must be an object.');
  const allowed = ['engine', 'objectStore', 'nodeId', 'consistencyMode', 'consistencyMethod', 'confirmationText', 'operatorAttestation', 'deploymentFingerprint', 'storageFingerprint', 'connectionRevision'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Core backup execution field: ${unknown[0]}.`);
  const consistencyMode = String(input.consistencyMode || '').toLowerCase();
  if (!CONSISTENCY_METHODS[consistencyMode]) throw new TypeError('Choose a supported InfluxDB 3 Core object-store consistency mode.');
  if (input.consistencyMethod && input.consistencyMethod !== CONSISTENCY_METHODS[consistencyMode]) throw new TypeError('InfluxDB 3 Core consistency method does not match its proof mode.');
  const operatorAttestation = input.operatorAttestation || (input.confirmationText === CONSISTENCY_CONFIRMATIONS[consistencyMode] ? consistencyMode : null);
  if (operatorAttestation !== consistencyMode) throw new TypeError(`InfluxDB 3 Core ${consistencyMode} backup requires exact operator confirmation.`);
  const connectionRevision = Number(input.connectionRevision);
  if (!Number.isInteger(connectionRevision) || connectionRevision < 1) throw new TypeError('InfluxDB 3 Core connection revision is invalid.');
  const deploymentFingerprint = requiredText(input.deploymentFingerprint, 'InfluxDB 3 Core deployment fingerprint', 80);
  const storage = requiredText(input.storageFingerprint, 'InfluxDB 3 Core storage fingerprint', 80);
  if (![deploymentFingerprint, storage].every((value) => /^sha256:[0-9a-f]{64}$/.test(value))) throw new TypeError('InfluxDB 3 Core backup fingerprints are invalid.');
  const objectStore = String(input.objectStore || 'file').toLowerCase();
  if (!['file', 's3', 'azure', 'google'].includes(objectStore)) throw new TypeError('InfluxDB 3 Core backup execution uses an unsupported object store.');
  return Object.freeze({ engine: 'influxdb3-core', objectStore, nodeId: normalizeNodeId(input.nodeId), consistencyMode, consistencyMethod: CONSISTENCY_METHODS[consistencyMode], operatorAttestation: consistencyMode, deploymentFingerprint, storageFingerprint: storage, connectionRevision });
}

async function copyFileMember(source, destination, expected, signal) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const before = await fs.lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.sizeBytes || before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs || String(before.dev) !== expected.dev || String(before.ino) !== expected.ino) throw new DatabaseAdapterError('INFLUXDB3_CORE_SOURCE_CHANGED', 'InfluxDB 3 Core storage changed before a member was copied.', { category: 'consistency', retryable: true });
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  const output = fsSync.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  try {
    for await (const raw of fsSync.createReadStream(source, { highWaterMark: 1024 * 1024, signal })) {
      if (signal?.aborted) throw new DatabaseAdapterError('INFLUXDB3_CORE_CANCELED', 'The InfluxDB 3 Core backup was canceled.', { category: 'canceled' });
      const chunk = Buffer.from(raw); sizeBytes += chunk.length; hash.update(chunk);
      if (!output.write(chunk)) await once(output, 'drain');
    }
    await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
  } catch (error) {
    output.destroy();
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  const after = await fs.lstat(source);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino) || sizeBytes !== before.size) throw new DatabaseAdapterError('INFLUXDB3_CORE_SOURCE_CHANGED', 'InfluxDB 3 Core storage changed while a member was copied.', { category: 'consistency', retryable: true });
  return Object.freeze({ relativePath: expected.relativePath, sizeBytes, contentDigest: `sha256:${hash.digest('hex')}` });
}

class InfluxDb3CoreAdapter {
  constructor({
    transport = defaultTransport,
    s3StoreFactory = (options) => new InfluxDb3CoreS3Store(options),
    azureStoreFactory = (options) => new InfluxDb3CoreAzureStore(options),
    gcsStoreFactory = (options) => new InfluxDb3CoreGcsStore(options),
    clock = () => new Date().toISOString(),
    now = () => Date.now()
  } = {}) { this.transport = transport; this.s3StoreFactory = s3StoreFactory; this.azureStoreFactory = azureStoreFactory; this.gcsStoreFactory = gcsStoreFactory; this.clock = clock; this.now = now; }

  manifest() {
    return { apiVersion: 1, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, displayName: 'InfluxDB 3 Core', engine: 'influxdb3-core', executionReady: true, sourceEnrollmentReady: true, serverVersionRange: 'InfluxDB 3 Core 3.x with filesystem, S3, Azure Blob, or GCS storage', restoreVersionRange: 'Exact-version stopped filesystem, S3, Azure Blob, or GCS alternate targets', capabilities: { backupMethods: ['physical'], backupModes: ['full'], selection: { database: true, schema: false, table: false, globalObjects: false }, consistencyStrategies: [
      { id: CONSISTENCY_METHODS.stopped, produces: 'application', backupMethods: ['physical'], lockScope: 'instance', requiresDowntime: true, capturesCoordinates: false },
      { id: CONSISTENCY_METHODS['atomic-snapshot'], produces: 'application', backupMethods: ['physical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: false },
      { id: CONSISTENCY_METHODS['ordered-live-copy'], produces: 'crash', backupMethods: ['physical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: false }
    ], transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null }, streaming: { backup: true, restore: true, compression: false, encryption: false }, restore: { alternateTarget: true, offlineBundle: false, originalTarget: false, nativeValidation: true }, replicaAware: false }, requiredTools: [], requiredPrivileges: [] };
  }

  normalizeConfig(input) { return normalizeConfig(input); }
  validateConfig(input) { try { normalizeConfig(input); return []; } catch (error) { return [{ path: '', code: 'INFLUXDB3_CORE_CONFIG_INVALID', severity: 'error', message: error.message }]; } }

  s3Store(context, config) { return this.s3StoreFactory({ config: coreS3StorageConfig(config), resolveSecret: context.resolveSecret }); }
  azureStore(context, config) { return this.azureStoreFactory({ config: coreAzureStorageConfig(config), resolveSecret: context.resolveSecret }); }
  gcsStore(context, config) { return this.gcsStoreFactory({ config: coreGcsStorageConfig(config), resolveSecret: context.resolveSecret }); }
  objectStore(context, config) {
    if (config.objectStore === 's3') return this.s3Store(context, config);
    if (config.objectStore === 'azure') return this.azureStore(context, config);
    if (config.objectStore === 'google') return this.gcsStore(context, config);
    throw new DatabaseAdapterError('INFLUXDB3_CORE_OBJECT_STORE_UNSUPPORTED', 'InfluxDB 3 Core object-store provider is unsupported.', { category: 'compatibility' });
  }

  async readIdentity(context = {}, input = {}) {
    const config = normalizeConfig(input);
    const response = await this.transport({ config, signal: context.signal });
    const product = parsePing(response);
    if (config.expectedVersion && config.expectedVersion !== product.version.text) throw new DatabaseAdapterError('INFLUXDB3_CORE_VERSION_CHANGED', 'InfluxDB 3 Core version changed since the connection was tested.', { category: 'integrity' });
    const store = objectStoreType(config);
    let layout;
    try {
      layout = isRemoteObjectStore(store)
        ? await this.objectStore(context, config).inspect(context)
        : await inspectNodeLayout(config);
    } catch (error) {
      throw databaseObjectStoreError(error);
    }
    const storageFingerprintValue = isRemoteObjectStore(store) ? layout.bindingFingerprint : layout.storageFingerprint;
    const deploymentFingerprint = isRemoteObjectStore(store)
      ? stableDigest({ product: product.product, version: product.version.text, protocol: config.protocol, host: config.host, port: config.port, basePath: config.basePath, nodeId: config.nodeId, objectStore: store, storageFingerprint: storageFingerprintValue })
      : stableDigest({ product: product.product, version: product.version.text, protocol: config.protocol, host: config.host, port: config.port, basePath: config.basePath, nodeId: config.nodeId, dataRoot: config.dataRoot });
    if (config.expectedDeploymentFingerprint && config.expectedDeploymentFingerprint !== deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_DEPLOYMENT_CHANGED', 'InfluxDB 3 Core endpoint binding changed since the connection was tested.', { category: 'integrity' });
    if (config.expectedStorageFingerprint && config.expectedStorageFingerprint !== storageFingerprintValue) throw new DatabaseAdapterError('INFLUXDB3_CORE_STORAGE_CHANGED', 'InfluxDB 3 Core object-store binding changed since the connection was tested.', { category: 'integrity' });
    return Object.freeze({ ...product, deploymentFingerprint, storageFingerprint: storageFingerprintValue, layout });
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now(); const testedAt = this.clock();
    try {
      const identity = await this.readIdentity(context, input);
      const store = identity.layout.objectStore;
      const storage = store === 's3' ? 'S3' : store === 'azure' ? 'Azure Blob' : store === 'google' ? 'GCS' : 'filesystem';
      const canRestore = restoreSupported(store);
      return normalizeConnectionTestResult({ adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'success', checks: [
        { id: 'product', status: 'pass', safeMessage: `InfluxDB 3 Core ${identity.version.text} identity was authenticated through /ping.` },
        { id: 'object-store-binding', status: 'pass', safeMessage: `The exact ${identity.layout.nodeId} ${storage} node layout is readable.` },
        { id: 'ordered-copy', status: 'pass', safeMessage: `${storage} backup will copy snapshots, dbs, WAL, catalog, then the catalog checkpoint.` },
        { id: 'restore-boundary', status: 'pass', safeMessage: store === 'file' ? 'Exact-version alternate filesystem restore is available only while the target is stopped and its node path is absent.' : `Exact-version alternate ${storage} restore is available only while the target is stopped and its exact node prefix is empty.` }
      ], remotePlatform: { engine: 'influxdb3-core', version: identity.version.text, distribution: 'core', platform: process.platform }, endpointIdentity: { product: identity.product, version: identity.version.text, revision: identity.revision, deploymentFingerprint: identity.deploymentFingerprint, dataRootFingerprint: identity.layout.dataRootFingerprint || null, storageFingerprint: identity.storageFingerprint, nodeId: identity.layout.nodeId, objectStore: store, fileCount: identity.layout.fileCount, directoryCount: identity.layout.directoryCount, totalBytes: identity.layout.totalBytes, restoreSupported: canRestore }, error: null }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    } catch (error) {
      const safe = error instanceof DatabaseAdapterError ? error : new DatabaseAdapterError('INFLUXDB3_CORE_DISCOVERY_FAILED', 'DeployerX could not validate InfluxDB 3 Core.', { category: 'connectivity', retryable: true });
      return normalizeConnectionTestResult({ adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'failure', checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null } }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    }
  }

  async *discover(context = {}, request = {}) {
    if (!['all', 'node'].includes(String(request.kind || 'all').toLowerCase())) throw new DatabaseAdapterError('INFLUXDB3_CORE_DISCOVERY_KIND_UNSUPPORTED', 'InfluxDB 3 Core discovery kind is unsupported.', { category: 'compatibility' });
    const identity = await this.readIdentity(context, request.connection);
    const store = identity.layout.objectStore;
    const canRestore = restoreSupported(store);
    yield { nextCursor: null, product: identity.product, version: identity.version, deploymentFingerprint: identity.deploymentFingerprint, dataRootFingerprint: identity.layout.dataRootFingerprint || null, storageFingerprint: identity.storageFingerprint, items: [{ id: identity.layout.nodeId, name: identity.layout.nodeId, selectable: true, objectStore: store, fileCount: identity.layout.fileCount, directoryCount: identity.layout.directoryCount, totalBytes: identity.layout.totalBytes, excluded: identity.layout.excluded, restoreSupported: canRestore }], capabilities: { filesystemFullBackup: store === 'file', s3FullBackup: store === 's3', azureBlobFullBackup: store === 'azure', gcsFullBackup: store === 'google', orderedCopy: true, restoreAvailable: canRestore, cloudObjectStoresAvailable: isRemoteObjectStore(store), memoryObjectStoreSupported: false } };
  }

  async assertStopped(context, config) {
    try { await this.transport({ config, signal: context.signal }); }
    catch (error) {
      if (error?.category === 'connectivity' || error?.category === 'timeout') return true;
      throw error;
    }
    throw new DatabaseAdapterError('INFLUXDB3_CORE_NODE_STILL_RUNNING', 'The InfluxDB 3 Core endpoint is still reachable; stopped-node consistency is unproven.', { category: 'consistency' });
  }

  async preflight(context = {}, request = {}) {
    if (request.operation !== 'backup') throw new DatabaseAdapterError('INFLUXDB3_CORE_OPERATION_UNSUPPORTED', 'InfluxDB 3 Core supports full object-store backup preflight only.', { category: 'compatibility' });
    const config = normalizeConfig(request.connection); const execution = normalizeBackupExecution(request.execution);
    const store = objectStoreType(config);
    if (execution.nodeId !== config.nodeId || execution.objectStore !== store || execution.connectionRevision < 1) throw new DatabaseAdapterError('INFLUXDB3_CORE_SOURCE_CHANGED', 'InfluxDB 3 Core Source binding is invalid.', { category: 'integrity' });
    let layout;
    try { layout = isRemoteObjectStore(store) ? await this.objectStore(context, config).inspect(context) : await inspectNodeLayout(config); }
    catch (error) { throw databaseObjectStoreError(error); }
    const storage = isRemoteObjectStore(store) ? layout.bindingFingerprint : layout.storageFingerprint;
    if (storage !== execution.storageFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_STORAGE_CHANGED', 'InfluxDB 3 Core object-store identity changed after Source enrollment.', { category: 'integrity' });
    let version = config.expectedVersion;
    if (execution.consistencyMode === 'stopped') await this.assertStopped(context, config);
    else {
      const identity = await this.readIdentity(context, config);
      version = identity.version.text;
      if (identity.deploymentFingerprint !== execution.deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_DEPLOYMENT_CHANGED', 'InfluxDB 3 Core deployment identity changed after Source enrollment.', { category: 'integrity' });
    }
    return { checkedAt: this.clock(), serverVersion: parseVersion(version).text, serverVersionSupported: true, serverIdentityFingerprint: execution.deploymentFingerprint, consistency: [{ method: execution.consistencyMethod, verified: true, produces: execution.consistencyMode === 'ordered-live-copy' ? 'crash' : 'application' }], tools: [], privileges: [], coordinateCaptureVerified: false, warnings: execution.consistencyMode === 'ordered-live-copy' ? ['Ordered live copy is crash-consistent, not application-consistent; writes after the latest copied snapshot may be absent.'] : execution.consistencyMode === 'atomic-snapshot' ? [`Application consistency depends on the operator-attested atomic ${isRemoteObjectStore(store) ? 'object-store' : 'filesystem'} snapshot.`] : ['The endpoint was unreachable and the operator attested that the node is stopped.'], metadata: { product: 'influxdb3-core', objectStore: store, nodeId: execution.nodeId, copyOrder: COPY_PHASES.map((phase) => phase.name), excluded: ['table-snapshots/'], consistencyMode: execution.consistencyMode, storageFingerprint: execution.storageFingerprint, restoreSupported: restoreSupported(store) } };
  }

  async planBackup(_context = {}, request = {}) {
    const config = normalizeConfig(request.connection); const execution = normalizeBackupExecution(request.execution);
    const store = objectStoreType(config);
    if (execution.objectStore !== store || request.consistency?.method !== execution.consistencyMethod || request.consistency?.backupMethod !== 'physical' || request.consistency?.backupMode !== 'full' || request.consistency?.captureCoordinates !== false) throw new DatabaseAdapterError('INFLUXDB3_CORE_PLAN_INVALID', 'InfluxDB 3 Core requires matching object-store physical full-backup consistency evidence.', { category: 'compatibility' });
    const operation = { file: 'influxdb3-core-filesystem-full', s3: 'influxdb3-core-s3-full', azure: 'influxdb3-core-azure-full', google: 'influxdb3-core-gcs-full' }[store];
    return Object.freeze({ version: 1, operation, connection: config, execution, consistency: request.consistency, artifact: { kind: 'physical-backup', path: 'influxdb3-core/backup-metadata.json', mediaType: 'application/json', restoreSupported: restoreSupported(store) } });
  }

  async createBackupMedia(context = {}, plan = {}, destinationDirectory) {
    const operationStores = Object.freeze({ 'influxdb3-core-filesystem-full': 'file', 'influxdb3-core-s3-full': 's3', 'influxdb3-core-azure-full': 'azure', 'influxdb3-core-gcs-full': 'google' });
    const operationStore = operationStores[plan.operation];
    if (!operationStore || objectStoreType(plan.connection || {}) !== operationStore || plan.execution?.objectStore !== operationStore) throw new DatabaseAdapterError('INFLUXDB3_CORE_PLAN_INVALID', 'InfluxDB 3 Core backup plan is invalid.', { category: 'integrity' });
    if (isRemoteObjectStore(operationStore)) {
      let media;
      try {
        const store = this.objectStore(context, plan.connection);
        const before = await store.inspect(context);
        if (before.bindingFingerprint !== plan.execution.storageFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_STORAGE_CHANGED', 'InfluxDB 3 Core object-store identity changed before backup.', { category: 'integrity' });
        media = await store.capture(context, destinationDirectory, plan.execution.consistencyMode);
        if (plan.execution.consistencyMode === 'stopped') await this.assertStopped(context, plan.connection);
        else {
          const identity = await this.readIdentity(context, plan.connection);
          if (identity.deploymentFingerprint !== plan.execution.deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_DEPLOYMENT_CHANGED', 'InfluxDB 3 Core deployment identity changed during backup.', { category: 'integrity' });
        }
      } catch (error) {
        if (media?.directory) await fs.rm(media.directory, { recursive: true, force: true }).catch(() => {});
        const failure = operationStore === 's3'
          ? ['INFLUXDB3_CORE_S3_BACKUP_FAILED', 'DeployerX could not create the InfluxDB 3 Core S3 backup.']
          : operationStore === 'azure'
            ? ['INFLUXDB3_CORE_AZURE_BACKUP_FAILED', 'DeployerX could not create the InfluxDB 3 Core Azure Blob backup.']
            : ['INFLUXDB3_CORE_GCS_BACKUP_FAILED', 'DeployerX could not create the InfluxDB 3 Core GCS backup.'];
        throw databaseObjectStoreError(error, ...failure);
      }
      return Object.freeze({ ...media, product: 'influxdb3-core', productVersion: plan.connection.expectedVersion, deploymentFingerprint: plan.execution.deploymentFingerprint, storageFingerprint: plan.execution.storageFingerprint, consistencyMode: plan.execution.consistencyMode, restoreSupported: restoreSupported(operationStore) });
    }
    const destination = path.resolve(requiredText(destinationDirectory, 'InfluxDB 3 Core staging destination'));
    if (await fs.lstat(destination).catch(() => null)) throw new DatabaseAdapterError('INFLUXDB3_CORE_DESTINATION_EXISTS', 'InfluxDB 3 Core staging destination already exists.', { category: 'conflict' });
    const before = await inspectNodeLayout(plan.connection);
    if (before.storageFingerprint !== plan.execution.storageFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_STORAGE_CHANGED', 'InfluxDB 3 Core filesystem identity changed before backup.', { category: 'integrity' });
    const files = []; const phaseEvidence = [];
    try {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      for (const phase of before.phases) {
        await context.onProgress?.({ phase: 'capturing', component: phase.phase, copyOrder: COPY_PHASES.map((item) => item.name) });
        for (const directory of phase.directories) await fs.mkdir(path.join(destination, ...directory.split('/')), { recursive: true, mode: 0o700 });
        for (const member of phase.files) files.push(await copyFileMember(member.absolutePath, path.join(destination, ...member.relativePath.split('/')), member, context.signal));
        phaseEvidence.push({ phase: phase.phase, sourceInventoryDigest: phase.digest, fileCount: phase.files.length, directoryCount: phase.directories.length, totalBytes: phase.files.reduce((sum, file) => sum + file.sizeBytes, 0) });
      }
      const after = await inspectNodeLayout(plan.connection);
      if (after.storageFingerprint !== before.storageFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_STORAGE_CHANGED', 'InfluxDB 3 Core filesystem identity changed during backup.', { category: 'integrity' });
      const driftPhases = before.phases.filter((phase, index) => phase.digest !== after.phases[index]?.digest).map((phase) => phase.phase);
      if (driftPhases.length && plan.execution.consistencyMode !== 'ordered-live-copy') throw new DatabaseAdapterError('INFLUXDB3_CORE_SOURCE_CHANGED', 'InfluxDB 3 Core storage changed during an application-consistent capture.', { category: 'consistency', retryable: true, details: { driftPhases } });
      if (plan.execution.consistencyMode === 'stopped') await this.assertStopped(context, plan.connection);
      else {
        const identity = await this.readIdentity(context, plan.connection);
        if (identity.deploymentFingerprint !== plan.execution.deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_DEPLOYMENT_CHANGED', 'InfluxDB 3 Core deployment identity changed during backup.', { category: 'integrity' });
      }
      const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
      const directories = before.phases.flatMap((phase) => phase.directories).sort((left, right) => left.localeCompare(right, 'en-US'));
      const canonicalFiles = files.map(({ relativePath, sizeBytes, contentDigest }) => ({ relativePath, sizeBytes, contentDigest })).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
      return Object.freeze({ directory: destination, product: 'influxdb3-core', productVersion: plan.connection.expectedVersion, nodeId: plan.execution.nodeId, objectStore: 'file', deploymentFingerprint: plan.execution.deploymentFingerprint, storageFingerprint: plan.execution.storageFingerprint, consistencyMode: plan.execution.consistencyMode, achievedConsistency: plan.execution.consistencyMode === 'ordered-live-copy' ? 'crash' : 'application', copyOrder: COPY_PHASES.map((phase) => phase.name), excluded: ['table-snapshots/'], phaseEvidence, driftPhases, files, directories, fileCount: files.length, directoryCount: directories.length, totalBytes, mediaFingerprint: stableDigest(canonicalFiles), directoryFingerprint: stableDigest(directories) });
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      if (error instanceof DatabaseAdapterError) throw error;
      throw new DatabaseAdapterError('INFLUXDB3_CORE_BACKUP_FAILED', 'DeployerX could not create the InfluxDB 3 Core filesystem backup.', { category: error?.category || 'execution', retryable: Boolean(error?.retryable) });
    }
  }

  async executeBackup(context = {}, plan = {}) { if (!context.destinationDirectory) throw new DatabaseAdapterError('INFLUXDB3_CORE_DESTINATION_REQUIRED', 'InfluxDB 3 Core backup requires an owned staging directory.', { category: 'configuration' }); return this.createBackupMedia(context, plan, context.destinationDirectory); }

  async planRestore(context = {}, request = {}) {
    if (request.mode !== 'alternate' || request.confirmation !== RESTORE_CONFIRMATION) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_MODE_UNSUPPORTED', 'InfluxDB 3 Core restore requires explicit alternate-target confirmation.', { category: 'compatibility' });
    const connection = normalizeConfig(request.connection);
    const store = objectStoreType(connection);
    const source = normalizeRestoreSource(request.source); const targetIdentity = request.targetIdentity || {};
    if (store !== source.objectStore) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_OBJECT_STORE_MISMATCH', 'The alternate InfluxDB 3 Core target must use the protected object-store type.', { category: 'compatibility' });
    if (['azure', 'google'].includes(store) && (targetIdentity.objectStore !== store || targetIdentity.nodeId !== connection.nodeId)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_INVALID', 'The tested alternate InfluxDB 3 Core target provider and node ID must match the protected Source.', { category: 'compatibility' });
    if (targetIdentity.version !== source.productVersion || targetIdentity.version !== connection.expectedVersion || connection.nodeId !== source.nodeId) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_VERSION_INCOMPATIBLE', 'The alternate InfluxDB 3 Core target must exactly match the protected version and node ID.', { category: 'compatibility' });
    if (targetIdentity.deploymentFingerprint !== connection.expectedDeploymentFingerprint || targetIdentity.deploymentFingerprint === source.deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_INVALID', 'Choose a separately tested alternate InfluxDB 3 Core deployment.', { category: 'conflict' });
    await this.assertStopped(context, connection);
    const executionId = requiredText(request.executionId, 'InfluxDB 3 Core restore execution ID', 200);
    if (isRemoteObjectStore(store)) {
      const providerLabel = objectStoreLabel(store);
      const targetStorageFingerprint = requiredText(targetIdentity.storageFingerprint, 'InfluxDB 3 Core target storage fingerprint', 80);
      if (!/^sha256:[0-9a-f]{64}$/.test(targetStorageFingerprint) || targetStorageFingerprint !== connection.expectedStorageFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_CHANGED', `The alternate InfluxDB 3 Core ${providerLabel} binding changed after testing.`, { category: 'integrity' });
      let empty;
      try { empty = await this.objectStore(context, connection).assertEmpty(context); } catch (error) { throw databaseObjectStoreError(error); }
      if (empty.bindingFingerprint !== targetStorageFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_CHANGED', `The alternate InfluxDB 3 Core ${providerLabel} binding changed after testing.`, { category: 'integrity' });
      return Object.freeze({ version: 1, operation: RESTORE_OPERATIONS[store], connection, executionId, source, target: Object.freeze({ productVersion: targetIdentity.version, deploymentFingerprint: targetIdentity.deploymentFingerprint, storageFingerprint: targetStorageFingerprint, nodeId: connection.nodeId, objectStore: store, endpointMustRemainStopped: true, nodePrefixMustBeEmpty: true }) });
    }
    const rootEvidence = await targetDataRootEvidence(connection);
    if (rootEvidence.fingerprint !== targetIdentity.dataRootFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core data-root binding changed after testing.', { category: 'integrity' });
    if (await fs.lstat(nodeRoot(connection)).catch(() => null)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_EXISTS', 'The alternate InfluxDB 3 Core node path must be absent before restore.', { category: 'conflict' });
    await assertNoTargetRestoreStage(connection);
    const stageName = restoreStageName(executionId);
    if (await fs.lstat(path.join(connection.dataRoot, stageName)).catch(() => null)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_STAGE_EXISTS', 'An InfluxDB 3 Core target-side restore stage already exists.', { category: 'conflict' });
    return Object.freeze({ version: 1, operation: RESTORE_OPERATIONS.file, connection, executionId, source, target: Object.freeze({ productVersion: targetIdentity.version, deploymentFingerprint: targetIdentity.deploymentFingerprint, dataRootFingerprint: rootEvidence.fingerprint, nodeId: connection.nodeId, objectStore: 'file', stageName, endpointMustRemainStopped: true }) });
  }

  async executeRestore(context = {}, plan = {}) {
    const restoreStore = restoreStoreFromOperation(plan.operation);
    if (!restoreStore || objectStoreType(plan.connection || {}) !== restoreStore || plan.source?.objectStore !== restoreStore || plan.target?.objectStore !== restoreStore || (['azure', 'google'].includes(restoreStore) && plan.source?.restoreSupported !== true)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_PLAN_INVALID', 'InfluxDB 3 Core restore plan is invalid.', { category: 'integrity' });
    const sourceDirectory = path.resolve(requiredText(context.sourceDirectory, 'InfluxDB 3 Core restore source directory'));
    await authenticateCapturedNode(sourceDirectory, plan.source);
    await this.assertStopped(context, plan.connection);
    if (isRemoteObjectStore(restoreStore)) {
      const providerLabel = objectStoreLabel(restoreStore);
      const store = this.objectStore(context, plan.connection);
      let empty;
      try { empty = await store.assertEmpty(context); } catch (error) { throw databaseObjectStoreError(error); }
      if (empty.bindingFingerprint !== plan.target.storageFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_CHANGED', `The alternate InfluxDB 3 Core ${providerLabel} binding changed before restore.`, { category: 'integrity' });
      await context.onMutationStarted?.({ objectStore: restoreStore });
      const restored = [];
      for (const phase of RESTORE_PHASES) {
        if (context.signal?.aborted) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_CANCELED', `InfluxDB 3 Core ${providerLabel} restore was canceled after target mutation began.`, { category: 'canceled' });
        await context.onProgress?.({ phase: 'restoring', component: phase.name, restoreOrder: RESTORE_PHASES.map((item) => item.name) });
        for (const member of plan.source.nativeMedia.members.filter((item) => item.relativePath === phase.name || (phase.kind === 'directory' && item.relativePath.startsWith(`${phase.name}/`)))) {
          try { restored.push(await store.uploadRestoreMember(context, sourceDirectory, member)); } catch (error) { throw databaseObjectStoreError(error); }
        }
        await this.assertStopped(context, plan.connection);
      }
      const validation = await this.validateRestore(context, { plan });
      return Object.freeze({ plan, restoredMembers: restored.length, installed: true, validation, completedAt: this.clock() });
    }
    const rootEvidence = await targetDataRootEvidence(plan.connection);
    if (rootEvidence.fingerprint !== plan.target.dataRootFingerprint || await fs.lstat(nodeRoot(plan.connection)).catch(() => null)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core target changed before installation.', { category: 'integrity' });
    await assertNoTargetRestoreStage(plan.connection);
    const stage = path.join(plan.connection.dataRoot, plan.target.stageName);
    if (await fs.lstat(stage).catch(() => null)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_STAGE_EXISTS', 'The target-side InfluxDB 3 Core restore stage already exists.', { category: 'conflict' });
    await context.onMutationStarted?.({ stageName: plan.target.stageName });
    await fs.mkdir(stage, { mode: 0o700 });
    await fs.writeFile(path.join(stage, '.owner.json'), JSON.stringify({ version: 1, executionId: plan.executionId, nodeId: plan.target.nodeId }), { flag: 'wx', mode: 0o600 });
    const sourceLayout = await inspectCapturedNodeRoot(sourceDirectory);
    const sourcePhases = new Map(sourceLayout.phases.map((phase) => [phase.phase, phase]));
    const restored = [];
    for (const phase of RESTORE_PHASES) {
      if (context.signal?.aborted) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_CANCELED', 'InfluxDB 3 Core restore was canceled after target mutation began.', { category: 'canceled' });
      const inventory = sourcePhases.get(phase.name);
      await context.onProgress?.({ phase: 'restoring', component: phase.name, restoreOrder: RESTORE_PHASES.map((item) => item.name) });
      for (const directory of inventory.directories) await fs.mkdir(path.join(stage, ...directory.split('/')), { recursive: true, mode: 0o700 });
      for (const member of inventory.files) {
        const copied = await copyFileMember(member.absolutePath, path.join(stage, ...member.relativePath.split('/')), member, context.signal);
        const handle = await fs.open(path.join(stage, ...member.relativePath.split('/')), 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        restored.push(copied);
      }
    }
    await fs.rm(path.join(stage, '.owner.json'), { force: true });
    await authenticateCapturedNode(stage, plan.source);
    await syncDirectory(stage);
    await this.assertStopped(context, plan.connection);
    if (await fs.lstat(nodeRoot(plan.connection)).catch(() => null)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core node path appeared during restore.', { category: 'conflict' });
    await fs.rename(stage, nodeRoot(plan.connection));
    await syncDirectory(plan.connection.dataRoot);
    const validation = await this.validateRestore(context, { plan });
    return Object.freeze({ plan, restoredMembers: restored.length, installed: true, validation, completedAt: this.clock() });
  }

  async validateRestore(context = {}, restored = {}) {
    const plan = restored.plan;
    const restoreStore = restoreStoreFromOperation(plan?.operation);
    if (!restoreStore || objectStoreType(plan?.connection || {}) !== restoreStore || plan?.source?.objectStore !== restoreStore || plan?.target?.objectStore !== restoreStore || (['azure', 'google'].includes(restoreStore) && plan?.source?.restoreSupported !== true)) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_PLAN_INVALID', 'InfluxDB 3 Core restore validation evidence is invalid.', { category: 'integrity' });
    await this.assertStopped(context, plan.connection);
    if (isRemoteObjectStore(restoreStore)) {
      const providerLabel = objectStoreLabel(restoreStore);
      let verified;
      try { verified = await this.objectStore(context, plan.connection).authenticateInstalled(context, { ...plan.source, targetStorageFingerprint: plan.target.storageFingerprint }); } catch (error) { throw databaseObjectStoreError(error); }
      return Object.freeze({ valid: true, status: 'succeeded', nativeIntegrityValidation: true, endpointStopped: true, nodeId: plan.target.nodeId, objectStore: restoreStore, fileCount: verified.files.length, directoryCount: verified.directories.length, totalBytes: verified.totalBytes, mediaFingerprint: plan.source.nativeMedia.mediaFingerprint, directoryFingerprint: plan.source.nativeMedia.directoryFingerprint, checks: [
        { id: 'endpoint-stopped', status: 'pass', safeMessage: `The alternate InfluxDB 3 Core endpoint remained stopped during ${providerLabel} validation.` },
        { id: 'node-layout', status: 'pass', safeMessage: `The installed ${providerLabel} node contains the exact authenticated object layout.` },
        { id: 'member-digests', status: 'pass', safeMessage: `Every installed ${providerLabel} object matches its authenticated SHA-256 digest.` },
        { id: 'operator-start-required', status: 'warning', safeMessage: 'The restored target remains stopped and must be started separately after operator review.' }
      ] });
    }
    const rootEvidence = await targetDataRootEvidence(plan.connection);
    if (rootEvidence.fingerprint !== plan.target.dataRootFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core data-root binding changed during validation.', { category: 'integrity' });
    const verified = await authenticateCapturedNode(nodeRoot(plan.connection), plan.source);
    return Object.freeze({ valid: true, status: 'succeeded', nativeIntegrityValidation: true, endpointStopped: true, nodeId: plan.target.nodeId, fileCount: verified.files.length, directoryCount: verified.directories.length, totalBytes: plan.source.nativeMedia.totalBytes, mediaFingerprint: plan.source.nativeMedia.mediaFingerprint, directoryFingerprint: plan.source.nativeMedia.directoryFingerprint, checks: [
      { id: 'endpoint-stopped', status: 'pass', safeMessage: 'The alternate InfluxDB 3 Core endpoint remained stopped during filesystem validation.' },
      { id: 'node-layout', status: 'pass', safeMessage: 'The installed node contains the exact authenticated filesystem layout.' },
      { id: 'member-digests', status: 'pass', safeMessage: 'Every installed filesystem member matches its authenticated SHA-256 digest.' },
      { id: 'operator-ownership-review', status: 'warning', safeMessage: 'Review and correct restored filesystem ownership for the InfluxDB service account before startup.' },
      { id: 'operator-start-required', status: 'warning', safeMessage: 'The restored target remains stopped and must be started separately after operator review.' }
    ] });
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

function persistedCoreEndpoint(config) {
  const { objectStoreCredentialSecretRefId: _secretRefId, ...endpoint } = config;
  return endpoint;
}

function trustModeForObjectStore(objectStore) {
  return objectStore === 's3' ? 's3-plus-ping' : objectStore === 'azure' ? 'azure-plus-ping' : objectStore === 'google' ? 'gcs-plus-ping' : 'local-filesystem-plus-ping';
}

function parseGcsServiceAccount(value) {
  const serialized = requiredText(value, 'InfluxDB 3 Core GCS service-account JSON', 32768);
  let credential;
  try { credential = JSON.parse(serialized); }
  catch { throw new TypeError('InfluxDB 3 Core GCS service-account JSON is invalid.'); }
  normalizeGcsCredential(credential);
  return credential;
}

class InfluxDb3CoreConnectionService {
  constructor({ controlDatabase, secretStore = null, deviceId, adapter = new InfluxDb3CoreAdapter() } = {}) { if (!controlDatabase) throw new TypeError('Control database is required.'); this.controlDatabase = controlDatabase; this.secretStore = secretStore; this.deviceId = requiredText(deviceId, 'Device ID', 200); this.adapter = adapter; }
  async list(workspaceId) { const tenant = requiredText(workspaceId, 'Workspace ID', 200); return (await this.controlDatabase.repository('connection').list(tenant, { limit: 1000 })).filter((record) => record.adapterId === ADAPTER_ID).map((record) => ({ ...record, capabilities: this.adapter.manifest().capabilities, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) })); }
  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const actor = requiredText(actorId, 'Actor ID', 200); const name = requiredText(input.name, 'InfluxDB 3 Core connection name', 200);
    const objectStore = String(input.objectStore || 'file').toLowerCase();
    if (objectStore === 'file') {
      if (input.confirmationText !== BIND_CONFIRMATION) throw new TypeError(`InfluxDB 3 Core filesystem binding requires ${BIND_CONFIRMATION}.`);
      const config = normalizeConfig({ protocol: input.protocol, allowInsecureHttp: input.allowInsecureHttp, host: input.host, port: input.port, basePath: input.basePath, caFile: input.caFile, timeoutMs: input.timeoutMs, dataRoot: input.dataRoot, nodeId: input.nodeId, filesystemBindingConfirmed: true });
      return this.controlDatabase.repository('connection').create({ workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device', endpoint: { ...persistedCoreEndpoint(config), expectedVersion: null, expectedDeploymentFingerprint: null, expectedStorageFingerprint: null }, secretRefIds: [], trust: { mode: 'local-filesystem-plus-ping', fingerprint: null }, workerAffinity: [`device:${this.deviceId}`], lastTest: null, influxdb3CoreInventory: null });
    }
    if (!['s3', 'azure', 'google'].includes(objectStore)) throw new TypeError('This InfluxDB 3 Core object-store connection type is not implemented.');
    if (!this.secretStore) throw new TypeError('InfluxDB 3 Core object-store connections require the SecretRef store.');
    const expectedConfirmation = objectStore === 's3' ? S3_BIND_CONFIRMATION : objectStore === 'azure' ? AZURE_BIND_CONFIRMATION : GCS_BIND_CONFIRMATION;
    if (input.confirmationText !== expectedConfirmation) {
      const providerLabel = objectStore === 'google' ? 'GCS' : objectStore === 'azure' ? 'Azure' : 'S3';
      if (objectStore === 's3') throw new TypeError(`InfluxDB 3 Core S3 binding requires ${expectedConfirmation}.`);
      throw new TypeError(`InfluxDB 3 Core ${providerLabel} binding is not implemented without exact ${expectedConfirmation} confirmation.`);
    }
    const credential = objectStore === 's3'
      ? normalizeS3Credential(input)
      : objectStore === 'azure'
        ? normalizeAzureCredential({ accountName: input.objectStoreAccountName, accessKey: input.accessKey }, input.objectStoreAccountName)
        : parseGcsServiceAccount(input.serviceAccountJson);
    const secretType = objectStore === 'google' ? 'private-key' : 'access-key';
    const providerLabel = objectStore === 's3' ? 'S3' : objectStore === 'azure' ? 'Azure' : 'GCS';
    let credentialRef = null;
    try {
      credentialRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} ${providerLabel} credentials`, secretType, value: JSON.stringify(credential), scope: 'device' });
      const config = normalizeConfig({
        protocol: input.protocol, allowInsecureHttp: input.allowInsecureHttp, host: input.host, port: input.port, basePath: input.basePath, caFile: input.caFile, timeoutMs: input.timeoutMs,
        objectStore, s3BindingConfirmed: objectStore === 's3' ? true : undefined, azureBindingConfirmed: objectStore === 'azure' ? true : undefined, gcsBindingConfirmed: objectStore === 'google' ? true : undefined,
        objectStoreAccountName: objectStore === 'azure' ? input.objectStoreAccountName : undefined, objectStoreEndpoint: objectStore !== 'google' ? input.objectStoreEndpoint : undefined,
        objectStoreRegion: objectStore === 's3' ? input.objectStoreRegion : undefined, objectStoreBucket: input.objectStoreBucket,
        objectStorePrefix: input.objectStorePrefix, objectStoreForcePathStyle: objectStore === 's3' ? input.objectStoreForcePathStyle : undefined,
        allowInsecureObjectStoreEndpoint: objectStore !== 'google' ? input.allowInsecureObjectStoreEndpoint : undefined,
        objectStoreTimeoutMs: input.objectStoreTimeoutMs, objectStoreCredentialSecretRefId: credentialRef.id, nodeId: input.nodeId
      });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(credentialRef, actor));
        return transaction.create('connection', { workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device', endpoint: { ...persistedCoreEndpoint(config), expectedVersion: null, expectedDeploymentFingerprint: null, expectedStorageFingerprint: null }, secretRefIds: [credentialRef.id], trust: { mode: trustModeForObjectStore(objectStore), fingerprint: null }, workerAffinity: [`device:${this.deviceId}`], lastTest: null, influxdb3CoreInventory: null });
      });
    } catch (error) {
      if (credentialRef) await this.secretStore.delete({ workspaceId: tenant, id: credentialRef.id }).catch(() => {});
      throw error;
    }
  }
  config(connection) {
    const objectStore = String(connection.endpoint?.objectStore || 'file').toLowerCase();
    const secretRefIds = Array.isArray(connection.secretRefIds) ? connection.secretRefIds : [];
    if (isRemoteObjectStore(objectStore) && secretRefIds.length !== 1) throw new TypeError('InfluxDB 3 Core object-store connections require exactly one credential SecretRef.');
    if (objectStore === 'file' && secretRefIds.length) throw new TypeError('InfluxDB 3 Core filesystem connections cannot include credential SecretRefs.');
    return normalizeConfig({ ...connection.endpoint, ...(isRemoteObjectStore(objectStore) ? { objectStoreCredentialSecretRefId: secretRefIds[0] } : {}) });
  }
  async test(workspaceId, connectionId, actorId = 'system', signal) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const id = requiredText(connectionId, 'Connection ID', 200); const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('InfluxDB 3 Core connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This InfluxDB 3 Core connection belongs to another device.');
    const context = { resolveSecret: (secretRefId) => this.secretStore?.resolve({ workspaceId: tenant, id: secretRefId }), signal };
    const result = await this.adapter.testConnection(context, this.config(current));
    let endpoint = current.endpoint; let trust = current.trust; let inventory = null;
    if (result.status === 'success') {
      endpoint = { ...current.endpoint, expectedVersion: result.endpointIdentity.version, expectedDeploymentFingerprint: result.endpointIdentity.deploymentFingerprint, expectedStorageFingerprint: result.endpointIdentity.storageFingerprint };
      trust = { mode: trustModeForObjectStore(result.endpointIdentity.objectStore), fingerprint: result.endpointIdentity.deploymentFingerprint, dataRootFingerprint: result.endpointIdentity.dataRootFingerprint, storageFingerprint: result.endpointIdentity.storageFingerprint, objectStore: result.endpointIdentity.objectStore, observedAt: result.testedAt };
      const pages = []; for await (const page of this.adapter.discover(context, { connection: this.config({ ...current, endpoint }), kind: 'all' })) pages.push(page);
      if (pages.length !== 1 || pages[0].storageFingerprint !== result.endpointIdentity.storageFingerprint) throw new DatabaseAdapterError('INFLUXDB3_CORE_INVENTORY_CHANGED', 'InfluxDB 3 Core object-store identity changed during connection testing.', { category: 'integrity' });
      inventory = { version: 1, capturedAt: result.testedAt, product: pages[0].product, productVersion: pages[0].version.text, deploymentFingerprint: pages[0].deploymentFingerprint, dataRootFingerprint: pages[0].dataRootFingerprint, storageFingerprint: pages[0].storageFingerprint, nodes: pages[0].items };
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { endpoint, trust, lastTest: result, influxdb3CoreInventory: inventory, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection, result };
  }
  async discover(workspaceId, connectionId, input = {}) { const tenant = requiredText(workspaceId, 'Workspace ID', 200); const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200)); if (!current || current.adapterId !== ADAPTER_ID) throw new Error('InfluxDB 3 Core connection was not found.'); if (current.lastTest?.status !== 'success') throw new Error('Test the InfluxDB 3 Core connection successfully before discovery.'); const pages = []; for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore?.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current), kind: input.kind || 'all' })) pages.push(page); if (pages.length !== 1) throw new Error('InfluxDB 3 Core discovery returned an invalid page count.'); return pages[0]; }
  async withExecution(workspaceId, connection, signal, callback) { const tenant = requiredText(workspaceId, 'Workspace ID', 200); if (typeof callback !== 'function') throw new TypeError('InfluxDB 3 Core execution callback is required.'); return callback({ resolveSecret: (secretRefId) => this.secretStore?.resolve({ workspaceId: tenant, id: secretRefId }), signal }, this.config(connection)); }
}

module.exports = { ADAPTER_ID, ADAPTER_VERSION, AZURE_BIND_CONFIRMATION, BIND_CONFIRMATION, GCS_BIND_CONFIRMATION, S3_BIND_CONFIRMATION, CONSISTENCY_CONFIRMATIONS, CONSISTENCY_METHODS, COPY_PHASES, RESTORE_CONFIRMATION, RESTORE_PHASES, InfluxDb3CoreAdapter, InfluxDb3CoreConnectionService, authenticateCapturedNode, inspectCapturedNodeRoot, inspectNodeLayout, nodeRoot, normalizeBackupExecution, normalizeConfig, normalizeRestoreSource, parsePing, parseVersion, restoreStageName, targetDataRootEvidence };
