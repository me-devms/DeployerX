const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { FileRestoreService, LocalRestoreTarget, archiveRelativePath, createConnectionRestoreTarget, expandSelection, normalizeRequest } = require('./file-restore');
const { fingerprintHostKey } = require('./ssh-connection');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'device-test';

function memoryDatabase(records) {
  let sequence = 0;
  const repositories = Object.fromEntries(Object.entries(records).map(([type, values]) => [type, values.map((value) => structuredClone(value))]));
  repositories.restoreRun = [];
  const transitions = { queued: ['preparing', 'failed', 'interrupted'], preparing: ['running', 'failed', 'interrupted'], running: ['validating', 'failed', 'interrupted'], validating: ['succeeded', 'warning', 'failed', 'interrupted'], interrupted: ['failed'] };
  const repository = (type) => ({
    async create(input) {
      const now = new Date().toISOString();
      const record = { ...structuredClone(input), id: `restore-${++sequence}`, revision: 1, schemaVersion: 1, createdAt: now, updatedAt: now, createdBy: input.actorId || 'system', updatedBy: input.actorId || 'system', deletedAt: null };
      delete record.actorId;
      repositories[type].push(record);
      return structuredClone(record);
    },
    async get(workspaceId, id) { return structuredClone(repositories[type].find((item) => item.workspaceId === workspaceId && item.id === id) || null); },
    async list(workspaceId, options = {}) { return repositories[type].filter((item) => item.workspaceId === workspaceId).slice(0, options.limit || 100).map((item) => structuredClone(item)); }
  });
  return {
    repository,
    async transaction(operation) {
      return operation({
        get(type, workspaceId, id) { return repositories[type].find((item) => item.workspaceId === workspaceId && item.id === id) || null; },
        projectExecution(type, workspaceId, id, changes) {
          const index = repositories[type].findIndex((item) => item.workspaceId === workspaceId && item.id === id);
          const current = repositories[type][index];
          const nextState = changes.state || current.state;
          if (nextState !== current.state && !transitions[current.state]?.includes(nextState)) throw new Error('invalid transition');
          const updated = { ...current, ...structuredClone(changes), revision: current.revision + 1, updatedAt: new Date().toISOString() };
          repositories[type][index] = updated;
          return structuredClone(updated);
        }
      });
    }
  };
}

async function fixture(context, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-file-restore-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const database = memoryDatabase({
    source: [{ id: 'source-1', workspaceId: WORKSPACE_ID, connectionId: 'connection-1' }],
    connection: [{ id: 'connection-1', workspaceId: WORKSPACE_ID, kind: 'local', workerAffinity: [`device:${DEVICE_ID}`], lastTest: { status: 'success' } }]
  });
  const snapshotBrowser = {
    async openAuthenticatedSnapshot() {
      return {
        point: { id: 'point-1', sourceId: 'source-1' }, copy: { repositoryId: 'repository-1' },
        manifest: { files }, masterKey: Buffer.alloc(32),
        engine: { async *streamFile(_context, input) { yield Buffer.from(files.find((item) => item.path === input.path).content); } }
      };
    }
  };
  const service = new FileRestoreService({ controlDatabase: database, snapshotBrowser, deviceId: DEVICE_ID, createTarget: () => new LocalRestoreTarget() });
  return { root, database, service };
}

function directory(entryPath) {
  return { path: entryPath, type: 'directory', sizeBytes: 0, metadata: { type: 'directory', size: null } };
}

function file(entryPath, content) {
  return { path: entryPath, type: 'file', sizeBytes: Buffer.byteLength(content), content, metadata: { type: 'file', size: Buffer.byteLength(content) } };
}

test('normalizes bounded selections and preserves archive roots below alternate destinations', () => {
  assert.deepEqual(normalizeRequest({ recoveryPointId: 'point', targetConnectionId: 'target', mode: 'alternate', destinationPath: '/restore', conflictPolicy: 'skip', paths: ['/srv', '/srv/app/a.txt'] }).paths, ['/srv']);
  assert.equal(archiveRelativePath('/srv/app/a.txt'), 'srv/app/a.txt');
  assert.equal(archiveRelativePath('C:/Logs/a.txt'), 'C/Logs/a.txt');
  assert.equal(archiveRelativePath('//server/share/a.txt'), 'server/share/a.txt');
  assert.throws(() => normalizeRequest({ recoveryPointId: 'point', targetConnectionId: 'target', mode: 'alternate', destinationPath: '/restore', paths: ['/srv/../secret'] }), (error) => error.code === 'SNAPSHOT_PATH_INVALID');
});

test('expands directory selections in hierarchy order', () => {
  const groups = expandSelection({ files: [directory('/srv'), directory('/srv/app'), file('/srv/app/a.txt', 'A')] }, ['/srv']);
  assert.deepEqual(groups[0].entries.map((entry) => entry.path), ['/srv', '/srv/app', '/srv/app/a.txt']);
});

test('streams selected files into an alternate destination and records verified success', async (context) => {
  const { root, service } = await fixture(context, [directory('/srv'), directory('/srv/app'), file('/srv/app/a.txt', 'alpha')]);
  const started = await service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'point-1', targetConnectionId: 'connection-1', mode: 'alternate', destinationPath: root, conflictPolicy: 'fail', paths: ['/srv/app'] });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.result.bytesRestored, 5);
  assert.equal(await fs.readFile(path.join(root, 'srv', 'app', 'a.txt'), 'utf8'), 'alpha');
});

test('fail policy preflights conflicts without changing existing content', async (context) => {
  const { root, service } = await fixture(context, [file('/srv/app/a.txt', 'new')]);
  const target = path.join(root, 'srv', 'app', 'a.txt');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'existing');
  const started = await service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'point-1', targetConnectionId: 'connection-1', mode: 'alternate', destinationPath: root, conflictPolicy: 'fail', paths: ['/srv/app/a.txt'] });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'RESTORE_CONFLICT');
  assert.equal(await fs.readFile(target, 'utf8'), 'existing');
});

test('rename and skip policies preserve existing targets', async (context) => {
  const { root, service } = await fixture(context, [file('/srv/app/a.txt', 'restored')]);
  const target = path.join(root, 'srv', 'app', 'a.txt');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'existing');
  let started = await service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'point-1', targetConnectionId: 'connection-1', mode: 'alternate', destinationPath: root, conflictPolicy: 'rename', paths: ['/srv/app/a.txt'] });
  let completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(await fs.readFile(path.join(root, 'srv', 'app', 'a (restored 1).txt'), 'utf8'), 'restored');
  started = await service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'point-1', targetConnectionId: 'connection-1', mode: 'alternate', destinationPath: root, conflictPolicy: 'skip', paths: ['/srv/app/a.txt'] });
  completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'warning');
  assert.equal(completed.result.skippedItems, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'existing');
});

test('skip merges through existing directories and restores missing descendants', async (context) => {
  const { root, service } = await fixture(context, [directory('/srv/app'), file('/srv/app/new.txt', 'new file')]);
  await fs.mkdir(path.join(root, 'srv', 'app'), { recursive: true });
  const started = await service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'point-1', targetConnectionId: 'connection-1', mode: 'alternate', destinationPath: root, conflictPolicy: 'skip', paths: ['/srv/app'] });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'warning');
  assert.equal(completed.result.skippedItems, 1);
  assert.equal(await fs.readFile(path.join(root, 'srv', 'app', 'new.txt'), 'utf8'), 'new file');
});

test('rejects symbolic-link parents before any restore write', async (context) => {
  const { root, service } = await fixture(context, [file('/srv/app/a.txt', 'secret')]);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-file-restore-outside-'));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'srv'));
  await fs.symlink(outside, path.join(root, 'srv', 'app'), process.platform === 'win32' ? 'junction' : 'dir');
  const started = await service.start(WORKSPACE_ID, 'actor', { recoveryPointId: 'point-1', targetConnectionId: 'connection-1', mode: 'alternate', destinationPath: root, conflictPolicy: 'overwrite', paths: ['/srv/app/a.txt'] });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'RESTORE_TARGET_LINK_UNSAFE');
  await assert.rejects(fs.access(path.join(outside, 'a.txt')));
});

test('does not resolve SSH credentials before the pinned host key is accepted', async () => {
  let secretResolutions = 0;
  class RejectingClient extends EventEmitter {
    connect(config) {
      assert.equal(config.hostVerifier(Buffer.from('unexpected key')), false);
      queueMicrotask(() => this.emit('error', new Error('host rejected')));
    }
    end() {}
  }
  await assert.rejects(createConnectionRestoreTarget({
    workspaceId: WORKSPACE_ID,
    connection: { kind: 'ssh', endpoint: { host: 'server.example', port: 22, username: 'backup', authType: 'password' }, trust: { fingerprint: fingerprintHostKey(Buffer.from('expected key')) }, secretRefIds: ['secret-1'] },
    secretStore: { async resolve() { secretResolutions += 1; return 'password'; } },
    ClientClass: RejectingClient
  }), (error) => error.code === 'RESTORE_SSH_CONNECTION_FAILED');
  assert.equal(secretResolutions, 0);
});

test('reconciles abandoned durable restore runs after process restart', async (context) => {
  const { database, service } = await fixture(context, [file('/srv/app/a.txt', 'content')]);
  const abandoned = await database.repository('restoreRun').create({ workspaceId: WORKSPACE_ID, actorId: 'actor', recoveryPointIds: ['point-1'], targetConnectionId: 'connection-1', state: 'running', progress: { phase: 'running' } });
  const mysql = await database.repository('restoreRun').create({ workspaceId: WORKSPACE_ID, actorId: 'actor', recoveryPointIds: ['point-mysql'], targetConnectionId: 'connection-1', target: { engine: 'mysql' }, state: 'running', progress: { phase: 'running' } });
  const reconciled = await service.reconcile(WORKSPACE_ID, 'reconciler');
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, abandoned.id);
  assert.equal(reconciled[0].state, 'failed');
  assert.equal(reconciled[0].result.error.code, 'RESTORE_PROCESS_INTERRUPTED');
  assert.equal((await database.repository('restoreRun').get(WORKSPACE_ID, mysql.id)).state, 'running');
  assert.equal((await service.list(WORKSPACE_ID)).some((record) => record.id === mysql.id), false);
});
