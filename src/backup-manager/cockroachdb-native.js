const crypto = require('crypto');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID, normalizeConfig, parseTsv, readDiscovery, runSqlCommand } = require('./cockroachdb');

const CONTROLLER_VERSION = '0.1.0';
const MAX_INCREMENTALS = 48;
const MIN_INCREMENTAL_CADENCE_MS = 5 * 60 * 1000;
const MIN_AS_OF_LAG_MS = 10 * 1000;
const MAX_AS_OF_LAG_SECONDS = 24 * 60 * 60;
const MAX_TABLES = 100;
const MAX_LOCALITIES = 16;
const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'canceled', 'revert-failed']);
const JOB_STATES = new Set(['pending', 'paused', 'pause-requested', 'failed', 'succeeded', 'canceled', 'cancel-requested', 'running', 'retry-running', 'retry-reverting', 'reverting', 'revert-failed']);

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function plainObject(value, label, allowedFields = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  if (allowedFields) {
    const unknown = Object.keys(value).filter((key) => !allowedFields.includes(key));
    if (unknown.length) throw new TypeError(`Unknown ${label} field: ${unknown[0]}.`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TypeError(`${label} is invalid.`);
  return number;
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeFingerprint(value, label) {
  const fingerprint = requiredText(value, label, 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new TypeError(`${label} is invalid.`);
  return fingerprint;
}

function normalizeTimestamp(value, label, nullable = false) {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  const date = new Date(requiredText(value, label, 100));
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} is invalid.`);
  return date.toISOString();
}

function normalizeJobId(value, label = 'CockroachDB job ID') {
  const jobId = requiredText(value, label, 40);
  if (!/^[1-9][0-9]{0,38}$/.test(jobId)) throw new TypeError(`${label} must be an exact positive numeric identifier.`);
  return jobId;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function quoteIdentifier(value, label = 'CockroachDB identifier') {
  return `"${requiredText(value, label, 256).replace(/"/g, '""')}"`;
}

function quoteSqlString(value, label = 'CockroachDB SQL value') {
  return `'${requiredText(value, label, 4096).replace(/'/g, "''")}'`;
}

function normalizeSelection(input = {}) {
  const raw = plainObject(input, 'CockroachDB selection', ['scope', 'database', 'tables']);
  const scope = String(raw.scope || '').toLowerCase();
  if (!['cluster', 'database', 'table'].includes(scope)) throw new TypeError('CockroachDB selection scope is invalid.');
  if (scope === 'cluster') {
    if (raw.database !== undefined || raw.tables !== undefined) throw new TypeError('CockroachDB cluster selection cannot include database or table fields.');
    return deepFreeze({ scope: 'cluster', database: null, tables: [], fingerprint: stableDigest({ scope: 'cluster' }) });
  }
  if (scope === 'database') {
    if (raw.tables !== undefined) throw new TypeError('CockroachDB database selection cannot include table fields.');
    const database = requiredText(raw.database, 'CockroachDB selected database', 256);
    return deepFreeze({ scope: 'database', database, tables: [], fingerprint: stableDigest({ scope: 'database', database }) });
  }
  if (raw.database !== undefined || !Array.isArray(raw.tables) || raw.tables.length < 1 || raw.tables.length > MAX_TABLES) throw new TypeError(`CockroachDB table selection requires between 1 and ${MAX_TABLES} whole tables.`);
  const tables = raw.tables.map((item) => {
    const table = plainObject(item, 'CockroachDB table selection', ['database', 'schema', 'name']);
    return {
      database: requiredText(table.database, 'CockroachDB table database', 256),
      schema: optionalText(table.schema, 'CockroachDB table schema', 256) || 'public',
      name: requiredText(table.name, 'CockroachDB table name', 256)
    };
  }).sort((left, right) => `${left.database}\0${left.schema}\0${left.name}`.localeCompare(`${right.database}\0${right.schema}\0${right.name}`, 'en-US'));
  const identities = tables.map((table) => `${table.database}\0${table.schema}\0${table.name}`);
  if (new Set(identities).size !== tables.length) throw new TypeError('CockroachDB table selection contains duplicate identities.');
  return deepFreeze({ scope: 'table', database: null, tables, fingerprint: stableDigest({ scope: 'table', tables }) });
}

function normalizeLocality(value) {
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

function normalizeDestination(input = {}) {
  const raw = plainObject(input, 'CockroachDB destination', ['type', 'externalConnectionName', 'localities', 'expectedDestinationFingerprint']);
  if (String(raw.type || '') !== 'external-connection') throw new TypeError('CockroachDB native backup currently supports external connections only.');
  if (raw.externalConnectionName && raw.localities !== undefined) throw new TypeError('CockroachDB destination cannot mix one external connection with locality bindings.');
  let localities;
  if (raw.externalConnectionName) localities = [{ locality: 'default', externalConnectionName: normalizeExternalConnectionName(raw.externalConnectionName) }];
  else {
    if (!Array.isArray(raw.localities) || raw.localities.length < 1 || raw.localities.length > MAX_LOCALITIES) throw new TypeError(`CockroachDB destination requires between 1 and ${MAX_LOCALITIES} external connection locality bindings.`);
    localities = raw.localities.map((item) => {
      const binding = plainObject(item, 'CockroachDB locality binding', ['locality', 'externalConnectionName']);
      return { locality: normalizeLocality(binding.locality), externalConnectionName: normalizeExternalConnectionName(binding.externalConnectionName) };
    });
  }
  localities.sort((left, right) => left.locality === 'default' ? -1 : right.locality === 'default' ? 1 : left.locality.localeCompare(right.locality, 'en-US'));
  if (new Set(localities.map((item) => item.locality)).size !== localities.length || new Set(localities.map((item) => item.externalConnectionName)).size !== localities.length) throw new TypeError('CockroachDB backup localities and external connections must be unique.');
  if (localities.length > 1 && localities.filter((item) => item.locality === 'default').length !== 1) throw new TypeError('CockroachDB locality-aware backup requires exactly one default locality.');
  if (localities.length === 1 && localities[0].locality !== 'default') throw new TypeError('A single CockroachDB backup destination must use the default locality.');
  const localityFingerprint = stableDigest(localities);
  const destinationFingerprint = stableDigest({ type: 'external-connection', localities });
  if (raw.expectedDestinationFingerprint && normalizeFingerprint(raw.expectedDestinationFingerprint, 'Expected CockroachDB destination fingerprint') !== destinationFingerprint) throw new TypeError('CockroachDB destination identity changed.');
  return deepFreeze({ type: 'external-connection', localityAware: localities.length > 1, localities, localityFingerprint, destinationFingerprint });
}

function normalizeBinding(input = {}) {
  const raw = plainObject(input, 'CockroachDB deployment binding', ['clusterId', 'deploymentFingerprint', 'topologyFingerprint', 'inventoryFingerprint', 'connectionRevision']);
  const clusterId = requiredText(raw.clusterId, 'CockroachDB bound cluster ID', 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clusterId)) throw new TypeError('CockroachDB bound cluster ID is invalid.');
  return deepFreeze({
    clusterId,
    deploymentFingerprint: normalizeFingerprint(raw.deploymentFingerprint, 'CockroachDB bound deployment fingerprint'),
    topologyFingerprint: normalizeFingerprint(raw.topologyFingerprint, 'CockroachDB bound topology fingerprint'),
    inventoryFingerprint: normalizeFingerprint(raw.inventoryFingerprint, 'CockroachDB bound inventory fingerprint'),
    connectionRevision: positiveInteger(raw.connectionRevision, 'CockroachDB connection revision')
  });
}

function normalizeExecution(input = {}) {
  const raw = plainObject(input, 'CockroachDB execution', ['workspaceId', 'sourceId', 'executionId', 'connectionRevision']);
  return deepFreeze({
    workspaceId: requiredText(raw.workspaceId, 'Workspace ID', 200),
    sourceId: requiredText(raw.sourceId, 'CockroachDB Source ID', 200),
    executionId: requiredText(raw.executionId, 'CockroachDB execution ID', 200),
    connectionRevision: positiveInteger(raw.connectionRevision, 'CockroachDB execution connection revision')
  });
}

function normalizeAsOf(input, nowMs) {
  if (!Number.isFinite(nowMs)) throw new TypeError('CockroachDB clock is invalid.');
  if (input.asOfTimestamp !== undefined && input.asOfLagSeconds !== undefined) throw new TypeError('CockroachDB AS OF SYSTEM TIME accepts a timestamp or a safe lag, not both.');
  let timestamp;
  if (input.asOfTimestamp !== undefined) timestamp = normalizeTimestamp(input.asOfTimestamp, 'CockroachDB AS OF SYSTEM TIME timestamp');
  else {
    const lagSeconds = Number(input.asOfLagSeconds ?? 10);
    if (!Number.isInteger(lagSeconds) || lagSeconds < 10 || lagSeconds > MAX_AS_OF_LAG_SECONDS) throw new TypeError('CockroachDB AS OF SYSTEM TIME lag must be between 10 seconds and 24 hours.');
    timestamp = new Date(nowMs - lagSeconds * 1000).toISOString();
  }
  if (nowMs - new Date(timestamp).getTime() < MIN_AS_OF_LAG_MS) throw new TypeError('CockroachDB AS OF SYSTEM TIME must be at least 10 seconds in the past.');
  return timestamp;
}

function normalizeParentChain(input, expected) {
  if (expected.backupMode === 'full') {
    if (input !== undefined && input !== null) throw new TypeError('CockroachDB full backup cannot include incremental parent evidence.');
    return null;
  }
  const raw = plainObject(input, 'CockroachDB incremental chain', [
    'version', 'rootExecutionId', 'headExecutionId', 'incrementalCount', 'lastAsOfTimestamp', 'clusterId',
    'deploymentFingerprint', 'topologyFingerprint', 'destinationFingerprint', 'localityFingerprint',
    'selectionFingerprint', 'revisionHistory', 'encryptionMode'
  ]);
  if (Number(raw.version) !== 1) throw new TypeError('CockroachDB incremental chain version is unsupported.');
  const normalized = {
    version: 1,
    rootExecutionId: requiredText(raw.rootExecutionId, 'CockroachDB chain root execution ID', 200),
    headExecutionId: requiredText(raw.headExecutionId, 'CockroachDB chain head execution ID', 200),
    incrementalCount: positiveInteger(raw.incrementalCount, 'CockroachDB incremental count', MAX_INCREMENTALS, 0),
    lastAsOfTimestamp: normalizeTimestamp(raw.lastAsOfTimestamp, 'CockroachDB parent backup timestamp'),
    clusterId: requiredText(raw.clusterId, 'CockroachDB chain cluster ID', 36).toLowerCase(),
    deploymentFingerprint: normalizeFingerprint(raw.deploymentFingerprint, 'CockroachDB chain deployment fingerprint'),
    topologyFingerprint: normalizeFingerprint(raw.topologyFingerprint, 'CockroachDB chain topology fingerprint'),
    destinationFingerprint: normalizeFingerprint(raw.destinationFingerprint, 'CockroachDB chain destination fingerprint'),
    localityFingerprint: normalizeFingerprint(raw.localityFingerprint, 'CockroachDB chain locality fingerprint'),
    selectionFingerprint: normalizeFingerprint(raw.selectionFingerprint, 'CockroachDB chain selection fingerprint'),
    revisionHistory: raw.revisionHistory === true,
    encryptionMode: String(raw.encryptionMode || '')
  };
  if (normalized.incrementalCount >= MAX_INCREMENTALS) throw new DatabaseAdapterError('COCKROACH_INCREMENTAL_LIMIT_REACHED', `CockroachDB supports at most ${MAX_INCREMENTALS} incrementals in an uncompacted manual chain.`, { category: 'capacity' });
  const comparisons = [
    ['clusterId', expected.binding.clusterId], ['deploymentFingerprint', expected.binding.deploymentFingerprint],
    ['topologyFingerprint', expected.binding.topologyFingerprint], ['destinationFingerprint', expected.destination.destinationFingerprint],
    ['localityFingerprint', expected.destination.localityFingerprint], ['selectionFingerprint', expected.selection.fingerprint],
    ['encryptionMode', expected.encryptionMode]
  ];
  if (comparisons.some(([key, value]) => normalized[key] !== value) || normalized.revisionHistory !== expected.revisionHistory) throw new DatabaseAdapterError('COCKROACH_INCREMENTAL_CHAIN_CHANGED', 'CockroachDB incremental parent evidence does not match the current cluster, scope, destination, locality, revision-history, or encryption identity.', { category: 'integrity' });
  if (new Date(expected.asOfTimestamp).getTime() - new Date(normalized.lastAsOfTimestamp).getTime() < MIN_INCREMENTAL_CADENCE_MS) throw new DatabaseAdapterError('COCKROACH_INCREMENTAL_CADENCE_INVALID', 'CockroachDB manual incrementals must be at least five minutes apart.', { category: 'compatibility' });
  return deepFreeze(normalized);
}

function normalizeBackupRequest(input = {}, nowMs = Date.now()) {
  const raw = plainObject(input, 'CockroachDB native backup request', [
    'connection', 'binding', 'selection', 'destination', 'backupMode', 'asOfTimestamp', 'asOfLagSeconds',
    'revisionHistory', 'encryptionMode', 'execution', 'parentChain'
  ]);
  const connection = normalizeConfig(raw.connection);
  const binding = normalizeBinding(raw.binding);
  const selection = normalizeSelection(raw.selection);
  const destination = normalizeDestination(raw.destination);
  const execution = normalizeExecution(raw.execution);
  const backupMode = String(raw.backupMode || '').toLowerCase();
  if (!['full', 'incremental'].includes(backupMode)) throw new TypeError('CockroachDB native backup mode is invalid.');
  if (binding.connectionRevision !== execution.connectionRevision) throw new TypeError('CockroachDB connection revision changed before planning.');
  const revisionHistory = raw.revisionHistory === true;
  const encryptionMode = String(raw.encryptionMode || 'none').toLowerCase();
  if (encryptionMode !== 'none') throw new DatabaseAdapterError('COCKROACH_ENCRYPTION_MODE_NOT_READY', 'This CockroachDB native slice currently admits only unencrypted external-connection backups.', { category: 'compatibility' });
  const asOfTimestamp = normalizeAsOf(raw, nowMs);
  const partial = { connection, binding, selection, destination, backupMode, asOfTimestamp, revisionHistory, encryptionMode, execution };
  const parentChain = normalizeParentChain(raw.parentChain, partial);
  const chainEvidence = deepFreeze({
    rootExecutionId: backupMode === 'full' ? execution.executionId : parentChain.rootExecutionId,
    parentExecutionId: backupMode === 'full' ? null : parentChain.headExecutionId,
    chainIndex: backupMode === 'full' ? 0 : parentChain.incrementalCount + 1,
    maximumIncrementals: MAX_INCREMENTALS,
    previousAsOfTimestamp: parentChain?.lastAsOfTimestamp || null
  });
  return deepFreeze({ ...partial, parentChain, chainEvidence });
}

function destinationSql(destination) {
  const values = destination.localities.map((binding) => quoteSqlString(`external://${binding.externalConnectionName}`, 'CockroachDB external connection URI'));
  return values.length === 1 ? values[0] : `(${values.join(', ')})`;
}

function buildBackupStatement(input = {}) {
  const request = input.connection ? input : normalizeBackupRequest(input);
  let target = '';
  if (request.selection.scope === 'database') target = ` DATABASE ${quoteIdentifier(request.selection.database, 'CockroachDB database')}`;
  if (request.selection.scope === 'table') target = ` TABLE ${request.selection.tables.map((table) => [table.database, table.schema, table.name].map((name) => quoteIdentifier(name, 'CockroachDB table identifier')).join('.')).join(', ')}`;
  const destination = request.backupMode === 'full' ? `INTO ${destinationSql(request.destination)}` : `INTO LATEST IN ${destinationSql(request.destination)}`;
  const options = request.revisionHistory ? 'revision_history, detached' : 'detached';
  return `BACKUP${target} ${destination} AS OF SYSTEM TIME ${quoteSqlString(request.asOfTimestamp, 'CockroachDB backup timestamp')} WITH ${options}`;
}

function privilegeQuery(selection, table = null) {
  if (selection.scope === 'database') return `SELECT has_database_privilege(current_user, ${quoteSqlString(selection.database)}, 'BACKUP')::STRING AS allowed`;
  if (selection.scope === 'table') {
    const qualified = [table.database, table.schema, table.name].map((name) => quoteIdentifier(name)).join('.');
    return `SELECT has_table_privilege(current_user, ${quoteSqlString(qualified)}, 'BACKUP')::STRING AS allowed`;
  }
  return null;
}

function parseAllowed(output, label) {
  const rows = parseTsv(output, label);
  if (!Array.isArray(rows.columns) || rows.columns.length !== 1 || rows.columns[0] !== 'allowed' || rows.length !== 1 || !['true', 't', '1', 'false', 'f', '0'].includes(String(rows[0].allowed).toLowerCase())) throw new DatabaseAdapterError('COCKROACH_PRIVILEGE_EVIDENCE_INVALID', `${label} returned invalid privilege evidence.`, { category: 'integrity' });
  return ['true', 't', '1'].includes(String(rows[0].allowed).toLowerCase());
}

function assertBoundDiscovery(discovery, binding) {
  if (discovery.clusterId !== binding.clusterId || discovery.deploymentFingerprint !== binding.deploymentFingerprint || discovery.topologyFingerprint !== binding.topologyFingerprint || discovery.inventoryFingerprint !== binding.inventoryFingerprint) throw new DatabaseAdapterError('COCKROACH_SOURCE_IDENTITY_CHANGED', 'CockroachDB cluster, topology, or capability identity changed after Source approval.', { category: 'integrity' });
}

function assertCompletionIdentity(discovery, binding, currentUser) {
  if (discovery.clusterId !== binding.clusterId || discovery.deploymentFingerprint !== binding.deploymentFingerprint || discovery.topologyFingerprint !== binding.topologyFingerprint || discovery.currentUser !== currentUser) throw new DatabaseAdapterError('COCKROACH_COMPLETION_IDENTITY_CHANGED', 'CockroachDB cluster, deployment, topology, or user identity changed before completion evidence was accepted.', { category: 'integrity' });
}

function assertSelectionInventory(discovery, selection) {
  const databases = new Set(discovery.databases.map((database) => database.name));
  if (selection.scope === 'database' && !databases.has(selection.database)) throw new DatabaseAdapterError('COCKROACH_SELECTION_CHANGED', 'The selected CockroachDB database no longer exists.', { category: 'integrity' });
  if (selection.scope === 'table' && selection.tables.some((table) => !databases.has(table.database))) throw new DatabaseAdapterError('COCKROACH_SELECTION_CHANGED', 'A CockroachDB table selection references a database that no longer exists.', { category: 'integrity' });
}

function assertDestinationInventory(discovery, destination) {
  if (!discovery.capabilities.externalConnectionsVisible) throw new DatabaseAdapterError('COCKROACH_EXTERNAL_CONNECTION_UNPROVEN', 'CockroachDB external connection inventory is unavailable.', { category: 'authorization' });
  const names = new Set(discovery.externalConnections.map((connection) => connection.name));
  if (destination.localities.some((binding) => !names.has(binding.externalConnectionName))) throw new DatabaseAdapterError('COCKROACH_EXTERNAL_CONNECTION_CHANGED', 'An approved CockroachDB external connection no longer exists.', { category: 'integrity' });
}

function validatePlanDigest(plan) {
  const { planDigest, ...unsigned } = plan;
  if (normalizeFingerprint(planDigest, 'CockroachDB plan digest') !== stableDigest(unsigned)) throw new DatabaseAdapterError('COCKROACH_PLAN_TAMPERED', 'CockroachDB native backup plan integrity validation failed.', { category: 'integrity' });
}

function parseDetachedJobId(output) {
  const rows = parseTsv(output, 'CockroachDB detached backup submission');
  if (!Array.isArray(rows.columns) || rows.columns.length !== 1 || rows.columns[0] !== 'job_id' || rows.length !== 1) throw new DatabaseAdapterError('COCKROACH_JOB_ID_INVALID', 'CockroachDB detached backup did not return one exact job ID.', { category: 'integrity' });
  return normalizeJobId(rows[0].job_id);
}

function jobStatusQuery(jobId) {
  const id = normalizeJobId(jobId);
  return `SELECT job_id::STRING AS job_id, job_type::STRING AS job_type, user_name::STRING AS user_name, status::STRING AS status, created::STRING AS created, COALESCE(started::STRING, '') AS started, COALESCE(finished::STRING, '') AS finished, modified::STRING AS modified, fraction_completed::STRING AS fraction_completed, COALESCE(coordinator_id::STRING, '') AS coordinator_id, (COALESCE(error, '') <> '')::STRING AS has_error FROM [SHOW JOBS] WHERE job_id = ${id}`;
}

function parseJobEvidence(output, expected = {}) {
  const rows = parseTsv(output, 'CockroachDB job reconciliation');
  const columns = ['job_id', 'job_type', 'user_name', 'status', 'created', 'started', 'finished', 'modified', 'fraction_completed', 'coordinator_id', 'has_error'];
  if (!Array.isArray(rows.columns) || rows.columns.length !== columns.length || rows.columns.some((column, index) => column !== columns[index]) || rows.length !== 1) throw new DatabaseAdapterError('COCKROACH_JOB_AMBIGUOUS', 'CockroachDB did not return one exact owned job.', { category: 'integrity' });
  const row = rows[0];
  const jobId = normalizeJobId(row.job_id);
  const status = String(row.status || '').toLowerCase();
  const fractionCompleted = Number(row.fraction_completed);
  if (row.job_type !== 'BACKUP' || expected.jobId && jobId !== expected.jobId || expected.currentUser && row.user_name !== expected.currentUser || !JOB_STATES.has(status) || !Number.isFinite(fractionCompleted) || fractionCompleted < 0 || fractionCompleted > 1) throw new DatabaseAdapterError('COCKROACH_JOB_IDENTITY_INVALID', 'CockroachDB job identity or state does not match owned backup evidence.', { category: 'integrity' });
  const evidence = {
    jobId,
    jobType: 'BACKUP',
    currentUser: requiredText(row.user_name, 'CockroachDB job user', 256),
    status,
    createdAt: normalizeTimestamp(row.created, 'CockroachDB job creation time'),
    startedAt: normalizeTimestamp(row.started, 'CockroachDB job start time', true),
    finishedAt: normalizeTimestamp(row.finished, 'CockroachDB job finish time', true),
    modifiedAt: normalizeTimestamp(row.modified, 'CockroachDB job modification time'),
    fractionCompleted,
    coordinatorId: row.coordinator_id ? positiveInteger(row.coordinator_id, 'CockroachDB job coordinator ID', 1000000) : null,
    hasError: ['true', 't', '1'].includes(String(row.has_error).toLowerCase()),
    terminal: TERMINAL_JOB_STATES.has(status)
  };
  if (!['true', 't', '1', 'false', 'f', '0'].includes(String(row.has_error).toLowerCase()) || status === 'succeeded' && (fractionCompleted !== 1 || !evidence.finishedAt)) throw new DatabaseAdapterError('COCKROACH_JOB_EVIDENCE_INVALID', 'CockroachDB returned incomplete terminal job evidence.', { category: 'integrity' });
  return deepFreeze({ ...evidence, evidenceFingerprint: stableDigest(evidence) });
}

function normalizeOwnership(input = {}) {
  const raw = plainObject(input, 'CockroachDB ownership evidence', [
    'version', 'adapterId', 'controllerVersion', 'operation', 'jobId', 'planDigest', 'clusterId', 'deploymentFingerprint',
    'topologyFingerprint', 'inventoryFingerprint', 'executionId', 'currentUser', 'selectionFingerprint',
    'destinationFingerprint', 'localityFingerprint', 'backupMode', 'chainIndex', 'rootExecutionId', 'parentExecutionId',
    'asOfTimestamp', 'revisionHistory', 'encryptionMode', 'submittedAt'
  ]);
  if (Number(raw.version) !== 1 || raw.adapterId !== ADAPTER_ID || raw.controllerVersion !== CONTROLLER_VERSION || raw.operation !== 'cockroachdb-native-backup') throw new TypeError('CockroachDB ownership evidence version is invalid.');
  return deepFreeze({
    version: 1, adapterId: ADAPTER_ID, controllerVersion: CONTROLLER_VERSION, operation: 'cockroachdb-native-backup',
    jobId: normalizeJobId(raw.jobId), planDigest: normalizeFingerprint(raw.planDigest, 'CockroachDB owned plan digest'),
    clusterId: requiredText(raw.clusterId, 'CockroachDB owned cluster ID', 36).toLowerCase(),
    deploymentFingerprint: normalizeFingerprint(raw.deploymentFingerprint, 'CockroachDB owned deployment fingerprint'),
    topologyFingerprint: normalizeFingerprint(raw.topologyFingerprint, 'CockroachDB owned topology fingerprint'),
    inventoryFingerprint: normalizeFingerprint(raw.inventoryFingerprint, 'CockroachDB owned inventory fingerprint'),
    executionId: requiredText(raw.executionId, 'CockroachDB owned execution ID', 200),
    currentUser: requiredText(raw.currentUser, 'CockroachDB owned job user', 256),
    selectionFingerprint: normalizeFingerprint(raw.selectionFingerprint, 'CockroachDB owned selection fingerprint'),
    destinationFingerprint: normalizeFingerprint(raw.destinationFingerprint, 'CockroachDB owned destination fingerprint'),
    localityFingerprint: normalizeFingerprint(raw.localityFingerprint, 'CockroachDB owned locality fingerprint'),
    backupMode: ['full', 'incremental'].includes(raw.backupMode) ? raw.backupMode : (() => { throw new TypeError('CockroachDB owned backup mode is invalid.'); })(),
    chainIndex: positiveInteger(raw.chainIndex, 'CockroachDB owned chain index', MAX_INCREMENTALS, 0),
    rootExecutionId: requiredText(raw.rootExecutionId, 'CockroachDB owned root execution ID', 200),
    parentExecutionId: optionalText(raw.parentExecutionId, 'CockroachDB owned parent execution ID', 200),
    asOfTimestamp: normalizeTimestamp(raw.asOfTimestamp, 'CockroachDB owned backup timestamp'),
    revisionHistory: raw.revisionHistory === true,
    encryptionMode: raw.encryptionMode === 'none' ? 'none' : (() => { throw new TypeError('CockroachDB owned encryption mode is invalid.'); })(),
    submittedAt: normalizeTimestamp(raw.submittedAt, 'CockroachDB submission time')
  });
}

class CockroachDbNativeBackupController {
  constructor({ clock = () => new Date().toISOString(), now = () => Date.now(), delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), pollIntervalMs = 1000, maximumWaitMs = 24 * 60 * 60 * 1000 } = {}) {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60000) throw new TypeError('CockroachDB polling interval is invalid.');
    if (!Number.isInteger(maximumWaitMs) || maximumWaitMs < 1000 || maximumWaitMs > 24 * 60 * 60 * 1000) throw new TypeError('CockroachDB maximum wait is invalid.');
    this.clock = clock;
    this.now = now;
    this.delay = delay;
    this.pollIntervalMs = pollIntervalMs;
    this.maximumWaitMs = maximumWaitMs;
    this.maximumPollAttempts = Math.ceil(maximumWaitMs / pollIntervalMs) + 1;
  }

  async #admit(context, request) {
    const discovery = await readDiscovery(context, request.connection);
    assertBoundDiscovery(discovery, request.binding);
    assertSelectionInventory(discovery, request.selection);
    assertDestinationInventory(discovery, request.destination);
    if (!discovery.capabilities.backupIntoSyntax || !discovery.capabilities.detachedJobs || !discovery.capabilities.jobsVisible || !discovery.privileges.visible || discovery.privileges.system.VIEWJOB !== true || discovery.privileges.system.CONTROLJOB !== true) throw new DatabaseAdapterError('COCKROACH_NATIVE_CAPABILITY_UNPROVEN', 'CockroachDB BACKUP INTO, detached job visibility, and exact job-control capability must be proven.', { category: 'authorization' });
    const privilegeChecks = [];
    if (request.selection.scope === 'cluster') {
      if (discovery.privileges.system.BACKUP !== true) throw new DatabaseAdapterError('COCKROACH_BACKUP_PRIVILEGE_MISSING', 'CockroachDB cluster BACKUP privilege is not proven.', { category: 'authorization' });
      privilegeChecks.push({ scope: 'cluster', allowed: true });
    } else if (request.selection.scope === 'database') {
      const response = await runSqlCommand(context, request.connection, privilegeQuery(request.selection));
      if (!parseAllowed(response.stdout, 'CockroachDB database BACKUP privilege')) throw new DatabaseAdapterError('COCKROACH_BACKUP_PRIVILEGE_MISSING', 'CockroachDB database BACKUP privilege is not proven.', { category: 'authorization' });
      privilegeChecks.push({ scope: 'database', database: request.selection.database, allowed: true });
    } else {
      for (const table of request.selection.tables) {
        const response = await runSqlCommand(context, request.connection, privilegeQuery(request.selection, table));
        if (!parseAllowed(response.stdout, 'CockroachDB table BACKUP privilege')) throw new DatabaseAdapterError('COCKROACH_BACKUP_PRIVILEGE_MISSING', 'CockroachDB whole-table BACKUP privilege is not proven.', { category: 'authorization' });
        privilegeChecks.push({ scope: 'table', ...table, allowed: true });
      }
    }
    for (const binding of request.destination.localities) await runSqlCommand(context, request.connection, `CHECK EXTERNAL CONNECTION ${quoteSqlString(`external://${binding.externalConnectionName}`, 'CockroachDB external connection URI')}`);
    const checkedAt = this.clock();
    return deepFreeze({
      checkedAt,
      currentUser: discovery.currentUser,
      productVersion: discovery.version.text,
      clusterVersion: discovery.clusterVersion.text,
      privilegeChecks,
      externalConnectionsChecked: request.destination.localities.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName })),
      checkFingerprint: stableDigest({ clusterId: discovery.clusterId, deploymentFingerprint: discovery.deploymentFingerprint, destinationFingerprint: request.destination.destinationFingerprint, selectionFingerprint: request.selection.fingerprint })
    });
  }

  async preflight(context = {}, input = {}) {
    const request = normalizeBackupRequest(input, this.now());
    const admission = await this.#admit(context, request);
    return deepFreeze({ request, admission });
  }

  async planBackup(context = {}, input = {}) {
    const { request, admission } = await this.preflight(context, input);
    const unsigned = {
      version: 1,
      operation: 'cockroachdb-native-backup',
      adapterId: ADAPTER_ID,
      controllerVersion: CONTROLLER_VERSION,
      ...request,
      admission,
      createdAt: this.clock()
    };
    return deepFreeze({ ...unsigned, planDigest: stableDigest(unsigned) });
  }

  #normalizePlan(input) {
    const plan = plainObject(input, 'CockroachDB native backup plan');
    if (plan.version !== 1 || plan.operation !== 'cockroachdb-native-backup' || plan.adapterId !== ADAPTER_ID || plan.controllerVersion !== CONTROLLER_VERSION) throw new DatabaseAdapterError('COCKROACH_PLAN_INVALID', 'CockroachDB native backup plan version is invalid.', { category: 'integrity' });
    validatePlanDigest(plan);
    const selection = plan.selection?.scope === 'cluster'
      ? { scope: 'cluster' }
      : plan.selection?.scope === 'database'
        ? { scope: 'database', database: plan.selection.database }
        : { scope: plan.selection?.scope, tables: plan.selection?.tables?.map(({ database, schema, name }) => ({ database, schema, name })) };
    const destination = {
      type: plan.destination?.type,
      localities: plan.destination?.localities?.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName }))
    };
    const request = normalizeBackupRequest({
      connection: plan.connection, binding: plan.binding, selection, destination,
      backupMode: plan.backupMode, asOfTimestamp: plan.asOfTimestamp, revisionHistory: plan.revisionHistory,
      encryptionMode: plan.encryptionMode, execution: plan.execution, parentChain: plan.parentChain
    }, this.now());
    if (JSON.stringify(request.chainEvidence) !== JSON.stringify(plan.chainEvidence)) throw new DatabaseAdapterError('COCKROACH_PLAN_INVALID', 'CockroachDB chain planning evidence changed.', { category: 'integrity' });
    return { plan, request };
  }

  #ownership(plan, admission, jobId, submittedAt) {
    return normalizeOwnership({
      version: 1, adapterId: ADAPTER_ID, controllerVersion: CONTROLLER_VERSION, operation: 'cockroachdb-native-backup',
      jobId, planDigest: plan.planDigest, clusterId: plan.binding.clusterId,
      deploymentFingerprint: plan.binding.deploymentFingerprint, topologyFingerprint: plan.binding.topologyFingerprint,
      inventoryFingerprint: plan.binding.inventoryFingerprint, executionId: plan.execution.executionId,
      currentUser: admission.currentUser, selectionFingerprint: plan.selection.fingerprint,
      destinationFingerprint: plan.destination.destinationFingerprint, localityFingerprint: plan.destination.localityFingerprint,
      backupMode: plan.backupMode, chainIndex: plan.chainEvidence.chainIndex,
      rootExecutionId: plan.chainEvidence.rootExecutionId, parentExecutionId: plan.chainEvidence.parentExecutionId,
      asOfTimestamp: plan.asOfTimestamp, revisionHistory: plan.revisionHistory, encryptionMode: plan.encryptionMode, submittedAt
    });
  }

  async #readOwnedJob(context, connection, ownership) {
    const response = await runSqlCommand(context, connection, jobStatusQuery(ownership.jobId));
    return parseJobEvidence(response.stdout, { jobId: ownership.jobId, currentUser: ownership.currentUser });
  }

  async #waitForNextPoll(context, jobId) {
    const signal = context.signal;
    if (!signal || typeof signal.addEventListener !== 'function') {
      await this.delay(this.pollIntervalMs);
      return;
    }
    if (signal.aborted) throw new DatabaseAdapterError('COCKROACH_MONITOR_CANCELED', 'CockroachDB backup monitoring was canceled; the exact owned native job remains active for reconciliation.', { category: 'canceled', details: { jobId } });
    let removeAbortListener = () => {};
    const aborted = new Promise((resolve, reject) => {
      const listener = () => reject(new DatabaseAdapterError('COCKROACH_MONITOR_CANCELED', 'CockroachDB backup monitoring was canceled; the exact owned native job remains active for reconciliation.', { category: 'canceled', details: { jobId } }));
      signal.addEventListener('abort', listener, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', listener);
    });
    try { await Promise.race([Promise.resolve().then(() => this.delay(this.pollIntervalMs)), aborted]); }
    finally { removeAbortListener(); }
  }

  async executeBackup(context = {}, input = {}) {
    const { plan, request } = this.#normalizePlan(input);
    if (typeof context.onOwnership !== 'function') throw new DatabaseAdapterError('COCKROACH_OWNERSHIP_CALLBACK_REQUIRED', 'CockroachDB detached backup requires durable ownership persistence before monitoring.', { category: 'configuration' });
    const admission = await this.#admit(context, request);
    if (context.signal?.aborted) throw new DatabaseAdapterError('COCKROACH_OPERATION_CANCELED', 'CockroachDB backup was canceled before native submission.', { category: 'canceled' });
    const submission = await runSqlCommand(context, request.connection, buildBackupStatement(request));
    const jobId = parseDetachedJobId(submission.stdout);
    const ownership = this.#ownership(plan, admission, jobId, this.clock());
    try { await context.onOwnership(ownership); }
    catch { throw new DatabaseAdapterError('COCKROACH_OWNERSHIP_PERSIST_FAILED', 'CockroachDB detached job ownership could not be persisted; the native job remains active for operator reconciliation.', { category: 'integrity' }); }
    const deadline = this.now() + this.maximumWaitMs;
    let job = null;
    let pollAttempts = 0;
    while (pollAttempts < this.maximumPollAttempts && this.now() <= deadline) {
      if (context.signal?.aborted) throw new DatabaseAdapterError('COCKROACH_MONITOR_CANCELED', 'CockroachDB backup monitoring was canceled; the exact owned native job remains active for reconciliation.', { category: 'canceled', details: { jobId } });
      pollAttempts += 1;
      job = await this.#readOwnedJob(context, request.connection, ownership);
      if (job.terminal) break;
      await this.#waitForNextPoll(context, jobId);
    }
    if (!job || !job.terminal) throw new DatabaseAdapterError('COCKROACH_BACKUP_TIMEOUT', 'CockroachDB native backup did not reach a terminal state before the monitoring deadline; ownership evidence is preserved.', { category: 'timeout', retryable: true, details: { jobId } });
    if (job.status !== 'succeeded') throw new DatabaseAdapterError('COCKROACH_BACKUP_FAILED', 'CockroachDB native backup did not succeed; collection and ownership evidence are preserved.', { category: 'execution', details: { jobId, status: job.status, hasError: job.hasError } });
    const completionConnection = { ...request.connection, expectedInventoryFingerprint: null };
    const completionDiscovery = await readDiscovery(context, completionConnection);
    assertCompletionIdentity(completionDiscovery, plan.binding, ownership.currentUser);
    const chain = deepFreeze({
      version: 1,
      rootExecutionId: plan.chainEvidence.rootExecutionId,
      headExecutionId: plan.execution.executionId,
      incrementalCount: plan.chainEvidence.chainIndex,
      lastAsOfTimestamp: plan.asOfTimestamp,
      clusterId: plan.binding.clusterId,
      deploymentFingerprint: plan.binding.deploymentFingerprint,
      topologyFingerprint: plan.binding.topologyFingerprint,
      destinationFingerprint: plan.destination.destinationFingerprint,
      localityFingerprint: plan.destination.localityFingerprint,
      selectionFingerprint: plan.selection.fingerprint,
      revisionHistory: plan.revisionHistory,
      encryptionMode: plan.encryptionMode
    });
    return deepFreeze({
      version: 1, kind: 'cockroachdb-native-backup', adapterId: ADAPTER_ID, controllerVersion: CONTROLLER_VERSION,
      backupMode: plan.backupMode, asOfTimestamp: plan.asOfTimestamp, revisionHistory: plan.revisionHistory,
      encryptionMode: plan.encryptionMode, selection: plan.selection,
      collection: { type: 'external-connection', destinationFingerprint: plan.destination.destinationFingerprint, localityFingerprint: plan.destination.localityFingerprint, localityAware: plan.destination.localityAware, localities: plan.destination.localities },
      binding: plan.binding, ownership, job, chain, completedAt: this.clock(), externalNativeMedia: true,
      publicationReady: false, restoreSupported: false
    });
  }

  async #authorizeOwnership(context, connectionInput, ownershipInput, control) {
    const connection = normalizeConfig(connectionInput);
    const ownership = normalizeOwnership(ownershipInput);
    const discovery = await readDiscovery(context, connection);
    if (discovery.clusterId !== ownership.clusterId || discovery.deploymentFingerprint !== ownership.deploymentFingerprint || discovery.topologyFingerprint !== ownership.topologyFingerprint || discovery.currentUser !== ownership.currentUser) throw new DatabaseAdapterError('COCKROACH_OWNERSHIP_CHANGED', 'CockroachDB owned job does not belong to the current cluster, topology, or user.', { category: 'integrity' });
    if (!discovery.capabilities.jobsVisible || !discovery.privileges.visible || discovery.privileges.system.VIEWJOB !== true || control && discovery.privileges.system.CONTROLJOB !== true) throw new DatabaseAdapterError('COCKROACH_JOB_PRIVILEGE_MISSING', 'CockroachDB job visibility or control privilege is not proven.', { category: 'authorization' });
    const job = await this.#readOwnedJob(context, connection, ownership);
    return { connection, ownership, job };
  }

  async reconcile(context = {}, input = {}) {
    const raw = plainObject(input, 'CockroachDB reconciliation request', ['connection', 'ownership']);
    const { ownership, job } = await this.#authorizeOwnership(context, raw.connection, raw.ownership, false);
    return deepFreeze({ version: 1, ownership, job, terminal: job.terminal, reconciledAt: this.clock(), collectionPreserved: true });
  }

  async #control(context, input, operation) {
    const raw = plainObject(input, 'CockroachDB job control request', ['connection', 'ownership']);
    const admitted = await this.#authorizeOwnership(context, raw.connection, raw.ownership, true);
    const allowed = operation === 'PAUSE' ? new Set(['pending', 'running', 'retry-running']) : operation === 'RESUME' ? new Set(['paused']) : new Set(['pending', 'paused', 'pause-requested', 'running', 'retry-running', 'retry-reverting', 'reverting']);
    if (!allowed.has(admitted.job.status)) throw new DatabaseAdapterError('COCKROACH_JOB_CONTROL_INVALID', `CockroachDB owned job cannot be ${operation.toLowerCase()}d from its current state.`, { category: 'conflict' });
    await runSqlCommand(context, admitted.connection, `${operation} JOB ${admitted.ownership.jobId}`);
    const job = await this.#readOwnedJob(context, admitted.connection, admitted.ownership);
    return deepFreeze({ version: 1, operation: operation.toLowerCase(), ownership: admitted.ownership, before: admitted.job, job, controlledAt: this.clock(), collectionPreserved: true });
  }

  async pause(context = {}, input = {}) { return this.#control(context, input, 'PAUSE'); }
  async resume(context = {}, input = {}) { return this.#control(context, input, 'RESUME'); }
  async cancel(context = {}, input = {}) { return this.#control(context, input, 'CANCEL'); }
}

module.exports = {
  CONTROLLER_VERSION,
  MAX_INCREMENTALS,
  MIN_INCREMENTAL_CADENCE_MS,
  CockroachDbNativeBackupController,
  buildBackupStatement,
  jobStatusQuery,
  normalizeBackupRequest,
  normalizeDestination,
  normalizeJobId,
  normalizeOwnership,
  normalizeSelection,
  parseDetachedJobId,
  parseJobEvidence,
  privilegeQuery,
  quoteIdentifier,
  quoteSqlString
};
