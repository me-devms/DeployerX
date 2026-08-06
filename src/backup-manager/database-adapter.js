const crypto = require('crypto');

const DATABASE_ADAPTER_API_VERSION = 1;
const MAX_SELECTION_ITEMS = 10000;
const MAX_WARNINGS = 100;
const BACKUP_MODES = new Set(['full', 'incremental', 'differential', 'native']);
const BACKUP_METHODS = new Set(['logical', 'physical']);
const CONSISTENCY_LEVELS = new Set(['application', 'crash', 'filesystem', 'unknown']);
const CONSISTENCY_METHODS = new Set([
  'transaction-snapshot',
  'coordinated-lock',
  'offline',
  'neo4j-native-backup',
  'clickhouse-native-backup',
  'cockroachdb-native-backup',
  'influxdb-v2-native-backup',
  'influxdb3-enterprise-native-backup',
  'influxdb3-enterprise-legacy-stopped-copy',
  'influxdb3-enterprise-legacy-atomic-snapshot-copy',
  'influxdb3-enterprise-legacy-copy',
  'influxdb3-core-stopped',
  'influxdb3-core-atomic-snapshot',
  'influxdb3-core-ordered-copy',
  'storage-snapshot',
  'replica-snapshot',
  'pg-basebackup',
  'sql-server-native-backup',
  'oracle-rman',
  'mongodb-oplog-dump',
  'mongodb-coordinated-snapshot',
  'sqlite-online-backup',
  'redis-rdb',
  'redis-aof',
  'redis-cluster-rdb',
  'redis-cluster-aof',
  'search-native-snapshot',
  'cassandra-native-snapshot',
  'scylla-manager-backup'
]);
const LOCK_SCOPES = new Set(['none', 'global-read', 'database', 'table', 'instance', 'cluster']);
const ADAPTER_METHODS = Object.freeze([
  'manifest',
  'testConnection',
  'discover',
  'preflight',
  'planBackup',
  'executeBackup',
  'planRestore',
  'executeRestore',
  'validateRestore'
]);
const CREDENTIAL_KEY = /(password|passphrase|token|secret|credential|privatekey|connectionstring|dsn|uri|url)$/i;
const CONSISTENCY_RANK = Object.freeze({ unknown: 0, filesystem: 1, crash: 2, application: 3 });

class DatabaseAdapterError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'DatabaseAdapterError';
    this.code = code;
    this.category = options.category || 'validation';
    this.retryable = Boolean(options.retryable);
    this.details = normalizeDetails(options.details);
  }
}

function fail(code, message, category = 'validation', details = {}) {
  throw new DatabaseAdapterError(code, message, { category, details });
}

function requiredText(value, label, maximumLength = 512) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) fail('DATABASE_INPUT_INVALID', `${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 512) {
  if (value === null || value === undefined || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function normalizeDetails(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (['string', 'number', 'boolean'].includes(typeof item) || item === null) {
      result[String(key).slice(0, 100)] = typeof item === 'string' ? item.slice(0, 500) : item;
    }
  }
  return result;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('DATABASE_INPUT_INVALID', `${label} must be an object.`);
  }
  return value;
}

function enumValue(value, allowed, label) {
  const result = requiredText(value, label, 80);
  if (!allowed.has(result)) fail('DATABASE_INPUT_INVALID', `${label} is not supported.`);
  return result;
}

function uniqueTextList(input, label, options = {}) {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) fail('DATABASE_INPUT_INVALID', `${label} must be an array.`);
  const maximum = options.maximum ?? MAX_SELECTION_ITEMS;
  if (input.length > maximum) fail('DATABASE_INPUT_LIMIT_EXCEEDED', `${label} contains too many entries.`, 'capacity');
  const values = new Set();
  for (const item of input) values.add(requiredText(item, `${label} entry`, options.maximumLength || 256));
  return [...values].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function normalizeJson(value, depth = 0) {
  if (depth > 20) fail('DATABASE_INPUT_LIMIT_EXCEEDED', 'Database configuration is too deeply nested.', 'capacity');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('DATABASE_INPUT_INVALID', 'Database configuration contains an invalid number.');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, depth + 1));
  assertPlainObject(value, 'Database configuration');
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, normalizeJson(value[key], depth + 1)]));
}

function digestJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeJson(value))).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function normalizeToolRequirements(input) {
  if (!Array.isArray(input)) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database adapter native-tool requirements must be an array.', 'compatibility');
  return input.map((raw) => {
    assertPlainObject(raw, 'Native-tool requirement');
    return {
      name: requiredText(raw.name, 'Native-tool name', 100),
      versionRange: requiredText(raw.versionRange, 'Native-tool version range', 100),
      operations: uniqueTextList(raw.operations, 'Native-tool operations', { maximum: 10, maximumLength: 40 })
    };
  });
}

function normalizePrivilegeRequirements(input) {
  if (!Array.isArray(input)) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database adapter privilege requirements must be an array.', 'compatibility');
  return input.map((raw) => {
    assertPlainObject(raw, 'Privilege requirement');
    return {
      id: requiredText(raw.id, 'Privilege ID', 100),
      operations: uniqueTextList(raw.operations, 'Privilege operations', { maximum: 10, maximumLength: 40 }),
      required: raw.required !== false,
      safeDescription: requiredText(raw.safeDescription, 'Privilege description', 300)
    };
  });
}

function normalizeConsistencyStrategies(input) {
  if (!Array.isArray(input) || input.length === 0) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'A database adapter must declare at least one consistency strategy.', 'compatibility');
  const seen = new Set();
  return input.map((raw) => {
    assertPlainObject(raw, 'Consistency strategy');
    const id = enumValue(raw.id, CONSISTENCY_METHODS, 'Consistency strategy');
    if (seen.has(id)) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database adapter consistency strategies must be unique.', 'compatibility');
    seen.add(id);
    const backupMethods = uniqueTextList(raw.backupMethods, 'Consistency backup methods', { maximum: 2, maximumLength: 20 });
    if (!backupMethods.length || backupMethods.some((method) => !BACKUP_METHODS.has(method))) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'A consistency strategy declares an invalid backup method.', 'compatibility');
    return {
      id,
      produces: enumValue(raw.produces, CONSISTENCY_LEVELS, 'Consistency result'),
      backupMethods,
      lockScope: enumValue(raw.lockScope || 'none', LOCK_SCOPES, 'Consistency lock scope'),
      requiresDowntime: Boolean(raw.requiresDowntime),
      capturesCoordinates: Boolean(raw.capturesCoordinates)
    };
  });
}

function normalizeCapabilities(input) {
  const raw = assertPlainObject(input, 'Database adapter capabilities');
  const backupMethods = uniqueTextList(raw.backupMethods, 'Backup methods', { maximum: 2, maximumLength: 20 });
  if (!backupMethods.length || backupMethods.some((method) => !BACKUP_METHODS.has(method))) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database adapter backup methods are invalid.', 'compatibility');
  const backupModes = uniqueTextList(raw.backupModes, 'Backup modes', { maximum: 4, maximumLength: 30 });
  if (!backupModes.length || backupModes.some((mode) => !BACKUP_MODES.has(mode))) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database adapter backup modes are invalid.', 'compatibility');
  const selection = assertPlainObject(raw.selection, 'Database selection capabilities');
  const streaming = assertPlainObject(raw.streaming, 'Database streaming capabilities');
  const restore = assertPlainObject(raw.restore, 'Database restore capabilities');
  const transactionLogs = assertPlainObject(raw.transactionLogs, 'Database transaction-log capabilities');
  const consistencyStrategies = normalizeConsistencyStrategies(raw.consistencyStrategies);
  if (consistencyStrategies.some((strategy) => strategy.backupMethods.some((method) => !backupMethods.includes(method)))) {
    fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'A consistency strategy uses an undeclared backup method.', 'compatibility');
  }
  const granularitySeconds = transactionLogs.granularitySeconds === null || transactionLogs.granularitySeconds === undefined
    ? null
    : Number(transactionLogs.granularitySeconds);
  if (granularitySeconds !== null && (!Number.isInteger(granularitySeconds) || granularitySeconds < 1 || granularitySeconds > 86400)) {
    fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database transaction-log granularity is invalid.', 'compatibility');
  }
  const transactionLogType = optionalText(transactionLogs.type, 'Transaction-log type', 80);
  if (Boolean(transactionLogs.supported) !== Boolean(transactionLogType)) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database transaction-log support and type must be declared together.', 'compatibility');
  if (transactionLogs.pointInTimeRecovery && !transactionLogs.supported) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Point-in-time recovery requires transaction-log support.', 'compatibility');
  const supportedProducts = Array.isArray(transactionLogs.supportedProducts) ? [...new Set(transactionLogs.supportedProducts.map((product) => requiredText(product, 'Transaction-log supported product', 80).toLowerCase()))].sort() : [];
  if (supportedProducts.length > 50 || (supportedProducts.length && !transactionLogs.supported)) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database transaction-log product scope is invalid.', 'compatibility');
  return {
    backupMethods,
    backupModes,
    selection: {
      database: selection.database !== false,
      schema: Boolean(selection.schema),
      table: Boolean(selection.table),
      globalObjects: Boolean(selection.globalObjects)
    },
    consistencyStrategies,
    transactionLogs: {
      supported: Boolean(transactionLogs.supported),
      type: transactionLogType,
      pointInTimeRecovery: Boolean(transactionLogs.pointInTimeRecovery),
      granularitySeconds,
      ...(supportedProducts.length ? { supportedProducts } : {})
    },
    streaming: {
      backup: Boolean(streaming.backup),
      restore: Boolean(streaming.restore),
      compression: Boolean(streaming.compression),
      encryption: Boolean(streaming.encryption)
    },
    restore: {
      alternateTarget: Boolean(restore.alternateTarget),
      offlineBundle: Boolean(restore.offlineBundle),
      originalTarget: Boolean(restore.originalTarget),
      nativeValidation: Boolean(restore.nativeValidation)
    },
    replicaAware: Boolean(raw.replicaAware)
  };
}

function normalizeDatabaseAdapterManifest(input) {
  const raw = assertPlainObject(input, 'Database adapter manifest');
  const adapterId = requiredText(raw.adapterId, 'Database adapter ID', 200);
  if (!/^deployerx\.database\.[a-z0-9][a-z0-9.-]*$/.test(adapterId)) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database adapter ID is invalid.', 'compatibility');
  const adapterVersion = requiredText(raw.adapterVersion, 'Database adapter version', 50);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(adapterVersion)) fail('DATABASE_ADAPTER_MANIFEST_INVALID', 'Database adapter version must be semantic.', 'compatibility');
  if (Number(raw.apiVersion) !== DATABASE_ADAPTER_API_VERSION) fail('DATABASE_ADAPTER_API_INCOMPATIBLE', 'Database adapter API version is incompatible.', 'compatibility');
  const manifest = {
    apiVersion: DATABASE_ADAPTER_API_VERSION,
    adapterId,
    adapterVersion,
    displayName: requiredText(raw.displayName, 'Database adapter display name', 100),
    engine: requiredText(raw.engine, 'Database engine', 80).toLowerCase(),
    executionReady: raw.executionReady !== false,
    sourceEnrollmentReady: raw.sourceEnrollmentReady === true || raw.executionReady !== false,
    serverVersionRange: requiredText(raw.serverVersionRange, 'Supported server version range', 100),
    restoreVersionRange: requiredText(raw.restoreVersionRange, 'Compatible restore version range', 100),
    capabilities: normalizeCapabilities(raw.capabilities),
    requiredTools: normalizeToolRequirements(raw.requiredTools || []),
    requiredPrivileges: normalizePrivilegeRequirements(raw.requiredPrivileges || [])
  };
  return deepFreeze(manifest);
}

function normalizeObjectRules(input, label, fields) {
  if (input === null || input === undefined) return { include: [], exclude: [] };
  const raw = assertPlainObject(input, label);
  const normalizeItems = (items, listLabel) => {
    if (items === null || items === undefined) return [];
    if (!Array.isArray(items)) fail('DATABASE_SELECTION_INVALID', `${listLabel} must be an array.`);
    if (items.length > MAX_SELECTION_ITEMS) fail('DATABASE_SELECTION_LIMIT_EXCEEDED', `${listLabel} contains too many entries.`, 'capacity');
    const unique = new Map();
    for (const item of items) {
      const object = assertPlainObject(item, `${listLabel} entry`);
      const normalized = Object.fromEntries(fields.map((field) => [field, requiredText(object[field], `${listLabel} ${field}`, 256)]));
      unique.set(fields.map((field) => normalized[field]).join('\0'), normalized);
    }
    return [...unique.values()].sort((left, right) => fields.map((field) => left[field]).join('\0').localeCompare(fields.map((field) => right[field]).join('\0'), 'en-US'));
  };
  const include = normalizeItems(raw.include, `${label} include rules`);
  const exclude = normalizeItems(raw.exclude, `${label} exclude rules`);
  const excluded = new Set(exclude.map((item) => fields.map((field) => item[field]).join('\0')));
  if (include.some((item) => excluded.has(fields.map((field) => item[field]).join('\0')))) fail('DATABASE_SELECTION_CONFLICT', `${label} cannot include and exclude the same object.`);
  return { include, exclude };
}

function normalizeDatabaseSelector(input, manifestOrCapabilities) {
  const raw = assertPlainObject(input, 'Database selector');
  const capabilities = manifestOrCapabilities?.capabilities || manifestOrCapabilities;
  assertPlainObject(capabilities, 'Database adapter capabilities');
  const databases = normalizeObjectRules(raw.databases, 'Database rules', ['name']);
  const schemas = normalizeObjectRules(raw.schemas, 'Schema rules', ['database', 'name']);
  const tables = normalizeObjectRules(raw.tables, 'Table rules', ['database', 'schema', 'name']);
  const allDatabases = Boolean(raw.allDatabases);
  if (!allDatabases && databases.include.length === 0) fail('DATABASE_SELECTION_EMPTY', 'Select at least one database or explicitly select all databases.');
  if (allDatabases && databases.include.length) fail('DATABASE_SELECTION_CONFLICT', 'All-database selection cannot also contain database include rules.');
  if (allDatabases && (schemas.include.length || schemas.exclude.length || tables.include.length || tables.exclude.length)) {
    fail('DATABASE_SELECTION_CONFLICT', 'All-database selection cannot contain schema or table rules.');
  }
  if (!allDatabases) {
    const selectedDatabases = new Set(databases.include.map((item) => item.name));
    const references = [...schemas.include, ...schemas.exclude, ...tables.include, ...tables.exclude];
    if (references.some((item) => !selectedDatabases.has(item.database))) fail('DATABASE_SELECTION_CONFLICT', 'Schema and table rules must reference an included database.');
  }
  if (!capabilities.selection?.database) fail('DATABASE_SELECTION_UNSUPPORTED', 'This adapter does not support database selection.', 'compatibility');
  if ((schemas.include.length || schemas.exclude.length) && !capabilities.selection.schema) fail('DATABASE_SELECTION_UNSUPPORTED', 'This adapter does not support schema selection.', 'compatibility');
  if ((tables.include.length || tables.exclude.length) && !capabilities.selection.table) fail('DATABASE_SELECTION_UNSUPPORTED', 'This adapter does not support table selection.', 'compatibility');
  if (raw.includeGlobalObjects && !capabilities.selection.globalObjects) fail('DATABASE_SELECTION_UNSUPPORTED', 'This adapter does not support global-object selection.', 'compatibility');
  const selector = {
    version: 1,
    kind: 'database-objects',
    allDatabases,
    databases,
    schemas,
    tables,
    includeGlobalObjects: Boolean(raw.includeGlobalObjects)
  };
  return deepFreeze({ ...selector, digest: digestJson(selector) });
}

function normalizeConsistencyRequest(input = {}, capabilities) {
  const raw = assertPlainObject(input, 'Database consistency request');
  const backupMethod = enumValue(raw.backupMethod || 'logical', BACKUP_METHODS, 'Database backup method');
  const backupMode = enumValue(raw.backupMode || 'full', BACKUP_MODES, 'Database backup mode');
  if (!capabilities.backupMethods.includes(backupMethod) || !capabilities.backupModes.includes(backupMode)) fail('DATABASE_BACKUP_MODE_UNSUPPORTED', 'The requested database backup method or mode is unsupported.', 'compatibility');
  const preferredMethod = raw.method && raw.method !== 'auto' ? enumValue(raw.method, CONSISTENCY_METHODS, 'Database consistency method') : 'auto';
  return deepFreeze({
    requestedLevel: enumValue(raw.requestedLevel || 'application', CONSISTENCY_LEVELS, 'Requested database consistency'),
    method: preferredMethod,
    backupMethod,
    backupMode,
    captureCoordinates: Boolean(raw.captureCoordinates),
    allowDowngrade: Boolean(raw.allowDowngrade)
  });
}

function normalizePreflightEvidence(input = {}) {
  const raw = assertPlainObject(input, 'Database preflight evidence');
  const consistency = Array.isArray(raw.consistency) ? raw.consistency.slice(0, 20).map((item) => {
    assertPlainObject(item, 'Consistency evidence');
    return {
      method: enumValue(item.method, CONSISTENCY_METHODS, 'Consistency evidence method'),
      verified: item.verified === true,
      produces: enumValue(item.produces, CONSISTENCY_LEVELS, 'Consistency evidence result'),
      reasonCode: optionalText(item.reasonCode, 'Consistency evidence reason', 100)
    };
  }) : [];
  const tools = Array.isArray(raw.tools) ? raw.tools.slice(0, 50).map((item) => ({
    name: requiredText(item?.name, 'Native-tool evidence name', 100),
    version: optionalText(item?.version, 'Native-tool version', 100),
    compatible: item?.compatible === true,
    executableFingerprint: optionalText(item?.executableFingerprint, 'Native-tool fingerprint', 200)
  })) : [];
  const privileges = Array.isArray(raw.privileges) ? raw.privileges.slice(0, 100).map((item) => ({
    id: requiredText(item?.id, 'Privilege evidence ID', 100),
    allowed: item?.allowed === true,
    evidence: optionalText(item?.evidence, 'Privilege evidence', 300)
  })) : [];
  return deepFreeze({
    checkedAt: requiredText(raw.checkedAt, 'Preflight check time', 40),
    serverVersion: requiredText(raw.serverVersion, 'Database server version', 100),
    serverVersionSupported: raw.serverVersionSupported === true,
    serverIdentityFingerprint: requiredText(raw.serverIdentityFingerprint, 'Database server identity fingerprint', 200),
    consistency,
    tools,
    privileges,
    coordinateCaptureVerified: raw.coordinateCaptureVerified === true,
    warnings: uniqueTextList(raw.warnings, 'Database preflight warnings', { maximum: MAX_WARNINGS, maximumLength: 500 }),
    metadata: normalizeJson(raw.metadata || {})
  });
}

function resolveConsistencyPlan(manifestInput, requestInput, evidenceInput) {
  const manifest = normalizeDatabaseAdapterManifest(manifestInput);
  const request = normalizeConsistencyRequest(requestInput, manifest.capabilities);
  const evidence = normalizePreflightEvidence(evidenceInput);
  if (!evidence.serverVersionSupported) fail('DATABASE_SERVER_VERSION_UNSUPPORTED', 'The database server version is not supported by this adapter.', 'compatibility');
  const evidenceByMethod = new Map(evidence.consistency.map((item) => [item.method, item]));
  const candidates = manifest.capabilities.consistencyStrategies
    .filter((strategy) => strategy.backupMethods.includes(request.backupMethod))
    .filter((strategy) => request.method === 'auto' || strategy.id === request.method)
    .filter((strategy) => evidenceByMethod.get(strategy.id)?.verified === true)
    .filter((strategy) => evidenceByMethod.get(strategy.id)?.produces === strategy.produces);
  const exact = candidates.find((strategy) => strategy.produces === request.requestedLevel);
  const downgradeCandidates = candidates
    .filter((strategy) => CONSISTENCY_RANK[strategy.produces] < CONSISTENCY_RANK[request.requestedLevel])
    .sort((left, right) => CONSISTENCY_RANK[right.produces] - CONSISTENCY_RANK[left.produces]);
  if (!exact && downgradeCandidates.length && !request.allowDowngrade) fail('DATABASE_CONSISTENCY_DOWNGRADE_REFUSED', 'A weaker database consistency level was refused.', 'consistency');
  const strategy = exact || (request.allowDowngrade ? downgradeCandidates[0] : null);
  if (!strategy) fail('DATABASE_CONSISTENCY_UNPROVEN', 'The requested database consistency cannot be proven for this backup.', 'consistency');
  const requiredTools = manifest.requiredTools.filter((item) => item.operations.includes('backup'));
  const missingTool = requiredTools.find((required) => !evidence.tools.some((item) => item.name === required.name && item.compatible));
  if (missingTool) fail('DATABASE_NATIVE_TOOL_UNAVAILABLE', 'A required compatible database-native tool is unavailable.', 'compatibility', { tool: missingTool.name });
  const requiredPrivileges = manifest.requiredPrivileges.filter((item) => item.required && item.operations.includes('backup'));
  const missingPrivilege = requiredPrivileges.find((required) => !evidence.privileges.some((item) => item.id === required.id && item.allowed));
  if (missingPrivilege) fail('DATABASE_PRIVILEGE_MISSING', 'A required database backup privilege is unavailable.', 'authorization', { privilege: missingPrivilege.id });
  if (request.captureCoordinates && (!strategy.capturesCoordinates || !evidence.coordinateCaptureVerified)) {
    fail('DATABASE_COORDINATE_CAPTURE_UNPROVEN', 'Database transaction coordinates cannot be captured safely.', 'consistency');
  }
  return deepFreeze({
    version: 1,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    engine: manifest.engine,
    backupMethod: request.backupMethod,
    backupMode: request.backupMode,
    requestedLevel: request.requestedLevel,
    achievedLevel: strategy.produces,
    method: strategy.id,
    lockScope: strategy.lockScope,
    requiresDowntime: strategy.requiresDowntime,
    captureCoordinates: request.captureCoordinates,
    proven: true,
    evidence: {
      checkedAt: evidence.checkedAt,
      serverVersion: evidence.serverVersion,
      serverIdentityFingerprint: evidence.serverIdentityFingerprint,
      nativeTools: requiredTools.map((required) => evidence.tools.find((item) => item.name === required.name)),
      privileges: requiredPrivileges.map((required) => evidence.privileges.find((item) => item.id === required.id)),
      warnings: evidence.warnings,
      metadata: evidence.metadata
    }
  });
}

function assertSecretRefOnlyCredentials(value, path = 'connection') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretRefOnlyCredentials(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key) && item !== null && item !== undefined && item !== '') fail('DATABASE_PLAINTEXT_CREDENTIAL_REFUSED', 'Database credentials must be stored as SecretRef IDs.', 'authentication', { field: `${path}.${key}` });
    if (/secretRefId$/i.test(key) && item !== null && item !== undefined && !/^sec_[A-Za-z0-9_-]{8,200}$/.test(String(item))) fail('DATABASE_SECRET_REF_INVALID', 'A database credential SecretRef ID is invalid.', 'authentication', { field: `${path}.${key}` });
    assertSecretRefOnlyCredentials(item, `${path}.${key}`);
  }
}

function publicDatabaseEndpoint(input = {}) {
  const raw = assertPlainObject(input, 'Database endpoint');
  assertSecretRefOnlyCredentials(raw);
  const endpoint = {
    host: optionalText(raw.host, 'Database host', 253),
    port: raw.port === null || raw.port === undefined ? null : Number(raw.port),
    database: optionalText(raw.database, 'Default database', 256),
    username: optionalText(raw.username, 'Database username', 256),
    tlsMode: optionalText(raw.tlsMode, 'Database TLS mode', 50),
    serverIdentityFingerprint: optionalText(raw.serverIdentityFingerprint, 'Database server fingerprint', 200)
  };
  if (endpoint.port !== null && (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)) fail('DATABASE_INPUT_INVALID', 'Database port is invalid.');
  return deepFreeze(endpoint);
}

function validateAdapter(adapter) {
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter?.[method] !== 'function') fail('DATABASE_ADAPTER_INVALID', `Database adapter does not implement ${method}.`, 'compatibility');
  }
  return normalizeDatabaseAdapterManifest(adapter.manifest());
}

class DatabaseAdapterRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    this.manifests = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    const manifest = validateAdapter(adapter);
    if (this.adapters.has(manifest.adapterId)) fail('DATABASE_ADAPTER_DUPLICATE', 'A database adapter with this ID is already registered.', 'compatibility');
    this.adapters.set(manifest.adapterId, adapter);
    this.manifests.set(manifest.adapterId, manifest);
    return manifest;
  }

  list() {
    return [...this.manifests.values()].map((manifest) => structuredClone(manifest)).sort((left, right) => left.displayName.localeCompare(right.displayName, 'en-US'));
  }

  manifest(adapterId) {
    const manifest = this.manifests.get(requiredText(adapterId, 'Database adapter ID', 200));
    if (!manifest) fail('DATABASE_ADAPTER_NOT_FOUND', 'Database adapter is not installed.', 'compatibility');
    return manifest;
  }

  adapter(adapterId) {
    const id = this.manifest(adapterId).adapterId;
    return this.adapters.get(id);
  }

  async prepareBackup(adapterId, context, request = {}) {
    const manifest = this.manifest(adapterId);
    const adapter = this.adapters.get(manifest.adapterId);
    if (context?.signal?.aborted) fail('DATABASE_OPERATION_CANCELED', 'Database backup planning was canceled.', 'canceled');
    assertSecretRefOnlyCredentials(request.connection || {});
    const execution = request.execution === undefined || request.execution === null ? null : normalizeJson(request.execution);
    if (execution) assertSecretRefOnlyCredentials(execution, 'execution');
    const selector = normalizeDatabaseSelector(request.selector, manifest);
    const evidence = await adapter.preflight(context, {
      operation: 'backup',
      connection: request.connection,
      selector,
      consistency: request.consistency,
      execution
    });
    const consistencyPlan = resolveConsistencyPlan(manifest, request.consistency, evidence);
    const adapterPlan = await adapter.planBackup(context, {
      connection: request.connection,
      selector,
      consistency: consistencyPlan,
      execution
    });
    assertPlainObject(adapterPlan, 'Database adapter backup plan');
    assertSecretRefOnlyCredentials(adapterPlan, 'adapterPlan');
    return deepFreeze({
      version: 1,
      adapterId: manifest.adapterId,
      adapterVersion: manifest.adapterVersion,
      engine: manifest.engine,
      selector,
      consistency: consistencyPlan,
      adapterPlan: normalizeJson(adapterPlan),
      planDigest: digestJson({ adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selector, consistencyPlan, adapterPlan })
    });
  }
}

module.exports = {
  ADAPTER_METHODS,
  DATABASE_ADAPTER_API_VERSION,
  DatabaseAdapterError,
  DatabaseAdapterRegistry,
  MAX_SELECTION_ITEMS,
  assertSecretRefOnlyCredentials,
  digestJson,
  normalizeConsistencyRequest,
  normalizeDatabaseAdapterManifest,
  normalizeDatabaseSelector,
  normalizePreflightEvidence,
  publicDatabaseEndpoint,
  resolveConsistencyPlan,
  validateAdapter
};
