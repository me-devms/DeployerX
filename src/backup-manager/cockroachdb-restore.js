const crypto = require('crypto');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID, normalizeConfig, parseTsv, readDiscovery, runSqlCommand } = require('./cockroachdb');
const {
  normalizeDestination,
  normalizeJobId,
  normalizeSelection,
  quoteIdentifier,
  quoteSqlString
} = require('./cockroachdb-native');

const CONTROLLER_VERSION = '0.1.0';
const RESTORE_CONFIRMATION = 'RESTORE COCKROACHDB ALTERNATE';
const RESTORE_OPERATION = 'cockroachdb-native-alternate-restore';
const MAX_CHAIN_LENGTH = 49;
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

function normalizeUuid(value, label) {
  const id = requiredText(value, label, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new TypeError(`${label} is invalid.`);
  return id;
}

function normalizeTimestamp(value, label, nullable = false) {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  const date = new Date(requiredText(value, label, 100));
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} is invalid.`);
  return date.toISOString();
}

function normalizeRegions(input) {
  if (!Array.isArray(input) || input.length > 32) throw new TypeError('CockroachDB required-region evidence is invalid.');
  const regions = input.map((value) => requiredText(value, 'CockroachDB required region', 256)).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (regions.some((region) => !/^[A-Za-z0-9_.-]+$/.test(region)) || new Set(regions).size !== regions.length) throw new TypeError('CockroachDB required-region evidence is invalid.');
  return regions;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function parseVersion(value, label) {
  const text = requiredText(value, label, 100);
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) throw new TypeError(`${label} is invalid.`);
  return deepFreeze({ text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) });
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    const difference = left[key] - right[key];
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function normalizeBinding(input = {}) {
  const raw = plainObject(input, 'CockroachDB restore target binding', ['clusterId', 'deploymentFingerprint', 'topologyFingerprint', 'inventoryFingerprint', 'connectionRevision']);
  return deepFreeze({
    clusterId: normalizeUuid(raw.clusterId, 'CockroachDB target cluster ID'),
    deploymentFingerprint: normalizeFingerprint(raw.deploymentFingerprint, 'CockroachDB target deployment fingerprint'),
    topologyFingerprint: normalizeFingerprint(raw.topologyFingerprint, 'CockroachDB target topology fingerprint'),
    inventoryFingerprint: normalizeFingerprint(raw.inventoryFingerprint, 'CockroachDB target inventory fingerprint'),
    connectionRevision: positiveInteger(raw.connectionRevision, 'CockroachDB target connection revision')
  });
}

function normalizeExecution(input = {}) {
  const raw = plainObject(input, 'CockroachDB restore execution', ['workspaceId', 'restoreRunId', 'connectionRevision']);
  return deepFreeze({
    workspaceId: requiredText(raw.workspaceId, 'Workspace ID', 200),
    restoreRunId: requiredText(raw.restoreRunId, 'RestoreRun ID', 200),
    connectionRevision: positiveInteger(raw.connectionRevision, 'CockroachDB restore connection revision')
  });
}

function normalizeChain(input = {}, expected = {}) {
  const raw = plainObject(input, 'CockroachDB recovery chain', ['version', 'complete', 'points', 'revisionStartTimestamp']);
  if (Number(raw.version) !== 1 || raw.complete !== true || !Array.isArray(raw.points) || raw.points.length < 1 || raw.points.length > MAX_CHAIN_LENGTH) throw new DatabaseAdapterError('COCKROACH_RESTORE_CHAIN_INVALID', 'CockroachDB recovery requires one complete bounded native backup chain.', { category: 'integrity' });
  const seen = new Set();
  const points = raw.points.map((item, index) => {
    const point = plainObject(item, 'CockroachDB recovery chain point', ['recoveryPointId', 'parentRecoveryPointId', 'type', 'asOfTimestamp', 'verificationState', 'retained']);
    const recoveryPointId = requiredText(point.recoveryPointId, 'CockroachDB chain RecoveryPoint ID', 200);
    if (seen.has(recoveryPointId)) throw new DatabaseAdapterError('COCKROACH_RESTORE_CHAIN_INVALID', 'CockroachDB recovery chain contains duplicate RecoveryPoint identities.', { category: 'integrity' });
    seen.add(recoveryPointId);
    const type = String(point.type || '').toLowerCase();
    if (type !== (index === 0 ? 'full' : 'incremental')) throw new DatabaseAdapterError('COCKROACH_RESTORE_CHAIN_INVALID', 'CockroachDB recovery chain must begin with one full backup followed only by incrementals.', { category: 'integrity' });
    const parentRecoveryPointId = optionalText(point.parentRecoveryPointId, 'CockroachDB parent RecoveryPoint ID', 200);
    const expectedParentId = index === 0 ? null : raw.points[index - 1]?.recoveryPointId;
    if (parentRecoveryPointId !== expectedParentId || point.verificationState !== 'succeeded' || point.retained !== true) throw new DatabaseAdapterError('COCKROACH_RESTORE_CHAIN_INVALID', 'Every CockroachDB recovery ancestor must be retained, verified, and linked to its exact parent.', { category: 'integrity' });
    const asOfTimestamp = normalizeTimestamp(point.asOfTimestamp, 'CockroachDB recovery timestamp');
    if (index > 0 && new Date(asOfTimestamp).getTime() <= new Date(raw.points[index - 1].asOfTimestamp).getTime()) throw new DatabaseAdapterError('COCKROACH_RESTORE_CHAIN_INVALID', 'CockroachDB recovery timestamps must increase strictly across the chain.', { category: 'integrity' });
    return { recoveryPointId, parentRecoveryPointId, type, asOfTimestamp, verificationState: 'succeeded', retained: true };
  });
  const head = points.at(-1);
  if (head.recoveryPointId !== expected.recoveryPointId || head.type !== expected.backupMode || head.asOfTimestamp !== expected.asOfTimestamp) throw new DatabaseAdapterError('COCKROACH_RESTORE_CHAIN_INVALID', 'CockroachDB recovery head evidence does not match the selected RecoveryPoint.', { category: 'integrity' });
  const revisionStartTimestamp = normalizeTimestamp(raw.revisionStartTimestamp, 'CockroachDB revision-history start timestamp', true);
  if (expected.revisionHistory && !revisionStartTimestamp) throw new DatabaseAdapterError('COCKROACH_RESTORE_RANGE_UNPROVEN', 'CockroachDB revision-history recovery requires an authenticated restorable start timestamp.', { category: 'integrity' });
  if (!expected.revisionHistory && revisionStartTimestamp) throw new DatabaseAdapterError('COCKROACH_RESTORE_CHAIN_INVALID', 'CockroachDB non-revision backup evidence cannot claim a revision-history range.', { category: 'integrity' });
  if (revisionStartTimestamp && new Date(revisionStartTimestamp).getTime() > new Date(head.asOfTimestamp).getTime()) throw new DatabaseAdapterError('COCKROACH_RESTORE_RANGE_UNPROVEN', 'CockroachDB revision-history range is invalid.', { category: 'integrity' });
  return deepFreeze({ version: 1, complete: true, points, revisionStartTimestamp });
}

function normalizeRecoveryEvidenceCore(input = {}) {
  const raw = plainObject(input, 'CockroachDB authenticated recovery evidence', [
    'version', 'kind', 'adapterId', 'recoveryPointId', 'artifactId', 'sourceId', 'sourceClusterId',
    'sourceVersion', 'sourceClusterVersion', 'sourceDeploymentFingerprint', 'sourceTopologyFingerprint',
    'selection', 'collection', 'backupMode', 'asOfTimestamp', 'revisionHistory', 'encryptionMode',
    'consistency', 'verificationState', 'deletionEligible', 'restoreSupported', 'externalNativeMedia',
    'multiRegion', 'requiredRegions', 'dependencyPolicy', 'manifestDigest', 'artifactDigest', 'chain', 'evidenceDigest'
  ]);
  if (Number(raw.version) !== 1 || raw.kind !== 'cockroachdb-native-backup' || raw.adapterId !== ADAPTER_ID) throw new DatabaseAdapterError('COCKROACH_RECOVERY_EVIDENCE_INVALID', 'The selected evidence is not a CockroachDB native backup.', { category: 'integrity' });
  const selectionInput = plainObject(raw.selection, 'CockroachDB recovery selection');
  const selection = normalizeSelection(selectionInput.scope === 'database'
    ? { scope: 'database', database: selectionInput.database }
    : selectionInput.scope === 'cluster'
      ? { scope: 'cluster' }
      : { scope: selectionInput.scope, tables: selectionInput.tables?.map(({ database, schema, name }) => ({ database, schema, name })) });
  if (selection.scope !== 'database') throw new DatabaseAdapterError('COCKROACH_RESTORE_SCOPE_NOT_READY', 'CockroachDB recovery currently supports one complete database into an absent alternate database name.', { category: 'compatibility' });
  const collectionInput = plainObject(raw.collection, 'CockroachDB recovery collection', ['type', 'localities', 'destinationFingerprint', 'localityFingerprint', 'localityAware']);
  const collection = normalizeDestination({
    type: collectionInput.type,
    localities: collectionInput.localities,
    expectedDestinationFingerprint: collectionInput.destinationFingerprint
  });
  if (collection.localityFingerprint !== normalizeFingerprint(collectionInput.localityFingerprint, 'CockroachDB recovery locality fingerprint')) throw new DatabaseAdapterError('COCKROACH_RECOVERY_EVIDENCE_INVALID', 'CockroachDB recovery locality evidence changed.', { category: 'integrity' });
  const backupMode = String(raw.backupMode || '').toLowerCase();
  if (!['full', 'incremental'].includes(backupMode)) throw new TypeError('CockroachDB recovery backup mode is invalid.');
  const asOfTimestamp = normalizeTimestamp(raw.asOfTimestamp, 'CockroachDB RecoveryPoint timestamp');
  const revisionHistory = raw.revisionHistory === true;
  if (raw.encryptionMode !== 'none') throw new DatabaseAdapterError('COCKROACH_RESTORE_ENCRYPTION_NOT_READY', 'This CockroachDB restore slice currently accepts only unencrypted external-connection collections.', { category: 'compatibility' });
  if (raw.consistency !== 'application' || raw.verificationState !== 'succeeded' || raw.deletionEligible === true || raw.restoreSupported !== true || raw.externalNativeMedia !== true) throw new DatabaseAdapterError('COCKROACH_RECOVERY_EVIDENCE_INVALID', 'CockroachDB recovery evidence must be retained, verified, application-consistent, and explicitly restorable.', { category: 'integrity' });
  const requiredRegions = normalizeRegions(raw.requiredRegions || []);
  const multiRegion = raw.multiRegion === true;
  if (multiRegion !== (requiredRegions.length > 0)) throw new DatabaseAdapterError('COCKROACH_RESTORE_REGION_EVIDENCE_INVALID', 'CockroachDB multi-region recovery requires exact authenticated region evidence.', { category: 'integrity' });
  if (raw.dependencyPolicy !== 'reject-unresolved') throw new DatabaseAdapterError('COCKROACH_RESTORE_DEPENDENCY_POLICY_INVALID', 'CockroachDB recovery must reject unresolved cross-database dependencies.', { category: 'integrity' });
  const partial = {
    version: 1,
    kind: 'cockroachdb-native-backup',
    adapterId: ADAPTER_ID,
    recoveryPointId: requiredText(raw.recoveryPointId, 'CockroachDB RecoveryPoint ID', 200),
    artifactId: requiredText(raw.artifactId, 'CockroachDB Artifact ID', 200),
    sourceId: requiredText(raw.sourceId, 'CockroachDB Source ID', 200),
    sourceClusterId: normalizeUuid(raw.sourceClusterId, 'CockroachDB source cluster ID'),
    sourceVersion: parseVersion(raw.sourceVersion, 'CockroachDB source version').text,
    sourceClusterVersion: parseVersion(raw.sourceClusterVersion, 'CockroachDB source cluster version').text,
    sourceDeploymentFingerprint: normalizeFingerprint(raw.sourceDeploymentFingerprint, 'CockroachDB source deployment fingerprint'),
    sourceTopologyFingerprint: normalizeFingerprint(raw.sourceTopologyFingerprint, 'CockroachDB source topology fingerprint'),
    selection,
    collection,
    backupMode,
    asOfTimestamp,
    revisionHistory,
    encryptionMode: 'none',
    consistency: 'application',
    verificationState: 'succeeded',
    deletionEligible: false,
    restoreSupported: true,
    externalNativeMedia: true,
    multiRegion,
    requiredRegions,
    dependencyPolicy: 'reject-unresolved',
    manifestDigest: normalizeFingerprint(raw.manifestDigest, 'CockroachDB repository manifest digest'),
    artifactDigest: normalizeFingerprint(raw.artifactDigest, 'CockroachDB Artifact digest')
  };
  const chain = normalizeChain(raw.chain, partial);
  return deepFreeze({ ...partial, chain });
}

function sealRecoveryEvidence(input = {}) {
  const evidence = normalizeRecoveryEvidenceCore(input);
  return deepFreeze({ ...evidence, evidenceDigest: stableDigest(evidence) });
}

function normalizeRecoveryEvidence(input = {}) {
  const raw = plainObject(input, 'CockroachDB authenticated recovery evidence');
  const evidence = normalizeRecoveryEvidenceCore(raw);
  if (normalizeFingerprint(raw.evidenceDigest, 'CockroachDB recovery evidence digest') !== stableDigest(evidence)) throw new DatabaseAdapterError('COCKROACH_RECOVERY_EVIDENCE_TAMPERED', 'CockroachDB authenticated recovery evidence changed after publication.', { category: 'integrity' });
  return deepFreeze({ ...evidence, evidenceDigest: raw.evidenceDigest });
}

function normalizeRestoreTimestamp(value, recovery) {
  const timestamp = normalizeTimestamp(value || recovery.asOfTimestamp, 'CockroachDB restore timestamp');
  const requested = new Date(timestamp).getTime();
  const head = new Date(recovery.asOfTimestamp).getTime();
  if (requested > head) throw new DatabaseAdapterError('COCKROACH_RESTORE_TIMESTAMP_INVALID', 'CockroachDB restore timestamp is newer than the selected RecoveryPoint.', { category: 'compatibility' });
  const exactBoundary = recovery.chain.points.some((point) => point.asOfTimestamp === timestamp);
  if (!exactBoundary && !recovery.revisionHistory) throw new DatabaseAdapterError('COCKROACH_RESTORE_TIMESTAMP_UNAVAILABLE', 'CockroachDB point-in-time recovery between backup boundaries requires revision-history evidence.', { category: 'compatibility' });
  if (recovery.revisionHistory && requested < new Date(recovery.chain.revisionStartTimestamp).getTime()) throw new DatabaseAdapterError('COCKROACH_RESTORE_TIMESTAMP_UNAVAILABLE', 'CockroachDB restore timestamp is older than the authenticated revision-history range.', { category: 'compatibility' });
  if (!recovery.revisionHistory && requested < new Date(recovery.chain.points[0].asOfTimestamp).getTime()) throw new DatabaseAdapterError('COCKROACH_RESTORE_TIMESTAMP_UNAVAILABLE', 'CockroachDB restore timestamp is outside the authenticated backup chain.', { category: 'compatibility' });
  return timestamp;
}

function normalizeRestoreRequest(input = {}, options = {}) {
  const raw = plainObject(input, 'CockroachDB native restore request', [
    'connection', 'targetBinding', 'recovery', 'targetDatabase', 'restoreTimestamp', 'mode',
    'confirmed', 'confirmationText', 'execution'
  ]);
  if (String(raw.mode || 'alternate') !== 'alternate') throw new DatabaseAdapterError('COCKROACH_RESTORE_MODE_UNSUPPORTED', 'CockroachDB recovery currently supports an absent alternate database target only.', { category: 'compatibility' });
  if (options.requireConfirmation !== false && (raw.confirmed !== true || String(raw.confirmationText || '').trim() !== RESTORE_CONFIRMATION)) throw new DatabaseAdapterError('COCKROACH_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the CockroachDB alternate-target recovery before continuing.', { category: 'conflict' });
  const connection = normalizeConfig(raw.connection);
  const targetBinding = normalizeBinding(raw.targetBinding);
  const recovery = normalizeRecoveryEvidence(raw.recovery);
  const execution = normalizeExecution(raw.execution);
  if (targetBinding.connectionRevision !== execution.connectionRevision) throw new DatabaseAdapterError('COCKROACH_RESTORE_CONNECTION_CHANGED', 'CockroachDB target connection revision changed before recovery planning.', { category: 'integrity' });
  const targetDatabase = requiredText(raw.targetDatabase, 'CockroachDB alternate database name', 256);
  if (['system', 'defaultdb', 'postgres'].includes(targetDatabase.toLowerCase())) throw new TypeError('CockroachDB alternate database name is reserved.');
  if (targetBinding.clusterId === recovery.sourceClusterId && targetDatabase === recovery.selection.database) throw new DatabaseAdapterError('COCKROACH_SOURCE_TARGET_CONFLICT', 'CockroachDB recovery cannot replace the protected source database.', { category: 'conflict' });
  return deepFreeze({
    connection,
    targetBinding,
    recovery,
    targetDatabase,
    restoreTimestamp: normalizeRestoreTimestamp(raw.restoreTimestamp, recovery),
    mode: 'alternate',
    execution
  });
}

function destinationSql(collection) {
  const values = collection.localities.map(({ externalConnectionName }) => quoteSqlString(`external://${externalConnectionName}`, 'CockroachDB external connection URI'));
  return values.length === 1 ? values[0] : `(${values.join(', ')})`;
}

function buildShowBackupStatement(input = {}) {
  const recovery = input.evidenceDigest ? normalizeRecoveryEvidence(input) : input.recovery || input;
  return `SHOW BACKUP FROM LATEST IN ${destinationSql(recovery.collection)}`;
}

function buildRestoreStatement(input = {}) {
  const request = input.recovery ? input : normalizeRestoreRequest(input);
  const sourceDatabase = quoteIdentifier(request.recovery.selection.database, 'CockroachDB source database');
  const collection = destinationSql(request.recovery.collection);
  const timestamp = quoteSqlString(request.restoreTimestamp, 'CockroachDB restore timestamp');
  const targetDatabase = quoteSqlString(request.targetDatabase, 'CockroachDB alternate database name');
  return `RESTORE DATABASE ${sourceDatabase} FROM LATEST IN ${collection} AS OF SYSTEM TIME ${timestamp} WITH new_db_name = ${targetDatabase}, detached`;
}

function parseDetachedRestoreJobId(output) {
  const rows = parseTsv(output, 'CockroachDB detached restore submission');
  if (!Array.isArray(rows.columns) || rows.columns.length !== 1 || rows.columns[0] !== 'job_id' || rows.length !== 1) throw new DatabaseAdapterError('COCKROACH_RESTORE_JOB_ID_INVALID', 'CockroachDB detached restore did not return one exact job ID.', { category: 'integrity' });
  return normalizeJobId(rows[0].job_id, 'CockroachDB restore job ID');
}

function restoreJobStatusQuery(jobId) {
  const id = normalizeJobId(jobId, 'CockroachDB restore job ID');
  return `SELECT job_id::STRING AS job_id, job_type::STRING AS job_type, user_name::STRING AS user_name, status::STRING AS status, created::STRING AS created, COALESCE(started::STRING, '') AS started, COALESCE(finished::STRING, '') AS finished, modified::STRING AS modified, fraction_completed::STRING AS fraction_completed, COALESCE(coordinator_id::STRING, '') AS coordinator_id, (COALESCE(error, '') <> '')::STRING AS has_error FROM [SHOW JOBS] WHERE job_id = ${id}`;
}

function parseRestoreJobEvidence(output, expected = {}) {
  const rows = parseTsv(output, 'CockroachDB restore job reconciliation');
  const columns = ['job_id', 'job_type', 'user_name', 'status', 'created', 'started', 'finished', 'modified', 'fraction_completed', 'coordinator_id', 'has_error'];
  if (!Array.isArray(rows.columns) || rows.columns.length !== columns.length || rows.columns.some((column, index) => column !== columns[index]) || rows.length !== 1) throw new DatabaseAdapterError('COCKROACH_RESTORE_JOB_AMBIGUOUS', 'CockroachDB did not return one exact owned restore job.', { category: 'integrity' });
  const row = rows[0];
  const jobId = normalizeJobId(row.job_id, 'CockroachDB restore job ID');
  const status = String(row.status || '').toLowerCase();
  const fractionCompleted = Number(row.fraction_completed);
  if (row.job_type !== 'RESTORE' || expected.jobId && jobId !== expected.jobId || expected.currentUser && row.user_name !== expected.currentUser || !JOB_STATES.has(status) || !Number.isFinite(fractionCompleted) || fractionCompleted < 0 || fractionCompleted > 1) throw new DatabaseAdapterError('COCKROACH_RESTORE_JOB_IDENTITY_INVALID', 'CockroachDB restore job identity or state does not match owned evidence.', { category: 'integrity' });
  const hasErrorText = String(row.has_error).toLowerCase();
  if (!['true', 't', '1', 'false', 'f', '0'].includes(hasErrorText)) throw new DatabaseAdapterError('COCKROACH_RESTORE_JOB_EVIDENCE_INVALID', 'CockroachDB returned invalid restore job evidence.', { category: 'integrity' });
  const evidence = {
    jobId,
    jobType: 'RESTORE',
    currentUser: requiredText(row.user_name, 'CockroachDB restore job user', 256),
    status,
    createdAt: normalizeTimestamp(row.created, 'CockroachDB restore job creation time'),
    startedAt: normalizeTimestamp(row.started, 'CockroachDB restore job start time', true),
    finishedAt: normalizeTimestamp(row.finished, 'CockroachDB restore job finish time', true),
    modifiedAt: normalizeTimestamp(row.modified, 'CockroachDB restore job modification time'),
    fractionCompleted,
    coordinatorId: row.coordinator_id ? positiveInteger(row.coordinator_id, 'CockroachDB restore job coordinator ID', 1000000) : null,
    hasError: ['true', 't', '1'].includes(hasErrorText),
    terminal: TERMINAL_JOB_STATES.has(status)
  };
  if (status === 'succeeded' && (fractionCompleted !== 1 || !evidence.finishedAt || evidence.hasError)) throw new DatabaseAdapterError('COCKROACH_RESTORE_JOB_EVIDENCE_INVALID', 'CockroachDB returned incomplete successful restore evidence.', { category: 'integrity' });
  return deepFreeze({ ...evidence, evidenceFingerprint: stableDigest(evidence) });
}

function normalizeRestoreOwnership(input = {}) {
  const raw = plainObject(input, 'CockroachDB restore ownership evidence', [
    'version', 'adapterId', 'controllerVersion', 'operation', 'jobId', 'planDigest', 'restoreRunId',
    'targetClusterId', 'targetTopologyFingerprint', 'preRestoreDeploymentFingerprint', 'currentUser',
    'recoveryPointId', 'artifactId', 'recoveryEvidenceDigest', 'sourceClusterId', 'selectionFingerprint',
    'destinationFingerprint', 'localityFingerprint', 'targetDatabase', 'restoreTimestamp', 'submittedAt'
  ]);
  if (Number(raw.version) !== 1 || raw.adapterId !== ADAPTER_ID || raw.controllerVersion !== CONTROLLER_VERSION || raw.operation !== RESTORE_OPERATION) throw new TypeError('CockroachDB restore ownership evidence version is invalid.');
  return deepFreeze({
    version: 1,
    adapterId: ADAPTER_ID,
    controllerVersion: CONTROLLER_VERSION,
    operation: RESTORE_OPERATION,
    jobId: normalizeJobId(raw.jobId, 'CockroachDB restore job ID'),
    planDigest: normalizeFingerprint(raw.planDigest, 'CockroachDB restore plan digest'),
    restoreRunId: requiredText(raw.restoreRunId, 'CockroachDB RestoreRun ID', 200),
    targetClusterId: normalizeUuid(raw.targetClusterId, 'CockroachDB restore target cluster ID'),
    targetTopologyFingerprint: normalizeFingerprint(raw.targetTopologyFingerprint, 'CockroachDB restore target topology fingerprint'),
    preRestoreDeploymentFingerprint: normalizeFingerprint(raw.preRestoreDeploymentFingerprint, 'CockroachDB pre-restore deployment fingerprint'),
    currentUser: requiredText(raw.currentUser, 'CockroachDB restore job user', 256),
    recoveryPointId: requiredText(raw.recoveryPointId, 'CockroachDB owned RecoveryPoint ID', 200),
    artifactId: requiredText(raw.artifactId, 'CockroachDB owned Artifact ID', 200),
    recoveryEvidenceDigest: normalizeFingerprint(raw.recoveryEvidenceDigest, 'CockroachDB owned recovery evidence digest'),
    sourceClusterId: normalizeUuid(raw.sourceClusterId, 'CockroachDB restore source cluster ID'),
    selectionFingerprint: normalizeFingerprint(raw.selectionFingerprint, 'CockroachDB restore selection fingerprint'),
    destinationFingerprint: normalizeFingerprint(raw.destinationFingerprint, 'CockroachDB restore destination fingerprint'),
    localityFingerprint: normalizeFingerprint(raw.localityFingerprint, 'CockroachDB restore locality fingerprint'),
    targetDatabase: requiredText(raw.targetDatabase, 'CockroachDB alternate database name', 256),
    restoreTimestamp: normalizeTimestamp(raw.restoreTimestamp, 'CockroachDB owned restore timestamp'),
    submittedAt: normalizeTimestamp(raw.submittedAt, 'CockroachDB restore submission time')
  });
}

function assertTargetBinding(discovery, binding) {
  if (discovery.clusterId !== binding.clusterId || discovery.deploymentFingerprint !== binding.deploymentFingerprint || discovery.topologyFingerprint !== binding.topologyFingerprint || discovery.inventoryFingerprint !== binding.inventoryFingerprint) throw new DatabaseAdapterError('COCKROACH_RESTORE_TARGET_CHANGED', 'CockroachDB target cluster, topology, or capability identity changed after approval.', { category: 'integrity' });
}

function assertVersionCompatibility(recovery, discovery) {
  const source = parseVersion(recovery.sourceVersion, 'CockroachDB source version');
  const target = discovery.version;
  const sourceCluster = parseVersion(recovery.sourceClusterVersion, 'CockroachDB source cluster version');
  const targetCluster = discovery.clusterVersion;
  if (compareVersions(target, source) < 0 || target.major > source.major + 1 || compareVersions(targetCluster, sourceCluster) < 0 || targetCluster.major > sourceCluster.major + 1) throw new DatabaseAdapterError('COCKROACH_RESTORE_VERSION_INCOMPATIBLE', 'CockroachDB recovery requires the same or next major target and never restores a newer backup into an older target.', { category: 'compatibility' });
}

function localityRegions(discovery) {
  const regions = new Set();
  for (const node of discovery.nodes || []) {
    const match = /(?:^|,)region=([^,]+)/.exec(String(node.locality || ''));
    if (match) regions.add(match[1]);
  }
  return regions;
}

function assertRegionCompatibility(recovery, discovery) {
  const targetRegions = localityRegions(discovery);
  if (recovery.requiredRegions.some((region) => !targetRegions.has(region))) throw new DatabaseAdapterError('COCKROACH_RESTORE_REGION_INCOMPATIBLE', 'CockroachDB target topology does not contain every authenticated source region required by the database.', { category: 'compatibility' });
}

function showCreateDatabaseStatement(targetDatabase) {
  return `SHOW CREATE DATABASE ${quoteIdentifier(targetDatabase, 'CockroachDB alternate database')}`;
}

function invalidObjectsStatement(targetDatabase) {
  return `SELECT count(*)::STRING AS invalid_object_count FROM crdb_internal.invalid_objects WHERE database_name = ${quoteSqlString(targetDatabase, 'CockroachDB alternate database')}`;
}

function parseNativeTargetValidation(createOutput, invalidOutput, targetDatabase) {
  const createRows = parseTsv(createOutput, 'CockroachDB restored database descriptor validation');
  if (!Array.isArray(createRows.columns) || createRows.columns.length !== 2 || createRows.columns[0] !== 'database_name' || createRows.columns[1] !== 'create_statement'
    || createRows.length !== 1 || createRows[0].database_name !== targetDatabase || !String(createRows[0].create_statement || '').trim()) {
    throw new DatabaseAdapterError('COCKROACH_RESTORE_NATIVE_VALIDATION_FAILED', 'CockroachDB could not prove one exact restored database descriptor.', { category: 'validation' });
  }
  const invalidRows = parseTsv(invalidOutput, 'CockroachDB restored dependency validation');
  if (!Array.isArray(invalidRows.columns) || invalidRows.columns.length !== 1 || invalidRows.columns[0] !== 'invalid_object_count' || invalidRows.length !== 1
    || !/^(?:0|[1-9][0-9]{0,9})$/.test(String(invalidRows[0].invalid_object_count || ''))) {
    throw new DatabaseAdapterError('COCKROACH_RESTORE_DEPENDENCY_VALIDATION_FAILED', 'CockroachDB returned invalid dependency validation evidence.', { category: 'validation' });
  }
  const invalidObjectCount = Number(invalidRows[0].invalid_object_count);
  if (invalidObjectCount !== 0) throw new DatabaseAdapterError('COCKROACH_RESTORE_DEPENDENCY_UNRESOLVED', 'CockroachDB restored the alternate database with unresolved dependencies; preserve it for operator inspection.', { category: 'validation', details: { targetPreserved: true, invalidObjectCount } });
  return deepFreeze({
    nativeDescriptorRead: true,
    descriptorFingerprint: stableDigest({ databaseName: targetDatabase, createStatement: createRows[0].create_statement }),
    unresolvedDependencyCount: 0,
    dependenciesValid: true
  });
}

function validatePlanDigest(plan) {
  const { planDigest, ...unsigned } = plan;
  if (normalizeFingerprint(planDigest, 'CockroachDB restore plan digest') !== stableDigest(unsigned)) throw new DatabaseAdapterError('COCKROACH_RESTORE_PLAN_TAMPERED', 'CockroachDB native restore plan integrity validation failed.', { category: 'integrity' });
}

class CockroachDbNativeRestoreController {
  constructor({ clock = () => new Date().toISOString(), now = () => Date.now(), delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), pollIntervalMs = 1000, maximumWaitMs = 24 * 60 * 60 * 1000 } = {}) {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60000) throw new TypeError('CockroachDB restore polling interval is invalid.');
    if (!Number.isInteger(maximumWaitMs) || maximumWaitMs < 1000 || maximumWaitMs > 24 * 60 * 60 * 1000) throw new TypeError('CockroachDB restore maximum wait is invalid.');
    this.clock = clock;
    this.now = now;
    this.delay = delay;
    this.pollIntervalMs = pollIntervalMs;
    this.maximumWaitMs = maximumWaitMs;
    this.maximumPollAttempts = Math.ceil(maximumWaitMs / pollIntervalMs) + 1;
  }

  async #admit(context, request) {
    const discovery = await readDiscovery(context, request.connection);
    assertTargetBinding(discovery, request.targetBinding);
    assertVersionCompatibility(request.recovery, discovery);
    assertRegionCompatibility(request.recovery, discovery);
    if (!discovery.capabilities.restoreSyntax || !discovery.capabilities.detachedJobs || !discovery.capabilities.jobsVisible || !discovery.privileges.visible || discovery.privileges.system.RESTORE !== true || discovery.privileges.system.VIEWJOB !== true || discovery.privileges.system.CONTROLJOB !== true) throw new DatabaseAdapterError('COCKROACH_RESTORE_CAPABILITY_UNPROVEN', 'CockroachDB RESTORE, detached job visibility, and exact job control must be proven on the target.', { category: 'authorization' });
    if (discovery.databases.some((database) => database.name === request.targetDatabase)) throw new DatabaseAdapterError('COCKROACH_RESTORE_TARGET_NOT_EMPTY', 'CockroachDB alternate target database already exists.', { category: 'conflict' });
    if (!discovery.capabilities.externalConnectionsVisible) throw new DatabaseAdapterError('COCKROACH_RESTORE_COLLECTION_UNPROVEN', 'CockroachDB external connection inventory is unavailable on the restore target.', { category: 'authorization' });
    const available = new Set(discovery.externalConnections.map((connection) => connection.name));
    if (request.recovery.collection.localities.some(({ externalConnectionName }) => !available.has(externalConnectionName))) throw new DatabaseAdapterError('COCKROACH_RESTORE_COLLECTION_CHANGED', 'An authenticated CockroachDB backup external connection is unavailable on the restore target.', { category: 'integrity' });
    for (const binding of request.recovery.collection.localities) await runSqlCommand(context, request.connection, `CHECK EXTERNAL CONNECTION ${quoteSqlString(`external://${binding.externalConnectionName}`, 'CockroachDB external connection URI')}`);
    const metadata = await runSqlCommand(context, request.connection, buildShowBackupStatement(request.recovery));
    const metadataOutput = String(metadata.stdout || '');
    if (!metadataOutput.trim()) throw new DatabaseAdapterError('COCKROACH_RESTORE_METADATA_UNAVAILABLE', 'CockroachDB could not authenticate native collection metadata through the target.', { category: 'integrity' });
    return deepFreeze({
      checkedAt: this.clock(),
      targetClusterId: discovery.clusterId,
      targetVersion: discovery.version.text,
      targetClusterVersion: discovery.clusterVersion.text,
      currentUser: discovery.currentUser,
      targetDatabaseAbsent: true,
      collectionMetadataRead: true,
      collectionMetadataDigest: stableDigest(metadataOutput),
      collectionMetadataBytes: Buffer.byteLength(metadataOutput),
      targetZoneConfigurationMutation: false,
      admissionFingerprint: stableDigest({ targetClusterId: discovery.clusterId, topologyFingerprint: discovery.topologyFingerprint, recoveryEvidenceDigest: request.recovery.evidenceDigest, targetDatabase: request.targetDatabase, restoreTimestamp: request.restoreTimestamp })
    });
  }

  async preflight(context = {}, input = {}) {
    const request = normalizeRestoreRequest(input);
    const admission = await this.#admit(context, request);
    return deepFreeze({ request, admission });
  }

  async planRestore(context = {}, input = {}) {
    const { request, admission } = await this.preflight(context, input);
    const unsigned = {
      version: 1,
      operation: RESTORE_OPERATION,
      adapterId: ADAPTER_ID,
      controllerVersion: CONTROLLER_VERSION,
      request,
      admission,
      createdAt: this.clock()
    };
    return deepFreeze({ ...unsigned, planDigest: stableDigest(unsigned) });
  }

  #normalizePlan(input = {}) {
    const plan = plainObject(input, 'CockroachDB native restore plan', ['version', 'operation', 'adapterId', 'controllerVersion', 'request', 'admission', 'createdAt', 'planDigest']);
    if (Number(plan.version) !== 1 || plan.operation !== RESTORE_OPERATION || plan.adapterId !== ADAPTER_ID || plan.controllerVersion !== CONTROLLER_VERSION) throw new DatabaseAdapterError('COCKROACH_RESTORE_PLAN_INVALID', 'CockroachDB native restore plan version is invalid.', { category: 'integrity' });
    validatePlanDigest(plan);
    const request = normalizeRestoreRequest({ ...plan.request, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
    return { plan, request };
  }

  #ownership(plan, admission, jobId, submittedAt) {
    const request = plan.request;
    return normalizeRestoreOwnership({
      version: 1,
      adapterId: ADAPTER_ID,
      controllerVersion: CONTROLLER_VERSION,
      operation: RESTORE_OPERATION,
      jobId,
      planDigest: plan.planDigest,
      restoreRunId: request.execution.restoreRunId,
      targetClusterId: request.targetBinding.clusterId,
      targetTopologyFingerprint: request.targetBinding.topologyFingerprint,
      preRestoreDeploymentFingerprint: request.targetBinding.deploymentFingerprint,
      currentUser: admission.currentUser,
      recoveryPointId: request.recovery.recoveryPointId,
      artifactId: request.recovery.artifactId,
      recoveryEvidenceDigest: request.recovery.evidenceDigest,
      sourceClusterId: request.recovery.sourceClusterId,
      selectionFingerprint: request.recovery.selection.fingerprint,
      destinationFingerprint: request.recovery.collection.destinationFingerprint,
      localityFingerprint: request.recovery.collection.localityFingerprint,
      targetDatabase: request.targetDatabase,
      restoreTimestamp: request.restoreTimestamp,
      submittedAt
    });
  }

  async #readOwnedJob(context, connection, ownership) {
    const response = await runSqlCommand(context, connection, restoreJobStatusQuery(ownership.jobId));
    return parseRestoreJobEvidence(response.stdout, { jobId: ownership.jobId, currentUser: ownership.currentUser });
  }

  async #validateTarget(context, connection, targetDatabase) {
    const create = await runSqlCommand(context, connection, showCreateDatabaseStatement(targetDatabase));
    const invalid = await runSqlCommand(context, connection, invalidObjectsStatement(targetDatabase));
    return parseNativeTargetValidation(create.stdout, invalid.stdout, targetDatabase);
  }

  async #waitForNextPoll(context, jobId) {
    const signal = context.signal;
    if (!signal || typeof signal.addEventListener !== 'function') {
      await this.delay(this.pollIntervalMs);
      return;
    }
    if (signal.aborted) throw new DatabaseAdapterError('COCKROACH_RESTORE_MONITOR_CANCELED', 'CockroachDB restore monitoring was canceled; the exact owned native job and target are preserved for reconciliation.', { category: 'canceled', details: { jobId } });
    let removeAbortListener = () => {};
    const aborted = new Promise((resolve, reject) => {
      const listener = () => reject(new DatabaseAdapterError('COCKROACH_RESTORE_MONITOR_CANCELED', 'CockroachDB restore monitoring was canceled; the exact owned native job and target are preserved for reconciliation.', { category: 'canceled', details: { jobId } }));
      signal.addEventListener('abort', listener, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', listener);
    });
    try { await Promise.race([Promise.resolve().then(() => this.delay(this.pollIntervalMs)), aborted]); }
    finally { removeAbortListener(); }
  }

  async executeRestore(context = {}, input = {}) {
    const { plan, request } = this.#normalizePlan(input);
    if (typeof context.onOwnership !== 'function') throw new DatabaseAdapterError('COCKROACH_RESTORE_OWNERSHIP_CALLBACK_REQUIRED', 'CockroachDB detached restore requires durable ownership persistence before monitoring.', { category: 'configuration' });
    const admission = await this.#admit(context, request);
    if (context.signal?.aborted) throw new DatabaseAdapterError('COCKROACH_RESTORE_CANCELED', 'CockroachDB recovery was canceled before native submission.', { category: 'canceled' });
    const submission = await runSqlCommand(context, request.connection, buildRestoreStatement(request));
    const jobId = parseDetachedRestoreJobId(submission.stdout);
    const ownership = this.#ownership(plan, admission, jobId, this.clock());
    try { await context.onOwnership(ownership); }
    catch { throw new DatabaseAdapterError('COCKROACH_RESTORE_OWNERSHIP_PERSIST_FAILED', 'CockroachDB restore ownership could not be persisted; the native job and target are preserved for operator reconciliation.', { category: 'integrity', details: { jobId } }); }
    const deadline = this.now() + this.maximumWaitMs;
    let job = null;
    let pollAttempts = 0;
    while (pollAttempts < this.maximumPollAttempts && this.now() <= deadline) {
      if (context.signal?.aborted) throw new DatabaseAdapterError('COCKROACH_RESTORE_MONITOR_CANCELED', 'CockroachDB restore monitoring was canceled; the exact owned native job and target are preserved for reconciliation.', { category: 'canceled', details: { jobId } });
      pollAttempts += 1;
      job = await this.#readOwnedJob(context, request.connection, ownership);
      if (job.terminal) break;
      await this.#waitForNextPoll(context, jobId);
    }
    if (!job || !job.terminal) throw new DatabaseAdapterError('COCKROACH_RESTORE_TIMEOUT', 'CockroachDB native restore did not reach a terminal state before the monitoring deadline; ownership and target evidence are preserved.', { category: 'timeout', retryable: true, details: { jobId } });
    if (job.status !== 'succeeded') throw new DatabaseAdapterError('COCKROACH_RESTORE_FAILED', 'CockroachDB native restore did not succeed; the alternate target is preserved for operator inspection and no rollback is claimed.', { category: 'execution', details: { jobId, status: job.status, hasError: job.hasError, targetPreserved: true } });
    const completionConnection = { ...request.connection, expectedDeploymentFingerprint: null, expectedInventoryFingerprint: null };
    const discovery = await readDiscovery(context, completionConnection);
    if (discovery.clusterId !== request.targetBinding.clusterId || discovery.topologyFingerprint !== request.targetBinding.topologyFingerprint || discovery.currentUser !== ownership.currentUser) throw new DatabaseAdapterError('COCKROACH_RESTORE_COMPLETION_IDENTITY_CHANGED', 'CockroachDB target cluster, topology, or user changed before restore completion evidence was accepted.', { category: 'integrity', details: { jobId } });
    if (!discovery.databases.some((database) => database.name === request.targetDatabase)) throw new DatabaseAdapterError('COCKROACH_RESTORE_VALIDATION_FAILED', 'CockroachDB reported success but the alternate database is absent.', { category: 'validation', details: { jobId } });
    const nativeValidation = await this.#validateTarget(context, request.connection, request.targetDatabase);
    return deepFreeze({
      version: 1,
      kind: 'cockroachdb-native-restore',
      adapterId: ADAPTER_ID,
      controllerVersion: CONTROLLER_VERSION,
      operation: RESTORE_OPERATION,
      ownership,
      job,
      recoveryPointId: request.recovery.recoveryPointId,
      artifactId: request.recovery.artifactId,
      sourceDatabase: request.recovery.selection.database,
      targetDatabase: request.targetDatabase,
      targetClusterId: discovery.clusterId,
      restoreTimestamp: request.restoreTimestamp,
      collection: {
        destinationFingerprint: request.recovery.collection.destinationFingerprint,
        localityFingerprint: request.recovery.collection.localityFingerprint,
        localityAware: request.recovery.collection.localityAware
      },
      validation: {
        nativeRestoreRead: true,
        detachedJobSucceeded: true,
        targetDatabasePresent: true,
        targetIdentityStable: true,
        ...nativeValidation,
        validatedAt: this.clock()
      },
      sourceProtected: true,
      targetPreserved: true,
      rollbackClaimed: false,
      completedAt: this.clock()
    });
  }

  async #authorizeOwnership(context, connectionInput, ownershipInput, control) {
    const connection = normalizeConfig(connectionInput);
    const ownership = normalizeRestoreOwnership(ownershipInput);
    const discovery = await readDiscovery(context, { ...connection, expectedDeploymentFingerprint: null, expectedInventoryFingerprint: null });
    if (discovery.clusterId !== ownership.targetClusterId || discovery.topologyFingerprint !== ownership.targetTopologyFingerprint || discovery.currentUser !== ownership.currentUser) throw new DatabaseAdapterError('COCKROACH_RESTORE_OWNERSHIP_CHANGED', 'CockroachDB restore job does not belong to the current target cluster, topology, or user.', { category: 'integrity' });
    if (!discovery.capabilities.jobsVisible || !discovery.privileges.visible || discovery.privileges.system.VIEWJOB !== true || control && discovery.privileges.system.CONTROLJOB !== true) throw new DatabaseAdapterError('COCKROACH_RESTORE_JOB_PRIVILEGE_MISSING', 'CockroachDB restore job visibility or control privilege is not proven.', { category: 'authorization' });
    const job = await this.#readOwnedJob(context, connection, ownership);
    return { connection, ownership, discovery, job };
  }

  async reconcile(context = {}, input = {}) {
    const raw = plainObject(input, 'CockroachDB restore reconciliation request', ['connection', 'ownership']);
    const admitted = await this.#authorizeOwnership(context, raw.connection, raw.ownership, false);
    const nativeValidation = admitted.job.status === 'succeeded'
      ? await this.#validateTarget(context, admitted.connection, admitted.ownership.targetDatabase)
      : null;
    return deepFreeze({
      version: 1,
      ownership: admitted.ownership,
      job: admitted.job,
      terminal: admitted.job.terminal,
      targetDatabasePresent: admitted.discovery.databases.some((database) => database.name === admitted.ownership.targetDatabase),
      nativeValidation,
      targetPreserved: true,
      rollbackClaimed: false,
      reconciledAt: this.clock()
    });
  }

  async validateRestore(context = {}, input = {}) {
    const raw = plainObject(input, 'CockroachDB restore validation request', ['connection', 'ownership']);
    const admitted = await this.#authorizeOwnership(context, raw.connection, raw.ownership, false);
    if (admitted.job.status !== 'succeeded') throw new DatabaseAdapterError('COCKROACH_RESTORE_VALIDATION_PENDING', 'CockroachDB native restore has not succeeded, so target validation cannot be accepted.', { category: 'conflict', details: { jobId: admitted.ownership.jobId, status: admitted.job.status } });
    if (!admitted.discovery.databases.some((database) => database.name === admitted.ownership.targetDatabase)) throw new DatabaseAdapterError('COCKROACH_RESTORE_VALIDATION_FAILED', 'CockroachDB reported success but the alternate database is absent.', { category: 'validation', details: { jobId: admitted.ownership.jobId } });
    const nativeValidation = await this.#validateTarget(context, admitted.connection, admitted.ownership.targetDatabase);
    return deepFreeze({
      version: 1,
      valid: true,
      status: 'succeeded',
      ownership: admitted.ownership,
      job: admitted.job,
      targetDatabasePresent: true,
      nativeIntegrityValidation: true,
      ...nativeValidation,
      targetPreserved: true,
      rollbackClaimed: false,
      validatedAt: this.clock()
    });
  }

  async #control(context, input, operation) {
    const raw = plainObject(input, 'CockroachDB restore job control request', ['connection', 'ownership']);
    const admitted = await this.#authorizeOwnership(context, raw.connection, raw.ownership, true);
    const allowed = operation === 'PAUSE' ? new Set(['pending', 'running', 'retry-running']) : operation === 'RESUME' ? new Set(['paused']) : new Set(['pending', 'paused', 'pause-requested', 'running', 'retry-running', 'retry-reverting', 'reverting']);
    if (!allowed.has(admitted.job.status)) throw new DatabaseAdapterError('COCKROACH_RESTORE_JOB_CONTROL_INVALID', `CockroachDB owned restore job cannot be ${operation.toLowerCase()}d from its current state.`, { category: 'conflict' });
    await runSqlCommand(context, admitted.connection, `${operation} JOB ${admitted.ownership.jobId}`);
    const job = await this.#readOwnedJob(context, admitted.connection, admitted.ownership);
    return deepFreeze({ version: 1, operation: operation.toLowerCase(), ownership: admitted.ownership, before: admitted.job, job, targetPreserved: true, rollbackClaimed: false, controlledAt: this.clock() });
  }

  async pause(context = {}, input = {}) { return this.#control(context, input, 'PAUSE'); }
  async resume(context = {}, input = {}) { return this.#control(context, input, 'RESUME'); }
  async cancel(context = {}, input = {}) { return this.#control(context, input, 'CANCEL'); }
}

module.exports = {
  CONTROLLER_VERSION,
  MAX_CHAIN_LENGTH,
  RESTORE_CONFIRMATION,
  RESTORE_OPERATION,
  CockroachDbNativeRestoreController,
  buildRestoreStatement,
  buildShowBackupStatement,
  normalizeRecoveryEvidence,
  normalizeRestoreOwnership,
  normalizeRestoreRequest,
  parseDetachedRestoreJobId,
  parseRestoreJobEvidence,
  restoreJobStatusQuery,
  sealRecoveryEvidence
};
