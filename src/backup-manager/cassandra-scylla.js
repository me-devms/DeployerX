const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');
const { domainToASCII } = require('url');
const { execFile } = require('child_process');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');
const { planCassandraCommitLogRestore } = require('./cassandra-commit-log');

const ADAPTER_ID = 'deployerx.database.cassandra-scylla';
const ADAPTER_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RING_TOKENS = 1000000;
const PRODUCTS = new Set(['auto', 'cassandra', 'scylladb']);
const EXECUTION_MODES = new Set(['local', 'ssh']);
const DISCOVERY_KINDS = new Set(['all', 'topology', 'keyspaces', 'tables', 'snapshots']);

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

function normalizePort(value) {
  const port = Number(value ?? 9042);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('CQL native port must be between 1 and 65535.');
  return port;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('Cassandra/Scylla command timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeContactHost(value) {
  const input = optionalText(value, 'CQL contact host', 253) || '127.0.0.1';
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('CQL contact host must be a hostname or IP address without a URI scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new TypeError('CQL contact host is invalid.');
  return ascii;
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

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Cassandra/Scylla connection configuration must be an object.');
  const allowed = ['expectedProduct', 'executionMode', 'sshConnectionId', 'contactHost', 'nativePort', 'cqlUsername', 'cqlPasswordSecretRefId', 'nodetoolPath', 'cqlshPath', 'sstableloaderPath', 'cassandraPath', 'scyllaPath', 'timeoutMs', 'expectedClusterName', 'expectedDeploymentFingerprint', 'expectedTopologyFingerprint'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown Cassandra/Scylla connection field: ${unknown[0]}.`);
  const expectedProduct = String(input.expectedProduct || 'auto').toLowerCase();
  if (!PRODUCTS.has(expectedProduct)) throw new TypeError('Expected Cassandra/Scylla product is invalid.');
  const executionMode = String(input.executionMode || 'ssh').toLowerCase();
  if (!EXECUTION_MODES.has(executionMode)) throw new TypeError('Cassandra/Scylla execution mode is invalid.');
  const sshConnectionId = optionalText(input.sshConnectionId, 'SSH connection ID', 200);
  if (executionMode === 'ssh' && !sshConnectionId) throw new TypeError('SSH execution requires a saved SSH connection.');
  if (executionMode === 'local' && sshConnectionId) throw new TypeError('Local execution cannot include an SSH connection.');
  const cqlUsername = optionalText(input.cqlUsername, 'CQL username', 256);
  const cqlPasswordSecretRefId = optionalText(input.cqlPasswordSecretRefId, 'CQL password SecretRef ID', 200);
  if (Boolean(cqlUsername) !== Boolean(cqlPasswordSecretRefId)) throw new TypeError('CQL authentication requires both a username and password SecretRef.');
  const executables = {
    nodetoolPath: normalizeExecutable(input.nodetoolPath, 'nodetool path', 'nodetool'),
    cqlshPath: normalizeExecutable(input.cqlshPath, 'cqlsh path', 'cqlsh'),
    sstableloaderPath: normalizeExecutable(input.sstableloaderPath, 'sstableloader path', 'sstableloader'),
    cassandraPath: normalizeExecutable(input.cassandraPath, 'Cassandra path', 'cassandra'),
    scyllaPath: normalizeExecutable(input.scyllaPath, 'ScyllaDB path', 'scylla')
  };
  if (executionMode === 'ssh' && Object.values(executables).some((executable) => /[\\:]/.test(executable))) throw new TypeError('SSH execution requires POSIX executable paths or executable names.');
  return {
    expectedProduct,
    executionMode,
    sshConnectionId,
    contactHost: normalizeContactHost(input.contactHost),
    nativePort: normalizePort(input.nativePort),
    cqlUsername,
    cqlPasswordSecretRefId,
    ...executables,
    timeoutMs: normalizeTimeout(input.timeoutMs),
    expectedClusterName: optionalText(input.expectedClusterName, 'Expected cluster name', 255),
    expectedDeploymentFingerprint: optionalText(input.expectedDeploymentFingerprint, 'Expected deployment fingerprint', 80),
    expectedTopologyFingerprint: optionalText(input.expectedTopologyFingerprint, 'Expected topology fingerprint', 80)
  };
}

function runLocalCommand({ executable, args = [], timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs, windowsHide: true, signal }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new DatabaseAdapterError(error.killed ? 'CASSANDRA_COMMAND_TIMEOUT' : error.name === 'AbortError' ? 'CASSANDRA_COMMAND_CANCELED' : 'CASSANDRA_COMMAND_FAILED', error.killed ? 'A Cassandra/Scylla native command timed out.' : error.name === 'AbortError' ? 'Cassandra/Scylla discovery was canceled.' : 'A Cassandra/Scylla native command failed.', { category: error.killed ? 'timeout' : error.name === 'AbortError' ? 'canceled' : 'unavailable', retryable: Boolean(error.killed) });
        wrapped.exitCode = Number.isInteger(error.code) ? error.code : null;
        return reject(wrapped);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode: 0 });
    });
  });
}

async function command(context, config, executable, args, options = {}) {
  const runner = context.runNativeCommand || runLocalCommand;
  try {
    return await runner({ executable, args, timeoutMs: config.timeoutMs, signal: context.signal });
  } catch (error) {
    if (options.allowFailure) return { stdout: '', stderr: '', exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1, failed: true };
    if (error instanceof DatabaseAdapterError) throw error;
    throw new DatabaseAdapterError('CASSANDRA_COMMAND_FAILED', 'A Cassandra/Scylla native command failed.', { category: 'unavailable', retryable: true });
  }
}

function extractVersion(value, product) {
  const text = requiredText(value, `${product} version output`, 4096);
  const match = /(?:^|[^0-9])(20\d{2}|\d{1,2})[.](\d+)(?:[.](\d+))?/.exec(text);
  if (!match) throw new DatabaseAdapterError('CASSANDRA_VERSION_INVALID', 'The database product returned an invalid version.', { category: 'compatibility' });
  const version = { text: `${match[1]}.${match[2]}.${match[3] || '0'}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) };
  const supported = product === 'cassandra'
    ? version.major >= 4 && version.major <= 5
    : (version.major >= 5 && version.major <= 6) || (version.major >= 2024 && version.major <= 2027);
  if (!supported) throw new DatabaseAdapterError('CASSANDRA_VERSION_UNSUPPORTED', `${product === 'cassandra' ? 'Apache Cassandra' : 'ScyllaDB'} ${version.text} is not supported.`, { category: 'compatibility' });
  return version;
}

async function detectProduct(context, config) {
  const attempts = config.expectedProduct === 'cassandra' ? ['cassandra'] : config.expectedProduct === 'scylladb' ? ['scylladb'] : ['scylladb', 'cassandra'];
  for (const product of attempts) {
    const result = product === 'scylladb'
      ? await command(context, config, config.scyllaPath, ['--version'], { allowFailure: true })
      : await command(context, config, config.cassandraPath, ['-v'], { allowFailure: true });
    if (!result.failed && result.stdout.trim()) return { product, version: extractVersion(result.stdout, product) };
  }
  throw new DatabaseAdapterError('CASSANDRA_PRODUCT_UNAVAILABLE', 'A supported Cassandra or ScyllaDB product binary was not found on the execution host.', { category: 'compatibility' });
}

function parseInfo(output) {
  const result = {};
  for (const raw of String(output || '').split(/\r?\n/)) {
    const match = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(raw);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, '-');
    if (!Object.hasOwn(result, key)) result[key] = match[2].trim();
  }
  return result;
}

function parseStatus(output) {
  let dataCenter = null;
  const nodes = [];
  for (const raw of String(output || '').split(/\r?\n/)) {
    const dc = /^Datacenter:\s*(.+?)\s*$/.exec(raw);
    if (dc) { dataCenter = requiredText(dc[1], 'Data center', 255); continue; }
    const match = /^\s*([UD][NLMJ])\s+(\S+)\s+(.+?)\s+(\d+)\s+(\?|[0-9.]+%)\s+([0-9a-fA-F-]{16,})\s+(.+?)\s*$/.exec(raw);
    if (!match) continue;
    const state = match[1];
    nodes.push({
      dataCenter,
      status: state[0] === 'U' ? 'up' : 'down',
      state: ({ N: 'normal', L: 'leaving', M: 'moving', J: 'joining' })[state[1]] || 'unknown',
      address: match[2],
      load: match[3].trim(),
      tokens: Number(match[4]),
      ownership: match[5] === '?' ? null : Number(match[5].slice(0, -1)),
      hostId: match[6].toLowerCase(),
      rack: match[7].trim()
    });
  }
  if (!nodes.length || nodes.some((node) => !node.dataCenter)) throw new DatabaseAdapterError('CASSANDRA_TOPOLOGY_INVALID', 'nodetool returned no usable cluster topology.', { category: 'integrity' });
  if (nodes.length > 10000) throw new DatabaseAdapterError('CASSANDRA_TOPOLOGY_LIMIT', 'The cluster topology exceeds the discovery limit.', { category: 'capacity' });
  return nodes.sort((left, right) => left.hostId.localeCompare(right.hostId, 'en-US'));
}

function parseRing(output, nodes) {
  const byAddress = new Map(nodes.map((node) => [node.address.replace(/^\//, ''), node]));
  const tokensByHost = new Map(nodes.map((node) => [node.hostId, []]));
  const seenTokens = new Set();
  for (const raw of String(output || '').split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(\S+)\s+(Up|Down)\s+(Normal|Leaving|Joining|Moving)\s+(.+?)\s+(\?|[0-9.]+%)\s+(-?\d{1,80})\s*$/.exec(raw);
    if (!match) continue;
    const address = match[1].replace(/^\//, '');
    const node = byAddress.get(address);
    if (!node) throw new DatabaseAdapterError('CASSANDRA_RING_NODE_UNKNOWN', 'nodetool ring contains a node outside the authenticated topology.', { category: 'integrity' });
    if ((match[3] === 'Up' ? 'up' : 'down') !== node.status || match[4].toLowerCase() !== node.state || match[2] !== node.rack) throw new DatabaseAdapterError('CASSANDRA_RING_NODE_MISMATCH', 'nodetool ring and status disagree on node state or rack.', { category: 'integrity' });
    const token = BigInt(match[7]).toString();
    if (seenTokens.has(token)) throw new DatabaseAdapterError('CASSANDRA_RING_TOKEN_DUPLICATE', 'The token ring contains duplicate ownership boundaries.', { category: 'integrity' });
    seenTokens.add(token);
    tokensByHost.get(node.hostId).push(token);
    if (seenTokens.size > MAX_RING_TOKENS) throw new DatabaseAdapterError('CASSANDRA_RING_LIMIT', 'The token ring exceeds the discovery limit.', { category: 'capacity' });
  }
  if (!seenTokens.size) throw new DatabaseAdapterError('CASSANDRA_RING_INVALID', 'nodetool returned no token ownership evidence.', { category: 'integrity' });
  const nodeCoverage = nodes.filter((node) => node.tokens > 0).map((node) => {
    const tokens = tokensByHost.get(node.hostId).sort((left, right) => {
      const a = BigInt(left); const b = BigInt(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    if (tokens.length !== node.tokens) throw new DatabaseAdapterError('CASSANDRA_RING_TOKEN_COUNT_MISMATCH', 'Token ownership counts do not match the authenticated topology.', { category: 'integrity' });
    return { hostId: node.hostId, address: node.address, dataCenter: node.dataCenter, rack: node.rack, tokenCount: tokens.length, tokenDigest: stableDigest(tokens) };
  }).sort((left, right) => left.hostId.localeCompare(right.hostId, 'en-US'));
  if (nodeCoverage.reduce((sum, node) => sum + node.tokenCount, 0) !== seenTokens.size) throw new DatabaseAdapterError('CASSANDRA_RING_COVERAGE_INCOMPLETE', 'The token ring contains ownership outside the required node set.', { category: 'integrity' });
  return { mode: 'vnode-ring', tokenCount: seenTokens.size, nodeCoverage, ringFingerprint: stableDigest(nodeCoverage.map(({ hostId, tokenCount, tokenDigest }) => ({ hostId, tokenCount, tokenDigest }))) };
}

function clusterInventoryFromDiscovery(page, capturedAt) {
  const coverageByHost = new Map((page.coverage?.nodeCoverage || []).map((node) => [node.hostId, node]));
  const inventory = {
    version: 1,
    capturedAt,
    product: requiredText(page.product, 'Inventory product', 40),
    productVersion: requiredText(page.identity?.version?.text, 'Inventory product version', 100),
    partitioner: requiredText(page.identity?.partitioner, 'Inventory partitioner', 512),
    clusterName: requiredText(page.clusterName, 'Inventory cluster name', 255),
    clusterFingerprint: requiredText(page.clusterFingerprint, 'Inventory cluster fingerprint', 80),
    deploymentFingerprint: requiredText(page.deploymentFingerprint, 'Inventory deployment fingerprint', 80),
    topologyFingerprint: requiredText(page.topologyFingerprint, 'Inventory topology fingerprint', 80),
    schemaVersion: requiredText(page.identity?.schemaVersion, 'Inventory schema version', 100),
    schemaAgreement: page.identity?.schemaAgreement === true,
    incrementalBackupsEnabled: page.identity?.incrementalBackupsEnabled === true,
    localHostId: requiredText(page.identity?.localHostId, 'Inventory local host ID', 100),
    nodes: (page.topology || []).slice(0, 10000).map((node) => {
      const coverage = coverageByHost.get(node.hostId);
      return {
        hostId: node.hostId, address: node.address, dataCenter: node.dataCenter, rack: node.rack,
        status: node.status, state: node.state, tokenCount: coverage?.tokenCount || 0, tokenDigest: coverage?.tokenDigest || null
      };
    }),
    coverage: {
      mode: requiredText(page.coverage?.mode, 'Inventory coverage mode', 40),
      tokenCount: Number(page.coverage?.tokenCount || 0),
      ringFingerprint: requiredText(page.coverage?.ringFingerprint, 'Inventory ring fingerprint', 80)
    },
    keyspaces: (page.keyspaces || []).slice(0, 10000).map(({ name, durableWrites, replication, tabletsEnabled, system }) => ({ name, durableWrites, replication, tabletsEnabled, system })),
    tables: (page.tables || []).slice(0, 10000).map(({ keyspace, name, tableId, system, selectable }) => ({ keyspace, name, tableId, system, selectable })),
    derivedObjects: (page.derivedObjects || []).slice(0, 10000).map(({ kind, keyspace, name, table, baseTableId, objectId, restoreAction }) => ({ kind, keyspace, name, table: table || null, baseTableId: baseTableId || null, objectId: objectId || null, restoreAction }))
  };
  return Object.freeze({ ...inventory, inventoryFingerprint: stableDigest(inventory) });
}

function parseCqlJson(output, label) {
  const rows = [];
  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { throw new DatabaseAdapterError('CASSANDRA_DISCOVERY_INVALID', `${label} discovery returned invalid JSON.`, { category: 'integrity' }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DatabaseAdapterError('CASSANDRA_DISCOVERY_INVALID', `${label} discovery returned an invalid row.`, { category: 'integrity' });
    rows.push(parsed);
    if (rows.length > 10000) throw new DatabaseAdapterError('CASSANDRA_DISCOVERY_LIMIT', `${label} discovery exceeds the item limit.`, { category: 'capacity' });
  }
  return rows;
}

function tabletSetting(value, product, version) {
  if (product !== 'scylladb') return false;
  if (value === undefined || value === null) return version.major === 5 ? false : null;
  let normalized = value;
  if (typeof normalized === 'string') {
    try { normalized = JSON.parse(normalized.replace(/'/g, '"')); }
    catch { return null; }
  }
  if (typeof normalized === 'boolean') return normalized;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return null;
  const enabled = normalized.enabled;
  if (enabled === true || String(enabled).toLowerCase() === 'true') return true;
  if (enabled === false || String(enabled).toLowerCase() === 'false') return false;
  return null;
}

function normalizeKeyspaces(rows, product, version) {
  return rows.map((row) => ({
    kind: 'keyspace',
    name: requiredText(row.keyspace_name, 'Keyspace name', 255),
    durableWrites: row.durable_writes !== false,
    replication: row.replication && typeof row.replication === 'object' && !Array.isArray(row.replication) ? Object.fromEntries(Object.entries(row.replication).map(([key, value]) => [String(key).slice(0, 255), String(value).slice(0, 255)]).sort()) : {},
    tabletsEnabled: tabletSetting(row.tablets, product, version),
    system: /^system(?:_|$)/.test(String(row.keyspace_name))
  })).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
}

function normalizeDerivedObjects(viewRows, indexRows) {
  const views = viewRows.map((row) => ({
    kind: 'materialized-view', keyspace: requiredText(row.keyspace_name, 'Materialized-view keyspace', 255),
    name: requiredText(row.view_name, 'Materialized-view name', 255), baseTableId: optionalText(row.base_table_id, 'Materialized-view base table ID', 100),
    objectId: optionalText(row.id, 'Materialized-view ID', 100), selectable: false, restoreAction: 'rebuild'
  }));
  const indexes = indexRows.map((row) => ({
    kind: 'secondary-index', keyspace: requiredText(row.keyspace_name, 'Secondary-index keyspace', 255),
    name: requiredText(row.index_name, 'Secondary-index name', 255), table: requiredText(row.table_name, 'Secondary-index base table', 255),
    indexKind: optionalText(row.kind, 'Secondary-index kind', 100), selectable: false, restoreAction: 'rebuild'
  }));
  return [...views, ...indexes].sort((left, right) => `${left.keyspace}\0${left.kind}\0${left.name}`.localeCompare(`${right.keyspace}\0${right.kind}\0${right.name}`, 'en-US'));
}

function normalizeTables(rows) {
  return rows.map((row) => ({
    kind: 'table',
    keyspace: requiredText(row.keyspace_name, 'Table keyspace', 255),
    name: requiredText(row.table_name, 'Table name', 255),
    tableId: optionalText(row.id, 'Table ID', 100),
    system: /^system(?:_|$)/.test(String(row.keyspace_name)),
    selectable: !/^system(?:_|$)/.test(String(row.keyspace_name))
  })).sort((left, right) => `${left.keyspace}\0${left.name}`.localeCompare(`${right.keyspace}\0${right.name}`, 'en-US'));
}

function parseSnapshotNames(output) {
  const names = new Set();
  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^-+$/.test(line) || /^Snapshot Details:|^Snapshot name\b|^There are no snapshots|^Total TrueDiskSpaceUsed:/i.test(line)) continue;
    const name = line.split(/\s+/)[0];
    if (/^[A-Za-z0-9._-]{1,255}$/.test(name)) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'en-US')).slice(0, 10000);
}

function parseSchemaVersions(output) {
  const versions = new Set();
  for (const raw of String(output || '').split(/\r?\n/)) {
    const match = /^\s*([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})\s*:\s*\[/.exec(raw);
    if (match) versions.add(match[1].toLowerCase());
  }
  if (!versions.size || versions.size > 100) throw new DatabaseAdapterError('CASSANDRA_SCHEMA_STATUS_INVALID', 'nodetool returned invalid schema-version evidence.', { category: 'integrity' });
  return [...versions].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function cqlArgs(config, cqlshrcPath, statement) {
  return [config.contactHost, String(config.nativePort), ...(cqlshrcPath ? ['--cqlshrc', cqlshrcPath] : []), '--execute', statement];
}

async function readDiscovery(context, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const productIdentity = await detectProduct(context, config);
  const cqlshrcPath = context.cqlshrcPath || null;
  const [nodetoolVersion, cqlshVersion, infoResult, statusResult, ringResult, clusterResult, backupResult, snapshotsResult, localResult, keyspacesResult, tablesResult, viewsResult, indexesResult] = await Promise.all([
    command(context, config, config.nodetoolPath, ['version']),
    command(context, config, config.cqlshPath, ['--version']),
    command(context, config, config.nodetoolPath, ['info']),
    command(context, config, config.nodetoolPath, ['status']),
    command(context, config, config.nodetoolPath, ['ring']),
    command(context, config, config.nodetoolPath, ['describecluster']),
    command(context, config, config.nodetoolPath, ['statusbackup']),
    command(context, config, config.nodetoolPath, ['listsnapshots']),
    command(context, config, config.cqlshPath, cqlArgs(config, cqlshrcPath, 'SELECT JSON cluster_name, data_center, host_id, partitioner, rack, release_version, schema_version FROM system.local;')),
    command(context, config, config.cqlshPath, cqlArgs(config, cqlshrcPath, 'SELECT JSON * FROM system_schema.keyspaces;')),
    command(context, config, config.cqlshPath, cqlArgs(config, cqlshrcPath, 'SELECT JSON id, keyspace_name, table_name FROM system_schema.tables;')),
    command(context, config, config.cqlshPath, cqlArgs(config, cqlshrcPath, 'SELECT JSON * FROM system_schema.views;')),
    command(context, config, config.cqlshPath, cqlArgs(config, cqlshrcPath, 'SELECT JSON * FROM system_schema.indexes;'))
  ]);
  const localRows = parseCqlJson(localResult.stdout, 'Local identity');
  if (localRows.length !== 1) throw new DatabaseAdapterError('CASSANDRA_IDENTITY_INVALID', 'CQL returned an ambiguous local cluster identity.', { category: 'integrity' });
  const local = localRows[0];
  const clusterName = requiredText(local.cluster_name, 'Cluster name', 255);
  const partitioner = requiredText(local.partitioner, 'Partitioner', 512);
  const schemaVersion = requiredText(local.schema_version, 'Schema version', 100).toLowerCase();
  const schemaVersions = parseSchemaVersions(clusterResult.stdout);
  const localHostId = requiredText(local.host_id, 'Local host ID', 100).toLowerCase();
  const nodes = parseStatus(statusResult.stdout);
  if (!nodes.some((node) => node.hostId === localHostId)) throw new DatabaseAdapterError('CASSANDRA_LOCAL_NODE_MISSING', 'The local node is missing from the discovered topology.', { category: 'integrity' });
  const info = parseInfo(infoResult.stdout);
  if (info['cluster-name'] && info['cluster-name'] !== clusterName) throw new DatabaseAdapterError('CASSANDRA_CLUSTER_NAME_MISMATCH', 'nodetool and CQL returned different cluster names.', { category: 'integrity' });
  if (!/Murmur3Partitioner$/.test(partitioner)) throw new DatabaseAdapterError('CASSANDRA_PARTITIONER_UNSUPPORTED', 'Source enrollment currently requires the Murmur3 partitioner.', { category: 'compatibility' });
  const coverage = parseRing(ringResult.stdout, nodes);
  const topologyFingerprint = stableDigest({ partitioner, nodes: nodes.map(({ hostId, dataCenter, rack, address, status, state, tokens }) => ({ hostId, dataCenter, rack, address, status, state, tokens })), ringFingerprint: coverage.ringFingerprint });
  const clusterFingerprint = stableDigest({ product: productIdentity.product, clusterName, partitioner });
  const deploymentFingerprint = stableDigest({ product: productIdentity.product, clusterName, partitioner, localHostId });
  if (config.expectedProduct !== 'auto' && config.expectedProduct !== productIdentity.product) throw new DatabaseAdapterError('CASSANDRA_PRODUCT_MISMATCH', 'The detected database product does not match the approved connection.', { category: 'integrity' });
  if (config.expectedClusterName && config.expectedClusterName !== clusterName) throw new DatabaseAdapterError('CASSANDRA_CLUSTER_IDENTITY_CHANGED', 'The cluster name no longer matches the approved connection.', { category: 'integrity' });
  if (config.expectedDeploymentFingerprint && config.expectedDeploymentFingerprint !== deploymentFingerprint) throw new DatabaseAdapterError('CASSANDRA_CLUSTER_IDENTITY_CHANGED', 'The database deployment identity changed.', { category: 'integrity' });
  if (config.expectedTopologyFingerprint && config.expectedTopologyFingerprint !== topologyFingerprint) throw new DatabaseAdapterError('CASSANDRA_TOPOLOGY_CHANGED', 'The database topology changed and must be approved again.', { category: 'integrity' });
  return {
    product: productIdentity.product,
    version: productIdentity.version,
    compatibilityVersion: nodetoolVersion.stdout.trim().slice(0, 200),
    cqlshVersion: cqlshVersion.stdout.trim().slice(0, 200),
    clusterName,
    partitioner,
    schemaVersion,
    schemaVersions,
    schemaAgreement: schemaVersions.length === 1 && schemaVersions[0] === schemaVersion,
    localHostId,
    localDataCenter: optionalText(local.data_center, 'Local data center', 255),
    localRack: optionalText(local.rack, 'Local rack', 255),
    deploymentFingerprint,
    clusterFingerprint,
    topologyFingerprint,
    nodes,
    coverage,
    keyspaces: normalizeKeyspaces(parseCqlJson(keyspacesResult.stdout, 'Keyspace'), productIdentity.product, productIdentity.version),
    tables: normalizeTables(parseCqlJson(tablesResult.stdout, 'Table')),
    derivedObjects: normalizeDerivedObjects(parseCqlJson(viewsResult.stdout, 'Materialized view'), parseCqlJson(indexesResult.stdout, 'Secondary index')),
    incrementalBackupsEnabled: /^running\.?$/i.test(backupResult.stdout.trim()),
    snapshots: parseSnapshotNames(snapshotsResult.stdout),
    nativeTransportActive: String(info['native-transport-active'] || '').toLowerCase() === 'true',
    gossipActive: String(info['gossip-active'] || '').toLowerCase() === 'true'
  };
}

function safeAdapterError(error) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error?.name === 'AbortError') return new DatabaseAdapterError('CASSANDRA_COMMAND_CANCELED', 'Cassandra/Scylla discovery was canceled.', { category: 'canceled' });
  return new DatabaseAdapterError('CASSANDRA_DISCOVERY_FAILED', 'DeployerX could not complete Cassandra/Scylla discovery.', { category: 'connectivity', retryable: true });
}

class CassandraScyllaAdapter {
  constructor({ clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    this.clock = clock;
    this.now = now;
  }

  manifest() {
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      displayName: 'Apache Cassandra / ScyllaDB',
      engine: 'cassandra-scylla',
      executionReady: true,
      sourceEnrollmentReady: true,
      serverVersionRange: 'Apache Cassandra 4.0-5.x; supported ScyllaDB 5.4/6.x and 2024.1+',
      restoreVersionRange: 'Authenticated offline bundles and same-product, same-major alternate clusters',
      capabilities: {
        backupMethods: ['physical'],
        backupModes: ['full', 'incremental', 'native'],
        selection: { database: true, schema: false, table: true, globalObjects: false },
        consistencyStrategies: [{ id: 'cassandra-native-snapshot', produces: 'crash', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: true }],
        transactionLogs: { supported: true, type: 'cassandra-commit-log', pointInTimeRecovery: true, granularitySeconds: 1, supportedProducts: ['cassandra'] },
        streaming: { backup: true, restore: true, compression: false, encryption: false },
        restore: { alternateTarget: true, offlineBundle: true, originalTarget: false, nativeValidation: true },
        replicaAware: true
      },
      requiredTools: [
        { name: 'nodetool', versionRange: 'Product-compatible', operations: ['discovery', 'backup'] },
        { name: 'cqlsh', versionRange: 'Product-compatible', operations: ['discovery', 'backup', 'restore'] },
        { name: 'sstableloader', versionRange: 'Same product major as protected SSTables', operations: ['restore'] },
        { name: 'cassandra or scylla', versionRange: 'Supported server release', operations: ['discovery', 'backup'] },
        { name: 'find, cat, sha256sum, date', versionRange: 'GNU-compatible', operations: ['backup'] }
      ],
      requiredPrivileges: [
        { id: 'cassandra-native-discovery', operations: ['discovery'], required: true, safeDescription: 'Read cluster identity, topology, schema, snapshot, and incremental-backup state.' },
        { id: 'cassandra-native-snapshot', operations: ['backup'], required: true, safeDescription: 'Create and clear exact owned native snapshot tags and read immutable snapshot files beneath approved data roots.' },
        { id: 'cassandra-commit-log-archive', operations: ['backup'], required: false, safeDescription: 'Read an operator-approved, ownership-marked Cassandra commit-log archive and its inactive restore configuration.' },
        { id: 'cassandra-alternate-restore', operations: ['restore'], required: false, safeDescription: 'Create selected schema on a separate empty cluster, stage authenticated SSTables, run native loading and repair, and remove only exact owned staging files.' }
      ]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }

  validateConfig(input) {
    try { normalizeConfig(input); return []; }
    catch (error) { return [{ path: '', code: 'CASSANDRA_CONFIG_INVALID', severity: 'error', message: error.message }]; }
  }

  async testConnection(context = {}, input = {}) {
    const started = this.now();
    const testedAt = this.clock();
    try {
      const discovery = await readDiscovery(context, input);
      const unhealthyNodes = discovery.nodes.filter((node) => node.status !== 'up' || node.state !== 'normal');
      return normalizeConnectionTestResult({
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        testedAt,
        latencyMs: Math.max(0, this.now() - started),
        status: 'success',
        checks: [
          { id: 'product-version', status: 'pass', safeMessage: `${discovery.product === 'cassandra' ? 'Apache Cassandra' : 'ScyllaDB'} ${discovery.version.text} is supported.` },
          { id: 'native-tools', status: 'pass', safeMessage: 'Product-compatible nodetool and cqlsh probes succeeded.' },
          { id: 'cluster-identity', status: 'pass', safeMessage: 'Cluster, partitioner, schema, and local host identity were verified.' },
          { id: 'schema-agreement', status: discovery.schemaAgreement ? 'pass' : 'warning', safeMessage: discovery.schemaAgreement ? 'All reported nodes agree on one schema version.' : 'The cluster reports multiple or mismatched schema versions.' },
          { id: 'topology', status: unhealthyNodes.length ? 'warning' : 'pass', safeMessage: unhealthyNodes.length ? `${unhealthyNodes.length} cluster node(s) are not up and normal.` : 'All discovered cluster nodes are up and normal.' },
          { id: 'incremental-backups', status: discovery.incrementalBackupsEnabled ? 'pass' : 'warning', safeMessage: discovery.incrementalBackupsEnabled ? 'Incremental backups are enabled on this node.' : 'Incremental backups are disabled on this node.' }
        ],
        remotePlatform: { engine: discovery.product, version: discovery.version.text, distribution: discovery.product === 'cassandra' ? 'Apache Cassandra' : 'ScyllaDB', platform: null },
        endpointIdentity: {
          product: discovery.product,
          version: discovery.version.text,
          clusterName: discovery.clusterName,
          partitioner: discovery.partitioner,
          schemaVersion: discovery.schemaVersion,
          localHostId: discovery.localHostId,
          deploymentFingerprint: discovery.deploymentFingerprint,
          clusterFingerprint: discovery.clusterFingerprint,
          topologyFingerprint: discovery.topologyFingerprint,
          nodeCount: discovery.nodes.length,
          schemaAgreement: discovery.schemaAgreement,
          incrementalBackupsEnabled: discovery.incrementalBackupsEnabled
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
    if (!DISCOVERY_KINDS.has(kind)) throw new DatabaseAdapterError('CASSANDRA_DISCOVERY_KIND_UNSUPPORTED', 'Cassandra/Scylla discovery kind is unsupported.', { category: 'compatibility' });
    const discovery = await readDiscovery(context, request.connection);
    const common = { nextCursor: null, product: discovery.product, clusterName: discovery.clusterName, deploymentFingerprint: discovery.deploymentFingerprint, clusterFingerprint: discovery.clusterFingerprint, topologyFingerprint: discovery.topologyFingerprint };
    if (kind === 'topology') yield { ...common, items: discovery.nodes };
    else if (kind === 'keyspaces') yield { ...common, items: discovery.keyspaces };
    else if (kind === 'tables') yield { ...common, items: discovery.tables };
    else if (kind === 'snapshots') yield { ...common, items: discovery.snapshots.map((name) => ({ kind: 'native-snapshot', name })) };
    else yield { ...common, items: [], identity: { product: discovery.product, version: discovery.version, clusterName: discovery.clusterName, partitioner: discovery.partitioner, schemaVersion: discovery.schemaVersion, schemaVersions: discovery.schemaVersions, schemaAgreement: discovery.schemaAgreement, localHostId: discovery.localHostId, incrementalBackupsEnabled: discovery.incrementalBackupsEnabled, nativeTransportActive: discovery.nativeTransportActive, gossipActive: discovery.gossipActive }, topology: discovery.nodes, coverage: discovery.coverage, keyspaces: discovery.keyspaces, tables: discovery.tables, derivedObjects: discovery.derivedObjects, snapshots: discovery.snapshots };
  }

  #backupRequest(request = {}) {
    const source = request.source;
    const execution = source?.physicalExecution || request.physicalExecution;
    const consistency = request.consistency || source?.consistency;
    if (!execution || execution.engine !== 'cassandra-scylla' || execution.topology !== 'cluster' || consistency?.backupMethod !== 'physical' || !['full', 'incremental', 'native'].includes(consistency?.backupMode)) throw new DatabaseAdapterError('CASSANDRA_BACKUP_REQUEST_INVALID', 'Cassandra/Scylla backup requires a complete enrolled physical cluster and a supported mode.', { category: 'validation' });
    if (consistency.backupMode === 'native' && (execution.product !== 'cassandra' || execution.commitLogPitrEnabled !== true || !execution.nodes?.every((node) => Boolean(node.commitLogArchive)))) throw new DatabaseAdapterError('CASSANDRA_COMMIT_LOG_NOT_ENROLLED', 'Cassandra native mode requires complete per-node commit-log archive enrollment.', { category: 'validation' });
    return { source, execution, consistency };
  }

  async preflight(context = {}, request = {}) {
    const validated = this.#backupRequest(request);
    if (typeof context.preflightCassandraCluster !== 'function') throw new DatabaseAdapterError('CASSANDRA_BACKUP_ORCHESTRATOR_REQUIRED', 'Cassandra/Scylla backup preflight requires the coordinated cluster executor.', { category: 'compatibility' });
    return context.preflightCassandraCluster({ ...request, ...validated });
  }

  async planBackup(_context = {}, request = {}) {
    const validated = this.#backupRequest(request);
    if (request.consistency?.proven !== true || request.consistency?.method !== 'cassandra-native-snapshot' || request.consistency?.achievedLevel !== 'crash') throw new DatabaseAdapterError('CASSANDRA_CONSISTENCY_PLAN_INVALID', 'Cassandra/Scylla full backup requires a proven coordinated native-snapshot preflight.', { category: 'consistency' });
    const incremental = request.consistency.backupMode === 'incremental';
    const commitLog = request.consistency.backupMode === 'native';
    return {
      version: 1, operation: commitLog ? 'cassandra-commit-log' : incremental ? 'cassandra-scylla-native-incremental' : 'cassandra-scylla-native-full', sourceId: validated.source?.id || null,
      physicalExecution: validated.execution, consistency: request.consistency,
      artifacts: { nodePrefix: 'cassandra-scylla/nodes', schemaPath: 'cassandra-scylla/schema/schema.cql', clusterManifestPath: 'cassandra-scylla/cluster-manifest.json' },
      resumable: false
    };
  }

  async executeBackup(context = {}, plan = {}, sink) {
    if (!['cassandra-scylla-native-full', 'cassandra-scylla-native-incremental', 'cassandra-commit-log'].includes(plan.operation) || !plan.physicalExecution || plan.consistency?.proven !== true) throw new DatabaseAdapterError('CASSANDRA_BACKUP_PLAN_INVALID', 'The Cassandra/Scylla coordinated backup plan is invalid.', { category: 'integrity' });
    if (typeof context.executeCassandraClusterBackup !== 'function') throw new DatabaseAdapterError('CASSANDRA_BACKUP_ORCHESTRATOR_REQUIRED', 'Cassandra/Scylla backup execution requires the coordinated cluster executor.', { category: 'compatibility' });
    return context.executeCassandraClusterBackup(plan, sink);
  }

  #restoreNotReady() {
    throw new DatabaseAdapterError('CASSANDRA_RESTORE_NOT_READY', 'Cassandra/Scylla restore remains unavailable until alternate-cluster recovery is implemented.', { category: 'compatibility' });
  }

  async planRestore(context = {}, request = {}) {
    if (request.operation === 'cassandra-commit-log-offline-plan') return planCassandraCommitLogRestore(request);
    if (['cassandra-scylla-offline-bundle', 'cassandra-scylla-alternate-cluster'].includes(request.operation) && typeof context.planCassandraScyllaRestore === 'function') return context.planCassandraScyllaRestore(request);
    return this.#restoreNotReady();
  }
  async executeRestore(context = {}, plan = {}) {
    if (!['cassandra-scylla-offline-bundle', 'cassandra-scylla-alternate-cluster'].includes(plan.operation) || typeof context.executeCassandraScyllaRestore !== 'function') return this.#restoreNotReady();
    return context.executeCassandraScyllaRestore(plan);
  }
  async validateRestore(context = {}, result = {}) {
    if (typeof context.validateCassandraScyllaRestore !== 'function') return this.#restoreNotReady();
    return context.validateCassandraScyllaRestore(result);
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

function cqlshrcContents(username, password) {
  const user = requiredText(username, 'CQL username', 256);
  const secret = requiredText(password, 'CQL password', 16384);
  if (/[\r\n]/.test(user) || /[\r\n]/.test(secret)) throw new TypeError('CQL credentials cannot contain line breaks.');
  return `[authentication]\nusername = ${user}\npassword = ${secret}\n`;
}

class CassandraScyllaConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new CassandraScyllaAdapter(), sessionFactory = openSshExecutionSession, localCommandRunner = runLocalCommand } = {}) {
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
    const name = requiredText(input.name, 'Cassandra/Scylla connection name', 200);
    const username = optionalText(input.cqlUsername, 'CQL username', 256);
    const password = input.cqlPassword === undefined || input.cqlPassword === null || input.cqlPassword === '' ? null : requiredText(input.cqlPassword, 'CQL password', 16384);
    if (Boolean(username) !== Boolean(password)) throw new TypeError('CQL authentication requires both username and password.');
    let passwordRef = null;
    try {
      if (password) passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} CQL password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({
        expectedProduct: input.expectedProduct, executionMode: input.executionMode, sshConnectionId: input.sshConnectionId,
        contactHost: input.contactHost, nativePort: input.nativePort, cqlUsername: username, cqlPasswordSecretRefId: passwordRef?.id,
        nodetoolPath: input.nodetoolPath, cqlshPath: input.cqlshPath, sstableloaderPath: input.sstableloaderPath, cassandraPath: input.cassandraPath, scyllaPath: input.scyllaPath,
        timeoutMs: input.timeoutMs, expectedClusterName: input.expectedClusterName
      });
      if (config.executionMode === 'ssh') await this.#validatedSshConnection(tenant, config.sshConnectionId);
      const { cqlPasswordSecretRefId: _secretRefId, ...endpoint } = config;
      return await this.controlDatabase.transaction((transaction) => {
        if (passwordRef) transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device',
          endpoint,
          secretRefIds: passwordRef ? [passwordRef.id] : [],
          trust: { mode: config.executionMode, fingerprint: null },
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
    return normalizeConfig({ ...connection.endpoint, cqlPasswordSecretRefId: connection.secretRefIds?.[0] || null });
  }

  async #validatedSshConnection(workspaceId, connectionId) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, connectionId);
    if (!connection || connection.adapterId !== 'deployerx.connection.ssh') throw new Error('The paired SSH connection was not found.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('The paired SSH connection belongs to another device.');
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new Error('Test and approve the paired SSH connection before Cassandra/Scylla discovery.');
    return connection;
  }

  async #withExecution(workspaceId, connection, signal, callback) {
    const config = this.config(connection);
    let session = null;
    let localDirectory = null;
    let cqlshrcPath = null;
    try {
      if (config.executionMode === 'ssh') {
        const sshConnection = await this.#validatedSshConnection(workspaceId, config.sshConnectionId);
        session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal });
      }
      if (config.cqlPasswordSecretRefId) {
        const password = await this.secretStore.resolve({ workspaceId, id: config.cqlPasswordSecretRefId });
        const contents = cqlshrcContents(config.cqlUsername, password);
        if (session) {
          cqlshrcPath = `/tmp/deployerx-cql-${crypto.randomBytes(16).toString('hex')}.rc`;
          await session.writeFile(cqlshrcPath, contents, { mode: 0o600 });
        } else {
          localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cql-'));
          cqlshrcPath = path.join(localDirectory, 'cqlshrc');
          await fs.writeFile(cqlshrcPath, contents, { mode: 0o600, flag: 'wx' });
        }
      }
      const context = {
        signal,
        cqlshrcPath,
        runNativeCommand: session
          ? ({ executable, args, timeoutMs }) => new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (error) reject(error);
              else resolve(value);
            };
            const timer = setTimeout(() => {
              session.close();
              finish(new DatabaseAdapterError('CASSANDRA_COMMAND_TIMEOUT', 'A Cassandra/Scylla native command timed out.', { category: 'timeout', retryable: true }));
            }, timeoutMs);
            session.run(commandFromArgs(executable, args), { stdoutLimitBytes: MAX_OUTPUT_BYTES, stderrLimitBytes: MAX_OUTPUT_BYTES }).then((value) => finish(null, value), (error) => finish(error));
          })
          : this.localCommandRunner
      };
      return await callback(context, config);
    } finally {
      let cleanupFailed = false;
      if (session && cqlshrcPath) {
        try { await session.run(commandFromArgs('rm', ['-f', '--', cqlshrcPath]), { ignoreAbort: true }); }
        catch { cleanupFailed = true; }
      }
      session?.close();
      if (localDirectory) {
        try { await fs.rm(localDirectory, { recursive: true, force: true }); }
        catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw new DatabaseAdapterError('CASSANDRA_CREDENTIAL_CLEANUP_FAILED', 'Temporary CQL credential cleanup could not be proven.', { category: 'integrity' });
    }
  }

  async test(workspaceId, connectionId, actorId = 'system', signal) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Cassandra/Scylla connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This Cassandra/Scylla connection belongs to another device.');
    const tested = await this.#withExecution(tenant, current, signal, async (context, config) => {
      const result = await this.adapter.testConnection(context, config);
      if (result.status !== 'success') return { result, clusterInventory: null };
      const pages = [];
      for await (const page of this.adapter.discover(context, { connection: config, kind: 'all' })) pages.push(page);
      if (pages.length !== 1) throw new DatabaseAdapterError('CASSANDRA_INVENTORY_INVALID', 'Cassandra/Scylla cluster inventory was incomplete.', { category: 'integrity' });
      if (pages[0].deploymentFingerprint !== result.endpointIdentity.deploymentFingerprint || pages[0].clusterFingerprint !== result.endpointIdentity.clusterFingerprint || pages[0].topologyFingerprint !== result.endpointIdentity.topologyFingerprint || pages[0].identity?.schemaVersion !== result.endpointIdentity.schemaVersion) throw new DatabaseAdapterError('CASSANDRA_INVENTORY_CHANGED', 'Cassandra/Scylla identity changed while cluster inventory was being captured.', { category: 'integrity' });
      return { result, clusterInventory: clusterInventoryFromDiscovery(pages[0], result.testedAt) };
    });
    const { result, clusterInventory } = tested;
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const endpoint = result.status === 'success' ? { ...current.endpoint, expectedProduct: result.endpointIdentity.product, expectedClusterName: result.endpointIdentity.clusterName, expectedDeploymentFingerprint: result.endpointIdentity.deploymentFingerprint, expectedTopologyFingerprint: result.endpointIdentity.topologyFingerprint } : current.endpoint;
    const trust = result.status === 'success' ? { mode: current.endpoint.executionMode, fingerprint: result.endpointIdentity.deploymentFingerprint, topologyFingerprint: result.endpointIdentity.topologyFingerprint, observedAt: result.testedAt } : current.trust;
    const updated = await this.controlDatabase.repository('connection').update(tenant, id, { endpoint, lastTest: result, trust, clusterInventory: clusterInventory || current.clusterInventory || null, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection: updated, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Cassandra/Scylla connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This Cassandra/Scylla connection belongs to another device.');
    if (current.lastTest?.status !== 'success') throw new Error('Test the Cassandra/Scylla connection successfully before discovery.');
    return this.#withExecution(tenant, current, input.signal, async (context, config) => {
      const pages = [];
      for await (const page of this.adapter.discover(context, { connection: config, kind: input.kind })) pages.push(page);
      return pages[0] || { items: [], nextCursor: null };
    });
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  CassandraScyllaAdapter,
  CassandraScyllaConnectionService,
  cqlshrcContents,
  extractVersion,
  normalizeConfig,
  parseRing,
  parseCqlJson,
  parseInfo,
  parseSchemaVersions,
  parseSnapshotNames,
  parseStatus,
  readDiscovery,
  runLocalCommand,
  stableDigest,
  clusterInventoryFromDiscovery
};
