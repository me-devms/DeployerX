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

const ADAPTER_ID = 'deployerx.database.mysql.logical';
const ADAPTER_VERSION = '1.4.0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_DISCOVERED_DATABASES = 1000;
const MAX_DISCOVERED_OBJECTS = 10000;
const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const TLS_MODES = new Set(['disabled', 'preferred', 'required', 'verify-ca', 'verify-identity']);
const REQUIRED_LOGICAL_PRIVILEGES = Object.freeze(['SELECT', 'SHOW VIEW', 'TRIGGER', 'EVENT']);
const REQUIRED_RESTORE_PRIVILEGES = Object.freeze(['CREATE', 'DROP', 'ALTER', 'INSERT', 'UPDATE', 'DELETE', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'TRIGGER', 'EVENT', 'CREATE ROUTINE', 'ALTER ROUTINE']);
const REQUIRED_BINLOG_PRIVILEGES = Object.freeze(['RELOAD', 'REPLICATION CLIENT']);

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeHost(value) {
  const input = requiredText(value, 'MySQL host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('MySQL host must be a hostname or IP address without a URL scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('MySQL host is invalid.');
  return ascii;
}

function normalizePort(value) {
  const port = Number(value ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('MySQL port must be between 1 and 65535.');
  return port;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('MySQL timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeExecutable(value, expectedName) {
  const executable = value === undefined || value === null || value === '' ? expectedName : requiredText(value, `${expectedName} executable`, 4096);
  const base = path.win32.basename(executable).toLowerCase().replace(/[.]exe$/, '');
  if (base !== expectedName) throw new TypeError(`Only the ${expectedName} executable may be configured.`);
  return executable;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MySQL connection configuration must be an object.');
  const allowed = ['host', 'port', 'username', 'passwordSecretRefId', 'tlsMode', 'timeoutMs', 'mysqlExecutable', 'mysqldumpExecutable', 'mysqlbinlogExecutable'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown MySQL connection field: ${unknown[0]}.`);
  const username = requiredText(input.username, 'MySQL username', 256);
  if (/\p{C}/u.test(username)) throw new TypeError('MySQL username contains invalid characters.');
  const tlsMode = String(input.tlsMode || 'verify-identity').toLowerCase();
  if (!TLS_MODES.has(tlsMode)) throw new TypeError('MySQL TLS mode is not supported.');
  return {
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    username,
    passwordSecretRefId: requiredText(input.passwordSecretRefId, 'MySQL password SecretRef ID', 200),
    tlsMode,
    timeoutMs: normalizeTimeout(input.timeoutMs),
    mysqlExecutable: normalizeExecutable(input.mysqlExecutable, 'mysql'),
    mysqldumpExecutable: normalizeExecutable(input.mysqldumpExecutable, 'mysqldump'),
    mysqlbinlogExecutable: normalizeExecutable(input.mysqlbinlogExecutable, 'mysqlbinlog')
  };
}

function mysqlVersion(value) {
  const match = String(value || '').match(/(?:Distrib|Ver)\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return { text: null, major: null, minor: null, patch: null, supported: false };
  const version = { text: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  return { ...version, supported: version.major === 8 };
}

function serverVersion(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { text: String(value || '').slice(0, 100), major: null, minor: null, patch: null, supported: false };
  const version = { text: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  return { ...version, supported: version.major === 8 };
}

function optionFileValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function optionFileContents(config, password) {
  const tlsMode = config.tlsMode.toUpperCase().replace('-', '_');
  return [
    '[client]',
    'protocol=tcp',
    `host=${optionFileValue(config.host)}`,
    `port=${config.port}`,
    `user=${optionFileValue(config.username)}`,
    `password=${optionFileValue(password)}`,
    `ssl-mode=${tlsMode}`,
    'default-character-set=utf8mb4',
    ''
  ].join('\n');
}

function safeAdapterError(error, operation) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error instanceof NativeProcessError) {
    const stderr = error.stderr.toLowerCase();
    if (stderr.includes('access denied')) return new DatabaseAdapterError('MYSQL_AUTHENTICATION_FAILED', 'MySQL authentication failed. Check the username and password.', { category: 'authentication' });
    if (stderr.includes('ssl') || stderr.includes('tls') || stderr.includes('certificate')) return new DatabaseAdapterError('MYSQL_TLS_FAILED', 'MySQL TLS verification failed. Check the server certificate and TLS mode.', { category: 'integrity' });
    if (stderr.includes('unknown host') || stderr.includes("can't connect") || stderr.includes('connection refused')) return new DatabaseAdapterError('MYSQL_CONNECT_FAILED', 'DeployerX could not connect to MySQL. Check the host, port, firewall, and service.', { category: 'connectivity', retryable: true });
    if (error.code === 'NATIVE_EXECUTABLE_NOT_FOUND') return new DatabaseAdapterError('MYSQL_NATIVE_TOOL_NOT_FOUND', 'Install the MySQL 8 client tools and make mysql and mysqldump available on PATH.', { category: 'compatibility' });
    if (error.code === 'NATIVE_PROCESS_CANCELED') return new DatabaseAdapterError('MYSQL_OPERATION_CANCELED', `The MySQL ${operation} was canceled.`, { category: 'canceled' });
    if (error.code === 'NATIVE_PROCESS_TIMEOUT') return new DatabaseAdapterError('MYSQL_OPERATION_TIMEOUT', `The MySQL ${operation} exceeded its timeout.`, { category: 'timeout', retryable: true });
  }
  return new DatabaseAdapterError('MYSQL_OPERATION_FAILED', `The MySQL ${operation} failed.`, { category: 'execution', retryable: false });
}

function connectionFailure(error, testedAt, latencyMs) {
  const safe = safeAdapterError(error, 'connection test');
  return {
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    testedAt,
    latencyMs,
    status: 'failure',
    checks: [],
    error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null }
  };
}

function mysqlStringLiteral(value) {
  return `CONVERT(0x${Buffer.from(String(value), 'utf8').toString('hex')} USING utf8mb4)`;
}

function normalizeObjectName(value, label = 'MySQL object') {
  const name = requiredText(value, label, 64);
  if (/\p{C}/u.test(name)) throw new DatabaseAdapterError('MYSQL_OBJECT_NAME_INVALID', `${label} contains invalid control characters.`, { category: 'validation' });
  return name;
}

function quoteMysqlIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function selectionScope(selector = {}) {
  const databases = selector.allDatabases ? [] : (selector.databases?.include || []).map((item) => normalizeObjectName(item.name, 'MySQL database'));
  const schemaRules = [...(selector.schemas?.include || []), ...(selector.schemas?.exclude || [])];
  if (schemaRules.length) throw new DatabaseAdapterError('MYSQL_SCHEMA_SELECTION_UNSUPPORTED', 'MySQL schemas are selected as databases. Use table selection to narrow one database.', { category: 'compatibility' });
  if ((selector.tables?.exclude || []).length) throw new DatabaseAdapterError('MYSQL_TABLE_EXCLUDES_UNSUPPORTED', 'Select the MySQL tables to include; table exclusion rules are not supported.', { category: 'compatibility' });
  const tables = (selector.tables?.include || []).map((item) => ({
    database: normalizeObjectName(item.database, 'MySQL table database'),
    schema: normalizeObjectName(item.schema, 'MySQL table schema'),
    name: normalizeObjectName(item.name, 'MySQL table')
  }));
  if (!tables.length) return { mode: 'databases', databases, database: null, tables: [] };
  if (selector.allDatabases || databases.length !== 1) throw new DatabaseAdapterError('MYSQL_PARTIAL_DATABASE_SCOPE_INVALID', 'MySQL table selection requires exactly one selected database.', { category: 'validation' });
  const [database] = databases;
  if (tables.some((item) => item.database !== database || item.schema !== database)) throw new DatabaseAdapterError('MYSQL_TABLE_SCOPE_INVALID', 'Every selected MySQL table must belong to the selected database.', { category: 'validation' });
  return { mode: 'tables', databases, database, tables: tables.map((item) => item.name) };
}

function selectedDatabasePredicate(selector) {
  const scope = selectionScope(selector);
  if (scope.mode === 'tables') {
    return `TABLE_SCHEMA = ${mysqlStringLiteral(scope.database)} AND TABLE_NAME IN (${scope.tables.map(mysqlStringLiteral).join(',')})`;
  }
  if (selector.allDatabases) return "TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')";
  const databases = scope.databases.map(mysqlStringLiteral);
  return `TABLE_SCHEMA IN (${databases.join(',')})`;
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
  return REQUIRED_BINLOG_PRIVILEGES.every((privilege) => grants.includes(privilege)) && (grants.includes('REPLICATION SLAVE') || grants.includes('REPLICATION REPLICA'));
}

function databaseNames(selector) {
  return selectionScope(selector).databases;
}

function dumpArguments(config, selector, captureCoordinates = false) {
  const scope = selectionScope(selector);
  const args = [
    '--single-transaction', '--quick', '--skip-lock-tables', '--triggers', '--hex-blob',
    '--no-tablespaces', '--set-gtid-purged=OFF', '--column-statistics=0', '--default-character-set=utf8mb4',
    `--max-allowed-packet=1073741824`, `--net-buffer-length=16384`
  ];
  if (captureCoordinates) args.push('--source-data=2');
  if (scope.mode === 'tables') return [...args, '--skip-routines', '--skip-events', scope.database, ...scope.tables];
  args.push('--routines', '--events');
  if (selector.allDatabases) args.push('--all-databases');
  else args.push('--databases', ...scope.databases);
  return args;
}

class MysqlLogicalAdapter {
  constructor({ processRunner = new NativeProcessRunner(), fileSystem = fs, temporaryRoot = os.tmpdir(), clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!processRunner || typeof processRunner.run !== 'function' || typeof processRunner.stream !== 'function' || typeof processRunner.consume !== 'function') throw new TypeError('MySQL process runner is required.');
    this.processRunner = processRunner;
    this.fileSystem = fileSystem;
    this.temporaryRoot = temporaryRoot;
    this.clock = clock;
    this.now = now;
  }

  manifest() {
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      displayName: 'MySQL logical backup',
      engine: 'mysql',
      serverVersionRange: '>=8.0.0 <9.0.0',
      restoreVersionRange: '>=8.0.0 <9.0.0',
      capabilities: {
        backupMethods: ['logical', 'physical'],
        backupModes: ['full', 'incremental'],
        selection: { database: true, schema: false, table: true, globalObjects: false },
        consistencyStrategies: [
          { id: 'transaction-snapshot', produces: 'application', backupMethods: ['logical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: true },
          { id: 'coordinated-lock', produces: 'application', backupMethods: ['physical'], lockScope: 'instance', requiresDowntime: false, capturesCoordinates: true }
        ],
        transactionLogs: { supported: true, type: 'mysql-binary-log', pointInTimeRecovery: true, granularitySeconds: 1 },
        streaming: { backup: true, restore: true, compression: false, encryption: false },
        restore: { alternateTarget: true, nativeValidation: true },
        replicaAware: false
      },
      requiredTools: [
        { name: 'mysql', versionRange: '>=8.0.0 <9.0.0', operations: ['backup', 'restore', 'validation'] },
        { name: 'mysqldump', versionRange: '>=8.0.0 <9.0.0', operations: ['backup'] },
        { name: 'mysqlbinlog', versionRange: '>=8.0.0 <9.0.0', operations: ['point-in-time-capture', 'point-in-time-restore'] }
      ],
      requiredPrivileges: [{
        id: 'mysql-logical-read', operations: ['backup'], required: true,
        safeDescription: 'SELECT, SHOW VIEW, TRIGGER, and EVENT access is required for selected databases.'
      }, {
        id: 'mysql-logical-restore', operations: ['restore'], required: true,
        safeDescription: 'Create, modify, and remove database objects and data on the selected restore target.'
      }, {
        id: 'mysql-binlog-read', operations: ['point-in-time-capture'], required: true,
        safeDescription: 'RELOAD, REPLICATION CLIENT, and REPLICATION SLAVE or REPLICATION REPLICA are required for binary-log capture.'
      }]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'MYSQL_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async #credentialSession(context, input) {
    const config = normalizeConfig(input);
    if (typeof context?.resolveSecret !== 'function') throw new DatabaseAdapterError('MYSQL_SECRET_RESOLVER_MISSING', 'MySQL credentials are unavailable.', { category: 'authentication' });
    const password = await context.resolveSecret(config.passwordSecretRefId);
    const directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, 'deployerx-mysql-'));
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
        executable: session.config.mysqlExecutable,
        args: [`--defaults-extra-file=${session.filePath}`, '--batch', '--skip-column-names', '--raw', `--connect-timeout=${Math.ceil(session.config.timeoutMs / 1000)}`, `--execute=${query}`, ...(options.database ? [normalizeObjectName(options.database, 'MySQL query database')] : [])],
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
      return { name, ...mysqlVersion(result.stdout) };
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
      const result = await this.#runClient(context, config, 'SELECT VERSION(), @@server_uuid, @@version_comment;', { operation: 'connection test' });
      const [versionText, serverUuid, versionComment] = result.stdout.trim().split('\t');
      const version = serverVersion(versionText);
      if (!version.supported || !serverUuid) throw new DatabaseAdapterError('MYSQL_SERVER_VERSION_UNSUPPORTED', 'DeployerX requires MySQL 8.x for logical backup.', { category: 'compatibility' });
      return {
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'success',
        checks: [
          { id: 'authentication', status: 'pass', safeMessage: 'MySQL authentication succeeded.' },
          { id: 'server-version', status: 'pass', safeMessage: `MySQL ${version.text} is supported.` },
          { id: 'server-identity', status: 'pass', safeMessage: 'MySQL server identity was captured.' },
          { id: 'tls', status: config.tlsMode === 'disabled' ? 'warning' : 'pass', safeMessage: config.tlsMode === 'disabled' ? 'MySQL traffic is not required to use TLS.' : 'The configured MySQL TLS policy was accepted.' }
        ],
        remotePlatform: { engine: 'mysql', version: version.text, distribution: String(versionComment || '').slice(0, 200) },
        endpointIdentity: { serverFingerprint: `sha256:${crypto.createHash('sha256').update(`${config.host}:${config.port}:${serverUuid}`).digest('hex')}`, serverUuid },
        error: null
      };
    } catch (error) {
      return connectionFailure(error, testedAt, Math.max(0, this.now() - started));
    }
  }

  async *discover(context = {}, request = {}) {
    try {
      if (request.kind === 'table') {
        const database = normalizeObjectName(request.database, 'MySQL discovery database');
        if (SYSTEM_DATABASES.has(database)) throw new DatabaseAdapterError('MYSQL_SYSTEM_DATABASE_SELECTION_REFUSED', 'System database objects cannot be selected for protection.', { category: 'validation' });
        const query = `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables WHERE TABLE_SCHEMA=${mysqlStringLiteral(database)} ORDER BY TABLE_NAME;`;
        const result = await this.#runClient(context, request.connection, query, { operation: 'table discovery', stdoutLimitBytes: 8 * 1024 * 1024 });
        const objects = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          const [nameValue, typeValue] = line.split('\t');
          const name = normalizeObjectName(nameValue, 'Discovered MySQL table');
          const objectType = String(typeValue || '').toUpperCase() === 'VIEW' ? 'view' : 'table';
          return { id: `mysql-table:${crypto.createHash('sha256').update(`${database}\0${name}`).digest('hex').slice(0, 24)}`, kind: 'table', database, schema: database, name, objectType, selectable: true };
        }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
        if (objects.length > MAX_DISCOVERED_OBJECTS) throw new DatabaseAdapterError('MYSQL_DISCOVERY_LIMIT_EXCEEDED', 'The MySQL database contains too many objects to list safely.', { category: 'capacity' });
        yield { items: objects, nextCursor: null };
        return;
      }
      if (request.kind && request.kind !== 'database') throw new DatabaseAdapterError('MYSQL_DISCOVERY_KIND_UNSUPPORTED', 'This MySQL object type cannot be discovered.', { category: 'compatibility' });
      const result = await this.#runClient(context, request.connection, 'SHOW DATABASES;', { operation: 'database discovery', stdoutLimitBytes: 2 * 1024 * 1024 });
      const includeSystem = request.includeSystem === true;
      const names = [...new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
        .filter((name) => includeSystem || !SYSTEM_DATABASES.has(name))
        .sort((left, right) => left.localeCompare(right, 'en-US'));
      if (names.length > MAX_DISCOVERED_DATABASES) throw new DatabaseAdapterError('MYSQL_DISCOVERY_LIMIT_EXCEEDED', 'The MySQL server contains too many databases to list safely.', { category: 'capacity' });
      yield { items: names.map((name) => ({ id: `mysql-db:${crypto.createHash('sha256').update(name).digest('hex').slice(0, 24)}`, kind: 'database', name, selectable: !SYSTEM_DATABASES.has(name) })), nextCursor: null };
    } catch (error) { throw safeAdapterError(error, 'database discovery'); }
  }

  async preflight(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const selector = request.selector;
    const scope = selectionScope(selector);
    const captureCoordinates = request.consistency?.captureCoordinates === true;
    if (captureCoordinates && (scope.mode !== 'databases' || selector.allDatabases || scope.databases.length !== 1)) throw new DatabaseAdapterError('MYSQL_PITR_SCOPE_INVALID', 'MySQL point-in-time recovery requires exactly one whole selected user database.', { category: 'compatibility' });
    const [serverResult, grantsResult, engineResult, inventoryResult, mysqlTool, dumpTool, binlogTool, binlogVariables] = await Promise.all([
      this.#runClient(context, config, 'SELECT VERSION(), @@server_uuid, @@version_comment, @@character_set_server, @@collation_server;', { operation: 'preflight server check' }),
      this.#runClient(context, config, 'SHOW GRANTS FOR CURRENT_USER();', { operation: 'preflight privilege check' }),
      this.#runClient(context, config, `SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_TYPE='BASE TABLE' AND ENGINE <> 'InnoDB' AND ${selectedDatabasePredicate(selector)};`, { operation: 'preflight consistency check' }),
      this.#runClient(context, config, captureInventoryQuery(selector, scope), { operation: 'preflight validation inventory', stdoutLimitBytes: 8 * 1024 * 1024 }),
      this.#toolVersion(config.mysqlExecutable, 'mysql', context.signal),
      this.#toolVersion(config.mysqldumpExecutable, 'mysqldump', context.signal),
      captureCoordinates ? this.#toolVersion(config.mysqlbinlogExecutable, 'mysqlbinlog', context.signal) : Promise.resolve(null),
      captureCoordinates ? this.#runClient(context, config, 'SELECT @@global.log_bin, @@global.binlog_format, @@global.binlog_row_image, @@global.binlog_checksum;', { operation: 'binary-log preflight' }) : Promise.resolve(null)
    ]);
    const [versionText, serverUuid, versionComment, characterSet, collation] = serverResult.stdout.trim().split('\t');
    const version = serverVersion(versionText);
    const nonTransactionalTables = Number(engineResult.stdout.trim());
    const privilegesAllowed = hasLogicalPrivileges(grantsResult.stdout);
    const [logBin, binlogFormat, binlogRowImage, binlogChecksum] = binlogVariables?.stdout.trim().split('\t') || [];
    const binlogPrivilegesAllowed = !captureCoordinates || hasBinlogPrivileges(grantsResult.stdout);
    const binlogConfigurationAllowed = !captureCoordinates || (String(logBin).toUpperCase() === '1' || String(logBin).toUpperCase() === 'ON') && String(binlogFormat).toUpperCase() === 'ROW' && String(binlogRowImage).toUpperCase() === 'FULL';
    const coordinateCaptureVerified = !captureCoordinates || Boolean(binlogTool?.supported && binlogPrivilegesAllowed && binlogConfigurationAllowed);
    let validationInventory;
    try { validationInventory = normalizeInventory(inventoryResult.stdout, normalizeObjectName, 'MYSQL'); }
    catch (error) { throw new DatabaseAdapterError(error.code || 'MYSQL_VALIDATION_INVENTORY_INVALID', error.message, { category: error.category || 'integrity' }); }
    const identity = `sha256:${crypto.createHash('sha256').update(`${config.host}:${config.port}:${serverUuid || 'unknown'}`).digest('hex')}`;
    const warnings = [];
    if (config.tlsMode === 'disabled') warnings.push('MySQL transport encryption is disabled by configuration.');
    if (nonTransactionalTables > 0) warnings.push(`${nonTransactionalTables} selected table(s) are not InnoDB and cannot share the transaction snapshot.`);
    if (scope.mode === 'tables') warnings.push('A table-only MySQL backup omits database-level routines and events and does not include dependencies outside the selected tables.');
    return {
      checkedAt: this.clock(),
      serverVersion: version.text,
      serverVersionSupported: version.supported,
      serverIdentityFingerprint: identity,
      consistency: [{ method: 'transaction-snapshot', verified: Number.isInteger(nonTransactionalTables) && nonTransactionalTables === 0, produces: 'application', reasonCode: nonTransactionalTables > 0 ? 'MYSQL_NON_TRANSACTIONAL_TABLES' : null }],
      tools: [mysqlTool, dumpTool, ...(binlogTool ? [binlogTool] : [])].map((tool) => ({ name: tool.name, version: tool.text, compatible: tool.supported, executableFingerprint: tool.text ? `sha256:${crypto.createHash('sha256').update(`${tool.name}:${tool.text}`).digest('hex')}` : null })),
      privileges: [{ id: 'mysql-logical-read', allowed: privilegesAllowed, evidence: privilegesAllowed ? 'Required logical-backup grants were observed.' : 'SELECT, SHOW VIEW, TRIGGER, and EVENT grants were not all observed.' }, ...(captureCoordinates ? [{ id: 'mysql-binlog-read', allowed: binlogPrivilegesAllowed, evidence: binlogPrivilegesAllowed ? 'Binary-log monitoring and remote-read grants were observed.' : 'RELOAD, REPLICATION CLIENT, and REPLICATION SLAVE or REPLICATION REPLICA grants were not all observed.' }] : [])],
      coordinateCaptureVerified,
      warnings,
      metadata: {
        engine: 'mysql',
        serverVersion: version.text,
        distribution: String(versionComment || '').slice(0, 200),
        characterSet: String(characterSet || '').slice(0, 100),
        collation: String(collation || '').slice(0, 100),
        serverIdentityFingerprint: identity,
        nonTransactionalTables,
        selectionMode: scope.mode,
        selectedDatabases: selector.allDatabases ? validationInventory.databases : scope.databases,
        selectedSchemas: [],
        selectedTables: scope.mode === 'tables' ? scope.tables.map((name) => ({ database: scope.database, schema: scope.database, name })) : [],
        validationInventoryVersion: 1,
        expectedDatabases: validationInventory.databases,
        expectedObjects: validationInventory.objects
        , binaryLog: captureCoordinates ? { enabled: String(logBin).toUpperCase() === '1' || String(logBin).toUpperCase() === 'ON', format: String(binlogFormat || '').toUpperCase(), rowImage: String(binlogRowImage || '').toUpperCase(), checksum: String(binlogChecksum || '').toUpperCase(), privilegesVerified: binlogPrivilegesAllowed, toolVerified: Boolean(binlogTool?.supported) } : null
      }
    };
  }

  async planBackup(_context = {}, request = {}) {
    if (request.consistency?.proven !== true || request.consistency?.method !== 'transaction-snapshot' || request.consistency?.achievedLevel !== 'application') throw new DatabaseAdapterError('MYSQL_CONSISTENCY_PLAN_INVALID', 'MySQL logical backup requires a proven transaction snapshot.', { category: 'consistency' });
    const config = normalizeConfig(request.connection);
    const scope = selectionScope(request.selector);
    return {
      version: 1,
      operation: 'mysql-logical-backup',
      connection: config,
      selector: request.selector,
      dumpArguments: dumpArguments(config, request.selector, request.consistency.captureCoordinates),
      restoreDatabase: scope.mode === 'tables' ? scope.database : null,
      consistency: request.consistency,
      databaseMetadata: request.consistency.evidence?.metadata || {},
      artifact: { kind: 'database-dump', path: 'mysql/logical-dump.sql', mediaType: 'application/sql' },
      resumable: false
    };
  }

  async openBackup(context = {}, plan = {}) {
    if (plan.operation !== 'mysql-logical-backup' || plan.consistency?.proven !== true) throw new DatabaseAdapterError('MYSQL_BACKUP_PLAN_INVALID', 'The MySQL backup plan is invalid.', { category: 'integrity' });
    const session = await this.#credentialSession(context, plan.connection);
    let started;
    try {
      started = this.processRunner.stream({
        executable: session.config.mysqldumpExecutable,
        args: [`--defaults-extra-file=${session.filePath}`, ...plan.dumpArguments],
        timeoutMs: Math.max(session.config.timeoutMs, 24 * 60 * 60 * 1000),
        signal: context.signal
      });
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
    if (scope.mode !== 'databases' || request.selector?.allDatabases || scope.databases.length !== 1) throw new DatabaseAdapterError('MYSQL_PITR_SCOPE_INVALID', 'MySQL binary-log capture requires exactly one whole selected user database.', { category: 'compatibility' });
    const capturedAt = this.clock();
    const [serverResult, grantsResult, variablesResult, statusResult, inventoryResult, binlogTool] = await Promise.all([
      this.#runClient(context, config, 'SELECT VERSION(), @@server_uuid, @@version_comment;', { operation: 'binary-log server identity check' }),
      this.#runClient(context, config, 'SHOW GRANTS FOR CURRENT_USER();', { operation: 'binary-log privilege check' }),
      this.#runClient(context, config, 'SELECT @@global.log_bin, @@global.binlog_format, @@global.binlog_row_image, @@global.binlog_checksum;', { operation: 'binary-log configuration check' }),
      this.#runClient(context, config, 'SHOW BINARY LOG STATUS;', { operation: 'binary-log coordinate capture' }),
      this.#runClient(context, config, 'SHOW BINARY LOGS;', { operation: 'binary-log inventory', stdoutLimitBytes: 8 * 1024 * 1024 }),
      this.#toolVersion(config.mysqlbinlogExecutable, 'mysqlbinlog', context.signal)
    ]);
    const [versionText, serverUuid] = serverResult.stdout.trim().split('\t');
    const version = serverVersion(versionText);
    const identity = `sha256:${crypto.createHash('sha256').update(`${config.host}:${config.port}:${serverUuid || 'unknown'}`).digest('hex')}`;
    const [logBin, binlogFormat, rowImage, checksum] = variablesResult.stdout.trim().split('\t');
    if (!version.supported || identity !== request.startCoordinate?.serverIdentityFingerprint) throw new DatabaseAdapterError('MYSQL_BINLOG_SERVER_IDENTITY_CHANGED', 'The MySQL server identity changed after the preceding recovery point.', { category: 'integrity' });
    if (!hasBinlogPrivileges(grantsResult.stdout)) throw new DatabaseAdapterError('MYSQL_BINLOG_PRIVILEGES_MISSING', 'The MySQL account lacks the privileges required for binary-log capture.', { category: 'authorization' });
    if (!binlogTool.supported) throw new DatabaseAdapterError('MYSQL_BINLOG_TOOL_UNAVAILABLE', 'Install a compatible MySQL 8 mysqlbinlog client on this worker.', { category: 'compatibility' });
    if (!(['1', 'ON'].includes(String(logBin).toUpperCase())) || String(binlogFormat).toUpperCase() !== 'ROW' || String(rowImage).toUpperCase() !== 'FULL') throw new DatabaseAdapterError('MYSQL_BINLOG_CONFIGURATION_UNSAFE', 'MySQL point-in-time recovery requires binary logging in ROW format with FULL row images.', { category: 'compatibility' });
    const end = parseBinaryLogStatus(statusResult.stdout, { engine: 'mysql', capturedAt, serverIdentityFingerprint: identity });
    const inventory = parseBinaryLogInventory(inventoryResult.stdout);
    const interval = planBinaryLogSegments({ start: request.startCoordinate, end, inventory });
    return { version: 1, operation: 'mysql-binlog-capture', connection: config, database: scope.databases[0], checksum: String(checksum || '').toUpperCase(), nativeTool: binlogTool, ...interval };
  }

  async captureBinaryLogs(context = {}, plan = {}, destinationDirectory) {
    if (plan.operation !== 'mysql-binlog-capture' || !Array.isArray(plan.segments)) throw new DatabaseAdapterError('MYSQL_BINLOG_CAPTURE_PLAN_INVALID', 'The MySQL binary-log capture plan is invalid.', { category: 'integrity' });
    const directory = requiredText(destinationDirectory, 'MySQL binary-log destination', 4096);
    const session = await this.#credentialSession(context, plan.connection);
    const files = [];
    try {
      for (const segment of plan.segments) {
        const filePath = path.join(directory, segment.file);
        await this.processRunner.run({
          executable: session.config.mysqlbinlogExecutable,
          args: [`--defaults-extra-file=${session.filePath}`, '--read-from-remote-server=BINLOG-DUMP-NON-GTIDS', '--raw', '--verify-binlog-checksum', `--result-file=${directory}${path.sep}`, segment.file],
          timeoutMs: Math.max(session.config.timeoutMs, 24 * 60 * 60 * 1000), stdoutLimitBytes: 1024 * 1024, signal: context.signal
        });
        const stat = await this.fileSystem.stat(filePath);
        if (!stat.isFile() || stat.size < segment.stopPosition) throw new DatabaseAdapterError('MYSQL_BINLOG_DOWNLOAD_INCOMPLETE', 'A downloaded MySQL binary-log file does not cover the planned interval.', { category: 'integrity' });
        files.push({ ...segment, filePath, sizeBytes: stat.size });
      }
      return files;
    } catch (error) { throw safeAdapterError(error, 'binary-log capture'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async executeBinaryLogReplay(context = {}, request = {}) {
    const connection = normalizeConfig(request.connection);
    const sourceDatabase = normalizeObjectName(request.sourceDatabase, 'MySQL PITR source database');
    const targetDatabase = normalizeObjectName(request.targetDatabase || sourceDatabase, 'MySQL PITR target database');
    const files = Array.isArray(request.files) ? request.files.slice(0, 10000) : [];
    if (!files.length) throw new DatabaseAdapterError('MYSQL_PITR_LOG_FILES_MISSING', 'The MySQL point-in-time restore has no binary-log files.', { category: 'integrity' });
    const stop = request.stop || {};
    const stopSequence = stop.type === 'coordinate' ? normalizeBinaryLogName(stop.coordinate?.file).sequence : null;
    const session = await this.#credentialSession(context, connection);
    const runner = this.processRunner;
    const executable = connection.mysqlbinlogExecutable;
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
        args.push(requiredText(file.filePath, 'MySQL binary-log file path', 4096));
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
      await this.processRunner.consume({ executable: connection.mysqlExecutable, args: [`--defaults-extra-file=${session.filePath}`, `--connect-timeout=${Math.ceil(connection.timeoutMs / 1000)}`, '--default-character-set=utf8mb4', targetDatabase], stdin: decoded, timeoutMs: Math.max(connection.timeoutMs, 24 * 60 * 60 * 1000), signal, stdoutLimitBytes: 1024 * 1024 });
      return { status: 'succeeded', replayedFiles, sourceDatabase, targetDatabase, stop };
    } catch (error) { throw safeAdapterError(error, 'point-in-time replay'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async executeBackup(context = {}, plan = {}, sink) {
    if (!sink || typeof sink.write !== 'function') throw new TypeError('MySQL backup artifact sink is required.');
    const opened = await this.openBackup(context, plan);
    const stored = await sink.write({ ...opened.artifact, content: opened.content, metadata: opened.metadata });
    return { status: 'succeeded', artifacts: [stored || opened.artifact], consistency: plan.consistency, metadata: opened.metadata };
  }

  async prepareRestoreTarget(context = {}, request = {}) {
    const mode = String(request.mode || 'original');
    if (!['original', 'alternate', 'new-database'].includes(mode)) throw new DatabaseAdapterError('MYSQL_RESTORE_MODE_INVALID', 'The MySQL restore target mode is not supported.', { category: 'validation' });
    const connection = normalizeConfig(request.connection);
    const originalMetadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    const mapping = mode === 'new-database' ? remapMysqlFamilyMetadata(originalMetadata, request.targetDatabase) : null;
    const metadata = mapping?.metadata || originalMetadata;
    if (mode === 'original') return { metadata, sourceDatabase: null, targetDatabase: null, databaseCreated: false, collisions: [] };
    const [result, grantsResult] = await Promise.all([
      this.#runClient(context, connection, 'SHOW DATABASES;', { operation: 'restore target discovery', stdoutLimitBytes: 2 * 1024 * 1024 }),
      this.#runClient(context, connection, 'SHOW GRANTS FOR CURRENT_USER();', { operation: 'restore target privilege check', stdoutLimitBytes: 1024 * 1024 })
    ]);
    if (!hasLogicalRestorePrivileges(grantsResult.stdout)) throw new DatabaseAdapterError('MYSQL_RESTORE_PRIVILEGES_MISSING', 'The selected MySQL target account lacks the privileges required to create and replace restored objects.', { category: 'authorization' });
    const existing = new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
    const databaseNames = Array.isArray(metadata.expectedDatabases) && metadata.expectedDatabases.length ? metadata.expectedDatabases : metadata.selectedDatabases || [];
    const expectedDatabases = [...new Set(databaseNames.map((name) => normalizeObjectName(name, 'MySQL restore database')))];
    if (!expectedDatabases.length) throw new DatabaseAdapterError('MYSQL_RESTORE_TARGET_INVENTORY_UNAVAILABLE', 'This recovery point does not contain the database inventory required for a safe alternate target restore.', { category: 'compatibility' });
    const collisions = expectedDatabases.filter((name) => existing.has(name));
    if (mode === 'new-database' && collisions.length) throw new DatabaseAdapterError('MYSQL_NEW_DATABASE_EXISTS', 'Choose a new MySQL database name that does not already exist on the target server.', { category: 'conflict' });
    if (mode === 'alternate' && collisions.length && request.conflictPolicy !== 'overwrite') throw new DatabaseAdapterError('MYSQL_ALTERNATE_TARGET_CONFLICT', 'The alternate MySQL server already contains a protected database. Choose overwrite explicitly or use another target.', { category: 'conflict' });
    const partial = metadata.selectionMode === 'tables';
    let databaseCreated = false;
    if (partial && expectedDatabases.length === 1 && !existing.has(expectedDatabases[0])) {
      await this.#runClient(context, connection, `CREATE DATABASE ${quoteMysqlIdentifier(expectedDatabases[0])};`, { operation: 'restore target database creation' });
      databaseCreated = true;
    }
    return { metadata, sourceDatabase: mapping?.sourceDatabase || null, targetDatabase: mapping?.targetDatabase || null, databaseCreated, collisions };
  }

  async planRestore(_context = {}, request = {}) {
    const mode = String(request.mode || 'original');
    const confirmations = { original: 'RESTORE_MYSQL_ORIGINAL', alternate: 'RESTORE_MYSQL_ALTERNATE', 'new-database': 'RESTORE_MYSQL_NEW_DATABASE' };
    if (!confirmations[mode]) throw new DatabaseAdapterError('MYSQL_RESTORE_MODE_INVALID', 'The MySQL restore target mode is not supported.', { category: 'validation' });
    if (request.confirmation !== confirmations[mode]) throw new DatabaseAdapterError('MYSQL_RESTORE_CONFIRMATION_REQUIRED', 'Explicit confirmation is required before restoring the MySQL databases.', { category: 'conflict' });
    const connection = normalizeConfig(request.connection);
    const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    if (mode === 'original' && (!metadata.serverIdentityFingerprint || metadata.serverIdentityFingerprint !== request.serverIdentityFingerprint)) throw new DatabaseAdapterError('MYSQL_RESTORE_SERVER_MISMATCH', 'The restore target does not match the protected MySQL server identity.', { category: 'integrity' });
    if (mode === 'alternate' && metadata.serverIdentityFingerprint === request.serverIdentityFingerprint) throw new DatabaseAdapterError('MYSQL_ALTERNATE_TARGET_IS_ORIGINAL', 'Choose a MySQL server with a different verified server identity for alternate-server restore.', { category: 'conflict' });
    if (mode !== 'original' && request.targetPrepared !== true) throw new DatabaseAdapterError('MYSQL_RESTORE_TARGET_NOT_PREPARED', 'The MySQL restore target must pass destination preflight before restore.', { category: 'validation' });
    const restoreDatabase = metadata.selectionMode === 'tables' && Array.isArray(metadata.selectedDatabases) && metadata.selectedDatabases.length === 1
      ? normalizeObjectName(metadata.selectedDatabases[0], 'MySQL restore database')
      : null;
    const mapping = mode === 'new-database' ? metadata.restoreDatabaseMapping : null;
    if (mode === 'new-database' && (!mapping?.sourceDatabase || !mapping?.targetDatabase)) throw new DatabaseAdapterError('MYSQL_RESTORE_MAPPING_INVALID', 'The MySQL new-database mapping is invalid.', { category: 'integrity' });
    return { version: 2, operation: 'mysql-logical-restore', mode, connection, artifactPath: requiredText(request.artifactPath, 'MySQL dump artifact path', 8192), metadata, restoreDatabase, databaseMapping: mapping || null, destructive: mode !== 'new-database' || Boolean(request.databaseCreated) };
  }

  async executeRestore(context = {}, plan = {}, source) {
    if (plan.operation !== 'mysql-logical-restore' || !source || typeof source.open !== 'function') throw new DatabaseAdapterError('MYSQL_RESTORE_PLAN_INVALID', 'The MySQL restore plan is invalid.', { category: 'integrity' });
    const session = await this.#credentialSession(context, plan.connection);
    try {
      const openedContent = await source.open({ kind: 'database-dump', path: plan.artifactPath });
      const content = plan.databaseMapping && plan.metadata.selectionMode !== 'tables'
        ? remapMysqlFamilyDump(openedContent, plan.databaseMapping.sourceDatabase, plan.databaseMapping.targetDatabase)
        : openedContent;
      await this.processRunner.consume({
        executable: session.config.mysqlExecutable,
        args: [`--defaults-extra-file=${session.filePath}`, `--connect-timeout=${Math.ceil(session.config.timeoutMs / 1000)}`, '--default-character-set=utf8mb4', ...(plan.restoreDatabase ? [plan.restoreDatabase] : [])],
        stdin: content,
        timeoutMs: Math.max(session.config.timeoutMs, 24 * 60 * 60 * 1000),
        signal: context.signal,
        stdoutLimitBytes: 1024 * 1024
      });
      return { status: 'succeeded', restoredArtifactPath: plan.artifactPath, validationRequired: true, metadata: plan.metadata };
    } catch (error) { throw safeAdapterError(error, 'logical restore'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async validateRestore(context = {}, result = {}) {
    if (result.status !== 'succeeded') return { status: 'failed', valid: false, checks: [] };
    try {
      const expected = expectedInventory(result.metadata || {}, normalizeObjectName, 'MYSQL');
      if (!expected) {
        const query = await this.#runClient(context, context.connection, 'SELECT 1;', { operation: 'legacy restore connectivity validation' });
        const valid = query.stdout.trim() === '1';
        return {
          status: valid ? 'warning' : 'failed', valid,
          checks: [{ id: 'connectivity', status: valid ? 'pass' : 'fail', databasesChecked: valid ? 1 : 0 }, { id: 'expected-objects', status: 'warning', reasonCode: 'MYSQL_VALIDATION_INVENTORY_UNAVAILABLE' }],
          nativeIntegrityValidation: false,
          warnings: valid ? [{ code: 'MYSQL_VALIDATION_INVENTORY_UNAVAILABLE', safeMessage: 'This older recovery point has no authenticated expected-object inventory; only connectivity could be validated.' }] : []
        };
      }
      for (const database of expected.databases) {
        const query = await this.#runClient(context, context.connection, 'SELECT 1;', { operation: 'restore database connectivity validation', database });
        if (query.stdout.trim() !== '1') return { status: 'failed', valid: false, checks: [{ id: 'connectivity', status: 'fail', databasesChecked: 0 }], nativeIntegrityValidation: false };
      }
      const inventoryResult = await this.#runClient(context, context.connection, validationInventoryQuery({ ...(result.metadata || {}), expectedDatabases: expected.databases }), { operation: 'restore expected-object validation', stdoutLimitBytes: 8 * 1024 * 1024 });
      const actual = normalizeInventory(inventoryResult.stdout, normalizeObjectName, 'MYSQL');
      const comparison = compareInventory(expected, actual);
      const checks = [
        { id: 'connectivity', status: 'pass', databasesChecked: expected.databases.length },
        {
          id: 'expected-objects', status: comparison.valid ? 'pass' : 'fail', expectedDatabases: expected.databases.length, expectedObjects: expected.objects.length,
          missingDatabases: comparison.missingDatabases.slice(0, 20),
          missingObjects: comparison.missingObjects.slice(0, 20).map((item) => `${item.database}.${item.name}`),
          typeMismatches: comparison.typeMismatches.slice(0, 20).map((item) => `${item.expected.database}.${item.expected.name}`)
        }
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
      return { status: 'failed', valid: false, checks: [{ id: 'native-validation', status: 'fail', errorCode: String(safe.code || 'MYSQL_OPERATION_FAILED').slice(0, 100) }], nativeIntegrityValidation: false };
    }
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class MysqlConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new MysqlLogicalAdapter() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { limit: 1000 }))
      .filter((record) => record.adapterId === ADAPTER_ID)
      .map((record) => ({ ...record, capabilities: this.adapter.manifest().capabilities, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'MySQL connection name', 200);
    const password = requiredText(input.password, 'MySQL password', 1024 * 1024);
    let passwordRef = null;
    try {
      passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} MySQL password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({
        host: input.host,
        port: input.port,
        username: input.username,
        passwordSecretRefId: passwordRef.id,
        tlsMode: input.tlsMode,
        timeoutMs: input.timeoutMs,
        mysqlExecutable: input.mysqlExecutable,
        mysqldumpExecutable: input.mysqldumpExecutable,
        mysqlbinlogExecutable: input.mysqlbinlogExecutable
      });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION,
          scope: 'device', endpoint: { host: config.host, port: config.port, username: config.username, tlsMode: config.tlsMode, timeoutMs: config.timeoutMs, mysqlExecutable: config.mysqlExecutable, mysqldumpExecutable: config.mysqldumpExecutable, mysqlbinlogExecutable: config.mysqlbinlogExecutable },
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
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('MySQL source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This MySQL connection belongs to another device.');
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
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('MySQL source connection was not found.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the MySQL connection successfully before discovering databases.');
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
  MysqlConnectionService,
  MysqlLogicalAdapter,
  REQUIRED_LOGICAL_PRIVILEGES,
  SYSTEM_DATABASES,
  dumpArguments,
  hasLogicalPrivileges,
  mysqlVersion,
  normalizeConfig,
  optionFileContents,
  selectionScope,
  serverVersion
};
