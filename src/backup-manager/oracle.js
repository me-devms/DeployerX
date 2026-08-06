const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { NativeProcessError, NativeProcessRunner } = require('./native-process');

const ADAPTER_ID = 'deployerx.database.oracle.rman';
const ADAPTER_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30000;
const SUPPORTED_MAJORS = new Set([19, 21, 23]);
const RECORD_SEPARATOR = '\x1f';
const IDENTITY_MARKER = 'DX_ORACLE_ID';

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeHost(value) {
  const input = requiredText(value, 'Oracle host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('Oracle host must be a hostname or IP address without a URL scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('Oracle host is invalid.');
  return ascii;
}

function normalizePort(value) {
  const port = Number(value ?? 2484);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Oracle TCPS port must be between 1 and 65535.');
  return port;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('Oracle timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeExecutable(value) {
  const executable = value === undefined || value === null || value === '' ? 'sqlplus' : requiredText(value, 'SQL*Plus executable', 4096);
  if (path.win32.basename(executable).toLowerCase().replace(/[.]exe$/, '') !== 'sqlplus') throw new TypeError('Only the sqlplus executable may be configured.');
  return executable;
}

function normalizeServiceName(value) {
  const serviceName = requiredText(value, 'Oracle service name', 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._$#-]{0,254}$/.test(serviceName)) throw new TypeError('Oracle service name is invalid.');
  return serviceName;
}

function normalizeUsername(value) {
  const username = requiredText(value, 'Oracle username', 128);
  if (!/^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(username)) throw new TypeError('Oracle username must be an unquoted Oracle account name.');
  return username.toUpperCase();
}

function normalizeTnsAdminDirectory(value) {
  if (value === undefined || value === null || value === '') return null;
  const directory = requiredText(value, 'Oracle TNS admin directory', 4096);
  if (!path.isAbsolute(directory)) throw new TypeError('Oracle TNS admin directory must be absolute.');
  return path.normalize(directory);
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Oracle connection configuration must be an object.');
  const allowed = ['host', 'port', 'serviceName', 'username', 'passwordSecretRefId', 'tlsMode', 'timeoutMs', 'sqlplusExecutable', 'tnsAdminDirectory'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown Oracle connection field: ${unknown[0]}.`);
  const tlsMode = String(input.tlsMode || 'verify-identity').toLowerCase();
  if (tlsMode !== 'verify-identity') throw new TypeError('Oracle RMAN protection requires TCPS with certificate identity verification.');
  return {
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    serviceName: normalizeServiceName(input.serviceName),
    username: normalizeUsername(input.username),
    passwordSecretRefId: requiredText(input.passwordSecretRefId, 'Oracle password SecretRef ID', 200),
    tlsMode,
    timeoutMs: normalizeTimeout(input.timeoutMs),
    sqlplusExecutable: normalizeExecutable(input.sqlplusExecutable),
    tnsAdminDirectory: normalizeTnsAdminDirectory(input.tnsAdminDirectory)
  };
}

function quoteSqlPlusCredential(value, label) {
  const text = String(value ?? '');
  if (!text || text.includes('\0') || /[\r\n]/.test(text) || text.length > 1024 * 1024) throw new DatabaseAdapterError('ORACLE_CREDENTIAL_INVALID', `${label} cannot be represented safely.`, { category: 'authentication' });
  return `"${text.replace(/"/g, '""')}"`;
}

function tcpsDescriptor(config) {
  return `(DESCRIPTION=(CONNECT_TIMEOUT=${Math.max(1, Math.ceil(config.timeoutMs / 1000))})(TRANSPORT_CONNECT_TIMEOUT=${Math.max(1, Math.ceil(config.timeoutMs / 1000))})(ADDRESS=(PROTOCOL=TCPS)(HOST=${config.host})(PORT=${config.port}))(CONNECT_DATA=(SERVICE_NAME=${config.serviceName}))(SECURITY=(SSL_SERVER_DN_MATCH=YES)))`;
}

function identityQuery() {
  return `SELECT '${IDENTITY_MARKER}' || CHR(31) ||
  TO_CHAR(d.dbid) || CHR(31) || d.name || CHR(31) || d.db_unique_name || CHR(31) ||
  d.database_role || CHR(31) || d.open_mode || CHR(31) || d.log_mode || CHR(31) || d.cdb || CHR(31) ||
  d.platform_name || CHR(31) || i.instance_name || CHR(31) || i.host_name || CHR(31) || i.version_full || CHR(31) ||
  TO_CHAR((SELECT COUNT(*) FROM gv$instance)) || CHR(31) ||
  TO_CHAR((SELECT incarnation# FROM v$database_incarnation WHERE status = 'CURRENT')) || CHR(31) ||
  TO_CHAR(d.resetlogs_change#) || CHR(31) || TO_CHAR(d.resetlogs_time, 'YYYY-MM-DD"T"HH24:MI:SS') || CHR(31) ||
  TO_CHAR(d.current_scn)
FROM v$database d CROSS JOIN v$instance i;`;
}

function sqlPlusScript(config, password, query) {
  const statement = requiredText(query, 'Oracle SQL query', 65536);
  return Buffer.from(`WHENEVER OSERROR EXIT 91\nWHENEVER SQLERROR EXIT SQL.SQLCODE\nSET ECHO OFF FEEDBACK OFF HEADING OFF PAGESIZE 0 VERIFY OFF TERMOUT ON TRIMSPOOL ON LINESIZE 32767\nCONNECT ${quoteSqlPlusCredential(config.username, 'Oracle username')}/${quoteSqlPlusCredential(password, 'Oracle password')}@${quoteSqlPlusCredential(tcpsDescriptor(config), 'Oracle TCPS descriptor')} AS SYSBACKUP\nALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,';\n${statement}\nEXIT SUCCESS\n`, 'utf8');
}

function decimalText(value, label) {
  const text = requiredText(value, label, 100);
  if (!/^\d+$/.test(text)) throw new DatabaseAdapterError('ORACLE_IDENTITY_INVALID', `Oracle returned an invalid ${label.toLowerCase()}.`, { category: 'integrity' });
  return text.replace(/^0+(?=\d)/, '');
}

function parseIdentity(value) {
  const line = String(value || '').split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith(`${IDENTITY_MARKER}${RECORD_SEPARATOR}`));
  if (!line) throw new DatabaseAdapterError('ORACLE_IDENTITY_EMPTY', 'Oracle database identity output was missing.', { category: 'integrity' });
  const fields = line.split(RECORD_SEPARATOR);
  if (fields.length !== 17 || fields[0] !== IDENTITY_MARKER) throw new DatabaseAdapterError('ORACLE_IDENTITY_INVALID', 'Oracle returned invalid database identity output.', { category: 'integrity' });
  const instanceCount = Number(decimalText(fields[12], 'Oracle instance count'));
  const incarnation = Number(decimalText(fields[13], 'Oracle incarnation'));
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 1 || instanceCount > 1024 || !Number.isSafeInteger(incarnation) || incarnation < 1) throw new DatabaseAdapterError('ORACLE_IDENTITY_INVALID', 'Oracle returned invalid topology or incarnation evidence.', { category: 'integrity' });
  return {
    dbid: decimalText(fields[1], 'Oracle DBID'),
    databaseName: requiredText(fields[2], 'Oracle database name', 128),
    databaseUniqueName: requiredText(fields[3], 'Oracle database unique name', 128),
    databaseRole: requiredText(fields[4], 'Oracle database role', 40).toUpperCase(),
    openMode: requiredText(fields[5], 'Oracle open mode', 40).toUpperCase(),
    logMode: requiredText(fields[6], 'Oracle log mode', 40).toUpperCase(),
    cdb: requiredText(fields[7], 'Oracle CDB flag', 10).toUpperCase() === 'YES',
    platformName: requiredText(fields[8], 'Oracle platform', 200),
    instanceName: requiredText(fields[9], 'Oracle instance name', 128),
    hostName: requiredText(fields[10], 'Oracle host identity', 255),
    version: requiredText(fields[11], 'Oracle version', 100),
    instanceCount,
    incarnation,
    resetlogsChange: decimalText(fields[14], 'Oracle resetlogs SCN'),
    resetlogsTime: requiredText(fields[15], 'Oracle resetlogs time', 100),
    currentScn: decimalText(fields[16], 'Oracle current SCN')
  };
}

function parseServerVersion(value) {
  const text = requiredText(value, 'Oracle version', 100);
  const match = /^(\d+)(?:[.](\d+))?(?:[.](\d+))?/.exec(text);
  const major = Number(match?.[1]);
  if (!match || !SUPPORTED_MAJORS.has(major)) throw new DatabaseAdapterError('ORACLE_VERSION_UNSUPPORTED', 'Oracle Database 19c, 21c, or 23ai is required.', { category: 'compatibility' });
  return { text, major, minor: Number(match[2] || 0), update: Number(match[3] || 0) };
}

function databaseFingerprint(identity) {
  const material = [identity.dbid, identity.databaseName, identity.databaseUniqueName, identity.platformName].map((item) => String(item || '').toLocaleLowerCase('en-US')).join('\0');
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

function instanceFingerprint(config, identity) {
  const material = [config.host, config.port, config.serviceName, identity.dbid, identity.databaseUniqueName, identity.instanceName, identity.hostName].map((item) => String(item || '').toLocaleLowerCase('en-US')).join('\0');
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

function validateIdentity(identity) {
  const version = parseServerVersion(identity.version);
  if (!identity.platformName.toLowerCase().startsWith('linux')) throw new DatabaseAdapterError('ORACLE_PLATFORM_UNSUPPORTED', 'Oracle RMAN protection currently requires Oracle Database on Linux.', { category: 'compatibility' });
  if (identity.databaseRole !== 'PRIMARY') throw new DatabaseAdapterError('ORACLE_ROLE_UNSUPPORTED', 'Oracle RMAN protection currently requires a primary database.', { category: 'compatibility' });
  if (identity.openMode !== 'READ WRITE') throw new DatabaseAdapterError('ORACLE_OPEN_MODE_UNSUPPORTED', 'Oracle RMAN online protection requires the database to be open read/write.', { category: 'consistency' });
  if (identity.logMode !== 'ARCHIVELOG') throw new DatabaseAdapterError('ORACLE_ARCHIVELOG_REQUIRED', 'Enable Oracle ARCHIVELOG mode before configuring online RMAN protection.', { category: 'consistency' });
  if (identity.instanceCount !== 1) throw new DatabaseAdapterError('ORACLE_RAC_UNSUPPORTED', 'Oracle RAC databases are not supported in this release.', { category: 'compatibility' });
  return version;
}

function safeAdapterError(error, operation) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error instanceof NativeProcessError) {
    const output = error.stderr.toLowerCase();
    if (output.includes('ora-01017') || output.includes('ora-01031')) return new DatabaseAdapterError('ORACLE_AUTHENTICATION_FAILED', 'Oracle SYSBACKUP authentication failed. Check the username, password, and administrative privilege.', { category: 'authentication' });
    if (output.includes('ora-29024') || output.includes('ora-28860') || output.includes('certificate') || output.includes('ssl')) return new DatabaseAdapterError('ORACLE_TLS_FAILED', 'Oracle TCPS certificate identity verification failed.', { category: 'integrity' });
    if (output.includes('ora-12154') || output.includes('ora-12514') || output.includes('ora-12541') || output.includes('ora-12545')) return new DatabaseAdapterError('ORACLE_CONNECT_FAILED', 'DeployerX could not connect to the Oracle service. Check the host, TCPS port, service name, listener, and firewall.', { category: 'connectivity', retryable: true });
    if (error.code === 'NATIVE_EXECUTABLE_NOT_FOUND') return new DatabaseAdapterError('ORACLE_SQLPLUS_NOT_FOUND', 'Install a supported Oracle SQL*Plus client and make it available on PATH.', { category: 'compatibility' });
    if (error.code === 'NATIVE_PROCESS_CANCELED') return new DatabaseAdapterError('ORACLE_OPERATION_CANCELED', `The Oracle ${operation} was canceled.`, { category: 'canceled' });
    if (error.code === 'NATIVE_PROCESS_TIMEOUT') return new DatabaseAdapterError('ORACLE_OPERATION_TIMEOUT', `The Oracle ${operation} exceeded its timeout.`, { category: 'timeout', retryable: true });
  }
  return new DatabaseAdapterError('ORACLE_OPERATION_FAILED', `The Oracle ${operation} failed.`, { category: 'execution' });
}

class OracleRmanAdapter {
  constructor({ processRunner = new NativeProcessRunner(), clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!processRunner || typeof processRunner.consume !== 'function') throw new TypeError('Oracle process runner with standard-input support is required.');
    this.processRunner = processRunner;
    this.clock = clock;
    this.now = now;
  }

  manifest() {
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      displayName: 'Oracle RMAN',
      engine: 'oracle',
      serverVersionRange: '>=19.0.0 <24.0.0',
      restoreVersionRange: '>=19.0.0 <24.0.0',
      capabilities: {
        backupMethods: ['physical'],
        backupModes: ['full', 'incremental', 'differential', 'native'],
        selection: { database: true, schema: false, table: false, globalObjects: false },
        consistencyStrategies: [{ id: 'oracle-rman', produces: 'application', backupMethods: ['physical'], lockScope: 'database', requiresDowntime: false, capturesCoordinates: true }],
        transactionLogs: { supported: true, type: 'oracle-archived-redo-log', pointInTimeRecovery: true, granularitySeconds: 1 },
        streaming: { backup: true, restore: true, compression: true, encryption: false },
        restore: { alternateTarget: true, nativeValidation: true },
        replicaAware: false
      },
      requiredTools: [
        { name: 'sqlplus', versionRange: '>=19.0.0 <24.0.0', operations: ['discovery', 'validation'] },
        { name: 'rman', versionRange: '>=19.0.0 <24.0.0', operations: ['backup', 'restore', 'validation'] }
      ],
      requiredPrivileges: [
        { id: 'oracle-sysbackup', operations: ['discovery', 'backup', 'restore'], required: true, safeDescription: 'Oracle SYSBACKUP administrative privilege is required for control-plane discovery and native RMAN operations.' },
        { id: 'oracle-osbackupdba', operations: ['backup', 'restore'], required: true, safeDescription: 'The paired SSH execution identity must run RMAN through a dedicated Oracle OS backup administrative account.' }
      ]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'ORACLE_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async runQuery(context, input, query, options = {}) {
    const config = normalizeConfig(input);
    if (typeof context?.resolveSecret !== 'function') throw new DatabaseAdapterError('ORACLE_SECRET_RESOLVER_MISSING', 'Oracle credentials are unavailable.', { category: 'authentication' });
    const password = String(await context.resolveSecret(config.passwordSecretRefId));
    const stdin = sqlPlusScript(config, password, query);
    try {
      return await this.processRunner.consume({
        executable: config.sqlplusExecutable,
        args: ['-L', '-S', '/nolog'],
        env: config.tnsAdminDirectory ? { TNS_ADMIN: config.tnsAdminDirectory } : {},
        stdin,
        timeoutMs: options.timeoutMs || config.timeoutMs,
        stdoutLimitBytes: options.stdoutLimitBytes || 4 * 1024 * 1024,
        signal: context.signal
      });
    } catch (error) { throw safeAdapterError(error, options.operation || 'query'); }
  }

  async readIdentity(context, input, options = {}) {
    const result = await this.runQuery(context, input, identityQuery(), { ...options, operation: options.operation || 'identity query' });
    return parseIdentity(result.stdout);
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const config = normalizeConfig(input);
      const identity = await this.readIdentity(context, config, { operation: 'connection test' });
      const version = validateIdentity(identity);
      return {
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'success',
        checks: [
          { id: 'authentication', status: 'pass', safeMessage: 'Oracle SYSBACKUP authentication succeeded.' },
          { id: 'server-version', status: 'pass', safeMessage: `Oracle Database ${version.text} is supported.` },
          { id: 'platform', status: 'pass', safeMessage: 'Oracle Database is running on Linux.' },
          { id: 'database-role', status: 'pass', safeMessage: 'The Oracle database is a single-instance primary.' },
          { id: 'open-mode', status: 'pass', safeMessage: 'The Oracle database is open read/write.' },
          { id: 'archivelog', status: 'pass', safeMessage: 'Oracle ARCHIVELOG mode is enabled.' },
          { id: 'tls', status: 'pass', safeMessage: 'TCPS certificate identity verification is required.' }
        ],
        remotePlatform: { engine: 'oracle', version: version.text, distribution: 'Oracle Database', platform: 'linux' },
        endpointIdentity: {
          databaseFingerprint: databaseFingerprint(identity),
          instanceFingerprint: instanceFingerprint(config, identity),
          dbid: identity.dbid,
          databaseName: identity.databaseName,
          databaseUniqueName: identity.databaseUniqueName,
          incarnation: identity.incarnation,
          resetlogsChange: identity.resetlogsChange,
          instanceName: identity.instanceName,
          hostName: identity.hostName,
          cdb: identity.cdb
        },
        error: null
      };
    } catch (error) {
      const safe = safeAdapterError(error, 'connection test');
      return { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'failure', checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null } };
    }
  }

  async *discover(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const identity = await this.readIdentity(context, config, { operation: 'database discovery' });
    const version = validateIdentity(identity);
    yield {
      items: [{
        kind: 'database',
        name: identity.databaseUniqueName,
        databaseName: identity.databaseName,
        system: false,
        selectable: true,
        state: identity.openMode,
        role: identity.databaseRole,
        recoveryModel: identity.logMode,
        version: version.text,
        dbid: identity.dbid,
        incarnation: identity.incarnation,
        resetlogsChange: identity.resetlogsChange,
        currentScn: identity.currentScn,
        cdb: identity.cdb,
        reasonCode: null
      }],
      nextCursor: null
    };
  }

  async preflight(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const identity = await this.readIdentity(context, config, { operation: 'preflight' });
    const version = validateIdentity(identity);
    return {
      checkedAt: this.clock(),
      serverVersion: version.text,
      serverVersionSupported: true,
      serverIdentityFingerprint: databaseFingerprint(identity),
      consistency: [{ method: 'oracle-rman', verified: true, produces: 'application' }],
      tools: [{ name: 'sqlplus', version: version.text, compatible: true }],
      privileges: [{ id: 'oracle-sysbackup', allowed: true }],
      coordinateCaptureVerified: true,
      warnings: [],
      metadata: { engine: 'oracle', platform: 'linux', dbid: identity.dbid, incarnation: identity.incarnation, resetlogsChange: identity.resetlogsChange }
    };
  }

  async planBackup(_context = {}, request = {}) { return { operation: 'oracle-rman-backup', selector: request.selector, consistency: request.consistency }; }
  async executeBackup() { throw new DatabaseAdapterError('ORACLE_RMAN_EXECUTION_REQUIRED', 'Oracle backups require the paired SSH RMAN execution service.', { category: 'compatibility' }); }
  async planRestore() { throw new DatabaseAdapterError('ORACLE_RESTORE_SERVICE_REQUIRED', 'Oracle recovery requires the native RMAN restore service.', { category: 'compatibility' }); }
  async executeRestore() { throw new DatabaseAdapterError('ORACLE_RESTORE_SERVICE_REQUIRED', 'Oracle recovery requires the native RMAN restore service.', { category: 'compatibility' }); }
  async validateRestore() { return { status: 'failed', valid: false, checks: [] }; }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class OracleConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new OracleRmanAdapter() } = {}) {
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
    const name = requiredText(input.name, 'Oracle connection name', 200);
    const password = String(input.password ?? '');
    quoteSqlPlusCredential(password, 'Oracle password');
    let passwordRef = null;
    try {
      passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} Oracle password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({
        host: input.host,
        port: input.port,
        serviceName: input.serviceName,
        username: input.username,
        passwordSecretRefId: passwordRef.id,
        tlsMode: input.tlsMode,
        timeoutMs: input.timeoutMs,
        sqlplusExecutable: input.sqlplusExecutable,
        tnsAdminDirectory: input.tnsAdminDirectory
      });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant,
          actorId: actor,
          name,
          kind: 'database',
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          scope: 'device',
          endpoint: {
            host: config.host,
            port: config.port,
            serviceName: config.serviceName,
            username: config.username,
            tlsMode: config.tlsMode,
            timeoutMs: config.timeoutMs,
            sqlplusExecutable: config.sqlplusExecutable,
            tnsAdminDirectory: config.tnsAdminDirectory
          },
          secretRefIds: [passwordRef.id],
          trust: { mode: config.tlsMode, fingerprint: null },
          workerAffinity: [`device:${this.deviceId}`],
          lastTest: null
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
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Oracle source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This Oracle connection belongs to another device.');
    const result = normalizeConnectionTestResult(await this.adapter.testConnection({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }) }, this.config(current)), { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const trust = result.status === 'success' ? { mode: current.endpoint.tlsMode, fingerprint: result.endpointIdentity?.databaseFingerprint || null, observedAt: result.testedAt } : current.trust;
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { lastTest: result, trust, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Oracle source connection was not found.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the Oracle connection successfully before discovering databases.');
    const pages = [];
    for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current) })) pages.push(page);
    return pages[0] || { items: [], nextCursor: null };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  OracleConnectionService,
  OracleRmanAdapter,
  databaseFingerprint,
  identityQuery,
  instanceFingerprint,
  normalizeConfig,
  parseIdentity,
  parseServerVersion,
  safeAdapterError,
  sqlPlusScript,
  tcpsDescriptor,
  validateIdentity
};
