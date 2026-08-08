const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { FileRestoreService, SftpRestoreTarget } = require('./file-restore');
const { FileSourceReaderService } = require('./file-source-reader');
const { ManualBackupService } = require('./manual-backup');
const { BackupSecretStore } = require('./secrets');
const {
  ENGINE_ID,
  ENGINE_VERSION,
  FileRepositoryEngine,
  MIN_CHUNK_SIZE_BYTES,
  REPOSITORY_FORMAT_VERSION
} = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const { SnapshotBrowserService } = require('./snapshot-browser');
const { fingerprintHostKey } = require('./ssh-connection');
const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  LOCK_RECOVERY_GRACE_MS,
  SftpRepositoryAdapter,
  SftpRepositoryService,
  normalizeSftpRepositoryConfig,
  openSftpSession
} = require('./sftp-repository');

const CONNECTION_CONFIG = {
  host: 'backup.example.com', port: 22, username: 'backup', authType: 'password',
  credentialSecretRefId: 'sec_password', passphraseSecretRefId: null,
  hostKeyFingerprint: fingerprintHostKey(Buffer.from('approved-host-key')), hostKeyAlgorithm: 'ssh-ed25519', timeoutMs: 1000
};

class MemorySftpRemote {
  constructor({ hardlink = true, capacity = { blocks: 1000, bsize: 4096, bavail: 600 }, genericExistsStatus = false } = {}) {
    this.hardlink = hardlink;
    this.capacity = capacity;
    this.genericExistsStatus = genericExistsStatus;
    this.directories = new Set(['/']);
    this.files = new Map();
    this.modified = new Map();
    this.promiseWriteBlock = null;
    this.callbackWriteBlock = null;
  }

  sessionFactory = async () => new MemorySftpSession(this);

  blockNextPromiseWrite({ disconnectOnFail = false } = {}) {
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const block = { consumed: false, entered, enteredPromise, reject: null };
    this.promiseWriteBlock = block;
    return {
      entered: enteredPromise,
      fail(error = new Error('Simulated SFTP process interruption.')) {
        if (!block.reject) throw new Error('The SFTP write has not started.');
        if (disconnectOnFail) block.session?.disconnect(error);
        block.reject(error);
      }
    };
  }

  blockNextCallbackWrite() {
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const block = { consumed: false, entered, enteredPromise, callback: null };
    this.callbackWriteBlock = block;
    return {
      entered: enteredPromise,
      fail(error = new Error('Simulated SFTP process interruption.')) {
        if (!block.callback) throw new Error('The SFTP write has not started.');
        const callback = block.callback;
        block.callback = null;
        callback(error);
      }
    };
  }
}

function writeRemoteBytes(remote, remotePath, buffer, position) {
  const current = remote.files.get(remotePath) || Buffer.alloc(0);
  const next = Buffer.alloc(Math.max(current.length, position + buffer.length));
  current.copy(next);
  buffer.copy(next, position);
  remote.files.set(remotePath, next);
  remote.modified.set(remotePath, 1785758400);
}

class MemorySftpSession {
  constructor(remote) {
    this.remote = remote;
    this.disconnected = false;
  }

  disconnect(error = Object.assign(new Error('Simulated SFTP transport loss.'), { code: 'ECONNRESET' })) {
    this.disconnected = error;
  }

  assertConnected() {
    if (this.disconnected) throw this.disconnected;
  }

  supportsHardlink() { return this.remote.hardlink; }

  async ensureDirectory(remotePath) {
    this.assertConnected();
    const parts = path.posix.normalize(remotePath).split('/').filter(Boolean);
    let current = '/';
    for (const part of parts) {
      current = path.posix.join(current, part);
      if (this.remote.files.has(current)) throw Object.assign(new Error('not a directory'), { code: 4 });
      this.remote.directories.add(current);
    }
  }

  async lstat(remotePath) {
    this.assertConnected();
    if (this.remote.directories.has(remotePath)) return { mode: 0o040700, size: 0, mtime: 1785758400 };
    const value = this.remote.files.get(remotePath);
    return value ? { mode: 0o100600, size: value.length, mtime: this.remote.modified.get(remotePath) || 1785758400 } : null;
  }

  async open(remotePath, flags) {
    this.assertConnected();
    if (flags === 'r' && !this.remote.files.has(remotePath)) throw Object.assign(new Error('missing'), { code: 2 });
    if (flags === 'wx') {
      if (this.remote.files.has(remotePath)) throw Object.assign(new Error('exists'), { code: 11 });
      this.remote.files.set(remotePath, Buffer.alloc(0));
      this.remote.modified.set(remotePath, 1785758400);
    }
    if (flags === 'w') this.remote.files.set(remotePath, Buffer.alloc(0));
    return { path: remotePath, flags };
  }

  async closeHandle() { this.assertConnected(); }

  async read(handle, buffer, offset, length, position) {
    this.assertConnected();
    const source = this.remote.files.get(handle.path);
    if (!source) throw Object.assign(new Error('missing'), { code: 2 });
    const bytesRead = Math.min(length, Math.max(0, source.length - position));
    if (bytesRead) source.copy(buffer, offset, position, position + bytesRead);
    return bytesRead;
  }

  async write(handle, buffer, position) {
    this.assertConnected();
    const block = this.remote.promiseWriteBlock;
    if (block && !block.consumed) {
      block.consumed = true;
      block.session = this;
      const partialLength = Math.max(1, Math.floor(buffer.length / 2));
      writeRemoteBytes(this.remote, handle.path, buffer.subarray(0, partialLength), position);
      block.entered({ path: handle.path, partialBytes: partialLength, totalBytes: buffer.length });
      await new Promise((resolve, reject) => { block.reject = reject; });
      return;
    }
    writeRemoteBytes(this.remote, handle.path, buffer, position);
  }

  async sync() { this.assertConnected(); }

  async hardlink(sourcePath, targetPath) {
    this.assertConnected();
    if (!this.remote.hardlink) throw new Error('unsupported');
    if (this.remote.files.has(targetPath)) throw Object.assign(new Error('exists'), { code: 11 });
    const source = this.remote.files.get(sourcePath);
    if (!source) throw Object.assign(new Error('missing'), { code: 2 });
    this.remote.files.set(targetPath, Buffer.from(source));
    this.remote.modified.set(targetPath, 1785758400);
  }

  async unlink(remotePath, allowMissing = false) {
    this.assertConnected();
    if (!this.remote.files.delete(remotePath) && !allowMissing) throw Object.assign(new Error('missing'), { code: 2 });
  }

  async mkdir(remotePath) {
    this.assertConnected();
    if (this.remote.directories.has(remotePath) || this.remote.files.has(remotePath)) throw Object.assign(new Error('exists'), { code: 11 });
    this.remote.directories.add(remotePath);
  }

  async rename(sourcePath, targetPath) {
    this.assertConnected();
    if (this.remote.directories.has(targetPath) || this.remote.files.has(targetPath)) {
      if (this.remote.genericExistsStatus) throw Object.assign(new Error(), { code: 4 });
      throw Object.assign(new Error('exists'), { code: 11 });
    }
    if (this.remote.files.has(sourcePath)) {
      this.remote.files.set(targetPath, this.remote.files.get(sourcePath));
      this.remote.files.delete(sourcePath);
      if (this.remote.modified.has(sourcePath)) {
        this.remote.modified.set(targetPath, this.remote.modified.get(sourcePath));
        this.remote.modified.delete(sourcePath);
      }
      return;
    }
    if (!this.remote.directories.has(sourcePath)) throw Object.assign(new Error('missing'), { code: 2 });
    const directories = [...this.remote.directories].filter((item) => item === sourcePath || item.startsWith(`${sourcePath}/`));
    const files = [...this.remote.files.entries()].filter(([item]) => item.startsWith(`${sourcePath}/`));
    const modified = [...this.remote.modified.entries()].filter(([item]) => item.startsWith(`${sourcePath}/`));
    for (const item of directories) this.remote.directories.delete(item);
    for (const [item] of files) this.remote.files.delete(item);
    for (const [item] of modified) this.remote.modified.delete(item);
    for (const item of directories) this.remote.directories.add(`${targetPath}${item.slice(sourcePath.length)}`);
    for (const [item, value] of files) this.remote.files.set(`${targetPath}${item.slice(sourcePath.length)}`, value);
    for (const [item, value] of modified) this.remote.modified.set(`${targetPath}${item.slice(sourcePath.length)}`, value);
  }

  async replace(sourcePath, targetPath) {
    this.assertConnected();
    if (!this.remote.files.has(sourcePath)) throw Object.assign(new Error('missing'), { code: 2 });
    if (this.remote.directories.has(targetPath)) throw Object.assign(new Error('target is a directory'), { code: 4 });
    this.remote.files.set(targetPath, this.remote.files.get(sourcePath));
    this.remote.files.delete(sourcePath);
    if (this.remote.modified.has(sourcePath)) {
      this.remote.modified.set(targetPath, this.remote.modified.get(sourcePath));
      this.remote.modified.delete(sourcePath);
    }
  }

  async rmdir(remotePath) {
    this.assertConnected();
    if (![...this.remote.directories].includes(remotePath)) throw Object.assign(new Error('missing'), { code: 2 });
    if ([...this.remote.directories].some((item) => item.startsWith(`${remotePath}/`)) || [...this.remote.files.keys()].some((item) => item.startsWith(`${remotePath}/`))) throw Object.assign(new Error('not empty'), { code: 4 });
    this.remote.directories.delete(remotePath);
  }

  async readFile(remotePath, maximumBytes) {
    this.assertConnected();
    const value = this.remote.files.get(remotePath);
    if (!value) throw Object.assign(new Error('missing'), { code: 2 });
    if (value.length > maximumBytes) throw new Error('oversized');
    return Buffer.from(value);
  }

  async writeFile(remotePath, bytes, flags) {
    this.assertConnected();
    if (flags === 'wx' && this.remote.files.has(remotePath)) throw Object.assign(new Error('exists'), { code: 11 });
    this.remote.files.set(remotePath, Buffer.from(bytes));
    this.remote.modified.set(remotePath, 1785758400);
  }

  async readdir(remotePath) {
    this.assertConnected();
    const prefix = remotePath === '/' ? '/' : `${remotePath}/`;
    const entries = new Map();
    for (const directory of this.remote.directories) {
      if (!directory.startsWith(prefix) || directory === remotePath) continue;
      const remainder = directory.slice(prefix.length);
      if (remainder && !remainder.includes('/')) entries.set(remainder, { filename: remainder, attrs: { mode: 0o040700, size: 0, mtime: this.remote.modified.get(directory) || 1785758400 } });
    }
    for (const [filePath, value] of this.remote.files) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      if (remainder && !remainder.includes('/')) entries.set(remainder, { filename: remainder, attrs: { mode: 0o100600, size: value.length, mtime: this.remote.modified.get(filePath) || 1785758400 } });
    }
    return [...entries.values()];
  }

  async capacity() { this.assertConnected(); return this.remote.capacity; }
  async close() {}
}

function callbackOperation(callback, operation) {
  Promise.resolve().then(operation).then((value) => callback(null, value), (error) => callback(error));
}

class CallbackMemorySftp {
  constructor(remote) {
    this.remote = remote;
    this.session = new MemorySftpSession(remote);
  }

  lstat(remotePath, callback) {
    callbackOperation(callback, async () => {
      const result = await this.session.lstat(remotePath);
      if (!result) throw Object.assign(new Error('missing'), { code: 2 });
      return result;
    });
  }

  mkdir(remotePath, _attributes, callback) {
    callbackOperation(callback, () => this.session.mkdir(remotePath));
  }

  open(remotePath, flags, _mode, callback) {
    callbackOperation(callback, () => this.session.open(remotePath, flags));
  }

  write(handle, buffer, offset, length, position, callback) {
    const part = Buffer.from(buffer.subarray(offset, offset + length));
    const block = this.remote.callbackWriteBlock;
    if (block && !block.consumed) {
      block.consumed = true;
      const partialLength = Math.max(1, Math.floor(part.length / 2));
      writeRemoteBytes(this.remote, handle.path, part.subarray(0, partialLength), position);
      block.callback = callback;
      block.entered({ path: handle.path, partialBytes: partialLength, totalBytes: part.length });
      return;
    }
    callbackOperation(callback, () => this.session.write(handle, part, position));
  }

  close(_handle, callback) {
    callbackOperation(callback, async () => undefined);
  }

  ext_openssh_fsync(_handle, callback) {
    callbackOperation(callback, async () => undefined);
  }

  rename(sourcePath, targetPath, callback) {
    callbackOperation(callback, () => this.session.rename(sourcePath, targetPath));
  }

  unlink(remotePath, callback) {
    callbackOperation(callback, () => this.session.unlink(remotePath));
  }

  end() {}
}

async function seedRemoteFile(remote, remotePath, bytes) {
  const session = new MemorySftpSession(remote);
  await session.ensureDirectory(path.posix.dirname(remotePath));
  remote.files.set(remotePath, Buffer.from(bytes));
  remote.modified.set(remotePath, 1785758400);
}

function adapterFor(remote) {
  return new SftpRepositoryAdapter({ rootPath: '/srv/backups', connectionConfig: CONNECTION_CONFIG, resolveSecret: async () => 'password', sessionFactory: remote.sessionFactory, clock: () => '2026-08-03T12:00:00.000Z' });
}

async function put(adapter, key, body) {
  const bytes = Buffer.from(body);
  const checksum = { algorithm: 'sha256', digest: crypto.createHash('sha256').update(bytes).digest('hex') };
  const pending = await adapter.write({}, { key, body: bytes, sizeBytes: bytes.length, checksum });
  return adapter.commit({}, pending);
}

async function readObject(adapter, key) {
  const parts = [];
  for await (const part of await adapter.read({}, { key })) parts.push(part);
  return Buffer.concat(parts);
}

function fakeSecureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5),
    decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString('utf8')
  };
}

const SFTP_WORKSPACE_ID = 'workspace-sftp-file';
const SFTP_DEVICE_ID = 'device-sftp-file';
const SFTP_ACTOR_ID = 'sftp-file-test';

async function sftpFileWorkflowFixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-sftp-file-workflow-'));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
  await controlDatabase.initialize();
  context.after(async () => {
    await controlDatabase.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  const sourceRemote = new MemorySftpRemote();
  const repositoryRemote = new MemorySftpRemote({ capacity: { blocks: 1024 * 1024, bsize: 4096, bavail: 768 * 1024 } });
  const targetRemote = new MemorySftpRemote();
  const sourcePath = '/srv/application/data.bin';
  const payload = Buffer.concat([
    Buffer.from('authenticated SFTP file backup payload\n', 'utf8'),
    Buffer.alloc(MIN_CHUNK_SIZE_BYTES + 257, 0x51)
  ]);
  await seedRemoteFile(sourceRemote, sourcePath, payload);

  const sourceConnection = await controlDatabase.repository('connection').create({
    workspaceId: SFTP_WORKSPACE_ID,
    actorId: SFTP_ACTOR_ID,
    name: 'Protected server',
    kind: 'ssh',
    adapterId: 'deployerx.connection.ssh',
    adapterVersion: '1.0.0',
    endpoint: { host: 'source.example.com', port: 22, username: 'source', authType: 'password', timeoutMs: 1000 },
    secretRefIds: [],
    trust: { mode: 'pinned-sha256', fingerprint: 'SHA256:source', algorithm: 'ssh-ed25519' },
    workerAffinity: [`device:${SFTP_DEVICE_ID}`],
    lastTest: { status: 'success' }
  });
  const source = await controlDatabase.repository('source').create({
    workspaceId: SFTP_WORKSPACE_ID,
    actorId: SFTP_ACTOR_ID,
    name: 'Protected application files',
    connectionId: sourceConnection.id,
    sourceType: 'files',
    adapterId: 'deployerx.files.ssh',
    enabled: true,
    selector: {
      version: 1,
      kind: 'file-paths',
      roots: [{ path: '/srv/application', type: 'directory' }],
      includePatterns: ['**/*.bin'],
      excludePatterns: [],
      options: { includeHidden: false, crossMounts: false, followSymbolicLinks: false },
      metadataPolicy: { preserve: {} },
      digest: 'sftp-file-selection-digest'
    },
    platform: { os: 'linux', metadataCapabilities: {} }
  });
  const repositoryConnection = await controlDatabase.repository('connection').create({
    workspaceId: SFTP_WORKSPACE_ID,
    actorId: SFTP_ACTOR_ID,
    name: 'Repository server',
    kind: 'ssh',
    adapterId: 'deployerx.connection.ssh',
    adapterVersion: '1.0.0',
    endpoint: { host: CONNECTION_CONFIG.host, port: 22, username: 'backup', authType: 'password', timeoutMs: 1000 },
    secretRefIds: [],
    trust: { mode: 'pinned-sha256', fingerprint: CONNECTION_CONFIG.hostKeyFingerprint, algorithm: 'ssh-ed25519' },
    workerAffinity: [`device:${SFTP_DEVICE_ID}`],
    lastTest: { status: 'success' }
  });
  const repository = await controlDatabase.repository('repository').create({
    workspaceId: SFTP_WORKSPACE_ID,
    actorId: SFTP_ACTOR_ID,
    name: 'Encrypted SFTP archive',
    connectionId: repositoryConnection.id,
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    engineId: ENGINE_ID,
    engineVersion: ENGINE_VERSION,
    location: { path: '/srv/backups' },
    secretRefIds: [],
    encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'sftp-workflow-key-v1' },
    workerAffinity: [`device:${SFTP_DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const targetConnection = await controlDatabase.repository('connection').create({
    workspaceId: SFTP_WORKSPACE_ID,
    actorId: SFTP_ACTOR_ID,
    name: 'Recovery server',
    kind: 'ssh',
    adapterId: 'deployerx.connection.ssh',
    adapterVersion: '1.0.0',
    endpoint: { host: 'restore.example.com', port: 22, username: 'restore', authType: 'password', timeoutMs: 1000 },
    secretRefIds: [],
    trust: { mode: 'pinned-sha256', fingerprint: 'SHA256:restore', algorithm: 'ssh-ed25519' },
    workerAffinity: [`device:${SFTP_DEVICE_ID}`],
    lastTest: { status: 'success' }
  });

  let repositoryNow = Date.parse('2026-08-05T12:00:00.000Z');
  const repositoryClock = () => new Date(repositoryNow).toISOString();
  const repositoryAdapter = new SftpRepositoryAdapter({
    rootPath: '/srv/backups',
    connectionConfig: CONNECTION_CONFIG,
    resolveSecret: async () => 'unused-test-password',
    sessionFactory: repositoryRemote.sessionFactory,
    clock: repositoryClock
  });
  await repositoryAdapter.initialize();
  const repositoryEngine = new FileRepositoryEngine({ adapter: repositoryAdapter, clock: repositoryClock });
  const masterKey = Buffer.alloc(32, 0x73);
  await repositoryEngine.ensureRepository({}, { repositoryId: repository.id });

  const created = await new BackupJobService({ controlDatabase, deviceId: SFTP_DEVICE_ID }).create(SFTP_WORKSPACE_ID, SFTP_ACTOR_ID, {
    name: 'SFTP file protection',
    sourceId: source.id,
    repositoryIds: [repository.id],
    backupMode: 'full',
    verifyAfterBackup: true
  });
  const openRepository = async (workspaceId, repositoryId) => {
    assert.equal(workspaceId, SFTP_WORKSPACE_ID);
    assert.equal(repositoryId, repository.id);
    return {
      repository: await controlDatabase.repository('repository').get(workspaceId, repositoryId),
      adapter: repositoryAdapter,
      engine: repositoryEngine,
      masterKey,
      keyVersion: 'sftp-workflow-key-v1'
    };
  };
  const createRepositoryService = () => new SftpRepositoryService({
    controlDatabase,
    secretStore: { resolve: async () => masterKey.toString('base64') },
    deviceId: SFTP_DEVICE_ID,
    adapterFactory: (config) => new SftpRepositoryAdapter({ rootPath: config.rootPath, connectionConfig: CONNECTION_CONFIG, resolveSecret: config.resolveSecret, sessionFactory: repositoryRemote.sessionFactory, clock: repositoryClock }),
    clock: repositoryClock
  });
  const checkpointRoot = path.join(rootPath, 'checkpoints');
  const createManualService = () => new ManualBackupService({
    controlDatabase,
    sourceReader: new FileSourceReaderService({
      controlDatabase,
      secretStore: { resolve: async () => 'unused-test-password' },
      deviceId: SFTP_DEVICE_ID,
      openRemoteSession: sourceRemote.sessionFactory
    }),
    checkpointStore: new RunCheckpointStore({ rootPath: checkpointRoot }),
    deviceId: SFTP_DEVICE_ID,
    openRepository,
    clock: repositoryClock
  });
  const snapshotBrowser = new SnapshotBrowserService({ controlDatabase, openRepository });
  const createRestoreService = () => new FileRestoreService({
    controlDatabase,
    snapshotBrowser,
    deviceId: SFTP_DEVICE_ID,
    createTarget: () => new SftpRestoreTarget({ end() {} }, new CallbackMemorySftp(targetRemote)),
    clock: () => '2026-08-05T12:00:00.000Z'
  });

  return {
    controlDatabase,
    sourceRemote,
    repositoryRemote,
    targetRemote,
    sourcePath,
    payload,
    repository,
    targetConnection,
    job: created.job,
    createManualService,
    createRepositoryService,
    advanceRepositoryClock: (milliseconds) => { repositoryNow += Number(milliseconds); },
    createRestoreService,
    snapshotBrowser
  };
}

test('validates absolute POSIX repository paths', () => {
  assert.deepEqual(normalizeSftpRepositoryConfig({ rootPath: '/srv/backup/../archive' }), { rootPath: '/srv/archive' });
  assert.throws(() => normalizeSftpRepositoryConfig({ rootPath: 'relative/path' }), /absolute Linux path/);
});

test('verifies the pinned host key before resolving SSH SecretRefs', async () => {
  let resolutions = 0;
  class MismatchClient extends EventEmitter {
    connect(config) {
      queueMicrotask(() => {
        assert.equal(config.hostVerifier(Buffer.from('changed-host-key')), false);
        this.emit('error', Object.assign(new Error('host rejected'), { level: 'handshake' }));
      });
    }
    end() {}
  }
  await assert.rejects(openSftpSession({
    connectionConfig: CONNECTION_CONFIG,
    resolveSecret: async () => { resolutions += 1; return 'must-not-resolve'; },
    clientFactory: () => new MismatchClient()
  }), (error) => error.code === 'SSH_HOST_KEY_MISMATCH');
  assert.equal(resolutions, 0);
});

test('rejects an in-flight SFTP operation when the SSH transport is reset', async () => {
  let client;
  let sftp;
  class HangingSftp extends EventEmitter {
    constructor() {
      super();
      this._extensions = { 'hardlink@openssh.com': '1', 'fsync@openssh.com': '1' };
    }

    open(_remotePath, _flags, _mode, callback) { callback(null, { id: 'handle' }); }
    write() {}
    end() {}
  }
  class HangingClient extends EventEmitter {
    connect(config) {
      queueMicrotask(() => {
        assert.equal(config.hostVerifier(Buffer.from('approved-host-key')), true);
        this.emit('ready');
      });
    }

    sftp(callback) {
      sftp = new HangingSftp();
      callback(null, sftp);
    }

    end() {}
  }
  const session = await openSftpSession({
    connectionConfig: CONNECTION_CONFIG,
    resolveSecret: async () => 'unused-test-password',
    clientFactory: () => { client = new HangingClient(); return client; }
  });
  const pending = session.write({ id: 'handle' }, Buffer.from('partial'), 0);
  client.emit('error', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
  await assert.rejects(pending, (error) => error.code === 'ECONNRESET');
  assert.ok(sftp);
  session.close();
});

test('rejects an in-flight SFTP operation when the channel closes without an error event', async () => {
  let client;
  let sftp;
  class ClosingSftp extends EventEmitter {
    constructor() {
      super();
      this._extensions = { 'hardlink@openssh.com': '1' };
    }

    open(_remotePath, _flags, _mode, callback) { callback(null, { id: 'handle' }); }
    write() {}
    end() {}
  }
  class ClosingClient extends EventEmitter {
    connect(config) {
      queueMicrotask(() => {
        assert.equal(config.hostVerifier(Buffer.from('approved-host-key')), true);
        this.emit('ready');
      });
    }

    sftp(callback) {
      sftp = new ClosingSftp();
      callback(null, sftp);
    }

    end() {}
  }
  const session = await openSftpSession({
    connectionConfig: CONNECTION_CONFIG,
    resolveSecret: async () => 'unused-test-password',
    clientFactory: () => { client = new ClosingClient(); return client; }
  });
  const pending = session.write({ id: 'handle' }, Buffer.from('partial'), 0);
  sftp.emit('exit');
  await assert.rejects(pending, (error) => error.code === 'ECONNRESET');
  assert.ok(client);
  session.close();
});

test('bounds a hung SFTP operation by the repository operation deadline', async () => {
  class TimeoutSftp extends EventEmitter {
    constructor() {
      super();
      this._extensions = { 'hardlink@openssh.com': '1' };
    }

    open(_remotePath, _flags, _mode, callback) { callback(null, { id: 'handle' }); }
    write() {}
    end() {}
  }
  class TimeoutClient extends EventEmitter {
    connect(config) {
      queueMicrotask(() => {
        assert.equal(config.hostVerifier(Buffer.from('approved-host-key')), true);
        this.emit('ready');
      });
    }

    sftp(callback) { callback(null, new TimeoutSftp()); }
    end() {}
  }
  const session = await openSftpSession({
    connectionConfig: CONNECTION_CONFIG,
    resolveSecret: async () => 'unused-test-password',
    clientFactory: () => new TimeoutClient()
  });
  await assert.rejects(session.write({ id: 'handle' }, Buffer.from('partial'), 0), (error) => error.code === 'ETIMEDOUT');
  session.close();
});

test('commits immutable remote objects, paginates, copies, deletes, and reports capacity', async () => {
  const remote = new MemorySftpRemote();
  const adapter = adapterFor(remote);
  const first = await put(adapter, 'chunks/v1/aa/one.dxb', Buffer.from('one'));
  assert.equal(first.existing, false);
  assert.equal((await put(adapter, first.key, Buffer.from('one'))).existing, true);
  const conflicting = Buffer.from('different');
  const checksum = { algorithm: 'sha256', digest: crypto.createHash('sha256').update(conflicting).digest('hex') };
  const pending = await adapter.write({}, { key: first.key, body: conflicting, sizeBytes: conflicting.length, checksum });
  await assert.rejects(adapter.commit({}, pending), (error) => error.code === 'SFTP_REPOSITORY_OBJECT_CONFLICT');
  await adapter.abort({}, pending);

  await put(adapter, 'chunks/v1/bb/two.dxb', Buffer.from('two'));
  const firstPage = (await adapter.list({}, { prefix: 'chunks/', pageSize: 1 }).next()).value;
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.hasMore, true);
  const secondPage = (await adapter.list({}, { prefix: 'chunks/', pageSize: 1, cursor: firstPage.nextCursor }).next()).value;
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.hasMore, false);
  await adapter.copy({}, { sourceKey: first.key, targetKey: 'indexes/v1/copied.dxb' });
  assert.deepEqual(await readObject(adapter, 'indexes/v1/copied.dxb'), Buffer.from('one'));
  assert.equal((await adapter.delete({}, { key: 'indexes/v1/copied.dxb' })).deleted, true);
  assert.equal((await adapter.delete({}, { key: 'indexes/v1/copied.dxb' })).absent, true);
  assert.deepEqual(await adapter.getCapacity(), { reporting: 'exact', totalBytes: 4096000, freeBytes: 2457600, usedBytes: 1638400, measuredAt: '2026-08-03T12:00:00.000Z' });
});

test('coordinates encrypted SFTP leases across remote sessions', async () => {
  const remote = new MemorySftpRemote();
  const masterKey = crypto.randomBytes(32);
  let now = Date.parse('2026-08-03T12:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  const first = adapterFor(remote);
  const second = adapterFor(remote);
  first.clock = clock;
  second.clock = clock;
  const request = { repositoryId: 'repo-sftp', operation: 'backup', workerId: 'worker-a', runId: 'run-a', ttlMs: 5000 };
  const lease = await first.acquireLock({ masterKey }, request);
  await assert.rejects(second.acquireLock({ masterKey }, { ...request, workerId: 'worker-b', runId: 'run-b' }), (error) => error.code === 'REPOSITORY_LOCK_CONTENDED');
  now += 1000;
  const renewed = await first.renewLock({ masterKey }, lease);
  assert.equal(Date.parse(renewed.expiresAt), now + 5000);
  assert.deepEqual(await first.releaseLock({ masterKey }, renewed), { released: true, absent: false });
  const replacement = await second.acquireLock({ masterKey }, { ...request, workerId: 'worker-b', runId: 'run-b' });
  now += 6000;
  const takeover = await first.acquireLock({ masterKey }, { ...request, workerId: 'worker-c', runId: 'run-c' });
  assert.notEqual(takeover.leaseId, replacement.leaseId);
  assert.deepEqual(await first.releaseLock({ masterKey }, takeover), { released: true, absent: false });
});

test('maps an empty-message OpenSSH status-4 lock rename to contention', async () => {
  const remote = new MemorySftpRemote({ genericExistsStatus: true });
  const masterKey = crypto.randomBytes(32);
  const first = adapterFor(remote);
  const second = adapterFor(remote);
  const request = { repositoryId: 'repo-sftp', operation: 'backup', workerId: 'worker-a', runId: 'run-a', ttlMs: 5000 };
  const lease = await first.acquireLock({ masterKey }, request);
  await assert.rejects(
    second.acquireLock({ masterKey }, { ...request, workerId: 'worker-b', runId: 'run-b' }),
    (error) => error.code === 'REPOSITORY_LOCK_CONTENDED'
  );
  await first.releaseLock({ masterKey }, lease);
});

test('fresh SFTP adapter takes over after dead owner, reconciles only stale generated staging files, and preserves ownership fencing', async () => {
  const remote = new MemorySftpRemote();
  const masterKey = crypto.randomBytes(32);
  let now = Date.parse('2026-08-03T12:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  const createAdapter = () => new SftpRepositoryAdapter({
    rootPath: '/srv/backups', connectionConfig: CONNECTION_CONFIG,
    resolveSecret: async () => 'password', sessionFactory: remote.sessionFactory, clock
  });
  const first = createAdapter();
  const second = createAdapter();
  const request = { repositoryId: 'repo-sftp', operation: 'backup', workerId: 'worker-a', runId: 'run-a', ttlMs: 5000 };
  const lease = await first.acquireLock({ masterKey }, request);
  const lockScopeId = crypto.createHash('sha256').update(lease.scope).digest('hex');
  const interruptedLeaseUpdate = `/srv/backups/.deployerx-repository/locks/${lockScopeId}/lease.dxl.update-12345678-1234-4123-8123-123456789abc`;
  await seedRemoteFile(remote, interruptedLeaseUpdate, Buffer.from('partial lease update'));
  const interruption = remote.blockNextPromiseWrite({ disconnectOnFail: true });
  const body = Buffer.from('orphaned staged bytes');
  const checksum = { algorithm: 'sha256', digest: crypto.createHash('sha256').update(body).digest('hex') };
  const writing = first.write({}, { key: 'chunks/v1/orphan.dxb', body, sizeBytes: body.length, checksum });
  const stage = await interruption.entered;
  assert.equal(remote.files.get(stage.path).length, stage.partialBytes);
  interruption.fail(Object.assign(new Error('Simulated terminated SFTP channel.'), { code: 'ECONNRESET' }));
  await assert.rejects(writing, (error) => error.code === 'SFTP_REPOSITORY_WRITE_FAILED');
  assert.equal(remote.files.has(stage.path), true);
  assert.equal([...remote.files.keys()].some((item) => item.includes('/objects/')), false);

  await seedRemoteFile(remote, '/srv/backups/.deployerx-repository/staging/.probe-keep', Buffer.from('keep'));
  await seedRemoteFile(remote, '/srv/backups/.deployerx-repository/staging/.not-a-generated-temp.tmp', Buffer.from('keep'));
  now += LOCK_RECOVERY_GRACE_MS + 1000;
  const youngStage = '/srv/backups/.deployerx-repository/staging/.12345678-1234-4123-8123-123456789abc.tmp';
  await seedRemoteFile(remote, youngStage, Buffer.from('young'));
  remote.modified.set(youngStage, Math.floor(now / 1000));
  const replacement = await second.acquireLock({ masterKey }, { ...request, workerId: 'worker-b', runId: 'run-b' });
  await assert.rejects(first.renewLock({ masterKey }, lease), (error) => error.code === 'REPOSITORY_LOCK_LOST');
  const reconciled = await second.reconcileStaging({ masterKey }, { lease: replacement, minimumAgeMs: 1 });
  assert.equal(reconciled.removed.includes(path.posix.basename(stage.path)), true);
  assert.equal(remote.files.has(stage.path), false);
  assert.equal(remote.files.has(interruptedLeaseUpdate), false);
  assert.equal(remote.files.has('/srv/backups/.deployerx-repository/staging/.probe-keep'), true);
  assert.equal(remote.files.has('/srv/backups/.deployerx-repository/staging/.not-a-generated-temp.tmp'), true);
  assert.equal(remote.files.has(youngStage), true);
  await second.releaseLock({ masterKey }, replacement);
});

test('recovers only aged empty or short lock initialization records', async () => {
  const remote = new MemorySftpRemote();
  const masterKey = crypto.randomBytes(32);
  let now = Date.parse('2026-08-03T12:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  const adapter = new SftpRepositoryAdapter({
    rootPath: '/srv/backups', connectionConfig: CONNECTION_CONFIG,
    resolveSecret: async () => 'password', sessionFactory: remote.sessionFactory, clock
  });
  const session = new MemorySftpSession(remote);
  await adapter.initialize();
  const scope = 'repository:repo-sftp:mutation';
  const scopeId = crypto.createHash('sha256').update(scope).digest('hex');
  const lockDirectory = `/srv/backups/.deployerx-repository/locks/${scopeId}`;
  const leasePath = `${lockDirectory}/lease.dxl`;
  await session.mkdir(lockDirectory);
  await assert.rejects(adapter.acquireLock({ masterKey }, { repositoryId: 'repo-sftp', operation: 'backup', scope, workerId: 'worker-a', runId: 'run-a', ttlMs: 5000 }), (error) => error.code === 'REPOSITORY_LOCK_CONTENDED');
  now += LOCK_RECOVERY_GRACE_MS + 1;
  const recoveredEmpty = await adapter.acquireLock({ masterKey }, { repositoryId: 'repo-sftp', operation: 'backup', scope, workerId: 'worker-b', runId: 'run-b', ttlMs: 5000 });
  await adapter.releaseLock({ masterKey }, recoveredEmpty);

  await session.mkdir(lockDirectory);
  remote.files.set(leasePath, Buffer.from('partial'));
  remote.modified.set(leasePath, 1785758400);
  const recoveredPartial = await adapter.acquireLock({ masterKey }, { repositoryId: 'repo-sftp', operation: 'backup', scope, workerId: 'worker-c', runId: 'run-c', ttlMs: 5000 });
  assert.equal(recoveredPartial.workerId, 'worker-c');
  await adapter.releaseLock({ masterKey }, recoveredPartial);

  await session.mkdir(lockDirectory);
  remote.files.set(leasePath, Buffer.alloc(64, 0x7f));
  remote.modified.set(leasePath, 1785758400);
  await assert.rejects(adapter.acquireLock({ masterKey }, { repositoryId: 'repo-sftp', operation: 'backup', scope, workerId: 'worker-d', runId: 'run-d', ttlMs: 5000 }), (error) => error.code === 'REPOSITORY_LOCK_INVALID');
});

test('refuses SFTP servers that cannot provide atomic immutable commits', async () => {
  const adapter = adapterFor(new MemorySftpRemote({ hardlink: false }));
  await assert.rejects(adapter.initialize(), (error) => error.code === 'SFTP_REPOSITORY_ATOMIC_COMMIT_UNAVAILABLE' && error.category === 'compatibility');
});

test('runs the encrypted repository engine over SFTP object storage', async () => {
  const remote = new MemorySftpRemote();
  const adapter = adapterFor(remote);
  const engine = new FileRepositoryEngine({ adapter, clock: () => '2026-08-03T12:00:00.000Z' });
  const masterKey = Buffer.alloc(32, 0x52);
  const content = Buffer.concat([Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x19), Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x19)]);
  const snapshot = await engine.createSnapshot({}, {
    repositoryId: 'repo-sftp', keyVersion: 'secret:1', masterKey, idempotencyKey: 'sftp-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES,
    files: [{ path: '/remote/private.txt', type: 'file', metadata: null, content }]
  });
  assert.equal(snapshot.uploadedChunkCount, 1);
  const reopened = new FileRepositoryEngine({ adapter: adapterFor(remote) });
  const opened = await reopened.openSnapshot({}, { repositoryId: 'repo-sftp', snapshotId: snapshot.snapshotId, masterKey });
  assert.deepEqual(await reopened.readFile({}, { repositoryId: 'repo-sftp', manifest: opened.manifest, path: '/remote/private.txt', masterKey }), content);
  const stored = Buffer.concat([...remote.files.values()]);
  assert.equal(stored.includes(Buffer.from('/remote/private.txt')), false);
});

test('backs up an SFTP file source into an encrypted SFTP repository and restores it to SFTP', async (context) => {
  const value = await sftpFileWorkflowFixture(context);
  const manual = value.createManualService();
  const started = await manual.start(SFTP_WORKSPACE_ID, SFTP_ACTOR_ID, value.job.id);
  await manual.wait(started.id);
  const completed = await value.controlDatabase.repository('run').get(SFTP_WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'warning');
  assert.equal(completed.result.warnings.some((warning) => warning.code === 'SSH_MOUNT_BOUNDARY_UNAVAILABLE'), true);

  const [point] = await value.controlDatabase.repository('recoveryPoint').list(SFTP_WORKSPACE_ID);
  const [artifact] = await value.controlDatabase.repository('artifact').list(SFTP_WORKSPACE_ID);
  assert.equal(point.repositoryCopies[0].repositoryId, value.repository.id);
  assert.equal(artifact.recoveryPointId, point.id);
  assert.equal(artifact.repositoryId, value.repository.id);
  const repositoryBytes = Buffer.concat([...value.repositoryRemote.files.values()]);
  assert.equal(repositoryBytes.includes(value.payload), false);

  const restore = value.createRestoreService();
  const destinationPath = '/restore/complete';
  const restoredPath = path.posix.join(destinationPath, value.sourcePath.slice(1));
  const restoreStarted = await restore.start(SFTP_WORKSPACE_ID, SFTP_ACTOR_ID, {
    recoveryPointId: point.id,
    targetConnectionId: value.targetConnection.id,
    mode: 'alternate',
    destinationPath,
    conflictPolicy: 'fail',
    paths: [value.sourcePath]
  });
  const restored = await restore.wait(SFTP_WORKSPACE_ID, restoreStarted.id);
  assert.equal(restored.state, 'succeeded');
  assert.equal(restored.result.bytesRestored, value.payload.length);
  assert.deepEqual(value.targetRemote.files.get(restoredPath), value.payload);
  assert.equal([...value.targetRemote.files.keys()].some((item) => item.includes('.deployerx-stage-')), false);
});

test('reconciles interrupted SFTP backup and restore transfers without partial publication and retries safely', async (context) => {
  const value = await sftpFileWorkflowFixture(context);
  const originalManual = value.createManualService();
  const repositoryInterruption = value.repositoryRemote.blockNextPromiseWrite();
  const started = await originalManual.start(SFTP_WORKSPACE_ID, SFTP_ACTOR_ID, value.job.id);
  const repositoryStage = await repositoryInterruption.entered;
  assert.match(repositoryStage.path, /\/\.deployerx-repository\/staging\/\.[^.]+\.tmp$/);
  assert.equal(value.repositoryRemote.files.get(repositoryStage.path).length, repositoryStage.partialBytes);

  const restartedManual = value.createManualService();
  const reconciledBackups = await restartedManual.reconcile(SFTP_WORKSPACE_ID, 'restart-reconciler', { force: true });
  assert.equal(reconciledBackups.length, 1);
  assert.equal(reconciledBackups[0].id, started.id);
  assert.equal(reconciledBackups[0].state, 'interrupted');
  assert.equal(reconciledBackups[0].result.safeErrorCode, 'BACKUP_RUN_PROCESS_INTERRUPTED');
  assert.equal((await value.controlDatabase.repository('recoveryPoint').list(SFTP_WORKSPACE_ID)).length, 0);
  assert.equal((await value.controlDatabase.repository('artifact').list(SFTP_WORKSPACE_ID)).length, 0);
  assert.equal([...value.repositoryRemote.files.keys()].some((item) => item.includes('/objects/manifests/')), false);

  // The original worker is intentionally left pending. A genuinely fresh
  // repository service takes over only after the mutation lease expires and
  // removes the orphan without relying on the old worker's cleanup path.
  value.advanceRepositoryClock(LOCK_RECOVERY_GRACE_MS + 1000);
  const reconciledRepository = await value.createRepositoryService().reconcile(SFTP_WORKSPACE_ID, 'restart-reconciler');
  assert.equal(reconciledRepository.repositories.length, 1);
  assert.equal(reconciledRepository.repositories[0].status, 'reconciled');
  assert.equal(reconciledRepository.repositories[0].removedCount, 1);
  assert.equal(reconciledRepository.repositories[0].leaseReleased, true);
  assert.equal(value.repositoryRemote.files.has(repositoryStage.path), false);

  repositoryInterruption.fail(Object.assign(new Error('Simulated terminated SFTP repository channel.'), { code: 'ECONNRESET' }));
  await originalManual.wait(started.id);
  assert.equal(value.repositoryRemote.files.has(repositoryStage.path), false);
  assert.equal((await value.controlDatabase.repository('recoveryPoint').list(SFTP_WORKSPACE_ID)).length, 0);

  const resumed = await restartedManual.resume(SFTP_WORKSPACE_ID, SFTP_ACTOR_ID, started.id);
  await restartedManual.wait(resumed.id);
  const completed = await value.controlDatabase.repository('run').get(SFTP_WORKSPACE_ID, resumed.id);
  assert.equal(completed.state, 'warning');
  assert.equal(completed.result.warnings.some((warning) => warning.code === 'SSH_MOUNT_BOUNDARY_UNAVAILABLE'), true);
  assert.equal(completed.parentRunId, started.id);
  assert.equal(completed.attempt, 2);
  const [point] = await value.controlDatabase.repository('recoveryPoint').list(SFTP_WORKSPACE_ID);
  assert.ok(point);
  assert.equal((await value.controlDatabase.repository('artifact').list(SFTP_WORKSPACE_ID)).length, 1);

  const destinationPath = '/restore/after-interruption';
  const restoredPath = path.posix.join(destinationPath, value.sourcePath.slice(1));
  const restoreRequest = {
    recoveryPointId: point.id,
    targetConnectionId: value.targetConnection.id,
    mode: 'alternate',
    destinationPath,
    conflictPolicy: 'fail',
    paths: [value.sourcePath]
  };
  const originalRestore = value.createRestoreService();
  const targetInterruption = value.targetRemote.blockNextCallbackWrite();
  const restoreStarted = await originalRestore.start(SFTP_WORKSPACE_ID, SFTP_ACTOR_ID, restoreRequest);
  const targetStage = await targetInterruption.entered;
  assert.match(targetStage.path, /\.deployerx-stage-/);
  assert.equal(value.targetRemote.files.get(targetStage.path).length, targetStage.partialBytes);
  assert.equal(value.targetRemote.files.has(restoredPath), false);

  const restartedRestore = value.createRestoreService();
  const reconciledRestores = await restartedRestore.reconcile(SFTP_WORKSPACE_ID, 'restart-reconciler');
  assert.equal(reconciledRestores.length, 1);
  assert.equal(reconciledRestores[0].id, restoreStarted.id);
  assert.equal(reconciledRestores[0].state, 'failed');
  assert.equal(reconciledRestores[0].result.error.code, 'RESTORE_PROCESS_INTERRUPTED');
  assert.equal(value.targetRemote.files.has(restoredPath), false);

  targetInterruption.fail(Object.assign(new Error('Simulated terminated SFTP restore channel.'), { code: 'ECONNRESET' }));
  await originalRestore.wait(SFTP_WORKSPACE_ID, restoreStarted.id);
  assert.equal(value.targetRemote.files.has(targetStage.path), false);
  assert.equal(value.targetRemote.files.has(restoredPath), false);

  const retryStarted = await restartedRestore.start(SFTP_WORKSPACE_ID, SFTP_ACTOR_ID, restoreRequest);
  const retried = await restartedRestore.wait(SFTP_WORKSPACE_ID, retryStarted.id);
  assert.equal(retried.state, 'succeeded');
  assert.equal(retried.result.bytesRestored, value.payload.length);
  assert.deepEqual(value.targetRemote.files.get(restoredPath), value.payload);
  assert.equal([...value.targetRemote.files.keys()].some((item) => item.includes('.deployerx-stage-')), false);
});

test('persists SFTP repositories against saved SSH connections and retains remote data and keys', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-sftp-repository-service-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control'), clock: () => '2026-08-03T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: fakeSecureStorage(), isReferenced: async () => true });
  await secretStore.initialize();
  const credentialRef = await secretStore.create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'SSH password', secretType: 'password', value: 'password', scope: 'device' });
  const connection = await controlDatabase.transaction((transaction) => {
    transaction.create('secretRef', { ...credentialRef, actorId: 'tester' });
    return transaction.create('connection', {
      workspaceId: 'workspace-a', actorId: 'tester', name: 'Archive server', kind: 'ssh', adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0', scope: 'device',
      endpoint: { host: CONNECTION_CONFIG.host, port: 22, username: 'backup', authType: 'password', timeoutMs: 1000 }, secretRefIds: [credentialRef.id],
      trust: { mode: 'pinned-sha256', fingerprint: CONNECTION_CONFIG.hostKeyFingerprint, algorithm: 'ssh-ed25519', approvedAt: '2026-08-03T12:00:00.000Z', approvedBy: 'tester' },
      workerAffinity: ['device:device-a'], lastTest: null
    });
  });
  const remote = new MemorySftpRemote();
  const service = new SftpRepositoryService({
    controlDatabase, secretStore, deviceId: 'device-a', clock: () => '2026-08-03T12:00:00.000Z',
    adapterFactory: (config) => new SftpRepositoryAdapter({ ...config, sessionFactory: remote.sessionFactory })
  });
  const repository = await service.create('workspace-a', 'tester', { name: 'Remote archive', connectionId: connection.id, rootPath: '/srv/backups' });
  const secondaryRepository = await service.create('workspace-a', 'tester', { name: 'Weekly archive', connectionId: connection.id, rootPath: '/srv/weekly' });
  assert.equal(repository.adapterId, ADAPTER_ID);
  assert.equal(repository.connectionId, connection.id);
  assert.equal(secondaryRepository.connectionId, connection.id);
  assert.notEqual(secondaryRepository.location.path, repository.location.path);
  assert.equal(repository.health.status, 'ready');
  assert.match(repository.encryptionKeyRefId, /^sec_/);
  assert.equal((await service.list('workspace-a')).length, 2);
  assert.ok((await service.list('workspace-a')).every((destination) => destination.connectionName === 'Archive server'));
  assert.deepEqual(await service.list('workspace-b'), []);

  const opened = await service.open('workspace-a', repository.id);
  assert.equal(opened.masterKey.length, 32);
  const healthCheck = await service.test('workspace-a', 'tester', repository.id);
  assert.equal(healthCheck.repository.health.status, 'ready');
  assert.equal(healthCheck.lockState.status, 'available');
  assert.equal(healthCheck.capacity.reporting, 'exact');
  const removed = await service.remove('workspace-a', 'tester', repository.id, healthCheck.repository.revision);
  assert.equal(removed.dataRetainedAt, '/srv/backups');
  assert.equal(removed.encryptionKeyRetained, true);
  assert.equal(remote.files.size > 0, true);
  assert.equal((await secretStore.list('workspace-a')).some((ref) => ref.id === repository.encryptionKeyRefId), true);
  assert.equal((await service.list('workspace-a')).length, 1);
  await service.remove('workspace-a', 'tester', secondaryRepository.id, secondaryRepository.revision);
});

test('fresh SFTP repository service reconciles aged staging after contention and retries safely', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-sftp-reconcile-service-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  let now = Date.parse('2026-08-03T12:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control'), clock });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: fakeSecureStorage(), isReferenced: async () => true });
  await secretStore.initialize();
  const credentialRef = await secretStore.create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'SSH password', secretType: 'password', value: 'password', scope: 'device' });
  const connection = await controlDatabase.transaction((transaction) => {
    transaction.create('secretRef', { ...credentialRef, actorId: 'tester' });
    return transaction.create('connection', {
      workspaceId: 'workspace-a', actorId: 'tester', name: 'Reconcile server', kind: 'ssh', adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0', scope: 'device',
      endpoint: { host: CONNECTION_CONFIG.host, port: 22, username: 'backup', authType: 'password', timeoutMs: 1000 }, secretRefIds: [credentialRef.id],
      trust: { mode: 'pinned-sha256', fingerprint: CONNECTION_CONFIG.hostKeyFingerprint, algorithm: 'ssh-ed25519', approvedAt: clock(), approvedBy: 'tester' },
      workerAffinity: ['device:device-a'], lastTest: null
    });
  });
  const remote = new MemorySftpRemote();
  const createService = () => new SftpRepositoryService({
    controlDatabase, secretStore, deviceId: 'device-a', clock,
    adapterFactory: (config) => new SftpRepositoryAdapter({ ...config, sessionFactory: remote.sessionFactory })
  });
  const repository = await createService().create('workspace-a', 'tester', { name: 'Reconciled archive', connectionId: connection.id, rootPath: '/srv/backups' });
  const opened = await createService().open('workspace-a', repository.id);
  const contender = new SftpRepositoryAdapter({ rootPath: '/srv/backups', connectionConfig: CONNECTION_CONFIG, resolveSecret: async () => 'password', sessionFactory: remote.sessionFactory, clock });
  const activeLease = await contender.acquireLock({ masterKey: opened.masterKey }, {
    repositoryId: repository.id, operation: 'backup', scope: `repository:${repository.id}:mutation`,
    workerId: 'device:device-a', runId: 'active-backup', ttlMs: LOCK_RECOVERY_GRACE_MS
  });
  const oldStage = '/srv/backups/.deployerx-repository/staging/.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp';
  const youngStage = '/srv/backups/.deployerx-repository/staging/.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.tmp';
  const retained = '/srv/backups/.deployerx-repository/staging/operator-note.tmp';
  await seedRemoteFile(remote, oldStage, Buffer.from('old'));
  await seedRemoteFile(remote, youngStage, Buffer.from('young'));
  await seedRemoteFile(remote, retained, Buffer.from('keep'));

  const contended = await createService().reconcile('workspace-a', 'restart-reconciler');
  assert.equal(contended.repositories.length, 1);
  assert.equal(contended.repositories[0].status, 'skipped');
  assert.equal(contended.repositories[0].reason, 'lease-contended');
  assert.equal(remote.files.has(oldStage), true);
  assert.equal(JSON.stringify(contended).includes(oldStage), false);

  await contender.releaseLock({ masterKey: opened.masterKey }, activeLease);
  now += LOCK_RECOVERY_GRACE_MS + 1000;
  remote.modified.set(youngStage, Math.floor(now / 1000));
  const reconciled = await createService().reconcile('workspace-a', 'restart-reconciler');
  assert.equal(reconciled.minimumAgeMs, LOCK_RECOVERY_GRACE_MS);
  assert.equal(reconciled.repositories[0].status, 'reconciled');
  assert.equal(reconciled.repositories[0].removedCount, 1);
  assert.equal(reconciled.repositories[0].leaseReleased, true);
  assert.equal(remote.files.has(oldStage), false);
  assert.equal(remote.files.has(youngStage), true);
  assert.equal(remote.files.has(retained), true);

  const retried = await createService().reconcile('workspace-a', 'restart-reconciler');
  assert.equal(retried.repositories[0].status, 'reconciled');
  assert.equal(retried.repositories[0].removedCount, 0);
  assert.equal(retried.repositories[0].leaseReleased, true);
});
