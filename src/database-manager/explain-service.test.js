const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseExplainService, buildExplainQuery, normalizePlan } = require('./explain-service');

const profile = (overrides = {}) => ({ id: 'profile-a', name: 'Orders', driverId: 'postgresql', environment: 'development', accessMode: 'read-write', queryTimeoutMs: 1000, ...overrides });

test('builds dialect-aware read-only explain statements', () => {
  assert.equal(buildExplainQuery('postgresql', 'SELECT * FROM orders;'), 'EXPLAIN (FORMAT JSON, ANALYZE false, BUFFERS false, VERBOSE false) SELECT * FROM orders');
  assert.equal(buildExplainQuery('mysql', 'SELECT 1'), 'EXPLAIN FORMAT=JSON SELECT 1');
  assert.equal(buildExplainQuery('sqlite', 'SELECT 1'), 'EXPLAIN QUERY PLAN SELECT 1');
  assert.throws(() => buildExplainQuery('sqlite', 'DELETE FROM orders'), (error) => error.code === 'DATABASE_MANAGER_EXPLAIN_READ_ONLY_REQUIRED');
});

test('normalizes JSON and SQLite explain rows without leaking arbitrary result objects', () => {
  const postgres = normalizePlan('postgresql', { columns: ['QUERY PLAN'], rows: [[JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan' } }])]], executionTimeMs: 4 });
  assert.equal(postgres.plan[0].Plan['Node Type'], 'Seq Scan');
  const sqlite = normalizePlan('sqlite', { columns: ['id', 'parent', 'notused', 'detail'], rows: [[0, 0, 0, 'SCAN orders']], warnings: ['slow'] });
  assert.deepEqual(sqlite.plan, [{ id: 0, parentId: 0, detail: 'SCAN orders' }]);
});

test('bounds deeply nested explain plans before they reach the renderer', () => {
  const plan = normalizePlan('postgresql', { columns: ['QUERY PLAN'], rows: [[JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan', Plans: [{ 'Node Type': 'Nested Loop' }] } }])]] });
  assert.equal(plan.plan[0].Plan['Node Type'], 'Seq Scan');
  assert.ok(Array.isArray(plan.plan[0].Plan.Plans));
});

test('creates, completes, and cancels explain tasks through the query service', async () => {
  let cancelled = false;
  const tasks = [];
  const taskService = {
    async create(_workspace, _actor, input) { const task = { id: 'task-a', revision: 1, state: 'queued', ...input }; tasks.push(task); return task; },
    async start(_workspace, _actor, id, revision) { tasks[0] = { ...tasks[0], id, revision: revision + 1, state: 'running' }; return tasks[0]; },
    async complete(_workspace, _actor, id, options) { tasks[0] = { ...tasks[0], id, revision: options.expectedRevision + 1, state: options.state === 'failed' ? 'failed' : 'succeeded' }; return tasks[0]; },
    registerCancellation() { return () => {}; },
    async get() { return tasks[0]; }
  };
  const queryService = {
    async execute(_workspace, _actor, request) { assert.match(request.query, /^EXPLAIN/); return { result: { columns: ['QUERY PLAN'], rows: [[JSON.stringify([{ Plan: { 'Node Type': 'Index Scan' } }])]], executionTimeMs: 2 } }; },
    cancel() { cancelled = true; return { cancelled: true }; }
  };
  const service = new DatabaseExplainService({ profileService: { get: async () => profile() }, queryService, taskService });
  const result = await service.execute('workspace-a', 'actor-a', { profileId: 'profile-a', query: 'SELECT * FROM orders' });
  assert.equal(result.task.state, 'succeeded');
  assert.equal(result.result.plan[0].Plan['Node Type'], 'Index Scan');
  service.cancel('workspace-a', 'actor-a', result.requestId);
  assert.equal(cancelled, true);
});
