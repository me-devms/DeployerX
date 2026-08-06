const crypto = require('node:crypto');
const net = require('node:net');
const { domainToASCII } = require('node:url');

const DATABASE_MANAGER_SCHEMA_VERSION = 1;
const DEFAULT_QUERY_PAGE_SIZE = 100;
const MAX_QUERY_PAGE_SIZE = 5000;
const MAX_QUERY_BYTES = 2 * 1024 * 1024;
const MAX_SCHEMA_TABLES = 1000;
const MAX_SCHEMA_COLUMNS_PER_TABLE = 1000;
const MAX_QUERY_HISTORY_ITEMS = 500;
const DATABASE_TASK_TYPES = Object.freeze(['import', 'dump', 'explain', 'schema', 'administration']);
const DATABASE_TASK_STATES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted']);

const BUILT_IN_DRIVERS = Object.freeze([
  Object.freeze({ id: 'postgresql', name: 'PostgreSQL', defaultPort: 5432 }),
  Object.freeze({ id: 'mysql', name: 'MySQL / MariaDB', defaultPort: 3306 }),
  Object.freeze({ id: 'sqlite', name: 'SQLite', defaultPort: null })
]);

const DRIVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const PROFILE_ENVIRONMENTS = new Set(['development', 'staging', 'production', 'unclassified']);
const ACCESS_MODES = new Set(['read-write', 'read-only']);
const ENDPOINT_KINDS = new Set(['network', 'file', 'folder', 'api', 'none']);
const SSL_MODES = new Set(['disabled', 'preferred', 'required', 'verify-ca', 'verify-full']);
const SQL_DIALECT_ALIASES = Object.freeze({ postgres: 'postgresql', postgresql: 'postgresql', mariadb: 'mysql', mysql: 'mysql', sqlite: 'sqlite', sqlite3: 'sqlite', mssql: 'mssql', sqlserver: 'mssql', oracle: 'oracle', generic: 'generic' });
const SENSITIVE_KEY = /(?:password|passphrase|private.?key|secret|token|credential|connection.?uri|authorization|cookie|api.?key|client.?key|access.?key)$/i;

class DatabaseManagerValidationError extends Error {
  constructor(message, code = 'DATABASE_MANAGER_INPUT_INVALID', options = {}) {
    super(message);
    this.name = 'DatabaseManagerValidationError';
    this.code = code;
    this.category = options.category || 'validation';
    this.retryable = false;
    this.details = normalizeSafeDetails(options.details);
  }
}

function fail(message, code, details) {
  throw new DatabaseManagerValidationError(message, code, { details });
}

function requiredText(value, label, maximumLength = 512) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) fail(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 512) {
  if (value === null || value === undefined || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function normalizeIdentifier(value, label) {
  const id = requiredText(value, label, 100).toLowerCase();
  if (!DRIVER_ID_PATTERN.test(id)) fail(`${label} is invalid.`);
  return id;
}

function normalizeHost(value) {
  const input = requiredText(value, 'Database host', 253);
  if (/[\s/@\\]/.test(input) || input.includes('://')) fail('Database host must not include a URL scheme, credentials, path, or whitespace.', 'DATABASE_MANAGER_HOST_INVALID');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
    fail('Database host is invalid.', 'DATABASE_MANAGER_HOST_INVALID');
  }
  return ascii;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Database port must be between 1 and 65535.', 'DATABASE_MANAGER_PORT_INVALID');
  return port;
}

function normalizeTags(input) {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input) || input.length > 50) fail('Database profile tags are invalid.');
  return [...new Set(input.map((item) => requiredText(item, 'Database profile tag', 40).toLowerCase()))]
    .sort((left, right) => left.localeCompare(right, 'en-US'));
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function normalizeJson(value, label = 'Database configuration', depth = 0) {
  if (depth > 20) fail(`${label} is too deeply nested.`, 'DATABASE_MANAGER_INPUT_LIMIT_EXCEEDED');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains an invalid number.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 10000) fail(`${label} contains too many values.`, 'DATABASE_MANAGER_INPUT_LIMIT_EXCEEDED');
    return value.map((item) => normalizeJson(item, label, depth + 1));
  }
  assertPlainObject(value, label);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    if (SENSITIVE_KEY.test(key)) fail(`${label} must use encrypted secret references instead of plaintext ${key}.`, 'DATABASE_MANAGER_SECRET_REFERENCE_REQUIRED');
    result[key] = normalizeJson(value[key], label, depth + 1);
  }
  return result;
}

function normalizeEndpoint(input = {}) {
  const raw = assertPlainObject(input, 'Database endpoint');
  const kind = String(raw.kind || 'network').toLowerCase();
  if (!ENDPOINT_KINDS.has(kind)) fail('Database endpoint kind is not supported.');
  if (kind === 'network') {
    return Object.freeze({ kind, host: normalizeHost(raw.host), port: normalizePort(raw.port) });
  }
  if (kind === 'file' || kind === 'folder') {
    return Object.freeze({ kind, localResourceRequired: true });
  }
  if (kind === 'api') {
    const baseUrl = optionalText(raw.baseUrl, 'Database API base URL', 2048);
    if (baseUrl) {
      let parsed;
      try { parsed = new URL(baseUrl); } catch { fail('Database API base URL is invalid.', 'DATABASE_MANAGER_URL_INVALID'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        fail('Database API base URL must use HTTP or HTTPS and must not contain credentials.', 'DATABASE_MANAGER_URL_INVALID');
      }
    }
    return Object.freeze({ kind, baseUrl });
  }
  return Object.freeze({ kind: 'none' });
}

function normalizeSsl(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const mode = String(raw.mode || 'disabled').toLowerCase();
  if (!SSL_MODES.has(mode)) fail('Database SSL mode is not supported.');
  return Object.freeze({
    mode,
    caPathRequired: Boolean(raw.caPathRequired),
    clientCertificateRequired: Boolean(raw.clientCertificateRequired)
  });
}

function normalizeTunnel(input = {}, projectId = null) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const type = String(raw.type || 'none').toLowerCase();
  if (!['none', 'server'].includes(type)) fail('Database tunnel type is not supported.');
  if (type === 'server') {
    const linkedProjectId = optionalText(raw.projectId || projectId, 'Linked server ID', 200);
    if (!linkedProjectId) fail('A linked DeployerX server is required for the database tunnel.', 'DATABASE_MANAGER_SERVER_LINK_REQUIRED');
    return Object.freeze({ type, projectId: linkedProjectId });
  }
  return Object.freeze({ type: 'none' });
}

function normalizeCredentialSlots(input) {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input) || input.length > 20) fail('Database credential slots are invalid.');
  const seen = new Set();
  return input.map((item) => {
    const raw = assertPlainObject(item, 'Database credential slot');
    const id = normalizeIdentifier(raw.id, 'Credential slot ID');
    if (seen.has(id)) fail('Database credential slot IDs must be unique.');
    seen.add(id);
    const type = String(raw.type || 'password').toLowerCase();
    if (!['password', 'token', 'username', 'certificate', 'private-key', 'connection-uri'].includes(type)) fail('Database credential slot type is not supported.');
    return Object.freeze({ id, type, required: raw.required !== false, label: requiredText(raw.label || id, 'Credential slot label', 80) });
  });
}

function pluginSettingRequiresSecret(field) {
  return /(?:password|passphrase|secret|token|api.?key|connection.?uri|private.?key|certificate|(?:extra|connection).?properties)/i.test(String(field?.key || ''));
}

function pluginSettingCredentialSlot(field) {
  const id = String(field.key || '').toLowerCase().replaceAll('_', '-');
  const type = /connection.?uri/i.test(id) ? 'connection-uri' : /private.?key/i.test(id) ? 'private-key' : /certificate/i.test(id) ? 'certificate' : /password|passphrase/i.test(id) ? 'password' : 'token';
  return { id, type, label: field.label || field.key, required: field.required === true };
}

function normalizeProfileInput(input = {}) {
  const raw = assertPlainObject(input, 'Database profile');
  const driverId = normalizeIdentifier(raw.driverId, 'Database driver ID');
  const projectId = optionalText(raw.projectId, 'Linked server ID', 200);
  const environment = String(raw.environment || 'unclassified').toLowerCase();
  const accessMode = String(raw.accessMode || 'read-write').toLowerCase();
  if (!PROFILE_ENVIRONMENTS.has(environment)) fail('Database profile environment is not supported.');
  if (!ACCESS_MODES.has(accessMode)) fail('Database profile access mode is not supported.');
  const endpoint = normalizeEndpoint(raw.endpoint || {});
  const tunnel = normalizeTunnel(raw.tunnel, projectId);
  const profile = {
    schemaVersion: DATABASE_MANAGER_SCHEMA_VERSION,
    name: requiredText(raw.name, 'Database profile name', 120),
    driverId,
    sharedConnectionId: optionalText(raw.sharedConnectionId, 'Shared connection ID', 200),
    projectId: tunnel.type === 'server' ? tunnel.projectId : projectId,
    endpoint,
    database: optionalText(raw.database, 'Database name', 512),
    defaultSchema: optionalText(raw.defaultSchema, 'Default schema', 512),
    environment,
    accessMode,
    tags: normalizeTags(raw.tags),
    ssl: normalizeSsl(raw.ssl),
    tunnel,
    credentialSlots: normalizeCredentialSlots(raw.credentialSlots),
    settings: normalizeJson(raw.settings || {}, 'Database driver settings'),
    startupScript: optionalText(raw.startupScript, 'Database startup script', 100000),
    queryTimeoutMs: normalizeQueryTimeout(raw.queryTimeoutMs),
    appearance: normalizeAppearance(raw.appearance)
  };
  return Object.freeze(profile);
}

function normalizeQueryTimeout(value) {
  const timeout = Number(value ?? 60000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 30 * 60 * 1000) fail('Database query timeout must be between 1 second and 30 minutes.');
  return timeout;
}

function normalizeAppearance(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const accentColor = optionalText(raw.accentColor, 'Database accent color', 20);
  if (accentColor && !/^#[0-9a-f]{6}$/i.test(accentColor)) fail('Database accent color must be a six-digit hexadecimal color.');
  return Object.freeze({ icon: optionalText(raw.icon, 'Database icon', 200), accentColor });
}

function normalizeDriverManifest(input = {}) {
  const raw = assertPlainObject(input, 'Database driver manifest');
  const id = normalizeIdentifier(raw.id, 'Database driver ID');
  const source = String(raw.source || 'plugin').toLowerCase();
  if (!['built-in', 'plugin'].includes(source)) fail('Database driver source is not supported.');
  const capabilities = raw.capabilities && typeof raw.capabilities === 'object' && !Array.isArray(raw.capabilities) ? raw.capabilities : {};
  const declaredDialect = String(raw.sqlDialect || raw.sql_dialect || capabilities.sqlDialect || capabilities.sql_dialect || id).trim().toLowerCase();
  const sqlDialect = SQL_DIALECT_ALIASES[declaredDialect] || (declaredDialect === id ? 'generic' : null);
  if (!sqlDialect) fail('Database driver SQL dialect is not supported.');
  const identifierQuote = optionalText(raw.identifierQuote || raw.identifier_quote || capabilities.identifierQuote || capabilities.identifier_quote, 'Database driver identifier quote', 4)
    || (sqlDialect === 'mysql' ? '`' : '"');
  const settings = normalizeJson(raw.settings || {}, 'Database driver manifest settings');
  if (raw.credentialSlots !== null && raw.credentialSlots !== undefined && !Array.isArray(raw.credentialSlots)) fail('Database credential slots are invalid.');
  const credentialSlotInputs = Array.isArray(raw.credentialSlots) ? raw.credentialSlots.map((slot) => ({ ...slot })) : [];
  if (source === 'plugin' && Array.isArray(settings.fields)) {
    const retainedFields = [];
    for (const field of settings.fields) {
      if (!pluginSettingRequiresSecret(field)) {
        retainedFields.push(field);
        continue;
      }
      const slot = pluginSettingCredentialSlot(field);
      if (!credentialSlotInputs.some((candidate) => String(candidate?.id || '').toLowerCase() === slot.id)) credentialSlotInputs.push(slot);
    }
    settings.fields = retainedFields;
  }
  return Object.freeze({
    schemaVersion: DATABASE_MANAGER_SCHEMA_VERSION,
    id,
    name: requiredText(raw.name, 'Database driver name', 120),
    version: requiredText(raw.version, 'Database driver version', 50),
    source,
    description: optionalText(raw.description, 'Database driver description', 500),
    defaultPort: raw.defaultPort === null || raw.defaultPort === undefined ? null : normalizePort(raw.defaultPort),
    sqlDialect,
    identifierQuote,
    capabilities: Object.freeze({
      schemas: Boolean(capabilities.schemas),
      fileBased: Boolean(capabilities.fileBased),
      folderBased: Boolean(capabilities.folderBased),
      noConnectionRequired: Boolean(capabilities.noConnectionRequired),
      query: capabilities.query !== false,
      batch: Boolean(capabilities.batch),
      crud: Boolean(capabilities.crud),
      explain: Boolean(capabilities.explain),
      schemaChanges: Boolean(capabilities.schemaChanges),
      views: Boolean(capabilities.views),
      materializedViews: Boolean(capabilities.materializedViews),
      routines: Boolean(capabilities.routines),
      triggers: Boolean(capabilities.triggers),
      userManagement: Boolean(capabilities.userManagement),
      supportsSsl: Boolean(capabilities.supportsSsl),
      supportsSsh: capabilities.supportsSsh !== false
    }),
    credentialSlots: normalizeCredentialSlots(credentialSlotInputs),
    settings
  });
}

function normalizeQueryRequest(input = {}) {
  const raw = assertPlainObject(input, 'Database query request');
  const query = String(raw.query ?? '');
  if (!query.trim() || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES || query.includes('\0')) {
    fail('Database query is empty or too large.', 'DATABASE_MANAGER_QUERY_INVALID');
  }
  const page = Number(raw.page ?? 1);
  const pageSize = Number(raw.pageSize ?? DEFAULT_QUERY_PAGE_SIZE);
  if (!Number.isInteger(page) || page < 1 || page > 1000000) fail('Database query page is invalid.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_QUERY_PAGE_SIZE) fail(`Database query page size must be between 1 and ${MAX_QUERY_PAGE_SIZE}.`);
  return Object.freeze({
    requestId: optionalText(raw.requestId, 'Query request ID', 200) || `dbq_${crypto.randomUUID()}`,
    profileId: requiredText(raw.profileId, 'Database profile ID', 200),
    query,
    page,
    pageSize,
    schema: optionalText(raw.schema, 'Database query schema', 512),
    batch: Boolean(raw.batch),
    source: ['editor', 'notebook', 'grid', 'schema', 'plugin', 'import', 'explain'].includes(raw.source) ? raw.source : 'editor'
  });
}

function normalizeQueryResult(input = {}) {
  const raw = assertPlainObject(input, 'Database query result');
  if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) fail('Database query result columns and rows are required.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  const columns = raw.columns.map((item, index) => {
    if (typeof item === 'string') return Object.freeze({ name: requiredText(item, `Query column ${index + 1}`, 512), dataType: null });
    const column = assertPlainObject(item, `Query column ${index + 1}`);
    return Object.freeze({ name: requiredText(column.name, `Query column ${index + 1}`, 512), dataType: optionalText(column.dataType, 'Query column data type', 200) });
  });
  const rows = raw.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) fail('Database query result row width does not match its columns.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
    return row.map((value) => normalizeResultValue(value));
  });
  const affectedRows = Number(raw.affectedRows ?? 0);
  if (!Number.isSafeInteger(affectedRows) || affectedRows < 0) fail('Database query result affected-row count is invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  return Object.freeze({
    columns: Object.freeze(columns),
    rows: Object.freeze(rows.map(Object.freeze)),
    affectedRows,
    truncated: Boolean(raw.truncated),
    pagination: normalizePagination(raw.pagination),
    executionTimeMs: normalizeExecutionTime(raw.executionTimeMs),
    warnings: Object.freeze(normalizeWarnings(raw.warnings)),
    additionalResults: Object.freeze((raw.additionalResults || []).map(normalizeQueryResult))
  });
}

function normalizeSchemaSnapshotRequest(input = {}) {
  const raw = assertPlainObject(input, 'Database schema request');
  const maxTables = Number(raw.maxTables ?? 500);
  const maxColumnsPerTable = Number(raw.maxColumnsPerTable ?? 500);
  if (!Number.isInteger(maxTables) || maxTables < 1 || maxTables > MAX_SCHEMA_TABLES) fail(`Database schema table limit must be between 1 and ${MAX_SCHEMA_TABLES}.`);
  if (!Number.isInteger(maxColumnsPerTable) || maxColumnsPerTable < 1 || maxColumnsPerTable > MAX_SCHEMA_COLUMNS_PER_TABLE) fail(`Database schema column limit must be between 1 and ${MAX_SCHEMA_COLUMNS_PER_TABLE}.`);
  return Object.freeze({
    requestId: optionalText(raw.requestId, 'Schema request ID', 200) || `dbs_${crypto.randomUUID()}`,
    profileId: requiredText(raw.profileId, 'Database profile ID', 200),
    schema: optionalText(raw.schema, 'Database schema name', 512),
    includeSystem: Boolean(raw.includeSystem),
    maxTables,
    maxColumnsPerTable
  });
}

function normalizeSchemaSnapshot(input = {}) {
  const raw = assertPlainObject(input, 'Database schema snapshot');
  if (!Array.isArray(raw.schemas) || raw.schemas.length > 100) fail('Database schema snapshot schemas are invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  let tableCount = 0;
  const schemas = raw.schemas.map((schemaInput) => {
    const schema = assertPlainObject(schemaInput, 'Database schema');
    if (!Array.isArray(schema.tables)) fail('Database schema tables are required.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
    tableCount += schema.tables.length;
    if (tableCount > MAX_SCHEMA_TABLES) fail('Database schema snapshot contains too many tables.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
    const tables = schema.tables.map((tableInput) => {
      const table = assertPlainObject(tableInput, 'Database table');
      if (!Array.isArray(table.columns) || table.columns.length > MAX_SCHEMA_COLUMNS_PER_TABLE) fail('Database table columns are invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
      const type = String(table.type || 'table').toLowerCase();
      if (!['table', 'view', 'materialized-view', 'collection', 'bucket', 'graph', 'other'].includes(type)) fail('Database table type is invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
      const indexes = Array.isArray(table.indexes) ? table.indexes.slice(0, 500).map((indexInput) => {
        const index = assertPlainObject(indexInput, 'Database index');
        if (!Array.isArray(index.columns) || index.columns.length < 1 || index.columns.length > 100) fail('Database index columns are invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
        return Object.freeze({
          name: requiredText(index.name, 'Database index name', 512),
          unique: Boolean(index.unique),
          columns: Object.freeze(index.columns.map((column) => requiredText(column, 'Database index column', 512)))
        });
      }) : [];
      const foreignKeys = Array.isArray(table.foreignKeys) ? table.foreignKeys.slice(0, 500).map((foreignKeyInput) => {
        const foreignKey = assertPlainObject(foreignKeyInput, 'Database foreign key');
        if (!Array.isArray(foreignKey.columns) || !foreignKey.columns.length || foreignKey.columns.length > 100
          || !Array.isArray(foreignKey.referencedColumns) || foreignKey.referencedColumns.length !== foreignKey.columns.length) {
          fail('Database foreign-key columns are invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
        }
        return Object.freeze({
          name: requiredText(foreignKey.name, 'Database foreign-key name', 512),
          columns: Object.freeze(foreignKey.columns.map((column) => requiredText(column, 'Database foreign-key column', 512))),
          referencedSchema: requiredText(foreignKey.referencedSchema || schema.name, 'Referenced schema name', 512),
          referencedTable: requiredText(foreignKey.referencedTable, 'Referenced table name', 512),
          referencedColumns: Object.freeze(foreignKey.referencedColumns.map((column) => requiredText(column, 'Referenced foreign-key column', 512))),
          onDelete: optionalText(foreignKey.onDelete, 'Foreign-key ON DELETE action', 40),
          onUpdate: optionalText(foreignKey.onUpdate, 'Foreign-key ON UPDATE action', 40)
        });
      }) : [];
      return Object.freeze({
        name: requiredText(table.name, 'Database table name', 512),
        type,
        columns: Object.freeze(table.columns.map((columnInput) => {
          const column = assertPlainObject(columnInput, 'Database column');
          return Object.freeze({
            name: requiredText(column.name, 'Database column name', 512),
            dataType: optionalText(column.dataType, 'Database column type', 200),
            nullable: column.nullable !== false,
            primaryKey: Boolean(column.primaryKey),
            defaultValue: optionalText(column.defaultValue, 'Database column default', 2000)
          });
        })),
        indexes: Object.freeze(indexes),
        foreignKeys: Object.freeze(foreignKeys)
      });
    });
    return Object.freeze({ name: requiredText(schema.name, 'Database schema name', 512), tables: Object.freeze(tables) });
  });
  return Object.freeze({
    database: optionalText(raw.database, 'Database name', 512),
    schemas: Object.freeze(schemas),
    truncated: Boolean(raw.truncated),
    warnings: Object.freeze(normalizeWarnings(raw.warnings))
  });
}

function normalizeSavedQueryInput(input = {}) {
  const raw = assertPlainObject(input, 'Saved database query');
  const query = String(raw.query ?? '').trim();
  if (!query || query.includes('\0') || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
    fail('Saved database query is empty or too large.', 'DATABASE_MANAGER_SAVED_QUERY_INVALID');
  }
  return Object.freeze({
    profileId: requiredText(raw.profileId, 'Database profile ID', 200),
    name: requiredText(raw.name, 'Saved query name', 200),
    description: optionalText(raw.description, 'Saved query description', 2000),
    query,
    tags: Object.freeze(normalizeTags(raw.tags))
  });
}

function normalizeNotebookInput(input = {}) {
  const raw = assertPlainObject(input, 'Database notebook');
  if (!Array.isArray(raw.cells) || !raw.cells.length || raw.cells.length > 100) {
    fail('A database notebook must contain between 1 and 100 cells.', 'DATABASE_MANAGER_NOTEBOOK_INVALID');
  }
  let totalBytes = 0;
  const ids = new Set();
  const cells = raw.cells.map((cellInput, index) => {
    const cell = assertPlainObject(cellInput, 'Database notebook cell');
    const id = requiredText(cell.id || `cell-${index + 1}`, 'Database notebook cell ID', 120);
    if (ids.has(id)) fail('Database notebook cell IDs must be unique.', 'DATABASE_MANAGER_NOTEBOOK_INVALID');
    ids.add(id);
    const type = String(cell.type || '').toLowerCase();
    if (!['sql', 'markdown', 'chart'].includes(type)) fail('Database notebook cell type is invalid.', 'DATABASE_MANAGER_NOTEBOOK_INVALID');
    const content = type === 'chart' ? '' : String(cell.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (content.includes('\0') || bytes > MAX_QUERY_BYTES) fail('Database notebook cell content is too large.', 'DATABASE_MANAGER_NOTEBOOK_INVALID');
    totalBytes += bytes;
    const normalized = { id, type, content, collapsed: cell.collapsed === true };
    if (type === 'chart') {
      const chart = assertPlainObject(cell.chart, 'Database notebook chart');
      normalized.chart = Object.freeze({
        sourceCellId: requiredText(chart.sourceCellId, 'Database notebook chart source cell ID', 120),
        chartType: ['bar', 'line'].includes(chart.chartType) ? chart.chartType : 'bar',
        categoryColumn: optionalText(chart.categoryColumn, 'Database notebook chart category column', 200),
        valueColumn: optionalText(chart.valueColumn, 'Database notebook chart value column', 200)
      });
      totalBytes += Buffer.byteLength(JSON.stringify(normalized.chart), 'utf8');
    }
    return Object.freeze(normalized);
  });
  for (const cell of cells.filter((item) => item.type === 'chart')) {
    if (!cells.some((item) => item.id === cell.chart.sourceCellId && item.type === 'sql')) {
      fail('Database notebook chart source must reference a SQL cell.', 'DATABASE_MANAGER_NOTEBOOK_INVALID');
    }
  }
  if (totalBytes > 4 * 1024 * 1024) fail('Database notebook content exceeds 4 MiB.', 'DATABASE_MANAGER_NOTEBOOK_INVALID');
  return Object.freeze({
    profileId: requiredText(raw.profileId, 'Database profile ID', 200),
    name: requiredText(raw.name, 'Database notebook name', 200),
    description: optionalText(raw.description, 'Database notebook description', 2000),
    cells: Object.freeze(cells),
    tags: Object.freeze(normalizeTags(raw.tags))
  });
}

function normalizeDatabaseTaskInput(input = {}) {
  const raw = assertPlainObject(input, 'Database task');
  const type = String(raw.type || '').toLowerCase();
  const state = String(raw.state || 'queued').toLowerCase();
  if (!DATABASE_TASK_TYPES.includes(type)) fail('Database task type is invalid.', 'DATABASE_MANAGER_TASK_INVALID');
  if (!DATABASE_TASK_STATES.includes(state)) fail('Database task state is invalid.', 'DATABASE_MANAGER_TASK_INVALID');
  const progressInput = raw.progress === undefined ? {} : assertPlainObject(raw.progress, 'Database task progress');
  const percent = Number(progressInput.percent ?? 0);
  const itemsTotal = Number(progressInput.itemsTotal ?? 0);
  const itemsCompleted = Number(progressInput.itemsCompleted ?? 0);
  const bytesTotal = Number(progressInput.bytesTotal ?? 0);
  const bytesCompleted = Number(progressInput.bytesCompleted ?? 0);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) fail('Database task progress percentage is invalid.', 'DATABASE_MANAGER_TASK_INVALID');
  for (const [label, value] of [['item total', itemsTotal], ['completed item count', itemsCompleted], ['byte total', bytesTotal], ['completed byte count', bytesCompleted]]) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`Database task ${label} is invalid.`, 'DATABASE_MANAGER_TASK_INVALID');
  }
  if ((itemsTotal && itemsCompleted > itemsTotal) || (bytesTotal && bytesCompleted > bytesTotal)) fail('Database task progress exceeds its total.', 'DATABASE_MANAGER_TASK_INVALID');
  const normalizeTime = (value, label) => {
    const text = optionalText(value, label, 100);
    if (text && !Number.isFinite(Date.parse(text))) fail(`${label} is invalid.`, 'DATABASE_MANAGER_TASK_INVALID');
    return text;
  };
  const terminal = ['succeeded', 'failed', 'canceled'].includes(state);
  return Object.freeze({
    profileId: requiredText(raw.profileId, 'Database profile ID', 200),
    type,
    label: requiredText(raw.label, 'Database task label', 200),
    state,
    progress: Object.freeze({
      phase: optionalText(progressInput.phase, 'Database task progress phase', 80),
      percent,
      itemsTotal,
      itemsCompleted,
      bytesTotal,
      bytesCompleted,
      message: optionalText(progressInput.message, 'Database task progress message', 500)
    }),
    canCancel: !terminal && raw.canCancel !== false,
    safeMessage: optionalText(raw.safeMessage, 'Database task message', 1000),
    startedAt: normalizeTime(raw.startedAt, 'Database task start time'),
    completedAt: normalizeTime(raw.completedAt, 'Database task completion time')
  });
}

function normalizeQueryHistoryInput(input = {}) {
  const raw = assertPlainObject(input, 'Database query history entry');
  const query = String(raw.query ?? '').trim();
  if (!query || query.includes('\0') || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
    fail('Database query history SQL is empty or too large.', 'DATABASE_MANAGER_QUERY_HISTORY_INVALID');
  }
  const status = String(raw.status || '').toLowerCase();
  if (!['succeeded', 'failed', 'cancelled'].includes(status)) fail('Database query history status is invalid.');
  const classification = optionalText(raw.classification, 'Database query classification', 40);
  if (classification && !['read', 'mutation', 'destructive', 'unknown'].includes(classification)) fail('Database query classification is invalid.');
  const source = ['editor', 'notebook', 'grid', 'schema', 'plugin', 'import', 'explain'].includes(raw.source) ? raw.source : 'editor';
  const executionTimeMs = Number(raw.executionTimeMs ?? 0);
  const rowCount = Number(raw.rowCount ?? 0);
  const affectedRows = Number(raw.affectedRows ?? 0);
  if (!Number.isFinite(executionTimeMs) || executionTimeMs < 0) fail('Database query history execution time is invalid.');
  if (!Number.isInteger(rowCount) || rowCount < 0) fail('Database query history row count is invalid.');
  if (!Number.isInteger(affectedRows) || affectedRows < 0) fail('Database query history affected-row count is invalid.');
  return Object.freeze({
    profileId: requiredText(raw.profileId, 'Database profile ID', 200),
    query,
    source,
    status,
    classification,
    executionTimeMs,
    rowCount,
    affectedRows,
    errorCode: optionalText(raw.errorCode, 'Database query history error code', 120),
    safeMessage: optionalText(raw.safeMessage, 'Database query history error message', 1000)
  });
}

function normalizeResultValue(value, depth = 0) {
  if (depth > 20) fail('Database query result is too deeply nested.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeResultValue(item, depth + 1));
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return Object.freeze({ type: 'binary', byteLength: value.byteLength, base64: value.toString('base64') });
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = normalizeResultValue(item, depth + 1);
    return result;
  }
  return String(value);
}

function normalizePagination(input) {
  if (input === null || input === undefined) return null;
  const raw = assertPlainObject(input, 'Database query pagination');
  const page = Number(raw.page);
  const pageSize = Number(raw.pageSize);
  const totalRows = raw.totalRows === null || raw.totalRows === undefined ? null : Number(raw.totalRows);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_QUERY_PAGE_SIZE) {
    fail('Database query pagination is invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  }
  if (totalRows !== null && (!Number.isSafeInteger(totalRows) || totalRows < 0)) fail('Database query total-row count is invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  return Object.freeze({ page, pageSize, totalRows, hasMore: Boolean(raw.hasMore) });
}

function normalizeExecutionTime(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) fail('Database query execution time is invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  return number;
}

function normalizeWarnings(input) {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input) || input.length > 100) fail('Database query warnings are invalid.', 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  return input.map((warning) => requiredText(warning, 'Database query warning', 1000));
}

function projectProfileForCloud(input = {}) {
  const profile = normalizeProfileInput(input);
  let endpoint = profile.endpoint;
  if (endpoint.kind === 'file' || endpoint.kind === 'folder') {
    endpoint = Object.freeze({ kind: endpoint.kind, localResourceRequired: true });
  } else if (endpoint.kind === 'api' && endpoint.baseUrl) {
    const cloudUrl = new URL(endpoint.baseUrl);
    cloudUrl.search = '';
    cloudUrl.hash = '';
    endpoint = Object.freeze({ kind: endpoint.kind, baseUrl: cloudUrl.toString() });
  }
  return Object.freeze({
    schemaVersion: profile.schemaVersion,
    name: profile.name,
    driverId: profile.driverId,
    sharedConnectionId: profile.sharedConnectionId,
    projectId: profile.projectId,
    endpoint,
    database: profile.database,
    defaultSchema: profile.defaultSchema,
    environment: profile.environment,
    accessMode: profile.accessMode,
    tags: profile.tags,
    ssl: profile.ssl,
    tunnel: profile.tunnel,
    credentialSlots: profile.credentialSlots,
    appearance: profile.appearance
  });
}

function normalizeSafeDetails(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (item === null || ['boolean', 'number'].includes(typeof item)) result[key] = item;
    else if (typeof item === 'string') result[key] = item.slice(0, 500);
  }
  return result;
}

module.exports = {
  ACCESS_MODES,
  BUILT_IN_DRIVERS,
  DATABASE_TASK_STATES,
  DATABASE_TASK_TYPES,
  DATABASE_MANAGER_SCHEMA_VERSION,
  DEFAULT_QUERY_PAGE_SIZE,
  DatabaseManagerValidationError,
  MAX_QUERY_BYTES,
  MAX_QUERY_HISTORY_ITEMS,
  MAX_QUERY_PAGE_SIZE,
  MAX_SCHEMA_COLUMNS_PER_TABLE,
  MAX_SCHEMA_TABLES,
  PROFILE_ENVIRONMENTS,
  normalizeDatabaseTaskInput,
  normalizeDriverManifest,
  normalizeProfileInput,
  normalizeQueryRequest,
  normalizeQueryResult,
  normalizeQueryHistoryInput,
  normalizeNotebookInput,
  normalizeSavedQueryInput,
  normalizeSchemaSnapshot,
  normalizeSchemaSnapshotRequest,
  normalizeSafeDetails,
  projectProfileForCloud
};
