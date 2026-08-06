const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DatabaseTransferService, buildTransferCommand, normalizeFormat } = require('./transfer-service');

function profile(overrides = {}) {
  return {
    id: 'profile-a', name: 'Orders', driverId: 'postgresql', environment: 'development', accessMode: 'read-write',
    endpoint: { kind: 'network', host: 'db.example.test', port: 5432 }, database: 'orders', settings: { username: 'app' },
    queryTimeoutMs: 1000, credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-a' }], ...overrides
  };
}

function taskHarness() {
  const records = [];
  return {
    records,
    async create(_workspace, _actor, input) { const task = { id: 'task-a', revision: 1, state: 'queued', progress: input.progress, ...input }; records.push(task); return task; },
    async start(_workspace, _actor, id, revision) { const task = { ...records[0], id, state: 'running', revision: revision + 1 }; records[0] = task; return task; },
    async reportProgress(_workspace, _actor, id, progress, revision) { const task = { ...records[0], id, progress: { ...records[0].progress, ...progress }, revision: revision + 1 }; records[0] = task; return task; },
    async complete(_workspace, _actor, id, options) { const task = { ...records[0], id, state: options.state === 'failed' ? 'failed' : 'succeeded', revision: options.expectedRevision + 1 }; records[0] = task; return task; },
    async get() { return records[0]; },
    registerCancellation() { return () => {}; }
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', 143, 'SIGTERM'); };
  return child;
}

test('builds shell-free driver commands and keeps passwords in environment variables', () => {
  const command = buildTransferCommand('dump', profile(), {
    endpoint: profile().endpoint, database: 'orders', credentials: { password: 'secret' }
  }, { format: 'sql', path: 'C:\\Exports\\orders.sql', environment: { PATH: 'test' } });
  assert.equal(command.executable, 'pg_dump');
  assert.ok(command.args.includes('--file'));
  assert.equal(command.env.PGPASSWORD, 'secret');
  assert.equal(command.env.PATH, 'test');
  assert.equal(command.args.includes('secret'), false);
  assert.throws(() => normalizeFormat('import', 'csv', profile()), (error) => error.code === 'DATABASE_MANAGER_TRANSFER_FORMAT_INVALID');
});

test('rejects imports on read-only profiles before opening a file dialog', async () => {
  let opened = false;
  const service = new DatabaseTransferService({
    profileService: { get: async () => profile({ accessMode: 'read-only' }) },
    secretStore: { resolve: async () => 'secret' },
    taskService: taskHarness(),
    showOpenDialog: async () => { opened = true; return { canceled: true }; },
    showSaveDialog: async () => ({ canceled: true })
  });
  await assert.rejects(service.execute('workspace-a', 'actor-a', { operation: 'import', profileId: 'profile-a' }), (error) => error.code === 'DATABASE_MANAGER_READ_ONLY_VIOLATION');
  assert.equal(opened, false);
});

test('runs a bounded import as a persistent task and clears runtime credentials', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-transfer-'));
  const importPath = path.join(root, 'orders.sql');
  await fs.writeFile(importPath, 'INSERT INTO orders VALUES (1);', 'utf8');
  const tasks = taskHarness();
  let child;
  const service = new DatabaseTransferService({
    profileService: { get: async () => profile() },
    secretStore: { resolve: async () => 'secret' },
    taskService: tasks,
    showOpenDialog: async () => ({ canceled: false, filePaths: [importPath] }),
    showSaveDialog: async () => ({ canceled: true }),
    spawnProcess: (executable, args, options) => { assert.equal(executable, 'psql'); assert.ok(args.includes('--file')); assert.equal(options.shell, false); assert.equal(options.env.PGPASSWORD, 'secret'); child = fakeChild(); setImmediate(() => child.emit('close', 0, null)); return child; },
    localResourceResolver: async () => null,
    environment: { PATH: 'test' }
  });
  const result = await service.execute('workspace-a', 'actor-a', { operation: 'import', profileId: 'profile-a', approval: { confirmed: true } });
  assert.equal(result.task.state, 'succeeded');
  assert.equal(result.displayName, 'orders.sql');
  assert.ok(tasks.records[0].progress.bytesTotal > 0);
  await fs.rm(root, { recursive: true, force: true });
});
