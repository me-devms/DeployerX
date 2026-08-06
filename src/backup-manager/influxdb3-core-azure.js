const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { once } = require('events');
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

const AZURE_COPY_PHASES = Object.freeze([
  Object.freeze({ name: 'snapshots', kind: 'prefix' }),
  Object.freeze({ name: 'dbs', kind: 'prefix' }),
  Object.freeze({ name: 'wal', kind: 'prefix' }),
  Object.freeze({ name: 'catalog', kind: 'prefix' }),
  Object.freeze({ name: '_catalog_checkpoint', kind: 'object' })
]);
const MAX_BLOBS = 100000;
const MAX_DIRECTORIES = 50000;
const MAX_BYTES = 64 * 1024 * 1024 * 1024 * 1024;
const MAX_LIST_PAGES = 1000;

class InfluxDb3CoreAzureError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3CoreAzureError';
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

function normalizeAccountName(value) {
  const accountName = requiredText(value, 'InfluxDB 3 Core Azure storage account', 24).toLowerCase();
  if (!/^[a-z0-9]{3,24}$/.test(accountName)) throw new TypeError('InfluxDB 3 Core Azure storage account is invalid.');
  return accountName;
}

function normalizeContainer(value) {
  const container = requiredText(value, 'InfluxDB 3 Core Azure container', 63).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(container)) throw new TypeError('InfluxDB 3 Core Azure container is invalid.');
  return container;
}

function normalizePrefix(value) {
  const prefix = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!prefix) return '';
  if (prefix.length > 512 || prefix.includes('\\') || prefix.includes('//') || prefix.split('/').some((segment) => !segment || segment === '.' || segment === '..') || path.posix.normalize(prefix) !== prefix) throw new TypeError('InfluxDB 3 Core Azure prefix is invalid.');
  return prefix;
}

function normalizeEndpoint(value, accountName, allowInsecureEndpoint) {
  const fallback = `https://${accountName}.blob.core.windows.net`;
  const text = value === undefined || value === null || String(value).trim() === '' ? fallback : requiredText(value, 'InfluxDB 3 Core Azure endpoint', 2048);
  let endpoint;
  try { endpoint = new URL(text); } catch { throw new TypeError('InfluxDB 3 Core Azure endpoint is invalid.'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError('InfluxDB 3 Core Azure endpoint is invalid.');
  if (endpoint.protocol === 'http:' && allowInsecureEndpoint !== true) throw new TypeError('InfluxDB 3 Core Azure HTTP endpoints require explicit insecure-endpoint approval.');
  endpoint.pathname = endpoint.pathname.replace(/\/+$/g, '');
  return endpoint.toString().replace(/\/$/, '');
}

function normalizeCoreAzureConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Core Azure configuration must be an object.');
  const allowed = ['objectStore', 'accountName', 'container', 'endpoint', 'prefix', 'allowInsecureEndpoint', 'timeoutMs', 'credentialSecretRefId', 'nodeId'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Core Azure field: ${unknown[0]}.`);
  if (input.objectStore !== undefined && String(input.objectStore).toLowerCase() !== 'azure') throw new TypeError('InfluxDB 3 Core memory and non-Azure object stores are not valid Azure bindings.');
  const accountName = normalizeAccountName(input.accountName);
  const allowInsecureEndpoint = input.allowInsecureEndpoint === true;
  const timeoutMs = input.timeoutMs === undefined ? 30000 : Number(input.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('InfluxDB 3 Core Azure timeout is invalid.');
  return Object.freeze({
    objectStore: 'azure',
    accountName,
    container: normalizeContainer(input.container),
    endpoint: normalizeEndpoint(input.endpoint, accountName, allowInsecureEndpoint),
    prefix: normalizePrefix(input.prefix),
    allowInsecureEndpoint: allowInsecureEndpoint && String(input.endpoint || '').trim().toLowerCase().startsWith('http://'),
    timeoutMs,
    credentialSecretRefId: requiredText(input.credentialSecretRefId, 'InfluxDB 3 Core Azure credential SecretRef ID', 200),
    nodeId: normalizeNodeId(input.nodeId)
  });
}

function normalizeAzureCredential(input, accountName) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Core Azure credential is invalid.');
  const allowed = ['accountName', 'accessKey'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Core Azure credential field: ${unknown[0]}.`);
  if (normalizeAccountName(input.accountName) !== accountName) throw new TypeError('InfluxDB 3 Core Azure credential account does not match the bound account.');
  const accessKey = requiredText(input.accessKey, 'InfluxDB 3 Core Azure storage access key', 4096);
  const decoded = Buffer.from(accessKey, 'base64');
  if (decoded.length < 32 || decoded.length > 256 || decoded.toString('base64') !== accessKey) throw new TypeError('InfluxDB 3 Core Azure storage access key is invalid.');
  return Object.freeze({ accountName, accessKey });
}

function nodePrefix(config) {
  return `${config.prefix ? `${config.prefix}/` : ''}${config.nodeId}/`;
}

function blobEtag(value) {
  const etag = requiredText(value, 'InfluxDB 3 Core Azure blob ETag', 256);
  if (!/^"[\x21\x23-\x7e]+"$/.test(etag)) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_BLOB_INVALID', 'InfluxDB 3 Core Azure Blob returned an invalid blob identity.', { category: 'integrity' });
  return etag;
}

function relativeBlobPath(name, config) {
  const exactPrefix = nodePrefix(config);
  const text = requiredText(name, 'InfluxDB 3 Core Azure blob name', 1024);
  if (!text.startsWith(exactPrefix)) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_NAME_INVALID', 'InfluxDB 3 Core Azure Blob returned a blob outside the exact node prefix.', { category: 'integrity' });
  const relative = text.slice(exactPrefix.length);
  const marker = relative.endsWith('/');
  const comparable = marker ? relative.slice(0, -1) : relative;
  if (!comparable || comparable.startsWith('/') || comparable.includes('\\') || comparable.includes('//') || comparable.split('/').some((segment) => !segment || segment === '.' || segment === '..') || path.posix.normalize(comparable) !== comparable) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_NAME_INVALID', 'InfluxDB 3 Core Azure Blob returned an unsafe blob name.', { category: 'integrity' });
  return relative;
}

function blobPhase(relativePath) {
  if (relativePath === '_catalog_checkpoint') return '_catalog_checkpoint';
  const top = relativePath.split('/')[0];
  if (top === 'table-snapshots') return 'table-snapshots';
  if (AZURE_COPY_PHASES.some((phase) => phase.kind === 'prefix' && phase.name === top)) return top;
  throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_LAYOUT_UNSUPPORTED', 'InfluxDB 3 Core Azure Blob contains an unrecognized top-level component.', { category: 'compatibility' });
}

function safeSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_BLOB_INVALID', 'InfluxDB 3 Core Azure Blob returned an invalid blob size.', { category: 'integrity' });
  return size;
}

function bodyParts(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return (async function* one() { yield Buffer.from(body); })();
  if (body && typeof body[Symbol.asyncIterator] === 'function') return body;
  throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_BLOB_INVALID', 'InfluxDB 3 Core Azure Blob returned an invalid blob stream.', { category: 'integrity' });
}

function providerStatus(error) {
  return Number(error?.statusCode || error?.response?.status || error?.details?.statusCode || 0);
}

function providerCode(error) {
  return String(error?.code || error?.details?.errorCode || error?.response?.parsedBody?.Code || '');
}

function safeProviderError(error, fallbackCode, fallbackMessage) {
  if (error instanceof InfluxDb3CoreAzureError) return error;
  const code = providerCode(error);
  if (error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'OperationTimedOut') return new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_TIMEOUT', 'The InfluxDB 3 Core Azure Blob operation timed out or was canceled.', { category: 'timeout', retryable: true });
  if ([401, 403].includes(providerStatus(error)) || ['AuthenticationFailed', 'AuthorizationFailure', 'AuthorizationPermissionMismatch'].includes(code)) return new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_ACCESS_DENIED', 'InfluxDB 3 Core Azure credentials cannot access the configured container and node prefix.', { category: providerStatus(error) === 401 ? 'authentication' : 'authorization' });
  if (providerStatus(error) === 404 || ['ContainerNotFound', 'BlobNotFound', 'ResourceNotFound'].includes(code)) return new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_BLOB_MISSING', 'A required InfluxDB 3 Core Azure blob is unavailable.', { category: 'integrity' });
  if (providerStatus(error) === 412 || code === 'ConditionNotMet') return new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_SOURCE_CHANGED', 'An InfluxDB 3 Core Azure blob changed before it could be copied.', { category: 'consistency', retryable: true });
  return new InfluxDb3CoreAzureError(fallbackCode, fallbackMessage, { category: 'availability', retryable: true });
}

function targetWriteError(error) {
  const code = providerCode(error);
  if ([409, 412].includes(providerStatus(error)) || ['BlobAlreadyExists', 'ConditionNotMet'].includes(code)) return new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core Azure node prefix changed during restore.', { category: 'conflict' });
  return safeProviderError(error, 'INFLUXDB3_CORE_AZURE_RESTORE_WRITE_FAILED', 'DeployerX could not write an InfluxDB 3 Core Azure restore blob.');
}

function bindingFingerprint(config) {
  return stableDigest({ objectStore: 'azure', endpoint: config.endpoint, accountName: config.accountName, container: config.container, prefix: config.prefix, nodeId: config.nodeId });
}

function restoreMediaError() {
  return new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_MEDIA_INVALID', 'An authenticated InfluxDB 3 Core restore member is unavailable or invalid.', { category: 'integrity' });
}

function normalizeRestoreMember(member, config) {
  try {
    if (!member || typeof member !== 'object' || Array.isArray(member)) throw new TypeError('member');
    const relativePath = relativeBlobPath(`${nodePrefix(config)}${requiredText(member.relativePath, 'InfluxDB 3 Core restore member path', 1024)}`, config);
    if (relativePath.endsWith('/') || blobPhase(relativePath) === 'table-snapshots') throw new TypeError('member');
    const sizeBytes = safeSize(member.sizeBytes);
    const contentDigest = requiredText(member.contentDigest, 'InfluxDB 3 Core restore member digest', 71);
    if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest)) throw new TypeError('member');
    return Object.freeze({ relativePath, sizeBytes, contentDigest });
  } catch {
    throw restoreMediaError();
  }
}

async function authenticateRestoreFile(context, sourceRoot, member, config) {
  const normalized = normalizeRestoreMember(member, config);
  let root;
  try { root = path.resolve(requiredText(sourceRoot, 'InfluxDB 3 Core Azure restore source')); }
  catch { throw restoreMediaError(); }
  const source = path.resolve(root, ...normalized.relativePath.split('/'));
  const containment = path.relative(root, source);
  if (!containment || containment.startsWith('..') || path.isAbsolute(containment)) throw restoreMediaError();
  const before = await fs.lstat(source).catch(() => null);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.size !== normalized.sizeBytes) throw restoreMediaError();
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  try {
    for await (const raw of fsSync.createReadStream(source, { highWaterMark: 1024 * 1024, signal: context.signal })) {
      const chunk = Buffer.from(raw);
      sizeBytes += chunk.length;
      if (sizeBytes > normalized.sizeBytes) throw restoreMediaError();
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof InfluxDb3CoreAzureError) throw error;
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_CANCELED', 'The InfluxDB 3 Core Azure restore was canceled.', { category: 'canceled' });
    throw restoreMediaError();
  }
  const after = await fs.lstat(source).catch(() => null);
  const unchanged = after && after.isFile() && !after.isSymbolicLink() && after.size === before.size && after.mtimeMs === before.mtimeMs && after.dev === before.dev && after.ino === before.ino;
  if (!unchanged || sizeBytes !== normalized.sizeBytes || `sha256:${hash.digest('hex')}` !== normalized.contentDigest) throw restoreMediaError();
  return Object.freeze({ source, ...normalized });
}

function phaseDigest(phase, members) {
  return stableDigest(members.filter((member) => member.phase === phase).map(({ relativePath, sizeBytes, etag, lastModified }) => ({ relativePath, sizeBytes, etag, lastModified })));
}

function directoriesForMembers(members) {
  const directories = new Set(AZURE_COPY_PHASES.filter((phase) => phase.kind === 'prefix').map((phase) => phase.name));
  for (const member of members) {
    let current = path.posix.dirname(member.relativePath);
    while (current && current !== '.') { directories.add(current); current = path.posix.dirname(current); }
  }
  const result = [...directories].sort((left, right) => left.localeCompare(right, 'en-US'));
  if (result.length > MAX_DIRECTORIES) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_STORAGE_LIMIT', 'InfluxDB 3 Core Azure Blob contains too many logical directories.', { category: 'capacity' });
  return result;
}

class InfluxDb3CoreAzureStore {
  constructor({ config, resolveSecret, containerClient, clientFactory } = {}) {
    this.config = normalizeCoreAzureConfig(config);
    this.resolveSecret = resolveSecret;
    this.containerClient = containerClient || null;
    this.clientFactory = clientFactory || null;
    this.clientPromise = null;
    if (!containerClient && typeof resolveSecret !== 'function') throw new TypeError('InfluxDB 3 Core Azure SecretRef resolver is required.');
  }

  async client() {
    if (this.containerClient) return this.containerClient;
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = this.createClient();
    try { return await this.clientPromise; }
    catch (error) { this.clientPromise = null; throw error; }
  }

  async createClient() {
    let credentialInput;
    try { credentialInput = JSON.parse(await this.resolveSecret(this.config.credentialSecretRefId)); }
    catch { throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_CREDENTIAL_INVALID', 'The InfluxDB 3 Core Azure credential SecretRef is unavailable or invalid.', { category: 'authentication' }); }
    let credential;
    try {
      const normalized = normalizeAzureCredential(credentialInput, this.config.accountName);
      credential = new StorageSharedKeyCredential(normalized.accountName, normalized.accessKey);
    } catch (error) {
      throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_CREDENTIAL_INVALID', error.message, { category: 'authentication' });
    }
    this.containerClient = this.clientFactory
      ? await this.clientFactory({ endpoint: this.config.endpoint, accountName: this.config.accountName, container: this.config.container, credential, timeoutMs: this.config.timeoutMs })
      : new BlobServiceClient(this.config.endpoint, credential, { retryOptions: { maxTries: 4, tryTimeoutInMs: this.config.timeoutMs } }).getContainerClient(this.config.container);
    if (!this.containerClient || typeof this.containerClient.listBlobsFlat !== 'function') throw new TypeError('InfluxDB 3 Core Azure container client is invalid.');
    return this.containerClient;
  }

  async request(context, operation) {
    const upstream = context.signal || context.abortSignal || null;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (upstream?.aborted) controller.abort();
    else upstream?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try { return await operation(controller.signal); }
    finally { clearTimeout(timer); upstream?.removeEventListener?.('abort', onAbort); }
  }

  async inspect(context = {}) {
    const client = await this.client();
    try { await this.request(context, (abortSignal) => client.getProperties({ abortSignal })); }
    catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_AZURE_UNAVAILABLE', 'DeployerX could not access the InfluxDB 3 Core Azure container.'); }
    const members = [];
    let totalBytes = 0;
    let token = null;
    const seenTokens = new Set();
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      let response;
      try {
        response = await this.request(context, async (abortSignal) => {
          const pages = client.listBlobsFlat({ prefix: nodePrefix(this.config), abortSignal }).byPage({ continuationToken: token || undefined, maxPageSize: 1000 });
          return (await pages.next()).value;
        });
      } catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_AZURE_LIST_FAILED', 'DeployerX could not list the InfluxDB 3 Core Azure node.'); }
      for (const blob of response?.segment?.blobItems || []) {
        if (blob.deleted === true || blob.snapshot || blob.isCurrentVersion === false) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_BLOB_INVALID', 'InfluxDB 3 Core Azure Blob returned a non-current blob.', { category: 'integrity' });
        if (blob.name === nodePrefix(this.config)) {
          if (safeSize(blob.properties?.contentLength) !== 0) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_BLOB_INVALID', 'InfluxDB 3 Core Azure Blob contains an invalid node marker.', { category: 'integrity' });
          continue;
        }
        const relativePath = relativeBlobPath(blob.name, this.config);
        const sizeBytes = safeSize(blob.properties?.contentLength);
        if (blob.properties?.blobType && blob.properties.blobType !== 'BlockBlob') throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_BLOB_INVALID', 'InfluxDB 3 Core Azure Blob contains a non-block blob.', { category: 'compatibility' });
        if (relativePath.endsWith('/')) {
          if (sizeBytes !== 0) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_BLOB_INVALID', 'InfluxDB 3 Core Azure Blob contains an invalid directory marker.', { category: 'integrity' });
          blobPhase(relativePath.slice(0, -1));
          continue;
        }
        const phase = blobPhase(relativePath);
        if (phase === 'table-snapshots') continue;
        const lastModifiedDate = new Date(blob.properties?.lastModified);
        if (Number.isNaN(lastModifiedDate.getTime())) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_BLOB_INVALID', 'InfluxDB 3 Core Azure Blob returned invalid modification evidence.', { category: 'integrity' });
        members.push(Object.freeze({ name: blob.name, relativePath, phase, sizeBytes, etag: blobEtag(blob.properties?.etag), lastModified: lastModifiedDate.toISOString() }));
        totalBytes += sizeBytes;
        if (members.length > MAX_BLOBS || totalBytes > MAX_BYTES) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_STORAGE_LIMIT', 'InfluxDB 3 Core Azure Blob exceeds the supported backup limits.', { category: 'capacity' });
      }
      token = response?.continuationToken ? requiredText(response.continuationToken, 'InfluxDB 3 Core Azure continuation token', 4096) : null;
      if (!token) break;
      if (seenTokens.has(token)) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_LIST_INVALID', 'InfluxDB 3 Core Azure Blob returned a repeated list cursor.', { category: 'integrity' });
      seenTokens.add(token);
      if (page === MAX_LIST_PAGES - 1) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_STORAGE_LIMIT', 'InfluxDB 3 Core Azure Blob listing exceeds the supported page limit.', { category: 'capacity' });
    }
    members.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    if (!members.some((member) => member.relativePath === '_catalog_checkpoint')) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_LAYOUT_INVALID', 'InfluxDB 3 Core Azure Blob is missing the catalog checkpoint.', { category: 'integrity' });
    if (new Set(members.map((member) => member.relativePath)).size !== members.length) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_LAYOUT_INVALID', 'InfluxDB 3 Core Azure Blob returned duplicate node blobs.', { category: 'integrity' });
    const directories = directoriesForMembers(members);
    const phaseEvidence = AZURE_COPY_PHASES.map((phase) => Object.freeze({ phase: phase.name, digest: phaseDigest(phase.name, members), fileCount: members.filter((member) => member.phase === phase.name).length, totalBytes: members.filter((member) => member.phase === phase.name).reduce((sum, member) => sum + member.sizeBytes, 0) }));
    return Object.freeze({
      objectStore: 'azure', nodeId: this.config.nodeId, bindingFingerprint: bindingFingerprint(this.config),
      members, directories, fileCount: members.length, directoryCount: directories.length, totalBytes, phaseEvidence, excluded: ['table-snapshots/'], layoutFingerprint: stableDigest(phaseEvidence.map(({ phase, digest }) => ({ phase, digest })))
    });
  }

  async assertEmpty(context = {}) {
    const client = await this.client();
    try {
      await this.request(context, (abortSignal) => client.getProperties({ abortSignal }));
      const response = await this.request(context, async (abortSignal) => {
        const pages = client.listBlobsFlat({ prefix: nodePrefix(this.config), abortSignal }).byPage({ maxPageSize: 1 });
        return (await pages.next()).value;
      });
      if ((response?.segment?.blobItems || []).length || response?.continuationToken) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_TARGET_EXISTS', 'The alternate InfluxDB 3 Core Azure node prefix must be empty before restore.', { category: 'conflict' });
      return Object.freeze({ empty: true, bindingFingerprint: bindingFingerprint(this.config) });
    } catch (error) {
      if (error instanceof InfluxDb3CoreAzureError) throw error;
      throw safeProviderError(error, 'INFLUXDB3_CORE_AZURE_RESTORE_TARGET_UNAVAILABLE', 'DeployerX could not inspect the alternate InfluxDB 3 Core Azure target.');
    }
  }

  async uploadRestoreMember(context = {}, sourceRoot, member) {
    const authenticated = await authenticateRestoreFile(context, sourceRoot, member, this.config);
    const client = await this.client();
    try {
      await this.request(context, (abortSignal) => client.getBlockBlobClient(`${nodePrefix(this.config)}${authenticated.relativePath}`).uploadFile(authenticated.source, {
        abortSignal,
        conditions: { ifNoneMatch: '*' },
        contentChecksumAlgorithm: 'StorageCrc64'
      }));
    } catch (error) { throw targetWriteError(error); }
    return Object.freeze({ relativePath: authenticated.relativePath, sizeBytes: authenticated.sizeBytes, contentDigest: authenticated.contentDigest });
  }

  async authenticateInstalled(context = {}, source = {}) {
    const layout = await this.inspect(context);
    if (layout.bindingFingerprint !== source.targetStorageFingerprint) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core Azure binding changed during validation.', { category: 'integrity' });
    const sourceMedia = source.nativeMedia;
    const expectedMembers = Array.isArray(sourceMedia?.members) ? sourceMedia.members : [];
    const expected = new Map(expectedMembers.map((member) => [member.relativePath, member]));
    if (expected.size !== expectedMembers.length) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_VALIDATION_FAILED', 'The authenticated InfluxDB 3 Core restore media contains duplicate members.', { category: 'integrity' });
    const client = await this.client();
    const authenticated = [];
    for (const listed of layout.members) {
      const member = expected.get(listed.relativePath);
      if (!member || member.sizeBytes !== listed.sizeBytes) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_VALIDATION_FAILED', 'The restored InfluxDB 3 Core Azure inventory does not match the authenticated media.', { category: 'integrity' });
      let response;
      try { response = await this.request(context, (abortSignal) => client.getBlobClient(listed.name).download(0, undefined, { conditions: { ifMatch: listed.etag }, abortSignal, maxRetryRequests: 3 })); }
      catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_AZURE_RESTORE_VALIDATION_FAILED', 'DeployerX could not validate an installed InfluxDB 3 Core Azure blob.'); }
      if (blobEtag(response.etag) !== listed.etag || safeSize(response.contentLength) !== member.sizeBytes) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_VALIDATION_FAILED', 'An installed InfluxDB 3 Core Azure blob changed during validation.', { category: 'integrity' });
      const hash = crypto.createHash('sha256');
      let sizeBytes = 0;
      for await (const raw of bodyParts(response.readableStreamBody)) {
        const chunk = Buffer.from(raw);
        hash.update(chunk);
        sizeBytes += chunk.length;
        if (sizeBytes > member.sizeBytes) break;
      }
      const contentDigest = `sha256:${hash.digest('hex')}`;
      if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_VALIDATION_FAILED', 'An installed InfluxDB 3 Core Azure blob failed SHA-256 authentication.', { category: 'integrity' });
      authenticated.push({ relativePath: member.relativePath, sizeBytes, contentDigest });
    }
    authenticated.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    if (authenticated.length !== sourceMedia?.fileCount || stableDigest(authenticated) !== sourceMedia?.mediaFingerprint || layout.directoryCount !== sourceMedia?.directoryCount || stableDigest(layout.directories) !== sourceMedia?.directoryFingerprint || layout.totalBytes !== sourceMedia?.totalBytes) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_VALIDATION_FAILED', 'The complete restored InfluxDB 3 Core Azure node failed authentication.', { category: 'integrity' });
    const after = await this.inspect(context);
    if (after.bindingFingerprint !== layout.bindingFingerprint || after.layoutFingerprint !== layout.layoutFingerprint || after.fileCount !== layout.fileCount || after.directoryCount !== layout.directoryCount || after.totalBytes !== layout.totalBytes) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core Azure node changed during validation.', { category: 'integrity' });
    return Object.freeze({ files: authenticated, directories: layout.directories, totalBytes: layout.totalBytes, bindingFingerprint: layout.bindingFingerprint });
  }

  async copyMember(context, member, destinationRoot) {
    const client = await this.client();
    const destination = path.join(destinationRoot, ...member.relativePath.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    let response;
    try { response = await this.request(context, (abortSignal) => client.getBlobClient(member.name).download(0, undefined, { conditions: { ifMatch: member.etag }, abortSignal, maxRetryRequests: 3 })); }
    catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_AZURE_READ_FAILED', 'DeployerX could not read an InfluxDB 3 Core Azure blob.'); }
    if (blobEtag(response.etag) !== member.etag || safeSize(response.contentLength) !== member.sizeBytes) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_SOURCE_CHANGED', 'An InfluxDB 3 Core Azure blob identity changed while it was copied.', { category: 'consistency', retryable: true });
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const output = fsSync.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    try {
      for await (const raw of bodyParts(response.readableStreamBody)) {
        if (context.signal?.aborted) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_CANCELED', 'The InfluxDB 3 Core Azure capture was canceled.', { category: 'canceled' });
        const chunk = Buffer.from(raw); sizeBytes += chunk.length; hash.update(chunk);
        if (sizeBytes > member.sizeBytes) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_SOURCE_CHANGED', 'An InfluxDB 3 Core Azure blob size changed while it was copied.', { category: 'consistency', retryable: true });
        if (!output.write(chunk)) await once(output, 'drain');
      }
      await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
    } catch (error) {
      output.destroy(); await fs.rm(destination, { force: true }).catch(() => {}); throw error;
    }
    if (sizeBytes !== member.sizeBytes) { await fs.rm(destination, { force: true }).catch(() => {}); throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_SOURCE_CHANGED', 'An InfluxDB 3 Core Azure blob was truncated while it was copied.', { category: 'consistency', retryable: true }); }
    return Object.freeze({ relativePath: member.relativePath, sizeBytes, contentDigest: `sha256:${hash.digest('hex')}` });
  }

  async capture(context = {}, destinationInput, consistencyMode = 'ordered-live-copy') {
    if (!['stopped', 'atomic-snapshot', 'ordered-live-copy'].includes(consistencyMode)) throw new TypeError('InfluxDB 3 Core Azure consistency mode is invalid.');
    const destination = path.resolve(requiredText(destinationInput, 'InfluxDB 3 Core Azure staging destination'));
    if (await fs.lstat(destination).catch(() => null)) throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_DESTINATION_EXISTS', 'InfluxDB 3 Core Azure staging destination already exists.', { category: 'conflict' });
    const before = await this.inspect(context);
    const files = [];
    const drift = new Set();
    try {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      for (const phase of AZURE_COPY_PHASES) {
        await context.onProgress?.({ phase: 'capturing', component: phase.name, copyOrder: AZURE_COPY_PHASES.map((item) => item.name) });
        for (const member of before.members.filter((candidate) => candidate.phase === phase.name)) files.push(await this.copyMember(context, member, destination));
        const current = await this.inspect(context);
        if (current.phaseEvidence.find((item) => item.phase === phase.name)?.digest !== before.phaseEvidence.find((item) => item.phase === phase.name)?.digest) drift.add(phase.name);
        if (drift.size && consistencyMode !== 'ordered-live-copy') throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_SOURCE_CHANGED', 'InfluxDB 3 Core Azure Blob changed during an application-consistent capture.', { category: 'consistency', retryable: true, details: { driftPhases: [...drift] } });
      }
      const after = await this.inspect(context);
      for (const phase of AZURE_COPY_PHASES) if (after.phaseEvidence.find((item) => item.phase === phase.name)?.digest !== before.phaseEvidence.find((item) => item.phase === phase.name)?.digest) drift.add(phase.name);
      if (drift.size && consistencyMode !== 'ordered-live-copy') throw new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_SOURCE_CHANGED', 'InfluxDB 3 Core Azure Blob changed during an application-consistent capture.', { category: 'consistency', retryable: true, details: { driftPhases: [...drift] } });
      const canonicalFiles = files.map(({ relativePath, sizeBytes, contentDigest }) => ({ relativePath, sizeBytes, contentDigest })).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
      return Object.freeze({ directory: destination, objectStore: 'azure', nodeId: this.config.nodeId, bindingFingerprint: before.bindingFingerprint, copyOrder: AZURE_COPY_PHASES.map((phase) => phase.name), excluded: before.excluded, phaseEvidence: before.phaseEvidence, driftPhases: [...drift].sort((left, right) => AZURE_COPY_PHASES.findIndex((phase) => phase.name === left) - AZURE_COPY_PHASES.findIndex((phase) => phase.name === right)), achievedConsistency: consistencyMode === 'ordered-live-copy' ? 'crash' : 'application', files, directories: before.directories, fileCount: files.length, directoryCount: before.directoryCount, totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), mediaFingerprint: stableDigest(canonicalFiles), directoryFingerprint: stableDigest(before.directories) });
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error instanceof InfluxDb3CoreAzureError ? error : new InfluxDb3CoreAzureError('INFLUXDB3_CORE_AZURE_CAPTURE_FAILED', 'DeployerX could not capture the InfluxDB 3 Core Azure node.', { category: error?.category || 'execution', retryable: Boolean(error?.retryable) });
    }
  }
}

module.exports = {
  AZURE_COPY_PHASES,
  InfluxDb3CoreAzureError,
  InfluxDb3CoreAzureStore,
  MAX_BLOBS,
  MAX_BYTES,
  MAX_DIRECTORIES,
  nodePrefix,
  normalizeAzureCredential,
  normalizeCoreAzureConfig
};
