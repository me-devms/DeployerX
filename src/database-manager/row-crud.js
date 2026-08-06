const crypto = require('node:crypto');

const SUPPORTED_DRIVERS = new Set(['postgresql', 'mysql', 'sqlite']);
const MAX_MUTATION_BYTES = 2 * 1024 * 1024;
const MAX_DELETE_ROWS = 100;
const MAX_CELL_BYTES = 512 * 1024;

function crudError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, safeMessage: message, category: 'database-manager', retryable: false, details });
}

function requiredText(value, label, maximumLength = 512) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0') || /\p{C}/u.test(text)) {
    throw crudError(`${label} is invalid.`, 'DATABASE_MANAGER_ROW_INPUT_INVALID');
  }
  return text;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw crudError(`${label} must be an object.`, 'DATABASE_MANAGER_ROW_INPUT_INVALID');
  }
  return value;
}

function quoteIdentifier(driverId, value) {
  const identifier = requiredText(value, 'Database identifier');
  return driverId === 'mysql' ? `\`${identifier.replace(/`/g, '``')}\`` : `"${identifier.replace(/"/g, '""')}"`;
}

function textExpression(driverId, value) {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  if (driverId === 'postgresql') return `convert_from(decode('${hex}', 'hex'), 'UTF8')`;
  if (driverId === 'mysql') return `CONVERT(0x${hex} USING utf8mb4)`;
  return `CAST(X'${hex}' AS TEXT)`;
}

function binaryExpression(driverId, value) {
  const base64 = String(value.base64 || '');
  const bytes = Buffer.from(base64, 'base64');
  if (!base64 || bytes.toString('base64') !== base64 || bytes.length > MAX_CELL_BYTES) {
    throw crudError('Binary row value is invalid or too large.', 'DATABASE_MANAGER_ROW_VALUE_INVALID');
  }
  if (driverId === 'postgresql') return `decode('${base64}', 'base64')`;
  if (driverId === 'mysql') return `FROM_BASE64('${base64}')`;
  return `X'${bytes.toString('hex')}'`;
}

function valueExpression(driverId, column, value) {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw crudError('Numeric row value is invalid.', 'DATABASE_MANAGER_ROW_VALUE_INVALID');
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    if (value?.type === 'binary') return binaryExpression(driverId, value);
    const dataType = String(column.dataType || '').toLowerCase();
    if (!/json/.test(dataType)) throw crudError(`${column.name} does not accept a structured JSON value.`, 'DATABASE_MANAGER_ROW_VALUE_INVALID');
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json, 'utf8') > MAX_CELL_BYTES) throw crudError('JSON row value is invalid or too large.', 'DATABASE_MANAGER_ROW_VALUE_INVALID');
    const expression = textExpression(driverId, json);
    if (driverId === 'postgresql') return `CAST(${expression} AS ${dataType.includes('jsonb') ? 'jsonb' : 'json'})`;
    if (driverId === 'mysql') return `CAST(${expression} AS JSON)`;
    return expression;
  }
  const text = String(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_CELL_BYTES || text.includes('\0')) throw crudError('Text row value is invalid or too large.', 'DATABASE_MANAGER_ROW_VALUE_INVALID');
  return textExpression(driverId, text);
}

function columnMap(table) {
  return new Map((table.columns || []).map((column) => [column.name, column]));
}

function normalizedValues(table, input, label) {
  const raw = plainObject(input, label);
  const columns = columnMap(table);
  const entries = Object.entries(raw);
  if (!entries.length || entries.length > columns.size) throw crudError(`${label} is empty or too large.`, 'DATABASE_MANAGER_ROW_INPUT_INVALID');
  for (const [name] of entries) if (!columns.has(name)) throw crudError(`Column ${name} was not found in the current table schema.`, 'DATABASE_MANAGER_ROW_COLUMN_NOT_FOUND');
  return entries.map(([name, value]) => [columns.get(name), value]);
}

function keyPredicate(driverId, table, input) {
  const keys = (table.columns || []).filter((column) => column.primaryKey);
  if (!keys.length) throw crudError('Row updates and deletes require a table primary key.', 'DATABASE_MANAGER_ROW_PRIMARY_KEY_REQUIRED');
  const values = plainObject(input, 'Row primary key');
  if (Object.keys(values).length !== keys.length || keys.some((column) => !Object.hasOwn(values, column.name))) {
    throw crudError('Provide every primary-key value for this row.', 'DATABASE_MANAGER_ROW_PRIMARY_KEY_INVALID');
  }
  return keys.map((column) => values[column.name] === null
    ? `${quoteIdentifier(driverId, column.name)} IS NULL`
    : `${quoteIdentifier(driverId, column.name)} = ${valueExpression(driverId, column, values[column.name])}`).join(' AND ');
}

function qualifiedTable(driverId, schemaName, tableName) {
  return `${quoteIdentifier(driverId, schemaName)}.${quoteIdentifier(driverId, tableName)}`;
}

function assertMutationSize(sql) {
  if (Buffer.byteLength(sql, 'utf8') > MAX_MUTATION_BYTES) throw crudError('The generated row mutation is too large.', 'DATABASE_MANAGER_ROW_MUTATION_TOO_LARGE');
  return sql;
}

function buildRowMutationSql({ driverId, action, schema, table, values, key, keys } = {}) {
  if (!SUPPORTED_DRIVERS.has(driverId)) throw crudError('This database driver does not support row editing.', 'DATABASE_MANAGER_ROW_DRIVER_UNSUPPORTED');
  if (!table || table.type !== 'table' || !Array.isArray(table.columns)) throw crudError('Choose a writable table from the current schema.', 'DATABASE_MANAGER_ROW_TABLE_INVALID');
  const target = qualifiedTable(driverId, requiredText(schema, 'Database schema'), requiredText(table.name, 'Database table'));
  if (action === 'insert') {
    const entries = normalizedValues(table, values, 'Inserted row values');
    return assertMutationSize(`INSERT INTO ${target} (${entries.map(([column]) => quoteIdentifier(driverId, column.name)).join(', ')}) VALUES (${entries.map(([column, value]) => valueExpression(driverId, column, value)).join(', ')})`);
  }
  if (action === 'update') {
    const entries = normalizedValues(table, values, 'Updated row values');
    const primaryKeys = new Set(table.columns.filter((column) => column.primaryKey).map((column) => column.name));
    if (entries.some(([column]) => primaryKeys.has(column.name))) throw crudError('Primary-key columns cannot be changed from the row editor.', 'DATABASE_MANAGER_ROW_PRIMARY_KEY_UPDATE_UNSUPPORTED');
    const assignments = entries.map(([column, value]) => `${quoteIdentifier(driverId, column.name)} = ${valueExpression(driverId, column, value)}`).join(', ');
    return assertMutationSize(`UPDATE ${target} SET ${assignments} WHERE ${keyPredicate(driverId, table, key)}`);
  }
  if (action === 'delete') {
    if (!Array.isArray(keys) || !keys.length || keys.length > MAX_DELETE_ROWS) throw crudError(`Delete between 1 and ${MAX_DELETE_ROWS} rows at a time.`, 'DATABASE_MANAGER_ROW_DELETE_LIMIT');
    const predicates = keys.map((item) => `(${keyPredicate(driverId, table, item)})`);
    return assertMutationSize(`DELETE FROM ${target} WHERE ${predicates.join(' OR ')}`);
  }
  throw crudError('Row mutation action is invalid.', 'DATABASE_MANAGER_ROW_ACTION_INVALID');
}

function findTable(snapshot, schemaName, tableName) {
  const schema = (snapshot.schemas || []).find((item) => item.name === schemaName);
  return schema?.tables?.find((item) => item.name === tableName) || null;
}

class DatabaseRowCrudService {
  constructor({ profileService, schemaService, queryService } = {}) {
    if (!profileService?.get) throw new TypeError('Database row CRUD requires the profile service.');
    if (!schemaService?.load) throw new TypeError('Database row CRUD requires the schema service.');
    if (!queryService?.execute) throw new TypeError('Database row CRUD requires the query service.');
    this.profileService = profileService;
    this.schemaService = schemaService;
    this.queryService = queryService;
  }

  async execute(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId || 'system', 'Actor ID', 200);
    const profileId = requiredText(input.profileId, 'Database profile ID', 200);
    const profile = await this.profileService.get(tenant, profileId);
    if (!profile) throw crudError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    if (profile.accessMode === 'read-only') throw crudError('This profile is read only and cannot edit rows.', 'DATABASE_MANAGER_READ_ONLY_VIOLATION');
    if (!SUPPORTED_DRIVERS.has(profile.driverId)) throw crudError('This database driver does not support row editing.', 'DATABASE_MANAGER_ROW_DRIVER_UNSUPPORTED');
    if (input.action === 'delete' && input.approval?.confirmed !== true) {
      throw crudError('Confirm the selected row deletion before continuing.', 'DATABASE_MANAGER_ROW_DELETE_CONFIRMATION_REQUIRED');
    }
    const schemaName = requiredText(input.schema || profile.defaultSchema || (profile.driverId === 'sqlite' ? 'main' : ''), 'Database schema');
    const tableName = requiredText(input.table, 'Database table');
    const schemaResult = await this.schemaService.load(tenant, actor, {
      requestId: `dbs_row_${crypto.randomUUID()}`, profileId, schema: schemaName, includeSystem: false, maxTables: 1000, maxColumnsPerTable: 1000
    });
    const table = findTable(schemaResult.snapshot, schemaName, tableName);
    if (!table) throw crudError('The table was not found in the current database schema.', 'DATABASE_MANAGER_ROW_TABLE_NOT_FOUND');
    const sql = buildRowMutationSql({ driverId: profile.driverId, action: input.action, schema: schemaName, table, values: input.values, key: input.key, keys: input.keys });
    const execution = await this.queryService.execute(tenant, actor, {
      requestId: requiredText(input.requestId || `dbr_${crypto.randomUUID()}`, 'Database row request ID', 200),
      profileId, query: sql, page: 1, pageSize: 1, batch: false, source: 'grid', approval: input.approval
    });
    return Object.freeze({ action: input.action, schema: schemaName, table: tableName, affectedRows: execution.result.affectedRows, execution });
  }
}

module.exports = {
  DatabaseRowCrudService,
  MAX_DELETE_ROWS,
  SUPPORTED_DRIVERS,
  buildRowMutationSql,
  findTable,
  quoteIdentifier,
  valueExpression
};
