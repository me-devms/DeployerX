const crypto = require('crypto');
const { Readable } = require('stream');
const {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} = require('@aws-sdk/client-s3');
const {
  ENGINE_ID,
  ENGINE_VERSION,
  FileRepositoryEngine
} = require('./repository-engine');
const { MAX_LIST_PAGE_SIZE, normalizeObjectKey } = require('./local-repository');
const {
  RepositoryLockError,
  decodeLockRecord,
  encodeLockRecord,
  isExpired,
  lockScopeId,
  normalizeLockRequest,
  publicLease,
  renewLease,
  sameLease,
  validateLease
} = require('./repository-lock');
const { checkRepositoryHealth } = require('./repository-health');
const { normalizeStoragePolicy } = require('./repository-capacity');

const ADAPTER_ID = 'deployerx.repository.s3-compatible';
const ADAPTER_VERSION = '1.0.0';
const STORE_DIRECTORY = '.deployerx-repository';
const DIRECT_UPLOAD_LIMIT_BYTES = 16 * 1024 * 1024;
const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
const MAX_MULTIPART_PARTS = 10000;
const MAX_OBJECT_SIZE_BYTES = MULTIPART_PART_SIZE_BYTES * MAX_MULTIPART_PARTS;
const MAX_LIST_OBJECTS = 100000;
const DEFAULT_TIMEOUT_MS = 30000;

class S3RepositoryError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'S3RepositoryError';
    this.code = code;
    this.category = options.category || 'repository';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeEndpoint(value, allowInsecureEndpoint) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let parsed;
  try { parsed = new URL(text); } catch { throw new TypeError('S3 endpoint must be a valid HTTP or HTTPS URL.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError('S3 endpoint must be an HTTP or HTTPS origin without credentials, query parameters, or fragments.');
  if (parsed.protocol === 'http:' && !allowInsecureEndpoint) throw new TypeError('HTTP S3 endpoints require explicit insecure-endpoint approval.');
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new TypeError('S3 endpoint must not include a path.');
  return parsed.origin;
}

function normalizeBucket(value) {
  const bucket = requiredText(value, 'S3 bucket', 63).toLowerCase();
  if (bucket.length < 3 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) || bucket.includes('..') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)) throw new TypeError('S3 bucket name is invalid.');
  return bucket;
}

function normalizePrefix(value) {
  const prefix = String(value ?? '').trim();
  if (!prefix) return '';
  if (prefix.startsWith('/') || prefix.endsWith('/') || prefix.includes('\\') || prefix.includes('//') || prefix.includes('\0') || prefix.length > 1024) throw new TypeError('S3 prefix is invalid.');
  const segments = prefix.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) throw new TypeError('S3 prefix is invalid.');
  return segments.join('/');
}

function normalizeS3RepositoryConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('S3 repository configuration must be an object.');
  const unknown = Object.keys(input).filter((key) => !['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'allowInsecureEndpoint', 'timeoutMs'].includes(key));
  if (unknown.length) throw new TypeError(`Unknown S3 repository field: ${unknown[0]}.`);
  const allowInsecureEndpoint = input.allowInsecureEndpoint === true;
  const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new TypeError('S3 timeout must be between 1 and 120 seconds.');
  const region = requiredText(input.region || 'us-east-1', 'S3 region', 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(region)) throw new TypeError('S3 region is invalid.');
  return {
    endpoint: normalizeEndpoint(input.endpoint, allowInsecureEndpoint),
    region,
    bucket: normalizeBucket(input.bucket),
    prefix: normalizePrefix(input.prefix),
    forcePathStyle: input.forcePathStyle === true,
    allowInsecureEndpoint,
    timeoutMs
  };
}

function normalizeS3Credential(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('S3 credentials must be an object.');
  const accessKeyId = requiredText(input.accessKeyId, 'S3 access key ID', 256);
  const secretAccessKey = requiredText(input.secretAccessKey, 'S3 secret access key', 4096);
  const sessionToken = String(input.sessionToken ?? '').trim();
  if (sessionToken.length > 8192 || sessionToken.includes('\0')) throw new TypeError('S3 session token is invalid.');
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function normalizeChecksum(checksum) {
  if (checksum?.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(checksum?.digest || '')) throw new S3RepositoryError('S3_REPOSITORY_WRITE_INVALID', 'Repository object checksum is invalid.', { category: 'validation' });
  return { algorithm: 'sha256', digest: checksum.digest };
}

function checksumBase64(hexDigest) {
  return Buffer.from(hexDigest, 'hex').toString('base64');
}

function binaryParts(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return (async function* onePart() { yield Buffer.from(body); })();
  if (body && typeof body[Symbol.asyncIterator] === 'function') return body;
  throw new S3RepositoryError('S3_REPOSITORY_WRITE_INVALID', 'Repository object body must be binary data or a binary stream.', { category: 'validation' });
}

function responseBodyParts(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return (async function* onePart() { yield Buffer.from(body); })();
  if (body && typeof body[Symbol.asyncIterator] === 'function') return body;
  throw new S3RepositoryError('S3_REPOSITORY_READ_FAILED', 'The S3 provider returned an invalid object stream.', { category: 'integrity' });
}

function normalizedSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_SIZE_BYTES) throw new S3RepositoryError('S3_REPOSITORY_OBJECT_INVALID', 'S3 repository object size is invalid.', { category: 'integrity' });
  return size;
}

function statusCode(error) {
  return Number(error?.$metadata?.httpStatusCode || error?.statusCode || 0);
}

function isMissing(error) {
  return statusCode(error) === 404 || ['NotFound', 'NoSuchKey', 'NoSuchBucket'].includes(error?.name);
}

function isPreconditionFailure(error) {
  return statusCode(error) === 412 || error?.name === 'PreconditionFailed';
}

function safeS3Error(error, fallbackCode = 'S3_REPOSITORY_OPERATION_FAILED', fallbackMessage = 'The S3 repository operation failed.') {
  if (error instanceof S3RepositoryError) return error;
  if (isMissing(error)) return new S3RepositoryError('S3_REPOSITORY_OBJECT_NOT_FOUND', 'S3 repository object was not found.', { category: 'not-found' });
  if (isPreconditionFailure(error)) return new S3RepositoryError('S3_REPOSITORY_OBJECT_CONFLICT', 'An immutable S3 repository object already exists with different content.', { category: 'integrity' });
  if (statusCode(error) === 401 || ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken'].includes(error?.name)) return new S3RepositoryError('S3_AUTHENTICATION_FAILED', 'S3 authentication failed. Check the access key, secret key, region, and endpoint.', { category: 'authentication' });
  if (statusCode(error) === 403 || error?.name === 'AccessDenied') return new S3RepositoryError('S3_REPOSITORY_ACCESS_DENIED', 'The S3 credentials do not have permission to use this bucket or prefix.', { category: 'authorization' });
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return new S3RepositoryError('S3_REPOSITORY_TIMEOUT', 'The S3 repository operation was canceled or timed out.', { category: 'timeout', retryable: true });
  if ([429, 500, 502, 503, 504].includes(statusCode(error)) || ['SlowDown', 'RequestTimeout'].includes(error?.name)) return new S3RepositoryError('S3_REPOSITORY_THROTTLED', 'The S3 provider is temporarily unavailable or throttling requests.', { category: 'availability', retryable: true });
  return new S3RepositoryError(fallbackCode, fallbackMessage, { retryable: true });
}

function encodeCursor(prefix, providerToken) {
  const token = String(providerToken || '');
  const signature = crypto.createHash('sha256').update(`s3-repository-list-v1\0${prefix}\0${token}`).digest('hex').slice(0, 16);
  return Buffer.from(JSON.stringify({ version: 1, prefix, token, signature }), 'utf8').toString('base64url');
}

function decodeCursor(value, prefix) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(requiredText(value, 'Repository list cursor', 8192), 'base64url').toString('utf8'));
    if (parsed.version !== 1 || parsed.prefix !== prefix || typeof parsed.token !== 'string' || parsed.token.length > 4096 || encodeCursor(prefix, parsed.token) !== value) throw new Error('invalid');
    return parsed.token;
  } catch {
    throw new S3RepositoryError('S3_REPOSITORY_CURSOR_INVALID', 'Repository list cursor is invalid.', { category: 'validation' });
  }
}

function capabilitiesFromProbe(probe = {}) {
  return {
    operations: { list: true, stat: true, read: true, rangeRead: true, write: true, resumeWrite: false, multipartWrite: true, atomicCommit: true, copy: true, delete: true },
    locking: 'conditional-write', consistency: 'read-after-write', checksums: ['sha256'],
    versioning: probe.versioning === true, objectImmutability: probe.objectLock === true, legalHold: probe.objectLock === true,
    storageClasses: false, serverSideEncryption: false, clientSideEncryptionCompatible: true,
    capacityReporting: 'unavailable', maximumObjectSizeBytes: MAX_OBJECT_SIZE_BYTES,
    minimumPartSizeBytes: 5 * 1024 * 1024, caseSensitiveKeys: true,
    reductions: [
      'no-cross-process-multipart-resume',
      ...(probe.versioning === true ? [] : ['bucket-versioning-unavailable']),
      ...(probe.objectLock === true ? [] : ['object-lock-unavailable']),
      'capacity-reporting-unavailable'
    ]
  };
}

class S3CompatibleRepositoryAdapter {
  constructor({ config, credentialSecretRefId, resolveSecret, client, clientFactory, clock = () => new Date().toISOString() } = {}) {
    this.config = normalizeS3RepositoryConfig(config || {});
    this.credentialSecretRefId = requiredText(credentialSecretRefId, 'S3 credential SecretRef ID', 200);
    if (typeof resolveSecret !== 'function') throw new TypeError('S3 repository SecretRef resolver is required.');
    this.resolveSecret = resolveSecret;
    this.clock = clock;
    this.client = client || (clientFactory || ((options) => new S3Client(options)))({
      region: this.config.region,
      ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
      forcePathStyle: this.config.forcePathStyle,
      credentials: async () => normalizeS3Credential(JSON.parse(await this.resolveSecret(this.credentialSecretRefId)))
    });
    this.storePrefix = this.config.prefix ? `${this.config.prefix}/${STORE_DIRECTORY}` : STORE_DIRECTORY;
    this.objectsPrefix = `${this.storePrefix}/objects`;
    this.activeSessions = new Map();
    this.initialized = false;
    this.capabilityProbe = null;
  }

  manifest() {
    return { apiVersion: 1, id: ADAPTER_ID, version: ADAPTER_VERSION, kind: 'repository', displayName: 'S3-compatible storage', capabilities: this.capabilities() };
  }

  capabilities() { return capabilitiesFromProbe(this.capabilityProbe || {}); }
  normalizeConfig(input) { return normalizeS3RepositoryConfig(input); }
  validateConfig(input) { try { this.normalizeConfig(input); return []; } catch (error) { return [{ path: '', code: 'S3_REPOSITORY_CONFIG_INVALID', safeMessage: error.message }]; } }

  async #send(command, context = {}) {
    const upstream = context.abortSignal || context.signal || null;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (upstream?.aborted) controller.abort();
    else upstream?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try { return await this.client.send(command, { abortSignal: controller.signal }); }
    finally { clearTimeout(timer); upstream?.removeEventListener?.('abort', onAbort); }
  }

  #key(key) {
    const normalized = normalizeObjectKey(key);
    return { key: normalized, providerKey: `${this.objectsPrefix}/${normalized}` };
  }

  async initialize(context = {}) {
    if (this.initialized) return { bucket: this.config.bucket, prefix: this.storePrefix };
    try {
      await this.#send(new HeadBucketCommand({ Bucket: this.config.bucket }), context);
      this.initialized = true;
      return { bucket: this.config.bucket, prefix: this.storePrefix };
    } catch (error) {
      throw safeS3Error(error, 'S3_REPOSITORY_INITIALIZE_FAILED', 'DeployerX could not access the configured S3 bucket.');
    }
  }

  async stat(context, key) {
    await this.initialize(context);
    const resolved = this.#key(key);
    try {
      const result = await this.#send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: resolved.providerKey, ChecksumMode: 'ENABLED' }), context);
      return { key: resolved.key, sizeBytes: normalizedSize(result.ContentLength), modifiedAt: result.LastModified instanceof Date ? result.LastModified.toISOString() : null, etag: result.ETag || null, versionId: result.VersionId || null, checksum: result.ChecksumSHA256 ? { algorithm: 'sha256', digest: Buffer.from(result.ChecksumSHA256, 'base64').toString('hex') } : null };
    } catch (error) {
      if (isMissing(error)) return null;
      throw safeS3Error(error, 'S3_REPOSITORY_STAT_FAILED', 'DeployerX could not inspect an S3 repository object.');
    }
  }

  async read(context, request = {}) {
    await this.initialize(context);
    const resolved = this.#key(request.key);
    const offset = request.offset === undefined ? 0 : Number(request.offset);
    const length = request.length === undefined ? null : Number(request.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== null && (!Number.isSafeInteger(length) || length < 1))) throw new S3RepositoryError('S3_REPOSITORY_RANGE_INVALID', 'S3 repository read range is invalid.', { category: 'validation' });
    const range = length === null && offset === 0 ? undefined : `bytes=${offset}-${length === null ? '' : offset + length - 1}`;
    const adapter = this;
    return (async function* readS3Object() {
      let result;
      try { result = await adapter.#send(new GetObjectCommand({ Bucket: adapter.config.bucket, Key: resolved.providerKey, ...(range ? { Range: range } : {}) }), context); }
      catch (error) { throw safeS3Error(error, 'S3_REPOSITORY_READ_FAILED', 'DeployerX could not read an S3 repository object.'); }
      const expected = normalizedSize(result.ContentLength);
      let received = 0;
      for await (const rawPart of responseBodyParts(result.Body)) {
        if (!Buffer.isBuffer(rawPart) && !(rawPart instanceof Uint8Array)) throw new S3RepositoryError('S3_REPOSITORY_READ_FAILED', 'The S3 provider returned invalid object bytes.', { category: 'integrity' });
        const part = Buffer.from(rawPart);
        received += part.length;
        if (received > expected || received > MAX_OBJECT_SIZE_BYTES) throw new S3RepositoryError('S3_REPOSITORY_OBJECT_INVALID', 'S3 repository object exceeded its declared size.', { category: 'integrity' });
        yield part;
      }
      if (received !== expected) throw new S3RepositoryError('S3_REPOSITORY_OBJECT_INVALID', 'S3 repository object size changed while it was read.', { category: 'integrity' });
    })();
  }

  async #hashObject(context, resolved) {
    const checksum = crypto.createHash('sha256');
    let sizeBytes = 0;
    for await (const part of await this.read(context, { key: resolved.key })) {
      sizeBytes += part.length;
      checksum.update(part);
    }
    return { sizeBytes, checksum: { algorithm: 'sha256', digest: checksum.digest('hex') } };
  }

  async #existingEvidence(context, resolved, declaredSize, checksum) {
    const stat = await this.stat(context, resolved.key);
    if (!stat) return null;
    if (stat.sizeBytes !== declaredSize) throw new S3RepositoryError('S3_REPOSITORY_OBJECT_CONFLICT', 'An immutable S3 repository object already exists with different content.', { category: 'integrity' });
    const evidence = await this.#hashObject(context, resolved);
    if (evidence.checksum.digest !== checksum.digest) throw new S3RepositoryError('S3_REPOSITORY_OBJECT_CONFLICT', 'An immutable S3 repository object already exists with different content.', { category: 'integrity' });
    return evidence;
  }

  async *#verifiedParts(body, declaredSize, checksum, tracker) {
    const hash = crypto.createHash('sha256');
    let buffers = [];
    let bufferedBytes = 0;
    for await (const rawPart of binaryParts(body)) {
      if (!Buffer.isBuffer(rawPart) && !(rawPart instanceof Uint8Array)) throw new S3RepositoryError('S3_REPOSITORY_WRITE_INVALID', 'Repository object stream emitted invalid data.', { category: 'validation' });
      const input = Buffer.from(rawPart);
      tracker.sizeBytes += input.length;
      if (!Number.isSafeInteger(tracker.sizeBytes) || tracker.sizeBytes > declaredSize || tracker.sizeBytes > MAX_OBJECT_SIZE_BYTES) throw new S3RepositoryError('S3_REPOSITORY_WRITE_INVALID', 'Repository object stream exceeded its declared size.', { category: 'validation' });
      hash.update(input);
      let position = 0;
      while (position < input.length) {
        const take = Math.min(MULTIPART_PART_SIZE_BYTES - bufferedBytes, input.length - position);
        buffers.push(input.subarray(position, position + take));
        bufferedBytes += take;
        position += take;
        if (bufferedBytes === MULTIPART_PART_SIZE_BYTES) {
          yield Buffer.concat(buffers, bufferedBytes);
          buffers = [];
          bufferedBytes = 0;
        }
      }
    }
    if (bufferedBytes || declaredSize === 0) yield Buffer.concat(buffers, bufferedBytes);
    tracker.digest = hash.digest('hex');
    if (tracker.sizeBytes !== declaredSize || tracker.digest !== checksum.digest) throw new S3RepositoryError('S3_REPOSITORY_WRITE_MISMATCH', 'Repository object bytes do not match their declared size or checksum.', { category: 'integrity' });
  }

  async #directUpload(context, resolved, request, declaredSize, checksum) {
    const tracker = { sizeBytes: 0, digest: null };
    const body = Readable.from(this.#verifiedParts(request.body, declaredSize, checksum, tracker));
    const result = await this.#send(new PutObjectCommand({
      Bucket: this.config.bucket, Key: resolved.providerKey, Body: body, ContentLength: declaredSize,
      IfNoneMatch: '*', ChecksumSHA256: checksumBase64(checksum.digest),
      Metadata: { 'deployerx-sha256': checksum.digest, 'deployerx-size': String(declaredSize) }
    }), context);
    return { etag: result.ETag || null, versionId: result.VersionId || null, multipart: false };
  }

  async #multipartUpload(context, resolved, request, declaredSize, checksum) {
    let uploadId = null;
    try {
      const created = await this.#send(new CreateMultipartUploadCommand({
        Bucket: this.config.bucket, Key: resolved.providerKey, ChecksumAlgorithm: 'SHA256',
        Metadata: { 'deployerx-sha256': checksum.digest, 'deployerx-size': String(declaredSize) }
      }), context);
      uploadId = requiredText(created.UploadId, 'S3 multipart upload ID', 4096);
      const tracker = { sizeBytes: 0, digest: null };
      const completedParts = [];
      let partNumber = 0;
      for await (const part of this.#verifiedParts(request.body, declaredSize, checksum, tracker)) {
        partNumber += 1;
        if (partNumber > MAX_MULTIPART_PARTS) throw new S3RepositoryError('S3_REPOSITORY_WRITE_INVALID', 'Repository object requires too many multipart upload parts.', { category: 'capacity' });
        const partChecksum = crypto.createHash('sha256').update(part).digest('base64');
        const uploaded = await this.#send(new UploadPartCommand({ Bucket: this.config.bucket, Key: resolved.providerKey, UploadId: uploadId, PartNumber: partNumber, Body: part, ContentLength: part.length, ChecksumSHA256: partChecksum }), context);
        completedParts.push({ ETag: uploaded.ETag, PartNumber: partNumber, ChecksumSHA256: uploaded.ChecksumSHA256 || partChecksum });
      }
      const completed = await this.#send(new CompleteMultipartUploadCommand({ Bucket: this.config.bucket, Key: resolved.providerKey, UploadId: uploadId, IfNoneMatch: '*', MultipartUpload: { Parts: completedParts } }), context);
      uploadId = null;
      return { etag: completed.ETag || null, versionId: completed.VersionId || null, multipart: true, partCount: completedParts.length };
    } catch (error) {
      if (uploadId) await this.#send(new AbortMultipartUploadCommand({ Bucket: this.config.bucket, Key: resolved.providerKey, UploadId: uploadId }), context).catch(() => {});
      throw error;
    }
  }

  async write(context, request = {}) {
    await this.initialize(context);
    const resolved = this.#key(request.key);
    const declaredSize = Number(request.sizeBytes);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_OBJECT_SIZE_BYTES) throw new S3RepositoryError('S3_REPOSITORY_WRITE_INVALID', 'Repository object size is invalid.', { category: 'validation' });
    const checksum = normalizeChecksum(request.checksum);
    const token = crypto.randomUUID();
    let providerEvidence;
    let existing = false;
    try {
      providerEvidence = declaredSize <= DIRECT_UPLOAD_LIMIT_BYTES
        ? await this.#directUpload(context, resolved, request, declaredSize, checksum)
        : await this.#multipartUpload(context, resolved, request, declaredSize, checksum);
    } catch (error) {
      try {
        const evidence = await this.#existingEvidence(context, resolved, declaredSize, checksum);
        if (evidence) { providerEvidence = { ...evidence, multipart: declaredSize > DIRECT_UPLOAD_LIMIT_BYTES }; existing = true; }
      } catch (evidenceError) {
        if (evidenceError instanceof S3RepositoryError && evidenceError.code === 'S3_REPOSITORY_OBJECT_CONFLICT') throw evidenceError;
      }
      if (!providerEvidence) throw safeS3Error(error, 'S3_REPOSITORY_WRITE_FAILED', 'DeployerX could not upload an S3 repository object.');
    }
    const session = { token, key: resolved.key, providerKey: resolved.providerKey, sizeBytes: declaredSize, checksum, existing, providerEvidence, idempotencyKey: request.idempotencyKey || null };
    this.activeSessions.set(token, session);
    return { ...session };
  }

  async commit(context, input = {}) {
    const session = this.activeSessions.get(input.token);
    if (!session || session.key !== input.key || session.providerKey !== input.providerKey) throw new S3RepositoryError('S3_REPOSITORY_SESSION_INVALID', 'S3 repository write session is invalid.', { category: 'validation' });
    const evidence = await this.#existingEvidence(context, this.#key(session.key), session.sizeBytes, session.checksum);
    if (!evidence) throw new S3RepositoryError('S3_REPOSITORY_COMMIT_FAILED', 'S3 repository object was not visible after commit.', { category: 'consistency', retryable: true });
    this.activeSessions.delete(session.token);
    return { key: session.key, ...evidence, existing: session.existing, etag: session.providerEvidence?.etag || null, versionId: session.providerEvidence?.versionId || null, multipart: Boolean(session.providerEvidence?.multipart) };
  }

  async abort(_context, input = {}) {
    const session = this.activeSessions.get(input.token);
    if (!session) return { aborted: false };
    this.activeSessions.delete(session.token);
    return { aborted: true, objectRetained: true };
  }

  async copy(context, request = {}) {
    const source = this.#key(request.sourceKey);
    const target = this.#key(request.targetKey);
    const sourceStat = await this.stat(context, source.key);
    if (!sourceStat) throw new S3RepositoryError('S3_REPOSITORY_OBJECT_NOT_FOUND', 'S3 repository source object was not found.', { category: 'not-found' });
    const evidence = await this.#hashObject(context, source);
    const body = await this.read(context, { key: source.key });
    const session = await this.write(context, { key: target.key, body, sizeBytes: evidence.sizeBytes, checksum: evidence.checksum, idempotencyKey: request.idempotencyKey });
    return this.commit(context, session);
  }

  async delete(context, request = {}) {
    await this.initialize(context);
    const resolved = this.#key(request.key);
    const existing = await this.stat(context, resolved.key);
    if (!existing) return { key: resolved.key, deleted: false, absent: true };
    try {
      const result = await this.#send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: resolved.providerKey }), context);
      return { key: resolved.key, deleted: true, absent: false, deleteMarker: result.DeleteMarker === true, versionId: result.VersionId || null };
    } catch (error) {
      throw safeS3Error(error, 'S3_REPOSITORY_DELETE_FAILED', 'DeployerX could not delete an S3 repository object.');
    }
  }

  async *list(context, request = {}) {
    await this.initialize(context);
    const prefix = String(request.prefix ?? '').trim();
    if (prefix) normalizeObjectKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    const pageSize = request.pageSize === undefined ? 100 : Number(request.pageSize);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_LIST_PAGE_SIZE) throw new S3RepositoryError('S3_REPOSITORY_LIST_INVALID', 'Repository list page size is invalid.', { category: 'validation' });
    const continuationToken = decodeCursor(request.cursor, prefix);
    const providerPrefix = `${this.objectsPrefix}/${prefix}`;
    let result;
    try { result = await this.#send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: providerPrefix, MaxKeys: pageSize, ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }), context); }
    catch (error) { throw safeS3Error(error, 'S3_REPOSITORY_LIST_FAILED', 'DeployerX could not list S3 repository objects.'); }
    const contents = Array.isArray(result.Contents) ? result.Contents : [];
    if (contents.length > pageSize || contents.length > MAX_LIST_OBJECTS) throw new S3RepositoryError('S3_REPOSITORY_LIST_LIMIT_EXCEEDED', 'S3 repository listing exceeded the bounded page limit.', { category: 'capacity' });
    const items = contents.map((item) => {
      const providerKey = requiredText(item.Key, 'S3 object key', 2048);
      const boundary = `${this.objectsPrefix}/`;
      if (!providerKey.startsWith(boundary)) throw new S3RepositoryError('S3_REPOSITORY_OBJECT_INVALID', 'S3 provider returned an object outside the repository prefix.', { category: 'integrity' });
      const key = normalizeObjectKey(providerKey.slice(boundary.length));
      if (!key.startsWith(prefix)) throw new S3RepositoryError('S3_REPOSITORY_OBJECT_INVALID', 'S3 provider returned an object outside the requested prefix.', { category: 'integrity' });
      return { key, sizeBytes: normalizedSize(item.Size), modifiedAt: item.LastModified instanceof Date ? item.LastModified.toISOString() : null, etag: item.ETag || null };
    });
    const nextToken = result.IsTruncated ? requiredText(result.NextContinuationToken, 'S3 continuation token', 4096) : null;
    yield { items, nextCursor: nextToken ? encodeCursor(prefix, nextToken) : null, hasMore: Boolean(nextToken) };
  }

  async getCapacity() { return { reporting: 'unavailable', measuredAt: this.clock() }; }

  #lockKey(scope) {
    const scopeId = lockScopeId(scope);
    return { key: `${this.storePrefix}/locks/${scopeId}.dxl`, binding: `${ADAPTER_ID}:${scopeId}` };
  }

  async #readLock(context, paths, masterKey) {
    let result;
    try {
      result = await this.#send(new GetObjectCommand({ Bucket: this.config.bucket, Key: paths.key }), context);
    } catch (error) {
      if (isMissing(error)) return null;
      throw safeS3Error(error, 'REPOSITORY_LOCK_READ_FAILED', 'DeployerX could not read the S3 repository lease.');
    }
    const parts = [];
    let sizeBytes = 0;
    for await (const part of responseBodyParts(result.Body)) {
      sizeBytes += part.length;
      if (sizeBytes > 16 * 1024 + 64) throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'S3 repository lease record is too large.', { category: 'integrity', retryable: false });
      parts.push(Buffer.from(part));
    }
    return { lease: decodeLockRecord(Buffer.concat(parts), masterKey, paths.binding), etag: requiredText(result.ETag, 'S3 repository lease ETag', 512) };
  }

  async acquireLock(context = {}, request = {}) {
    await this.initialize(context);
    const lease = normalizeLockRequest(request, this.clock);
    const paths = this.#lockKey(lease.scope);
    const body = encodeLockRecord(lease, context.masterKey, paths.binding);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.#send(new PutObjectCommand({ Bucket: this.config.bucket, Key: paths.key, Body: body, ContentLength: body.length, IfNoneMatch: '*', ChecksumSHA256: crypto.createHash('sha256').update(body).digest('base64') }), context);
        return publicLease(lease);
      } catch (error) {
        if (!isPreconditionFailure(error)) throw safeS3Error(error, 'REPOSITORY_LOCK_ACQUIRE_FAILED', 'DeployerX could not acquire the S3 repository lease.');
      }
      const existing = await this.#readLock(context, paths, context.masterKey);
      if (existing && !isExpired(existing.lease, this.clock)) throw new RepositoryLockError('REPOSITORY_LOCK_CONTENDED', 'The repository is already locked by another operation.');
      if (existing) {
        try {
          await this.#send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: paths.key, IfMatch: existing.etag }), context);
        } catch (error) {
          if (!isPreconditionFailure(error)) throw safeS3Error(error, 'REPOSITORY_LOCK_TAKEOVER_FAILED', 'DeployerX could not replace the expired S3 repository lease.');
        }
      }
    }
    throw new RepositoryLockError('REPOSITORY_LOCK_CONTENDED', 'The S3 repository lease changed while DeployerX tried to acquire it.');
  }

  async renewLock(context = {}, input = {}) {
    await this.initialize(context);
    const lease = validateLease(input);
    const paths = this.#lockKey(lease.scope);
    const existing = await this.#readLock(context, paths, context.masterKey);
    if (!existing || !sameLease(existing.lease, lease)) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The S3 repository lease is no longer owned by this operation.');
    const renewed = renewLease(existing.lease, this.clock);
    const body = encodeLockRecord(renewed, context.masterKey, paths.binding);
    try {
      const result = await this.#send(new PutObjectCommand({ Bucket: this.config.bucket, Key: paths.key, Body: body, ContentLength: body.length, IfMatch: existing.etag, ChecksumSHA256: crypto.createHash('sha256').update(body).digest('base64') }), context);
      return { ...publicLease(renewed), providerVersion: result.VersionId || null };
    } catch (error) {
      if (isPreconditionFailure(error)) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The S3 repository lease changed while it was renewed.');
      throw safeS3Error(error, 'REPOSITORY_LOCK_RENEW_FAILED', 'DeployerX could not renew the S3 repository lease.');
    }
  }

  async releaseLock(context = {}, input = {}) {
    await this.initialize(context);
    const lease = validateLease(input);
    const paths = this.#lockKey(lease.scope);
    const existing = await this.#readLock(context, paths, context.masterKey);
    if (!existing) return { released: false, absent: true };
    if (!sameLease(existing.lease, lease)) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The S3 repository lease is owned by another operation.');
    try {
      await this.#send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: paths.key, IfMatch: existing.etag }), context);
      return { released: true, absent: false };
    } catch (error) {
      if (isMissing(error)) return { released: false, absent: true };
      if (isPreconditionFailure(error)) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The S3 repository lease changed before it could be released.');
      throw safeS3Error(error, 'REPOSITORY_LOCK_RELEASE_FAILED', 'DeployerX could not release the S3 repository lease.');
    }
  }

  async testConnection(context = {}) {
    const startedAt = Date.now();
    const probeKey = `${this.storePrefix}/probes/${crypto.randomUUID()}.probe`;
    const first = Buffer.from('deployerx-s3-probe-original');
    const replacement = Buffer.from('deployerx-s3-probe-replacement');
    try {
      await this.initialize(context);
      await this.#send(new PutObjectCommand({ Bucket: this.config.bucket, Key: probeKey, Body: first, ContentLength: first.length, IfNoneMatch: '*', ChecksumSHA256: crypto.createHash('sha256').update(first).digest('base64') }), context);
      let conditionalWrite = false;
      try {
        await this.#send(new PutObjectCommand({ Bucket: this.config.bucket, Key: probeKey, Body: replacement, ContentLength: replacement.length, IfNoneMatch: '*', ChecksumSHA256: crypto.createHash('sha256').update(replacement).digest('base64') }), context);
      } catch (error) {
        conditionalWrite = isPreconditionFailure(error);
        if (!conditionalWrite) throw error;
      }
      if (!conditionalWrite) throw new S3RepositoryError('S3_REPOSITORY_CONDITIONAL_WRITE_UNAVAILABLE', 'The S3 provider did not enforce immutable conditional object creation.', { category: 'compatibility' });
      let conditionalReplace = false;
      try {
        await this.#send(new PutObjectCommand({ Bucket: this.config.bucket, Key: probeKey, Body: replacement, ContentLength: replacement.length, IfMatch: '"deployerx-intentionally-wrong-etag"', ChecksumSHA256: crypto.createHash('sha256').update(replacement).digest('base64') }), context);
      } catch (error) {
        conditionalReplace = isPreconditionFailure(error);
        if (!conditionalReplace) throw error;
      }
      if (!conditionalReplace) throw new S3RepositoryError('S3_REPOSITORY_LOCKING_UNAVAILABLE', 'The S3 provider did not enforce conditional lease replacement.', { category: 'compatibility' });
      let conditionalDelete = false;
      try {
        await this.#send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: probeKey, IfMatch: '"deployerx-intentionally-wrong-etag"' }), context);
      } catch (error) {
        conditionalDelete = isPreconditionFailure(error);
        if (!conditionalDelete) throw error;
      }
      if (!conditionalDelete) throw new S3RepositoryError('S3_REPOSITORY_LOCKING_UNAVAILABLE', 'The S3 provider did not enforce conditional lease deletion.', { category: 'compatibility' });
      const range = await this.#send(new GetObjectCommand({ Bucket: this.config.bucket, Key: probeKey, Range: 'bytes=0-3' }), context);
      const rangeParts = [];
      for await (const part of responseBodyParts(range.Body)) rangeParts.push(Buffer.from(part));
      if (!Buffer.concat(rangeParts).equals(first.subarray(0, 4))) throw new S3RepositoryError('S3_REPOSITORY_RANGE_READ_UNAVAILABLE', 'The S3 provider did not return the requested byte range.', { category: 'compatibility' });
      let versioning = false;
      let objectLock = false;
      try { versioning = (await this.#send(new GetBucketVersioningCommand({ Bucket: this.config.bucket }), context)).Status === 'Enabled'; } catch {}
      try { objectLock = (await this.#send(new GetObjectLockConfigurationCommand({ Bucket: this.config.bucket }), context)).ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled'; } catch {}
      this.capabilityProbe = { conditionalWrite: true, conditionalLocking: true, rangeRead: true, multipart: true, versioning, objectLock, probedAt: this.clock() };
      return { status: 'success', testedAt: this.clock(), latencyMs: Date.now() - startedAt, checks: [
        { id: 'bucket-access', status: 'pass', safeMessage: 'DeployerX can access the S3 bucket.' },
        { id: 'conditional-write', status: 'pass', safeMessage: 'The provider enforces atomic create-without-overwrite writes.' },
        { id: 'conditional-locking', status: 'pass', safeMessage: 'The provider enforces ETag-guarded repository lease renewal and release.' },
        { id: 'range-read', status: 'pass', safeMessage: 'The provider supports bounded byte-range reads.' }
      ], capabilities: this.capabilities() };
    } catch (error) {
      const safe = safeS3Error(error, 'S3_REPOSITORY_TEST_FAILED', 'DeployerX could not validate the S3 repository.');
      return { status: 'failure', testedAt: this.clock(), latencyMs: Date.now() - startedAt, checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message } };
    } finally {
      await this.#send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: probeKey }), context).catch(() => {});
    }
  }

  async probeCapabilities(context = {}) {
    const connectionTest = await this.testConnection(context);
    return { status: connectionTest.status === 'success' ? 'available' : 'unavailable', probedAt: this.clock(), capabilities: connectionTest.capabilities || this.capabilities(), connectionTest, reductions: (connectionTest.capabilities || this.capabilities()).reductions };
  }

  async validateImmutability(context = {}) {
    try {
      const result = await this.#send(new GetObjectLockConfigurationCommand({ Bucket: this.config.bucket }), context);
      const config = result.ObjectLockConfiguration || {};
      const retention = config.Rule?.DefaultRetention || null;
      return { supported: config.ObjectLockEnabled === 'Enabled', enforced: config.ObjectLockEnabled === 'Enabled' && Boolean(retention?.Mode), mode: retention?.Mode?.toLowerCase() || 'none', checkedAt: this.clock(), defaultRetention: retention ? { days: retention.Days || null, years: retention.Years || null } : null };
    } catch {
      return { supported: false, enforced: false, mode: 'none', checkedAt: this.clock(), defaultRetention: null };
    }
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class S3RepositoryService {
  constructor({ controlDatabase, secretStore, deviceId, adapterFactory = (config) => new S3CompatibleRepositoryAdapter(config), clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterFactory = adapterFactory;
    this.clock = clock;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('repository').list(tenant, { limit: 1000 }))
      .filter((repository) => repository.adapterId === ADAPTER_ID)
      .map((repository) => ({ ...repository, capabilities: capabilitiesFromProbe(repository.capabilityProbe || {}), currentDevice: (repository.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  #adapter(workspaceId, repositoryConfig, credentialSecretRefId) {
    return this.adapterFactory({ config: repositoryConfig, credentialSecretRefId, resolveSecret: (id) => this.secretStore.resolve({ workspaceId, id }), clock: this.clock });
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'Repository name', 200);
    const repositoryConfig = normalizeS3RepositoryConfig({
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
      forcePathStyle: input.forcePathStyle,
      allowInsecureEndpoint: input.allowInsecureEndpoint,
      timeoutMs: input.timeoutMs
    });
    const credential = normalizeS3Credential(input);
    const duplicate = (await this.list(tenant)).some((repository) => repository.location.bucket === repositoryConfig.bucket && repository.location.prefix === repositoryConfig.prefix && repository.location.endpoint === repositoryConfig.endpoint);
    if (duplicate) throw new TypeError('This S3 bucket and prefix are already configured as a repository in this workspace.');
    let credentialRef = null;
    let keyRef = null;
    try {
      credentialRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} S3 credentials`, secretType: 'access-key', value: JSON.stringify(credential), scope: 'device' });
      keyRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} repository encryption key ${crypto.randomUUID().slice(0, 8)}`, secretType: 'encryption-key', value: crypto.randomBytes(32).toString('base64'), scope: 'device' });
    } catch (error) {
      if (keyRef) await this.secretStore.delete({ workspaceId: tenant, id: keyRef.id }).catch(() => {});
      if (credentialRef) await this.secretStore.delete({ workspaceId: tenant, id: credentialRef.id }).catch(() => {});
      throw error;
    }
    let adapter;
    let repository;
    try {
      adapter = this.#adapter(tenant, repositoryConfig, credentialRef.id);
      const probe = await adapter.probeCapabilities({});
      if (probe.status !== 'available') {
        throw new S3RepositoryError(probe.connectionTest?.error?.code || 'S3_REPOSITORY_TEST_FAILED', probe.connectionTest?.error?.safeMessage || 'DeployerX could not validate the S3 repository.', { category: probe.connectionTest?.error?.category, retryable: probe.connectionTest?.error?.retryable });
      }
      const immutability = await adapter.validateImmutability({});
      repository = await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(credentialRef, actor));
        transaction.create('secretRef', secretMetadataInput(keyRef, actor));
        return transaction.create('repository', {
          workspaceId: tenant, actorId: actor, name, connectionId: null,
          adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
          location: repositoryConfig, secretRefIds: [credentialRef.id], encryptionKeyRefId: keyRef.id,
          encryption: { algorithm: 'aes-256-gcm', keyVersion: `secret:${keyRef.version}` }, scope: 'device', workerAffinity: [`device:${this.deviceId}`],
          immutability, storagePolicy: normalizeStoragePolicy(input.storagePolicy || {}), capacity: { reporting: 'unavailable', measuredAt: this.clock() }, capabilityProbe: adapter.capabilityProbe,
          health: { status: 'initializing', checkedAt: null, repositoryFormatVersion: null, safeErrorCode: null }
        });
      });
    } catch (error) {
      await this.secretStore.delete({ workspaceId: tenant, id: keyRef.id }).catch(() => {});
      await this.secretStore.delete({ workspaceId: tenant, id: credentialRef.id }).catch(() => {});
      throw error;
    }
    const engine = new FileRepositoryEngine({ adapter, clock: this.clock });
    try {
      await engine.ensureRepository({}, { repositoryId: repository.id });
    } catch (error) {
      return this.controlDatabase.repository('repository').update(tenant, repository.id, { health: { status: 'needs-attention', checkedAt: this.clock(), repositoryFormatVersion: null, safeErrorCode: error.code || 'S3_REPOSITORY_INITIALIZE_FAILED' } }, { expectedRevision: repository.revision, actorId: actor });
    }
    return (await this.test(tenant, actor, repository.id)).repository;
  }

  async open(workspaceId, repositoryId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const repository = await this.controlDatabase.repository('repository').get(tenant, requiredText(repositoryId, 'Repository ID', 200));
    if (!repository || repository.adapterId !== ADAPTER_ID) throw new Error('S3 repository was not found.');
    if (!(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This S3 repository belongs to another device.');
    const credentialSecretRefId = repository.secretRefIds?.[0];
    const encodedKey = await this.secretStore.resolve({ workspaceId: tenant, id: repository.encryptionKeyRefId });
    const masterKey = Buffer.from(encodedKey, 'base64');
    if (masterKey.length !== 32 || masterKey.toString('base64') !== encodedKey) throw new S3RepositoryError('S3_REPOSITORY_KEY_INVALID', 'S3 repository encryption key is invalid.', { category: 'encryption' });
    const adapter = this.#adapter(tenant, repository.location, credentialSecretRefId);
    return { repository, adapter, engine: new FileRepositoryEngine({ adapter, clock: this.clock }), masterKey, keyVersion: repository.encryption.keyVersion };
  }

  test(workspaceId, actorId, repositoryId) {
    return checkRepositoryHealth({
      controlDatabase: this.controlDatabase,
      workspaceId,
      actorId: requiredText(actorId, 'Actor ID', 200),
      repositoryId,
      deviceId: this.deviceId,
      openRepository: (tenant, id) => this.open(tenant, id),
      clock: this.clock
    });
  }

  async remove(workspaceId, actorId, repositoryId, revision) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const repository = await this.controlDatabase.repository('repository').get(tenant, requiredText(repositoryId, 'Repository ID', 200));
    if (!repository || repository.adapterId !== ADAPTER_ID) throw new Error('S3 repository was not found.');
    const expectedRevision = Number(revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('Repository revision is required for removal.');
    const removed = await this.controlDatabase.repository('repository').softDelete(tenant, repository.id, { expectedRevision, actorId: actor });
    let credentialsRemoved = false;
    for (const secretRefId of repository.secretRefIds || []) {
      try {
        await this.secretStore.delete({ workspaceId: tenant, id: secretRefId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').softDelete(tenant, secretRefId, { expectedRevision: metadata.revision, actorId: actor });
        credentialsRemoved = true;
      } catch {}
    }
    return { repository: removed, dataRetainedAt: `s3://${repository.location.bucket}/${repository.location.prefix || ''}`, encryptionKeyRetained: true, credentialsRemoved };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  DIRECT_UPLOAD_LIMIT_BYTES,
  MAX_OBJECT_SIZE_BYTES,
  MULTIPART_PART_SIZE_BYTES,
  S3CompatibleRepositoryAdapter,
  S3RepositoryError,
  S3RepositoryService,
  STORE_DIRECTORY,
  capabilitiesFromProbe,
  normalizeS3Credential,
  normalizeS3RepositoryConfig
};
