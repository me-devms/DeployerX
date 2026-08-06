const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { once } = require('events');
const {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');
const { normalizeS3Credential, normalizeS3RepositoryConfig } = require('./s3-repository');

const OBJECT_COPY_PHASES = Object.freeze([
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

class InfluxDb3CoreS3Error extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3CoreS3Error';
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

function normalizeCoreS3Config(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Core S3 configuration must be an object.');
  const allowed = ['objectStore', 'endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'allowInsecureEndpoint', 'timeoutMs', 'credentialSecretRefId', 'nodeId'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Core S3 field: ${unknown[0]}.`);
  if (input.objectStore !== undefined && String(input.objectStore).toLowerCase() !== 's3') throw new TypeError('InfluxDB 3 Core memory and non-S3 object stores are not valid S3 bindings.');
  const storage = normalizeS3RepositoryConfig({
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    prefix: input.prefix,
    forcePathStyle: input.forcePathStyle,
    allowInsecureEndpoint: input.allowInsecureEndpoint,
    timeoutMs: input.timeoutMs
  });
  return Object.freeze({
    objectStore: 's3',
    ...storage,
    credentialSecretRefId: requiredText(input.credentialSecretRefId, 'InfluxDB 3 Core S3 credential SecretRef ID', 200),
    nodeId: normalizeNodeId(input.nodeId)
  });
}

function nodePrefix(config) {
  return `${config.prefix ? `${config.prefix}/` : ''}${config.nodeId}/`;
}

function objectEtag(value) {
  const etag = requiredText(value, 'InfluxDB 3 Core S3 object ETag', 256);
  if (!/^"[\x21\x23-\x7e]+"$/.test(etag)) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_OBJECT_INVALID', 'InfluxDB 3 Core S3 returned an invalid object identity.', { category: 'integrity' });
  return etag;
}

function relativeObjectPath(key, config) {
  const exactPrefix = nodePrefix(config);
  const text = requiredText(key, 'InfluxDB 3 Core S3 object key', 8192);
  if (!text.startsWith(exactPrefix)) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_KEY_INVALID', 'InfluxDB 3 Core S3 returned an object outside the exact node prefix.', { category: 'integrity' });
  const relative = text.slice(exactPrefix.length);
  const marker = relative.endsWith('/');
  const comparable = marker ? relative.slice(0, -1) : relative;
  if (!comparable || comparable.startsWith('/') || comparable.includes('\\') || comparable.includes('//') || comparable.split('/').some((segment) => !segment || segment === '.' || segment === '..') || path.posix.normalize(comparable) !== comparable) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_KEY_INVALID', 'InfluxDB 3 Core S3 returned an unsafe object key.', { category: 'integrity' });
  return relative;
}

function objectPhase(relativePath) {
  if (relativePath === '_catalog_checkpoint') return '_catalog_checkpoint';
  const top = relativePath.split('/')[0];
  if (top === 'table-snapshots') return 'table-snapshots';
  if (OBJECT_COPY_PHASES.some((phase) => phase.kind === 'prefix' && phase.name === top)) return top;
  throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_LAYOUT_UNSUPPORTED', 'InfluxDB 3 Core S3 contains an unrecognized top-level component.', { category: 'compatibility' });
}

function safeSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_OBJECT_INVALID', 'InfluxDB 3 Core S3 returned an invalid object size.', { category: 'integrity' });
  return size;
}

function bodyParts(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return (async function* one() { yield Buffer.from(body); })();
  if (body && typeof body[Symbol.asyncIterator] === 'function') return body;
  throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_OBJECT_INVALID', 'InfluxDB 3 Core S3 returned an invalid object stream.', { category: 'integrity' });
}

function providerStatus(error) {
  return Number(error?.$metadata?.httpStatusCode || error?.statusCode || 0);
}

function safeProviderError(error, fallbackCode, fallbackMessage) {
  if (error instanceof InfluxDb3CoreS3Error) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_TIMEOUT', 'The InfluxDB 3 Core S3 operation timed out or was canceled.', { category: 'timeout', retryable: true });
  if ([401, 403].includes(providerStatus(error)) || ['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken'].includes(error?.name)) return new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_ACCESS_DENIED', 'InfluxDB 3 Core S3 credentials cannot access the configured bucket and prefix.', { category: providerStatus(error) === 401 ? 'authentication' : 'authorization' });
  if (providerStatus(error) === 404 || ['NoSuchBucket', 'NoSuchKey', 'NotFound'].includes(error?.name)) return new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_OBJECT_MISSING', 'A required InfluxDB 3 Core S3 object is unavailable.', { category: 'integrity' });
  if (providerStatus(error) === 412 || error?.name === 'PreconditionFailed') return new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_SOURCE_CHANGED', 'An InfluxDB 3 Core S3 object changed before it could be copied.', { category: 'consistency', retryable: true });
  return new InfluxDb3CoreS3Error(fallbackCode, fallbackMessage, { category: 'availability', retryable: true });
}

function targetWriteError(error) {
  if (providerStatus(error) === 409 || providerStatus(error) === 412 || ['ConditionalRequestConflict', 'PreconditionFailed'].includes(error?.name)) return new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core S3 node prefix changed during restore.', { category: 'conflict' });
  return safeProviderError(error, 'INFLUXDB3_CORE_S3_RESTORE_WRITE_FAILED', 'DeployerX could not write an InfluxDB 3 Core S3 restore object.');
}

function phaseDigest(phase, members) {
  return stableDigest(members.filter((member) => member.phase === phase).map(({ relativePath, sizeBytes, etag, lastModified }) => ({ relativePath, sizeBytes, etag, lastModified })));
}

function directoriesForMembers(members) {
  const directories = new Set(OBJECT_COPY_PHASES.filter((phase) => phase.kind === 'prefix').map((phase) => phase.name));
  for (const member of members) {
    let current = path.posix.dirname(member.relativePath);
    while (current && current !== '.') { directories.add(current); current = path.posix.dirname(current); }
  }
  const result = [...directories].sort((left, right) => left.localeCompare(right, 'en-US'));
  if (result.length > MAX_DIRECTORIES) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_STORAGE_LIMIT', 'InfluxDB 3 Core S3 contains too many logical directories.', { category: 'capacity' });
  return result;
}

class InfluxDb3CoreS3Store {
  constructor({ config, resolveSecret, client, clientFactory } = {}) {
    this.config = normalizeCoreS3Config(config);
    this.resolveSecret = resolveSecret;
    if (!client && typeof resolveSecret !== 'function') throw new TypeError('InfluxDB 3 Core S3 SecretRef resolver is required.');
    this.client = client || (clientFactory || ((options) => new S3Client(options)))({
      region: this.config.region,
      ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
      forcePathStyle: this.config.forcePathStyle,
      credentials: async () => normalizeS3Credential(JSON.parse(await this.resolveSecret(this.config.credentialSecretRefId)))
    });
  }

  async send(command, context = {}) {
    const upstream = context.signal || context.abortSignal || null;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (upstream?.aborted) controller.abort();
    else upstream?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try { return await this.client.send(command, { abortSignal: controller.signal }); }
    finally { clearTimeout(timer); upstream?.removeEventListener?.('abort', onAbort); }
  }

  async inspect(context = {}) {
    try { await this.send(new HeadBucketCommand({ Bucket: this.config.bucket }), context); }
    catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_S3_UNAVAILABLE', 'DeployerX could not access the InfluxDB 3 Core S3 bucket.'); }
    const members = [];
    let totalBytes = 0;
    let token = null;
    const seenTokens = new Set();
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      let response;
      try { response = await this.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: nodePrefix(this.config), MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }), context); }
      catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_S3_LIST_FAILED', 'DeployerX could not list the InfluxDB 3 Core S3 node.'); }
      for (const object of response?.Contents || []) {
        if (object.Key === nodePrefix(this.config)) {
          if (safeSize(object.Size) !== 0) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_OBJECT_INVALID', 'InfluxDB 3 Core S3 contains an invalid node marker.', { category: 'integrity' });
          continue;
        }
        const relativePath = relativeObjectPath(object.Key, this.config);
        const sizeBytes = safeSize(object.Size);
        if (relativePath.endsWith('/')) {
          if (sizeBytes !== 0) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_OBJECT_INVALID', 'InfluxDB 3 Core S3 contains an invalid directory marker.', { category: 'integrity' });
          objectPhase(relativePath.slice(0, -1));
          continue;
        }
        const phase = objectPhase(relativePath);
        if (phase === 'table-snapshots') continue;
        const lastModifiedDate = new Date(object.LastModified);
        if (Number.isNaN(lastModifiedDate.getTime())) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_OBJECT_INVALID', 'InfluxDB 3 Core S3 returned invalid object modification evidence.', { category: 'integrity' });
        members.push(Object.freeze({ key: object.Key, relativePath, phase, sizeBytes, etag: objectEtag(object.ETag), lastModified: lastModifiedDate.toISOString() }));
        totalBytes += sizeBytes;
        if (members.length > MAX_OBJECTS || totalBytes > MAX_BYTES) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_STORAGE_LIMIT', 'InfluxDB 3 Core S3 exceeds the supported backup limits.', { category: 'capacity' });
      }
      if (!response?.IsTruncated) { token = null; break; }
      token = requiredText(response.NextContinuationToken, 'InfluxDB 3 Core S3 continuation token', 4096);
      if (seenTokens.has(token)) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_LIST_INVALID', 'InfluxDB 3 Core S3 returned a repeated list cursor.', { category: 'integrity' });
      seenTokens.add(token);
      if (page === MAX_LIST_PAGES - 1) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_STORAGE_LIMIT', 'InfluxDB 3 Core S3 listing exceeds the supported page limit.', { category: 'capacity' });
    }
    members.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    if (!members.some((member) => member.relativePath === '_catalog_checkpoint')) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_LAYOUT_INVALID', 'InfluxDB 3 Core S3 is missing the catalog checkpoint.', { category: 'integrity' });
    if (new Set(members.map((member) => member.relativePath)).size !== members.length) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_LAYOUT_INVALID', 'InfluxDB 3 Core S3 returned duplicate node objects.', { category: 'integrity' });
    const directories = directoriesForMembers(members);
    const phaseEvidence = OBJECT_COPY_PHASES.map((phase) => Object.freeze({ phase: phase.name, digest: phaseDigest(phase.name, members), fileCount: members.filter((member) => member.phase === phase.name).length, totalBytes: members.filter((member) => member.phase === phase.name).reduce((sum, member) => sum + member.sizeBytes, 0) }));
    return Object.freeze({
      objectStore: 's3', nodeId: this.config.nodeId, bindingFingerprint: stableDigest({ objectStore: 's3', endpoint: this.config.endpoint, region: this.config.region, bucket: this.config.bucket, prefix: this.config.prefix, nodeId: this.config.nodeId }),
      members, directories, fileCount: members.length, directoryCount: directories.length, totalBytes, phaseEvidence, excluded: ['table-snapshots/'], layoutFingerprint: stableDigest(phaseEvidence.map(({ phase, digest }) => ({ phase, digest })))
    });
  }

  async assertEmpty(context = {}) {
    try {
      await this.send(new HeadBucketCommand({ Bucket: this.config.bucket }), context);
      const response = await this.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: nodePrefix(this.config), MaxKeys: 1 }), context);
      if ((response?.Contents || []).length || response?.IsTruncated) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_RESTORE_TARGET_EXISTS', 'The alternate InfluxDB 3 Core S3 node prefix must be empty before restore.', { category: 'conflict' });
      return Object.freeze({ empty: true, bindingFingerprint: stableDigest({ objectStore: 's3', endpoint: this.config.endpoint, region: this.config.region, bucket: this.config.bucket, prefix: this.config.prefix, nodeId: this.config.nodeId }) });
    } catch (error) {
      if (error instanceof InfluxDb3CoreS3Error) throw error;
      throw safeProviderError(error, 'INFLUXDB3_CORE_S3_RESTORE_TARGET_UNAVAILABLE', 'DeployerX could not inspect the alternate InfluxDB 3 Core S3 target.');
    }
  }

  async uploadRestoreMember(context, sourceRoot, member) {
    const source = path.join(sourceRoot, ...member.relativePath.split('/'));
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size !== member.sizeBytes) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_RESTORE_MEDIA_INVALID', 'An authenticated InfluxDB 3 Core restore member is unavailable.', { category: 'integrity' });
    const checksum = Buffer.from(member.contentDigest.slice('sha256:'.length), 'hex').toString('base64');
    try {
      await this.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: `${nodePrefix(this.config)}${member.relativePath}`, Body: fsSync.createReadStream(source, { highWaterMark: 1024 * 1024, signal: context.signal }), ContentLength: member.sizeBytes, ChecksumAlgorithm: 'SHA256', ChecksumSHA256: checksum, IfNoneMatch: '*' }), context);
    } catch (error) { throw targetWriteError(error); }
    return Object.freeze({ relativePath: member.relativePath, sizeBytes: member.sizeBytes, contentDigest: member.contentDigest });
  }

  async authenticateInstalled(context = {}, source = {}) {
    const layout = await this.inspect(context);
    if (layout.bindingFingerprint !== source.targetStorageFingerprint) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core S3 binding changed during validation.', { category: 'integrity' });
    const expected = new Map((source.nativeMedia?.members || []).map((member) => [member.relativePath, member]));
    const authenticated = [];
    for (const listed of layout.members) {
      const member = expected.get(listed.relativePath);
      if (!member || member.sizeBytes !== listed.sizeBytes) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_RESTORE_VALIDATION_FAILED', 'The restored InfluxDB 3 Core S3 inventory does not match the authenticated media.', { category: 'integrity' });
      let response;
      try { response = await this.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: listed.key, IfMatch: listed.etag }), context); }
      catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_S3_RESTORE_VALIDATION_FAILED', 'DeployerX could not validate an installed InfluxDB 3 Core S3 object.'); }
      if (objectEtag(response.ETag) !== listed.etag || safeSize(response.ContentLength) !== member.sizeBytes) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_RESTORE_VALIDATION_FAILED', 'An installed InfluxDB 3 Core S3 object changed during validation.', { category: 'integrity' });
      const hash = crypto.createHash('sha256'); let sizeBytes = 0;
      for await (const raw of bodyParts(response.Body)) { const chunk = Buffer.from(raw); hash.update(chunk); sizeBytes += chunk.length; if (sizeBytes > member.sizeBytes) break; }
      const contentDigest = `sha256:${hash.digest('hex')}`;
      if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_RESTORE_VALIDATION_FAILED', 'An installed InfluxDB 3 Core S3 object failed SHA-256 authentication.', { category: 'integrity' });
      authenticated.push({ relativePath: member.relativePath, sizeBytes, contentDigest });
    }
    authenticated.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    if (authenticated.length !== source.nativeMedia.fileCount || stableDigest(authenticated) !== source.nativeMedia.mediaFingerprint || layout.directoryCount !== source.nativeMedia.directoryCount || stableDigest(layout.directories) !== source.nativeMedia.directoryFingerprint || layout.totalBytes !== source.nativeMedia.totalBytes) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_RESTORE_VALIDATION_FAILED', 'The complete restored InfluxDB 3 Core S3 node failed authentication.', { category: 'integrity' });
    return Object.freeze({ files: authenticated, directories: layout.directories, totalBytes: layout.totalBytes, bindingFingerprint: layout.bindingFingerprint });
  }

  async copyMember(context, member, destinationRoot) {
    const destination = path.join(destinationRoot, ...member.relativePath.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    let response;
    try { response = await this.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: member.key, IfMatch: member.etag }), context); }
    catch (error) { throw safeProviderError(error, 'INFLUXDB3_CORE_S3_READ_FAILED', 'DeployerX could not read an InfluxDB 3 Core S3 object.'); }
    if (objectEtag(response.ETag) !== member.etag || safeSize(response.ContentLength) !== member.sizeBytes) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_SOURCE_CHANGED', 'An InfluxDB 3 Core S3 object identity changed while it was copied.', { category: 'consistency', retryable: true });
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const output = fsSync.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    try {
      for await (const raw of bodyParts(response.Body)) {
        if (context.signal?.aborted) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_CANCELED', 'The InfluxDB 3 Core S3 capture was canceled.', { category: 'canceled' });
        const chunk = Buffer.from(raw); sizeBytes += chunk.length; hash.update(chunk);
        if (sizeBytes > member.sizeBytes) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_SOURCE_CHANGED', 'An InfluxDB 3 Core S3 object size changed while it was copied.', { category: 'consistency', retryable: true });
        if (!output.write(chunk)) await once(output, 'drain');
      }
      await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
    } catch (error) {
      output.destroy(); await fs.rm(destination, { force: true }).catch(() => {}); throw error;
    }
    if (sizeBytes !== member.sizeBytes) { await fs.rm(destination, { force: true }).catch(() => {}); throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_SOURCE_CHANGED', 'An InfluxDB 3 Core S3 object was truncated while it was copied.', { category: 'consistency', retryable: true }); }
    return Object.freeze({ relativePath: member.relativePath, sizeBytes, contentDigest: `sha256:${hash.digest('hex')}` });
  }

  async capture(context = {}, destinationInput, consistencyMode = 'ordered-live-copy') {
    if (!['stopped', 'atomic-snapshot', 'ordered-live-copy'].includes(consistencyMode)) throw new TypeError('InfluxDB 3 Core S3 consistency mode is invalid.');
    const destination = path.resolve(requiredText(destinationInput, 'InfluxDB 3 Core S3 staging destination'));
    if (await fs.lstat(destination).catch(() => null)) throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_DESTINATION_EXISTS', 'InfluxDB 3 Core S3 staging destination already exists.', { category: 'conflict' });
    const before = await this.inspect(context);
    const files = [];
    const drift = new Set();
    try {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      for (const phase of OBJECT_COPY_PHASES) {
        await context.onProgress?.({ phase: 'capturing', component: phase.name, copyOrder: OBJECT_COPY_PHASES.map((item) => item.name) });
        for (const member of before.members.filter((candidate) => candidate.phase === phase.name)) files.push(await this.copyMember(context, member, destination));
        const current = await this.inspect(context);
        if (current.phaseEvidence.find((item) => item.phase === phase.name)?.digest !== before.phaseEvidence.find((item) => item.phase === phase.name)?.digest) drift.add(phase.name);
        if (drift.size && consistencyMode !== 'ordered-live-copy') throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_SOURCE_CHANGED', 'InfluxDB 3 Core S3 changed during an application-consistent capture.', { category: 'consistency', retryable: true, details: { driftPhases: [...drift] } });
      }
      const after = await this.inspect(context);
      for (const phase of OBJECT_COPY_PHASES) if (after.phaseEvidence.find((item) => item.phase === phase.name)?.digest !== before.phaseEvidence.find((item) => item.phase === phase.name)?.digest) drift.add(phase.name);
      if (drift.size && consistencyMode !== 'ordered-live-copy') throw new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_SOURCE_CHANGED', 'InfluxDB 3 Core S3 changed during an application-consistent capture.', { category: 'consistency', retryable: true, details: { driftPhases: [...drift] } });
      const canonicalFiles = files.map(({ relativePath, sizeBytes, contentDigest }) => ({ relativePath, sizeBytes, contentDigest })).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
      return Object.freeze({ directory: destination, objectStore: 's3', nodeId: this.config.nodeId, bindingFingerprint: before.bindingFingerprint, copyOrder: OBJECT_COPY_PHASES.map((phase) => phase.name), excluded: before.excluded, phaseEvidence: before.phaseEvidence, driftPhases: [...drift].sort((left, right) => OBJECT_COPY_PHASES.findIndex((phase) => phase.name === left) - OBJECT_COPY_PHASES.findIndex((phase) => phase.name === right)), achievedConsistency: consistencyMode === 'ordered-live-copy' ? 'crash' : 'application', files, directories: before.directories, fileCount: files.length, directoryCount: before.directoryCount, totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), mediaFingerprint: stableDigest(canonicalFiles), directoryFingerprint: stableDigest(before.directories) });
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error instanceof InfluxDb3CoreS3Error ? error : new InfluxDb3CoreS3Error('INFLUXDB3_CORE_S3_CAPTURE_FAILED', 'DeployerX could not capture the InfluxDB 3 Core S3 node.', { category: error?.category || 'execution', retryable: Boolean(error?.retryable) });
    }
  }
}

module.exports = {
  InfluxDb3CoreS3Error,
  InfluxDb3CoreS3Store,
  MAX_BYTES,
  MAX_DIRECTORIES,
  MAX_OBJECTS,
  OBJECT_COPY_PHASES,
  nodePrefix,
  normalizeCoreS3Config
};
