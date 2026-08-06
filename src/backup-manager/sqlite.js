const crypto = require('crypto');
const fsNative = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError, digestJson } = require('./database-adapter');
const { NativeProcessError, NativeProcessRunner } = require('./native-process');

const ADAPTER_ID = 'deployerx.database.sqlite.native';
const ADAPTER_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30000;
const RECORD_SEPARATOR = '\x1f';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const MAX_DATABASES = 20;
const MAX_OBJECTS = 10000;
const MAX_BACKUP_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const IDENTITY_SQL = [
  "SELECT 'DX_SQLITE_META', sqlite_version(), journal_mode, page_size, page_count, freelist_count, schema_version, user_version, application_id FROM pragma_journal_mode, pragma_page_size, pragma_page_count, pragma_freelist_count, pragma_schema_version, pragma_user_version, pragma_application_id;",
  "SELECT 'DX_SQLITE_DATABASE', seq, hex(name), hex(file) FROM pragma_database_list ORDER BY seq LIMIT 21;",
  "SELECT 'DX_SQLITE_OBJECT', type, hex(name), hex(tbl_name), hex(COALESCE(sql,'')) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT 10001;",
  "SELECT 'DX_SQLITE_CHECK', quick_check FROM pragma_quick_check LIMIT 2;"
].join('\n');

class SqliteAdapterError extends DatabaseAdapterError {
  constructor(code, safeMessage, options = {}) {
    super(code, safeMessage, options);
    this.name = 'SqliteAdapterError';
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function executableName(value = 'sqlite3') {
  const executable = requiredText(value, 'SQLite executable', 512);
  if (!/^(?:[A-Za-z]:[\\/][A-Za-z0-9 ._+\\/-]+|\/[A-Za-z0-9 ._+/\-]+|[A-Za-z0-9._+-]+)$/.test(executable) || executable.split(/[\\/]/).includes('..') || path.basename(executable).toLowerCase().replace(/[.]exe$/, '') !== 'sqlite3') throw new TypeError('SQLite executable must resolve to sqlite3.');
  return executable;
}

function timeoutValue(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('SQLite timeout must be between 1000 and 300000 milliseconds.');
  return timeoutMs;
}

function canonicalInputPath(value) {
  const databasePath = requiredText(value, 'SQLite database path', 4096);
  if (!path.isAbsolute(databasePath) || /[\r\n\x1f]/.test(databasePath) || path.normalize(databasePath) !== databasePath) throw new TypeError('SQLite database path must be a canonical absolute path.');
  return databasePath;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('SQLite connection settings must be an object.');
  return Object.freeze({ databasePath: canonicalInputPath(input.databasePath), sqliteExecutable: executableName(input.sqliteExecutable), timeoutMs: timeoutValue(input.timeoutMs) });
}

function samePath(left, right) {
  const normalize = (value) => path.normalize(String(value || ''));
  return process.platform === 'win32' ? normalize(left).toLowerCase() === normalize(right).toLowerCase() : normalize(left) === normalize(right);
}

function databaseFingerprint(identity) {
  return `sha256:${crypto.createHash('sha256').update(`${identity.databasePath}\0${identity.applicationId}\0${identity.schemaFingerprint}`).digest('hex')}`;
}

function backupDotCommand(destinationPath) {
  const destination = canonicalInputPath(path.normalize(destinationPath)).replace(/\\/g, '/');
  if (/["'\r\n]/.test(destination)) throw new SqliteAdapterError('SQLITE_BACKUP_PATH_UNSAFE', 'The protected SQLite temporary path cannot be represented safely by the native CLI.', { category: 'validation' });
  return Buffer.from(`.backup main "${destination}"\n`, 'utf8');
}

async function resolveDatabasePath(fileSystem, value) {
  const requested = canonicalInputPath(value);
  const stat = await fileSystem.lstat(requested).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new SqliteAdapterError('SQLITE_DATABASE_FILE_INVALID', 'Choose an existing regular SQLite database file.', { category: 'validation' });
  const resolved = await fileSystem.realpath(requested);
  if (!samePath(requested, resolved)) throw new SqliteAdapterError('SQLITE_DATABASE_SYMLINK_REFUSED', 'SQLite database paths must not traverse a symbolic link.', { category: 'integrity' });
  return canonicalInputPath(path.normalize(resolved));
}

function throwIfDigestCanceled(options = {}) {
  if (!options.signal?.aborted) return;
  throw new SqliteAdapterError(options.canceledCode || 'SQLITE_OPERATION_CANCELED', options.canceledMessage || 'The SQLite operation was canceled.', { category: 'canceled' });
}

async function digestFile(fileSystem, filePath, options = {}) {
  const digest = crypto.createHash('sha256');
  throwIfDigestCanceled(options);
  const handle = await fileSystem.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (true) {
      throwIfDigestCanceled(options);
      const read = await handle.read(buffer, 0, buffer.length, position);
      throwIfDigestCanceled(options);
      if (!read.bytesRead) break;
      digest.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
  } finally { await handle.close(); }
  return `sha256:${digest.digest('hex')}`;
}

function restoreStagePath(targetPath, executionId) {
  const suffix = crypto.createHash('sha256').update(requiredText(executionId, 'SQLite restore execution ID', 200)).digest('hex').slice(0, 32);
  return `${targetPath}.deployerx-sqlite-stage-${suffix}`;
}

function expectedProtectedIdentity(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SqliteAdapterError('SQLITE_RESTORE_METADATA_INVALID', 'The SQLite recovery metadata is invalid.', { category: 'integrity' });
  const expected = {};
  for (const field of ['pageSize', 'schemaVersion', 'userVersion', 'applicationId', 'objectCount']) expected[field] = integer(value[field], field, field === 'pageSize' ? 65536 : Number.MAX_SAFE_INTEGER);
  expected.schemaFingerprint = requiredText(value.schemaFingerprint, 'SQLite schema fingerprint', 100);
  if (!/^sha256:[0-9a-f]{64}$/.test(expected.schemaFingerprint)) throw new SqliteAdapterError('SQLITE_RESTORE_METADATA_INVALID', 'The SQLite recovery schema fingerprint is invalid.', { category: 'integrity' });
  return expected;
}

function parseVersion(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new SqliteAdapterError('SQLITE_VERSION_INVALID', 'The SQLite runtime returned an invalid version.', { category: 'compatibility' });
  const version = { text: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  version.supported = version.major > 3 || version.major === 3 && version.minor >= 38;
  return version;
}

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new SqliteAdapterError('SQLITE_IDENTITY_INVALID', `SQLite ${label} evidence is invalid.`, { category: 'integrity' });
  return number;
}

function decodeHex(value, label, maximumLength = 4096) {
  const encoded = String(value || '');
  if (encoded.length % 2 || !/^[0-9a-f]*$/i.test(encoded) || encoded.length > maximumLength * 2) throw new SqliteAdapterError('SQLITE_IDENTITY_INVALID', `SQLite ${label} evidence is invalid.`, { category: 'integrity' });
  const decoded = Buffer.from(encoded, 'hex').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('hex').toLowerCase() !== encoded.toLowerCase() || decoded.includes('\0')) throw new SqliteAdapterError('SQLITE_IDENTITY_INVALID', `SQLite ${label} evidence is invalid.`, { category: 'integrity' });
  return decoded;
}

function parseIdentity(stdout, expectedPath) {
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean).map((line) => line.split(RECORD_SEPARATOR));
  const metaRows = lines.filter((row) => row[0] === 'DX_SQLITE_META');
  const checks = lines.filter((row) => row[0] === 'DX_SQLITE_CHECK').map((row) => String(row[1] || ''));
  if (metaRows.length !== 1 || metaRows[0].length !== 9 || checks.length !== 1 || checks[0] !== 'ok') throw new SqliteAdapterError('SQLITE_INTEGRITY_CHECK_FAILED', 'SQLite did not return one successful quick integrity check.', { category: 'integrity' });
  const meta = metaRows[0];
  const version = parseVersion(meta[1]);
  if (!version.supported) throw new SqliteAdapterError('SQLITE_VERSION_UNSUPPORTED', 'DeployerX requires SQLite 3.38 or newer for bounded native discovery and online backup.', { category: 'compatibility' });
  const journalMode = requiredText(meta[2], 'SQLite journal mode', 40).toLowerCase();
  if (!['delete', 'truncate', 'persist', 'memory', 'wal', 'off'].includes(journalMode)) throw new SqliteAdapterError('SQLITE_JOURNAL_MODE_INVALID', 'SQLite returned an unsupported journal mode.', { category: 'integrity' });
  const databases = lines.filter((row) => row[0] === 'DX_SQLITE_DATABASE').map((row) => ({ sequence: integer(row[1], 'database sequence', 1000), name: decodeHex(row[2], 'database name', 255), file: decodeHex(row[3], 'database path', 4096) }));
  if (!databases.length || databases.length > MAX_DATABASES || databases.some((item, index) => item.sequence !== index) || databases.some((item, index) => databases.findIndex((candidate) => candidate.name === item.name) !== index)) throw new SqliteAdapterError('SQLITE_DATABASE_INVENTORY_INVALID', 'SQLite returned an invalid attached-database inventory.', { category: 'integrity' });
  const main = databases.find((item) => item.name === 'main');
  if (!main || !samePath(main.file, expectedPath)) throw new SqliteAdapterError('SQLITE_DATABASE_IDENTITY_CHANGED', 'SQLite opened a different main database path.', { category: 'integrity' });
  const attached = databases.filter((item) => !['main', 'temp'].includes(item.name) && item.file);
  if (attached.length) throw new SqliteAdapterError('SQLITE_ATTACHED_DATABASES_UNSUPPORTED', 'This SQLite connection has attached databases; save a complete-set profile before backup.', { category: 'compatibility' });
  const objects = lines.filter((row) => row[0] === 'DX_SQLITE_OBJECT').map((row) => ({ type: requiredText(row[1], 'SQLite object type', 40), name: decodeHex(row[2], 'object name', 1024), tableName: decodeHex(row[3], 'object table name', 1024), sql: decodeHex(row[4], 'object SQL', 1024 * 1024) }));
  if (objects.length > MAX_OBJECTS || objects.some((item, index) => objects.findIndex((candidate) => candidate.type === item.type && candidate.name === item.name) !== index)) throw new SqliteAdapterError('SQLITE_SCHEMA_INVENTORY_INVALID', 'SQLite returned an invalid or oversized schema inventory.', { category: 'capacity' });
  const schemaFingerprint = `sha256:${crypto.createHash('sha256').update(digestJson(objects)).digest('hex')}`;
  return {
    version: version.text, journalMode, pageSize: integer(meta[3], 'page size', 65536), pageCount: integer(meta[4], 'page count'),
    freelistCount: integer(meta[5], 'freelist count'), schemaVersion: integer(meta[6], 'schema version'), userVersion: integer(meta[7], 'user version'),
    applicationId: integer(meta[8], 'application ID', 0xffffffff), databases: databases.map(({ sql, ...item }) => item),
    objects: objects.map(({ sql, ...item }) => item), objectCount: objects.length, schemaFingerprint, quickCheck: 'ok'
  };
}

function publicFailure(error, testedAt, latencyMs) {
  const known = error instanceof SqliteAdapterError || error instanceof NativeProcessError;
  const code = known ? String(error.code || 'SQLITE_CONNECTION_FAILED') : 'SQLITE_CONNECTION_FAILED';
  return {
    adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs, status: 'failed', checks: [], remotePlatform: null, endpointIdentity: null,
    error: { code, category: known ? String(error.category || 'connectivity') : 'connectivity', retryable: Boolean(known && error.retryable), safeMessage: known ? String(error.message).slice(0, 500) : 'DeployerX could not validate the SQLite database.' }
  };
}

function sqliteLockReported(error) {
  return /\bsqlite_(?:busy|locked)\b|database(?: table| schema)? (?:is )?(?:busy|locked)/.test(String(error?.stderr || '').toLowerCase());
}

function restorePathFailure(error) {
  if (['EACCES', 'EPERM'].includes(error?.code)) return new SqliteAdapterError('SQLITE_RESTORE_PATH_ACCESS_DENIED', 'DeployerX cannot safely inspect the SQLite recovery path.', { category: 'authorization' });
  if (['EBUSY', 'ETXTBSY'].includes(error?.code)) return new SqliteAdapterError('SQLITE_RESTORE_PATH_BUSY', 'The SQLite recovery path is busy. Wait for the conflicting operation before retrying.', { category: 'conflict', retryable: true });
  return new SqliteAdapterError('SQLITE_RESTORE_PATH_PROBE_FAILED', 'DeployerX could not safely inspect the SQLite recovery path.', { category: 'filesystem', retryable: true });
}

async function inspectRestorePath(fileSystem, filePath) {
  try { return await fileSystem.lstat(filePath); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw restorePathFailure(error);
  }
}

function sqliteBackupFailure(error) {
  if (!(error instanceof NativeProcessError)) return null;
  if (error.code === 'NATIVE_PROCESS_CANCELED') return new SqliteAdapterError('SQLITE_BACKUP_CANCELED', 'The SQLite online backup was canceled.', { category: 'canceled' });
  if (sqliteLockReported(error)) {
    return new SqliteAdapterError('SQLITE_BACKUP_SOURCE_BUSY', 'The SQLite database is busy or locked. Retry after the conflicting transaction finishes.', { category: 'conflict', retryable: true });
  }
  return new SqliteAdapterError('SQLITE_BACKUP_NATIVE_FAILED', 'The SQLite native online backup failed.', { category: error.category, retryable: error.retryable });
}

function sqliteRestoreFailure(error) {
  if (!(error instanceof NativeProcessError)) return null;
  if (error.code === 'NATIVE_PROCESS_CANCELED') return new SqliteAdapterError('SQLITE_RESTORE_CANCELED', 'The SQLite recovery was canceled.', { category: 'canceled' });
  if (sqliteLockReported(error)) return new SqliteAdapterError('SQLITE_RESTORE_DATABASE_BUSY', 'The staged SQLite database is busy or locked. Retry after the conflicting operation finishes.', { category: 'conflict', retryable: true });
  return new SqliteAdapterError('SQLITE_RESTORE_NATIVE_FAILED', 'SQLite native recovery validation failed.', { category: error.category, retryable: error.retryable });
}

class SqliteNativeAdapter {
  constructor({ processRunner = new NativeProcessRunner(), fileSystem = fs, temporaryRoot = os.tmpdir(), createReadStream = fsNative.createReadStream, clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!processRunner || typeof processRunner.run !== 'function') throw new TypeError('SQLite native process runner is required.');
    this.processRunner = processRunner;
    this.fileSystem = fileSystem;
    this.temporaryRoot = canonicalInputPath(path.normalize(temporaryRoot));
    this.createReadStream = createReadStream;
    this.clock = clock;
    this.now = now;
  }

  manifest() {
    return {
      apiVersion: 1, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, displayName: 'SQLite Native', engine: 'sqlite', executionReady: true,
      serverVersionRange: '>=3.38.0 <4.0.0', restoreVersionRange: '>=3.38.0 <4.0.0',
      capabilities: {
        backupMethods: ['logical'], backupModes: ['full'], selection: { database: true, schema: false, table: false, globalObjects: false },
        consistencyStrategies: [{ id: 'sqlite-online-backup', produces: 'application', backupMethods: ['logical'], lockScope: 'database', requiresDowntime: false, capturesCoordinates: false }],
        transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null },
        streaming: { backup: false, restore: false, compression: false, encryption: false }, restore: { alternateTarget: true, nativeValidation: true }, replicaAware: false
      },
      requiredTools: [{ name: 'sqlite3', versionRange: '>=3.38.0 <4.0.0', operations: ['discovery', 'backup', 'restore', 'validation'] }], requiredPrivileges: []
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) { try { normalizeConfig(input); return []; } catch (error) { return [{ path: '', code: 'SQLITE_CONFIG_INVALID', severity: 'error', message: error.message }]; } }

  async readIdentity(context = {}, input = {}) {
    const config = normalizeConfig(input);
    const databasePath = await resolveDatabasePath(this.fileSystem, config.databasePath);
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const handle = await this.fileSystem.open(databasePath, 'r');
    try {
      const read = await handle.read(header, 0, header.length, 0);
      if (read.bytesRead !== header.length || !header.equals(SQLITE_HEADER)) throw new SqliteAdapterError('SQLITE_HEADER_INVALID', 'The selected file is not an unencrypted SQLite database. SQLCipher and extension databases require a compatible provider.', { category: 'compatibility' });
    } finally { await handle.close(); }
    const result = await this.processRunner.run({
      executable: config.sqliteExecutable,
      args: ['-batch', '-readonly', '-noheader', '-separator', RECORD_SEPARATOR, databasePath, IDENTITY_SQL],
      timeoutMs: config.timeoutMs, stdoutLimitBytes: 16 * 1024 * 1024, signal: context.signal
    });
    return { ...parseIdentity(result.stdout, databasePath), databasePath };
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const identity = await this.readIdentity(context, input);
      const fingerprint = databaseFingerprint(identity);
      return {
        adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'success',
        checks: [
          { id: 'database-file', status: 'pass', safeMessage: 'The canonical SQLite database file is a regular unencrypted database.' },
          { id: 'runtime-version', status: 'pass', safeMessage: `SQLite ${identity.version} supports bounded native discovery.` },
          { id: 'integrity', status: 'pass', safeMessage: 'SQLite quick_check passed.' },
          { id: 'attached-databases', status: 'pass', safeMessage: 'No unprotected attached databases were discovered.' }
        ],
        remotePlatform: { engine: 'sqlite', version: identity.version, distribution: 'SQLite CLI' },
        endpointIdentity: { databaseFingerprint: fingerprint, databasePath: identity.databasePath, journalMode: identity.journalMode, pageSize: identity.pageSize, pageCount: identity.pageCount, schemaVersion: identity.schemaVersion, userVersion: identity.userVersion, applicationId: identity.applicationId, objectCount: identity.objectCount, schemaFingerprint: identity.schemaFingerprint }, error: null
      };
    } catch (error) { return publicFailure(error, testedAt, Math.max(0, this.now() - started)); }
  }

  async *discover(context = {}, request = {}) {
    const identity = await this.readIdentity(context, request.connection);
    const kind = String(request.kind || 'database');
    if (kind === 'database') {
      yield { items: [{ name: 'main', kind: 'database', selectable: true, path: identity.databasePath, objectCount: identity.objectCount }], nextCursor: null };
      return;
    }
    if (kind === 'table') {
      yield { items: identity.objects.filter((item) => ['table', 'view'].includes(item.type)).map((item) => ({ database: 'main', schema: 'main', name: item.name, kind: 'table', objectType: item.type, selectable: false })), nextCursor: null };
      return;
    }
    throw new SqliteAdapterError('SQLITE_DISCOVERY_KIND_UNSUPPORTED', 'SQLite discovery supports database or read-only object inventory.', { category: 'validation' });
  }

  async preflight(context = {}, request = {}) {
    const identity = await this.readIdentity(context, request.connection);
    return {
      checkedAt: this.clock(), serverVersion: identity.version, serverVersionSupported: true, serverIdentityFingerprint: databaseFingerprint(identity),
      consistency: [{ method: 'sqlite-online-backup', verified: true, produces: 'application' }],
      tools: [{ name: 'sqlite3', version: identity.version, compatible: true }], privileges: [], coordinateCaptureVerified: false, warnings: [],
      metadata: {
        engine: 'sqlite', journalMode: identity.journalMode, pageSize: identity.pageSize, pageCount: identity.pageCount,
        freelistCount: identity.freelistCount, schemaVersion: identity.schemaVersion, userVersion: identity.userVersion,
        applicationId: identity.applicationId, objectCount: identity.objectCount, schemaFingerprint: identity.schemaFingerprint, quickCheck: identity.quickCheck
      }
    };
  }

  async planBackup(_context = {}, request = {}) {
    if (request.consistency?.proven !== true || request.consistency?.method !== 'sqlite-online-backup' || request.consistency?.achievedLevel !== 'application') throw new SqliteAdapterError('SQLITE_CONSISTENCY_PLAN_INVALID', 'SQLite backup requires a proven native online backup plan.', { category: 'consistency' });
    const selector = request.selector || {};
    const selectedMain = selector.allDatabases === true || (selector.databases?.include?.length === 1 && selector.databases.include[0]?.name === 'main');
    const filtered = selector.databases?.exclude?.length || selector.schemas?.include?.length || selector.schemas?.exclude?.length || selector.tables?.include?.length || selector.tables?.exclude?.length || selector.includeGlobalObjects;
    if (!selectedMain || filtered) throw new SqliteAdapterError('SQLITE_SELECTION_INVALID', 'SQLite online backup requires the complete main database without object filters.', { category: 'compatibility' });
    return {
      version: 1, operation: 'sqlite-online-backup', connection: normalizeConfig(request.connection), selector,
      consistency: request.consistency, expectedIdentity: request.consistency.evidence?.metadata || {},
      artifact: { kind: 'database-dump', path: 'sqlite/database.sqlite3', mediaType: 'application/vnd.sqlite3' }, resumable: false
    };
  }

  async createBackupMedia(context = {}, plan = {}, destinationPath) {
    if (plan.operation !== 'sqlite-online-backup' || plan.consistency?.proven !== true || typeof this.processRunner.consume !== 'function') throw new SqliteAdapterError('SQLITE_BACKUP_PLAN_INVALID', 'The SQLite online backup plan is invalid.', { category: 'integrity' });
    const config = normalizeConfig(plan.connection);
    const destination = canonicalInputPath(path.normalize(destinationPath));
    const existing = await this.fileSystem.lstat(destination).catch(() => null);
    if (existing) throw new SqliteAdapterError('SQLITE_BACKUP_DESTINATION_EXISTS', 'The protected SQLite temporary output already exists.', { category: 'integrity' });
    try {
      const before = await this.readIdentity(context, config);
      if (databaseFingerprint(before) !== plan.consistency.evidence?.serverIdentityFingerprint) throw new SqliteAdapterError('SQLITE_DATABASE_IDENTITY_CHANGED', 'The SQLite database identity changed after its last successful test.', { category: 'integrity' });
      await this.processRunner.consume({
        executable: config.sqliteExecutable, args: ['-batch', '-bail', config.databasePath], stdin: backupDotCommand(destination),
        timeoutMs: Math.max(config.timeoutMs, MAX_BACKUP_TIMEOUT_MS), stdoutLimitBytes: 1024 * 1024, signal: context.signal
      });
      const stat = await this.fileSystem.lstat(destination).catch(() => null);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size < SQLITE_HEADER.length) throw new SqliteAdapterError('SQLITE_BACKUP_OUTPUT_INVALID', 'SQLite did not create a valid regular backup file.', { category: 'integrity' });
      await this.fileSystem.chmod(destination, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
      const handle = await this.fileSystem.open(destination, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      const protectedIdentity = await this.readIdentity(context, { ...config, databasePath: destination });
      const after = await this.readIdentity(context, config);
      if (databaseFingerprint(after) !== databaseFingerprint(before)) throw new SqliteAdapterError('SQLITE_DATABASE_IDENTITY_CHANGED', 'The SQLite database schema identity changed during online backup.', { category: 'consistency' });
      for (const field of ['applicationId', 'userVersion', 'schemaVersion', 'schemaFingerprint', 'objectCount', 'pageSize']) {
        if (protectedIdentity[field] !== before[field]) throw new SqliteAdapterError('SQLITE_BACKUP_IDENTITY_MISMATCH', 'The protected SQLite image does not match the planned database identity.', { category: 'integrity' });
      }
      return { filePath: destination, sizeBytes: stat.size, digest: await digestFile(this.fileSystem, destination, { signal: context.signal, canceledCode: 'SQLITE_BACKUP_CANCELED', canceledMessage: 'The SQLite online backup was canceled.' }), identity: protectedIdentity };
    } catch (error) {
      await this.fileSystem.rm(destination, { force: true }).catch(() => {});
      if (error instanceof SqliteAdapterError) throw error;
      const nativeFailure = sqliteBackupFailure(error);
      if (nativeFailure) throw nativeFailure;
      throw new SqliteAdapterError('SQLITE_BACKUP_FAILED', 'DeployerX could not create the SQLite online backup.', { retryable: true });
    }
  }

  async openBackup(context = {}, plan = {}) {
    let directory = null;
    try {
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, 'deployerx-sqlite-adapter-'));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const media = await this.createBackupMedia(context, plan, path.join(directory, 'database.sqlite3'));
      const createReadStream = this.createReadStream;
      const fileSystem = this.fileSystem;
      const content = (async function* streamBackup() {
        try { for await (const chunk of createReadStream(media.filePath, { highWaterMark: 64 * 1024, signal: context.signal })) yield Buffer.from(chunk); }
        finally { await fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {}); }
      })();
      return { content, artifact: plan.artifact, metadata: { ...plan.expectedIdentity, protectedIdentity: media.identity, contentDigest: media.digest, sizeBytes: media.sizeBytes } };
    } catch (error) {
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async executeBackup(context = {}, plan = {}, sink) {
    if (!sink || typeof sink.write !== 'function') throw new TypeError('SQLite backup artifact sink is required.');
    const opened = await this.openBackup(context, plan);
    const stored = await sink.write({ ...opened.artifact, content: opened.content, metadata: opened.metadata });
    return { status: 'succeeded', artifacts: [stored || opened.artifact], consistency: plan.consistency, metadata: opened.metadata };
  }
  async planRestore(_context = {}, request = {}) {
    if (request.mode !== 'alternate' || request.confirmation !== 'RESTORE_SQLITE_ALTERNATE') throw new SqliteAdapterError('SQLITE_RESTORE_MODE_UNSUPPORTED', 'SQLite recovery currently supports a confirmed alternate absent path only.', { category: 'compatibility' });
    const targetPath = canonicalInputPath(path.normalize(request.targetPath));
    const target = await inspectRestorePath(this.fileSystem, targetPath);
    if (target) throw new SqliteAdapterError('SQLITE_RESTORE_TARGET_EXISTS', 'Choose an absent path for alternate SQLite recovery.', { category: 'conflict' });
    const parentPath = path.dirname(targetPath);
    const parent = await inspectRestorePath(this.fileSystem, parentPath);
    if (!parent || !parent.isDirectory() || parent.isSymbolicLink()) throw new SqliteAdapterError('SQLITE_RESTORE_PARENT_INVALID', 'Choose an existing regular directory for alternate SQLite recovery.', { category: 'validation' });
    const resolvedParent = await this.fileSystem.realpath(parentPath);
    if (!samePath(parentPath, resolvedParent)) throw new SqliteAdapterError('SQLITE_RESTORE_PARENT_SYMLINK_REFUSED', 'SQLite recovery paths must not traverse a symbolic link.', { category: 'integrity' });
    const expectedDigest = requiredText(request.contentDigest, 'SQLite protected content digest', 100);
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new SqliteAdapterError('SQLITE_RESTORE_METADATA_INVALID', 'The SQLite protected content digest is invalid.', { category: 'integrity' });
    const sizeBytes = Number(request.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < SQLITE_HEADER.length || sizeBytes > 1024 * 1024 * 1024 * 1024) throw new SqliteAdapterError('SQLITE_RESTORE_SIZE_INVALID', 'The SQLite protected media size is invalid.', { category: 'capacity' });
    return {
      version: 1, operation: 'sqlite-alternate-restore', targetPath, stagePath: restoreStagePath(targetPath, request.executionId),
      sqliteExecutable: executableName(request.sqliteExecutable), timeoutMs: timeoutValue(request.timeoutMs), expectedDigest, sizeBytes,
      protectedIdentity: expectedProtectedIdentity(request.protectedIdentity)
    };
  }

  async validateRestoredFile(context = {}, request = {}) {
    const filePath = await resolveDatabasePath(this.fileSystem, request.filePath);
    const stat = await this.fileSystem.lstat(filePath);
    const expectedDigest = requiredText(request.expectedDigest, 'SQLite protected content digest', 100);
    if (request.sizeBytes !== undefined && Number(request.sizeBytes) !== stat.size) throw new SqliteAdapterError('SQLITE_RESTORE_SIZE_MISMATCH', 'The restored SQLite file size does not match its authenticated Artifact.', { category: 'integrity' });
    const contentDigest = await digestFile(this.fileSystem, filePath, { signal: context.signal, canceledCode: 'SQLITE_RESTORE_CANCELED', canceledMessage: 'The SQLite recovery was canceled.' });
    if (contentDigest !== expectedDigest) throw new SqliteAdapterError('SQLITE_RESTORE_DIGEST_MISMATCH', 'The restored SQLite file does not match its authenticated Artifact digest.', { category: 'integrity' });
    const identity = await this.readIdentity(context, { databasePath: filePath, sqliteExecutable: request.sqliteExecutable, timeoutMs: request.timeoutMs });
    const expected = expectedProtectedIdentity(request.protectedIdentity);
    for (const field of Object.keys(expected)) if (identity[field] !== expected[field]) throw new SqliteAdapterError('SQLITE_RESTORE_IDENTITY_MISMATCH', 'The restored SQLite database does not match its protected schema identity.', { category: 'integrity' });
    return { valid: true, status: 'succeeded', filePath, sizeBytes: stat.size, contentDigest, identity };
  }

  async executeRestore(context = {}, plan = {}, source) {
    if (plan.operation !== 'sqlite-alternate-restore' || !source || typeof source.open !== 'function') throw new SqliteAdapterError('SQLITE_RESTORE_PLAN_INVALID', 'The SQLite recovery plan is invalid.', { category: 'integrity' });
    let handle = null;
    let stageOwned = false;
    let published = false;
    let bytesWritten = 0;
    try {
      if (context.signal?.aborted) throw new SqliteAdapterError('SQLITE_RESTORE_CANCELED', 'The SQLite recovery was canceled.', { category: 'canceled' });
      try {
        handle = await this.fileSystem.open(plan.stagePath, 'wx', 0o600);
        stageOwned = true;
      } catch (error) {
        if (['EEXIST', 'EBUSY', 'EPERM'].includes(error?.code)) throw new SqliteAdapterError('SQLITE_RESTORE_STAGE_BUSY', 'Another recovery operation owns the SQLite staging file. Reconcile or wait for that operation before retrying.', { category: 'conflict', retryable: true });
        throw error;
      }
      const content = await source.open({ signal: context.signal });
      for await (const rawChunk of content) {
        if (context.signal?.aborted) throw new SqliteAdapterError('SQLITE_RESTORE_CANCELED', 'The SQLite recovery was canceled.', { category: 'canceled' });
        const chunk = Buffer.from(rawChunk);
        let offset = 0;
        while (offset < chunk.length) {
          if (context.signal?.aborted) throw new SqliteAdapterError('SQLITE_RESTORE_CANCELED', 'The SQLite recovery was canceled.', { category: 'canceled' });
          const written = await handle.write(chunk, offset, chunk.length - offset);
          if (!written.bytesWritten) throw new SqliteAdapterError('SQLITE_RESTORE_WRITE_FAILED', 'DeployerX could not write the SQLite recovery staging file.', { category: 'capacity', retryable: true });
          offset += written.bytesWritten;
          bytesWritten += written.bytesWritten;
        }
      }
      if (bytesWritten !== plan.sizeBytes) throw new SqliteAdapterError('SQLITE_RESTORE_SIZE_MISMATCH', 'The restored SQLite byte count does not match its authenticated Artifact.', { category: 'integrity' });
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fileSystem.chmod(plan.stagePath, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
      const validation = await this.validateRestoredFile(context, { filePath: plan.stagePath, expectedDigest: plan.expectedDigest, sizeBytes: plan.sizeBytes, protectedIdentity: plan.protectedIdentity, sqliteExecutable: plan.sqliteExecutable, timeoutMs: plan.timeoutMs });
      if (context.signal?.aborted) throw new SqliteAdapterError('SQLITE_RESTORE_CANCELED', 'The SQLite recovery was canceled.', { category: 'canceled' });
      if (await inspectRestorePath(this.fileSystem, plan.targetPath)) throw new SqliteAdapterError('SQLITE_RESTORE_TARGET_EXISTS', 'The alternate SQLite recovery target appeared before commit.', { category: 'conflict' });
      try {
        await this.fileSystem.link(plan.stagePath, plan.targetPath);
      } catch (error) {
        if (error?.code === 'EEXIST') throw new SqliteAdapterError('SQLITE_RESTORE_TARGET_EXISTS', 'The alternate SQLite recovery target appeared before commit.', { category: 'conflict' });
        if (['EACCES', 'EPERM'].includes(error?.code)) throw new SqliteAdapterError('SQLITE_RESTORE_TARGET_COMMIT_DENIED', 'DeployerX cannot publish the validated SQLite recovery at the selected target.', { category: 'authorization' });
        if (['EBUSY', 'ETXTBSY'].includes(error?.code)) throw new SqliteAdapterError('SQLITE_RESTORE_TARGET_BUSY', 'The SQLite recovery target is busy. Wait for the conflicting operation before retrying.', { category: 'conflict', retryable: true });
        throw error;
      }
      published = true;
      await this.fileSystem.rm(plan.stagePath, { force: true });
      stageOwned = false;
      let directoryHandle = null;
      try {
        directoryHandle = await this.fileSystem.open(path.dirname(plan.targetPath), 'r');
        await directoryHandle.sync();
      } catch (error) {
        if (process.platform !== 'win32') throw error;
      } finally { await directoryHandle?.close().catch(() => {}); }
      return { status: 'succeeded', targetPath: plan.targetPath, bytesWritten, validation };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (stageOwned) await this.fileSystem.rm(plan.stagePath, { force: true }).catch(() => {});
      if (error instanceof SqliteAdapterError) throw error;
      if (published) throw new SqliteAdapterError('SQLITE_RESTORE_PUBLICATION_UNCERTAIN', 'The SQLite target was published, but final durability confirmation failed. Validate the target before retrying.', { category: 'consistency' });
      if (context.signal?.aborted) throw new SqliteAdapterError('SQLITE_RESTORE_CANCELED', 'The SQLite recovery was canceled.', { category: 'canceled' });
      const nativeFailure = sqliteRestoreFailure(error);
      if (nativeFailure) throw nativeFailure;
      throw new SqliteAdapterError('SQLITE_RESTORE_FAILED', 'DeployerX could not complete the SQLite recovery.', { retryable: true });
    }
  }

  async validateRestore(context = {}, result = {}) {
    if (result.status !== 'succeeded' || !result.validation?.valid) return { valid: false, status: 'failed', nativeIntegrityValidation: false, checks: [] };
    return {
      valid: true, status: 'succeeded', nativeIntegrityValidation: true, warnings: [],
      checks: [
        { id: 'authenticated-digest', status: 'pass', safeMessage: 'The SQLite recovery matches the authenticated repository Artifact.' },
        { id: 'expected-objects', status: 'pass', safeMessage: 'The SQLite schema and object fingerprint matches the protected image.' },
        { id: 'native-integrity', status: 'pass', safeMessage: 'SQLite quick_check passed before atomic publication.' }
      ]
    };
  }
}

class SqliteConnectionService {
  constructor({ controlDatabase, deviceId, adapter = new SqliteNativeAdapter(), fileSystem = fs } = {}) {
    if (!controlDatabase) throw new TypeError('SQLite control database is required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.fileSystem = fileSystem;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { limit: 1000 })).filter((record) => record.adapterId === ADAPTER_ID)
      .map((record) => ({ ...record, capabilities: this.adapter.manifest().capabilities, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'SQLite connection name', 200);
    const databasePath = await resolveDatabasePath(this.fileSystem, input.databasePath);
    const config = normalizeConfig({ databasePath, sqliteExecutable: input.sqliteExecutable, timeoutMs: input.timeoutMs });
    return this.controlDatabase.repository('connection').create({
      workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device',
      endpoint: config, secretRefIds: [], trust: { mode: 'local-file-identity', fingerprint: null }, workerAffinity: [`device:${this.deviceId}`], lastTest: null
    });
  }

  config(connection) { return normalizeConfig(connection.endpoint); }

  async test(workspaceId, connectionId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('SQLite source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This SQLite connection belongs to another device.');
    const result = normalizeConnectionTestResult(await this.adapter.testConnection({}, this.config(current)), { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    const trust = result.status === 'success' ? { mode: 'local-file-identity', fingerprint: result.endpointIdentity?.databaseFingerprint || null, observedAt: result.testedAt } : current.trust;
    const connection = await this.controlDatabase.repository('connection').update(tenant, current.id, { lastTest: result, trust, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('SQLite source connection was not found.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the SQLite connection successfully before discovery.');
    const pages = [];
    for await (const page of this.adapter.discover({ signal: input.signal }, { connection: this.config(current), kind: input.kind || 'database' })) pages.push(page);
    return pages[0] || { items: [], nextCursor: null };
  }
}

module.exports = {
  ADAPTER_ID, ADAPTER_VERSION, IDENTITY_SQL, MAX_BACKUP_TIMEOUT_MS, MAX_DATABASES, MAX_OBJECTS, SQLITE_HEADER,
  SqliteAdapterError, SqliteConnectionService, SqliteNativeAdapter, backupDotCommand, databaseFingerprint, digestFile, inspectRestorePath, normalizeConfig, parseIdentity, parseVersion, resolveDatabasePath, restoreStagePath
};
