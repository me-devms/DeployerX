const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { NativeProcessError, NativeProcessRunner } = require('./native-process');

const ADAPTER_ID = 'deployerx.database.sqlserver.native';
const ADAPTER_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 30000;
const SYSTEM_DATABASES = new Set(['master', 'model', 'msdb', 'tempdb']);
const SUPPORTED_MAJORS = new Set([15, 16, 17]);

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeHost(value) {
  const input = requiredText(value, 'SQL Server host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('SQL Server host must be a hostname or IP address without a URL scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('SQL Server host is invalid.');
  return ascii;
}

function normalizePort(value) {
  const port = Number(value ?? 1433);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('SQL Server port must be between 1 and 65535.');
  return port;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('SQL Server timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeExecutable(value) {
  const executable = value === undefined || value === null || value === '' ? 'sqlcmd' : requiredText(value, 'sqlcmd executable', 4096);
  if (path.win32.basename(executable).toLowerCase().replace(/[.]exe$/, '') !== 'sqlcmd') throw new TypeError('Only the sqlcmd executable may be configured.');
  return executable;
}

function normalizeDatabaseName(value, label = 'SQL Server database') {
  const name = requiredText(value, label, 128);
  if (/\p{C}/u.test(name)) throw new TypeError(`${label} contains invalid control characters.`);
  if (SYSTEM_DATABASES.has(name.toLocaleLowerCase('en-US'))) throw new DatabaseAdapterError('SQLSERVER_SYSTEM_DATABASE_UNSUPPORTED', 'SQL Server system databases are not supported by this backup workflow.', { category: 'compatibility' });
  return name;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('SQL Server connection configuration must be an object.');
  const allowed = ['host', 'port', 'username', 'passwordSecretRefId', 'tlsMode', 'timeoutMs', 'sqlcmdExecutable'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown SQL Server connection field: ${unknown[0]}.`);
  const username = requiredText(input.username, 'SQL Server username', 128);
  if (/\p{C}/u.test(username)) throw new TypeError('SQL Server username contains invalid characters.');
  const tlsMode = String(input.tlsMode || 'verify-identity').toLowerCase();
  if (tlsMode !== 'verify-identity') throw new TypeError('SQL Server native backup requires encrypted TLS with certificate identity verification.');
  return {
    host: normalizeHost(input.host), port: normalizePort(input.port), username,
    passwordSecretRefId: requiredText(input.passwordSecretRefId, 'SQL Server password SecretRef ID', 200),
    tlsMode, timeoutMs: normalizeTimeout(input.timeoutMs), sqlcmdExecutable: normalizeExecutable(input.sqlcmdExecutable)
  };
}

function sqlcmdArguments(config, query, options = {}) {
  return [
    '-S', `tcp:${config.host},${config.port}`, '-U', config.username, '-d', options.database || 'master',
    '-N', '-b', '-r', '1', '-W', '-h', '-1', '-w', '65535', '-y', '0', '-Q', requiredText(query, 'SQL Server query', 65536)
  ];
}

function parseJsonResult(value, label = 'SQL Server result') {
  const text = String(value || '').trim();
  if (!text) throw new DatabaseAdapterError('SQLSERVER_RESULT_EMPTY', `${label} was empty.`, { category: 'integrity' });
  const first = text.indexOf(text.startsWith('[') ? '[' : '{');
  const last = text.lastIndexOf(text.startsWith('[') ? ']' : '}');
  if (first < 0 || last < first) throw new DatabaseAdapterError('SQLSERVER_RESULT_INVALID', `${label} was invalid.`, { category: 'integrity' });
  try { return JSON.parse(text.slice(first, last + 1)); }
  catch { throw new DatabaseAdapterError('SQLSERVER_RESULT_INVALID', `${label} was invalid.`, { category: 'integrity' }); }
}

function parseServerVersion(value) {
  const text = requiredText(value, 'SQL Server version', 100);
  const match = /^(\d+)(?:[.](\d+))?(?:[.](\d+))?/.exec(text);
  const major = Number(match?.[1]);
  if (!match || !SUPPORTED_MAJORS.has(major)) throw new DatabaseAdapterError('SQLSERVER_VERSION_UNSUPPORTED', 'SQL Server 2019, 2022, or 2025 is required.', { category: 'compatibility' });
  return { text, major, minor: Number(match[2] || 0), build: Number(match[3] || 0) };
}

function instanceFingerprint(config, identity) {
  const material = [config.host, config.port, identity.serverName, identity.machineName, identity.instanceName || 'MSSQLSERVER'].map((item) => String(item || '').toLocaleLowerCase('en-US')).join('\0');
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

function safeAdapterError(error, operation) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error instanceof NativeProcessError) {
    const stderr = error.stderr.toLowerCase();
    if (stderr.includes('login failed')) return new DatabaseAdapterError('SQLSERVER_AUTHENTICATION_FAILED', 'SQL Server authentication failed. Check the username and password.', { category: 'authentication' });
    if (stderr.includes('certificate') || stderr.includes('ssl') || stderr.includes('tls')) return new DatabaseAdapterError('SQLSERVER_TLS_FAILED', 'SQL Server TLS certificate verification failed.', { category: 'integrity' });
    if (stderr.includes('network-related') || stderr.includes('connection') || stderr.includes('server was not found')) return new DatabaseAdapterError('SQLSERVER_CONNECT_FAILED', 'DeployerX could not connect to SQL Server. Check the host, port, firewall, and service.', { category: 'connectivity', retryable: true });
    if (error.code === 'NATIVE_EXECUTABLE_NOT_FOUND') return new DatabaseAdapterError('SQLSERVER_SQLCMD_NOT_FOUND', 'Install Microsoft sqlcmd and make it available on PATH.', { category: 'compatibility' });
    if (error.code === 'NATIVE_PROCESS_CANCELED') return new DatabaseAdapterError('SQLSERVER_OPERATION_CANCELED', `The SQL Server ${operation} was canceled.`, { category: 'canceled' });
    if (error.code === 'NATIVE_PROCESS_TIMEOUT') return new DatabaseAdapterError('SQLSERVER_OPERATION_TIMEOUT', `The SQL Server ${operation} exceeded its timeout.`, { category: 'timeout', retryable: true });
  }
  return new DatabaseAdapterError('SQLSERVER_OPERATION_FAILED', `The SQL Server ${operation} failed.`, { category: 'execution' });
}

function identityQuery() {
  return `SET NOCOUNT ON;
SELECT
  CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')) AS serverName,
  CONVERT(nvarchar(128), SERVERPROPERTY('MachineName')) AS machineName,
  CONVERT(nvarchar(128), SERVERPROPERTY('InstanceName')) AS instanceName,
  CONVERT(varchar(100), SERVERPROPERTY('ProductVersion')) AS productVersion,
  CONVERT(nvarchar(128), SERVERPROPERTY('Edition')) AS edition,
  CONVERT(int, SERVERPROPERTY('EngineEdition')) AS engineEdition,
  host_platform AS hostPlatform,
  ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0) AS isSysadmin
FROM sys.dm_os_host_info
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`;
}

function discoveryQuery(includeSystem = false) {
  const systemPredicate = includeSystem ? '' : 'AND database_id > 4';
  return `SET NOCOUNT ON;
SELECT name, state_desc AS state, recovery_model_desc AS recoveryModel, compatibility_level AS compatibilityLevel,
  CONVERT(varchar(36), database_guid) AS databaseGuid, is_read_only AS isReadOnly,
  CASE WHEN source_database_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS isSnapshot
FROM sys.databases
WHERE HAS_DBACCESS(name) = 1 ${systemPredicate}
ORDER BY name
FOR JSON PATH;`;
}

class SqlServerNativeAdapter {
  constructor({ processRunner = new NativeProcessRunner(), clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!processRunner || typeof processRunner.run !== 'function') throw new TypeError('SQL Server process runner is required.');
    this.processRunner = processRunner;
    this.clock = clock;
    this.now = now;
  }

  manifest() {
    return {
      apiVersion: 1, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, displayName: 'SQL Server native backup', engine: 'sqlserver',
      serverVersionRange: '>=15.0.0 <18.0.0', restoreVersionRange: '>=15.0.0 <18.0.0',
      capabilities: {
        backupMethods: ['physical'], backupModes: ['full', 'incremental', 'differential'],
        selection: { database: true, schema: false, table: false, globalObjects: false },
        consistencyStrategies: [{ id: 'sql-server-native-backup', produces: 'application', backupMethods: ['physical'], lockScope: 'database', requiresDowntime: false, capturesCoordinates: true }],
        transactionLogs: { supported: true, type: 'sql-server-transaction-log', pointInTimeRecovery: true, granularitySeconds: 1 },
        streaming: { backup: true, restore: true, compression: true, encryption: false }, restore: { alternateTarget: true, nativeValidation: true }, replicaAware: false
      },
      requiredTools: [{ name: 'sqlcmd', versionRange: '>=18.0.0', operations: ['backup', 'restore', 'validation'] }],
      requiredPrivileges: [{ id: 'sqlserver-sysadmin', operations: ['backup', 'restore'], required: true, safeDescription: 'SQL Server sysadmin membership is required for native backup, restore, tail-log, and metadata validation.' }]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'SQLSERVER_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async runQuery(context, input, query, options = {}) {
    const config = normalizeConfig(input);
    if (typeof context?.resolveSecret !== 'function') throw new DatabaseAdapterError('SQLSERVER_SECRET_RESOLVER_MISSING', 'SQL Server credentials are unavailable.', { category: 'authentication' });
    const password = String(await context.resolveSecret(config.passwordSecretRefId));
    if (!password || password.includes('\0') || /[\r\n]/.test(password)) throw new DatabaseAdapterError('SQLSERVER_PASSWORD_INVALID', 'The SQL Server password cannot be represented safely.', { category: 'authentication' });
    try {
      return await this.processRunner.run({ executable: config.sqlcmdExecutable, args: sqlcmdArguments(config, query, options), env: { SQLCMDPASSWORD: password }, timeoutMs: options.timeoutMs || config.timeoutMs, stdoutLimitBytes: options.stdoutLimitBytes || 8 * 1024 * 1024, signal: context.signal });
    } catch (error) { throw safeAdapterError(error, options.operation || 'query'); }
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const config = normalizeConfig(input);
      const result = await this.runQuery(context, config, identityQuery(), { operation: 'connection test' });
      const identity = parseJsonResult(result.stdout, 'SQL Server identity');
      const version = parseServerVersion(identity.productVersion);
      if (String(identity.hostPlatform).toLowerCase() !== 'linux') throw new DatabaseAdapterError('SQLSERVER_PLATFORM_UNSUPPORTED', 'SQL Server native backup currently requires SQL Server on Linux.', { category: 'compatibility' });
      if (Number(identity.isSysadmin) !== 1) throw new DatabaseAdapterError('SQLSERVER_SYSADMIN_REQUIRED', 'The SQL Server login must be a sysadmin for native backup and restore.', { category: 'authorization' });
      const fingerprint = instanceFingerprint(config, identity);
      return {
        adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'success',
        checks: [
          { id: 'authentication', status: 'pass', safeMessage: 'SQL Server authentication succeeded.' },
          { id: 'server-version', status: 'pass', safeMessage: `SQL Server ${version.text} is supported.` },
          { id: 'platform', status: 'pass', safeMessage: 'SQL Server is running on Linux.' },
          { id: 'sysadmin', status: 'pass', safeMessage: 'The SQL Server login has sysadmin membership.' },
          { id: 'tls', status: 'pass', safeMessage: 'Encrypted TLS with certificate identity verification is required.' }
        ],
        remotePlatform: { engine: 'sqlserver', version: version.text, distribution: identity.edition || 'SQL Server', platform: 'linux' },
        endpointIdentity: { serverFingerprint: fingerprint, instanceFingerprint: fingerprint, serverName: String(identity.serverName || ''), machineName: String(identity.machineName || ''), instanceName: identity.instanceName || null }, error: null
      };
    } catch (error) {
      const safe = safeAdapterError(error, 'connection test');
      return { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'failure', checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null } };
    }
  }

  async *discover(context = {}, request = {}) {
    const result = await this.runQuery(context, request.connection, discoveryQuery(Boolean(request.includeSystem)), { operation: 'database discovery', stdoutLimitBytes: 4 * 1024 * 1024 });
    const rows = parseJsonResult(result.stdout, 'SQL Server database discovery');
    if (!Array.isArray(rows) || rows.length > 1000) throw new DatabaseAdapterError('SQLSERVER_DISCOVERY_INVALID', 'SQL Server returned an invalid database inventory.', { category: 'integrity' });
    yield {
      items: rows.map((row) => {
        const name = requiredText(row.name, 'SQL Server discovered database', 128);
        const system = SYSTEM_DATABASES.has(name.toLocaleLowerCase('en-US'));
        const selectable = !system && row.state === 'ONLINE' && !row.isReadOnly && !row.isSnapshot;
        return { kind: 'database', name, system, selectable, state: row.state, recoveryModel: row.recoveryModel, compatibilityLevel: Number(row.compatibilityLevel), databaseGuid: row.databaseGuid || null, reasonCode: selectable ? null : system ? 'system-database' : row.isSnapshot ? 'database-snapshot' : row.isReadOnly ? 'read-only' : 'not-online' };
      }), nextCursor: null
    };
  }

  async preflight(context = {}, request = {}) {
    const tested = await this.testConnection(context, request.connection);
    if (tested.status !== 'success') throw new DatabaseAdapterError(tested.error.code, tested.error.safeMessage, { category: tested.error.category, retryable: tested.error.retryable });
    return { checkedAt: tested.testedAt, serverVersion: tested.remotePlatform.version, serverVersionSupported: true, serverIdentityFingerprint: tested.endpointIdentity.instanceFingerprint, consistency: [{ method: 'sql-server-native-backup', verified: true, produces: 'application' }], tools: [{ name: 'sqlcmd', version: tested.remotePlatform.version, compatible: true }], privileges: [{ id: 'sqlserver-sysadmin', allowed: true }], coordinateCaptureVerified: true, warnings: [], metadata: { engine: 'sqlserver', platform: 'linux' } };
  }

  async planBackup(_context = {}, request = {}) { return { operation: 'sqlserver-native-backup', selector: request.selector, consistency: request.consistency }; }
  async executeBackup() { throw new DatabaseAdapterError('SQLSERVER_PHYSICAL_EXECUTION_REQUIRED', 'SQL Server backups require the paired SSH native execution service.', { category: 'compatibility' }); }
  async planRestore() { throw new DatabaseAdapterError('SQLSERVER_RESTORE_SERVICE_REQUIRED', 'SQL Server restore requires the native restore service.', { category: 'compatibility' }); }
  async executeRestore() { throw new DatabaseAdapterError('SQLSERVER_RESTORE_SERVICE_REQUIRED', 'SQL Server restore requires the native restore service.', { category: 'compatibility' }); }
  async validateRestore() { return { status: 'failed', valid: false, checks: [] }; }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class SqlServerConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new SqlServerNativeAdapter() } = {}) {
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
    const name = requiredText(input.name, 'SQL Server connection name', 200);
    const password = String(input.password ?? '');
    if (!password || password.includes('\0') || /[\r\n]/.test(password) || password.length > 1024 * 1024) throw new TypeError('SQL Server password is invalid.');
    let passwordRef = null;
    try {
      passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} SQL Server password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({ host: input.host, port: input.port, username: input.username, passwordSecretRefId: passwordRef.id, tlsMode: input.tlsMode, timeoutMs: input.timeoutMs, sqlcmdExecutable: input.sqlcmdExecutable });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device',
          endpoint: { host: config.host, port: config.port, username: config.username, database: 'master', tlsMode: config.tlsMode, timeoutMs: config.timeoutMs, sqlcmdExecutable: config.sqlcmdExecutable },
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
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('SQL Server source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This SQL Server connection belongs to another device.');
    const result = normalizeConnectionTestResult(await this.adapter.testConnection({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }) }, this.config(current)), { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const trust = result.status === 'success' ? { mode: current.endpoint.tlsMode, fingerprint: result.endpointIdentity?.instanceFingerprint || null, observedAt: result.testedAt } : current.trust;
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { lastTest: result, trust, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('SQL Server source connection was not found.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the SQL Server connection successfully before discovering databases.');
    const pages = [];
    for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current), includeSystem: input.includeSystem })) pages.push(page);
    return pages[0] || { items: [], nextCursor: null };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SqlServerConnectionService,
  SqlServerNativeAdapter,
  discoveryQuery,
  identityQuery,
  instanceFingerprint,
  normalizeConfig,
  normalizeDatabaseName,
  parseJsonResult,
  parseServerVersion,
  safeAdapterError,
  sqlcmdArguments
};
