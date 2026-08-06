const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const {
  remapMysqlFamilyDump,
  remapMysqlFamilyMetadata,
  remapPostgresqlDump,
  remapPostgresqlMetadata,
  singleSourceDatabase
} = require('./database-restore-target');

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function metadata(engine = 'mysql') {
  return {
    engine,
    selectionMode: engine === 'postgresql' ? 'schemas' : 'tables',
    selectedDatabases: ['orders'],
    selectedSchemas: engine === 'postgresql' ? [{ database: 'orders', name: 'public' }] : [],
    selectedTables: [{ database: 'orders', schema: engine === 'postgresql' ? 'public' : 'orders', name: 'items' }],
    validationInventoryVersion: 1,
    expectedDatabases: ['orders'],
    expectedSchemas: engine === 'postgresql' ? [{ database: 'orders', name: 'public' }] : [],
    expectedObjects: [{ database: 'orders', schema: engine === 'postgresql' ? 'public' : 'orders', name: 'items', kind: 'relation', objectType: 'table' }]
  };
}

test('remaps MySQL-family database identities without changing matching object names or strings', async () => {
  const dump = [
    '-- database `orders` remains a comment',
    'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `orders`;',
    'USE `orders`;',
    'CREATE TABLE `orders` (`value` varchar(20));',
    "INSERT INTO `orders` VALUES ('`orders`.`items`');",
    'CREATE VIEW `summary` AS SELECT * FROM `orders`.`items`;',
    'CREATE PROCEDURE `orders`.`refresh_orders`() SELECT 1;'
  ].join('\n');
  const output = await collect(remapMysqlFamilyDump(Readable.from([dump.slice(0, 37), dump.slice(37)]), 'orders', 'orders_restore'));
  assert.match(output, /CREATE DATABASE \/\*!32312 IF NOT EXISTS\*\/ `orders_restore`;/);
  assert.match(output, /USE `orders_restore`;/);
  assert.match(output, /CREATE TABLE `orders`/);
  assert.match(output, /'`orders`\.`items`'/);
  assert.match(output, /FROM `orders_restore`\.`items`/);
  assert.match(output, /PROCEDURE `orders_restore`\.`refresh_orders`/);
  assert.match(output, /database `orders` remains a comment/);
});

test('refuses a MySQL-family dump before releasing bytes when mapping controls are absent', async () => {
  const source = remapMysqlFamilyDump(Readable.from(['CREATE TABLE `items` (`id` int);']), 'orders', 'orders_restore');
  await assert.rejects(collect(source), (error) => error.code === 'DATABASE_DUMP_REMAP_UNSAFE');
});

test('remaps PostgreSQL database creation and psql connection controls', async () => {
  const dump = 'DROP DATABASE IF EXISTS orders;\nCREATE DATABASE orders WITH TEMPLATE = template0;\n\\connect orders\nCREATE TABLE public.items(id integer);\n';
  const output = await collect(remapPostgresqlDump(Readable.from([dump]), 'orders', 'orders restore'));
  assert.match(output, /DROP DATABASE IF EXISTS "orders restore"/);
  assert.match(output, /CREATE DATABASE "orders restore"/);
  assert.match(output, /\\connect "orders restore"/);
  assert.match(output, /CREATE TABLE public\.items/);
});

test('remaps native validation metadata for MySQL-family and PostgreSQL targets', () => {
  const mysql = remapMysqlFamilyMetadata(metadata(), 'orders_restore');
  assert.equal(mysql.sourceDatabase, 'orders');
  assert.deepEqual(mysql.metadata.expectedDatabases, ['orders_restore']);
  assert.equal(mysql.metadata.expectedObjects[0].schema, 'orders_restore');
  const postgresql = remapPostgresqlMetadata(metadata('postgresql'), 'orders_restore');
  assert.deepEqual(postgresql.metadata.expectedDatabases, ['orders_restore']);
  assert.equal(postgresql.metadata.expectedSchemas[0].database, 'orders_restore');
  assert.equal(postgresql.metadata.expectedObjects[0].schema, 'public');
});

test('requires exactly one source database for a new-database mapping', () => {
  assert.equal(singleSourceDatabase({ selectedDatabases: ['orders'] }), 'orders');
  assert.throws(() => singleSourceDatabase({ selectedDatabases: ['orders', 'accounts'] }), (error) => error.code === 'DATABASE_NEW_TARGET_REQUIRES_SINGLE_SOURCE');
});
