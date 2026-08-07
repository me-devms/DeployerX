const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ACCESS_PROTOCOL_VERSION = 1;
const MAX_CONTROL_FRAME_BYTES = 8 * 1024;
const MAX_HANDOFF_BYTES = 256 * 1024;
const SUPPORTED_ACCESS_DRIVERS = Object.freeze(['postgresql', 'mysql', 'sqlite']);
const APPROVED_ACCESS_THEME_IDS = Object.freeze([
  'deployerx-light',
  'termius-dark',
  'tokyo-day',
  'catppuccin-mocha',
  'gruvbox-dark',
  'solarized-light'
]);
const SAFE_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR'
]);
const COMPANION_BINARY_NAME = 'deployerx-db-access-manager.exe';

class DatabaseAccessCompanionError extends Error {
  constructor(code, safeMessage, { retryable = false } = {}) {
    super(safeMessage);
    this.name = 'DatabaseAccessCompanionError';
    this.code = code;
    this.safeMessage = safeMessage;
    this.category = 'database-manager';
    this.retryable = retryable;
  }
}

function accessError(code, safeMessage, options) {
  return new DatabaseAccessCompanionError(code, safeMessage, options);
}

function requiredProfileId(value) {
  const profileId = String(value ?? '').trim();
  if (!profileId || profileId.length > 200 || profileId.includes('\0')) {
    throw accessError('DATABASE_ACCESS_PROFILE_INVALID', 'The database profile is invalid.');
  }
  return profileId;
}

function requiredContextId(value, label) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 200 || id.includes('\0')) {
    throw accessError('DATABASE_ACCESS_CONTEXT_INVALID', `The database ${label} is invalid.`);
  }
  return id;
}

function sessionKey(workspaceId, actorId, profileId) {
  return JSON.stringify([workspaceId, actorId, profileId]);
}

function boundedMilliseconds(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function createSafeEnvironment(source = process.env) {
  const safeEnvironment = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase()) && typeof value === 'string') {
      safeEnvironment[key] = value;
    }
  }
  return safeEnvironment;
}

function createWindowsPipeName(randomBytes = crypto.randomBytes) {
  const token = randomBytes(32);
  if (!Buffer.isBuffer(token) || token.length < 32) {
    throw accessError('DATABASE_ACCESS_PIPE_CREATE_FAILED', 'DB Access Manager could not create a secure connection channel.');
  }
  return `\\\\.\\pipe\\deployerx-db-access-${token.toString('hex')}`;
}

function resolveDatabaseAccessCompanionExecutablePath({ isPackaged, resourcesPath, appPath } = {}) {
  const basePath = String(isPackaged ? resourcesPath : appPath || '').trim();
  if (!basePath || basePath.includes('\0')) {
    throw new TypeError('DB Access Manager requires a valid application path.');
  }
  const stagedPath = isPackaged
    ? path.join(basePath, 'db-access-manager', COMPANION_BINARY_NAME)
    : path.join(basePath, 'native', 'dist', 'deployerx-db-access-manager', 'win32-x64', COMPANION_BINARY_NAME);
  if (isPackaged) return stagedPath;

  const developmentCandidates = [
    stagedPath,
    path.join(basePath, 'DeployerX DB Manager', 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', COMPANION_BINARY_NAME),
    path.join(basePath, 'DeployerX DB Manager', 'src-tauri', 'target', 'release', COMPANION_BINARY_NAME),
    path.join(basePath, 'DeployerX DB Manager', 'src-tauri', 'target', 'debug', COMPANION_BINARY_NAME)
  ];
  return developmentCandidates.find((candidate) => {
    try {
      const stats = fs.lstatSync(candidate);
      return stats.isFile() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }) || stagedPath;
}

function normalizeAccessThemeId(value) {
  const themeId = String(value || '').trim();
  return APPROVED_ACCESS_THEME_IDS.includes(themeId) ? themeId : 'deployerx-light';
}

function boundedProfileName(value) {
  const profileName = String(value ?? '').trim();
  if (!profileName || profileName.length > 120 || profileName.includes('\0')) {
    throw accessError('DATABASE_ACCESS_PREPARATION_INVALID', 'The database connection could not be prepared for DB Access Manager.');
  }
  return profileName;
}

function normalizePreparedConnection(prepared, profileId, maximumBytes) {
  if (!prepared || typeof prepared !== 'object') {
    throw accessError('DATABASE_ACCESS_PREPARATION_INVALID', 'The database connection could not be prepared for DB Access Manager.');
  }
  if (!SUPPORTED_ACCESS_DRIVERS.includes(prepared.driverId)) {
    throw accessError('DATABASE_ACCESS_DRIVER_UNSUPPORTED', 'DB Access Manager does not support this database driver yet.');
  }
  if (typeof prepared.readOnly !== 'boolean') {
    throw accessError('DATABASE_ACCESS_PREPARATION_INVALID', 'The database connection could not be prepared for DB Access Manager.');
  }
  if (!prepared.connection || typeof prepared.connection !== 'object' || Array.isArray(prepared.connection)) {
    throw accessError('DATABASE_ACCESS_PREPARATION_INVALID', 'The database connection could not be prepared for DB Access Manager.');
  }

  let payloadLine;
  try {
    payloadLine = `${JSON.stringify({
      protocolVersion: ACCESS_PROTOCOL_VERSION,
      type: 'deployerx.db-access.connection',
      profileId,
      profileName: boundedProfileName(prepared.profileName),
      driverId: prepared.driverId,
      readOnly: prepared.readOnly,
      themeId: normalizeAccessThemeId(prepared.themeId),
      connection: prepared.connection
    })}\n`;
  } catch {
    throw accessError('DATABASE_ACCESS_PREPARATION_INVALID', 'The database connection could not be prepared for DB Access Manager.');
  }

  if (payloadLine === undefined || Buffer.byteLength(payloadLine, 'utf8') > maximumBytes) {
    throw accessError('DATABASE_ACCESS_HANDOFF_TOO_LARGE', 'The database connection settings are too large for DB Access Manager.');
  }
  return Buffer.from(payloadLine, 'utf8');
}

function scrubCredentialRecord(record) {
  if (!record || typeof record !== 'object') return;
  for (const key of Object.keys(record)) {
    if (Buffer.isBuffer(record[key])) record[key].fill(0);
    try {
      record[key] = '';
    } catch {
      // Best-effort overwrite for caller-owned objects that may be frozen.
    }
  }
}

function scrubPreparedConnection(prepared) {
  scrubCredentialRecord(prepared?.credentials);
  scrubCredentialRecord(prepared?.connection?.credentials);
}

function safeResult(profileId, state) {
  return Object.freeze({ profileId, state });
}

function isExpectedFrame(frame, type) {
  return frame
    && typeof frame === 'object'
    && frame.protocolVersion === ACCESS_PROTOCOL_VERSION
    && frame.type === type;
}

function parseControlFrame(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw accessError('DATABASE_ACCESS_HANDSHAKE_INVALID', 'DB Access Manager returned an invalid connection response.');
  }
}

class DatabaseAccessCompanionService {
  constructor({
    executablePath,
    prepareConnection,
    cleanupConnection,
    focusExisting = null,
    fileExists = (filePath) => {
      try {
        const stats = fs.lstatSync(filePath);
        return stats.isFile() && !stats.isSymbolicLink();
      } catch {
        return false;
      }
    },
    spawn = childProcess.spawn,
    createServer = net.createServer,
    randomBytes = crypto.randomBytes,
    environment = process.env,
    platform = process.platform,
    launchTimeoutMs = 15000,
    handshakeTimeoutMs = 5000,
    maximumHandoffBytes = MAX_HANDOFF_BYTES,
    onStateChange = () => {}
  } = {}) {
    if (typeof executablePath !== 'string' || !executablePath.trim()) {
      throw new TypeError('DB Access Manager requires a companion executable path.');
    }
    if (typeof prepareConnection !== 'function') {
      throw new TypeError('DB Access Manager requires a connection preparation callback.');
    }
    if (typeof cleanupConnection !== 'function') {
      throw new TypeError('DB Access Manager requires a connection cleanup callback.');
    }
    if (focusExisting !== null && typeof focusExisting !== 'function') {
      throw new TypeError('DB Access Manager received an invalid companion focus callback.');
    }
    if (typeof fileExists !== 'function') {
      throw new TypeError('DB Access Manager received an invalid companion file check.');
    }
    if (typeof spawn !== 'function' || typeof createServer !== 'function' || typeof randomBytes !== 'function') {
      throw new TypeError('DB Access Manager received invalid process dependencies.');
    }
    if (typeof onStateChange !== 'function') {
      throw new TypeError('DB Access Manager requires a valid state callback.');
    }

    this.executablePath = executablePath.trim();
    this.prepareConnection = prepareConnection;
    this.cleanupConnection = cleanupConnection;
    this.focusExisting = focusExisting;
    this.fileExists = fileExists;
    this.spawn = spawn;
    this.createServer = createServer;
    this.randomBytes = randomBytes;
    this.environment = environment;
    this.platform = platform;
    this.launchTimeoutMs = boundedMilliseconds(launchTimeoutMs, 15000, 10, 120000);
    this.handshakeTimeoutMs = boundedMilliseconds(handshakeTimeoutMs, 5000, 10, 60000);
    this.maximumHandoffBytes = boundedMilliseconds(maximumHandoffBytes, MAX_HANDOFF_BYTES, 1024, 1024 * 1024);
    this.onStateChange = onStateChange;
    this.sessions = new Map();
  }

  async open(request = {}) {
    const workspaceId = requiredContextId(request.workspaceId, 'workspace');
    const actorId = requiredContextId(request.actorId, 'actor');
    const profileId = requiredProfileId(typeof request === 'string' ? request : request.profileId);
    const key = sessionKey(workspaceId, actorId, profileId);
    if (this.platform !== 'win32') {
      throw accessError('DATABASE_ACCESS_PLATFORM_UNSUPPORTED', 'DB Access Manager is currently available on Windows only.');
    }

    const existing = this.sessions.get(key);
    if (existing) {
      await existing.readyPromise;
      const current = this.sessions.get(key);
      if (!current || current !== existing || current.state !== 'active') {
        throw accessError('DATABASE_ACCESS_COMPANION_EXITED', 'DB Access Manager closed before it could be opened.', { retryable: true });
      }
      await this.#focus(current);
      return safeResult(profileId, 'focused');
    }

    const session = {
      key,
      workspaceId,
      actorId,
      profileId,
      state: 'launching',
      prepared: null,
      payloadFrame: null,
      pipeName: null,
      server: null,
      socket: null,
      controlChannelClosed: false,
      child: null,
      launchTimer: null,
      handshakeTimer: null,
      finalized: false,
      finalReason: null,
      cleanupStarted: false,
      cleanupPromise: null,
      rejectHandshake: null,
      readyPromise: null
    };
    session.readyPromise = this.#launch(session);
    this.sessions.set(key, session);

    await session.readyPromise;
    if (this.sessions.get(key) !== session || session.state !== 'active') {
      throw accessError('DATABASE_ACCESS_COMPANION_EXITED', 'DB Access Manager closed before it could be opened.', { retryable: true });
    }
    return safeResult(profileId, 'active');
  }

  isActive(request = {}) {
    const workspaceId = requiredContextId(request.workspaceId, 'workspace');
    const actorId = requiredContextId(request.actorId, 'actor');
    const profileId = requiredProfileId(request.profileId);
    return this.sessions.get(sessionKey(workspaceId, actorId, profileId))?.state === 'active';
  }

  isAvailable() {
    return this.fileExists(this.executablePath);
  }

  async close(request = {}) {
    const workspaceId = requiredContextId(request.workspaceId, 'workspace');
    const actorId = requiredContextId(request.actorId, 'actor');
    const profileId = requiredProfileId(request.profileId);
    const session = this.sessions.get(sessionKey(workspaceId, actorId, profileId));
    if (!session) return safeResult(profileId, 'closed');
    await this.#finalize(session, 'requested-close', { terminateChild: true });
    return safeResult(profileId, 'closed');
  }

  async dispose() {
    await Promise.all([...this.sessions.values()].map((session) => (
      this.#finalize(session, 'service-dispose', { terminateChild: true })
    )));
  }

  async #launch(session) {
    try {
      if (!this.isAvailable()) {
        throw accessError(
          'DATABASE_ACCESS_COMPANION_MISSING',
          'DB Access Manager is not installed in this DeployerX build. Build or install the companion artifact before opening it.',
          { retryable: false }
        );
      }
      let prepared;
      try {
        prepared = await this.prepareConnection(Object.freeze({
          workspaceId: session.workspaceId,
          actorId: session.actorId,
          profileId: session.profileId
        }));
      } catch {
        throw accessError('DATABASE_ACCESS_PREPARATION_FAILED', 'The database connection could not be prepared for DB Access Manager.', { retryable: true });
      }
      session.prepared = prepared;
      if (session.finalized) {
        await this.#cleanupPrepared(session, session.finalReason || 'launch-cancelled');
        throw accessError('DATABASE_ACCESS_LAUNCH_CANCELLED', 'DB Access Manager opening was cancelled.', { retryable: true });
      }
      session.payloadFrame = normalizePreparedConnection(prepared, session.profileId, this.maximumHandoffBytes);
      session.pipeName = createWindowsPipeName(this.randomBytes);

      const handshake = this.#createHandshake(session);
      session.rejectHandshake = handshake.reject;
      await handshake.listenPromise;
      if (session.finalized) {
        throw accessError('DATABASE_ACCESS_LAUNCH_CANCELLED', 'DB Access Manager opening was cancelled.', { retryable: true });
      }

      try {
        session.child = this.spawn(
          this.executablePath,
          ['--deployerx-access', '--pipe', session.pipeName],
          {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
            env: createSafeEnvironment(this.environment)
          }
        );
      } catch {
        throw accessError('DATABASE_ACCESS_LAUNCH_FAILED', 'DB Access Manager could not be started.', { retryable: true });
      }

      if (!session.child || typeof session.child.once !== 'function') {
        throw accessError('DATABASE_ACCESS_LAUNCH_FAILED', 'DB Access Manager could not be started.', { retryable: true });
      }
      this.#observeChild(session, handshake.reject);
      session.launchTimer = setTimeout(() => {
        handshake.reject(accessError('DATABASE_ACCESS_LAUNCH_TIMEOUT', 'DB Access Manager took too long to start.', { retryable: true }));
      }, this.launchTimeoutMs);

      await handshake.resultPromise;
      session.rejectHandshake = null;
      this.#clearTimers(session);
      this.#closeListener(session);
      if (session.finalized) {
        throw accessError('DATABASE_ACCESS_COMPANION_EXITED', 'DB Access Manager closed before it could be opened.', { retryable: true });
      }
      session.state = 'active';
      this.#notify(session, 'active');
    } catch (error) {
      const safe = error instanceof DatabaseAccessCompanionError
        ? error
        : accessError('DATABASE_ACCESS_LAUNCH_FAILED', 'DB Access Manager could not be started.', { retryable: true });
      await this.#finalize(session, 'launch-failed', { terminateChild: true });
      throw safe;
    }
  }

  #createHandshake(session) {
    let resolveResult;
    let rejectResult;
    let settled = false;
    const resultPromise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    resultPromise.catch(() => undefined);
    const resolve = () => {
      if (settled) return;
      settled = true;
      resolveResult();
    };
    const reject = (error) => {
      if (settled) return;
      settled = true;
      rejectResult(error instanceof DatabaseAccessCompanionError
        ? error
        : accessError('DATABASE_ACCESS_HANDSHAKE_FAILED', 'DB Access Manager could not receive the database connection.', { retryable: true }));
    };

    let resolveListen;
    let rejectListen;
    const listenPromise = new Promise((resolvePromise, rejectPromise) => {
      resolveListen = resolvePromise;
      rejectListen = rejectPromise;
    });

    let accepted = false;
    let listening = false;
    const server = this.createServer((socket) => {
      if (accepted || session.finalized) {
        socket.destroy();
        return;
      }
      accepted = true;
      session.socket = socket;
      if (session.launchTimer) {
        clearTimeout(session.launchTimer);
        session.launchTimer = null;
      }
      try {
        server.close();
      } catch {
        // The accepted pipe remains usable even if the listener was already closed.
      }
      session.handshakeTimer = setTimeout(() => {
        reject(accessError('DATABASE_ACCESS_HANDSHAKE_TIMEOUT', 'DB Access Manager took too long to receive the database connection.', { retryable: true }));
      }, this.handshakeTimeoutMs);
      this.#handleHandshakeSocket(session, socket, resolve, reject);
    });
    session.server = server;
    server.once('error', () => {
      const error = accessError('DATABASE_ACCESS_PIPE_FAILED', 'DB Access Manager could not open a secure connection channel.', { retryable: true });
      if (listening) reject(error);
      else rejectListen(error);
    });
    server.listen(session.pipeName, () => {
      listening = true;
      resolveListen();
    });

    return { listenPromise, resultPromise, reject };
  }

  #handleHandshakeSocket(session, socket, resolve, reject) {
    let buffer = Buffer.alloc(0);
    let phase = 'ready';
    const fail = (error) => {
      reject(error);
      socket.destroy();
    };

    socket.on('data', (chunk) => {
      if (phase === 'complete') return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_CONTROL_FRAME_BYTES) {
        fail(accessError('DATABASE_ACCESS_HANDSHAKE_INVALID', 'DB Access Manager returned an invalid connection response.'));
        return;
      }

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf(0x0a)) !== -1 && phase !== 'complete') {
        const line = buffer.subarray(0, newlineIndex).toString('utf8');
        buffer = buffer.subarray(newlineIndex + 1);
        let frame;
        try {
          frame = parseControlFrame(line);
        } catch (error) {
          fail(error);
          return;
        }

        if (phase === 'ready') {
          if (!isExpectedFrame(frame, 'deployerx.db-access.ready')) {
            fail(accessError('DATABASE_ACCESS_HANDSHAKE_INVALID', 'DB Access Manager returned an invalid connection response.'));
            return;
          }
          phase = 'accepted';
          socket.write(session.payloadFrame, (error) => {
            if (error) fail(accessError('DATABASE_ACCESS_HANDSHAKE_FAILED', 'DB Access Manager could not receive the database connection.', { retryable: true }));
          });
          continue;
        }

        if (!isExpectedFrame(frame, 'deployerx.db-access.accepted') || frame.profileId !== session.profileId) {
          fail(accessError('DATABASE_ACCESS_HANDSHAKE_INVALID', 'DB Access Manager returned an invalid connection response.'));
          return;
        }
        phase = 'complete';
        this.#scrubSessionSecrets(session);
        resolve();
      }
    });
    socket.once('error', () => {
      if (phase !== 'complete') fail(accessError('DATABASE_ACCESS_HANDSHAKE_FAILED', 'DB Access Manager could not receive the database connection.', { retryable: true }));
    });
    socket.once('close', () => {
      if (phase !== 'complete') {
        reject(accessError('DATABASE_ACCESS_HANDSHAKE_FAILED', 'DB Access Manager could not receive the database connection.', { retryable: true }));
      } else if (session.socket === socket) {
        session.socket = null;
        session.controlChannelClosed = true;
      }
    });
  }

  #observeChild(session, rejectHandshake) {
    session.child.once('error', () => {
      rejectHandshake(accessError('DATABASE_ACCESS_LAUNCH_FAILED', 'DB Access Manager could not be started.', { retryable: true }));
      void this.#finalize(session, 'child-error');
    });
    session.child.once('exit', () => {
      rejectHandshake(accessError('DATABASE_ACCESS_COMPANION_EXITED', 'DB Access Manager closed before it could be opened.', { retryable: true }));
      void this.#finalize(session, 'child-exit');
    });
  }

  async #focus(session) {
    const socket = session.socket;
    if (!socket || socket.destroyed || !socket.writable || session.controlChannelClosed) {
      throw accessError('DATABASE_ACCESS_FOCUS_CHANNEL_CLOSED', 'DB Access Manager is open, but its focus channel is unavailable. Close it and try Access again.', { retryable: true });
    }
    const frame = Buffer.from(`${JSON.stringify({
      protocolVersion: ACCESS_PROTOCOL_VERSION,
      type: 'deployerx.db-access.focus',
      profileId: session.profileId
    })}\n`, 'utf8');
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('focus timeout')), this.handshakeTimeoutMs);
        socket.write(frame, (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      });
      if (this.focusExisting) {
        const focused = await this.focusExisting(Object.freeze({
          profileId: session.profileId,
          pid: Number.isInteger(session.child?.pid) ? session.child.pid : null
        }));
        if (focused === false) throw new Error('focus rejected');
      }
    } catch {
      throw accessError('DATABASE_ACCESS_FOCUS_FAILED', 'DB Access Manager is open but could not be focused.', { retryable: true });
    } finally {
      frame.fill(0);
    }
    if (session.finalized || session.state !== 'active') {
      throw accessError('DATABASE_ACCESS_COMPANION_EXITED', 'DB Access Manager closed before it could be focused.', { retryable: true });
    }
    this.#notify(session, 'focused');
  }

  async #finalize(session, reason, { terminateChild = false } = {}) {
    if (session.finalized) return session.cleanupPromise;
    session.finalized = true;
    session.finalReason = reason;
    this.#scrubSessionSecrets(session);
    if (session.rejectHandshake) {
      session.rejectHandshake(accessError(
        'DATABASE_ACCESS_LAUNCH_CANCELLED',
        'DB Access Manager opening was cancelled.',
        { retryable: true }
      ));
      session.rejectHandshake = null;
    }
    this.#clearTimers(session);
    this.#closeTransport(session);
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);

    if (terminateChild && session.child && typeof session.child.kill === 'function' && session.child.exitCode == null) {
      try {
        session.child.kill();
      } catch {
        // Cleanup still runs if Windows has already closed the process handle.
      }
    }
    session.state = 'closed';
    this.#notify(session, 'closed', reason);
    return this.#cleanupPrepared(session, reason);
  }

  #cleanupPrepared(session, reason) {
    if (session.cleanupStarted) return session.cleanupPromise;
    if (!session.prepared) return Promise.resolve();
    session.cleanupStarted = true;
    session.cleanupPromise = Promise.resolve()
      .then(() => this.cleanupConnection(session.prepared, Object.freeze({
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        profileId: session.profileId,
        reason
      })))
      .catch(() => undefined);
    return session.cleanupPromise;
  }

  #clearTimers(session) {
    if (session.launchTimer) clearTimeout(session.launchTimer);
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    session.launchTimer = null;
    session.handshakeTimer = null;
  }

  #scrubSessionSecrets(session) {
    if (session.payloadFrame) {
      session.payloadFrame.fill(0);
      session.payloadFrame = null;
    }
    scrubPreparedConnection(session.prepared);
  }

  #closeListener(session) {
    if (!session.server) return;
    try {
      session.server.close();
    } catch {
      // The one-time listener may already be closed after accepting the companion.
    }
    session.server = null;
  }

  #closeTransport(session) {
    if (session.socket) {
      session.socket.destroy();
      session.socket = null;
    }
    this.#closeListener(session);
  }

  #notify(session, state, reason) {
    try {
      this.onStateChange(Object.freeze({
        workspaceId: session.workspaceId,
        profileId: session.profileId,
        state,
        ...(reason ? { reason } : {})
      }));
    } catch {
      // Observer failures must not affect process or secret cleanup.
    }
  }
}

module.exports = {
  ACCESS_PROTOCOL_VERSION,
  APPROVED_ACCESS_THEME_IDS,
  DatabaseAccessCompanionError,
  DatabaseAccessCompanionService,
  MAX_CONTROL_FRAME_BYTES,
  MAX_HANDOFF_BYTES,
  SUPPORTED_ACCESS_DRIVERS,
  createSafeEnvironment,
  createWindowsPipeName,
  normalizeAccessThemeId,
  normalizePreparedConnection,
  resolveDatabaseAccessCompanionExecutablePath,
  scrubPreparedConnection
};
