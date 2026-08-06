const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');

const ADAPTER_ID = 'deployerx.database.influxdb';
const ADAPTER_VERSION = '0.3.0';
const RESTORE_CONFIRMATION = 'RESTORE INFLUXDB ALTERNATE';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TLS_FILE_BYTES = 1024 * 1024;
const MAX_ORGANIZATIONS = 1000;
const MAX_BUCKETS = 10000;
const PAGE_SIZE = 100;
const MAX_BACKUP_FILES = 10000;
const MAX_BACKUP_DIRECTORIES = 1000;
const MAX_BACKUP_BYTES = 16 * 1024 * 1024 * 1024 * 1024;
const MAX_BACKUP_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_RESTORE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_KINDS = new Set(['all', 'organizations', 'buckets']);

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
  const input = requiredText(value, 'InfluxDB host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('InfluxDB host must be a hostname or IP address without a URI scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('InfluxDB host is invalid.');
  return ascii;
}

function normalizeBasePath(value) {
  const raw = optionalText(value, 'InfluxDB base path', 512);
  if (!raw || raw === '/') return '';
  if (!raw.startsWith('/') || raw.endsWith('/') || /[?#\\\s]/.test(raw) || raw.includes('//')) throw new TypeError('InfluxDB base path is invalid.');
  const segments = raw.slice(1).split('/');
  for (const segment of segments) {
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch { throw new TypeError('InfluxDB base path is invalid.'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\\0]/.test(decoded)) throw new TypeError('InfluxDB base path is invalid.');
  }
  return `/${segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join('/')}`;
}

function normalizeAbsoluteFile(value, label) {
  const file = optionalText(value, label, 4096);
  if (!file) return null;
  if (!path.isAbsolute(file)) throw new TypeError(`${label} must be absolute.`);
  return path.normalize(file);
}

function normalizeExecutable(value) {
  const executable = optionalText(value, 'Influx CLI path', 1024) || 'influx';
  if (path.isAbsolute(executable)) return path.normalize(executable);
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) throw new TypeError('Influx CLI path must be an absolute path or executable name.');
  return executable;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB connection configuration must be an object.');
  const allowed = ['protocol', 'allowInsecureHttp', 'host', 'port', 'basePath', 'tokenSecretRefId', 'caFile', 'cliPath', 'timeoutMs', 'expectedVersion', 'expectedCliVersion', 'expectedDeploymentFingerprint'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB connection field: ${unknown[0]}.`);
  const protocol = String(input.protocol || 'https').toLowerCase();
  if (!['https', 'http'].includes(protocol)) throw new TypeError('InfluxDB protocol is invalid.');
  const allowInsecureHttp = input.allowInsecureHttp === true;
  if (protocol === 'http' && !allowInsecureHttp) throw new TypeError('InfluxDB HTTP requires explicit insecure-transport approval.');
  if (protocol === 'https' && allowInsecureHttp) throw new TypeError('InfluxDB insecure-transport approval is valid only for HTTP.');
  const port = Number(input.port ?? 8086);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('InfluxDB port must be between 1 and 65535.');
  const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('InfluxDB timeout must be between 1 and 300 seconds.');
  return {
    protocol,
    allowInsecureHttp,
    host: normalizeHost(input.host),
    port,
    basePath: normalizeBasePath(input.basePath),
    tokenSecretRefId: requiredText(input.tokenSecretRefId, 'InfluxDB API-token SecretRef ID', 200),
    caFile: protocol === 'https' ? normalizeAbsoluteFile(input.caFile, 'InfluxDB TLS CA file') : null,
    cliPath: normalizeExecutable(input.cliPath),
    timeoutMs,
    expectedVersion: optionalText(input.expectedVersion, 'Expected InfluxDB version', 100),
    expectedCliVersion: optionalText(input.expectedCliVersion, 'Expected Influx CLI version', 100),
    expectedDeploymentFingerprint: optionalText(input.expectedDeploymentFingerprint, 'Expected InfluxDB deployment fingerprint', 80)
  };
}

function safeApiPath(config, apiPath, query = {}) {
  const pathname = requiredText(apiPath, 'InfluxDB API path', 1024);
  if (!pathname.startsWith('/') || /[?#\\\0]/.test(pathname) || pathname.split('/').some((segment) => segment === '.' || segment === '..')) throw new TypeError('InfluxDB API path is invalid.');
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
  const suffix = entries.length ? `?${new URLSearchParams(entries.map(([key, value]) => [requiredText(key, 'InfluxDB query key', 100), String(value)])).toString()}` : '';
  return `${config.basePath}${pathname}${suffix}`;
}

async function readTlsFile(file) {
  if (!file) return undefined;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_TLS_FILE_BYTES) throw new Error('invalid TLS file');
    return await fs.readFile(file);
  } catch {
    throw new DatabaseAdapterError('INFLUXDB_TLS_FILE_INVALID', 'The InfluxDB TLS CA file is unavailable or invalid.', { category: 'configuration' });
  }
}

function authorizationHeader(token) {
  const value = String(token ?? '');
  if (!value || value.includes('\0') || /[\r\n\s]/.test(value) || value.length > 16384) throw new DatabaseAdapterError('INFLUXDB_TOKEN_INVALID', 'The InfluxDB API token cannot be represented safely.', { category: 'authentication' });
  return `Token ${value}`;
}

async function defaultTransport({ config, apiPath, query, authorization, signal }) {
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
    const request = client.request({
      protocol: `${config.protocol}:`, hostname: config.host, port: config.port, method: 'GET', path: safeApiPath(config, apiPath, query),
      headers: { accept: 'application/json', authorization },
      ...(config.protocol === 'https' ? { ca, rejectUnauthorized: true, servername: net.isIP(config.host) ? undefined : config.host } : {}),
      agent: false
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) return request.destroy(new DatabaseAdapterError('INFLUXDB_RESPONSE_TOO_LARGE', 'InfluxDB returned an oversized response.', { category: 'integrity' }));
        chunks.push(chunk);
      });
      response.on('end', () => {
        const statusCode = Number(response.statusCode || 0);
        if (statusCode >= 300 && statusCode < 400) return finish(reject, new DatabaseAdapterError('INFLUXDB_REDIRECT_REFUSED', 'InfluxDB redirects are not allowed.', { category: 'connectivity' }));
        if (statusCode < 200 || statusCode >= 300) {
          const code = statusCode === 401 ? 'INFLUXDB_AUTHENTICATION_FAILED' : statusCode === 403 ? 'INFLUXDB_PRIVILEGE_MISSING' : statusCode === 404 ? 'INFLUXDB_API_UNAVAILABLE' : statusCode === 429 ? 'INFLUXDB_RATE_LIMITED' : 'INFLUXDB_REQUEST_FAILED';
          const message = statusCode === 401 ? 'InfluxDB API-token authentication failed.' : statusCode === 403 ? 'The InfluxDB token lacks organization or bucket read access.' : statusCode === 429 ? 'InfluxDB is temporarily rate limited.' : 'The InfluxDB API request failed.';
          return finish(reject, new DatabaseAdapterError(code, message, { category: statusCode === 401 ? 'authentication' : statusCode === 403 ? 'authorization' : 'connectivity', retryable: statusCode === 429 || statusCode >= 500 }));
        }
        const contentType = String(response.headers?.['content-type'] || '');
        if (!/^application\/(?:json|[^;]+[+]json)(?:;|$)/i.test(contentType)) return finish(reject, new DatabaseAdapterError('INFLUXDB_CONTENT_TYPE_INVALID', 'InfluxDB returned a non-JSON response.', { category: 'integrity' }));
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return finish(reject, new DatabaseAdapterError('INFLUXDB_RESPONSE_INVALID', 'InfluxDB returned invalid JSON.', { category: 'integrity' })); }
        return finish(resolve, { statusCode, body });
      });
    });
    request.setTimeout(config.timeoutMs, () => request.destroy(new DatabaseAdapterError('INFLUXDB_OPERATION_TIMEOUT', 'The InfluxDB request timed out.', { category: 'timeout', retryable: true })));
    request.on('error', (error) => finish(reject, error));
    const onAbort = () => request.destroy(new DatabaseAdapterError('INFLUXDB_OPERATION_CANCELED', 'InfluxDB discovery was canceled.', { category: 'canceled' }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    request.end();
  });
}

function defaultCommandRunner({ executable, args, timeoutMs, signal, env }) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, signal, env: env || process.env }, (error, stdout, stderr) => {
      if (error) {
        if (signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') return reject(new DatabaseAdapterError('INFLUXDB_OPERATION_CANCELED', 'The InfluxDB native operation was canceled.', { category: 'canceled' }));
        if (error.killed) return reject(new DatabaseAdapterError('INFLUXDB_OPERATION_TIMEOUT', 'The InfluxDB native operation timed out.', { category: 'timeout', retryable: true }));
        return reject(new DatabaseAdapterError('INFLUXDB_CLI_UNAVAILABLE', 'The Influx CLI could not be executed.', { category: 'configuration', retryable: false }));
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode: 0 });
    });
  });
}

function endpointUrl(config) {
  const host = net.isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  return `${config.protocol}://${host}:${config.port}${config.basePath}`;
}

function nativeEnvironment(token) {
  const environment = { INFLUX_TOKEN: token };
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function normalizeRestoreBucket(input = {}) {
  const type = String(input.type || '').toLowerCase();
  if (!['user', 'system'].includes(type)) throw new DatabaseAdapterError('INFLUXDB_RESTORE_SCOPE_INVALID', 'InfluxDB restore bucket type is invalid.', { category: 'integrity' });
  const retentionRules = Array.isArray(input.retentionRules) ? input.retentionRules.map((rule) => {
    if (!rule || String(rule.type || '').toLowerCase() !== 'expire') throw new DatabaseAdapterError('INFLUXDB_RESTORE_SCOPE_INVALID', 'InfluxDB restore retention evidence is invalid.', { category: 'integrity' });
    return Object.freeze({ type: 'expire', everySeconds: boundedInteger(rule.everySeconds, 'InfluxDB retention duration'), shardGroupDurationSeconds: boundedInteger(rule.shardGroupDurationSeconds ?? 0, 'InfluxDB shard-group duration') });
  }) : [];
  if (retentionRules.length > 10) throw new DatabaseAdapterError('INFLUXDB_RESTORE_SCOPE_INVALID', 'InfluxDB restore retention evidence is too large.', { category: 'capacity' });
  return Object.freeze({
    id: normalizeId(input.id, 'InfluxDB restore bucket ID'),
    name: requiredText(input.name, 'InfluxDB restore bucket name', 255),
    type,
    schemaType: optionalText(input.schemaType, 'InfluxDB restore bucket schema type', 40),
    retentionRules
  });
}

function normalizeRestoreSource(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.product !== 'influxdb-oss-v2') throw new DatabaseAdapterError('INFLUXDB_RESTORE_SOURCE_INVALID', 'Authenticated InfluxDB restore evidence is invalid.', { category: 'integrity' });
  const scopeType = String(input.scope?.type || '').toLowerCase();
  if (!['organization', 'bucket'].includes(scopeType)) throw new DatabaseAdapterError('INFLUXDB_RESTORE_SCOPE_INVALID', 'InfluxDB restore scope is invalid.', { category: 'integrity' });
  const buckets = Array.isArray(input.scope?.buckets) ? input.scope.buckets.map(normalizeRestoreBucket) : [];
  if (buckets.length > MAX_BUCKETS || new Set(buckets.map((bucket) => bucket.id)).size !== buckets.length || (scopeType === 'bucket' && buckets.length !== 1)) throw new DatabaseAdapterError('INFLUXDB_RESTORE_SCOPE_INVALID', 'InfluxDB restore bucket evidence is incomplete or ambiguous.', { category: 'integrity' });
  const bucketId = scopeType === 'bucket' ? normalizeId(input.scope.bucketId, 'InfluxDB restore bucket ID') : null;
  if (scopeType === 'bucket' && (buckets.length !== 1 || buckets[0].id !== bucketId || buckets[0].name !== requiredText(input.scope.bucketName, 'InfluxDB restore bucket name', 255))) throw new DatabaseAdapterError('INFLUXDB_RESTORE_SCOPE_INVALID', 'InfluxDB bucket restore evidence is inconsistent.', { category: 'integrity' });
  const fileCount = boundedInteger(input.nativeMedia?.fileCount, 'InfluxDB restore media file count');
  const totalBytes = boundedInteger(input.nativeMedia?.totalBytes, 'InfluxDB restore media byte count');
  const mediaFingerprint = requiredText(input.nativeMedia?.mediaFingerprint, 'InfluxDB restore media fingerprint', 80);
  const deploymentFingerprint = requiredText(input.deploymentFingerprint, 'Protected InfluxDB deployment fingerprint', 80);
  if (fileCount < 1 || fileCount > MAX_BACKUP_FILES || totalBytes < 1 || totalBytes > MAX_BACKUP_BYTES || !/^sha256:[0-9a-f]{64}$/.test(mediaFingerprint)) throw new DatabaseAdapterError('INFLUXDB_RESTORE_MEDIA_INVALID', 'InfluxDB restore media evidence is invalid.', { category: 'integrity' });
  if (!/^sha256:[0-9a-f]{64}$/.test(deploymentFingerprint)) throw new DatabaseAdapterError('INFLUXDB_RESTORE_SOURCE_INVALID', 'Protected InfluxDB deployment identity is invalid.', { category: 'integrity' });
  return Object.freeze({
    product: 'influxdb-oss-v2', productVersion: parseVersion(input.productVersion).text, cliVersion: parseVersion(input.cliVersion, 'Influx CLI').text,
    deploymentFingerprint,
    scope: Object.freeze({ type: scopeType, organizationId: normalizeId(input.scope.organizationId, 'InfluxDB restore organization ID'), organizationName: requiredText(input.scope.organizationName, 'InfluxDB restore organization name', 255), bucketId, bucketName: scopeType === 'bucket' ? requiredText(input.scope.bucketName, 'InfluxDB restore bucket name', 255) : null, buckets }),
    nativeMedia: Object.freeze({ fileCount, totalBytes, mediaFingerprint })
  });
}

function normalizeBackupExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB backup execution must be an object.');
  const allowed = ['engine', 'scope', 'organizationId', 'organizationName', 'bucketId', 'bucketName', 'deploymentFingerprint', 'inventoryFingerprint', 'connectionRevision'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB backup execution field: ${unknown[0]}.`);
  const scope = String(input.scope || '').toLowerCase();
  if (!['organization', 'bucket'].includes(scope)) throw new TypeError('InfluxDB backup scope must be one organization or one bucket.');
  const bucketId = scope === 'bucket' ? normalizeId(input.bucketId, 'InfluxDB bucket ID') : null;
  const bucketName = scope === 'bucket' ? requiredText(input.bucketName, 'InfluxDB bucket name', 255) : null;
  const connectionRevision = Number(input.connectionRevision);
  if (!Number.isInteger(connectionRevision) || connectionRevision < 1) throw new TypeError('InfluxDB connection revision is invalid.');
  const deploymentFingerprint = requiredText(input.deploymentFingerprint, 'InfluxDB deployment fingerprint', 80);
  const inventoryFingerprint = requiredText(input.inventoryFingerprint, 'InfluxDB inventory fingerprint', 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(deploymentFingerprint) || !/^sha256:[0-9a-f]{64}$/.test(inventoryFingerprint)) throw new TypeError('InfluxDB backup fingerprints are invalid.');
  return Object.freeze({
    engine: 'influxdb', scope, organizationId: normalizeId(input.organizationId, 'InfluxDB organization ID'),
    organizationName: requiredText(input.organizationName, 'InfluxDB organization name', 255), bucketId, bucketName,
    deploymentFingerprint, inventoryFingerprint, connectionRevision
  });
}

async function digestFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function inspectBackupDirectory(directory) {
  const root = path.resolve(requiredText(directory, 'InfluxDB backup directory', 4096));
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new DatabaseAdapterError('INFLUXDB_BACKUP_OUTPUT_INVALID', 'InfluxDB did not create a regular backup directory.', { category: 'integrity' });
  const files = [];
  let directoryCount = 0;
  let totalBytes = 0;
  const pending = [{ absolutePath: root, relativePath: '' }];
  while (pending.length) {
    const current = pending.pop();
    directoryCount += 1;
    if (directoryCount > MAX_BACKUP_DIRECTORIES) throw new DatabaseAdapterError('INFLUXDB_BACKUP_OUTPUT_LIMIT', 'InfluxDB backup output contains too many directories.', { category: 'capacity' });
    const entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    if (entries.length > MAX_BACKUP_FILES) throw new DatabaseAdapterError('INFLUXDB_BACKUP_OUTPUT_LIMIT', 'InfluxDB backup output contains too many entries.', { category: 'capacity' });
    for (const entry of entries) {
      if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes('\0') || /[/\\]/.test(entry.name)) throw new DatabaseAdapterError('INFLUXDB_BACKUP_OUTPUT_INVALID', 'InfluxDB created an unsafe backup member name.', { category: 'integrity' });
      const absolutePath = path.join(current.absolutePath, entry.name);
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new DatabaseAdapterError('INFLUXDB_BACKUP_OUTPUT_INVALID', 'InfluxDB backup output contains a symbolic link.', { category: 'integrity' });
      if (stat.isDirectory()) pending.push({ absolutePath, relativePath });
      else if (stat.isFile()) {
        if (stat.size < 1) throw new DatabaseAdapterError('INFLUXDB_BACKUP_OUTPUT_INVALID', 'InfluxDB backup output contains an empty file.', { category: 'integrity' });
        totalBytes += stat.size;
        if (files.length >= MAX_BACKUP_FILES || !Number.isSafeInteger(totalBytes) || totalBytes > MAX_BACKUP_BYTES) throw new DatabaseAdapterError('INFLUXDB_BACKUP_OUTPUT_LIMIT', 'InfluxDB backup output exceeds the supported size or file count.', { category: 'capacity' });
        files.push(Object.freeze({ relativePath, absolutePath, sizeBytes: stat.size, contentDigest: await digestFile(absolutePath) }));
      } else throw new DatabaseAdapterError('INFLUXDB_BACKUP_OUTPUT_INVALID', 'InfluxDB backup output contains an unsupported file type.', { category: 'integrity' });
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  if (!files.length || files.filter((file) => file.relativePath.endsWith('.manifest')).length !== 1) throw new DatabaseAdapterError('INFLUXDB_BACKUP_MANIFEST_INVALID', 'InfluxDB backup output must contain one native manifest.', { category: 'integrity' });
  return Object.freeze({ files, fileCount: files.length, totalBytes, mediaFingerprint: stableDigest(files.map(({ relativePath, sizeBytes, contentDigest }) => ({ relativePath, sizeBytes, contentDigest }))) });
}

function parseVersion(value, label = 'InfluxDB server') {
  const text = requiredText(value, `${label} version`, 100).replace(/^v/i, '');
  const match = /^(2)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) throw new DatabaseAdapterError('INFLUXDB_VERSION_UNSUPPORTED', `${label} must report a supported OSS v2 semantic version.`, { category: 'compatibility' });
  return Object.freeze({ text, major: 2, minor: Number(match[2]), patch: Number(match[3]) });
}

function parseCliVersion(output) {
  const match = /(?:^|\s)Influx CLI\s+v?(2\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/i.exec(String(output || ''));
  if (!match) throw new DatabaseAdapterError('INFLUXDB_CLI_VERSION_INVALID', 'The Influx CLI did not report a supported v2 semantic version.', { category: 'compatibility' });
  return parseVersion(match[1], 'Influx CLI');
}

function normalizeId(value, label) {
  const id = requiredText(value, label, 32).toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(id)) throw new DatabaseAdapterError('INFLUXDB_IDENTITY_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return id;
}

function boundedInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new DatabaseAdapterError('INFLUXDB_INVENTORY_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return number;
}

function normalizeOrganizations(input) {
  if (!Array.isArray(input) || input.length > MAX_ORGANIZATIONS) throw new DatabaseAdapterError('INFLUXDB_ORGANIZATIONS_INVALID', 'InfluxDB returned invalid organization inventory.', { category: 'integrity' });
  const ids = new Set();
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('INFLUXDB_ORGANIZATIONS_INVALID', 'InfluxDB returned invalid organization metadata.', { category: 'integrity' });
    const id = normalizeId(raw.id, 'InfluxDB organization ID');
    if (ids.has(id)) throw new DatabaseAdapterError('INFLUXDB_ORGANIZATIONS_INVALID', 'InfluxDB returned duplicate organization identity.', { category: 'integrity' });
    ids.add(id);
    const status = String(raw.status || 'active').toLowerCase();
    if (!['active', 'inactive'].includes(status)) throw new DatabaseAdapterError('INFLUXDB_ORGANIZATIONS_INVALID', 'InfluxDB returned invalid organization status.', { category: 'integrity' });
    return Object.freeze({ id, name: requiredText(raw.name, 'InfluxDB organization name', 255), status, selectable: status === 'active' });
  }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
}

function normalizeBuckets(input, organizationIds) {
  if (!Array.isArray(input) || input.length > MAX_BUCKETS) throw new DatabaseAdapterError('INFLUXDB_BUCKETS_INVALID', 'InfluxDB returned invalid bucket inventory.', { category: 'integrity' });
  const ids = new Set();
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DatabaseAdapterError('INFLUXDB_BUCKETS_INVALID', 'InfluxDB returned invalid bucket metadata.', { category: 'integrity' });
    const id = normalizeId(raw.id, 'InfluxDB bucket ID');
    const organizationId = normalizeId(raw.orgID, 'InfluxDB bucket organization ID');
    if (ids.has(id) || !organizationIds.has(organizationId)) throw new DatabaseAdapterError('INFLUXDB_BUCKETS_INVALID', 'InfluxDB bucket ownership is invalid.', { category: 'integrity' });
    ids.add(id);
    const type = String(raw.type || 'user').toLowerCase();
    if (!['user', 'system'].includes(type)) throw new DatabaseAdapterError('INFLUXDB_BUCKETS_INVALID', 'InfluxDB bucket type is invalid.', { category: 'integrity' });
    const retentionRules = Array.isArray(raw.retentionRules) ? raw.retentionRules.map((rule) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule) || String(rule.type || '').toLowerCase() !== 'expire') throw new DatabaseAdapterError('INFLUXDB_BUCKETS_INVALID', 'InfluxDB bucket retention rule is invalid.', { category: 'integrity' });
      return Object.freeze({ type: 'expire', everySeconds: boundedInteger(rule.everySeconds, 'InfluxDB retention duration'), shardGroupDurationSeconds: boundedInteger(rule.shardGroupDurationSeconds ?? 0, 'InfluxDB shard-group duration') });
    }) : [];
    if (retentionRules.length > 10) throw new DatabaseAdapterError('INFLUXDB_BUCKETS_INVALID', 'InfluxDB bucket has too many retention rules.', { category: 'integrity' });
    return Object.freeze({ id, organizationId, name: requiredText(raw.name, 'InfluxDB bucket name', 255), type, schemaType: optionalText(raw.schemaType, 'InfluxDB bucket schema type', 40), retentionRules, selectable: type === 'user' && !String(raw.name).startsWith('_') });
  }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
}

async function readPaged(request, apiPath, field, maximum) {
  const items = [];
  for (let offset = 0; offset < maximum; offset += PAGE_SIZE) {
    const response = await request(apiPath, { limit: PAGE_SIZE, offset });
    const page = response?.body?.[field];
    if (!Array.isArray(page)) throw new DatabaseAdapterError('INFLUXDB_RESPONSE_INVALID', `InfluxDB returned invalid ${field} pagination.`, { category: 'integrity' });
    if (items.length + page.length > maximum) throw new DatabaseAdapterError('INFLUXDB_INVENTORY_LIMIT_EXCEEDED', `InfluxDB exposes too many ${field}.`, { category: 'capacity' });
    items.push(...page);
    const total = response.body?.total;
    if (page.length < PAGE_SIZE || Number.isSafeInteger(total) && items.length >= total) return items;
  }
  throw new DatabaseAdapterError('INFLUXDB_INVENTORY_LIMIT_EXCEEDED', `InfluxDB exposes too many ${field}.`, { category: 'capacity' });
}

class InfluxDbOssV2Adapter {
  constructor({ transport = defaultTransport, commandRunner = defaultCommandRunner, clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    this.transport = transport;
    this.commandRunner = commandRunner;
    this.clock = clock;
    this.now = now;
  }

  manifest() {
    return {
      apiVersion: 1, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, displayName: 'InfluxDB OSS v2', engine: 'influxdb', executionReady: true, sourceEnrollmentReady: true,
      serverVersionRange: 'Self-managed InfluxDB OSS 2.x', restoreVersionRange: 'Exact-version alternate self-managed InfluxDB OSS v2 instances',
      capabilities: {
        backupMethods: ['physical'], backupModes: ['full'], selection: { database: true, schema: false, table: true, globalObjects: false },
        consistencyStrategies: [{ id: 'influxdb-v2-native-backup', produces: 'application', backupMethods: ['physical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: true }],
        transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null },
        streaming: { backup: true, restore: true, compression: true, encryption: false }, restore: { alternateTarget: true, offlineBundle: false, originalTarget: false, nativeValidation: true }, replicaAware: false
      },
      requiredTools: [{ name: 'influx', versionRange: 'Influx CLI 2.x', operations: ['discovery', 'backup', 'restore'] }],
      requiredPrivileges: [{ id: 'influxdb-v2-inventory', operations: ['discovery', 'restore'], required: true, safeDescription: 'Read organization and bucket identities, system/user scope, and retention rules.' }]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }
  validateConfig(input) { try { normalizeConfig(input); return []; } catch (error) { return [{ path: '', code: 'INFLUXDB_CONFIG_INVALID', severity: 'error', message: error.message }]; } }

  async readIdentity(context = {}, input = {}) {
    const config = normalizeConfig(input);
    const token = await context.resolveSecret?.(config.tokenSecretRefId);
    const authorization = authorizationHeader(token);
    const request = (apiPath, query) => this.transport({ config, apiPath, query, authorization, signal: context.signal });
    const healthResponse = await request('/health');
    const health = healthResponse.body;
    if (!health || typeof health !== 'object' || Array.isArray(health) || String(health.name || '').toLowerCase() !== 'influxdb' || String(health.status || '').toLowerCase() !== 'pass') throw new DatabaseAdapterError('INFLUXDB_HEALTH_INVALID', 'The endpoint is not a healthy self-managed InfluxDB OSS v2 server.', { category: 'compatibility' });
    const version = parseVersion(health.version);
    if (config.expectedVersion && config.expectedVersion !== version.text) throw new DatabaseAdapterError('INFLUXDB_VERSION_CHANGED', 'InfluxDB version changed since the connection was tested.', { category: 'integrity' });
    const cliResult = await (context.runCommand || this.commandRunner)({ executable: config.cliPath, args: ['version'], timeoutMs: config.timeoutMs, signal: context.signal });
    const cliVersion = parseCliVersion(`${cliResult?.stdout || ''}\n${cliResult?.stderr || ''}`);
    if (config.expectedCliVersion && config.expectedCliVersion !== cliVersion.text) throw new DatabaseAdapterError('INFLUXDB_CLI_VERSION_CHANGED', 'Influx CLI version changed since the connection was tested.', { category: 'integrity' });
    const organizations = normalizeOrganizations(await readPaged(request, '/api/v2/orgs', 'orgs', MAX_ORGANIZATIONS));
    const organizationIds = new Set(organizations.map((item) => item.id));
    const buckets = normalizeBuckets(await readPaged(request, '/api/v2/buckets', 'buckets', MAX_BUCKETS), organizationIds);
    const deploymentFingerprint = stableDigest({ product: 'influxdb-oss-v2', protocol: config.protocol, host: config.host, port: config.port, basePath: config.basePath, version: version.text, organizationIds: organizations.map((item) => item.id).sort() });
    if (config.expectedDeploymentFingerprint && config.expectedDeploymentFingerprint !== deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB_DEPLOYMENT_CHANGED', 'InfluxDB deployment identity changed since the connection was tested.', { category: 'integrity' });
    const inventoryFingerprint = stableDigest({ organizations: organizations.map(({ id, name, status }) => ({ id, name, status })), buckets: buckets.map(({ id, organizationId, name, type, schemaType, retentionRules }) => ({ id, organizationId, name, type, schemaType, retentionRules })) });
    return Object.freeze({ product: 'influxdb-oss-v2', version, cliVersion, organizations, buckets, deploymentFingerprint, inventoryFingerprint, tokenRecovery: 'hash-only-plaintext-unrecoverable' });
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const identity = await this.readIdentity(context, input);
      return normalizeConnectionTestResult({
        adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'success',
        checks: [
          { id: 'server-version', status: 'pass', safeMessage: `InfluxDB OSS ${identity.version.text} is supported for discovery.` },
          { id: 'cli-version', status: 'pass', safeMessage: `Influx CLI ${identity.cliVersion.text} is available on this device.` },
          { id: 'organization-inventory', status: 'pass', safeMessage: `${identity.organizations.length} organization identities were authenticated.` },
          { id: 'bucket-inventory', status: 'pass', safeMessage: `${identity.buckets.length} bucket identities and retention policies were authenticated.` },
          { id: 'token-recovery-boundary', status: 'pass', safeMessage: 'InfluxDB token hashes may be backed up later, but plaintext tokens can never be recovered or displayed.' }
        ],
        remotePlatform: { engine: 'influxdb', version: identity.version.text, distribution: 'oss-v2', platform: null },
        endpointIdentity: { product: identity.product, version: identity.version.text, cliVersion: identity.cliVersion.text, deploymentFingerprint: identity.deploymentFingerprint, inventoryFingerprint: identity.inventoryFingerprint, organizationCount: identity.organizations.length, bucketCount: identity.buckets.length, userBucketCount: identity.buckets.filter((item) => item.selectable).length, recoveryBoundary: identity.tokenRecovery }, error: null
      }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    } catch (error) {
      const safe = error instanceof DatabaseAdapterError ? error : new DatabaseAdapterError('INFLUXDB_DISCOVERY_FAILED', 'DeployerX could not complete InfluxDB discovery.', { category: 'connectivity', retryable: true });
      return normalizeConnectionTestResult({ adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'failure', checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null } }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    }
  }

  async *discover(context = {}, request = {}) {
    const kind = String(request.kind || 'all').toLowerCase();
    if (!DISCOVERY_KINDS.has(kind)) throw new DatabaseAdapterError('INFLUXDB_DISCOVERY_KIND_UNSUPPORTED', 'InfluxDB discovery kind is unsupported.', { category: 'compatibility' });
    const identity = await this.readIdentity(context, request.connection);
    const common = { nextCursor: null, product: identity.product, version: identity.version, cliVersion: identity.cliVersion, deploymentFingerprint: identity.deploymentFingerprint, inventoryFingerprint: identity.inventoryFingerprint, tokenRecovery: identity.tokenRecovery };
    if (kind === 'organizations') yield { ...common, items: identity.organizations };
    else if (kind === 'buckets') yield { ...common, items: identity.buckets };
    else yield { ...common, items: [], organizations: identity.organizations, buckets: identity.buckets, capabilities: { nativeBackupAvailable: true, nativeRestoreAvailable: true, plaintextTokenRecovery: false } };
  }

  async preflight(context = {}, request = {}) {
    if (request.operation !== 'backup') throw new DatabaseAdapterError('INFLUXDB_OPERATION_UNSUPPORTED', 'InfluxDB supports native full-backup preflight only.', { category: 'compatibility' });
    const identity = await this.readIdentity(context, request.connection);
    const execution = normalizeBackupExecution(request.execution);
    if (execution.deploymentFingerprint !== identity.deploymentFingerprint || execution.inventoryFingerprint !== identity.inventoryFingerprint) throw new DatabaseAdapterError('INFLUXDB_SOURCE_IDENTITY_CHANGED', 'InfluxDB deployment or inventory changed after Source enrollment.', { category: 'integrity' });
    const organization = identity.organizations.find((item) => item.id === execution.organizationId && item.name === execution.organizationName && item.selectable);
    const bucket = execution.scope === 'bucket' ? identity.buckets.find((item) => item.id === execution.bucketId && item.organizationId === execution.organizationId && item.name === execution.bucketName && item.selectable) : null;
    if (!organization || (execution.scope === 'bucket' && !bucket)) throw new DatabaseAdapterError('INFLUXDB_SOURCE_SELECTION_CHANGED', 'The selected InfluxDB organization or bucket is absent from current authenticated inventory.', { category: 'integrity' });
    return {
      checkedAt: this.clock(), serverVersion: identity.version.text, serverVersionSupported: true, serverIdentityFingerprint: identity.deploymentFingerprint,
      consistency: [{ method: 'influxdb-v2-native-backup', verified: true, produces: 'application' }],
      tools: [{ name: 'influx', version: identity.cliVersion.text, compatible: true, executableFingerprint: stableDigest({ executable: normalizeConfig(request.connection).cliPath, version: identity.cliVersion.text }) }],
      privileges: [], coordinateCaptureVerified: true, warnings: ['Plaintext API tokens cannot be recovered from restored token hashes.'],
      metadata: { product: identity.product, inventoryFingerprint: identity.inventoryFingerprint, scope: execution.scope, organizationId: execution.organizationId, bucketId: execution.bucketId }
    };
  }

  async planBackup(_context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const execution = normalizeBackupExecution(request.execution);
    if (request.consistency?.method !== 'influxdb-v2-native-backup' || request.consistency?.backupMethod !== 'physical' || request.consistency?.backupMode !== 'full' || request.consistency?.captureCoordinates !== true) throw new DatabaseAdapterError('INFLUXDB_BACKUP_PLAN_INVALID', 'InfluxDB backup requires native physical full mode with coordinate capture.', { category: 'compatibility' });
    const args = ['backup', '--host', endpointUrl(config), '--org-id', execution.organizationId];
    if (execution.scope === 'bucket') args.push('--bucket-id', execution.bucketId);
    return Object.freeze({
      version: 1, operation: 'influxdb-oss-v2-full', connection: config, execution, args,
      consistency: request.consistency,
      artifact: { kind: 'physical-backup', path: 'influxdb/backup-metadata.json', mediaType: 'application/json' }
    });
  }

  async createBackupMedia(context = {}, plan = {}, destinationDirectory) {
    if (plan.operation !== 'influxdb-oss-v2-full') throw new DatabaseAdapterError('INFLUXDB_BACKUP_PLAN_INVALID', 'InfluxDB backup plan is invalid.', { category: 'integrity' });
    const destination = path.resolve(requiredText(destinationDirectory, 'InfluxDB backup destination', 4096));
    if (await fs.lstat(destination).catch(() => null)) throw new DatabaseAdapterError('INFLUXDB_BACKUP_DESTINATION_EXISTS', 'InfluxDB backup staging destination already exists.', { category: 'conflict' });
    const before = await this.readIdentity(context, plan.connection);
    if (before.deploymentFingerprint !== plan.execution.deploymentFingerprint || before.inventoryFingerprint !== plan.execution.inventoryFingerprint) throw new DatabaseAdapterError('INFLUXDB_SOURCE_IDENTITY_CHANGED', 'InfluxDB deployment or inventory changed before backup.', { category: 'integrity' });
    const token = await context.resolveSecret?.(plan.connection.tokenSecretRefId);
    authorizationHeader(token);
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const runCommand = context.runCommand || this.commandRunner;
      await runCommand({ executable: plan.connection.cliPath, args: [...plan.args, destination], env: nativeEnvironment(token), timeoutMs: MAX_BACKUP_TIMEOUT_MS, signal: context.signal });
      const media = await inspectBackupDirectory(destination);
      const after = await this.readIdentity(context, plan.connection);
      if (after.deploymentFingerprint !== before.deploymentFingerprint || after.inventoryFingerprint !== before.inventoryFingerprint || after.version.text !== before.version.text || after.cliVersion.text !== before.cliVersion.text) throw new DatabaseAdapterError('INFLUXDB_SOURCE_IDENTITY_CHANGED', 'InfluxDB deployment, inventory, or tool identity changed during backup.', { category: 'integrity' });
      return Object.freeze({ directory: destination, ...media, product: before.product, productVersion: before.version.text, cliVersion: before.cliVersion.text, deploymentFingerprint: before.deploymentFingerprint, inventoryFingerprint: before.inventoryFingerprint, selection: plan.execution, tokenRecovery: before.tokenRecovery });
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      if (error instanceof DatabaseAdapterError) throw error;
      throw new DatabaseAdapterError('INFLUXDB_BACKUP_FAILED', 'DeployerX could not create the native InfluxDB backup.', { category: error?.category || 'execution', retryable: Boolean(error?.retryable) });
    }
  }

  async executeBackup(context = {}, plan = {}) {
    if (!context.destinationDirectory) throw new DatabaseAdapterError('INFLUXDB_BACKUP_DESTINATION_REQUIRED', 'InfluxDB backup execution requires an owned staging directory.', { category: 'configuration' });
    return this.createBackupMedia(context, plan, context.destinationDirectory);
  }
  async planRestore(context = {}, request = {}) {
    if (request.mode !== 'alternate' || request.confirmation !== RESTORE_CONFIRMATION) throw new DatabaseAdapterError('INFLUXDB_RESTORE_MODE_UNSUPPORTED', 'InfluxDB restore requires explicit alternate-instance confirmation.', { category: 'compatibility' });
    const connection = normalizeConfig(request.connection);
    const source = normalizeRestoreSource(request.source);
    const target = await this.readIdentity(context, connection);
    if (target.version.text !== source.productVersion || target.cliVersion.text !== source.cliVersion) throw new DatabaseAdapterError('INFLUXDB_RESTORE_VERSION_INCOMPATIBLE', 'The alternate InfluxDB server and CLI must exactly match the protected versions.', { category: 'compatibility' });
    if (target.deploymentFingerprint === source.deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB_RESTORE_SOURCE_TARGET_COLLISION', 'Choose an alternate InfluxDB deployment; original-target replacement is unavailable.', { category: 'conflict' });
    const organizationCollision = target.organizations.some((item) => item.id === source.scope.organizationId || item.name === source.scope.organizationName);
    const bucketIds = new Set(source.scope.buckets.map((item) => item.id));
    if (organizationCollision || target.buckets.some((item) => bucketIds.has(item.id))) throw new DatabaseAdapterError('INFLUXDB_RESTORE_TARGET_NOT_EMPTY', 'The alternate target already contains an authenticated organization or bucket identity from this backup.', { category: 'conflict' });
    const args = ['restore', '--host', endpointUrl(connection), source.scope.type === 'bucket' ? '--bucket-id' : '--org-id', source.scope.type === 'bucket' ? source.scope.bucketId : source.scope.organizationId];
    return Object.freeze({ version: 1, operation: 'influxdb-oss-v2-alternate-restore', connection, source, target: Object.freeze({ productVersion: target.version.text, cliVersion: target.cliVersion.text, deploymentFingerprint: target.deploymentFingerprint, inventoryFingerprint: target.inventoryFingerprint, endpointFingerprint: stableDigest({ protocol: connection.protocol, host: connection.host, port: connection.port, basePath: connection.basePath, productVersion: target.version.text, cliVersion: target.cliVersion.text }) }), args });
  }

  async executeRestore(context = {}, plan = {}) {
    if (plan.operation !== 'influxdb-oss-v2-alternate-restore') throw new DatabaseAdapterError('INFLUXDB_RESTORE_PLAN_INVALID', 'InfluxDB restore plan is invalid.', { category: 'integrity' });
    const directory = path.resolve(requiredText(context.sourceDirectory, 'InfluxDB restore staging directory', 4096));
    const media = await inspectBackupDirectory(directory);
    if (media.fileCount !== plan.source.nativeMedia.fileCount || media.totalBytes !== plan.source.nativeMedia.totalBytes || media.mediaFingerprint !== plan.source.nativeMedia.mediaFingerprint) throw new DatabaseAdapterError('INFLUXDB_RESTORE_MEDIA_INVALID', 'Materialized InfluxDB media does not match the authenticated RecoveryPoint.', { category: 'integrity' });
    const before = await this.readIdentity(context, plan.connection);
    if (before.deploymentFingerprint !== plan.target.deploymentFingerprint || before.inventoryFingerprint !== plan.target.inventoryFingerprint) throw new DatabaseAdapterError('INFLUXDB_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB target changed before native restore.', { category: 'integrity' });
    const token = await context.resolveSecret?.(plan.connection.tokenSecretRefId);
    authorizationHeader(token);
    await context.onMutationStarted?.();
    try {
      await (context.runCommand || this.commandRunner)({ executable: plan.connection.cliPath, args: [...plan.args, directory], env: nativeEnvironment(token), timeoutMs: MAX_RESTORE_TIMEOUT_MS, signal: context.signal });
    } catch (error) {
      if (error instanceof DatabaseAdapterError) throw error;
      throw new DatabaseAdapterError('INFLUXDB_RESTORE_FAILED', 'The native InfluxDB restore did not complete.', { category: error?.category || 'execution', retryable: false });
    }
    const discovery = await this.readIdentity(context, { ...plan.connection, expectedDeploymentFingerprint: null });
    return Object.freeze({ version: 1, plan, discovery, completedAt: this.clock() });
  }

  async validateRestore(context = {}, restored = {}) {
    const plan = restored.plan;
    if (plan?.operation !== 'influxdb-oss-v2-alternate-restore') throw new DatabaseAdapterError('INFLUXDB_RESTORE_PLAN_INVALID', 'InfluxDB restore validation evidence is invalid.', { category: 'integrity' });
    const connection = normalizeConfig(plan.connection);
    const endpointFingerprint = stableDigest({ protocol: connection.protocol, host: connection.host, port: connection.port, basePath: connection.basePath, productVersion: plan.source.productVersion, cliVersion: plan.source.cliVersion });
    if (plan.target?.endpointFingerprint !== endpointFingerprint) throw new DatabaseAdapterError('INFLUXDB_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB target binding changed during recovery.', { category: 'integrity' });
    const discovery = restored.discovery || await this.readIdentity(context, { ...plan.connection, expectedDeploymentFingerprint: null });
    if (discovery.version.text !== plan.source.productVersion || discovery.cliVersion.text !== plan.source.cliVersion || discovery.deploymentFingerprint === plan.source.deploymentFingerprint) throw new DatabaseAdapterError('INFLUXDB_RESTORE_VALIDATION_FAILED', 'The restored InfluxDB target identity is invalid.', { category: 'integrity' });
    const organization = discovery.organizations.find((item) => item.id === plan.source.scope.organizationId && item.name === plan.source.scope.organizationName && item.status === 'active');
    const buckets = plan.source.scope.buckets.map((expected) => {
      const actual = discovery.buckets.find((item) => item.id === expected.id && item.organizationId === plan.source.scope.organizationId && item.name === expected.name);
      if (!actual || actual.type !== expected.type || actual.schemaType !== expected.schemaType || JSON.stringify(actual.retentionRules) !== JSON.stringify(expected.retentionRules)) throw new DatabaseAdapterError('INFLUXDB_RESTORE_VALIDATION_FAILED', 'A restored InfluxDB bucket or retention rule does not match the authenticated backup.', { category: 'integrity' });
      return Object.freeze({ id: actual.id, name: actual.name, type: actual.type, retentionRules: actual.retentionRules });
    });
    if (!organization) throw new DatabaseAdapterError('INFLUXDB_RESTORE_VALIDATION_FAILED', 'The restored InfluxDB organization identity does not match the authenticated backup.', { category: 'integrity' });
    const restoredUserBucketIds = discovery.buckets.filter((item) => item.organizationId === plan.source.scope.organizationId && item.selectable).map((item) => item.id).sort();
    if (JSON.stringify(restoredUserBucketIds) !== JSON.stringify(buckets.filter((item) => item.type === 'user').map((item) => item.id).sort())) throw new DatabaseAdapterError('INFLUXDB_RESTORE_VALIDATION_FAILED', 'The restored InfluxDB organization contains an unexpected user-bucket identity.', { category: 'integrity' });
    return Object.freeze({ valid: true, status: 'succeeded', organization: Object.freeze({ id: organization.id, name: organization.name }), buckets, checks: ['server-version', 'cli-version', 'alternate-deployment', 'organization-identity', 'bucket-identity', 'retention-rules'] });
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class InfluxDbConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new InfluxDbOssV2Adapter() } = {}) {
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
    const name = requiredText(input.name, 'InfluxDB connection name', 200);
    const token = String(input.token ?? '');
    authorizationHeader(token);
    let tokenRef = null;
    try {
      tokenRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} API token`, secretType: 'token', value: token, scope: 'device' });
      const config = normalizeConfig({ protocol: input.protocol, allowInsecureHttp: input.allowInsecureHttp, host: input.host, port: input.port, basePath: input.basePath, tokenSecretRefId: tokenRef.id, caFile: input.caFile, cliPath: input.cliPath, timeoutMs: input.timeoutMs });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(tokenRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device',
          endpoint: { protocol: config.protocol, allowInsecureHttp: config.allowInsecureHttp, host: config.host, port: config.port, basePath: config.basePath, caFile: config.caFile, cliPath: config.cliPath, timeoutMs: config.timeoutMs, expectedVersion: null, expectedCliVersion: null, expectedDeploymentFingerprint: null },
          secretRefIds: [tokenRef.id], trust: { mode: config.protocol, fingerprint: null }, workerAffinity: [`device:${this.deviceId}`], lastTest: null, influxdbInventory: null
        });
      });
    } catch (error) {
      if (tokenRef) await this.secretStore.delete({ workspaceId: tenant, id: tokenRef.id }).catch(() => {});
      throw error;
    }
  }

  config(connection) {
    return normalizeConfig({ ...connection.endpoint, tokenSecretRefId: connection.secretRefIds?.[0] });
  }

  async test(workspaceId, connectionId, actorId = 'system', signal) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('InfluxDB connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This InfluxDB connection belongs to another device.');
    const context = { resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal };
    const result = await this.adapter.testConnection(context, this.config(current));
    let inventory = null;
    if (result.status === 'success') {
      const pages = [];
      for await (const page of this.adapter.discover(context, { connection: { ...this.config(current), expectedVersion: result.endpointIdentity.version, expectedCliVersion: result.endpointIdentity.cliVersion, expectedDeploymentFingerprint: result.endpointIdentity.deploymentFingerprint }, kind: 'all' })) pages.push(page);
      if (pages.length !== 1 || pages[0].inventoryFingerprint !== result.endpointIdentity.inventoryFingerprint) throw new DatabaseAdapterError('INFLUXDB_INVENTORY_CHANGED', 'InfluxDB inventory changed while the connection was being tested.', { category: 'integrity' });
      inventory = { version: 1, capturedAt: result.testedAt, product: pages[0].product, productVersion: pages[0].version.text, cliVersion: pages[0].cliVersion.text, deploymentFingerprint: pages[0].deploymentFingerprint, inventoryFingerprint: pages[0].inventoryFingerprint, organizations: pages[0].organizations, buckets: pages[0].buckets, tokenRecovery: pages[0].tokenRecovery };
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const endpoint = result.status === 'success' ? { ...current.endpoint, expectedVersion: result.endpointIdentity.version, expectedCliVersion: result.endpointIdentity.cliVersion, expectedDeploymentFingerprint: result.endpointIdentity.deploymentFingerprint } : current.endpoint;
    const trust = result.status === 'success' ? { mode: current.endpoint.protocol, fingerprint: result.endpointIdentity.deploymentFingerprint, inventoryFingerprint: result.endpointIdentity.inventoryFingerprint, observedAt: result.testedAt } : current.trust;
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { endpoint, lastTest: result, trust, influxdbInventory: inventory, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('InfluxDB connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This InfluxDB connection belongs to another device.');
    if (current.lastTest?.status !== 'success' || current.trust?.fingerprint !== current.endpoint?.expectedDeploymentFingerprint) throw new Error('Test the InfluxDB connection successfully before discovery.');
    const pages = [];
    for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current), kind: input.kind || 'all' })) pages.push(page);
    if (pages.length !== 1) throw new Error('InfluxDB discovery returned an invalid page count.');
    return pages[0];
  }

  async withExecution(workspaceId, connection, signal, callback) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return callback({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal }, this.config(connection));
  }
}

module.exports = { ADAPTER_ID, ADAPTER_VERSION, InfluxDbConnectionService, InfluxDbOssV2Adapter, MAX_BACKUP_TIMEOUT_MS, MAX_RESTORE_TIMEOUT_MS, RESTORE_CONFIRMATION, authorizationHeader, endpointUrl, inspectBackupDirectory, nativeEnvironment, normalizeBackupExecution, normalizeBuckets, normalizeConfig, normalizeOrganizations, normalizeRestoreSource, parseCliVersion, parseVersion, safeApiPath };
