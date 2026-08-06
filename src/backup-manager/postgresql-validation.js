const MAX_VALIDATION_OBJECTS = 10000;
const MAX_VALIDATION_SCHEMAS = 1000;

function descriptor(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 512 || /\p{C}/u.test(text)) throw new TypeError('PostgreSQL validation object identity is invalid.');
  return text;
}

function textLiteral(value) {
  return `convert_from(decode('${Buffer.from(String(value), 'utf8').toString('hex')}','hex'),'UTF8')`;
}

function valuesPredicate(items, expression) {
  return `${expression} IN (${items.map(textLiteral).join(',')})`;
}

function pairPredicate(items, schemaExpression, nameExpression) {
  return `(${items.map((item) => `(${schemaExpression}=${textLiteral(item.schema)} AND ${nameExpression}=${textLiteral(item.name)})`).join(' OR ')})`;
}

function inventoryQuery(scope) {
  const userSchemas = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";
  let schemaPredicate = userSchemas;
  let relationPredicate = userSchemas;
  let parentPredicate = "pn.nspname NOT LIKE 'pg\\_%' AND pn.nspname <> 'information_schema'";
  if (scope.mode === 'schemas') {
    const names = scope.schemas.map((item) => item.name);
    schemaPredicate = valuesPredicate(names, 'n.nspname');
    relationPredicate = schemaPredicate;
    parentPredicate = valuesPredicate(names, 'pn.nspname');
  } else if (scope.mode === 'tables') {
    const schemas = [...new Set(scope.tables.map((item) => item.schema))];
    schemaPredicate = valuesPredicate(schemas, 'n.nspname');
    relationPredicate = pairPredicate(scope.tables, 'n.nspname', 'c.relname');
    parentPredicate = pairPredicate(scope.tables, 'pn.nspname', 'pc.relname');
  }
  const includeSchemaObjects = scope.mode !== 'tables';
  const clauses = [
    `SELECT 'schema', n.nspname, '', 'schema', TRUE FROM pg_namespace n WHERE ${schemaPredicate}`,
    `SELECT 'relation', n.nspname, c.relname, CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned-table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized-view' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign-table' END, CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,TRUE) IS NOT NULL WHEN c.relkind IN ('r','p','m','S') THEN pg_relation_size(c.oid)>=0 ELSE TRUE END FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','S','f') AND ${relationPredicate}`,
    `SELECT 'trigger', pn.nspname, pc.relname || '.' || t.tgname, 'trigger', pg_get_triggerdef(t.oid,TRUE) IS NOT NULL FROM pg_trigger t JOIN pg_class pc ON pc.oid=t.tgrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE NOT t.tgisinternal AND ${parentPredicate}`,
    `SELECT 'index', pn.nspname, ic.relname, CASE ic.relkind WHEN 'I' THEN 'partitioned-index' ELSE 'index' END, i.indisvalid AND i.indisready AND pg_relation_size(ic.oid)>=0 FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_class pc ON pc.oid=i.indrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE ${parentPredicate}`
  ];
  if (includeSchemaObjects) {
    clauses.push(`SELECT 'routine', n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, pg_get_functiondef(p.oid) IS NOT NULL FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN ('f','p') AND ${schemaPredicate}`);
  }
  return `${clauses.join(' UNION ALL ')} ORDER BY 2, 1, 3;`;
}

function scopeFromMetadata(metadata, normalizeName) {
  const mode = ['databases', 'schemas', 'tables'].includes(metadata.selectionMode) ? metadata.selectionMode : 'databases';
  const schemas = mode === 'schemas' ? (metadata.selectedSchemas || []).map((item) => ({ database: normalizeName(item.database), name: normalizeName(item.name) })) : [];
  const tables = mode === 'tables' ? (metadata.selectedTables || []).map((item) => ({ database: normalizeName(item.database), schema: normalizeName(item.schema), name: normalizeName(item.name) })) : [];
  return { mode, schemas, tables };
}

function normalizeInventory(databaseValue, output, normalizeName) {
  const database = normalizeName(databaseValue);
  const schemas = new Map();
  const objects = new Map();
  const lines = String(output || '').split(/\r?\n/).filter(Boolean);
  if (lines.length > MAX_VALIDATION_OBJECTS + MAX_VALIDATION_SCHEMAS) throw Object.assign(new Error('The PostgreSQL validation inventory contains too many objects.'), { code: 'POSTGRESQL_VALIDATION_INVENTORY_LIMIT_EXCEEDED', category: 'capacity' });
  for (const line of lines) {
    const [kindValue, schemaValue, nameValue, typeValue, validValue] = line.split('\t');
    const kind = String(kindValue || '').toLowerCase();
    const schema = normalizeName(schemaValue);
    if (kind === 'schema') {
      schemas.set(`${database}\0${schema}`, { database, name: schema });
      continue;
    }
    if (!['relation', 'trigger', 'index', 'routine'].includes(kind)) throw Object.assign(new Error('The PostgreSQL validation inventory contains an unsupported object kind.'), { code: 'POSTGRESQL_VALIDATION_INVENTORY_INVALID', category: 'integrity' });
    const name = descriptor(nameValue);
    const objectType = String(typeValue || '').toLowerCase();
    const nativeValid = validValue === 't';
    const item = { database, schema, name, kind, objectType, nativeValid };
    objects.set(`${database}\0${schema}\0${kind}\0${name}`, item);
  }
  if (schemas.size > MAX_VALIDATION_SCHEMAS || objects.size > MAX_VALIDATION_OBJECTS) throw Object.assign(new Error('The PostgreSQL validation inventory contains too many objects.'), { code: 'POSTGRESQL_VALIDATION_INVENTORY_LIMIT_EXCEEDED', category: 'capacity' });
  return {
    schemas: [...schemas.values()].sort((left, right) => `${left.database}\0${left.name}`.localeCompare(`${right.database}\0${right.name}`, 'en-US')),
    objects: [...objects.values()].sort((left, right) => `${left.database}\0${left.schema}\0${left.kind}\0${left.name}`.localeCompare(`${right.database}\0${right.schema}\0${right.kind}\0${right.name}`, 'en-US'))
  };
}

function expectedInventory(metadata, normalizeName) {
  if (metadata.validationInventoryVersion !== 1 || !Array.isArray(metadata.expectedDatabases) || !Array.isArray(metadata.expectedSchemas) || !Array.isArray(metadata.expectedObjects)) return null;
  const databases = [...new Set(metadata.expectedDatabases.map((name) => normalizeName(name)))].sort((left, right) => left.localeCompare(right, 'en-US'));
  const schemas = metadata.expectedSchemas.map((item) => ({ database: normalizeName(item.database), name: normalizeName(item.name) }));
  const objects = metadata.expectedObjects.map((item) => {
    const database = normalizeName(item.database);
    const schema = normalizeName(item.schema);
    const name = descriptor(item.name);
    const kind = String(item.kind || '').toLowerCase();
    const objectType = String(item.objectType || '').toLowerCase();
    if (!['relation', 'trigger', 'index', 'routine'].includes(kind) || !objectType) throw new TypeError('Expected PostgreSQL object metadata is invalid.');
    return { database, schema, name, kind, objectType };
  });
  if (!databases.length || databases.length > 1000 || schemas.length > MAX_VALIDATION_SCHEMAS || objects.length > MAX_VALIDATION_OBJECTS) throw new TypeError('Expected PostgreSQL validation inventory is outside supported bounds.');
  return { databases, schemas, objects };
}

function compareInventory(expected, actual) {
  const actualSchemas = new Set(actual.schemas.map((item) => `${item.database}\0${item.name}`));
  const actualObjects = new Map(actual.objects.map((item) => [`${item.database}\0${item.schema}\0${item.kind}\0${item.name}`, item]));
  const missingSchemas = expected.schemas.filter((item) => !actualSchemas.has(`${item.database}\0${item.name}`));
  const missingObjects = [];
  const typeMismatches = [];
  const invalidObjects = [];
  for (const item of expected.objects) {
    const actualItem = actualObjects.get(`${item.database}\0${item.schema}\0${item.kind}\0${item.name}`);
    if (!actualItem) missingObjects.push(item);
    else if (actualItem.objectType !== item.objectType) typeMismatches.push({ expected: item, actualType: actualItem.objectType });
    else if (!actualItem.nativeValid) invalidObjects.push(item);
  }
  return { missingSchemas, missingObjects, typeMismatches, invalidObjects, valid: missingSchemas.length === 0 && missingObjects.length === 0 && typeMismatches.length === 0 && invalidObjects.length === 0 };
}

module.exports = { compareInventory, expectedInventory, inventoryQuery, normalizeInventory, scopeFromMetadata };
