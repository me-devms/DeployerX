const crypto = require('crypto');
const path = require('path');
const { Client } = require('ssh2');
const {
  ENGINE_ID,
  ENGINE_VERSION,
  FileRepositoryEngine
} = require('./repository-engine');
const {
  ADAPTER_ID: SSH_CONNECTION_ADAPTER_ID,
  LinuxSshConnectionAdapter,
  fingerprintHostKey
} = require('./ssh-connection');
const {
  MAX_LIST_PAGE_SIZE,
  MAX_OBJECT_KEY_LENGTH,
  normalizeObjectKey
} = require('./local-repository');
const {
  RepositoryLockError,
  MAX_LOCK_TTL_MS,
  MIN_LOCK_TTL_MS,
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

const ADAPTER_ID = 'deployerx.repository.sftp';
const ADAPTER_VERSION = '1.0.0';
const STORE_DIRECTORY = '.deployerx-repository';
const MAX_OBJECT_SIZE_BYTES = 128 * 1024 * 1024 * 1024;
const MAX_LIST_OBJECTS = 100000;
const MAX_LIST_DIRECTORIES = 100000;
const SFTP_OPERATION_TIMEOUT_MS = 30000;
const MAX_STAGING_RECONCILIATION_ENTRIES = 10000;
const MAX_STAGING_RECONCILIATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_RECOVERY_GRACE_MS = MAX_LOCK_TTL_MS;
const LOCK_RECORD_MIN_BYTES = 4 + 12 + 16 + 1;
const GENERATED_STAGING_TEMP_NAME = /^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const GENERATED_LOCK_UPDATE_NAME = /^lease\.dxl\.update-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class SftpRepositoryError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'SftpRepositoryError';
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

function normalizeSftpRepositoryConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('SFTP repository configuration must be an object.');
  const inputPath = requiredText(input.rootPath, 'SFTP repository folder', 4096);
  if (!inputPath.startsWith('/')) throw new TypeError('SFTP repository folder must be an absolute Linux path.');
  return { rootPath: path.posix.normalize(inputPath) };
}

function normalizePrefix(value) {
  const prefix = String(value ?? '').trim();
  if (!prefix) return '';
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  normalizeObjectKey(normalized);
  return prefix.endsWith('/') ? `${normalized}/` : normalized;
}

function encodeCursor(prefix, offset) {
  const signature = crypto.createHash('sha256').update(`sftp-repository-list-v1\0${prefix}\0${offset}`).digest('hex').slice(0, 16);
  return Buffer.from(JSON.stringify({ version: 1, prefix, offset, signature }), 'utf8').toString('base64url');
}

function decodeCursor(value, prefix) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(requiredText(value, 'Repository list cursor', 2048), 'base64url').toString('utf8'));
    if (parsed.version !== 1 || parsed.prefix !== prefix || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || encodeCursor(prefix, parsed.offset) !== value) throw new Error('invalid');
    return parsed.offset;
  } catch {
    throw new SftpRepositoryError('SFTP_REPOSITORY_CURSOR_INVALID', 'Repository list cursor is invalid.', { category: 'validation' });
  }
}

function isMissingError(error) {
  return error?.code === 2 || error?.code === 'ENOENT';
}

function isExistsError(error) {
  const code = Number(error?.code);
  const message = String(error?.message || '');
  // OpenSSH's SFTP server reports an existing mkdir/rename target as the
  // generic SSH_FX_FAILURE (4), while in-memory and some commercial servers
  // use SSH_FX_FILE_ALREADY_EXISTS (11).
  return code === 11 || (code === 4 && /failure|already exists|file exists|exists/i.test(message)) || /already exists|file exists/i.test(message);
}

// OpenSSH may return SSH_FX_FAILURE (4) with an empty message when a rename
// targets an existing directory. Treat that code as an existing target only
// in the lock publication probe, where the canonical path is checked again;
// generic operation failures must remain fail-closed.
function isLockTargetExistsError(error) {
  return isExistsError(error) || Number(error?.code) === 4;
}

function isAccessError(error) {
  return error?.code === 3 || error?.code === 'EACCES' || error?.code === 'EPERM';
}

function isDirectory(attributes = {}) {
  return (Number(attributes.mode) & 0o170000) === 0o040000;
}

function isRegularFile(attributes = {}) {
  return (Number(attributes.mode) & 0o170000) === 0o100000;
}

function attributeTimeMilliseconds(attributes = {}) {
  const seconds = Number(attributes.mtime);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function ageMilliseconds(nowMilliseconds, attributes) {
  const modifiedMilliseconds = attributeTimeMilliseconds(attributes);
  if (modifiedMilliseconds === null || modifiedMilliseconds > nowMilliseconds) return null;
  return nowMilliseconds - modifiedMilliseconds;
}

function sanitizedReconciliationError(error, fallbackCode = 'SFTP_REPOSITORY_RECONCILIATION_FAILED') {
  const trusted = error instanceof SftpRepositoryError || error instanceof RepositoryLockError;
  return {
    code: String(trusted ? (error.code || fallbackCode) : fallbackCode).slice(0, 128),
    category: String(trusted ? (error.category || 'repository') : 'repository').slice(0, 80),
    retryable: trusted ? Boolean(error.retryable) : true,
    safeMessage: trusted ? String(error.message || 'SFTP repository reconciliation failed.').slice(0, 300) : 'SFTP repository reconciliation failed.'
  };
}

function normalizedObjectSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_SIZE_BYTES) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository object size is invalid.', { category: 'integrity' });
  return size;
}

function sftpCall(target, method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      target[method](...args, (error, result) => error ? reject(error) : resolve(result));
    } catch (error) {
      reject(error);
    }
  });
}

function classifySessionError(error, flags = {}) {
  if (flags.hostKeyMismatch) return new SftpRepositoryError('SSH_HOST_KEY_MISMATCH', 'The server host key does not match the approved fingerprint.', { category: 'integrity' });
  if (flags.canceled || error?.code === 'ABORT_ERR') return new SftpRepositoryError('SFTP_REPOSITORY_CANCELED', 'SFTP repository operation was canceled.', { category: 'canceled' });
  if (error?.code === 'ETIMEDOUT' || error?.level === 'client-timeout') return new SftpRepositoryError('SFTP_REPOSITORY_TIMEOUT', 'The SFTP repository did not respond before the SSH timeout.', { category: 'timeout', retryable: true });
  if (error?.level === 'client-authentication') return new SftpRepositoryError('SSH_AUTHENTICATION_FAILED', 'SSH authentication failed for the SFTP repository.', { category: 'authentication' });
  return new SftpRepositoryError('SFTP_REPOSITORY_CONNECT_FAILED', 'DeployerX could not connect to the SFTP repository.', { category: 'connectivity', retryable: true });
}

function openSftpSession({ connectionConfig, resolveSecret, clientFactory = () => new Client(), signal } = {}) {
  if (typeof resolveSecret !== 'function') throw new TypeError('SFTP repository SecretRef resolver is required.');
  const config = new LinuxSshConnectionAdapter().normalizeConfig(connectionConfig);
  const client = clientFactory();
  return new Promise((resolve, reject) => {
    let settled = false;
    let authAttempted = false;
    let timer = null;
    const flags = { hostKeyMismatch: false, canceled: false, observedFingerprint: null };
    const finish = (error, sftp) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) {
        try { client.end(); } catch {}
        reject(error instanceof SftpRepositoryError ? error : classifySessionError(error, flags));
        return;
      }
      // Keep individual requests within the repository bound while honoring
      // a shorter connection timeout selected by the operator.
      resolve(new SftpRemoteSession(client, sftp, { operationTimeoutMs: Math.min(SFTP_OPERATION_TIMEOUT_MS, config.timeoutMs) }));
    };
    const onAbort = () => {
      flags.canceled = true;
      finish(classifySessionError(null, flags));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new SftpRepositoryError('SFTP_REPOSITORY_TIMEOUT', 'The SFTP repository did not respond before the SSH timeout.', { category: 'timeout', retryable: true })), config.timeoutMs);
    client.once('error', (error) => finish(error));
    client.once('ready', () => {
      client.sftp((error, sftp) => {
        if (error) return finish(new SftpRepositoryError('SSH_SFTP_UNAVAILABLE', 'SSH connected, but the SFTP subsystem is unavailable.', { category: 'compatibility' }));
        finish(null, sftp);
      });
    });
    try {
      client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: config.timeoutMs,
        keepaliveInterval: 10000,
        keepaliveCountMax: 2,
        hostVerifier: (key) => {
          flags.observedFingerprint = fingerprintHostKey(key);
          flags.hostKeyMismatch = flags.observedFingerprint !== config.hostKeyFingerprint;
          return !flags.hostKeyMismatch;
        },
        authHandler: (_methodsLeft, _partialSuccess, callback) => {
          if (authAttempted || !flags.observedFingerprint || flags.hostKeyMismatch) return callback(false);
          authAttempted = true;
          Promise.resolve(resolveSecret(config.credentialSecretRefId))
            .then(async (credential) => {
              if (config.authType === 'password') return callback({ type: 'password', username: config.username, password: credential });
              const passphrase = config.passphraseSecretRefId ? await resolveSecret(config.passphraseSecretRefId) : undefined;
              callback({ type: 'publickey', username: config.username, key: credential, ...(passphrase ? { passphrase } : {}) });
            })
            .catch(() => callback(false));
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

class SftpRemoteSession {
  constructor(client, sftp, options = {}) {
    this.client = client;
    this.sftp = sftp;
    this.operationTimeoutMs = Number.isInteger(options.operationTimeoutMs) && options.operationTimeoutMs >= 1000
      ? options.operationTimeoutMs : SFTP_OPERATION_TIMEOUT_MS;
    this.failure = null;
    this.pending = new Set();
    this.closed = false;
    this.onTransportError = (error) => {
      if (this.failure) return;
      this.failure = error instanceof Error ? error : new Error('The SFTP transport closed unexpectedly.');
      for (const operation of [...this.pending]) operation.reject(this.failure);
    };
    this.onTransportClose = () => {
      if (this.closed || this.failure) return;
      this.onTransportError(Object.assign(new Error('The SFTP transport closed unexpectedly.'), { code: 'ECONNRESET' }));
    };
    this.transportListeners = [
      [this.client, 'error', this.onTransportError],
      [this.client, 'close', this.onTransportClose],
      [this.client, 'end', this.onTransportClose],
      [this.client, 'timeout', this.onTransportClose],
      [this.sftp, 'error', this.onTransportError],
      [this.sftp, 'close', this.onTransportClose],
      [this.sftp, 'end', this.onTransportClose],
      [this.sftp, 'exit', this.onTransportClose]
    ];
    for (const [target, event, listener] of this.transportListeners) target?.on?.(event, listener);
  }

  #call(method, ...args) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('The SFTP session is closed.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const operation = {
        reject: (error) => finish(error),
      };
      const timer = setTimeout(() => {
        const timeoutError = Object.assign(new Error('The SFTP operation timed out.'), { code: 'ETIMEDOUT' });
        this.failure = this.failure || timeoutError;
        for (const pending of [...this.pending]) pending.reject(this.failure);
      }, this.operationTimeoutMs);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(operation);
        if (error) reject(error);
        else resolve(value);
      };
      this.pending.add(operation);
      try {
        this.sftp[method](...args, (error, result) => finish(error, result));
      } catch (error) {
        finish(error);
      }
    });
  }

  supportsHardlink() {
    return this.sftp?._extensions?.['hardlink@openssh.com'] === '1';
  }

  async lstat(remotePath) {
    try {
      return await this.#call('lstat', remotePath);
    } catch (error) {
      if (isMissingError(error)) return null;
      throw error;
    }
  }

  async ensureDirectory(remotePath) {
    const parts = path.posix.normalize(remotePath).split('/').filter(Boolean);
    let current = '/';
    for (const part of parts) {
      current = path.posix.join(current, part);
      let attributes = await this.lstat(current);
      if (!attributes) {
        try { await this.#call('mkdir', current, { mode: 0o700 }); } catch (error) { if (!await this.lstat(current)) throw error; }
        attributes = await this.lstat(current);
      }
      if (!isDirectory(attributes)) throw new SftpRepositoryError('SFTP_REPOSITORY_PATH_UNSAFE', 'SFTP repository paths must be real directories.', { category: 'integrity' });
    }
  }

  async open(remotePath, flags, mode = 0o600) {
    return this.#call('open', remotePath, flags, mode);
  }

  async closeHandle(handle) {
    await this.#call('close', handle);
  }

  async read(handle, buffer, offset, length, position) {
    return this.#call('read', handle, buffer, offset, length, position);
  }

  async write(handle, buffer, position) {
    await this.#call('write', handle, buffer, 0, buffer.length, position);
  }

  async sync(handle) {
    if (this.sftp?._extensions?.['fsync@openssh.com'] === '1') await this.#call('ext_openssh_fsync', handle);
  }

  hardlink(sourcePath, targetPath) {
    if (!this.supportsHardlink()) throw new SftpRepositoryError('SFTP_REPOSITORY_ATOMIC_COMMIT_UNAVAILABLE', 'This SFTP server does not support atomic immutable repository commits.', { category: 'compatibility' });
    return this.#call('ext_openssh_hardlink', sourcePath, targetPath);
  }

  async unlink(remotePath, allowMissing = false) {
    try { await this.#call('unlink', remotePath); } catch (error) { if (!allowMissing || !isMissingError(error)) throw error; }
  }

  mkdir(remotePath) {
    return this.#call('mkdir', remotePath, { mode: 0o700 });
  }

  rename(sourcePath, targetPath) {
    return this.#call('rename', sourcePath, targetPath);
  }

  replace(sourcePath, targetPath) {
    return this.#call('rename', sourcePath, targetPath);
  }

  rmdir(remotePath) {
    return this.#call('rmdir', remotePath);
  }

  async readFile(remotePath, maximumBytes) {
    const handle = await this.open(remotePath, 'r');
    const parts = [];
    let position = 0;
    try {
      while (true) {
        const buffer = Buffer.allocUnsafe(Math.min(4096, maximumBytes + 1 - position));
        const bytesRead = await this.read(handle, buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        if (position > maximumBytes) throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'SFTP repository lease record is too large.', { category: 'integrity', retryable: false });
        parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      return Buffer.concat(parts, position);
    } finally {
      await this.closeHandle(handle).catch(() => {});
    }
  }

  async writeFile(remotePath, bytes, flags) {
    const handle = await this.open(remotePath, flags, 0o600);
    try {
      await this.write(handle, Buffer.from(bytes), 0);
      await this.sync(handle);
    } finally {
      await this.closeHandle(handle).catch(() => {});
    }
  }

  readdir(remotePath) {
    return this.#call('readdir', remotePath);
  }

  async capacity(remotePath) {
    if (this.sftp?._extensions?.['statvfs@openssh.com'] !== '2') return null;
    return this.#call('ext_openssh_statvfs', remotePath);
  }

  close() {
    this.closed = true;
    for (const [target, event, listener] of this.transportListeners || []) target?.removeListener?.(event, listener);
    try { this.sftp.end(); } catch {}
    try { this.client.end(); } catch {}
  }
}

function binaryParts(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return (async function* onePart() { yield Buffer.from(body); })();
  if (body && typeof body[Symbol.asyncIterator] === 'function') return body;
  throw new SftpRepositoryError('SFTP_REPOSITORY_WRITE_INVALID', 'Repository object body must be binary data or a binary stream.', { category: 'validation' });
}

function repositoryCapabilities() {
  return {
    operations: { list: true, stat: true, read: true, rangeRead: false, write: true, resumeWrite: false, multipartWrite: false, atomicCommit: true, copy: true, delete: true },
    locking: 'native', consistency: 'strong', checksums: ['sha256'], versioning: false,
    objectImmutability: false, legalHold: false, storageClasses: false, serverSideEncryption: false,
    clientSideEncryptionCompatible: true, capacityReporting: 'probe', maximumObjectSizeBytes: MAX_OBJECT_SIZE_BYTES,
    minimumPartSizeBytes: null, caseSensitiveKeys: true,
    requirements: ['hardlink@openssh.com=1'], reductions: ['no-resumable-write', 'no-range-read', 'no-native-versioning']
  };
}

class SftpRepositoryAdapter {
  constructor({ rootPath, connectionConfig, resolveSecret, clientFactory, sessionFactory, clock = () => new Date().toISOString() } = {}) {
    this.rootPath = normalizeSftpRepositoryConfig({ rootPath }).rootPath;
    this.connectionConfig = new LinuxSshConnectionAdapter().normalizeConfig(connectionConfig || {});
    this.resolveSecret = resolveSecret;
    this.clientFactory = clientFactory;
    this.sessionFactory = sessionFactory || ((context = {}) => openSftpSession({ connectionConfig: this.connectionConfig, resolveSecret: this.resolveSecret, clientFactory: this.clientFactory, signal: context.signal }));
    this.clock = clock;
    this.storePath = path.posix.join(this.rootPath, STORE_DIRECTORY);
    this.objectsPath = path.posix.join(this.storePath, 'objects');
    this.stagingPath = path.posix.join(this.storePath, 'staging');
    this.locksPath = path.posix.join(this.storePath, 'locks');
    this.activeSessions = new Map();
    this.initialized = false;
  }

  manifest() {
    return { apiVersion: 1, id: ADAPTER_ID, version: ADAPTER_VERSION, kind: 'repository', displayName: 'SFTP server', capabilities: this.capabilities() };
  }

  capabilities() {
    return repositoryCapabilities();
  }

  normalizeConfig(input) {
    return normalizeSftpRepositoryConfig(input);
  }

  validateConfig(input) {
    try { this.normalizeConfig(input); return []; } catch (error) { return [{ path: 'rootPath', code: 'SFTP_REPOSITORY_PATH_INVALID', safeMessage: error.message }]; }
  }

  async #withSession(context, operation) {
    const session = await this.sessionFactory(context || {});
    try { return await operation(session); } finally { await session.close?.(); }
  }

  async initialize(context = {}) {
    if (this.initialized) return { rootPath: this.rootPath, storePath: this.storePath };
    try {
      return await this.#withSession(context, async (session) => {
        await session.ensureDirectory(this.rootPath);
        await session.ensureDirectory(this.storePath);
        await session.ensureDirectory(this.objectsPath);
        await session.ensureDirectory(this.stagingPath);
        await session.ensureDirectory(this.locksPath);
        if (!session.supportsHardlink()) throw new SftpRepositoryError('SFTP_REPOSITORY_ATOMIC_COMMIT_UNAVAILABLE', 'This SFTP server does not advertise hardlink@openssh.com, which DeployerX requires for atomic immutable commits.', { category: 'compatibility' });
        this.initialized = true;
        return { rootPath: this.rootPath, storePath: this.storePath };
      });
    } catch (error) {
      throw this.#operationError(error, 'SFTP_REPOSITORY_INITIALIZE_FAILED', 'DeployerX could not initialize the SFTP repository folder.');
    }
  }

  #targetPath(key) {
    const normalized = normalizeObjectKey(key);
    const target = path.posix.resolve(this.objectsPath, ...normalized.split('/'));
    if (!target.startsWith(`${path.posix.resolve(this.objectsPath)}/`)) throw new SftpRepositoryError('SFTP_REPOSITORY_KEY_INVALID', 'Repository object key escapes the object store.', { category: 'validation' });
    return { key: normalized, target };
  }

  async #ensureParent(session, key) {
    await session.ensureDirectory(path.posix.dirname(this.#targetPath(key).target));
  }

  async #hashFile(session, targetPath) {
    let handle = null;
    const checksum = crypto.createHash('sha256');
    let sizeBytes = 0;
    try {
      const attributes = await session.lstat(targetPath);
      if (!attributes) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_NOT_FOUND', 'SFTP repository object was not found.', { category: 'not-found' });
      if (!isRegularFile(attributes)) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository object is not a regular file.', { category: 'integrity' });
      const expectedSize = normalizedObjectSize(attributes.size);
      handle = await session.open(targetPath, 'r');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const bytesRead = await session.read(handle, buffer, 0, buffer.length, sizeBytes);
        if (!bytesRead) break;
        sizeBytes += bytesRead;
        if (sizeBytes > expectedSize || sizeBytes > MAX_OBJECT_SIZE_BYTES) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository object exceeded its declared size.', { category: 'integrity' });
        checksum.update(buffer.subarray(0, bytesRead));
      }
      if (sizeBytes !== expectedSize) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository object size changed while it was read.', { category: 'integrity' });
      return { sizeBytes, checksum: { algorithm: 'sha256', digest: checksum.digest('hex') } };
    } finally {
      if (handle) await session.closeHandle(handle).catch(() => {});
    }
  }

  async stat(context, key) {
    await this.initialize(context);
    const resolved = this.#targetPath(key);
    return this.#withSession(context, async (session) => {
      let attributes;
      try { attributes = await session.lstat(resolved.target); } catch (error) { throw this.#operationError(error, 'SFTP_REPOSITORY_STAT_FAILED', 'DeployerX could not inspect an SFTP repository object.'); }
      if (!attributes) return null;
      if (!isRegularFile(attributes)) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository object is not a regular file.', { category: 'integrity' });
      const modifiedAt = Number.isFinite(attributes.mtime) ? new Date(attributes.mtime * 1000).toISOString() : null;
      return { key: resolved.key, sizeBytes: normalizedObjectSize(attributes.size), modifiedAt };
    });
  }

  async read(context, request = {}) {
    await this.initialize(context);
    const resolved = this.#targetPath(request.key);
    const adapter = this;
    return (async function* readRemoteObject() {
      const session = await adapter.sessionFactory(context || {});
      let handle = null;
      let position = 0;
      try {
        const attributes = await session.lstat(resolved.target);
        if (!attributes) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_NOT_FOUND', 'SFTP repository object was not found.', { category: 'not-found' });
        if (!isRegularFile(attributes)) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository object is not a regular file.', { category: 'integrity' });
        const expectedSize = normalizedObjectSize(attributes.size);
        handle = await session.open(resolved.target, 'r');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (true) {
          const bytesRead = await session.read(handle, buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead;
          if (position > expectedSize || position > MAX_OBJECT_SIZE_BYTES) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository object exceeded its declared size.', { category: 'integrity' });
          yield Buffer.from(buffer.subarray(0, bytesRead));
        }
        if (position !== expectedSize) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository object size changed while it was read.', { category: 'integrity' });
      } catch (error) {
        if (error instanceof SftpRepositoryError) throw error;
        throw adapter.#operationError(error, 'SFTP_REPOSITORY_READ_FAILED', 'DeployerX could not read an SFTP repository object.');
      } finally {
        if (handle) await session.closeHandle(handle).catch(() => {});
        await session.close?.();
      }
    })();
  }

  async write(context, request = {}) {
    await this.initialize(context);
    const resolved = this.#targetPath(request.key);
    const declaredSize = Number(request.sizeBytes);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_OBJECT_SIZE_BYTES) throw new SftpRepositoryError('SFTP_REPOSITORY_WRITE_INVALID', 'Repository object size is invalid.', { category: 'validation' });
    if (request.checksum?.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(request.checksum?.digest || '')) throw new SftpRepositoryError('SFTP_REPOSITORY_WRITE_INVALID', 'Repository object checksum is invalid.', { category: 'validation' });
    const token = crypto.randomUUID();
    const temporaryPath = path.posix.join(this.stagingPath, `.${token}.tmp`);
    await this.#withSession(context, async (session) => {
      let handle = null;
      try {
        await this.#ensureParent(session, resolved.key);
        handle = await session.open(temporaryPath, 'wx', 0o600);
        const checksum = crypto.createHash('sha256');
        let sizeBytes = 0;
        for await (const rawPart of binaryParts(request.body)) {
          if (!Buffer.isBuffer(rawPart) && !(rawPart instanceof Uint8Array)) throw new SftpRepositoryError('SFTP_REPOSITORY_WRITE_INVALID', 'Repository object stream emitted invalid data.', { category: 'validation' });
          const part = Buffer.from(rawPart);
          if (sizeBytes + part.length > declaredSize || sizeBytes + part.length > MAX_OBJECT_SIZE_BYTES) throw new SftpRepositoryError('SFTP_REPOSITORY_WRITE_INVALID', 'Repository object stream exceeded its declared size.', { category: 'validation' });
          await session.write(handle, part, sizeBytes);
          sizeBytes += part.length;
          checksum.update(part);
        }
        const digest = checksum.digest('hex');
        if (sizeBytes !== declaredSize || digest !== request.checksum.digest) throw new SftpRepositoryError('SFTP_REPOSITORY_WRITE_MISMATCH', 'Repository object bytes do not match their declared size or checksum.', { category: 'integrity' });
        await session.sync(handle);
        await session.closeHandle(handle);
        handle = null;
      } catch (error) {
        if (handle) await session.closeHandle(handle).catch(() => {});
        await session.unlink(temporaryPath, true).catch(() => {});
        if (error instanceof SftpRepositoryError) throw error;
        throw this.#operationError(error, 'SFTP_REPOSITORY_WRITE_FAILED', 'DeployerX could not stage an SFTP repository object.');
      }
    });
    const session = { token, key: resolved.key, targetPath: resolved.target, temporaryPath, sizeBytes: declaredSize, checksum: request.checksum, idempotencyKey: request.idempotencyKey || null };
    this.activeSessions.set(token, session);
    return { ...session };
  }

  async commit(context, input = {}) {
    await this.initialize(context);
    const pending = this.activeSessions.get(input.token);
    if (!pending || pending.key !== input.key || pending.temporaryPath !== input.temporaryPath) throw new SftpRepositoryError('SFTP_REPOSITORY_SESSION_INVALID', 'SFTP repository write session is invalid.', { category: 'validation' });
    return this.#withSession(context, async (session) => {
      let existing = false;
      try {
        const attributes = await session.lstat(pending.targetPath);
        if (attributes) {
          const evidence = await this.#hashFile(session, pending.targetPath);
          if (evidence.sizeBytes !== pending.sizeBytes || evidence.checksum.digest !== pending.checksum.digest) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_CONFLICT', 'An immutable SFTP repository object already exists with different content.', { category: 'integrity' });
          existing = true;
        } else {
          try {
            await session.hardlink(pending.temporaryPath, pending.targetPath);
          } catch (error) {
            if (error instanceof SftpRepositoryError) throw error;
            const concurrent = await session.lstat(pending.targetPath).catch(() => null);
            if (!concurrent) throw error;
            const evidence = await this.#hashFile(session, pending.targetPath);
            if (evidence.sizeBytes !== pending.sizeBytes || evidence.checksum.digest !== pending.checksum.digest) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_CONFLICT', 'An immutable SFTP repository object was committed concurrently with different content.', { category: 'integrity' });
            existing = true;
          }
        }
        await session.unlink(pending.temporaryPath, true).catch(() => {});
        this.activeSessions.delete(pending.token);
        return { key: pending.key, sizeBytes: pending.sizeBytes, checksum: pending.checksum, existing };
      } catch (error) {
        if (error instanceof SftpRepositoryError) throw error;
        throw this.#operationError(error, 'SFTP_REPOSITORY_COMMIT_FAILED', 'DeployerX could not atomically commit an SFTP repository object.');
      }
    });
  }

  async abort(context, input = {}) {
    const pending = this.activeSessions.get(input.token);
    if (!pending) return { aborted: false };
    this.activeSessions.delete(pending.token);
    await this.#withSession(context, (session) => session.unlink(pending.temporaryPath, true)).catch(() => {});
    return { aborted: true };
  }

  /**
   * Remove only abandoned adapter staging files while the caller owns the
   * repository mutation lease. The caller must acquire/take over that lease
   * before invoking this method; this method never guesses ownership.
   */
  async reconcileStaging(context = {}, options = {}) {
    await this.initialize(context);
    const lease = validateLease(options.lease);
    const minimumAgeMs = Number(options.minimumAgeMs);
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 1 || minimumAgeMs > MAX_STAGING_RECONCILIATION_AGE_MS) {
      throw new SftpRepositoryError('SFTP_REPOSITORY_RECONCILIATION_INVALID', 'A bounded staging age threshold is required for SFTP repository reconciliation.', { category: 'validation', retryable: false });
    }
    const nowMilliseconds = Date.parse(this.clock());
    if (!Number.isFinite(nowMilliseconds)) throw new SftpRepositoryError('SFTP_REPOSITORY_CLOCK_INVALID', 'The SFTP repository reconciliation clock is invalid.', { category: 'internal', retryable: false });
    const paths = this.#lockPaths(lease.scope);
    return this.#withSession(context, async (session) => {
      const existing = await this.#readLock(session, paths, context.masterKey, true);
      if (!existing || !sameLease(existing, lease) || isExpired(existing, this.clock)) {
        throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The SFTP repository mutation lease is not owned by the reconciliation worker.');
      }
      const entries = await session.readdir(this.stagingPath);
      if (!Array.isArray(entries) || entries.length > MAX_STAGING_RECONCILIATION_ENTRIES) {
        throw new SftpRepositoryError('SFTP_REPOSITORY_RECONCILIATION_LIMIT_EXCEEDED', 'The SFTP repository staging directory exceeds the bounded reconciliation limit.', { category: 'capacity', retryable: false });
      }
      const removed = [];
      const skipped = { nonGenerated: 0, nonRegular: 0, youngOrUnknownAge: 0 };
      let inspected = 0;
      for (const entry of entries) {
        if (isExpired(existing, this.clock)) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The SFTP repository mutation lease expired during reconciliation.');
        const name = String(entry?.filename || '');
        if (!GENERATED_STAGING_TEMP_NAME.test(name)) {
          skipped.nonGenerated += 1;
          continue;
        }
        inspected += 1;
        if (!isRegularFile(entry?.attrs)) {
          skipped.nonRegular += 1;
          continue;
        }
        const age = ageMilliseconds(nowMilliseconds, entry.attrs);
        if (age === null || age < minimumAgeMs) {
          skipped.youngOrUnknownAge += 1;
          continue;
        }
        const currentLease = await this.#readLock(session, paths, context.masterKey, true);
        if (!currentLease || !sameLease(currentLease, lease) || isExpired(currentLease, this.clock)) {
          throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The SFTP repository mutation lease changed during reconciliation.');
        }
        const remotePath = path.posix.join(this.stagingPath, name);
        try {
          await session.unlink(remotePath, true);
          removed.push(name);
        } catch (error) {
          if (!isMissingError(error)) throw this.#operationError(error, 'SFTP_REPOSITORY_RECONCILIATION_FAILED', 'DeployerX could not remove an abandoned SFTP staging file.');
        }
      }
      return { lease: publicLease(existing), entriesScanned: entries.length, inspected, removed, skipped };
    });
  }

  async copy(context, request = {}) {
    await this.initialize(context);
    const source = this.#targetPath(request.sourceKey);
    const target = this.#targetPath(request.targetKey);
    let evidence;
    try { evidence = await this.#withSession(context, (session) => this.#hashFile(session, source.target)); } catch (error) { throw this.#operationError(error, 'SFTP_REPOSITORY_COPY_SOURCE_FAILED', 'DeployerX could not inspect the SFTP repository source object.'); }
    const body = await this.read(context, { key: source.key });
    const pending = await this.write(context, { key: target.key, body, sizeBytes: evidence.sizeBytes, checksum: evidence.checksum, idempotencyKey: request.idempotencyKey });
    return this.commit(context, pending);
  }

  async delete(context, request = {}) {
    await this.initialize(context);
    const resolved = this.#targetPath(request.key);
    return this.#withSession(context, async (session) => {
      const attributes = await session.lstat(resolved.target);
      if (!attributes) return { key: resolved.key, deleted: false, absent: true };
      if (!isRegularFile(attributes)) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository object is not a regular file.', { category: 'integrity' });
      try { await session.unlink(resolved.target); } catch (error) { throw this.#operationError(error, 'SFTP_REPOSITORY_DELETE_FAILED', 'DeployerX could not delete an SFTP repository object.'); }
      return { key: resolved.key, deleted: true, absent: false };
    });
  }

  async *list(context, request = {}) {
    await this.initialize(context);
    const prefix = normalizePrefix(request.prefix);
    const pageSize = request.pageSize === undefined ? 100 : Number(request.pageSize);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_LIST_PAGE_SIZE) throw new SftpRepositoryError('SFTP_REPOSITORY_LIST_INVALID', 'Repository list page size is invalid.', { category: 'validation' });
    const offset = decodeCursor(request.cursor, prefix);
    const page = await this.#withSession(context, async (session) => {
      const items = [];
      let scanned = 0;
      let scannedDirectories = 0;
      const pendingDirectories = [{ directory: this.objectsPath, relative: '' }];
      while (pendingDirectories.length) {
        const { directory, relative } = pendingDirectories.pop();
        scannedDirectories += 1;
        if (scannedDirectories > MAX_LIST_DIRECTORIES) throw new SftpRepositoryError('SFTP_REPOSITORY_LIST_LIMIT_EXCEEDED', 'SFTP repository directory listing exceeds the bounded limit.', { category: 'capacity' });
        const entries = await session.readdir(directory);
        for (const entry of entries) {
          const name = String(entry?.filename || '');
          if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || name.length > MAX_OBJECT_KEY_LENGTH) throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository returned an unsafe object name.', { category: 'integrity' });
          const key = relative ? `${relative}/${name}` : name;
          const target = path.posix.join(directory, name);
          normalizeObjectKey(key);
          if (isDirectory(entry.attrs)) pendingDirectories.push({ directory: target, relative: key });
          else if (isRegularFile(entry.attrs)) {
            scanned += 1;
            if (scanned > MAX_LIST_OBJECTS) throw new SftpRepositoryError('SFTP_REPOSITORY_LIST_LIMIT_EXCEEDED', 'SFTP repository listing exceeds the bounded object limit.', { category: 'capacity' });
            if (key.startsWith(prefix)) items.push({ key, sizeBytes: normalizedObjectSize(entry.attrs.size), modifiedAt: Number.isFinite(entry.attrs.mtime) ? new Date(entry.attrs.mtime * 1000).toISOString() : null });
          } else throw new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_INVALID', 'SFTP repository contains an unsupported object type.', { category: 'integrity' });
        }
      }
      items.sort((left, right) => left.key.localeCompare(right.key, 'en-US'));
      if (offset > items.length) throw new SftpRepositoryError('SFTP_REPOSITORY_CURSOR_INVALID', 'Repository list cursor is outside the current listing.', { category: 'validation' });
      const selected = items.slice(offset, offset + pageSize);
      const nextOffset = offset + selected.length;
      return { items: selected, nextCursor: nextOffset < items.length ? encodeCursor(prefix, nextOffset) : null, hasMore: nextOffset < items.length };
    });
    yield page;
  }

  async getCapacity(context = {}) {
    await this.initialize(context);
    return this.#withSession(context, async (session) => {
      try {
        const stats = await session.capacity(this.storePath);
        if (!stats) return { reporting: 'unavailable', measuredAt: this.clock() };
        const totalBytes = Number(stats.blocks) * Number(stats.bsize);
        const freeBytes = Number(stats.bavail) * Number(stats.bsize);
        if (![totalBytes, freeBytes].every(Number.isSafeInteger)) return { reporting: 'unavailable', measuredAt: this.clock() };
        return { reporting: 'exact', totalBytes, freeBytes, usedBytes: totalBytes - freeBytes, measuredAt: this.clock() };
      } catch {
        return { reporting: 'unavailable', measuredAt: this.clock() };
      }
    });
  }

  #lockPaths(scope) {
    const scopeId = lockScopeId(scope);
    const directory = path.posix.join(this.locksPath, scopeId);
    return { directory, leasePath: path.posix.join(directory, 'lease.dxl'), binding: `${ADAPTER_ID}:${scopeId}` };
  }

  async #publishLock(session, paths, lease, masterKey) {
    const temporaryDirectory = `${paths.directory}.init-${crypto.randomUUID()}`;
    let published = false;
    try {
      await session.mkdir(temporaryDirectory);
      await session.writeFile(path.posix.join(temporaryDirectory, 'lease.dxl'), encodeLockRecord(lease, masterKey, paths.binding), 'wx');
      try {
        await session.rename(temporaryDirectory, paths.directory);
        published = true;
        return true;
      } catch (error) {
        // A competing publisher owns the canonical path. An absent path is
        // ambiguous after a transport failure and remains fail-closed.
        const canonical = await session.lstat(paths.directory).catch((probeError) => isLockTargetExistsError(probeError) ? { mode: 0o040700 } : null);
        if (canonical || isExistsError(error)) return false;
        throw error;
      }
    } finally {
      if (!published) {
        await session.unlink(path.posix.join(temporaryDirectory, 'lease.dxl'), true).catch(() => {});
        await session.rmdir(temporaryDirectory).catch(() => {});
      }
    }
  }

  async #removeLeaseArtifacts(session, directory) {
    const entries = await session.readdir(directory);
    if (!Array.isArray(entries) || entries.length > MAX_STAGING_RECONCILIATION_ENTRIES) {
      throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'SFTP repository lock directory exceeds the bounded cleanup limit.', { category: 'integrity', retryable: false });
    }
    for (const entry of entries) {
      const name = String(entry?.filename || '');
      if (name !== 'lease.dxl' && !GENERATED_LOCK_UPDATE_NAME.test(name)) continue;
      if (!isRegularFile(entry?.attrs)) throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'SFTP repository lock cleanup encountered a non-regular lease artifact.', { category: 'integrity', retryable: false });
      await session.unlink(path.posix.join(directory, name), true);
    }
    await session.rmdir(directory);
  }

  async #retireLockDirectory(session, directory, reason = 'recovery') {
    const retiredPath = `${directory}.${reason}-${crypto.randomUUID()}`;
    try {
      await session.rename(directory, retiredPath);
    } catch (error) {
      if (isMissingError(error)) return false;
      throw error;
    }
    try {
      await this.#removeLeaseArtifacts(session, retiredPath);
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
    return true;
  }

  async #inspectLock(session, paths, masterKey) {
    const directoryAttributes = await session.lstat(paths.directory);
    if (!directoryAttributes) return { state: 'absent' };
    if (!isDirectory(directoryAttributes)) return { state: 'invalid-directory', directoryAttributes };
    const leaseAttributes = await session.lstat(paths.leasePath);
    if (!leaseAttributes) return { state: 'missing', directoryAttributes };
    if (!isRegularFile(leaseAttributes) || Number(leaseAttributes.size) > 16 * 1024 + 64) {
      return { state: 'invalid', directoryAttributes, leaseAttributes, error: new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'SFTP repository lease record is invalid.', { category: 'integrity', retryable: false }) };
    }
    if (Number(leaseAttributes.size) < LOCK_RECORD_MIN_BYTES) return { state: 'partial', directoryAttributes, leaseAttributes };
    try {
      return { state: 'valid', directoryAttributes, leaseAttributes, lease: await this.#readLock(session, paths, masterKey, false) };
    } catch (error) {
      return { state: 'invalid', directoryAttributes, leaseAttributes, error };
    }
  }

  async #publishLeaseRecord(session, paths, bytes) {
    const temporaryPath = `${paths.leasePath}.update-${crypto.randomUUID()}`;
    let published = false;
    try {
      await session.writeFile(temporaryPath, bytes, 'wx');
      const replace = typeof session.replace === 'function' ? session.replace.bind(session) : session.rename.bind(session);
      await replace(temporaryPath, paths.leasePath);
      published = true;
    } finally {
      if (!published) await session.unlink(temporaryPath, true).catch(() => {});
    }
  }

  async #readLock(session, paths, masterKey, allowMissing = false) {
    try {
      const attributes = await session.lstat(paths.leasePath);
      if (!attributes) {
        if (allowMissing) return null;
        throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'SFTP repository lease record is missing.', { category: 'integrity', retryable: false });
      }
      if (!isRegularFile(attributes) || Number(attributes.size) > 16 * 1024 + 64) throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'SFTP repository lease record is invalid.', { category: 'integrity', retryable: false });
      return decodeLockRecord(await session.readFile(paths.leasePath, 16 * 1024 + 64), masterKey, paths.binding);
    } catch (error) {
      if (allowMissing && isMissingError(error)) return null;
      if (error instanceof RepositoryLockError) throw error;
      throw this.#operationError(error, 'REPOSITORY_LOCK_READ_FAILED', 'DeployerX could not read the SFTP repository lease.');
    }
  }

  async acquireLock(context = {}, request = {}) {
    await this.initialize(context);
    const lease = normalizeLockRequest(request, this.clock);
    const paths = this.#lockPaths(lease.scope);
    return this.#withSession(context, async (session) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          if (await this.#publishLock(session, paths, lease, context.masterKey)) return publicLease(lease);
        } catch (error) {
          if (error instanceof RepositoryLockError) throw error;
          if (isExistsError(error)) continue;
          throw this.#operationError(error, 'REPOSITORY_LOCK_ACQUIRE_FAILED', 'DeployerX could not acquire the SFTP repository lease.');
        }
        const state = await this.#inspectLock(session, paths, context.masterKey);
        if (state.state === 'absent') continue;
        if (state.state === 'valid') {
          if (!isExpired(state.lease, this.clock)) throw new RepositoryLockError('REPOSITORY_LOCK_CONTENDED', 'The repository is already locked by another operation.');
          try {
            await this.#retireLockDirectory(session, paths.directory, 'stale');
          } catch (error) {
            if (!isMissingError(error)) throw this.#operationError(error, 'REPOSITORY_LOCK_TAKEOVER_FAILED', 'DeployerX could not replace the expired SFTP repository lease.');
          }
          continue;
        }
        if (state.state === 'missing' || state.state === 'partial') {
          const nowMilliseconds = Date.parse(this.clock());
          const age = ageMilliseconds(nowMilliseconds, state.directoryAttributes);
          if (age === null || age < LOCK_RECOVERY_GRACE_MS) {
            throw new RepositoryLockError('REPOSITORY_LOCK_CONTENDED', 'The repository lease is being initialized by another operation.');
          }
          try {
            await this.#retireLockDirectory(session, paths.directory, 'recovery');
          } catch (error) {
            if (!isMissingError(error)) throw this.#operationError(error, 'REPOSITORY_LOCK_TAKEOVER_FAILED', 'DeployerX could not quarantine the incomplete SFTP repository lease.');
          }
          continue;
        }
        throw state.error || new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'The SFTP repository lease record is invalid.', { category: 'integrity', retryable: false });
      }
      throw new RepositoryLockError('REPOSITORY_LOCK_CONTENDED', 'The SFTP repository lease changed while DeployerX tried to acquire it.');
    });
  }

  async renewLock(context = {}, input = {}) {
    await this.initialize(context);
    const lease = validateLease(input);
    const paths = this.#lockPaths(lease.scope);
    return this.#withSession(context, async (session) => {
      const existing = await this.#readLock(session, paths, context.masterKey, true);
      if (!existing || !sameLease(existing, lease)) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The SFTP repository lease is no longer owned by this operation.');
      const renewed = renewLease(existing, this.clock);
      try { await this.#publishLeaseRecord(session, paths, encodeLockRecord(renewed, context.masterKey, paths.binding)); }
      catch (error) { throw this.#operationError(error, 'REPOSITORY_LOCK_RENEW_FAILED', 'DeployerX could not renew the SFTP repository lease.'); }
      const persisted = await this.#readLock(session, paths, context.masterKey, true);
      if (!persisted || !sameLease(persisted, renewed) || persisted.heartbeatAt !== renewed.heartbeatAt) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The SFTP repository lease changed while it was renewed.');
      return publicLease(renewed);
    });
  }

  async releaseLock(context = {}, input = {}) {
    await this.initialize(context);
    const lease = validateLease(input);
    const paths = this.#lockPaths(lease.scope);
    return this.#withSession(context, async (session) => {
      const existing = await this.#readLock(session, paths, context.masterKey, true);
      if (!existing) return { released: false, absent: true };
      if (!sameLease(existing, lease)) throw new RepositoryLockError('REPOSITORY_LOCK_LOST', 'The SFTP repository lease is owned by another operation.');
      const releasedPath = `${paths.directory}.released-${crypto.randomUUID()}`;
      try {
        await session.rename(paths.directory, releasedPath);
        await this.#removeLeaseArtifacts(session, releasedPath);
        return { released: true, absent: false };
      } catch (error) {
        if (isMissingError(error)) return { released: false, absent: true };
        throw this.#operationError(error, 'REPOSITORY_LOCK_RELEASE_FAILED', 'DeployerX could not release the SFTP repository lease.');
      }
    });
  }

  async testConnection(context = {}) {
    const startedAt = Date.now();
    let probePath = null;
    try {
      await this.initialize(context);
      return await this.#withSession(context, async (session) => {
        let handle = null;
        probePath = path.posix.join(this.stagingPath, `.probe-${crypto.randomUUID()}`);
        try {
          handle = await session.open(probePath, 'wx', 0o600);
          await session.write(handle, Buffer.from('deployerx-sftp-repository-probe'), 0);
          await session.sync(handle);
          await session.closeHandle(handle);
          handle = null;
          await session.unlink(probePath);
          probePath = null;
          return { status: 'success', testedAt: this.clock(), latencyMs: Date.now() - startedAt, checks: [{ id: 'sftp-atomic-write', status: 'pass', safeMessage: 'The SFTP server supports writable staging and atomic immutable commits.' }] };
        } finally {
          if (handle) await session.closeHandle(handle).catch(() => {});
          if (probePath) await session.unlink(probePath, true).catch(() => {});
        }
      });
    } catch (error) {
      const safeError = this.#operationError(error, 'SFTP_REPOSITORY_ACCESS_FAILED', 'DeployerX could not access the SFTP repository.');
      return { status: 'failure', testedAt: this.clock(), latencyMs: Date.now() - startedAt, checks: [], error: { code: safeError.code, category: safeError.category, retryable: safeError.retryable, safeMessage: safeError.message } };
    }
  }

  async probeCapabilities(context = {}) {
    const connectionTest = await this.testConnection(context);
    return { status: connectionTest.status === 'success' ? 'available' : 'unavailable', probedAt: this.clock(), capabilities: this.capabilities(), connectionTest, reductions: this.capabilities().reductions };
  }

  async validateImmutability() {
    return { supported: false, enforced: false, mode: 'none', checkedAt: this.clock() };
  }

  #operationError(error, code, safeMessage) {
    if (error instanceof SftpRepositoryError) return error;
    if (isMissingError(error)) return new SftpRepositoryError('SFTP_REPOSITORY_OBJECT_NOT_FOUND', 'SFTP repository object was not found.', { category: 'not-found' });
    if (isAccessError(error)) return new SftpRepositoryError('SFTP_REPOSITORY_ACCESS_FAILED', 'The SSH account cannot access the SFTP repository path.', { category: 'authorization' });
    return new SftpRepositoryError(code, safeMessage, { retryable: true });
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class SftpRepositoryService {
  constructor({ controlDatabase, secretStore, deviceId, adapterFactory = (config) => new SftpRepositoryAdapter(config), clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterFactory = adapterFactory;
    this.clock = clock;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const repositories = (await this.controlDatabase.repository('repository').list(tenant, { limit: 1000 })).filter((repository) => repository.adapterId === ADAPTER_ID);
    return Promise.all(repositories.map(async (repository) => {
      const connection = repository.connectionId ? await this.controlDatabase.repository('connection').get(tenant, repository.connectionId) : null;
      return { ...repository, capabilities: repositoryCapabilities(), currentDevice: (repository.workerAffinity || []).includes(`device:${this.deviceId}`), connectionName: connection?.name || 'Unavailable SSH connection' };
    }));
  }

  async #connection(workspaceId, connectionId) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, requiredText(connectionId, 'SSH connection ID', 200));
    if (!connection || connection.adapterId !== SSH_CONNECTION_ADAPTER_ID) throw new Error('Choose a saved SSH connection for the SFTP repository.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This SSH connection belongs to another device.');
    const [credentialSecretRefId, passphraseSecretRefId = null] = connection.secretRefIds || [];
    return {
      connection,
      config: {
        ...connection.endpoint,
        credentialSecretRefId,
        passphraseSecretRefId,
        hostKeyFingerprint: connection.trust?.fingerprint,
        hostKeyAlgorithm: connection.trust?.algorithm
      }
    };
  }

  #adapter(workspaceId, config, rootPath) {
    return this.adapterFactory({ rootPath, connectionConfig: config, resolveSecret: (id) => this.secretStore.resolve({ workspaceId, id }), clock: this.clock });
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'Repository name', 200);
    const repositoryConfig = normalizeSftpRepositoryConfig({ rootPath: input.rootPath });
    const { connection, config } = await this.#connection(tenant, input.connectionId);
    const duplicate = (await this.list(tenant)).some((repository) => repository.connectionId === connection.id && repository.location.path === repositoryConfig.rootPath);
    if (duplicate) throw new TypeError('This SFTP folder is already configured as a repository in this workspace.');
    const adapter = this.#adapter(tenant, config, repositoryConfig.rootPath);
    await adapter.initialize();
    const keyRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} repository encryption key ${crypto.randomUUID().slice(0, 8)}`, secretType: 'encryption-key', value: crypto.randomBytes(32).toString('base64'), scope: 'device' });
    let repository;
    try {
      repository = await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(keyRef, actor));
        return transaction.create('repository', {
          workspaceId: tenant, actorId: actor, name, connectionId: connection.id,
          adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
          location: { path: repositoryConfig.rootPath, storeDirectory: STORE_DIRECTORY, host: connection.endpoint.host, port: connection.endpoint.port },
          secretRefIds: [], encryptionKeyRefId: keyRef.id,
          encryption: { algorithm: 'aes-256-gcm', keyVersion: `secret:${keyRef.version}` },
          scope: 'device', workerAffinity: [`device:${this.deviceId}`], immutability: { mode: 'none', enforced: false }, storagePolicy: normalizeStoragePolicy(input.storagePolicy || {}), capacity: null,
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
      return this.controlDatabase.repository('repository').update(tenant, repository.id, { health: { status: 'needs-attention', checkedAt: this.clock(), repositoryFormatVersion: null, safeErrorCode: error.code || 'SFTP_REPOSITORY_INITIALIZE_FAILED' } }, { expectedRevision: repository.revision, actorId: actor });
    }
    return (await this.test(tenant, actor, repository.id)).repository;
  }

  async open(workspaceId, repositoryId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const repository = await this.controlDatabase.repository('repository').get(tenant, requiredText(repositoryId, 'Repository ID', 200));
    if (!repository || repository.adapterId !== ADAPTER_ID) throw new Error('SFTP repository was not found.');
    if (!(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This SFTP repository belongs to another device.');
    const { config } = await this.#connection(tenant, repository.connectionId);
    const encodedKey = await this.secretStore.resolve({ workspaceId: tenant, id: repository.encryptionKeyRefId });
    const masterKey = Buffer.from(encodedKey, 'base64');
    if (masterKey.length !== 32 || masterKey.toString('base64') !== encodedKey) throw new SftpRepositoryError('SFTP_REPOSITORY_KEY_INVALID', 'SFTP repository encryption key is invalid.', { category: 'encryption' });
    const adapter = this.#adapter(tenant, config, repository.location.path);
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

  async reconcile(workspaceId, actorId = 'system', options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new SftpRepositoryError('SFTP_REPOSITORY_RECONCILIATION_INVALID', 'SFTP repository reconciliation options are invalid.', { category: 'validation', retryable: false });
    const minimumAgeMs = Number(options.minimumAgeMs ?? LOCK_RECOVERY_GRACE_MS);
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 1 || minimumAgeMs > MAX_STAGING_RECONCILIATION_AGE_MS) {
      throw new SftpRepositoryError('SFTP_REPOSITORY_RECONCILIATION_INVALID', 'The SFTP repository reconciliation age threshold is invalid.', { category: 'validation', retryable: false });
    }
    const ttlMs = Number(options.ttlMs ?? LOCK_RECOVERY_GRACE_MS);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LOCK_TTL_MS || ttlMs > LOCK_RECOVERY_GRACE_MS) {
      throw new SftpRepositoryError('SFTP_REPOSITORY_RECONCILIATION_INVALID', 'The SFTP repository reconciliation lease duration is invalid.', { category: 'validation', retryable: false });
    }
    const requestedRepositoryId = options.repositoryId ? requiredText(options.repositoryId, 'Repository ID', 200) : null;
    const repositories = (await this.list(tenant)).filter((repository) => repository.currentDevice && (!requestedRepositoryId || repository.id === requestedRepositoryId));
    const workerId = `device:${this.deviceId}:sftp-reconciler`;
    const results = [];
    for (const repository of repositories) {
      let opened = null;
      let lease = null;
      let result = { repositoryId: repository.id, status: 'failed', removedCount: 0, entriesScanned: 0, inspected: 0, skipped: null, leaseReleased: null };
      try {
        opened = await this.open(tenant, repository.id);
        lease = await opened.adapter.acquireLock({ masterKey: opened.masterKey }, {
          repositoryId: repository.id,
          operation: 'reconcile',
          scope: `repository:${repository.id}:mutation`,
          workerId,
          runId: `sftp-reconcile:${crypto.randomUUID()}`,
          ttlMs
        });
        const reconciled = await opened.adapter.reconcileStaging({ masterKey: opened.masterKey }, { lease, minimumAgeMs });
        result = {
          repositoryId: repository.id,
          status: 'reconciled',
          removedCount: reconciled.removed.length,
          entriesScanned: reconciled.entriesScanned,
          inspected: reconciled.inspected,
          skipped: reconciled.skipped,
          leaseReleased: null
        };
      } catch (error) {
        const contended = error?.code === 'REPOSITORY_LOCK_CONTENDED';
        result = {
          repositoryId: repository.id,
          status: contended ? 'skipped' : 'failed',
          reason: contended ? 'lease-contended' : undefined,
          removedCount: 0,
          entriesScanned: 0,
          inspected: 0,
          skipped: null,
          leaseReleased: null,
          error: sanitizedReconciliationError(error, contended ? 'REPOSITORY_LOCK_CONTENDED' : undefined)
        };
        if (result.reason === undefined) delete result.reason;
      } finally {
        if (opened && lease) {
          try {
            await opened.adapter.releaseLock({ masterKey: opened.masterKey }, lease);
            result.leaseReleased = true;
          } catch (error) {
            result.leaseReleased = false;
            result.status = 'failed';
            result.error = sanitizedReconciliationError(error, 'REPOSITORY_LOCK_RELEASE_FAILED');
          }
        }
        results.push(result);
      }
    }
    return { workspaceId: tenant, minimumAgeMs, repositories: results };
  }

  async remove(workspaceId, actorId, repositoryId, revision) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const repository = await this.controlDatabase.repository('repository').get(tenant, requiredText(repositoryId, 'Repository ID', 200));
    if (!repository || repository.adapterId !== ADAPTER_ID) throw new Error('SFTP repository was not found.');
    const expectedRevision = Number(revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('Repository revision is required for removal.');
    const removed = await this.controlDatabase.repository('repository').softDelete(tenant, repository.id, { expectedRevision, actorId: actor });
    return { repository: removed, dataRetainedAt: repository.location.path, encryptionKeyRetained: true };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  LOCK_RECOVERY_GRACE_MS,
  MAX_STAGING_RECONCILIATION_AGE_MS,
  MAX_STAGING_RECONCILIATION_ENTRIES,
  SftpRepositoryAdapter,
  SftpRepositoryError,
  SftpRepositoryService,
  STORE_DIRECTORY,
  normalizeSftpRepositoryConfig,
  openSftpSession,
  repositoryCapabilities
};
