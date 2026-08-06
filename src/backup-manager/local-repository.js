const crypto = require('crypto');
const fs = require('fs/promises');
const fsConstants = require('fs').constants;
const path = require('path');
const {
  ENGINE_ID,
  ENGINE_VERSION,
  FileRepositoryEngine
} = require('./repository-engine');
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

const ADAPTER_ID = 'deployerx.repository.local';
const ADAPTER_VERSION = '1.0.0';
const STORE_DIRECTORY = '.deployerx-repository';
const MAX_OBJECT_KEY_LENGTH = 1024;
const MAX_OBJECT_SIZE_BYTES = 128 * 1024 * 1024 * 1024;
const MAX_LIST_PAGE_SIZE = 200;
const MAX_LIST_OBJECTS = 100000;

class LocalRepositoryError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'LocalRepositoryError';
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

function normalizeLocalRepositoryConfig(input = {}, pathModule = path) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Local repository configuration must be an object.');
  const rootPath = pathModule.normalize(requiredText(input.rootPath, 'Local repository folder', 4096));
  if (!pathModule.isAbsolute(rootPath)) throw new TypeError('Local repository folder must be absolute.');
  return { rootPath };
}

function normalizeObjectKey(value) {
  const key = requiredText(value, 'Repository object key', MAX_OBJECT_KEY_LENGTH);
  if (key.startsWith('/') || key.endsWith('/') || key.includes('\\') || key.includes('//')) throw new LocalRepositoryError('LOCAL_REPOSITORY_KEY_INVALID', 'Repository object key is invalid.', { category: 'validation' });
  const segments = key.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new LocalRepositoryError('LOCAL_REPOSITORY_KEY_INVALID', 'Repository object key is invalid.', { category: 'validation' });
  }
  return segments.join('/');
}

function normalizePrefix(value) {
  const prefix = String(value ?? '').trim();
  if (!prefix) return '';
  const withoutTrailingSlash = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  normalizeObjectKey(withoutTrailingSlash);
  return prefix.endsWith('/') ? `${withoutTrailingSlash}/` : withoutTrailingSlash;
}

function encodeCursor(prefix, offset) {
  const signature = crypto.createHash('sha256').update(`local-repository-list-v1\0${prefix}\0${offset}`).digest('hex').slice(0, 16);
  return Buffer.from(JSON.stringify({ version: 1, prefix, offset, signature }), 'utf8').toString('base64url');
}

function decodeCursor(value, prefix) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(requiredText(value, 'Repository list cursor', 2048), 'base64url').toString('utf8'));
    const expected = encodeCursor(prefix, parsed.offset);
    if (parsed.version !== 1 || parsed.prefix !== prefix || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || expected !== value) throw new Error('invalid');
    return parsed.offset;
  } catch {
    throw new LocalRepositoryError('LOCAL_REPOSITORY_CURSOR_INVALID', 'Repository list cursor is invalid.', { category: 'validation' });
  }
}

async function optionalLstat(fileSystem, targetPath) {
  try {
    return await fileSystem.lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function hashFile(fileSystem, targetPath) {
  const handle = await fileSystem.open(targetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  const checksum = crypto.createHash('sha256');
  let sizeBytes = 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_INVALID', 'Repository object is not a regular file.', { category: 'integrity' });
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      sizeBytes += bytesRead;
      checksum.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { sizeBytes, checksum: { algorithm: 'sha256', digest: checksum.digest('hex') } };
}

function contentParts(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return (async function* bufferBody() { yield Buffer.from(body); })();
  if (body && typeof body[Symbol.asyncIterator] === 'function') return body;
  throw new LocalRepositoryError('LOCAL_REPOSITORY_WRITE_INVALID', 'Repository object body must be binary data or a binary stream.', { category: 'validation' });
}

class LocalFolderRepositoryAdapter {
  constructor({ rootPath, fileSystem = fs, pathModule = path, clock = () => new Date().toISOString() } = {}) {
    const config = normalizeLocalRepositoryConfig({ rootPath }, pathModule);
    this.rootPath = config.rootPath;
    this.pathModule = pathModule;
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.storePath = pathModule.join(this.rootPath, STORE_DIRECTORY);
    this.objectsPath = pathModule.join(this.storePath, 'objects');
    this.stagingPath = pathModule.join(this.storePath, 'staging');
    this.locksPath = pathModule.join(this.storePath, 'locks');
    this.activeSessions = new Map();
    this.initializePromise = null;
  }

  manifest() {
    return {
      apiVersion: 1,
      id: ADAPTER_ID,
      version: ADAPTER_VERSION,
      kind: 'repository',
      displayName: 'Local folder',
      capabilities: this.capabilities()
    };
  }

  capabilities() {
    return {
      operations: { list: true, stat: true, read: true, rangeRead: false, write: true, resumeWrite: false, multipartWrite: false, atomicCommit: true, copy: true, delete: true },
      locking: 'native',
      consistency: 'strong',
      checksums: ['sha256'],
      versioning: false,
      objectImmutability: false,
      legalHold: false,
      storageClasses: false,
      serverSideEncryption: false,
      clientSideEncryptionCompatible: true,
      capacityReporting: 'exact',
      maximumObjectSizeBytes: MAX_OBJECT_SIZE_BYTES,
      minimumPartSizeBytes: null,
      caseSensitiveKeys: process.platform !== 'win32'
    };
  }

  normalizeConfig(input) {
    return normalizeLocalRepositoryConfig(input, this.pathModule);
  }

  validateConfig(input) {
    try {
      this.normalizeConfig(input);
      return [];
    } catch (error) {
      return [{ path: 'rootPath', code: 'LOCAL_REPOSITORY_PATH_INVALID', safeMessage: error.message }];
    }
  }

  async initialize() {
    if (!this.initializePromise) {
      this.initializePromise = this.#initialize().catch((error) => {
        this.initializePromise = null;
        if (error instanceof LocalRepositoryError) throw error;
        throw new LocalRepositoryError('LOCAL_REPOSITORY_INITIALIZE_FAILED', 'DeployerX could not initialize the local repository folder.', { retryable: true });
      });
    }
    return this.initializePromise;
  }

  async #initialize() {
    await this.fileSystem.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const rootStat = await this.fileSystem.lstat(this.rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new LocalRepositoryError('LOCAL_REPOSITORY_PATH_UNSAFE', 'Local repository folder must be a real directory.', { category: 'validation' });
    for (const directory of [this.storePath, this.objectsPath, this.stagingPath, this.locksPath]) {
      await this.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await this.fileSystem.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalRepositoryError('LOCAL_REPOSITORY_PATH_UNSAFE', 'Local repository internal paths must be real directories.', { category: 'integrity' });
    }
    return { rootPath: this.rootPath, storePath: this.storePath };
  }

  #targetPath(key) {
    const normalized = normalizeObjectKey(key);
    const target = this.pathModule.resolve(this.objectsPath, ...normalized.split('/'));
    const boundary = `${this.pathModule.resolve(this.objectsPath)}${this.pathModule.sep}`;
    if (!target.startsWith(boundary)) throw new LocalRepositoryError('LOCAL_REPOSITORY_KEY_INVALID', 'Repository object key escapes the object store.', { category: 'validation' });
    return { key: normalized, target };
  }

  async #ensureParent(key) {
    const segments = key.split('/').slice(0, -1);
    let current = this.objectsPath;
    for (const segment of segments) {
      current = this.pathModule.join(current, segment);
      await this.fileSystem.mkdir(current, { mode: 0o700 }).catch((error) => {
        if (error?.code !== 'EEXIST') throw error;
      });
      const stat = await this.fileSystem.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalRepositoryError('LOCAL_REPOSITORY_PATH_UNSAFE', 'Repository object parent path is unsafe.', { category: 'integrity' });
    }
  }

  async stat(_context, key) {
    await this.initialize();
    const resolved = this.#targetPath(key);
    let stat;
    try { stat = await optionalLstat(this.fileSystem, resolved.target); } catch { throw new LocalRepositoryError('LOCAL_REPOSITORY_STAT_FAILED', 'DeployerX could not inspect a local repository object.', { retryable: true }); }
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_INVALID', 'Local repository object is not a regular file.', { category: 'integrity' });
    return { key: resolved.key, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  }

  async read(_context, request = {}) {
    await this.initialize();
    const resolved = this.#targetPath(request.key);
    const fileSystem = this.fileSystem;
    return (async function* readObject() {
      let handle;
      try {
        handle = await fileSystem.open(resolved.target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile()) throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_INVALID', 'Local repository object is not a regular file.', { category: 'integrity' });
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          yield Buffer.from(buffer.subarray(0, bytesRead));
        }
      } catch (error) {
        if (error instanceof LocalRepositoryError) throw error;
        if (error?.code === 'ENOENT') throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_NOT_FOUND', 'Local repository object was not found.', { category: 'not-found' });
        throw new LocalRepositoryError('LOCAL_REPOSITORY_READ_FAILED', 'DeployerX could not read a local repository object.', { retryable: true });
      } finally {
        await handle?.close().catch(() => {});
      }
    })();
  }

  async write(_context, request = {}) {
    await this.initialize();
    const resolved = this.#targetPath(request.key);
    await this.#ensureParent(resolved.key);
    const declaredSize = Number(request.sizeBytes);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_OBJECT_SIZE_BYTES) throw new LocalRepositoryError('LOCAL_REPOSITORY_WRITE_INVALID', 'Repository object size is invalid.', { category: 'validation' });
    if (request.checksum?.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(request.checksum?.digest || '')) throw new LocalRepositoryError('LOCAL_REPOSITORY_WRITE_INVALID', 'Repository object checksum is invalid.', { category: 'validation' });
    const token = crypto.randomUUID();
    const temporaryPath = this.pathModule.join(this.stagingPath, `.${token}.tmp`);
    let handle;
    try {
      handle = await this.fileSystem.open(temporaryPath, 'wx', 0o600);
      const checksum = crypto.createHash('sha256');
      let sizeBytes = 0;
      for await (const rawPart of contentParts(request.body)) {
        if (!Buffer.isBuffer(rawPart) && !(rawPart instanceof Uint8Array)) throw new LocalRepositoryError('LOCAL_REPOSITORY_WRITE_INVALID', 'Repository object stream emitted invalid data.', { category: 'validation' });
        const part = Buffer.from(rawPart);
        sizeBytes += part.length;
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes > declaredSize || sizeBytes > MAX_OBJECT_SIZE_BYTES) throw new LocalRepositoryError('LOCAL_REPOSITORY_WRITE_INVALID', 'Repository object stream exceeded its declared size.', { category: 'validation' });
        await handle.write(part, 0, part.length, null);
        checksum.update(part);
      }
      const actualChecksum = checksum.digest('hex');
      if (sizeBytes !== declaredSize || actualChecksum !== request.checksum.digest) throw new LocalRepositoryError('LOCAL_REPOSITORY_WRITE_MISMATCH', 'Repository object bytes do not match their declared size or checksum.', { category: 'integrity' });
      await handle.sync();
      await handle.close();
      handle = null;
      const session = { token, key: resolved.key, targetPath: resolved.target, temporaryPath, sizeBytes, checksum: { algorithm: 'sha256', digest: actualChecksum }, idempotencyKey: request.idempotencyKey || null };
      this.activeSessions.set(token, session);
      return { ...session };
    } catch (error) {
      await handle?.close().catch(() => {});
      await this.fileSystem.unlink(temporaryPath).catch(() => {});
      if (error instanceof LocalRepositoryError) throw error;
      throw new LocalRepositoryError('LOCAL_REPOSITORY_WRITE_FAILED', 'DeployerX could not stage a local repository object.', { retryable: true });
    }
  }

  async commit(_context, input = {}) {
    await this.initialize();
    const session = this.activeSessions.get(input.token);
    if (!session || session.key !== input.key || session.temporaryPath !== input.temporaryPath) throw new LocalRepositoryError('LOCAL_REPOSITORY_SESSION_INVALID', 'Local repository write session is invalid.', { category: 'validation' });
    try {
      const existing = await optionalLstat(this.fileSystem, session.targetPath);
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()) throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_INVALID', 'Local repository target is not a regular file.', { category: 'integrity' });
        const evidence = await hashFile(this.fileSystem, session.targetPath);
        if (evidence.sizeBytes !== session.sizeBytes || evidence.checksum.digest !== session.checksum.digest) throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_CONFLICT', 'An immutable repository object already exists with different content.', { category: 'integrity' });
        await this.fileSystem.unlink(session.temporaryPath);
        this.activeSessions.delete(session.token);
        return { key: session.key, ...evidence, existing: true };
      }
      try {
        await this.fileSystem.link(session.temporaryPath, session.targetPath);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
        const evidence = await hashFile(this.fileSystem, session.targetPath);
        if (evidence.sizeBytes !== session.sizeBytes || evidence.checksum.digest !== session.checksum.digest) throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_CONFLICT', 'An immutable repository object was committed concurrently with different content.', { category: 'integrity' });
      }
      await this.fileSystem.unlink(session.temporaryPath);
      this.activeSessions.delete(session.token);
      return { key: session.key, sizeBytes: session.sizeBytes, checksum: session.checksum, existing: false };
    } catch (error) {
      if (error instanceof LocalRepositoryError) throw error;
      throw new LocalRepositoryError('LOCAL_REPOSITORY_COMMIT_FAILED', 'DeployerX could not atomically commit a local repository object.', { retryable: true });
    }
  }

  async abort(_context, input = {}) {
    const session = this.activeSessions.get(input.token);
    if (!session) return { aborted: false };
    this.activeSessions.delete(session.token);
    await this.fileSystem.unlink(session.temporaryPath).catch(() => {});
    return { aborted: true };
  }

  async copy(context, request = {}) {
    await this.initialize();
    const sourceKey = normalizeObjectKey(request.sourceKey);
    const targetKey = normalizeObjectKey(request.targetKey);
    let evidence;
    try {
      evidence = await hashFile(this.fileSystem, this.#targetPath(sourceKey).target);
    } catch (error) {
      if (error instanceof LocalRepositoryError) throw error;
      if (error?.code === 'ENOENT') throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_NOT_FOUND', 'Local repository source object was not found.', { category: 'not-found' });
      if (error?.code === 'ELOOP') throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_INVALID', 'Local repository source object is not a regular file.', { category: 'integrity' });
      if (['EACCES', 'EPERM'].includes(error?.code)) throw new LocalRepositoryError('LOCAL_REPOSITORY_ACCESS_FAILED', 'DeployerX could not access the local repository source object.', { category: 'authorization', retryable: true });
      throw new LocalRepositoryError('LOCAL_REPOSITORY_COPY_SOURCE_FAILED', 'DeployerX could not inspect the local repository source object.', { retryable: true });
    }
    const body = await this.read(context, { key: sourceKey });
    const session = await this.write(context, { key: targetKey, sizeBytes: evidence.sizeBytes, checksum: evidence.checksum, body, idempotencyKey: request.idempotencyKey });
    return this.commit(context, session);
  }

  async delete(_context, request = {}) {
    await this.initialize();
    const resolved = this.#targetPath(request.key);
    const existing = await optionalLstat(this.fileSystem, resolved.target).catch(() => {
      throw new LocalRepositoryError('LOCAL_REPOSITORY_DELETE_FAILED', 'DeployerX could not inspect a local repository object for deletion.', { retryable: true });
    });
    if (!existing) return { key: resolved.key, deleted: false, absent: true };
    if (!existing.isFile() || existing.isSymbolicLink()) throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_INVALID', 'Local repository object is not a regular file.', { category: 'integrity' });
    try { await this.fileSystem.unlink(resolved.target); } catch { throw new LocalRepositoryError('LOCAL_REPOSITORY_DELETE_FAILED', 'DeployerX could not delete a local repository object.', { retryable: true }); }
    let parent = this.pathModule.dirname(resolved.target);
    while (parent !== this.objectsPath && parent.startsWith(`${this.objectsPath}${this.pathModule.sep}`)) {
      try { await this.fileSystem.rmdir(parent); } catch { break; }
      parent = this.pathModule.dirname(parent);
    }
    return { key: resolved.key, deleted: true, absent: false };
  }

  async *list(_context, request = {}) {
    await this.initialize();
    const prefix = normalizePrefix(request.prefix);
    const pageSize = request.pageSize === undefined ? 100 : Number(request.pageSize);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_LIST_PAGE_SIZE) throw new LocalRepositoryError('LOCAL_REPOSITORY_LIST_INVALID', 'Repository list page size is invalid.', { category: 'validation' });
    const offset = decodeCursor(request.cursor, prefix);
    const keys = [];
    let scannedObjects = 0;
    const walk = async (directory, relative = '') => {
      const entries = await this.fileSystem.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_INVALID', 'Local repository contains an unsafe symbolic link.', { category: 'integrity' });
        const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const nextPath = this.pathModule.join(directory, entry.name);
        if (entry.isDirectory()) await walk(nextPath, nextRelative);
        else if (entry.isFile()) {
          scannedObjects += 1;
          if (scannedObjects > MAX_LIST_OBJECTS) throw new LocalRepositoryError('LOCAL_REPOSITORY_LIST_LIMIT_EXCEEDED', 'Local repository listing exceeds the bounded object limit.', { category: 'capacity' });
          normalizeObjectKey(nextRelative);
          if (nextRelative.startsWith(prefix)) keys.push(nextRelative);
        } else throw new LocalRepositoryError('LOCAL_REPOSITORY_OBJECT_INVALID', 'Local repository contains an unsupported object type.', { category: 'integrity' });
      }
    };
    await walk(this.objectsPath);
    keys.sort((left, right) => left.localeCompare(right, 'en-US'));
    if (offset > keys.length) throw new LocalRepositoryError('LOCAL_REPOSITORY_CURSOR_INVALID', 'Repository list cursor is outside the current listing.', { category: 'validation' });
    const pageKeys = keys.slice(offset, offset + pageSize);
    const items = [];
    for (const key of pageKeys) items.push(await this.stat({}, key));
    const nextOffset = offset + items.length;
    yield { items, nextCursor: nextOffset < keys.length ? encodeCursor(prefix, nextOffset) : null, hasMore: nextOffset < keys.length };
  }

  async getCapacity() {
    await this.initialize();
    if (typeof this.fileSystem.statfs !== 'function') return { reporting: 'unavailable', measuredAt: this.clock() };
    try {
      const stat = await this.fileSystem.statfs(this.storePath);
      const totalBytes = Number(stat.blocks) * Number(stat.bsize);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      return { reporting: 'exact', totalBytes, freeBytes, usedBytes: totalBytes - freeBytes, measuredAt: this.clock() };
    } catch {
      return { reporting: 'unavailable', measuredAt: this.clock() };
    }
  }

  async testConnection() {
    const startedAt = Date.now();
    let probePath = null;
    let handle = null;
    try {
      await this.initialize();
      probePath = this.pathModule.join(this.stagingPath, `.probe-${crypto.randomUUID()}`);
      handle = await this.fileSystem.open(probePath, 'wx', 0o600);
      await handle.writeFile(Buffer.from('deployerx-local-repository-probe'));
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fileSystem.unlink(probePath);
      probePath = null;
      return { status: 'success', testedAt: this.clock(), latencyMs: Date.now() - startedAt, checks: [{ id: 'local-folder-write', status: 'pass', safeMessage: 'DeployerX can write and remove staging files in this folder.' }] };
    } catch {
      return { status: 'failure', testedAt: this.clock(), latencyMs: Date.now() - startedAt, checks: [], error: { code: 'LOCAL_REPOSITORY_ACCESS_FAILED', category: 'authorization', retryable: true, safeMessage: 'DeployerX could not write to the selected local repository folder.' } };
    } finally {
      await handle?.close().catch(() => {});
      if (probePath) await this.fileSystem.unlink(probePath).catch(() => {});
    }
  }

  #lockPaths(scope) {
    const scopeId = lockScopeId(scope);
    const directory = this.pathModule.join(this.locksPath, scopeId);
    return { scopeId, directory, leasePath: this.pathModule.join(directory, 'lease.dxl'), binding: `${ADAPTER_ID}:${scopeId}` };
  }

  async #readLock(paths, masterKey, allowMissing = false) {
    try {
      const stat = await this.fileSystem.lstat(paths.leasePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 + 64) throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'Local repository lease record is invalid.', { category: 'integrity', retryable: false });
      return decodeLockRecord(await this.fileSystem.readFile(paths.leasePath), masterKey, paths.binding);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return null;
      if (error instanceof RepositoryLockError) throw error;
      throw new RepositoryLockError('REPOSITORY_LOCK_READ_FAILED', 'DeployerX could not read the local repository lease.', { category: 'availability' });
    }
  }

  async acquireLock(context = {}, request = {}) {
    await this.initialize();
    const lease = normalizeLockRequest(request, this.clock);
    const paths = this.#lockPaths(lease.scope);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.fileSystem.mkdir(paths.directory, { mode: 0o700 });
        try {
          await this.fileSystem.writeFile(paths.leasePath, encodeLockRecord(lease, context.masterKey, paths.binding), { flag: 'wx', mode: 0o600 });
        } catch (error) {
          await this.fileSystem.rm(paths.directory, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        return publicLease(lease);
      } catch (error) {
        if (error instanceof RepositoryLockError) throw error;
        if (error?.code !== 'EEXIST') throw new RepositoryLockError('REPOSITORY_LOCK_ACQUIRE_FAILED', 'DeployerX could not acquire the local repository lease.', { category: 'availability' });
      }
      const existing = await this.#readLock(paths, context.masterKey, true);
      if (!existing) throw new RepositoryLockError('REPOSITORY_LOCK_CONTENDED', 'The repository lease is being initialized by another operation.');
      if (!isExpired(existing, this.clock)) throw new RepositoryLockError('REPOSITORY_LOCK_CONTENDED', 'The repository is already locked by another operation.');
      const stalePath = `${paths.directory}.stale-${crypto.randomUUID()}`;
      try {
        await this.fileSystem.rename(paths.directory, stalePath);
        await this.fileSystem.rm(stalePath, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new RepositoryLockError('REPOSITORY_LOCK_TAKEOVER_FAILED', 'DeployerX could not replace the expired local repository lease.', { category: 'availability' });
      }
    }
    throw new RepositoryLockError('REPOSITORY_LOCK_CONTENDED', 'The repository lease changed while DeployerX tried to acquire it.');
  }

  async renewLock(context = {}, input = {}) {
    await this.initialize();
    const lease = validateLease(input);
    const paths = this.#lockPaths(lease.scope);
    const existing = await this.#readLock(paths, context.masterKey, true);
    if (!existing || !sameLease(existing, lease)) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The local repository lease is no longer owned by this operation.');
    const renewed = renewLease(existing, this.clock);
    let handle;
    try {
      handle = await this.fileSystem.open(paths.leasePath, 'r+');
      await handle.truncate(0);
      await handle.writeFile(encodeLockRecord(renewed, context.masterKey, paths.binding));
      await handle.sync();
    } catch (error) {
      if (error instanceof RepositoryLockError) throw error;
      throw new RepositoryLockError('REPOSITORY_LOCK_RENEW_FAILED', 'DeployerX could not renew the local repository lease.', { category: 'availability' });
    } finally {
      await handle?.close().catch(() => {});
    }
    const persisted = await this.#readLock(paths, context.masterKey, true);
    if (!persisted || !sameLease(persisted, renewed) || persisted.heartbeatAt !== renewed.heartbeatAt) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The local repository lease changed while it was renewed.');
    return publicLease(renewed);
  }

  async releaseLock(context = {}, input = {}) {
    await this.initialize();
    const lease = validateLease(input);
    const paths = this.#lockPaths(lease.scope);
    const existing = await this.#readLock(paths, context.masterKey, true);
    if (!existing) return { released: false, absent: true };
    if (!sameLease(existing, lease)) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The local repository lease is owned by another operation.');
    const releasedPath = `${paths.directory}.released-${crypto.randomUUID()}`;
    try {
      await this.fileSystem.rename(paths.directory, releasedPath);
      await this.fileSystem.rm(releasedPath, { recursive: true, force: true });
      return { released: true, absent: false };
    } catch (error) {
      if (error?.code === 'ENOENT') return { released: false, absent: true };
      throw new RepositoryLockError('REPOSITORY_LOCK_RELEASE_FAILED', 'DeployerX could not release the local repository lease.', { category: 'availability' });
    }
  }

  async probeCapabilities() {
    const connectionTest = await this.testConnection();
    return { status: connectionTest.status === 'success' ? 'available' : 'unavailable', probedAt: this.clock(), capabilities: this.capabilities(), connectionTest, reductions: [] };
  }

  async validateImmutability() {
    return { supported: false, enforced: false, mode: 'none', checkedAt: this.clock() };
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class LocalRepositoryService {
  constructor({ controlDatabase, secretStore, deviceId, adapterFactory = (config) => new LocalFolderRepositoryAdapter(config), clock = () => new Date().toISOString() } = {}) {
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
      .map((repository) => ({ ...repository, capabilities: this.adapterFactory({ rootPath: repository.location.path }).capabilities(), currentDevice: (repository.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'Repository name', 200);
    const config = normalizeLocalRepositoryConfig({ rootPath: input.rootPath });
    const duplicatePath = (await this.list(tenant)).some((repository) => this.#pathKey(repository.location.path) === this.#pathKey(config.rootPath));
    if (duplicatePath) throw new TypeError('This local folder is already configured as a repository in this workspace.');
    const adapter = this.adapterFactory(config);
    await adapter.initialize();
    const keyValue = crypto.randomBytes(32).toString('base64');
    const keyRef = await this.secretStore.create({
      workspaceId: tenant,
      actorId: actor,
      name: `${name} repository encryption key ${crypto.randomUUID().slice(0, 8)}`,
      secretType: 'encryption-key',
      value: keyValue,
      scope: 'device'
    });
    let repository;
    try {
      repository = await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(keyRef, actor));
        return transaction.create('repository', {
          workspaceId: tenant,
          actorId: actor,
          name,
          connectionId: null,
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          engineId: ENGINE_ID,
          engineVersion: ENGINE_VERSION,
          location: { path: config.rootPath, storeDirectory: STORE_DIRECTORY },
          secretRefIds: [],
          encryptionKeyRefId: keyRef.id,
          encryption: { algorithm: 'aes-256-gcm', keyVersion: `secret:${keyRef.version}` },
          scope: 'device',
          workerAffinity: [`device:${this.deviceId}`],
          immutability: { mode: 'none', enforced: false },
          storagePolicy: normalizeStoragePolicy(input.storagePolicy || {}),
          capacity: null,
          health: { status: 'initializing', checkedAt: null, repositoryFormatVersion: null, safeErrorCode: null }
        });
      });
    } catch (error) {
      await this.secretStore.delete({ workspaceId: tenant, id: keyRef.id }).catch(() => {});
      throw error;
    }
    const engine = new FileRepositoryEngine({ adapter, clock: this.clock });
    try {
      await engine.ensureRepository({}, { repositoryId: repository.id });
    } catch (error) {
      return this.controlDatabase.repository('repository').update(tenant, repository.id, {
        health: { status: 'needs-attention', checkedAt: this.clock(), repositoryFormatVersion: null, safeErrorCode: error.code || 'LOCAL_REPOSITORY_INITIALIZE_FAILED' }
      }, { expectedRevision: repository.revision, actorId: actor });
    }
    return (await this.test(tenant, actor, repository.id)).repository;
  }

  async open(workspaceId, repositoryId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(repositoryId, 'Repository ID', 200);
    const repository = await this.controlDatabase.repository('repository').get(tenant, id);
    if (!repository || repository.adapterId !== ADAPTER_ID) throw new Error('Local repository was not found.');
    if (!(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This local repository belongs to another device.');
    const encodedKey = await this.secretStore.resolve({ workspaceId: tenant, id: repository.encryptionKeyRefId });
    const masterKey = Buffer.from(encodedKey, 'base64');
    if (masterKey.length !== 32 || masterKey.toString('base64') !== encodedKey) throw new LocalRepositoryError('LOCAL_REPOSITORY_KEY_INVALID', 'Local repository encryption key is invalid.', { category: 'encryption' });
    const adapter = this.adapterFactory({ rootPath: repository.location.path });
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
    const id = requiredText(repositoryId, 'Repository ID', 200);
    const repository = await this.controlDatabase.repository('repository').get(tenant, id);
    if (!repository || repository.adapterId !== ADAPTER_ID) throw new Error('Local repository was not found.');
    const expectedRevision = Number(revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('Repository revision is required for removal.');
    const removed = await this.controlDatabase.repository('repository').softDelete(tenant, id, { expectedRevision, actorId: actor });
    return { repository: removed, dataRetainedAt: repository.location.path, encryptionKeyRetained: true };
  }

  #pathKey(value) {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  LocalFolderRepositoryAdapter,
  LocalRepositoryError,
  LocalRepositoryService,
  MAX_LIST_PAGE_SIZE,
  MAX_OBJECT_KEY_LENGTH,
  STORE_DIRECTORY,
  normalizeLocalRepositoryConfig,
  normalizeObjectKey
};
