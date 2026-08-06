const { ADAPTER_ID, ADAPTER_VERSION } = require('./cockroachdb');
const {
  CONTROLLER_VERSION,
  MAX_INCREMENTALS,
  CockroachDbNativeBackupController,
  normalizeDestination,
  normalizeSelection
} = require('./cockroachdb-native');
const { DatabaseAdapterError, digestJson } = require('./database-adapter');

const ARTIFACT_PATH = 'cockroachdb/backup-metadata.json';
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_RECOVERY_POINTS = MAX_INCREMENTALS + 1;

class CockroachDbSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CockroachDbSourceReaderError';
    this.code = code;
    this.category = options.category || 'source';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function fingerprint(value, label) {
  const text = requiredText(value, label, 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TypeError(`${label} is invalid.`);
  return number;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(plainObject(value, label)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} has unexpected fields.`);
  return value;
}

function timestamp(value, label) {
  const date = new Date(requiredText(value, label, 100));
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} is invalid.`);
  return date.toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function hashJson(value) {
  return `sha256:${digestJson(value)}`;
}

function rawDestination(destination) {
  return {
    type: destination.type,
    localities: destination.localities.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName }))
  };
}

function rawSelection(selection) {
  const selected = plainObject(selection, 'CockroachDB published selection');
  if (selected.scope === 'cluster') return { scope: 'cluster' };
  if (selected.scope === 'database') return { scope: 'database', database: selected.database };
  return { scope: selected.scope, tables: Array.isArray(selected.tables) ? selected.tables.map(({ database, schema, name }) => ({ database, schema, name })) : selected.tables };
}

function publicDestination(destination) {
  return deepFreeze({
    type: 'external-connection',
    localityAware: destination.localityAware,
    bindingCount: destination.localities.length,
    destinationFingerprint: destination.destinationFingerprint,
    localityFingerprint: destination.localityFingerprint
  });
}

function normalizedSelectorLists(selector) {
  const lists = ['databases', 'schemas', 'tables'];
  for (const key of lists) {
    if (!selector[key] || !Array.isArray(selector[key].include) || !Array.isArray(selector[key].exclude)) throw new TypeError('CockroachDB Source selection must be normalized before admission.');
  }
  return selector;
}

function selectionFromSelector(input = {}) {
  const selector = normalizedSelectorLists(plainObject(input, 'CockroachDB Source selector'));
  const hasSchemas = selector.schemas.include.length || selector.schemas.exclude.length;
  const hasExclusions = selector.databases.exclude.length || selector.tables.exclude.length;
  if (hasSchemas || hasExclusions) throw new TypeError('CockroachDB native backup does not support schema selection or exclusion rules.');
  if (selector.allDatabases) {
    if (selector.databases.include.length || selector.tables.include.length || selector.includeGlobalObjects !== true) throw new TypeError('CockroachDB cluster backup requires all databases and cluster global objects without child filters.');
    return normalizeSelection({ scope: 'cluster' });
  }
  if (selector.tables.include.length) {
    if (selector.includeGlobalObjects || selector.databases.include.length < 1) throw new TypeError('CockroachDB table backup requires exact database parents and no global objects.');
    const selectedDatabases = new Set(selector.databases.include.map((item) => requiredText(item.name, 'CockroachDB selected database', 256)));
    const referencedDatabases = new Set(selector.tables.include.map((item) => requiredText(item.database, 'CockroachDB table database', 256)));
    if (selectedDatabases.size !== referencedDatabases.size || [...selectedDatabases].some((name) => !referencedDatabases.has(name))) throw new TypeError('CockroachDB table backup database parents must exactly match the selected whole tables.');
    return normalizeSelection({ scope: 'table', tables: selector.tables.include.map(({ database, schema, name }) => ({ database, schema, name })) });
  }
  if (selector.includeGlobalObjects || selector.databases.include.length !== 1) throw new TypeError('CockroachDB database backup requires one exact database without child filters or global objects.');
  return normalizeSelection({ scope: 'database', database: selector.databases.include[0].name });
}

function trustedConnectionState(connection, deviceId) {
  const record = plainObject(connection, 'CockroachDB connection');
  if (record.adapterId !== ADAPTER_ID || record.kind !== 'database') throw new TypeError('CockroachDB Source requires a CockroachDB database connection.');
  if (deviceId && !(record.workerAffinity || []).includes(`device:${requiredText(deviceId, 'Device ID', 200)}`)) throw new TypeError('The CockroachDB connection belongs to another device.');
  const endpoint = plainObject(record.endpoint, 'CockroachDB connection endpoint');
  const trust = plainObject(record.trust, 'CockroachDB connection trust');
  const inventory = plainObject(record.cockroachdbInventory, 'CockroachDB trusted inventory');
  const identity = plainObject(record.lastTest?.endpointIdentity, 'CockroachDB tested identity');
  if (record.lastTest?.status !== 'success'
    || trust.clusterId !== endpoint.expectedClusterId || trust.clusterId !== identity.clusterId || trust.clusterId !== inventory.clusterId
    || trust.fingerprint !== endpoint.expectedDeploymentFingerprint || trust.fingerprint !== identity.deploymentFingerprint || trust.fingerprint !== inventory.deploymentFingerprint
    || trust.topologyFingerprint !== endpoint.expectedTopologyFingerprint || trust.topologyFingerprint !== identity.topologyFingerprint || trust.topologyFingerprint !== inventory.topologyFingerprint
    || trust.inventoryFingerprint !== endpoint.expectedInventoryFingerprint || trust.inventoryFingerprint !== identity.inventoryFingerprint || trust.inventoryFingerprint !== inventory.inventoryFingerprint) {
    throw new TypeError('Retest the CockroachDB connection to capture its exact cluster, topology, and capability inventory.');
  }
  const capabilities = inventory.capabilities;
  if (!capabilities?.backupIntoSyntax || !capabilities?.detachedJobs || !capabilities?.jobsVisible || !capabilities?.externalConnectionsVisible
    || capabilities.privilegeEvidenceVisible !== true || capabilities.systemPrivileges?.VIEWJOB !== true || capabilities.systemPrivileges?.CONTROLJOB !== true) {
    throw new TypeError('CockroachDB native backup capabilities and exact job control must be proven before Source enrollment.');
  }
  const destinationTrust = plainObject(record.cockroachdbBackupDestinationTrust, 'CockroachDB backup destination trust');
  const destination = normalizeDestination(destinationTrust.destination);
  const inventoryNames = new Set((inventory.externalConnections || []).map((item) => item.name));
  if (destinationTrust.version !== 1 || destinationTrust.connectionRevision !== record.revision
    || destinationTrust.clusterId !== trust.clusterId || destinationTrust.deploymentFingerprint !== trust.fingerprint
    || destinationTrust.topologyFingerprint !== trust.topologyFingerprint || destinationTrust.inventoryFingerprint !== trust.inventoryFingerprint
    || destinationTrust.destinationFingerprint !== destination.destinationFingerprint || destinationTrust.localityFingerprint !== destination.localityFingerprint
    || destination.localities.some((item) => !inventoryNames.has(item.externalConnectionName))) {
    throw new TypeError('Test and approve the exact CockroachDB external-connection destination again before Source enrollment.');
  }
  return { record, endpoint, trust, inventory, identity, destinationTrust, destination };
}

function admitCockroachDbSource({ connection, selector, consistency, input = {}, deviceId = null } = {}) {
  const request = plainObject(consistency, 'CockroachDB Source consistency');
  if (request.backupMethod !== 'physical' || request.backupMode !== 'full' || !['auto', 'cockroachdb-native-backup'].includes(request.method)
    || request.requestedLevel !== 'application' || request.captureCoordinates !== true) {
    throw new TypeError('CockroachDB Source enrollment requires physical native backup, full anchor mode, application consistency, and AS OF coordinate capture.');
  }
  const selection = selectionFromSelector(selector);
  const trusted = trustedConnectionState(connection, deviceId);
  const settings = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const asOfLagSeconds = Number(settings.asOfLagSeconds ?? 10);
  if (!Number.isInteger(asOfLagSeconds) || asOfLagSeconds < 10 || asOfLagSeconds > 24 * 60 * 60) throw new TypeError('CockroachDB AS OF lag must be between 10 seconds and 24 hours.');
  if (settings.encryptionMode !== undefined && settings.encryptionMode !== 'none') throw new TypeError('CockroachDB Source encryption modes are not enabled in this slice.');
  return deepFreeze({
    version: 1,
    engine: 'cockroachdb',
    controllerVersion: CONTROLLER_VERSION,
    selection,
    binding: {
      clusterId: trusted.trust.clusterId,
      deploymentFingerprint: trusted.trust.fingerprint,
      topologyFingerprint: trusted.trust.topologyFingerprint,
      inventoryFingerprint: trusted.trust.inventoryFingerprint,
      connectionRevision: trusted.record.revision
    },
    destination: publicDestination(trusted.destination),
    revisionHistory: settings.revisionHistory === true,
    encryptionMode: 'none',
    asOfLagSeconds,
    approvedAt: timestamp(trusted.destinationTrust.checkedAt, 'CockroachDB destination check time')
  });
}

function cockroachDbSourceReadiness(source, connection, deviceId) {
  try {
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new TypeError('The CockroachDB Source is disabled or unavailable.');
    const admitted = admitCockroachDbSource({ connection, selector: source.selector, consistency: source.consistency, input: source.physicalExecution, deviceId });
    if (hashJson(admitted) !== hashJson(source.physicalExecution)) throw new TypeError('The CockroachDB Source binding changed after enrollment.');
    return { ready: true, reasonCode: null, message: 'Ready' };
  } catch (error) {
    return { ready: false, reasonCode: 'COCKROACH_SOURCE_BINDING_CHANGED', message: error.message };
  }
}

function assertCockroachDbJobMode(source, backupMode) {
  if (!source || source.adapterId !== ADAPTER_ID || source.physicalExecution?.engine !== 'cockroachdb') throw new TypeError('CockroachDB Job admission requires an enrolled CockroachDB Source.');
  const mode = String(backupMode || '').toLowerCase();
  if (!['full', 'incremental'].includes(mode)) throw new TypeError('CockroachDB Jobs support full and incremental modes only.');
  return mode;
}

function publicationPayload(metadata) {
  const { publication: _publication, ...payload } = metadata;
  return payload;
}

function normalizePublishedMetadata(input, expected = {}) {
  const metadata = plainObject(input, 'CockroachDB published metadata');
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized) < 1 || Buffer.byteLength(serialized) > MAX_METADATA_BYTES) {
    throw new CockroachDbSourceReaderError('COCKROACH_PUBLISHED_METADATA_LIMIT', 'CockroachDB published backup metadata exceeds the bounded size limit.', { category: 'capacity' });
  }
  try {
    exactKeys(metadata, [
      'version', 'kind', 'adapterId', 'adapterVersion', 'controllerVersion', 'engine', 'productVersion', 'clusterVersion',
      'sourceId', 'jobId', 'backupMethod', 'backupMode', 'asOfTimestamp', 'revisionHistory', 'encryptionMode', 'selection',
      'selectionFingerprint', 'binding', 'destination', 'nativeChain', 'chain', 'job', 'ownershipFingerprint',
      'externalNativeMedia', 'restoreSupported', 'publicationReady', 'completedAt', 'publication'
    ], 'CockroachDB published metadata');
  } catch {
    throw new CockroachDbSourceReaderError('COCKROACH_PUBLISHED_METADATA_INVALID', 'CockroachDB published backup metadata is invalid.', { category: 'integrity' });
  }
  if (metadata.version !== 1 || metadata.kind !== 'cockroachdb-native-backup' || metadata.adapterId !== ADAPTER_ID || metadata.adapterVersion !== ADAPTER_VERSION
    || metadata.controllerVersion !== CONTROLLER_VERSION || metadata.engine !== 'cockroachdb' || metadata.backupMethod !== 'physical'
    || !['full', 'incremental'].includes(metadata.backupMode) || typeof metadata.revisionHistory !== 'boolean' || metadata.encryptionMode !== 'none'
    || metadata.externalNativeMedia !== true || metadata.restoreSupported !== true || metadata.publicationReady !== true) {
    throw new CockroachDbSourceReaderError('COCKROACH_PUBLISHED_METADATA_INVALID', 'CockroachDB published backup metadata is invalid.', { category: 'integrity' });
  }
  let selection;
  let binding;
  let destination;
  let nativeChain;
  let chain;
  let job;
  let publication;
  try {
    selection = normalizeSelection(rawSelection(metadata.selection));
    exactKeys(metadata.selection, ['scope', 'database', 'tables', 'fingerprint'], 'CockroachDB published selection');
    if (JSON.stringify(selection) !== JSON.stringify(metadata.selection)) throw new TypeError('CockroachDB published selection is not canonical.');
    binding = exactKeys(metadata.binding, ['clusterId', 'deploymentFingerprint', 'topologyFingerprint', 'inventoryFingerprint', 'connectionRevision'], 'CockroachDB published binding');
    destination = exactKeys(metadata.destination, ['type', 'localityAware', 'bindingCount', 'destinationFingerprint', 'localityFingerprint'], 'CockroachDB published destination');
    nativeChain = exactKeys(metadata.nativeChain, [
      'version', 'rootExecutionId', 'headExecutionId', 'incrementalCount', 'lastAsOfTimestamp', 'clusterId', 'deploymentFingerprint',
      'topologyFingerprint', 'destinationFingerprint', 'localityFingerprint', 'selectionFingerprint', 'revisionHistory', 'encryptionMode'
    ], 'CockroachDB published native chain');
    chain = exactKeys(metadata.chain, ['version', 'parentRecoveryPointId', 'chainRootRecoveryPointId', 'ancestorRecoveryPointIds'], 'CockroachDB published recovery chain');
    job = exactKeys(metadata.job, ['jobType', 'status', 'createdAt', 'startedAt', 'finishedAt', 'modifiedAt', 'fractionCompleted', 'hasError', 'terminal', 'evidenceFingerprint'], 'CockroachDB published job evidence');
    publication = exactKeys(metadata.publication, ['version', 'state', 'metadataDigest'], 'CockroachDB publication evidence');

    const clusterId = requiredText(binding.clusterId, 'CockroachDB published cluster ID', 36).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clusterId) || clusterId !== binding.clusterId) throw new TypeError('CockroachDB published cluster ID is invalid.');
    requiredText(metadata.productVersion, 'CockroachDB published product version', 100);
    requiredText(metadata.clusterVersion, 'CockroachDB published cluster version', 100);
    requiredText(metadata.sourceId, 'CockroachDB published Source ID', 200);
    requiredText(metadata.jobId, 'CockroachDB published Backup Job ID', 200);
    timestamp(metadata.asOfTimestamp, 'CockroachDB published backup timestamp');
    timestamp(metadata.completedAt, 'CockroachDB published completion time');
    fingerprint(metadata.selectionFingerprint, 'CockroachDB published selection fingerprint');
    fingerprint(binding.deploymentFingerprint, 'CockroachDB published deployment fingerprint');
    fingerprint(binding.topologyFingerprint, 'CockroachDB published topology fingerprint');
    fingerprint(binding.inventoryFingerprint, 'CockroachDB published inventory fingerprint');
    positiveInteger(binding.connectionRevision, 'CockroachDB published connection revision');
    fingerprint(destination.destinationFingerprint, 'CockroachDB published destination fingerprint');
    fingerprint(destination.localityFingerprint, 'CockroachDB published locality fingerprint');
    positiveInteger(destination.bindingCount, 'CockroachDB published destination binding count', 16);
    requiredText(nativeChain.rootExecutionId, 'CockroachDB published chain root execution ID', 200);
    requiredText(nativeChain.headExecutionId, 'CockroachDB published chain head execution ID', 200);
    positiveInteger(nativeChain.incrementalCount, 'CockroachDB published incremental count', MAX_INCREMENTALS, 0);
    timestamp(nativeChain.lastAsOfTimestamp, 'CockroachDB published chain timestamp');
    fingerprint(nativeChain.deploymentFingerprint, 'CockroachDB published chain deployment fingerprint');
    fingerprint(nativeChain.topologyFingerprint, 'CockroachDB published chain topology fingerprint');
    fingerprint(nativeChain.destinationFingerprint, 'CockroachDB published chain destination fingerprint');
    fingerprint(nativeChain.localityFingerprint, 'CockroachDB published chain locality fingerprint');
    fingerprint(nativeChain.selectionFingerprint, 'CockroachDB published chain selection fingerprint');
    if (requiredText(nativeChain.clusterId, 'CockroachDB published chain cluster ID', 36) !== binding.clusterId
      || nativeChain.version !== 1 || nativeChain.revisionHistory !== metadata.revisionHistory || nativeChain.encryptionMode !== 'none') throw new TypeError('CockroachDB published native chain binding is invalid.');
    if (!Array.isArray(chain.ancestorRecoveryPointIds) || chain.ancestorRecoveryPointIds.some((id) => requiredText(id, 'CockroachDB ancestor RecoveryPoint ID', 200) !== id)
      || new Set(chain.ancestorRecoveryPointIds).size !== chain.ancestorRecoveryPointIds.length) throw new TypeError('CockroachDB published RecoveryPoint lineage is invalid.');
    if (chain.parentRecoveryPointId !== null) requiredText(chain.parentRecoveryPointId, 'CockroachDB parent RecoveryPoint ID', 200);
    if (chain.chainRootRecoveryPointId !== null) requiredText(chain.chainRootRecoveryPointId, 'CockroachDB chain root RecoveryPoint ID', 200);
    timestamp(job.createdAt, 'CockroachDB published job creation time');
    if (job.startedAt !== null) timestamp(job.startedAt, 'CockroachDB published job start time');
    timestamp(job.finishedAt, 'CockroachDB published job finish time');
    timestamp(job.modifiedAt, 'CockroachDB published job modification time');
    fingerprint(job.evidenceFingerprint, 'CockroachDB published job evidence fingerprint');
    fingerprint(metadata.ownershipFingerprint, 'CockroachDB published ownership fingerprint');
    fingerprint(publication.metadataDigest, 'CockroachDB publication digest');
  } catch {
    throw new CockroachDbSourceReaderError('COCKROACH_PUBLISHED_METADATA_INVALID', 'CockroachDB published backup metadata is incomplete or changed.', { category: 'integrity' });
  }
  const fullChain = metadata.backupMode === 'full';
  if (metadata.selectionFingerprint !== selection.fingerprint || destination.type !== 'external-connection' || typeof destination.localityAware !== 'boolean'
    || destination.localityAware !== (destination.bindingCount > 1)
    || nativeChain.clusterId !== binding.clusterId || nativeChain.deploymentFingerprint !== binding.deploymentFingerprint
    || nativeChain.topologyFingerprint !== binding.topologyFingerprint || nativeChain.destinationFingerprint !== destination.destinationFingerprint
    || nativeChain.localityFingerprint !== destination.localityFingerprint || nativeChain.selectionFingerprint !== selection.fingerprint
    || nativeChain.lastAsOfTimestamp !== metadata.asOfTimestamp || chain.version !== 1 || chain.ancestorRecoveryPointIds.length !== nativeChain.incrementalCount
    || fullChain && (nativeChain.incrementalCount !== 0 || nativeChain.rootExecutionId !== nativeChain.headExecutionId || chain.parentRecoveryPointId !== null
      || chain.chainRootRecoveryPointId !== null || chain.ancestorRecoveryPointIds.length !== 0)
    || !fullChain && (nativeChain.incrementalCount < 1 || chain.parentRecoveryPointId !== chain.ancestorRecoveryPointIds.at(-1)
      || chain.chainRootRecoveryPointId !== chain.ancestorRecoveryPointIds[0])
    || job.jobType !== 'BACKUP' || job.status !== 'succeeded' || job.terminal !== true || job.fractionCompleted !== 1 || job.hasError !== false
    || publication.version !== 1 || publication.state !== 'ready' || publication.metadataDigest !== hashJson(publicationPayload(metadata))) {
    throw new CockroachDbSourceReaderError('COCKROACH_PUBLISHED_METADATA_INVALID', 'CockroachDB published backup metadata is incomplete or changed.', { category: 'integrity' });
  }
  if (/externalConnectionName|external:\/\/|(?:s3|gs|azure|nodelocal):\/\/|password|passphrase|credential|nativeJobId|user_name|description|statement|\berror\b/i.test(serialized)) {
    throw new CockroachDbSourceReaderError('COCKROACH_PUBLISHED_METADATA_PRIVATE', 'CockroachDB published backup metadata contains private execution data.', { category: 'integrity' });
  }
  const comparisons = [
    ['sourceId', expected.sourceId], ['jobId', expected.jobId], ['selectionFingerprint', expected.selectionFingerprint],
    ['revisionHistory', expected.revisionHistory], ['encryptionMode', expected.encryptionMode]
  ].filter(([, value]) => value !== undefined);
  if (comparisons.some(([key, value]) => metadata[key] !== value)
    || expected.destinationFingerprint && destination.destinationFingerprint !== expected.destinationFingerprint
    || expected.localityFingerprint && destination.localityFingerprint !== expected.localityFingerprint
    || expected.clusterId && binding.clusterId !== expected.clusterId
    || expected.deploymentFingerprint && binding.deploymentFingerprint !== expected.deploymentFingerprint
    || expected.topologyFingerprint && binding.topologyFingerprint !== expected.topologyFingerprint
    || expected.inventoryFingerprint && binding.inventoryFingerprint !== expected.inventoryFingerprint
    || expected.connectionRevision && binding.connectionRevision !== expected.connectionRevision) {
    throw new CockroachDbSourceReaderError('COCKROACH_PUBLISHED_METADATA_CHANGED', 'CockroachDB published backup metadata does not match the current Source and Job.', { category: 'integrity' });
  }
  return deepFreeze(structuredClone(metadata));
}

function publicJobEvidence(job) {
  return deepFreeze({
    jobType: 'BACKUP',
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    modifiedAt: job.modifiedAt,
    fractionCompleted: job.fractionCompleted,
    hasError: job.hasError,
    terminal: job.terminal,
    evidenceFingerprint: job.evidenceFingerprint
  });
}

function buildPublishedMetadata({ plan, result, parent, source, jobId }) {
  const payload = {
    version: 1,
    kind: 'cockroachdb-native-backup',
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    controllerVersion: CONTROLLER_VERSION,
    engine: 'cockroachdb',
    productVersion: plan.admission.productVersion,
    clusterVersion: plan.admission.clusterVersion,
    sourceId: source.id,
    jobId,
    backupMethod: 'physical',
    backupMode: result.backupMode,
    asOfTimestamp: result.asOfTimestamp,
    revisionHistory: result.revisionHistory,
    encryptionMode: 'none',
    selection: result.selection,
    selectionFingerprint: result.selection.fingerprint,
    binding: result.binding,
    destination: {
      type: 'external-connection',
      localityAware: result.collection.localityAware,
      bindingCount: result.collection.localities.length,
      destinationFingerprint: result.collection.destinationFingerprint,
      localityFingerprint: result.collection.localityFingerprint
    },
    nativeChain: result.chain,
    chain: {
      version: 1,
      parentRecoveryPointId: parent?.parentRecoveryPointId || null,
      chainRootRecoveryPointId: parent?.chainRootRecoveryPointId || null,
      ancestorRecoveryPointIds: parent?.ancestorRecoveryPointIds || []
    },
    job: publicJobEvidence(result.job),
    ownershipFingerprint: hashJson(result.ownership),
    externalNativeMedia: true,
    restoreSupported: true,
    publicationReady: true,
    completedAt: result.completedAt
  };
  return normalizePublishedMetadata({ ...payload, publication: { version: 1, state: 'ready', metadataDigest: hashJson(payload) } }, {
    sourceId: source.id,
    jobId,
    selectionFingerprint: source.physicalExecution.selection.fingerprint,
    destinationFingerprint: source.physicalExecution.destination.destinationFingerprint,
    localityFingerprint: source.physicalExecution.destination.localityFingerprint,
    clusterId: source.physicalExecution.binding.clusterId,
    deploymentFingerprint: source.physicalExecution.binding.deploymentFingerprint,
    topologyFingerprint: source.physicalExecution.binding.topologyFingerprint,
    inventoryFingerprint: source.physicalExecution.binding.inventoryFingerprint,
    connectionRevision: source.physicalExecution.binding.connectionRevision,
    revisionHistory: source.physicalExecution.revisionHistory,
    encryptionMode: source.physicalExecution.encryptionMode
  });
}

class CockroachDbSourceReaderService {
  constructor({ controlDatabase, deviceId, connectionService, controller = new CockroachDbNativeBackupController(), adapterRegistry = null, openRepository = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !connectionService) throw new TypeError('CockroachDB source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.connectionService = connectionService;
    this.controller = controller;
    this.adapterRegistry = adapterRegistry;
    this.openRepository = typeof openRepository === 'function' ? openRepository : null;
    this.clock = clock;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(sourceId, 'CockroachDB Source ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, id);
    const connection = source ? await this.controlDatabase.repository('connection').get(tenant, source.connectionId) : null;
    const readiness = cockroachDbSourceReadiness(source, connection, this.deviceId);
    if (!readiness.ready) throw new CockroachDbSourceReaderError('COCKROACH_SOURCE_UNAVAILABLE', readiness.message, { category: 'integrity' });
    if (this.adapterRegistry) {
      const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
      if (!manifest.sourceEnrollmentReady) throw new CockroachDbSourceReaderError('COCKROACH_SOURCE_ENROLLMENT_NOT_READY', 'CockroachDB Source enrollment is not enabled.', { category: 'compatibility' });
    }
    return deepFreeze({
      source,
      connection,
      connectionConfig: this.connectionService.config(connection),
      manifest: { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, selectionDigest: source.selector.digest, sourceRevision: source.revision }
    });
  }

  async #authenticatedParent(workspaceId, plan, options) {
    if (options.backupMode === 'full') return null;
    assertCockroachDbJobMode(plan.source, options.backupMode);
    if (!this.openRepository) throw new CockroachDbSourceReaderError('COCKROACH_PARENT_AUTH_UNAVAILABLE', 'CockroachDB incremental parent authentication is unavailable.', { category: 'compatibility' });
    const previous = options.previousRecoveryPoint;
    if (!previous || previous.sourceId !== plan.source.id || previous.jobId !== options.jobId) throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_PARENT_REQUIRED', 'CockroachDB incremental backup requires the latest RecoveryPoint from this exact Job.', { category: 'consistency' });
    const points = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 });
    const byId = new Map(points.map((point) => [point.id, point]));
    byId.set(previous.id, previous);
    const newestFirst = [];
    const seen = new Set();
    let current = previous;
    while (current && newestFirst.length <= MAX_RECOVERY_POINTS) {
      if (seen.has(current.id)) throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_CHAIN_CYCLE', 'CockroachDB RecoveryPoint lineage contains a cycle.', { category: 'integrity' });
      seen.add(current.id);
      if (current.sourceId !== plan.source.id || current.jobId !== options.jobId || !['full', 'incremental'].includes(current.type)
        || current.consistency !== 'application' || current.verification?.state !== 'succeeded' || current.retention?.deletionEligible === true
        || !Array.isArray(current.repositoryCopies)) throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_CHAIN_UNAVAILABLE', 'Every CockroachDB ancestor must be retained, verified, application-consistent, and available.', { category: 'integrity' });
      newestFirst.push(current);
      if (current.type === 'full') break;
      if (!current.parentRecoveryPointId) throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_CHAIN_INCOMPLETE', 'CockroachDB RecoveryPoint lineage has no full anchor.', { category: 'integrity' });
      current = byId.get(current.parentRecoveryPointId);
      if (!current) throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_CHAIN_INCOMPLETE', 'A CockroachDB incremental ancestor is missing.', { category: 'integrity' });
    }
    const chain = newestFirst.reverse();
    if (!chain.length || chain.length > MAX_RECOVERY_POINTS || chain[0].type !== 'full' || chain[0].id !== (previous.chainRootId || chain[0].id)
      || chain.some((point, index) => index > 0 && point.parentRecoveryPointId !== chain[index - 1].id)) {
      throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_CHAIN_INVALID', 'CockroachDB RecoveryPoint lineage is not one complete ordered chain.', { category: 'integrity' });
    }
    const requestedRepositories = new Set((options.repositoryIds || []).map(String));
    const repositoryId = [...requestedRepositories].find((id) => chain.every((point) => point.repositoryCopies.some((copy) => copy.repositoryId === id && copy.state === 'available')));
    if (!repositoryId) throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_REPOSITORY_UNAVAILABLE', 'No selected repository contains the complete CockroachDB metadata chain.', { category: 'not-found' });
    const opened = await this.openRepository(workspaceId, repositoryId);
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 });
    const authenticated = [];
    for (let index = 0; index < chain.length; index += 1) {
      const point = chain[index];
      const copy = point.repositoryCopies.find((item) => item.repositoryId === repositoryId && item.state === 'available');
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === repositoryId && item.kind === 'metadata');
      if (!artifact) throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_ARTIFACT_MISSING', 'A CockroachDB parent metadata Artifact is missing.', { category: 'not-found' });
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      const locatorPath = decodeURIComponent(String(artifact.locator || '').split('#').slice(1).join('#'));
      const file = locatorPath === ARTIFACT_PATH ? (snapshot.manifest.files || []).find((candidate) => candidate.type === 'file' && candidate.path === ARTIFACT_PATH && candidate.metadata?.artifactKind === 'metadata' && candidate.metadata?.externalNativeMedia === true) : null;
      const metadata = file?.metadata?.database;
      if (!file || snapshot.summary.manifestKey !== copy.manifestLocator || snapshot.summary.manifestChecksum?.digest !== copy.manifestChecksum?.digest
        || file.sizeBytes < 1 || file.sizeBytes > MAX_METADATA_BYTES || file.sizeBytes !== artifact.sizeBytes
        || file.contentDigest?.digest !== artifact.checksum?.digest || digestJson(metadata) !== digestJson(artifact.metadata)) {
        throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_ARTIFACT_CHANGED', 'An authenticated CockroachDB parent repository Artifact changed.', { category: 'integrity' });
      }
      const normalized = normalizePublishedMetadata(metadata, {
        sourceId: plan.source.id,
        jobId: options.jobId,
        selectionFingerprint: plan.source.physicalExecution.selection.fingerprint,
        destinationFingerprint: plan.source.physicalExecution.destination.destinationFingerprint,
        localityFingerprint: plan.source.physicalExecution.destination.localityFingerprint,
        clusterId: plan.source.physicalExecution.binding.clusterId,
        deploymentFingerprint: plan.source.physicalExecution.binding.deploymentFingerprint,
        topologyFingerprint: plan.source.physicalExecution.binding.topologyFingerprint,
        inventoryFingerprint: plan.source.physicalExecution.binding.inventoryFingerprint,
        connectionRevision: plan.source.physicalExecution.binding.connectionRevision,
        revisionHistory: plan.source.physicalExecution.revisionHistory,
        encryptionMode: plan.source.physicalExecution.encryptionMode
      });
      const expectedAncestors = chain.slice(0, index).map((item) => item.id);
      const expectedRoot = index ? chain[0].id : null;
      if (normalized.backupMode !== point.type || normalized.nativeChain.incrementalCount !== index || normalized.nativeChain.headExecutionId !== point.runId
        || normalized.chain.parentRecoveryPointId !== (index ? chain[index - 1].id : null) || normalized.chain.chainRootRecoveryPointId !== expectedRoot
        || JSON.stringify(normalized.chain.ancestorRecoveryPointIds) !== JSON.stringify(expectedAncestors)
        || index && (normalized.nativeChain.rootExecutionId !== authenticated[0].nativeChain.rootExecutionId
          || Date.parse(normalized.nativeChain.lastAsOfTimestamp) - Date.parse(authenticated[index - 1].nativeChain.lastAsOfTimestamp) < 5 * 60 * 1000)) {
        throw new CockroachDbSourceReaderError('COCKROACH_INCREMENTAL_ARTIFACT_INVALID', 'Authenticated CockroachDB parent metadata has inconsistent native or RecoveryPoint lineage.', { category: 'integrity' });
      }
      authenticated.push(normalized);
    }
    const head = authenticated.at(-1);
    return deepFreeze({
      parentChain: head.nativeChain,
      parentRecoveryPointId: previous.id,
      chainRootRecoveryPointId: chain[0].id,
      ancestorRecoveryPointIds: chain.map((point) => point.id)
    });
  }

  async #prepare(workspaceId, executionId, plan, options) {
    const backupMode = assertCockroachDbJobMode(plan.source, options.backupMode);
    const parent = await this.#authenticatedParent(workspaceId, plan, { ...options, backupMode });
    const destinationTrust = trustedConnectionState(plan.connection, this.deviceId).destinationTrust;
    if (typeof options.onSourceLease !== 'function') throw new CockroachDbSourceReaderError('COCKROACH_DURABLE_OWNERSHIP_REQUIRED', 'CockroachDB backup requires durable run ownership persistence.', { category: 'configuration' });
    return this.connectionService.withExecution(workspaceId, plan.connection, options.signal, async (context, connectionConfig) => {
      const request = {
        connection: connectionConfig,
        binding: plan.source.physicalExecution.binding,
        selection: plan.source.physicalExecution.selection.scope === 'cluster'
          ? { scope: 'cluster' }
          : plan.source.physicalExecution.selection.scope === 'database'
            ? { scope: 'database', database: plan.source.physicalExecution.selection.database }
            : { scope: 'table', tables: plan.source.physicalExecution.selection.tables.map(({ database, schema, name }) => ({ database, schema, name })) },
        destination: rawDestination(normalizeDestination(destinationTrust.destination)),
        backupMode,
        asOfLagSeconds: plan.source.physicalExecution.asOfLagSeconds,
        revisionHistory: plan.source.physicalExecution.revisionHistory,
        encryptionMode: 'none',
        execution: { workspaceId, sourceId: plan.source.id, executionId, connectionRevision: plan.connection.revision },
        parentChain: parent?.parentChain || null
      };
      const nativePlan = await this.controller.planBackup(context, request);
      let sourceLease = null;
      const onOwnership = async (ownership) => {
        sourceLease = deepFreeze({
          version: 1,
          kind: 'cockroachdb-native-job',
          state: 'active',
          workspaceId,
          sourceId: plan.source.id,
          executionId,
          connectionId: plan.connection.id,
          ownership,
          nativeStatus: 'submitted',
          updatedAt: ownership.submittedAt
        });
        await options.onSourceLease(sourceLease);
      };
      let result;
      try { result = await this.controller.executeBackup({ ...context, signal: options.signal, onOwnership }, nativePlan); }
      catch (error) {
        if (error instanceof CockroachDbSourceReaderError) throw error;
        if (error instanceof DatabaseAdapterError || error?.code) throw new CockroachDbSourceReaderError(error.code || 'COCKROACH_NATIVE_BACKUP_FAILED', error.message, { category: error.category, retryable: error.retryable });
        throw new CockroachDbSourceReaderError('COCKROACH_NATIVE_BACKUP_FAILED', 'DeployerX could not complete the CockroachDB native backup.', { retryable: true });
      }
      sourceLease = deepFreeze({ ...sourceLease, nativeStatus: result.job.status, nativeTerminal: result.job.terminal, updatedAt: result.completedAt });
      await options.onSourceLease(sourceLease);
      const databaseManifest = buildPublishedMetadata({ plan: nativePlan, result, parent, source: plan.source, jobId: requiredText(options.jobId, 'Backup Job ID', 200) });
      const bytes = Buffer.from(JSON.stringify(databaseManifest));
      if (bytes.length < 1 || bytes.length > MAX_METADATA_BYTES) throw new CockroachDbSourceReaderError('COCKROACH_METADATA_LIMIT', 'CockroachDB published metadata exceeds the bounded size limit.', { category: 'capacity' });
      return { bytes, databaseManifest, sourceLease, onSourceLease: options.onSourceLease };
    });
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    const backupMode = assertCockroachDbJobMode({ adapterId: ADAPTER_ID, physicalExecution: { engine: 'cockroachdb' } }, options.backupMode || 'full');
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, { ...options, backupMode });
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    return {
      ...plan,
      manifest: {
        ...plan.manifest,
        workloadType: 'database',
        resumable: false,
        consistency: {
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          engine: 'cockroachdb',
          backupMethod: 'physical',
          backupMode: prepared.databaseManifest.backupMode,
          requestedLevel: 'application',
          achievedLevel: 'application',
          method: 'cockroachdb-native-backup',
          lockScope: 'none',
          requiresDowntime: false,
          captureCoordinates: true,
          proven: true,
          evidence: {
            checkedAt: prepared.databaseManifest.completedAt,
            serverVersion: prepared.databaseManifest.productVersion,
            serverIdentityFingerprint: prepared.databaseManifest.binding.deploymentFingerprint,
            warnings: [],
            metadata: {
              topologyFingerprint: prepared.databaseManifest.binding.topologyFingerprint,
              selectionFingerprint: prepared.databaseManifest.selectionFingerprint,
              destinationFingerprint: prepared.databaseManifest.destination.destinationFingerprint
            }
          }
        },
        database: prepared.databaseManifest,
        artifactPath: ARTIFACT_PATH,
        artifactPaths: [ARTIFACT_PATH],
        sizeBytes: prepared.bytes.length,
        externalNativeMedia: true
      },
      create: async function* createCockroachDbMetadata() {
        yield {
          path: ARTIFACT_PATH,
          type: 'file',
          metadata: { workload: 'database', artifactKind: 'metadata', externalNativeMedia: true, database: prepared.databaseManifest },
          content: (async function* content() { yield prepared.bytes; })()
        };
      }
    };
  }

  async release(workspaceId, executionId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(executionId, 'Backup execution ID', 200);
    const key = `${tenant}:${id}`;
    const promise = this.preparations.get(key);
    this.preparations.delete(key);
    if (!promise) return false;
    const prepared = await promise.catch(() => null);
    if (!prepared) return false;
    const releasedAt = timestamp(this.clock(), 'CockroachDB source release time');
    await prepared.onSourceLease(deepFreeze({ ...prepared.sourceLease, state: 'released', releasedAt, updatedAt: releasedAt }));
    return true;
  }

  async #ownedRun(workspaceId, runId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(runId, 'Backup run ID', 200);
    const run = await this.controlDatabase.repository('run').get(tenant, id);
    const lease = run?.sourceLease;
    if (!run || run.configSnapshot?.source?.adapterId !== ADAPTER_ID || lease?.version !== 1 || lease.kind !== 'cockroachdb-native-job'
      || lease.workspaceId !== tenant || lease.executionId !== run.id || lease.state !== 'active' || !lease.ownership) {
      throw new CockroachDbSourceReaderError('COCKROACH_OWNED_RUN_INVALID', 'The backup run has no active CockroachDB native ownership evidence.', { category: 'integrity' });
    }
    const connection = await this.controlDatabase.repository('connection').get(tenant, lease.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new CockroachDbSourceReaderError('COCKROACH_OWNED_CONNECTION_MISSING', 'The owned CockroachDB connection is unavailable.', { category: 'not-found' });
    return { tenant, run, lease, connection };
  }

  async reconcileRun(workspaceId, run = {}) {
    const owned = await this.#ownedRun(workspaceId, run.id);
    const reconciled = await this.connectionService.withExecution(owned.tenant, owned.connection, null, (context, connection) => this.controller.reconcile(context, { connection, ownership: owned.lease.ownership }));
    return deepFreeze({
      applicable: true,
      proven: reconciled.terminal === true,
      reconciledOperations: 1,
      nativeMediaDeleted: false,
      sourceLease: reconciled.terminal ? { ...owned.lease, state: 'released', nativeStatus: reconciled.job.status, reconciledAt: reconciled.reconciledAt, updatedAt: reconciled.reconciledAt } : { ...owned.lease, nativeStatus: reconciled.job.status, reconciledAt: reconciled.reconciledAt, updatedAt: reconciled.reconciledAt }
    });
  }

  async #controlRun(workspaceId, runId, operation) {
    const owned = await this.#ownedRun(workspaceId, runId);
    const controlled = await this.connectionService.withExecution(owned.tenant, owned.connection, null, (context, connection) => this.controller[operation](context, { connection, ownership: owned.lease.ownership }));
    const sourceLease = deepFreeze({ ...owned.lease, nativeStatus: controlled.job.status, lastControl: operation, controlledAt: controlled.controlledAt, updatedAt: controlled.controlledAt });
    await this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('run', owned.tenant, owned.run.id);
      if (!current || current.revision !== owned.run.revision || current.sourceLease?.ownership?.jobId !== owned.lease.ownership.jobId) throw new CockroachDbSourceReaderError('COCKROACH_OWNED_RUN_CHANGED', 'CockroachDB run ownership changed during native job control.', { category: 'conflict' });
      transaction.projectExecution('run', owned.tenant, current.id, { sourceLease }, { expectedRevision: current.revision, actorId: `device:${this.deviceId}` });
    });
    return deepFreeze({ operation, status: controlled.job.status, terminal: controlled.job.terminal, fractionCompleted: controlled.job.fractionCompleted, controlledAt: controlled.controlledAt, ownershipPreserved: true });
  }

  async pauseRun(workspaceId, runId) { return this.#controlRun(workspaceId, runId, 'pause'); }
  async resumeRun(workspaceId, runId) { return this.#controlRun(workspaceId, runId, 'resume'); }
  async cancelRun(workspaceId, runId) { return this.#controlRun(workspaceId, runId, 'cancel'); }
}

module.exports = {
  ARTIFACT_PATH,
  MAX_METADATA_BYTES,
  CockroachDbSourceReaderError,
  CockroachDbSourceReaderService,
  admitCockroachDbSource,
  assertCockroachDbJobMode,
  buildPublishedMetadata,
  cockroachDbSourceReadiness,
  normalizePublishedMetadata,
  publicDestination,
  selectionFromSelector
};
