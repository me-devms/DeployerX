const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeSqlDialect } = require('./sql-safety');

const DATABASE_DRIVER_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const METHOD_PATTERN = /^[a-z][a-z0-9_]*(?:[.-][a-z][a-z0-9_]*){0,5}$/;
const PLUGIN_ENVIRONMENT_KEYS = Object.freeze(new Map([
  ['path', 'PATH'],
  ['pathext', 'PATHEXT'],
  ['systemroot', 'SystemRoot'],
  ['windir', 'WINDIR'],
  ['comspec', 'ComSpec'],
  ['temp', 'TEMP'],
  ['tmp', 'TMP'],
  ['tmpdir', 'TMPDIR'],
  ['lang', 'LANG'],
  ['lc_all', 'LC_ALL'],
  ['tz', 'TZ']
]));

class DatabaseDriverRuntimeError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'DatabaseDriverRuntimeError';
    this.code = code;
    this.safeMessage = safeMessage;
    this.category = options.category || 'driver-runtime';
    this.retryable = Boolean(options.retryable);
    this.details = safeDetails(options.details);
  }
}

function runtimeError(code, safeMessage, options) {
  return new DatabaseDriverRuntimeError(code, safeMessage, options);
}

function safeDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (/(?:password|passphrase|secret|token|credential|authorization|cookie|key|path|query|sql)/i.test(key)) continue;
    if (item === null || typeof item === 'boolean' || typeof item === 'number') result[key] = item;
    else if (typeof item === 'string') result[key] = item.slice(0, 300);
  }
  return result;
}

function sanitizePluginEnvironment(environment = process.env) {
  const source = environment && typeof environment === 'object' && !Array.isArray(environment) ? environment : {};
  const normalized = new Map(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]));
  const result = {};
  for (const [lookupKey, outputKey] of PLUGIN_ENVIRONMENT_KEYS) {
    const value = normalized.get(lookupKey);
    if (typeof value === 'string' && !value.includes('\0')) result[outputKey] = value;
  }
  return Object.freeze(result);
}

function positiveInteger(value, fallback, maximum, label) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new TypeError(`${label} is invalid.`);
  return number;
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const complete = (exited) => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', onExit);
      if (timer) clearTimeout(timer);
      resolve(exited);
    };
    const onExit = () => complete(true);
    timer = setTimeout(() => complete(false), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) complete(true);
  });
}

function normalizeMethod(value) {
  const method = String(value || '').trim();
  if (!METHOD_PATTERN.test(method)) throw new TypeError('Database driver method is invalid.');
  return method;
}

function normalizeParams(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Database driver parameters must be an object.');
  }
  return value;
}

function resolveDatabaseDriverHostPath({ isPackaged = false, resourcesPath, appPath, platform = process.platform, arch = process.arch } = {}) {
  const executable = platform === 'win32' ? 'deployerx-db-host.exe' : 'deployerx-db-host';
  if (isPackaged) return path.join(String(resourcesPath || ''), 'database-manager', `${platform}-${arch}`, executable);
  return path.join(String(appPath || process.cwd()), 'native', 'deployerx-db-host', 'dist', `${platform}-${arch}`, executable);
}

class SidecarDriverRuntime {
  constructor({
    executablePath,
    args = [],
    spawnProcess = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
    maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
    environment = process.env,
    workingDirectory = null,
    beforeStart = null,
    trustRemoteErrors = true,
    includeProtocolVersion = true,
    requireProtocolVersion = true,
    onDiagnostic = null
  } = {}) {
    this.executablePath = String(executablePath || '').trim();
    if (!this.executablePath) throw new TypeError('Database driver host executable path is required.');
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw new TypeError('Database driver host arguments are invalid.');
    if (typeof spawnProcess !== 'function') throw new TypeError('Database driver host process factory is required.');
    this.args = [...args];
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = positiveInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 30 * 60 * 1000, 'Database driver request timeout');
    this.maxMessageBytes = positiveInteger(maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 128 * 1024 * 1024, 'Database driver message limit');
    this.maxPendingRequests = positiveInteger(maxPendingRequests, DEFAULT_MAX_PENDING_REQUESTS, 1000, 'Database driver concurrency limit');
    this.environment = environment && typeof environment === 'object' ? { ...environment } : {};
    this.workingDirectory = workingDirectory ? path.resolve(String(workingDirectory)) : undefined;
    if (beforeStart !== null && typeof beforeStart !== 'function') throw new TypeError('Database driver pre-start verifier is invalid.');
    this.beforeStart = beforeStart;
    this.trustRemoteErrors = trustRemoteErrors !== false;
    this.includeProtocolVersion = includeProtocolVersion !== false;
    this.requireProtocolVersion = requireProtocolVersion !== false;
    this.onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : null;
    this.child = null;
    this.starting = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.pending = new Map();
    this.generation = 0;
    this.stopping = false;
  }

  async health(options = {}) {
    const result = await this.invoke('system.health', {}, options);
    if (!result || result.protocolVersion !== DATABASE_DRIVER_PROTOCOL_VERSION || result.status !== 'ready') {
      throw runtimeError('DATABASE_MANAGER_DRIVER_PROTOCOL_MISMATCH', 'The database driver host returned an incompatible health response.');
    }
    return result;
  }

  testConnection(connection, options = {}) {
    return this.invoke('connection.test', { connection }, options);
  }

  async openConnection(connection, options = {}) {
    const runtimeSessionId = `dbsession_${crypto.randomUUID()}`;
    const result = await this.invoke('connection.open', { sessionId: runtimeSessionId, connection }, options);
    return { ...result, runtimeSessionId };
  }

  closeConnection(runtimeSessionId, options = {}) {
    return this.invoke('connection.close', { sessionId: runtimeSessionId }, options);
  }

  connectionStatus(runtimeSessionId, options = {}) {
    return this.invoke('connection.status', { sessionId: runtimeSessionId }, options);
  }

  executeQuery(connection, request, options = {}) {
    return this.invoke('query.execute', { connection, request }, options);
  }

  executeSessionQuery(runtimeSessionId, request, options = {}) {
    return this.invoke('query.execute_session', { sessionId: runtimeSessionId, request }, options);
  }

  discoverSchema(connection, request, options = {}) {
    return this.invoke('schema.snapshot', { connection, request }, options);
  }

  discoverSessionSchema(runtimeSessionId, request, options = {}) {
    return this.invoke('schema.snapshot_session', { sessionId: runtimeSessionId, request }, options);
  }

  async invoke(methodValue, paramsValue = {}, options = {}) {
    const method = normalizeMethod(methodValue);
    const params = normalizeParams(paramsValue);
    if (options.signal?.aborted) throw runtimeError('DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED', 'The database operation was cancelled.');
    if (this.pending.size >= this.maxPendingRequests) {
      throw runtimeError('DATABASE_MANAGER_DRIVER_BUSY', 'The database driver host is busy. Try again shortly.', { retryable: true });
    }
    await this.#ensureStarted();
    const id = `dbhost_${crypto.randomUUID()}`;
    const requestMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };
    if (this.includeProtocolVersion) requestMessage.protocolVersion = DATABASE_DRIVER_PROTOCOL_VERSION;
    const message = Buffer.from(`${JSON.stringify(requestMessage)}\n`, 'utf8');
    if (message.byteLength > this.maxMessageBytes) {
      throw runtimeError('DATABASE_MANAGER_DRIVER_REQUEST_TOO_LARGE', 'The database driver request is too large.');
    }
    const timeoutMs = positiveInteger(options.timeoutMs, this.requestTimeoutMs, 30 * 60 * 1000, 'Database driver request timeout');
    return new Promise((resolve, reject) => {
      const complete = (callback, value) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
        callback(value);
      };
      const cancel = (code, safeMessage) => {
        this.#writeNotification('request.cancel', { requestId: id });
        complete(reject, runtimeError(code, safeMessage, { retryable: code === 'DATABASE_MANAGER_DRIVER_TIMEOUT' }));
      };
      const timer = setTimeout(() => cancel('DATABASE_MANAGER_DRIVER_TIMEOUT', 'The database operation timed out.'), timeoutMs);
      timer.unref?.();
      const onAbort = () => cancel('DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED', 'The database operation was cancelled.');
      this.pending.set(id, { resolve: (value) => complete(resolve, value), reject: (error) => complete(reject, error), timer, signal: options.signal, onAbort });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.child.stdin.write(message, (error) => {
        if (error) complete(reject, runtimeError('DATABASE_MANAGER_DRIVER_WRITE_FAILED', 'The database driver host could not accept the request.', { retryable: true }));
      });
    });
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (!child) {
      this.stopping = false;
      return;
    }
    try {
      this.#writeNotification('system.shutdown', {}, child);
      for (const pending of this.pending.values()) pending.reject(runtimeError('DATABASE_MANAGER_DRIVER_STOPPED', 'The database driver host stopped.'));
      let exited = await waitForChildExit(child, 250);
      if (!exited && !child.killed) {
        try { child.kill(); } catch {}
      }
      if (!exited) exited = await waitForChildExit(child, 2000);
      if (!exited) throw runtimeError('DATABASE_MANAGER_DRIVER_STOP_FAILED', 'The database driver host did not stop in time.', { retryable: true });
    } finally {
      this.stopping = false;
    }
  }

  async #ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    const generation = ++this.generation;
    this.starting = (async () => {
      await this.beforeStart?.();
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = this.spawnProcess(this.executablePath, this.args, {
            windowsHide: true,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: this.workingDirectory,
            env: { ...this.environment, DEPLOYERX_DB_PROTOCOL_VERSION: String(DATABASE_DRIVER_PROTOCOL_VERSION) }
          });
        } catch {
          reject(runtimeError('DATABASE_MANAGER_DRIVER_HOST_UNAVAILABLE', 'The database driver host is not installed or could not be started.'));
          return;
        }
        this.child = child;
        this.stdoutBuffer = Buffer.alloc(0);
        const onSpawn = () => {
          this.#diagnostic('spawn', { generation });
          resolve();
        };
        const onError = () => {
          if (this.child === child) this.child = null;
          reject(runtimeError('DATABASE_MANAGER_DRIVER_HOST_UNAVAILABLE', 'The database driver host is not installed or could not be started.'));
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
        child.stdin.on('error', () => {});
        child.stdout.on('error', () => {});
        child.stderr.on('error', () => {});
        child.stdout.on('data', (chunk) => this.#consumeStdout(child, generation, chunk));
        child.stderr.on('data', (chunk) => this.#diagnostic('stderr', { byteLength: Buffer.byteLength(chunk) }));
        child.once('exit', (code, signal) => this.#handleExit(child, generation, code, signal));
      });
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  #consumeStdout(child, generation, chunk) {
    if (this.child !== child || generation !== this.generation) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.from(chunk)]);
    if (this.stdoutBuffer.byteLength > this.maxMessageBytes && this.stdoutBuffer.indexOf(10) === -1) {
      this.#failProtocol(child, 'The database driver host returned an oversized response.');
      return;
    }
    let newline;
    while ((newline = this.stdoutBuffer.indexOf(10)) !== -1) {
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (!line.length) continue;
      if (line.byteLength > this.maxMessageBytes) {
        this.#failProtocol(child, 'The database driver host returned an oversized response.');
        return;
      }
      let message;
      try { message = JSON.parse(line.toString('utf8')); } catch {
        this.#failProtocol(child, 'The database driver host returned malformed data.');
        return;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (!message || message.jsonrpc !== '2.0' || (this.requireProtocolVersion && message.protocolVersion !== DATABASE_DRIVER_PROTOCOL_VERSION) || !['string', 'number'].includes(typeof message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (Object.prototype.hasOwnProperty.call(message, 'result')) {
      pending.resolve(message.result);
      return;
    }
    const remote = message.error && typeof message.error === 'object' ? message.error : {};
    const trustedCode = String(remote.code || 'DATABASE_MANAGER_DRIVER_OPERATION_FAILED').slice(0, 120);
    pending.reject(runtimeError(
      this.trustRemoteErrors && /^[A-Z][A-Z0-9_]{2,119}$/.test(trustedCode) ? trustedCode : 'DATABASE_MANAGER_PLUGIN_OPERATION_FAILED',
      this.trustRemoteErrors ? String(remote.data?.safeMessage || 'The database driver could not complete the operation.').slice(0, 1000) : 'The database plugin could not complete the operation.',
      { retryable: this.trustRemoteErrors && Boolean(remote.data?.retryable), details: this.trustRemoteErrors ? remote.data?.details : {} }
    ));
  }

  #writeNotification(method, params, child = this.child) {
    if (!child || child.killed || !child.stdin?.writable) return;
    const notification = { jsonrpc: '2.0', method, params };
    if (this.includeProtocolVersion) notification.protocolVersion = DATABASE_DRIVER_PROTOCOL_VERSION;
    const message = Buffer.from(`${JSON.stringify(notification)}\n`, 'utf8');
    if (message.byteLength <= this.maxMessageBytes) child.stdin.write(message, () => {});
  }

  #failProtocol(child, safeMessage) {
    const error = runtimeError('DATABASE_MANAGER_DRIVER_PROTOCOL_ERROR', safeMessage, { retryable: true });
    this.#diagnostic('protocol-error', {});
    for (const pending of [...this.pending.values()]) pending.reject(error);
    if (!child.killed) child.kill();
  }

  #handleExit(child, generation, code, signal) {
    if (this.child !== child || generation !== this.generation) return;
    this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
    const error = runtimeError('DATABASE_MANAGER_DRIVER_HOST_EXITED', 'The database driver host stopped unexpectedly.', {
      retryable: true,
      details: { exitCode: Number.isInteger(code) ? code : null, signal: signal || null }
    });
    for (const pending of [...this.pending.values()]) pending.reject(error);
    if (!this.stopping) this.#diagnostic('exit', error.details);
  }

  #diagnostic(event, details) {
    try { this.onDiagnostic?.({ event, details: safeDetails(details) }); } catch {}
  }
}

function tabularisConnectionParams(connection = {}) {
  const endpoint = connection.endpoint && typeof connection.endpoint === 'object' ? connection.endpoint : {};
  const credentials = connection.credentials && typeof connection.credentials === 'object' ? connection.credentials : {};
  const connectionUri = credentials['connection-uri'] || connection.settings?.connectionUri || null;
  const db2Uri = connection.driverId === 'db2' && connectionUri ? parseDb2ConnectionUri(connectionUri) : null;
  if (connection.driverId === 'db2' && connectionUri && !db2Uri) {
    throw runtimeError('DATABASE_MANAGER_PLUGIN_CONNECTION_URI_INVALID', 'The Db2 connection URI is invalid.');
  }
  return {
    driver: connection.driverId || null,
    host: db2Uri?.host || endpoint.host || null,
    port: db2Uri?.port || (Number.isInteger(endpoint.port) ? endpoint.port : null),
    database: db2Uri?.database || connectionUri || endpoint.path || connection.database || null,
    username: db2Uri?.username || credentials.username || connection.settings?.username || null,
    password: db2Uri?.password || credentials.password || null,
    token: credentials.token || null,
    connection_uri: connectionUri,
    ssl_mode: connection.ssl?.mode || null,
    settings: connection.settings && typeof connection.settings === 'object' ? connection.settings : {}
  };
}

function decodedUriPart(value) {
  try { return decodeURIComponent(String(value || '')); } catch { return null; }
}

function parseDb2ConnectionUri(value) {
  let uri;
  try { uri = new URL(String(value || '')); } catch { return null; }
  if (uri.protocol !== 'db2:' || !uri.hostname || uri.search || uri.hash) return null;
  const database = decodedUriPart(uri.pathname.replace(/^\//, ''));
  const username = decodedUriPart(uri.username);
  const password = decodedUriPart(uri.password);
  const port = uri.port ? Number(uri.port) : 50000;
  if (!database || database.includes('/') || username === null || password === null || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return Object.freeze({ host: uri.hostname, port, database, username: username || null, password: password || null });
}

function pluginInitializationSettings(connection = {}) {
  const source = connection.settings && typeof connection.settings === 'object' && !Array.isArray(connection.settings) ? connection.settings : {};
  const credentials = connection.credentials && typeof connection.credentials === 'object' && !Array.isArray(connection.credentials) ? connection.credentials : {};
  const settings = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'connectionUri'));
  for (const [slotId, value] of Object.entries(credentials)) {
    if (['username', 'password', 'token', 'connection-uri'].includes(slotId) || typeof value !== 'string') continue;
    settings[slotId.replaceAll('-', '_')] = value;
  }
  return settings;
}

function normalizePluginConnectionResult(result, connection) {
  if (result !== null && (!result || typeof result !== 'object' || Array.isArray(result))) return { status: 'invalid' };
  const declaredStatus = String(result?.status || '').toLowerCase();
  const status = result === null || result?.success === true || declaredStatus === 'success'
    ? 'success'
    : result?.success === false || declaredStatus === 'failure' ? 'failure' : 'invalid';
  const normalized = {
    status,
    database: connection.database || connection.endpoint?.path || null,
    readOnly: connection.accessMode === 'read-only'
  };
  const latencyMs = Number(result?.latencyMs ?? result?.latency_ms);
  if (Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 30 * 60 * 1000) normalized.latencyMs = latencyMs;
  if (status === 'failure') normalized.error = { code: 'DATABASE_MANAGER_PLUGIN_CONNECTION_FAILED', safeMessage: 'The database plugin could not connect.', retryable: false };
  return normalized;
}

function normalizePluginHealthResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { status: 'invalid' };
  if (result.success === true || String(result.status || '').toLowerCase() === 'ready') return { status: 'ready' };
  return { status: 'failed' };
}

function normalizePluginQueryResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return {
    ...result,
    affectedRows: result.affectedRows ?? result.affected_rows ?? 0,
    pagination: result.pagination ? { ...result.pagination, pageSize: result.pagination.pageSize ?? result.pagination.page_size, totalRows: result.pagination.totalRows ?? result.pagination.total_rows, hasMore: result.pagination.hasMore ?? result.pagination.has_more } : null
  };
}

function normalizePluginSchemaResult(result, connection) {
  if (Array.isArray(result)) {
    return {
      database: connection.database || connection.endpoint?.path || null,
      schemas: [{ name: connection.defaultSchema || 'public', tables: result.map((table) => ({ name: table.name, type: 'table', columns: (table.columns || []).map((column) => ({ name: column.name, dataType: column.data_type || column.dataType || null, nullable: column.is_nullable !== false, primaryKey: Boolean(column.is_pk || column.primaryKey), defaultValue: column.default_value ?? column.defaultValue ?? null }),), foreignKeys: table.foreign_keys || table.foreignKeys || [] })) }],
      truncated: false,
      warnings: []
    };
  }
  return result;
}

class PluginDriverRuntime {
  constructor({ pluginId, executablePath, installPath, launcherPath = null, args = [], methods = {}, environment = process.env, beforeStart = null, ...options } = {}) {
    this.pluginId = String(pluginId || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(this.pluginId)) throw new TypeError('Database plugin ID is invalid.');
    const rootPath = path.resolve(String(installPath || ''));
    const entrypointPath = path.resolve(String(executablePath || ''));
    const relative = path.relative(rootPath, entrypointPath);
    if (!installPath || !executablePath || relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError('Database plugin executable must stay inside its installation directory.');
    const defaults = { initialize: 'initialize', health: 'initialize', testConnection: 'test_connection', executeQuery: 'execute_query', discoverSchema: 'get_schema_snapshot' };
    this.hasDeclaredHealthMethod = Object.prototype.hasOwnProperty.call(methods, 'health');
    this.methods = Object.freeze(Object.fromEntries(Object.entries({ ...defaults, ...methods }).map(([key, value]) => [key, normalizeMethod(value)])));
    this.runtime = new SidecarDriverRuntime({
      ...options,
      executablePath: launcherPath ? String(launcherPath) : entrypointPath,
      args: launcherPath ? [entrypointPath, ...args] : args,
      workingDirectory: rootPath,
      includeProtocolVersion: false,
      requireProtocolVersion: false,
      beforeStart,
      trustRemoteErrors: false,
      environment: { ...sanitizePluginEnvironment(environment), DEPLOYERX_DATABASE_PLUGIN_ID: this.pluginId },
    });
    this.initializerSupport = 'unknown';
    this.operationTail = Promise.resolve();
    this.queuedOperations = 0;
  }

  async health(options = {}) {
    return this.#serialize(async () => {
      try {
        const raw = await this.runtime.invoke(this.methods.health, {}, options);
        if (!this.hasDeclaredHealthMethod) this.initializerSupport = 'supported';
        const result = raw === null && !this.hasDeclaredHealthMethod ? { status: 'ready' } : normalizePluginHealthResult(raw);
        if (result.status !== 'ready') throw runtimeError('DATABASE_MANAGER_PLUGIN_HEALTH_FAILED', 'The database plugin did not become ready.');
        return result;
      } catch (error) {
        if (!this.hasDeclaredHealthMethod && error?.code === 'DATABASE_MANAGER_PLUGIN_OPERATION_FAILED') {
          this.initializerSupport = 'unsupported';
          return { status: 'ready' };
        }
        throw error;
      }
    }, options);
  }
  async testConnection(connection, options = {}) {
    const params = tabularisConnectionParams(connection);
    return normalizePluginConnectionResult(await this.#connectionOperation(connection, () => this.runtime.invoke(this.methods.testConnection, { params }, options), options), connection);
  }
  async openConnection(connection, options = {}) {
    const evidence = await this.testConnection(connection, options);
    return { status: evidence.status, connectionMode: 'operation-scoped', evidence };
  }
  async closeConnection() { return { status: 'closed', closed: true }; }
  async executeQuery(connection, request, options = {}) {
    const params = tabularisConnectionParams(connection);
    return normalizePluginQueryResult(await this.#connectionOperation(connection, () => this.runtime.invoke(this.methods.executeQuery, { params, query: request.query, page: request.page, page_size: request.pageSize, limit: request.pageSize }, options), options));
  }
  async discoverSchema(connection, request, options = {}) {
    const params = tabularisConnectionParams(connection);
    return normalizePluginSchemaResult(await this.#connectionOperation(connection, () => this.runtime.invoke(this.methods.discoverSchema, { params, schema: request.schema, include_system: request.includeSystem }, options), options), connection);
  }
  invoke(method, params, options = {}) { return this.#serialize(() => this.runtime.invoke(method, params, options), options); }
  stop() { return this.runtime.stop(); }

  async #connectionOperation(connection, operation, options) {
    return this.#serialize(async () => {
      await this.#initializeConnectionSettings(connection, options);
      try { return await operation(); }
      finally { await this.#resetConnectionSettings(); }
    }, options);
  }

  async #initializeConnectionSettings(connection, options) {
    if (this.initializerSupport === 'unsupported') return;
    try {
      await this.runtime.invoke(this.methods.initialize, { settings: pluginInitializationSettings(connection) }, { ...options, timeoutMs: Math.min(Number(options.timeoutMs) || 5000, 5000) });
      this.initializerSupport = 'supported';
    } catch (error) {
      if (this.initializerSupport === 'unknown' && error?.code === 'DATABASE_MANAGER_PLUGIN_OPERATION_FAILED') {
        this.initializerSupport = 'unsupported';
        return;
      }
      throw error;
    }
  }

  async #resetConnectionSettings() {
    if (this.initializerSupport !== 'supported' || !this.runtime.child) return;
    try { await this.runtime.invoke(this.methods.initialize, { settings: {} }, { timeoutMs: 2000 }); }
    catch {
      this.initializerSupport = 'unknown';
      await this.runtime.stop().catch(() => {});
      throw runtimeError('DATABASE_MANAGER_PLUGIN_SETTINGS_RESET_FAILED', 'The database plugin could not clear operation settings.');
    }
  }

  async #serialize(operation, options = {}) {
    if (options.signal?.aborted) throw runtimeError('DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED', 'The database operation was cancelled.');
    if (this.queuedOperations >= DEFAULT_MAX_PENDING_REQUESTS) throw runtimeError('DATABASE_MANAGER_DRIVER_BUSY', 'The database driver host is busy. Try again shortly.', { retryable: true });
    this.queuedOperations += 1;
    const previous = this.operationTail;
    let release;
    this.operationTail = new Promise((resolve) => { release = resolve; });
    try {
      await previous;
      if (options.signal?.aborted) throw runtimeError('DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED', 'The database operation was cancelled.');
      return await operation();
    } finally {
      this.queuedOperations -= 1;
      release();
    }
  }
}

function createInstalledPluginRuntime({
  installed,
  beforeStart = null,
  environment = process.env,
  platform = process.platform,
  nodeExecutablePath = process.execPath,
  pythonExecutablePath = null,
  ...options
} = {}) {
  if (!installed || typeof installed !== 'object' || !installed.pluginId || !installed.installPath || !installed.entrypoint || !installed.driverManifest) {
    throw new TypeError('A complete installed database plugin record is required.');
  }
  const runtimeConfig = installed.driverManifest.runtime && typeof installed.driverManifest.runtime === 'object' ? installed.driverManifest.runtime : {};
  const args = Array.isArray(runtimeConfig.args) ? runtimeConfig.args : [];
  const methods = runtimeConfig.methods && typeof runtimeConfig.methods === 'object' && !Array.isArray(runtimeConfig.methods) ? runtimeConfig.methods : {};
  const entrypointPath = path.join(installed.installPath, installed.entrypoint);
  const extension = path.extname(installed.entrypoint).toLowerCase();
  const launcherPath = extension === '.py'
    ? pythonExecutablePath || (platform === 'win32' ? 'python.exe' : 'python3')
    : extension === '.js' ? nodeExecutablePath : null;
  return new PluginDriverRuntime({
    ...options,
    pluginId: installed.pluginId,
    installPath: installed.installPath,
    executablePath: entrypointPath,
    launcherPath,
    args,
    methods,
    beforeStart,
    environment
  });
}

class DatabaseDriverRuntimeRegistry {
  constructor() {
    this.runtimes = new Map();
    this.policies = new Map();
  }

  register(driverIdValue, runtime, manifest = null) {
    const driverId = String(driverIdValue || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(driverId)) throw new TypeError('Database driver ID is invalid.');
    if (!runtime?.testConnection || !runtime?.executeQuery || !runtime?.discoverSchema) throw new TypeError('Database driver runtime is invalid.');
    if (this.runtimes.has(driverId)) throw new TypeError(`Database driver ${driverId} is already registered.`);
    this.runtimes.set(driverId, runtime);
    const capabilities = manifest?.capabilities && typeof manifest.capabilities === 'object' ? manifest.capabilities : {};
    this.policies.set(driverId, Object.freeze({
      sqlDialect: normalizeSqlDialect(manifest?.sqlDialect || manifest?.sql_dialect || driverId),
      query: capabilities.query !== false,
      readOnly: manifest?.readOnly === true || capabilities.crud === false
    }));
    return this;
  }

  get(driverIdValue) {
    const driverId = String(driverIdValue || '').trim().toLowerCase();
    const runtime = this.runtimes.get(driverId);
    if (!runtime) throw runtimeError('DATABASE_MANAGER_DRIVER_NOT_AVAILABLE', 'This database driver is not installed.');
    return runtime;
  }

  has(driverIdValue) {
    return this.runtimes.has(String(driverIdValue || '').trim().toLowerCase());
  }

  getPolicy(driverIdValue) {
    const driverId = String(driverIdValue || '').trim().toLowerCase();
    const policy = this.policies.get(driverId);
    if (!policy) throw runtimeError('DATABASE_MANAGER_DRIVER_NOT_AVAILABLE', 'This database driver is not installed.');
    return policy;
  }

  async unregister(driverIdValue) {
    const driverId = String(driverIdValue || '').trim().toLowerCase();
    const runtime = this.runtimes.get(driverId);
    if (!runtime) return false;
    this.runtimes.delete(driverId);
    this.policies.delete(driverId);
    await runtime.stop?.();
    return true;
  }

  async stopAll() {
    await Promise.all([...new Set(this.runtimes.values())].map((runtime) => runtime.stop?.()));
  }
}

module.exports = {
  DATABASE_DRIVER_PROTOCOL_VERSION,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_PENDING_REQUESTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DatabaseDriverRuntimeError,
  DatabaseDriverRuntimeRegistry,
  PluginDriverRuntime,
  SidecarDriverRuntime,
  createInstalledPluginRuntime,
  resolveDatabaseDriverHostPath,
  safeDetails,
  sanitizePluginEnvironment
};
