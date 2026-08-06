const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js/dist/sql-asm.js');

const { DirectDatabaseDriverRuntime } = require('./direct-driver-runtime');

async function sqliteFixture(directory) {
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE people (
      id INTEGER PRIMARY KEY,
      team_id INTEGER,
      email TEXT NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX people_email_idx ON people(email);
    INSERT INTO teams VALUES (1, 'Platform');
    INSERT INTO people VALUES (1, 1, 'one@example.test'), (2, 1, 'two@example.test');
  `);
  const filePath = path.join(directory, 'runtime.sqlite');
  await fs.writeFile(filePath, Buffer.from(database.export()));
  database.close();
  return filePath;
}

function connection(filePath, accessMode = 'read-write') {
  return {
    driverId: 'sqlite',
    endpoint: { kind: 'file', path: filePath },
    database: 'main',
    accessMode,
    credentials: {},
    settings: {},
    ssl: { mode: 'disabled' }
  };
}

test('SQLite fallback supports sessions, paging, schema metadata, persistence, and read-only policy', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-direct-db-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = await sqliteFixture(directory);
  let sqliteLoads = 0;
  const runtime = new DirectDatabaseDriverRuntime({
    driverId: 'sqlite',
    loaders: { sqlite: () => { sqliteLoads += 1; return initSqlJs; } }
  });
  t.after(() => runtime.stop());

  const health = await runtime.health();
  assert.deepEqual(health.drivers, ['sqlite']);
  assert.equal(sqliteLoads, 0, 'health must not eagerly load database packages');

  const tested = await runtime.testConnection(connection(filePath));
  assert.equal(tested.status, 'success');
  assert.equal(tested.database, 'main');
  assert.equal(sqliteLoads, 1);

  const opened = await runtime.openConnection(connection(filePath));
  assert.match(opened.runtimeSessionId, /^direct_/);
  assert.equal((await runtime.connectionStatus(opened.runtimeSessionId)).status, 'ready');

  const firstPage = await runtime.executeSessionQuery(opened.runtimeSessionId, {
    query: 'SELECT id, email FROM people ORDER BY id', page: 1, pageSize: 1
  });
  assert.deepEqual(firstPage.columns.map((column) => column.name), ['id', 'email']);
  assert.deepEqual(firstPage.rows, [[1, 'one@example.test']]);
  assert.equal(firstPage.pagination.hasMore, true);

  const inserted = await runtime.executeSessionQuery(opened.runtimeSessionId, {
    query: "INSERT INTO people VALUES (3, 1, 'three@example.test')", page: 1, pageSize: 100
  });
  assert.equal(inserted.affectedRows, 1);
  await assert.rejects(
    runtime.executeSessionQuery(opened.runtimeSessionId, { query: "INSERT INTO people VALUES (99, 999, 'orphan@example.test')", page: 1, pageSize: 100 }),
    (error) => error.code === 'DATABASE_MANAGER_QUERY_FAILED'
  );
  const afterForeignKeyFailure = await runtime.executeSessionQuery(opened.runtimeSessionId, { query: 'SELECT id FROM people WHERE id = 99', page: 1, pageSize: 100 });
  assert.deepEqual(afterForeignKeyFailure.rows, []);

  const snapshot = await runtime.discoverSessionSchema(opened.runtimeSessionId, {
    maxTables: 20, maxColumnsPerTable: 20, includeSystem: false
  });
  const people = snapshot.schemas[0].tables.find((table) => table.name === 'people');
  assert.ok(people);
  assert.deepEqual(people.indexes.find((index) => index.name === 'people_email_idx'), {
    name: 'people_email_idx', unique: true, columns: ['email']
  });
  assert.deepEqual(people.foreignKeys[0].columns, ['team_id']);
  assert.equal(people.foreignKeys[0].referencedTable, 'teams');

  assert.equal((await runtime.closeConnection(opened.runtimeSessionId)).closed, true);
  assert.equal((await runtime.connectionStatus(opened.runtimeSessionId)).status, 'closed');

  const SQL = await initSqlJs();
  const persisted = new SQL.Database(new Uint8Array(await fs.readFile(filePath)));
  assert.equal(persisted.exec('SELECT COUNT(*) AS count FROM people')[0].values[0][0], 3);
  assert.equal(persisted.exec('SELECT COUNT(*) AS count FROM people WHERE id = 99')[0].values[0][0], 0);
  persisted.close();

  const readOnly = await runtime.openConnection(connection(filePath, 'read-only'));
  await assert.rejects(
    runtime.executeSessionQuery(readOnly.runtimeSessionId, { query: 'DELETE FROM people', page: 1, pageSize: 100 }),
    (error) => error.code === 'DATABASE_MANAGER_READ_ONLY_VIOLATION'
  );
  const readable = await runtime.executeSessionQuery(readOnly.runtimeSessionId, { query: 'SELECT COUNT(*) AS count FROM people', page: 1, pageSize: 100 });
  assert.deepEqual(readable.rows, [[3]]);
});

test('SQLite restores its in-memory state when atomic persistence fails', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-direct-db-fault-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = await sqliteFixture(directory);
  let failRename = true;
  const fileSystem = {
    stat: (...args) => fs.stat(...args),
    readFile: (...args) => fs.readFile(...args),
    open: (...args) => fs.open(...args),
    rm: (...args) => fs.rm(...args),
    rename: (...args) => failRename ? (failRename = false, Promise.reject(new Error('injected rename failure'))) : fs.rename(...args)
  };
  const runtime = new DirectDatabaseDriverRuntime({ driverId: 'sqlite', fileSystem });
  t.after(() => runtime.stop());
  const opened = await runtime.openConnection(connection(filePath));

  await assert.rejects(
    runtime.executeSessionQuery(opened.runtimeSessionId, { query: "INSERT INTO people VALUES (3, 1, 'failed@example.test')", page: 1, pageSize: 100 }),
    (error) => error.code === 'DATABASE_MANAGER_SQLITE_PERSIST_FAILED'
  );
  const afterFailure = await runtime.executeSessionQuery(opened.runtimeSessionId, { query: 'SELECT id FROM people ORDER BY id', page: 1, pageSize: 100 });
  assert.deepEqual(afterFailure.rows, [[1], [2]], 'the failed write must not remain in the shared in-memory database');

  await runtime.executeSessionQuery(opened.runtimeSessionId, { query: "INSERT INTO people VALUES (4, 1, 'saved@example.test')", page: 1, pageSize: 100 });
  await runtime.closeConnection(opened.runtimeSessionId);
  const SQL = await initSqlJs();
  const persisted = new SQL.Database(new Uint8Array(await fs.readFile(filePath)));
  assert.deepEqual(persisted.exec('SELECT id FROM people ORDER BY id')[0].values, [[1], [2], [4]]);
  persisted.close();
});

test('SQLite refuses to overwrite a file changed outside the open session', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-direct-db-conflict-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = await sqliteFixture(directory);
  const runtime = new DirectDatabaseDriverRuntime({ driverId: 'sqlite' });
  t.after(() => runtime.stop());
  const opened = await runtime.openConnection(connection(filePath));

  const SQL = await initSqlJs();
  const external = new SQL.Database(new Uint8Array(await fs.readFile(filePath)));
  external.run("INSERT INTO people VALUES (9, 1, 'external@example.test')");
  await fs.writeFile(filePath, Buffer.from(external.export()));
  external.close();

  await assert.rejects(
    runtime.executeSessionQuery(opened.runtimeSessionId, { query: "INSERT INTO people VALUES (10, 1, 'stale@example.test')", page: 1, pageSize: 100 }),
    (error) => error.code === 'DATABASE_MANAGER_SQLITE_EXTERNAL_CHANGE_CONFLICT'
  );
  const staleSession = await runtime.executeSessionQuery(opened.runtimeSessionId, { query: 'SELECT id FROM people ORDER BY id', page: 1, pageSize: 100 });
  assert.deepEqual(staleSession.rows, [[1], [2]], 'the rejected write must be rolled back in memory');
  await runtime.closeConnection(opened.runtimeSessionId);

  const persisted = new SQL.Database(new Uint8Array(await fs.readFile(filePath)));
  assert.deepEqual(persisted.exec('SELECT id FROM people ORDER BY id')[0].values, [[1], [2], [9]]);
  persisted.close();
});

test('network dependencies stay lazy and fail only when their driver is used', async () => {
  for (const driverId of ['postgresql', 'mysql']) {
    let loads = 0;
    const runtime = new DirectDatabaseDriverRuntime({
      driverId,
      loaders: { [driverId]: () => { loads += 1; throw new Error('not installed'); } }
    });
    assert.equal((await runtime.health()).status, 'ready');
    assert.equal(loads, 0);
    await assert.rejects(
      runtime.testConnection({ driverId, endpoint: { kind: 'network', host: '127.0.0.1', port: driverId === 'postgresql' ? 5432 : 3306 }, credentials: {}, settings: {}, ssl: { mode: 'disabled' } }),
      (error) => error.code === 'DATABASE_MANAGER_DRIVER_DEPENDENCY_MISSING'
    );
    assert.equal(loads, 1);
  }
});

test('PostgreSQL fallback maps connection options and normalizes its runtime contract', async () => {
  const pools = [];
  const queries = [];
  class FakePool {
    constructor(options) { this.options = options; this.ended = false; pools.push(this); }
    async query(input, params) {
      const sql = typeof input === 'string' ? input : input.text;
      queries.push({ sql, params });
      if (sql.startsWith('SELECT version()')) return { rows: [{ version: 'PostgreSQL 17.test', database: 'product' }] };
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      if (sql.includes('information_schema.tables')) return { rows: [{ table_schema: 'public', table_name: 'deployments', table_type: 'BASE TABLE' }] };
      if (sql.includes('information_schema.columns')) return { rows: [
        { column_name: 'tenant_id', data_type: 'bigint', is_nullable: 'NO', column_default: null, is_primary_key: true },
        { column_name: 'id', data_type: 'bigint', is_nullable: 'NO', column_default: null, is_primary_key: true },
        { column_name: 'team_id', data_type: 'bigint', is_nullable: 'YES', column_default: null, is_primary_key: false }
      ] };
      if (sql.includes('pg_catalog.pg_index')) return { rows: [
        { index_name: 'deployments_created_idx', is_unique: false, column_name: 'created_at', ordinal_position: 1 },
        { index_name: 'deployments_pkey', is_unique: true, column_name: 'tenant_id', ordinal_position: 1 },
        { index_name: 'deployments_pkey', is_unique: true, column_name: 'id', ordinal_position: 2 }
      ] };
      if (sql.includes('pg_catalog.pg_constraint')) return { rows: [
        { constraint_name: 'deployments_team_fk', source_column: 'tenant_id', referenced_schema: 'directory', referenced_table: 'teams', referenced_column: 'tenant_id', on_delete: 'CASCADE', on_update: 'NO ACTION', ordinal_position: 1 },
        { constraint_name: 'deployments_team_fk', source_column: 'team_id', referenced_schema: 'directory', referenced_table: 'teams', referenced_column: 'id', on_delete: 'CASCADE', on_update: 'NO ACTION', ordinal_position: 2 }
      ] };
      return {
        fields: [{ name: 'id', dataTypeID: 20 }, { name: 'created_at', dataTypeID: 1184 }],
        rows: [[9007199254740993n, new Date('2026-08-06T10:00:00.000Z')], [2n, new Date('2026-08-06T11:00:00.000Z')]],
        rowCount: 2
      };
    }
    async end() { this.ended = true; }
  }
  const password = 'pg-secret-value';
  const runtime = new DirectDatabaseDriverRuntime({ driverId: 'postgresql', loaders: { postgresql: () => ({ Pool: FakePool }) } });
  const connection = {
    driverId: 'postgresql', endpoint: { kind: 'network', host: 'db.internal', port: 5544 }, database: 'product',
    accessMode: 'read-write', credentials: { username: 'deploy', password }, settings: { username: 'ignored' }, ssl: { mode: 'verify-full' }
  };

  const tested = await runtime.testConnection(connection, { timeoutMs: 9000 });
  assert.equal(tested.serverVersion, 'PostgreSQL 17.test');
  assert.equal(pools[0].ended, true);
  assert.deepEqual({ ...pools[0].options, password: '<redacted>' }, {
    host: 'db.internal', port: 5544, database: 'product', user: 'deploy', password: '<redacted>',
    ssl: { rejectUnauthorized: true }, max: 4, connectionTimeoutMillis: 9000, query_timeout: 9000
  });

  const opened = await runtime.openConnection(connection);
  assert.equal((await runtime.connectionStatus(opened.runtimeSessionId)).status, 'ready');
  const result = await runtime.executeSessionQuery(opened.runtimeSessionId, { query: 'SELECT id, created_at FROM deployments', page: 1, pageSize: 1 });
  assert.deepEqual(result.columns, [{ name: 'id', dataType: '20' }, { name: 'created_at', dataType: '1184' }]);
  assert.deepEqual(result.rows, [['9007199254740993', '2026-08-06T10:00:00.000Z']]);
  assert.equal(result.pagination.hasMore, true);
  const schema = await runtime.discoverSessionSchema(opened.runtimeSessionId, { schema: 'public', maxTables: 10, maxColumnsPerTable: 10 });
  assert.equal(schema.schemas[0].tables[0].name, 'deployments');
  assert.equal(schema.schemas[0].tables[0].columns[0].dataType, 'bigint');
  assert.equal(schema.schemas[0].tables[0].columns[0].primaryKey, true);
  assert.equal(schema.schemas[0].tables[0].columns[2].primaryKey, false);
  assert.deepEqual(schema.schemas[0].tables[0].indexes, [
    { name: 'deployments_created_idx', unique: false, columns: ['created_at'] },
    { name: 'deployments_pkey', unique: true, columns: ['tenant_id', 'id'] }
  ]);
  assert.deepEqual(schema.schemas[0].tables[0].foreignKeys, [{
    name: 'deployments_team_fk', columns: ['tenant_id', 'team_id'], referencedSchema: 'directory', referencedTable: 'teams',
    referencedColumns: ['tenant_id', 'id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION'
  }]);
  assert.match(queries.find((call) => call.sql.includes('information_schema.columns')).sql, /table_constraints[\s\S]+PRIMARY KEY/);
  assert.deepEqual(queries.find((call) => call.sql.includes('pg_catalog.pg_index')).params, ['public', 'deployments', 501, 101]);
  assert.deepEqual(queries.find((call) => call.sql.includes('pg_catalog.pg_constraint')).params, ['public', 'deployments', 501, 101]);
  assert.equal((await runtime.closeConnection(opened.runtimeSessionId)).closed, true);
  assert.equal(pools[1].ended, true);
  assert.doesNotMatch(JSON.stringify({ tested, opened, result, schema }), /pg-secret-value/);
});

test('MySQL fallback maps connection options and normalizes its runtime contract', async () => {
  const pools = [];
  const queries = [];
  const createPool = (options) => {
    const pool = {
      options,
      ended: false,
      async query(input, params) {
        const sql = typeof input === 'string' ? input : input.sql;
        queries.push({ sql, params });
        if (sql.startsWith('SELECT VERSION()')) return [[{ version: '10.4.32-MariaDB', current_database_name: 'product' }], []];
        if (sql === 'SELECT 1') return [[{ one: 1 }], []];
        if (sql.includes('information_schema.tables')) return [[{ table_schema: 'product', table_name: 'deployments', table_type: 'BASE TABLE' }], []];
        if (sql.includes('information_schema.columns')) return [[
          { column_name: 'tenant_id', data_type: 'bigint unsigned', is_nullable: 'NO', column_default: null, is_primary_key: 1 },
          { column_name: 'id', data_type: 'bigint unsigned', is_nullable: 'NO', column_default: null, is_primary_key: 1 },
          { column_name: 'team_id', data_type: 'bigint unsigned', is_nullable: 'YES', column_default: null, is_primary_key: 0 }
        ], []];
        if (sql.includes('information_schema.statistics')) return [[
          { index_name: 'PRIMARY', is_unique: 1, column_name: 'tenant_id', ordinal_position: 1 },
          { index_name: 'PRIMARY', is_unique: 1, column_name: 'id', ordinal_position: 2 },
          { index_name: 'deployments_created_idx', is_unique: 0, column_name: 'created_at', ordinal_position: 1 }
        ], []];
        if (sql.includes('information_schema.referential_constraints')) return [[
          { constraint_name: 'deployments_team_fk', source_column: 'tenant_id', referenced_schema: 'directory', referenced_table: 'teams', referenced_column: 'tenant_id', on_delete: 'CASCADE', on_update: 'RESTRICT', ordinal_position: 1 },
          { constraint_name: 'deployments_team_fk', source_column: 'team_id', referenced_schema: 'directory', referenced_table: 'teams', referenced_column: 'id', on_delete: 'CASCADE', on_update: 'RESTRICT', ordinal_position: 2 }
        ], []];
        return [[[7, Buffer.from('ok')], [8, Buffer.from('more')]], [{ name: 'id', columnType: 8 }, { name: 'payload', columnType: 252 }]];
      },
      async end() { this.ended = true; }
    };
    pools.push(pool);
    return pool;
  };
  const password = 'mysql-secret-value';
  const runtime = new DirectDatabaseDriverRuntime({ driverId: 'mysql', loaders: { mysql: () => ({ createPool }) } });
  const connection = {
    driverId: 'mariadb', endpoint: { kind: 'network', host: 'maria.internal', port: 3307 }, database: 'product',
    accessMode: 'read-write', credentials: { password }, settings: { username: 'service-user' }, ssl: { mode: 'required' }
  };

  const tested = await runtime.testConnection(connection, { timeoutMs: 7000 });
  assert.equal(tested.serverVersion, '10.4.32-MariaDB');
  assert.equal(tested.database, 'product');
  assert.match(queries[0].sql, /DATABASE\(\) AS current_database_name/);
  assert.equal(pools[0].ended, true);
  assert.deepEqual({ ...pools[0].options, password: '<redacted>' }, {
    host: 'maria.internal', port: 3307, database: 'product', user: 'service-user', password: '<redacted>',
    ssl: { rejectUnauthorized: false }, connectionLimit: 4, connectTimeout: 7000, multipleStatements: false
  });

  const opened = await runtime.openConnection(connection);
  assert.equal((await runtime.connectionStatus(opened.runtimeSessionId)).status, 'ready');
  const result = await runtime.executeSessionQuery(opened.runtimeSessionId, { query: 'SELECT id, payload FROM deployments', page: 1, pageSize: 1 });
  assert.deepEqual(result.columns, [{ name: 'id', dataType: '8' }, { name: 'payload', dataType: '252' }]);
  assert.deepEqual(result.rows, [[7, Buffer.from('ok')]]);
  assert.equal(result.pagination.hasMore, true);
  const schema = await runtime.discoverSessionSchema(opened.runtimeSessionId, { maxTables: 10, maxColumnsPerTable: 10 });
  assert.equal(schema.schemas[0].tables[0].columns[0].primaryKey, true);
  assert.equal(schema.schemas[0].tables[0].columns[2].primaryKey, false);
  assert.deepEqual(schema.schemas[0].tables[0].indexes, [
    { name: 'PRIMARY', unique: true, columns: ['tenant_id', 'id'] },
    { name: 'deployments_created_idx', unique: false, columns: ['created_at'] }
  ]);
  assert.deepEqual(schema.schemas[0].tables[0].foreignKeys, [{
    name: 'deployments_team_fk', columns: ['tenant_id', 'team_id'], referencedSchema: 'directory', referencedTable: 'teams',
    referencedColumns: ['tenant_id', 'id'], onDelete: 'CASCADE', onUpdate: 'RESTRICT'
  }]);
  assert.deepEqual(queries.find((call) => call.sql.includes('information_schema.tables')).params, ['product', 'product', false, 11]);
  assert.deepEqual(queries.find((call) => call.sql.includes('information_schema.statistics')).params, ['product', 'deployments', 501, 'product', 'deployments', 101]);
  assert.deepEqual(queries.find((call) => call.sql.includes('information_schema.referential_constraints')).params, ['product', 'deployments', 501, 101]);
  assert.equal((await runtime.closeConnection(opened.runtimeSessionId)).closed, true);
  assert.equal(pools[1].ended, true);
  assert.doesNotMatch(JSON.stringify({ tested, opened, result, schema }), /mysql-secret-value/);
});
