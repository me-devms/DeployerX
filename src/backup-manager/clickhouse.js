const crypto = require('crypto');
const fs = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { DatabaseAdapterError } = require('./database-adapter');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');

const ADAPTER_ID = 'deployerx.database.clickhouse';
const ADAPTER_VERSION = '0.4.0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 10000;
const EXECUTION_MODES = new Set(['local', 'ssh']);
const TLS_MODES = new Set(['disabled', 'required']);
const DISCOVERY_KINDS = new Set(['all', 'databases', 'tables', 'topology', 'storage']);
const BACKUP_EXECUTION_MODES = new Set(['synchronous', 'asynchronous']);
const SUPPORTED_TABLE_ENGINES = new Set(['MergeTree', 'ReplacingMergeTree', 'SummingMergeTree', 'AggregatingMergeTree', 'CollapsingMergeTree', 'VersionedCollapsingMergeTree', 'GraphiteMergeTree', 'Log', 'TinyLog', 'StripeLog', 'View', 'MaterializedView', 'Dictionary']);
const MAX_BACKUP_WAIT_MS = 24 * 60 * 60 * 1000;
const MAX_INCREMENTAL_CHAIN_LENGTH = 1000;
const MAX_RESTORE_TABLES = 500;
const DESTINATION_CONFIRMATION = 'USE CLICKHOUSE BACKUP DISK';
const RESTORE_CONFIRMATION = 'RESTORE CLICKHOUSE ALTERNATE';

const QUERIES = Object.freeze({
  identity: 'SELECT version() AS version, timezone() AS timezone, hostName() AS host_name, currentUser() AS current_user FORMAT JSONEachRow',
  databases: "SELECT name, toString(uuid) AS uuid, engine, data_path FROM system.databases WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') ORDER BY name FORMAT JSONEachRow",
  tables: "SELECT database, name, toString(uuid) AS uuid, engine, is_temporary FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') ORDER BY database, name FORMAT JSONEachRow",
  clusters: 'SELECT cluster, shard_num, shard_weight, replica_num, host_name, host_address, port, is_local, errors_count, estimated_recovery_time FROM system.clusters ORDER BY cluster, shard_num, replica_num FORMAT JSONEachRow',
  replicas: "SELECT database, table, zookeeper_path, replica_name, is_readonly, is_session_expired, future_parts, queue_size, absolute_delay, total_replicas, active_replicas FROM system.replicas WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') ORDER BY database, table FORMAT JSONEachRow",
  partitions: "SELECT database, table, partition, count() AS part_count, sum(rows) AS row_count, sum(bytes_on_disk) AS bytes_on_disk FROM system.parts WHERE active AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') GROUP BY database, table, partition ORDER BY database, table, partition FORMAT JSONEachRow",
  disks: 'SELECT name, type, path, free_space, total_space, keep_free_space, is_read_only, is_write_once FROM system.disks ORDER BY name FORMAT JSONEachRow',
  namedCollections: 'SELECT DISTINCT name FROM system.named_collections ORDER BY name FORMAT JSONEachRow',
  grants: 'SELECT access_type, database, table FROM system.grants WHERE user_name = currentUser() ORDER BY access_type, database, table FORMAT JSONEachRow',
  backups: 'SELECT count() AS row_count FROM system.backups FORMAT JSONEachRow'
});

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

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError('ClickHouse command timeout must be between 1 and 300 seconds.');
  return timeoutMs;
}

function normalizeExecutable(value) {
  const executable = optionalText(value, 'clickhouse-client path', 1024) || 'clickhouse-client';
  if (executable.startsWith('/')) {
    if (!/^\/[A-Za-z0-9._+/-]+$/.test(executable) || executable.includes('..')) throw new TypeError('clickhouse-client path is invalid.');
    return executable.replace(/\/{2,}/g, '/');
  }
  if (path.isAbsolute(executable)) return path.normalize(executable);
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) throw new TypeError('clickhouse-client path must be an absolute path or executable name.');
  return executable;
}

function normalizeHost(value) {
  const host = optionalText(value, 'ClickHouse host', 253) || '127.0.0.1';
  if (net.isIP(host)) return host.toLowerCase();
  const normalized = host.toLowerCase();
  if (normalized.includes('..') || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(normalized)) throw new TypeError('ClickHouse host is invalid.');
  return normalized;
}

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ClickHouse connection configuration must be an object.');
  const allowed = ['executionMode', 'sshConnectionId', 'host', 'port', 'tlsMode', 'username', 'passwordSecretRefId', 'clientPath', 'timeoutMs', 'expectedVersion', 'expectedDeploymentFingerprint', 'expectedTopologyFingerprint'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown ClickHouse connection field: ${unknown[0]}.`);
  const executionMode = String(input.executionMode || 'ssh').toLowerCase();
  if (!EXECUTION_MODES.has(executionMode)) throw new TypeError('ClickHouse execution mode is invalid.');
  const sshConnectionId = optionalText(input.sshConnectionId, 'SSH connection ID', 200);
  if (executionMode === 'ssh' && !sshConnectionId) throw new TypeError('SSH execution requires a saved SSH connection.');
  if (executionMode === 'local' && sshConnectionId) throw new TypeError('Local execution cannot include an SSH connection.');
  const tlsMode = String(input.tlsMode || 'required').toLowerCase();
  if (!TLS_MODES.has(tlsMode)) throw new TypeError('ClickHouse TLS mode is invalid.');
  const port = Number(input.port ?? (tlsMode === 'required' ? 9440 : 9000));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('ClickHouse native port is invalid.');
  return {
    executionMode,
    sshConnectionId,
    host: normalizeHost(input.host),
    port,
    tlsMode,
    username: optionalText(input.username, 'ClickHouse username', 256) || 'default',
    passwordSecretRefId: optionalText(input.passwordSecretRefId, 'ClickHouse password SecretRef ID', 200),
    clientPath: normalizeExecutable(input.clientPath),
    timeoutMs: normalizeTimeout(input.timeoutMs),
    expectedVersion: optionalText(input.expectedVersion, 'Expected ClickHouse version', 100),
    expectedDeploymentFingerprint: optionalText(input.expectedDeploymentFingerprint, 'Expected ClickHouse deployment fingerprint', 80),
    expectedTopologyFingerprint: optionalText(input.expectedTopologyFingerprint, 'Expected ClickHouse topology fingerprint', 80)
  };
}

function parseVersion(value) {
  const match = /(?:^|\s)(\d{2})\.(\d{1,2})\.(\d{1,3})(?:\.(\d+))?(?:\s|$)/.exec(String(value || '').trim());
  if (!match) throw new DatabaseAdapterError('CLICKHOUSE_VERSION_INVALID', 'ClickHouse returned an invalid server version.', { category: 'compatibility' });
  const version = { text: [match[1], match[2], match[3], match[4]].filter((item) => item !== undefined).join('.'), major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), revision: match[4] === undefined ? null : Number(match[4]) };
  if (version.major < 23 || version.major > 26) throw new DatabaseAdapterError('CLICKHOUSE_VERSION_UNSUPPORTED', 'ClickHouse 23.x through 26.x self-managed releases are supported for discovery.', { category: 'compatibility' });
  return Object.freeze(version);
}

function parseJsonRows(output, label) {
  const text = String(output || '');
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new DatabaseAdapterError('CLICKHOUSE_OUTPUT_LIMIT', `${label} exceeded the bounded output limit.`, { category: 'capacity' });
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > MAX_ROWS) throw new DatabaseAdapterError('CLICKHOUSE_ROW_LIMIT', `${label} returned too many rows.`, { category: 'capacity' });
  return lines.map((line) => {
    let row;
    try { row = JSON.parse(line); }
    catch { throw new DatabaseAdapterError('CLICKHOUSE_OUTPUT_INVALID', `${label} returned malformed JSON.`, { category: 'integrity' }); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new DatabaseAdapterError('CLICKHOUSE_OUTPUT_INVALID', `${label} returned an invalid row.`, { category: 'integrity' });
    return row;
  });
}

function boundedName(value, label, maximumLength = 512) {
  return requiredText(value, label, maximumLength);
}

function boundedInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new DatabaseAdapterError('CLICKHOUSE_OUTPUT_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return number;
}

function normalizeUuid(value, label) {
  const uuid = requiredText(value, label, 40).toLowerCase();
  if (!/^(?:00000000-0000-0000-0000-000000000000|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(uuid)) throw new DatabaseAdapterError('CLICKHOUSE_UUID_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return uuid;
}

function xmlEscape(value, label) {
  const text = String(value ?? '');
  if (text.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text) || text.length > 16384) throw new TypeError(`${label} is invalid.`);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function clientConfigContents(config, password = null) {
  return `<config>\n  <host>${xmlEscape(config.host, 'ClickHouse host')}</host>\n  <port>${config.port}</port>\n  <secure>${config.tlsMode === 'required' ? '1' : '0'}</secure>\n  <user>${xmlEscape(config.username, 'ClickHouse username')}</user>\n${password === null ? '' : `  <password>${xmlEscape(password, 'ClickHouse password')}</password>\n`}  <send_logs_level>none</send_logs_level>\n</config>\n`;
}

function normalizeBaseBackup(input) {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ClickHouse incremental base backup is invalid.');
  const allowed = ['version', 'operationId', 'relativePath', 'parentRecoveryPointId', 'chainRootRecoveryPointId', 'ancestorRecoveryPointIds', 'selectionDigest', 'destinationFingerprint', 'deploymentFingerprint', 'topologyFingerprint', 'metadataDigest'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown ClickHouse incremental base field: ${unknown[0]}.`);
  const operationId = requiredText(input.operationId, 'ClickHouse base operation ID', 200);
  if (!/^deployerx-[0-9a-f]{32}$/.test(operationId)) throw new TypeError('ClickHouse base operation ID is invalid.');
  const relativePath = requiredText(input.relativePath, 'ClickHouse base relative path', 512);
  if (!/^deployerx\/[0-9a-f]{16}\/deployerx-[0-9a-f]{32}[.]zip$/.test(relativePath) || !relativePath.endsWith(`${operationId}.zip`)) throw new TypeError('ClickHouse base relative path is invalid.');
  const parentRecoveryPointId = requiredText(input.parentRecoveryPointId, 'ClickHouse base RecoveryPoint ID', 200);
  const chainRootRecoveryPointId = requiredText(input.chainRootRecoveryPointId, 'ClickHouse chain-root RecoveryPoint ID', 200);
  const ancestorRecoveryPointIds = Array.isArray(input.ancestorRecoveryPointIds) ? input.ancestorRecoveryPointIds.map((id) => requiredText(id, 'ClickHouse ancestor RecoveryPoint ID', 200)) : [];
  if (!ancestorRecoveryPointIds.length || ancestorRecoveryPointIds.length > MAX_INCREMENTAL_CHAIN_LENGTH || new Set(ancestorRecoveryPointIds).size !== ancestorRecoveryPointIds.length || ancestorRecoveryPointIds[0] !== chainRootRecoveryPointId || ancestorRecoveryPointIds.at(-1) !== parentRecoveryPointId) throw new TypeError('ClickHouse incremental ancestor chain is invalid.');
  const digest = (value, label) => {
    const normalized = requiredText(value, label, 80);
    if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new TypeError(`${label} is invalid.`);
    return normalized;
  };
  const selectionDigest = requiredText(input.selectionDigest, 'ClickHouse base selection digest', 80);
  if (!/^[0-9a-f]{64}$/.test(selectionDigest)) throw new TypeError('ClickHouse base selection digest is invalid.');
  return Object.freeze({
    version: 1, operationId, relativePath, parentRecoveryPointId, chainRootRecoveryPointId, ancestorRecoveryPointIds,
    selectionDigest, destinationFingerprint: digest(input.destinationFingerprint, 'ClickHouse base destination fingerprint'),
    deploymentFingerprint: digest(input.deploymentFingerprint, 'ClickHouse base deployment fingerprint'),
    topologyFingerprint: digest(input.topologyFingerprint, 'ClickHouse base topology fingerprint'),
    metadataDigest: digest(input.metadataDigest, 'ClickHouse base metadata digest')
  });
}

function normalizeBackupExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ClickHouse native backup execution settings are required.');
  const allowed = ['version', 'engine', 'destinationType', 'diskName', 'destinationFingerprint', 'executionMode', 'executionId', 'sourceId', 'workspaceId', 'jobId', 'baseBackup', 'approvedAt', 'deploymentFingerprint', 'topologyFingerprint', 'connectionRevision'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown ClickHouse backup execution field: ${unknown[0]}.`);
  const destinationType = String(input.destinationType || 'disk').toLowerCase();
  if (destinationType !== 'disk') throw new TypeError('This ClickHouse slice supports configured Disk destinations only.');
  const diskName = requiredText(input.diskName, 'ClickHouse backup disk name', 255);
  const destinationFingerprint = requiredText(input.destinationFingerprint, 'ClickHouse backup destination fingerprint', 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(destinationFingerprint)) throw new TypeError('ClickHouse backup destination fingerprint is invalid.');
  const executionMode = String(input.executionMode || 'asynchronous').toLowerCase();
  if (!BACKUP_EXECUTION_MODES.has(executionMode)) throw new TypeError('ClickHouse backup execution mode is invalid.');
  return Object.freeze({ version: 1, engine: 'clickhouse', destinationType, diskName, destinationFingerprint, executionMode, baseBackup: normalizeBaseBackup(input.baseBackup) });
}

function destinationFingerprint(disk) {
  return stableDigest({ name: disk.name, type: disk.type, path: disk.path, totalBytes: disk.totalBytes, readOnly: disk.readOnly, writeOnce: disk.writeOnce });
}

function quoteIdentifier(value) {
  return `\`${requiredText(value, 'ClickHouse identifier', 512).replace(/`/g, '``')}\``;
}

function quoteString(value) {
  const text = requiredText(value, 'ClickHouse string literal', 4096);
  if (/[\r\n]/.test(text)) throw new TypeError('ClickHouse string literal is invalid.');
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function selectedObjects(selector = {}, discovery) {
  const databaseRules = selector.databases || {};
  const tableRules = selector.tables || {};
  if (selector.allDatabases || (databaseRules.exclude || []).length || (selector.schemas?.include || []).length || (selector.schemas?.exclude || []).length || (tableRules.exclude || []).length || selector.includeGlobalObjects) throw new DatabaseAdapterError('CLICKHOUSE_SELECTION_INVALID', 'ClickHouse full backup requires one included database with no exclusions or global objects.', { category: 'compatibility' });
  if ((databaseRules.include || []).length !== 1) throw new DatabaseAdapterError('CLICKHOUSE_SELECTION_INVALID', 'Select exactly one ClickHouse database.', { category: 'compatibility' });
  const databaseName = requiredText(databaseRules.include[0].name, 'ClickHouse selected database', 512);
  const database = discovery.databases.find((item) => item.name === databaseName);
  if (!database) throw new DatabaseAdapterError('CLICKHOUSE_DATABASE_NOT_FOUND', 'The selected ClickHouse database identity is unavailable.', { category: 'integrity' });
  const requestedTables = tableRules.include || [];
  let tables;
  if (requestedTables.length) {
    if (requestedTables.some((item) => item.database !== databaseName || item.schema !== databaseName)) throw new DatabaseAdapterError('CLICKHOUSE_SELECTION_INVALID', 'ClickHouse table rules must use the selected database as both database and schema.', { category: 'compatibility' });
    const names = new Set();
    tables = requestedTables.map((item) => {
      const name = requiredText(item.name, 'ClickHouse selected table', 512);
      if (names.has(name)) throw new DatabaseAdapterError('CLICKHOUSE_SELECTION_INVALID', 'ClickHouse table selection contains duplicates.', { category: 'compatibility' });
      names.add(name);
      const table = discovery.tables.find((candidate) => candidate.database === databaseName && candidate.name === name);
      if (!table || !table.selectable) throw new DatabaseAdapterError('CLICKHOUSE_TABLE_NOT_FOUND', 'A selected ClickHouse table identity is unavailable.', { category: 'integrity' });
      return table;
    });
  } else tables = discovery.tables.filter((item) => item.database === databaseName && item.selectable);
  if (!tables.length) throw new DatabaseAdapterError('CLICKHOUSE_SELECTION_EMPTY', 'The selected ClickHouse database has no protectable tables.', { category: 'compatibility' });
  const unsupported = tables.find((table) => !SUPPORTED_TABLE_ENGINES.has(table.engine));
  if (unsupported) throw new DatabaseAdapterError('CLICKHOUSE_TABLE_ENGINE_UNSUPPORTED', `ClickHouse table ${unsupported.database}.${unsupported.name} uses an unsupported engine.`, { category: 'compatibility' });
  return { database, tables: tables.slice().sort((left, right) => left.name.localeCompare(right.name, 'en-US')), wholeDatabase: requestedTables.length === 0 };
}

function backupPrivilege(grants) {
  return grants.some((grant) => ['ALL', 'BACKUP'].includes(String(grant.accessType).toUpperCase()));
}

function restorePrivilege(grants) {
  return grants.some((grant) => ['ALL', 'BACKUP', 'RESTORE'].includes(String(grant.accessType).toUpperCase()));
}

function backupStatusQuery(operationId) {
  return `SELECT id, name, status, error, toString(start_time) AS start_time, toString(end_time) AS end_time, num_files, total_size, num_entries, uncompressed_size, compressed_size, files_read, bytes_read FROM system.backups WHERE id = ${quoteString(operationId)} ORDER BY start_time DESC LIMIT 2 FORMAT JSONEachRow`;
}

function normalizeBackupStatus(rows, operationId, expectedName) {
  if (rows.length !== 1) throw new DatabaseAdapterError('CLICKHOUSE_BACKUP_STATUS_AMBIGUOUS', 'ClickHouse did not return one exact native backup operation.', { category: 'integrity' });
  const row = rows[0];
  if (requiredText(row.id, 'ClickHouse backup operation ID', 200) !== operationId || requiredText(row.name, 'ClickHouse backup name', 4096) !== expectedName) throw new DatabaseAdapterError('CLICKHOUSE_BACKUP_OWNERSHIP_CHANGED', 'ClickHouse backup ownership evidence does not match the immutable plan.', { category: 'integrity' });
  return {
    id: operationId,
    name: expectedName,
    status: requiredText(row.status, 'ClickHouse backup status', 100).toUpperCase(),
    error: optionalText(row.error, 'ClickHouse backup error', 1000),
    startedAt: optionalText(row.start_time, 'ClickHouse backup start time', 100),
    completedAt: optionalText(row.end_time, 'ClickHouse backup end time', 100),
    files: boundedInteger(row.num_files, 'ClickHouse backup file count'),
    totalBytes: boundedInteger(row.total_size, 'ClickHouse backup total size'),
    entries: boundedInteger(row.num_entries, 'ClickHouse backup entry count'),
    uncompressedBytes: boundedInteger(row.uncompressed_size, 'ClickHouse backup uncompressed size'),
    compressedBytes: boundedInteger(row.compressed_size, 'ClickHouse backup compressed size'),
    filesRead: boundedInteger(row.files_read, 'ClickHouse backup files read'),
    bytesRead: boundedInteger(row.bytes_read, 'ClickHouse backup bytes read')
  };
}

function normalizeRestoreStatus(rows, operationId, expectedName) {
  if (rows.length !== 1) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_STATUS_AMBIGUOUS', 'ClickHouse did not return one exact native restore operation.', { category: 'integrity' });
  const row = rows[0];
  if (requiredText(row.id, 'ClickHouse restore operation ID', 200) !== operationId || requiredText(row.name, 'ClickHouse restore name', 4096) !== expectedName) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_OWNERSHIP_CHANGED', 'ClickHouse restore ownership evidence does not match the immutable plan.', { category: 'integrity' });
  return {
    id: operationId,
    name: expectedName,
    status: requiredText(row.status, 'ClickHouse restore status', 100).toUpperCase(),
    error: optionalText(row.error, 'ClickHouse restore error', 1000),
    startedAt: optionalText(row.start_time, 'ClickHouse restore start time', 100),
    completedAt: optionalText(row.end_time, 'ClickHouse restore end time', 100),
    files: boundedInteger(row.num_files, 'ClickHouse restore file count'),
    totalBytes: boundedInteger(row.total_size, 'ClickHouse restore total size'),
    entries: boundedInteger(row.num_entries, 'ClickHouse restore entry count'),
    uncompressedBytes: boundedInteger(row.uncompressed_size, 'ClickHouse restore uncompressed size'),
    compressedBytes: boundedInteger(row.compressed_size, 'ClickHouse restore compressed size'),
    filesRead: boundedInteger(row.files_read, 'ClickHouse restore files read'),
    bytesRead: boundedInteger(row.bytes_read, 'ClickHouse restore bytes read')
  };
}

function selectionStatistics(discovery, selection) {
  return selection.tables.map((table) => {
    const partitions = discovery.partitions.filter((item) => item.database === table.database && item.table === table.name);
    return {
      database: table.database,
      table: table.name,
      partCount: partitions.reduce((sum, item) => sum + item.partCount, 0),
      rowCount: partitions.reduce((sum, item) => sum + item.rowCount, 0),
      partitionCount: partitions.length
    };
  });
}

function normalizeRestoreSource(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.adapterId !== ADAPTER_ID || input.kind !== 'clickhouse-native-backup') throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_SOURCE_INVALID', 'The authenticated ClickHouse restore source is invalid.', { category: 'integrity' });
  const productVersion = parseVersion(input.productVersion).text;
  const deploymentFingerprint = requiredText(input.deploymentFingerprint, 'ClickHouse source deployment fingerprint', 80);
  const topologyFingerprint = requiredText(input.topologyFingerprint, 'ClickHouse source topology fingerprint', 80);
  const destination = input.destination || {};
  const diskName = requiredText(destination.diskName, 'ClickHouse restore disk name', 255);
  const destinationFingerprintValue = requiredText(destination.destinationFingerprint, 'ClickHouse restore destination fingerprint', 80);
  const relativePath = requiredText(destination.relativePath, 'ClickHouse restore relative path', 512);
  const operationId = requiredText(input.operation?.id, 'ClickHouse backup operation ID', 200);
  const backupName = `Disk(${quoteString(diskName)}, ${quoteString(relativePath)})`;
  if (!/^sha256:[0-9a-f]{64}$/.test(deploymentFingerprint) || !/^sha256:[0-9a-f]{64}$/.test(topologyFingerprint) || !/^sha256:[0-9a-f]{64}$/.test(destinationFingerprintValue)
    || !/^deployerx-[0-9a-f]{32}$/.test(operationId) || !/^deployerx\/[0-9a-f]{16}\/deployerx-[0-9a-f]{32}[.]zip$/.test(relativePath) || !relativePath.endsWith(`${operationId}.zip`)
    || destination.backupName !== backupName || input.operation?.name !== backupName || input.operation?.status !== 'BACKUP_CREATED'
    || boundedInteger(input.operation?.files, 'ClickHouse backup file count') < 1 || boundedInteger(input.operation?.entries, 'ClickHouse backup entry count') < 1 || boundedInteger(input.operation?.totalBytes, 'ClickHouse backup total size') < 1) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_SOURCE_INVALID', 'The authenticated ClickHouse native destination evidence is invalid.', { category: 'integrity' });
  const selection = input.selection || {};
  const database = selection.database || {};
  const sourceDatabase = requiredText(database.name, 'ClickHouse source database', 512);
  const databaseUuid = normalizeUuid(database.uuid, 'ClickHouse source database UUID');
  const tables = Array.isArray(selection.tables) ? selection.tables.map((table) => ({ database: requiredText(table.database, 'ClickHouse source table database', 512), name: requiredText(table.name, 'ClickHouse source table', 512), uuid: normalizeUuid(table.uuid, 'ClickHouse source table UUID'), engine: requiredText(table.engine, 'ClickHouse source table engine', 200) })) : [];
  if (!tables.length || tables.length > MAX_RESTORE_TABLES || tables.some((table) => table.database !== sourceDatabase) || new Set(tables.map((table) => table.name)).size !== tables.length) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_SELECTION_INVALID', 'The ClickHouse restore selection is empty, ambiguous, or exceeds the supported table limit.', { category: 'integrity' });
  const statistics = Array.isArray(selection.statistics) ? selection.statistics.map((item) => ({ database: requiredText(item.database, 'ClickHouse statistics database', 512), table: requiredText(item.table, 'ClickHouse statistics table', 512), partCount: boundedInteger(item.partCount, 'ClickHouse source part count'), rowCount: boundedInteger(item.rowCount, 'ClickHouse source row count'), partitionCount: boundedInteger(item.partitionCount, 'ClickHouse source partition count') })) : [];
  if (statistics.length !== tables.length || tables.some((table) => !statistics.some((item) => item.database === table.database && item.table === table.name))) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_STATISTICS_INVALID', 'The ClickHouse backup does not contain complete row and part evidence for restore validation.', { category: 'integrity' });
  return Object.freeze({ productVersion, deploymentFingerprint, topologyFingerprint, destination: { diskName, destinationFingerprint: destinationFingerprintValue, relativePath, backupName }, operationId, selection: { database: { name: sourceDatabase, uuid: databaseUuid, engine: requiredText(database.engine, 'ClickHouse source database engine', 100) }, tables, wholeDatabase: selection.wholeDatabase === true, statistics } });
}

function runLocalCommand({ executable, args, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, signal }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode: 0 });
    });
  });
}

async function command(context, config, query, options = {}) {
  const configPath = requiredText(context.clickhouseConfigPath, 'ClickHouse protected client configuration path', 2048);
  try {
    const queryId = options.queryId ? requiredText(options.queryId, 'ClickHouse query ID', 200) : null;
    return await (context.runNativeCommand || runLocalCommand)({ executable: config.clientPath, args: [`--config-file=${configPath}`, ...(queryId ? [`--query_id=${queryId}`] : []), '--query', query], timeoutMs: options.timeoutMs || config.timeoutMs, signal: context.signal });
  } catch (error) {
    if (options.allowFailure) return { stdout: '', stderr: '', exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1, failed: true };
    if (error instanceof DatabaseAdapterError) throw error;
    throw new DatabaseAdapterError('CLICKHOUSE_COMMAND_FAILED', 'A ClickHouse command failed.', { category: 'unavailable', retryable: true });
  }
}

async function readDiscovery(context = {}, input = {}) {
  const config = normalizeConfig(input);
  const results = await Promise.all(Object.entries(QUERIES).map(async ([key, query]) => [key, await command(context, config, query, { allowFailure: ['namedCollections', 'grants', 'backups'].includes(key) })]));
  const output = Object.fromEntries(results);
  const identityRows = parseJsonRows(output.identity.stdout, 'ClickHouse identity discovery');
  if (identityRows.length !== 1) throw new DatabaseAdapterError('CLICKHOUSE_IDENTITY_INVALID', 'ClickHouse returned an ambiguous server identity.', { category: 'integrity' });
  const identity = identityRows[0];
  const version = parseVersion(identity.version);
  if (config.expectedVersion && config.expectedVersion !== version.text) throw new DatabaseAdapterError('CLICKHOUSE_VERSION_CHANGED', 'ClickHouse version does not match the tested connection.', { category: 'integrity' });
  const databases = parseJsonRows(output.databases.stdout, 'ClickHouse database discovery').map((row) => ({ name: boundedName(row.name, 'ClickHouse database name'), uuid: normalizeUuid(row.uuid, 'ClickHouse database UUID'), engine: boundedName(row.engine, 'ClickHouse database engine', 100), dataPath: optionalText(row.data_path, 'ClickHouse database data path', 2048), selectable: true }));
  const tables = parseJsonRows(output.tables.stdout, 'ClickHouse table discovery').map((row) => ({ database: boundedName(row.database, 'ClickHouse table database'), name: boundedName(row.name, 'ClickHouse table name'), uuid: normalizeUuid(row.uuid, 'ClickHouse table UUID'), engine: boundedName(row.engine, 'ClickHouse table engine', 200), temporary: Boolean(row.is_temporary), selectable: !Boolean(row.is_temporary) }));
  const clusters = parseJsonRows(output.clusters.stdout, 'ClickHouse cluster discovery').map((row) => ({ cluster: boundedName(row.cluster, 'ClickHouse cluster name'), shardNumber: boundedInteger(row.shard_num, 'ClickHouse shard number', 100000), shardWeight: boundedInteger(row.shard_weight, 'ClickHouse shard weight'), replicaNumber: boundedInteger(row.replica_num, 'ClickHouse replica number', 100000), hostName: boundedName(row.host_name, 'ClickHouse replica host'), hostAddress: boundedName(row.host_address, 'ClickHouse replica address'), port: boundedInteger(row.port, 'ClickHouse replica port', 65535), local: Boolean(row.is_local), errors: boundedInteger(row.errors_count, 'ClickHouse replica error count'), estimatedRecoverySeconds: boundedInteger(row.estimated_recovery_time, 'ClickHouse replica recovery time') }));
  const replicas = parseJsonRows(output.replicas.stdout, 'ClickHouse replica discovery').map((row) => ({ database: boundedName(row.database, 'ClickHouse replica database'), table: boundedName(row.table, 'ClickHouse replica table'), coordinationPath: boundedName(row.zookeeper_path, 'ClickHouse coordination path', 2048), replicaName: boundedName(row.replica_name, 'ClickHouse replica name'), readOnly: Boolean(row.is_readonly), sessionExpired: Boolean(row.is_session_expired), futureParts: boundedInteger(row.future_parts, 'ClickHouse future parts'), queueSize: boundedInteger(row.queue_size, 'ClickHouse queue size'), absoluteDelaySeconds: boundedInteger(row.absolute_delay, 'ClickHouse replica delay'), totalReplicas: boundedInteger(row.total_replicas, 'ClickHouse total replicas'), activeReplicas: boundedInteger(row.active_replicas, 'ClickHouse active replicas') }));
  const partitions = parseJsonRows(output.partitions.stdout, 'ClickHouse partition discovery').map((row) => ({ database: boundedName(row.database, 'ClickHouse partition database'), table: boundedName(row.table, 'ClickHouse partition table'), partition: boundedName(row.partition, 'ClickHouse partition name'), partCount: boundedInteger(row.part_count, 'ClickHouse part count'), rowCount: boundedInteger(row.row_count, 'ClickHouse row count'), bytesOnDisk: boundedInteger(row.bytes_on_disk, 'ClickHouse partition bytes') }));
  const disks = parseJsonRows(output.disks.stdout, 'ClickHouse disk discovery').map((row) => ({ name: boundedName(row.name, 'ClickHouse disk name'), type: boundedName(row.type, 'ClickHouse disk type'), path: optionalText(row.path, 'ClickHouse disk path', 2048), freeBytes: boundedInteger(row.free_space, 'ClickHouse disk free space'), totalBytes: boundedInteger(row.total_space, 'ClickHouse disk total space'), keepFreeBytes: boundedInteger(row.keep_free_space, 'ClickHouse disk reserved space'), readOnly: Boolean(row.is_read_only), writeOnce: Boolean(row.is_write_once) }));
  const namedCollections = output.namedCollections.failed ? [] : parseJsonRows(output.namedCollections.stdout, 'ClickHouse named collection discovery').map((row) => boundedName(row.name, 'ClickHouse named collection name'));
  const grants = output.grants.failed ? [] : parseJsonRows(output.grants.stdout, 'ClickHouse grant discovery').map((row) => ({ accessType: boundedName(row.access_type, 'ClickHouse grant type', 100), database: optionalText(row.database, 'ClickHouse grant database', 512), table: optionalText(row.table, 'ClickHouse grant table', 512) }));
  const backupCatalogAvailable = !output.backups.failed && parseJsonRows(output.backups.stdout, 'ClickHouse backup catalog discovery').length === 1;
  const topologyEvidence = { clusters, replicas: replicas.map(({ coordinationPath: _privatePath, ...replica }) => replica) };
  const topologyFingerprint = stableDigest(topologyEvidence);
  const deploymentFingerprint = stableDigest({ version: version.text, hostName: boundedName(identity.host_name, 'ClickHouse host identity'), databases: databases.map(({ name, uuid, engine }) => ({ name, uuid, engine })), tables: tables.map(({ database, name, uuid, engine }) => ({ database, name, uuid, engine })) });
  if (config.expectedDeploymentFingerprint && config.expectedDeploymentFingerprint !== deploymentFingerprint) throw new DatabaseAdapterError('CLICKHOUSE_DEPLOYMENT_CHANGED', 'ClickHouse deployment identity has changed since the connection was tested.', { category: 'integrity' });
  if (config.expectedTopologyFingerprint && config.expectedTopologyFingerprint !== topologyFingerprint) throw new DatabaseAdapterError('CLICKHOUSE_TOPOLOGY_CHANGED', 'ClickHouse cluster or replica topology has changed since the connection was tested.', { category: 'integrity' });
  return {
    version, timezone: boundedName(identity.timezone, 'ClickHouse timezone', 100), hostName: boundedName(identity.host_name, 'ClickHouse host identity'), currentUser: boundedName(identity.current_user, 'ClickHouse current user', 256),
    databases, tables, clusters, replicas, partitions, disks, namedCollections, grants, backupCatalogAvailable,
    grantsVisible: !output.grants.failed, namedCollectionsVisible: !output.namedCollections.failed, deploymentFingerprint, topologyFingerprint
  };
}

function safeAdapterError(error) {
  if (error instanceof DatabaseAdapterError) return error;
  if (error?.name === 'AbortError') return new DatabaseAdapterError('CLICKHOUSE_COMMAND_CANCELED', 'ClickHouse discovery was canceled.', { category: 'canceled' });
  return new DatabaseAdapterError('CLICKHOUSE_DISCOVERY_FAILED', 'DeployerX could not complete ClickHouse discovery.', { category: 'connectivity', retryable: true });
}

class ClickHouseAdapter {
  constructor({ clock = () => new Date().toISOString(), now = () => Date.now(), delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), maximumBackupWaitMs = MAX_BACKUP_WAIT_MS, maximumRestoreWaitMs = MAX_BACKUP_WAIT_MS } = {}) {
    this.clock = clock; this.now = now; this.delay = delay;
    if (!Number.isInteger(maximumBackupWaitMs) || maximumBackupWaitMs < 1000 || maximumBackupWaitMs > MAX_BACKUP_WAIT_MS) throw new TypeError('ClickHouse maximum backup wait is invalid.');
    if (!Number.isInteger(maximumRestoreWaitMs) || maximumRestoreWaitMs < 1000 || maximumRestoreWaitMs > MAX_BACKUP_WAIT_MS) throw new TypeError('ClickHouse maximum restore wait is invalid.');
    this.maximumBackupWaitMs = maximumBackupWaitMs;
    this.maximumRestoreWaitMs = maximumRestoreWaitMs;
  }

  manifest() {
    return {
      apiVersion: 1, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, displayName: 'ClickHouse', engine: 'clickhouse', executionReady: true, sourceEnrollmentReady: true,
      serverVersionRange: 'Self-managed ClickHouse 23.x through 26.x', restoreVersionRange: 'Exact-version standalone ClickHouse 23.x through 26.x alternate targets',
      capabilities: {
        backupMethods: ['physical'], backupModes: ['full', 'incremental'], selection: { database: true, schema: false, table: true, globalObjects: false },
        consistencyStrategies: [{ id: 'clickhouse-native-backup', produces: 'application', backupMethods: ['physical'], lockScope: 'none', requiresDowntime: false, capturesCoordinates: true }],
        transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null },
        streaming: { backup: true, restore: true, compression: true, encryption: false }, restore: { alternateTarget: true, offlineBundle: false, originalTarget: false, nativeValidation: true }, replicaAware: false
      },
      requiredTools: [{ name: 'clickhouse-client', versionRange: 'Server-compatible 23.x through 26.x', operations: ['discovery', 'backup', 'restore', 'validation'] }],
      requiredPrivileges: [
        { id: 'clickhouse-discovery', operations: ['discovery'], required: true, safeDescription: 'Read server identity, databases, tables, UUIDs, partitions, disks, clusters, replicas, grants, named collection names, and native backup catalog capability.' },
        { id: 'clickhouse-backup', operations: ['backup'], required: true, safeDescription: 'Execute native BACKUP for the exact selected database or tables on one approved configured disk.' },
        { id: 'clickhouse-restore', operations: ['restore'], required: true, safeDescription: 'Execute native RESTORE into an exact empty alternate database or table scope and query the native operation catalog.' }
      ]
    };
  }

  normalizeConfig(input) { return normalizeConfig(input); }
  validateConfig(input) { try { normalizeConfig(input); return []; } catch (error) { return [{ path: '', code: 'CLICKHOUSE_CONFIG_INVALID', severity: 'error', message: error.message }]; } }

  async testConnection(context = {}, input = {}) {
    const started = this.now(); const testedAt = this.clock();
    try {
      const discovery = await readDiscovery(context, input);
      const unhealthy = discovery.replicas.filter((replica) => replica.readOnly || replica.sessionExpired || replica.activeReplicas < replica.totalReplicas || replica.queueSize > 0 || replica.absoluteDelaySeconds > 0);
      return normalizeConnectionTestResult({
        adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'success',
        checks: [
          { id: 'product-version', status: 'pass', safeMessage: `ClickHouse ${discovery.version.text} is supported for discovery.` },
          { id: 'deployment-identity', status: 'pass', safeMessage: 'Database and table UUID identities were captured.' },
          { id: 'topology', status: unhealthy.length ? 'warning' : 'pass', safeMessage: unhealthy.length ? `${unhealthy.length} replicated table(s) report degraded state.` : 'Discovered ClickHouse replica topology is healthy.' },
          { id: 'backup-catalog', status: discovery.backupCatalogAvailable ? 'pass' : 'warning', safeMessage: discovery.backupCatalogAvailable ? 'The native backup catalog is queryable.' : 'The native backup catalog is unavailable; backup execution will remain disabled.' },
          { id: 'privilege-inventory', status: discovery.grantsVisible ? 'pass' : 'warning', safeMessage: discovery.grantsVisible ? 'Current-user grant evidence was captured.' : 'Current-user grant evidence is not visible.' }
        ],
        remotePlatform: { engine: 'clickhouse', version: discovery.version.text, distribution: 'self-managed', platform: null },
        endpointIdentity: { product: 'clickhouse', version: discovery.version.text, hostName: discovery.hostName, timezone: discovery.timezone, deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint, databaseCount: discovery.databases.length, tableCount: discovery.tables.length, clusterCount: new Set(discovery.clusters.map((row) => row.cluster)).size, replicaCount: discovery.replicas.length, backupCatalogAvailable: discovery.backupCatalogAvailable },
        error: null
      }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    } catch (error) {
      const safe = safeAdapterError(error);
      return normalizeConnectionTestResult({ adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, testedAt, latencyMs: Math.max(0, this.now() - started), status: 'failure', checks: [], error: { code: safe.code, category: safe.category, retryable: safe.retryable, safeMessage: safe.message, retryAfterSeconds: null, details: safe.details || {}, causeFingerprint: null } }, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    }
  }

  async *discover(context = {}, request = {}) {
    const kind = String(request.kind || 'all').toLowerCase();
    if (!DISCOVERY_KINDS.has(kind)) throw new DatabaseAdapterError('CLICKHOUSE_DISCOVERY_KIND_UNSUPPORTED', 'ClickHouse discovery kind is unsupported.', { category: 'compatibility' });
    const discovery = await readDiscovery(context, request.connection);
    const common = { nextCursor: null, version: discovery.version, deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint };
    if (kind === 'databases') yield { ...common, items: discovery.databases };
    else if (kind === 'tables') yield { ...common, items: discovery.tables };
    else if (kind === 'topology') yield { ...common, items: [], clusters: discovery.clusters, replicas: discovery.replicas };
    else if (kind === 'storage') yield { ...common, items: discovery.disks, namedCollections: discovery.namedCollections, partitions: discovery.partitions };
    else yield { ...common, items: [], databases: discovery.databases, tables: discovery.tables, clusters: discovery.clusters, replicas: discovery.replicas, partitions: discovery.partitions, disks: discovery.disks, namedCollections: discovery.namedCollections, grants: discovery.grants, capabilities: { backupCatalogAvailable: discovery.backupCatalogAvailable, grantsVisible: discovery.grantsVisible, namedCollectionsVisible: discovery.namedCollectionsVisible }, identity: { product: 'clickhouse', version: discovery.version, timezone: discovery.timezone, hostName: discovery.hostName, currentUser: discovery.currentUser } };
  }

  async preflight(context = {}, request = {}) {
    const discovery = await readDiscovery(context, request.connection);
    const execution = normalizeBackupExecution(request.execution);
    if (!discovery.backupCatalogAvailable || !discovery.grantsVisible || !backupPrivilege(discovery.grants)) throw new DatabaseAdapterError('CLICKHOUSE_BACKUP_PRIVILEGE_UNPROVEN', 'ClickHouse native backup catalog and BACKUP privilege must be visible.', { category: 'authorization' });
    if (discovery.clusters.length || discovery.replicas.length) throw new DatabaseAdapterError('CLICKHOUSE_CLUSTER_SCOPE_UNAVAILABLE', 'This ClickHouse full-backup slice admits standalone non-replicated selections only.', { category: 'compatibility' });
    const disk = discovery.disks.find((item) => item.name === execution.diskName);
    if (!disk || disk.readOnly || disk.writeOnce || destinationFingerprint(disk) !== execution.destinationFingerprint) throw new DatabaseAdapterError('CLICKHOUSE_DESTINATION_CHANGED', 'The approved writable ClickHouse backup disk identity has changed.', { category: 'integrity' });
    const selected = selectedObjects(request.selector || {}, discovery);
    let baseBackup = null;
    if (execution.baseBackup) {
      if (execution.baseBackup.destinationFingerprint !== execution.destinationFingerprint || execution.baseBackup.deploymentFingerprint !== discovery.deploymentFingerprint || execution.baseBackup.topologyFingerprint !== discovery.topologyFingerprint || execution.baseBackup.selectionDigest !== request.selector?.digest) throw new DatabaseAdapterError('CLICKHOUSE_BASE_IDENTITY_CHANGED', 'The authenticated ClickHouse incremental base does not match the current Source, deployment, topology, or destination.', { category: 'integrity' });
      const baseName = `Disk(${quoteString(execution.diskName)}, ${quoteString(execution.baseBackup.relativePath)})`;
      const response = await command(context, normalizeConfig(request.connection), backupStatusQuery(execution.baseBackup.operationId));
      const status = normalizeBackupStatus(parseJsonRows(response.stdout, 'ClickHouse incremental base status'), execution.baseBackup.operationId, baseName);
      if (status.status !== 'BACKUP_CREATED' || status.files < 1 || status.entries < 1 || status.totalBytes < 1 || status.compressedBytes < 1 || status.uncompressedBytes < status.compressedBytes) throw new DatabaseAdapterError('CLICKHOUSE_BASE_UNAVAILABLE', 'The authenticated ClickHouse incremental base is not a complete available native backup.', { category: 'integrity' });
      baseBackup = { ...execution.baseBackup, backupName: baseName, statusFingerprint: stableDigest(status) };
    }
    return {
      checkedAt: this.clock(), serverVersion: discovery.version.text, serverVersionSupported: true, serverIdentityFingerprint: discovery.deploymentFingerprint,
      consistency: [{ method: 'clickhouse-native-backup', verified: true, produces: 'application' }],
      tools: [{ name: 'clickhouse-client', version: discovery.version.text, compatible: true, executableFingerprint: stableDigest({ path: request.connection.clientPath, version: discovery.version.text }) }],
      privileges: [{ id: 'clickhouse-discovery', allowed: true, evidence: 'Bounded identity, object, storage, topology, and backup-catalog discovery succeeded.' }, { id: 'clickhouse-backup', allowed: true, evidence: 'The current user exposes BACKUP privilege evidence.' }],
      coordinateCaptureVerified: true, warnings: [],
      metadata: {
        product: 'clickhouse', deploymentFingerprint: discovery.deploymentFingerprint, topologyFingerprint: discovery.topologyFingerprint,
        destination: { type: 'disk', diskName: disk.name, diskType: disk.type, destinationFingerprint: execution.destinationFingerprint },
        selection: { database: { name: selected.database.name, uuid: selected.database.uuid, engine: selected.database.engine }, tables: selected.tables.map(({ database, name, uuid, engine }) => ({ database, name, uuid, engine })), wholeDatabase: selected.wholeDatabase },
        executionMode: execution.executionMode, baseBackup
      }
    };
  }

  async planBackup(_context = {}, request = {}) {
    const backupMode = request.consistency?.backupMode;
    if (request.consistency?.proven !== true || request.consistency?.method !== 'clickhouse-native-backup' || request.consistency?.achievedLevel !== 'application' || request.consistency?.backupMethod !== 'physical' || !['full', 'incremental'].includes(backupMode) || request.consistency?.captureCoordinates !== true) throw new DatabaseAdapterError('CLICKHOUSE_CONSISTENCY_PLAN_INVALID', 'ClickHouse backup requires a proven native application-consistent full or incremental plan.', { category: 'integrity' });
    const execution = normalizeBackupExecution(request.execution);
    if (!request.execution?.executionId) throw new DatabaseAdapterError('CLICKHOUSE_EXECUTION_INVALID', 'ClickHouse native backup requires a run identity.', { category: 'integrity' });
    const executionId = requiredText(request.execution.executionId, 'ClickHouse backup execution ID', 200);
    const metadata = request.consistency.evidence?.metadata || {};
    if (metadata.destination?.destinationFingerprint !== execution.destinationFingerprint || metadata.destination?.diskName !== execution.diskName || metadata.deploymentFingerprint !== request.connection.expectedDeploymentFingerprint) throw new DatabaseAdapterError('CLICKHOUSE_PLAN_IDENTITY_INVALID', 'ClickHouse plan identity does not match the approved connection and destination.', { category: 'integrity' });
    if ((backupMode === 'incremental') !== Boolean(execution.baseBackup) || (execution.baseBackup && (!metadata.baseBackup || metadata.baseBackup.operationId !== execution.baseBackup.operationId || metadata.baseBackup.metadataDigest !== execution.baseBackup.metadataDigest))) throw new DatabaseAdapterError('CLICKHOUSE_BASE_PLAN_INVALID', 'ClickHouse incremental planning requires one revalidated authenticated base backup.', { category: 'integrity' });
    const operationId = `deployerx-${crypto.createHash('sha256').update(`${request.execution.workspaceId || ''}\0${executionId}`).digest('hex').slice(0, 32)}`;
    const relativePath = `deployerx/${crypto.createHash('sha256').update(String(request.execution.workspaceId || '')).digest('hex').slice(0, 16)}/${operationId}.zip`;
    const destinationName = `Disk(${quoteString(execution.diskName)}, ${quoteString(relativePath)})`;
    const selection = metadata.selection;
    const selectionSql = selection.wholeDatabase
      ? `DATABASE ${quoteIdentifier(selection.database.name)}`
      : selection.tables.map((table) => `TABLE ${quoteIdentifier(table.database)}.${quoteIdentifier(table.name)}`).join(', ');
    const baseDestinationName = execution.baseBackup ? `Disk(${quoteString(execution.diskName)}, ${quoteString(execution.baseBackup.relativePath)})` : null;
    const settings = [`id = ${quoteString(operationId)}`, ...(baseDestinationName ? [`base_backup = ${baseDestinationName}`] : [])];
    const statement = `BACKUP ${selectionSql} TO ${destinationName} SETTINGS ${settings.join(', ')}${execution.executionMode === 'asynchronous' ? ' ASYNC' : ''}`;
    return {
      version: 1, operation: `clickhouse-native-${backupMode}`, backupMode, connection: normalizeConfig(request.connection), execution: { ...execution, executionId, sourceId: request.execution.sourceId || null, workspaceId: request.execution.workspaceId || null, jobId: request.execution.jobId || null },
      consistency: request.consistency, selector: request.selector, selection, operationId, relativePath, destinationName, baseDestinationName, statement,
      ownershipFingerprint: stableDigest({ operationId, destinationName, baseDestinationName, selection, deploymentFingerprint: metadata.deploymentFingerprint, destinationFingerprint: execution.destinationFingerprint }),
      artifact: { kind: 'metadata', path: 'clickhouse/backup-metadata.json', mediaType: 'application/vnd.deployerx.clickhouse-backup+json' }, resumable: false
    };
  }

  async #readBackupStatus(context, plan) {
    const response = await command(context, plan.connection, backupStatusQuery(plan.operationId));
    return normalizeBackupStatus(parseJsonRows(response.stdout, 'ClickHouse backup status'), plan.operationId, plan.destinationName);
  }

  async executeBackup(context = {}, plan = {}) {
    if (!['clickhouse-native-full', 'clickhouse-native-incremental'].includes(plan.operation) || !['full', 'incremental'].includes(plan.backupMode) || (plan.backupMode === 'incremental') !== Boolean(plan.execution?.baseBackup)) throw new DatabaseAdapterError('CLICKHOUSE_PLAN_INVALID', 'ClickHouse native backup plan is invalid.', { category: 'integrity' });
    const planDigest = requiredText(context.planDigest, 'ClickHouse backup plan digest', 100);
    const before = await readDiscovery(context, plan.connection);
    if (before.deploymentFingerprint !== plan.consistency.evidence.serverIdentityFingerprint || before.topologyFingerprint !== plan.consistency.evidence.metadata.topologyFingerprint) throw new DatabaseAdapterError('CLICKHOUSE_DEPLOYMENT_CHANGED', 'ClickHouse identity changed before native backup.', { category: 'integrity' });
    const selectedBefore = selectedObjects(plan.selector || plan.consistency.selector || {}, before);
    const plannedTables = plan.selection.tables.map((table) => [table.database, table.name, table.uuid, table.engine]);
    const currentTables = selectedBefore.tables.map((table) => [table.database, table.name, table.uuid, table.engine]);
    if (selectedBefore.database.uuid !== plan.selection.database.uuid || JSON.stringify(currentTables) !== JSON.stringify(plannedTables)) throw new DatabaseAdapterError('CLICKHOUSE_SELECTION_CHANGED', 'ClickHouse selected object identities changed before backup.', { category: 'integrity' });
    const owner = { version: 1, adapterId: ADAPTER_ID, operationId: plan.operationId, destinationName: plan.destinationName, ownershipFingerprint: plan.ownershipFingerprint, executionId: plan.execution.executionId, sourceId: plan.execution.sourceId, workspaceId: plan.execution.workspaceId, planDigest };
    if (typeof context.onOwnership === 'function') await context.onOwnership(owner);
    try {
      await command(context, plan.connection, plan.statement, { queryId: plan.operationId, timeoutMs: plan.execution.executionMode === 'synchronous' ? this.maximumBackupWaitMs : plan.connection.timeoutMs });
      const deadline = this.now() + this.maximumBackupWaitMs;
      let status = null;
      while (this.now() <= deadline) {
        if (context.signal?.aborted) throw new DatabaseAdapterError('CLICKHOUSE_OPERATION_CANCELED', 'ClickHouse backup monitoring was canceled; native media is preserved for reconciliation.', { category: 'canceled' });
        status = await this.#readBackupStatus(context, plan);
        if (status.status === 'BACKUP_CREATED') break;
        if (['BACKUP_FAILED', 'BACKUP_CANCELLED', 'BACKUP_CANCELED'].includes(status.status)) throw new DatabaseAdapterError('CLICKHOUSE_BACKUP_FAILED', 'ClickHouse native backup failed; native media and ownership evidence are preserved for reconciliation.', { category: 'execution', details: { status: status.status, errorFingerprint: status.error ? stableDigest(status.error) : null } });
        if (!['CREATING_BACKUP', 'BACKUP_CREATING'].includes(status.status)) throw new DatabaseAdapterError('CLICKHOUSE_BACKUP_STATUS_INVALID', 'ClickHouse native backup entered an unsupported state.', { category: 'integrity' });
        await this.delay(500);
      }
      if (!status || status.status !== 'BACKUP_CREATED') throw new DatabaseAdapterError('CLICKHOUSE_BACKUP_TIMEOUT', 'ClickHouse native backup did not complete before the deadline.', { category: 'timeout', retryable: true });
      if (status.files < 1 || status.entries < 1 || status.totalBytes < 1 || status.compressedBytes < 1 || status.uncompressedBytes < status.compressedBytes) throw new DatabaseAdapterError('CLICKHOUSE_BACKUP_EVIDENCE_INVALID', 'ClickHouse completed without valid native media counts and sizes.', { category: 'integrity' });
      const after = await readDiscovery(context, plan.connection);
      if (after.deploymentFingerprint !== before.deploymentFingerprint || after.topologyFingerprint !== before.topologyFingerprint) throw new DatabaseAdapterError('CLICKHOUSE_DEPLOYMENT_CHANGED', 'ClickHouse identity changed after native backup.', { category: 'integrity' });
      const selectedAfter = selectedObjects(plan.selector || plan.consistency.selector || {}, after);
      const afterTables = selectedAfter.tables.map((table) => [table.database, table.name, table.uuid, table.engine]);
      if (selectedAfter.database.uuid !== plan.selection.database.uuid || JSON.stringify(afterTables) !== JSON.stringify(plannedTables)) throw new DatabaseAdapterError('CLICKHOUSE_SELECTION_CHANGED', 'ClickHouse selected object identities changed after backup.', { category: 'integrity' });
      const beforeStatistics = selectionStatistics(before, selectedBefore);
      const afterStatistics = selectionStatistics(after, selectedAfter);
      if (JSON.stringify(afterStatistics) !== JSON.stringify(beforeStatistics)) throw new DatabaseAdapterError('CLICKHOUSE_SELECTION_CHANGED', 'ClickHouse selected row or part evidence changed during native backup, so exact restore validation evidence cannot be published.', { category: 'integrity' });
      const result = {
        version: 1, kind: 'clickhouse-native-backup', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, engine: 'clickhouse', productVersion: after.version.text, backupMethod: 'physical', backupMode: plan.backupMode,
        deploymentFingerprint: after.deploymentFingerprint, topologyFingerprint: after.topologyFingerprint,
        destination: { type: 'disk', diskName: plan.execution.diskName, destinationFingerprint: plan.execution.destinationFingerprint, backupName: plan.destinationName, relativePath: plan.relativePath },
        operation: status, selection: { ...plan.selection, statistics: afterStatistics }, selectionDigest: plan.selector.digest, sourceId: plan.execution.sourceId, jobId: plan.execution.jobId, workspaceDigest: plan.execution.workspaceId ? stableDigest(plan.execution.workspaceId) : null,
        chain: plan.execution.baseBackup ? { parentRecoveryPointId: plan.execution.baseBackup.parentRecoveryPointId, chainRootRecoveryPointId: plan.execution.baseBackup.chainRootRecoveryPointId, ancestorRecoveryPointIds: plan.execution.baseBackup.ancestorRecoveryPointIds, baseOperationId: plan.execution.baseBackup.operationId, baseRelativePath: plan.execution.baseBackup.relativePath, baseMetadataDigest: plan.execution.baseBackup.metadataDigest } : { parentRecoveryPointId: null, chainRootRecoveryPointId: null, ancestorRecoveryPointIds: [], baseOperationId: null, baseRelativePath: null, baseMetadataDigest: null },
        consistency: plan.consistency, planDigest, ownershipFingerprint: plan.ownershipFingerprint, nativeResponseDigest: stableDigest(status), externalNativeMedia: true, restoreSupported: true, warnings: []
      };
      if (typeof context.onOwnership === 'function') await context.onOwnership(null);
      return result;
    } catch (error) {
      throw safeAdapterError(error);
    }
  }
  async reconcileBackup(context = {}, input = {}) {
    const owner = input.owner;
    if (!owner || owner.version !== 1 || owner.adapterId !== ADAPTER_ID) throw new DatabaseAdapterError('CLICKHOUSE_OWNER_INVALID', 'ClickHouse backup ownership evidence is invalid.', { category: 'integrity' });
    const operationId = requiredText(owner.operationId, 'ClickHouse backup operation ID', 200);
    const destinationName = requiredText(owner.destinationName, 'ClickHouse backup destination name', 4096);
    const response = await command(context, normalizeConfig(input.connection), backupStatusQuery(operationId));
    const status = normalizeBackupStatus(parseJsonRows(response.stdout, 'ClickHouse backup reconciliation status'), operationId, destinationName);
    const terminal = ['BACKUP_CREATED', 'BACKUP_FAILED', 'BACKUP_CANCELLED', 'BACKUP_CANCELED'].includes(status.status);
    if (!terminal && !['CREATING_BACKUP', 'BACKUP_CREATING'].includes(status.status)) throw new DatabaseAdapterError('CLICKHOUSE_BACKUP_STATUS_INVALID', 'ClickHouse native backup entered an unsupported state.', { category: 'integrity' });
    return Object.freeze({ version: 1, operationId, status, terminal, nativeMediaPreserved: true, ownershipFingerprint: owner.ownershipFingerprint });
  }
  async planRestore(context = {}, request = {}) {
    if (request.mode !== 'alternate' || request.confirmation !== RESTORE_CONFIRMATION) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_MODE_UNSUPPORTED', 'ClickHouse restore currently requires explicit alternate-target confirmation.', { category: 'compatibility' });
    const targetDatabase = requiredText(request.targetDatabase, 'ClickHouse target database', 512);
    if (['system', 'information_schema'].includes(targetDatabase.toLowerCase())) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_TARGET_INVALID', 'Choose a non-system ClickHouse target database.', { category: 'compatibility' });
    const operationId = requiredText(request.operationId, 'ClickHouse restore operation ID', 200);
    if (!/^deployerx-restore-[0-9a-f]{32}$/.test(operationId)) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_OPERATION_INVALID', 'ClickHouse restore requires one immutable operation ID.', { category: 'integrity' });
    const source = normalizeRestoreSource(request.source);
    const connection = normalizeConfig(request.connection);
    const discovery = await readDiscovery(context, connection);
    if (!discovery.backupCatalogAvailable || !discovery.grantsVisible || !restorePrivilege(discovery.grants)) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_PRIVILEGE_UNPROVEN', 'ClickHouse native backup catalog and RESTORE privilege must be visible on the target.', { category: 'authorization' });
    if (discovery.clusters.length || discovery.replicas.length) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_CLUSTER_UNAVAILABLE', 'This ClickHouse restore slice supports standalone non-replicated targets only.', { category: 'compatibility' });
    if (discovery.version.text !== source.productVersion) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_VERSION_INCOMPATIBLE', 'The ClickHouse target must run the exact backup product version for this recovery slice.', { category: 'compatibility' });
    const disk = discovery.disks.find((item) => item.name === source.destination.diskName);
    if (!disk || destinationFingerprint(disk) !== source.destination.destinationFingerprint) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_MEDIA_UNAVAILABLE', 'The target does not expose the authenticated ClickHouse backup disk identity.', { category: 'integrity' });
    if (discovery.deploymentFingerprint === source.deploymentFingerprint && targetDatabase === source.selection.database.name) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_SOURCE_TARGET_COLLISION', 'Restore on the protected deployment requires a distinct alternate database name.', { category: 'conflict' });
    const targetDatabaseRecord = discovery.databases.find((item) => item.name === targetDatabase);
    const targetTables = discovery.tables.filter((item) => item.database === targetDatabase);
    if (source.selection.wholeDatabase) {
      if (targetDatabaseRecord || targetTables.length) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_TARGET_NOT_EMPTY', 'The alternate ClickHouse target database already exists.', { category: 'conflict' });
    } else if (!targetDatabaseRecord || targetTables.length) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_TARGET_NOT_EMPTY', 'Selected-table restore requires one existing empty alternate database.', { category: 'conflict' });
    const selectionSql = source.selection.wholeDatabase
      ? `DATABASE ${quoteIdentifier(source.selection.database.name)} AS ${quoteIdentifier(targetDatabase)}`
      : source.selection.tables.map((table) => `TABLE ${quoteIdentifier(table.database)}.${quoteIdentifier(table.name)} AS ${quoteIdentifier(targetDatabase)}.${quoteIdentifier(table.name)}`).join(', ');
    const statement = `RESTORE ${selectionSql} FROM ${source.destination.backupName} SETTINGS id = ${quoteString(operationId)} ASYNC`;
    return Object.freeze({
      version: 1,
      operation: 'clickhouse-native-alternate-restore',
      operationId,
      statement,
      destinationName: source.destination.backupName,
      connection,
      source,
      target: {
        database: targetDatabase,
        deploymentFingerprint: discovery.deploymentFingerprint,
        topologyFingerprint: discovery.topologyFingerprint,
        version: discovery.version.text,
        hostName: discovery.hostName,
        sameDeployment: discovery.deploymentFingerprint === source.deploymentFingerprint,
        wholeDatabase: source.selection.wholeDatabase,
        tableNames: source.selection.tables.map((table) => table.name)
      },
      ownershipFingerprint: stableDigest({ operationId, destinationName: source.destination.backupName, source: source.selection, targetDatabase, targetDeploymentFingerprint: discovery.deploymentFingerprint })
    });
  }

  async #readRestoreStatus(context, plan) {
    const response = await command(context, plan.connection, backupStatusQuery(plan.operationId));
    return normalizeRestoreStatus(parseJsonRows(response.stdout, 'ClickHouse restore status'), plan.operationId, plan.destinationName);
  }

  async executeRestore(context = {}, plan = {}) {
    if (plan.operation !== 'clickhouse-native-alternate-restore' || !/^deployerx-restore-[0-9a-f]{32}$/.test(String(plan.operationId || ''))) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_PLAN_INVALID', 'The ClickHouse native restore plan is invalid.', { category: 'integrity' });
    const before = await readDiscovery(context, plan.connection);
    if (before.deploymentFingerprint !== plan.target.deploymentFingerprint || before.topologyFingerprint !== plan.target.topologyFingerprint || before.version.text !== plan.target.version || before.hostName !== plan.target.hostName) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_TARGET_CHANGED', 'The ClickHouse target identity changed before native restore.', { category: 'integrity' });
    const targetDatabase = before.databases.find((item) => item.name === plan.target.database);
    const targetTables = before.tables.filter((item) => item.database === plan.target.database);
    if ((plan.target.wholeDatabase && (targetDatabase || targetTables.length)) || (!plan.target.wholeDatabase && (!targetDatabase || targetTables.length))) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_TARGET_NOT_EMPTY', 'The ClickHouse alternate target is no longer empty.', { category: 'conflict' });
    if (typeof context.onMutationStarted === 'function') await context.onMutationStarted({ operationId: plan.operationId, ownershipFingerprint: plan.ownershipFingerprint });
    await command(context, plan.connection, plan.statement, { queryId: plan.operationId });
    const deadline = this.now() + this.maximumRestoreWaitMs;
    let status = null;
    while (this.now() <= deadline) {
      if (context.signal?.aborted) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_CANCELED', 'ClickHouse restore monitoring was canceled after native submission; the target is preserved for reconciliation.', { category: 'canceled' });
      status = await this.#readRestoreStatus(context, plan);
      if (status.status === 'RESTORED') break;
      if (['RESTORE_FAILED', 'RESTORE_CANCELLED', 'RESTORE_CANCELED'].includes(status.status)) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_FAILED', 'ClickHouse native restore failed after submission; the target is preserved for inspection.', { category: 'execution', details: { status: status.status, errorFingerprint: status.error ? stableDigest(status.error) : null } });
      if (status.status !== 'RESTORING') throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_STATUS_INVALID', 'ClickHouse native restore entered an unsupported state.', { category: 'integrity' });
      await this.delay(500);
    }
    if (!status || status.status !== 'RESTORED') throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_TIMEOUT', 'ClickHouse native restore did not complete before the deadline.', { category: 'timeout', retryable: true });
    if (status.entries < 1 || status.filesRead < 1 || status.bytesRead < 1) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_EVIDENCE_INVALID', 'ClickHouse completed restore without valid native read and entry evidence.', { category: 'integrity' });
    const relaxedConnection = { ...plan.connection, expectedDeploymentFingerprint: null };
    const after = await readDiscovery(context, relaxedConnection);
    if (after.topologyFingerprint !== plan.target.topologyFingerprint || after.version.text !== plan.target.version || after.hostName !== plan.target.hostName) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_TARGET_CHANGED', 'The ClickHouse target host, version, or topology changed during native restore.', { category: 'integrity' });
    return { version: 1, plan, status, discovery: after, completedAt: this.clock() };
  }

  async validateRestore(context = {}, result = {}) {
    const plan = result.plan;
    const discovery = result.discovery;
    if (!plan || plan.operation !== 'clickhouse-native-alternate-restore' || !discovery || result.status?.status !== 'RESTORED') throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_RESULT_INVALID', 'ClickHouse restore validation requires one completed native result.', { category: 'integrity' });
    const targetDatabase = discovery.databases.find((item) => item.name === plan.target.database);
    const tables = discovery.tables.filter((item) => item.database === plan.target.database);
    if (!targetDatabase || tables.length !== plan.source.selection.tables.length) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_OBJECT_MISMATCH', 'The restored ClickHouse database or table count does not match the authenticated backup.', { category: 'integrity' });
    const mappings = [];
    const checks = [];
    for (const sourceTable of plan.source.selection.tables) {
      const targetTable = tables.find((item) => item.name === sourceTable.name);
      if (!targetTable || targetTable.engine !== sourceTable.engine) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_OBJECT_MISMATCH', 'A restored ClickHouse table name or engine does not match the authenticated backup.', { category: 'integrity' });
      if (plan.target.sameDeployment && targetTable.uuid === sourceTable.uuid) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_UUID_COLLISION', 'A restored table reused the protected table UUID on the same deployment.', { category: 'integrity' });
      const expected = plan.source.selection.statistics.find((item) => item.table === sourceTable.name);
      const actualPartitions = discovery.partitions.filter((item) => item.database === plan.target.database && item.table === sourceTable.name);
      const actual = { partCount: actualPartitions.reduce((sum, item) => sum + item.partCount, 0), rowCount: actualPartitions.reduce((sum, item) => sum + item.rowCount, 0), partitionCount: actualPartitions.length };
      if (actual.partCount !== expected.partCount || actual.rowCount !== expected.rowCount || actual.partitionCount !== expected.partitionCount) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_COUNT_MISMATCH', 'Restored ClickHouse row, part, or partition evidence does not match the authenticated backup.', { category: 'integrity' });
      const query = `SELECT count() AS sample_count FROM (SELECT 1 FROM ${quoteIdentifier(plan.target.database)}.${quoteIdentifier(sourceTable.name)} LIMIT 1) FORMAT JSONEachRow`;
      const sample = parseJsonRows((await command(context, { ...plan.connection, expectedDeploymentFingerprint: null }, query)).stdout, 'ClickHouse restored-table bounded query');
      if (sample.length !== 1 || ![0, 1].includes(boundedInteger(sample[0].sample_count, 'ClickHouse bounded query result', 1))) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_QUERY_INVALID', 'A bounded query against a restored ClickHouse table returned invalid evidence.', { category: 'integrity' });
      mappings.push({ sourceDatabase: sourceTable.database, sourceTable: sourceTable.name, sourceUuid: sourceTable.uuid, targetDatabase: plan.target.database, targetTable: targetTable.name, targetUuid: targetTable.uuid, engine: targetTable.engine, ...actual });
      checks.push({ id: `table:${sourceTable.name}`, status: 'pass', safeMessage: 'Name, UUID mapping, engine, row/part counts, and bounded query validated.' });
    }
    return { valid: true, status: 'succeeded', nativeIntegrityValidation: true, checks, database: { sourceName: plan.source.selection.database.name, sourceUuid: plan.source.selection.database.uuid, targetName: targetDatabase.name, targetUuid: targetDatabase.uuid }, mappings, operation: result.status };
  }

  async reconcileRestore(context = {}, input = {}) {
    const operationId = requiredText(input.operationId, 'ClickHouse restore operation ID', 200);
    const destinationName = requiredText(input.destinationName, 'ClickHouse restore destination name', 4096);
    const response = await command(context, normalizeConfig(input.connection), backupStatusQuery(operationId));
    const status = normalizeRestoreStatus(parseJsonRows(response.stdout, 'ClickHouse restore reconciliation status'), operationId, destinationName);
    const terminal = ['RESTORED', 'RESTORE_FAILED', 'RESTORE_CANCELLED', 'RESTORE_CANCELED'].includes(status.status);
    if (!terminal && status.status !== 'RESTORING') throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_STATUS_INVALID', 'ClickHouse native restore entered an unsupported state.', { category: 'integrity' });
    if (status.status === 'RESTORED' && (status.entries < 1 || status.filesRead < 1 || status.bytesRead < 1)) throw new DatabaseAdapterError('CLICKHOUSE_RESTORE_EVIDENCE_INVALID', 'ClickHouse completed restore without valid native read and entry evidence.', { category: 'integrity' });
    return Object.freeze({ version: 1, operationId, status, terminal, targetPreserved: true });
  }
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class ClickHouseConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new ClickHouseAdapter(), sessionFactory = openSshExecutionSession, localCommandRunner = runLocalCommand, fileSystem = fs, temporaryRoot = os.tmpdir(), clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase; this.secretStore = secretStore; this.deviceId = requiredText(deviceId, 'Device ID', 200); this.adapter = adapter; this.sessionFactory = sessionFactory; this.localCommandRunner = localCommandRunner; this.fileSystem = fileSystem; this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'ClickHouse temporary root')); this.clock = clock;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { includeDeleted: false, limit: 1000 })).filter((record) => record.adapterId === ADAPTER_ID).map((record) => ({ ...record, capabilities: this.adapter.manifest().capabilities, currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const actor = requiredText(actorId, 'Actor ID', 200); const name = requiredText(input.name, 'ClickHouse connection name', 200);
    const password = input.password === undefined || input.password === null || input.password === '' ? null : String(input.password);
    if (password && (password.includes('\0') || password.length > 16384)) throw new TypeError('ClickHouse password is invalid.');
    let passwordRef = null;
    try {
      if (password) passwordRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} password`, secretType: 'password', value: password, scope: 'device' });
      const config = normalizeConfig({ executionMode: input.executionMode, sshConnectionId: input.sshConnectionId, host: input.host, port: input.port, tlsMode: input.tlsMode, username: input.username, passwordSecretRefId: passwordRef?.id, clientPath: input.clientPath, timeoutMs: input.timeoutMs });
      if (config.executionMode === 'ssh') await this.#validatedSshConnection(tenant, config.sshConnectionId);
      const { passwordSecretRefId: _secretRefId, ...endpoint } = config;
      return await this.controlDatabase.transaction((transaction) => {
        if (passwordRef) transaction.create('secretRef', secretMetadataInput(passwordRef, actor));
        return transaction.create('connection', { workspaceId: tenant, actorId: actor, name, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, scope: 'device', endpoint, secretRefIds: passwordRef ? [passwordRef.id] : [], trust: { mode: config.executionMode, fingerprint: null }, workerAffinity: [`device:${this.deviceId}`], lastTest: null });
      });
    } catch (error) { if (passwordRef) await this.secretStore.delete({ workspaceId: tenant, id: passwordRef.id }).catch(() => {}); throw error; }
  }

  config(connection) { return normalizeConfig({ ...connection.endpoint, passwordSecretRefId: connection.secretRefIds?.[0] || null }); }

  async #validatedSshConnection(workspaceId, connectionId) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, connectionId);
    if (!connection || connection.adapterId !== 'deployerx.connection.ssh') throw new Error('The paired SSH connection was not found.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('The paired SSH connection belongs to another device.');
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new Error('Test and approve the paired SSH connection before ClickHouse discovery.');
    return connection;
  }

  async withExecution(workspaceId, connection, signal, callback) {
    const config = this.config(connection); let session = null; let configPath = null; let localDirectory = null; let cleanupFailed = false;
    try {
      if (config.executionMode === 'ssh') {
        const sshConnection = await this.#validatedSshConnection(workspaceId, config.sshConnectionId);
        session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal });
      }
      const password = config.passwordSecretRefId ? await this.secretStore.resolve({ workspaceId, id: config.passwordSecretRefId }) : null;
      const contents = clientConfigContents(config, password);
      if (session) { configPath = `/tmp/deployerx-clickhouse-${crypto.randomBytes(16).toString('hex')}.xml`; await session.writeFile(configPath, contents, { mode: 0o600 }); }
      else { localDirectory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, 'deployerx-clickhouse-')); configPath = path.join(localDirectory, 'client.xml'); await this.fileSystem.writeFile(configPath, contents, { mode: 0o600 }); await this.fileSystem.chmod(configPath, 0o600); }
      const context = { signal, clickhouseConfigPath: configPath, runNativeCommand: session ? ({ executable, args, timeoutMs }) => new Promise((resolve, reject) => {
        let settled = false; const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
        const timer = setTimeout(() => { session.close(); finish(new DatabaseAdapterError('CLICKHOUSE_COMMAND_TIMEOUT', 'A ClickHouse command timed out.', { category: 'timeout', retryable: true })); }, timeoutMs);
        session.run(commandFromArgs(executable, args), { stdoutLimitBytes: MAX_OUTPUT_BYTES, stderrLimitBytes: MAX_OUTPUT_BYTES }).then((value) => finish(null, value), (error) => finish(error));
      }) : this.localCommandRunner };
      return await callback(context, config);
    } finally {
      if (session && configPath) { try { await session.run(commandFromArgs('rm', ['-f', '--', configPath]), { ignoreAbort: true, stdoutLimitBytes: 4096, stderrLimitBytes: 4096 }); } catch { cleanupFailed = true; } }
      if (localDirectory) { try { await this.fileSystem.rm(localDirectory, { recursive: true, force: true }); } catch { cleanupFailed = true; } }
      session?.close();
      if (cleanupFailed) throw new DatabaseAdapterError('CLICKHOUSE_CREDENTIAL_CLEANUP_FAILED', 'Temporary ClickHouse client configuration cleanup could not be proven.', { category: 'integrity' });
    }
  }

  async test(workspaceId, connectionId, actorId = 'system', signal) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const id = requiredText(connectionId, 'Connection ID', 200); const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('ClickHouse connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This ClickHouse connection belongs to another device.');
    const { result, inventory } = await this.withExecution(tenant, current, signal, async (context, config) => {
      const tested = await this.adapter.testConnection(context, config);
      if (tested.status !== 'success') return { result: tested, inventory: null };
      const pages = []; for await (const page of this.adapter.discover(context, { connection: config, kind: 'all' })) pages.push(page);
      if (pages.length !== 1 || pages[0].deploymentFingerprint !== tested.endpointIdentity.deploymentFingerprint || pages[0].topologyFingerprint !== tested.endpointIdentity.topologyFingerprint) throw new DatabaseAdapterError('CLICKHOUSE_INVENTORY_CHANGED', 'ClickHouse identity changed while inventory was being captured.', { category: 'integrity' });
      return { result: tested, inventory: { version: 1, capturedAt: tested.testedAt, productVersion: pages[0].version.text, deploymentFingerprint: pages[0].deploymentFingerprint, topologyFingerprint: pages[0].topologyFingerprint, databases: pages[0].databases, tables: pages[0].tables, clusters: pages[0].clusters, replicas: pages[0].replicas, partitions: pages[0].partitions, disks: pages[0].disks, namedCollections: pages[0].namedCollections, grants: pages[0].grants, capabilities: pages[0].capabilities } };
    });
    if (result.status === 'success') for (const secretRefId of current.secretRefIds || []) { const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId }); const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId); if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId }); }
    const endpoint = result.status === 'success' ? { ...current.endpoint, expectedVersion: result.endpointIdentity.version, expectedDeploymentFingerprint: result.endpointIdentity.deploymentFingerprint, expectedTopologyFingerprint: result.endpointIdentity.topologyFingerprint } : current.endpoint;
    const trust = result.status === 'success' ? { mode: current.endpoint.executionMode, fingerprint: result.endpointIdentity.deploymentFingerprint, topologyFingerprint: result.endpointIdentity.topologyFingerprint, observedAt: result.testedAt } : current.trust;
    const trustedDisk = inventory && current.clickhouseDestinationTrust
      ? inventory.disks.find((disk) => disk.name === current.clickhouseDestinationTrust.diskName && destinationFingerprint(disk) === current.clickhouseDestinationTrust.destinationFingerprint && !disk.readOnly && !disk.writeOnce)
      : null;
    const clickhouseDestinationTrust = result.status === 'success' && trustedDisk && current.clickhouseDestinationTrust.deploymentFingerprint === result.endpointIdentity.deploymentFingerprint && current.clickhouseDestinationTrust.topologyFingerprint === result.endpointIdentity.topologyFingerprint ? current.clickhouseDestinationTrust : null;
    const updated = await this.controlDatabase.repository('connection').update(tenant, id, { endpoint, lastTest: result, trust, clickhouseInventory: inventory || current.clickhouseInventory || null, clickhouseDestinationTrust, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection: updated, result };
  }

  async discover(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const current = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'Connection ID', 200));
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('ClickHouse connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This ClickHouse connection belongs to another device.');
    if (current.lastTest?.status !== 'success' || current.trust?.fingerprint !== current.lastTest?.endpointIdentity?.deploymentFingerprint) throw new Error('Test the ClickHouse connection successfully before discovery.');
    return this.withExecution(tenant, current, input.signal, async (context, config) => { const pages = []; for await (const page of this.adapter.discover(context, { connection: config, kind: input.kind || 'all' })) pages.push(page); if (pages.length !== 1) throw new Error('ClickHouse discovery returned an invalid page count.'); return pages[0]; });
  }

  async approveDestination(workspaceId, connectionId, input = {}, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    if (String(input.confirmationText || '').trim() !== DESTINATION_CONFIRMATION) throw new TypeError(`Type ${DESTINATION_CONFIRMATION} to approve this ClickHouse backup disk.`);
    const diskName = requiredText(input.diskName, 'ClickHouse backup disk name', 255);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('ClickHouse connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This ClickHouse connection belongs to another device.');
    if (current.lastTest?.status !== 'success' || !current.trust?.fingerprint || current.trust.fingerprint !== current.endpoint?.expectedDeploymentFingerprint || current.trust.topologyFingerprint !== current.endpoint?.expectedTopologyFingerprint) throw new Error('Test the ClickHouse connection successfully before approving a backup disk.');
    const discovery = await this.withExecution(tenant, current, input.signal, (context, config) => readDiscovery(context, config));
    const matches = discovery.disks.filter((disk) => disk.name === diskName);
    if (matches.length !== 1 || matches[0].readOnly || matches[0].writeOnce) throw new TypeError('Choose one discovered writable, non-write-once ClickHouse disk.');
    if (discovery.deploymentFingerprint !== current.trust.fingerprint || discovery.topologyFingerprint !== current.trust.topologyFingerprint) throw new DatabaseAdapterError('CLICKHOUSE_DEPLOYMENT_CHANGED', 'ClickHouse identity changed while approving the backup disk.', { category: 'integrity' });
    const disk = matches[0];
    const destinationTrust = Object.freeze({
      version: 1, destinationType: 'disk', diskName: disk.name, diskType: disk.type,
      pathFingerprint: stableDigest(disk.path || ''), totalBytes: disk.totalBytes,
      destinationFingerprint: destinationFingerprint(disk), deploymentFingerprint: discovery.deploymentFingerprint,
      topologyFingerprint: discovery.topologyFingerprint, approvedAt: this.clock()
    });
    const connection = await this.controlDatabase.repository('connection').update(tenant, id, { clickhouseDestinationTrust: destinationTrust }, { expectedRevision: current.revision, actorId: actor });
    return { connection, destinationTrust };
  }
}

module.exports = { ADAPTER_ID, ADAPTER_VERSION, DESTINATION_CONFIRMATION, RESTORE_CONFIRMATION, SUPPORTED_TABLE_ENGINES, ClickHouseAdapter, ClickHouseConnectionService, QUERIES, clientConfigContents, destinationFingerprint, normalizeBackupExecution, normalizeConfig, parseJsonRows, parseVersion, readDiscovery };
