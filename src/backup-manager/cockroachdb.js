const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');

const ADAPTER_ID = 'deployerx.database.cockroachdb';
const ADAPTER_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 10000;
const MAX_NODES = 1000;
const MAX_DATABASES = 1000;
const MAX_EXTERNAL_CONNECTIONS = 1000;
const MAX_BACKUP_LOCALITIES = 16;
const BACKUP_DESTINATION_CONFIRMATION = 'USE COCKROACHDB BACKUP DESTINATION';
const EXECUTION_MODES = new Set(['local', 'ssh']);
const AUTH_MODES = new Set(['password', 'client-certificate', 'insecure']);
const DISCOVERY_KINDS = new Set(['all', 'nodes', 'databases', 'capabilities']);
const SYSTEM_PRIVILEGES = Object.freeze(['BACKUP', 'RESTORE', 'VIEWJOB', 'CONTROLJOB', 'EXTERNALIOIMPLICITACCESS']);

const QUERIES = Object.freeze({
  identity: "SELECT version()::STRING AS version, crdb_internal.cluster_id()::STRING AS cluster_id, crdb_internal.node_id()::STRING AS node_id, current_user::STRING AS current_user, current_database()::STRING AS current_database",
  clusterVersion: 'SHOW CLUSTER SETTING version',
  nodes: "SELECT id::STRING AS node_id, address::STRING AS address, sql_address::STRING AS sql_address, build::STRING AS build_tag, started_at::STRING AS started_at, locality::STRING AS locality, is_available::STRING AS is_available, is_live::STRING AS is_live FROM [SHOW NODES] ORDER BY id LIMIT 1001",
  databases: "SELECT database_name::STRING AS database_name, owner::STRING AS owner FROM [SHOW DATABASES] ORDER BY database_name LIMIT 1001",
  systemPrivileges: "SELECT has_system_privilege(current_user, 'BACKUP')::STRING AS backup, has_system_privilege(current_user, 'RESTORE')::STRING AS restore, has_system_privilege(current_user, 'VIEWJOB')::STRING AS viewjob, has_system_privilege(current_user, 'CONTROLJOB')::STRING AS controljob, has_system_privilege(current_user, 'EXTERNALIOIMPLICITACCESS')::STRING AS externalioimplicitaccess",
  jobs: 'SELECT count(*)::STRING AS visible_job_count FROM [SHOW JOBS]',
  externalConnections: 'SELECT connection_name::STRING AS connection_name, owner::STRING AS owner FROM [SHOW EXTERNAL CONNECTIONS] ORDER BY connection_name LIMIT 1001'
});

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeBackupLocality(value) {
  const locality = requiredText(value, 'CockroachDB backup locality', 256);
  if (locality === 'default') return locality;
  const component = '[A-Za-z0-9_.-]+';
  if (!new RegExp(`^${component}=${component}(?:,${component}=${component})*$`).test(locality)) throw new TypeError('CockroachDB backup locality is invalid.');
  return locality;
}

function normalizeExternalConnectionName(value) {
  const name = requiredText(value, 'CockroachDB external connection name', 128);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new TypeError('CockroachDB external connection name is invalid.');
  return name;
}

function normalizeBackupDestination(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || String(input.type || '') !== 'external-connection') throw new TypeError('CockroachDB native backup currently supports external connections only.');
  if (input.externalConnectionName && input.localities !== undefined) throw new TypeError('CockroachDB destination cannot mix one external connection with locality bindings.');
  let localities;
  if (input.externalConnectionName) localities = [{ locality: 'default', externalConnectionName: normalizeExternalConnectionName(input.externalConnectionName) }];
  else {
    if (!Array.isArray(input.localities) || input.localities.length < 1 || input.localities.length > MAX_BACKUP_LOCALITIES) throw new TypeError(`CockroachDB destination requires between 1 and ${MAX_BACKUP_LOCALITIES} external connection locality bindings.`);
    localities = input.localities.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('CockroachDB locality binding is invalid.');
      return { locality: normalizeBackupLocality(item.locality), externalConnectionName: normalizeExternalConnectionName(item.externalConnectionName) };
    });
  }
  localities.sort((left, right) => left.locality === 'default' ? -1 : right.locality === 'default' ? 1 : left.locality.localeCompare(right.locality, 'en-US'));
  if (new Set(localities.map((item) => item.locality)).size !== localities.length || new Set(localities.map((item) => item.externalConnectionName)).size !== localities.length) throw new TypeError('CockroachDB backup localities and external connections must be unique.');
  if (localities.length > 1 && localities.filter((item) => item.locality === 'default').length !== 1) throw new TypeError('CockroachDB locality-aware backup requires exactly one default locality.');
  if (localities.length === 1 && localities[0].locality !== 'default') throw new TypeError('A single CockroachDB backup destination must use the default locality.');
  const localityFingerprint = stableDigest(localities);
  const destinationFingerprint = stableDigest({ type: 'external-connection', localities });
  return Object.freeze({ type: 'external-connection', localityAware: localities.length > 1, localities: Object.freeze(localities.map(Object.freeze)), localityFingerprint, destinationFingerprint });
}

function rawBackupDestination(destination) {
  return { type: 'external-connection', localities: destination.localities.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName })) };
}

function publicBackupDestinationTrust(trust) {
  if (!trust) return null;
  const destination = normalizeBackupDestination(trust.destination);
  return Object.freeze({
    version: 1,
    type: 'external-connection',
    localityAware: destination.localityAware,
    bindingCount: destination.localities.length,
    destinationFingerprint: destination.destinationFingerprint,
    localityFingerprint: destination.localityFingerprint,
    checkedAt: trust.checkedAt
  });
}

function publicConnection(record) {
  return record ? { ...record, cockroachdbBackupDestinationTrust: publicBackupDestinationTrust(record.cockroachdbBackupDestinationTrust) } : record;
}

function quoteSqlString(value, label = 'CockroachDB SQL value') {
  return `'${requiredText(value, label, 4096).replace(/'/g, "''")}'`;
}

function normalizeFingerprint(value, label) {
  const fingerprint = optionalText(value, label, 80);
  if (fingerprint && !/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new TypeError(`${label} is invalid.`);
  return fingerprint;
}

function normalizeUuid(value, label) {
  const uuid = requiredText(value, label, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) throw new DatabaseAdapterError('COCKROACH_IDENTITY_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return uuid;
}

function normalizeHost(value) {
  const input = optionalText(value, 'CockroachDB host', 253) || '127.0.0.1';
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('CockroachDB host must be a hostname or IP address without a URI scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('CockroachDB host is invalid.');
  return ascii;
}

function normalizeExecutable(value, executionMode) {
  const executable = optionalText(value, 'cockroach SQL client path', 1024) || 'cockroach';
  if (executable.startsWith('/')) {
    if (!/^\/[A-Za-z0-9._+/-]+$/.test(executable) || executable.includes('..')) throw new TypeError('cockroach SQL client path is invalid.');
    return executable.replace(/\/{2,}/g, '/');
  }
  if (path.isAbsolute(executable)) {
    if (executionMode === 'ssh') throw new TypeError('SSH execution requires a POSIX cockroach SQL client path or executable name.');
    return path.normalize(executable);
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) throw new TypeError('cockroach SQL client path must be an absolute path or executable name.');
  return executable;
}

function normalizeCredentialPath(value, label, executionMode, directory = false) {
  const input = optionalText(value, label, 4096);
  if (!input) return null;
  if (executionMode === 'ssh') {
    if (!input.startsWith('/') || input.includes('//') || input.split('/').includes('..') || !/^\/[A-Za-z0-9._+/@%-]+$/.test(input)) throw new TypeError(`${label} must be a canonical absolute POSIX path for SSH execution.`);
    return input.length > 1 ? input.replace(/\/$/, '') : input;
  }
  if (!path.isAbsolute(input)) throw new TypeError(`${label} must be absolute.`);
  const normalized = path.normalize(input);
  if (directory && normalized === path.parse(normalized).root) throw new TypeError(`${label} cannot be a filesystem root.`);
  return normalized;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('CockroachDB connection configuration must be an object.');
  const allowed = [
    'executionMode', 'sshConnectionId', 'authMode', 'allowInsecure', 'host', 'port', 'username', 'database',
    'passwordSecretRefId', 'caFile', 'certsDir', 'sqlPath', 'timeoutMs', 'expectedVersion', 'expectedClusterVersion',
    'expectedClusterId', 'expectedDeploymentFingerprint', 'expectedTopologyFingerprint', 'expectedInventoryFingerprint'
  ];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown CockroachDB connection field: ${unknown[0]}.`);
  const executionMode = String(input.executionMode || 'ssh').toLowerCase();
  if (!EXECUTION_MODES.has(executionMode)) throw new TypeError('CockroachDB execution mode is invalid.');
  const sshConnectionId = optionalText(input.sshConnectionId, 'SSH connection ID', 200);
  if (executionMode === 'ssh' && !sshConnectionId) throw new TypeError('SSH execution requires a saved SSH connection.');
  if (executionMode === 'local' && sshConnectionId) throw new TypeError('Local execution cannot include an SSH connection.');
  const authMode = String(input.authMode || 'password').toLowerCase();
  if (!AUTH_MODES.has(authMode)) throw new TypeError('CockroachDB authentication mode is invalid.');
  const allowInsecure = input.allowInsecure === true;
  const passwordSecretRefId = optionalText(input.passwordSecretRefId, 'CockroachDB password SecretRef ID', 200);
  const caFile = normalizeCredentialPath(input.caFile, 'CockroachDB TLS CA file', executionMode);
  const certsDir = normalizeCredentialPath(input.certsDir, 'CockroachDB certificate directory', executionMode, true);
  if (authMode === 'password' && !passwordSecretRefId) throw new TypeError('CockroachDB password authentication requires a password SecretRef.');
  if (authMode === 'password' && (certsDir || allowInsecure)) throw new TypeError('CockroachDB password authentication cannot include a certificate directory or insecure approval.');
  if (authMode === 'client-certificate' && (!certsDir || passwordSecretRefId || allowInsecure)) throw new TypeError('CockroachDB client-certificate authentication requires only an explicit certificate directory.');
  if (authMode === 'client-certificate' && caFile) throw new TypeError('CockroachDB client-certificate authentication uses the CA in its certificate directory.');
  if (authMode === 'insecure' && !allowInsecure) throw new TypeError('CockroachDB insecure transport requires explicit approval.');
  if (authMode === 'insecure' && (passwordSecretRefId || caFile || certsDir)) throw new TypeError('CockroachDB insecure transport cannot include TLS or password credentials.');
  const port = Number(input.port ?? 26257);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('CockroachDB SQL port must be between 1 and 65535.');
  const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('CockroachDB command timeout must be between 1 and 300 seconds.');
  const username = optionalText(input.username, 'CockroachDB username', 256) || 'root';
  if (authMode === 'client-certificate' && !/^[A-Za-z0-9_.-]+$/.test(username)) throw new TypeError('CockroachDB client-certificate usernames must be safe certificate file components.');
  const expectedClusterId = optionalText(input.expectedClusterId, 'Expected CockroachDB cluster ID', 36);
  if (expectedClusterId) normalizeUuid(expectedClusterId, 'Expected CockroachDB cluster ID');
  return Object.freeze({
    executionMode,
    sshConnectionId,
    authMode,
    allowInsecure,
    host: normalizeHost(input.host),
    port,
    username,
    database: optionalText(input.database, 'CockroachDB database', 256) || 'defaultdb',
    passwordSecretRefId,
    caFile,
    certsDir,
    sqlPath: normalizeExecutable(input.sqlPath, executionMode),
    timeoutMs,
    expectedVersion: optionalText(input.expectedVersion, 'Expected CockroachDB server version', 100),
    expectedClusterVersion: optionalText(input.expectedClusterVersion, 'Expected CockroachDB cluster version', 100),
    expectedClusterId: expectedClusterId ? expectedClusterId.toLowerCase() : null,
    expectedDeploymentFingerprint: normalizeFingerprint(input.expectedDeploymentFingerprint, 'Expected CockroachDB deployment fingerprint'),
    expectedTopologyFingerprint: normalizeFingerprint(input.expectedTopologyFingerprint, 'Expected CockroachDB topology fingerprint'),
    expectedInventoryFingerprint: normalizeFingerprint(input.expectedInventoryFingerprint, 'Expected CockroachDB inventory fingerprint')
  });
}

function versionParts(text, label, allowMissingPatch = false) {
  const pattern = allowMissingPatch
    ? /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+]([0-9A-Za-z.-]+))?$/
    : /^(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/;
  const match = pattern.exec(text);
  if (!match) throw new DatabaseAdapterError('COCKROACH_VERSION_INVALID', `${label} is invalid.`, { category: 'compatibility' });
  const version = { text, major: Number(match[1]), minor: Number(match[2]), patch: match[3] === undefined ? null : Number(match[3]), prerelease: match[4] || null };
  if (version.major < 24 || version.major > 26 || version.major === 24 && version.minor < 3) throw new DatabaseAdapterError('COCKROACH_VERSION_UNSUPPORTED', 'CockroachDB v24.3 through v26.x releases are supported for discovery.', { category: 'compatibility' });
  return Object.freeze(version);
}

function parseVersion(value) {
  const text = requiredText(value, 'CockroachDB server version', 1000);
  const match = /CockroachDB\s+(?:(CCL|OSS)\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i.exec(text);
  if (!match) throw new DatabaseAdapterError('COCKROACH_PRODUCT_INVALID', 'The SQL endpoint did not report a supported CockroachDB server identity.', { category: 'compatibility' });
  const parsed = versionParts(match[2], 'CockroachDB server version');
  return Object.freeze({ ...parsed, distribution: String(match[1] || 'unknown').toLowerCase() });
}

function parseClusterVersion(value) {
  const text = requiredText(value, 'CockroachDB cluster version', 100).replace(/^v/i, '');
  return versionParts(text, 'CockroachDB cluster version', true);
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    const difference = Number(left[key] ?? 0) - Number(right[key] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function parseTsv(output, label) {
  const text = String(output ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) throw new DatabaseAdapterError('COCKROACH_OUTPUT_LIMIT', `${label} exceeded the bounded output limit.`, { category: 'capacity' });
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (!lines.length) throw new DatabaseAdapterError('COCKROACH_OUTPUT_INVALID', `${label} returned no tabular output.`, { category: 'integrity' });
  const headers = lines.shift().split('\t');
  if (!headers.length || headers.length > 64 || headers.some((header) => !/^[a-z][a-z0-9_]{0,62}$/.test(header)) || new Set(headers).size !== headers.length) throw new DatabaseAdapterError('COCKROACH_OUTPUT_INVALID', `${label} returned invalid column metadata.`, { category: 'integrity' });
  if (lines.length > MAX_ROWS) throw new DatabaseAdapterError('COCKROACH_ROW_LIMIT', `${label} returned too many rows.`, { category: 'capacity' });
  const rows = lines.map((line) => {
    const values = line.split('\t');
    if (values.length !== headers.length) throw new DatabaseAdapterError('COCKROACH_OUTPUT_INVALID', `${label} returned a malformed row.`, { category: 'integrity' });
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
  Object.defineProperty(rows, 'columns', { value: Object.freeze([...headers]), enumerable: false });
  return rows;
}

function exactColumns(rows, expected, label) {
  if (!Array.isArray(rows)) throw new DatabaseAdapterError('COCKROACH_OUTPUT_INVALID', `${label} is invalid.`, { category: 'integrity' });
  if (!Array.isArray(rows.columns) || rows.columns.length !== expected.length || rows.columns.some((key, index) => key !== expected[index])) throw new DatabaseAdapterError('COCKROACH_OUTPUT_INVALID', `${label} returned unexpected columns.`, { category: 'integrity' });
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new DatabaseAdapterError('COCKROACH_OUTPUT_INVALID', `${label} returned unexpected columns.`, { category: 'integrity' });
  }
  return rows;
}

function boundedInteger(value, label, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new DatabaseAdapterError('COCKROACH_OUTPUT_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return number;
}

function strictBoolean(value, label) {
  const text = String(value).toLowerCase();
  if (text === 'true' || text === 't' || text === '1') return true;
  if (text === 'false' || text === 'f' || text === '0') return false;
  throw new DatabaseAdapterError('COCKROACH_OUTPUT_INVALID', `${label} is invalid.`, { category: 'integrity' });
}

function normalizeTimestamp(value, label) {
  const date = new Date(requiredText(value, label, 100));
  if (Number.isNaN(date.getTime())) throw new DatabaseAdapterError('COCKROACH_OUTPUT_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return date.toISOString();
}

function normalizeNodeBuild(value) {
  const build = requiredText(value, 'CockroachDB node build', 200);
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(build)) throw new DatabaseAdapterError('COCKROACH_NODE_INVENTORY_INVALID', 'CockroachDB returned an invalid node build identity.', { category: 'integrity' });
  return build.replace(/^v/i, '');
}

function normalizeNodes(rows, currentNodeId) {
  exactColumns(rows, ['node_id', 'address', 'sql_address', 'build_tag', 'started_at', 'locality', 'is_available', 'is_live'], 'CockroachDB node discovery');
  if (!rows.length || rows.length > MAX_NODES) throw new DatabaseAdapterError('COCKROACH_NODE_INVENTORY_INVALID', 'CockroachDB returned an empty or oversized node inventory.', { category: 'integrity' });
  const nodes = rows.map((row) => Object.freeze({
    nodeId: boundedInteger(row.node_id, 'CockroachDB node ID', 1000000, 1),
    address: requiredText(row.address, 'CockroachDB node address', 512),
    sqlAddress: requiredText(row.sql_address, 'CockroachDB node SQL address', 512),
    buildTag: normalizeNodeBuild(row.build_tag),
    startedAt: normalizeTimestamp(row.started_at, 'CockroachDB node start time'),
    locality: optionalText(row.locality, 'CockroachDB node locality', 2048) || '',
    available: strictBoolean(row.is_available, 'CockroachDB node availability'),
    live: strictBoolean(row.is_live, 'CockroachDB node liveness')
  })).sort((left, right) => left.nodeId - right.nodeId);
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length || !nodes.some((node) => node.nodeId === currentNodeId)) throw new DatabaseAdapterError('COCKROACH_NODE_INVENTORY_INVALID', 'CockroachDB node membership is duplicate or omits the connected node.', { category: 'integrity' });
  return nodes;
}

function normalizeDatabases(rows) {
  exactColumns(rows, ['database_name', 'owner'], 'CockroachDB database discovery');
  if (rows.length > MAX_DATABASES) throw new DatabaseAdapterError('COCKROACH_DATABASE_INVENTORY_INVALID', 'CockroachDB returned too many databases.', { category: 'capacity' });
  const databases = rows.map((row) => Object.freeze({
    name: requiredText(row.database_name, 'CockroachDB database name', 256),
    owner: requiredText(row.owner, 'CockroachDB database owner', 256),
    selectable: String(row.database_name).toLowerCase() !== 'system'
  })).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
  if (new Set(databases.map((database) => database.name)).size !== databases.length) throw new DatabaseAdapterError('COCKROACH_DATABASE_INVENTORY_INVALID', 'CockroachDB returned duplicate database identities.', { category: 'integrity' });
  return databases;
}

function parseOptionalPrivileges(result) {
  if (result.failed) return Object.freeze({ visible: false, system: Object.freeze(Object.fromEntries(SYSTEM_PRIVILEGES.map((name) => [name, null]))) });
  const rows = exactColumns(parseTsv(result.stdout, 'CockroachDB system privilege discovery'), ['backup', 'restore', 'viewjob', 'controljob', 'externalioimplicitaccess'], 'CockroachDB system privilege discovery');
  if (rows.length !== 1) throw new DatabaseAdapterError('COCKROACH_PRIVILEGE_INVENTORY_INVALID', 'CockroachDB returned ambiguous system privilege evidence.', { category: 'integrity' });
  return Object.freeze({ visible: true, system: Object.freeze({
    BACKUP: strictBoolean(rows[0].backup, 'CockroachDB BACKUP privilege'),
    RESTORE: strictBoolean(rows[0].restore, 'CockroachDB RESTORE privilege'),
    VIEWJOB: strictBoolean(rows[0].viewjob, 'CockroachDB VIEWJOB privilege'),
    CONTROLJOB: strictBoolean(rows[0].controljob, 'CockroachDB CONTROLJOB privilege'),
    EXTERNALIOIMPLICITACCESS: strictBoolean(rows[0].externalioimplicitaccess, 'CockroachDB EXTERNALIOIMPLICITACCESS privilege')
  }) });
}

function parseExternalConnections(result) {
  if (result.failed) return Object.freeze({ visible: false, connections: Object.freeze([]) });
  const rows = exactColumns(parseTsv(result.stdout, 'CockroachDB external connection discovery'), ['connection_name', 'owner'], 'CockroachDB external connection discovery');
  if (rows.length > MAX_EXTERNAL_CONNECTIONS) throw new DatabaseAdapterError('COCKROACH_EXTERNAL_CONNECTION_LIMIT', 'CockroachDB returned too many external connections.', { category: 'capacity' });
  const connections = rows.map((row) => Object.freeze({ name: requiredText(row.connection_name, 'CockroachDB external connection name', 256), owner: requiredText(row.owner, 'CockroachDB external connection owner', 256) })).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
  if (new Set(connections.map((connection) => connection.name)).size !== connections.length) throw new DatabaseAdapterError('COCKROACH_EXTERNAL_CONNECTION_INVALID', 'CockroachDB returned duplicate external connection identities.', { category: 'integrity' });
  return Object.freeze({ visible: true, connections: Object.freeze(connections) });
}

function sqlUrl(input = {}) {
  const config = normalizeConfig(input);
  const host = net.isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  const parameters = new URLSearchParams();
  if (config.authMode === 'insecure') parameters.set('sslmode', 'disable');
  else parameters.set('sslmode', 'verify-full');
  if (config.authMode === 'password' && config.caFile) parameters.set('sslrootcert', config.caFile);
  if (config.authMode === 'client-certificate') {
    const join = config.executionMode === 'ssh' ? path.posix.join : path.join;
    parameters.set('sslrootcert', join(config.certsDir, 'ca.crt'));
    parameters.set('sslcert', join(config.certsDir, `client.${config.username}.crt`));
    parameters.set('sslkey', join(config.certsDir, `client.${config.username}.key`));
  }
  return `postgresql://${encodeURIComponent(config.username)}@${host}:${config.port}/${encodeURIComponent(config.database)}?${parameters.toString()}`;
}

function runLocalCommand({ executable, args = [], timeoutMs = DEFAULT_TIMEOUT_MS, signal, env = {} }) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs, windowsHide: true, shell: false, signal, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode: 0 });
    });
  });
}

async function command(context, config, query, options = {}) {
  try {
    return await (context.runNativeCommand || runLocalCommand)({ executable: config.sqlPath, args: ['sql', `--url=${sqlUrl(config)}`, '--format=tsv', '--execute', query], timeoutMs: config.timeoutMs, signal: context.signal });
  } catch (error) {
    if (options.allowFailure) return { stdout: '', stderr: '', exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1, failed: true };
    if (error instanceof DatabaseAdapterError) throw error;
    if (error?.name === 'AbortError') throw new DatabaseAdapterError('COCKROACH_COMMAND_CANCELED', 'CockroachDB discovery was canceled.', { category: 'canceled' });
    throw new DatabaseAdapterError('COCKROACH_COMMAND_FAILED', 'A CockroachDB discovery command failed.', { category: 'connectivity', retryable: true });
  }
}

async function readDiscovery(context = {}, input = {}) {
  const config = normalizeConfig(input);
  const results = await Promise.all(Object.entries(QUERIES).map(async ([key, query]) => [key, await command(context, config, query, { allowFailure: ['systemPrivileges', 'jobs', 'externalConnections'].includes(key) })]));
  const output = Object.fromEntries(results);
  const identityRows = exactColumns(parseTsv(output.identity.stdout, 'CockroachDB identity discovery'), ['version', 'cluster_id', 'node_id', 'current_user', 'current_database'], 'CockroachDB identity discovery');
  if (identityRows.length !== 1) throw new DatabaseAdapterError('COCKROACH_IDENTITY_INVALID', 'CockroachDB returned an ambiguous server identity.', { category: 'integrity' });
  const identity = identityRows[0];
  const version = parseVersion(identity.version);
  const clusterRows = exactColumns(parseTsv(output.clusterVersion.stdout, 'CockroachDB cluster-version discovery'), ['version'], 'CockroachDB cluster-version discovery');
  if (clusterRows.length !== 1) throw new DatabaseAdapterError('COCKROACH_CLUSTER_VERSION_INVALID', 'CockroachDB returned an ambiguous cluster version.', { category: 'integrity' });
  const clusterVersion = parseClusterVersion(clusterRows[0].version);
  if (compareVersions(clusterVersion, version) > 0) throw new DatabaseAdapterError('COCKROACH_CLUSTER_VERSION_INVALID', 'CockroachDB cluster version is newer than the connected server binary.', { category: 'integrity' });
  const clusterId = normalizeUuid(identity.cluster_id, 'CockroachDB cluster ID');
  const currentNodeId = boundedInteger(identity.node_id, 'CockroachDB connected node ID', 1000000, 1);
  const currentUser = requiredText(identity.current_user, 'CockroachDB current user', 256);
  const currentDatabase = requiredText(identity.current_database, 'CockroachDB current database', 256);
  if (currentUser !== config.username || currentDatabase !== config.database) throw new DatabaseAdapterError('COCKROACH_SESSION_IDENTITY_CHANGED', 'CockroachDB authenticated a different user or database than the approved connection.', { category: 'integrity' });
  const nodes = normalizeNodes(parseTsv(output.nodes.stdout, 'CockroachDB node discovery'), currentNodeId);
  const databases = normalizeDatabases(parseTsv(output.databases.stdout, 'CockroachDB database discovery'));
  if (!databases.some((database) => database.name === currentDatabase)) throw new DatabaseAdapterError('COCKROACH_DATABASE_INVENTORY_INVALID', 'CockroachDB database inventory omits the connected database.', { category: 'integrity' });
  const privileges = parseOptionalPrivileges(output.systemPrivileges);
  let jobsVisible = false;
  let visibleJobCount = null;
  if (!output.jobs.failed) {
    const rows = exactColumns(parseTsv(output.jobs.stdout, 'CockroachDB job catalog discovery'), ['visible_job_count'], 'CockroachDB job catalog discovery');
    if (rows.length !== 1) throw new DatabaseAdapterError('COCKROACH_JOB_CATALOG_INVALID', 'CockroachDB returned ambiguous job catalog evidence.', { category: 'integrity' });
    jobsVisible = true;
    visibleJobCount = boundedInteger(rows[0].visible_job_count, 'CockroachDB visible job count');
  }
  const external = parseExternalConnections(output.externalConnections);
  const topologyEvidence = nodes.map(({ nodeId, address, sqlAddress, buildTag, locality }) => ({ nodeId, address, sqlAddress, buildTag, locality }));
  const topologyFingerprint = stableDigest(topologyEvidence);
  const deploymentFingerprint = stableDigest({ product: 'cockroachdb', clusterId, clusterVersion: clusterVersion.text, databases: databases.map(({ name, owner }) => ({ name, owner })) });
  const inventoryFingerprint = stableDigest({ privileges, jobsVisible, externalConnections: external.connections });
  if (config.expectedVersion && config.expectedVersion !== version.text) throw new DatabaseAdapterError('COCKROACH_VERSION_CHANGED', 'CockroachDB server version changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedClusterVersion && config.expectedClusterVersion !== clusterVersion.text) throw new DatabaseAdapterError('COCKROACH_CLUSTER_VERSION_CHANGED', 'CockroachDB active cluster version changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedClusterId && config.expectedClusterId !== clusterId) throw new DatabaseAdapterError('COCKROACH_CLUSTER_ID_CHANGED', 'CockroachDB cluster identity changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedDeploymentFingerprint && config.expectedDeploymentFingerprint !== deploymentFingerprint) throw new DatabaseAdapterError('COCKROACH_DEPLOYMENT_CHANGED', 'CockroachDB deployment identity changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedTopologyFingerprint && config.expectedTopologyFingerprint !== topologyFingerprint) throw new DatabaseAdapterError('COCKROACH_TOPOLOGY_CHANGED', 'CockroachDB node topology changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedInventoryFingerprint && config.expectedInventoryFingerprint !== inventoryFingerprint) throw new DatabaseAdapterError('COCKROACH_INVENTORY_CHANGED', 'CockroachDB privilege or external-connection inventory changed since the connection was tested.', { category: 'integrity' });
  const capabilities = Object.freeze({
    executionReady: false,
    backupIntoSyntax: true,
    restoreSyntax: true,
    detachedJobs: true,
    nativeSchedules: true,
    revisionHistory: true,
    normalIncrementalChainLimit: 48,
    minimumIncrementalCadenceSeconds: 300,
    backupCompactionVersionEligible: compareVersions(clusterVersion, { major: 26, minor: 2, patch: 0 }) >= 0,
    backupCompactionEnabled: null,
    privilegeEvidenceVisible: privileges.visible,
    systemPrivileges: privileges.system,
    perObjectPrivilegeProofComplete: false,
    jobsVisible,
    externalConnectionsVisible: external.visible,
    externalConnectionsChecked: false
  });
  return Object.freeze({
    product: 'cockroachdb', version, clusterVersion, clusterId, currentNodeId, currentUser, currentDatabase,
    nodes: Object.freeze(nodes), databases: Object.freeze(databases), privileges, visibleJobCount,
    externalConnections: external.connections, capabilities, deploymentFingerprint, topologyFingerprint, inventoryFingerprint
  });
}

function safeAdapterError(error) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error?.name === 'AbortError') return new DatabaseAdapterError('COCKROACH_COMMAND_CANCELED', 'CockroachDB discovery was canceled.', { category: 'canceled' });
  return new DatabaseAdapterError('COCKROACH_DISCOVERY_FAILED', 'DeployerX could not complete CockroachDB discovery.', { category: 'connectivity', retryable: true });
}

function executionNotReady(operation) {
  throw new DatabaseAdapterError('COCKROACH_EXECUTION_NOT_READY', `CockroachDB ${operation} is not enabled by this discovery-only adapter.`, { category: 'compatibility' });
}

class CockroachDbAdapter {
  constructor({ clock = () => new Date().toISOString(), now = () => Date.now(), nativeBackupController = null, nativeRestoreController = null } = {}) {
    this.clock = clock;
    this.now = now;
    this.nativeBackupController = nativeBackupController;
    this.nativeRestoreController = nativeRestoreController;
  }

  #backupController() {
    if (!this.nativeBackupController) {
      const { CockroachDbNativeBackupController } = require('./cockroachdb-native');
      this.nativeBackupController = new CockroachDbNativeBackupController({ clock: this.clock, now: this.now });
    }
    return this.nativeBackupController;
  }

  #restoreController() {
    if (!this.nativeRestoreController) {
      const { CockroachDbNativeRestoreController } = require('./cockroachdb-restore');
      this.nativeRestoreController = new CockroachDbNativeRestoreController({ clock: this.clock, now: this.now });
    }
    return this.nativeRestoreController;
  }

  manifest() {
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      displayName: 'CockroachDB',
      engine: 'cockroachdb',
      executionReady: true,
      sourceEnrollmentReady: true,
      serverVersionRange: 'CockroachDB v24.3 through v26.x',
      restoreVersionRange: 'Same-major or next-major alternate CockroachDB targets',
      capabilities: {
        backupMethods: ['physical'],
        backupModes: ['full', 'incremental'],
        selection: { database: true, schema: false, table: true, globalObjects: true },
        consistencyStrategies: [{ id: 'cockroachdb-native-backup', produces: 'application', backupMethods: ['physical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: true }],
        transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null },
        streaming: { backup: false, restore: false, compression: true, encryption: false },
        restore: { alternateTarget: true, offlineBundle: false, originalTarget: false, nativeValidation: true },
        replicaAware: true
      },
      requiredTools: [{ name: 'cockroach', versionRange: 'Server-compatible CockroachDB v24.3 through v26.x', operations: ['discovery', 'backup', 'restore', 'validation'] }],
      requiredPrivileges: [
        { id: 'cockroach-cluster-metadata', operations: ['discovery'], required: true, safeDescription: 'Read exact cluster, node, database, active-version, job-catalog, and external-connection identity evidence.' },
        { id: 'cockroach-backup-scope', operations: ['backup'], required: true, safeDescription: 'Prove BACKUP on every exact system, database, and table scope selected; privileges do not cascade.' },
        { id: 'cockroach-restore-scope', operations: ['restore'], required: true, safeDescription: 'Prove RESTORE on every exact target scope before detached native restore.' },
        { id: 'cockroach-job-control', operations: ['backup', 'restore'], required: true, safeDescription: 'View and control only exact persisted detached CockroachDB job IDs.' },
        { id: 'cockroach-external-io', operations: ['backup', 'restore'], required: true, safeDescription: 'Validate the exact external connection or prove explicitly approved implicit external I/O access.' }
      ]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'COCKROACH_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const discovery = await readDiscovery(context, input);
      const unavailable = discovery.nodes.filter((node) => !node.available || !node.live);
      const privileges = discovery.privileges.system;
      const backupPrivilege = privileges.BACKUP === true;
      const restorePrivilege = privileges.RESTORE === true;
      return normalizeConnectionTestResult({
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'success',
        checks: [
          { id: 'product-version', status: 'pass', safeMessage: `CockroachDB ${discovery.version.text} with active cluster version ${discovery.clusterVersion.text} is supported for discovery.` },
          { id: 'cluster-identity', status: 'pass', safeMessage: 'The exact CockroachDB cluster and connected-node identities were captured.' },
          { id: 'node-topology', status: unavailable.length ? 'warning' : 'pass', safeMessage: unavailable.length ? `${unavailable.length} CockroachDB node(s) are not available and live.` : 'Every discovered CockroachDB node is available and live.' },
          { id: 'backup-restore-privileges', status: discovery.privileges.visible && backupPrivilege && restorePrivilege ? 'pass' : 'warning', safeMessage: discovery.privileges.visible ? 'Bounded system BACKUP and RESTORE privilege evidence was captured; per-object proof remains required.' : 'System privilege evidence is unavailable; backup and restore execution remain disabled.' },
          { id: 'job-catalog', status: discovery.capabilities.jobsVisible ? 'pass' : 'warning', safeMessage: discovery.capabilities.jobsVisible ? 'The native job catalog is queryable; exact owned job IDs will be required for execution.' : 'The native job catalog is unavailable; detached execution remains disabled.' },
          { id: 'external-storage', status: discovery.capabilities.externalConnectionsVisible ? 'pass' : 'warning', safeMessage: discovery.capabilities.externalConnectionsVisible ? 'External connection names are visible; no external storage connection was checked.' : 'External connection inventory is unavailable; external storage remains unvalidated.' }
        ],
        remotePlatform: { engine: 'cockroachdb', version: discovery.version.text, distribution: discovery.version.distribution, platform: null },
        endpointIdentity: {
          product: discovery.product,
          version: discovery.version.text,
          distribution: discovery.version.distribution,
          clusterVersion: discovery.clusterVersion.text,
          clusterId: discovery.clusterId,
          currentNodeId: discovery.currentNodeId,
          deploymentFingerprint: discovery.deploymentFingerprint,
          topologyFingerprint: discovery.topologyFingerprint,
          inventoryFingerprint: discovery.inventoryFingerprint,
          nodeCount: discovery.nodes.length,
          liveNodeCount: discovery.nodes.filter((node) => node.live && node.available).length,
          executionReady: false
        },
        error: null
      }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    } catch (error) {
      const safe = safeAdapterError(error);
      return normalizeConnectionTestResult({
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'failure',
        checks: [],
        error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null }
      }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    }
  }

  async *discover(context = {}, request = {}) {
    const kind = String(request.kind || 'all').toLowerCase();
    if (!DISCOVERY_KINDS.has(kind)) throw new DatabaseAdapterError('COCKROACH_DISCOVERY_KIND_UNSUPPORTED', 'CockroachDB discovery kind is unsupported.', { category: 'compatibility' });
    const discovery = await readDiscovery(context, request.connection);
    const common = {
      nextCursor: null,
      product: discovery.product,
      version: discovery.version,
      clusterVersion: discovery.clusterVersion,
      clusterId: discovery.clusterId,
      deploymentFingerprint: discovery.deploymentFingerprint,
      topologyFingerprint: discovery.topologyFingerprint,
      inventoryFingerprint: discovery.inventoryFingerprint
    };
    if (kind === 'nodes') yield { ...common, items: discovery.nodes };
    else if (kind === 'databases') yield { ...common, items: discovery.databases };
    else if (kind === 'capabilities') yield { ...common, items: [], capabilities: discovery.capabilities, externalConnections: discovery.externalConnections };
    else yield {
      ...common,
      items: [],
      identity: { currentNodeId: discovery.currentNodeId, currentUser: discovery.currentUser, currentDatabase: discovery.currentDatabase, distribution: discovery.version.distribution },
      nodes: discovery.nodes,
      databases: discovery.databases,
      externalConnections: discovery.externalConnections,
      visibleJobCount: discovery.visibleJobCount,
      capabilities: discovery.capabilities
    };
  }

  async preflight(context, input) { return this.#backupController().preflight(context, input); }
  async planBackup(context, input) { return this.#backupController().planBackup(context, input); }
  async executeBackup(context, input) { return this.#backupController().executeBackup(context, input); }
  async planRestore(context, input) { return this.#restoreController().planRestore(context, input); }
  async executeRestore(context, input) { return this.#restoreController().executeRestore(context, input); }
  async validateRestore(context, input) { return this.#restoreController().validateRestore(context, input); }
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function passwordEnvironmentContents(password) {
  const secret = String(password ?? '');
  if (!secret || secret.includes('\0') || /[\r\n]/.test(secret) || secret.length > 16384) throw new TypeError('CockroachDB password is invalid.');
  return `export PGPASSWORD=${shellSingleQuote(secret)}\n`;
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class CockroachDbConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new CockroachDbAdapter(), sessionFactory = openSshExecutionSession, localCommandRunner = runLocalCommand, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.sessionFactory = sessionFactory;
    this.localCommandRunner = localCommandRunner;
    this.clock = clock;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { includeDeleted: false, limit: 1000 }))
      .filter((record) => record.adapterId === ADAPTER_ID)
      .map((record) => ({ ...publicConnection(record), capabilities: this.adapter.manifest().capabilities, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'CockroachDB connection name', 200);
    const authMode = String(input.authMode || 'password').toLowerCase();
    const password = input.password === undefined || input.password === null || input.password === '' ? null : String(input.password);
    if (authMode === 'password') passwordEnvironmentContents(password);
    else if (password !== null) throw new TypeError('CockroachDB passwords are valid only for password authentication.');
    let passwordRef = null;
    try {
      if (password !== null) passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({
        executionMode: input.executionMode,
        sshConnectionId: input.sshConnectionId,
        authMode,
        allowInsecure: input.allowInsecure,
        host: input.host,
        port: input.port,
        username: input.username,
        database: input.database,
        passwordSecretRefId: passwordRef?.id,
        caFile: input.caFile,
        certsDir: input.certsDir,
        sqlPath: input.sqlPath,
        timeoutMs: input.timeoutMs
      });
      if (config.executionMode === 'ssh') await this.#validatedSshConnection(tenant, config.sshConnectionId);
      const { passwordSecretRefId: _secretRefId, ...endpoint } = config;
      return await this.controlDatabase.transaction((transaction) => {
        if (passwordRef) transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant,
          actorId: actor,
          name,
          kind: 'database',
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          scope: 'device',
          endpoint,
          secretRefIds: passwordRef ? [passwordRef.id] : [],
          trust: { mode: config.executionMode, fingerprint: null },
          workerAffinity: [`device:${this.deviceId}`],
          lastTest: null,
          cockroachdbInventory: null
        });
      });
    } catch (error) {
      if (passwordRef) await this.secretStore.delete({ workspaceId: tenant, id: passwordRef.id }).catch(() => {});
      throw error;
    }
  }

  config(connection) {
    const secretRefIds = Array.isArray(connection?.secretRefIds) ? connection.secretRefIds : [];
    const passwordAuthentication = connection?.endpoint?.authMode === 'password';
    if (passwordAuthentication && secretRefIds.length !== 1) throw new Error('CockroachDB password authentication requires exactly one SecretRef.');
    if (!passwordAuthentication && secretRefIds.length !== 0) throw new Error('CockroachDB certificate and insecure connections cannot reference password SecretRefs.');
    return normalizeConfig({ ...connection.endpoint, passwordSecretRefId: passwordAuthentication ? secretRefIds[0] : null });
  }

  async #validatedSshConnection(workspaceId, connectionId) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, connectionId);
    if (!connection || connection.adapterId !== 'deployerx.connection.ssh') throw new Error('The paired SSH connection was not found.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('The paired SSH connection belongs to another device.');
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new Error('Test and approve the paired SSH connection before CockroachDB discovery.');
    return connection;
  }

  async withExecution(workspaceId, connection, signal, callback) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const config = this.config(connection);
    let session = null;
    let authFile = null;
    let authEnvironment = {};
    let cleanupFailed = false;
    try {
      if (config.executionMode === 'ssh') {
        const sshConnection = await this.#validatedSshConnection(tenant, config.sshConnectionId);
        session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal });
      }
      if (config.passwordSecretRefId) {
        const password = await this.secretStore.resolve({ workspaceId: tenant, id: config.passwordSecretRefId });
        const contents = passwordEnvironmentContents(password);
        if (session) {
          authFile = `/tmp/deployerx-cockroachdb-${crypto.randomBytes(16).toString('hex')}.env`;
          await session.writeFile(authFile, contents, { mode: 0o600 });
        } else authEnvironment = { PGPASSWORD: password };
      }
      const context = {
        signal,
        runNativeCommand: session
          ? ({ executable, args, timeoutMs }) => new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (error) reject(error); else resolve(value);
            };
            const timer = setTimeout(() => { session.close(); finish(new DatabaseAdapterError('COCKROACH_COMMAND_TIMEOUT', 'A CockroachDB discovery command timed out.', { category: 'timeout', retryable: true })); }, timeoutMs);
            const commandText = authFile
              ? commandFromArgs('sh', ['-c', '. "$1"; shift; exec "$@"', 'deployerx-cockroachdb', authFile, executable, ...args])
              : commandFromArgs(executable, args);
            session.run(commandText, { stdoutLimitBytes: MAX_OUTPUT_BYTES, stderrLimitBytes: MAX_OUTPUT_BYTES }).then((value) => finish(null, value), (error) => finish(error));
          })
          : (request) => this.localCommandRunner({ ...request, env: authEnvironment })
      };
      return await callback(context, config);
    } finally {
      if (session && authFile) {
        try { await session.run(commandFromArgs('rm', ['-f', '--', authFile]), { ignoreAbort: true, stdoutLimitBytes: 4096, stderrLimitBytes: 4096 }); }
        catch { cleanupFailed = true; }
      }
      session?.close();
      if (cleanupFailed) throw new DatabaseAdapterError('COCKROACH_CREDENTIAL_CLEANUP_FAILED', 'Temporary CockroachDB credential cleanup could not be proven.', { category: 'integrity' });
    }
  }

  async test(workspaceId, connectionId, actorId = 'system', signal) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('CockroachDB connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This CockroachDB connection belongs to another device.');
    const { result, inventory } = await this.withExecution(tenant, current, signal, async (context, config) => {
      const tested = await this.adapter.testConnection(context, config);
      if (tested.status !== 'success') return { result: tested, inventory: null };
      const pinned = {
        ...config,
        expectedVersion: tested.endpointIdentity.version,
        expectedClusterVersion: tested.endpointIdentity.clusterVersion,
        expectedClusterId: tested.endpointIdentity.clusterId,
        expectedDeploymentFingerprint: tested.endpointIdentity.deploymentFingerprint,
        expectedTopologyFingerprint: tested.endpointIdentity.topologyFingerprint,
        expectedInventoryFingerprint: tested.endpointIdentity.inventoryFingerprint
      };
      const pages = [];
      for await (const page of this.adapter.discover(context, { connection: pinned, kind: 'all' })) pages.push(page);
      if (pages.length !== 1 || pages[0].deploymentFingerprint !== tested.endpointIdentity.deploymentFingerprint || pages[0].topologyFingerprint !== tested.endpointIdentity.topologyFingerprint || pages[0].inventoryFingerprint !== tested.endpointIdentity.inventoryFingerprint) throw new DatabaseAdapterError('COCKROACH_INVENTORY_CHANGED', 'CockroachDB identity changed while inventory was being captured.', { category: 'integrity' });
      return { result: tested, inventory: Object.freeze({
        version: 1,
        capturedAt: tested.testedAt,
        productVersion: pages[0].version.text,
        distribution: pages[0].version.distribution,
        clusterVersion: pages[0].clusterVersion.text,
        clusterId: pages[0].clusterId,
        deploymentFingerprint: pages[0].deploymentFingerprint,
        topologyFingerprint: pages[0].topologyFingerprint,
        inventoryFingerprint: pages[0].inventoryFingerprint,
        identity: pages[0].identity,
        nodes: pages[0].nodes,
        databases: pages[0].databases,
        externalConnections: pages[0].externalConnections,
        capabilities: pages[0].capabilities
      }) };
    });
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const endpoint = result.status === 'success' ? {
      ...current.endpoint,
      expectedVersion: result.endpointIdentity.version,
      expectedClusterVersion: result.endpointIdentity.clusterVersion,
      expectedClusterId: result.endpointIdentity.clusterId,
      expectedDeploymentFingerprint: result.endpointIdentity.deploymentFingerprint,
      expectedTopologyFingerprint: result.endpointIdentity.topologyFingerprint,
      expectedInventoryFingerprint: result.endpointIdentity.inventoryFingerprint
    } : current.endpoint;
    const trust = result.status === 'success' ? {
      mode: current.endpoint.executionMode,
      fingerprint: result.endpointIdentity.deploymentFingerprint,
      clusterId: result.endpointIdentity.clusterId,
      topologyFingerprint: result.endpointIdentity.topologyFingerprint,
      inventoryFingerprint: result.endpointIdentity.inventoryFingerprint,
      observedAt: result.testedAt
    } : { mode: current.endpoint.executionMode, fingerprint: null };
    let cockroachdbBackupDestinationTrust = null;
    if (result.status === 'success' && inventory && current.cockroachdbBackupDestinationTrust?.version === 1
      && current.cockroachdbBackupDestinationTrust.connectionRevision === current.revision) {
      try {
        const prior = current.cockroachdbBackupDestinationTrust;
        const destination = normalizeBackupDestination(prior.destination);
        const inventoryNames = new Set(inventory.externalConnections.map((item) => item.name));
        if (prior.clusterId === result.endpointIdentity.clusterId && prior.deploymentFingerprint === result.endpointIdentity.deploymentFingerprint
          && prior.topologyFingerprint === result.endpointIdentity.topologyFingerprint && prior.inventoryFingerprint === result.endpointIdentity.inventoryFingerprint
          && prior.destinationFingerprint === destination.destinationFingerprint && prior.localityFingerprint === destination.localityFingerprint
          && destination.localities.every((item) => inventoryNames.has(item.externalConnectionName))) {
          cockroachdbBackupDestinationTrust = Object.freeze({ ...prior, connectionRevision: current.revision + 1 });
        }
      } catch {}
    }
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, {
      endpoint,
      lastTest: result,
      trust,
      cockroachdbInventory: result.status === 'success' ? inventory : null,
      cockroachdbBackupDestinationTrust,
      adapterVersion: ADAPTER_VERSION
    }, { expectedRevision: current.revision, actorId });
    return { connection: publicConnection(connection), result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('CockroachDB connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This CockroachDB connection belongs to another device.');
    const trusted = current.lastTest?.status === 'success'
      && current.trust?.fingerprint === current.endpoint?.expectedDeploymentFingerprint
      && current.trust?.clusterId === current.endpoint?.expectedClusterId
      && current.trust?.topologyFingerprint === current.endpoint?.expectedTopologyFingerprint
      && current.trust?.inventoryFingerprint === current.endpoint?.expectedInventoryFingerprint;
    if (!trusted) throw new Error('Test the CockroachDB connection successfully before discovery.');
    return this.withExecution(tenant, current, input.signal, async (context, config) => {
      const pages = [];
      for await (const page of this.adapter.discover(context, { connection: config, kind: input.kind || 'all' })) pages.push(page);
      if (pages.length !== 1) throw new Error('CockroachDB discovery returned an invalid page count.');
      return pages[0];
    });
  }

  async approveDestination(workspaceId, connectionId, input = {}, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    if (String(input.confirmationText || '').trim() !== BACKUP_DESTINATION_CONFIRMATION) throw new TypeError(`Type ${BACKUP_DESTINATION_CONFIRMATION} to approve this CockroachDB backup destination.`);
    const destinationInput = input.destination || {
      type: input.type || 'external-connection',
      externalConnectionName: input.externalConnectionName,
      localities: input.localities
    };
    const destination = normalizeBackupDestination(destinationInput);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('CockroachDB connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This CockroachDB connection belongs to another device.');
    const inventory = current.cockroachdbInventory;
    const identity = current.lastTest?.endpointIdentity;
    if (current.lastTest?.status !== 'success' || !inventory || current.trust?.clusterId !== current.endpoint?.expectedClusterId
      || current.trust?.clusterId !== identity?.clusterId || current.trust?.clusterId !== inventory.clusterId
      || current.trust?.fingerprint !== current.endpoint?.expectedDeploymentFingerprint || current.trust?.fingerprint !== identity?.deploymentFingerprint || current.trust?.fingerprint !== inventory.deploymentFingerprint
      || current.trust?.topologyFingerprint !== current.endpoint?.expectedTopologyFingerprint || current.trust?.topologyFingerprint !== identity?.topologyFingerprint || current.trust?.topologyFingerprint !== inventory.topologyFingerprint
      || current.trust?.inventoryFingerprint !== current.endpoint?.expectedInventoryFingerprint || current.trust?.inventoryFingerprint !== identity?.inventoryFingerprint || current.trust?.inventoryFingerprint !== inventory.inventoryFingerprint) {
      throw new Error('Test the CockroachDB connection successfully before approving a backup destination.');
    }
    const discoveredNames = new Set((inventory.externalConnections || []).map((item) => item.name));
    if (!inventory.capabilities?.externalConnectionsVisible || destination.localities.some((item) => !discoveredNames.has(item.externalConnectionName))) throw new TypeError('Choose only exact discovered CockroachDB external connections.');
    const discovery = await this.withExecution(tenant, current, input.signal, async (context, config) => {
      const live = await readDiscovery(context, config);
      if (live.clusterId !== current.trust.clusterId || live.deploymentFingerprint !== current.trust.fingerprint
        || live.topologyFingerprint !== current.trust.topologyFingerprint || live.inventoryFingerprint !== current.trust.inventoryFingerprint) {
        throw new DatabaseAdapterError('COCKROACH_DESTINATION_IDENTITY_CHANGED', 'CockroachDB cluster, topology, or inventory changed while approving the backup destination.', { category: 'integrity' });
      }
      if (!live.capabilities.externalConnectionsVisible || !live.capabilities.jobsVisible || !live.capabilities.privilegeEvidenceVisible
        || live.capabilities.systemPrivileges.VIEWJOB !== true || live.capabilities.systemPrivileges.CONTROLJOB !== true) {
        throw new DatabaseAdapterError('COCKROACH_DESTINATION_CAPABILITY_UNPROVEN', 'CockroachDB external-connection visibility and exact native job control must be proven.', { category: 'authorization' });
      }
      const liveNames = new Set(live.externalConnections.map((item) => item.name));
      if (destination.localities.some((item) => !liveNames.has(item.externalConnectionName))) throw new DatabaseAdapterError('COCKROACH_EXTERNAL_CONNECTION_CHANGED', 'A selected CockroachDB external connection is unavailable.', { category: 'integrity' });
      for (const binding of destination.localities) {
        await command(context, config, `CHECK EXTERNAL CONNECTION ${quoteSqlString(`external://${binding.externalConnectionName}`, 'CockroachDB external connection URI')}`);
      }
      return live;
    });
    const checkedAt = this.clock();
    const destinationTrust = Object.freeze({
      version: 1,
      connectionRevision: current.revision + 1,
      clusterId: discovery.clusterId,
      deploymentFingerprint: discovery.deploymentFingerprint,
      topologyFingerprint: discovery.topologyFingerprint,
      inventoryFingerprint: discovery.inventoryFingerprint,
      destination: rawBackupDestination(destination),
      destinationFingerprint: destination.destinationFingerprint,
      localityFingerprint: destination.localityFingerprint,
      checkedAt
    });
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { cockroachdbBackupDestinationTrust: destinationTrust }, { expectedRevision: current.revision, actorId: actor });
    return { connection: publicConnection(connection), destinationTrust: publicBackupDestinationTrust(destinationTrust) };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  AUTH_MODES,
  BACKUP_DESTINATION_CONFIRMATION,
  CockroachDbAdapter,
  CockroachDbConnectionService,
  QUERIES,
  SYSTEM_PRIVILEGES,
  normalizeConfig,
  normalizeBackupDestination,
  parseClusterVersion,
  parseTsv,
  parseVersion,
  passwordEnvironmentContents,
  readDiscovery,
  runSqlCommand: command,
  sqlUrl
};
