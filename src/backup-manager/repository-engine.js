const crypto = require('crypto');

const ENGINE_ID = 'deployerx.repository-engine.files';
const ENGINE_VERSION = '1.0.0';
const REPOSITORY_FORMAT_VERSION = 1;
const DEFAULT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const MIN_CHUNK_SIZE_BYTES = 64 * 1024;
const MAX_CHUNK_SIZE_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_BLOCK_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 100000;
const MAX_CHUNKS = 1000000;
const MAX_MATERIALIZED_FILE_BYTES = 256 * 1024 * 1024;
const OBJECT_MAGIC = Buffer.from('DXBKR001', 'ascii');
const OBJECT_KIND = Object.freeze({ chunk: 1, manifest: 2 });
const FORMAT_OBJECT_KEY = 'repository/format.json';

class RepositoryEngineError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'RepositoryEngineError';
    this.code = code;
    this.category = options.category || 'repository';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) {
    throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  }
  return text;
}

function safeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  }
  return number;
}

function normalizeMasterKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new RepositoryEngineError('REPOSITORY_KEY_INVALID', 'The repository encryption key must be binary key material.', { category: 'encryption' });
  }
  const key = Buffer.from(value);
  if (key.length < 32 || key.length > 1024) {
    throw new RepositoryEngineError('REPOSITORY_KEY_INVALID', 'The repository encryption key length is invalid.', { category: 'encryption' });
  }
  return key;
}

function normalizeChunkSize(value) {
  return value === undefined
    ? DEFAULT_CHUNK_SIZE_BYTES
    : safeInteger(value, 'Repository chunk size', MIN_CHUNK_SIZE_BYTES, MAX_CHUNK_SIZE_BYTES);
}

function normalizeSnapshotId(value) {
  const snapshotId = requiredText(value, 'Snapshot ID', 80);
  if (!/^snp_[a-f0-9]{40}$/.test(snapshotId)) {
    throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Snapshot ID is invalid.', { category: 'validation' });
  }
  return snapshotId;
}

function normalizeJson(value, depth = 0) {
  if (depth > 32) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Repository metadata is too deeply nested.', { category: 'validation' });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Repository metadata contains a non-finite number.', { category: 'validation' });
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Repository metadata must contain only JSON values.', { category: 'validation' });
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    output[requiredText(key, 'Repository metadata key', 256)] = normalizeJson(value[key], depth + 1);
  }
  return output;
}

function canonicalJson(value) {
  return Buffer.from(JSON.stringify(normalizeJson(value)), 'utf8');
}

function digest(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest('hex');
}

function deriveKeys(masterKey, repositoryId, keyVersion) {
  const key = normalizeMasterKey(masterKey);
  const salt = Buffer.from(requiredText(repositoryId, 'Repository ID', 200), 'utf8');
  const version = requiredText(keyVersion, 'Encryption key version', 128);
  const derive = (purpose) => Buffer.from(crypto.hkdfSync('sha256', key, salt, Buffer.from(`deployerx-backup-v1/${version}/${purpose}`, 'utf8'), 32));
  return {
    contentId: derive('content-id'),
    fileDigest: derive('file-digest'),
    chunkEncryption: derive('chunk-encryption'),
    manifestEncryption: derive('manifest-encryption'),
    snapshotId: derive('snapshot-id')
  };
}

function keyedDigest(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

function objectAad(kind, keyVersion) {
  return Buffer.concat([OBJECT_MAGIC, Buffer.from([kind]), Buffer.from(keyVersion, 'utf8')]);
}

function encryptObject(plaintext, kindName, key, keyVersion, randomBytes) {
  const kind = OBJECT_KIND[kindName];
  const version = requiredText(keyVersion, 'Encryption key version', 128);
  const versionBytes = Buffer.from(version, 'utf8');
  if (versionBytes.length > 65535) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Encryption key version is invalid.', { category: 'validation' });
  const nonce = randomBytes(12);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) throw new RepositoryEngineError('REPOSITORY_ENCRYPTION_FAILED', 'Repository encryption could not create a nonce.', { category: 'encryption' });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(objectAad(kind, version));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.alloc(OBJECT_MAGIC.length + 1 + 2);
  OBJECT_MAGIC.copy(header, 0);
  header.writeUInt8(kind, OBJECT_MAGIC.length);
  header.writeUInt16BE(versionBytes.length, OBJECT_MAGIC.length + 1);
  return Buffer.concat([header, nonce, tag, versionBytes, ciphertext]);
}

function parseObjectHeader(value) {
  const object = Buffer.from(value);
  const fixedLength = OBJECT_MAGIC.length + 1 + 2 + 12 + 16;
  if (object.length < fixedLength || !crypto.timingSafeEqual(object.subarray(0, OBJECT_MAGIC.length), OBJECT_MAGIC)) {
    throw new RepositoryEngineError('REPOSITORY_OBJECT_CORRUPT', 'A repository object has an invalid format header.', { category: 'integrity' });
  }
  const kind = object.readUInt8(OBJECT_MAGIC.length);
  const versionLength = object.readUInt16BE(OBJECT_MAGIC.length + 1);
  const versionStart = OBJECT_MAGIC.length + 3 + 12 + 16;
  const ciphertextStart = versionStart + versionLength;
  if (!Object.values(OBJECT_KIND).includes(kind) || versionLength === 0 || ciphertextStart > object.length) {
    throw new RepositoryEngineError('REPOSITORY_OBJECT_CORRUPT', 'A repository object header is corrupt.', { category: 'integrity' });
  }
  const keyVersion = object.subarray(versionStart, ciphertextStart).toString('utf8');
  requiredText(keyVersion, 'Repository object key version', 128);
  return {
    object,
    kind,
    keyVersion,
    nonce: object.subarray(OBJECT_MAGIC.length + 3, OBJECT_MAGIC.length + 3 + 12),
    tag: object.subarray(OBJECT_MAGIC.length + 3 + 12, versionStart),
    ciphertext: object.subarray(ciphertextStart)
  };
}

function decryptObject(value, kindName, key, expectedKeyVersion = null) {
  const header = parseObjectHeader(value);
  const expectedKind = OBJECT_KIND[kindName];
  if (header.kind !== expectedKind || (expectedKeyVersion && header.keyVersion !== expectedKeyVersion)) {
    throw new RepositoryEngineError('REPOSITORY_OBJECT_CORRUPT', 'A repository object does not match its manifest.', { category: 'integrity' });
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.nonce);
    decipher.setAAD(objectAad(header.kind, header.keyVersion));
    decipher.setAuthTag(header.tag);
    return { plaintext: Buffer.concat([decipher.update(header.ciphertext), decipher.final()]), keyVersion: header.keyVersion };
  } catch {
    throw new RepositoryEngineError('REPOSITORY_AUTHENTICATION_FAILED', 'Repository object authentication failed. The key is incorrect or the object was modified.', { category: 'integrity' });
  }
}

function assertAdapter(adapter) {
  for (const method of ['stat', 'read', 'write', 'commit', 'abort']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new RepositoryEngineError('REPOSITORY_ADAPTER_INVALID', `The repository adapter does not implement ${method}.`, { category: 'compatibility' });
    }
  }
}

async function readBounded(adapter, context, key, maximumBytes) {
  let value;
  try {
    value = await adapter.read(context, { key });
  } catch {
    throw new RepositoryEngineError('REPOSITORY_READ_FAILED', 'The repository adapter could not read an object.', { retryable: true });
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    if (buffer.length > maximumBytes) throw new RepositoryEngineError('REPOSITORY_OBJECT_TOO_LARGE', 'A repository object exceeds its format limit.', { category: 'integrity' });
    return buffer;
  }
  if (!value || typeof value[Symbol.asyncIterator] !== 'function') {
    throw new RepositoryEngineError('REPOSITORY_READ_FAILED', 'The repository adapter returned an unsupported read result.', { category: 'compatibility' });
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const part of value) {
      if (!Buffer.isBuffer(part) && !(part instanceof Uint8Array)) throw new RepositoryEngineError('REPOSITORY_READ_FAILED', 'The repository adapter returned invalid object bytes.', { category: 'compatibility' });
      const buffer = Buffer.from(part);
      total += buffer.length;
      if (total > maximumBytes) throw new RepositoryEngineError('REPOSITORY_OBJECT_TOO_LARGE', 'A repository object exceeds its format limit.', { category: 'integrity' });
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof RepositoryEngineError) throw error;
    throw new RepositoryEngineError('REPOSITORY_READ_FAILED', 'The repository adapter could not finish reading an object.', { retryable: true });
  }
  return Buffer.concat(chunks, total);
}

async function writeObject(adapter, context, key, body, idempotencyKey) {
  const checksum = { algorithm: 'sha256', digest: digest('sha256', body) };
  let session = null;
  try {
    session = await adapter.write(context, { key, sizeBytes: body.length, checksum, body });
    const committed = await adapter.commit(context, session);
    if ((committed?.sizeBytes !== undefined && committed.sizeBytes !== body.length)
      || (committed?.checksum?.algorithm === 'sha256' && committed.checksum.digest !== checksum.digest)) {
      throw new RepositoryEngineError('REPOSITORY_COMMIT_MISMATCH', 'The repository adapter returned inconsistent commit evidence.', { category: 'integrity' });
    }
    return { key, sizeBytes: body.length, checksum, committed: committed || null };
  } catch (error) {
    if (session) {
      try { await adapter.abort(context, session); } catch { /* best effort */ }
    }
    if (error instanceof RepositoryEngineError) throw error;
    throw new RepositoryEngineError('REPOSITORY_WRITE_FAILED', 'The repository adapter could not commit an object.', { retryable: true });
  }
}

async function adapterStat(adapter, context, key) {
  try {
    return await adapter.stat(context, key);
  } catch {
    throw new RepositoryEngineError('REPOSITORY_STAT_FAILED', 'The repository adapter could not inspect an object.', { retryable: true });
  }
}

async function* contentBlocks(content) {
  if (content === null || content === undefined) return;
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    yield Buffer.from(content);
    return;
  }
  if (typeof content[Symbol.asyncIterator] !== 'function') {
    throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'File content must be binary data or an asynchronous binary stream.', { category: 'validation' });
  }
  try {
    for await (const part of content) {
      if (!Buffer.isBuffer(part) && !(part instanceof Uint8Array)) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'File content streams must emit binary data.', { category: 'validation' });
      const block = Buffer.from(part);
      if (block.length > MAX_INPUT_BLOCK_BYTES) throw new RepositoryEngineError('REPOSITORY_INPUT_LIMIT_EXCEEDED', 'A source stream block exceeds the repository input limit.', { category: 'validation' });
      yield block;
    }
  } catch (error) {
    if (error instanceof RepositoryEngineError) throw error;
    throw new RepositoryEngineError('REPOSITORY_SOURCE_READ_FAILED', 'The source stream could not be read.', { category: 'source', retryable: true });
  }
}

async function* fixedChunks(content, chunkSize) {
  let pending = Buffer.alloc(0);
  for await (const block of contentBlocks(content)) {
    pending = pending.length ? Buffer.concat([pending, block]) : block;
    while (pending.length >= chunkSize) {
      yield pending.subarray(0, chunkSize);
      pending = pending.subarray(chunkSize);
    }
  }
  if (pending.length) yield pending;
}

function normalizeFileInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Every snapshot file must be an object.', { category: 'validation' });
  const type = requiredText(input.type, 'Snapshot file type', 20);
  if (!['file', 'directory', 'symlink'].includes(type)) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Snapshot file type is unsupported.', { category: 'validation' });
  if (type !== 'file' && input.content !== undefined && input.content !== null) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Only regular files may contain repository payload bytes.', { category: 'validation' });
  return {
    path: requiredText(input.path, 'Snapshot file path', 8192),
    type,
    metadata: normalizeJson(input.metadata ?? null),
    content: input.content
  };
}

function snapshotObjectKey(snapshotId) {
  return `manifests/v${REPOSITORY_FORMAT_VERSION}/${normalizeSnapshotId(snapshotId)}.dxb`;
}

function chunkObjectKey(chunkId) {
  if (!/^[a-f0-9]{64}$/.test(chunkId)) throw new RepositoryEngineError('REPOSITORY_OBJECT_CORRUPT', 'A manifest chunk ID is invalid.', { category: 'integrity' });
  return `chunks/v${REPOSITORY_FORMAT_VERSION}/${chunkId.slice(0, 2)}/${chunkId}.dxb`;
}

function parseManifest(value, expectedSnapshotId) {
  let manifest;
  try {
    manifest = JSON.parse(value.toString('utf8'));
  } catch {
    throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest is not valid JSON.', { category: 'integrity' });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest is invalid.', { category: 'integrity' });
  if (manifest.repositoryFormatVersion !== REPOSITORY_FORMAT_VERSION || manifest.engineId !== ENGINE_ID) {
    throw new RepositoryEngineError('REPOSITORY_FORMAT_UNSUPPORTED', 'This repository format is not supported by this DeployerX version.', { category: 'compatibility' });
  }
  if (manifest.snapshotId !== expectedSnapshotId || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) {
    throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest identity or file list is invalid.', { category: 'integrity' });
  }
  const keyVersion = requiredText(manifest.keyVersion, 'Manifest key version', 128);
  safeInteger(manifest.chunkSizeBytes, 'Manifest chunk size', MIN_CHUNK_SIZE_BYTES, MAX_CHUNK_SIZE_BYTES);
  if (!/^[a-f0-9]{64}$/.test(manifest.idempotencyDigest || '')
    || (manifest.parentSnapshotId !== null && normalizeSnapshotId(manifest.parentSnapshotId) !== manifest.parentSnapshotId)
    || Number.isNaN(new Date(manifest.createdAt).getTime())) {
    throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest header is invalid.', { category: 'integrity' });
  }
  let chunkCount = 0;
  let sourceBytes = 0;
  let regularFiles = 0;
  let directories = 0;
  let symbolicLinks = 0;
  const uniqueChunks = new Set();
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || !['file', 'directory', 'symlink'].includes(file.type)) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest contains an invalid file entry.', { category: 'integrity' });
    const filePath = requiredText(file.path, 'Manifest file path', 8192);
    if (paths.has(filePath)) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest contains duplicate paths.', { category: 'integrity' });
    paths.add(filePath);
    if (!Array.isArray(file.chunks)) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest contains an invalid chunk list.', { category: 'integrity' });
    normalizeJson(file.metadata ?? null);
    if (file.type !== 'file' && (file.chunks.length !== 0 || file.sizeBytes !== 0 || file.contentDigest !== null)) {
      throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'A non-file manifest entry contains payload data.', { category: 'integrity' });
    }
    if (file.type === 'file' && (file.contentDigest?.algorithm !== 'hmac-sha256' || !/^[a-f0-9]{64}$/.test(file.contentDigest?.digest || ''))) {
      throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'A manifest file digest is invalid.', { category: 'integrity' });
    }
    if (file.type === 'file') regularFiles += 1;
    if (file.type === 'directory') directories += 1;
    if (file.type === 'symlink') symbolicLinks += 1;
    chunkCount += file.chunks.length;
    if (chunkCount > MAX_CHUNKS) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest exceeds the chunk limit.', { category: 'integrity' });
    let total = 0;
    for (const chunk of file.chunks) {
      if (chunk?.key !== chunkObjectKey(chunk.id) || chunk.keyVersion !== keyVersion) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest contains an invalid chunk reference.', { category: 'integrity' });
      total += safeInteger(chunk.sizeBytes, 'Manifest chunk size', 1, MAX_CHUNK_SIZE_BYTES);
      uniqueChunks.add(chunk.id);
    }
    if (total !== safeInteger(file.sizeBytes, 'Manifest file size')) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest file size does not match its chunks.', { category: 'integrity' });
    sourceBytes += total;
    if (!Number.isSafeInteger(sourceBytes)) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest byte total is invalid.', { category: 'integrity' });
  }
  const totals = manifest.totals;
  if (!totals || totals.files !== regularFiles || totals.directories !== directories || totals.symbolicLinks !== symbolicLinks
    || totals.chunks !== chunkCount || totals.uniqueChunks !== uniqueChunks.size || totals.sourceBytes !== sourceBytes) {
    throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest totals are inconsistent.', { category: 'integrity' });
  }
  return manifest;
}

class FileRepositoryEngine {
  constructor({ adapter, clock = () => new Date().toISOString(), randomBytes = crypto.randomBytes } = {}) {
    assertAdapter(adapter);
    this.adapter = adapter;
    this.clock = clock;
    this.randomBytes = randomBytes;
  }

  manifest() {
    return {
      engineId: ENGINE_ID,
      engineVersion: ENGINE_VERSION,
      repositoryFormatVersion: REPOSITORY_FORMAT_VERSION,
      chunking: { algorithm: 'fixed-size', defaultSizeBytes: DEFAULT_CHUNK_SIZE_BYTES, minimumSizeBytes: MIN_CHUNK_SIZE_BYTES, maximumSizeBytes: MAX_CHUNK_SIZE_BYTES },
      contentIds: { algorithm: 'hmac-sha256', repositoryScoped: true },
      encryption: { algorithm: 'aes-256-gcm', clientSide: true, authenticated: true },
      deduplication: { scope: 'repository-key-version', plaintextVisibleToAdapter: false }
    };
  }

  async ensureRepository(context, input = {}) {
    const repositoryId = requiredText(input.repositoryId, 'Repository ID', 200);
    const existing = await adapterStat(this.adapter, context, FORMAT_OBJECT_KEY);
    if (existing) {
      const bytes = await readBounded(this.adapter, context, FORMAT_OBJECT_KEY, 64 * 1024);
      let format;
      try { format = JSON.parse(bytes.toString('utf8')); } catch { throw new RepositoryEngineError('REPOSITORY_FORMAT_CORRUPT', 'The repository format marker is corrupt.', { category: 'integrity' }); }
      if (format?.magic !== 'deployerx-backup-repository' || format.repositoryFormatVersion !== REPOSITORY_FORMAT_VERSION || format.engineId !== ENGINE_ID || format.repositoryId !== repositoryId) {
        throw new RepositoryEngineError('REPOSITORY_FORMAT_UNSUPPORTED', 'The destination contains a different or unsupported repository format.', { category: 'compatibility' });
      }
      return { ...format, existing: true };
    }
    const createdAt = new Date(this.clock());
    if (Number.isNaN(createdAt.getTime())) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Repository creation time is invalid.', { category: 'validation' });
    const format = {
      magic: 'deployerx-backup-repository',
      repositoryFormatVersion: REPOSITORY_FORMAT_VERSION,
      engineId: ENGINE_ID,
      minimumEngineVersion: ENGINE_VERSION,
      repositoryId,
      createdAt: createdAt.toISOString()
    };
    await writeObject(this.adapter, context, FORMAT_OBJECT_KEY, canonicalJson(format), `repository-format:${repositoryId}`);
    return { ...format, existing: false };
  }

  async createSnapshot(context, input = {}) {
    const repositoryId = requiredText(input.repositoryId, 'Repository ID', 200);
    const keyVersion = requiredText(input.keyVersion, 'Encryption key version', 128);
    const idempotencyKey = requiredText(input.idempotencyKey, 'Snapshot idempotency key', 512);
    const keys = deriveKeys(input.masterKey, repositoryId, keyVersion);
    const idempotencyDigest = keyedDigest(keys.snapshotId, Buffer.from(idempotencyKey, 'utf8'));
    const snapshotId = `snp_${idempotencyDigest.slice(0, 40)}`;
    const manifestKey = snapshotObjectKey(snapshotId);
    const parentSnapshotId = input.parentSnapshotId ? normalizeSnapshotId(input.parentSnapshotId) : null;
    if (parentSnapshotId === snapshotId) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'A snapshot cannot be its own parent.', { category: 'validation' });
    await this.ensureRepository(context, { repositoryId });

    if (await adapterStat(this.adapter, context, manifestKey)) {
      const existing = await this.openSnapshot(context, { repositoryId, snapshotId, masterKey: input.masterKey });
      if (existing.manifest.idempotencyDigest !== idempotencyDigest || existing.manifest.keyVersion !== keyVersion || existing.manifest.parentSnapshotId !== parentSnapshotId) {
        throw new RepositoryEngineError('REPOSITORY_IDEMPOTENCY_CONFLICT', 'The snapshot idempotency key conflicts with an existing manifest.', { category: 'integrity' });
      }
      return { ...existing.summary, idempotent: true };
    }
    if (parentSnapshotId && !await adapterStat(this.adapter, context, snapshotObjectKey(parentSnapshotId))) {
      throw new RepositoryEngineError('REPOSITORY_PARENT_NOT_FOUND', 'The parent repository snapshot was not found.', { category: 'not-found' });
    }

    const chunkSizeBytes = normalizeChunkSize(input.chunkSizeBytes);
    const createdAt = new Date(this.clock());
    if (Number.isNaN(createdAt.getTime())) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Snapshot creation time is invalid.', { category: 'validation' });
    const filesInput = input.files;
    if (!filesInput || (typeof filesInput[Symbol.iterator] !== 'function' && typeof filesInput[Symbol.asyncIterator] !== 'function')) {
      throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Snapshot files must be iterable.', { category: 'validation' });
    }
    const files = [];
    const paths = new Set();
    const knownChunks = new Map();
    let chunkCount = 0;
    let sourceBytes = 0;
    let uploadedBytes = 0;
    let uploadedChunks = 0;
    let reusedBytes = 0;

    for await (const rawFile of filesInput) {
      if (files.length >= MAX_FILES) throw new RepositoryEngineError('REPOSITORY_INPUT_LIMIT_EXCEEDED', 'The snapshot exceeds the file-count limit.', { category: 'validation' });
      const file = normalizeFileInput(rawFile);
      if (paths.has(file.path)) throw new RepositoryEngineError('REPOSITORY_INPUT_INVALID', 'Snapshot file paths must be unique.', { category: 'validation' });
      paths.add(file.path);
      const entry = { path: file.path, type: file.type, sizeBytes: 0, metadata: file.metadata, contentDigest: null, chunks: [] };
      if (file.type === 'file') {
        const fileDigest = crypto.createHmac('sha256', keys.fileDigest);
        for await (const chunk of fixedChunks(file.content, chunkSizeBytes)) {
          chunkCount += 1;
          if (chunkCount > MAX_CHUNKS) throw new RepositoryEngineError('REPOSITORY_INPUT_LIMIT_EXCEEDED', 'The snapshot exceeds the chunk-count limit.', { category: 'validation' });
          const chunkId = keyedDigest(keys.contentId, chunk);
          const objectKey = chunkObjectKey(chunkId);
          let reference = knownChunks.get(chunkId);
          if (!reference) {
            const existing = await adapterStat(this.adapter, context, objectKey);
            if (existing) {
              const stored = await readBounded(this.adapter, context, objectKey, MAX_CHUNK_SIZE_BYTES + 65536);
              const opened = decryptObject(stored, 'chunk', keys.chunkEncryption, keyVersion).plaintext;
              if (opened.length !== chunk.length || keyedDigest(keys.contentId, opened) !== chunkId) {
                throw new RepositoryEngineError('REPOSITORY_OBJECT_CORRUPT', 'An existing deduplicated chunk failed verification.', { category: 'integrity' });
              }
              reusedBytes += chunk.length;
            } else {
              const encrypted = encryptObject(chunk, 'chunk', keys.chunkEncryption, keyVersion, this.randomBytes);
              await writeObject(this.adapter, context, objectKey, encrypted, `chunk:${chunkId}`);
              uploadedBytes += encrypted.length;
              uploadedChunks += 1;
            }
            reference = { id: chunkId, key: objectKey, keyVersion, sizeBytes: chunk.length };
            knownChunks.set(chunkId, reference);
          } else {
            reusedBytes += chunk.length;
          }
          entry.chunks.push(reference);
          entry.sizeBytes += chunk.length;
          sourceBytes += chunk.length;
          fileDigest.update(chunk);
        }
        entry.contentDigest = { algorithm: 'hmac-sha256', digest: fileDigest.digest('hex') };
      }
      files.push(entry);
    }
    files.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
    const manifest = {
      repositoryFormatVersion: REPOSITORY_FORMAT_VERSION,
      engineId: ENGINE_ID,
      engineVersion: ENGINE_VERSION,
      snapshotId,
      idempotencyDigest,
      parentSnapshotId,
      createdAt: createdAt.toISOString(),
      keyVersion,
      chunkSizeBytes,
      files,
      totals: {
        files: files.filter((file) => file.type === 'file').length,
        directories: files.filter((file) => file.type === 'directory').length,
        symbolicLinks: files.filter((file) => file.type === 'symlink').length,
        chunks: chunkCount,
        uniqueChunks: knownChunks.size,
        sourceBytes
      }
    };
    const manifestPlaintext = canonicalJson(manifest);
    if (manifestPlaintext.length > MAX_MANIFEST_BYTES) throw new RepositoryEngineError('REPOSITORY_INPUT_LIMIT_EXCEEDED', 'The snapshot manifest exceeds the repository format limit.', { category: 'validation' });
    const encryptedManifest = encryptObject(manifestPlaintext, 'manifest', keys.manifestEncryption, keyVersion, this.randomBytes);
    const artifact = await writeObject(this.adapter, context, manifestKey, encryptedManifest, `manifest:${snapshotId}`);
    return {
      snapshotId,
      parentSnapshotId: manifest.parentSnapshotId,
      manifestKey,
      manifestChecksum: artifact.checksum,
      keyVersion,
      sourceBytes,
      uploadedBytes: uploadedBytes + encryptedManifest.length,
      reusedBytes,
      files: manifest.totals.files,
      directories: manifest.totals.directories,
      symbolicLinks: manifest.totals.symbolicLinks,
      chunkCount,
      uniqueChunkCount: knownChunks.size,
      uploadedChunkCount: uploadedChunks,
      idempotent: false
    };
  }

  async openSnapshot(context, input = {}) {
    const repositoryId = requiredText(input.repositoryId, 'Repository ID', 200);
    const snapshotId = normalizeSnapshotId(input.snapshotId);
    const manifestKey = snapshotObjectKey(snapshotId);
    if (!await adapterStat(this.adapter, context, FORMAT_OBJECT_KEY)) {
      throw new RepositoryEngineError('REPOSITORY_FORMAT_NOT_FOUND', 'The destination is not an initialized DeployerX backup repository.', { category: 'not-found' });
    }
    await this.ensureRepository(context, { repositoryId });
    if (!await adapterStat(this.adapter, context, manifestKey)) throw new RepositoryEngineError('REPOSITORY_SNAPSHOT_NOT_FOUND', 'The requested repository snapshot was not found.', { category: 'not-found' });
    const encrypted = await readBounded(this.adapter, context, manifestKey, MAX_MANIFEST_BYTES + 65536);
    const header = parseObjectHeader(encrypted);
    if (header.kind !== OBJECT_KIND.manifest) throw new RepositoryEngineError('REPOSITORY_OBJECT_CORRUPT', 'The snapshot locator does not contain a manifest.', { category: 'integrity' });
    const keys = deriveKeys(input.masterKey, repositoryId, header.keyVersion);
    const opened = decryptObject(encrypted, 'manifest', keys.manifestEncryption, header.keyVersion);
    if (opened.plaintext.length > MAX_MANIFEST_BYTES) throw new RepositoryEngineError('REPOSITORY_OBJECT_TOO_LARGE', 'The snapshot manifest exceeds the repository format limit.', { category: 'integrity' });
    const manifest = parseManifest(opened.plaintext, snapshotId);
    if (manifest.keyVersion !== header.keyVersion) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'The snapshot manifest key version is inconsistent.', { category: 'integrity' });
    return {
      manifest,
      summary: {
        snapshotId,
        parentSnapshotId: manifest.parentSnapshotId,
        manifestKey,
        manifestChecksum: { algorithm: 'sha256', digest: digest('sha256', encrypted) },
        keyVersion: manifest.keyVersion,
        sourceBytes: manifest.totals.sourceBytes,
        files: manifest.totals.files,
        directories: manifest.totals.directories,
        symbolicLinks: manifest.totals.symbolicLinks,
        chunkCount: manifest.totals.chunks,
        uniqueChunkCount: manifest.totals.uniqueChunks
      }
    };
  }

  async *streamFile(context, input = {}) {
    const repositoryId = requiredText(input.repositoryId, 'Repository ID', 200);
    const inputManifest = input.manifest;
    if (!inputManifest || inputManifest.repositoryFormatVersion !== REPOSITORY_FORMAT_VERSION || inputManifest.engineId !== ENGINE_ID) throw new RepositoryEngineError('REPOSITORY_MANIFEST_CORRUPT', 'A valid opened snapshot manifest is required.', { category: 'integrity' });
    const manifest = parseManifest(canonicalJson(inputManifest), normalizeSnapshotId(inputManifest.snapshotId));
    const filePath = requiredText(input.path, 'Snapshot file path', 8192);
    const file = manifest.files.find((entry) => entry.path === filePath);
    if (!file || file.type !== 'file') throw new RepositoryEngineError('REPOSITORY_FILE_NOT_FOUND', 'The requested file is not present in this snapshot.', { category: 'not-found' });
    const keys = deriveKeys(input.masterKey, repositoryId, manifest.keyVersion);
    const fileDigest = crypto.createHmac('sha256', keys.fileDigest);
    let total = 0;
    for (const chunk of file.chunks) {
      const encrypted = await readBounded(this.adapter, context, chunk.key, MAX_CHUNK_SIZE_BYTES + 65536);
      const plaintext = decryptObject(encrypted, 'chunk', keys.chunkEncryption, chunk.keyVersion).plaintext;
      if (plaintext.length !== chunk.sizeBytes || keyedDigest(keys.contentId, plaintext) !== chunk.id) throw new RepositoryEngineError('REPOSITORY_OBJECT_CORRUPT', 'A snapshot chunk failed content verification.', { category: 'integrity' });
      total += plaintext.length;
      fileDigest.update(plaintext);
      yield plaintext;
    }
    if (total !== file.sizeBytes || fileDigest.digest('hex') !== file.contentDigest?.digest) throw new RepositoryEngineError('REPOSITORY_FILE_CORRUPT', 'The restored file failed end-to-end verification.', { category: 'integrity' });
  }

  async readFile(context, input = {}) {
    const file = input.manifest?.files?.find((entry) => entry.path === input.path);
    if (file?.sizeBytes > MAX_MATERIALIZED_FILE_BYTES) throw new RepositoryEngineError('REPOSITORY_FILE_TOO_LARGE', 'Use streaming restore for files larger than the materialization limit.', { category: 'validation' });
    const chunks = [];
    let total = 0;
    for await (const chunk of this.streamFile(context, input)) {
      total += chunk.length;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
}

module.exports = {
  DEFAULT_CHUNK_SIZE_BYTES,
  ENGINE_ID,
  ENGINE_VERSION,
  FileRepositoryEngine,
  FORMAT_OBJECT_KEY,
  MAX_CHUNK_SIZE_BYTES,
  MAX_FILES,
  MAX_MANIFEST_BYTES,
  MIN_CHUNK_SIZE_BYTES,
  REPOSITORY_FORMAT_VERSION,
  RepositoryEngineError,
  chunkObjectKey,
  snapshotObjectKey
};
