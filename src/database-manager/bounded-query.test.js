const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { boundedMysqlQuery, boundedPostgresQuery } = require('./bounded-query');

class FakePgQuery extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
  }
}

function postgresPool(run) {
  const releases = [];
  const client = {
    query(command) { run(command); },
    release(error) { releases.push(error); }
  };
  return { pool: { connect: async () => client }, releases };
}

function mysqlPool(run) {
  const state = { destroyed: 0, released: 0 };
  const connection = {
    query(config) {
      const command = new EventEmitter();
      run(command, config);
      return command;
    },
    destroy() { state.destroyed += 1; },
    release() { state.released += 1; }
  };
  return {
    pool: { pool: { getConnection: (callback) => callback(null, connection) } },
    state
  };
}

test('PostgreSQL keeps one bounded page and preserves driver metadata', async () => {
  const fields = [{ name: 'id', dataTypeID: 23 }];
  const fixture = postgresPool((command) => queueMicrotask(() => {
    for (let id = 1; id <= 6; id += 1) command.emit('row', [id], { fields });
    command.emit('end', { fields, rowCount: 6 });
  }));

  const result = await boundedPostgresQuery({
    pool: fixture.pool,
    Query: FakePgQuery,
    text: 'select id from records',
    offset: 1,
    limit: 2
  });

  assert.strictEqual(result.fields, fields);
  assert.deepEqual(result.rows, [[2], [3]]);
  assert.equal(result.affectedRows, 0);
  assert.equal(result.hasMore, true);
  assert.equal(fixture.releases.length, 1);
  assert.equal(fixture.releases[0]?.code, 'DATABASE_MANAGER_DRIVER_PAGE_COMPLETE');

  const write = postgresPool((command) => queueMicrotask(() => {
    command.emit('end', { fields: [], rowCount: 4 });
  }));
  const writeResult = await boundedPostgresQuery({
    pool: write.pool,
    Query: FakePgQuery,
    text: 'update records set active = true'
  });
  assert.equal(writeResult.affectedRows, 4);
  assert.equal(write.releases[0], undefined);
});

test('PostgreSQL aborts an active query with the fixed cancellation error', async () => {
  let started;
  const queryStarted = new Promise((resolve) => { started = resolve; });
  const fixture = postgresPool(() => started());
  const controller = new AbortController();
  const operation = boundedPostgresQuery({
    pool: fixture.pool,
    Query: FakePgQuery,
    text: 'select pg_sleep(30)',
    signal: controller.signal
  });

  await queryStarted;
  controller.abort();

  await assert.rejects(operation, (error) => error.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED');
  assert.equal(fixture.releases[0]?.code, 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED');
});

test('MySQL keeps one bounded page and preserves driver metadata', async () => {
  const fields = [{ name: 'id', columnType: 3 }];
  const fixture = mysqlPool((command, config) => queueMicrotask(() => {
    assert.equal(config.rowsAsArray, true);
    command.emit('fields', fields);
    for (let id = 1; id <= 6; id += 1) command.emit('result', [id], 0);
    command.emit('end');
  }));

  const result = await boundedMysqlQuery({
    pool: fixture.pool,
    sql: 'select id from records',
    offset: 1,
    limit: 2
  });

  assert.strictEqual(result.fields, fields);
  assert.deepEqual(result.rows, [[2], [3]]);
  assert.equal(result.affectedRows, 0);
  assert.equal(result.hasMore, true);
  assert.deepEqual(fixture.state, { destroyed: 1, released: 0 });

  const write = mysqlPool((command) => queueMicrotask(() => {
    command.emit('result', { affectedRows: 5 }, 0);
    command.emit('end');
  }));
  const writeResult = await boundedMysqlQuery({ pool: write.pool, sql: 'delete from records' });
  assert.equal(writeResult.affectedRows, 5);
  assert.deepEqual(write.state, { destroyed: 0, released: 1 });
});

test('MySQL aborts an active query with the fixed cancellation error', async () => {
  let started;
  const queryStarted = new Promise((resolve) => { started = resolve; });
  const fixture = mysqlPool(() => started());
  const controller = new AbortController();
  const operation = boundedMysqlQuery({
    pool: fixture.pool,
    sql: 'select sleep(30)',
    signal: controller.signal
  });

  await queryStarted;
  controller.abort();

  await assert.rejects(operation, (error) => error.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED');
  assert.deepEqual(fixture.state, { destroyed: 1, released: 0 });
});
