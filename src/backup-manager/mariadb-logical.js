const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { remapMysqlFamilyDump, remapMysqlFamilyMetadata } = require('./database-restore-target');
const { normalizeBinaryLogName, parseBinaryLogInventory, parseBinaryLogStatus, planBinaryLogSegments } = require('./mysql-family-binlog');
const { captureInventoryQuery, checkTableQueries, checkTableResult, compareInventory, expectedInventory, normalizeInventory, validationInventoryQuery } = require('./mysql-family-validation');
const { NativeProcessError, NativeProcessRunner } = require('./native-process');

const ADAPTER_ID = 'deployerx.database.mariadb.logical';
const ADAPTER_VERSION = '1.4.0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_DISCOVERED_DATABASES = 1000;
const MAX_DISCOVERED_OBJECTS = 10000;
const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const TLS_MODES = new Set(['disabled', 'preferred', 'required', 'verify-ca', 'verify-identity']);
const REQUIRED_LOGICAL_PRIVILEGES = Object.freeze(['SELECT', 'SHOW VIEW', 'TRIGGER', 'EVENT']);
const REQUIRED_RESTORE_PRIVILEGES = Object.freeze(['CREATE', 'DROP', 'ALTER', 'INSERT', 'UPDATE', 'DELETE', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'TRIGGER', 'EVENT', 'CREATE ROUTINE', 'ALTER ROUTINE']);
const REQUIRED_BINLOG_PRIVILEGES = Object.freeze(['RELOAD']);

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeHost(value) {
  const input = requiredText(value, 'MariaDB host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('MariaDB host must be a hostname or IP address without a URL scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('MariaDB host is invalid.');
  return ascii;
}

function normalizePort(value) {
  const port = Number(value ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('MariaDB port must be between 1 and 65535.');
  return port;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('MariaDB timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeExecutable(value, expectedName) {
  const executable = value === undefined || value === null || value === '' ? expectedName : requiredText(value, `${expectedName} executable`, 4096);
  const base = path.win32.basename(executable).toLowerCase().replace(/[.]exe$/, '');
  if (base !== expectedName) throw new TypeError(`Only the ${expectedName} executable may be configured.`);
  return executable;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MariaDB connection configuration must be an object.');
  const allowed = ['host', 'port', 'username', 'passwordSecretRefId', 'tlsMode', 'timeoutMs', 'mariadbExecutable', 'mariadbDumpExecutable', 'mariadbBinlogExecutable'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown MariaDB connection field: ${unknown[0]}.`);
  const username = requiredText(input.username, 'MariaDB username', 256);
  if (/\p{C}/u.test(username)) throw new TypeError('MariaDB username contains invalid characters.');
  const tlsMode = String(input.tlsMode || 'verify-identity').toLowerCase();
  if (!TLS_MODES.has(tlsMode)) throw new TypeError('MariaDB TLS mode is not supported.');
  return {
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    username,
    passwordSecretRefId: requiredText(input.passwordSecretRefId, 'MariaDB password SecretRef ID', 200),
    tlsMode,
    timeoutMs: normalizeTimeout(input.timeoutMs),
    mariadbExecutable: normalizeExecutable(input.mariadbExecutable, 'mariadb'),
    mariadbDumpExecutable: normalizeExecutable(input.mariadbDumpExecutable, 'mariadb-dump'),
    mariadbBinlogExecutable: normalizeExecutable(input.mariadbBinlogExecutable, 'mariadb-binlog')
  };
}

function supportedVersion(match, fallback = '') {
  if (!match) return { text: String(fallback || '').slice(0, 100) || null, major: null, minor: null, patch: null, supported: false };
  const version = { text: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  return { ...version, supported: (version.major === 10 && version.minor >= 6) || version.major === 11 };
}

function mariadbVersion(value) {
  const text = String(value || '');
  return supportedVersion(text.match(/Distrib\s+(\d+)\.(\d+)\.(\d+)(?:[^\r\n]*-MariaDB)/i), text);
}

function serverVersion(value) {
  const text = String(value || '');
  if (!/-MariaDB(?:\b|$)/i.test(text)) return supportedVersion(null, text);
  return supportedVersion(text.match(/^(\d+)\.(\d+)\.(\d+)/), text);
}

function optionFileValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function optionFileContents(config, password) {
  const tls = [];
  if (config.tlsMode === 'disabled') tls.push('skip-ssl');
  else if (config.tlsMode === 'required') tls.push('ssl');
  else if (config.tlsMode === 'verify-ca' || config.tlsMode === 'verify-identity') tls.push('ssl', 'ssl-verify-server-cert');
  return [
    '[client]',
    'protocol=tcp',
    `host=${optionFileValue(config.host)}`,
    `port=${config.port}`,
    `user=${optionFileValue(config.username)}`,
    `password=${optionFileValue(password)}`,
    ...tls,
    'default-character-set=utf8mb4',
    ''
  ].join('\n');
}

function safeAdapterError(error, operation) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error instanceof NativeProcessError) {
    const stderr = error.stderr.toLowerCase();
    if (stderr.includes('access denied')) return new DatabaseAdapterError('MARIADB_AUTHENTICATION_FAILED', 'MariaDB authentication failed. Check the username and password.', { category: 'authentication' });
    if (stderr.includes('ssl') || stderr.includes('tls') || stderr.includes('certificate')) return new DatabaseAdapterError('MARIADB_TLS_FAILED', 'MariaDB TLS verification failed. Check the server certificate and TLS mode.', { category: 'integrity' });
    if (stderr.includes('unknown host') || stderr.includes("can't connect") || stderr.includes('connection refused')) return new DatabaseAdapterError('MARIADB_CONNECT_FAILED', 'DeployerX could not connect to MariaDB. Check the host, port, firewall, and service.', { category: 'connectivity', retryable: true });
    if (error.code === 'NATIVE_EXECUTABLE_NOT_FOUND') return new DatabaseAdapterError('MARIADB_NATIVE_TOOL_NOT_FOUND', 'Install compatible MariaDB client tools and make mariadb and mariadb-dump available on PATH.', { category: 'compatibility' });
    if (error.code === 'NATIVE_PROCESS_CANCELED') return new DatabaseAdapterError('MARIADB_OPERATION_CANCELED', `The MariaDB ${operation} was canceled.`, { category: 'canceled' });
    if (error.code === 'NATIVE_PROCESS_TIMEOUT') return new DatabaseAdapterError('MARIADB_OPERATION_TIMEOUT', `The MariaDB ${operation} exceeded its timeout.`, { category: 'timeout', retryable: true });
  }
  return new DatabaseAdapterError('MARIADB_OPERATION_FAILED', `The MariaDB ${operation} failed.`, { category: 'execution', retryable: false });
}

function connectionFailure(error, testedAt, latencyMs) {
  const safe = safeAdapterError(error, 'connection test');
  return { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs, status: 'failure', checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null } };
}

function sqlStringLiteral(value) {
  return `CONVERT(0x${Buffer.from(String(value), 'utf8').toString('hex')} USING utf8mb4)`;
}

function normalizeObjectName(value, label = 'MariaDB object') {
  const name = requiredText(value, label, 64);
  if (/\p{C}/u.test(name)) throw new DatabaseAdapterError('MARIADB_OBJECT_NAME_INVALID', `${label} contains invalid control characters.`, { category: 'validation' });
  return name;
}

function quoteMariadbIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function selectionScope(selector = {}) {
  const databases = selector.allDatabases ? [] : (selector.databases?.include || []).map((item) => normalizeObjectName(item.name, 'MariaDB database'));
  const schemaRules = [...(selector.schemas?.include || []), ...(selector.schemas?.exclude || [])];
  if (schemaRules.length) throw new DatabaseAdapterError('MARIADB_SCHEMA_SELECTION_UNSUPPORTED', 'MariaDB schemas are selected as databases. Use table selection to narrow one database.', { category: 'compatibility' });
  if ((selector.tables?.exclude || []).length) throw new DatabaseAdapterError('MARIADB_TABLE_EXCLUDES_UNSUPPORTED', 'Select the MariaDB tables to include; table exclusion rules are not supported.', { category: 'compatibility' });
  const tables = (selector.tables?.include || []).map((item) => ({
    database: normalizeObjectName(item.database, 'MariaDB table database'),
    schema: normalizeObjectName(item.schema, 'MariaDB table schema'),
    name: normalizeObjectName(item.name, 'MariaDB table')
  }));
  if (!tables.length) return { mode: 'databases', databases, database: null, tables: [] };
  if (selector.allDatabases || databases.length !== 1) throw new DatabaseAdapterError('MARIADB_PARTIAL_DATABASE_SCOPE_INVALID', 'MariaDB table selection requires exactly one selected database.', { category: 'validation' });
  const [database] = databases;
  if (tables.some((item) => item.database !== database || item.schema !== database)) throw new DatabaseAdapterError('MARIADB_TABLE_SCOPE_INVALID', 'Every selected MariaDB table must belong to the selected database.', { category: 'validation' });
  return { mode: 'tables', databases, database, tables: tables.map((item) => item.name) };
}

function selectedDatabasePredicate(selector) {
  const scope = selectionScope(selector);
  if (scope.mode === 'tables') return `TABLE_SCHEMA = ${sqlStringLiteral(scope.database)} AND TABLE_NAME IN (${scope.tables.map(sqlStringLiteral).join(',')})`;
  if (selector.allDatabases) return "TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')";
  return `TABLE_SCHEMA IN (${scope.databases.map(sqlStringLiteral).join(',')})`;
}

function hasLogicalPrivileges(grantsOutput) {
  const grants = String(grantsOutput || '').toUpperCase();
  if (/GRANT\s+ALL(?:\s+PRIVILEGES)?\s+ON/.test(grants)) return true;
  return REQUIRED_LOGICAL_PRIVILEGES.every((privilege) => grants.includes(privilege));
}

function hasLogicalRestorePrivileges(grantsOutput) {
  const grants = String(grantsOutput || '').toUpperCase();
  if (/GRANT\s+ALL(?:\s+PRIVILEGES)?\s+ON/.test(grants)) return true;
  return REQUIRED_RESTORE_PRIVILEGES.every((privilege) => grants.includes(privilege));
}

function hasBinlogPrivileges(grantsOutput) {
  const grants = String(grantsOutput || '').toUpperCase();
  if (/GRANT\s+ALL(?:\s+PRIVILEGES)?\s+ON/.test(grants)) return true;
  const monitor = grants.includes('BINLOG MONITOR') || grants.includes('REPLICATION CLIENT');
  return REQUIRED_BINLOG_PRIVILEGES.every((privilege) => grants.includes(privilege)) && monitor && grants.includes('REPLICATION SLAVE');
}

function dumpArguments(_config, selector, captureCoordinates = false) {
  const scope = selectionScope(selector);
  const args = [
    '--single-transaction', '--quick', '--skip-lock-tables', '--triggers', '--hex-blob',
    '--default-character-set=utf8mb4', '--max-allowed-packet=1073741824', '--net-buffer-length=16384'
  ];
  if (captureCoordinates) args.push('--master-data=2');
  if (scope.mode === 'tables') return [...args, '--skip-routines', '--skip-events', scope.database, ...scope.tables];
  args.push('--routines', '--events');
  if (selector.allDatabases) args.push('--all-databases');
  else args.push('--databases', ...scope.databases);
  return args;
}

class MariadbLogicalAdapter {
  constructor({ processRunner = new NativeProcessRunner(), fileSystem = fs, temporaryRoot = os.tmpdir(), clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!processRunner || typeof processRunner.run !== 'function' || typeof processRunner.stream !== 'function' || typeof processRunner.consume !== 'function') throw new TypeError('MariaDB process runner is required.');
    this.processRunner = processRunner;
    this.fileSystem = fileSystem;
    this.temporaryRoot = temporaryRoot;
    this.clock = clock;
    this.now = now;
  }

  manifest() {
    return {
      apiVersion: 1, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, displayName: 'MariaDB logical backup', engine: 'mariadb', serverVersionRange: '>=10.6.0 <12.0.0', restoreVersionRange: '>=10.6.0 <12.0.0',
      capabilities: {
        backupMethods: ['logical'], backupModes: ['full', 'incremental'], selection: { database: true, schema: false, table: true, globalObjects: false },
        consistencyStrategies: [{ id: 'transaction-snapshot', produces: 'application', backupMethods: ['logical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: true }],
        transactionLogs: { supported: true, type: 'mariadb-binary-log', pointInTimeRecovery: true, granularitySeconds: 1 },
        streaming: { backup: true, restore: true, compression: false, encryption: false }, restore: { alternateTarget: true, nativeValidation: true }, replicaAware: false
      },
      requiredTools: [
        { name: 'mariadb', versionRange: '>=10.6.0 <12.0.0', operations: ['backup', 'restore', 'validation'] },
        { name: 'mariadb-dump', versionRange: '>=10.6.0 <12.0.0', operations: ['backup'] },
        { name: 'mariadb-binlog', versionRange: '>=10.6.0 <12.0.0', operations: ['point-in-time-capture', 'point-in-time-restore'] }
      ],
      requiredPrivileges: [{ id: 'mariadb-logical-read', operations: ['backup'], required: true, safeDescription: 'SELECT, SHOW VIEW, TRIGGER, and EVENT access is required for selected databases.' }]
        .concat([{ id: 'mariadb-logical-restore', operations: ['restore'], required: true, safeDescription: 'Create, modify, and remove database objects and data on the selected restore target.' }, { id: 'mariadb-binlog-read', operations: ['point-in-time-capture'], required: true, safeDescription: 'RELOAD, BINLOG MONITOR or REPLICATION CLIENT, and REPLICATION SLAVE are required for binary-log capture.' }])
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'MARIADB_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async #credentialSession(context, input) {
    const config = normalizeConfig(input);
    if (typeof context?.resolveSecret !== 'function') throw new DatabaseAdapterError('MARIADB_SECRET_RESOLVER_MISSING', 'MariaDB credentials are unavailable.', { category: 'authentication' });
    const password = await context.resolveSecret(config.passwordSecretRefId);
    const directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, 'deployerx-mariadb-'));
    const filePath = path.join(directory, 'client.cnf');
    try {
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      await this.fileSystem.writeFile(filePath, optionFileContents(config, password), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.fileSystem.chmod(filePath, 0o600).catch(() => {});
      return { config, filePath, cleanup: () => this.fileSystem.rm(directory, { recursive: true, force: true }) };
    } catch (error) {
      await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async #runClient(context, input, query, options = {}) {
    const session = await this.#credentialSession(context, input);
    try {
      return await this.processRunner.run({
        executable: session.config.mariadbExecutable,
        args: [`--defaults-extra-file=${session.filePath}`, '--batch', '--skip-column-names', '--raw', `--connect-timeout=${Math.ceil(session.config.timeoutMs / 1000)}`, `--execute=${query}`, ...(options.database ? [normalizeObjectName(options.database, 'MariaDB query database')] : [])],
        timeoutMs: options.timeoutMs || session.config.timeoutMs,
        stdoutLimitBytes: options.stdoutLimitBytes || 4 * 1024 * 1024,
        signal: context.signal
      });
    } catch (error) { throw safeAdapterError(error, options.operation || 'query'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async #toolVersion(executable, name, signal) {
    try {
      const result = await this.processRunner.run({ executable, args: ['--version'], timeoutMs: 10000, stdoutLimitBytes: 4096, signal });
      return { name, ...mariadbVersion(result.stdout) };
    } catch (error) {
      const safe = safeAdapterError(error, 'tool check');
      return { name, text: null, major: null, minor: null, patch: null, supported: false, errorCode: safe.code };
    }
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const config = normalizeConfig(input);
      const result = await this.#runClient(context, config, 'SELECT VERSION(), @@server_id, @@hostname, @@version_comment;', { operation: 'connection test' });
      const [versionText, serverId, hostname, versionComment] = result.stdout.trim().split('\t');
      const version = serverVersion(versionText);
      if (!version.supported || !serverId || !hostname) throw new DatabaseAdapterError('MARIADB_SERVER_VERSION_UNSUPPORTED', 'DeployerX requires MariaDB 10.6 through 11.x for logical backup.', { category: 'compatibility' });
      const identityMaterial = `${config.host}:${config.port}:${serverId}:${hostname}`;
      return {
        adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'success',
        checks: [
          { id: 'authentication', status: 'pass', safeMessage: 'MariaDB authentication succeeded.' },
          { id: 'server-version', status: 'pass', safeMessage: `MariaDB ${version.text} is supported.` },
          { id: 'server-identity', status: 'pass', safeMessage: 'MariaDB server identity was captured.' },
          { id: 'tls', status: config.tlsMode === 'disabled' ? 'warning' : 'pass', safeMessage: config.tlsMode === 'disabled' ? 'MariaDB traffic is not required to use TLS.' : 'The configured MariaDB TLS policy was accepted.' }
        ],
        remotePlatform: { engine: 'mariadb', version: version.text, distribution: String(versionComment || '').slice(0, 200) },
        endpointIdentity: { serverFingerprint: `sha256:${crypto.createHash('sha256').update(identityMaterial).digest('hex')}` },
        error: null
      };
    } catch (error) { return connectionFailure(error, testedAt, Math.max(0, this.now() - started)); }
  }

  async *discover(context = {}, request = {}) {
    try {
      if (request.kind === 'table') {
        const database = normalizeObjectName(request.database, 'MariaDB discovery database');
        if (SYSTEM_DATABASES.has(database)) throw new DatabaseAdapterError('MARIADB_SYSTEM_DATABASE_SELECTION_REFUSED', 'System database objects cannot be selected for protection.', { category: 'validation' });
        const query = `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables WHERE TABLE_SCHEMA=${sqlStringLiteral(database)} ORDER BY TABLE_NAME;`;
        const result = await this.#runClient(context, request.connection, query, { operation: 'table discovery', stdoutLimitBytes: 8 * 1024 * 1024 });
        const objects = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          const [nameValue, typeValue] = line.split('\t');
          const name = normalizeObjectName(nameValue, 'Discovered MariaDB table');
          const objectType = String(typeValue || '').toUpperCase() === 'VIEW' ? 'view' : 'table';
          return { id: `mariadb-table:${crypto.createHash('sha256').update(`${database}\0${name}`).digest('hex').slice(0, 24)}`, kind: 'table', database, schema: database, name, objectType, selectable: true };
        }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
        if (objects.length > MAX_DISCOVERED_OBJECTS) throw new DatabaseAdapterError('MARIADB_DISCOVERY_LIMIT_EXCEEDED', 'The MariaDB database contains too many objects to list safely.', { category: 'capacity' });
        yield { items: objects, nextCursor: null };
        return;
      }
      if (request.kind && request.kind !== 'database') throw new DatabaseAdapterError('MARIADB_DISCOVERY_KIND_UNSUPPORTED', 'This MariaDB object type cannot be discovered.', { category: 'compatibility' });
      const result = await this.#runClient(context, request.connection, 'SHOW DATABASES;', { operation: 'database discovery', stdoutLimitBytes: 2 * 1024 * 1024 });
      const includeSystem = request.includeSystem === true;
      const names = [...new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))].filter((name) => includeSystem || !SYSTEM_DATABASES.has(name)).sort((left, right) => left.localeCompare(right, 'en-US'));
      if (names.length > MAX_DISCOVERED_DATABASES) throw new DatabaseAdapterError('MARIADB_DISCOVERY_LIMIT_EXCEEDED', 'The MariaDB server contains too many databases to list safely.', { category: 'capacity' });
      yield { items: names.map((name) => ({ id: `mariadb-db:${crypto.createHash('sha256').update(name).digest('hex').slice(0, 24)}`, kind: 'database', name, selectable: !SYSTEM_DATABASES.has(name) })), nextCursor: null };
    } catch (error) { throw safeAdapterError(error, 'database discovery'); }
  }

  async preflight(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const selector = request.selector;
    const scope = selectionScope(selector);
    const captureCoordinates = request.consistency?.captureCoordinates === true;
    if (captureCoordinates && (scope.mode !== 'databases' || selector.allDatabases || scope.databases.length !== 1)) throw new DatabaseAdapterError('MARIADB_PITR_SCOPE_INVALID', 'MariaDB point-in-time recovery requires exactly one whole selected user database.', { category: 'compatibility' });
    const [serverResult, grantsResult, engineResult, inventoryResult, clientTool, dumpTool, binlogTool, binlogVariables] = await Promise.all([
      this.#runClient(context, config, 'SELECT VERSION(), @@server_id, @@hostname, @@version_comment, @@character_set_server, @@collation_server;', { operation: 'preflight server check' }),
      this.#runClient(context, config, 'SHOW GRANTS FOR CURRENT_USER();', { operation: 'preflight privilege check' }),
      this.#runClient(context, config, `SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_TYPE='BASE TABLE' AND ENGINE <> 'InnoDB' AND ${selectedDatabasePredicate(selector)};`, { operation: 'preflight consistency check' }),
      this.#runClient(context, config, captureInventoryQuery(selector, scope), { operation: 'preflight validation inventory', stdoutLimitBytes: 8 * 1024 * 1024 }),
      this.#toolVersion(config.mariadbExecutable, 'mariadb', context.signal),
      this.#toolVersion(config.mariadbDumpExecutable, 'mariadb-dump', context.signal),
      captureCoordinates ? this.#toolVersion(config.mariadbBinlogExecutable, 'mariadb-binlog', context.signal) : Promise.resolve(null),
      captureCoordinates ? this.#runClient(context, config, 'SELECT @@global.log_bin, @@global.binlog_format, @@global.binlog_row_image, @@global.binlog_checksum;', { operation: 'binary-log preflight' }) : Promise.resolve(null)
    ]);
    const [versionText, serverId, hostname, versionComment, characterSet, collation] = serverResult.stdout.trim().split('\t');
    const version = serverVersion(versionText);
    const nonTransactionalTables = Number(engineResult.stdout.trim());
    const privilegesAllowed = hasLogicalPrivileges(grantsResult.stdout);
    const [logBin, binlogFormat, binlogRowImage, binlogChecksum] = binlogVariables?.stdout.trim().split('\t') || [];
    const binlogPrivilegesAllowed = !captureCoordinates || hasBinlogPrivileges(grantsResult.stdout);
    const binlogConfigurationAllowed = !captureCoordinates || (String(logBin).toUpperCase() === '1' || String(logBin).toUpperCase() === 'ON') && String(binlogFormat).toUpperCase() === 'ROW' && String(binlogRowImage).toUpperCase() === 'FULL';
    const coordinateCaptureVerified = !captureCoordinates || Boolean(binlogTool?.supported && binlogPrivilegesAllowed && binlogConfigurationAllowed);
    let validationInventory;
    try { validationInventory = normalizeInventory(inventoryResult.stdout, normalizeObjectName, 'MARIADB'); }
    catch (error) { throw new DatabaseAdapterError(error.code || 'MARIADB_VALIDATION_INVENTORY_INVALID', error.message, { category: error.category || 'integrity' }); }
    const identity = `sha256:${crypto.createHash('sha256').update(`${config.host}:${config.port}:${serverId || 'unknown'}:${hostname || 'unknown'}`).digest('hex')}`;
    const warnings = [];
    if (config.tlsMode === 'disabled') warnings.push('MariaDB transport encryption is disabled by configuration.');
    if (nonTransactionalTables > 0) warnings.push(`${nonTransactionalTables} selected table(s) are not InnoDB and cannot share the transaction snapshot.`);
    if (scope.mode === 'tables') warnings.push('A table-only MariaDB backup omits database-level routines and events and does not include dependencies outside the selected tables.');
    return {
      checkedAt: this.clock(), serverVersion: version.text, serverVersionSupported: version.supported, serverIdentityFingerprint: identity,
      consistency: [{ method: 'transaction-snapshot', verified: Number.isInteger(nonTransactionalTables) && nonTransactionalTables === 0, produces: 'application', reasonCode: nonTransactionalTables > 0 ? 'MARIADB_NON_TRANSACTIONAL_TABLES' : null }],
      tools: [clientTool, dumpTool, ...(binlogTool ? [binlogTool] : [])].map((tool) => ({ name: tool.name, version: tool.text, compatible: tool.supported, executableFingerprint: tool.text ? `sha256:${crypto.createHash('sha256').update(`${tool.name}:${tool.text}`).digest('hex')}` : null })),
      privileges: [{ id: 'mariadb-logical-read', allowed: privilegesAllowed, evidence: privilegesAllowed ? 'Required logical-backup grants were observed.' : 'SELECT, SHOW VIEW, TRIGGER, and EVENT grants were not all observed.' }, ...(captureCoordinates ? [{ id: 'mariadb-binlog-read', allowed: binlogPrivilegesAllowed, evidence: binlogPrivilegesAllowed ? 'Binary-log monitoring and remote-read grants were observed.' : 'RELOAD, BINLOG MONITOR or REPLICATION CLIENT, and REPLICATION SLAVE grants were not all observed.' }] : [])],
      coordinateCaptureVerified,
      warnings,
      metadata: { engine: 'mariadb', serverVersion: version.text, distribution: String(versionComment || '').slice(0, 200), characterSet: String(characterSet || '').slice(0, 100), collation: String(collation || '').slice(0, 100), serverId: String(serverId || '').slice(0, 100), hostname: String(hostname || '').slice(0, 253), serverIdentityFingerprint: identity, nonTransactionalTables, selectionMode: scope.mode, selectedDatabases: selector.allDatabases ? validationInventory.databases : scope.databases, selectedSchemas: [], selectedTables: scope.mode === 'tables' ? scope.tables.map((name) => ({ database: scope.database, schema: scope.database, name })) : [], validationInventoryVersion: 1, expectedDatabases: validationInventory.databases, expectedObjects: validationInventory.objects, binaryLog: captureCoordinates ? { enabled: String(logBin).toUpperCase() === '1' || String(logBin).toUpperCase() === 'ON', format: String(binlogFormat || '').toUpperCase(), rowImage: String(binlogRowImage || '').toUpperCase(), checksum: String(binlogChecksum || '').toUpperCase(), privilegesVerified: binlogPrivilegesAllowed, toolVerified: Boolean(binlogTool?.supported) } : null }
    };
  }

  async planBackup(_context = {}, request = {}) {
    if (request.consistency?.proven !== true || request.consistency?.method !== 'transaction-snapshot' || request.consistency?.achievedLevel !== 'application') throw new DatabaseAdapterError('MARIADB_CONSISTENCY_PLAN_INVALID', 'MariaDB logical backup requires a proven transaction snapshot.', { category: 'consistency' });
    const config = normalizeConfig(request.connection);
    const scope = selectionScope(request.selector);
    return { version: 1, operation: 'mariadb-logical-backup', connection: config, selector: request.selector, dumpArguments: dumpArguments(config, request.selector, request.consistency.captureCoordinates), restoreDatabase: scope.mode === 'tables' ? scope.database : null, consistency: request.consistency, databaseMetadata: request.consistency.evidence?.metadata || {}, artifact: { kind: 'database-dump', path: 'mariadb/logical-dump.sql', mediaType: 'application/sql' }, resumable: false };
  }

  async openBackup(context = {}, plan = {}) {
    if (plan.operation !== 'mariadb-logical-backup' || plan.consistency?.proven !== true) throw new DatabaseAdapterError('MARIADB_BACKUP_PLAN_INVALID', 'The MariaDB backup plan is invalid.', { category: 'integrity' });
    const session = await this.#credentialSession(context, plan.connection);
    let started;
    try {
      started = this.processRunner.stream({ executable: session.config.mariadbDumpExecutable, args: [`--defaults-extra-file=${session.filePath}`, ...plan.dumpArguments], timeoutMs: Math.max(session.config.timeoutMs, 24 * 60 * 60 * 1000), signal: context.signal });
    } catch (error) {
      await session.cleanup().catch(() => {});
      throw safeAdapterError(error, 'logical backup');
    }
    const content = (async function* streamDump() {
      let completed = false;
      try {
        for await (const chunk of started.stdout) {
          await context.onProgress?.({ phase: 'reading', bytesRead: Buffer.byteLength(chunk), path: plan.artifact.path });
          yield Buffer.from(chunk);
        }
        await started.completion;
        completed = true;
      } catch (error) { throw safeAdapterError(error, 'logical backup'); }
      finally {
        if (!completed) started.cancel();
        await started.completion.catch(() => {});
        await session.cleanup().catch(() => {});
      }
    })();
    return { content, artifact: plan.artifact, metadata: { ...plan.databaseMetadata, selectorDigest: plan.selector.digest, consistency: plan.consistency } };
  }

  async prepareBinaryLogCapture(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const scope = selectionScope(request.selector);
    if (scope.mode !== 'databases' || request.selector?.allDatabases || scope.databases.length !== 1) throw new DatabaseAdapterError('MARIADB_PITR_SCOPE_INVALID', 'MariaDB binary-log capture requires exactly one whole selected user database.', { category: 'compatibility' });
    const capturedAt = this.clock();
    const [serverResult, grantsResult, variablesResult, statusResult, inventoryResult, binlogTool] = await Promise.all([
      this.#runClient(context, config, 'SELECT VERSION(), @@server_id, @@hostname, @@version_comment;', { operation: 'binary-log server identity check' }),
      this.#runClient(context, config, 'SHOW GRANTS FOR CURRENT_USER();', { operation: 'binary-log privilege check' }),
      this.#runClient(context, config, 'SELECT @@global.log_bin, @@global.binlog_format, @@global.binlog_row_image, @@global.binlog_checksum;', { operation: 'binary-log configuration check' }),
      this.#runClient(context, config, 'SHOW MASTER STATUS;', { operation: 'binary-log coordinate capture' }),
      this.#runClient(context, config, 'SHOW BINARY LOGS;', { operation: 'binary-log inventory', stdoutLimitBytes: 8 * 1024 * 1024 }),
      this.#toolVersion(config.mariadbBinlogExecutable, 'mariadb-binlog', context.signal)
    ]);
    const [versionText, serverId, hostname] = serverResult.stdout.trim().split('\t');
    const version = serverVersion(versionText);
    const identity = `sha256:${crypto.createHash('sha256').update(`${config.host}:${config.port}:${serverId || 'unknown'}:${hostname || 'unknown'}`).digest('hex')}`;
    const [logBin, binlogFormat, rowImage, checksum] = variablesResult.stdout.trim().split('\t');
    if (!version.supported || identity !== request.startCoordinate?.serverIdentityFingerprint) throw new DatabaseAdapterError('MARIADB_BINLOG_SERVER_IDENTITY_CHANGED', 'The MariaDB server identity changed after the preceding recovery point.', { category: 'integrity' });
    if (!hasBinlogPrivileges(grantsResult.stdout)) throw new DatabaseAdapterError('MARIADB_BINLOG_PRIVILEGES_MISSING', 'The MariaDB account lacks the privileges required for binary-log capture.', { category: 'authorization' });
    if (!binlogTool.supported) throw new DatabaseAdapterError('MARIADB_BINLOG_TOOL_UNAVAILABLE', 'Install a compatible mariadb-binlog client on this worker.', { category: 'compatibility' });
    if (!(['1', 'ON'].includes(String(logBin).toUpperCase())) || String(binlogFormat).toUpperCase() !== 'ROW' || String(rowImage).toUpperCase() !== 'FULL') throw new DatabaseAdapterError('MARIADB_BINLOG_CONFIGURATION_UNSAFE', 'MariaDB point-in-time recovery requires binary logging in ROW format with FULL row images.', { category: 'compatibility' });
    const end = parseBinaryLogStatus(statusResult.stdout, { engine: 'mariadb', capturedAt, serverIdentityFingerprint: identity });
    const inventory = parseBinaryLogInventory(inventoryResult.stdout);
    const interval = planBinaryLogSegments({ start: request.startCoordinate, end, inventory });
    return { version: 1, operation: 'mariadb-binlog-capture', connection: config, database: scope.databases[0], checksum: String(checksum || '').toUpperCase(), nativeTool: binlogTool, ...interval };
  }

  async captureBinaryLogs(context = {}, plan = {}, destinationDirectory) {
    if (plan.operation !== 'mariadb-binlog-capture' || !Array.isArray(plan.segments)) throw new DatabaseAdapterError('MARIADB_BINLOG_CAPTURE_PLAN_INVALID', 'The MariaDB binary-log capture plan is invalid.', { category: 'integrity' });
    const directory = requiredText(destinationDirectory, 'MariaDB binary-log destination', 4096);
    const session = await this.#credentialSession(context, plan.connection);
    const files = [];
    try {
      for (const segment of plan.segments) {
        const filePath = path.join(directory, segment.file);
        await this.processRunner.run({ executable: session.config.mariadbBinlogExecutable, args: [`--defaults-extra-file=${session.filePath}`, '--read-from-remote-server', '--raw', '--verify-binlog-checksum', `--result-file=${directory}${path.sep}`, segment.file], timeoutMs: Math.max(session.config.timeoutMs, 24 * 60 * 60 * 1000), stdoutLimitBytes: 1024 * 1024, signal: context.signal });
        const stat = await this.fileSystem.stat(filePath);
        if (!stat.isFile() || stat.size < segment.stopPosition) throw new DatabaseAdapterError('MARIADB_BINLOG_DOWNLOAD_INCOMPLETE', 'A downloaded MariaDB binary-log file does not cover the planned interval.', { category: 'integrity' });
        files.push({ ...segment, filePath, sizeBytes: stat.size });
      }
      return files;
    } catch (error) { throw safeAdapterError(error, 'binary-log capture'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async executeBinaryLogReplay(context = {}, request = {}) {
    const connection = normalizeConfig(request.connection);
    const sourceDatabase = normalizeObjectName(request.sourceDatabase, 'MariaDB PITR source database');
    const targetDatabase = normalizeObjectName(request.targetDatabase || sourceDatabase, 'MariaDB PITR target database');
    const files = Array.isArray(request.files) ? request.files.slice(0, 10000) : [];
    if (!files.length) throw new DatabaseAdapterError('MARIADB_PITR_LOG_FILES_MISSING', 'The MariaDB point-in-time restore has no binary-log files.', { category: 'integrity' });
    const stop = request.stop || {};
    const stopSequence = stop.type === 'coordinate' ? normalizeBinaryLogName(stop.coordinate?.file).sequence : null;
    const session = await this.#credentialSession(context, connection);
    const runner = this.processRunner;
    const executable = connection.mariadbBinlogExecutable;
    const signal = context.signal;
    let replayedFiles = 0;
    const decoded = (async function* decodeLogs() {
      for (const file of files) {
        const sequence = normalizeBinaryLogName(file.file).sequence;
        if (stopSequence !== null && sequence > stopSequence) break;
        const stopPosition = stopSequence === sequence ? Math.min(file.stopPosition, stop.coordinate.position) : file.stopPosition;
        if (stopPosition <= file.startPosition) continue;
        const args = ['--verify-binlog-checksum', '--skip-gtids', `--database=${sourceDatabase}`, `--start-position=${file.startPosition}`, `--stop-position=${stopPosition}`];
        if (targetDatabase !== sourceDatabase) args.push(`--rewrite-db=${sourceDatabase}->${targetDatabase}`);
        if (stop.type === 'timestamp') args.push(`--stop-datetime=${stop.timestamp.replace('T', ' ').replace(/[.]\d{3}Z$/, '')}`);
        args.push(requiredText(file.filePath, 'MariaDB binary-log file path', 4096));
        const started = runner.stream({ executable, args, env: { TZ: 'UTC' }, timeoutMs: Math.max(connection.timeoutMs, 24 * 60 * 60 * 1000), signal });
        let completed = false;
        try {
          for await (const chunk of started.stdout) yield Buffer.from(chunk);
          await started.completion;
          completed = true;
          replayedFiles += 1;
        } finally {
          if (!completed) started.cancel();
          await started.completion.catch(() => {});
        }
      }
    })();
    try {
      await this.processRunner.consume({ executable: connection.mariadbExecutable, args: [`--defaults-extra-file=${session.filePath}`, `--connect-timeout=${Math.ceil(connection.timeoutMs / 1000)}`, '--default-character-set=utf8mb4', targetDatabase], stdin: decoded, timeoutMs: Math.max(connection.timeoutMs, 24 * 60 * 60 * 1000), signal, stdoutLimitBytes: 1024 * 1024 });
      return { status: 'succeeded', replayedFiles, sourceDatabase, targetDatabase, stop };
    } catch (error) { throw safeAdapterError(error, 'point-in-time replay'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async executeBackup(context = {}, plan = {}, sink) {
    if (!sink || typeof sink.write !== 'function') throw new TypeError('MariaDB backup artifact sink is required.');
    const opened = await this.openBackup(context, plan);
    const stored = await sink.write({ ...opened.artifact, content: opened.content, metadata: opened.metadata });
    return { status: 'succeeded', artifacts: [stored || opened.artifact], consistency: plan.consistency, metadata: opened.metadata };
  }

  async prepareRestoreTarget(context = {}, request = {}) {
    const mode = String(request.mode || 'original');
    if (!['original', 'alternate', 'new-database'].includes(mode)) throw new DatabaseAdapterError('MARIADB_RESTORE_MODE_INVALID', 'The MariaDB restore target mode is not supported.', { category: 'validation' });
    const connection = normalizeConfig(request.connection);
    const originalMetadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    const mapping = mode === 'new-database' ? remapMysqlFamilyMetadata(originalMetadata, request.targetDatabase) : null;
    const metadata = mapping?.metadata || originalMetadata;
    if (mode === 'original') return { metadata, sourceDatabase: null, targetDatabase: null, databaseCreated: false, collisions: [] };
    const [result, grantsResult] = await Promise.all([
      this.#runClient(context, connection, 'SHOW DATABASES;', { operation: 'restore target discovery', stdoutLimitBytes: 2 * 1024 * 1024 }),
      this.#runClient(context, connection, 'SHOW GRANTS FOR CURRENT_USER();', { operation: 'restore target privilege check', stdoutLimitBytes: 1024 * 1024 })
    ]);
    if (!hasLogicalRestorePrivileges(grantsResult.stdout)) throw new DatabaseAdapterError('MARIADB_RESTORE_PRIVILEGES_MISSING', 'The selected MariaDB target account lacks the privileges required to create and replace restored objects.', { category: 'authorization' });
    const existing = new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
    const databaseNames = Array.isArray(metadata.expectedDatabases) && metadata.expectedDatabases.length ? metadata.expectedDatabases : metadata.selectedDatabases || [];
    const expectedDatabases = [...new Set(databaseNames.map((name) => normalizeObjectName(name, 'MariaDB restore database')))];
    if (!expectedDatabases.length) throw new DatabaseAdapterError('MARIADB_RESTORE_TARGET_INVENTORY_UNAVAILABLE', 'This recovery point does not contain the database inventory required for a safe alternate target restore.', { category: 'compatibility' });
    const collisions = expectedDatabases.filter((name) => existing.has(name));
    if (mode === 'new-database' && collisions.length) throw new DatabaseAdapterError('MARIADB_NEW_DATABASE_EXISTS', 'Choose a new MariaDB database name that does not already exist on the target server.', { category: 'conflict' });
    if (mode === 'alternate' && collisions.length && request.conflictPolicy !== 'overwrite') throw new DatabaseAdapterError('MARIADB_ALTERNATE_TARGET_CONFLICT', 'The alternate MariaDB server already contains a protected database. Choose overwrite explicitly or use another target.', { category: 'conflict' });
    const partial = metadata.selectionMode === 'tables';
    let databaseCreated = false;
    if (partial && expectedDatabases.length === 1 && !existing.has(expectedDatabases[0])) {
      await this.#runClient(context, connection, `CREATE DATABASE ${quoteMariadbIdentifier(expectedDatabases[0])};`, { operation: 'restore target database creation' });
      databaseCreated = true;
    }
    return { metadata, sourceDatabase: mapping?.sourceDatabase || null, targetDatabase: mapping?.targetDatabase || null, databaseCreated, collisions };
  }

  async planRestore(_context = {}, request = {}) {
    const mode = String(request.mode || 'original');
    const confirmations = { original: 'RESTORE_MARIADB_ORIGINAL', alternate: 'RESTORE_MARIADB_ALTERNATE', 'new-database': 'RESTORE_MARIADB_NEW_DATABASE' };
    if (!confirmations[mode]) throw new DatabaseAdapterError('MARIADB_RESTORE_MODE_INVALID', 'The MariaDB restore target mode is not supported.', { category: 'validation' });
    if (request.confirmation !== confirmations[mode]) throw new DatabaseAdapterError('MARIADB_RESTORE_CONFIRMATION_REQUIRED', 'Explicit confirmation is required before restoring the MariaDB databases.', { category: 'conflict' });
    const connection = normalizeConfig(request.connection);
    const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    if (mode === 'original' && (!metadata.serverIdentityFingerprint || metadata.serverIdentityFingerprint !== request.serverIdentityFingerprint)) throw new DatabaseAdapterError('MARIADB_RESTORE_SERVER_MISMATCH', 'The restore target does not match the protected MariaDB server identity.', { category: 'integrity' });
    if (mode === 'alternate' && metadata.serverIdentityFingerprint === request.serverIdentityFingerprint) throw new DatabaseAdapterError('MARIADB_ALTERNATE_TARGET_IS_ORIGINAL', 'Choose a MariaDB server with a different verified server identity for alternate-server restore.', { category: 'conflict' });
    if (mode !== 'original' && request.targetPrepared !== true) throw new DatabaseAdapterError('MARIADB_RESTORE_TARGET_NOT_PREPARED', 'The MariaDB restore target must pass destination preflight before restore.', { category: 'validation' });
    const restoreDatabase = metadata.selectionMode === 'tables' && Array.isArray(metadata.selectedDatabases) && metadata.selectedDatabases.length === 1
      ? normalizeObjectName(metadata.selectedDatabases[0], 'MariaDB restore database')
      : null;
    const mapping = mode === 'new-database' ? metadata.restoreDatabaseMapping : null;
    if (mode === 'new-database' && (!mapping?.sourceDatabase || !mapping?.targetDatabase)) throw new DatabaseAdapterError('MARIADB_RESTORE_MAPPING_INVALID', 'The MariaDB new-database mapping is invalid.', { category: 'integrity' });
    return { version: 2, operation: 'mariadb-logical-restore', mode, connection, artifactPath: requiredText(request.artifactPath, 'MariaDB dump artifact path', 8192), metadata, restoreDatabase, databaseMapping: mapping || null, destructive: mode !== 'new-database' || Boolean(request.databaseCreated) };
  }

  async executeRestore(context = {}, plan = {}, source) {
    if (plan.operation !== 'mariadb-logical-restore' || !source || typeof source.open !== 'function') throw new DatabaseAdapterError('MARIADB_RESTORE_PLAN_INVALID', 'The MariaDB restore plan is invalid.', { category: 'integrity' });
    const session = await this.#credentialSession(context, plan.connection);
    try {
      const openedContent = await source.open({ kind: 'database-dump', path: plan.artifactPath });
      const content = plan.databaseMapping && plan.metadata.selectionMode !== 'tables'
        ? remapMysqlFamilyDump(openedContent, plan.databaseMapping.sourceDatabase, plan.databaseMapping.targetDatabase)
        : openedContent;
      await this.processRunner.consume({ executable: session.config.mariadbExecutable, args: [`--defaults-extra-file=${session.filePath}`, `--connect-timeout=${Math.ceil(session.config.timeoutMs / 1000)}`, '--default-character-set=utf8mb4', ...(plan.restoreDatabase ? [plan.restoreDatabase] : [])], stdin: content, timeoutMs: Math.max(session.config.timeoutMs, 24 * 60 * 60 * 1000), signal: context.signal, stdoutLimitBytes: 1024 * 1024 });
      return { status: 'succeeded', restoredArtifactPath: plan.artifactPath, validationRequired: true, metadata: plan.metadata };
    } catch (error) { throw safeAdapterError(error, 'logical restore'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async validateRestore(context = {}, result = {}) {
    if (result.status !== 'succeeded') return { status: 'failed', valid: false, checks: [] };
    try {
      const expected = expectedInventory(result.metadata || {}, normalizeObjectName, 'MARIADB');
      if (!expected) {
        const query = await this.#runClient(context, context.connection, 'SELECT 1;', { operation: 'legacy restore connectivity validation' });
        const valid = query.stdout.trim() === '1';
        return { status: valid ? 'warning' : 'failed', valid, checks: [{ id: 'connectivity', status: valid ? 'pass' : 'fail', databasesChecked: valid ? 1 : 0 }, { id: 'expected-objects', status: 'warning', reasonCode: 'MARIADB_VALIDATION_INVENTORY_UNAVAILABLE' }], nativeIntegrityValidation: false, warnings: valid ? [{ code: 'MARIADB_VALIDATION_INVENTORY_UNAVAILABLE', safeMessage: 'This older recovery point has no authenticated expected-object inventory; only connectivity could be validated.' }] : [] };
      }
      for (const database of expected.databases) {
        const query = await this.#runClient(context, context.connection, 'SELECT 1;', { operation: 'restore database connectivity validation', database });
        if (query.stdout.trim() !== '1') return { status: 'failed', valid: false, checks: [{ id: 'connectivity', status: 'fail', databasesChecked: 0 }], nativeIntegrityValidation: false };
      }
      const inventoryResult = await this.#runClient(context, context.connection, validationInventoryQuery({ ...(result.metadata || {}), expectedDatabases: expected.databases }), { operation: 'restore expected-object validation', stdoutLimitBytes: 8 * 1024 * 1024 });
      const actual = normalizeInventory(inventoryResult.stdout, normalizeObjectName, 'MARIADB');
      const comparison = compareInventory(expected, actual);
      const checks = [
        { id: 'connectivity', status: 'pass', databasesChecked: expected.databases.length },
        { id: 'expected-objects', status: comparison.valid ? 'pass' : 'fail', expectedDatabases: expected.databases.length, expectedObjects: expected.objects.length, missingDatabases: comparison.missingDatabases.slice(0, 20), missingObjects: comparison.missingObjects.slice(0, 20).map((item) => `${item.database}.${item.name}`), typeMismatches: comparison.typeMismatches.slice(0, 20).map((item) => `${item.expected.database}.${item.expected.name}`) }
      ];
      if (!comparison.valid) return { status: 'failed', valid: false, checks, nativeIntegrityValidation: false };
      let checkedRelations = 0;
      for (const batch of checkTableQueries(expected.objects)) {
        const nativeResult = await this.#runClient(context, context.connection, batch.sql, { operation: 'restore native integrity validation', timeoutMs: Math.max(context.connection?.timeoutMs || DEFAULT_TIMEOUT_MS, 5 * 60 * 1000), stdoutLimitBytes: 8 * 1024 * 1024 });
        const parsed = checkTableResult(nativeResult.stdout, batch.expected);
        checkedRelations += parsed.passed;
        if (!parsed.valid) {
          checks.push({ id: 'native-integrity', status: 'fail', checkedRelations, failureCount: parsed.failureCount });
          return { status: 'failed', valid: false, checks, nativeIntegrityValidation: true };
        }
      }
      checks.push({ id: 'native-integrity', status: 'pass', checkedRelations });
      return { status: 'succeeded', valid: true, checks, nativeIntegrityValidation: true, warnings: [] };
    } catch (error) {
      const safe = error?.code ? error : safeAdapterError(error, 'restore validation');
      return { status: 'failed', valid: false, checks: [{ id: 'native-validation', status: 'fail', errorCode: String(safe.code || 'MARIADB_OPERATION_FAILED').slice(0, 100) }], nativeIntegrityValidation: false };
    }
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class MariadbConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new MariadbLogicalAdapter() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { limit: 1000 })).filter((record) => record.adapterId === ADAPTER_ID).map((record) => ({ ...record, capabilities: this.adapter.manifest().capabilities, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'MariaDB connection name', 200);
    const password = requiredText(input.password, 'MariaDB password', 1024 * 1024);
    let passwordRef = null;
    try {
      passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} MariaDB password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({ host: input.host, port: input.port, username: input.username, passwordSecretRefId: passwordRef.id, tlsMode: input.tlsMode, timeoutMs: input.timeoutMs, mariadbExecutable: input.mariadbExecutable, mariadbDumpExecutable: input.mariadbDumpExecutable, mariadbBinlogExecutable: input.mariadbBinlogExecutable });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device',
          endpoint: { host: config.host, port: config.port, username: config.username, tlsMode: config.tlsMode, timeoutMs: config.timeoutMs, mariadbExecutable: config.mariadbExecutable, mariadbDumpExecutable: config.mariadbDumpExecutable, mariadbBinlogExecutable: config.mariadbBinlogExecutable },
          secretRefIds: [passwordRef.id], trust: { mode: config.tlsMode, fingerprint: null }, workerAffinity: [`device:${this.deviceId}`], lastTest: null
        });
      });
    } catch (error) {
      if (passwordRef) await this.secretStore.delete({ workspaceId: tenant, id: passwordRef.id }).catch(() => {});
      throw error;
    }
  }

  config(connection) {
    const [passwordSecretRefId] = connection.secretRefIds || [];
    return normalizeConfig({ ...connection.endpoint, passwordSecretRefId });
  }

  async test(workspaceId, connectionId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('MariaDB source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This MariaDB connection belongs to another device.');
    const result = normalizeConnectionTestResult(await this.adapter.testConnection({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }) }, this.config(current)), { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const trust = result.status === 'success' ? { mode: current.endpoint.tlsMode, fingerprint: result.endpointIdentity?.serverFingerprint || null, observedAt: result.testedAt } : current.trust;
    const updated = await this.controlDatabase.repository('connection').update(tenant, id, { lastTest: result, trust, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection: updated, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('MariaDB source connection was not found.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the MariaDB connection successfully before discovering databases.');
    const pages = [];
    for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current), includeSystem: input.includeSystem, kind: input.kind, database: input.database, schema: input.schema })) pages.push(page);
    return pages[0] || { items: [], nextCursor: null };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  MAX_DISCOVERED_DATABASES,
  MAX_DISCOVERED_OBJECTS,
  MariadbConnectionService,
  MariadbLogicalAdapter,
  REQUIRED_LOGICAL_PRIVILEGES,
  SYSTEM_DATABASES,
  dumpArguments,
  hasLogicalPrivileges,
  mariadbVersion,
  normalizeConfig,
  optionFileContents,
  selectionScope,
  serverVersion
};
