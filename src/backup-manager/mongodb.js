const crypto = require('crypto');
const fs = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { domainToASCII } = require('url');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { NativeProcessError, NativeProcessRunner } = require('./native-process');

const ADAPTER_ID = 'deployerx.database.mongodb.native';
const ADAPTER_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30000;
const IDENTITY_MARKER = 'DX_MONGODB_ID';
const SNAPSHOT_LOCK_MARKER = 'DX_MONGODB_SNAPSHOT_LOCK';
const SHARDED_BALANCER_MARKER = 'DX_MONGODB_BALANCER';
const RECORD_SEPARATOR = '\x1f';
const SUPPORTED_MAJORS = new Set([7, 8]);
const TOPOLOGIES = new Set(['auto', 'standalone', 'replica-set', 'sharded']);
const MAXIMUM_DUMP_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAXIMUM_INVENTORY_TIMEOUT_MS = 10 * 60 * 1000;
const MAXIMUM_VALIDATION_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_LOGICAL_DATABASES = 1000;
const MAX_LOGICAL_COLLECTIONS = 1000;
const MAX_LOGICAL_INDEXES = 10000;

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function mongoNumber(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return Number(value[key]);
    }
  }
  return Number(value);
}

function normalizeHost(value) {
  const input = requiredText(value, 'MongoDB host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('MongoDB host must be a hostname or IP address without a URI scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('MongoDB host is invalid.');
  return ascii;
}

function normalizePort(value) {
  const port = Number(value ?? 27017);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('MongoDB port must be between 1 and 65535.');
  return port;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('MongoDB timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeDatabaseName(value, label, fallback = null) {
  const name = requiredText(value || fallback, label, 63);
  if (/[/\\."$*<>:|?\s]/.test(name)) throw new TypeError(`${label} is invalid.`);
  return name;
}

function normalizeUsername(value) {
  const username = requiredText(value, 'MongoDB username', 128);
  if (/[\r\n]/.test(username)) throw new TypeError('MongoDB username is invalid.');
  return username;
}

function normalizeReplicaSet(value) {
  if (value === undefined || value === null || value === '') return null;
  const name = requiredText(value, 'MongoDB replica-set name', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new TypeError('MongoDB replica-set name is invalid.');
  return name;
}

function normalizeCaFile(value) {
  if (value === undefined || value === null || value === '') return null;
  const file = requiredText(value, 'MongoDB TLS CA file', 4096);
  if (!path.isAbsolute(file)) throw new TypeError('MongoDB TLS CA file must be absolute.');
  return path.normalize(file);
}

function normalizeExecutable(value) {
  const executable = value === undefined || value === null || value === '' ? 'mongosh' : requiredText(value, 'mongosh executable', 4096);
  if (path.win32.basename(executable).toLowerCase().replace(/[.]exe$/, '') !== 'mongosh') throw new TypeError('Only the mongosh executable may be configured.');
  return executable;
}

function normalizeDatabaseToolExecutable(value, tool) {
  const executable = value === undefined || value === null || value === '' ? tool : requiredText(value, `${tool} executable`, 4096);
  if (path.win32.basename(executable).toLowerCase().replace(/[.]exe$/, '') !== tool) throw new TypeError(`Only the ${tool} executable may be configured.`);
  return executable;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MongoDB connection configuration must be an object.');
  const allowed = ['host', 'port', 'username', 'passwordSecretRefId', 'authSource', 'replicaSet', 'expectedTopology', 'tlsMode', 'caFile', 'timeoutMs', 'mongoshExecutable', 'mongodumpExecutable', 'mongorestoreExecutable'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown MongoDB connection field: ${unknown[0]}.`);
  const tlsMode = String(input.tlsMode || 'verify-identity').toLowerCase();
  if (tlsMode !== 'verify-identity') throw new TypeError('MongoDB protection requires TLS certificate identity verification.');
  const expectedTopology = String(input.expectedTopology || 'auto').toLowerCase();
  if (!TOPOLOGIES.has(expectedTopology)) throw new TypeError('MongoDB expected topology is invalid.');
  return {
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    username: normalizeUsername(input.username),
    passwordSecretRefId: requiredText(input.passwordSecretRefId, 'MongoDB password SecretRef ID', 200),
    authSource: normalizeDatabaseName(input.authSource, 'MongoDB authentication database', 'admin'),
    replicaSet: normalizeReplicaSet(input.replicaSet),
    expectedTopology,
    tlsMode,
    caFile: normalizeCaFile(input.caFile),
    timeoutMs: normalizeTimeout(input.timeoutMs),
    mongoshExecutable: normalizeExecutable(input.mongoshExecutable),
    mongodumpExecutable: normalizeDatabaseToolExecutable(input.mongodumpExecutable, 'mongodump'),
    mongorestoreExecutable: normalizeDatabaseToolExecutable(input.mongorestoreExecutable, 'mongorestore')
  };
}

function connectionUriWithoutPassword(config) {
  const host = net.isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  const options = new URLSearchParams({
    authSource: config.authSource,
    tls: 'true',
    serverSelectionTimeoutMS: String(config.timeoutMs),
    connectTimeoutMS: String(config.timeoutMs),
    appName: 'DeployerX Backup Manager'
  });
  if (config.replicaSet) options.set('replicaSet', config.replicaSet);
  if (config.caFile) options.set('tlsCAFile', config.caFile);
  return `mongodb://${encodeURIComponent(config.username)}@${host}:${config.port}/?${options}`;
}

function databaseToolsConfig(config, password) {
  const secret = String(password ?? '');
  if (!secret || secret.includes('\0') || /[\r\n]/.test(secret) || secret.length > 1024 * 1024) throw new DatabaseAdapterError('MONGODB_CREDENTIAL_INVALID', 'MongoDB password cannot be represented safely.', { category: 'authentication' });
  return Buffer.from(`uri: ${JSON.stringify(connectionUriWithoutPassword(config))}\npassword: ${JSON.stringify(secret)}\n`, 'utf8');
}

function connectionUri(config, password, connectionOptions = {}) {
  const secret = String(password ?? '');
  if (!secret || secret.includes('\0') || /[\r\n]/.test(secret) || secret.length > 1024 * 1024) throw new DatabaseAdapterError('MONGODB_CREDENTIAL_INVALID', 'MongoDB password cannot be represented safely.', { category: 'authentication' });
  const host = net.isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  const query = new URLSearchParams({
    authSource: config.authSource,
    tls: 'true',
    serverSelectionTimeoutMS: String(config.timeoutMs),
    connectTimeoutMS: String(config.timeoutMs),
    appName: 'DeployerX Backup Manager'
  });
  if (config.replicaSet) query.set('replicaSet', config.replicaSet);
  if (config.caFile) query.set('tlsCAFile', config.caFile);
  if (connectionOptions.directConnection) query.set('directConnection', 'true');
  return `mongodb://${encodeURIComponent(config.username)}:${encodeURIComponent(secret)}@${host}:${config.port}/?${query}`;
}

function identityScript(config, password, options = {}) {
  const uri = connectionUri(config, password, { directConnection: options.directConnection });
  const probeTimestamp = options.probeTimestamp ? oplogTimestamp(options.probeTimestamp, 'MongoDB oplog probe timestamp') : null;
  const expectedDatabases = [...new Set((options.expectedDatabases || []).map((name) => normalizeDatabaseName(name, 'MongoDB inventory database')))];
  return Buffer.from(`const dxMongo = new Mongo(${JSON.stringify(uri)});
const dxAdmin = dxMongo.getDB('admin');
const dxIncludeLogicalInventory = ${options.includeLogicalInventory === true};
const dxRunNativeValidation = ${options.validateCollections === true};
const dxExpectedDatabases = ${JSON.stringify(expectedDatabases)};
const dxHello = dxAdmin.runCommand({ hello: 1 });
if (!dxHello.ok) throw new Error('MongoDB hello failed');
const dxBuild = dxAdmin.runCommand({ buildInfo: 1 });
if (!dxBuild.ok) throw new Error('MongoDB buildInfo failed');
const dxFcvResult = dxAdmin.runCommand({ getParameter: 1, featureCompatibilityVersion: 1 });
if (!dxFcvResult.ok) throw new Error('MongoDB FCV discovery failed');
const dxConnectionStatus = dxAdmin.runCommand({ connectionStatus: 1, showPrivileges: true });
if (!dxConnectionStatus.ok) throw new Error('MongoDB privilege discovery failed');
const dxDatabases = dxAdmin.runCommand({ listDatabases: 1, nameOnly: true, authorizedDatabases: true });
if (!dxDatabases.ok) throw new Error('MongoDB database discovery failed');
const dxTopology = dxHello.msg === 'isdbgrid' ? 'sharded' : dxHello.setName ? 'replica-set' : 'standalone';
let dxReplicaSetId = null;
let dxClusterId = null;
let dxStorageEngine = null;
let dxPersistent = null;
let dxOplog = null;
let dxReplicaStatus = null;
let dxReplicaRole = null;
let dxShardedTopology = null;
let dxLogicalInventory = null;
if (dxTopology === 'replica-set') {
  const dxConfigResult = dxAdmin.runCommand({ replSetGetConfig: 1 });
  if (!dxConfigResult.ok) throw new Error('MongoDB replica-set identity discovery failed');
  const dxStatusResult = dxAdmin.runCommand({ replSetGetStatus: 1 });
  if (!dxStatusResult.ok) throw new Error('MongoDB replica-set health discovery failed');
  dxReplicaSetId = dxConfigResult.config && dxConfigResult.config.settings && dxConfigResult.config.settings.replicaSetId ? dxConfigResult.config.settings.replicaSetId.toString() : null;
  dxReplicaRole = dxConfigResult.config && dxConfigResult.config.configsvr === true ? 'config-server' : 'shard';
  const dxMemberConfig = new Map((dxConfigResult.config.members || []).map((item) => [item.host, item]));
  dxReplicaStatus = {
    lastCommittedOpTime: dxStatusResult.optimes && dxStatusResult.optimes.lastCommittedOpTime ? dxStatusResult.optimes.lastCommittedOpTime : null,
    members: (dxStatusResult.members || []).map((item) => {
      const configured = dxMemberConfig.get(item.name) || {};
      return {
        name: item.name, state: item.stateStr, health: item.health, self: Boolean(item.self), uptime: item.uptime,
        optime: item.optime || null, syncSourceHost: item.syncSourceHost || null,
        arbiterOnly: Boolean(configured.arbiterOnly), hidden: Boolean(configured.hidden),
        secondaryDelaySecs: Number(configured.secondaryDelaySecs || configured.slaveDelay || 0),
        votes: Number(configured.votes === undefined ? 1 : configured.votes), priority: Number(configured.priority === undefined ? 1 : configured.priority)
      };
    })
  };
  const dxOplogCollection = dxMongo.getDB('local').getCollection('oplog.rs');
  const dxFirstCursor = dxOplogCollection.find({}, { ts: 1, t: 1, h: 1 }).sort({ $natural: 1 }).limit(1);
  const dxLastCursor = dxOplogCollection.find({}, { ts: 1, t: 1, h: 1 }).sort({ $natural: -1 }).limit(1);
  const dxFirst = dxFirstCursor.hasNext() ? dxFirstCursor.next() : null;
  const dxLast = dxLastCursor.hasNext() ? dxLastCursor.next() : null;
  const dxProbeTimestamp = ${probeTimestamp ? `EJSON.parse(${JSON.stringify(JSON.stringify({ $timestamp: probeTimestamp }))})` : 'null'};
  const dxProbe = dxProbeTimestamp ? dxOplogCollection.findOne({ ts: dxProbeTimestamp }, { ts: 1, t: 1, h: 1 }) : null;
  dxOplog = { earliest: dxFirst, latest: dxLast, probe: dxProbe };
}
if (dxTopology === 'sharded') {
  const dxConfig = dxMongo.getDB('config');
  const dxVersion = dxConfig.version.findOne({}, { clusterId: 1 });
  dxClusterId = dxVersion && dxVersion.clusterId ? dxVersion.clusterId.toString() : null;
  const dxOptions = dxAdmin.runCommand({ getCmdLineOpts: 1 });
  if (!dxOptions.ok) throw new Error('MongoDB config-server discovery failed');
  const dxBalancer = dxAdmin.runCommand({ balancerStatus: 1 });
  if (!dxBalancer.ok) throw new Error('MongoDB balancer discovery failed');
  const dxConfigServer = dxOptions.parsed && dxOptions.parsed.sharding ? (dxOptions.parsed.sharding.configDB || dxOptions.parsed.sharding.configdb) : null;
  if (!dxConfigServer) throw new Error('MongoDB config-server identity was missing');
  const dxShards = dxConfig.shards.find({}, { _id: 1, host: 1, state: 1 }).sort({ _id: 1 }).limit(1001).toArray();
  const dxDatabasePrimaries = dxConfig.databases.find({}, { _id: 1, primary: 1, partitioned: 1, version: 1 }).sort({ _id: 1 }).limit(10001).toArray();
  const dxCollectionCount = dxConfig.collections.countDocuments({ dropped: { $ne: true } });
  const dxCollections = dxConfig.collections.find({ dropped: { $ne: true } }, { _id: 1, uuid: 1, key: 1, unique: 1, unsplittable: 1, timestamp: 1, lastmodEpoch: 1 }).sort({ _id: 1 }).limit(10001).toArray();
  const dxChunkCount = dxConfig.chunks.countDocuments({});
  const dxChunkProjection = { _id: 1, uuid: 1, ns: 1, shard: 1, min: 1, max: 1, lastmod: 1, history: 1 };
  const dxChunkHead = dxConfig.chunks.find({}, dxChunkProjection).sort({ _id: 1 }).limit(32).toArray();
  const dxChunkTail = dxConfig.chunks.find({}, dxChunkProjection).sort({ _id: -1 }).limit(32).toArray().reverse();
  const dxChunksByShard = dxConfig.chunks.aggregate([{ $group: { _id: '$shard', count: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: 1001 }]).toArray();
  const dxBalancerSettings = dxConfig.settings.findOne({ _id: 'balancer' }) || null;
  dxShardedTopology = {
    configServer: dxConfigServer,
    shards: dxShards,
    shardsTruncated: dxShards.length > 1000,
    databasePrimaries: dxDatabasePrimaries,
    databasePrimariesTruncated: dxDatabasePrimaries.length > 10000,
    collectionCount: dxCollectionCount,
    collections: dxCollections,
    collectionsTruncated: dxCollections.length > 10000,
    chunks: { count: dxChunkCount, head: dxChunkHead, tail: dxChunkTail, byShard: dxChunksByShard, byShardTruncated: dxChunksByShard.length > 1000 },
    balancer: { mode: dxBalancer.mode || null, inBalancerRound: Boolean(dxBalancer.inBalancerRound), numBalancerRounds: dxBalancer.numBalancerRounds === undefined ? null : dxBalancer.numBalancerRounds, settings: dxBalancerSettings },
    operationTime: dxBalancer.operationTime || (dxBalancer.$clusterTime && dxBalancer.$clusterTime.clusterTime) || (dxHello.$clusterTime && dxHello.$clusterTime.clusterTime) || null
  };
} else {
  const dxServerStatus = dxAdmin.runCommand({ serverStatus: 1 });
  if (!dxServerStatus.ok) throw new Error('MongoDB storage discovery failed');
  dxStorageEngine = dxServerStatus.storageEngine ? dxServerStatus.storageEngine.name : null;
  dxPersistent = dxServerStatus.storageEngine ? Boolean(dxServerStatus.storageEngine.persistent) : null;
}
if (dxIncludeLogicalInventory) {
  const dxSystemDatabases = new Set(['admin', 'config', 'local']);
  const dxRequested = new Set(dxExpectedDatabases);
  const dxInventoryDatabases = (dxDatabases.databases || []).map((item) => item.name).filter((name) => !dxSystemDatabases.has(name) && (!dxRequested.size || dxRequested.has(name))).sort();
  if (dxInventoryDatabases.length > ${MAX_LOGICAL_DATABASES}) throw new Error('MongoDB logical inventory database limit exceeded');
  if (dxRequested.size && dxInventoryDatabases.length !== dxRequested.size) throw new Error('MongoDB logical inventory database missing');
  const dxCollections = [];
  const dxNativeValidation = [];
  let dxIndexCount = 0;
  for (const dxDatabaseName of dxInventoryDatabases) {
    const dxDatabase = dxMongo.getDB(dxDatabaseName);
    const dxInfos = dxDatabase.getCollectionInfos({}).filter((item) => item && item.name && !item.name.startsWith('system.')).sort((left, right) => left.name.localeCompare(right.name));
    if (dxCollections.length + dxInfos.length > ${MAX_LOGICAL_COLLECTIONS}) throw new Error('MongoDB logical inventory collection limit exceeded');
    for (const dxInfo of dxInfos) {
      const dxType = dxInfo.type || (dxInfo.options && dxInfo.options.viewOn ? 'view' : 'collection');
      const dxIndexes = dxType !== 'view' ? dxDatabase.getCollection(dxInfo.name).getIndexes().map((item) => ({
        name: item.name, key: item.key, unique: Boolean(item.unique), sparse: Boolean(item.sparse), hidden: Boolean(item.hidden),
        expireAfterSeconds: item.expireAfterSeconds === undefined ? null : item.expireAfterSeconds,
        partialFilterExpression: item.partialFilterExpression || null, collation: item.collation || null,
        wildcardProjection: item.wildcardProjection || null, weights: item.weights || null,
        default_language: item.default_language || null, language_override: item.language_override || null,
        textIndexVersion: item.textIndexVersion === undefined ? null : item.textIndexVersion,
        '2dsphereIndexVersion': item['2dsphereIndexVersion'] === undefined ? null : item['2dsphereIndexVersion'],
        bits: item.bits === undefined ? null : item.bits, min: item.min === undefined ? null : item.min,
        max: item.max === undefined ? null : item.max, bucketSize: item.bucketSize === undefined ? null : item.bucketSize,
        clustered: Boolean(item.clustered)
      })).sort((left, right) => left.name.localeCompare(right.name)) : [];
      dxIndexCount += dxIndexes.length;
      if (dxIndexCount > ${MAX_LOGICAL_INDEXES}) throw new Error('MongoDB logical inventory index limit exceeded');
      dxCollections.push({
        database: dxDatabaseName, name: dxInfo.name, type: dxType, uuid: dxInfo.info && dxInfo.info.uuid ? dxInfo.info.uuid : null,
        options: {
          capped: Boolean(dxInfo.options && dxInfo.options.capped), size: dxInfo.options && dxInfo.options.size !== undefined ? dxInfo.options.size : null,
          max: dxInfo.options && dxInfo.options.max !== undefined ? dxInfo.options.max : null,
          validator: dxInfo.options && dxInfo.options.validator ? dxInfo.options.validator : null,
          validationLevel: dxInfo.options && dxInfo.options.validationLevel ? dxInfo.options.validationLevel : null,
          validationAction: dxInfo.options && dxInfo.options.validationAction ? dxInfo.options.validationAction : null,
          timeseries: dxInfo.options && dxInfo.options.timeseries ? dxInfo.options.timeseries : null,
          clusteredIndex: dxInfo.options && dxInfo.options.clusteredIndex ? dxInfo.options.clusteredIndex : null,
          changeStreamPreAndPostImages: dxInfo.options && dxInfo.options.changeStreamPreAndPostImages ? dxInfo.options.changeStreamPreAndPostImages : null,
          collation: dxInfo.options && dxInfo.options.collation ? dxInfo.options.collation : null,
          viewOn: dxInfo.options && dxInfo.options.viewOn ? dxInfo.options.viewOn : null,
          pipeline: dxInfo.options && dxInfo.options.pipeline ? dxInfo.options.pipeline : null
        },
        indexes: dxIndexes
      });
      if (dxRunNativeValidation && dxType === 'collection') {
        const dxValidation = dxDatabase.runCommand({ validate: dxInfo.name, full: false, background: true, maxTimeMS: ${config.timeoutMs} });
        dxNativeValidation.push({
          database: dxDatabaseName, name: dxInfo.name, ok: Boolean(dxValidation.ok), valid: dxValidation.valid === true,
          warnings: Array.isArray(dxValidation.warnings) ? dxValidation.warnings.length : 0,
          errors: Array.isArray(dxValidation.errors) ? dxValidation.errors.length : 0,
          nIndexes: dxValidation.nIndexes === undefined ? null : dxValidation.nIndexes,
          nrecords: dxValidation.nrecords === undefined ? null : dxValidation.nrecords
        });
      }
    }
  }
  dxLogicalInventory = { version: 1, databases: dxInventoryDatabases, collections: dxCollections, indexCount: dxIndexCount, nativeValidation: { performed: dxRunNativeValidation, results: dxNativeValidation } };
}
const dxIdentity = {
  topology: dxTopology,
  endpointIdentity: ${JSON.stringify(`${config.host}:${config.port}`)},
  version: dxBuild.version,
  featureCompatibilityVersion: dxFcvResult.featureCompatibilityVersion && dxFcvResult.featureCompatibilityVersion.version,
  setName: dxHello.setName || null,
  replicaSetId: dxReplicaSetId,
  replicaRole: dxReplicaRole,
  clusterId: dxClusterId,
  shardedTopology: dxShardedTopology,
  logicalInventory: dxLogicalInventory,
  primary: dxHello.primary || null,
  me: dxHello.me || null,
  members: [...new Set([...(dxHello.hosts || []), ...(dxHello.passives || []), ...(dxHello.arbiters || [])])].sort(),
  storageEngine: dxStorageEngine,
  persistent: dxPersistent,
  logicalSessionTimeoutMinutes: dxHello.logicalSessionTimeoutMinutes || null,
  oplog: dxOplog,
  databases: (dxDatabases.databases || []).map((item) => item.name).sort(),
  authenticatedUsers: (dxConnectionStatus.authInfo && dxConnectionStatus.authInfo.authenticatedUsers) || [],
  authenticatedRoles: (dxConnectionStatus.authInfo && dxConnectionStatus.authInfo.authenticatedUserRoles) || [],
  privilegeCount: ((dxConnectionStatus.authInfo && dxConnectionStatus.authInfo.authenticatedUserPrivileges) || []).length,
  privilegeActions: [...new Set(((dxConnectionStatus.authInfo && dxConnectionStatus.authInfo.authenticatedUserPrivileges) || []).flatMap((item) => item.actions || []))].sort(),
  replicaStatus: dxReplicaStatus
};
print(${JSON.stringify(`${IDENTITY_MARKER}${RECORD_SEPARATOR}`)} + EJSON.stringify(dxIdentity, { relaxed: false }));
quit(0);
`, 'utf8');
}

function replicaMemberConfig(input, memberName) {
  const config = normalizeConfig(input);
  const member = requiredText(memberName, 'MongoDB replica-set member', 255);
  let host;
  let portText;
  const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(member);
  if (ipv6) [, host, portText] = ipv6;
  else {
    const separator = member.lastIndexOf(':');
    if (separator < 1 || member.indexOf(':') !== separator) throw new DatabaseAdapterError('MONGODB_MEMBER_ENDPOINT_INVALID', 'MongoDB returned an invalid replica-set member endpoint.', { category: 'integrity' });
    host = member.slice(0, separator);
    portText = member.slice(separator + 1);
  }
  return { ...config, host: normalizeHost(host), port: normalizePort(Number(portText)), expectedTopology: 'replica-set' };
}

function snapshotLockScript(config, password, action) {
  if (!['lock', 'unlock'].includes(action)) throw new TypeError('MongoDB snapshot lock action is invalid.');
  const uri = connectionUri(config, password, { directConnection: true });
  const command = action === 'lock' ? '{ fsync: 1, lock: true }' : '{ fsyncUnlock: 1 }';
  return Buffer.from(`const dxMongo = new Mongo(${JSON.stringify(uri)});
const dxAdmin = dxMongo.getDB('admin');
const dxHello = dxAdmin.runCommand({ hello: 1 });
if (!dxHello.ok || !dxHello.setName) throw new Error('MongoDB direct member identity failed');
const dxResult = dxAdmin.runCommand(${command});
if (!dxResult.ok) throw new Error('MongoDB snapshot ${action} failed');
print(${JSON.stringify(`${SNAPSHOT_LOCK_MARKER}${RECORD_SEPARATOR}`)} + EJSON.stringify({ action: ${JSON.stringify(action)}, member: dxHello.me || null, setName: dxHello.setName, lockCount: dxResult.lockCount === undefined ? null : dxResult.lockCount, operationTime: dxResult.operationTime || (dxResult.$clusterTime && dxResult.$clusterTime.clusterTime) || null }, { relaxed: false }));
quit(0);
`, 'utf8');
}

function parseSnapshotLockResult(output, action, expectedMember) {
  const line = String(output || '').split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith(`${SNAPSHOT_LOCK_MARKER}${RECORD_SEPARATOR}`));
  if (!line) throw new DatabaseAdapterError('MONGODB_SNAPSHOT_LOCK_RESULT_MISSING', 'MongoDB snapshot lock evidence was missing.', { category: 'integrity' });
  let raw;
  try { raw = JSON.parse(line.slice(`${SNAPSHOT_LOCK_MARKER}${RECORD_SEPARATOR}`.length)); }
  catch (_error) { throw new DatabaseAdapterError('MONGODB_SNAPSHOT_LOCK_RESULT_INVALID', 'MongoDB returned malformed snapshot lock evidence.', { category: 'integrity' }); }
  if (raw.action !== action || raw.member !== expectedMember) throw new DatabaseAdapterError('MONGODB_SNAPSHOT_MEMBER_CHANGED', 'MongoDB snapshot locking reached a different replica-set member.', { category: 'integrity' });
  return { action, member: expectedMember, setName: requiredText(raw.setName, 'MongoDB replica-set name', 128), lockCount: raw.lockCount === null || raw.lockCount === undefined ? null : mongoNumber(raw.lockCount), operationTime: raw.operationTime ? { $timestamp: oplogTimestamp(raw.operationTime, 'MongoDB snapshot operation time') } : null };
}

function balancerScript(config, password, action) {
  if (!['status', 'stop', 'start'].includes(action)) throw new TypeError('MongoDB balancer action is invalid.');
  const uri = connectionUri(config, password);
  const command = action === 'status' ? null : action === 'stop'
    ? `{ balancerStop: 1, maxTimeMS: ${config.timeoutMs} }`
    : `{ balancerStart: 1, maxTimeMS: ${config.timeoutMs} }`;
  return Buffer.from(`const dxMongo = new Mongo(${JSON.stringify(uri)});
const dxAdmin = dxMongo.getDB('admin');
const dxHello = dxAdmin.runCommand({ hello: 1 });
if (!dxHello.ok || dxHello.msg !== 'isdbgrid') throw new Error('MongoDB balancer endpoint is not mongos');
${command ? `const dxAction = dxAdmin.runCommand(${command});\nif (!dxAction.ok) throw new Error('MongoDB balancer ${action} failed');` : ''}
const dxStatus = dxAdmin.runCommand({ balancerStatus: 1 });
if (!dxStatus.ok) throw new Error('MongoDB balancer status failed');
print(${JSON.stringify(`${SHARDED_BALANCER_MARKER}${RECORD_SEPARATOR}`)} + EJSON.stringify({ action: ${JSON.stringify(action)}, mode: dxStatus.mode || null, inBalancerRound: Boolean(dxStatus.inBalancerRound), numBalancerRounds: dxStatus.numBalancerRounds === undefined ? null : dxStatus.numBalancerRounds, operationTime: dxStatus.operationTime || (dxStatus.$clusterTime && dxStatus.$clusterTime.clusterTime) || null }, { relaxed: false }));
quit(0);
`, 'utf8');
}

function parseBalancerResult(output, action) {
  const line = String(output || '').split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith(`${SHARDED_BALANCER_MARKER}${RECORD_SEPARATOR}`));
  if (!line) throw new DatabaseAdapterError('MONGODB_BALANCER_RESULT_MISSING', 'MongoDB balancer evidence was missing.', { category: 'integrity' });
  let raw;
  try { raw = JSON.parse(line.slice(`${SHARDED_BALANCER_MARKER}${RECORD_SEPARATOR}`.length)); }
  catch (_error) { throw new DatabaseAdapterError('MONGODB_BALANCER_RESULT_INVALID', 'MongoDB returned malformed balancer evidence.', { category: 'integrity' }); }
  if (raw.action !== action) throw new DatabaseAdapterError('MONGODB_BALANCER_RESULT_INVALID', 'MongoDB returned mismatched balancer evidence.', { category: 'integrity' });
  const mode = requiredText(raw.mode, 'MongoDB balancer mode', 40).toLowerCase();
  const inBalancerRound = Boolean(raw.inBalancerRound);
  const running = mode !== 'off';
  if (action === 'stop' && (running || inBalancerRound)) throw new DatabaseAdapterError('MONGODB_BALANCER_STOP_UNPROVEN', 'MongoDB did not prove that balancing and the active balancer round stopped.', { category: 'consistency' });
  if (action === 'start' && !running) throw new DatabaseAdapterError('MONGODB_BALANCER_START_UNPROVEN', 'MongoDB did not prove that balancing resumed.', { category: 'consistency' });
  return {
    action, mode, running, inBalancerRound,
    numBalancerRounds: raw.numBalancerRounds === null || raw.numBalancerRounds === undefined ? null : mongoNumber(raw.numBalancerRounds),
    operationTime: raw.operationTime ? { $timestamp: oplogTimestamp(raw.operationTime, 'MongoDB balancer operation time') } : null
  };
}

function parseVersion(value) {
  const text = requiredText(value, 'MongoDB version', 100);
  const match = /^(\d+)(?:[.](\d+))?(?:[.](\d+))?/.exec(text);
  const major = Number(match?.[1]);
  if (!match || !SUPPORTED_MAJORS.has(major)) throw new DatabaseAdapterError('MONGODB_VERSION_UNSUPPORTED', 'MongoDB 7.0 or 8.0 is required.', { category: 'compatibility' });
  return { text, major, minor: Number(match[2] || 0), patch: Number(match[3] || 0) };
}

function normalizeReplicaStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const committed = value.lastCommittedOpTime?.ts ? { timestamp: { $timestamp: oplogTimestamp(value.lastCommittedOpTime.ts, 'MongoDB majority-committed operation time') }, term: jsonClone(value.lastCommittedOpTime.t) } : null;
  const members = (Array.isArray(value.members) ? value.members : []).slice(0, 1000).map((item) => {
    const state = requiredText(item.state, 'MongoDB replica-set member state', 40).toUpperCase();
    const timestamp = item.optime?.ts ? { $timestamp: oplogTimestamp(item.optime.ts, 'MongoDB member optime') } : null;
    const health = mongoNumber(item.health);
    const delaySeconds = mongoNumber(item.secondaryDelaySecs || 0);
    const votes = mongoNumber(item.votes);
    const priority = mongoNumber(item.priority);
    if (!Number.isFinite(health) || !Number.isFinite(delaySeconds) || delaySeconds < 0 || !Number.isFinite(votes) || !Number.isFinite(priority)) throw new DatabaseAdapterError('MONGODB_REPLICA_STATUS_INVALID', 'MongoDB returned invalid replica-set member health evidence.', { category: 'integrity' });
    return {
      name: requiredText(item.name, 'MongoDB replica-set member name', 255), state, health,
      self: Boolean(item.self), uptimeSeconds: Math.max(0, mongoNumber(item.uptime) || 0), optime: timestamp,
      syncSourceHost: item.syncSourceHost ? requiredText(item.syncSourceHost, 'MongoDB sync source', 255) : null,
      arbiterOnly: Boolean(item.arbiterOnly), hidden: Boolean(item.hidden), secondaryDelaySeconds: delaySeconds, votes, priority
    };
  });
  return { lastCommittedOpTime: committed, members };
}

function normalizeMemberEndpoint(value, label) {
  const member = requiredText(value, label, 255);
  let host;
  let portText;
  const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(member);
  if (ipv6) [, host, portText] = ipv6;
  else {
    const separator = member.lastIndexOf(':');
    if (separator < 1 || member.indexOf(':') !== separator) throw new DatabaseAdapterError('MONGODB_COMPONENT_ENDPOINT_INVALID', `${label} is invalid.`, { category: 'integrity' });
    host = member.slice(0, separator);
    portText = member.slice(separator + 1);
  }
  const normalizedHost = normalizeHost(host);
  const port = normalizePort(Number(portText));
  return `${net.isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost}:${port}`;
}

function normalizeReplicaSetConnectionString(value, label = 'MongoDB replica-set connection string') {
  const text = requiredText(value, label, 8192);
  const separator = text.indexOf('/');
  if (separator < 1 || separator === text.length - 1) throw new DatabaseAdapterError('MONGODB_COMPONENT_CONNECTION_INVALID', `${label} is invalid.`, { category: 'integrity' });
  const setName = normalizeReplicaSet(text.slice(0, separator));
  const hosts = [...new Set(text.slice(separator + 1).split(',').map((item) => normalizeMemberEndpoint(item, `${label} member`)))].sort();
  if (!hosts.length || hosts.length > 1000) throw new DatabaseAdapterError('MONGODB_COMPONENT_CONNECTION_INVALID', `${label} has an invalid member count.`, { category: 'integrity' });
  return { setName, hosts, connectionString: `${setName}/${hosts.join(',')}` };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function boundedEvidence(value, label, maximumBytes = 64 * 1024) {
  const normalized = canonicalize(jsonClone(value));
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > maximumBytes) throw new DatabaseAdapterError('MONGODB_SHARDED_EVIDENCE_OVERSIZED', `${label} exceeded the authenticated evidence limit.`, { category: 'integrity' });
  return normalized;
}

function shardedTopologyFingerprint(value) {
  const topology = value?.shardedTopology || value;
  if (!topology || typeof topology !== 'object') throw new DatabaseAdapterError('MONGODB_SHARDED_TOPOLOGY_MISSING', 'MongoDB sharded topology evidence is missing.', { category: 'integrity' });
  const material = {
    configServer: topology.configServer,
    shards: topology.shards,
    databasePrimaries: topology.databasePrimaries,
    collectionEvidence: topology.collectionEvidence,
    chunkEvidence: topology.chunkEvidence
  };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(material))).digest('hex')}`;
}

function normalizeShardedTopology(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const configServer = normalizeReplicaSetConnectionString(value.configServer, 'MongoDB config-server connection string');
  const rawShards = Array.isArray(value.shards) ? value.shards : [];
  if (value.shardsTruncated || !rawShards.length || rawShards.length > 1000) throw new DatabaseAdapterError('MONGODB_SHARD_MAP_INCOMPLETE', 'MongoDB returned an incomplete shard map.', { category: 'integrity' });
  const shards = rawShards.map((item) => {
    const shardId = requiredText(item._id, 'MongoDB shard ID', 200);
    const connection = normalizeReplicaSetConnectionString(item.host, `MongoDB shard ${shardId} connection string`);
    return { shardId, setName: connection.setName, hosts: connection.hosts, connectionString: connection.connectionString, state: item.state === undefined ? null : mongoNumber(item.state) };
  }).sort((left, right) => left.shardId.localeCompare(right.shardId, 'en-US'));
  if (new Set(shards.map((item) => item.shardId)).size !== shards.length || new Set(shards.map((item) => item.setName)).size !== shards.length || shards.some((item) => item.state !== null && !Number.isSafeInteger(item.state))) throw new DatabaseAdapterError('MONGODB_SHARD_MAP_INVALID', 'MongoDB returned invalid, duplicate shard, or replica-set identities.', { category: 'integrity' });
  const rawPrimaries = Array.isArray(value.databasePrimaries) ? value.databasePrimaries : [];
  if (value.databasePrimariesTruncated || rawPrimaries.length > 10000) throw new DatabaseAdapterError('MONGODB_DATABASE_PRIMARY_MAP_INCOMPLETE', 'MongoDB returned an incomplete database-primary map.', { category: 'integrity' });
  const databasePrimaries = rawPrimaries.map((item) => ({
    database: normalizeDatabaseName(item._id, 'MongoDB database-primary database'),
    primaryShardId: requiredText(item.primary, 'MongoDB database primary shard ID', 200),
    partitioned: Boolean(item.partitioned),
    version: boundedEvidence(item.version, 'MongoDB database-primary version', 4096)
  })).sort((left, right) => left.database.localeCompare(right.database, 'en-US'));
  if (databasePrimaries.some((item) => !shards.some((shard) => shard.shardId === item.primaryShardId))) throw new DatabaseAdapterError('MONGODB_DATABASE_PRIMARY_UNKNOWN_SHARD', 'MongoDB assigned a database to an unknown shard.', { category: 'integrity' });
  const totalCollections = mongoNumber(value.collectionCount);
  const rawCollections = Array.isArray(value.collections) ? value.collections.slice(0, 10000) : [];
  if (!Number.isSafeInteger(totalCollections) || totalCollections < 0 || rawCollections.length > totalCollections) throw new DatabaseAdapterError('MONGODB_COLLECTION_EVIDENCE_INVALID', 'MongoDB returned invalid collection metadata evidence.', { category: 'integrity' });
  const collectionEvidence = {
    mode: value.collectionsTruncated || totalCollections > rawCollections.length ? 'bounded' : 'complete',
    total: totalCollections,
    items: rawCollections.map((item) => ({
      namespace: requiredText(item._id, 'MongoDB sharded collection namespace', 500),
      uuid: boundedEvidence(item.uuid, 'MongoDB collection UUID', 4096),
      shardKey: boundedEvidence(item.key, 'MongoDB collection shard key', 4096),
      unique: Boolean(item.unique), unsplittable: Boolean(item.unsplittable),
      timestamp: boundedEvidence(item.timestamp, 'MongoDB collection timestamp', 4096),
      lastmodEpoch: boundedEvidence(item.lastmodEpoch, 'MongoDB collection epoch', 4096)
    }))
  };
  const chunks = value.chunks && typeof value.chunks === 'object' ? value.chunks : {};
  const chunkCount = mongoNumber(chunks.count);
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 0 || chunks.byShardTruncated) throw new DatabaseAdapterError('MONGODB_CHUNK_EVIDENCE_INVALID', 'MongoDB returned invalid or incomplete chunk metadata evidence.', { category: 'integrity' });
  const chunkEvidence = {
    mode: 'bounded', total: chunkCount,
    head: boundedEvidence(Array.isArray(chunks.head) ? chunks.head.slice(0, 32) : [], 'MongoDB leading chunk evidence'),
    tail: boundedEvidence(Array.isArray(chunks.tail) ? chunks.tail.slice(0, 32) : [], 'MongoDB trailing chunk evidence'),
    byShard: (Array.isArray(chunks.byShard) ? chunks.byShard : []).map((item) => ({ shardId: requiredText(item._id, 'MongoDB chunk shard ID', 200), count: mongoNumber(item.count) })).sort((left, right) => left.shardId.localeCompare(right.shardId, 'en-US'))
  };
  if (chunkEvidence.byShard.some((item) => !Number.isSafeInteger(item.count) || item.count < 0 || !shards.some((shard) => shard.shardId === item.shardId)) || chunkEvidence.byShard.reduce((sum, item) => sum + item.count, 0) !== chunkCount) throw new DatabaseAdapterError('MONGODB_CHUNK_EVIDENCE_INVALID', 'MongoDB chunk evidence did not reconcile to the shard map.', { category: 'integrity' });
  const mode = requiredText(value.balancer?.mode, 'MongoDB balancer mode', 40).toLowerCase();
  const balancer = { mode, running: mode !== 'off', inBalancerRound: Boolean(value.balancer?.inBalancerRound), numBalancerRounds: value.balancer?.numBalancerRounds === null || value.balancer?.numBalancerRounds === undefined ? null : mongoNumber(value.balancer.numBalancerRounds), settings: boundedEvidence(value.balancer?.settings, 'MongoDB balancer settings', 16384) };
  const operationTime = value.operationTime ? { $timestamp: oplogTimestamp(value.operationTime, 'MongoDB cluster operation time') } : null;
  const normalized = { configServer, shards, databasePrimaries, collectionEvidence, chunkEvidence, balancer, operationTime };
  return { ...normalized, metadataFingerprint: shardedTopologyFingerprint(normalized) };
}

function normalizeLogicalInventory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (mongoNumber(value.version) !== 1) throw new DatabaseAdapterError('MONGODB_VALIDATION_INVENTORY_VERSION_UNSUPPORTED', 'MongoDB returned an unsupported logical validation inventory.', { category: 'integrity' });
  const databases = [...new Set((Array.isArray(value.databases) ? value.databases : []).map((name) => normalizeDatabaseName(name, 'MongoDB inventory database')))];
  if (!databases.length || databases.length > MAX_LOGICAL_DATABASES) throw new DatabaseAdapterError('MONGODB_VALIDATION_INVENTORY_DATABASE_LIMIT', 'MongoDB logical validation inventory has an invalid database count.', { category: 'capacity' });
  const collections = (Array.isArray(value.collections) ? value.collections : []).map((item) => {
    const database = normalizeDatabaseName(item.database, 'MongoDB inventory collection database');
    if (!databases.includes(database)) throw new DatabaseAdapterError('MONGODB_VALIDATION_INVENTORY_INVALID', 'MongoDB collection inventory references an unknown database.', { category: 'integrity' });
    const name = requiredText(item.name, 'MongoDB inventory collection name', 500);
    const type = requiredText(item.type, 'MongoDB inventory collection type', 40).toLowerCase();
    if (!['collection', 'view', 'timeseries'].includes(type)) throw new DatabaseAdapterError('MONGODB_VALIDATION_INVENTORY_INVALID', 'MongoDB returned an unsupported collection type.', { category: 'integrity' });
    const indexes = (Array.isArray(item.indexes) ? item.indexes : []).map((index) => ({
      name: requiredText(index.name, 'MongoDB inventory index name', 500),
      key: boundedEvidence(index.key, 'MongoDB index key', 16384),
      options: boundedEvidence({
        unique: Boolean(index.unique), sparse: Boolean(index.sparse), hidden: Boolean(index.hidden),
        expireAfterSeconds: index.expireAfterSeconds ?? null, partialFilterExpression: index.partialFilterExpression ?? null,
        collation: index.collation ?? null, wildcardProjection: index.wildcardProjection ?? null, weights: index.weights ?? null,
        default_language: index.default_language ?? null, language_override: index.language_override ?? null,
        textIndexVersion: index.textIndexVersion ?? null, '2dsphereIndexVersion': index['2dsphereIndexVersion'] ?? null,
        bits: index.bits ?? null, min: index.min ?? null, max: index.max ?? null, bucketSize: index.bucketSize ?? null,
        clustered: Boolean(index.clustered)
      }, 'MongoDB index options', 32768)
    })).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    if (new Set(indexes.map((index) => index.name)).size !== indexes.length) throw new DatabaseAdapterError('MONGODB_VALIDATION_INVENTORY_INVALID', 'MongoDB collection inventory contains duplicate index names.', { category: 'integrity' });
    const uuid = boundedEvidence(item.uuid, 'MongoDB collection UUID', 4096);
    if (type !== 'view' && uuid === null) throw new DatabaseAdapterError('MONGODB_VALIDATION_INVENTORY_UUID_MISSING', 'MongoDB collection inventory is missing a stable UUID.', { category: 'integrity' });
    return {
      database, name, type,
      uuid,
      options: boundedEvidence(item.options || {}, 'MongoDB collection options', 65536),
      indexes
    };
  }).sort((left, right) => left.database.localeCompare(right.database, 'en-US') || left.name.localeCompare(right.name, 'en-US'));
  if (collections.length > MAX_LOGICAL_COLLECTIONS || new Set(collections.map((item) => `${item.database}\0${item.name}`)).size !== collections.length) throw new DatabaseAdapterError('MONGODB_VALIDATION_INVENTORY_COLLECTION_LIMIT', 'MongoDB logical validation inventory has an invalid or duplicate collection count.', { category: 'capacity' });
  const indexCount = collections.reduce((total, item) => total + item.indexes.length, 0);
  if (indexCount > MAX_LOGICAL_INDEXES || (value.indexCount !== undefined && mongoNumber(value.indexCount) !== indexCount)) throw new DatabaseAdapterError('MONGODB_VALIDATION_INVENTORY_INDEX_LIMIT', 'MongoDB logical validation inventory has an invalid index count.', { category: 'capacity' });
  const rawNative = value.nativeValidation && typeof value.nativeValidation === 'object' ? value.nativeValidation : {};
  const nativeValidation = {
    performed: rawNative.performed === true,
    results: (Array.isArray(rawNative.results) ? rawNative.results : []).map((item) => ({
      database: normalizeDatabaseName(item.database, 'MongoDB native validation database'),
      name: requiredText(item.name, 'MongoDB native validation collection', 500),
      ok: item.ok === true, valid: item.valid === true,
      warnings: mongoNumber(item.warnings || 0), errors: mongoNumber(item.errors || 0),
      nIndexes: item.nIndexes === null || item.nIndexes === undefined ? null : mongoNumber(item.nIndexes),
      nrecords: item.nrecords === null || item.nrecords === undefined ? null : mongoNumber(item.nrecords)
    }))
  };
  if (nativeValidation.results.length > MAX_LOGICAL_COLLECTIONS || nativeValidation.results.some((item) => !Number.isSafeInteger(item.warnings) || item.warnings < 0 || !Number.isSafeInteger(item.errors) || item.errors < 0)) throw new DatabaseAdapterError('MONGODB_NATIVE_VALIDATION_EVIDENCE_INVALID', 'MongoDB returned invalid native validation evidence.', { category: 'integrity' });
  if (new Set(nativeValidation.results.map((item) => `${item.database}\0${item.name}`)).size !== nativeValidation.results.length || nativeValidation.results.some((item) => !collections.some((collection) => collection.database === item.database && collection.name === item.name && collection.type === 'collection'))) throw new DatabaseAdapterError('MONGODB_NATIVE_VALIDATION_EVIDENCE_INVALID', 'MongoDB returned duplicate or unrelated native validation evidence.', { category: 'integrity' });
  const material = { version: 1, databases: [...databases].sort(), collections, indexCount };
  return { ...material, inventoryFingerprint: `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(material))).digest('hex')}`, nativeValidation };
}

function logicalInventoryMetadata(inventory) {
  if (!inventory) return {};
  return {
    validationInventoryVersion: 1,
    expectedDatabases: structuredClone(inventory.databases),
    expectedCollections: structuredClone(inventory.collections),
    validationInventoryFingerprint: inventory.inventoryFingerprint
  };
}

function logicalInventoryFromMetadata(metadata = {}) {
  if (mongoNumber(metadata.validationInventoryVersion) !== 1 || !Array.isArray(metadata.expectedDatabases) || !Array.isArray(metadata.expectedCollections)) return null;
  const normalized = normalizeLogicalInventory({ version: 1, databases: metadata.expectedDatabases, collections: metadata.expectedCollections, indexCount: metadata.expectedCollections.reduce((total, item) => total + (Array.isArray(item.indexes) ? item.indexes.length : 0), 0), nativeValidation: { performed: false, results: [] } });
  if (metadata.validationInventoryFingerprint && metadata.validationInventoryFingerprint !== normalized.inventoryFingerprint) throw new DatabaseAdapterError('MONGODB_VALIDATION_INVENTORY_FINGERPRINT_MISMATCH', 'The authenticated MongoDB validation inventory fingerprint is invalid.', { category: 'integrity' });
  return normalized;
}

function compareLogicalInventories(expected, current, options = {}) {
  if (!expected || !current) throw new TypeError('MongoDB logical inventories are required.');
  const missingDatabases = expected.databases.filter((name) => !current.databases.includes(name));
  const missingCollections = [];
  const typeMismatches = [];
  const uuidMismatches = [];
  const optionMismatches = [];
  const missingIndexes = [];
  const indexMismatches = [];
  for (const collection of expected.collections) {
    const actual = current.collections.find((item) => item.database === collection.database && item.name === collection.name);
    const namespace = `${collection.database}.${collection.name}`;
    if (!actual) { missingCollections.push(namespace); continue; }
    if (actual.type !== collection.type) typeMismatches.push(namespace);
    if (options.requireUuid !== false && JSON.stringify(canonicalize(actual.uuid)) !== JSON.stringify(canonicalize(collection.uuid))) uuidMismatches.push(namespace);
    if (JSON.stringify(canonicalize(actual.options)) !== JSON.stringify(canonicalize(collection.options))) optionMismatches.push(namespace);
    for (const index of collection.indexes) {
      const actualIndex = actual.indexes.find((item) => item.name === index.name);
      const identity = `${namespace}.${index.name}`;
      if (!actualIndex) missingIndexes.push(identity);
      else if (JSON.stringify(canonicalize(actualIndex)) !== JSON.stringify(canonicalize(index))) indexMismatches.push(identity);
    }
  }
  const requiredNative = expected.collections.filter((item) => item.type === 'collection');
  const invalidNative = requiredNative.map((item) => {
    const result = current.nativeValidation.results.find((candidate) => candidate.database === item.database && candidate.name === item.name);
    return !current.nativeValidation.performed || !result || !result.ok || !result.valid || result.errors > 0 ? `${item.database}.${item.name}` : null;
  }).filter(Boolean);
  const valid = !missingDatabases.length && !missingCollections.length && !typeMismatches.length && !uuidMismatches.length && !optionMismatches.length && !missingIndexes.length && !indexMismatches.length && !invalidNative.length;
  return { valid, missingDatabases, missingCollections, typeMismatches, uuidMismatches, optionMismatches, missingIndexes, indexMismatches, invalidNative };
}

function parseIdentity(value) {
  const line = String(value || '').split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith(`${IDENTITY_MARKER}${RECORD_SEPARATOR}`));
  if (!line) throw new DatabaseAdapterError('MONGODB_IDENTITY_EMPTY', 'MongoDB deployment identity output was missing.', { category: 'integrity' });
  let raw;
  try { raw = JSON.parse(line.slice(`${IDENTITY_MARKER}${RECORD_SEPARATOR}`.length)); }
  catch (_error) { throw new DatabaseAdapterError('MONGODB_IDENTITY_INVALID', 'MongoDB returned malformed deployment identity.', { category: 'integrity' }); }
  const topology = requiredText(raw.topology, 'MongoDB topology', 40);
  if (!['standalone', 'replica-set', 'sharded'].includes(topology)) throw new DatabaseAdapterError('MONGODB_IDENTITY_INVALID', 'MongoDB returned an unsupported topology.', { category: 'integrity' });
  const version = parseVersion(raw.version);
  const featureCompatibilityVersion = requiredText(raw.featureCompatibilityVersion, 'MongoDB feature compatibility version', 40);
  const deploymentId = topology === 'replica-set' ? requiredText(raw.replicaSetId, 'MongoDB replica-set ID', 200)
    : topology === 'sharded' ? requiredText(raw.clusterId, 'MongoDB sharded cluster ID', 200)
    : requiredText(raw.me || raw.primary || raw.endpointIdentity, 'MongoDB standalone identity', 255);
  const databases = [...new Set((Array.isArray(raw.databases) ? raw.databases : []).map((item) => normalizeDatabaseName(item, 'Discovered MongoDB database')))].sort();
  const members = [...new Set((Array.isArray(raw.members) ? raw.members : []).map((item) => requiredText(item, 'MongoDB member identity', 255)))].sort();
  const authenticatedUsers = Array.isArray(raw.authenticatedUsers) ? raw.authenticatedUsers.slice(0, 100) : [];
  const authenticatedRoles = Array.isArray(raw.authenticatedRoles) ? raw.authenticatedRoles.slice(0, 100) : [];
  const privilegeActions = [...new Set((Array.isArray(raw.privilegeActions) ? raw.privilegeActions : []).map((item) => requiredText(item, 'MongoDB privilege action', 100)))].sort();
  const privilegeCount = mongoNumber(raw.privilegeCount);
  if (!authenticatedUsers.length || !Number.isInteger(privilegeCount) || privilegeCount < 1) throw new DatabaseAdapterError('MONGODB_PRIVILEGES_INSUFFICIENT', 'MongoDB authenticated privilege evidence is missing.', { category: 'authorization' });
  return {
    topology,
    version: version.text,
    major: version.major,
    featureCompatibilityVersion,
    deploymentId,
    setName: raw.setName ? requiredText(raw.setName, 'MongoDB replica-set name', 128) : null,
    replicaSetId: raw.replicaSetId ? requiredText(raw.replicaSetId, 'MongoDB replica-set ID', 200) : null,
    replicaRole: raw.replicaRole ? requiredText(raw.replicaRole, 'MongoDB replica-set role', 40) : null,
    clusterId: raw.clusterId ? requiredText(raw.clusterId, 'MongoDB cluster ID', 200) : null,
    shardedTopology: normalizeShardedTopology(raw.shardedTopology),
    primary: raw.primary ? requiredText(raw.primary, 'MongoDB primary identity', 255) : null,
    me: raw.me ? requiredText(raw.me, 'MongoDB member identity', 255) : null,
    members,
    storageEngine: raw.storageEngine ? requiredText(raw.storageEngine, 'MongoDB storage engine', 80) : null,
    persistent: raw.persistent === null || raw.persistent === undefined ? null : Boolean(raw.persistent),
    logicalSessionTimeoutMinutes: raw.logicalSessionTimeoutMinutes === null || raw.logicalSessionTimeoutMinutes === undefined ? null : mongoNumber(raw.logicalSessionTimeoutMinutes),
    databases,
    authenticatedUsers,
    authenticatedRoles,
    privilegeCount,
    privilegeActions,
    oplog: raw.oplog && typeof raw.oplog === 'object' ? raw.oplog : null,
    replicaStatus: normalizeReplicaStatus(raw.replicaStatus),
    logicalInventory: normalizeLogicalInventory(raw.logicalInventory)
  };
}

function deploymentFingerprint(identity) {
  const material = [identity.topology, identity.deploymentId, identity.setName || '', identity.featureCompatibilityVersion].map((item) => String(item).toLocaleLowerCase('en-US')).join('\0');
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

function validateIdentity(config, identity) {
  const version = parseVersion(identity.version);
  if (config.expectedTopology !== 'auto' && identity.topology !== config.expectedTopology) throw new DatabaseAdapterError('MONGODB_TOPOLOGY_MISMATCH', `The endpoint is ${identity.topology}, not the expected ${config.expectedTopology} topology.`, { category: 'integrity' });
  if (config.replicaSet && (identity.topology !== 'replica-set' || identity.setName !== config.replicaSet)) throw new DatabaseAdapterError('MONGODB_REPLICA_SET_MISMATCH', 'The endpoint does not match the configured MongoDB replica set.', { category: 'integrity' });
  if (identity.topology !== 'sharded' && identity.storageEngine && identity.storageEngine !== 'wiredTiger') throw new DatabaseAdapterError('MONGODB_STORAGE_ENGINE_UNSUPPORTED', 'MongoDB physical protection requires WiredTiger.', { category: 'compatibility' });
  if (identity.topology !== 'sharded' && identity.persistent !== true) throw new DatabaseAdapterError('MONGODB_STORAGE_NOT_PERSISTENT', 'MongoDB protection requires a persistent storage engine.', { category: 'compatibility' });
  return version;
}

function databaseToolsVersion(output, tool = 'MongoDB Database Tools') {
  const text = String(output || '').trim().slice(0, 1000);
  const match = /(?:version(?:\s*[:=])?|v)\s*(\d+)[.](\d+)[.](\d+)/i.exec(text);
  const version = match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
  const supported = Boolean(version && version.major === 100 && version.minor >= 9);
  return { name: tool, text: version ? `${version.major}.${version.minor}.${version.patch}` : null, supported };
}

function selectedNamespaces(selector = {}) {
  if (!selector || selector.kind !== 'database-objects') throw new DatabaseAdapterError('MONGODB_SELECTION_INVALID', 'MongoDB requires a normalized database selection.', { category: 'validation' });
  const tables = selector.tables?.include || [];
  if (selector.schemas?.include?.length || selector.schemas?.exclude?.length) throw new DatabaseAdapterError('MONGODB_SCHEMA_SELECTION_UNSUPPORTED', 'MongoDB does not support relational schema selection.', { category: 'compatibility' });
  if (tables.length) return tables.map((item) => `${requiredText(item.database, 'MongoDB namespace database', 63)}.${requiredText(item.name, 'MongoDB collection', 255)}`);
  if (selector.allDatabases) return [];
  return (selector.databases?.include || []).map((item) => `${requiredText(item.name, 'MongoDB database', 63)}.*`);
}

function dumpArguments(selector = {}, captureOplog = false) {
  const include = selectedNamespaces(selector);
  const excludedDatabases = (selector.databases?.exclude || []).map((item) => `${requiredText(item.name, 'MongoDB excluded database', 63)}.*`);
  const excludedCollections = (selector.tables?.exclude || []).map((item) => `${requiredText(item.database, 'MongoDB excluded namespace database', 63)}.${requiredText(item.name, 'MongoDB excluded collection', 255)}`);
  if (captureOplog && (!selector.allDatabases || include.length || excludedDatabases.length || excludedCollections.length || selector.includeGlobalObjects)) {
    throw new DatabaseAdapterError('MONGODB_OPLOG_SCOPE_INVALID', 'MongoDB oplog anchors require the complete deployment without namespace filters or authorization data.', { category: 'compatibility' });
  }
  const args = ['--archive', '--gzip', '--numParallelCollections=4'];
  if (captureOplog) args.push('--oplog');
  else {
    for (const namespace of include) args.push(`--nsInclude=${namespace}`);
    for (const namespace of [...excludedDatabases, ...excludedCollections]) args.push(`--nsExclude=${namespace}`);
    if (selector.includeGlobalObjects) args.push('--dumpDbUsersAndRoles');
  }
  return args;
}

function hasLogicalBackupPrivileges(identity) {
  const actions = new Set(identity.privilegeActions || []);
  return ['find', 'listCollections', 'listDatabases', 'listIndexes'].every((action) => actions.has(action));
}

function hasLogicalRestorePrivileges(identity, destructive = false, nativeValidation = false) {
  const actions = new Set(identity.privilegeActions || []);
  const required = ['insert', 'createCollection', 'createIndex', 'listCollections', 'listDatabases'];
  if (destructive) required.push('dropCollection');
  if (nativeValidation) required.push('find', 'listIndexes', 'validate');
  return required.every((action) => actions.has(action));
}

function oplogTimestamp(value, label = 'MongoDB oplog timestamp') {
  const raw = value?.$timestamp || value;
  const seconds = Number(raw?.t);
  const increment = Number(raw?.i);
  if (!Number.isInteger(seconds) || seconds < 0 || !Number.isInteger(increment) || increment < 0) throw new DatabaseAdapterError('MONGODB_OPLOG_TIMESTAMP_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return { t: seconds, i: increment };
}

function compareOplogTimestamps(left, right) {
  const a = oplogTimestamp(left);
  const b = oplogTimestamp(right);
  return a.t === b.t ? a.i - b.i : a.t - b.t;
}

function jsonClone(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function oplogCoordinate(entry, context = {}) {
  if (!entry?.ts) throw new DatabaseAdapterError('MONGODB_OPLOG_BOUNDARY_MISSING', 'MongoDB oplog boundary evidence is missing.', { category: 'integrity' });
  const timestamp = oplogTimestamp(entry.ts);
  const term = jsonClone(entry.t);
  const hash = jsonClone(entry.h);
  const historyFingerprint = `sha256:${crypto.createHash('sha256').update(JSON.stringify({ timestamp, term, hash })).digest('hex')}`;
  return {
    version: 1,
    engine: 'mongodb',
    timestamp: { $timestamp: timestamp },
    term,
    hash,
    historyFingerprint,
    capturedAt: context.capturedAt || null,
    serverIdentityFingerprint: context.serverIdentityFingerprint || null,
    replicaSetId: context.replicaSetId || null
  };
}

function normalizeOplogCoordinate(value) {
  const candidate = value?.timestamp ? value : value?.endCoordinate || (value?.end?.timestamp ? value.end : value);
  const timestamp = candidate?.timestamp || candidate?.ts || value?.end;
  if (!timestamp) throw new DatabaseAdapterError('MONGODB_OPLOG_COORDINATE_INVALID', 'The preceding MongoDB recovery point has no valid oplog coordinate.', { category: 'integrity' });
  return { ...candidate, timestamp: { $timestamp: oplogTimestamp(timestamp) } };
}

function sameOplogHistory(expected, actual) {
  if (!expected || !actual) return false;
  if (compareOplogTimestamps(expected.timestamp, actual.timestamp) !== 0) return false;
  if (expected.historyFingerprint) return expected.historyFingerprint === actual.historyFingerprint;
  return JSON.stringify({ term: expected.term ?? null, hash: expected.hash ?? null }) === JSON.stringify({ term: actual.term ?? null, hash: actual.hash ?? null });
}

async function validateBsonFile(fileSystem, filePath) {
  const stat = await fileSystem.stat(filePath);
  if (!stat.isFile() || stat.size < 5) throw new DatabaseAdapterError('MONGODB_OPLOG_BSON_EMPTY', 'MongoDB oplog capture returned no BSON documents.', { category: 'integrity' });
  const handle = await fileSystem.open(filePath, 'r');
  let offset = 0;
  let documents = 0;
  try {
    const lengthBuffer = Buffer.alloc(4);
    const terminator = Buffer.alloc(1);
    while (offset < stat.size) {
      const lengthRead = await handle.read(lengthBuffer, 0, 4, offset);
      if (lengthRead.bytesRead !== 4) throw new DatabaseAdapterError('MONGODB_OPLOG_BSON_TRUNCATED', 'MongoDB oplog BSON framing is truncated.', { category: 'integrity' });
      const length = lengthBuffer.readInt32LE(0);
      if (length < 5 || length > 64 * 1024 * 1024 || offset + length > stat.size) throw new DatabaseAdapterError('MONGODB_OPLOG_BSON_INVALID', 'MongoDB oplog BSON framing is invalid.', { category: 'integrity' });
      const tailRead = await handle.read(terminator, 0, 1, offset + length - 1);
      if (tailRead.bytesRead !== 1 || terminator[0] !== 0) throw new DatabaseAdapterError('MONGODB_OPLOG_BSON_INVALID', 'MongoDB oplog BSON document termination is invalid.', { category: 'integrity' });
      offset += length;
      documents += 1;
    }
  } finally { await handle.close(); }
  if (offset !== stat.size || documents < 1) throw new DatabaseAdapterError('MONGODB_OPLOG_BSON_INVALID', 'MongoDB oplog BSON framing is incomplete.', { category: 'integrity' });
  return { sizeBytes: stat.size, documents };
}

function safeAdapterError(error, operation) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error instanceof NativeProcessError) {
    const output = `${error.stderr || ''}\n${error.stdout || ''}`.toLowerCase();
    if (output.includes('authentication failed') || output.includes('code 18') || output.includes('unauthorized')) return new DatabaseAdapterError('MONGODB_AUTHENTICATION_FAILED', 'MongoDB authentication or required privilege validation failed.', { category: 'authentication' });
    if (output.includes('certificate') || output.includes('tls') || output.includes('ssl')) return new DatabaseAdapterError('MONGODB_TLS_FAILED', 'MongoDB TLS certificate identity verification failed.', { category: 'integrity' });
    if (output.includes('server selection') || output.includes('econnrefused') || output.includes('enotfound')) return new DatabaseAdapterError('MONGODB_CONNECT_FAILED', 'DeployerX could not connect to the MongoDB deployment.', { category: 'connectivity', retryable: true });
    if (error.code === 'NATIVE_EXECUTABLE_NOT_FOUND') return new DatabaseAdapterError('MONGODB_MONGOSH_NOT_FOUND', 'Install a supported mongosh client and make it available on PATH.', { category: 'compatibility' });
    if (error.code === 'NATIVE_PROCESS_CANCELED') return new DatabaseAdapterError('MONGODB_OPERATION_CANCELED', `The MongoDB ${operation} was canceled.`, { category: 'canceled' });
    if (error.code === 'NATIVE_PROCESS_TIMEOUT') return new DatabaseAdapterError('MONGODB_OPERATION_TIMEOUT', `The MongoDB ${operation} exceeded its timeout.`, { category: 'timeout', retryable: true });
  }
  return new DatabaseAdapterError('MONGODB_OPERATION_FAILED', `The MongoDB ${operation} failed.`, { category: 'execution' });
}

class MongoDbNativeAdapter {
  constructor({ processRunner = new NativeProcessRunner(), clock = () => new Date().toISOString(), now = () => Date.now(), temporaryRoot = os.tmpdir(), fileSystem = fs, snapshotProviderRegistry = null } = {}) {
    if (!processRunner || typeof processRunner.consume !== 'function') throw new TypeError('MongoDB process runner with standard-input support is required.');
    this.processRunner = processRunner;
    this.clock = clock;
    this.now = now;
    this.temporaryRoot = temporaryRoot;
    this.fileSystem = fileSystem;
    this.snapshotProviderRegistry = snapshotProviderRegistry;
  }

  manifest() {
    const physicalSnapshots = Boolean(this.snapshotProviderRegistry?.list?.().length);
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      displayName: 'MongoDB Native',
      engine: 'mongodb',
      executionReady: true,
      serverVersionRange: '>=7.0.0 <9.0.0',
      restoreVersionRange: '>=7.0.0 <9.0.0',
      capabilities: {
        backupMethods: physicalSnapshots ? ['logical', 'physical'] : ['logical'],
        backupModes: ['full', 'incremental'],
        selection: { database: true, schema: false, table: true, globalObjects: true },
        consistencyStrategies: [
          { id: 'mongodb-oplog-dump', produces: 'application', backupMethods: ['logical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: true },
          ...(physicalSnapshots ? [{ id: 'mongodb-coordinated-snapshot', produces: 'application', backupMethods: ['physical'], lockScope: 'instance', requiresDowntime: false, capturesCoordinates: true }] : [])
        ],
        transactionLogs: { supported: true, type: 'mongodb-oplog', pointInTimeRecovery: true, granularitySeconds: 1 },
        streaming: { backup: true, restore: true, compression: true, encryption: false },
        restore: { alternateTarget: true, nativeValidation: false },
        replicaAware: true
      },
      requiredTools: [
        { name: 'mongosh', versionRange: '>=2.0.0 <3.0.0', operations: physicalSnapshots ? ['discovery', 'validation', 'snapshot'] : ['discovery', 'validation'] },
        { name: 'mongodump', versionRange: '>=100.9.0 <101.0.0', operations: ['backup'] },
        { name: 'mongorestore', versionRange: '>=100.9.0 <101.0.0', operations: ['restore', 'validation'] }
      ],
      requiredPrivileges: [
        { id: 'mongodb-backup-effective-privileges', operations: ['discovery', 'backup'], required: true, safeDescription: 'The source account must expose effective backup and topology-monitoring privileges.' },
        ...(physicalSnapshots ? [{ id: 'mongodb-snapshot-effective-privileges', operations: ['snapshot'], required: true, safeDescription: 'The source account must expose effective fsync and replica-set monitoring privileges.' }] : []),
        { id: 'mongodb-restore-effective-privileges', operations: ['restore'], required: true, safeDescription: 'The restore account must expose effective write, index, and selected authorization-data privileges.' }
      ]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'MONGODB_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async readIdentity(context = {}, input = {}, options = {}) {
    const config = normalizeConfig(input);
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('MONGODB_SECRET_RESOLVER_MISSING', 'MongoDB credentials are unavailable.', { category: 'authentication' });
    const password = await context.resolveSecret(config.passwordSecretRefId);
    try {
      const result = await this.processRunner.consume({
        executable: config.mongoshExecutable,
        args: ['--nodb', '--quiet'],
        env: {},
        stdin: identityScript(config, password, {
          probeTimestamp: options.probeTimestamp, directConnection: options.directConnection,
          includeLogicalInventory: options.includeLogicalInventory, validateCollections: options.validateCollections,
          expectedDatabases: options.expectedDatabases
        }),
        timeoutMs: options.timeoutMs || config.timeoutMs,
        stdoutLimitBytes: options.stdoutLimitBytes || (options.includeLogicalInventory ? 16 * 1024 * 1024 : 4 * 1024 * 1024),
        signal: context.signal
      });
      return parseIdentity(result.stdout);
    } catch (error) { throw safeAdapterError(error, options.operation || 'identity query'); }
  }

  async snapshotMemberIdentity(context = {}, input = {}, memberName) {
    const memberConfig = replicaMemberConfig(input, memberName);
    const identity = await this.readIdentity(context, memberConfig, { operation: 'snapshot member identity query', directConnection: true });
    validateIdentity(memberConfig, identity);
    if (identity.me !== memberName || identity.topology !== 'replica-set') throw new DatabaseAdapterError('MONGODB_SNAPSHOT_MEMBER_CHANGED', 'The snapshot endpoint did not authenticate the selected replica-set member.', { category: 'integrity' });
    return { config: memberConfig, identity };
  }

  async setSnapshotMemberLock(context = {}, input = {}, memberName, locked) {
    const action = locked ? 'lock' : 'unlock';
    const config = replicaMemberConfig(input, memberName);
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('MONGODB_SECRET_RESOLVER_MISSING', 'MongoDB credentials are unavailable.', { category: 'authentication' });
    const password = await context.resolveSecret(config.passwordSecretRefId);
    try {
      const result = await this.processRunner.consume({
        executable: config.mongoshExecutable, args: ['--nodb', '--quiet'], env: {}, stdin: snapshotLockScript(config, password, action),
        timeoutMs: config.timeoutMs, stdoutLimitBytes: 1024 * 1024, signal: context.signal
      });
      return parseSnapshotLockResult(result.stdout, action, memberName);
    } catch (error) { throw safeAdapterError(error, `snapshot ${action}`); }
  }

  async setBalancerState(context = {}, input = {}, action = 'status') {
    const config = normalizeConfig(input);
    if (!['status', 'stop', 'start'].includes(action)) throw new TypeError('MongoDB balancer action is invalid.');
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('MONGODB_SECRET_RESOLVER_MISSING', 'MongoDB credentials are unavailable.', { category: 'authentication' });
    const password = await context.resolveSecret(config.passwordSecretRefId);
    try {
      const result = await this.processRunner.consume({
        executable: config.mongoshExecutable, args: ['--nodb', '--quiet'], env: {}, stdin: balancerScript(config, password, action),
        timeoutMs: config.timeoutMs, stdoutLimitBytes: 1024 * 1024, signal: context.signal
      });
      return parseBalancerResult(result.stdout, action);
    } catch (error) { throw safeAdapterError(error, `balancer ${action}`); }
  }

  async #toolVersion(executable, signal) {
    if (typeof this.processRunner.run !== 'function') throw new DatabaseAdapterError('MONGODB_DATABASE_TOOLS_UNAVAILABLE', 'MongoDB Database Tools execution is unavailable on this worker.', { category: 'compatibility' });
    try {
      const result = await this.processRunner.run({ executable, args: ['--version'], timeoutMs: 10000, stdoutLimitBytes: 1024 * 1024, signal });
      return databaseToolsVersion(`${result.stdout || ''}\n${result.stderr || ''}`, path.win32.basename(executable).replace(/[.]exe$/i, ''));
    } catch (error) { throw safeAdapterError(error, 'Database Tools version check'); }
  }

  async #credentialSession(context, input) {
    const config = normalizeConfig(input);
    if (typeof context.resolveSecret !== 'function') throw new DatabaseAdapterError('MONGODB_SECRET_RESOLVER_MISSING', 'MongoDB credentials are unavailable.', { category: 'authentication' });
    const password = await context.resolveSecret(config.passwordSecretRefId);
    const directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, 'deployerx-mongodb-tools-'));
    const filePath = path.join(directory, 'mongodb-tools.yml');
    try {
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      await this.fileSystem.writeFile(filePath, databaseToolsConfig(config, password), { flag: 'wx', mode: 0o600 });
      await this.fileSystem.chmod(filePath, 0o600).catch(() => {});
      return { config, filePath, cleanup: () => this.fileSystem.rm(directory, { recursive: true, force: true }) };
    } catch (error) {
      await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const config = normalizeConfig(input);
      const identity = await this.readIdentity(context, config, { operation: 'connection test' });
      const version = validateIdentity(config, identity);
      const fingerprint = deploymentFingerprint(identity);
      return {
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'success',
        checks: [
          { id: 'authentication', status: 'pass', safeMessage: 'MongoDB authentication and privilege discovery succeeded.' },
          { id: 'server-version', status: 'pass', safeMessage: `MongoDB ${version.text} is supported.` },
          { id: 'topology', status: 'pass', safeMessage: `MongoDB ${identity.topology} topology was authenticated.` },
          { id: 'deployment-identity', status: 'pass', safeMessage: 'A stable MongoDB deployment identity was recorded.' },
          { id: 'storage-engine', status: identity.topology === 'sharded' || identity.storageEngine === 'wiredTiger' ? 'pass' : 'fail', safeMessage: identity.topology === 'sharded' ? 'Storage engines will be verified on every shard execution path.' : 'MongoDB WiredTiger persistent storage was verified.' },
          { id: 'tls', status: 'pass', safeMessage: 'TLS certificate identity verification is required.' }
        ],
        remotePlatform: { engine: 'mongodb', version: version.text, distribution: 'MongoDB', platform: null },
        endpointIdentity: {
          deploymentFingerprint: fingerprint,
          deploymentId: identity.deploymentId,
          topology: identity.topology,
          setName: identity.setName,
          replicaSetId: identity.replicaSetId,
          replicaRole: identity.replicaRole,
          clusterId: identity.clusterId,
          primary: identity.primary,
          memberCount: identity.members.length,
          members: identity.members.slice(),
          shardedTopology: identity.shardedTopology ? {
            metadataFingerprint: identity.shardedTopology.metadataFingerprint,
            configServer: {
              setName: identity.shardedTopology.configServer.setName,
              hosts: identity.shardedTopology.configServer.hosts.slice()
            },
            shards: identity.shardedTopology.shards.map((shard) => ({
              shardId: shard.shardId,
              setName: shard.setName,
              hosts: shard.hosts.slice()
            }))
          } : null,
          featureCompatibilityVersion: identity.featureCompatibilityVersion,
          storageEngine: identity.storageEngine
        },
        metadata: { databases: identity.databases, authenticatedRoles: identity.authenticatedRoles, privilegeCount: identity.privilegeCount, privilegeActions: identity.privilegeActions },
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
    validateIdentity(config, identity);
    const system = new Set(['admin', 'config', 'local']);
    const items = identity.databases.filter((name) => request.includeSystem || !system.has(name)).map((name) => ({
      kind: 'database', name, system: system.has(name), selectable: !system.has(name), state: 'available', topology: identity.topology,
      deploymentId: identity.deploymentId, reasonCode: system.has(name) ? 'system-database' : null
    }));
    yield { items, nextCursor: null };
  }

  async preflight(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    if (request.consistency?.backupMethod === 'physical') {
      const [identity, dumpTool] = await Promise.all([this.readIdentity(context, config, { operation: 'coordinated snapshot preflight' }), this.#toolVersion(config.mongodumpExecutable, context.signal)]);
      const version = validateIdentity(config, identity);
      const namespaces = selectedNamespaces(request.selector);
      const execution = request.execution || {};
      const providerId = requiredText(execution.providerId, 'MongoDB snapshot provider ID', 200);
      this.snapshotProviderRegistry?.get(providerId);
      const unfiltered = request.selector?.allDatabases === true && namespaces.length === 0 && !(request.selector?.databases?.exclude?.length || request.selector?.tables?.exclude?.length || request.selector?.includeGlobalObjects);
      const actions = new Set(identity.privilegeActions || []);
      const backupPrivilegesAllowed = hasLogicalBackupPrivileges(identity);
      const privilegesAllowed = ['fsync', 'replSetGetStatus', 'listDatabases'].every((action) => actions.has(action));
      const replicaEvidence = identity.topology === 'replica-set' && Boolean(identity.replicaSetId && identity.replicaStatus?.lastCommittedOpTime?.timestamp && identity.replicaStatus?.members?.length);
      const verified = unfiltered && backupPrivilegesAllowed && privilegesAllowed && replicaEvidence && dumpTool.supported;
      return {
        checkedAt: this.clock(), serverVersion: version.text, serverVersionSupported: true,
        serverIdentityFingerprint: deploymentFingerprint(identity),
        consistency: [{ method: 'mongodb-coordinated-snapshot', verified, produces: verified ? 'application' : 'unknown', reasonCode: verified ? null : 'MONGODB_COORDINATED_SNAPSHOT_UNPROVEN' }],
        tools: [{ name: dumpTool.name, version: dumpTool.text, compatible: dumpTool.supported }],
        privileges: [
          { id: 'mongodb-backup-effective-privileges', allowed: backupPrivilegesAllowed, evidence: backupPrivilegesAllowed ? 'Required logical read and discovery actions were observed.' : 'Required backup actions were not all observed.' },
          { id: 'mongodb-snapshot-effective-privileges', allowed: privilegesAllowed, evidence: privilegesAllowed ? 'fsync, replSetGetStatus, and listDatabases actions were observed.' : 'Required snapshot actions were not all observed.' }
        ],
        coordinateCaptureVerified: verified,
        warnings: verified ? [] : [{ code: 'MONGODB_COORDINATED_SNAPSHOT_UNPROVEN', safeMessage: 'A complete replica-set scope, snapshot privileges, and authenticated member health are required.' }],
        metadata: { engine: 'mongodb', topology: identity.topology, deploymentId: identity.deploymentId, setName: identity.setName, serverVersion: version.text, serverIdentityFingerprint: deploymentFingerprint(identity), replicaSetId: identity.replicaSetId, featureCompatibilityVersion: identity.featureCompatibilityVersion, storageEngine: identity.storageEngine, databases: identity.databases.filter((name) => !['admin', 'config', 'local'].includes(name)), replicaStatus: identity.replicaStatus, snapshotProviderId: providerId }
      };
    }
    const [identity, dumpTool] = await Promise.all([
      this.readIdentity(context, config, { operation: 'logical backup inventory preflight', includeLogicalInventory: true, timeoutMs: Math.max(config.timeoutMs, MAXIMUM_INVENTORY_TIMEOUT_MS) }),
      this.#toolVersion(config.mongodumpExecutable, context.signal)
    ]);
    const version = validateIdentity(config, identity);
    const namespaces = selectedNamespaces(request.selector);
    const oplogScope = identity.topology === 'replica-set' && request.selector?.allDatabases === true && namespaces.length === 0
      && !(request.selector?.databases?.exclude?.length || request.selector?.tables?.exclude?.length || request.selector?.includeGlobalObjects);
    const privilegesAllowed = hasLogicalBackupPrivileges(identity);
    const consistencyVerified = oplogScope && privilegesAllowed && dumpTool.supported && Boolean(identity.oplog?.earliest?.ts && identity.oplog?.latest?.ts && identity.logicalInventory);
    return {
      checkedAt: this.clock(), serverVersion: version.text, serverVersionSupported: true,
      serverIdentityFingerprint: deploymentFingerprint(identity),
      consistency: [{ method: 'mongodb-oplog-dump', verified: consistencyVerified, produces: consistencyVerified ? 'application' : 'unknown', reasonCode: consistencyVerified ? null : 'MONGODB_OPLOG_ANCHOR_UNPROVEN' }],
      tools: [{ name: dumpTool.name, version: dumpTool.text, compatible: dumpTool.supported }],
      privileges: [{ id: 'mongodb-backup-effective-privileges', allowed: privilegesAllowed, evidence: privilegesAllowed ? 'Required logical read, collection, and index discovery actions were observed.' : 'find, listCollections, listDatabases, and listIndexes actions were not all observed.' }],
      coordinateCaptureVerified: consistencyVerified,
      warnings: consistencyVerified ? [] : [{ code: 'MONGODB_OPLOG_ANCHOR_UNPROVEN', safeMessage: 'Application-consistent logical backup currently requires a complete replica-set dump with an available oplog.' }],
      metadata: {
        engine: 'mongodb', topology: identity.topology, deploymentId: identity.deploymentId, setName: identity.setName,
        serverVersion: version.text, serverIdentityFingerprint: deploymentFingerprint(identity),
        replicaSetId: identity.replicaSetId, featureCompatibilityVersion: identity.featureCompatibilityVersion,
        storageEngine: identity.storageEngine, selectedNamespaces: namespaces,
        oplog: identity.oplog, databases: identity.logicalInventory?.databases || identity.databases.filter((name) => !['admin', 'config', 'local'].includes(name)),
        ...logicalInventoryMetadata(identity.logicalInventory)
      }
    };
  }

  async planBackup(_context = {}, request = {}) {
    if (request.consistency?.backupMethod === 'physical') {
      if (request.consistency?.proven !== true || request.consistency?.method !== 'mongodb-coordinated-snapshot' || request.consistency?.achievedLevel !== 'application') throw new DatabaseAdapterError('MONGODB_SNAPSHOT_CONSISTENCY_PLAN_INVALID', 'MongoDB physical backup requires a proven coordinated snapshot plan.', { category: 'consistency' });
      const execution = request.execution || {};
      this.snapshotProviderRegistry?.get(requiredText(execution.providerId, 'MongoDB snapshot provider ID', 200));
      return { version: 1, operation: 'mongodb-coordinated-snapshot', connection: normalizeConfig(request.connection), selector: request.selector, consistency: request.consistency, execution, artifact: { kind: 'physical-backup', path: 'mongodb/physical/snapshot.export', mediaType: 'application/vnd.deployerx.mongodb-snapshot' }, resumable: false };
    }
    if (request.consistency?.proven !== true || request.consistency?.method !== 'mongodb-oplog-dump' || request.consistency?.achievedLevel !== 'application' || request.consistency?.captureCoordinates !== true) {
      throw new DatabaseAdapterError('MONGODB_CONSISTENCY_PLAN_INVALID', 'MongoDB logical backup requires a proven replica-set oplog anchor.', { category: 'consistency' });
    }
    const config = normalizeConfig(request.connection);
    return {
      version: 1, operation: 'mongodb-oplog-dump', connection: config, selector: request.selector,
      dumpArguments: dumpArguments(request.selector, true), consistency: request.consistency,
      databaseMetadata: request.consistency.evidence?.metadata || {},
      artifact: { kind: 'database-dump', path: 'mongodb/logical-anchor.archive.gz', mediaType: 'application/vnd.mongodb.archive+gzip' },
      resumable: false
    };
  }

  async openBackup(context = {}, plan = {}) {
    if (plan.operation !== 'mongodb-oplog-dump' || plan.consistency?.proven !== true || typeof this.processRunner.stream !== 'function') throw new DatabaseAdapterError('MONGODB_BACKUP_PLAN_INVALID', 'The MongoDB logical backup plan is invalid.', { category: 'integrity' });
    const session = await this.#credentialSession(context, plan.connection);
    let started;
    try {
      started = this.processRunner.stream({
        executable: session.config.mongodumpExecutable,
        args: [`--config=${session.filePath}`, ...plan.dumpArguments],
        timeoutMs: Math.max(session.config.timeoutMs, MAXIMUM_DUMP_TIMEOUT_MS), signal: context.signal
      });
    } catch (error) {
      await session.cleanup().catch(() => {});
      throw safeAdapterError(error, 'logical backup');
    }
    const metadata = {
      ...plan.databaseMetadata,
      selectorDigest: plan.selector.digest,
      consistency: plan.consistency,
      oplogReplay: true,
      oplog: { start: plan.databaseMetadata?.oplog?.latest?.ts || null, end: null, earliestAfter: null, startEntry: plan.databaseMetadata?.oplog?.latest || null, endEntry: null },
      server: {}
    };
    const adapter = this;
    const content = (async function* streamDump() {
      let completed = false;
      try {
        for await (const chunk of started.stdout) {
          await context.onProgress?.({ phase: 'reading', bytesRead: Buffer.byteLength(chunk), path: plan.artifact.path });
          yield Buffer.from(chunk);
        }
        await started.completion;
        const after = await adapter.readIdentity(context, session.config, { operation: 'post-dump oplog verification' });
        validateIdentity(session.config, after);
        if (deploymentFingerprint(after) !== plan.consistency.evidence.serverIdentityFingerprint) throw new DatabaseAdapterError('MONGODB_DEPLOYMENT_IDENTITY_CHANGED', 'The MongoDB deployment identity changed during backup.', { category: 'integrity' });
        const start = metadata.oplog.start;
        const earliestAfter = after.oplog?.earliest?.ts;
        const end = after.oplog?.latest?.ts;
        if (!start || !earliestAfter || !end || compareOplogTimestamps(earliestAfter, start) > 0 || compareOplogTimestamps(end, start) < 0) {
          throw new DatabaseAdapterError('MONGODB_OPLOG_WINDOW_CHANGED', 'The MongoDB oplog no longer covers the logical backup anchor.', { category: 'consistency' });
        }
        metadata.oplog = { start, end, earliestAfter, startEntry: metadata.oplog.startEntry, endEntry: after.oplog.latest };
        metadata.server = { oplog: metadata.oplog };
        completed = true;
      } catch (error) { throw safeAdapterError(error, 'logical backup'); }
      finally {
        if (!completed) started.cancel();
        await started.completion.catch(() => {});
        await session.cleanup().catch(() => {});
      }
    })();
    return { content, artifact: plan.artifact, metadata, server: metadata };
  }

  async prepareBinaryLogCapture(context = {}, request = {}) {
    const config = normalizeConfig(request.connection);
    const selector = request.selector || {};
    const filtered = selector.allDatabases !== true || selector.databases?.include?.length || selector.databases?.exclude?.length
      || selector.schemas?.include?.length || selector.schemas?.exclude?.length || selector.tables?.include?.length || selector.tables?.exclude?.length || selector.includeGlobalObjects;
    if (filtered) throw new DatabaseAdapterError('MONGODB_OPLOG_SCOPE_INVALID', 'MongoDB oplog capture requires the complete replica-set deployment.', { category: 'compatibility' });
    const start = normalizeOplogCoordinate(request.startCoordinate);
    const [identity, dumpTool] = await Promise.all([
      this.readIdentity(context, config, { operation: 'oplog range planning', probeTimestamp: start.timestamp }),
      this.#toolVersion(config.mongodumpExecutable, context.signal)
    ]);
    validateIdentity(config, identity);
    const serverIdentityFingerprint = deploymentFingerprint(identity);
    if (identity.topology !== 'replica-set' || !identity.replicaSetId) throw new DatabaseAdapterError('MONGODB_OPLOG_TOPOLOGY_INVALID', 'MongoDB continuous oplog capture requires a replica set.', { category: 'compatibility' });
    if (start.serverIdentityFingerprint && start.serverIdentityFingerprint !== serverIdentityFingerprint) throw new DatabaseAdapterError('MONGODB_DEPLOYMENT_IDENTITY_CHANGED', 'The MongoDB deployment identity changed after the preceding recovery point.', { category: 'integrity' });
    if (start.replicaSetId && start.replicaSetId !== identity.replicaSetId) throw new DatabaseAdapterError('MONGODB_REPLICA_SET_ID_CHANGED', 'The MongoDB replica-set ID changed after the preceding recovery point.', { category: 'integrity' });
    if (!dumpTool.supported) throw new DatabaseAdapterError('MONGODB_DATABASE_TOOLS_UNSUPPORTED', 'Install MongoDB Database Tools 100.9 or newer on this worker.', { category: 'compatibility' });
    const earliestTimestamp = identity.oplog?.earliest?.ts;
    const latestEntry = identity.oplog?.latest;
    const probeEntry = identity.oplog?.probe;
    if (!earliestTimestamp || !latestEntry?.ts || compareOplogTimestamps(earliestTimestamp, start.timestamp) > 0) throw new DatabaseAdapterError('MONGODB_OPLOG_ROLLED_OVER', 'The MongoDB oplog rolled past the preceding recovery point.', { category: 'consistency' });
    if (compareOplogTimestamps(latestEntry.ts, start.timestamp) < 0) throw new DatabaseAdapterError('MONGODB_OPLOG_HISTORY_DIVERGED', 'The MongoDB oplog is behind the preceding recovery point.', { category: 'consistency' });
    const observedStart = probeEntry ? oplogCoordinate(probeEntry, { serverIdentityFingerprint, replicaSetId: identity.replicaSetId, capturedAt: start.capturedAt }) : null;
    if (!sameOplogHistory(start, observedStart)) throw new DatabaseAdapterError('MONGODB_OPLOG_HISTORY_DIVERGED', 'The MongoDB oplog history diverged from the preceding recovery point.', { category: 'consistency' });
    const end = oplogCoordinate(latestEntry, { serverIdentityFingerprint, replicaSetId: identity.replicaSetId, capturedAt: this.clock() });
    const empty = compareOplogTimestamps(start.timestamp, end.timestamp) === 0;
    const startTs = oplogTimestamp(start.timestamp);
    const endTs = oplogTimestamp(end.timestamp);
    const file = `oplog-${startTs.t}-${startTs.i}--${endTs.t}-${endTs.i}.bson`;
    const segments = empty ? [] : [{ file, artifactPath: `mongodb/oplog/${file}`, startCoordinate: start, endCoordinate: end, startPosition: 0, stopPosition: null }];
    return {
      version: 1, operation: 'mongodb-oplog-capture', connection: config, selector, serverIdentityFingerprint,
      replicaSetId: identity.replicaSetId, database: '*', checksum: 'bson-framing-v1', nativeTool: dumpTool,
      start, end, segments, empty
    };
  }

  async captureBinaryLogs(context = {}, plan = {}, destinationDirectory) {
    if (plan.operation !== 'mongodb-oplog-capture' || !Array.isArray(plan.segments) || plan.segments.length !== 1) throw new DatabaseAdapterError('MONGODB_OPLOG_CAPTURE_PLAN_INVALID', 'The MongoDB oplog capture plan is invalid.', { category: 'integrity' });
    const destination = requiredText(destinationDirectory, 'MongoDB oplog destination', 4096);
    const session = await this.#credentialSession(context, plan.connection);
    const outputDirectory = path.join(destination, 'native-oplog');
    const queryFile = path.join(destination, 'oplog-query.json');
    try {
      await this.fileSystem.mkdir(outputDirectory, { recursive: false, mode: 0o700 });
      const query = { ts: { $gt: plan.start.timestamp, $lte: plan.end.timestamp } };
      await this.fileSystem.writeFile(queryFile, JSON.stringify(query), { flag: 'wx', mode: 0o600 });
      await this.processRunner.run({
        executable: session.config.mongodumpExecutable,
        args: [`--config=${session.filePath}`, '--db=local', '--collection=oplog.rs', `--queryFile=${queryFile}`, `--out=${outputDirectory}`, '--numParallelCollections=1'],
        timeoutMs: Math.max(session.config.timeoutMs, MAXIMUM_DUMP_TIMEOUT_MS), stdoutLimitBytes: 4 * 1024 * 1024, signal: context.signal
      });
      const filePath = path.join(outputDirectory, 'local', 'oplog.rs.bson');
      const validation = await validateBsonFile(this.fileSystem, filePath);
      const after = await this.readIdentity(context, session.config, { operation: 'post-capture oplog verification', probeTimestamp: plan.start.timestamp });
      validateIdentity(session.config, after);
      if (deploymentFingerprint(after) !== plan.serverIdentityFingerprint || after.replicaSetId !== plan.replicaSetId) throw new DatabaseAdapterError('MONGODB_DEPLOYMENT_IDENTITY_CHANGED', 'The MongoDB deployment identity changed during oplog capture.', { category: 'integrity' });
      if (!after.oplog?.earliest?.ts || compareOplogTimestamps(after.oplog.earliest.ts, plan.start.timestamp) > 0) throw new DatabaseAdapterError('MONGODB_OPLOG_ROLLED_OVER', 'The MongoDB oplog rolled over during capture.', { category: 'consistency' });
      if (!after.oplog?.latest?.ts || compareOplogTimestamps(after.oplog.latest.ts, plan.end.timestamp) < 0) throw new DatabaseAdapterError('MONGODB_OPLOG_CAPTURE_INCOMPLETE', 'The MongoDB oplog capture did not retain its planned end boundary.', { category: 'consistency' });
      const observedStart = after.oplog?.probe ? oplogCoordinate(after.oplog.probe, { serverIdentityFingerprint: plan.serverIdentityFingerprint, replicaSetId: plan.replicaSetId, capturedAt: plan.start.capturedAt }) : null;
      if (!sameOplogHistory(plan.start, observedStart)) throw new DatabaseAdapterError('MONGODB_OPLOG_HISTORY_DIVERGED', 'The MongoDB oplog history diverged during capture.', { category: 'consistency' });
      const segment = plan.segments[0];
      return [{ ...segment, filePath, sizeBytes: validation.sizeBytes, stopPosition: validation.sizeBytes, documentCount: validation.documents }];
    } catch (error) { throw safeAdapterError(error, 'oplog capture'); }
    finally {
      await this.fileSystem.rm(queryFile, { force: true }).catch(() => {});
      await session.cleanup().catch(() => {});
    }
  }

  async executeBackup(context = {}, plan = {}, sink) {
    if (!sink || typeof sink.write !== 'function') throw new TypeError('MongoDB backup artifact sink is required.');
    const opened = await this.openBackup(context, plan);
    const stored = await sink.write({ ...opened.artifact, content: opened.content, metadata: opened.metadata });
    return { status: 'succeeded', artifacts: [stored || opened.artifact], consistency: plan.consistency, metadata: opened.metadata };
  }

  async prepareRestoreTarget(context = {}, request = {}) {
    const mode = String(request.mode || 'original');
    if (!['original', 'alternate'].includes(mode)) throw new DatabaseAdapterError('MONGODB_RESTORE_MODE_INVALID', 'MongoDB logical recovery supports only the original deployment or an alternate deployment.', { category: 'validation' });
    const connection = normalizeConfig(request.connection);
    const [identity, restoreTool] = await Promise.all([
      this.readIdentity(context, connection, { operation: 'restore target preflight' }),
      this.#toolVersion(connection.mongorestoreExecutable, context.signal)
    ]);
    const targetVersion = validateIdentity(connection, identity);
    if (identity.topology === 'sharded') throw new DatabaseAdapterError('MONGODB_SHARDED_RESTORE_UNSUPPORTED', 'Sharded-cluster recovery requires coordinated config-server and every-shard restore.', { category: 'compatibility' });
    if (!restoreTool.supported) throw new DatabaseAdapterError('MONGODB_DATABASE_TOOLS_UNSUPPORTED', 'Install MongoDB Database Tools 100.9 or newer on this worker.', { category: 'compatibility' });
    const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    const validationInventory = logicalInventoryFromMetadata(metadata);
    const destructive = mode === 'original' || request.conflictPolicy === 'overwrite' || Boolean(validationInventory);
    if (!hasLogicalRestorePrivileges(identity, destructive, Boolean(validationInventory))) throw new DatabaseAdapterError('MONGODB_RESTORE_PRIVILEGES_MISSING', 'The selected MongoDB target account lacks the effective privileges required to create, index, write, replace, and natively validate restored collections.', { category: 'authorization' });
    const expectedDatabases = validationInventory?.databases || [...new Set((metadata.databases || metadata.server?.databases || []).filter((name) => !['admin', 'config', 'local'].includes(name)).map((name) => normalizeDatabaseName(name, 'MongoDB restore database')))];
    if (!expectedDatabases.length) throw new DatabaseAdapterError('MONGODB_RESTORE_INVENTORY_MISSING', 'The recovery point has no authenticated user-database inventory.', { category: 'integrity' });
    const sourceMajor = metadata.serverVersion ? parseVersion(metadata.serverVersion).major : null;
    if (sourceMajor && sourceMajor !== targetVersion.major) throw new DatabaseAdapterError('MONGODB_RESTORE_VERSION_MISMATCH', 'MongoDB logical recovery requires the target server to use the protected server major version.', { category: 'compatibility' });
    const targetFingerprint = deploymentFingerprint(identity);
    const sourceFingerprint = metadata.serverIdentityFingerprint || request.serverIdentityFingerprint;
    if (!sourceFingerprint) throw new DatabaseAdapterError('MONGODB_RESTORE_IDENTITY_MISSING', 'The recovery point has no authenticated MongoDB deployment identity.', { category: 'integrity' });
    if (mode === 'original' && targetFingerprint !== sourceFingerprint) throw new DatabaseAdapterError('MONGODB_RESTORE_DEPLOYMENT_MISMATCH', 'The original MongoDB deployment identity no longer matches this recovery point.', { category: 'integrity' });
    if (mode === 'alternate' && targetFingerprint === sourceFingerprint) throw new DatabaseAdapterError('MONGODB_ALTERNATE_TARGET_IS_ORIGINAL', 'Choose a different verified MongoDB deployment for alternate recovery.', { category: 'conflict' });
    const existing = new Set(identity.databases.filter((name) => !['admin', 'config', 'local'].includes(name)));
    const collisions = expectedDatabases.filter((name) => existing.has(name));
    if (mode === 'alternate' && collisions.length && request.conflictPolicy !== 'overwrite') throw new DatabaseAdapterError('MONGODB_ALTERNATE_TARGET_CONFLICT', 'The alternate MongoDB deployment already contains a protected database. Choose overwrite explicitly or use an empty target.', { category: 'conflict' });
    return { connection, identity, restoreTool, metadata, validationInventory, expectedDatabases, collisions, destructive, preserveUuid: Boolean(validationInventory), targetFingerprint };
  }

  async planRestore(_context = {}, request = {}) {
    const mode = String(request.mode || 'original');
    const confirmations = { original: 'RESTORE_MONGODB_ORIGINAL', alternate: 'RESTORE_MONGODB_ALTERNATE' };
    if (!confirmations[mode] || request.confirmation !== confirmations[mode]) throw new DatabaseAdapterError('MONGODB_RESTORE_CONFIRMATION_REQUIRED', 'Explicit confirmation is required before restoring MongoDB data.', { category: 'conflict' });
    const prepared = request.prepared;
    if (!prepared || prepared.targetFingerprint !== request.targetFingerprint || !Array.isArray(prepared.expectedDatabases)) throw new DatabaseAdapterError('MONGODB_RESTORE_TARGET_NOT_PREPARED', 'The MongoDB restore target must pass destination preflight before restore.', { category: 'integrity' });
    return {
      version: 1, operation: 'mongodb-logical-restore', mode, connection: normalizeConfig(request.connection),
      artifactPath: requiredText(request.artifactPath, 'MongoDB archive artifact path', 8192),
      expectedDatabases: prepared.expectedDatabases, destructive: prepared.destructive,
      validationInventory: prepared.validationInventory ? structuredClone(prepared.validationInventory) : null,
      preserveUuid: prepared.preserveUuid === true,
      targetFingerprint: prepared.targetFingerprint, oplogLimit: request.oplogLimit ? normalizeOplogCoordinate(request.oplogLimit) : null
    };
  }

  async executeRestore(context = {}, plan = {}, source) {
    if (plan.operation !== 'mongodb-logical-restore' || !source || typeof source.open !== 'function') throw new DatabaseAdapterError('MONGODB_RESTORE_PLAN_INVALID', 'The MongoDB logical restore plan is invalid.', { category: 'integrity' });
    const session = await this.#credentialSession(context, plan.connection);
    try {
      const content = await source.open({ kind: 'database-dump', path: plan.artifactPath });
      const args = [`--config=${session.filePath}`, '--archive', '--gzip', '--oplogReplay', '--stopOnError', '--numParallelCollections=4'];
      if (plan.preserveUuid) args.push('--drop', '--preserveUUID');
      else if (plan.destructive) args.push('--drop');
      if (plan.oplogLimit) {
        const timestamp = oplogTimestamp(plan.oplogLimit.timestamp);
        args.push(`--oplogLimit=${timestamp.t}:${timestamp.i}`);
      }
      await this.processRunner.consume({ executable: session.config.mongorestoreExecutable, args, env: {}, stdin: content, timeoutMs: Math.max(session.config.timeoutMs, MAXIMUM_DUMP_TIMEOUT_MS), stdoutLimitBytes: 4 * 1024 * 1024, signal: context.signal });
      return { status: 'succeeded', expectedDatabases: plan.expectedDatabases, targetFingerprint: plan.targetFingerprint };
    } catch (error) { throw safeAdapterError(error, 'logical restore'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async executeOplogReplay(context = {}, request = {}) {
    const connection = normalizeConfig(request.connection);
    const files = Array.isArray(request.files) ? request.files.slice(0, 1000) : [];
    if (!files.length) throw new DatabaseAdapterError('MONGODB_OPLOG_REPLAY_FILES_MISSING', 'The MongoDB recovery chain contains no oplog files to replay.', { category: 'integrity' });
    const limit = request.oplogLimit ? oplogTimestamp(normalizeOplogCoordinate(request.oplogLimit).timestamp) : null;
    const session = await this.#credentialSession(context, connection);
    let replayedFiles = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        await validateBsonFile(this.fileSystem, requiredText(file.filePath, 'MongoDB oplog file path', 4096));
        const args = [`--config=${session.filePath}`, '--oplogReplay', `--oplogFile=${file.filePath}`, '--stopOnError'];
        if (limit && index === files.length - 1) args.push(`--oplogLimit=${limit.t}:${limit.i}`);
        await this.processRunner.run({ executable: session.config.mongorestoreExecutable, args, timeoutMs: Math.max(session.config.timeoutMs, MAXIMUM_DUMP_TIMEOUT_MS), stdoutLimitBytes: 4 * 1024 * 1024, signal: context.signal });
        replayedFiles += 1;
      }
      return { status: 'succeeded', replayedFiles, oplogLimit: request.oplogLimit || null };
    } catch (error) { throw safeAdapterError(error, 'oplog replay'); }
    finally { await session.cleanup().catch(() => {}); }
  }

  async validateRestore(context = {}, request = {}) {
    const connection = normalizeConfig(request.connection);
    const expectedDatabases = [...new Set((request.expectedDatabases || []).map((name) => normalizeDatabaseName(name, 'MongoDB restored database')))];
    const expectedInventory = request.validationInventory ? normalizeLogicalInventory(request.validationInventory) : null;
    const identity = await this.readIdentity(context, connection, {
      operation: 'post-restore native validation', includeLogicalInventory: Boolean(expectedInventory), validateCollections: Boolean(expectedInventory),
      expectedDatabases, timeoutMs: expectedInventory ? Math.max(connection.timeoutMs, MAXIMUM_VALIDATION_TIMEOUT_MS) : connection.timeoutMs
    });
    validateIdentity(connection, identity);
    const missing = expectedDatabases.filter((name) => !identity.databases.includes(name));
    const targetFingerprint = deploymentFingerprint(identity);
    const identityValid = !request.targetFingerprint || request.targetFingerprint === targetFingerprint;
    if (!expectedInventory) {
      const valid = !missing.length && identityValid;
      return {
        status: valid ? 'warning' : 'failed', valid, nativeIntegrityValidation: false,
        checks: [
          { id: 'connectivity', status: 'pass' },
          { id: 'target-identity', status: identityValid ? 'pass' : 'fail' },
          { id: 'expected-databases', status: missing.length ? 'fail' : 'pass', missing },
          { id: 'expected-objects', status: 'warning', reasonCode: 'MONGODB_VALIDATION_INVENTORY_UNAVAILABLE' }
        ],
        expectedDatabases, missing, targetFingerprint,
        warnings: valid ? [{ code: 'MONGODB_VALIDATION_INVENTORY_UNAVAILABLE', safeMessage: 'This older MongoDB recovery point has no authenticated collection and index inventory; only deployment and database connectivity were validated.' }] : []
      };
    }
    if (!identity.logicalInventory) throw new DatabaseAdapterError('MONGODB_NATIVE_VALIDATION_EVIDENCE_MISSING', 'MongoDB did not return post-restore collection and native validation evidence.', { category: 'integrity' });
    const comparison = compareLogicalInventories(expectedInventory, identity.logicalInventory, { requireUuid: request.requireUuid !== false });
    const valid = !missing.length && identityValid && comparison.valid;
    const nativeWarnings = identity.logicalInventory.nativeValidation.results.reduce((total, item) => total + item.warnings, 0);
    return {
      status: valid ? 'succeeded' : 'failed', valid, nativeIntegrityValidation: true,
      checks: [
        { id: 'connectivity', status: 'pass' },
        { id: 'target-identity', status: identityValid ? 'pass' : 'fail' },
        { id: 'expected-databases', status: missing.length || comparison.missingDatabases.length ? 'fail' : 'pass', missing: [...new Set([...missing, ...comparison.missingDatabases])].slice(0, 20) },
        { id: 'expected-objects', status: comparison.missingCollections.length || comparison.typeMismatches.length || comparison.optionMismatches.length ? 'fail' : 'pass', expectedCollections: expectedInventory.collections.length, missingCollections: comparison.missingCollections.slice(0, 20), typeMismatches: comparison.typeMismatches.slice(0, 20), optionMismatches: comparison.optionMismatches.slice(0, 20) },
        { id: 'collection-uuids', status: comparison.uuidMismatches.length ? 'fail' : 'pass', mismatches: comparison.uuidMismatches.slice(0, 20) },
        { id: 'indexes', status: comparison.missingIndexes.length || comparison.indexMismatches.length ? 'fail' : 'pass', expectedIndexes: expectedInventory.indexCount, missingIndexes: comparison.missingIndexes.slice(0, 20), mismatches: comparison.indexMismatches.slice(0, 20) },
        { id: 'native-validation', status: comparison.invalidNative.length ? 'fail' : 'pass', collectionsChecked: identity.logicalInventory.nativeValidation.results.length, invalidCollections: comparison.invalidNative.slice(0, 20), warningCount: nativeWarnings }
      ],
      expectedDatabases, missing, targetFingerprint, inventoryFingerprint: identity.logicalInventory.inventoryFingerprint,
      warnings: nativeWarnings ? [{ code: 'MONGODB_NATIVE_VALIDATION_WARNINGS', safeMessage: 'MongoDB native validation passed but reported bounded warnings; inspect the validation record.' }] : []
    };
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class MongoDbConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new MongoDbNativeAdapter() } = {}) {
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
    const name = requiredText(input.name, 'MongoDB connection name', 200);
    const password = String(input.password ?? '');
    if (!password || password.includes('\0') || /[\r\n]/.test(password) || password.length > 1024 * 1024) throw new TypeError('MongoDB password is invalid.');
    let passwordRef = null;
    try {
      passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} MongoDB password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({
        host: input.host, port: input.port, username: input.username, passwordSecretRefId: passwordRef.id,
        authSource: input.authSource, replicaSet: input.replicaSet, expectedTopology: input.expectedTopology,
        tlsMode: input.tlsMode, caFile: input.caFile, timeoutMs: input.timeoutMs, mongoshExecutable: input.mongoshExecutable,
        mongodumpExecutable: input.mongodumpExecutable, mongorestoreExecutable: input.mongorestoreExecutable
      });
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION,
          scope: 'device', endpoint: {
            host: config.host, port: config.port, username: config.username, authSource: config.authSource, replicaSet: config.replicaSet,
            expectedTopology: config.expectedTopology, tlsMode: config.tlsMode, caFile: config.caFile, timeoutMs: config.timeoutMs,
            mongoshExecutable: config.mongoshExecutable, mongodumpExecutable: config.mongodumpExecutable, mongorestoreExecutable: config.mongorestoreExecutable
          },
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
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('MongoDB source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This MongoDB connection belongs to another device.');
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
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('MongoDB source connection was not found.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the MongoDB connection successfully before discovering databases.');
    const pages = [];
    for await (const page of this.adapter.discover({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId }), signal: input.signal }, { connection: this.config(current), includeSystem: Boolean(input.includeSystem) })) pages.push(page);
    return pages[0] || { items: [], nextCursor: null };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  MAX_LOGICAL_COLLECTIONS,
  MAX_LOGICAL_DATABASES,
  MAX_LOGICAL_INDEXES,
  MongoDbConnectionService,
  MongoDbNativeAdapter,
  balancerScript,
  connectionUri,
  connectionUriWithoutPassword,
  compareOplogTimestamps,
  compareLogicalInventories,
  databaseToolsConfig,
  databaseToolsVersion,
  deploymentFingerprint,
  dumpArguments,
  identityScript,
  normalizeConfig,
  normalizeLogicalInventory,
  normalizeOplogCoordinate,
  normalizeReplicaSetConnectionString,
  normalizeReplicaStatus,
  normalizeShardedTopology,
  oplogCoordinate,
  oplogTimestamp,
  parseIdentity,
  parseBalancerResult,
  parseSnapshotLockResult,
  parseVersion,
  replicaMemberConfig,
  logicalInventoryFromMetadata,
  logicalInventoryMetadata,
  safeAdapterError,
  sameOplogHistory,
  shardedTopologyFingerprint,
  snapshotLockScript,
  validateBsonFile,
  validateIdentity
};
