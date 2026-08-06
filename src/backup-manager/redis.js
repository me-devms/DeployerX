const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const net = require('net');
const path = require('path');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { NativeProcessError, NativeProcessRunner } = require('./native-process');

const ADAPTER_ID = 'deployerx.database.redis.native';
const ADAPTER_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30000;
const CLUSTER_SLOT_COUNT = 16384;
const MAX_CLUSTER_NODES = 1000;
const MAX_RDB_BACKUP_BYTES = 16 * 1024 * 1024 * 1024 * 1024;
const MAX_AOF_MANIFEST_BYTES = 1024 * 1024;
const BACKUP_STATES = new Set(['idle', 'pending', 'snapshotting', 'incrementing', 'sealed', 'failed']);
const TOPOLOGIES = new Set(['auto', 'standalone', 'replication', 'cluster']);

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function normalizeHost(value) {
  const input = requiredText(value, 'Redis host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('Redis host must be a hostname or IP address without a URI scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('Redis host is invalid.');
  return ascii;
}

function normalizePort(value) {
  const port = Number(value ?? 6379);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Redis port must be between 1 and 65535.');
  return port;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('Redis timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeAbsoluteFile(value, label) {
  const file = optionalText(value, label);
  if (!file) return null;
  if (!path.isAbsolute(file)) throw new TypeError(`${label} must be absolute.`);
  return path.normalize(file);
}

function normalizeExecutable(value) {
  const executable = value === undefined || value === null || value === '' ? 'redis-cli' : requiredText(value, 'redis-cli executable');
  if (path.win32.basename(executable).toLowerCase().replace(/[.]exe$/, '') !== 'redis-cli') throw new TypeError('Only the redis-cli executable may be configured.');
  return executable;
}

function normalizeServerExecutable(value) {
  const executable = value === undefined || value === null || value === '' ? 'redis-server' : requiredText(value, 'redis-server executable');
  if (path.win32.basename(executable).toLowerCase().replace(/[.]exe$/, '') !== 'redis-server') throw new TypeError('Only the redis-server executable may be configured for Redis recovery.');
  return executable;
}

function redisRestorePath(targetDirectory, executionId, suffix) {
  const owner = crypto.createHash('sha256').update(requiredText(executionId, 'Redis restore execution ID', 200)).digest('hex').slice(0, 24);
  return path.join(path.dirname(targetDirectory), `.${path.basename(targetDirectory)}.deployerx-${owner}-${suffix}`);
}

function normalizeRestoreArtifact(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis recovery artifact metadata is invalid.', { category: 'integrity' });
  const component = String(input.component || (index === 0 ? 'rdb' : '')).toLowerCase();
  if (!['rdb', 'base', 'increment', 'manifest'].includes(component)) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis recovery artifact component is invalid.', { category: 'integrity' });
  const artifactPath = requiredText(input.path, 'Redis recovery artifact path', 1024).replace(/\\/g, '/');
  if (artifactPath.startsWith('/') || artifactPath.split('/').some((part) => !part || part === '.' || part === '..')) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis recovery artifact path is unsafe.', { category: 'integrity' });
  const filename = safePersistenceName(input.filename || artifactPath.split('/').at(-1), 'Redis recovery artifact filename');
  const contentDigest = requiredText(input.contentDigest, 'Redis recovery artifact digest', 100);
  if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest)) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis recovery artifact digest is invalid.', { category: 'integrity' });
  const sizeBytes = Number(input.sizeBytes);
  const maximumBytes = component === 'manifest' ? MAX_AOF_MANIFEST_BYTES : MAX_RDB_BACKUP_BYTES;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < (component === 'increment' ? 0 : 1) || sizeBytes > maximumBytes) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis recovery artifact size is invalid.', { category: 'integrity' });
  return { component, path: artifactPath, filename, contentDigest, sizeBytes, mediaType: optionalText(input.mediaType, 'Redis recovery artifact media type', 200) };
}

function normalizeRestoreMetadata(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis recovery metadata is invalid.', { category: 'integrity' });
  const kind = String(input.kind || '').toLowerCase();
  if (!['redis-rdb', 'redis-sealed-backup', 'redis-multipart-aof'].includes(kind)) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis recovery artifact kind is unsupported.', { category: 'compatibility' });
  const rawArtifacts = kind === 'redis-rdb' ? [input.artifact] : input.artifacts;
  if (!Array.isArray(rawArtifacts) || !rawArtifacts.length || rawArtifacts.length > 10000) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis recovery artifact membership is invalid.', { category: 'integrity' });
  const artifacts = rawArtifacts.map(normalizeRestoreArtifact);
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length || new Set(artifacts.map((artifact) => artifact.filename)).size !== artifacts.length) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis recovery artifacts must have unique paths and filenames.', { category: 'integrity' });
  if (kind === 'redis-rdb' && (artifacts.length !== 1 || artifacts[0].component !== 'rdb')) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis RDB recovery requires exactly one RDB artifact.', { category: 'integrity' });
  if (kind !== 'redis-rdb' && (artifacts.filter((item) => item.component === 'base').length !== 1 || artifacts.filter((item) => item.component === 'increment').length < 1 || artifacts.filter((item) => item.component === 'manifest').length !== 1)) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis AOF recovery requires one BASE, one or more INCR files, and one manifest.', { category: 'integrity' });
  const serverVersion = parseVersion(input.consistency?.evidence?.serverVersion || input.serverVersion);
  const expectedDatabases = Array.isArray(input.consistency?.evidence?.metadata?.databases) ? input.consistency.evidence.metadata.databases.slice(0, 16).map((database) => ({
    name: requiredText(database?.name, 'Redis expected logical database name', 20),
    keys: integerValue(database?.keys ?? database?.keyCount ?? 0, 'Redis expected key count'),
    expires: integerValue(database?.expires ?? database?.expiryCount ?? 0, 'Redis expected expiry count')
  })) : [];
  return { kind, artifacts, serverVersion, expectedDatabases };
}

function safePersistenceName(value, label) {
  const name = requiredText(value, label, 255);
  if (name === '.' || name === '..' || /[/\\]/.test(name)) throw new DatabaseAdapterError('REDIS_PERSISTENCE_PATH_INVALID', `${label} is unsafe.`, { category: 'integrity' });
  return name;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Redis connection configuration must be an object.');
  const allowed = ['host', 'port', 'username', 'passwordSecretRefId', 'tlsMode', 'caFile', 'clientCertificateFile', 'clientKeyFile', 'timeoutMs', 'redisCliExecutable', 'expectedTopology', 'filesystemConnectionId'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown Redis connection field: ${unknown[0]}.`);
  const tlsMode = String(input.tlsMode || 'verify-identity').toLowerCase();
  if (tlsMode !== 'verify-identity') throw new TypeError('Redis protection requires TLS certificate identity verification.');
  const expectedTopology = String(input.expectedTopology || 'auto').toLowerCase();
  if (!TOPOLOGIES.has(expectedTopology)) throw new TypeError('Redis expected topology is invalid.');
  const clientCertificateFile = normalizeAbsoluteFile(input.clientCertificateFile, 'Redis TLS client certificate file');
  const clientKeyFile = normalizeAbsoluteFile(input.clientKeyFile, 'Redis TLS client key file');
  if (Boolean(clientCertificateFile) !== Boolean(clientKeyFile)) throw new TypeError('Redis mutual TLS requires both a client certificate and client key file.');
  return {
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    username: optionalText(input.username, 'Redis ACL username', 256) || 'default',
    passwordSecretRefId: requiredText(input.passwordSecretRefId, 'Redis password SecretRef ID', 200),
    tlsMode,
    caFile: normalizeAbsoluteFile(input.caFile, 'Redis TLS CA file'),
    clientCertificateFile,
    clientKeyFile,
    timeoutMs: normalizeTimeout(input.timeoutMs),
    redisCliExecutable: normalizeExecutable(input.redisCliExecutable),
    expectedTopology,
    filesystemConnectionId: optionalText(input.filesystemConnectionId, 'Redis filesystem connection ID', 200)
  };
}

function redisCliArguments(config, command) {
  if (!Array.isArray(command) || !command.length) throw new TypeError('Redis command is invalid.');
  const args = ['-h', config.host, '-p', String(config.port), '--tls', '--sni', config.host, '--json', '--no-auth-warning'];
  if (config.username) args.push('--user', config.username);
  if (config.caFile) args.push('--cacert', config.caFile);
  if (config.clientCertificateFile) args.push('--cert', config.clientCertificateFile, '--key', config.clientKeyFile);
  return [...args, ...command.map((part) => requiredText(part, 'Redis command argument', 512))];
}

function parseCliJson(stdout, label) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new DatabaseAdapterError('REDIS_RESPONSE_INVALID', `${label} returned an empty response.`, { category: 'integrity' });
  if (/^(?:error:|\(error\))/i.test(text)) {
    if (/NOAUTH|WRONGPASS|AUTH failed/i.test(text)) throw new DatabaseAdapterError('REDIS_AUTHENTICATION_FAILED', 'Redis authentication failed.', { category: 'authentication' });
    if (/NOPERM/i.test(text)) throw new DatabaseAdapterError('REDIS_PRIVILEGE_MISSING', 'The Redis account lacks a command required for backup discovery.', { category: 'authorization' });
    throw new DatabaseAdapterError('REDIS_COMMAND_FAILED', `${label} failed.`, { category: 'execution' });
  }
  try { return JSON.parse(text); }
  catch { throw new DatabaseAdapterError('REDIS_RESPONSE_INVALID', `${label} returned an invalid bounded response.`, { category: 'integrity' }); }
}

function responseText(value, label) {
  if (typeof value !== 'string') throw new DatabaseAdapterError('REDIS_RESPONSE_INVALID', `${label} returned an unexpected response type.`, { category: 'integrity' });
  return value;
}

function parseInfo(value, label = 'Redis INFO') {
  const result = {};
  for (const rawLine of responseText(value, label).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function integerValue(value, label, options = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (options.minimum ?? 0)) throw new DatabaseAdapterError('REDIS_IDENTITY_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return number;
}

function parseVersion(value) {
  const text = requiredText(value, 'Redis version', 100);
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) throw new DatabaseAdapterError('REDIS_VERSION_INVALID', 'Redis returned an invalid server version.', { category: 'compatibility' });
  const version = { text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  if (version.major < 6 || (version.major === 6 && version.minor < 2) || version.major >= 9) throw new DatabaseAdapterError('REDIS_VERSION_UNSUPPORTED', `Redis ${text} is not supported.`, { category: 'compatibility' });
  return version;
}

function parseConfigResponse(value) {
  if (Array.isArray(value)) {
    const result = {};
    for (let index = 0; index < value.length; index += 2) {
      if (typeof value[index] === 'string' && value[index + 1] !== undefined) result[value[index]] = String(value[index + 1]);
    }
    return result;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  throw new DatabaseAdapterError('REDIS_CONFIG_INVALID', 'Redis persistence configuration could not be normalized.', { category: 'integrity' });
}

function parseBackupStatus(value) {
  const fields = parseConfigResponse(value);
  const state = String(fields.state || '').toLowerCase();
  if (!BACKUP_STATES.has(state)) throw new DatabaseAdapterError('REDIS_BACKUP_STATUS_INVALID', 'Redis returned an invalid backup state.', { category: 'integrity' });
  const startTime = integerValue(fields.start_time ?? 0, 'Redis backup start time');
  const endTime = integerValue(fields.end_time ?? 0, 'Redis backup end time');
  return { state, failed: state === 'failed', hasError: Boolean(String(fields.error || '')), startTime, endTime };
}

function parseAofManifest(value, expected = {}) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  if (!text || Buffer.byteLength(text) > MAX_AOF_MANIFEST_BYTES) throw new DatabaseAdapterError('REDIS_BACKUP_MANIFEST_INVALID', 'Redis returned an invalid sealed backup manifest.', { category: 'integrity' });
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^file ([A-Za-z0-9._-]+) seq (\d+) type ([bi])$/.exec(line);
    if (!match) throw new DatabaseAdapterError('REDIS_BACKUP_MANIFEST_INVALID', 'Redis sealed backup manifest contains an unsupported entry.', { category: 'integrity' });
    entries.push({ filename: match[1], sequence: integerValue(match[2], 'Redis backup manifest sequence', { minimum: 1 }), type: match[3] });
  }
  const baseEntries = entries.filter((entry) => entry.type === 'b');
  const incrementEntries = entries.filter((entry) => entry.type === 'i');
  if (entries.length < 2 || entries.length > 10000 || baseEntries.length !== 1 || incrementEntries.length < 1 || new Set(entries.map((entry) => entry.filename)).size !== entries.length || new Set(incrementEntries.map((entry) => entry.sequence)).size !== incrementEntries.length) throw new DatabaseAdapterError('REDIS_BACKUP_MANIFEST_INCOMPLETE', 'Redis backup manifest must contain one BASE and one or more unique INCR files.', { category: 'integrity' });
  if (expected.exactSealed === true && (entries.length !== 2 || incrementEntries.length !== 1)) throw new DatabaseAdapterError('REDIS_BACKUP_MANIFEST_INCOMPLETE', 'Redis sealed backup manifest must contain exactly one BASE and one INCR file.', { category: 'integrity' });
  if (expected.baseFilename && entries.find((entry) => entry.type === 'b')?.filename !== expected.baseFilename) throw new DatabaseAdapterError('REDIS_BACKUP_MANIFEST_MISMATCH', 'Redis sealed backup manifest references a different BASE file.', { category: 'integrity' });
  if (expected.incrementFilename && entries.find((entry) => entry.type === 'i')?.filename !== expected.incrementFilename) throw new DatabaseAdapterError('REDIS_BACKUP_MANIFEST_MISMATCH', 'Redis sealed backup manifest references a different INCR file.', { category: 'integrity' });
  return entries;
}

function classifySealedBackupFiles(value, filesystem, identity) {
  if (!Array.isArray(value) || value.length !== 3 || new Set(value).size !== 3) throw new DatabaseAdapterError('REDIS_BACKUP_FILE_SET_INVALID', 'Redis sealed backup must report exactly three unique files.', { category: 'integrity' });
  if (typeof filesystem.validateBackupPath !== 'function') throw new DatabaseAdapterError('REDIS_FILESYSTEM_EXECUTOR_INVALID', 'The paired filesystem executor cannot validate Redis backup paths.', { category: 'configuration' });
  const files = value.map((rawPath) => {
    const sourcePath = filesystem.validateBackupPath(identity.persistenceConfig.directory, identity.persistenceConfig.backupDirectoryName, requiredText(rawPath, 'Redis sealed backup path'));
    const filename = sourcePath.replace(/\\/g, '/').split('/').at(-1);
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new DatabaseAdapterError('REDIS_BACKUP_FILENAME_INVALID', 'Redis sealed backup reported an unsafe filename.', { category: 'integrity' });
    const component = /[.]base[.]rdb$/.test(filename) ? 'base' : /[.]incr[.]aof$/.test(filename) ? 'increment' : /[.]manifest$/.test(filename) ? 'manifest' : null;
    if (!component) throw new DatabaseAdapterError('REDIS_BACKUP_FILE_SET_INVALID', 'Redis sealed backup reported an unsupported artifact type.', { category: 'integrity' });
    return { component, filename, sourcePath };
  });
  for (const component of ['base', 'increment', 'manifest']) if (files.filter((file) => file.component === component).length !== 1) throw new DatabaseAdapterError('REDIS_BACKUP_FILE_SET_INVALID', 'Redis sealed backup must contain one BASE, one INCR, and one manifest.', { category: 'integrity' });
  return files.sort((left, right) => ['base', 'increment', 'manifest'].indexOf(left.component) - ['base', 'increment', 'manifest'].indexOf(right.component));
}

function parseRole(value) {
  if (!Array.isArray(value) || !value.length || typeof value[0] !== 'string') throw new DatabaseAdapterError('REDIS_ROLE_INVALID', 'Redis ROLE returned an invalid response.', { category: 'integrity' });
  const rawRole = value[0].toLowerCase();
  if (rawRole === 'master') return { role: 'master', offset: integerValue(value[1], 'Redis master ROLE offset'), replicaCount: Array.isArray(value[2]) ? value[2].length : 0 };
  if (rawRole === 'slave' || rawRole === 'replica') return { role: 'replica', masterHost: requiredText(value[1], 'Redis ROLE master host', 253), masterPort: integerValue(value[2], 'Redis ROLE master port', { minimum: 1 }), state: requiredText(value[3], 'Redis replica state', 40), offset: integerValue(value[4], 'Redis replica ROLE offset') };
  if (rawRole === 'sentinel') return { role: 'sentinel', offset: null };
  throw new DatabaseAdapterError('REDIS_ROLE_INVALID', 'Redis reported an unsupported role.', { category: 'compatibility' });
}

function parseKeyspace(info) {
  const databases = [];
  for (const [name, raw] of Object.entries(info)) {
    const match = /^db(\d+)$/.exec(name);
    if (!match) continue;
    const values = Object.fromEntries(String(raw).split(',').map((part) => part.split('=', 2)));
    databases.push({
      name,
      index: Number(match[1]),
      keys: integerValue(values.keys || 0, `${name} key count`),
      expires: integerValue(values.expires || 0, `${name} expiry count`),
      averageTtlMs: integerValue(values.avg_ttl || 0, `${name} average TTL`)
    });
  }
  if (!databases.some((item) => item.index === 0)) databases.push({ name: 'db0', index: 0, keys: 0, expires: 0, averageTtlMs: 0 });
  return databases.sort((left, right) => left.index - right.index);
}

function parseClusterNodes(value) {
  const lines = responseText(value, 'Redis CLUSTER NODES').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > MAX_CLUSTER_NODES) throw new DatabaseAdapterError('REDIS_CLUSTER_INVENTORY_INVALID', 'Redis Cluster returned an invalid node inventory.', { category: 'capacity' });
  const ownership = new Array(CLUSTER_SLOT_COUNT).fill(null);
  let selfNodeId = null;
  const masters = [];
  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (fields.length < 8) throw new DatabaseAdapterError('REDIS_CLUSTER_INVENTORY_INVALID', 'Redis Cluster returned a malformed node record.', { category: 'integrity' });
    const [nodeId, address, rawFlags] = fields;
    const flags = rawFlags.split(',');
    if (flags.includes('myself')) selfNodeId = nodeId;
    if (!flags.includes('master')) continue;
    const unhealthy = flags.some((flag) => ['fail', 'fail?', 'handshake', 'noaddr'].includes(flag)) || fields[7] !== 'connected';
    const slots = [];
    for (const token of fields.slice(8)) {
      if (token.startsWith('[')) continue;
      const match = /^(\d+)(?:-(\d+))?$/.exec(token);
      if (!match) continue;
      const first = Number(match[1]);
      const last = Number(match[2] ?? match[1]);
      if (first < 0 || last >= CLUSTER_SLOT_COUNT || first > last) throw new DatabaseAdapterError('REDIS_CLUSTER_SLOT_INVALID', 'Redis Cluster reported an invalid slot range.', { category: 'integrity' });
      for (let slot = first; slot <= last; slot += 1) {
        if (ownership[slot] && ownership[slot] !== nodeId) throw new DatabaseAdapterError('REDIS_CLUSTER_SLOT_DUPLICATE', 'Redis Cluster reported duplicate slot ownership.', { category: 'integrity' });
        ownership[slot] = nodeId;
      }
      slots.push(match[2] === undefined ? String(first) : `${first}-${last}`);
    }
    masters.push({ nodeId, address: address.split('@')[0], healthy: !unhealthy, slots });
  }
  const coveredSlots = ownership.filter(Boolean).length;
  if (!selfNodeId) throw new DatabaseAdapterError('REDIS_CLUSTER_IDENTITY_MISSING', 'Redis Cluster did not identify the authenticated node.', { category: 'integrity' });
  if (!masters.length || masters.some((item) => !item.healthy) || coveredSlots !== CLUSTER_SLOT_COUNT) throw new DatabaseAdapterError('REDIS_CLUSTER_INCOMPLETE', 'Redis Cluster must have healthy masters with complete 16,384-slot coverage.', { category: 'integrity', details: { masterCount: masters.length, coveredSlots } });
  return { selfNodeId, masters, coveredSlots };
}

function backupCommandAvailable(value) {
  return Array.isArray(value) && value.length > 0 && value.some((item) => item !== null);
}

function atLeast(version, major, minor) {
  return version.major > major || (version.major === major && version.minor >= minor);
}

function deploymentFingerprint(identity) {
  const stable = {
    mode: identity.mode,
    runId: identity.runId,
    role: identity.role,
    replicationId: identity.replicationId,
    clusterNodeId: identity.cluster?.selfNodeId || null,
    clusterMasters: identity.cluster?.masters.map((item) => item.nodeId).sort() || []
  };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex')}`;
}

function clusterTopologyFingerprint(cluster) {
  if (!cluster || !Array.isArray(cluster.masters) || cluster.coveredSlots !== CLUSTER_SLOT_COUNT) throw new DatabaseAdapterError('REDIS_CLUSTER_INCOMPLETE', 'Redis Cluster topology evidence is incomplete.', { category: 'integrity' });
  const topology = cluster.masters.map((master) => ({ nodeId: master.nodeId, slots: [...master.slots].sort() })).sort((left, right) => left.nodeId.localeCompare(right.nodeId, 'en-US'));
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(topology)).digest('hex')}`;
}

function normalizeIdentity(responses) {
  const ping = responseText(responses.ping, 'Redis PING');
  if (ping.toUpperCase() !== 'PONG') throw new DatabaseAdapterError('REDIS_PING_FAILED', 'Redis did not return PONG.', { category: 'connectivity', retryable: true });
  const server = parseInfo(responses.server, 'Redis INFO server');
  const persistenceInfo = parseInfo(responses.persistence, 'Redis INFO persistence');
  const replication = parseInfo(responses.replication, 'Redis INFO replication');
  const keyspace = parseInfo(responses.keyspace, 'Redis INFO keyspace');
  const roleEvidence = parseRole(responses.role);
  const config = parseConfigResponse(responses.config);
  const version = parseVersion(server.redis_version);
  const infoRole = String(replication.role || '').toLowerCase() === 'slave' ? 'replica' : String(replication.role || '').toLowerCase();
  const role = roleEvidence.role;
  const replicationOffset = role === 'master'
    ? integerValue(replication.master_repl_offset, 'Redis master replication offset')
    : role === 'replica'
      ? integerValue(replication.slave_repl_offset ?? replication.master_repl_offset, 'Redis replica replication offset')
      : null;
  const cluster = responses.clusterNodes === null ? null : parseClusterNodes(responses.clusterNodes);
  const aofEnabled = config.appendonly === 'yes' || persistenceInfo.aof_enabled === '1';
  const sealedAvailable = atLeast(version, 8, 10) && backupCommandAvailable(responses.backupCommand);
  return {
    version,
    mode: String(server.redis_mode || (cluster ? 'cluster' : 'standalone')).toLowerCase(),
    runId: requiredText(server.run_id, 'Redis run ID', 128),
    role,
    infoRole,
    roleOffset: roleEvidence.offset,
    roleState: roleEvidence.state || null,
    replicationId: role === 'sentinel' ? null : optionalText(replication.master_replid, 'Redis master replication ID', 128),
    replicationOffset,
    connectedReplicas: integerValue(replication.connected_slaves || 0, 'Redis connected replica count'),
    persistence: {
      loading: persistenceInfo.loading === '1',
      rdbSaveInProgress: persistenceInfo.rdb_bgsave_in_progress === '1',
      rdbLastStatus: String(persistenceInfo.rdb_last_bgsave_status || 'unknown').toLowerCase(),
      rdbLastSaveTime: Number(persistenceInfo.rdb_last_save_time || 0),
      rdbSaves: persistenceInfo.rdb_saves === undefined ? null : integerValue(persistenceInfo.rdb_saves, 'Redis RDB save count'),
      aofEnabled,
      aofRewriteInProgress: persistenceInfo.aof_rewrite_in_progress === '1',
      aofLastRewriteStatus: String(persistenceInfo.aof_last_bgrewrite_status || 'unknown').toLowerCase(),
      aofLastWriteStatus: String(persistenceInfo.aof_last_write_status || 'unknown').toLowerCase()
    },
    persistenceConfig: {
      directory: requiredText(config.dir, 'Redis persistence directory'),
      rdbFilename: safePersistenceName(config.dbfilename, 'Redis RDB filename'),
      appendOnly: aofEnabled,
      appendDirectoryName: optionalText(config.appenddirname, 'Redis AOF directory name', 255),
      appendFilename: config.appendfilename ? safePersistenceName(config.appendfilename, 'Redis AOF filename') : null,
      automaticRewritePercentage: integerValue(config['auto-aof-rewrite-percentage'] || 0, 'Redis automatic AOF rewrite percentage'),
      backupDirectoryName: safePersistenceName(config.backupdirname || 'backupdir', 'Redis backup directory name'),
      backupSealedTtlSeconds: integerValue(config['backup-sealed-ttl'] || 0, 'Redis sealed backup TTL')
    },
    databases: parseKeyspace(keyspace),
    cluster,
    clusterState: responses.clusterInfo === null ? null : String(parseInfo(responses.clusterInfo, 'Redis CLUSTER INFO').cluster_state || '').toLowerCase(),
    backupCommandAvailable: sealedAvailable,
    backupStrategy: sealedAvailable ? 'sealed-backup' : aofEnabled && atLeast(version, 7, 0) ? 'multipart-aof' : 'rdb'
  };
}

function validateIdentity(config, identity, options = {}) {
  if (identity.mode === 'sentinel' || identity.role === 'sentinel') throw new DatabaseAdapterError('REDIS_SENTINEL_ENDPOINT', 'A Redis Sentinel endpoint cannot be used as a data source.', { category: 'compatibility' });
  if (!['standalone', 'cluster'].includes(identity.mode)) throw new DatabaseAdapterError('REDIS_MODE_UNSUPPORTED', 'Redis reported an unsupported server mode.', { category: 'compatibility' });
  if (!['master', 'replica'].includes(identity.role) || identity.infoRole !== identity.role) throw new DatabaseAdapterError('REDIS_ROLE_DIVERGED', 'Redis INFO and ROLE identity evidence did not agree.', { category: 'integrity' });
  if (!identity.replicationId || identity.replicationOffset !== identity.roleOffset) throw new DatabaseAdapterError('REDIS_REPLICATION_IDENTITY_DIVERGED', 'Redis replication identity or applied offset was inconsistent.', { category: 'integrity' });
  if (identity.role === 'replica' && identity.roleState !== 'connected') throw new DatabaseAdapterError('REDIS_REPLICA_NOT_CONNECTED', 'Redis replica is not connected to its upstream master.', { category: 'integrity', retryable: true });
  const actualTopology = identity.mode === 'cluster' ? 'cluster' : identity.role === 'replica' || identity.connectedReplicas > 0 ? 'replication' : 'standalone';
  if (config.expectedTopology !== 'auto' && config.expectedTopology !== actualTopology) throw new DatabaseAdapterError('REDIS_TOPOLOGY_MISMATCH', `Redis reported ${actualTopology} instead of the expected topology.`, { category: 'integrity' });
  if (actualTopology === 'cluster' && (identity.clusterState !== 'ok' || identity.cluster?.coveredSlots !== CLUSTER_SLOT_COUNT)) throw new DatabaseAdapterError('REDIS_CLUSTER_INCOMPLETE', 'Redis Cluster is not healthy with complete slot coverage.', { category: 'integrity' });
  if (options.forBackup) {
    if (!config.filesystemConnectionId) throw new DatabaseAdapterError('REDIS_FILESYSTEM_EXECUTOR_REQUIRED', 'Redis backup requires a paired local or SSH filesystem connection.', { category: 'configuration' });
    const state = identity.persistence;
    if (state.loading || state.rdbSaveInProgress || state.aofRewriteInProgress) throw new DatabaseAdapterError('REDIS_PERSISTENCE_BUSY', 'Redis persistence is busy and cannot establish a backup publication boundary.', { category: 'concurrency', retryable: true });
    if (state.rdbLastStatus !== 'ok' || (state.aofEnabled && (state.aofLastRewriteStatus !== 'ok' || state.aofLastWriteStatus !== 'ok'))) throw new DatabaseAdapterError('REDIS_PERSISTENCE_UNHEALTHY', 'Redis persistence health must be repaired before backup.', { category: 'integrity' });
  }
  return { version: identity.version, actualTopology };
}

function safeAdapterError(error, operation) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error instanceof NativeProcessError) {
    const output = String(error.stderr || '').toLowerCase();
    if (/noauth|wrongpass|authentication/.test(output)) return new DatabaseAdapterError('REDIS_AUTHENTICATION_FAILED', 'Redis authentication failed.', { category: 'authentication' });
    if (/noperm/.test(output)) return new DatabaseAdapterError('REDIS_PRIVILEGE_MISSING', 'The Redis account lacks a command required for backup discovery.', { category: 'authorization' });
    if (/certificate|tls|ssl/.test(output)) return new DatabaseAdapterError('REDIS_TLS_FAILED', 'Redis TLS certificate identity verification failed.', { category: 'integrity' });
    if (error.code === 'NATIVE_EXECUTABLE_NOT_FOUND') return new DatabaseAdapterError('REDIS_CLI_NOT_FOUND', 'Install a supported redis-cli client and make it available on PATH.', { category: 'compatibility' });
    if (error.code === 'NATIVE_PROCESS_CANCELED') return new DatabaseAdapterError('REDIS_OPERATION_CANCELED', `The Redis ${operation} was canceled.`, { category: 'canceled' });
    if (error.code === 'NATIVE_PROCESS_TIMEOUT') return new DatabaseAdapterError('REDIS_OPERATION_TIMEOUT', `The Redis ${operation} exceeded its timeout.`, { category: 'timeout', retryable: true });
    return new DatabaseAdapterError('REDIS_CONNECT_FAILED', 'DeployerX could not complete the authenticated Redis command.', { category: 'connectivity', retryable: true });
  }
  return new DatabaseAdapterError('REDIS_OPERATION_FAILED', `The Redis ${operation} failed.`, { category: 'execution' });
}

class RedisNativeAdapter {
  constructor({ processRunner = new NativeProcessRunner(), clock = () => new Date().toISOString(), now = () => Date.now(), delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), fileSystem = fsPromises, createReadStream = fs.createReadStream, maximumRdbWaitMs = 60 * 60 * 1000, maximumSealedWaitMs = 60 * 60 * 1000, maximumAofPauseMs = 5 * 60 * 1000 } = {}) {
    if (!processRunner || typeof processRunner.run !== 'function') throw new TypeError('Redis process runner is required.');
    this.processRunner = processRunner;
    this.clock = clock;
    this.now = now;
    this.delay = delay;
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.maximumRdbWaitMs = maximumRdbWaitMs;
    this.maximumSealedWaitMs = maximumSealedWaitMs;
    this.maximumAofPauseMs = Math.min(5 * 60 * 1000, Math.max(1000, Number(maximumAofPauseMs) || 5 * 60 * 1000));
  }

  manifest() {
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      displayName: 'Redis Native',
      engine: 'redis',
      executionReady: true,
      serverVersionRange: '>=6.2.0 <9.0.0',
      restoreVersionRange: '>=6.2.0 <9.0.0',
      capabilities: {
        backupMethods: ['physical'],
        backupModes: ['full'],
        selection: { database: true, schema: false, table: false, globalObjects: false },
        consistencyStrategies: [
          { id: 'redis-rdb', produces: 'application', backupMethods: ['physical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: true },
          { id: 'redis-aof', produces: 'application', backupMethods: ['physical'], lockScope: 'instance', requiresDowntime: false, capturesCoordinates: true },
          { id: 'redis-cluster-rdb', produces: 'crash', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: true },
          { id: 'redis-cluster-aof', produces: 'crash', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: true }
        ],
        transactionLogs: { supported: true, type: 'redis-sealed-aof', pointInTimeRecovery: false, granularitySeconds: 1 },
        streaming: { backup: true, restore: false, compression: false, encryption: false },
        restore: { alternateTarget: true, nativeValidation: true },
        replicaAware: true
      },
      requiredTools: [{ name: 'redis-cli', versionRange: '>=7.0.0 <9.0.0', operations: ['discovery', 'backup', 'validation'] }],
      requiredPrivileges: [{ id: 'redis-backup-discovery-commands', operations: ['discovery'], required: true, safeDescription: 'The Redis ACL user must run PING, INFO, ROLE, CONFIG GET, COMMAND INFO, and cluster discovery commands when applicable.' }]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'REDIS_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async #command(config, password, command, signal) {
    try {
      const result = await this.processRunner.run({
        executable: config.redisCliExecutable,
        args: redisCliArguments(config, command),
        env: { REDISCLI_AUTH: password },
        timeoutMs: config.timeoutMs,
        stdoutLimitBytes: command[0] === 'CLUSTER' && command[1] === 'NODES' ? 8 * 1024 * 1024 : 2 * 1024 * 1024,
        signal
      });
      return parseCliJson(result.stdout, `Redis ${command.join(' ')}`);
    } catch (error) { throw safeAdapterError(error, command.join(' ').toLowerCase()); }
  }

  async readIdentity(context = {}, input = {}) {
    const config = normalizeConfig(input);
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('REDIS_SECRET_RESOLVER_MISSING', 'Redis credentials are unavailable.', { category: 'authentication' });
    const password = String(await context.resolveSecret(config.passwordSecretRefId));
    if (!password || password.includes('\0') || password.length > 8192) throw new DatabaseAdapterError('REDIS_CREDENTIAL_INVALID', 'Redis password cannot be represented safely.', { category: 'authentication' });
    const run = (command) => this.#command(config, password, command, context.signal);
    const ping = await run(['PING']);
    const server = await run(['INFO', 'server']);
    const mode = String(parseInfo(server, 'Redis INFO server').redis_mode || '').toLowerCase();
    const [persistence, replication, keyspace, role, configResponse, backupCommand] = await Promise.all([
      run(['INFO', 'persistence']),
      run(['INFO', 'replication']),
      run(['INFO', 'keyspace']),
      run(['ROLE']),
      run(['CONFIG', 'GET', 'dir', 'dbfilename', 'appendonly', 'appendfilename', 'appenddirname', 'auto-aof-rewrite-percentage', 'backupdirname', 'backup-sealed-ttl']),
      run(['COMMAND', 'INFO', 'BACKUP'])
    ]);
    let clusterInfo = null;
    let clusterNodes = null;
    if (mode === 'cluster' || config.expectedTopology === 'cluster') {
      [clusterInfo, clusterNodes] = await Promise.all([run(['CLUSTER', 'INFO']), run(['CLUSTER', 'NODES'])]);
    }
    return normalizeIdentity({ ping, server, persistence, replication, keyspace, role, config: configResponse, backupCommand, clusterInfo, clusterNodes });
  }

  async #toolVersion(config, signal) {
    try {
      const result = await this.processRunner.run({ executable: config.redisCliExecutable, args: ['--version'], env: {}, timeoutMs: 10000, stdoutLimitBytes: 8192, signal });
      const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
      const match = /redis-cli\s+(\d+)\.(\d+)\.(\d+)/i.exec(text);
      if (!match) throw new DatabaseAdapterError('REDIS_CLI_VERSION_INVALID', 'redis-cli returned an invalid version.', { category: 'compatibility' });
      const version = { text: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
      if (version.major < 7 || version.major >= 9) throw new DatabaseAdapterError('REDIS_CLI_VERSION_UNSUPPORTED', `redis-cli ${version.text} is not supported.`, { category: 'compatibility' });
      return version;
    } catch (error) { throw safeAdapterError(error, 'CLI version check'); }
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const config = normalizeConfig(input);
      const identity = await this.readIdentity(context, config);
      const validated = validateIdentity(config, identity);
      const busy = identity.persistence.loading || identity.persistence.rdbSaveInProgress || identity.persistence.aofRewriteInProgress;
      const persistenceHealthy = identity.persistence.rdbLastStatus === 'ok' && (!identity.persistence.aofEnabled || (identity.persistence.aofLastRewriteStatus === 'ok' && identity.persistence.aofLastWriteStatus === 'ok'));
      return {
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'success',
        checks: [
          { id: 'authentication', status: 'pass', safeMessage: 'Redis authentication and required-command discovery succeeded.' },
          { id: 'server-version', status: 'pass', safeMessage: `Redis ${identity.version.text} is supported.` },
          { id: 'tls', status: 'pass', safeMessage: 'TLS certificate identity verification is required.' },
          { id: 'topology', status: 'pass', safeMessage: `Redis ${validated.actualTopology} topology identity was verified.` },
          { id: 'replication-identity', status: 'pass', safeMessage: 'Redis replication ID and applied offset agreed across INFO and ROLE.' },
          { id: 'persistence-health', status: persistenceHealthy && !busy ? 'pass' : 'warning', safeMessage: persistenceHealthy && !busy ? 'Redis persistence is healthy and idle.' : 'Redis persistence requires a healthy idle boundary before backup execution.' },
          { id: 'filesystem-executor', status: config.filesystemConnectionId ? 'pass' : 'warning', safeMessage: config.filesystemConnectionId ? 'A paired filesystem connection is configured for artifact capture.' : 'Pair a local or SSH filesystem connection before creating a Redis backup job.' }
        ],
        remotePlatform: { engine: 'redis', version: identity.version.text, distribution: 'Redis', platform: null },
        endpointIdentity: {
          deploymentFingerprint: deploymentFingerprint(identity),
          mode: identity.mode,
          role: identity.role,
          runId: identity.runId,
          replicationId: identity.replicationId,
          replicationOffset: identity.replicationOffset,
           clusterNodeId: identity.cluster?.selfNodeId || null,
           clusterMasterCount: identity.cluster?.masters.length || 0,
           coveredSlots: identity.cluster?.coveredSlots || 0,
           clusterTopologyFingerprint: identity.cluster ? clusterTopologyFingerprint(identity.cluster) : null,
           clusterMasters: identity.cluster?.masters.map((master) => ({ nodeId: master.nodeId, address: master.address, slots: master.slots.slice() })) || [],
           backupStrategy: identity.backupStrategy
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
    const identity = await this.readIdentity(context, config);
    const validated = validateIdentity(config, identity);
    yield {
      items: identity.databases.map((database) => ({
        kind: 'database',
        name: database.name,
        index: database.index,
        keyCount: database.keys,
        expiryCount: database.expires,
        averageTtlMs: database.averageTtlMs,
        selectable: validated.actualTopology !== 'cluster' || database.index === 0,
        state: 'available',
        topology: validated.actualTopology,
        reasonCode: validated.actualTopology === 'cluster' && database.index !== 0 ? 'redis-cluster-db0-only' : null
      })),
      nextCursor: null
    };
  }

  async preflight(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const [identity, toolVersion] = await Promise.all([this.readIdentity(context, config), this.#toolVersion(config, context.signal)]);
    validateIdentity(config, identity, { forBackup: true });
    const sealedReady = identity.backupCommandAvailable && identity.persistenceConfig.backupSealedTtlSeconds === 0;
    const multipartReady = identity.backupStrategy === 'multipart-aof' && identity.persistenceConfig.appendOnly && Boolean(identity.persistenceConfig.appendDirectoryName) && Boolean(identity.persistenceConfig.appendFilename);
    const aofReady = sealedReady || multipartReady;
    return {
      checkedAt: this.clock(),
      serverVersion: identity.version.text,
      serverVersionSupported: true,
      serverIdentityFingerprint: deploymentFingerprint(identity),
      consistency: identity.mode === 'cluster' ? [
        { method: 'redis-cluster-rdb', verified: identity.role === 'master', produces: 'crash', reasonCode: identity.role === 'master' ? null : 'REDIS_CLUSTER_MASTER_REQUIRED' },
        { method: 'redis-cluster-aof', verified: identity.role === 'master' && aofReady, produces: 'crash', reasonCode: identity.role !== 'master' ? 'REDIS_CLUSTER_MASTER_REQUIRED' : aofReady ? null : identity.backupCommandAvailable ? 'REDIS_BACKUP_TTL_MUST_BE_ZERO' : 'REDIS_MULTIPART_AOF_UNAVAILABLE' }
      ] : [
        { method: 'redis-rdb', verified: true, produces: 'application' },
        { method: 'redis-aof', verified: aofReady, produces: 'application', reasonCode: aofReady ? null : identity.backupCommandAvailable ? 'REDIS_BACKUP_TTL_MUST_BE_ZERO' : 'REDIS_MULTIPART_AOF_UNAVAILABLE' }
      ],
      tools: [{ name: 'redis-cli', version: toolVersion.text, compatible: true }],
      privileges: [],
      coordinateCaptureVerified: true,
      warnings: identity.backupCommandAvailable && identity.persistenceConfig.backupSealedTtlSeconds !== 0 ? ['Set backup-sealed-ttl to 0 before using sealed Redis backup execution.'] : [],
      metadata: {
        mode: identity.mode,
        role: identity.role,
        runId: identity.runId,
        replicationId: identity.replicationId,
        replicationOffset: identity.replicationOffset,
        rdbLastSaveTime: identity.persistence.rdbLastSaveTime,
        rdbSaves: identity.persistence.rdbSaves,
        persistenceDirectory: identity.persistenceConfig.directory,
        rdbFilename: identity.persistenceConfig.rdbFilename,
        appendFilename: identity.persistenceConfig.appendFilename,
        appendDirectoryName: identity.persistenceConfig.appendDirectoryName,
        automaticRewritePercentage: identity.persistenceConfig.automaticRewritePercentage,
        backupStrategy: identity.backupStrategy,
        databases: identity.databases,
        backupDirectoryName: identity.persistenceConfig.backupDirectoryName,
        backupSealedTtlSeconds: identity.persistenceConfig.backupSealedTtlSeconds,
        backupCommandAvailable: identity.backupCommandAvailable,
        clusterNodeId: identity.cluster?.selfNodeId || null,
        clusterMasterCount: identity.cluster?.masters.length || 0,
        coveredSlots: identity.cluster?.coveredSlots || 0,
        clusterTopologyFingerprint: identity.cluster ? clusterTopologyFingerprint(identity.cluster) : null,
        clusterMasters: identity.cluster?.masters.map((master) => ({ nodeId: master.nodeId, address: master.address, slots: master.slots.slice() })) || []
      }
    };
  }

  async planBackup(_context = {}, request = {}) {
    const method = request.consistency?.method;
    const clusterMethod = ['redis-cluster-rdb', 'redis-cluster-aof'].includes(method);
    const expectedLevel = clusterMethod ? 'crash' : 'application';
    if (request.consistency?.proven !== true || !['redis-rdb', 'redis-aof', 'redis-cluster-rdb', 'redis-cluster-aof'].includes(method) || request.consistency?.achievedLevel !== expectedLevel || request.consistency?.backupMode !== 'full') throw new DatabaseAdapterError('REDIS_CONSISTENCY_PLAN_INVALID', 'Redis backup requires a proven full native persistence plan.', { category: 'integrity' });
    const selector = request.selector || {};
    const childRules = (selector.databases?.include?.length || 0) + (selector.databases?.exclude?.length || 0) + (selector.schemas?.include?.length || 0) + (selector.schemas?.exclude?.length || 0) + (selector.tables?.include?.length || 0) + (selector.tables?.exclude?.length || 0);
    if (selector.allDatabases !== true || childRules || selector.includeGlobalObjects) throw new DatabaseAdapterError('REDIS_SELECTION_INVALID', 'Redis RDB backup requires the complete instance without object filters.', { category: 'compatibility' });
    return {
      version: 1,
      operation: clusterMethod ? method === 'redis-cluster-aof' ? 'redis-cluster-aof-backup' : 'redis-cluster-rdb-backup' : method === 'redis-aof'
        ? request.consistency.evidence?.metadata?.backupStrategy === 'multipart-aof' ? 'redis-multipart-aof-backup' : 'redis-sealed-backup'
        : 'redis-rdb-backup',
      connection: normalizeConfig(request.connection),
      selector,
      consistency: request.consistency,
      expectedIdentity: request.consistency.evidence?.metadata || {},
      execution: request.execution || null,
      artifact: clusterMethod
        ? { kind: 'physical-backup', pathPrefix: 'redis/cluster', mediaType: 'application/octet-stream' }
        : method === 'redis-aof'
        ? { kind: 'physical-backup', pathPrefix: request.consistency.evidence?.metadata?.backupStrategy === 'multipart-aof' ? 'redis/aof' : 'redis/sealed', mediaType: 'application/octet-stream' }
        : { kind: 'database-dump', path: 'redis/dump.rdb', mediaType: 'application/x-redis-rdb' },
      resumable: false
    };
  }

  async planClusterMemberBackup(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const identity = await this.readIdentity(context, config);
    validateIdentity(config, identity, { forBackup: true });
    const nodeId = requiredText(request.nodeId, 'Redis Cluster master node ID', 200);
    const topologyFingerprint = requiredText(request.topologyFingerprint, 'Redis Cluster topology fingerprint', 100);
    if (identity.mode !== 'cluster' || identity.role !== 'master' || identity.cluster?.selfNodeId !== nodeId || clusterTopologyFingerprint(identity.cluster) !== topologyFingerprint) throw new DatabaseAdapterError('REDIS_CLUSTER_MASTER_IDENTITY_CHANGED', 'A Redis Cluster master no longer matches the enrolled topology.', { category: 'integrity' });
    const parentMethod = String(request.method || '');
    if (!['redis-cluster-rdb', 'redis-cluster-aof'].includes(parentMethod)) throw new DatabaseAdapterError('REDIS_CLUSTER_PLAN_INVALID', 'Redis Cluster member backup method is invalid.', { category: 'integrity' });
    const backupStrategy = identity.backupStrategy;
    const aof = parentMethod === 'redis-cluster-aof';
    if (aof && backupStrategy === 'rdb') throw new DatabaseAdapterError('REDIS_CLUSTER_AOF_UNAVAILABLE', 'A Redis Cluster master cannot produce the requested AOF recovery set.', { category: 'compatibility' });
    const prefix = `${requiredText(request.artifactPrefix, 'Redis Cluster artifact prefix', 1024)}/${encodeURIComponent(nodeId)}`;
    return {
      version: 1,
      operation: aof ? backupStrategy === 'multipart-aof' ? 'redis-multipart-aof-backup' : 'redis-sealed-backup' : 'redis-rdb-backup',
      connection: config,
      consistency: {
        version: 1, proven: true, method: aof ? 'redis-aof' : 'redis-rdb', achievedLevel: 'application', backupMode: 'full',
        evidence: { serverIdentityFingerprint: deploymentFingerprint(identity), metadata: { backupStrategy, clusterNodeId: nodeId, clusterTopologyFingerprint: topologyFingerprint, databases: identity.databases, serverVersion: identity.version.text } }
      },
      expectedClusterNodeId: nodeId,
      expectedClusterTopologyFingerprint: topologyFingerprint,
      artifact: aof ? { kind: 'physical-backup', pathPrefix: `${prefix}/${backupStrategy === 'multipart-aof' ? 'aof' : 'sealed'}`, mediaType: 'application/octet-stream' } : { kind: 'physical-backup', path: `${prefix}/dump.rdb`, mediaType: 'application/x-redis-rdb' },
      resumable: false
    };
  }

  async createRdbMedia(context = {}, plan = {}, destinationPath) {
    if (plan.operation !== 'redis-rdb-backup' || plan.consistency?.proven !== true) throw new DatabaseAdapterError('REDIS_BACKUP_PLAN_INVALID', 'The Redis RDB backup plan is invalid.', { category: 'integrity' });
    const config = normalizeConfig(plan.connection);
    const filesystem = context.filesystem;
    if (!filesystem || typeof filesystem.resolvePath !== 'function' || typeof filesystem.lstat !== 'function' || typeof filesystem.read !== 'function') throw new DatabaseAdapterError('REDIS_FILESYSTEM_EXECUTOR_INVALID', 'The paired Redis filesystem executor is unavailable.', { category: 'configuration' });
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('REDIS_SECRET_RESOLVER_MISSING', 'Redis credentials are unavailable.', { category: 'authentication' });
    const destination = path.resolve(requiredText(destinationPath, 'Redis staging destination'));
    if (await this.fileSystem.lstat(destination).catch(() => null)) throw new DatabaseAdapterError('REDIS_BACKUP_DESTINATION_EXISTS', 'The protected Redis staging output already exists.', { category: 'integrity' });
    const password = String(await context.resolveSecret(config.passwordSecretRefId));
    if (!password || password.includes('\0') || password.length > 8192) throw new DatabaseAdapterError('REDIS_CREDENTIAL_INVALID', 'Redis password cannot be represented safely.', { category: 'authentication' });
    const initial = await this.readIdentity(context, config);
    validateIdentity(config, initial, { forBackup: true });
    if (plan.expectedClusterNodeId && (initial.cluster?.selfNodeId !== plan.expectedClusterNodeId || clusterTopologyFingerprint(initial.cluster) !== plan.expectedClusterTopologyFingerprint)) throw new DatabaseAdapterError('REDIS_CLUSTER_MASTER_IDENTITY_CHANGED', 'Redis Cluster master identity changed before RDB capture.', { category: 'integrity' });
    if (deploymentFingerprint(initial) !== plan.consistency.evidence?.serverIdentityFingerprint) throw new DatabaseAdapterError('REDIS_IDENTITY_CHANGED', 'Redis identity changed after backup planning.', { category: 'integrity' });
    const sourcePath = filesystem.resolvePath(initial.persistenceConfig.directory, initial.persistenceConfig.rdbFilename);
    const beforeStat = await filesystem.lstat(sourcePath).catch(() => null);
    const response = responseText(await this.#command(config, password, ['BGSAVE'], context.signal), 'Redis BGSAVE');
    if (!/background saving started/i.test(response)) throw new DatabaseAdapterError('REDIS_BGSAVE_NOT_STARTED', 'Redis did not start the requested background save.', { category: 'execution' });
    const deadline = this.now() + this.maximumRdbWaitMs;
    let finalPersistence = null;
    while (this.now() <= deadline) {
      if (context.signal?.aborted) throw new DatabaseAdapterError('REDIS_OPERATION_CANCELED', 'The Redis RDB backup was canceled.', { category: 'canceled' });
      const current = parseInfo(await this.#command(config, password, ['INFO', 'persistence'], context.signal), 'Redis INFO persistence');
      const inProgress = current.rdb_bgsave_in_progress === '1';
      const lastStatus = String(current.rdb_last_bgsave_status || 'unknown').toLowerCase();
      const lastSaveTime = Number(current.rdb_last_save_time || 0);
      const saves = current.rdb_saves === undefined ? null : Number(current.rdb_saves);
      const advanced = (initial.persistence.rdbSaves !== null && saves !== null && saves > initial.persistence.rdbSaves) || lastSaveTime > initial.persistence.rdbLastSaveTime;
      if (!inProgress && lastStatus !== 'ok') throw new DatabaseAdapterError('REDIS_BGSAVE_FAILED', 'Redis reported that the requested background save failed.', { category: 'integrity' });
      if (!inProgress && advanced) { finalPersistence = { lastSaveTime, rdbSaves: saves }; break; }
      if (!inProgress) {
        const candidate = await filesystem.lstat(sourcePath).catch(() => null);
        const fileAdvanced = Boolean(candidate && (!beforeStat || Number(candidate.mtimeMs) > Number(beforeStat.mtimeMs) || Number(candidate.size) !== Number(beforeStat.size)));
        if (fileAdvanced) { finalPersistence = { lastSaveTime, rdbSaves: saves }; break; }
      }
      await this.delay(250);
    }
    const afterSaveStat = await filesystem.lstat(sourcePath).catch(() => null);
    const statAdvanced = Boolean(afterSaveStat && (!beforeStat || Number(afterSaveStat.mtimeMs) > Number(beforeStat.mtimeMs) || Number(afterSaveStat.size) !== Number(beforeStat.size)));
    if (!finalPersistence && !statAdvanced) throw new DatabaseAdapterError('REDIS_BGSAVE_COMPLETION_UNPROVEN', 'Redis did not prove completion of the run-owned background save.', { category: 'integrity' });
    if (!afterSaveStat?.isFile || afterSaveStat.isSymbolicLink || !Number.isSafeInteger(afterSaveStat.size) || afterSaveStat.size < 1 || afterSaveStat.size > MAX_RDB_BACKUP_BYTES) throw new DatabaseAdapterError('REDIS_RDB_FILE_INVALID', 'Redis published an invalid RDB file.', { category: 'integrity' });
    let handle = null;
    let sizeBytes = 0;
    const digest = crypto.createHash('sha256');
    let header = Buffer.alloc(0);
    try {
      handle = await this.fileSystem.open(destination, 'wx', 0o600);
      for await (const rawChunk of filesystem.read(sourcePath, context.signal)) {
        if (context.signal?.aborted) throw new DatabaseAdapterError('REDIS_OPERATION_CANCELED', 'The Redis RDB backup was canceled.', { category: 'canceled' });
        const chunk = Buffer.from(rawChunk);
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_RDB_BACKUP_BYTES) throw new DatabaseAdapterError('REDIS_RDB_LIMIT_EXCEEDED', 'The Redis RDB exceeds the supported artifact limit.', { category: 'capacity' });
        if (header.length < 9) header = Buffer.concat([header, chunk.subarray(0, 9 - header.length)]);
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await handle.write(chunk, offset, chunk.length - offset, null);
          if (!written.bytesWritten) throw new DatabaseAdapterError('REDIS_RDB_STAGE_WRITE_FAILED', 'The Redis RDB staging write did not make progress.', { category: 'execution' });
          offset += written.bytesWritten;
        }
        await context.onProgress?.({ phase: 'transferring', path: plan.artifact.path, bytesRead: chunk.length });
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (!/^REDIS\d{4}$/.test(header.toString('ascii'))) throw new DatabaseAdapterError('REDIS_RDB_HEADER_INVALID', 'Redis published a file without a valid RDB header.', { category: 'integrity' });
      const afterReadStat = await filesystem.lstat(sourcePath).catch(() => null);
      if (!afterReadStat?.isFile || afterReadStat.isSymbolicLink || afterReadStat.size !== afterSaveStat.size || afterReadStat.mtimeMs !== afterSaveStat.mtimeMs || sizeBytes !== afterSaveStat.size) throw new DatabaseAdapterError('REDIS_RDB_CHANGED_DURING_CAPTURE', 'The Redis RDB changed while it was being captured.', { category: 'integrity', retryable: true });
      const finalIdentity = await this.readIdentity(context, config);
      validateIdentity(config, finalIdentity);
      if (plan.expectedClusterNodeId && (finalIdentity.cluster?.selfNodeId !== plan.expectedClusterNodeId || clusterTopologyFingerprint(finalIdentity.cluster) !== plan.expectedClusterTopologyFingerprint)) throw new DatabaseAdapterError('REDIS_CLUSTER_TOPOLOGY_CHANGED', 'Redis Cluster topology changed during RDB capture.', { category: 'integrity' });
      if (finalIdentity.replicationId !== initial.replicationId || finalIdentity.runId !== initial.runId) throw new DatabaseAdapterError('REDIS_HISTORY_CHANGED', 'Redis replication history changed during RDB capture.', { category: 'integrity' });
      return {
        filePath: destination,
        sourcePath,
        sizeBytes,
        digest: `sha256:${digest.digest('hex')}`,
        before: { runId: initial.runId, replicationId: initial.replicationId, replicationOffset: initial.replicationOffset, rdbLastSaveTime: initial.persistence.rdbLastSaveTime, rdbSaves: initial.persistence.rdbSaves },
        after: {
          runId: finalIdentity.runId,
          replicationId: finalIdentity.replicationId,
          replicationOffset: finalIdentity.replicationOffset,
          rdbLastSaveTime: Math.max(Number(finalPersistence?.lastSaveTime || 0), Number(finalIdentity.persistence.rdbLastSaveTime || 0)),
          rdbSaves: finalIdentity.persistence.rdbSaves ?? finalPersistence?.rdbSaves ?? null
        },
        identity: finalIdentity
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      await this.fileSystem.rm(destination, { force: true }).catch(() => {});
      throw safeAdapterError(error, 'RDB capture');
    }
  }

  async #backupStatus(config, password, signal = null) {
    return parseBackupStatus(await this.#command(config, password, ['BACKUP', 'STATUS'], signal));
  }

  async #stageSealedFile(context, filesystem, source, destinationPath, artifactPath) {
    const before = await filesystem.lstat(source.sourcePath).catch(() => null);
    const rdbHeaderRequired = source.rdbHeaderRequired ?? source.component === 'base';
    const minimumSize = source.component === 'increment' ? 0 : rdbHeaderRequired ? 9 : 1;
    if (!before?.isFile || before.isSymbolicLink || !Number.isSafeInteger(before.size) || before.size < minimumSize || before.size > MAX_RDB_BACKUP_BYTES) throw new DatabaseAdapterError('REDIS_BACKUP_FILE_INVALID', `Redis sealed ${source.component} artifact is invalid.`, { category: 'integrity' });
    const digest = crypto.createHash('sha256');
    let handle = null;
    let sizeBytes = 0;
    let header = Buffer.alloc(0);
    try {
      handle = await this.fileSystem.open(destinationPath, 'wx', 0o600);
      for await (const rawChunk of filesystem.read(source.sourcePath, context.signal)) {
        if (context.signal?.aborted) throw new DatabaseAdapterError('REDIS_OPERATION_CANCELED', 'The Redis sealed backup was canceled.', { category: 'canceled' });
        const chunk = Buffer.from(rawChunk);
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_RDB_BACKUP_BYTES) throw new DatabaseAdapterError('REDIS_BACKUP_FILE_LIMIT_EXCEEDED', 'A Redis sealed backup artifact exceeds the supported limit.', { category: 'capacity' });
        if (rdbHeaderRequired && header.length < 9) header = Buffer.concat([header, chunk.subarray(0, 9 - header.length)]);
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await handle.write(chunk, offset, chunk.length - offset, null);
          if (!written.bytesWritten) throw new DatabaseAdapterError('REDIS_BACKUP_STAGE_WRITE_FAILED', 'The Redis sealed backup staging write did not make progress.', { category: 'execution' });
          offset += written.bytesWritten;
        }
        await context.onProgress?.({ phase: 'transferring', path: artifactPath, bytesRead: chunk.length });
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (rdbHeaderRequired && !/^REDIS\d{4}$/.test(header.toString('ascii'))) throw new DatabaseAdapterError('REDIS_RDB_HEADER_INVALID', 'Redis backup contains a BASE file without a valid RDB header.', { category: 'integrity' });
      const after = await filesystem.lstat(source.sourcePath).catch(() => null);
      if (!after?.isFile || after.isSymbolicLink || after.size !== before.size || after.mtimeMs !== before.mtimeMs || sizeBytes !== before.size) throw new DatabaseAdapterError('REDIS_BACKUP_FILE_CHANGED', `Redis sealed ${source.component} artifact changed while it was being captured.`, { category: 'integrity', retryable: true });
      return { ...source, filePath: destinationPath, artifactPath, sizeBytes, digest: `sha256:${digest.digest('hex')}` };
    } catch (error) {
      await handle?.close().catch(() => {});
      await this.fileSystem.rm(destinationPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #readStableSourceBytes(context, filesystem, sourcePath, maximumBytes = MAX_AOF_MANIFEST_BYTES) {
    const before = await filesystem.lstat(sourcePath).catch(() => null);
    if (!before?.isFile || before.isSymbolicLink || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > maximumBytes) throw new DatabaseAdapterError('REDIS_BACKUP_FILE_INVALID', 'Redis published an invalid AOF manifest.', { category: 'integrity' });
    const chunks = [];
    let sizeBytes = 0;
    for await (const rawChunk of filesystem.read(sourcePath, context.signal)) {
      if (context.signal?.aborted) throw new DatabaseAdapterError('REDIS_OPERATION_CANCELED', 'The Redis AOF backup was canceled.', { category: 'canceled' });
      const chunk = Buffer.from(rawChunk);
      sizeBytes += chunk.length;
      if (sizeBytes > maximumBytes) throw new DatabaseAdapterError('REDIS_BACKUP_FILE_LIMIT_EXCEEDED', 'The Redis AOF manifest exceeds the supported limit.', { category: 'capacity' });
      chunks.push(chunk);
    }
    const after = await filesystem.lstat(sourcePath).catch(() => null);
    if (!after?.isFile || after.isSymbolicLink || after.size !== before.size || after.mtimeMs !== before.mtimeMs || sizeBytes !== before.size) throw new DatabaseAdapterError('REDIS_BACKUP_FILE_CHANGED', 'The Redis AOF manifest changed while it was being read.', { category: 'integrity', retryable: true });
    return Buffer.concat(chunks, sizeBytes);
  }

  async #stageBuffer(bytes, destinationPath, source, artifactPath) {
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    let handle = null;
    try {
      handle = await this.fileSystem.open(destinationPath, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      return { ...source, filePath: destinationPath, artifactPath, sizeBytes: bytes.length, digest: `sha256:${digest}` };
    } catch (error) {
      await handle?.close().catch(() => {});
      await this.fileSystem.rm(destinationPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #restoreAofRewritePolicy(context, config, password, ownership) {
    const identity = await this.readIdentity({ ...context, signal: null }, config);
    if (deploymentFingerprint(identity) !== ownership.serverIdentityFingerprint) throw new DatabaseAdapterError('REDIS_AOF_POLICY_IDENTITY_CHANGED', 'Redis identity changed before AOF rewrite-policy restoration.', { category: 'integrity' });
    const current = identity.persistenceConfig.automaticRewritePercentage;
    if (current !== 0 && current !== ownership.originalAutomaticRewritePercentage) throw new DatabaseAdapterError('REDIS_AOF_POLICY_OWNERSHIP_CHANGED', 'Redis AOF rewrite policy changed outside this backup run.', { category: 'integrity' });
    if (current === 0 && current !== ownership.originalAutomaticRewritePercentage) {
      const reply = responseText(await this.#command(config, password, ['CONFIG', 'SET', 'auto-aof-rewrite-percentage', String(ownership.originalAutomaticRewritePercentage)], null), 'Redis CONFIG SET');
      if (reply.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_AOF_POLICY_RESTORE_FAILED', 'Redis did not restore the automatic AOF rewrite policy.', { category: 'execution' });
    }
    const verified = await this.readIdentity({ ...context, signal: null }, config);
    if (deploymentFingerprint(verified) !== ownership.serverIdentityFingerprint || verified.persistenceConfig.automaticRewritePercentage !== ownership.originalAutomaticRewritePercentage) throw new DatabaseAdapterError('REDIS_AOF_POLICY_RESTORE_UNPROVEN', 'Redis automatic AOF rewrite-policy restoration could not be proven.', { category: 'integrity' });
    await Promise.resolve(context.onSession?.(null)).catch(() => {});
    return verified;
  }

  async createMultipartAofMedia(context = {}, plan = {}, destinationDirectory) {
    if (plan.operation !== 'redis-multipart-aof-backup' || plan.consistency?.proven !== true || plan.consistency?.method !== 'redis-aof') throw new DatabaseAdapterError('REDIS_BACKUP_PLAN_INVALID', 'The Redis multipart-AOF backup plan is invalid.', { category: 'integrity' });
    const config = normalizeConfig(plan.connection);
    const filesystem = context.filesystem;
    if (!filesystem || typeof filesystem.resolveAofPath !== 'function' || typeof filesystem.lstat !== 'function' || typeof filesystem.read !== 'function') throw new DatabaseAdapterError('REDIS_FILESYSTEM_EXECUTOR_INVALID', 'The paired Redis filesystem executor cannot capture multipart AOF files.', { category: 'configuration' });
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('REDIS_SECRET_RESOLVER_MISSING', 'Redis credentials are unavailable.', { category: 'authentication' });
    const destination = path.resolve(requiredText(destinationDirectory, 'Redis multipart-AOF staging directory'));
    if (await this.fileSystem.lstat(destination).catch(() => null)) throw new DatabaseAdapterError('REDIS_BACKUP_DESTINATION_EXISTS', 'The Redis multipart-AOF staging directory already exists.', { category: 'integrity' });
    const password = String(await context.resolveSecret(config.passwordSecretRefId));
    if (!password || password.includes('\0') || password.length > 8192) throw new DatabaseAdapterError('REDIS_CREDENTIAL_INVALID', 'Redis password cannot be represented safely.', { category: 'authentication' });
    const initial = await this.readIdentity(context, config);
    validateIdentity(config, initial, { forBackup: true });
    if (plan.expectedClusterNodeId && (initial.cluster?.selfNodeId !== plan.expectedClusterNodeId || clusterTopologyFingerprint(initial.cluster) !== plan.expectedClusterTopologyFingerprint)) throw new DatabaseAdapterError('REDIS_CLUSTER_MASTER_IDENTITY_CHANGED', 'Redis Cluster master identity changed before multipart-AOF capture.', { category: 'integrity' });
    if (initial.backupStrategy !== 'multipart-aof' || !initial.persistenceConfig.appendOnly || !initial.persistenceConfig.appendDirectoryName || !initial.persistenceConfig.appendFilename) throw new DatabaseAdapterError('REDIS_MULTIPART_AOF_UNAVAILABLE', 'Redis did not expose an executable multipart-AOF layout.', { category: 'compatibility' });
    const fingerprint = deploymentFingerprint(initial);
    if (fingerprint !== plan.consistency.evidence?.serverIdentityFingerprint) throw new DatabaseAdapterError('REDIS_IDENTITY_CHANGED', 'Redis identity changed after multipart-AOF planning.', { category: 'integrity' });
    const ownership = { version: 1, kind: 'multipart-aof-rewrite-policy', originalAutomaticRewritePercentage: initial.persistenceConfig.automaticRewritePercentage, serverIdentityFingerprint: fingerprint };
    let policyOwned = false;
    let writesPaused = false;
    let localCreated = false;
    try {
      await context.onSession?.(ownership);
      policyOwned = true;
      if (ownership.originalAutomaticRewritePercentage !== 0) {
        const reply = responseText(await this.#command(config, password, ['CONFIG', 'SET', 'auto-aof-rewrite-percentage', '0'], context.signal), 'Redis CONFIG SET');
        if (reply.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_AOF_POLICY_DISABLE_FAILED', 'Redis did not disable automatic AOF rewrites for capture.', { category: 'execution' });
      }
      const boundary = await this.readIdentity(context, config);
      validateIdentity(config, boundary, { forBackup: true });
      if (deploymentFingerprint(boundary) !== fingerprint || boundary.persistenceConfig.automaticRewritePercentage !== 0 || boundary.persistenceConfig.appendDirectoryName !== initial.persistenceConfig.appendDirectoryName || boundary.persistenceConfig.appendFilename !== initial.persistenceConfig.appendFilename) throw new DatabaseAdapterError('REDIS_AOF_BOUNDARY_CHANGED', 'Redis could not establish the planned multipart-AOF publication boundary.', { category: 'integrity' });
      const pauseReply = responseText(await this.#command(config, password, ['CLIENT', 'PAUSE', String(this.maximumAofPauseMs), 'WRITE'], context.signal), 'Redis CLIENT PAUSE');
      if (pauseReply.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_AOF_WRITE_PAUSE_FAILED', 'Redis did not establish the bounded write pause required for multipart-AOF capture.', { category: 'execution' });
      writesPaused = true;
      const pausedIdentity = await this.readIdentity(context, config);
      validateIdentity(config, pausedIdentity, { forBackup: true });
      if (deploymentFingerprint(pausedIdentity) !== fingerprint || pausedIdentity.persistenceConfig.automaticRewritePercentage !== 0) throw new DatabaseAdapterError('REDIS_AOF_BOUNDARY_CHANGED', 'Redis identity changed after the multipart-AOF write pause.', { category: 'integrity' });
      const manifestFilename = safePersistenceName(`${boundary.persistenceConfig.appendFilename}.manifest`, 'Redis AOF manifest filename');
      const manifestPath = filesystem.resolveAofPath(boundary.persistenceConfig.directory, boundary.persistenceConfig.appendDirectoryName, manifestFilename);
      const firstManifest = await this.#readStableSourceBytes(context, filesystem, manifestPath);
      const manifestEntries = parseAofManifest(firstManifest);
      await this.fileSystem.mkdir(destination, { recursive: false, mode: 0o700 });
      localCreated = true;
      const stagedFiles = [];
      for (const entry of manifestEntries) {
        const baseRdb = entry.type === 'b' && /[.]base[.]rdb$/.test(entry.filename);
        const baseAof = entry.type === 'b' && /[.]base[.]aof$/.test(entry.filename);
        const increment = entry.type === 'i' && /[.]incr[.]aof$/.test(entry.filename);
        if (!baseRdb && !baseAof && !increment) throw new DatabaseAdapterError('REDIS_BACKUP_MANIFEST_INVALID', 'Redis multipart-AOF manifest contains an unsupported persistence filename.', { category: 'integrity' });
        const source = {
          component: entry.type === 'b' ? 'base' : 'increment',
          filename: entry.filename,
          sourcePath: filesystem.resolveAofPath(boundary.persistenceConfig.directory, boundary.persistenceConfig.appendDirectoryName, entry.filename),
          rdbHeaderRequired: baseRdb,
          mediaType: baseRdb ? 'application/x-redis-rdb' : 'application/x-redis-aof'
        };
        stagedFiles.push(await this.#stageSealedFile(context, filesystem, source, path.join(destination, source.filename), `${plan.artifact.pathPrefix}/${source.filename}`));
      }
      const secondManifest = await this.#readStableSourceBytes(context, filesystem, manifestPath);
      if (!firstManifest.equals(secondManifest)) throw new DatabaseAdapterError('REDIS_BACKUP_MANIFEST_CHANGED', 'Redis multipart-AOF manifest changed during capture.', { category: 'integrity', retryable: true });
      const manifestSource = { component: 'manifest', filename: manifestFilename, sourcePath: manifestPath, rdbHeaderRequired: false, mediaType: 'text/plain' };
      stagedFiles.push(await this.#stageBuffer(secondManifest, path.join(destination, manifestFilename), manifestSource, `${plan.artifact.pathPrefix}/${manifestFilename}`));
      const finalIdentity = await this.readIdentity(context, config);
      validateIdentity(config, finalIdentity, { forBackup: true });
      if (plan.expectedClusterNodeId && (finalIdentity.cluster?.selfNodeId !== plan.expectedClusterNodeId || clusterTopologyFingerprint(finalIdentity.cluster) !== plan.expectedClusterTopologyFingerprint)) throw new DatabaseAdapterError('REDIS_CLUSTER_TOPOLOGY_CHANGED', 'Redis Cluster topology changed during multipart-AOF capture.', { category: 'integrity' });
      if (deploymentFingerprint(finalIdentity) !== fingerprint || finalIdentity.persistenceConfig.automaticRewritePercentage !== 0 || finalIdentity.runId !== initial.runId || finalIdentity.replicationId !== initial.replicationId || finalIdentity.replicationOffset !== pausedIdentity.replicationOffset) throw new DatabaseAdapterError('REDIS_HISTORY_CHANGED', 'Redis identity or replication offset changed during the multipart-AOF write pause.', { category: 'integrity' });
      const unpauseReply = responseText(await this.#command(config, password, ['CLIENT', 'UNPAUSE'], null), 'Redis CLIENT UNPAUSE');
      if (unpauseReply.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_AOF_WRITE_RESUME_FAILED', 'Redis did not end the multipart-AOF write pause.', { category: 'execution' });
      writesPaused = false;
      const restoredIdentity = await this.#restoreAofRewritePolicy(context, config, password, ownership);
      policyOwned = false;
      return {
        directory: destination,
        files: stagedFiles,
        sizeBytes: stagedFiles.reduce((total, file) => total + file.sizeBytes, 0),
        manifestEntries,
        before: { runId: pausedIdentity.runId, replicationId: pausedIdentity.replicationId, replicationOffset: pausedIdentity.replicationOffset },
        after: { runId: restoredIdentity.runId, replicationId: restoredIdentity.replicationId, replicationOffset: restoredIdentity.replicationOffset },
        rewritePolicy: { originalAutomaticRewritePercentage: ownership.originalAutomaticRewritePercentage, restored: true }
      };
    } catch (error) {
      let unpauseError = null;
      let restoreError = null;
      if (writesPaused) {
        try {
          const reply = responseText(await this.#command(config, password, ['CLIENT', 'UNPAUSE'], null), 'Redis CLIENT UNPAUSE');
          if (reply.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_AOF_WRITE_RESUME_FAILED', 'Redis did not end the multipart-AOF write pause.', { category: 'execution' });
        } catch (failure) { unpauseError = failure; }
      }
      if (policyOwned) await this.#restoreAofRewritePolicy(context, config, password, ownership).catch((failure) => { restoreError = failure; });
      if (localCreated) await this.fileSystem.rm(destination, { recursive: true, force: true }).catch(() => {});
      if (unpauseError || restoreError) throw new DatabaseAdapterError('REDIS_AOF_CLEANUP_UNPROVEN', 'Redis multipart-AOF failure cleanup could not prove write-resume and rewrite-policy restoration; inspect the server before retrying.', {
        category: 'integrity', details: { captureErrorCode: error?.code || null, unpauseErrorCode: unpauseError?.code || null, restoreErrorCode: restoreError?.code || null }
      });
      throw safeAdapterError(error, 'multipart AOF capture');
    }
  }

  async createSealedBackupMedia(context = {}, plan = {}, destinationDirectory) {
    if (plan.operation !== 'redis-sealed-backup' || plan.consistency?.proven !== true || plan.consistency?.method !== 'redis-aof') throw new DatabaseAdapterError('REDIS_BACKUP_PLAN_INVALID', 'The Redis sealed backup plan is invalid.', { category: 'integrity' });
    const config = normalizeConfig(plan.connection);
    const filesystem = context.filesystem;
    if (!filesystem || typeof filesystem.validateBackupPath !== 'function' || typeof filesystem.lstat !== 'function' || typeof filesystem.read !== 'function') throw new DatabaseAdapterError('REDIS_FILESYSTEM_EXECUTOR_INVALID', 'The paired Redis filesystem executor cannot capture sealed backup files.', { category: 'configuration' });
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('REDIS_SECRET_RESOLVER_MISSING', 'Redis credentials are unavailable.', { category: 'authentication' });
    const destination = path.resolve(requiredText(destinationDirectory, 'Redis sealed backup staging directory'));
    if (await this.fileSystem.lstat(destination).catch(() => null)) throw new DatabaseAdapterError('REDIS_BACKUP_DESTINATION_EXISTS', 'The Redis sealed backup staging directory already exists.', { category: 'integrity' });
    const password = String(await context.resolveSecret(config.passwordSecretRefId));
    if (!password || password.includes('\0') || password.length > 8192) throw new DatabaseAdapterError('REDIS_CREDENTIAL_INVALID', 'Redis password cannot be represented safely.', { category: 'authentication' });
    const initial = await this.readIdentity(context, config);
    validateIdentity(config, initial, { forBackup: true });
    if (plan.expectedClusterNodeId && (initial.cluster?.selfNodeId !== plan.expectedClusterNodeId || clusterTopologyFingerprint(initial.cluster) !== plan.expectedClusterTopologyFingerprint)) throw new DatabaseAdapterError('REDIS_CLUSTER_MASTER_IDENTITY_CHANGED', 'Redis Cluster master identity changed before sealed backup capture.', { category: 'integrity' });
    if (!initial.backupCommandAvailable) throw new DatabaseAdapterError('REDIS_SEALED_BACKUP_UNAVAILABLE', 'Redis 8.10 sealed backup commands are unavailable.', { category: 'compatibility' });
    if (initial.persistenceConfig.backupSealedTtlSeconds !== 0) throw new DatabaseAdapterError('REDIS_BACKUP_TTL_UNSAFE', 'Set backup-sealed-ttl to 0 before running a sealed backup.', { category: 'configuration' });
    const fingerprint = deploymentFingerprint(initial);
    if (fingerprint !== plan.consistency.evidence?.serverIdentityFingerprint) throw new DatabaseAdapterError('REDIS_IDENTITY_CHANGED', 'Redis identity changed after sealed-backup planning.', { category: 'integrity' });
    const initialStatus = await this.#backupStatus(config, password, context.signal);
    if (initialStatus.state !== 'idle') throw new DatabaseAdapterError('REDIS_BACKUP_SESSION_BUSY', 'Redis already has a backup session that is not owned by this run.', { category: 'concurrency', retryable: true });
    let ownedStartTime = null;
    let sessionStarted = false;
    let localCreated = false;
    try {
      const started = responseText(await this.#command(config, password, ['BACKUP', 'START'], context.signal), 'Redis BACKUP START');
      if (started.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_BACKUP_START_FAILED', 'Redis did not start the sealed backup session.', { category: 'execution' });
      sessionStarted = true;
      const maximumPolls = Math.max(1, Math.ceil(this.maximumSealedWaitMs / 250));
      let incrementingStatus = null;
      for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
        const status = await this.#backupStatus(config, password, context.signal);
        if (status.startTime > 0 && ownedStartTime === null) {
          ownedStartTime = status.startTime;
          await context.onSession?.({ version: 1, state: status.state, startTime: ownedStartTime, serverIdentityFingerprint: fingerprint });
        }
        if (ownedStartTime !== null && status.startTime !== ownedStartTime) throw new DatabaseAdapterError('REDIS_BACKUP_OWNERSHIP_CHANGED', 'Redis backup session ownership changed during snapshot creation.', { category: 'integrity' });
        if (status.failed) throw new DatabaseAdapterError('REDIS_BACKUP_SESSION_FAILED', 'Redis failed while producing the sealed backup BASE snapshot.', { category: 'execution' });
        if (status.state === 'incrementing') { incrementingStatus = status; break; }
        if (!['pending', 'snapshotting'].includes(status.state)) throw new DatabaseAdapterError('REDIS_BACKUP_STATE_INVALID', 'Redis entered an invalid state before sealed-backup finalization.', { category: 'integrity' });
        await this.delay(250);
      }
      if (!incrementingStatus || ownedStartTime === null) throw new DatabaseAdapterError('REDIS_BACKUP_SNAPSHOT_TIMEOUT', 'Redis did not finish the sealed backup BASE snapshot within the allowed time.', { category: 'timeout', retryable: true });
      const sealedReply = responseText(await this.#command(config, password, ['BACKUP', 'SEAL'], context.signal), 'Redis BACKUP SEAL');
      if (sealedReply.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_BACKUP_SEAL_FAILED', 'Redis did not seal the backup artifact set.', { category: 'execution' });
      let sealedStatus = null;
      for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
        const status = await this.#backupStatus(config, password, context.signal);
        if (status.startTime !== ownedStartTime) throw new DatabaseAdapterError('REDIS_BACKUP_OWNERSHIP_CHANGED', 'Redis backup session ownership changed during sealing.', { category: 'integrity' });
        if (status.failed) throw new DatabaseAdapterError('REDIS_BACKUP_SESSION_FAILED', 'Redis failed while sealing the backup artifact set.', { category: 'execution' });
        if (status.state === 'sealed') { sealedStatus = status; break; }
        if (status.state !== 'incrementing') throw new DatabaseAdapterError('REDIS_BACKUP_STATE_INVALID', 'Redis entered an invalid state while sealing the backup.', { category: 'integrity' });
        await this.delay(250);
      }
      if (!sealedStatus || sealedStatus.endTime < sealedStatus.startTime) throw new DatabaseAdapterError('REDIS_BACKUP_SEAL_TIMEOUT', 'Redis did not seal the backup within the allowed time.', { category: 'timeout', retryable: true });
      await context.onSession?.({ version: 1, state: 'sealed', startTime: ownedStartTime, endTime: sealedStatus.endTime, serverIdentityFingerprint: fingerprint });
      const listed = await this.#command(config, password, ['BACKUP', 'LIST'], context.signal);
      const sources = classifySealedBackupFiles(listed, filesystem, initial);
      await this.fileSystem.mkdir(destination, { recursive: false, mode: 0o700 });
      localCreated = true;
      const stagedFiles = [];
      for (const source of sources) {
        const artifactPath = `${plan.artifact.pathPrefix}/${source.filename}`;
        stagedFiles.push(await this.#stageSealedFile(context, filesystem, source, path.join(destination, source.filename), artifactPath));
      }
      const base = stagedFiles.find((file) => file.component === 'base');
      const increment = stagedFiles.find((file) => file.component === 'increment');
      const manifest = stagedFiles.find((file) => file.component === 'manifest');
      const manifestEntries = parseAofManifest(await this.fileSystem.readFile(manifest.filePath), { baseFilename: base.filename, incrementFilename: increment.filename, exactSealed: true });
      const finalIdentity = await this.readIdentity(context, config);
      validateIdentity(config, finalIdentity);
      if (plan.expectedClusterNodeId && (finalIdentity.cluster?.selfNodeId !== plan.expectedClusterNodeId || clusterTopologyFingerprint(finalIdentity.cluster) !== plan.expectedClusterTopologyFingerprint)) throw new DatabaseAdapterError('REDIS_CLUSTER_TOPOLOGY_CHANGED', 'Redis Cluster topology changed during sealed backup capture.', { category: 'integrity' });
      if (finalIdentity.runId !== initial.runId || finalIdentity.replicationId !== initial.replicationId) throw new DatabaseAdapterError('REDIS_HISTORY_CHANGED', 'Redis replication history changed during sealed backup capture.', { category: 'integrity' });
      const cleanupReply = responseText(await this.#command(config, password, ['BACKUP', 'CLEANUP'], null), 'Redis BACKUP CLEANUP');
      if (cleanupReply.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_BACKUP_CLEANUP_FAILED', 'Redis did not clean up the sealed backup session.', { category: 'execution' });
      const finalStatus = await this.#backupStatus(config, password, null);
      if (finalStatus.state !== 'idle') throw new DatabaseAdapterError('REDIS_BACKUP_CLEANUP_UNPROVEN', 'Redis did not return to idle after sealed-backup cleanup.', { category: 'integrity' });
      sessionStarted = false;
      await context.onSession?.(null);
      return {
        directory: destination,
        files: stagedFiles,
        sizeBytes: stagedFiles.reduce((total, file) => total + file.sizeBytes, 0),
        manifestEntries,
        before: { runId: initial.runId, replicationId: initial.replicationId, replicationOffset: initial.replicationOffset },
        after: { runId: finalIdentity.runId, replicationId: finalIdentity.replicationId, replicationOffset: finalIdentity.replicationOffset },
        session: { startTime: sealedStatus.startTime, endTime: sealedStatus.endTime }
      };
    } catch (error) {
      let cleanupError = null;
      if (sessionStarted && ownedStartTime === null) {
        cleanupError = new DatabaseAdapterError('REDIS_BACKUP_OWNERSHIP_UNPROVEN', 'Redis started a backup session but its start time could not be observed safely.', { category: 'integrity' });
      } else if (sessionStarted) {
        try {
          let status = await this.#backupStatus(config, password, null);
          if (status.startTime === ownedStartTime) {
            if (['pending', 'snapshotting', 'incrementing'].includes(status.state)) {
              const abortReply = responseText(await this.#command(config, password, ['BACKUP', 'ABORT'], null), 'Redis BACKUP ABORT');
              if (abortReply.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_BACKUP_ABORT_FAILED', 'Redis did not abort the owned backup session.', { category: 'execution' });
              status = await this.#backupStatus(config, password, null);
            }
            if (['failed', 'sealed'].includes(status.state)) {
              const cleanupReply = responseText(await this.#command(config, password, ['BACKUP', 'CLEANUP'], null), 'Redis BACKUP CLEANUP');
              if (cleanupReply.toUpperCase() !== 'OK') throw new DatabaseAdapterError('REDIS_BACKUP_CLEANUP_FAILED', 'Redis did not clean up the owned backup session.', { category: 'execution' });
              status = await this.#backupStatus(config, password, null);
            }
            if (status.state !== 'idle') throw new DatabaseAdapterError('REDIS_BACKUP_CLEANUP_UNPROVEN', 'Redis did not return to idle after sealed-backup failure cleanup.', { category: 'integrity' });
            await Promise.resolve(context.onSession?.(null)).catch(() => {});
          } else {
            throw new DatabaseAdapterError('REDIS_BACKUP_OWNERSHIP_CHANGED', 'Redis backup session ownership changed before failure cleanup.', { category: 'integrity' });
          }
        } catch (failure) { cleanupError = failure; }
      }
      if (localCreated) await this.fileSystem.rm(destination, { recursive: true, force: true }).catch(() => {});
      if (cleanupError) throw new DatabaseAdapterError('REDIS_BACKUP_CLEANUP_UNPROVEN', 'Redis sealed-backup failure cleanup could not be proven; inspect the server backup status before retrying.', {
        category: 'integrity',
        details: { captureErrorCode: error?.code || null, cleanupErrorCode: cleanupError?.code || null }
      });
      throw safeAdapterError(error, 'sealed backup capture');
    }
  }

  async reconcileBackupSession(context = {}, input = {}, ownership = {}) {
    const config = normalizeConfig(input);
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('REDIS_SECRET_RESOLVER_MISSING', 'Redis credentials are unavailable.', { category: 'authentication' });
    const password = String(await context.resolveSecret(config.passwordSecretRefId));
    if (ownership.kind === 'multipart-aof-rewrite-policy') {
      if (!Number.isSafeInteger(ownership.originalAutomaticRewritePercentage) || ownership.originalAutomaticRewritePercentage < 0) return { proven: false, reconciled: false, reasonCode: 'REDIS_AOF_RECONCILIATION_OWNER_INVALID' };
      const before = await this.readIdentity(context, config);
      if (deploymentFingerprint(before) !== ownership.serverIdentityFingerprint) return { proven: false, reconciled: false, reasonCode: 'REDIS_RECONCILIATION_IDENTITY_CHANGED' };
      if (before.persistenceConfig.automaticRewritePercentage === ownership.originalAutomaticRewritePercentage) return { proven: true, reconciled: false, state: 'restored' };
      if (before.persistenceConfig.automaticRewritePercentage !== 0) return { proven: false, reconciled: false, state: 'changed', reasonCode: 'REDIS_AOF_RECONCILIATION_OWNERSHIP_CHANGED' };
      const verified = await this.#restoreAofRewritePolicy(context, config, password, ownership);
      return { proven: true, reconciled: true, previousValue: 0, value: verified.persistenceConfig.automaticRewritePercentage, state: 'restored' };
    }
    const identity = await this.readIdentity(context, config);
    if (deploymentFingerprint(identity) !== ownership.serverIdentityFingerprint) return { proven: false, reconciled: false, reasonCode: 'REDIS_RECONCILIATION_IDENTITY_CHANGED' };
    let status = await this.#backupStatus(config, password, null);
    if (status.state === 'idle') return { proven: true, reconciled: false, state: 'idle' };
    if (!Number.isSafeInteger(ownership.startTime) || status.startTime !== ownership.startTime) return { proven: false, reconciled: false, state: status.state, reasonCode: 'REDIS_RECONCILIATION_OWNERSHIP_CHANGED' };
    if (['pending', 'snapshotting', 'incrementing'].includes(status.state)) {
      await this.#command(config, password, ['BACKUP', 'ABORT'], null);
      status = await this.#backupStatus(config, password, null);
    }
    if (['failed', 'sealed'].includes(status.state)) await this.#command(config, password, ['BACKUP', 'CLEANUP'], null);
    const final = await this.#backupStatus(config, password, null);
    if (final.state !== 'idle') throw new DatabaseAdapterError('REDIS_BACKUP_RECONCILIATION_FAILED', 'Redis backup session reconciliation did not return to idle.', { category: 'integrity' });
    return { proven: true, reconciled: true, previousState: status.state, state: 'idle' };
  }

  async executeBackup(context = {}, plan = {}, sink) {
    if (!sink || typeof sink.write !== 'function') throw new TypeError('Redis backup artifact sink is required.');
    const destinationPath = requiredText(context.destinationPath, 'Redis staging destination');
    if (['redis-sealed-backup', 'redis-multipart-aof-backup'].includes(plan.operation)) {
      const media = plan.operation === 'redis-sealed-backup'
        ? await this.createSealedBackupMedia(context, plan, destinationPath)
        : await this.createMultipartAofMedia(context, plan, destinationPath);
      const artifacts = [];
      for (const file of media.files) artifacts.push(await sink.write({ kind: 'physical-backup', path: file.artifactPath, mediaType: file.mediaType || (file.component === 'base' ? 'application/x-redis-rdb' : file.component === 'increment' ? 'application/x-redis-aof' : 'text/plain'), content: this.createReadStream(file.filePath), metadata: { component: file.component, digest: file.digest, sizeBytes: file.sizeBytes } }));
      return { status: 'succeeded', artifacts, media };
    }
    const media = await this.createRdbMedia(context, plan, destinationPath);
    const stored = await sink.write({ kind: plan.artifact.kind, path: plan.artifact.path, mediaType: plan.artifact.mediaType, content: this.createReadStream(media.filePath), metadata: { digest: media.digest, sizeBytes: media.sizeBytes, before: media.before, after: media.after } });
    return { status: 'succeeded', artifacts: [stored], media };
  }

  async planRestore(_context = {}, request = {}) {
    if (request.mode !== 'alternate' || request.confirmation !== 'RESTORE_REDIS_ALTERNATE') throw new DatabaseAdapterError('REDIS_RESTORE_MODE_UNSUPPORTED', 'Redis recovery supports a confirmed isolated alternate directory only.', { category: 'compatibility' });
    const targetInput = requiredText(request.targetDirectory, 'Redis recovery target directory');
    if (!path.isAbsolute(targetInput) || path.normalize(targetInput) !== targetInput) throw new DatabaseAdapterError('REDIS_RESTORE_TARGET_INVALID', 'Choose a canonical absolute directory for Redis recovery.', { category: 'validation' });
    const targetDirectory = path.resolve(targetInput);
    if (await this.fileSystem.lstat(targetDirectory).catch(() => null)) throw new DatabaseAdapterError('REDIS_RESTORE_TARGET_EXISTS', 'Choose an absent directory for alternate Redis recovery.', { category: 'conflict' });
    const parentDirectory = path.dirname(targetDirectory);
    const parent = await this.fileSystem.lstat(parentDirectory).catch(() => null);
    if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new DatabaseAdapterError('REDIS_RESTORE_PARENT_INVALID', 'Choose an existing regular parent directory for Redis recovery.', { category: 'validation' });
    const realParent = await this.fileSystem.realpath(parentDirectory);
    const comparable = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (comparable(realParent) !== comparable(parentDirectory)) throw new DatabaseAdapterError('REDIS_RESTORE_PARENT_SYMLINK_REFUSED', 'Redis recovery paths must not traverse a symbolic link.', { category: 'integrity' });
    const metadata = normalizeRestoreMetadata(request.metadata);
    const port = Number(request.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new DatabaseAdapterError('REDIS_RESTORE_PORT_INVALID', 'Redis isolated validation port must be between 1024 and 65535.', { category: 'validation' });
    const timeoutMs = normalizeTimeout(request.timeoutMs);
    const stageDirectory = redisRestorePath(targetDirectory, request.executionId, 'stage');
    const validationDirectory = redisRestorePath(targetDirectory, request.executionId, 'validate');
    if (await this.fileSystem.lstat(stageDirectory).catch(() => null) || await this.fileSystem.lstat(validationDirectory).catch(() => null)) throw new DatabaseAdapterError('REDIS_RESTORE_STAGE_EXISTS', 'A Redis recovery staging directory already exists for this execution.', { category: 'conflict' });
    const layout = metadata.artifacts.map((artifact) => ({
      ...artifact,
      relativePath: metadata.kind === 'redis-rdb' ? 'dump.rdb' : `${metadata.kind === 'redis-multipart-aof' ? 'appendonlydir' : 'sealed'}/${artifact.filename}`
    }));
    const manifest = layout.find((artifact) => artifact.component === 'manifest') || null;
    const appendFilename = metadata.kind === 'redis-multipart-aof' ? manifest.filename.replace(/[.]manifest$/, '') : null;
    if (metadata.kind === 'redis-multipart-aof' && (!manifest.filename.endsWith('.manifest') || !appendFilename)) throw new DatabaseAdapterError('REDIS_RESTORE_METADATA_INVALID', 'Redis multipart-AOF manifest filename is invalid.', { category: 'integrity' });
    return {
      version: 1,
      operation: 'redis-isolated-alternate-restore',
      targetDirectory,
      stageDirectory,
      validationDirectory,
      port,
      timeoutMs,
      redisServerExecutable: normalizeServerExecutable(request.redisServerExecutable),
      redisCliExecutable: normalizeExecutable(request.redisCliExecutable),
      metadata,
      layout,
      manifestRelativePath: manifest?.relativePath || null,
      appendFilename
    };
  }

  async #writeRestoreArtifact(context, source, artifact, destinations) {
    const handles = [];
    const digest = crypto.createHash('sha256');
    let sizeBytes = 0;
    let header = Buffer.alloc(0);
    try {
      for (const destination of destinations) handles.push(await this.fileSystem.open(destination, 'wx', 0o600));
      const content = await source.open(artifact.path);
      if (!content || typeof content[Symbol.asyncIterator] !== 'function') throw new DatabaseAdapterError('REDIS_RESTORE_SOURCE_INVALID', 'Redis recovery artifact content is unavailable.', { category: 'integrity' });
      for await (const rawChunk of content) {
        if (context.signal?.aborted) throw new DatabaseAdapterError('REDIS_RESTORE_CANCELED', 'The Redis recovery was canceled before publication.', { category: 'canceled' });
        const chunk = Buffer.from(rawChunk);
        sizeBytes += chunk.length;
        if (sizeBytes > artifact.sizeBytes) throw new DatabaseAdapterError('REDIS_RESTORE_SIZE_MISMATCH', 'A Redis recovery artifact exceeds its authenticated size.', { category: 'integrity' });
        if ((artifact.component === 'rdb' || (artifact.component === 'base' && artifact.filename.endsWith('.rdb'))) && header.length < 9) header = Buffer.concat([header, chunk.subarray(0, 9 - header.length)]);
        digest.update(chunk);
        for (const handle of handles) {
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(chunk, offset, chunk.length - offset, null);
            if (!written.bytesWritten) throw new DatabaseAdapterError('REDIS_RESTORE_WRITE_FAILED', 'Redis recovery staging did not make progress.', { category: 'capacity', retryable: true });
            offset += written.bytesWritten;
          }
        }
      }
      if (sizeBytes !== artifact.sizeBytes) throw new DatabaseAdapterError('REDIS_RESTORE_SIZE_MISMATCH', 'A Redis recovery artifact size does not match authenticated metadata.', { category: 'integrity' });
      const contentDigest = `sha256:${digest.digest('hex')}`;
      if (contentDigest !== artifact.contentDigest) throw new DatabaseAdapterError('REDIS_RESTORE_DIGEST_MISMATCH', 'A Redis recovery artifact does not match its authenticated digest.', { category: 'integrity' });
      if ((artifact.component === 'rdb' || (artifact.component === 'base' && artifact.filename.endsWith('.rdb'))) && !/^REDIS\d{4}$/.test(header.toString('ascii'))) throw new DatabaseAdapterError('REDIS_RDB_HEADER_INVALID', 'Redis recovery media does not contain a valid RDB header.', { category: 'integrity' });
      for (const handle of handles) await handle.sync();
      return { path: artifact.path, relativePath: artifact.relativePath, sizeBytes, contentDigest };
    } finally {
      for (const handle of handles) await handle.close().catch(() => {});
    }
  }

  async #serverVersion(plan, signal) {
    const result = await this.processRunner.run({ executable: plan.redisServerExecutable, args: ['--version'], env: {}, timeoutMs: 10000, stdoutLimitBytes: 8192, signal });
    const match = /(?:Redis server )?v(?:ersion)?[= ](\d+)\.(\d+)\.(\d+)/i.exec(`${result.stdout || ''}\n${result.stderr || ''}`);
    if (!match) throw new DatabaseAdapterError('REDIS_SERVER_VERSION_INVALID', 'redis-server returned an invalid version.', { category: 'compatibility' });
    return parseVersion(`${match[1]}.${match[2]}.${match[3]}`);
  }

  async #restoreCommand(plan, command, signal) {
    const result = await this.processRunner.run({
      executable: plan.redisCliExecutable,
      args: ['-h', '127.0.0.1', '-p', String(plan.port), '--json', '--no-auth-warning', ...command],
      env: {}, timeoutMs: Math.min(plan.timeoutMs, 30000), stdoutLimitBytes: 2 * 1024 * 1024, signal
    });
    return parseCliJson(result.stdout, `Redis isolated ${command.join(' ')}`);
  }

  async #validateIsolatedRuntime(context, plan) {
    if (typeof this.processRunner.stream !== 'function') throw new DatabaseAdapterError('REDIS_SERVER_RUNNER_UNAVAILABLE', 'The native process runner cannot start an isolated Redis validation process.', { category: 'compatibility' });
    const targetVersion = await this.#serverVersion(plan, context.signal);
    const sourceVersion = plan.metadata.serverVersion;
    if (targetVersion.major < sourceVersion.major || (plan.metadata.kind === 'redis-sealed-backup' && !atLeast(targetVersion, 8, 10))) throw new DatabaseAdapterError('REDIS_RESTORE_VERSION_INCOMPATIBLE', 'The selected redis-server cannot load this Redis recovery artifact safely.', { category: 'compatibility' });
    const args = ['--bind', '127.0.0.1', '--protected-mode', 'yes', '--port', String(plan.port), '--daemonize', 'no', '--dir', plan.validationDirectory, '--loglevel', 'warning'];
    if (plan.metadata.kind === 'redis-rdb') args.push('--dbfilename', 'dump.rdb', '--appendonly', 'no');
    else if (plan.metadata.kind === 'redis-multipart-aof') args.push('--dbfilename', 'unused.rdb', '--appendonly', 'yes', '--appendfilename', plan.appendFilename, '--appenddirname', 'appendonlydir', '--aof-load-truncated', 'no');
    else args.push('--dbfilename', 'unused.rdb', '--appendonly', 'no', '--preload-file', `aof:${path.join(plan.validationDirectory, plan.manifestRelativePath)}`);
    const server = this.processRunner.stream({ executable: plan.redisServerExecutable, args, env: {}, cwd: plan.validationDirectory, timeoutMs: plan.timeoutMs, stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 1024 * 1024, signal: context.signal });
    server.stdout?.resume?.();
    let exited = false;
    let exitError = null;
    server.completion.then(() => { exited = true; }, (error) => { exited = true; exitError = error; });
    let ping = null;
    try {
      const maximumPolls = Math.max(1, Math.ceil(Math.min(plan.timeoutMs, 30000) / 250));
      for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
        if (context.signal?.aborted) throw new DatabaseAdapterError('REDIS_RESTORE_CANCELED', 'The Redis recovery was canceled before publication.', { category: 'canceled' });
        if (exited) throw exitError || new DatabaseAdapterError('REDIS_RESTORE_SERVER_EXITED', 'The isolated Redis validation process exited before validation.', { category: 'integrity' });
        try { ping = await this.#restoreCommand(plan, ['PING'], context.signal); break; }
        catch (error) { if (attempt + 1 === maximumPolls) throw error; await this.delay(250); }
      }
      if (String(ping).toUpperCase() !== 'PONG') throw new DatabaseAdapterError('REDIS_RESTORE_PING_FAILED', 'The isolated Redis validation process did not return PONG.', { category: 'integrity' });
      const [serverInfoRaw, persistenceRaw, keyspaceRaw, roleRaw] = await Promise.all([
        this.#restoreCommand(plan, ['INFO', 'server'], context.signal),
        this.#restoreCommand(plan, ['INFO', 'persistence'], context.signal),
        this.#restoreCommand(plan, ['INFO', 'keyspace'], context.signal),
        this.#restoreCommand(plan, ['ROLE'], context.signal)
      ]);
      const serverInfo = parseInfo(serverInfoRaw, 'Redis isolated INFO server');
      const persistence = parseInfo(persistenceRaw, 'Redis isolated INFO persistence');
      const databases = parseKeyspace(parseInfo(keyspaceRaw, 'Redis isolated INFO keyspace'));
      const role = parseRole(roleRaw);
      if (persistence.loading === '1' || String(persistence.rdb_last_bgsave_status || 'ok').toLowerCase() !== 'ok' || (persistence.aof_enabled === '1' && (String(persistence.aof_last_bgrewrite_status || 'ok').toLowerCase() !== 'ok' || String(persistence.aof_last_write_status || 'ok').toLowerCase() !== 'ok'))) throw new DatabaseAdapterError('REDIS_RESTORE_PERSISTENCE_INVALID', 'The isolated Redis process reported a persistence loading error.', { category: 'integrity' });
      if (role.role !== 'master') throw new DatabaseAdapterError('REDIS_RESTORE_ROLE_INVALID', 'The isolated Redis validation process did not start as an independent master.', { category: 'integrity' });
      const observed = new Map(databases.map((database) => [database.name, database]));
      const warnings = [];
      for (const expected of plan.metadata.expectedDatabases) {
        const actual = observed.get(expected.name) || { keys: 0, expires: 0 };
        if (actual.keys > expected.keys) throw new DatabaseAdapterError('REDIS_RESTORE_KEYSPACE_DIVERGED', 'The isolated Redis keyspace exceeds the protected key count.', { category: 'integrity' });
        if (actual.expires > expected.expires || expected.keys - actual.keys > expected.expires) throw new DatabaseAdapterError('REDIS_RESTORE_KEYSPACE_DIVERGED', 'The isolated Redis keyspace differs by more keys than protected expirations can explain.', { category: 'integrity' });
        if (actual.keys !== expected.keys) warnings.push(`${expected.name} restored ${actual.keys} of ${expected.keys} protected keys; up to ${expected.expires} protected expirations may have elapsed.`);
      }
      await this.processRunner.run({ executable: plan.redisCliExecutable, args: ['-h', '127.0.0.1', '-p', String(plan.port), 'SHUTDOWN', 'NOSAVE'], env: {}, timeoutMs: 30000, stdoutLimitBytes: 8192, signal: null });
      await server.completion;
      exited = true;
      return { valid: true, targetVersion: targetVersion.text, loadedVersion: serverInfo.redis_version || targetVersion.text, role: role.role, databases, warnings };
    } finally {
      if (!exited) {
        server.cancel?.();
        await server.completion.catch(() => {});
      }
    }
  }

  async executeRestore(context = {}, plan = {}, source) {
    if (plan.operation !== 'redis-isolated-alternate-restore' || !source || typeof source.open !== 'function') throw new DatabaseAdapterError('REDIS_RESTORE_PLAN_INVALID', 'The Redis recovery plan is invalid.', { category: 'integrity' });
    let targetClaimed = false;
    try {
      if (context.signal?.aborted) throw new DatabaseAdapterError('REDIS_RESTORE_CANCELED', 'The Redis recovery was canceled before publication.', { category: 'canceled' });
      await this.fileSystem.mkdir(plan.stageDirectory, { recursive: false, mode: 0o700 });
      await this.fileSystem.mkdir(plan.validationDirectory, { recursive: false, mode: 0o700 });
      const written = [];
      for (const artifact of plan.layout) {
        const stagePath = path.join(plan.stageDirectory, artifact.relativePath);
        const validationPath = path.join(plan.validationDirectory, artifact.relativePath);
        await this.fileSystem.mkdir(path.dirname(stagePath), { recursive: true, mode: 0o700 });
        await this.fileSystem.mkdir(path.dirname(validationPath), { recursive: true, mode: 0o700 });
        written.push(await this.#writeRestoreArtifact(context, source, artifact, [stagePath, validationPath]));
      }
      if (plan.metadata.kind !== 'redis-rdb') {
        const manifestPath = path.join(plan.stageDirectory, plan.manifestRelativePath);
        const manifestBytes = await this.fileSystem.readFile(manifestPath);
        const entries = parseAofManifest(manifestBytes, { exactSealed: plan.metadata.kind === 'redis-sealed-backup' });
        const expectedNames = plan.layout.filter((artifact) => ['base', 'increment'].includes(artifact.component)).map((artifact) => artifact.filename).sort();
        if (JSON.stringify(entries.map((entry) => entry.filename).sort()) !== JSON.stringify(expectedNames)) throw new DatabaseAdapterError('REDIS_BACKUP_MANIFEST_MISMATCH', 'Redis recovery manifest membership does not match authenticated artifacts.', { category: 'integrity' });
      }
      const validation = await this.#validateIsolatedRuntime(context, plan);
      await this.fileSystem.rm(plan.validationDirectory, { recursive: true, force: true });
      if (context.signal?.aborted) throw new DatabaseAdapterError('REDIS_RESTORE_CANCELED', 'The Redis recovery was canceled before publication.', { category: 'canceled' });
      if (await this.fileSystem.lstat(plan.targetDirectory).catch(() => null)) throw new DatabaseAdapterError('REDIS_RESTORE_TARGET_EXISTS', 'The alternate Redis target appeared before publication.', { category: 'conflict' });
      try {
        await this.fileSystem.mkdir(plan.targetDirectory, { recursive: false, mode: 0o700 });
        targetClaimed = true;
      } catch (error) {
        if (error?.code === 'EEXIST') throw new DatabaseAdapterError('REDIS_RESTORE_TARGET_EXISTS', 'The alternate Redis target appeared before publication.', { category: 'conflict' });
        throw error;
      }
      const topLevelNames = [...new Set(plan.layout.map((artifact) => artifact.relativePath.split('/')[0]))];
      if (topLevelNames.length !== 1) throw new DatabaseAdapterError('REDIS_RESTORE_LAYOUT_INVALID', 'Redis recovery staging does not have one publishable root.', { category: 'integrity' });
      await this.fileSystem.rename(path.join(plan.stageDirectory, topLevelNames[0]), path.join(plan.targetDirectory, topLevelNames[0]));
      await this.fileSystem.rm(plan.stageDirectory, { recursive: true, force: true });
      let directoryHandle = null;
      try {
        directoryHandle = await this.fileSystem.open(plan.targetDirectory, 'r');
        await directoryHandle.sync();
        await directoryHandle.close();
        directoryHandle = null;
        directoryHandle = await this.fileSystem.open(path.dirname(plan.targetDirectory), 'r');
        await directoryHandle.sync();
      } catch (error) { if (process.platform !== 'win32') throw error; }
      finally { await directoryHandle?.close().catch(() => {}); }
      return { status: 'succeeded', targetDirectory: plan.targetDirectory, artifacts: written, validation, kind: plan.metadata.kind };
    } catch (error) {
      await this.fileSystem.rm(plan.validationDirectory, { recursive: true, force: true }).catch(() => {});
      await this.fileSystem.rm(plan.stageDirectory, { recursive: true, force: true }).catch(() => {});
      if (targetClaimed) throw new DatabaseAdapterError('REDIS_RESTORE_PUBLICATION_UNCERTAIN', 'The alternate Redis target was claimed and may contain validated artifacts. Inspect that directory before any retry.', { category: 'conflict' });
      if (error instanceof DatabaseAdapterError) throw error;
      throw safeAdapterError(error, 'isolated restore');
    }
  }

  async validateRestore(_context = {}, result = {}) {
    if (result.status !== 'succeeded' || !result.validation?.valid) return { valid: false, status: 'failed', nativeIntegrityValidation: false, checks: [] };
    return {
      valid: true,
      status: result.validation.warnings?.length ? 'warning' : 'succeeded',
      nativeIntegrityValidation: true,
      warnings: result.validation.warnings || [],
      checks: [
        { id: 'authenticated-digests', status: 'pass', safeMessage: 'Every Redis recovery artifact matched its authenticated digest and size.' },
        { id: 'native-startup', status: 'pass', safeMessage: 'A disposable loopback-only redis-server loaded the recovery artifacts successfully.' },
        { id: 'persistence-health', status: 'pass', safeMessage: 'Redis reported healthy completed RDB/AOF loading.' },
        { id: 'role-isolation', status: 'pass', safeMessage: 'The validation process started as an independent master and was shut down before publication.' },
        { id: 'keyspace', status: result.validation.warnings?.length ? 'warning' : 'pass', safeMessage: result.validation.warnings?.length ? 'Expired keys reduced one or more logical database counts.' : 'Logical database key counts matched protected evidence.' }
      ]
    };
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class RedisConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new RedisNativeAdapter() } = {}) {
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
    const name = requiredText(input.name, 'Redis connection name', 200);
    const password = String(input.password ?? '');
    if (!password || password.includes('\0') || password.length > 8192) throw new TypeError('Redis password is invalid.');
    let passwordRef = null;
    try {
      passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} Redis password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({
        host: input.host, port: input.port, username: input.username, passwordSecretRefId: passwordRef.id,
        tlsMode: input.tlsMode, caFile: input.caFile, clientCertificateFile: input.clientCertificateFile,
        clientKeyFile: input.clientKeyFile, timeoutMs: input.timeoutMs, redisCliExecutable: input.redisCliExecutable,
        expectedTopology: input.expectedTopology, filesystemConnectionId: input.filesystemConnectionId
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
            username: config.username,
            tlsMode: config.tlsMode,
            caFile: config.caFile,
            clientCertificateFile: config.clientCertificateFile,
            clientKeyFile: config.clientKeyFile,
            timeoutMs: config.timeoutMs,
            redisCliExecutable: config.redisCliExecutable,
            expectedTopology: config.expectedTopology,
            filesystemConnectionId: config.filesystemConnectionId
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
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Redis source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This Redis connection belongs to another device.');
    const result = normalizeConnectionTestResult(await this.adapter.testConnection({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }) }, this.config(current)), { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const trust = result.status === 'success' ? { mode: current.endpoint.tlsMode, fingerprint: result.endpointIdentity?.deploymentFingerprint || null, observedAt: result.testedAt } : current.trust;
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { lastTest: result, trust, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Redis source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This Redis connection belongs to another device.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the Redis connection successfully before discovering logical databases.');
    const pages = [];
    for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current) })) pages.push(page);
    return pages[0] || { items: [], nextCursor: null };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  CLUSTER_SLOT_COUNT,
  RedisConnectionService,
  RedisNativeAdapter,
  clusterTopologyFingerprint,
  deploymentFingerprint,
  normalizeConfig,
  normalizeIdentity,
  parseCliJson,
  parseClusterNodes,
  parseConfigResponse,
  parseInfo,
  parseKeyspace,
  parseRole,
  parseVersion,
  redisRestorePath,
  redisCliArguments,
  safeAdapterError,
  validateIdentity
};
