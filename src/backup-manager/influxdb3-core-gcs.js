const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { once } = require('events');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { Storage } = require('@google-cloud/storage');

const GCS_COPY_PHASES = Object.freeze([
  Object.freeze({ name: 'snapshots', kind: 'prefix' }),
  Object.freeze({ name: 'dbs', kind: 'prefix' }),
  Object.freeze({ name: 'wal', kind: 'prefix' }),
  Object.freeze({ name: 'catalog', kind: 'prefix' }),
  Object.freeze({ name: '_catalog_checkpoint', kind: 'object' })
]);
const MAX_OBJECTS = 100000;
const MAX_DIRECTORIES = 50000;
const MAX_BYTES = 64 * 1024 * 1024 * 1024 * 1024;
const MAX_LIST_PAGES = 1000;

class InfluxDb3CoreGcsError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3CoreGcsError';
    this.code = code;
    this.category = options.category || 'object-store';
    this.retryable = Boolean(options.retryable);
    this.details = options.details || {};
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeNodeId(value) {
  const nodeId = requiredText(value, 'InfluxDB 3 Core node ID', 128);
  if (nodeId === '.' || nodeId === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) throw new TypeError('InfluxDB 3 Core node ID is invalid.');
  return nodeId;
}

function normalizeBucket(value) {
  const bucket = requiredText(value, 'InfluxDB 3 Core GCS bucket', 63);
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,61})[a-z0-9]$/.test(bucket) || bucket.includes('..') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket) || bucket.startsWith('goog') || /google/i.test(bucket)) throw new TypeError('InfluxDB 3 Core GCS bucket is invalid.');
  return bucket;
}

function normalizePrefix(value) {
  const prefix = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!prefix) return '';
  if (prefix.length > 512 || prefix.includes('\\') || prefix.includes('//') || prefix.split('/').some((segment) => !segment || segment === '.' || segment === '..') || path.posix.normalize(prefix) !== prefix) throw new TypeError('InfluxDB 3 Core GCS prefix is invalid.');
  return prefix;
}

function normalizeCoreGcsConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Core GCS configuration must be an object.');
  const allowed = ['objectStore', 'bucket', 'prefix', 'timeoutMs', 'credentialSecretRefId', 'nodeId'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Core GCS field: ${unknown[0]}.`);
  if (input.objectStore !== undefined && String(input.objectStore).toLowerCase() !== 'google') throw new TypeError('InfluxDB 3 Core memory and non-GCS object stores are not valid GCS bindings.');
  const timeoutMs = input.timeoutMs === undefined ? 30000 : Number(input.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('InfluxDB 3 Core GCS timeout is invalid.');
  return Object.freeze({
    objectStore: 'google',
    bucket: normalizeBucket(input.bucket),
    prefix: normalizePrefix(input.prefix),
    timeoutMs,
    credentialSecretRefId: requiredText(input.credentialSecretRefId, 'InfluxDB 3 Core GCS credential SecretRef ID', 200),
    nodeId: normalizeNodeId(input.nodeId)
  });
}

function exactGoogleUrl(value, label, hostname, pathname, allowPathSuffix = false) {
  let url;
  try { url = new URL(requiredText(value, label, 2048)); } catch { throw new TypeError(`${label} is invalid.`); }
  const validPath = allowPathSuffix ? url.pathname.startsWith(pathname) && url.pathname.length > pathname.length : url.pathname === pathname;
  if (url.protocol !== 'https:' || url.hostname !== hostname || !validPath || url.username || url.password || url.port || url.search || url.hash) throw new TypeError(`${label} is invalid.`);
  return url.toString();
}

function normalizePrivateKey(value) {
  const privateKey = requiredText(value, 'InfluxDB 3 Core GCS service-account private key', 16384).replace(/\r\n/g, '\n');
  const lines = privateKey.split('\n');
  if (lines.length < 4 || lines[0] !== '-----BEGIN PRIVATE KEY-----' || lines.at(-1) !== '-----END PRIVATE KEY-----') throw new TypeError('InfluxDB 3 Core GCS service-account private key is invalid.');
  const encoded = lines.slice(1, -1).join('');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new TypeError('InfluxDB 3 Core GCS service-account private key is invalid.');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length < 512 || decoded.length > 8192 || decoded.toString('base64') !== encoded) throw new TypeError('InfluxDB 3 Core GCS service-account private key is invalid.');
  return privateKey;
}

function normalizeGcsCredential(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Core GCS credential is invalid.');
  const allowed = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email', 'client_id', 'auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'client_x509_cert_url', 'universe_domain'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Core GCS credential field: ${unknown[0]}.`);
  if (input.type !== 'service_account') throw new TypeError('InfluxDB 3 Core GCS credential must be a service-account document.');
  const projectId = requiredText(input.project_id, 'InfluxDB 3 Core GCS service-account project ID', 30);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new TypeError('InfluxDB 3 Core GCS service-account project ID is invalid.');
  const privateKeyId = requiredText(input.private_key_id, 'InfluxDB 3 Core GCS service-account private-key ID', 128);
  if (!/^[a-f0-9]{40}$/.test(privateKeyId)) throw new TypeError('InfluxDB 3 Core GCS service-account private-key ID is invalid.');
  const clientEmail = requiredText(input.client_email, 'InfluxDB 3 Core GCS service-account email', 320).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(clientEmail) || !clientEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`)) throw new TypeError('InfluxDB 3 Core GCS service-account email is invalid.');
  const clientId = requiredText(input.client_id, 'InfluxDB 3 Core GCS service-account client ID', 64);
  if (!/^[0-9]{10,64}$/.test(clientId)) throw new TypeError('InfluxDB 3 Core GCS service-account client ID is invalid.');
  exactGoogleUrl(input.auth_uri, 'InfluxDB 3 Core GCS auth URI', 'accounts.google.com', '/o/oauth2/auth');
  exactGoogleUrl(input.token_uri, 'InfluxDB 3 Core GCS token URI', 'oauth2.googleapis.com', '/token');
  exactGoogleUrl(input.auth_provider_x509_cert_url, 'InfluxDB 3 Core GCS auth certificate URL', 'www.googleapis.com', '/oauth2/v1/certs');
  exactGoogleUrl(input.client_x509_cert_url, 'InfluxDB 3 Core GCS client certificate URL', 'www.googleapis.com', '/robot/v1/metadata/x509/', true);
  if (input.universe_domain !== undefined && input.universe_domain !== 'googleapis.com') throw new TypeError('InfluxDB 3 Core GCS universe domain is invalid.');
  return Object.freeze({ projectId, privateKeyId, privateKey: normalizePrivateKey(input.private_key), clientEmail, clientId });
}

function nodePrefix(config) {
  return `${config.prefix ? `${config.prefix}/` : ''}${config.nodeId}/`;
}

function objectGeneration(value) {
  const generation = requiredText(value, 'InfluxDB 3 Core GCS object generation', 32);
  if (!/^[1-9][0-9]{0,30}$/.test(generation)) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_INVALID', 'InfluxDB 3 Core GCS returned an invalid object generation.', { category: 'integrity' });
  return generation;
}

function relativeObjectPath(name, config) {
  const exactPrefix = nodePrefix(config);
  const text = requiredText(name, 'InfluxDB 3 Core GCS object name', 1024);
  if (!text.startsWith(exactPrefix)) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_NAME_INVALID', 'InfluxDB 3 Core GCS returned an object outside the exact node prefix.', { category: 'integrity' });
  const relative = text.slice(exactPrefix.length);
  const marker = relative.endsWith('/');
  const comparable = marker ? relative.slice(0, -1) : relative;
  if (!comparable || comparable.startsWith('/') || comparable.includes('\\') || comparable.includes('//') || comparable.split('/').some((segment) => !segment || segment === '.' || segment === '..') || path.posix.normalize(comparable) !== comparable) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_NAME_INVALID', 'InfluxDB 3 Core GCS returned an unsafe object name.', { category: 'integrity' });
  return relative;
}

function objectPhase(relativePath) {
  if (relativePath === '_catalog_checkpoint') return '_catalog_checkpoint';
  const top = relativePath.split('/')[0];
  if (top === 'table-snapshots') return 'table-snapshots';
  if (GCS_COPY_PHASES.some((phase) => phase.kind === 'prefix' && phase.name === top)) return top;
  throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_LAYOUT_UNSUPPORTED', 'InfluxDB 3 Core GCS contains an unrecognized top-level component.', { category: 'compatibility' });
}

function safeSize(value) {
  const text = String(value ?? '');
  if (!/^(0|[1-9][0-9]{0,20})$/.test(text)) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_INVALID', 'InfluxDB 3 Core GCS returned an invalid object size.', { category: 'integrity' });
  const size = Number(text);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_INVALID', 'InfluxDB 3 Core GCS returned an invalid object size.', { category: 'integrity' });
  return size;
}

function providerStatus(error) {
  const directCode = typeof error?.code === 'number' ? error.code : 0;
  return Number(error?.statusCode || error?.response?.status || error?.response?.statusCode || directCode || 0);
}

function safeProviderError(error, fallbackCode, fallbackMessage) {
  if (error instanceof InfluxDb3CoreGcsError) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ETIMEDOUT') return new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_TIMEOUT', 'The InfluxDB 3 Core GCS operation timed out or was canceled.', { category: 'timeout', retryable: true });
  if ([401, 403].includes(providerStatus(error))) return new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_ACCESS_DENIED', 'InfluxDB 3 Core GCS credentials cannot access the configured bucket and node prefix.', { category: providerStatus(error) === 401 ? 'authentication' : 'authorization' });
  if (providerStatus(error) === 404) return new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_MISSING', 'A required InfluxDB 3 Core GCS object generation is unavailable.', { category: 'integrity' });
  if (providerStatus(error) === 412) return new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_SOURCE_CHANGED', 'An InfluxDB 3 Core GCS object changed before it could be copied.', { category: 'consistency', retryable: true });
  return new InfluxDb3CoreGcsError(fallbackCode, fallbackMessage, { category: 'availability', retryable: true });
}

function targetWriteError(error) {
  if (error instanceof InfluxDb3CoreGcsError) return error;
  if ([409, 412].includes(providerStatus(error))) return new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core GCS node prefix changed during restore.', { category: 'conflict' });
  return safeProviderError(error, 'INFLUXDB3_CORE_GCS_RESTORE_WRITE_FAILED', 'DeployerX could not write an InfluxDB 3 Core GCS restore object.');
}

function normalizeRestoreMember(input, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_MEDIA_INVALID', 'Authenticated InfluxDB 3 Core GCS restore media is invalid.', { category: 'integrity' });
  const relativePath = relativeObjectPath(`${nodePrefix(config)}${requiredText(input.relativePath, 'InfluxDB 3 Core GCS restore member path', 1024)}`, config);
  const phase = objectPhase(relativePath);
  const sizeBytes = safeSize(input.sizeBytes);
  const contentDigest = requiredText(input.contentDigest, 'InfluxDB 3 Core GCS restore member digest', 80).toLowerCase();
  if (relativePath.endsWith('/') || phase === 'table-snapshots' || !/^sha256:[0-9a-f]{64}$/.test(contentDigest)) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_MEDIA_INVALID', 'Authenticated InfluxDB 3 Core GCS restore media is invalid.', { category: 'integrity' });
  return Object.freeze({ relativePath, sizeBytes, contentDigest });
}

function sameFileIdentity(left, right) {
  return Boolean(right?.isFile?.()) && !right.isSymbolicLink() && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

async function authenticateStagedMember(source, member, signal) {
  const before = await fs.lstat(source).catch(() => null);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.size !== member.sizeBytes) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_MEDIA_INVALID', 'An authenticated InfluxDB 3 Core GCS restore member is unavailable.', { category: 'integrity' });
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  try {
    for await (const raw of fsSync.createReadStream(source, { highWaterMark: 1024 * 1024, ...(signal ? { signal } : {}) })) {
      const chunk = Buffer.from(raw);
      sizeBytes += chunk.length;
      hash.update(chunk);
      if (sizeBytes > member.sizeBytes) break;
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_CANCELED', 'The InfluxDB 3 Core GCS restore was canceled.', { category: 'canceled' });
    throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_MEDIA_INVALID', 'An authenticated InfluxDB 3 Core GCS restore member is unreadable.', { category: 'integrity' });
  }
  const after = await fs.lstat(source).catch(() => null);
  const contentDigest = `sha256:${hash.digest('hex')}`;
  if (!sameFileIdentity(before, after) || sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_MEDIA_INVALID', 'An authenticated InfluxDB 3 Core GCS restore member failed SHA-256 authentication.', { category: 'integrity' });
  return before;
}

function phaseDigest(phase, members) {
  return stableDigest(members.filter((member) => member.phase === phase).map(({ relativePath, sizeBytes, generation, lastModified }) => ({ relativePath, sizeBytes, generation, lastModified })));
}

function directoriesForMembers(members) {
  const directories = new Set(GCS_COPY_PHASES.filter((phase) => phase.kind === 'prefix').map((phase) => phase.name));
  for (const member of members) {
    let current = path.posix.dirname(member.relativePath);
    while (current && current !== '.') { directories.add(current); current = path.posix.dirname(current); }
  }
  const result = [...directories].sort((left, right) => left.localeCompare(right, 'en-US'));
  if (result.length > MAX_DIRECTORIES) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_STORAGE_LIMIT', 'InfluxDB 3 Core GCS contains too many logical directories.', { category: 'capacity' });
  return result;
}

class InfluxDb3CoreGcsStore {
  constructor({ config, resolveSecret, bucketClient, clientFactory } = {}) {
    this.config = normalizeCoreGcsConfig(config);
    this.resolveSecret = resolveSecret;
    this.bucketClient = bucketClient || null;
    this.clientFactory = clientFactory || null;
    this.clientPromise = null;
    if (!bucketClient && typeof resolveSecret !== 'function') throw new TypeError('InfluxDB 3 Core GCS SecretRef resolver is required.');
  }

  async client() {
    if (this.bucketClient) return this.bucketClient;
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = this.createClient();
    try { return await this.clientPromise; }
    catch (error) { this.clientPromise = null; throw error; }
  }

  async createClient() {
    let credentialInput;
    try { credentialInput = JSON.parse(await this.resolveSecret(this.config.credentialSecretRefId)); }
    catch { throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_CREDENTIAL_INVALID', 'The InfluxDB 3 Core GCS credential SecretRef is unavailable or invalid.', { category: 'authentication' }); }
    let credential;
    try { credential = normalizeGcsCredential(credentialInput); }
    catch (error) { throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_CREDENTIAL_INVALID', error.message, { category: 'authentication' }); }
    const credentials = { client_email: credential.clientEmail, private_key: credential.privateKey };
    this.bucketClient = this.clientFactory
      ? await this.clientFactory({ projectId: credential.projectId, credentials, bucket: this.config.bucket, timeoutMs: this.config.timeoutMs })
      : new Storage({ projectId: credential.projectId, credentials, retryOptions: { autoRetry: true, maxRetries: 3, totalTimeout: Math.ceil(this.config.timeoutMs / 1000) } }).bucket(this.config.bucket);
    if (!this.bucketClient || typeof this.bucketClient.getFiles !== 'function' || typeof this.bucketClient.file !== 'function') throw new TypeError('InfluxDB 3 Core GCS bucket client is invalid.');
    return this.bucketClient;
  }

  async request(context, operation) {
    const signal = context.signal || context.abortSignal || null;
    if (signal?.aborted) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_CANCELED', 'The InfluxDB 3 Core GCS operation was canceled.', { category: 'canceled' });
    let timer;
    let onAbort;
    const boundary = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_TIMEOUT', 'The InfluxDB 3 Core GCS operation timed out.', { category: 'timeout', retryable: true })), this.config.timeoutMs);
      onAbort = () => reject(new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_CANCELED', 'The InfluxDB 3 Core GCS operation was canceled.', { category: 'canceled' }));
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(operation), boundary]); }
    finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); }
  }

  async inspect(context = {}) {
    const client = await this.client();
    try { await this.request(context, () => client.getMetadata()); }
    catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_GCS_UNAVAILABLE', 'DeployerX could not access the InfluxDB 3 Core GCS bucket.'); }
    const members = [];
    let totalBytes = 0;
    let token = null;
    const seenTokens = new Set();
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      let response;
      try { response = await this.request(context, () => client.getFiles({ prefix: nodePrefix(this.config), autoPaginate: false, maxResults: 1000, pageToken: token || undefined, versions: false, softDeleted: false })); }
      catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_GCS_LIST_FAILED', 'DeployerX could not list the InfluxDB 3 Core GCS node.'); }
      const [files, nextQuery] = Array.isArray(response) ? response : [];
      if (!Array.isArray(files)) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_LIST_INVALID', 'InfluxDB 3 Core GCS returned an invalid object listing.', { category: 'integrity' });
      for (const file of files) {
        const metadata = file?.metadata || {};
        const name = requiredText(file?.name ?? metadata.name, 'InfluxDB 3 Core GCS object name', 1024);
        if (metadata.name !== undefined && metadata.name !== name) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_INVALID', 'InfluxDB 3 Core GCS returned inconsistent object metadata.', { category: 'integrity' });
        if (metadata.timeDeleted || metadata.softDeleteTime) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_INVALID', 'InfluxDB 3 Core GCS returned a non-current object.', { category: 'integrity' });
        if (name === nodePrefix(this.config)) {
          if (safeSize(metadata.size) !== 0) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_INVALID', 'InfluxDB 3 Core GCS contains an invalid node marker.', { category: 'integrity' });
          continue;
        }
        const relativePath = relativeObjectPath(name, this.config);
        const sizeBytes = safeSize(metadata.size);
        if (relativePath.endsWith('/')) {
          if (sizeBytes !== 0) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_INVALID', 'InfluxDB 3 Core GCS contains an invalid directory marker.', { category: 'integrity' });
          objectPhase(relativePath.slice(0, -1));
          continue;
        }
        const phase = objectPhase(relativePath);
        if (phase === 'table-snapshots') continue;
        const lastModifiedDate = new Date(metadata.updated);
        if (Number.isNaN(lastModifiedDate.getTime())) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_INVALID', 'InfluxDB 3 Core GCS returned invalid modification evidence.', { category: 'integrity' });
        members.push(Object.freeze({ name, relativePath, phase, sizeBytes, generation: objectGeneration(metadata.generation), lastModified: lastModifiedDate.toISOString() }));
        totalBytes += sizeBytes;
        if (members.length > MAX_OBJECTS || totalBytes > MAX_BYTES) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_STORAGE_LIMIT', 'InfluxDB 3 Core GCS exceeds the supported backup limits.', { category: 'capacity' });
      }
      token = nextQuery?.pageToken ? requiredText(nextQuery.pageToken, 'InfluxDB 3 Core GCS page token', 4096) : null;
      if (!token) break;
      if (seenTokens.has(token)) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_LIST_INVALID', 'InfluxDB 3 Core GCS returned a repeated list cursor.', { category: 'integrity' });
      seenTokens.add(token);
      if (page === MAX_LIST_PAGES - 1) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_STORAGE_LIMIT', 'InfluxDB 3 Core GCS listing exceeds the supported page limit.', { category: 'capacity' });
    }
    members.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    if (!members.some((member) => member.relativePath === '_catalog_checkpoint')) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_LAYOUT_INVALID', 'InfluxDB 3 Core GCS is missing the catalog checkpoint.', { category: 'integrity' });
    if (new Set(members.map((member) => member.relativePath)).size !== members.length) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_LAYOUT_INVALID', 'InfluxDB 3 Core GCS returned duplicate node objects.', { category: 'integrity' });
    const directories = directoriesForMembers(members);
    const phaseEvidence = GCS_COPY_PHASES.map((phase) => Object.freeze({ phase: phase.name, digest: phaseDigest(phase.name, members), fileCount: members.filter((member) => member.phase === phase.name).length, totalBytes: members.filter((member) => member.phase === phase.name).reduce((sum, member) => sum + member.sizeBytes, 0) }));
    return Object.freeze({
      objectStore: 'google', nodeId: this.config.nodeId, bindingFingerprint: stableDigest({ objectStore: 'google', bucket: this.config.bucket, prefix: this.config.prefix, nodeId: this.config.nodeId }),
      members, directories, fileCount: members.length, directoryCount: directories.length, totalBytes, phaseEvidence, excluded: ['table-snapshots/'], layoutFingerprint: stableDigest(phaseEvidence.map(({ phase, digest }) => ({ phase, digest })))
    });
  }

  async assertEmpty(context = {}) {
    const client = await this.client();
    try {
      await this.request(context, () => client.getMetadata());
      const response = await this.request(context, () => client.getFiles({ prefix: nodePrefix(this.config), autoPaginate: false, maxResults: 1, versions: false, softDeleted: false }));
      const [files, nextQuery] = Array.isArray(response) ? response : [];
      if (!Array.isArray(files)) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_TARGET_UNAVAILABLE', 'DeployerX could not inspect the alternate InfluxDB 3 Core GCS target.', { category: 'integrity' });
      if (files.length || nextQuery?.pageToken) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_TARGET_EXISTS', 'The alternate InfluxDB 3 Core GCS node prefix must be empty before restore.', { category: 'conflict' });
      return Object.freeze({ empty: true, bindingFingerprint: stableDigest({ objectStore: 'google', bucket: this.config.bucket, prefix: this.config.prefix, nodeId: this.config.nodeId }) });
    } catch (error) {
      if (error instanceof InfluxDb3CoreGcsError) throw error;
      throw safeProviderError(error, 'INFLUXDB3_CORE_GCS_RESTORE_TARGET_UNAVAILABLE', 'DeployerX could not inspect the alternate InfluxDB 3 Core GCS target.');
    }
  }

  async uploadRestoreMember(context = {}, sourceRoot, memberInput) {
    const member = normalizeRestoreMember(memberInput, this.config);
    const source = path.join(path.resolve(requiredText(sourceRoot, 'InfluxDB 3 Core GCS restore source')), ...member.relativePath.split('/'));
    const signal = context.signal || context.abortSignal || null;
    const authenticatedStat = await authenticateStagedMember(source, member, signal);
    const client = await this.client();
    const file = client.file(`${nodePrefix(this.config)}${member.relativePath}`);
    if (!file || typeof file.createWriteStream !== 'function') throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_TARGET_UNAVAILABLE', 'The alternate InfluxDB 3 Core GCS target returned an invalid object handle.', { category: 'availability', retryable: true });
    let writer;
    try {
      writer = file.createWriteStream({ resumable: false, validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 } });
    } catch (error) { throw targetWriteError(error); }
    if (!writer || typeof writer.write !== 'function' || typeof writer.destroy !== 'function') throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_TARGET_UNAVAILABLE', 'The alternate InfluxDB 3 Core GCS target returned an invalid upload stream.', { category: 'availability', retryable: true });
    const reader = fsSync.createReadStream(source, { highWaterMark: 1024 * 1024 });
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const authenticator = new Transform({
      transform(raw, _encoding, callback) {
        const chunk = Buffer.from(raw);
        sizeBytes += chunk.length;
        hash.update(chunk);
        if (sizeBytes > member.sizeBytes) callback(new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_MEDIA_INVALID', 'An authenticated InfluxDB 3 Core GCS restore member changed during upload.', { category: 'integrity' }));
        else callback(null, chunk);
      }
    });
    const abortError = () => new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_CANCELED', 'The InfluxDB 3 Core GCS restore was canceled.', { category: 'canceled' });
    const timeoutError = () => new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_TIMEOUT', 'The InfluxDB 3 Core GCS restore upload timed out.', { category: 'timeout', retryable: true });
    const onAbort = () => { const error = abortError(); reader.destroy(error); writer.destroy(error); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => { const error = timeoutError(); reader.destroy(error); writer.destroy(error); }, this.config.timeoutMs);
    try { await pipeline(reader, authenticator, writer); }
    catch (error) { throw targetWriteError(error); }
    finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); }
    const after = await fs.lstat(source).catch(() => null);
    const contentDigest = `sha256:${hash.digest('hex')}`;
    if (!sameFileIdentity(authenticatedStat, after) || sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_MEDIA_INVALID', 'An authenticated InfluxDB 3 Core GCS restore member changed during upload.', { category: 'integrity' });
    return member;
  }

  async authenticateInstalled(context = {}, source = {}) {
    const layout = await this.inspect(context);
    if (layout.bindingFingerprint !== source.targetStorageFingerprint) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core GCS binding changed during validation.', { category: 'integrity' });
    const expectedMembers = (source.nativeMedia?.members || []).map((member) => normalizeRestoreMember(member, this.config));
    const expected = new Map(expectedMembers.map((member) => [member.relativePath, member]));
    if (expected.size !== expectedMembers.length || layout.members.length !== expectedMembers.length || layout.fileCount !== source.nativeMedia?.fileCount) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_VALIDATION_FAILED', 'The restored InfluxDB 3 Core GCS inventory does not match the authenticated media.', { category: 'integrity' });
    const client = await this.client();
    const authenticated = [];
    for (const listed of layout.members) {
      const member = expected.get(listed.relativePath);
      if (!member || member.sizeBytes !== listed.sizeBytes) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_VALIDATION_FAILED', 'The restored InfluxDB 3 Core GCS inventory does not match the authenticated media.', { category: 'integrity' });
      const file = client.file(listed.name);
      if (!file || typeof file.createReadStream !== 'function') throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_VALIDATION_FAILED', 'The restored InfluxDB 3 Core GCS object handle is invalid.', { category: 'integrity' });
      file.generation = listed.generation;
      const stream = file.createReadStream({ validation: 'crc32c', decompress: false });
      let responseGeneration = null;
      let responseLength = null;
      stream.once?.('response', (response) => {
        responseGeneration = response?.headers?.['x-goog-generation'] === undefined ? null : String(response.headers['x-goog-generation']);
        responseLength = response?.headers?.['content-length'] === undefined ? null : String(response.headers['content-length']);
      });
      const hash = crypto.createHash('sha256');
      let sizeBytes = 0;
      const signal = context.signal || context.abortSignal || null;
      const onAbort = () => stream.destroy(new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_CANCELED', 'The InfluxDB 3 Core GCS restore validation was canceled.', { category: 'canceled' }));
      if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
      const timer = setTimeout(() => stream.destroy(new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_TIMEOUT', 'The InfluxDB 3 Core GCS restore validation timed out.', { category: 'timeout', retryable: true })), this.config.timeoutMs);
      try {
        for await (const raw of stream) {
          const chunk = Buffer.from(raw);
          sizeBytes += chunk.length;
          hash.update(chunk);
          if (sizeBytes > member.sizeBytes) break;
        }
      } catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_GCS_RESTORE_VALIDATION_FAILED', 'DeployerX could not validate an installed InfluxDB 3 Core GCS object.'); }
      finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); }
      const contentDigest = `sha256:${hash.digest('hex')}`;
      if (responseGeneration === null || objectGeneration(responseGeneration) !== listed.generation || safeSize(responseLength) !== member.sizeBytes || sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_VALIDATION_FAILED', 'An installed InfluxDB 3 Core GCS object failed exact-generation SHA-256 authentication.', { category: 'integrity' });
      authenticated.push({ relativePath: member.relativePath, sizeBytes, contentDigest });
    }
    authenticated.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    if (authenticated.length !== source.nativeMedia?.fileCount || stableDigest(authenticated) !== source.nativeMedia?.mediaFingerprint || layout.directoryCount !== source.nativeMedia?.directoryCount || stableDigest(layout.directories) !== source.nativeMedia?.directoryFingerprint || layout.totalBytes !== source.nativeMedia?.totalBytes) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_VALIDATION_FAILED', 'The complete restored InfluxDB 3 Core GCS node failed authentication.', { category: 'integrity' });
    const after = await this.inspect(context);
    if (after.bindingFingerprint !== layout.bindingFingerprint || after.layoutFingerprint !== layout.layoutFingerprint || after.fileCount !== layout.fileCount || after.directoryCount !== layout.directoryCount || after.totalBytes !== layout.totalBytes) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core GCS node changed during validation.', { category: 'integrity' });
    return Object.freeze({ files: authenticated, directories: layout.directories, totalBytes: layout.totalBytes, bindingFingerprint: layout.bindingFingerprint });
  }

  async copyMember(context, member, destinationRoot) {
    const client = await this.client();
    const destination = path.join(destinationRoot, ...member.relativePath.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const file = client.file(member.name);
    if (!file || typeof file.createReadStream !== 'function') throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_OBJECT_INVALID', 'InfluxDB 3 Core GCS returned an invalid object handle.', { category: 'integrity' });
    // The SDK converts constructor generations to Number; retain the exact decimal identity.
    file.generation = member.generation;
    const stream = file.createReadStream({ validation: 'crc32c', decompress: false });
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    let responseGeneration = null;
    let responseLength = null;
    stream.once?.('response', (response) => {
      responseGeneration = response?.headers?.['x-goog-generation'] ? String(response.headers['x-goog-generation']) : null;
      responseLength = response?.headers?.['content-length'] === undefined ? null : String(response.headers['content-length']);
    });
    const output = fsSync.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    const signal = context.signal || context.abortSignal || null;
    const onAbort = () => stream.destroy(new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_CANCELED', 'The InfluxDB 3 Core GCS capture was canceled.', { category: 'canceled' }));
    if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => stream.destroy(new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_TIMEOUT', 'The InfluxDB 3 Core GCS object download timed out.', { category: 'timeout', retryable: true })), this.config.timeoutMs);
    try {
      for await (const raw of stream) {
        const chunk = Buffer.from(raw); sizeBytes += chunk.length; hash.update(chunk);
        if (sizeBytes > member.sizeBytes) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_SOURCE_CHANGED', 'An InfluxDB 3 Core GCS object size changed while it was copied.', { category: 'consistency', retryable: true });
        if (!output.write(chunk)) await once(output, 'drain');
      }
      await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
    } catch (error) {
      output.destroy(); await fs.rm(destination, { force: true }).catch(() => {}); throw safeProviderError(error, 'INFLUXDB3_CORE_GCS_READ_FAILED', 'DeployerX could not read an InfluxDB 3 Core GCS object.');
    } finally {
      clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort);
    }
    if (responseGeneration !== member.generation || safeSize(responseLength) !== member.sizeBytes || sizeBytes !== member.sizeBytes) {
      await fs.rm(destination, { force: true }).catch(() => {});
      throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_SOURCE_CHANGED', 'An InfluxDB 3 Core GCS object identity changed while it was copied.', { category: 'consistency', retryable: true });
    }
    return Object.freeze({ relativePath: member.relativePath, sizeBytes, contentDigest: `sha256:${hash.digest('hex')}` });
  }

  async capture(context = {}, destinationInput, consistencyMode = 'ordered-live-copy') {
    if (!['stopped', 'atomic-snapshot', 'ordered-live-copy'].includes(consistencyMode)) throw new TypeError('InfluxDB 3 Core GCS consistency mode is invalid.');
    const destination = path.resolve(requiredText(destinationInput, 'InfluxDB 3 Core GCS staging destination'));
    if (await fs.lstat(destination).catch(() => null)) throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_DESTINATION_EXISTS', 'InfluxDB 3 Core GCS staging destination already exists.', { category: 'conflict' });
    const before = await this.inspect(context);
    const files = [];
    const drift = new Set();
    try {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      for (const phase of GCS_COPY_PHASES) {
        await context.onProgress?.({ phase: 'capturing', component: phase.name, copyOrder: GCS_COPY_PHASES.map((item) => item.name) });
        for (const member of before.members.filter((candidate) => candidate.phase === phase.name)) files.push(await this.copyMember(context, member, destination));
        const current = await this.inspect(context);
        if (current.phaseEvidence.find((item) => item.phase === phase.name)?.digest !== before.phaseEvidence.find((item) => item.phase === phase.name)?.digest) drift.add(phase.name);
        if (drift.size && consistencyMode !== 'ordered-live-copy') throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_SOURCE_CHANGED', 'InfluxDB 3 Core GCS changed during an application-consistent capture.', { category: 'consistency', retryable: true, details: { driftPhases: [...drift] } });
      }
      const after = await this.inspect(context);
      for (const phase of GCS_COPY_PHASES) if (after.phaseEvidence.find((item) => item.phase === phase.name)?.digest !== before.phaseEvidence.find((item) => item.phase === phase.name)?.digest) drift.add(phase.name);
      if (drift.size && consistencyMode !== 'ordered-live-copy') throw new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_SOURCE_CHANGED', 'InfluxDB 3 Core GCS changed during an application-consistent capture.', { category: 'consistency', retryable: true, details: { driftPhases: [...drift] } });
      const canonicalFiles = files.map(({ relativePath, sizeBytes, contentDigest }) => ({ relativePath, sizeBytes, contentDigest })).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
      return Object.freeze({ directory: destination, objectStore: 'google', nodeId: this.config.nodeId, bindingFingerprint: before.bindingFingerprint, copyOrder: GCS_COPY_PHASES.map((phase) => phase.name), excluded: before.excluded, phaseEvidence: before.phaseEvidence, driftPhases: [...drift].sort((left, right) => GCS_COPY_PHASES.findIndex((phase) => phase.name === left) - GCS_COPY_PHASES.findIndex((phase) => phase.name === right)), achievedConsistency: consistencyMode === 'ordered-live-copy' ? 'crash' : 'application', files, directories: before.directories, fileCount: files.length, directoryCount: before.directoryCount, totalBytes: files.reduce((sum, fileEntry) => sum + fileEntry.sizeBytes, 0), mediaFingerprint: stableDigest(canonicalFiles), directoryFingerprint: stableDigest(before.directories) });
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error instanceof InfluxDb3CoreGcsError ? error : new InfluxDb3CoreGcsError('INFLUXDB3_CORE_GCS_CAPTURE_FAILED', 'DeployerX could not capture the InfluxDB 3 Core GCS node.', { category: error?.category || 'execution', retryable: Boolean(error?.retryable) });
    }
  }
}

module.exports = {
  GCS_COPY_PHASES,
  InfluxDb3CoreGcsError,
  InfluxDb3CoreGcsStore,
  MAX_BYTES,
  MAX_DIRECTORIES,
  MAX_OBJECTS,
  nodePrefix,
  normalizeCoreGcsConfig,
  normalizeGcsCredential
};
