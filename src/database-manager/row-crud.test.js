const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseRowCrudService, buildRowMutationSql, quoteIdentifier } = require('./row-crud');

const table = {
  name: 'orders', type: 'table', columns: [
    { name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true },
    { name: 'customer', dataType: 'TEXT', nullable: false, primaryKey: false },
    { name: 'metadata', dataType: 'JSONB', nullable: true, primaryKey: false },
    { name: 'payload', dataType: 'BLOB', nullable: true, primaryKey: false }
  ]
};

test('quotes identifiers and builds dialect-safe insert values', () => {
  assert.equal(quoteIdentifier('postgresql', 'odd"name'), '"odd""name"');
  assert.equal(quoteIdentifier('mysql', 'odd`name'), '`odd``name`');
  const postgres = buildRowMutationSql({ driverId: 'postgresql', action: 'insert', schema: 'public', table, values: { id: 7, customer: "O'Reilly", metadata: { priority: true } } });
  assert.match(postgres, /^INSERT INTO "public"\."orders"/);
  assert.match(postgres, /convert_from\(decode\('[0-9a-f]+', 'hex'\), 'UTF8'\)/);
  assert.match(postgres, /AS jsonb/);
  assert.doesNotMatch(postgres, /O'Reilly/);
  const mysql = buildRowMutationSql({ driverId: 'mysql', action: 'insert', schema: 'shop', table, values: { id: 7, customer: 'A\\B' } });
  assert.match(mysql, /CONVERT\(0x[0-9a-f]+ USING utf8mb4\)/);
});

test('requires complete primary keys for bounded updates and deletes', () => {
  const update = buildRowMutationSql({ driverId: 'sqlite', action: 'update', schema: 'main', table, key: { id: 7 }, values: { customer: 'Updated' } });
  assert.match(update, /^UPDATE "main"\."orders" SET/);
  assert.match(update, /WHERE "id" = 7$/);
  const deletion = buildRowMutationSql({ driverId: 'postgresql', action: 'delete', schema: 'public', table, keys: [{ id: 7 }, { id: 8 }] });
  assert.equal(deletion, 'DELETE FROM "public"."orders" WHERE ("id" = 7) OR ("id" = 8)');
  assert.throws(() => buildRowMutationSql({ driverId: 'postgresql', action: 'update', schema: 'public', table, key: {}, values: { customer: 'x' } }), (error) => error.code === 'DATABASE_MANAGER_ROW_PRIMARY_KEY_INVALID');
  assert.throws(() => buildRowMutationSql({ driverId: 'postgresql', action: 'update', schema: 'public', table, key: { id: 1 }, values: { id: 2 } }), (error) => error.code === 'DATABASE_MANAGER_ROW_PRIMARY_KEY_UPDATE_UNSUPPORTED');
  assert.throws(() => buildRowMutationSql({ driverId: 'postgresql', action: 'delete', schema: 'public', table, keys: Array.from({ length: 101 }, (_, id) => ({ id })) }), (error) => error.code === 'DATABASE_MANAGER_ROW_DELETE_LIMIT');
});

test('encodes binary values without embedding raw bytes', () => {
  const base64 = Buffer.from([0, 1, 2, 255]).toString('base64');
  assert.match(buildRowMutationSql({ driverId: 'postgresql', action: 'insert', schema: 'public', table, values: { id: 1, payload: { type: 'binary', base64 } } }), /decode\('AAEC\/w==', 'base64'\)/);
  assert.match(buildRowMutationSql({ driverId: 'sqlite', action: 'insert', schema: 'main', table, values: { id: 1, payload: { type: 'binary', base64 } } }), /X'000102ff'/);
});

function profile(overrides = {}) {
  return { id: 'profile-a', name: 'Orders Production', driverId: 'postgresql', defaultSchema: 'public', accessMode: 'read-write', environment: 'production', ...overrides };
}

function fixture(profileValue = profile()) {
  const observed = { schemaCalls: 0, queryCalls: [] };
  const service = new DatabaseRowCrudService({
    profileService: { get: async () => profileValue },
    schemaService: { load: async () => { observed.schemaCalls += 1; return { snapshot: { schemas: [{ name: 'public', tables: [table] }] } }; } },
    queryService: { execute: async (_workspaceId, _actorId, input) => { observed.queryCalls.push(input); return { result: { affectedRows: 1 } }; } }
  });
  return { observed, service };
}

test('revalidates schema and routes row mutations through the query policy service', async () => {
  const values = fixture();
  const result = await values.service.execute('workspace-a', 'tester', { requestId: 'row-a', profileId: 'profile-a', action: 'update', schema: 'public', table: 'orders', key: { id: 7 }, values: { customer: 'Updated' }, approval: { confirmed: true } });
  assert.equal(result.affectedRows, 1);
  assert.equal(values.observed.schemaCalls, 1);
  assert.equal(values.observed.queryCalls[0].source, 'grid');
  assert.equal(values.observed.queryCalls[0].approval.confirmed, true);
  assert.match(values.observed.queryCalls[0].query, /^UPDATE/);
});

test('rejects read-only edits and unconfirmed deletes before driver-backed schema discovery', async () => {
  const readOnly = fixture(profile({ accessMode: 'read-only' }));
  await assert.rejects(readOnly.service.execute('workspace-a', 'tester', { profileId: 'profile-a', action: 'update', schema: 'public', table: 'orders', key: { id: 1 }, values: { customer: 'x' } }), (error) => error.code === 'DATABASE_MANAGER_READ_ONLY_VIOLATION');
  assert.equal(readOnly.observed.schemaCalls, 0);
  const writable = fixture();
  await assert.rejects(writable.service.execute('workspace-a', 'tester', { profileId: 'profile-a', action: 'delete', schema: 'public', table: 'orders', keys: [{ id: 1 }] }), (error) => error.code === 'DATABASE_MANAGER_ROW_DELETE_CONFIRMATION_REQUIRED');
  assert.equal(writable.observed.schemaCalls, 0);
});
