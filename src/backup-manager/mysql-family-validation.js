const MAX_VALIDATION_OBJECTS = 10000;
const MAX_CHECK_TABLE_BATCH = 64;
const SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys'];

function databasePredicate(databases, column) {
  return `${column} IN (${databases.map((name) => `CONVERT(0x${Buffer.from(name, 'utf8').toString('hex')} USING utf8mb4)`).join(',')})`;
}

function tablePredicate(scope, databaseColumn, tableColumn) {
  const databaseClause = databasePredicate(scope.databases, databaseColumn);
  if (scope.mode !== 'tables') return databaseClause;
  return `${databaseClause} AND ${tableColumn} IN (${scope.tables.map((name) => `CONVERT(0x${Buffer.from(name, 'utf8').toString('hex')} USING utf8mb4)`).join(',')})`;
}

function captureInventoryQuery(selector, scope) {
  const schemaClause = selector.allDatabases
    ? `SCHEMA_NAME NOT IN (${SYSTEM_DATABASES.map((name) => `'${name}'`).join(',')})`
    : databasePredicate(scope.databases, 'SCHEMA_NAME');
  const tableClause = selector.allDatabases
    ? `TABLE_SCHEMA NOT IN (${SYSTEM_DATABASES.map((name) => `'${name}'`).join(',')})`
    : tablePredicate(scope, 'TABLE_SCHEMA', 'TABLE_NAME');
  const triggerClause = selector.allDatabases
    ? `TRIGGER_SCHEMA NOT IN (${SYSTEM_DATABASES.map((name) => `'${name}'`).join(',')})`
    : tablePredicate(scope, 'TRIGGER_SCHEMA', 'EVENT_OBJECT_TABLE');
  const clauses = [
    `SELECT SCHEMA_NAME, '', 'database', '' FROM information_schema.schemata WHERE ${schemaClause}`,
    `SELECT TABLE_SCHEMA, TABLE_NAME, 'relation', LOWER(REPLACE(TABLE_TYPE, 'BASE ', '')) FROM information_schema.tables WHERE ${tableClause}`,
    `SELECT TRIGGER_SCHEMA, TRIGGER_NAME, 'trigger', 'trigger' FROM information_schema.triggers WHERE ${triggerClause}`
  ];
  if (scope.mode !== 'tables') {
    const routineClause = selector.allDatabases
      ? `ROUTINE_SCHEMA NOT IN (${SYSTEM_DATABASES.map((name) => `'${name}'`).join(',')})`
      : databasePredicate(scope.databases, 'ROUTINE_SCHEMA');
    const eventClause = selector.allDatabases
      ? `EVENT_SCHEMA NOT IN (${SYSTEM_DATABASES.map((name) => `'${name}'`).join(',')})`
      : databasePredicate(scope.databases, 'EVENT_SCHEMA');
    clauses.push(
      `SELECT ROUTINE_SCHEMA, ROUTINE_NAME, 'routine', LOWER(ROUTINE_TYPE) FROM information_schema.routines WHERE ${routineClause}`,
      `SELECT EVENT_SCHEMA, EVENT_NAME, 'event', 'event' FROM information_schema.events WHERE ${eventClause}`
    );
  }
  return `${clauses.join(' UNION ALL ')} ORDER BY 1, 3, 2;`;
}

function validationInventoryQuery(metadata) {
  const databases = metadata.expectedDatabases || [];
  const selectedTables = metadata.selectionMode === 'tables' ? (metadata.selectedTables || []).map((item) => item.name) : [];
  return captureInventoryQuery({ allDatabases: false }, { mode: metadata.selectionMode, databases, tables: selectedTables });
}

function normalizeInventory(output, normalizeName, codePrefix) {
  const databases = new Map();
  const objects = new Map();
  const lines = String(output || '').split(/\r?\n/).filter(Boolean);
  if (lines.length > MAX_VALIDATION_OBJECTS + 1000) {
    const error = new Error('The native validation inventory contains too many objects.');
    error.code = `${codePrefix}_VALIDATION_INVENTORY_LIMIT_EXCEEDED`;
    error.category = 'capacity';
    throw error;
  }
  for (const line of lines) {
    const [databaseValue, nameValue, kindValue, typeValue] = line.split('\t');
    const database = normalizeName(databaseValue, `${codePrefix} validation database`);
    const kind = String(kindValue || '').toLowerCase();
    if (kind === 'database') {
      databases.set(database, database);
      continue;
    }
    if (!['relation', 'routine', 'trigger', 'event'].includes(kind)) {
      const error = new Error('The native validation inventory contains an unsupported object kind.');
      error.code = `${codePrefix}_VALIDATION_INVENTORY_INVALID`;
      error.category = 'integrity';
      throw error;
    }
    const name = normalizeName(nameValue, `${codePrefix} validation object`);
    const objectType = String(typeValue || '').toLowerCase();
    const item = { database, schema: database, name, kind, objectType };
    objects.set(`${database}\0${kind}\0${name}`, item);
  }
  if (objects.size > MAX_VALIDATION_OBJECTS) {
    const error = new Error('The native validation inventory contains too many objects.');
    error.code = `${codePrefix}_VALIDATION_INVENTORY_LIMIT_EXCEEDED`;
    error.category = 'capacity';
    throw error;
  }
  return {
    databases: [...databases.values()].sort((left, right) => left.localeCompare(right, 'en-US')),
    objects: [...objects.values()].sort((left, right) => `${left.database}\0${left.kind}\0${left.name}`.localeCompare(`${right.database}\0${right.kind}\0${right.name}`, 'en-US'))
  };
}

function expectedInventory(metadata, normalizeName, codePrefix) {
  if (metadata.validationInventoryVersion !== 1 || !Array.isArray(metadata.expectedDatabases) || !Array.isArray(metadata.expectedObjects)) return null;
  const databases = [...new Set(metadata.expectedDatabases.map((name) => normalizeName(name, `${codePrefix} expected database`)))].sort((left, right) => left.localeCompare(right, 'en-US'));
  const objects = metadata.expectedObjects.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Expected database object metadata is invalid.');
    const database = normalizeName(item.database, `${codePrefix} expected object database`);
    const name = normalizeName(item.name, `${codePrefix} expected object name`);
    const kind = String(item.kind || '').toLowerCase();
    const objectType = String(item.objectType || '').toLowerCase();
    if (!['relation', 'routine', 'trigger', 'event'].includes(kind) || !objectType) throw new TypeError('Expected database object metadata is invalid.');
    return { database, schema: database, name, kind, objectType };
  });
  if (!databases.length || databases.length > 1000 || objects.length > MAX_VALIDATION_OBJECTS) throw new TypeError('Expected database validation inventory is outside supported bounds.');
  return { databases, objects };
}

function compareInventory(expected, actual) {
  const actualDatabases = new Set(actual.databases);
  const actualObjects = new Map(actual.objects.map((item) => [`${item.database}\0${item.kind}\0${item.name}`, item]));
  const missingDatabases = expected.databases.filter((name) => !actualDatabases.has(name));
  const missingObjects = [];
  const typeMismatches = [];
  for (const item of expected.objects) {
    const current = actualObjects.get(`${item.database}\0${item.kind}\0${item.name}`);
    if (!current) missingObjects.push(item);
    else if (current.objectType !== item.objectType) typeMismatches.push({ expected: item, actualType: current.objectType });
  }
  return { missingDatabases, missingObjects, typeMismatches, valid: missingDatabases.length === 0 && missingObjects.length === 0 && typeMismatches.length === 0 };
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function checkTableQueries(objects) {
  const relations = objects.filter((item) => item.kind === 'relation');
  const queries = [];
  for (let index = 0; index < relations.length; index += MAX_CHECK_TABLE_BATCH) {
    const batch = relations.slice(index, index + MAX_CHECK_TABLE_BATCH);
    queries.push({
      expected: batch.length,
      sql: `CHECK TABLE ${batch.map((item) => `${quoteIdentifier(item.database)}.${quoteIdentifier(item.name)}`).join(', ')} QUICK;`
    });
  }
  return queries;
}

function checkTableResult(output, expected) {
  const rows = String(output || '').split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'));
  const failures = rows.filter((fields) => String(fields[2] || '').toLowerCase() === 'error' || String(fields[2] || '').toLowerCase() === 'warning');
  const passed = rows.filter((fields) => String(fields[2] || '').toLowerCase() === 'status' && String(fields[3] || '').toLowerCase() === 'ok').length;
  return { valid: failures.length === 0 && passed >= expected, passed, failureCount: failures.length };
}

module.exports = {
  MAX_VALIDATION_OBJECTS,
  captureInventoryQuery,
  checkTableQueries,
  checkTableResult,
  compareInventory,
  expectedInventory,
  normalizeInventory,
  validationInventoryQuery
};
