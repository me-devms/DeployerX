const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { DirectDatabaseDriverRuntime } = require('./direct-driver-runtime');

class FakePgQuery extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
  }
}

test('PostgreSQL direct runtime uses the bounded streaming path', async (t) => {
  const releases = [];
  class FakePool {
    async query(sql) {
      assert.match(String(sql), /^SELECT version\(\)/);
      return { rows: [{ version: 'PostgreSQL test', database: 'product' }] };
    }

    async connect() {
      return {
        query(command) {
          queueMicrotask(() => {
            const fields = [{ name: 'id', dataTypeID: 23 }];
            for (let id = 1; id <= 5; id += 1) command.emit('row', [id], { fields });
            command.emit('end', { fields, rowCount: 5 });
          });
        },
        release(error) { releases.push(error); }
      };
    }

    async end() {}
  }

  const runtime = new DirectDatabaseDriverRuntime({
    driverId: 'postgresql',
    loaders: { postgresql: () => ({ Pool: FakePool, Query: FakePgQuery }) }
  });
  t.after(() => runtime.stop());
  const opened = await runtime.openConnection({
    driverId: 'postgresql', endpoint: { kind: 'network', host: 'db.internal' }, database: 'product',
    credentials: {}, settings: {}, ssl: { mode: 'disabled' }
  });

  const result = await runtime.executeSessionQuery(opened.runtimeSessionId, {
    query: 'SELECT id FROM records', page: 2, pageSize: 2
  });

  assert.deepEqual(result.rows, [[3], [4]]);
  assert.equal(result.pagination.hasMore, true);
  assert.equal(releases[0]?.code, 'DATABASE_MANAGER_DRIVER_PAGE_COMPLETE');
});

test('MySQL direct runtime uses the bounded streaming path', async (t) => {
  const state = { destroyed: 0, released: 0 };
  const pool = {
    async query(sql) {
      assert.match(String(sql), /^SELECT VERSION\(\)/);
      return [[{ version: 'MySQL test', database: 'product' }], []];
    },
    pool: {
      getConnection(callback) {
        callback(null, {
          query(config) {
            assert.equal(config.rowsAsArray, true);
            const command = new EventEmitter();
            queueMicrotask(() => {
              command.emit('fields', [{ name: 'id', columnType: 3 }]);
              for (let id = 1; id <= 5; id += 1) command.emit('result', [id], 0);
              command.emit('end');
            });
            return command;
          },
          destroy() { state.destroyed += 1; },
          release() { state.released += 1; }
        });
      }
    },
    async end() {}
  };
  const runtime = new DirectDatabaseDriverRuntime({
    driverId: 'mysql',
    loaders: { mysql: () => ({ createPool: () => pool }) }
  });
  t.after(() => runtime.stop());
  const opened = await runtime.openConnection({
    driverId: 'mysql', endpoint: { kind: 'network', host: 'db.internal' }, database: 'product',
    credentials: {}, settings: {}, ssl: { mode: 'disabled' }
  });

  const result = await runtime.executeSessionQuery(opened.runtimeSessionId, {
    query: 'SELECT id FROM records', page: 2, pageSize: 2
  });

  assert.deepEqual(result.rows, [[3], [4]]);
  assert.equal(result.pagination.hasMore, true);
  assert.deepEqual(state, { destroyed: 1, released: 0 });
});
