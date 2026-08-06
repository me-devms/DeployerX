const crypto = require('crypto');
const fsNative = require('fs');
const fs = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');

const ADAPTER_ID = 'deployerx.database.neo4j';
const ADAPTER_VERSION = '0.6.0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_DUMP_BYTES = 16 * 1024 * 1024 * 1024 * 1024;
const MAX_BACKUP_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RESTORE_CONFIRMATION = 'RESTORE NEO4J ALTERNATE';
const EXECUTION_MODES = new Set(['local', 'ssh']);
const EDITIONS = new Set(['auto', 'community', 'enterprise']);
const DISCOVERY_KINDS = new Set(['all', 'databases', 'servers']);
const ONLINE_TIER = 'enterprise-online';
const MAX_NATIVE_FILES = 10000;

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function digestFile(fileSystem, filePath) {
  const handle = await fileSystem.open(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
  } finally { await handle.close(); }
  return `sha256:${hash.digest('hex')}`;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('Neo4j command timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeExecutable(value, label, defaultValue) {
  const executable = optionalText(value, label, 1024) || defaultValue;
  if (executable.startsWith('/')) {
    if (!/^\/[A-Za-z0-9._+/-]+$/.test(executable) || executable.includes('..')) throw new TypeError(`${label} is invalid.`);
    return executable.replace(/\/{2,}/g, '/');
  }
  if (path.isAbsolute(executable)) return path.normalize(executable);
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) throw new TypeError(`${label} must be an absolute path or executable name.`);
  return executable;
}

function normalizeAddress(value) {
  const address = optionalText(value, 'Neo4j address', 2048) || 'neo4j://127.0.0.1:7687';
  let parsed;
  try { parsed = new URL(address); }
  catch { throw new TypeError('Neo4j address must be a valid Bolt or Neo4j URI.'); }
  if (!['bolt:', 'bolt+s:', 'bolt+ssc:', 'neo4j:', 'neo4j+s:', 'neo4j+ssc:'].includes(parsed.protocol)) throw new TypeError('Neo4j address must use a Bolt or Neo4j URI scheme.');
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '' || parsed.search || parsed.hash) throw new TypeError('Neo4j address cannot contain credentials, a path, query, or fragment.');
  if (parsed.port && (Number(parsed.port) < 1 || Number(parsed.port) > 65535)) throw new TypeError('Neo4j address port is invalid.');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Neo4j connection configuration must be an object.');
  const allowed = ['expectedEdition', 'executionMode', 'sshConnectionId', 'address', 'username', 'passwordSecretRefId', 'neo4jPath', 'neo4jAdminPath', 'cypherShellPath', 'timeoutMs', 'expectedVersion', 'expectedDeploymentFingerprint', 'expectedTopologyFingerprint'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown Neo4j connection field: ${unknown[0]}.`);
  const expectedEdition = String(input.expectedEdition || 'auto').toLowerCase();
  if (!EDITIONS.has(expectedEdition)) throw new TypeError('Expected Neo4j edition is invalid.');
  const executionMode = String(input.executionMode || 'ssh').toLowerCase();
  if (!EXECUTION_MODES.has(executionMode)) throw new TypeError('Neo4j execution mode is invalid.');
  const sshConnectionId = optionalText(input.sshConnectionId, 'SSH connection ID', 200);
  if (executionMode === 'ssh' && !sshConnectionId) throw new TypeError('SSH execution requires a saved SSH connection.');
  if (executionMode === 'local' && sshConnectionId) throw new TypeError('Local execution cannot include an SSH connection.');
  const username = optionalText(input.username, 'Neo4j username', 256);
  const passwordSecretRefId = optionalText(input.passwordSecretRefId, 'Neo4j password SecretRef ID', 200);
  if (Boolean(username) !== Boolean(passwordSecretRefId)) throw new TypeError('Neo4j authentication requires both a username and password SecretRef.');
  const executables = {
    neo4jPath: normalizeExecutable(input.neo4jPath, 'neo4j path', 'neo4j'),
    neo4jAdminPath: normalizeExecutable(input.neo4jAdminPath, 'neo4j-admin path', 'neo4j-admin'),
    cypherShellPath: normalizeExecutable(input.cypherShellPath, 'cypher-shell path', 'cypher-shell')
  };
  if (executionMode === 'ssh' && Object.values(executables).some((executable) => /[\\:]/.test(executable))) throw new TypeError('SSH execution requires POSIX executable paths or executable names.');
  return {
    expectedEdition,
    executionMode,
    sshConnectionId,
    address: normalizeAddress(input.address),
    username,
    passwordSecretRefId,
    ...executables,
    timeoutMs: normalizeTimeout(input.timeoutMs),
    expectedVersion: optionalText(input.expectedVersion, 'Expected Neo4j version', 100),
    expectedDeploymentFingerprint: optionalText(input.expectedDeploymentFingerprint, 'Expected Neo4j deployment fingerprint', 80),
    expectedTopologyFingerprint: optionalText(input.expectedTopologyFingerprint, 'Expected Neo4j topology fingerprint', 80)
  };
}

function selectedDatabase(selector = {}) {
  const included = selector.databases?.include || [];
  const filtered = selector.allDatabases || selector.databases?.exclude?.length || selector.schemas?.include?.length || selector.schemas?.exclude?.length || selector.tables?.include?.length || selector.tables?.exclude?.length;
  if (included.length !== 1 || filtered) throw new DatabaseAdapterError('NEO4J_SELECTION_INVALID', 'Neo4j backup requires exactly one complete user database without object filters.', { category: 'compatibility' });
  const name = requiredText(included[0]?.name, 'Neo4j selected database', 63).toLowerCase();
  if (name === 'system' || !/^[a-z][a-z0-9.-]{0,62}$/.test(name)) throw new DatabaseAdapterError('NEO4J_SELECTION_INVALID', 'Select one valid Neo4j user database.', { category: 'compatibility' });
  return name;
}

function normalizeBackupAddress(value) {
  const address = requiredText(value, 'Neo4j backup-service address', 512).toLowerCase();
  let host;
  let portText;
  const ipv6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(address);
  if (ipv6) {
    if (net.isIP(ipv6[1]) !== 6) throw new TypeError('Neo4j backup-service IPv6 address is invalid.');
    host = `[${ipv6[1]}]`;
    portText = ipv6[2];
  } else {
    const match = /^([^:\/\s]+):(\d{1,5})$/.exec(address);
    if (!match || (!net.isIP(match[1]) && (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(match[1]) || match[1].includes('..')))) throw new TypeError('Neo4j backup-service address must be an explicit host:port value.');
    host = match[1];
    portText = match[2];
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Neo4j backup-service port is invalid.');
  return `${host}:${port}`;
}

function normalizeOnlineExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Neo4j Enterprise online execution settings are required.');
  const allowed = ['backupAddresses'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown Neo4j online execution field: ${unknown[0]}.`);
  if (!Array.isArray(input.backupAddresses) || input.backupAddresses.length < 1 || input.backupAddresses.length > 100) throw new TypeError('Neo4j Enterprise online backup requires between 1 and 100 backup-service addresses.');
  const backupAddresses = [...new Set(input.backupAddresses.map(normalizeBackupAddress))].sort();
  if (backupAddresses.length !== input.backupAddresses.length) throw new TypeError('Neo4j backup-service addresses must be unique.');
  return Object.freeze({ backupAddresses });
}

function onlineDatabaseEvidence(discovery, selectedName) {
  if (discovery.edition !== 'enterprise') throw new DatabaseAdapterError('NEO4J_ENTERPRISE_REQUIRED', 'Neo4j online backup requires Enterprise Edition.', { category: 'compatibility' });
  const allocations = discovery.databases.filter((database) => database.name.toLowerCase() === selectedName);
  if (!allocations.length || allocations.some((database) => database.system || database.selectable !== true)) throw new DatabaseAdapterError('NEO4J_DATABASE_NOT_FOUND', 'The selected Neo4j user database was not found.', { category: 'validation' });
  const databaseIds = [...new Set(allocations.map((database) => database.databaseId))];
  if (databaseIds.length !== 1) throw new DatabaseAdapterError('NEO4J_DATABASE_IDENTITY_AMBIGUOUS', 'Neo4j returned ambiguous database identities for the selected database.', { category: 'integrity' });
  if (allocations.some((database) => database.currentStatus !== 'online' || database.requestedStatus !== 'online')) throw new DatabaseAdapterError('NEO4J_DATABASE_NOT_ONLINE', 'Start every selected Neo4j database allocation before online backup.', { category: 'consistency' });
  const writers = allocations.filter((database) => database.writer);
  if (writers.length !== 1) throw new DatabaseAdapterError('NEO4J_DATABASE_WRITER_AMBIGUOUS', 'Neo4j online backup requires exactly one authenticated writer allocation.', { category: 'consistency' });
  const serverIds = [...new Set(allocations.map((database) => database.serverId))].sort();
  const servers = serverIds.map((serverId) => discovery.servers.find((server) => server.serverId === serverId));
  if (servers.some((server) => !server || server.state !== 'enabled' || !['available', 'healthy'].includes(server.health))) throw new DatabaseAdapterError('NEO4J_DATABASE_TOPOLOGY_UNHEALTHY', 'Every server hosting the selected Neo4j database must be enabled and healthy.', { category: 'connectivity', retryable: true });
  return {
    name: selectedName,
    databaseId: databaseIds[0],
    writerServerId: writers[0].serverId,
    allocations: allocations.map(({ serverId, role, writer, currentStatus, requestedStatus }) => ({ serverId, role, writer, currentStatus, requestedStatus })).sort((left, right) => left.serverId.localeCompare(right.serverId, 'en-US')),
    servers: servers.map(({ serverId, state, health }) => ({ serverId, state, health }))
  };
}

function nativeArtifactName(value) {
  const name = requiredText(value, 'Neo4j native backup filename', 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*[.]backup$/.test(name) || name.includes('..')) throw new DatabaseAdapterError('NEO4J_BACKUP_FILENAME_INVALID', 'Neo4j returned an unsafe native backup filename.', { category: 'integrity' });
  return name;
}

function parseOnlineBackupInspection(value) {
  const text = requiredText(value, 'Neo4j online backup inspection', MAX_OUTPUT_BYTES);
  const fields = {};
  for (const line of text.split(/\r?\n/).slice(0, 2000)) {
    const match = /^([^:=]{1,100})\s*[:=]\s*(.{1,4096})$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (Object.prototype.hasOwnProperty.call(fields, key)) throw new DatabaseAdapterError('NEO4J_BACKUP_INSPECTION_AMBIGUOUS', 'Neo4j returned duplicate online backup inspection fields.', { category: 'integrity' });
    fields[key] = match[2].trim();
  }
  const name = databaseName(fields.databasename || fields.database);
  const databaseId = requiredText(fields.databaseid || fields.databaseuuid, 'Neo4j inspected database ID', 200);
  const typeText = requiredText(fields.backuptype || fields.artifacttype || fields.type, 'Neo4j inspected backup type', 40).toLowerCase();
  const backupMode = typeText === 'full' ? 'full' : ['diff', 'differential'].includes(typeText) ? 'differential' : null;
  if (!backupMode) throw new DatabaseAdapterError('NEO4J_BACKUP_TYPE_INVALID', 'Neo4j returned an unsupported native backup type.', { category: 'integrity' });
  const backupTime = requiredText(fields.backuptime || fields.backupdate || fields.timestamp, 'Neo4j backup time', 100);
  if (!Number.isFinite(Date.parse(backupTime))) throw new DatabaseAdapterError('NEO4J_BACKUP_TIME_INVALID', 'Neo4j returned an invalid backup time.', { category: 'integrity' });
  const integer = (raw, label) => {
    if (!/^(?:0|[1-9]\d*)$/.test(String(raw || ''))) throw new DatabaseAdapterError('NEO4J_TRANSACTION_RANGE_INVALID', `${label} is invalid.`, { category: 'integrity' });
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) throw new DatabaseAdapterError('NEO4J_TRANSACTION_RANGE_INVALID', `${label} exceeds the supported range.`, { category: 'integrity' });
    return parsed;
  };
  const lowestTransactionId = integer(fields.lowesttransactionid || fields.lowertransactionid, 'Neo4j lowest transaction ID');
  const highestTransactionId = integer(fields.highesttransactionid || fields.uppertransactionid, 'Neo4j highest transaction ID');
  if ((lowestTransactionId === 0) !== (highestTransactionId === 0) || (highestTransactionId && lowestTransactionId > highestTransactionId)) throw new DatabaseAdapterError('NEO4J_TRANSACTION_RANGE_INVALID', 'Neo4j returned an invalid transaction range.', { category: 'integrity' });
  const storeFormat = requiredText(fields.storeformat || fields.storeformatversion, 'Neo4j store format', 200);
  if (!/^[A-Za-z0-9._+-]+$/.test(storeFormat)) throw new DatabaseAdapterError('NEO4J_STORE_FORMAT_UNAVAILABLE', 'Neo4j returned an invalid store format.', { category: 'integrity' });
  return { databaseName: name, databaseId, backupMode, backupTime: new Date(backupTime).toISOString(), lowestTransactionId, highestTransactionId, storeFormat };
}

function databaseName(value, label = 'Neo4j database name') {
  const name = requiredText(value, label, 63).toLowerCase();
  if (name === 'system' || !/^[a-z][a-z0-9.-]{0,62}$/.test(name)) throw new DatabaseAdapterError('NEO4J_DATABASE_NAME_INVALID', 'Choose a valid Neo4j user database name.', { category: 'validation' });
  return name;
}

function parseDatabaseInfo(value) {
  const text = requiredText(value, 'Neo4j database information', MAX_OUTPUT_BYTES);
  const fields = {};
  for (const line of text.split(/\r?\n/).slice(0, 1000)) {
    const match = /^([^:]{1,100}):\s*(.{1,4096})$/.exec(line.trim());
    if (!match) continue;
    fields[match[1].trim().toLowerCase()] = match[2].trim();
  }
  const storeFormat = fields['store format version'] || fields['store format'];
  if (!storeFormat || !/^[A-Za-z0-9._+-]{1,200}$/.test(storeFormat)) throw new DatabaseAdapterError('NEO4J_STORE_FORMAT_UNAVAILABLE', 'neo4j-admin did not return a valid store format for the dump.', { category: 'integrity' });
  return { storeFormat, databaseName: fields['database name'] || null };
}

function offlineDatabaseEvidence(discovery, databaseName) {
  const allocations = discovery.databases.filter((database) => database.name.toLowerCase() === databaseName);
  if (!allocations.length || allocations.some((database) => database.system || database.selectable !== true)) throw new DatabaseAdapterError('NEO4J_DATABASE_NOT_FOUND', 'The selected Neo4j user database was not found.', { category: 'validation' });
  const databaseIds = [...new Set(allocations.map((database) => database.databaseId))];
  if (databaseIds.length !== 1) throw new DatabaseAdapterError('NEO4J_DATABASE_IDENTITY_AMBIGUOUS', 'Neo4j returned ambiguous database identities for the selected database.', { category: 'integrity' });
  if (allocations.some((database) => database.currentStatus !== 'offline' || database.requestedStatus !== 'offline')) throw new DatabaseAdapterError('NEO4J_DATABASE_NOT_OFFLINE', 'Stop the selected Neo4j database before creating an offline dump.', { category: 'consistency' });
  return {
    name: databaseName,
    databaseId: databaseIds[0],
    allocations: allocations.map(({ serverId, role, writer, currentStatus, requestedStatus }) => ({ serverId, role, writer, currentStatus, requestedStatus })).sort((left, right) => left.serverId.localeCompare(right.serverId, 'en-US'))
  };
}

function parseVersion(value) {
  const text = requiredText(value, 'Neo4j version output', 4096);
  const match = /(?:^|[^0-9])((?:20\d{2})|\d{1,2})[.](\d+)(?:[.](\d+))?/.exec(text);
  if (!match) throw new DatabaseAdapterError('NEO4J_VERSION_INVALID', 'Neo4j returned an invalid version.', { category: 'compatibility' });
  const version = { text: `${match[1]}.${match[2]}.${match[3] || '0'}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) };
  const supported = (version.major === 5 && version.minor >= 26) || (version.major >= 2025 && version.major <= 2029);
  if (!supported) throw new DatabaseAdapterError('NEO4J_VERSION_UNSUPPORTED', `Neo4j ${version.text} is not supported.`, { category: 'compatibility' });
  return version;
}

function supportsPreferDiffAsParent(value) {
  const version = typeof value === 'object' && value ? value : parseVersion(value);
  return version.major > 2025 || (version.major === 2025 && version.minor >= 4);
}

function supportsFirstDifferentialOverlap(value) {
  const version = typeof value === 'object' && value ? value : parseVersion(value);
  return version.major > 2026 || (version.major === 2026 && version.minor >= 2);
}

function decodeField(value) {
  const text = String(value ?? '').trim();
  if (text === 'null' || text === '<null>') return null;
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/""/g, '"');
  return text;
}

function parseTsv(output, label) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  if (!lines.length) throw new DatabaseAdapterError('NEO4J_DISCOVERY_INVALID', `${label} returned no rows.`, { category: 'integrity' });
  const headers = lines[0].split('\t').map((field) => requiredText(decodeField(field), `${label} column`, 100));
  if (new Set(headers).size !== headers.length) throw new DatabaseAdapterError('NEO4J_DISCOVERY_INVALID', `${label} returned duplicate columns.`, { category: 'integrity' });
  const rows = lines.slice(1).map((line) => {
    const values = line.split('\t');
    if (values.length !== headers.length) throw new DatabaseAdapterError('NEO4J_DISCOVERY_INVALID', `${label} returned a malformed row.`, { category: 'integrity' });
    return Object.fromEntries(headers.map((header, index) => [header, decodeField(values[index])]));
  });
  if (rows.length > 10000) throw new DatabaseAdapterError('NEO4J_DISCOVERY_LIMIT', `${label} exceeds the item limit.`, { category: 'capacity' });
  return rows;
}

function parseBoolean(value, label) {
  if (value === true || String(value).toLowerCase() === 'true') return true;
  if (value === false || String(value).toLowerCase() === 'false') return false;
  throw new DatabaseAdapterError('NEO4J_DISCOVERY_INVALID', `${label} is invalid.`, { category: 'integrity' });
}

function normalizeDatabases(rows) {
  if (!rows.length) throw new DatabaseAdapterError('NEO4J_DATABASES_EMPTY', 'Neo4j returned no database inventory.', { category: 'integrity' });
  const databases = rows.map((row) => ({
    kind: 'database',
    name: requiredText(row.name, 'Neo4j database name', 255),
    type: requiredText(row.type, 'Neo4j database type', 40).toLowerCase(),
    access: requiredText(row.access, 'Neo4j database access', 40).toLowerCase(),
    currentStatus: requiredText(row.currentStatus, 'Neo4j database current status', 40).toLowerCase(),
    requestedStatus: requiredText(row.requestedStatus, 'Neo4j database requested status', 40).toLowerCase(),
    role: requiredText(row.role, 'Neo4j database role', 40).toLowerCase(),
    writer: parseBoolean(row.writer, 'Neo4j writer state'),
    default: parseBoolean(row.default, 'Neo4j default state'),
    home: parseBoolean(row.home, 'Neo4j home state'),
    databaseId: requiredText(row.databaseID, 'Neo4j database ID', 200),
    serverId: requiredText(row.serverID, 'Neo4j server ID', 200),
    constituents: row.constituents ? String(row.constituents).slice(0, 4096) : null,
    system: String(row.name).toLowerCase() === 'system',
    selectable: String(row.name).toLowerCase() !== 'system'
  })).sort((left, right) => left.name.localeCompare(right.name, 'en-US') || left.serverId.localeCompare(right.serverId, 'en-US'));
  if (!databases.some((database) => database.system)) throw new DatabaseAdapterError('NEO4J_SYSTEM_DATABASE_MISSING', 'Neo4j did not report its required system database.', { category: 'integrity' });
  return databases;
}

function normalizeServers(rows, databases, edition) {
  if (!rows.length && edition === 'enterprise') throw new DatabaseAdapterError('NEO4J_SERVER_INVENTORY_REQUIRED', 'Neo4j Enterprise server inventory is unavailable.', { category: 'authorization' });
  const servers = rows.length ? rows.map((row) => ({
    kind: 'server',
    serverId: requiredText(row.serverId, 'Neo4j server ID', 200),
    name: requiredText(row.name, 'Neo4j server name', 255),
    address: requiredText(row.address, 'Neo4j server address', 1024),
    state: requiredText(row.state, 'Neo4j server state', 40).toLowerCase(),
    health: requiredText(row.health, 'Neo4j server health', 40).toLowerCase(),
    hosting: row.hosting ? String(row.hosting).slice(0, 4096) : null
  })) : [...new Set(databases.map((database) => database.serverId))].map((serverId) => ({ kind: 'server', serverId, name: serverId, address: null, state: 'enabled', health: 'available', hosting: null }));
  if (new Set(servers.map((server) => server.serverId)).size !== servers.length) throw new DatabaseAdapterError('NEO4J_SERVER_INVENTORY_INVALID', 'Neo4j returned duplicate server identities.', { category: 'integrity' });
  return servers.sort((left, right) => left.serverId.localeCompare(right.serverId, 'en-US'));
}

function runLocalCommand({ executable, args = [], timeoutMs = DEFAULT_TIMEOUT_MS, signal, env = {} }) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs, windowsHide: true, signal, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error) {
        const code = error.killed ? 'NEO4J_COMMAND_TIMEOUT' : error.name === 'AbortError' ? 'NEO4J_COMMAND_CANCELED' : 'NEO4J_COMMAND_FAILED';
        const wrapped = new DatabaseAdapterError(code, error.killed ? 'A Neo4j native command timed out.' : error.name === 'AbortError' ? 'Neo4j discovery was canceled.' : 'A Neo4j native command failed.', { category: error.killed ? 'timeout' : error.name === 'AbortError' ? 'canceled' : 'unavailable', retryable: Boolean(error.killed) });
        wrapped.exitCode = Number.isInteger(error.code) ? error.code : null;
        reject(wrapped);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode: 0 });
    });
  });
}

async function command(context, config, executable, args, options = {}) {
  try { return await (context.runNativeCommand || runLocalCommand)({ executable, args, timeoutMs: options.timeoutMs || config.timeoutMs, signal: context.signal }); }
  catch (error) {
    if (options.allowFailure) return { stdout: '', stderr: '', exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1, failed: true };
    if (error instanceof DatabaseAdapterError) throw error;
    throw new DatabaseAdapterError('NEO4J_COMMAND_FAILED', 'A Neo4j native command failed.', { category: 'unavailable', retryable: true });
  }
}

function cypherArgs(config, statement) {
  return ['--address', config.address, '--format', 'plain', '--wrap', 'false', '--field-terminator', '\t', statement];
}

async function readDiscovery(context = {}, input = {}) {
  const config = normalizeConfig(input);
  const [neo4jResult, adminResult, componentResult, databaseResult, serverResult] = await Promise.all([
    command(context, config, config.neo4jPath, ['--version']),
    command(context, config, config.neo4jAdminPath, ['--version']),
    command(context, config, config.cypherShellPath, cypherArgs(config, 'CALL dbms.components() YIELD name, versions, edition RETURN name, versions[0] AS version, edition')),
    command(context, config, config.cypherShellPath, cypherArgs(config, 'SHOW DATABASES YIELD name, type, access, currentStatus, requestedStatus, role, writer, default, home, databaseID, serverID, constituents RETURN name, type, access, currentStatus, requestedStatus, role, writer, default, home, databaseID, serverID, constituents ORDER BY name, serverID')),
    command(context, config, config.cypherShellPath, cypherArgs(config, 'SHOW SERVERS YIELD serverId, name, address, state, health, hosting RETURN serverId, name, address, state, health, hosting ORDER BY serverId'), { allowFailure: true })
  ]);
  const binaryVersion = parseVersion(neo4jResult.stdout);
  const adminVersion = parseVersion(adminResult.stdout);
  const components = parseTsv(componentResult.stdout, 'Neo4j component discovery');
  if (components.length !== 1) throw new DatabaseAdapterError('NEO4J_COMPONENT_IDENTITY_INVALID', 'Neo4j returned an ambiguous component identity.', { category: 'integrity' });
  const component = components[0];
  const serverVersion = parseVersion(component.version);
  const edition = requiredText(component.edition, 'Neo4j edition', 40).toLowerCase();
  if (!['community', 'enterprise'].includes(edition)) throw new DatabaseAdapterError('NEO4J_EDITION_UNSUPPORTED', 'Neo4j returned an unsupported edition.', { category: 'compatibility' });
  if (config.expectedEdition !== 'auto' && config.expectedEdition !== edition) throw new DatabaseAdapterError('NEO4J_EDITION_CHANGED', 'Neo4j edition does not match the tested connection.', { category: 'integrity' });
  if (binaryVersion.major !== serverVersion.major || adminVersion.major !== serverVersion.major) throw new DatabaseAdapterError('NEO4J_TOOL_VERSION_MISMATCH', 'Neo4j server and native tools must use the same major release.', { category: 'compatibility' });
  if (config.expectedVersion && config.expectedVersion !== serverVersion.text) throw new DatabaseAdapterError('NEO4J_VERSION_CHANGED', 'Neo4j version does not match the tested connection.', { category: 'integrity' });
  const databases = normalizeDatabases(parseTsv(databaseResult.stdout, 'Neo4j database discovery'));
  const serverRows = serverResult.failed ? [] : parseTsv(serverResult.stdout, 'Neo4j server discovery');
  const servers = normalizeServers(serverRows, databases, edition);
  const topologyEvidence = servers.map(({ serverId, address, state, health }) => ({ serverId, address, state, health }));
  const databaseEvidence = databases.map(({ name, databaseId, serverId, role, writer, currentStatus }) => ({ name, databaseId, serverId, role, writer, currentStatus }));
  const topologyFingerprint = stableDigest(topologyEvidence);
  const deploymentFingerprint = stableDigest({ edition, version: serverVersion.text, servers: topologyEvidence, databases: databaseEvidence });
  if (config.expectedDeploymentFingerprint && config.expectedDeploymentFingerprint !== deploymentFingerprint) throw new DatabaseAdapterError('NEO4J_DEPLOYMENT_CHANGED', 'Neo4j deployment identity has changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedTopologyFingerprint && config.expectedTopologyFingerprint !== topologyFingerprint) throw new DatabaseAdapterError('NEO4J_TOPOLOGY_CHANGED', 'Neo4j server topology has changed since the connection was tested.', { category: 'integrity' });
  return { edition, version: serverVersion, binaryVersion, adminVersion, componentName: requiredText(component.name, 'Neo4j component name', 200), databases, servers, deploymentFingerprint, topologyFingerprint };
}

function safeAdapterError(error) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error?.name === 'AbortError') return new DatabaseAdapterError('NEO4J_COMMAND_CANCELED', 'Neo4j discovery was canceled.', { category: 'canceled' });
  return new DatabaseAdapterError('NEO4J_DISCOVERY_FAILED', 'DeployerX could not complete Neo4j discovery.', { category: 'connectivity', retryable: true });
}

class Neo4jAdapter {
  constructor({ fileSystem = fs, createReadStream = fsNative.createReadStream, temporaryRoot = os.tmpdir(), clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'Neo4j temporary root'));
    this.clock = clock;
    this.now = now;
  }

  manifest() {
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      displayName: 'Neo4j',
      engine: 'neo4j',
      executionReady: true,
      sourceEnrollmentReady: true,
      serverVersionRange: 'Neo4j 5.26 LTS and supported calendar-version releases',
      restoreVersionRange: 'Same supported product major and compatible store format',
      capabilities: {
        backupMethods: ['physical'],
        backupModes: ['full', 'differential'],
        selection: { database: true, schema: false, table: false, globalObjects: true },
        consistencyStrategies: [
          { id: 'offline', produces: 'application', backupMethods: ['physical'], lockScope: 'database', requiresDowntime: true, capturesCoordinates: false },
          { id: 'neo4j-native-backup', produces: 'application', backupMethods: ['physical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: true }
        ],
        transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null },
        streaming: { backup: true, restore: true, compression: true, encryption: false },
        restore: { alternateTarget: true, offlineBundle: true, originalTarget: false, nativeValidation: true },
        replicaAware: true
      },
      requiredTools: [
        { name: 'neo4j', versionRange: 'Same supported major as server', operations: ['discovery'] },
        { name: 'neo4j-admin', versionRange: 'Same supported major as server', operations: ['discovery', 'backup', 'restore', 'aggregation'] },
        { name: 'cypher-shell', versionRange: 'Server-compatible', operations: ['discovery', 'restore'] }
      ],
      requiredPrivileges: [
        { id: 'neo4j-discovery', operations: ['discovery'], required: true, safeDescription: 'Read product identity, database inventory, database IDs, server IDs, roles, and topology health.' },
        { id: 'neo4j-offline-dump', operations: ['backup'], required: true, safeDescription: 'Prove the selected database stopped and create, inspect, read, and remove an owned native dump.' },
        { id: 'neo4j-enterprise-backup', operations: ['backup'], required: false, safeDescription: 'Run Enterprise online full or differential backups for every selected database and hosting server.' },
        { id: 'neo4j-enterprise-aggregation', operations: ['aggregation'], required: false, safeDescription: 'Materialize and aggregate an authenticated Enterprise native backup chain while preserving its source media.' },
        { id: 'neo4j-alternate-restore', operations: ['restore'], required: false, safeDescription: 'Load or restore authenticated media into an empty alternate DBMS and run native consistency validation.' }
      ]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'NEO4J_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const discovery = await readDiscovery(context, input);
      const unhealthy = discovery.servers.filter((server) => server.state !== 'enabled' || !['available', 'healthy'].includes(server.health));
      const unavailable = discovery.databases.filter((database) => database.currentStatus !== 'online');
      return normalizeConnectionTestResult({
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'success',
        checks: [
          { id: 'product-version', status: 'pass', safeMessage: `Neo4j ${discovery.version.text} ${discovery.edition} is supported.` },
          { id: 'native-tools', status: 'pass', safeMessage: 'Compatible neo4j, neo4j-admin, and cypher-shell probes succeeded.' },
          { id: 'deployment-identity', status: 'pass', safeMessage: 'Database and server identities were captured.' },
          { id: 'topology-health', status: unhealthy.length ? 'warning' : 'pass', safeMessage: unhealthy.length ? `${unhealthy.length} Neo4j server(s) are not enabled and healthy.` : 'All discovered Neo4j servers are enabled and healthy.' },
          { id: 'database-health', status: unavailable.length ? 'warning' : 'pass', safeMessage: unavailable.length ? `${unavailable.length} Neo4j database allocation(s) are not online.` : 'All discovered Neo4j database allocations are online.' }
        ],
        remotePlatform: { engine: 'neo4j', version: discovery.version.text, distribution: discovery.edition, platform: null },
        endpointIdentity: {
          product: 'neo4j', edition: discovery.edition, version: discovery.version.text,
          deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint,
          databaseCount: new Set(discovery.databases.map((database) => database.databaseId)).size,
          allocationCount: discovery.databases.length, serverCount: discovery.servers.length,
          defaultDatabase: discovery.databases.find((database) => database.default)?.name || null,
          homeDatabase: discovery.databases.find((database) => database.home)?.name || null
        },
        error: null
      }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    } catch (error) {
      const safe = safeAdapterError(error);
      return normalizeConnectionTestResult({ adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'failure', checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null } }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    }
  }

  async *discover(context = {}, request = {}) {
    const kind = String(request.kind || 'all').toLowerCase();
    if (!DISCOVERY_KINDS.has(kind)) throw new DatabaseAdapterError('NEO4J_DISCOVERY_KIND_UNSUPPORTED', 'Neo4j discovery kind is unsupported.', { category: 'compatibility' });
    const discovery = await readDiscovery(context, request.connection);
    const common = { nextCursor: null, edition: discovery.edition, version: discovery.version, deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint };
    if (kind === 'databases') yield { ...common, items: discovery.databases };
    else if (kind === 'servers') yield { ...common, items: discovery.servers };
    else yield { ...common, items: [], databases: discovery.databases, servers: discovery.servers, identity: { product: 'neo4j', edition: discovery.edition, version: discovery.version, binaryVersion: discovery.binaryVersion, adminVersion: discovery.adminVersion, componentName: discovery.componentName } };
  }

  async preflight(context = {}, request = {}) {
    const databaseName = selectedDatabase(request.selector);
    const discovery = await readDiscovery(context, request.connection);
    if (request.consistency?.method === 'neo4j-native-backup' || request.execution?.tier === ONLINE_TIER) {
      const execution = request.execution || {};
      const database = onlineDatabaseEvidence(discovery, databaseName);
      if (execution.engine !== 'neo4j' || execution.tier !== ONLINE_TIER || execution.deploymentFingerprint !== discovery.deploymentFingerprint || execution.topologyFingerprint !== discovery.topologyFingerprint || execution.databaseId !== database.databaseId || execution.databaseName !== database.name || execution.edition !== discovery.edition || execution.productVersion !== discovery.version.text || execution.connectionRevision < 1) throw new DatabaseAdapterError('NEO4J_ONLINE_EXECUTION_CHANGED', 'Neo4j Enterprise online execution settings no longer match the authenticated deployment.', { category: 'integrity' });
      const addresses = normalizeOnlineExecution({ backupAddresses: execution.backupAddresses }).backupAddresses;
      if (JSON.stringify(addresses) !== JSON.stringify(execution.backupAddresses) || execution.metadataPolicy !== (request.selector.includeGlobalObjects ? 'all' : 'none') || execution.compression !== true || execution.preferDiffAsParent !== supportsPreferDiffAsParent(discovery.version)) throw new DatabaseAdapterError('NEO4J_ONLINE_EXECUTION_INVALID', 'Neo4j Enterprise online execution settings are invalid.', { category: 'integrity' });
      if (request.consistency?.backupMode === 'differential' && !execution.preferDiffAsParent) throw new DatabaseAdapterError('NEO4J_DIFFERENTIAL_VERSION_UNSUPPORTED', 'This Neo4j release cannot safely maintain the required differential parent chain.', { category: 'compatibility' });
      return {
        checkedAt: this.clock(), serverVersion: discovery.version.text, serverVersionSupported: true,
        serverIdentityFingerprint: discovery.deploymentFingerprint,
        consistency: [{ method: 'neo4j-native-backup', verified: true, produces: 'application' }],
        tools: [
          { name: 'neo4j', version: discovery.binaryVersion.text, compatible: discovery.binaryVersion.major === discovery.version.major },
          { name: 'neo4j-admin', version: discovery.adminVersion.text, compatible: discovery.adminVersion.major === discovery.version.major },
          { name: 'cypher-shell', version: discovery.version.text, compatible: true }
        ],
        privileges: [
          { id: 'neo4j-discovery', allowed: true, evidence: 'Authenticated Enterprise database and server inventory queries completed.' },
          { id: 'neo4j-offline-dump', allowed: true, evidence: 'A compatible native execution binding is present.' },
          { id: 'neo4j-enterprise-backup', allowed: true, evidence: 'The selected Enterprise database is online with one writer and healthy hosting servers.' }
        ],
        coordinateCaptureVerified: true,
        warnings: [],
        metadata: {
          engine: 'neo4j', edition: discovery.edition, version: discovery.version.text,
          deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint,
          database, metadataScope: execution.metadataPolicy === 'all' ? 'database-store-and-rbac' : 'database-store-only-no-rbac',
          onlineExecution: structuredClone(execution)
        }
      };
    }
    if (request.selector.includeGlobalObjects) throw new DatabaseAdapterError('NEO4J_OFFLINE_METADATA_UNSUPPORTED', 'Neo4j offline dump cannot include Enterprise RBAC metadata.', { category: 'compatibility' });
    const database = offlineDatabaseEvidence(discovery, databaseName);
    return {
      checkedAt: this.clock(),
      serverVersion: discovery.version.text,
      serverVersionSupported: true,
      serverIdentityFingerprint: discovery.deploymentFingerprint,
      consistency: [{ method: 'offline', verified: true, produces: 'application' }],
      tools: [
        { name: 'neo4j', version: discovery.binaryVersion.text, compatible: discovery.binaryVersion.major === discovery.version.major },
        { name: 'neo4j-admin', version: discovery.adminVersion.text, compatible: discovery.adminVersion.major === discovery.version.major },
        { name: 'cypher-shell', version: discovery.version.text, compatible: true }
      ],
      privileges: [
        { id: 'neo4j-discovery', allowed: true, evidence: 'Authenticated product and database inventory queries completed.' },
        { id: 'neo4j-offline-dump', allowed: true, evidence: 'The bound execution host exposes a compatible neo4j-admin binary and the selected database is stopped.' }
      ],
      coordinateCaptureVerified: false,
      warnings: [],
      metadata: {
        engine: 'neo4j', edition: discovery.edition, version: discovery.version.text,
        deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint,
        database, metadataScope: 'database-store-only-no-rbac'
      }
    };
  }

  async planBackup(_context = {}, request = {}) {
    if (request.consistency?.method === 'neo4j-native-backup') {
      if (request.consistency?.proven !== true || request.consistency?.achievedLevel !== 'application' || request.consistency?.backupMethod !== 'physical' || !['full', 'differential'].includes(request.consistency?.backupMode) || request.consistency?.captureCoordinates !== true) throw new DatabaseAdapterError('NEO4J_CONSISTENCY_PLAN_INVALID', 'Neo4j Enterprise online backup requires a proven native full or differential plan with coordinate capture.', { category: 'consistency' });
      const databaseName = selectedDatabase(request.selector);
      const evidence = request.consistency.evidence?.metadata || {};
      const execution = evidence.onlineExecution || {};
      if (evidence.edition !== 'enterprise' || evidence.database?.name !== databaseName || !evidence.database?.databaseId || execution.tier !== ONLINE_TIER || execution.databaseId !== evidence.database.databaseId || execution.deploymentFingerprint !== evidence.deploymentFingerprint || execution.topologyFingerprint !== evidence.topologyFingerprint) throw new DatabaseAdapterError('NEO4J_BACKUP_EVIDENCE_INVALID', 'Neo4j Enterprise online backup evidence is incomplete.', { category: 'integrity' });
      return {
        version: 1,
        operation: 'neo4j-enterprise-online-backup',
        connection: normalizeConfig(request.connection),
        selector: request.selector,
        consistency: request.consistency,
        execution: structuredClone(execution),
        expected: {
          edition: evidence.edition, version: evidence.version,
          deploymentFingerprint: evidence.deploymentFingerprint, topologyFingerprint: evidence.topologyFingerprint,
          database: evidence.database, metadataScope: evidence.metadataScope
        },
        artifact: { kind: 'physical-backup', path: null, mediaType: 'application/vnd.neo4j.backup' },
        resumable: false
      };
    }
    if (request.consistency?.proven !== true || request.consistency?.method !== 'offline' || request.consistency?.achievedLevel !== 'application' || request.consistency?.backupMethod !== 'physical' || request.consistency?.backupMode !== 'full') throw new DatabaseAdapterError('NEO4J_CONSISTENCY_PLAN_INVALID', 'Neo4j offline backup requires a proven stopped-database physical full plan.', { category: 'consistency' });
    const databaseName = selectedDatabase(request.selector);
    const evidence = request.consistency.evidence?.metadata || {};
    if (evidence.database?.name !== databaseName || !evidence.database?.databaseId || !evidence.deploymentFingerprint || !evidence.topologyFingerprint) throw new DatabaseAdapterError('NEO4J_BACKUP_EVIDENCE_INVALID', 'Neo4j offline backup evidence is incomplete.', { category: 'integrity' });
    return {
      version: 1,
      operation: 'neo4j-offline-dump',
      connection: normalizeConfig(request.connection),
      selector: request.selector,
      consistency: request.consistency,
      expected: {
        edition: evidence.edition, version: evidence.version,
        deploymentFingerprint: evidence.deploymentFingerprint, topologyFingerprint: evidence.topologyFingerprint,
        database: evidence.database, metadataScope: evidence.metadataScope
      },
      artifact: { kind: 'database-dump', path: `neo4j/${databaseName}.dump`, mediaType: 'application/vnd.neo4j.dump' },
      resumable: false
    };
  }

  async createBackupMedia(context = {}, plan = {}, destinationPath, options = {}) {
    if (plan.operation === 'neo4j-enterprise-online-backup') return this.createOnlineBackupMedia(context, plan, destinationPath, options);
    if (plan.operation !== 'neo4j-offline-dump' || plan.consistency?.proven !== true) throw new DatabaseAdapterError('NEO4J_BACKUP_PLAN_INVALID', 'The Neo4j offline dump plan is invalid.', { category: 'integrity' });
    if (typeof context.createNativeTemporaryDirectory !== 'function' || typeof context.copyNativeFileToLocal !== 'function' || typeof context.removeNativeDirectory !== 'function') throw new DatabaseAdapterError('NEO4J_EXECUTION_CONTEXT_INVALID', 'Neo4j offline backup requires an owned local or SSH media executor.', { category: 'compatibility' });
    const destination = path.resolve(requiredText(destinationPath, 'Neo4j local dump destination'));
    if (await this.fileSystem.lstat(destination).catch(() => null)) throw new DatabaseAdapterError('NEO4J_BACKUP_DESTINATION_EXISTS', 'The Neo4j local staging destination already exists.', { category: 'integrity' });
    let nativeDirectory = null;
    try {
      const before = await readDiscovery(context, plan.connection);
      const database = offlineDatabaseEvidence(before, plan.expected.database.name);
      if (before.edition !== plan.expected.edition || before.version.text !== plan.expected.version || before.deploymentFingerprint !== plan.expected.deploymentFingerprint || before.topologyFingerprint !== plan.expected.topologyFingerprint || database.databaseId !== plan.expected.database.databaseId) throw new DatabaseAdapterError('NEO4J_DATABASE_IDENTITY_CHANGED', 'Neo4j database identity changed after backup planning.', { category: 'integrity' });
      nativeDirectory = await context.createNativeTemporaryDirectory();
      const dumpResult = await command(context, plan.connection, plan.connection.neo4jAdminPath, ['database', 'dump', database.name, `--to-path=${nativeDirectory}`], { timeoutMs: MAX_BACKUP_TIMEOUT_MS });
      if (dumpResult.exitCode !== 0) throw new DatabaseAdapterError('NEO4J_DUMP_FAILED', 'neo4j-admin could not create the offline database dump.', { category: 'execution', retryable: true });
      const nativeFile = `${nativeDirectory}/${database.name}.dump`;
      const inspection = await command(context, plan.connection, plan.connection.neo4jAdminPath, ['database', 'info', `--from-path=${nativeDirectory}`, database.name]);
      const inspectionText = `${inspection.stdout}\n${inspection.stderr}`.trim();
      if (!inspectionText || inspectionText.length > MAX_OUTPUT_BYTES) throw new DatabaseAdapterError('NEO4J_DUMP_INSPECTION_INVALID', 'neo4j-admin did not return bounded dump inspection evidence.', { category: 'integrity' });
      const databaseInfo = parseDatabaseInfo(inspectionText);
      await context.copyNativeFileToLocal(nativeFile, destination);
      const stat = await this.fileSystem.lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_DUMP_BYTES) throw new DatabaseAdapterError('NEO4J_DUMP_MEDIA_INVALID', 'The Neo4j dump is not a supported regular file.', { category: 'capacity' });
      const digest = await digestFile(this.fileSystem, destination);
      const after = await readDiscovery(context, plan.connection);
      const afterDatabase = offlineDatabaseEvidence(after, database.name);
      if (after.deploymentFingerprint !== before.deploymentFingerprint || after.topologyFingerprint !== before.topologyFingerprint || afterDatabase.databaseId !== database.databaseId) throw new DatabaseAdapterError('NEO4J_DATABASE_IDENTITY_CHANGED', 'Neo4j database identity changed while the offline dump was created.', { category: 'consistency' });
      return {
        filePath: destination,
        sizeBytes: stat.size,
        digest,
        inspectionDigest: stableDigest({ storeFormat: databaseInfo.storeFormat }),
        storeFormat: databaseInfo.storeFormat,
        database,
        edition: before.edition,
        version: before.version.text,
        deploymentFingerprint: before.deploymentFingerprint,
        topologyFingerprint: before.topologyFingerprint,
        metadataScope: 'database-store-only-no-rbac'
      };
    } catch (error) {
      await this.fileSystem.rm(destination, { force: true }).catch(() => {});
      if (error instanceof DatabaseAdapterError) throw error;
      throw new DatabaseAdapterError('NEO4J_DUMP_FAILED', 'DeployerX could not create the Neo4j offline dump.', { category: 'execution', retryable: true });
    } finally {
      if (nativeDirectory) await context.removeNativeDirectory(nativeDirectory);
    }
  }

  async createOnlineBackupMedia(context = {}, plan = {}, destinationPath, options = {}) {
    if (plan.operation !== 'neo4j-enterprise-online-backup' || plan.consistency?.proven !== true || !['full', 'differential'].includes(plan.consistency?.backupMode)) throw new DatabaseAdapterError('NEO4J_BACKUP_PLAN_INVALID', 'The Neo4j Enterprise online backup plan is invalid.', { category: 'integrity' });
    if (typeof context.createNativeTemporaryDirectory !== 'function' || typeof context.writeNativeFile !== 'function' || typeof context.listNativeDirectory !== 'function' || typeof context.copyNativeFileToLocal !== 'function' || typeof context.removeNativeDirectory !== 'function') throw new DatabaseAdapterError('NEO4J_EXECUTION_CONTEXT_INVALID', 'Neo4j online backup requires an ownership-fenced local or SSH media executor.', { category: 'compatibility' });
    const destination = path.resolve(requiredText(destinationPath, 'Neo4j local backup destination'));
    if (await this.fileSystem.lstat(destination).catch(() => null)) throw new DatabaseAdapterError('NEO4J_BACKUP_DESTINATION_EXISTS', 'The Neo4j local staging destination already exists.', { category: 'integrity' });
    const requestedMode = plan.consistency.backupMode;
    const parents = Array.isArray(options.parents) ? options.parents : [];
    if (requestedMode === 'full' && parents.length) throw new DatabaseAdapterError('NEO4J_BACKUP_PARENT_UNEXPECTED', 'A Neo4j full backup cannot consume differential parent media.', { category: 'integrity' });
    if (requestedMode === 'differential' && !parents.length) throw new DatabaseAdapterError('NEO4J_BACKUP_PARENT_REQUIRED', 'A Neo4j differential backup requires its complete authenticated native parent chain.', { category: 'consistency' });
    let nativeDirectory = null;
    let nativeTemporaryDirectory = null;
    try {
      const before = await readDiscovery(context, plan.connection);
      const database = onlineDatabaseEvidence(before, plan.expected.database.name);
      if (before.edition !== 'enterprise' || before.version.text !== plan.expected.version || before.deploymentFingerprint !== plan.expected.deploymentFingerprint || before.topologyFingerprint !== plan.expected.topologyFingerprint || database.databaseId !== plan.expected.database.databaseId) throw new DatabaseAdapterError('NEO4J_DATABASE_IDENTITY_CHANGED', 'Neo4j database identity changed after online backup planning.', { category: 'integrity' });
      nativeDirectory = await context.createNativeTemporaryDirectory();
      let previousHighest = null;
      let previousStoreFormat = null;
      for (const parent of parents) {
        const fileName = nativeArtifactName(parent.fileName);
        if (!Number.isSafeInteger(parent.sizeBytes) || parent.sizeBytes < 1 || parent.sizeBytes > MAX_DUMP_BYTES || !/^sha256:[0-9a-f]{64}$/.test(String(parent.contentDigest || '')) || typeof parent.open !== 'function') throw new DatabaseAdapterError('NEO4J_BACKUP_PARENT_INVALID', 'Neo4j differential parent media is incomplete.', { category: 'integrity' });
        if (parent.databaseId !== database.databaseId || !Number.isSafeInteger(parent.highestTransactionId) || parent.highestTransactionId < 0 || !/^[A-Za-z0-9._+-]+$/.test(String(parent.storeFormat || ''))) throw new DatabaseAdapterError('NEO4J_BACKUP_PARENT_IDENTITY_INVALID', 'Neo4j differential parent identity does not match the selected database.', { category: 'integrity' });
        const input = await parent.open();
        if (!input || typeof input[Symbol.asyncIterator] !== 'function') throw new DatabaseAdapterError('NEO4J_BACKUP_PARENT_STREAM_INVALID', 'Neo4j differential parent media is unavailable.', { category: 'integrity' });
        const hash = crypto.createHash('sha256');
        let sizeBytes = 0;
        const authenticated = (async function* authenticateParent() {
          for await (const raw of input) {
            if (context.signal?.aborted) throw new DatabaseAdapterError('NEO4J_BACKUP_CANCELED', 'The Neo4j backup was canceled.', { category: 'canceled' });
            const chunk = Buffer.from(raw);
            sizeBytes += chunk.length;
            if (sizeBytes > parent.sizeBytes || sizeBytes > MAX_DUMP_BYTES) throw new DatabaseAdapterError('NEO4J_BACKUP_PARENT_SIZE_INVALID', 'Neo4j differential parent media exceeds its authenticated size.', { category: 'integrity' });
            hash.update(chunk);
            yield chunk;
          }
        })();
        await context.writeNativeFile(`${nativeDirectory}/${fileName}`, authenticated);
        if (sizeBytes !== parent.sizeBytes || `sha256:${hash.digest('hex')}` !== parent.contentDigest) throw new DatabaseAdapterError('NEO4J_BACKUP_PARENT_DIGEST_MISMATCH', 'Neo4j differential parent bytes do not match the authenticated Artifact.', { category: 'integrity' });
        previousHighest = parent.highestTransactionId;
        previousStoreFormat = parent.storeFormat;
      }
      const beforeFiles = await context.listNativeDirectory(nativeDirectory);
      const beforeNames = new Set(beforeFiles.map((entry) => entry.name));
      if (beforeFiles.length !== parents.length || parents.some((parent) => !beforeNames.has(parent.fileName))) throw new DatabaseAdapterError('NEO4J_BACKUP_PARENT_SET_INVALID', 'The owned Neo4j native directory does not contain the exact authenticated parent set.', { category: 'integrity' });
      nativeTemporaryDirectory = await context.createNativeTemporaryDirectory();
      if ((await context.listNativeDirectory(nativeTemporaryDirectory)).length) throw new DatabaseAdapterError('NEO4J_BACKUP_TEMPORARY_DIRECTORY_INVALID', 'The owned Neo4j native temporary directory is not empty.', { category: 'integrity' });
      const args = [
        'database', 'backup', `--to-path=${nativeDirectory}`, `--temp-path=${nativeTemporaryDirectory}`,
        `--type=${requestedMode === 'full' ? 'FULL' : 'DIFF'}`,
        `--from=${plan.execution.backupAddresses.join(',')}`,
        `--include-metadata=${plan.execution.metadataPolicy}`,
        '--compress=true'
      ];
      if (requestedMode === 'differential') {
        if (plan.execution.preferDiffAsParent !== true) throw new DatabaseAdapterError('NEO4J_DIFFERENTIAL_VERSION_UNSUPPORTED', 'This Neo4j release cannot safely maintain the required differential parent chain.', { category: 'compatibility' });
        args.push('--prefer-diff-as-parent');
      }
      args.push(database.name);
      const backup = await command(context, plan.connection, plan.connection.neo4jAdminPath, args, { timeoutMs: MAX_BACKUP_TIMEOUT_MS });
      if (backup.exitCode !== 0) throw new DatabaseAdapterError('NEO4J_ONLINE_BACKUP_FAILED', 'neo4j-admin could not create the online database backup.', { category: 'execution', retryable: true });
      const afterFiles = await context.listNativeDirectory(nativeDirectory);
      const created = afterFiles.filter((entry) => !beforeNames.has(entry.name));
      if (created.length !== 1 || afterFiles.length !== beforeFiles.length + 1) throw new DatabaseAdapterError('NEO4J_BACKUP_ARTIFACT_AMBIGUOUS', 'Neo4j online backup did not create exactly one new native artifact.', { category: 'integrity' });
      const nativeFileName = nativeArtifactName(created[0].name);
      if (!Number.isSafeInteger(created[0].sizeBytes) || created[0].sizeBytes < 1 || created[0].sizeBytes > MAX_DUMP_BYTES) throw new DatabaseAdapterError('NEO4J_BACKUP_MEDIA_INVALID', 'The Neo4j online backup is not a supported regular file.', { category: 'capacity' });
      const nativeFile = `${nativeDirectory}/${nativeFileName}`;
      const inspected = await command(context, plan.connection, plan.connection.neo4jAdminPath, ['database', 'backup', `--inspect-path=${nativeFile}`]);
      const inspectionText = `${inspected.stdout}\n${inspected.stderr}`.trim();
      const inspection = parseOnlineBackupInspection(inspectionText);
      if (inspection.databaseName !== database.name || inspection.databaseId !== database.databaseId) throw new DatabaseAdapterError('NEO4J_BACKUP_DATABASE_IDENTITY_CHANGED', 'The native backup artifact belongs to a different Neo4j database.', { category: 'integrity' });
      if (requestedMode === 'full' && inspection.backupMode !== 'full') throw new DatabaseAdapterError('NEO4J_BACKUP_TYPE_CHANGED', 'Neo4j returned a differential artifact for a requested full backup.', { category: 'integrity' });
      if (inspection.backupMode === 'differential') {
        if (previousHighest === null || previousStoreFormat !== inspection.storeFormat) throw new DatabaseAdapterError('NEO4J_BACKUP_CHAIN_FORMAT_CHANGED', 'Neo4j differential backup store format does not match its authenticated parent chain.', { category: 'consistency' });
        const empty = inspection.lowestTransactionId === 0 && inspection.highestTransactionId === 0;
        const parent = parents.at(-1);
        const firstDifferentialOverlap = parent?.backupMode === 'full' && supportsFirstDifferentialOverlap(before.version);
        const contiguous = firstDifferentialOverlap ? inspection.lowestTransactionId <= previousHighest + 1 : inspection.lowestTransactionId === previousHighest + 1;
        if (!empty && (!contiguous || inspection.highestTransactionId < previousHighest)) throw new DatabaseAdapterError('NEO4J_BACKUP_CHAIN_GAP', 'Neo4j returned a discontinuous differential transaction range.', { category: 'consistency' });
      }
      await context.copyNativeFileToLocal(nativeFile, destination);
      const stat = await this.fileSystem.lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== created[0].sizeBytes) throw new DatabaseAdapterError('NEO4J_BACKUP_MEDIA_INVALID', 'The copied Neo4j online backup does not match native file evidence.', { category: 'integrity' });
      const digest = await digestFile(this.fileSystem, destination);
      const after = await readDiscovery(context, plan.connection);
      const afterDatabase = onlineDatabaseEvidence(after, database.name);
      if (after.deploymentFingerprint !== before.deploymentFingerprint || after.topologyFingerprint !== before.topologyFingerprint || afterDatabase.databaseId !== database.databaseId) throw new DatabaseAdapterError('NEO4J_DATABASE_IDENTITY_CHANGED', 'Neo4j database identity changed while the online backup was created.', { category: 'consistency' });
      return {
        filePath: destination, nativeFileName, sizeBytes: stat.size, digest,
        inspectionDigest: stableDigest(inspection), inspection,
        backupMode: inspection.backupMode, noChange: inspection.backupMode === 'differential' && inspection.lowestTransactionId === 0 && inspection.highestTransactionId === 0,
        database, edition: before.edition, version: before.version.text,
        deploymentFingerprint: before.deploymentFingerprint, topologyFingerprint: before.topologyFingerprint,
        metadataScope: plan.expected.metadataScope
      };
    } catch (error) {
      await this.fileSystem.rm(destination, { force: true }).catch(() => {});
      if (error instanceof DatabaseAdapterError) throw error;
      throw new DatabaseAdapterError('NEO4J_ONLINE_BACKUP_FAILED', 'DeployerX could not create the Neo4j Enterprise online backup.', { category: 'execution', retryable: true });
    } finally {
      if (nativeTemporaryDirectory) await context.removeNativeDirectory(nativeTemporaryDirectory);
      if (nativeDirectory) await context.removeNativeDirectory(nativeDirectory);
    }
  }

  async aggregateOnlineBackupMedia(context = {}, request = {}, destinationPath) {
    const connection = normalizeConfig(request.connection);
    const version = parseVersion(request.productVersion);
    const database = databaseName(request.databaseName, 'Neo4j aggregate database');
    const databaseId = requiredText(request.databaseId, 'Neo4j aggregate database ID', 200);
    const chain = Array.isArray(request.chain) ? request.chain : [];
    if (!chain.length || chain[0]?.backupMode !== 'full' || chain.slice(1).some((entry) => entry.backupMode !== 'differential')) throw new DatabaseAdapterError('NEO4J_AGGREGATE_CHAIN_INVALID', 'Neo4j aggregation requires a complete full and differential chain.', { category: 'integrity' });
    if (typeof context.createNativeTemporaryDirectory !== 'function' || typeof context.writeNativeFile !== 'function' || typeof context.listNativeDirectory !== 'function' || typeof context.copyNativeFileToLocal !== 'function' || typeof context.removeNativeDirectory !== 'function') throw new DatabaseAdapterError('NEO4J_EXECUTION_CONTEXT_INVALID', 'Neo4j aggregation requires an ownership-fenced local or SSH media executor.', { category: 'compatibility' });
    const destination = path.resolve(requiredText(destinationPath, 'Neo4j aggregate local destination'));
    if (await this.fileSystem.lstat(destination).catch(() => null)) throw new DatabaseAdapterError('NEO4J_AGGREGATE_DESTINATION_EXISTS', 'The Neo4j aggregate staging destination already exists.', { category: 'integrity' });
    let nativeDirectory = null;
    let nativeTemporaryDirectory = null;
    try {
      nativeDirectory = await context.createNativeTemporaryDirectory({ ownerType: 'neo4j-aggregation', ownerId: context.aggregationRunId || null });
      let totalBytes = 0;
      const names = new Set();
      for (const entry of chain) {
        const fileName = nativeArtifactName(entry.fileName);
        if (names.has(fileName) || entry.databaseId !== databaseId || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || !/^sha256:[0-9a-f]{64}$/.test(String(entry.contentDigest || '')) || !/^[A-Za-z0-9._+-]+$/.test(String(entry.storeFormat || '')) || typeof entry.open !== 'function') throw new DatabaseAdapterError('NEO4J_AGGREGATE_CHAIN_INVALID', 'Neo4j aggregation chain media is incomplete or inconsistent.', { category: 'integrity' });
        const input = await entry.open();
        if (!input || typeof input[Symbol.asyncIterator] !== 'function') throw new DatabaseAdapterError('NEO4J_AGGREGATE_STREAM_INVALID', 'A Neo4j aggregation chain stream is unavailable.', { category: 'integrity' });
        const hash = crypto.createHash('sha256');
        let fileBytes = 0;
        const authenticated = (async function* authenticateAggregateInput() {
          for await (const raw of input) {
            if (context.signal?.aborted) throw new DatabaseAdapterError('NEO4J_AGGREGATE_CANCELED', 'Neo4j aggregation was canceled.', { category: 'canceled' });
            const chunk = Buffer.from(raw);
            fileBytes += chunk.length;
            totalBytes += chunk.length;
            if (fileBytes > entry.sizeBytes || totalBytes > MAX_DUMP_BYTES) throw new DatabaseAdapterError('NEO4J_AGGREGATE_SIZE_INVALID', 'Neo4j aggregation input exceeds its authenticated size.', { category: 'integrity' });
            hash.update(chunk);
            await context.onAggregationProgress?.({ bytesWritten: totalBytes, bytesTotal: request.totalBytes });
            yield chunk;
          }
        })();
        await context.writeNativeFile(`${nativeDirectory}/${fileName}`, authenticated);
        if (fileBytes !== entry.sizeBytes || `sha256:${hash.digest('hex')}` !== entry.contentDigest) throw new DatabaseAdapterError('NEO4J_AGGREGATE_DIGEST_MISMATCH', 'Neo4j aggregation input bytes do not match the authenticated Artifact.', { category: 'integrity' });
        names.add(fileName);
      }
      const before = await context.listNativeDirectory(nativeDirectory);
      if (before.length !== chain.length || before.some((entry) => !names.has(entry.name))) throw new DatabaseAdapterError('NEO4J_AGGREGATE_CHAIN_INVALID', 'The owned Neo4j aggregate directory does not contain the exact authenticated chain.', { category: 'integrity' });
      nativeTemporaryDirectory = await context.createNativeTemporaryDirectory();
      if ((await context.listNativeDirectory(nativeTemporaryDirectory)).length) throw new DatabaseAdapterError('NEO4J_AGGREGATE_TEMPORARY_DIRECTORY_INVALID', 'The owned Neo4j aggregate temporary directory is not empty.', { category: 'integrity' });
      const args = version.major === 5
        ? ['database', 'aggregate-backup', `--from-path=${nativeDirectory}`, `--temp-path=${nativeTemporaryDirectory}`, '--keep-old-backup=true', database]
        : ['backup', 'aggregate', `--from-path=${nativeDirectory}`, `--temp-path=${nativeTemporaryDirectory}`, '--keep-old-backup=true', database];
      const aggregated = await command(context, connection, connection.neo4jAdminPath, args, { timeoutMs: MAX_BACKUP_TIMEOUT_MS });
      if (aggregated.exitCode !== 0) throw new DatabaseAdapterError('NEO4J_AGGREGATE_FAILED', 'neo4j-admin could not aggregate the native backup chain.', { category: 'execution', retryable: true });
      const after = await context.listNativeDirectory(nativeDirectory);
      const created = after.filter((entry) => !names.has(entry.name));
      if (created.length !== 1 || after.length !== before.length + 1 || before.some((entry) => !after.some((candidate) => candidate.name === entry.name && candidate.sizeBytes === entry.sizeBytes))) throw new DatabaseAdapterError('NEO4J_AGGREGATE_RESULT_AMBIGUOUS', 'Neo4j aggregation did not preserve the exact source chain and create one aggregate.', { category: 'integrity' });
      const fileName = nativeArtifactName(created[0].name);
      if (!Number.isSafeInteger(created[0].sizeBytes) || created[0].sizeBytes < 1 || created[0].sizeBytes > MAX_DUMP_BYTES) throw new DatabaseAdapterError('NEO4J_AGGREGATE_MEDIA_INVALID', 'The Neo4j aggregate is not a supported regular file.', { category: 'capacity' });
      const nativeFile = `${nativeDirectory}/${fileName}`;
      const inspected = await command(context, connection, connection.neo4jAdminPath, ['database', 'backup', `--inspect-path=${nativeFile}`]);
      const inspection = parseOnlineBackupInspection(`${inspected.stdout}\n${inspected.stderr}`.trim());
      const tail = chain.at(-1);
      if (inspection.databaseName !== database || inspection.databaseId !== databaseId || inspection.backupMode !== 'full' || inspection.storeFormat !== tail.storeFormat || inspection.highestTransactionId !== tail.highestTransactionId) throw new DatabaseAdapterError('NEO4J_AGGREGATE_IDENTITY_INVALID', 'The Neo4j aggregate does not match the authenticated chain identity and transaction boundary.', { category: 'integrity' });
      await context.copyNativeFileToLocal(nativeFile, destination);
      const stat = await this.fileSystem.lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== created[0].sizeBytes) throw new DatabaseAdapterError('NEO4J_AGGREGATE_MEDIA_INVALID', 'The copied Neo4j aggregate does not match native file evidence.', { category: 'integrity' });
      return { filePath: destination, nativeFileName: fileName, sizeBytes: stat.size, digest: await digestFile(this.fileSystem, destination), inspection, inspectionDigest: stableDigest(inspection), productVersion: version.text, databaseName: database, databaseId, storeFormat: inspection.storeFormat };
    } catch (error) {
      await this.fileSystem.rm(destination, { force: true }).catch(() => {});
      if (error instanceof DatabaseAdapterError) throw error;
      throw new DatabaseAdapterError('NEO4J_AGGREGATE_FAILED', 'DeployerX could not aggregate the Neo4j native backup chain.', { category: 'execution', retryable: true });
    } finally {
      if (nativeTemporaryDirectory) await context.removeNativeDirectory(nativeTemporaryDirectory);
      if (nativeDirectory) await context.removeNativeDirectory(nativeDirectory);
    }
  }

  async openBackup(context = {}, plan = {}) {
    let directory = null;
    try {
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, 'deployerx-neo4j-adapter-'));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const media = await this.createBackupMedia(context, plan, path.join(directory, `${plan.expected.database.name}.dump`));
      const createReadStream = this.createReadStream;
      const fileSystem = this.fileSystem;
      const content = (async function* streamDump() {
        try { for await (const chunk of createReadStream(media.filePath, { highWaterMark: 64 * 1024, signal: context.signal })) yield Buffer.from(chunk); }
        finally { await fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {}); }
      })();
      return { content, artifact: plan.artifact, metadata: { ...media, filePath: undefined } };
    } catch (error) {
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async executeBackup(context = {}, plan = {}, sink) {
    if (!sink || typeof sink.write !== 'function') throw new TypeError('Neo4j backup artifact sink is required.');
    const opened = await this.openBackup(context, plan);
    const stored = await sink.write({ ...opened.artifact, content: opened.content, metadata: opened.metadata });
    return { status: 'succeeded', artifacts: [stored || opened.artifact], consistency: plan.consistency, metadata: opened.metadata };
  }

  async planRestore(context = {}, request = {}) {
    if (request.mode !== 'alternate' || request.confirmation !== 'RESTORE_NEO4J_ALTERNATE') throw new DatabaseAdapterError('NEO4J_RESTORE_MODE_UNSUPPORTED', 'Neo4j recovery currently supports a confirmed empty alternate target only.', { category: 'compatibility' });
    const targetDatabase = databaseName(request.targetDatabase, 'Neo4j target database');
    const source = request.source;
    const artifact = source?.artifact;
    const enterprise = source?.kind === 'neo4j-enterprise-backup';
    if (!source || !['neo4j-offline-dump', 'neo4j-enterprise-backup'].includes(source.kind) || source.adapterId !== ADAPTER_ID || !['database-store-only-no-rbac', 'database-store-and-rbac'].includes(source.metadataScope) || !source.database?.databaseId || !source.deploymentFingerprint || !source.topologyFingerprint) throw new DatabaseAdapterError('NEO4J_RESTORE_METADATA_INVALID', 'The authenticated Neo4j recovery metadata is incomplete.', { category: 'integrity' });
    if (!enterprise && source.metadataScope !== 'database-store-only-no-rbac') throw new DatabaseAdapterError('NEO4J_RESTORE_METADATA_INVALID', 'The authenticated Neo4j dump metadata scope is invalid.', { category: 'integrity' });
    if (enterprise) {
      if (source.edition !== 'enterprise' || targetDatabase !== source.database.name || !Array.isArray(source.chain) || !source.chain.length) throw new DatabaseAdapterError('NEO4J_RESTORE_CHAIN_INVALID', 'Neo4j Enterprise restore requires a complete native chain and the authenticated database name.', { category: 'integrity' });
      if (source.metadataScope !== 'database-store-only-no-rbac') throw new DatabaseAdapterError('NEO4J_RESTORE_RBAC_UNSUPPORTED', 'This Neo4j backup contains users or roles. Restore requires a separate authenticated RBAC script preview and confirmation that is not available yet.', { category: 'compatibility' });
      let previous = null;
      let totalBytes = 0;
      const filenames = new Set();
      for (const entry of source.chain) {
        const native = entry?.artifact;
        const range = entry?.transactionRange;
        if (!entry?.pointId || !['full', 'differential'].includes(entry.backupMode) || !Number.isSafeInteger(range?.lowestTransactionId) || !Number.isSafeInteger(range?.highestTransactionId) || range.lowestTransactionId < 0 || range.highestTransactionId < range.lowestTransactionId
          || !Number.isSafeInteger(native?.sizeBytes) || native.sizeBytes < 1 || native.sizeBytes > MAX_DUMP_BYTES || !/^sha256:[0-9a-f]{64}$/.test(String(native.contentDigest || '')) || !/^sha256:[0-9a-f]{64}$/.test(String(native.inspectionDigest || '')) || !/^[A-Za-z0-9._+-]{1,200}$/.test(String(native.storeFormat || '')) || native.nativeKind !== 'neo4j-backup' || nativeArtifactName(native.nativeFileName) !== native.nativeFileName || filenames.has(native.nativeFileName)
          || (previous && (native.storeFormat !== previous.artifact.storeFormat || range.highestTransactionId < previous.transactionRange.highestTransactionId))) throw new DatabaseAdapterError('NEO4J_RESTORE_CHAIN_INVALID', 'The authenticated Neo4j native restore chain is incomplete or inconsistent.', { category: 'integrity' });
        if (previous) {
          const firstOverlap = previous.backupMode === 'full' && supportsFirstDifferentialOverlap(source.productVersion);
          const contiguous = firstOverlap ? range.lowestTransactionId <= previous.transactionRange.highestTransactionId + 1 : range.lowestTransactionId === previous.transactionRange.highestTransactionId + 1;
          if (!contiguous) throw new DatabaseAdapterError('NEO4J_RESTORE_CHAIN_GAP', 'The authenticated Neo4j native restore chain is discontinuous.', { category: 'integrity' });
        }
        totalBytes += native.sizeBytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_DUMP_BYTES) throw new DatabaseAdapterError('NEO4J_RESTORE_SIZE_INVALID', 'The Neo4j native restore chain exceeds the supported staging limit.', { category: 'capacity' });
        filenames.add(native.nativeFileName);
        previous = entry;
      }
      if (source.chain[0].backupMode !== 'full' || source.chain.slice(1).some((entry) => entry.backupMode !== 'differential')) throw new DatabaseAdapterError('NEO4J_RESTORE_CHAIN_INVALID', 'The Neo4j native restore chain must begin with one full backup followed by differentials.', { category: 'integrity' });
    } else if (!Number.isSafeInteger(artifact?.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes > MAX_DUMP_BYTES || !/^sha256:[0-9a-f]{64}$/.test(String(artifact.contentDigest || '')) || !/^sha256:[0-9a-f]{64}$/.test(String(artifact.inspectionDigest || '')) || !/^[A-Za-z0-9._+-]{1,200}$/.test(String(artifact.storeFormat || ''))) throw new DatabaseAdapterError('NEO4J_RESTORE_ARTIFACT_INVALID', 'The authenticated Neo4j dump identity is incomplete.', { category: 'integrity' });
    const sourceVersion = parseVersion(source.productVersion);
    const connection = normalizeConfig(request.connection);
    const target = await readDiscovery(context, connection);
    if (target.deploymentFingerprint === source.deploymentFingerprint) throw new DatabaseAdapterError('NEO4J_RESTORE_TARGET_IS_SOURCE', 'Choose a Neo4j deployment different from the protected source.', { category: 'conflict' });
    if (target.edition !== source.edition || target.version.major !== sourceVersion.major || target.adminVersion.major !== sourceVersion.major) throw new DatabaseAdapterError('NEO4J_RESTORE_COMPATIBILITY_INVALID', 'The alternate Neo4j target must use the same edition and supported product major as the backup.', { category: 'compatibility' });
    if (target.databases.some((database) => database.name.toLowerCase() === targetDatabase)) throw new DatabaseAdapterError('NEO4J_RESTORE_TARGET_DATABASE_EXISTS', 'The alternate Neo4j database name already exists.', { category: 'conflict' });
    if (target.databases.some((database) => database.databaseId === source.database.databaseId)) throw new DatabaseAdapterError('NEO4J_RESTORE_DATABASE_ID_EXISTS', 'The alternate deployment already contains the protected database identity.', { category: 'conflict' });
    if (target.servers.some((server) => server.state !== 'enabled' || !['available', 'healthy'].includes(server.health))) throw new DatabaseAdapterError('NEO4J_RESTORE_TARGET_UNHEALTHY', 'Every alternate Neo4j target server must be enabled and healthy.', { category: 'connectivity', retryable: true });
    const system = target.databases.filter((database) => database.system);
    if (!system.length || system.some((database) => database.currentStatus !== 'online' || database.requestedStatus !== 'online')) throw new DatabaseAdapterError('NEO4J_RESTORE_SYSTEM_DATABASE_UNHEALTHY', 'The alternate Neo4j system database must be online before recovery.', { category: 'connectivity', retryable: true });
    return {
      version: 1,
      operation: enterprise ? 'neo4j-enterprise-alternate-restore' : 'neo4j-offline-alternate-load',
      confirmation: request.confirmation,
      connection,
      targetDatabase,
      source: structuredClone(source),
      target: {
        edition: target.edition,
        version: target.version.text,
        deploymentFingerprint: target.deploymentFingerprint,
        topologyFingerprint: target.topologyFingerprint
      },
      resumable: false
    };
  }

  async executeRestore(context = {}, plan = {}, source) {
    const enterprise = plan.operation === 'neo4j-enterprise-alternate-restore';
    if (!['neo4j-offline-alternate-load', 'neo4j-enterprise-alternate-restore'].includes(plan.operation) || !source || typeof source.open !== 'function') throw new DatabaseAdapterError('NEO4J_RESTORE_PLAN_INVALID', 'The Neo4j alternate restore plan is invalid.', { category: 'integrity' });
    if (typeof context.createNativeTemporaryDirectory !== 'function' || typeof context.writeNativeFile !== 'function' || typeof context.removeNativeDirectory !== 'function' || typeof context.preserveNativeDirectory !== 'function') throw new DatabaseAdapterError('NEO4J_RESTORE_CONTEXT_INVALID', 'Neo4j recovery requires an ownership-fenced local or SSH executor.', { category: 'compatibility' });
    let nativeDirectory = null;
    let mutationStarted = false;
    try {
      const before = await readDiscovery(context, plan.connection);
      if (before.deploymentFingerprint !== plan.target.deploymentFingerprint || before.topologyFingerprint !== plan.target.topologyFingerprint || before.edition !== plan.target.edition || before.version.text !== plan.target.version) throw new DatabaseAdapterError('NEO4J_RESTORE_TARGET_CHANGED', 'The alternate Neo4j deployment changed after recovery planning.', { category: 'integrity' });
      if (before.databases.some((database) => database.name.toLowerCase() === plan.targetDatabase || database.databaseId === plan.source.database.databaseId)) throw new DatabaseAdapterError('NEO4J_RESTORE_TARGET_CHANGED', 'The alternate Neo4j database target is no longer empty.', { category: 'conflict' });
      nativeDirectory = await context.createNativeTemporaryDirectory({ ownerType: 'neo4j-restore', ownerId: context.restoreRunId || null });
      await context.onStageAllocated?.(nativeDirectory);
      const restoreArtifacts = enterprise ? plan.source.chain.map((entry) => ({ ...entry.artifact, inspection: entry.transactionRange, backupMode: entry.backupMode })) : [plan.source.artifact];
      const totalBytes = restoreArtifacts.reduce((sum, item) => sum + item.sizeBytes, 0);
      let sizeBytes = 0;
      const contentDigests = [];
      for (const restoreArtifact of restoreArtifacts) {
        const nativeName = enterprise ? restoreArtifact.nativeFileName : `${plan.targetDatabase}.dump`;
        const nativeFile = `${nativeDirectory}/${nativeName}`;
        const hash = crypto.createHash('sha256');
        let artifactBytes = 0;
        const input = await source.open(restoreArtifact.path);
        if (!input || typeof input[Symbol.asyncIterator] !== 'function') throw new DatabaseAdapterError('NEO4J_RESTORE_STREAM_INVALID', 'An authenticated Neo4j recovery stream is unavailable.', { category: 'integrity' });
        const authenticated = (async function* authenticate() {
          for await (const raw of input) {
            if (context.signal?.aborted) throw new DatabaseAdapterError('NEO4J_RESTORE_CANCELED', 'The Neo4j recovery was canceled.', { category: 'canceled' });
            const chunk = Buffer.from(raw);
            artifactBytes += chunk.length;
            sizeBytes += chunk.length;
            if (artifactBytes > restoreArtifact.sizeBytes || sizeBytes > totalBytes || sizeBytes > MAX_DUMP_BYTES) throw new DatabaseAdapterError('NEO4J_RESTORE_SIZE_INVALID', 'The Neo4j recovery stream exceeds its authenticated size.', { category: 'integrity' });
            hash.update(chunk);
            await context.onRestoreProgress?.({ bytesWritten: sizeBytes, bytesTotal: totalBytes });
            yield chunk;
          }
        })();
        await context.writeNativeFile(nativeFile, authenticated);
        const artifactDigest = `sha256:${hash.digest('hex')}`;
        if (artifactBytes !== restoreArtifact.sizeBytes || artifactDigest !== restoreArtifact.contentDigest) throw new DatabaseAdapterError('NEO4J_RESTORE_DIGEST_MISMATCH', 'Neo4j recovery bytes do not match the authenticated Artifact.', { category: 'integrity' });
        contentDigests.push(artifactDigest);
        const inspection = enterprise
          ? await command(context, plan.connection, plan.connection.neo4jAdminPath, ['database', 'backup', `--inspect-path=${nativeFile}`])
          : await command(context, plan.connection, plan.connection.neo4jAdminPath, ['database', 'info', `--from-path=${nativeDirectory}`, plan.targetDatabase]);
        const inspectionText = `${inspection.stdout}\n${inspection.stderr}`.trim();
        if (enterprise) {
          const nativeEvidence = parseOnlineBackupInspection(inspectionText);
          if (nativeEvidence.databaseName !== plan.source.database.name || nativeEvidence.databaseId !== plan.source.database.databaseId || nativeEvidence.backupMode !== restoreArtifact.backupMode || nativeEvidence.storeFormat !== restoreArtifact.storeFormat || stableDigest(nativeEvidence) !== restoreArtifact.inspectionDigest) throw new DatabaseAdapterError('NEO4J_RESTORE_MEDIA_IDENTITY_CHANGED', 'Target-side native backup inspection does not match the authenticated chain evidence.', { category: 'integrity' });
        } else {
          const databaseInfo = parseDatabaseInfo(inspectionText);
          if (databaseInfo.storeFormat !== restoreArtifact.storeFormat || stableDigest({ storeFormat: databaseInfo.storeFormat }) !== restoreArtifact.inspectionDigest) throw new DatabaseAdapterError('NEO4J_RESTORE_MEDIA_IDENTITY_CHANGED', 'Target-side dump inspection does not match the authenticated store-format evidence.', { category: 'integrity' });
        }
      }
      const finalPreflight = await readDiscovery(context, plan.connection);
      if (finalPreflight.deploymentFingerprint !== plan.target.deploymentFingerprint || finalPreflight.topologyFingerprint !== plan.target.topologyFingerprint || finalPreflight.databases.some((database) => database.name.toLowerCase() === plan.targetDatabase || database.databaseId === plan.source.database.databaseId)) throw new DatabaseAdapterError('NEO4J_RESTORE_TARGET_CHANGED', 'The alternate Neo4j target changed before native load.', { category: 'conflict' });
      await context.onMutationStarted?.({ nativeDirectory, targetDatabase: plan.targetDatabase });
      mutationStarted = true;
      await command(context, plan.connection, plan.connection.neo4jAdminPath, enterprise
        ? ['database', 'restore', `--from-path=${nativeDirectory}`, '--overwrite-destination=false', plan.targetDatabase]
        : ['database', 'load', plan.targetDatabase, `--from-path=${nativeDirectory}`, '--overwrite-destination=false'], { timeoutMs: MAX_BACKUP_TIMEOUT_MS });
      const check = await command(context, plan.connection, plan.connection.neo4jAdminPath, ['database', 'check', plan.targetDatabase], { timeoutMs: MAX_BACKUP_TIMEOUT_MS });
      const checkText = `${check.stdout}\n${check.stderr}`.trim();
      if (!checkText || checkText.length > MAX_OUTPUT_BYTES) throw new DatabaseAdapterError('NEO4J_RESTORE_CHECK_INVALID', 'neo4j-admin did not return bounded consistency-check evidence.', { category: 'integrity' });
      await context.removeNativeDirectory(nativeDirectory);
      nativeDirectory = null;
      return {
        status: 'succeeded',
        targetDatabase: plan.targetDatabase,
        sizeBytes,
        contentDigest: enterprise ? stableDigest(contentDigests) : contentDigests[0],
        storeFormat: restoreArtifacts[0].storeFormat,
        inspectionDigest: enterprise ? stableDigest(restoreArtifacts.map((item) => item.inspectionDigest)) : restoreArtifacts[0].inspectionDigest,
        artifactCount: restoreArtifacts.length,
        consistencyCheckDigest: stableDigest(checkText),
        target: structuredClone(plan.target),
        serviceStarted: false
      };
    } catch (error) {
      if (nativeDirectory) {
        if (mutationStarted) await context.preserveNativeDirectory(nativeDirectory);
        else await context.removeNativeDirectory(nativeDirectory).catch(() => {});
      }
      if (error instanceof DatabaseAdapterError) throw error;
      throw new DatabaseAdapterError('NEO4J_RESTORE_FAILED', 'DeployerX could not complete the Neo4j alternate-target recovery.', { category: 'restore', retryable: false });
    }
  }

  async validateRestore(_context = {}, restored = {}) {
    const valid = restored.status === 'succeeded' && restored.serviceStarted === false && Number.isSafeInteger(restored.sizeBytes) && restored.sizeBytes > 0 && /^sha256:[0-9a-f]{64}$/.test(String(restored.contentDigest || '')) && /^sha256:[0-9a-f]{64}$/.test(String(restored.consistencyCheckDigest || ''));
    return {
      valid,
      status: valid ? 'succeeded' : 'failed',
      nativeIntegrityValidation: valid,
      checks: [
        { id: 'artifact-digest', status: valid ? 'pass' : 'fail', safeMessage: valid ? 'The restored media matched its authenticated SHA-256 evidence.' : 'The restored media identity is incomplete.' },
        { id: 'native-consistency', status: valid ? 'pass' : 'fail', safeMessage: valid ? 'neo4j-admin completed the offline database consistency check.' : 'Native Neo4j consistency evidence is unavailable.' },
        { id: 'service-state', status: restored.serviceStarted === false ? 'pass' : 'fail', safeMessage: restored.serviceStarted === false ? 'The recovered database remains offline for operator-controlled activation.' : 'The recovered database service state is unsafe.' }
      ]
    };
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function authEnvironmentContents(username, password, address) {
  const user = requiredText(username, 'Neo4j username', 256);
  const secret = requiredText(password, 'Neo4j password', 16384);
  if (/[\r\n]/.test(user) || /[\r\n]/.test(secret)) throw new TypeError('Neo4j credentials cannot contain line breaks.');
  return `export NEO4J_USERNAME=${shellSingleQuote(user)}\nexport NEO4J_PASSWORD=${shellSingleQuote(secret)}\nexport NEO4J_URI=${shellSingleQuote(address)}\n`;
}

class Neo4jConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new Neo4jAdapter(), sessionFactory = openSshExecutionSession, localCommandRunner = runLocalCommand } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.sessionFactory = sessionFactory;
    this.localCommandRunner = localCommandRunner;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { includeDeleted: false, limit: 1000 }))
      .filter((record) => record.adapterId === ADAPTER_ID)
      .map((record) => ({ ...record, capabilities: this.adapter.manifest().capabilities, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'Neo4j connection name', 200);
    const username = optionalText(input.username, 'Neo4j username', 256);
    const password = input.password === undefined || input.password === null || input.password === '' ? null : requiredText(input.password, 'Neo4j password', 16384);
    if (Boolean(username) !== Boolean(password)) throw new TypeError('Neo4j authentication requires both username and password.');
    let passwordRef = null;
    try {
      if (password) passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({
        expectedEdition: input.expectedEdition, executionMode: input.executionMode, sshConnectionId: input.sshConnectionId,
        address: input.address, username, passwordSecretRefId: passwordRef?.id, neo4jPath: input.neo4jPath,
        neo4jAdminPath: input.neo4jAdminPath, cypherShellPath: input.cypherShellPath, timeoutMs: input.timeoutMs
      });
      if (config.executionMode === 'ssh') await this.#validatedSshConnection(tenant, config.sshConnectionId);
      const { passwordSecretRefId: _secretRefId, ...endpoint } = config;
      return await this.controlDatabase.transaction((transaction) => {
        if (passwordRef) transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device', endpoint,
          secretRefIds: passwordRef ? [passwordRef.id] : [], trust: { mode: config.executionMode, fingerprint: null }, workerAffinity: [`device:${this.deviceId}`], lastTest: null
        });
      });
    } catch (error) {
      if (passwordRef) await this.secretStore.delete({ workspaceId: tenant, id: passwordRef.id }).catch(() => {});
      throw error;
    }
  }

  config(connection) {
    return normalizeConfig({ ...connection.endpoint, passwordSecretRefId: connection.secretRefIds?.[0] || null });
  }

  async #validatedSshConnection(workspaceId, connectionId) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, connectionId);
    if (!connection || connection.adapterId !== 'deployerx.connection.ssh') throw new Error('The paired SSH connection was not found.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('The paired SSH connection belongs to another device.');
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new Error('Test and approve the paired SSH connection before Neo4j discovery.');
    return connection;
  }

  async withExecution(workspaceId, connection, signal, callback) {
    const config = this.config(connection);
    let session = null;
    let authFile = null;
    let authEnvironment = {};
    const ownedNativeDirectories = new Set();
    try {
      if (config.executionMode === 'ssh') {
        const sshConnection = await this.#validatedSshConnection(workspaceId, config.sshConnectionId);
        session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal });
      }
      if (config.passwordSecretRefId) {
        const password = await this.secretStore.resolve({ workspaceId, id: config.passwordSecretRefId });
        if (session) {
          authFile = `/tmp/deployerx-neo4j-${crypto.randomBytes(16).toString('hex')}.env`;
          await session.writeFile(authFile, authEnvironmentContents(config.username, password, config.address), { mode: 0o600 });
        } else {
          authEnvironment = { NEO4J_USERNAME: config.username, NEO4J_PASSWORD: password, NEO4J_URI: config.address };
        }
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
            const timer = setTimeout(() => { session.close(); finish(new DatabaseAdapterError('NEO4J_COMMAND_TIMEOUT', 'A Neo4j native command timed out.', { category: 'timeout', retryable: true })); }, timeoutMs);
            const commandText = authFile
              ? commandFromArgs('sh', ['-c', '. "$1"; shift; exec "$@"', 'deployerx-neo4j', authFile, executable, ...args])
              : commandFromArgs(executable, args);
            session.run(commandText, { stdoutLimitBytes: MAX_OUTPUT_BYTES, stderrLimitBytes: MAX_OUTPUT_BYTES }).then((value) => finish(null, value), (error) => finish(error));
          })
          : (request) => this.localCommandRunner({ ...request, env: authEnvironment }),
        createNativeTemporaryDirectory: async (owner = null) => {
          let directory;
          if (session) {
            const created = await session.run(commandFromArgs('mktemp', ['-d', '/tmp/deployerx-neo4j-XXXXXXXXXX']), { stdoutLimitBytes: 4096, stderrLimitBytes: 4096 });
            directory = String(created.stdout || '').trim();
            if (!/^\/tmp\/deployerx-neo4j-[A-Za-z0-9]{6,32}$/.test(directory)) throw new DatabaseAdapterError('NEO4J_TEMPORARY_DIRECTORY_INVALID', 'The SSH host returned an invalid Neo4j temporary directory.', { category: 'integrity' });
          } else {
            directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-neo4j-'));
            await fs.chmod(directory, 0o700).catch(() => {});
          }
          const ownershipKey = session ? directory : path.resolve(path.normalize(directory));
          ownedNativeDirectories.add(ownershipKey);
          if (owner) {
            const ownerType = requiredText(owner.ownerType, 'Neo4j native owner type', 100);
            const ownerId = requiredText(owner.ownerId, 'Neo4j native owner ID', 200);
            const marker = JSON.stringify({ version: 1, workspaceId, ownerType, ownerId });
            if (session) await session.writeFile(`${directory}/.deployerx-owner.json`, marker, { mode: 0o600 });
            else await fs.writeFile(path.join(ownershipKey, '.deployerx-owner.json'), marker, { flag: 'wx', mode: 0o600 });
          }
          return directory.replace(/\\/g, '/');
        },
        copyNativeFileToLocal: async (sourcePath, destinationPath) => {
          const source = requiredText(sourcePath, 'Neo4j native source path');
          const destination = path.resolve(requiredText(destinationPath, 'Neo4j local staging path'));
          if (!session) {
            await fs.copyFile(path.normalize(source), destination, fsNative.constants.COPYFILE_EXCL);
            await fs.chmod(destination, 0o600).catch(() => {});
            return;
          }
          const streamed = await session.stream(commandFromArgs('cat', ['--', source]), { stderrLimitBytes: MAX_OUTPUT_BYTES });
          const output = fsNative.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
          try { await Promise.all([pipeline(streamed.stdout, output, signal ? { signal } : {}), streamed.completion]); }
          catch (error) {
            output.destroy();
            await fs.rm(destination, { force: true }).catch(() => {});
            throw error;
          }
        },
        writeNativeFile: async (destinationPath, content) => {
          const destination = requiredText(destinationPath, 'Neo4j native destination path');
          if (!content || typeof content[Symbol.asyncIterator] !== 'function') throw new TypeError('Neo4j native file content must be an async iterable.');
          const parent = session ? path.posix.dirname(destination) : path.resolve(path.dirname(path.normalize(destination)));
          if (!ownedNativeDirectories.has(parent)) throw new DatabaseAdapterError('NEO4J_TEMPORARY_DIRECTORY_NOT_OWNED', 'Neo4j refused to write outside an owned temporary directory.', { category: 'integrity' });
          if (session) {
            await session.writeFile(destination, content, { mode: 0o600 });
            return;
          }
          await pipeline(Readable.from(content), fsNative.createWriteStream(path.normalize(destination), { flags: 'wx', mode: 0o600 }), signal ? { signal } : {});
        },
        listNativeDirectory: async (directoryPath) => {
          const directory = requiredText(directoryPath, 'Neo4j native temporary directory');
          const ownershipKey = session ? directory : path.resolve(path.normalize(directory));
          if (!ownedNativeDirectories.has(ownershipKey)) throw new DatabaseAdapterError('NEO4J_TEMPORARY_DIRECTORY_NOT_OWNED', 'Neo4j refused to list an unowned temporary directory.', { category: 'integrity' });
          let entries;
          if (session) {
            const listed = await session.run(commandFromArgs('find', ['--', ownershipKey, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\t%y\t%s\n']), { stdoutLimitBytes: MAX_OUTPUT_BYTES, stderrLimitBytes: MAX_OUTPUT_BYTES });
            entries = String(listed.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
              const fields = line.split('\t');
              if (fields.length !== 3 || fields[1] !== 'f' || !/^(?:0|[1-9]\d*)$/.test(fields[2])) throw new DatabaseAdapterError('NEO4J_NATIVE_DIRECTORY_INVALID', 'The owned Neo4j directory contains a nested or special entry.', { category: 'integrity' });
              return { name: fields[0], sizeBytes: Number(fields[2]) };
            });
          } else {
            const listed = await fs.readdir(ownershipKey, { withFileTypes: true });
            entries = await Promise.all(listed.map(async (entry) => {
              const stat = await fs.lstat(path.join(ownershipKey, entry.name));
              if (!entry.isFile() || !stat.isFile() || stat.isSymbolicLink()) throw new DatabaseAdapterError('NEO4J_NATIVE_DIRECTORY_INVALID', 'The owned Neo4j directory contains a nested or special entry.', { category: 'integrity' });
              return { name: entry.name, sizeBytes: stat.size };
            }));
          }
          entries = entries.filter((entry) => entry.name !== '.deployerx-owner.json');
          if (entries.length > MAX_NATIVE_FILES || new Set(entries.map((entry) => entry.name)).size !== entries.length || entries.some((entry) => !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(entry.name) || entry.name.includes('..') || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0)) throw new DatabaseAdapterError('NEO4J_NATIVE_DIRECTORY_INVALID', 'The owned Neo4j directory listing is unsafe or exceeds supported limits.', { category: 'integrity' });
          return entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US')).map((entry) => ({ ...entry, path: `${directory}/${entry.name}` }));
        },
        preserveNativeDirectory: async (directoryPath) => {
          const directory = requiredText(directoryPath, 'Neo4j native temporary directory');
          const ownershipKey = session ? directory : path.resolve(path.normalize(directory));
          if (!ownedNativeDirectories.has(ownershipKey)) throw new DatabaseAdapterError('NEO4J_TEMPORARY_DIRECTORY_NOT_OWNED', 'Neo4j refused to preserve an unowned temporary directory.', { category: 'integrity' });
          ownedNativeDirectories.delete(ownershipKey);
          return ownershipKey;
        },
        removeNativeDirectory: async (directoryPath) => {
          const directory = requiredText(directoryPath, 'Neo4j native temporary directory');
          const ownershipKey = session ? directory : path.resolve(path.normalize(directory));
          if (!ownedNativeDirectories.has(ownershipKey)) throw new DatabaseAdapterError('NEO4J_TEMPORARY_DIRECTORY_NOT_OWNED', 'Neo4j refused to remove an unowned temporary directory.', { category: 'integrity' });
          if (session) await session.run(commandFromArgs('rm', ['-rf', '--', ownershipKey]), { ignoreAbort: true, stdoutLimitBytes: 4096, stderrLimitBytes: 4096 });
          else await fs.rm(ownershipKey, { recursive: true, force: true });
          ownedNativeDirectories.delete(ownershipKey);
        }
      };
      return await callback(context, config);
    } finally {
      let cleanupFailed = false;
      for (const directory of [...ownedNativeDirectories]) {
        try {
          if (session) await session.run(commandFromArgs('rm', ['-rf', '--', directory]), { ignoreAbort: true, stdoutLimitBytes: 4096, stderrLimitBytes: 4096 });
          else await fs.rm(path.normalize(directory), { recursive: true, force: true });
          ownedNativeDirectories.delete(directory);
        } catch { cleanupFailed = true; }
      }
      if (session && authFile) {
        try { await session.run(commandFromArgs('rm', ['-f', '--', authFile]), { ignoreAbort: true }); }
        catch { cleanupFailed = true; }
      }
      session?.close();
      if (cleanupFailed) throw new DatabaseAdapterError('NEO4J_CREDENTIAL_CLEANUP_FAILED', 'Temporary Neo4j credential cleanup could not be proven.', { category: 'integrity' });
    }
  }

  async test(workspaceId, connectionId, actorId = 'system', signal) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Neo4j connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This Neo4j connection belongs to another device.');
    const { result, inventory } = await this.withExecution(tenant, current, signal, async (context, config) => {
      const tested = await this.adapter.testConnection(context, config);
      if (tested.status !== 'success') return { result: tested, inventory: null };
      const pages = [];
      for await (const page of this.adapter.discover(context, { connection: config, kind: 'all' })) pages.push(page);
      if (pages.length !== 1 || pages[0].deploymentFingerprint !== tested.endpointIdentity.deploymentFingerprint || pages[0].topologyFingerprint !== tested.endpointIdentity.topologyFingerprint) throw new DatabaseAdapterError('NEO4J_INVENTORY_CHANGED', 'Neo4j identity changed while inventory was being captured.', { category: 'integrity' });
      return { result: tested, inventory: { version: 1, capturedAt: tested.testedAt, edition: pages[0].edition, productVersion: pages[0].version.text, deploymentFingerprint: pages[0].deploymentFingerprint, topologyFingerprint: pages[0].topologyFingerprint, databases: pages[0].databases, servers: pages[0].servers } };
    });
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const endpoint = result.status === 'success' ? { ...current.endpoint, expectedEdition: result.endpointIdentity.edition, expectedVersion: result.endpointIdentity.version, expectedDeploymentFingerprint: result.endpointIdentity.deploymentFingerprint, expectedTopologyFingerprint: result.endpointIdentity.topologyFingerprint } : current.endpoint;
    const trust = result.status === 'success' ? { mode: current.endpoint.executionMode, fingerprint: result.endpointIdentity.deploymentFingerprint, topologyFingerprint: result.endpointIdentity.topologyFingerprint, observedAt: result.testedAt } : current.trust;
    const updated = await this.controlDatabase.repository('connection').update(tenant, id, { endpoint, lastTest: result, trust, neo4jInventory: inventory || current.neo4jInventory || null, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection: updated, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Neo4j connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This Neo4j connection belongs to another device.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the Neo4j connection successfully before discovery.');
    return this.withExecution(tenant, current, input.signal, async (context, config) => {
      const pages = [];
      for await (const page of this.adapter.discover(context, { connection: config, kind: input.kind })) pages.push(page);
      return pages[0] || { items: [], nextCursor: null };
    });
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  MAX_DUMP_BYTES,
  RESTORE_CONFIRMATION,
  Neo4jAdapter,
  Neo4jConnectionService,
  authEnvironmentContents,
  databaseName,
  normalizeBackupAddress,
  normalizeConfig,
  normalizeOnlineExecution,
  normalizeDatabases,
  normalizeServers,
  offlineDatabaseEvidence,
  parseDatabaseInfo,
  parseOnlineBackupInspection,
  parseTsv,
  parseVersion,
  readDiscovery,
  runLocalCommand,
  selectedDatabase,
  stableDigest,
  supportsFirstDifferentialOverlap,
  supportsPreferDiffAsParent
};
