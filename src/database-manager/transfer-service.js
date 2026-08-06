const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { releaseRuntimeConnection, resolveRuntimeConnection } = require('./connection-context');
const { enforceSqlPolicy } = require('./sql-safety');

const MAX_TRANSFER_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_EXECUTABLE_LENGTH = 512;
const TRANSFER_CLASSIFICATION = Object.freeze({ kind: 'mutation', statementCount: 1, malformed: false, statements: Object.freeze(['mutation']) });

function transferError(message, code, options = {}) {
  return Object.assign(new Error(message), {
    code,
    safeMessage: message,
    category: options.category || 'database-manager',
    retryable: Boolean(options.retryable),
    details: options.details || {}
  });
}

function requiredText(value, label, maximumLength = 512) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw transferError(`${label} is invalid.`, 'DATABASE_MANAGER_TRANSFER_INVALID');
  return text;
}

function normalizeOperation(value) {
  const operation = String(value || '').trim().toLowerCase();
  if (!['import', 'dump'].includes(operation)) throw transferError('Database transfer operation is invalid.', 'DATABASE_MANAGER_TRANSFER_INVALID');
  return operation;
}

function normalizeFormat(operation, value, profile) {
  const requested = String(value || '').trim().toLowerCase();
  if (operation === 'dump') {
    if (profile.driverId === 'postgresql') {
      if (requested && !['sql', 'custom'].includes(requested)) throw transferError('The requested dump format is not supported.', 'DATABASE_MANAGER_TRANSFER_FORMAT_INVALID');
      return requested || 'sql';
    }
    if (requested && requested !== 'sql') throw transferError('The requested dump format is not supported.', 'DATABASE_MANAGER_TRANSFER_FORMAT_INVALID');
    return 'sql';
  }
  if (profile.driverId === 'postgresql') {
    if (requested && !['sql', 'custom', 'dump', 'backup'].includes(requested)) throw transferError('The requested import format is not supported.', 'DATABASE_MANAGER_TRANSFER_FORMAT_INVALID');
    if (requested === 'custom' || requested === 'dump' || requested === 'backup') return 'custom';
    return 'sql';
  }
  if (requested && !['sql'].includes(requested)) throw transferError('The requested import format is not supported.', 'DATABASE_MANAGER_TRANSFER_FORMAT_INVALID');
  return 'sql';
}

function normalizeExecutable(value, fallback) {
  const executable = String(value || fallback).trim();
  if (!executable || executable.length > MAX_EXECUTABLE_LENGTH || /[\0\r\n]/.test(executable)) {
    throw transferError('The configured database utility path is invalid.', 'DATABASE_MANAGER_TRANSFER_EXECUTABLE_INVALID');
  }
  return executable;
}

function normalizeAbsolutePath(value, label) {
  const input = requiredText(value, label, 4096);
  if (!path.isAbsolute(input)) throw transferError(`The ${label.toLowerCase()} must be an absolute path.`, 'DATABASE_MANAGER_TRANSFER_PATH_INVALID');
  return path.normalize(input);
}

function networkArgs(connection, settings = {}) {
  const endpoint = connection.endpoint || {};
  if (endpoint.kind !== 'network' || !endpoint.host || !endpoint.port) throw transferError('This transfer requires a network database endpoint.', 'DATABASE_MANAGER_TRANSFER_ENDPOINT_INVALID');
  const username = String(settings.username || '');
  const database = String(connection.database || '');
  if (!database) throw transferError('A database name is required for this transfer.', 'DATABASE_MANAGER_TRANSFER_DATABASE_REQUIRED');
  return { host: endpoint.host, port: String(endpoint.port), username, database };
}

function buildTransferCommand(operationValue, profile = {}, connection = {}, options = {}) {
  const operation = normalizeOperation(operationValue);
  const format = normalizeFormat(operation, options.format, profile);
  const settings = profile.settings && typeof profile.settings === 'object' ? profile.settings : {};
  const password = String(connection.credentials?.password || '');
  const env = { ...(options.environment || process.env) };
  let executable;
  let args;
  let inputPath = null;

  if (profile.driverId === 'sqlite') {
    const databasePath = normalizeAbsolutePath(connection.endpoint?.path, 'database path');
    executable = normalizeExecutable(settings.sqliteExecutable, 'sqlite3');
    if (operation === 'dump') {
      const outputPath = normalizeAbsolutePath(options.path, 'dump destination');
      args = [databasePath, '.output', outputPath, '.dump'];
    } else {
      inputPath = normalizeAbsolutePath(options.path, 'import file');
      args = [databasePath];
    }
    return Object.freeze({ executable, args: Object.freeze(args), env, inputPath, format });
  }

  const network = networkArgs(connection, settings);
  if (profile.driverId === 'postgresql') {
    env.PGPASSWORD = password;
    const common = ['--host', network.host, '--port', network.port, '--username', network.username || 'postgres', '--dbname', network.database];
    if (operation === 'dump') {
      executable = normalizeExecutable(settings.pgDumpExecutable, 'pg_dump');
      args = [...common, '--format', format === 'custom' ? 'custom' : 'plain', '--file', normalizeAbsolutePath(options.path, 'dump destination')];
    } else if (format === 'custom') {
      executable = normalizeExecutable(settings.pgRestoreExecutable, 'pg_restore');
      args = [...common, '--exit-on-error', normalizeAbsolutePath(options.path, 'import file')];
    } else {
      executable = normalizeExecutable(settings.psqlExecutable, 'psql');
      args = [...common, '--set', 'ON_ERROR_STOP=1', '--file', normalizeAbsolutePath(options.path, 'import file')];
    }
  } else if (profile.driverId === 'mysql') {
    env.MYSQL_PWD = password;
    if (operation === 'dump') {
      executable = normalizeExecutable(settings.mysqldumpExecutable, 'mysqldump');
      args = ['--host', network.host, '--port', network.port, '--user', network.username || 'root', '--single-transaction', '--routines', '--events', '--result-file', normalizeAbsolutePath(options.path, 'dump destination'), network.database];
    } else {
      executable = normalizeExecutable(settings.mysqlExecutable, 'mysql');
      args = ['--host', network.host, '--port', network.port, '--user', network.username || 'root', '--database', network.database, '--show-warnings'];
      inputPath = normalizeAbsolutePath(options.path, 'import file');
    }
  } else {
    throw transferError('This database driver does not support native import or dump operations.', 'DATABASE_MANAGER_TRANSFER_UNSUPPORTED');
  }
  return Object.freeze({ executable, args: Object.freeze(args), env, inputPath, format });
}

async function boundedFileStat(fileSystem, inputPath, label) {
  const resolved = normalizeAbsolutePath(inputPath, label);
  const stat = await fileSystem.stat(resolved).catch(() => { throw transferError(`The selected ${label.toLowerCase()} is unavailable.`, 'DATABASE_MANAGER_TRANSFER_FILE_UNAVAILABLE'); });
  if (!stat.isFile()) throw transferError(`The selected ${label.toLowerCase()} must be a file.`, 'DATABASE_MANAGER_TRANSFER_FILE_INVALID');
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > MAX_TRANSFER_BYTES) throw transferError(`The selected ${label.toLowerCase()} exceeds the ${MAX_TRANSFER_BYTES / (1024 * 1024 * 1024)} GiB transfer limit.`, 'DATABASE_MANAGER_TRANSFER_SIZE_LIMIT');
  return Object.freeze({ path: resolved, size: stat.size });
}

function spawnFailure() {
  return transferError('The database transfer utility could not be started.', 'DATABASE_MANAGER_TRANSFER_START_FAILED', { retryable: true });
}

class DatabaseTransferService {
  constructor({ profileService, secretStore, taskService, localResourceResolver = null, tunnelProvider = null, showOpenDialog, showSaveDialog, spawnProcess = require('node:child_process').spawn, fileSystem = fsp, environment = process.env, clock = () => new Date().toISOString() } = {}) {
    if (!profileService?.get) throw new TypeError('DatabaseTransferService requires a profile service.');
    if (!secretStore?.resolve) throw new TypeError('DatabaseTransferService requires a shared secret store.');
    if (!taskService?.create || !taskService?.start || !taskService?.complete) throw new TypeError('DatabaseTransferService requires a task service.');
    if (typeof showOpenDialog !== 'function' || typeof showSaveDialog !== 'function') throw new TypeError('DatabaseTransferService requires native file dialogs.');
    if (typeof spawnProcess !== 'function') throw new TypeError('DatabaseTransferService requires a process factory.');
    if (tunnelProvider !== null && typeof tunnelProvider?.open !== 'function') throw new TypeError('Database transfer tunnel provider is invalid.');
    this.profileService = profileService;
    this.secretStore = secretStore;
    this.taskService = taskService;
    this.localResourceResolver = localResourceResolver;
    this.tunnelProvider = tunnelProvider;
    this.showOpenDialog = showOpenDialog;
    this.showSaveDialog = showSaveDialog;
    this.spawnProcess = spawnProcess;
    this.fileSystem = fileSystem;
    this.environment = environment && typeof environment === 'object' ? { ...environment } : {};
    this.clock = clock;
    this.active = new Set();
  }

  async execute(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId || 'system', 'Actor ID', 200);
    const operation = normalizeOperation(input.operation);
    const profileId = requiredText(input.profileId, 'Database profile ID', 200);
    const profile = await this.profileService.get(tenant, profileId);
    if (!profile) throw transferError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    if (operation === 'import') enforceSqlPolicy({ profile, classification: TRANSFER_CLASSIFICATION, approval: input.approval || {}, batch: false });
    const selection = operation === 'import'
      ? await this.#selectImport(input, profile)
      : await this.#selectDump(input, profile);
    if (selection.cancelled) return selection;
    const task = await this.taskService.create(tenant, actor, {
      profileId,
      type: operation,
      label: `${operation === 'import' ? 'Import' : 'Dump'} ${selection.displayName}`,
      canCancel: true,
      progress: { phase: 'queued', percent: 0, bytesTotal: selection.size || 0, bytesCompleted: 0, message: 'Waiting to start' }
    });
    let current = await this.taskService.start(tenant, actor, task.id, task.revision);
    let child = null;
    let inputStream = null;
    const controller = new AbortController();
    const unregister = this.taskService.registerCancellation(tenant, task.id, async () => {
      controller.abort();
      inputStream?.destroy();
      if (child && !child.killed) child.kill();
    });
    let connection = null;
    try {
      connection = await resolveRuntimeConnection({ workspaceId: tenant, profile, secretStore: this.secretStore, localResourceResolver: this.localResourceResolver, tunnelProvider: this.tunnelProvider, signal: controller.signal });
      const command = buildTransferCommand(operation, profile, connection, { format: selection.format, path: selection.path, environment: this.environment });
      child = this.spawnProcess(command.executable, command.args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: command.env });
      if (!child || typeof child.once !== 'function') throw spawnFailure();
      this.active.add(child);
      if (command.inputPath) {
        inputStream = fs.createReadStream(command.inputPath, { highWaterMark: 1024 * 1024 });
        inputStream.on('error', () => child.kill());
        inputStream.pipe(child.stdin);
      } else if (child.stdin?.end) child.stdin.end();
      current = await this.taskService.reportProgress(tenant, actor, task.id, { phase: 'running', percent: 10, message: 'Transfer in progress' }, current.revision);
      const exit = await this.#waitForChild(child);
      if (exit.code !== 0) throw transferError('The database transfer utility reported a failure.', 'DATABASE_MANAGER_TRANSFER_FAILED', { retryable: true });
      current = await this.taskService.complete(tenant, actor, task.id, { expectedRevision: current.revision });
      const outputSize = operation === 'dump' ? await this.fileSystem.stat(selection.path).then((stat) => stat.size).catch(() => 0) : 0;
      return Object.freeze({ cancelled: false, operation, format: selection.format, displayName: selection.displayName, byteLength: outputSize || selection.size || 0, task: current });
    } catch (error) {
      const latest = await this.taskService.get(tenant, task.id);
      if (latest && ['queued', 'running', 'interrupted'].includes(latest.state)) {
        await this.taskService.complete(tenant, actor, task.id, { state: 'failed', safeMessage: error?.safeMessage || 'Database transfer failed.', expectedRevision: latest.revision }).catch(() => {});
      }
      throw error?.code ? error : transferError('The database transfer failed.', 'DATABASE_MANAGER_TRANSFER_FAILED', { retryable: true });
    } finally {
      inputStream?.destroy();
      await releaseRuntimeConnection(connection);
      if (child) this.active.delete(child);
      unregister();
    }
  }

  async #selectImport(input, profile) {
    const result = await this.showOpenDialog({ title: `Import into ${profile.name}`, properties: ['openFile'], filters: this.#filters(profile, 'import') });
    if (result?.canceled || !result?.filePaths?.[0]) return Object.freeze({ cancelled: true, operation: 'import' });
    const file = await boundedFileStat(this.fileSystem, result.filePaths[0], 'import file');
    const extension = path.extname(file.path).slice(1).toLowerCase();
    const format = normalizeFormat('import', input.format || extension, profile);
    if (profile.driverId === 'postgresql' && format === 'custom' && !['dump', 'backup'].includes(extension)) throw transferError('PostgreSQL custom imports require a .dump or .backup file.', 'DATABASE_MANAGER_TRANSFER_FORMAT_INVALID');
    return Object.freeze({ ...file, format, displayName: path.basename(file.path), cancelled: false });
  }

  async #selectDump(input, profile) {
    const format = normalizeFormat('dump', input.format, profile);
    const extension = format === 'custom' ? 'dump' : 'sql';
    const result = await this.showSaveDialog({ title: `Dump ${profile.name}`, defaultPath: `${String(profile.name || 'database').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80)}.${extension}`, filters: this.#filters(profile, 'dump'), properties: ['showOverwriteConfirmation'] });
    if (result?.canceled || !result?.filePath) return Object.freeze({ cancelled: true, operation: 'dump' });
    const outputPath = normalizeAbsolutePath(result.filePath, 'dump destination');
    return Object.freeze({ path: outputPath, format, displayName: path.basename(outputPath), cancelled: false });
  }

  #filters(profile, operation) {
    if (operation === 'dump' && profile.driverId === 'postgresql') return [{ name: 'SQL or PostgreSQL dump', extensions: ['sql', 'dump'] }];
    return [{ name: 'SQL files', extensions: ['sql', 'dump', 'backup'] }, { name: 'All files', extensions: ['*'] }];
  }

  #waitForChild(child) {
    return new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr?.on?.('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2000); });
      child.once('error', () => reject(spawnFailure()));
      child.once('close', (code, signal) => resolve({ code: Number.isInteger(code) ? code : -1, signal, stderr }));
    });
  }

  closeAll() {
    for (const child of this.active) {
      try { if (!child.killed) child.kill(); } catch {}
    }
    this.active.clear();
  }
}

module.exports = {
  DatabaseTransferService,
  MAX_TRANSFER_BYTES,
  TRANSFER_CLASSIFICATION,
  buildTransferCommand,
  normalizeFormat,
  normalizeOperation
};
