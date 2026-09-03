const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { remapPostgresqlDump, remapPostgresqlMetadata } = require('./database-restore-target');
const { NativeProcessError, NativeProcessRunner } = require('./native-process');
const { compareInventory, expectedInventory, inventoryQuery, normalizeInventory, scopeFromMetadata } = require('./postgresql-validation');

const ADAPTER_ID = 'deployerx.database.postgresql.logical';
const ADAPTER_VERSION = '1.5.0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_DISCOVERED_DATABASES = 1000;
const MAX_DISCOVERED_OBJECTS = 10000;
const SYSTEM_DATABASES = new Set(['template0', 'template1']);
const TLS_MODES = new Set(['disabled', 'preferred', 'required', 'verify-ca', 'verify-identity']);
const DEPLOYMENT_PROFILES = new Set(['postgresql', 'supabase']);
const SUPABASE_ENDPOINT_MODES = new Set(['direct', 'session-pooler', 'transaction-pooler']);
const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const SUPABASE_TRANSACTION_POOLER_ERROR_CODE = 'POSTGRESQL_SUPABASE_TRANSACTION_POOLER_INELIGIBLE';
const SUPABASE_MANAGED_SCHEMAS = Object.freeze([
  '_analytics', '_realtime', 'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'net',
  'pgbouncer', 'pgmq', 'pgsodium', 'pgsodium_masks', 'realtime', 'storage', 'supabase_functions', 'vault'
]);
const SUPABASE_MANAGED_SCHEMA_SET = new Set(SUPABASE_MANAGED_SCHEMAS);
const MINIMUM_MAJOR = 14;
const MAXIMUM_MAJOR = 18;

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeHost(value) {
  const input = requiredText(value, 'PostgreSQL host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('PostgreSQL host must be a hostname or IP address without a URL scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('PostgreSQL host is invalid.');
  return ascii;
}

function normalizePort(value, defaultPort = 5432) {
  const port = Number(value ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('PostgreSQL port must be between 1 and 65535.');
  return port;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('PostgreSQL timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeExecutable(value, expectedName) {
  const executable = value === undefined || value === null || value === '' ? expectedName : requiredText(value, `${expectedName} executable`, 4096);
  const base = path.win32.basename(executable).toLowerCase().replace(/[.]exe$/, '');
  if (base !== expectedName) throw new TypeError(`Only the ${expectedName} executable may be configured.`);
  return executable;
}

function normalizeDatabaseName(value, label = 'PostgreSQL database') {
  const name = requiredText(value, label, 63);
  if (/\p{C}/u.test(name)) throw new TypeError(`${label} contains invalid control characters.`);
  return name;
}

function normalizeDeploymentProfile(value) {
  const profile = String(value || 'postgresql').trim().toLowerCase();
  if (!DEPLOYMENT_PROFILES.has(profile)) throw new TypeError('PostgreSQL deployment profile is not supported.');
  return profile;
}

function normalizeSupabaseProjectRef(value) {
  const projectRef = String(value ?? '').trim().toLowerCase();
  if (!SUPABASE_PROJECT_REF_PATTERN.test(projectRef)) throw new TypeError('Supabase project reference must contain exactly 20 lowercase letters or digits.');
  return projectRef;
}

function normalizeSupabaseEndpointMode(value) {
  const mode = String(value || 'direct').trim().toLowerCase();
  if (!SUPABASE_ENDPOINT_MODES.has(mode)) throw new TypeError('Supabase endpoint mode is not supported.');
  return mode;
}

function assertSupabaseEndpointBinding(config) {
  if (config.connectionMode === 'direct') {
    if (config.host !== `db.${config.projectRef}.supabase.co` || config.port !== 5432) throw new TypeError('Supabase direct connections must use the project-bound db.<projectRef>.supabase.co endpoint on port 5432.');
    return;
  }
  if (!config.host.endsWith('.pooler.supabase.com') || config.host === 'pooler.supabase.com') throw new TypeError('Supabase pooler connections must use a hosted *.pooler.supabase.com endpoint.');
  if (!config.username.toLowerCase().endsWith(`.${config.projectRef}`)) throw new TypeError('Supabase pooler usernames must end with the configured project reference.');
  const expectedPort = config.connectionMode === 'transaction-pooler' ? 6543 : 5432;
  if (config.port !== expectedPort) throw new TypeError(`Supabase ${config.connectionMode} connections must use port ${expectedPort}.`);
}

function profileMetadata(config) {
  if (config.deploymentProfile !== 'supabase') return { deploymentProfile: 'postgresql' };
  return {
    deploymentProfile: 'supabase',
    connectionMode: config.connectionMode,
    projectRef: config.projectRef,
    coverage: 'database-logical-only'
  };
}

function assertBackupRestoreEligible(config, operation) {
  if (config.deploymentProfile === 'supabase' && config.connectionMode === 'transaction-pooler') {
    throw new DatabaseAdapterError(SUPABASE_TRANSACTION_POOLER_ERROR_CODE, 'Supabase transaction-pooler connections can be saved and tested, but backup and restore require a direct or session-pooler endpoint.', {
      category: 'compatibility',
      details: { deploymentProfile: 'supabase', connectionMode: config.connectionMode, operation: String(operation || 'backup-restore').slice(0, 80) }
    });
  }
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('PostgreSQL connection configuration must be an object.');
  const allowed = ['host', 'port', 'username', 'database', 'maintenanceDatabase', 'passwordSecretRefId', 'tlsMode', 'timeoutMs', 'psqlExecutable', 'pgDumpExecutable', 'deploymentProfile', 'connectionMode', 'supabaseEndpointMode', 'projectRef'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown PostgreSQL connection field: ${unknown[0]}.`);
  const deploymentProfile = normalizeDeploymentProfile(input.deploymentProfile);
  if (input.connectionMode !== undefined && input.connectionMode !== null && input.supabaseEndpointMode !== undefined && input.supabaseEndpointMode !== null && String(input.connectionMode).trim().toLowerCase() !== String(input.supabaseEndpointMode).trim().toLowerCase()) throw new TypeError('Conflicting Supabase connection mode fields were provided.');
  const requestedConnectionMode = input.connectionMode ?? input.supabaseEndpointMode;
  const connectionMode = deploymentProfile === 'supabase' ? normalizeSupabaseEndpointMode(requestedConnectionMode) : null;
  const projectRef = deploymentProfile === 'supabase' ? normalizeSupabaseProjectRef(input.projectRef) : null;
  if (deploymentProfile === 'postgresql' && requestedConnectionMode !== undefined && requestedConnectionMode !== null && requestedConnectionMode !== '') throw new TypeError('Supabase connection mode is only valid for the Supabase deployment profile.');
  if (deploymentProfile === 'postgresql' && input.projectRef !== undefined && input.projectRef !== null && input.projectRef !== '') throw new TypeError('Supabase project reference is only valid for the Supabase deployment profile.');
  const username = requiredText(input.username, 'PostgreSQL username', 63);
  if (/\p{C}/u.test(username)) throw new TypeError('PostgreSQL username contains invalid characters.');
  const tlsMode = String(input.tlsMode || 'verify-identity').toLowerCase();
  if (!TLS_MODES.has(tlsMode)) throw new TypeError('PostgreSQL TLS mode is not supported.');
  if (deploymentProfile === 'supabase' && (tlsMode === 'disabled' || tlsMode === 'preferred')) throw new TypeError('Supabase connections require TLS. Disabled and preferred TLS modes are not allowed.');
  const config = {
    host: normalizeHost(input.host), port: normalizePort(input.port, connectionMode === 'transaction-pooler' ? 6543 : 5432), username,
    maintenanceDatabase: normalizeDatabaseName(input.maintenanceDatabase || input.database || 'postgres', 'PostgreSQL maintenance database'),
    passwordSecretRefId: requiredText(input.passwordSecretRefId, 'PostgreSQL password SecretRef ID', 200),
    tlsMode, timeoutMs: normalizeTimeout(input.timeoutMs),
    psqlExecutable: normalizeExecutable(input.psqlExecutable, 'psql'),
    pgDumpExecutable: normalizeExecutable(input.pgDumpExecutable, 'pg_dump'),
    deploymentProfile,
    connectionMode,
    projectRef
  };
  if (deploymentProfile === 'supabase') assertSupabaseEndpointBinding(config);
  return config;
}

function versionResult(match, fallback = '') {
  if (!match) return { text: String(fallback || '').slice(0, 100) || null, major: null, minor: null, patch: null, supported: false };
  const version = { text: [match[1], match[2] || '0', match[3] || '0'].join('.'), major: Number(match[1]), minor: Number(match[2] || 0), patch: Number(match[3] || 0) };
  return { ...version, supported: version.major >= MINIMUM_MAJOR && version.major <= MAXIMUM_MAJOR };
}

function postgresToolVersion(value) {
  const text = String(value || '');
  return versionResult(text.match(/\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?(?:\.(\d+))?/i), text);
}

function serverVersion(value) {
  const text = String(value || '').trim();
  return versionResult(text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/), text);
}

function sslMode(tlsMode) {
  if (tlsMode === 'verify-identity') return 'verify-full';
  if (tlsMode === 'disabled') return 'disable';
  if (tlsMode === 'preferred') return 'prefer';
  if (tlsMode === 'required') return 'require';
  return tlsMode;
}

function pgpassField(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

function pgpassContents(config, password) {
  const secret = String(password ?? '');
  if (!secret || /[\r\n\0]/.test(secret)) throw new DatabaseAdapterError('POSTGRESQL_PASSWORD_UNSUPPORTED', 'The PostgreSQL password contains characters that cannot be represented safely in a passfile.', { category: 'authentication' });
  return `${pgpassField(config.host)}:${config.port}:*:${pgpassField(config.username)}:${pgpassField(secret)}\n`;
}

function safeAdapterError(error, operation) {
  if (error instanceof DatabaseAdapterError) return error;
  const message = String(error?.message || '').toLowerCase();
  if (/secret could not be decrypted|credentials are unavailable|secret has expired/.test(message)) {
    return new DatabaseAdapterError('POSTGRESQL_CREDENTIALS_UNAVAILABLE', 'The saved PostgreSQL password could not be read on this device. Edit the connection and enter the password again.', { category: 'authentication' });
  }
  if (error instanceof NativeProcessError) {
    const stderr = error.stderr.toLowerCase();
    if (stderr.includes('password authentication failed')) return new DatabaseAdapterError('POSTGRESQL_AUTHENTICATION_FAILED', 'PostgreSQL authentication failed. Check the username and password.', { category: 'authentication' });
    if (stderr.includes('no pg_hba.conf entry')) return new DatabaseAdapterError('POSTGRESQL_ACCESS_POLICY_FAILED', 'The PostgreSQL host access policy rejected this connection.', { category: 'authorization' });
    if (stderr.includes('pg_control_system') && (stderr.includes('permission denied') || stderr.includes('must be superuser'))) return new DatabaseAdapterError('POSTGRESQL_IDENTITY_PRIVILEGE_MISSING', 'Grant this backup account permission to execute pg_control_system so DeployerX can pin the PostgreSQL cluster identity.', { category: 'authorization' });
    if (stderr.includes('permission denied')) return new DatabaseAdapterError('POSTGRESQL_PRIVILEGE_MISSING', 'The PostgreSQL account does not have all permissions required for this operation.', { category: 'authorization' });
    if (stderr.includes('ssl') || stderr.includes('certificate')) return new DatabaseAdapterError('POSTGRESQL_TLS_FAILED', 'PostgreSQL TLS verification failed. Check the server certificate and TLS mode.', { category: 'integrity' });
    if (stderr.includes('could not translate host name') || stderr.includes('connection refused') || stderr.includes('could not connect')) return new DatabaseAdapterError('POSTGRESQL_CONNECT_FAILED', 'DeployerX could not connect to PostgreSQL. Check the host, port, firewall, and service.', { category: 'connectivity', retryable: true });
    if (error.code === 'NATIVE_EXECUTABLE_NOT_FOUND') return new DatabaseAdapterError('POSTGRESQL_NATIVE_TOOL_NOT_FOUND', 'Install compatible PostgreSQL client tools and make psql and pg_dump available on PATH.', { category: 'compatibility' });
    if (error.code === 'NATIVE_PROCESS_CANCELED') return new DatabaseAdapterError('POSTGRESQL_OPERATION_CANCELED', `The PostgreSQL ${operation} was canceled.`, { category: 'canceled' });
    if (error.code === 'NATIVE_PROCESS_TIMEOUT') return new DatabaseAdapterError('POSTGRESQL_OPERATION_TIMEOUT', `The PostgreSQL ${operation} exceeded its timeout.`, { category: 'timeout', retryable: true });
  }
  return new DatabaseAdapterError('POSTGRESQL_OPERATION_FAILED', `The PostgreSQL ${operation} failed.`, { category: 'execution' });
}

function connectionFailure(error, testedAt, latencyMs, config = null) {
  const safe = safeAdapterError(error, 'connection test');
  const metadata = config ? profileMetadata(config) : null;
  return {
    adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs, status: 'failure', checks: [],
    ...(metadata ? { endpointIdentity: metadata, remotePlatform: { engine: 'postgresql', distribution: config.deploymentProfile === 'supabase' ? 'Supabase Postgres' : 'PostgreSQL', ...metadata } } : {}),
    error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null }
  };
}

function selectedDatabases(selector, maintenanceDatabase, deploymentProfile = 'postgresql') {
  if (selector?.allDatabases) throw new DatabaseAdapterError('POSTGRESQL_ALL_DATABASES_DEFERRED', 'Select PostgreSQL databases explicitly. All-database selection is not available in this release.', { category: 'compatibility' });
  const names = selector?.databases?.include?.map((item) => normalizeDatabaseName(item.name)) || [];
  if (!names.length) throw new DatabaseAdapterError('POSTGRESQL_DATABASE_SELECTION_EMPTY', 'Select at least one PostgreSQL database.', { category: 'validation' });
  if (deploymentProfile === 'supabase') {
    if (names.length !== 1) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_DATABASE_SCOPE_INVALID', 'A Supabase Source must protect exactly one configured project database.', { category: 'validation' });
    if (names[0] !== maintenanceDatabase) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_DATABASE_SCOPE_INVALID', 'The Supabase Source database must match the database configured on its endpoint.', { category: 'validation' });
  } else if (names.includes(maintenanceDatabase)) {
    throw new DatabaseAdapterError('POSTGRESQL_MAINTENANCE_DATABASE_SELECTED', 'The PostgreSQL maintenance database cannot also be a protected database. Configure a different maintenance database first.', { category: 'conflict' });
  }
  return names;
}

function normalizeObjectName(value, label = 'PostgreSQL object') {
  return normalizeDatabaseName(value, label);
}

function postgresTextLiteral(value) {
  return `convert_from(decode('${Buffer.from(String(value), 'utf8').toString('hex')}','hex'),'UTF8')`;
}

function pgDumpIdentifierPattern(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function selectionScope(selector, maintenanceDatabase, deploymentProfile = 'postgresql') {
  const databases = selectedDatabases(selector, maintenanceDatabase, deploymentProfile);
  if ((selector.schemas?.exclude || []).length || (selector.tables?.exclude || []).length) throw new DatabaseAdapterError('POSTGRESQL_OBJECT_EXCLUDES_UNSUPPORTED', 'Select the PostgreSQL schemas or tables to include; object exclusion rules are not supported.', { category: 'compatibility' });
  const schemas = (selector.schemas?.include || []).map((item) => ({ database: normalizeDatabaseName(item.database), name: normalizeObjectName(item.name, 'PostgreSQL schema') }));
  const tables = (selector.tables?.include || []).map((item) => ({ database: normalizeDatabaseName(item.database), schema: normalizeObjectName(item.schema, 'PostgreSQL table schema'), name: normalizeObjectName(item.name, 'PostgreSQL table') }));
  if (deploymentProfile === 'supabase' && (schemas.some((item) => SUPABASE_MANAGED_SCHEMA_SET.has(item.name)) || tables.some((item) => SUPABASE_MANAGED_SCHEMA_SET.has(item.schema)))) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_MANAGED_SCHEMA_UNSUPPORTED', 'Supabase platform-managed schemas are outside this logical database backup profile.', { category: 'compatibility' });
  if (schemas.length && tables.length) throw new DatabaseAdapterError('POSTGRESQL_OBJECT_SELECTION_MIXED', 'Choose PostgreSQL schemas or tables for one Source, not both.', { category: 'validation' });
  const mode = schemas.length ? 'schemas' : tables.length ? 'tables' : 'databases';
  if (mode !== 'databases' && databases.length !== 1) throw new DatabaseAdapterError('POSTGRESQL_PARTIAL_DATABASE_SCOPE_INVALID', 'PostgreSQL schema or table selection requires exactly one selected database.', { category: 'validation' });
  if (mode !== 'databases' && [...schemas, ...tables].some((item) => item.database !== databases[0])) throw new DatabaseAdapterError('POSTGRESQL_OBJECT_SCOPE_INVALID', 'Every selected PostgreSQL object must belong to the selected database.', { category: 'validation' });
  return { mode, databases, database: mode === 'databases' ? null : databases[0], schemas, tables, ...(deploymentProfile === 'supabase' ? { deploymentProfile } : {}) };
}

function dumpArguments(scope = { mode: 'databases', schemas: [], tables: [] }, options = {}) {
  const deploymentProfile = normalizeDeploymentProfile(typeof options === 'string' ? options : options.deploymentProfile || scope.deploymentProfile);
  const args = ['--format=plain'];
  if (scope.mode === 'databases' && deploymentProfile !== 'supabase') args.push('--create');
  args.push('--clean', '--if-exists', '--no-owner', '--no-privileges', '--encoding=UTF8', '--no-password');
  if (scope.mode === 'databases' && deploymentProfile === 'supabase') args.push(...SUPABASE_MANAGED_SCHEMAS.map((schema) => `--exclude-schema=${pgDumpIdentifierPattern(schema)}`));
  if (scope.mode === 'schemas') args.push(...scope.schemas.map((item) => `--schema=${pgDumpIdentifierPattern(item.name)}`));
  if (scope.mode === 'tables') args.push(...scope.tables.map((item) => `--table=${pgDumpIdentifierPattern(item.schema)}.${pgDumpIdentifierPattern(item.name)}`));
  return args;
}

function privilegeResult(value) {
  const [connect, missingSchemas, missingTables, missingSequences] = String(value || '').trim().split('\t');
  const counts = [missingSchemas, missingTables, missingSequences].map(Number);
  return { allowed: connect === 't' && counts.every((count) => Number.isInteger(count) && count === 0), connect: connect === 't', missingSchemas: counts[0], missingTables: counts[1], missingSequences: counts[2] };
}

function privilegeQuery(scope, deploymentProfile = 'postgresql') {
  const userSchemas = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";
  const managedSchemaPredicate = deploymentProfile === 'supabase' ? ` AND n.nspname NOT IN (${SUPABASE_MANAGED_SCHEMAS.map(postgresTextLiteral).join(',')})` : '';
  let schemaPredicate = `${userSchemas}${managedSchemaPredicate}`;
  let tablePredicate = `${userSchemas}${managedSchemaPredicate}`;
  let sequencePredicate = `${userSchemas}${managedSchemaPredicate}`;
  if (scope.mode === 'schemas') {
    const schemas = scope.schemas.map((item) => postgresTextLiteral(item.name));
    schemaPredicate = `n.nspname IN (${schemas.join(',')})`;
    tablePredicate = schemaPredicate;
    sequencePredicate = schemaPredicate;
  } else if (scope.mode === 'tables') {
    const schemaNames = [...new Set(scope.tables.map((item) => item.schema))].map(postgresTextLiteral);
    schemaPredicate = `n.nspname IN (${schemaNames.join(',')})`;
    tablePredicate = `(${scope.tables.map((item) => `(n.nspname=${postgresTextLiteral(item.schema)} AND c.relname=${postgresTextLiteral(item.name)})`).join(' OR ')})`;
    sequencePredicate = 'FALSE';
  }
  return `SELECT has_database_privilege(current_user,current_database(),'CONNECT'),
  (SELECT COUNT(*) FROM pg_namespace n WHERE ${schemaPredicate} AND NOT has_schema_privilege(current_user,n.oid,'USAGE')),
  (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','m') AND ${tablePredicate} AND NOT has_table_privilege(current_user,c.oid,'SELECT')),
  (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND ${sequencePredicate} AND NOT has_sequence_privilege(current_user,c.oid,'SELECT'));`;
}

function assertSupabaseRestoreIdentity(config, metadata, mode) {
  const sourceSupabase = metadata?.deploymentProfile === 'supabase';
  const targetSupabase = config.deploymentProfile === 'supabase';
  if (!sourceSupabase && !targetSupabase) return false;
  if (!sourceSupabase || !targetSupabase) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_RESTORE_PROFILE_MISMATCH', 'Supabase recovery points must be restored to a Supabase deployment profile.', { category: 'compatibility' });
  if (mode === 'new-database') throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_NEW_DATABASE_RESTORE_UNSUPPORTED', 'Supabase logical recovery restores into an existing project database; new-database restore is not supported.', { category: 'compatibility' });
  let sourceProjectRef;
  try { sourceProjectRef = normalizeSupabaseProjectRef(metadata.projectRef); }
  catch (_error) { throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_RECOVERY_IDENTITY_INVALID', 'The Supabase recovery point does not contain a valid project identity.', { category: 'integrity' }); }
  if (mode === 'original' && config.projectRef !== sourceProjectRef) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_RESTORE_PROJECT_MISMATCH', 'Original-target restore requires the same Supabase project reference as the recovery point.', { category: 'integrity' });
  if (mode === 'alternate' && config.projectRef === sourceProjectRef) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_ALTERNATE_TARGET_IS_ORIGINAL', 'Alternate-target restore requires a different Supabase project reference.', { category: 'conflict' });
  const selectedDatabases = Array.isArray(metadata.selectedDatabases) ? metadata.selectedDatabases.map((name) => normalizeDatabaseName(name, 'Supabase recovery database')) : [];
  if (selectedDatabases.length !== 1 || selectedDatabases[0] !== config.maintenanceDatabase) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_RESTORE_DATABASE_MISMATCH', 'The Supabase recovery database must match the existing target endpoint database.', { category: 'compatibility' });
  return true;
}

class PostgresqlLogicalAdapter {
  constructor({ processRunner = new NativeProcessRunner(), fileSystem = fs, temporaryRoot = os.tmpdir(), clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!processRunner || typeof processRunner.run !== 'function' || typeof processRunner.stream !== 'function' || typeof processRunner.consume !== 'function') throw new TypeError('PostgreSQL process runner is required.');
    this.processRunner = processRunner;
    this.fileSystem = fileSystem;
    this.temporaryRoot = temporaryRoot;
    this.clock = clock;
    this.now = now;
  }

  manifest(input = {}) {
    const deploymentProfile = normalizeDeploymentProfile(typeof input === 'string' ? input : input.deploymentProfile);
    const supabase = deploymentProfile === 'supabase';
    return {
      apiVersion: 1, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, displayName: 'PostgreSQL logical backup', engine: 'postgresql', serverVersionRange: '>=14.0.0 <19.0.0', restoreVersionRange: '>=14.0.0 <19.0.0',
      deploymentProfile,
      capabilities: {
        backupMethods: supabase ? ['logical'] : ['logical', 'physical'], backupModes: supabase ? ['full'] : ['full', 'incremental'], selection: { database: true, schema: true, table: true, globalObjects: false },
        consistencyStrategies: supabase
          ? [{ id: 'transaction-snapshot', produces: 'application', backupMethods: ['logical'], lockScope: 'table', requiresDowntime: false, capturesCoordinates: false }]
          : [
              { id: 'transaction-snapshot', produces: 'application', backupMethods: ['logical'], lockScope: 'table', requiresDowntime: false, capturesCoordinates: false },
              { id: 'pg-basebackup', produces: 'application', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: true }
            ],
        transactionLogs: supabase
          ? { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null }
          : { supported: true, type: 'wal', pointInTimeRecovery: true, granularitySeconds: 1 },
        streaming: { backup: true, restore: true, compression: false, encryption: false }, restore: { alternateTarget: true, ...(supabase ? { originalTarget: true } : {}), nativeValidation: true }, replicaAware: false
      },
      requiredTools: supabase ? [
        { name: 'psql', versionRange: '>=14.0.0 <19.0.0', operations: ['backup', 'restore', 'validation'] },
        { name: 'pg_dump', versionRange: '>=14.0.0 <19.0.0', operations: ['backup'] }
      ] : [
        { name: 'psql', versionRange: '>=14.0.0 <19.0.0', operations: ['backup', 'restore', 'validation'] },
        { name: 'pg_dump', versionRange: '>=14.0.0 <19.0.0', operations: ['backup'] },
        { name: 'pg_basebackup', versionRange: '>=14.0.0 <19.0.0', operations: ['physical-backup'] },
        { name: 'pg_verifybackup', versionRange: '>=14.0.0 <19.0.0', operations: ['physical-backup', 'physical-restore'] },
        { name: 'pg_waldump', versionRange: '>=14.0.0 <19.0.0', operations: ['wal-validation'] }
      ],
      requiredPrivileges: supabase ? [
        { id: 'postgresql-logical-read', operations: ['backup'], required: true, safeDescription: 'CONNECT, schema USAGE, and SELECT access are required for every selected non-managed database object.' },
        { id: 'postgresql-deployment-identity', operations: ['backup'], required: true, safeDescription: 'The project reference must be bound to the authenticated Supabase endpoint.' },
        { id: 'postgresql-logical-restore', operations: ['restore'], required: true, safeDescription: 'Object creation and ownership privileges are required in the existing Supabase project database.' }
      ] : [
        { id: 'postgresql-logical-read', operations: ['backup'], required: true, safeDescription: 'CONNECT, schema USAGE, and SELECT access to selected database objects are required.' },
        { id: 'postgresql-deployment-identity', operations: ['backup'], required: true, safeDescription: 'EXECUTE access to pg_control_system is required to pin cluster identity.' },
        { id: 'postgresql-logical-restore', operations: ['restore'], required: true, safeDescription: 'CREATEDB and object-owner privileges are required on alternate restore targets.' }
      ]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'POSTGRESQL_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async #credentialSession(context, input) {
    const config = normalizeConfig(input);
    if (typeof context?.resolveSecret !== 'function') throw new DatabaseAdapterError('POSTGRESQL_SECRET_RESOLVER_MISSING', 'PostgreSQL credentials are unavailable.', { category: 'authentication' });
    const password = await context.resolveSecret(config.passwordSecretRefId);
    const directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, 'deployerx-postgresql-'));
    const filePath = path.join(directory, 'pgpass.conf');
    try {
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      await this.fileSystem.writeFile(filePath, pgpassContents(config, password), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.fileSystem.chmod(filePath, 0o600).catch(() => {});
      return {
        config, filePath,
        environment: (database) => ({ PGPASSFILE: filePath, PGSSLMODE: sslMode(config.tlsMode), PGDATABASE: normalizeDatabaseName(database || config.maintenanceDatabase) }),
        cleanup: () => this.fileSystem.rm(directory, { recursive: true, force: true })
      };
    } catch (error) {
      await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  #connectionArguments(config) {
    return [`--host=${config.host}`, `--port=${config.port}`, `--username=${config.username}`, '--no-password'];
  }

  async #runClient(context, input, query, options = {}) {
    const session = await this.#credentialSession(context, input);
    try {
      return await this.processRunner.run({
        executable: session.config.psqlExecutable,
        args: [...this.#connectionArguments(session.config), '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator=\t', '--set=ON_ERROR_STOP=1', `--command=${query}`],
        env: session.environment(options.database), timeoutMs: options.timeoutMs || session.config.timeoutMs,
        stdoutLimitBytes: options.stdoutLimitBytes || 4 * 1024 * 1024, signal: context.signal
      });
    } catch (error) { throw safeAdapterError(error, options.operation || 'query'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async #toolVersion(executable, name, signal) {
    try {
      const result = await this.processRunner.run({ executable, args: ['--version'], timeoutMs: 10000, stdoutLimitBytes: 4096, signal });
      return { name, ...postgresToolVersion(result.stdout) };
    } catch (error) {
      const safe = safeAdapterError(error, 'tool check');
      return { name, text: null, major: null, minor: null, patch: null, supported: false, errorCode: safe.code };
    }
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    let config = null;
    try {
      config = normalizeConfig(input);
      const supabase = config.deploymentProfile === 'supabase';
      const query = supabase
        ? "SELECT current_setting('server_version'), current_setting('server_version_num');"
        : "SELECT current_setting('server_version'), current_setting('server_version_num'), c.system_identifier::text FROM pg_control_system() c;";
      const result = await this.#runClient(context, config, query, { operation: 'connection test' });
      const [versionText, versionNumber, systemIdentifier] = result.stdout.trim().split('\t');
      const version = serverVersion(versionText);
      if (!version.supported || !/^\d{6}$/.test(versionNumber || '') || (!supabase && !systemIdentifier)) throw new DatabaseAdapterError('POSTGRESQL_SERVER_VERSION_UNSUPPORTED', 'DeployerX requires PostgreSQL 14 through 18 for logical backup.', { category: 'compatibility' });
      const identity = supabase ? `supabase:${config.projectRef}` : `${config.host}:${config.port}:${systemIdentifier}`;
      const metadata = profileMetadata(config);
      const transactionPooler = supabase && config.connectionMode === 'transaction-pooler';
      return {
        adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'success',
        checks: [
          { id: 'authentication', status: 'pass', safeMessage: 'PostgreSQL authentication succeeded.' },
          { id: 'server-version', status: 'pass', safeMessage: `PostgreSQL ${version.text} is supported.` },
          { id: 'server-identity', status: 'pass', safeMessage: supabase ? 'The endpoint-bound Supabase project identity was captured.' : 'PostgreSQL cluster identity was captured.' },
          { id: 'tls', status: config.tlsMode === 'disabled' ? 'warning' : 'pass', safeMessage: config.tlsMode === 'disabled' ? 'PostgreSQL traffic is not required to use TLS.' : 'The configured PostgreSQL TLS policy was accepted.' },
          ...(supabase ? [{ id: 'backup-restore-eligibility', status: transactionPooler ? 'warning' : 'pass', safeMessage: transactionPooler ? 'This transaction-pooler endpoint is diagnostic-only; use a direct or session-pooler endpoint for backup and restore.' : 'This Supabase endpoint mode supports logical backup and restore.' }] : [])
        ],
        remotePlatform: { engine: 'postgresql', version: version.text, distribution: supabase ? 'Supabase Postgres' : 'PostgreSQL', ...metadata },
        endpointIdentity: { serverFingerprint: `sha256:${crypto.createHash('sha256').update(identity).digest('hex')}`, ...(supabase ? metadata : { systemIdentifier: String(systemIdentifier), ...metadata }) }, error: null
      };
    } catch (error) { return connectionFailure(error, testedAt, Math.max(0, this.now() - started), config); }
  }

  async *discover(context = {}, request = {}) {
    try {
      const config = normalizeConfig(request.connection);
      const supabase = config.deploymentProfile === 'supabase';
      if (request.kind === 'schema' || request.kind === 'table') {
        const database = normalizeDatabaseName(request.database, 'PostgreSQL discovery database');
        const maintenanceDatabase = config.maintenanceDatabase;
        if (SYSTEM_DATABASES.has(database) || (!supabase && database === maintenanceDatabase)) throw new DatabaseAdapterError('POSTGRESQL_PROTECTED_DATABASE_INVALID', 'The PostgreSQL maintenance and template databases cannot be used for object selection.', { category: 'validation' });
        if (supabase && database !== maintenanceDatabase) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_DATABASE_SCOPE_INVALID', 'Supabase object discovery is limited to the configured project database.', { category: 'validation' });
        const schemaDiscovery = request.kind === 'schema';
        const query = schemaDiscovery
          ? "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname;"
          : "SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' ORDER BY n.nspname,c.relname;";
        const result = await this.#runClient(context, request.connection, query, { operation: `${request.kind} discovery`, database, stdoutLimitBytes: 8 * 1024 * 1024 });
        const items = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          const fields = line.split('\t');
          if (schemaDiscovery) {
            const name = normalizeObjectName(fields[0], 'Discovered PostgreSQL schema');
            return { id: `postgresql-schema:${crypto.createHash('sha256').update(`${database}\0${name}`).digest('hex').slice(0, 24)}`, kind: 'schema', database, name, objectType: 'schema', selectable: true };
          }
          const schema = normalizeObjectName(fields[0], 'Discovered PostgreSQL table schema');
          const name = normalizeObjectName(fields[1], 'Discovered PostgreSQL table');
          const objectType = fields[2] === 'v' ? 'view' : fields[2] === 'm' ? 'materialized-view' : 'table';
          return { id: `postgresql-table:${crypto.createHash('sha256').update(`${database}\0${schema}\0${name}`).digest('hex').slice(0, 24)}`, kind: 'table', database, schema, name, objectType, selectable: true };
        }).filter((item) => !supabase || !SUPABASE_MANAGED_SCHEMA_SET.has(item.schema || item.name)).sort((left, right) => `${left.schema || ''}\0${left.name}`.localeCompare(`${right.schema || ''}\0${right.name}`, 'en-US'));
        if (items.length > MAX_DISCOVERED_OBJECTS) throw new DatabaseAdapterError('POSTGRESQL_DISCOVERY_LIMIT_EXCEEDED', 'The PostgreSQL database contains too many objects to list safely.', { category: 'capacity' });
        yield { items, nextCursor: null };
        return;
      }
      if (request.kind && request.kind !== 'database') throw new DatabaseAdapterError('POSTGRESQL_DISCOVERY_KIND_UNSUPPORTED', 'This PostgreSQL object type cannot be discovered.', { category: 'compatibility' });
      const result = await this.#runClient(context, request.connection, "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname;", { operation: 'database discovery', stdoutLimitBytes: 2 * 1024 * 1024 });
      const includeSystem = request.includeSystem === true;
      const maintenanceDatabase = config.maintenanceDatabase;
      const names = [...new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
        .filter((name) => includeSystem || (!SYSTEM_DATABASES.has(name) && (supabase ? name === maintenanceDatabase : name !== maintenanceDatabase)))
        .sort((left, right) => left.localeCompare(right, 'en-US'));
      if (names.length > MAX_DISCOVERED_DATABASES) throw new DatabaseAdapterError('POSTGRESQL_DISCOVERY_LIMIT_EXCEEDED', 'The PostgreSQL cluster contains too many databases to list safely.', { category: 'capacity' });
      yield { items: names.map((name) => ({ id: `postgresql-db:${crypto.createHash('sha256').update(name).digest('hex').slice(0, 24)}`, kind: 'database', name, selectable: !SYSTEM_DATABASES.has(name) && (supabase ? name === maintenanceDatabase : name !== maintenanceDatabase) })), nextCursor: null };
    } catch (error) { throw safeAdapterError(error, 'database discovery'); }
  }

  async preflight(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    assertBackupRestoreEligible(config, 'backup');
    const supabase = config.deploymentProfile === 'supabase';
    if (supabase && (String(request.consistency?.backupMethod || 'logical') !== 'logical' || String(request.consistency?.backupMode || 'full') !== 'full')) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_BACKUP_MODE_UNSUPPORTED', 'The Supabase deployment profile supports full logical backups only.', { category: 'compatibility' });
    const scope = selectionScope(request.selector, config.maintenanceDatabase, config.deploymentProfile);
    const databases = scope.databases;
    const serverQuery = supabase
      ? "SELECT current_setting('server_version'), current_setting('server_version_num'), current_setting('server_encoding'), current_setting('lc_collate'), current_setting('lc_ctype');"
      : "SELECT current_setting('server_version'), current_setting('server_version_num'), c.system_identifier::text, current_setting('server_encoding'), current_setting('lc_collate'), current_setting('lc_ctype') FROM pg_control_system() c;";
    const [serverResult, psqlTool, dumpTool] = await Promise.all([
      this.#runClient(context, config, serverQuery, { operation: 'preflight server check' }),
      this.#toolVersion(config.psqlExecutable, 'psql', context.signal),
      this.#toolVersion(config.pgDumpExecutable, 'pg_dump', context.signal)
    ]);
    const serverFields = serverResult.stdout.trim().split('\t');
    const [versionText, versionNumber] = serverFields;
    const [systemIdentifier, encoding, collation, ctype] = supabase ? [null, serverFields[2], serverFields[3], serverFields[4]] : serverFields.slice(2, 6);
    const version = serverVersion(versionText);
    const privilegeChecks = [];
    const validationInventories = [];
    for (const database of databases) {
      const result = await this.#runClient(context, config, privilegeQuery(scope, config.deploymentProfile), { operation: 'preflight privilege check', database });
      privilegeChecks.push({ database, ...privilegeResult(result.stdout) });
      const inventoryResult = await this.#runClient(context, config, inventoryQuery(scope), { operation: 'preflight validation inventory', database, stdoutLimitBytes: 8 * 1024 * 1024 });
      try {
        const inventory = normalizeInventory(database, inventoryResult.stdout, normalizeDatabaseName);
        validationInventories.push(supabase ? {
          schemas: inventory.schemas.filter((item) => !SUPABASE_MANAGED_SCHEMA_SET.has(item.name)),
          objects: inventory.objects.filter((item) => !SUPABASE_MANAGED_SCHEMA_SET.has(item.schema))
        } : inventory);
      }
      catch (error) { throw new DatabaseAdapterError(error.code || 'POSTGRESQL_VALIDATION_INVENTORY_INVALID', error.message, { category: error.category || 'integrity' }); }
    }
    const expectedSchemas = validationInventories.flatMap((item) => item.schemas);
    const expectedObjects = validationInventories.flatMap((item) => item.objects).map(({ nativeValid: _nativeValid, ...item }) => item);
    if (expectedSchemas.length > 1000 || expectedObjects.length > MAX_DISCOVERED_OBJECTS) throw new DatabaseAdapterError('POSTGRESQL_VALIDATION_INVENTORY_LIMIT_EXCEEDED', 'The PostgreSQL selection contains too many objects for bounded restore validation.', { category: 'capacity' });
    const privilegesAllowed = privilegeChecks.every((item) => item.allowed);
    const identityAllowed = supabase || Boolean(systemIdentifier);
    const identityMaterial = supabase ? `supabase:${config.projectRef}` : `${config.host}:${config.port}:${systemIdentifier || 'unknown'}`;
    const identity = `sha256:${crypto.createHash('sha256').update(identityMaterial).digest('hex')}`;
    const tools = [psqlTool, dumpTool].map((tool) => ({ ...tool, supported: tool.supported && version.supported && tool.major >= version.major }));
    const warnings = [];
    if (config.tlsMode === 'disabled') warnings.push('PostgreSQL transport encryption is disabled by configuration.');
    if (databases.length > 1) warnings.push('Each PostgreSQL database receives its own transaction snapshot; cross-database transactions are not coordinated.');
    if (scope.mode === 'tables') warnings.push('PostgreSQL table-only dumps do not automatically include dependent objects outside the selected tables.');
    if (supabase) warnings.push('This profile protects accessible PostgreSQL data and schema only. Supabase platform-managed schemas, Storage objects, project settings, Edge Functions, secrets, authentication provider configuration, and provider-managed snapshots are excluded.');
    const privileges = [
      { id: 'postgresql-logical-read', allowed: privilegesAllowed, evidence: privilegesAllowed ? 'CONNECT, schema USAGE, table SELECT, and sequence SELECT checks passed for every selected database.' : 'One or more selected PostgreSQL databases contain inaccessible objects.' },
      { id: 'postgresql-deployment-identity', allowed: identityAllowed, evidence: supabase ? 'The project reference is bound to the authenticated Supabase endpoint syntax.' : identityAllowed ? 'PostgreSQL system identifier was captured.' : 'PostgreSQL system identifier is unavailable.' }
    ];
    const metadata = {
      engine: 'postgresql', serverVersion: version.text, serverVersionNumber: versionNumber,
      ...(supabase ? profileMetadata(config) : { deploymentProfile: 'postgresql', systemIdentifier: String(systemIdentifier || '').slice(0, 100) }),
      encoding: String(encoding || '').slice(0, 100), collation: String(collation || '').slice(0, 200), ctype: String(ctype || '').slice(0, 200), serverIdentityFingerprint: identity,
      selectionMode: scope.mode, selectedDatabases: databases, selectedSchemas: scope.schemas, selectedTables: scope.tables, snapshotScope: 'per-database', validationInventoryVersion: 1, expectedDatabases: databases, expectedSchemas, expectedObjects,
      ...(supabase ? { excludedManagedSchemas: [...SUPABASE_MANAGED_SCHEMAS], platformSnapshotsIncluded: false } : {})
    };
    return {
      checkedAt: this.clock(), serverVersion: version.text, serverVersionSupported: version.supported && /^\d{6}$/.test(versionNumber || ''), serverIdentityFingerprint: identity,
      consistency: [{ method: 'transaction-snapshot', verified: privilegesAllowed && identityAllowed, produces: 'application', reasonCode: privilegesAllowed ? null : 'POSTGRESQL_READ_PRIVILEGES_MISSING' }],
      tools: tools.map((tool) => ({ name: tool.name, version: tool.text, compatible: tool.supported, executableFingerprint: tool.text ? `sha256:${crypto.createHash('sha256').update(`${tool.name}:${tool.text}`).digest('hex')}` : null })),
      privileges,
      coordinateCaptureVerified: false, warnings,
      metadata
    };
  }

  async planBackup(_context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    assertBackupRestoreEligible(config, 'backup');
    if (request.consistency?.proven !== true || request.consistency?.method !== 'transaction-snapshot' || request.consistency?.achievedLevel !== 'application') throw new DatabaseAdapterError('POSTGRESQL_CONSISTENCY_PLAN_INVALID', 'PostgreSQL logical backup requires a proven transaction snapshot.', { category: 'consistency' });
    const scope = selectionScope(request.selector, config.maintenanceDatabase, config.deploymentProfile);
    return { version: config.deploymentProfile === 'supabase' ? 2 : 1, operation: 'postgresql-logical-backup', connection: config, selector: request.selector, databases: scope.databases, dumpArguments: dumpArguments(scope, config), restoreDatabase: config.deploymentProfile === 'supabase' ? scope.databases[0] : scope.mode === 'databases' ? null : scope.database, consistency: request.consistency, databaseMetadata: request.consistency.evidence?.metadata || {}, artifact: { kind: 'database-dump', path: 'postgresql/logical-dump.sql', mediaType: 'application/sql' }, resumable: false };
  }

  async openBackup(context = {}, plan = {}) {
    if (plan.operation !== 'postgresql-logical-backup' || plan.consistency?.proven !== true || !Array.isArray(plan.databases) || !plan.databases.length) throw new DatabaseAdapterError('POSTGRESQL_BACKUP_PLAN_INVALID', 'The PostgreSQL backup plan is invalid.', { category: 'integrity' });
    const config = normalizeConfig(plan.connection);
    assertBackupRestoreEligible(config, 'backup');
    const session = await this.#credentialSession(context, config);
    const runner = this.processRunner;
    const connectionArguments = this.#connectionArguments(session.config);
    const content = (async function* streamDumps() {
      try {
        yield Buffer.from('-- DeployerX PostgreSQL logical backup\n', 'utf8');
        for (const database of plan.databases) {
          const started = runner.stream({ executable: session.config.pgDumpExecutable, args: [...connectionArguments, ...plan.dumpArguments], env: session.environment(database), timeoutMs: Math.max(session.config.timeoutMs, 24 * 60 * 60 * 1000), signal: context.signal });
          let completed = false;
          try {
            for await (const chunk of started.stdout) {
              await context.onProgress?.({ phase: 'reading', bytesRead: Buffer.byteLength(chunk), path: plan.artifact.path, database });
              yield Buffer.from(chunk);
            }
            await started.completion;
            completed = true;
            yield Buffer.from('\n', 'utf8');
          } catch (error) { throw safeAdapterError(error, 'logical backup'); }
          finally {
            if (!completed) started.cancel();
            await started.completion.catch(() => {});
          }
        }
      } finally { await session.cleanup().catch(() => {}); }
    })();
    return { content, artifact: plan.artifact, metadata: { ...plan.databaseMetadata, selectorDigest: plan.selector.digest, consistency: plan.consistency } };
  }

  async executeBackup(context = {}, plan = {}, sink) {
    if (!sink || typeof sink.write !== 'function') throw new TypeError('PostgreSQL backup artifact sink is required.');
    const opened = await this.openBackup(context, plan);
    const stored = await sink.write({ ...opened.artifact, content: opened.content, metadata: opened.metadata });
    return { status: 'succeeded', artifacts: [stored || opened.artifact], consistency: plan.consistency, metadata: opened.metadata };
  }

  async prepareRestoreTarget(context = {}, request = {}) {
    const mode = String(request.mode || 'original');
    if (!['original', 'alternate', 'new-database'].includes(mode)) throw new DatabaseAdapterError('POSTGRESQL_RESTORE_MODE_INVALID', 'The PostgreSQL restore target mode is not supported.', { category: 'validation' });
    const connection = normalizeConfig(request.connection);
    assertBackupRestoreEligible(connection, 'restore');
    const originalMetadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    const supabase = assertSupabaseRestoreIdentity(connection, originalMetadata, mode);
    const mapping = mode === 'new-database' ? remapPostgresqlMetadata(originalMetadata, request.targetDatabase) : null;
    const metadata = mapping?.metadata || originalMetadata;
    if (!supabase && (metadata.selectedDatabases || []).includes(connection.maintenanceDatabase)) throw new DatabaseAdapterError('POSTGRESQL_RESTORE_MAINTENANCE_CONFLICT', 'Configure an unprotected PostgreSQL maintenance database before restoring.', { category: 'conflict' });
    if (mode === 'original') return { metadata, sourceDatabase: null, targetDatabase: null, databaseCreated: false, collisions: [] };
    const [result, roleResult] = await Promise.all([
      this.#runClient(context, connection, "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname;", { operation: 'restore target discovery', stdoutLimitBytes: 2 * 1024 * 1024 }),
      supabase ? Promise.resolve(null) : this.#runClient(context, connection, "SELECT rolcreatedb OR rolsuper, rolsuper FROM pg_roles WHERE rolname=current_user;", { operation: 'restore target privilege check' })
    ]);
    if (!supabase) {
      const [canCreateDatabase] = roleResult.stdout.trim().split('\t');
      if (canCreateDatabase !== 't') throw new DatabaseAdapterError('POSTGRESQL_RESTORE_PRIVILEGES_MISSING', 'The selected PostgreSQL target account lacks CREATEDB or superuser capability required for alternate recovery.', { category: 'authorization' });
    }
    const existing = new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
    const databaseNames = Array.isArray(metadata.expectedDatabases) && metadata.expectedDatabases.length ? metadata.expectedDatabases : metadata.selectedDatabases || [];
    const expectedDatabases = [...new Set(databaseNames.map((name) => normalizeDatabaseName(name, 'PostgreSQL restore database')))];
    if (!expectedDatabases.length) throw new DatabaseAdapterError('POSTGRESQL_RESTORE_TARGET_INVENTORY_UNAVAILABLE', 'This recovery point does not contain the database inventory required for a safe alternate target restore.', { category: 'compatibility' });
    if (supabase && !existing.has(expectedDatabases[0])) throw new DatabaseAdapterError('POSTGRESQL_SUPABASE_RESTORE_DATABASE_MISSING', 'The existing Supabase target database was not found.', { category: 'compatibility' });
    const collisions = expectedDatabases.filter((name) => existing.has(name));
    if (mode === 'new-database' && collisions.length) throw new DatabaseAdapterError('POSTGRESQL_NEW_DATABASE_EXISTS', 'Choose a new PostgreSQL database name that does not already exist on the target cluster.', { category: 'conflict' });
    if (mode === 'alternate' && collisions.length && request.conflictPolicy !== 'overwrite') throw new DatabaseAdapterError('POSTGRESQL_ALTERNATE_TARGET_CONFLICT', 'The alternate PostgreSQL cluster already contains a protected database. Choose overwrite explicitly or use another target.', { category: 'conflict' });
    const partial = ['schemas', 'tables'].includes(metadata.selectionMode);
    let databaseCreated = false;
    if (!supabase && partial && expectedDatabases.length === 1 && !existing.has(expectedDatabases[0])) {
      await this.#runClient(context, connection, `CREATE DATABASE ${pgDumpIdentifierPattern(expectedDatabases[0])};`, { operation: 'restore target database creation' });
      databaseCreated = true;
    }
    return { metadata, sourceDatabase: mapping?.sourceDatabase || null, targetDatabase: mapping?.targetDatabase || null, databaseCreated, collisions };
  }

  async planRestore(_context = {}, request = {}) {
    const mode = String(request.mode || 'original');
    const confirmations = { original: 'RESTORE_POSTGRESQL_ORIGINAL', alternate: 'RESTORE_POSTGRESQL_ALTERNATE', 'new-database': 'RESTORE_POSTGRESQL_NEW_DATABASE' };
    if (!confirmations[mode]) throw new DatabaseAdapterError('POSTGRESQL_RESTORE_MODE_INVALID', 'The PostgreSQL restore target mode is not supported.', { category: 'validation' });
    const connection = normalizeConfig(request.connection);
    assertBackupRestoreEligible(connection, 'restore');
    const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    const supabase = assertSupabaseRestoreIdentity(connection, metadata, mode);
    if (request.confirmation !== confirmations[mode]) throw new DatabaseAdapterError('POSTGRESQL_RESTORE_CONFIRMATION_REQUIRED', 'Explicit confirmation is required before restoring the PostgreSQL databases.', { category: 'conflict' });
    if (!supabase && mode === 'original' && (!metadata.serverIdentityFingerprint || metadata.serverIdentityFingerprint !== request.serverIdentityFingerprint)) throw new DatabaseAdapterError('POSTGRESQL_RESTORE_SERVER_MISMATCH', 'The restore target does not match the protected PostgreSQL cluster identity.', { category: 'integrity' });
    if (!supabase && mode === 'alternate' && metadata.serverIdentityFingerprint === request.serverIdentityFingerprint) throw new DatabaseAdapterError('POSTGRESQL_ALTERNATE_TARGET_IS_ORIGINAL', 'Choose a PostgreSQL cluster with a different verified cluster identity for alternate-cluster restore.', { category: 'conflict' });
    if (mode !== 'original' && request.targetPrepared !== true) throw new DatabaseAdapterError('POSTGRESQL_RESTORE_TARGET_NOT_PREPARED', 'The PostgreSQL restore target must pass destination preflight before restore.', { category: 'validation' });
    if (!supabase && (metadata.selectedDatabases || []).includes(connection.maintenanceDatabase)) throw new DatabaseAdapterError('POSTGRESQL_RESTORE_MAINTENANCE_CONFLICT', 'Configure an unprotected PostgreSQL maintenance database before restoring.', { category: 'conflict' });
    const restoreDatabase = (supabase || ['schemas', 'tables'].includes(metadata.selectionMode)) && Array.isArray(metadata.selectedDatabases) && metadata.selectedDatabases.length === 1
      ? normalizeDatabaseName(metadata.selectedDatabases[0], 'PostgreSQL restore database')
      : null;
    const mapping = mode === 'new-database' ? metadata.restoreDatabaseMapping : null;
    if (mode === 'new-database' && (!mapping?.sourceDatabase || !mapping?.targetDatabase)) throw new DatabaseAdapterError('POSTGRESQL_RESTORE_MAPPING_INVALID', 'The PostgreSQL new-database mapping is invalid.', { category: 'integrity' });
    return { version: 2, operation: 'postgresql-logical-restore', mode, connection, artifactPath: requiredText(request.artifactPath, 'PostgreSQL dump artifact path', 8192), metadata, restoreDatabase, databaseMapping: mapping || null, destructive: mode !== 'new-database' || Boolean(request.databaseCreated) };
  }

  async executeRestore(context = {}, plan = {}, source) {
    if (plan.operation !== 'postgresql-logical-restore' || !source || typeof source.open !== 'function') throw new DatabaseAdapterError('POSTGRESQL_RESTORE_PLAN_INVALID', 'The PostgreSQL restore plan is invalid.', { category: 'integrity' });
    const config = normalizeConfig(plan.connection);
    assertBackupRestoreEligible(config, 'restore');
    const session = await this.#credentialSession(context, config);
    try {
      const openedContent = await source.open({ kind: 'database-dump', path: plan.artifactPath });
      const content = plan.databaseMapping && !['schemas', 'tables'].includes(plan.metadata.selectionMode)
        ? remapPostgresqlDump(openedContent, plan.databaseMapping.sourceDatabase, plan.databaseMapping.targetDatabase)
        : openedContent;
      await this.processRunner.consume({
        executable: session.config.psqlExecutable,
        args: [...this.#connectionArguments(session.config), '--no-psqlrc', '--set=ON_ERROR_STOP=1'],
        env: session.environment(plan.restoreDatabase || session.config.maintenanceDatabase), stdin: content,
        timeoutMs: Math.max(session.config.timeoutMs, 24 * 60 * 60 * 1000), signal: context.signal, stdoutLimitBytes: 1024 * 1024
      });
      return { status: 'succeeded', restoredArtifactPath: plan.artifactPath, validationRequired: true, metadata: plan.metadata };
    } catch (error) { throw safeAdapterError(error, 'logical restore'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async validateRestore(context = {}, result = {}) {
    if (result.status !== 'succeeded') return { status: 'failed', valid: false, checks: [] };
    try {
      const config = normalizeConfig(context.connection);
      assertBackupRestoreEligible(config, 'restore-validation');
      const metadata = result.metadata || {};
      const expected = expectedInventory(metadata, normalizeDatabaseName);
      if (!expected) {
        const query = await this.#runClient(context, context.connection, 'SELECT 1;', { operation: 'legacy restore connectivity validation' });
        const valid = query.stdout.trim() === '1';
        return { status: valid ? 'warning' : 'failed', valid, checks: [{ id: 'connectivity', status: valid ? 'pass' : 'fail', databasesChecked: valid ? 1 : 0 }, { id: 'expected-objects', status: 'warning', reasonCode: 'POSTGRESQL_VALIDATION_INVENTORY_UNAVAILABLE' }], nativeIntegrityValidation: false, warnings: valid ? [{ code: 'POSTGRESQL_VALIDATION_INVENTORY_UNAVAILABLE', safeMessage: 'This older recovery point has no authenticated expected-object inventory; only connectivity could be validated.' }] : [] };
      }
      const scope = scopeFromMetadata(metadata, normalizeDatabaseName);
      const actual = { schemas: [], objects: [] };
      for (const database of expected.databases) {
        const connectivity = await this.#runClient(context, context.connection, 'SELECT 1;', { operation: 'restore database connectivity validation', database });
        if (connectivity.stdout.trim() !== '1') return { status: 'failed', valid: false, checks: [{ id: 'connectivity', status: 'fail', databasesChecked: 0 }], nativeIntegrityValidation: false };
        const inventoryResult = await this.#runClient(context, context.connection, inventoryQuery(scope), { operation: 'restore native catalog validation', database, stdoutLimitBytes: 8 * 1024 * 1024 });
        const inventory = normalizeInventory(database, inventoryResult.stdout, normalizeDatabaseName);
        actual.schemas.push(...inventory.schemas);
        actual.objects.push(...inventory.objects);
      }
      const comparison = compareInventory(expected, actual);
      const checks = [
        { id: 'connectivity', status: 'pass', databasesChecked: expected.databases.length },
        { id: 'expected-objects', status: comparison.valid ? 'pass' : 'fail', expectedSchemas: expected.schemas.length, expectedObjects: expected.objects.length, missingSchemas: comparison.missingSchemas.slice(0, 20).map((item) => `${item.database}.${item.name}`), missingObjects: comparison.missingObjects.slice(0, 20).map((item) => `${item.database}.${item.schema}.${item.name}`), typeMismatches: comparison.typeMismatches.slice(0, 20).map((item) => `${item.expected.database}.${item.expected.schema}.${item.expected.name}`) },
        { id: 'native-integrity', status: comparison.invalidObjects.length ? 'fail' : 'pass', checkedObjects: expected.objects.length, invalidObjects: comparison.invalidObjects.slice(0, 20).map((item) => `${item.database}.${item.schema}.${item.name}`) }
      ];
      return { status: comparison.valid ? 'succeeded' : 'failed', valid: comparison.valid, checks, nativeIntegrityValidation: true, warnings: [] };
    } catch (error) {
      const safe = error?.code ? error : safeAdapterError(error, 'restore validation');
      return { status: 'failed', valid: false, checks: [{ id: 'native-validation', status: 'fail', errorCode: String(safe.code || 'POSTGRESQL_OPERATION_FAILED').slice(0, 100) }], nativeIntegrityValidation: false };
    }
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class PostgresqlConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new PostgresqlLogicalAdapter() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { limit: 1000 })).filter((record) => record.adapterId === ADAPTER_ID).map((record) => {
      const deploymentProfile = record.endpoint?.deploymentProfile === 'supabase' ? 'supabase' : 'postgresql';
      const manifest = this.adapter.manifest({ deploymentProfile });
      return { ...record, deploymentProfile, capabilities: manifest.capabilities, requiredTools: manifest.requiredTools, requiredPrivileges: manifest.requiredPrivileges, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) };
    });
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'PostgreSQL connection name', 200);
    const password = String(input.password ?? '');
    if (!password || password.includes('\0') || /[\r\n]/.test(password) || password.length > 1024 * 1024) throw new TypeError('PostgreSQL password is invalid.');
    let passwordRef = null;
    try {
      passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} PostgreSQL password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({ host: input.host, port: input.port, username: input.username, maintenanceDatabase: input.maintenanceDatabase || input.database, passwordSecretRefId: passwordRef.id, tlsMode: input.tlsMode, timeoutMs: input.timeoutMs, psqlExecutable: input.psqlExecutable, pgDumpExecutable: input.pgDumpExecutable, deploymentProfile: input.deploymentProfile, connectionMode: input.connectionMode, supabaseEndpointMode: input.supabaseEndpointMode, projectRef: input.projectRef });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device',
          endpoint: { host: config.host, port: config.port, username: config.username, database: config.maintenanceDatabase, maintenanceDatabase: config.maintenanceDatabase, tlsMode: config.tlsMode, timeoutMs: config.timeoutMs, psqlExecutable: config.psqlExecutable, pgDumpExecutable: config.pgDumpExecutable, deploymentProfile: config.deploymentProfile, connectionMode: config.connectionMode, projectRef: config.projectRef },
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
    return normalizeConfig({ ...connection.endpoint, maintenanceDatabase: connection.endpoint?.maintenanceDatabase || connection.endpoint?.database, passwordSecretRefId });
  }

  async test(workspaceId, connectionId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('PostgreSQL source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This PostgreSQL connection belongs to another device.');
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

  async update(workspaceId, actorId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('PostgreSQL source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This PostgreSQL connection belongs to another device.');
    const [passwordSecretRefId] = current.secretRefIds || [];
    const name = requiredText(input.name ?? current.name, 'PostgreSQL connection name', 200);
    const config = normalizeConfig({
      host: input.host ?? current.endpoint?.host,
      port: input.port ?? current.endpoint?.port,
      username: input.username ?? current.endpoint?.username,
      database: input.database ?? current.endpoint?.database,
      maintenanceDatabase: input.maintenanceDatabase ?? input.database ?? current.endpoint?.maintenanceDatabase ?? current.endpoint?.database,
      tlsMode: input.tlsMode ?? current.endpoint?.tlsMode,
      timeoutMs: input.timeoutMs ?? current.endpoint?.timeoutMs,
      psqlExecutable: input.psqlExecutable ?? current.endpoint?.psqlExecutable,
      pgDumpExecutable: input.pgDumpExecutable ?? current.endpoint?.pgDumpExecutable,
      deploymentProfile: input.deploymentProfile ?? current.endpoint?.deploymentProfile,
      connectionMode: input.connectionMode ?? current.endpoint?.connectionMode,
      projectRef: input.projectRef ?? current.endpoint?.projectRef,
      passwordSecretRefId
    });
    const password = input.password === undefined || input.password === null || input.password === '' ? null : String(input.password);
    if (password !== null && (!password || password.includes('\0') || /[\r\n]/.test(password) || password.length > 1024 * 1024)) throw new TypeError('PostgreSQL password is invalid.');
    if (password !== null) {
      const rotated = await this.secretStore.rotate({ workspaceId: tenant, id: passwordSecretRefId, actorId: actor, value: password });
      const secretRepository = this.controlDatabase.repository('secretRef');
      const metadata = await secretRepository.get(tenant, passwordSecretRefId);
      if (!metadata) throw new Error('PostgreSQL password SecretRef metadata was not found.');
      await secretRepository.update(tenant, passwordSecretRefId, {
        version: rotated.version,
        expiresAt: rotated.expiresAt,
        lastValidatedAt: rotated.lastValidatedAt
      }, { expectedRevision: metadata.revision, actorId: actor });
    }
    const updated = await this.controlDatabase.repository('connection').update(tenant, id, {
      name,
      endpoint: {
        host: config.host, port: config.port, username: config.username, database: config.maintenanceDatabase,
        maintenanceDatabase: config.maintenanceDatabase, tlsMode: config.tlsMode, timeoutMs: config.timeoutMs,
        psqlExecutable: config.psqlExecutable, pgDumpExecutable: config.pgDumpExecutable,
        deploymentProfile: config.deploymentProfile, connectionMode: config.connectionMode, projectRef: config.projectRef
      },
      trust: { mode: config.tlsMode, fingerprint: null },
      lastTest: null,
      adapterVersion: ADAPTER_VERSION
    }, { expectedRevision: current.revision, actorId: actor });
    return updated;
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('PostgreSQL source connection was not found.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the PostgreSQL connection successfully before discovering databases.');
    const pages = [];
    for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current), includeSystem: input.includeSystem, kind: input.kind, database: input.database, schema: input.schema })) pages.push(page);
    return pages[0] || { items: [], nextCursor: null };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  DEPLOYMENT_PROFILES,
  MAX_DISCOVERED_DATABASES,
  MAX_DISCOVERED_OBJECTS,
  MAXIMUM_MAJOR,
  MINIMUM_MAJOR,
  PostgresqlConnectionService,
  PostgresqlLogicalAdapter,
  SUPABASE_ENDPOINT_MODES,
  SUPABASE_MANAGED_SCHEMAS,
  SUPABASE_PROJECT_REF_PATTERN,
  SUPABASE_TRANSACTION_POOLER_ERROR_CODE,
  SYSTEM_DATABASES,
  dumpArguments,
  normalizeConfig,
  pgpassContents,
  pgDumpIdentifierPattern,
  profileMetadata,
  postgresToolVersion,
  privilegeResult,
  serverVersion,
  selectionScope,
  sslMode
};
