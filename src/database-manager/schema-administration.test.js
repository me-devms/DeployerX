const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DatabaseSchemaAdministrationService,
  buildSchemaMutationSql,
  normalizeSchemaActionInput,
  schemaAdministrationCapabilities
} = require('./schema-administration');

function profile(overrides = {}) {
  return { id: 'profile-a', driverId: 'postgresql', defaultSchema: 'public', accessMode: 'read-write', ...overrides };
}

test('builds escaped structured DDL for built-in drivers', () => {
  assert.equal(buildSchemaMutationSql('postgresql', {
    action: 'create-table', schema: 'public', table: 'order"items', columns: [
      { name: 'order_id', dataType: 'bigint', nullable: false, primaryKey: true },
      { name: 'sku', dataType: 'varchar(80)', nullable: false, unique: true }
    ]
  }), 'CREATE TABLE "public"."order""items" ("order_id" BIGINT NOT NULL PRIMARY KEY, "sku" VARCHAR(80) NOT NULL UNIQUE)');
  assert.equal(buildSchemaMutationSql('mysql', {
    action: 'set-column-nullable', schema: 'orders', table: 'customers', column: { name: 'email', dataType: 'varchar(255)', nullable: false }
  }), 'ALTER TABLE `orders`.`customers` MODIFY COLUMN `email` VARCHAR(255) NOT NULL');
  assert.equal(buildSchemaMutationSql('sqlite', {
    action: 'rename-column', schema: 'main', table: 'customers', columnName: 'full_name', newName: 'name'
  }), 'ALTER TABLE "main"."customers" RENAME COLUMN "full_name" TO "name"');
  assert.equal(buildSchemaMutationSql('postgresql', {
    action: 'create-index', schema: 'public', table: 'orders', indexName: 'orders_customer_idx', indexColumns: ['customer_id', 'created_at'], unique: false
  }), 'CREATE INDEX "public"."orders_customer_idx" ON "public"."orders" ("customer_id", "created_at")');
  assert.equal(buildSchemaMutationSql('mysql', {
    action: 'add-foreign-key', schema: 'orders', table: 'order_items', constraintName: 'fk_items_order', foreignKeyColumns: ['order_id'],
    referencedSchema: 'orders', referencedTable: 'orders', referencedColumns: ['id'], onDelete: 'cascade', onUpdate: 'restrict'
  }), 'ALTER TABLE `orders`.`order_items` ADD CONSTRAINT `fk_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders`.`orders` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT');
  assert.equal(buildSchemaMutationSql('sqlite', {
    action: 'create-view', schema: 'main', objectName: 'active_customers', query: 'SELECT id FROM customers WHERE active = 1;'
  }), 'CREATE VIEW "main"."active_customers" AS SELECT id FROM customers WHERE active = 1');
  assert.equal(buildSchemaMutationSql('postgresql', {
    action: 'refresh-materialized-view', schema: 'analytics', objectName: 'daily_revenue'
  }), 'REFRESH MATERIALIZED VIEW "analytics"."daily_revenue"');
});

test('rejects unsupported actions, unsafe types, duplicate columns, and read-only capabilities', () => {
  assert.throws(() => normalizeSchemaActionInput({ action: 'drop-schema', schema: 'main' }, profile({ driverId: 'sqlite' })), (error) => error.code === 'DATABASE_MANAGER_SCHEMA_ACTION_UNSUPPORTED');
  assert.throws(() => buildSchemaMutationSql('postgresql', { action: 'add-column', schema: 'public', table: 'orders', column: { name: 'bad', dataType: 'text; drop table users' } }), (error) => error.code === 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  assert.throws(() => buildSchemaMutationSql('postgresql', { action: 'create-table', schema: 'public', table: 'orders', columns: [{ name: 'id', dataType: 'bigint' }, { name: 'ID', dataType: 'text' }] }), (error) => error.code === 'DATABASE_MANAGER_SCHEMA_ACTION_INVALID');
  assert.throws(() => buildSchemaMutationSql('postgresql', { action: 'create-view', schema: 'public', objectName: 'unsafe', query: 'DELETE FROM customers' }), /read-only SELECT/);
  assert.throws(() => buildSchemaMutationSql('postgresql', { action: 'add-foreign-key', schema: 'public', table: 'items', constraintName: 'fk', foreignKeyColumns: ['order_id', 'tenant_id'], referencedTable: 'orders', referencedColumns: ['id'] }), /counts must match/);
  assert.deepEqual(schemaAdministrationCapabilities(profile({ accessMode: 'read-only' })).actions, []);
  assert.equal(schemaAdministrationCapabilities(profile({ accessMode: 'read-only' })).available, false);
});

test('runs schema actions through query safety and persistent tasks', async () => {
  const calls = [];
  const tasks = new Map();
  const taskService = {
    create: async (_workspaceId, _actorId, input) => { const task = { id: 'task-a', revision: 1, state: 'queued', ...input }; tasks.set(task.id, task); return task; },
    start: async (_workspaceId, _actorId, id) => { const task = { ...tasks.get(id), state: 'running', revision: 2 }; tasks.set(id, task); return task; },
    complete: async (_workspaceId, _actorId, id, options = {}) => { const task = { ...tasks.get(id), state: options.state || 'succeeded', revision: 3 }; tasks.set(id, task); return task; },
    get: async (_workspaceId, id) => tasks.get(id),
    registerCancellation: (_workspaceId, _taskId, cancellation) => { calls.push(['cancellation', cancellation]); return () => calls.push(['unregister']); }
  };
  const service = new DatabaseSchemaAdministrationService({
    profileService: { get: async () => profile() },
    queryService: {
      execute: async (...args) => { calls.push(['execute', ...args]); return { result: { affectedRows: 0 } }; },
      cancel: (...args) => calls.push(['cancel', ...args])
    },
    taskService
  });
  const result = await service.execute('workspace-a', 'tester', { profileId: 'profile-a', requestId: 'schema-action-a', action: 'drop-table', schema: 'public', table: 'old_orders', approval: { confirmed: true, typedConfirmation: 'DROP' } });
  assert.equal(result.task.state, 'succeeded');
  assert.equal(calls.find((call) => call[0] === 'execute')[3].source, 'schema');
  assert.equal(calls.find((call) => call[0] === 'execute')[3].query, 'DROP TABLE "public"."old_orders"');
  const capabilities = await service.capabilities('workspace-a', 'profile-a');
  assert.equal(capabilities.available, true);
  assert.ok(capabilities.actions.includes('create-index'));
  assert.ok(capabilities.actions.includes('add-foreign-key'));
  assert.ok(capabilities.actions.includes('create-materialized-view'));
});

test('requires production confirmation before creating an operation task', async () => {
  let taskCreates = 0;
  const service = new DatabaseSchemaAdministrationService({
    profileService: { get: async () => profile({ environment: 'production' }) },
    queryService: { execute: async () => ({ result: {} }), cancel: () => ({ cancelled: true }) },
    taskService: {
      create: async () => { taskCreates += 1; }, start: async () => {}, complete: async () => {},
      get: async () => null, registerCancellation: () => () => {}
    }
  });
  await assert.rejects(service.execute('workspace-a', 'tester', { profileId: 'profile-a', action: 'create-table', table: 'events', columns: [{ name: 'id', dataType: 'bigint' }] }), (error) => error.code === 'DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED');
  assert.equal(taskCreates, 0);
});

test('records failed schema tasks without leaking query details', async () => {
  const tasks = new Map();
  let completedOptions;
  const service = new DatabaseSchemaAdministrationService({
    profileService: { get: async () => profile() },
    queryService: { execute: async () => { throw Object.assign(new Error('secret SQL failure'), { code: 'FAILED' }); }, cancel: () => ({ cancelled: true }) },
    taskService: {
      create: async (_workspaceId, _actorId, input) => { const task = { id: 'task-a', revision: 1, state: 'queued', ...input }; tasks.set(task.id, task); return task; },
      start: async () => { const task = { ...tasks.get('task-a'), revision: 2, state: 'running' }; tasks.set(task.id, task); return task; },
      get: async () => tasks.get('task-a'),
      complete: async (_workspaceId, _actorId, _id, options) => { completedOptions = options; return { state: 'failed' }; },
      registerCancellation: () => () => {}
    }
  });
  await assert.rejects(service.execute('workspace-a', 'tester', { profileId: 'profile-a', action: 'drop-table', table: 'orders', approval: { confirmed: true } }), /secret SQL failure/);
  assert.equal(completedOptions.state, 'failed');
  assert.equal(completedOptions.safeMessage, 'Database schema operation failed.');
});

test('routes procedural definitions through the opaque executor and administration tasks', async () => {
  const calls = [];
  const task = { id: 'task-trigger', revision: 1 };
  const service = new DatabaseSchemaAdministrationService({
    profileService: { get: async () => profile({ name: 'Development', environment: 'development' }) },
    queryService: { execute: async () => { throw new Error('structured query should not run'); }, cancel: () => ({ cancelled: true }) },
    definitionExecutor: {
      execute: async (...args) => { calls.push(['definition', ...args]); return { result: { affectedRows: 0 } }; },
      cancel: () => ({ cancelled: true })
    },
    taskService: {
      create: async (_workspaceId, _actorId, input) => { calls.push(['create', input]); return { ...task, state: 'queued' }; },
      start: async () => ({ ...task, revision: 2, state: 'running' }),
      complete: async () => ({ ...task, revision: 3, state: 'succeeded' }),
      get: async () => ({ ...task, revision: 2, state: 'running' }),
      registerCancellation: () => () => {}
    }
  });
  const result = await service.execute('workspace-a', 'tester', {
    profileId: 'profile-a', action: 'create-trigger', schema: 'public', table: 'orders', objectName: 'orders_audit',
    definition: 'CREATE TRIGGER orders_audit AFTER INSERT ON public.orders EXECUTE FUNCTION audit_orders()', approval: { confirmed: true }
  });
  assert.equal(result.task.state, 'succeeded');
  assert.equal(calls.find((call) => call[0] === 'create')[1].type, 'administration');
  assert.equal(calls.find((call) => call[0] === 'definition')[3].source, 'schema');
});
