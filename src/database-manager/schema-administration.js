const crypto = require('node:crypto');
const { classifySql, enforceSqlPolicy } = require('./sql-safety');
const { DEFINITION_CLASSIFICATION } = require('./definition-executor');

const BUILT_IN_SCHEMA_ACTIONS = Object.freeze({
  postgresql: Object.freeze(['create-schema', 'drop-schema', 'create-table', 'rename-table', 'drop-table', 'add-column', 'rename-column', 'drop-column', 'set-column-nullable', 'create-index', 'drop-index', 'add-foreign-key', 'drop-foreign-key', 'create-view', 'replace-view', 'drop-view', 'create-materialized-view', 'drop-materialized-view', 'refresh-materialized-view', 'create-routine', 'drop-routine', 'create-trigger', 'drop-trigger']),
  mysql: Object.freeze(['create-table', 'rename-table', 'drop-table', 'add-column', 'rename-column', 'drop-column', 'set-column-nullable', 'create-index', 'drop-index', 'add-foreign-key', 'drop-foreign-key', 'create-view', 'replace-view', 'drop-view', 'create-routine', 'drop-routine', 'create-trigger', 'drop-trigger']),
  sqlite: Object.freeze(['create-table', 'rename-table', 'drop-table', 'add-column', 'rename-column', 'drop-column', 'create-index', 'drop-index', 'create-view', 'drop-view', 'create-trigger', 'drop-trigger'])
});

const MAX_COLUMNS = 100;
const MAX_INDEX_COLUMNS = 32;
const DATA_TYPE_PATTERN = /^[a-z][a-z0-9_ ]{0,62}(?:\(\s*\d{1,6}(?:\s*,\s*\d{1,6})?\s*\))?(?:\[\])?$/i;
const REFERENTIAL_ACTIONS = new Set(['no-action', 'restrict', 'cascade', 'set-null', 'set-default']);
const TABLE_ACTIONS = new Set(['create-table', 'rename-table', 'drop-table', 'add-column', 'rename-column', 'drop-column', 'set-column-nullable', 'create-index', 'drop-index', 'add-foreign-key', 'drop-foreign-key']);
const VIEW_ACTIONS = new Set(['create-view', 'replace-view', 'drop-view', 'create-materialized-view', 'drop-materialized-view', 'refresh-materialized-view']);
const DEFINITION_ACTIONS = new Set(['create-routine', 'create-trigger']);
const ROUTINE_ACTIONS = new Set(['create-routine', 'drop-routine']);
const TRIGGER_ACTIONS = new Set(['create-trigger', 'drop-trigger']);

function administrationError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, safeMessage: message, category: 'database-manager', retryable: false, details });
}

function requiredText(value, label, maximumLength = 512) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0') || /\p{C}/u.test(text)) {
    throw administrationError(`${label} is invalid.`, 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  }
  return text;
}

function quoteIdentifier(driverId, value) {
  const identifier = requiredText(value, 'Database identifier');
  return driverId === 'mysql' ? `\`${identifier.replace(/`/g, '``')}\`` : `"${identifier.replace(/"/g, '""')}"`;
}

function dataType(value) {
  const type = requiredText(value, 'Column data type', 80).replace(/\s+/g, ' ');
  if (!DATA_TYPE_PATTERN.test(type)) throw administrationError('Column data type is invalid.', 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  return type.toUpperCase();
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw administrationError(`${label} must be an object.`, 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  }
  return value;
}

function normalizeColumn(input) {
  const column = plainObject(input, 'Database column');
  return Object.freeze({
    name: requiredText(column.name, 'Column name'),
    dataType: dataType(column.dataType),
    nullable: column.nullable !== false,
    primaryKey: Boolean(column.primaryKey),
    unique: Boolean(column.unique)
  });
}

function normalizeIdentifierList(input, label) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_INDEX_COLUMNS) {
    throw administrationError(`${label} must contain between 1 and ${MAX_INDEX_COLUMNS} columns.`, 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  }
  const values = input.map((value) => requiredText(typeof value === 'object' && value ? value.name : value, `${label} column`));
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) throw administrationError(`${label} columns must be unique.`, 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  return Object.freeze(values);
}

function normalizeViewQuery(value) {
  const query = String(value ?? '').trim().replace(/;+\s*$/, '').trim();
  if (!query || query.includes('\0') || Buffer.byteLength(query, 'utf8') > 1024 * 1024) throw administrationError('View query is empty or too large.', 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  const classification = classifySql(query);
  if (classification.kind !== 'read' || classification.statementCount !== 1 || classification.malformed) {
    throw administrationError('A view definition must contain one read-only SELECT statement.', 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  }
  return query;
}

function normalizeReferentialAction(value, label) {
  const action = String(value || 'no-action').trim().toLowerCase();
  if (!REFERENTIAL_ACTIONS.has(action)) throw administrationError(`${label} action is invalid.`, 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  return action;
}

function normalizeDefinition(value, action) {
  const definition = String(value ?? '').trim();
  if (!definition || definition.length > 1024 * 1024 || definition.includes('\0')) throw administrationError('The database definition is empty or too large.', 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  const pattern = action === 'create-routine' ? /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i : /^CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\b/i;
  if (!pattern.test(definition)) throw administrationError('The definition does not match the selected database object type.', 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  return definition;
}

function normalizeSchemaActionInput(input = {}, profile = {}) {
  const raw = plainObject(input, 'Database schema action');
  const driverId = String(profile.driverId || '').trim().toLowerCase();
  const action = String(raw.action || '').trim().toLowerCase();
  const supported = BUILT_IN_SCHEMA_ACTIONS[driverId] || [];
  if (!supported.includes(action)) {
    throw administrationError('This database driver does not support that schema action.', 'DATABASE_MANAGER_SCHEMA_ACTION_UNSUPPORTED', { driverId, action });
  }
  const schema = requiredText(raw.schema || profile.defaultSchema || (driverId === 'sqlite' ? 'main' : ''), 'Database schema');
  const normalized = { action, schema };
  if (TABLE_ACTIONS.has(action)) {
    normalized.table = requiredText(raw.table, 'Database table');
  }
  if (action === 'rename-table') normalized.newName = requiredText(raw.newName, 'New table name');
  if (['add-column', 'set-column-nullable'].includes(action)) normalized.column = normalizeColumn(raw.column);
  if (['rename-column', 'drop-column'].includes(action)) normalized.columnName = requiredText(raw.columnName, 'Column name');
  if (action === 'rename-column') normalized.newName = requiredText(raw.newName, 'New column name');
  if (action === 'create-table') {
    if (!Array.isArray(raw.columns) || !raw.columns.length || raw.columns.length > MAX_COLUMNS) {
      throw administrationError(`Create a table with between 1 and ${MAX_COLUMNS} columns.`, 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
    }
    normalized.columns = raw.columns.map(normalizeColumn);
    const names = new Set(normalized.columns.map((column) => column.name.toLowerCase()));
    if (names.size !== normalized.columns.length) throw administrationError('Table column names must be unique.', 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  }
  if (action === 'drop-schema') normalized.cascade = Boolean(raw.cascade);
  if (['create-index', 'drop-index'].includes(action)) normalized.indexName = requiredText(raw.indexName, 'Database index name');
  if (action === 'create-index') {
    normalized.indexColumns = normalizeIdentifierList(raw.indexColumns, 'Database index');
    normalized.unique = Boolean(raw.unique);
  }
  if (['add-foreign-key', 'drop-foreign-key'].includes(action)) normalized.constraintName = requiredText(raw.constraintName, 'Foreign-key constraint name');
  if (action === 'add-foreign-key') {
    normalized.foreignKeyColumns = normalizeIdentifierList(raw.foreignKeyColumns, 'Foreign key');
    normalized.referencedSchema = requiredText(raw.referencedSchema || schema, 'Referenced schema');
    normalized.referencedTable = requiredText(raw.referencedTable, 'Referenced table');
    normalized.referencedColumns = normalizeIdentifierList(raw.referencedColumns, 'Referenced key');
    if (normalized.foreignKeyColumns.length !== normalized.referencedColumns.length) throw administrationError('Foreign-key and referenced column counts must match.', 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
    normalized.onDelete = normalizeReferentialAction(raw.onDelete, 'ON DELETE');
    normalized.onUpdate = normalizeReferentialAction(raw.onUpdate, 'ON UPDATE');
  }
  if (VIEW_ACTIONS.has(action)) normalized.objectName = requiredText(raw.objectName, 'Database object name');
  if (['create-view', 'replace-view', 'create-materialized-view'].includes(action)) normalized.query = normalizeViewQuery(raw.query);
  if (DEFINITION_ACTIONS.has(action)) {
    normalized.objectName = requiredText(raw.objectName, action === 'create-trigger' ? 'Trigger name' : 'Routine name');
    normalized.definition = normalizeDefinition(raw.definition, action);
    if (action === 'create-trigger') normalized.table = requiredText(raw.table, 'Trigger table');
  }
  if (action === 'drop-trigger') {
    normalized.objectName = requiredText(raw.objectName, 'Trigger name');
    normalized.table = requiredText(raw.table, 'Trigger table');
  }
  if (action === 'drop-routine') {
    normalized.objectName = requiredText(raw.objectName, 'Routine name');
    normalized.routineKind = String(raw.routineKind || 'function').toLowerCase();
    if (!['function', 'procedure'].includes(normalized.routineKind)) throw administrationError('Routine kind is invalid.', 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
    normalized.signature = Array.isArray(raw.signature) ? Object.freeze(raw.signature.map((value) => dataType(value))) : Object.freeze([]);
  }
  return Object.freeze(normalized);
}

function columnSql(driverId, column, { allowPrimaryKey = true } = {}) {
  return [
    quoteIdentifier(driverId, column.name),
    column.dataType,
    column.nullable ? 'NULL' : 'NOT NULL',
    allowPrimaryKey && column.primaryKey ? 'PRIMARY KEY' : '',
    column.unique ? 'UNIQUE' : ''
  ].filter(Boolean).join(' ');
}

function qualifiedName(driverId, schema, table) {
  return `${quoteIdentifier(driverId, schema)}.${quoteIdentifier(driverId, table)}`;
}

function referentialActionSql(value) {
  return value.toUpperCase().replace('-', ' ');
}

function buildSchemaMutationSql(driverIdValue, input = {}) {
  const driverId = String(driverIdValue || '').trim().toLowerCase();
  const action = normalizeSchemaActionInput(input, { driverId, defaultSchema: input.schema });
  const target = action.table ? qualifiedName(driverId, action.schema, action.table) : '';
  if (action.action === 'create-schema') return `CREATE SCHEMA ${quoteIdentifier(driverId, action.schema)}`;
  if (action.action === 'drop-schema') return `DROP SCHEMA ${quoteIdentifier(driverId, action.schema)}${action.cascade ? ' CASCADE' : ''}`;
  if (action.action === 'create-table') {
    const primaryKeys = action.columns.filter((column) => column.primaryKey);
    const definitions = action.columns.map((column) => columnSql(driverId, column, { allowPrimaryKey: primaryKeys.length === 1 }));
    if (primaryKeys.length > 1) definitions.push(`PRIMARY KEY (${primaryKeys.map((column) => quoteIdentifier(driverId, column.name)).join(', ')})`);
    return `CREATE TABLE ${target} (${definitions.join(', ')})`;
  }
  if (action.action === 'rename-table') return `ALTER TABLE ${target} RENAME TO ${quoteIdentifier(driverId, action.newName)}`;
  if (action.action === 'drop-table') return `DROP TABLE ${target}`;
  if (action.action === 'add-column') return `ALTER TABLE ${target} ADD COLUMN ${columnSql(driverId, action.column)}`;
  if (action.action === 'rename-column') return `ALTER TABLE ${target} RENAME COLUMN ${quoteIdentifier(driverId, action.columnName)} TO ${quoteIdentifier(driverId, action.newName)}`;
  if (action.action === 'drop-column') return `ALTER TABLE ${target} DROP COLUMN ${quoteIdentifier(driverId, action.columnName)}`;
  if (action.action === 'set-column-nullable') {
    const column = action.column;
    if (driverId === 'postgresql') return `ALTER TABLE ${target} ALTER COLUMN ${quoteIdentifier(driverId, column.name)} ${column.nullable ? 'DROP' : 'SET'} NOT NULL`;
    return `ALTER TABLE ${target} MODIFY COLUMN ${columnSql(driverId, column)}`;
  }
  if (action.action === 'create-index') {
    const indexName = driverId === 'mysql' ? quoteIdentifier(driverId, action.indexName) : qualifiedName(driverId, action.schema, action.indexName);
    const tableName = driverId === 'sqlite' ? quoteIdentifier(driverId, action.table) : target;
    return `CREATE ${action.unique ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${tableName} (${action.indexColumns.map((column) => quoteIdentifier(driverId, column)).join(', ')})`;
  }
  if (action.action === 'drop-index') {
    if (driverId === 'mysql') return `DROP INDEX ${quoteIdentifier(driverId, action.indexName)} ON ${target}`;
    return `DROP INDEX ${qualifiedName(driverId, action.schema, action.indexName)}`;
  }
  if (action.action === 'add-foreign-key') {
    return `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdentifier(driverId, action.constraintName)} FOREIGN KEY (${action.foreignKeyColumns.map((column) => quoteIdentifier(driverId, column)).join(', ')}) REFERENCES ${qualifiedName(driverId, action.referencedSchema, action.referencedTable)} (${action.referencedColumns.map((column) => quoteIdentifier(driverId, column)).join(', ')}) ON DELETE ${referentialActionSql(action.onDelete)} ON UPDATE ${referentialActionSql(action.onUpdate)}`;
  }
  if (action.action === 'drop-foreign-key') {
    return `ALTER TABLE ${target} DROP ${driverId === 'mysql' ? 'FOREIGN KEY' : 'CONSTRAINT'} ${quoteIdentifier(driverId, action.constraintName)}`;
  }
  if (['create-view', 'replace-view'].includes(action.action)) {
    return `CREATE ${action.action === 'replace-view' ? 'OR REPLACE ' : ''}VIEW ${qualifiedName(driverId, action.schema, action.objectName)} AS ${action.query}`;
  }
  if (action.action === 'drop-view') return `DROP VIEW ${qualifiedName(driverId, action.schema, action.objectName)}`;
  if (action.action === 'create-materialized-view') return `CREATE MATERIALIZED VIEW ${qualifiedName(driverId, action.schema, action.objectName)} AS ${action.query}`;
  if (action.action === 'drop-materialized-view') return `DROP MATERIALIZED VIEW ${qualifiedName(driverId, action.schema, action.objectName)}`;
  if (action.action === 'refresh-materialized-view') return `REFRESH MATERIALIZED VIEW ${qualifiedName(driverId, action.schema, action.objectName)}`;
  if (action.action === 'create-routine' || action.action === 'create-trigger') return action.definition;
  if (action.action === 'drop-trigger') return `DROP TRIGGER ${qualifiedName(driverId, action.schema, action.objectName)}${driverId === 'postgresql' ? ` ON ${qualifiedName(driverId, action.schema, action.table)}` : ''}`;
  if (action.action === 'drop-routine') {
    const keyword = action.routineKind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
    const signature = driverId === 'postgresql' && action.signature.length ? `(${action.signature.join(', ')})` : '';
    return `DROP ${keyword} ${qualifiedName(driverId, action.schema, action.objectName)}${signature}`;
  }
  throw administrationError('Database schema action is invalid.', 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
}

function schemaAdministrationCapabilities(profile = {}) {
  const driverId = String(profile.driverId || '').trim().toLowerCase();
  const readOnly = profile.accessMode === 'read-only';
  return Object.freeze({
    driverId,
    available: !readOnly && Boolean(BUILT_IN_SCHEMA_ACTIONS[driverId]),
    readOnly,
    actions: Object.freeze(readOnly ? [] : [...(BUILT_IN_SCHEMA_ACTIONS[driverId] || [])])
  });
}

function actionLabel(action) {
  const subject = action.objectName || action.indexName || action.constraintName || action.table || action.schema;
  return `${action.action.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')}: ${subject}`;
}

class DatabaseSchemaAdministrationService {
  constructor({ profileService, queryService, taskService, definitionExecutor = null } = {}) {
    if (!profileService?.get) throw new TypeError('Database schema administration requires the profile service.');
    if (!queryService?.execute || !queryService?.cancel) throw new TypeError('Database schema administration requires the query service.');
    if (!taskService?.create || !taskService?.start || !taskService?.complete) throw new TypeError('Database schema administration requires the task service.');
    this.profileService = profileService;
    this.queryService = queryService;
    this.taskService = taskService;
    this.definitionExecutor = definitionExecutor;
  }

  async capabilities(workspaceId, profileId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const profile = await this.profileService.get(tenant, requiredText(profileId, 'Database profile ID', 200));
    if (!profile) throw administrationError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    return schemaAdministrationCapabilities(profile);
  }

  async execute(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId || 'system', 'Actor ID', 200);
    const profileId = requiredText(input.profileId, 'Database profile ID', 200);
    const profile = await this.profileService.get(tenant, profileId);
    if (!profile) throw administrationError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    if (profile.accessMode === 'read-only') throw administrationError('This profile is read only and cannot change its schema.', 'DATABASE_MANAGER_READ_ONLY_VIOLATION');
    const action = normalizeSchemaActionInput(input, profile);
    const requestId = requiredText(input.requestId || `dba_${crypto.randomUUID()}`, 'Database schema action request ID', 200);
    const opaque = DEFINITION_ACTIONS.has(action.action);
    if (opaque && !this.definitionExecutor?.execute) throw administrationError('This database definition operation is not available yet.', 'DATABASE_MANAGER_SCHEMA_ACTION_UNSUPPORTED');
    const query = buildSchemaMutationSql(profile.driverId, action);
    enforceSqlPolicy({ profile, classification: opaque ? DEFINITION_CLASSIFICATION : classifySql(query), approval: input.approval, batch: false });
    const task = await this.taskService.create(tenant, actor, { profileId, type: opaque ? 'administration' : 'schema', label: actionLabel(action), canCancel: true });
    let current = await this.taskService.start(tenant, actor, task.id, task.revision);
    const executor = opaque ? this.definitionExecutor : this.queryService;
    const unregister = this.taskService.registerCancellation(tenant, task.id, () => executor.cancel(tenant, actor, requestId));
    try {
      const execution = await executor.execute(tenant, actor, {
        requestId,
        profileId,
        ...(opaque ? { query } : { query }),
        page: 1,
        pageSize: 1,
        batch: false,
        source: 'schema',
        approval: input.approval
      });
      current = await this.taskService.complete(tenant, actor, task.id, { expectedRevision: current.revision });
      return Object.freeze({ action, task: current, execution });
    } catch (error) {
      const latest = await this.taskService.get(tenant, task.id);
      if (latest && ['queued', 'running', 'interrupted'].includes(latest.state)) {
        await this.taskService.complete(tenant, actor, task.id, { state: 'failed', safeMessage: 'Database schema operation failed.', expectedRevision: latest.revision });
      }
      throw error;
    } finally {
      unregister();
    }
  }
}

module.exports = {
  BUILT_IN_SCHEMA_ACTIONS,
  DatabaseSchemaAdministrationService,
  buildSchemaMutationSql,
  normalizeSchemaActionInput,
  schemaAdministrationCapabilities
};
