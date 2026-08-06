const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { RepositoryVerificationService, normalizeRequest, sampleFiles } = require('./repository-verification');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'verification-device';

function memoryDatabase(records) {
  let sequence = 0;
  const data = Object.fromEntries(Object.entries(records).map(([type, values]) => [type, values.map((value) => structuredClone(value))]));
  data.verificationRun = data.verificationRun || [];
  const transitions = { queued: ['running', 'failed', 'canceled'], running: ['succeeded', 'warning', 'failed', 'canceled'] };
  return {
    repository(type) {
      return {
        async create(input) {
          const now = new Date().toISOString();
          const record = { ...structuredClone(input), id: `verify-${++sequence}`, revision: 1, createdAt: now, updatedAt: now };
          delete record.actorId;
          data[type].push(record);
          return structuredClone(record);
        },
        async get(workspaceId, id) { return structuredClone(data[type].find((record) => record.workspaceId === workspaceId && record.id === id) || null); },
        async list(workspaceId, options = {}) { return data[type].filter((record) => record.workspaceId === workspaceId).slice(0, options.limit || 100).map((record) => structuredClone(record)); }
      };
    },
    async transaction(operation) {
      return operation({
        get(type, workspaceId, id) { return data[type].find((record) => record.workspaceId === workspaceId && record.id === id) || null; },
        projectExecution(type, workspaceId, id, changes) {
          const index = data[type].findIndex((record) => record.workspaceId === workspaceId && record.id === id);
          const current = data[type][index];
          const next = changes.state || current.state;
          if (next !== current.state && !transitions[current.state]?.includes(next)) throw new Error('invalid transition');
          data[type][index] = { ...current, ...structuredClone(changes), revision: current.revision + 1, updatedAt: new Date().toISOString() };
          return structuredClone(data[type][index]);
        }
      });
    }
  };
}

function file(path, content) {
  return { path, type: 'file', sizeBytes: Buffer.byteLength(content), content, contentDigest: { digest: `digest-${path}` } };
}

function fixture(options = {}) {
  const filesByPoint = options.filesByPoint || {
    'point-1': [file('/srv/a.txt', 'alpha'), file('/srv/b.txt', 'bravo')],
    'point-2': [file('/srv/a.txt', 'alpha two')]
  };
  const points = Object.keys(filesByPoint).map((id) => ({ id, workspaceId: WORKSPACE_ID, repositoryCopies: [{ repositoryId: 'repository-1', state: 'available' }] }));
  const database = memoryDatabase({
    repository: [{ id: 'repository-1', workspaceId: WORKSPACE_ID, workerAffinity: [`device:${DEVICE_ID}`], health: { status: 'ready', lockState: { status: 'available' } } }],
    recoveryPoint: points
  });
  const opens = [];
  const streamed = [];
  const snapshotBrowser = {
    async openAuthenticatedSnapshot(_workspaceId, recoveryPointId, openOptions = {}) {
      opens.push({ recoveryPointId, repositoryId: openOptions.repositoryId || null });
      const files = filesByPoint[recoveryPointId];
      if (!files) throw new Error('missing point');
      return {
        point: { id: recoveryPointId }, copy: { repositoryId: openOptions.repositoryId || 'repository-1' },
        manifest: { files }, summary: { manifestChecksum: { digest: `manifest-${recoveryPointId}` } }, masterKey: Buffer.alloc(32),
        engine: {
          async *streamFile(_context, input) {
            streamed.push(input.path);
            if (options.corruptPath === input.path) throw Object.assign(new Error('A snapshot chunk failed authentication.'), { code: 'REPOSITORY_AUTHENTICATION_FAILED', category: 'integrity' });
            yield Buffer.from(files.find((entry) => entry.path === input.path).content);
          }
        }
      };
    }
  };
  const service = new RepositoryVerificationService({ controlDatabase: database, snapshotBrowser, deviceId: DEVICE_ID, notificationService: options.notificationService });
  return { database, service, opens, streamed };
}

test('normalizes modes and chooses a stable bounded hash-ranked sample', () => {
  assert.equal(normalizeRequest({ mode: 'checksum', repositoryId: 'repo' }).repositoryId, 'repo');
  const files = Array.from({ length: 20 }, (_value, index) => file(`/srv/${index}.txt`, String(index)));
  const first = sampleFiles('point', files, { samplePercent: 10, minimumFiles: 3, maximumFiles: 5 });
  const second = sampleFiles('point', [...files].reverse(), { samplePercent: 10, minimumFiles: 3, maximumFiles: 5 });
  assert.equal(first.length, 3);
  assert.deepEqual(first.map((entry) => entry.path), second.map((entry) => entry.path));
  assert.throws(() => normalizeRequest({ mode: 'sample-restore', recoveryPointId: 'point', samplePercent: 0 }), (error) => error.code === 'VERIFICATION_INPUT_INVALID');
});

test('fully streams every file in every available point for repository checksum verification', async () => {
  const { service, opens, streamed } = fixture();
  const started = await service.start(WORKSPACE_ID, 'actor', { mode: 'checksum', repositoryId: 'repository-1' });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.result.recoveryPointsVerified, 2);
  assert.equal(completed.result.filesVerified, 3);
  assert.equal(completed.result.bytesVerified, 19);
  assert.deepEqual(opens.map((item) => item.repositoryId), ['repository-1', 'repository-1']);
  assert.deepEqual(streamed, ['/srv/a.txt', '/srv/b.txt', '/srv/a.txt']);
  assert.equal(completed.result.evidenceDigest.digest.length, 64);
});

test('sample restore binds to the requested repository and verifies only the deterministic sample', async () => {
  const filesByPoint = { 'point-1': Array.from({ length: 10 }, (_value, index) => file(`/srv/${index}.txt`, `content-${index}`)) };
  const { service, opens, streamed } = fixture({ filesByPoint });
  const started = await service.start(WORKSPACE_ID, 'actor', { mode: 'sample-restore', recoveryPointId: 'point-1', repositoryId: 'repository-1', samplePercent: 20, minimumFiles: 1, maximumFiles: 10 });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.result.filesVerified, 2);
  assert.equal(streamed.length, 2);
  assert.equal(opens[0].repositoryId, 'repository-1');
});

test('records authenticated content corruption as a safe failed VerificationRun', async () => {
  const { service } = fixture({ corruptPath: '/srv/b.txt' });
  const started = await service.start(WORKSPACE_ID, 'actor', { mode: 'checksum', repositoryId: 'repository-1' });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'REPOSITORY_AUTHENTICATION_FAILED');
  assert.equal(completed.result.error.category, 'integrity');
});

test('notifies every terminal verification outcome and isolates delivery failures', async () => {
  const notified = [];
  const successful = fixture({ notificationService: { async notifyVerificationRun(workspaceId, run) { notified.push({ workspaceId, run }); } } });
  const started = await successful.service.start(WORKSPACE_ID, 'actor', { mode: 'checksum', repositoryId: 'repository-1' });
  const completed = await successful.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].workspaceId, WORKSPACE_ID);
  assert.equal(notified[0].run.state, 'succeeded');

  const failing = fixture({ corruptPath: '/srv/b.txt', notificationService: { async notifyVerificationRun() { throw new Error('provider unavailable'); } } });
  const failedStart = await failing.service.start(WORKSPACE_ID, 'actor', { mode: 'checksum', repositoryId: 'repository-1' });
  const failed = await failing.service.wait(WORKSPACE_ID, failedStart.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result.error.code, 'REPOSITORY_AUTHENTICATION_FAILED');
});

test('reconciles queued and running verification records after restart', async () => {
  const { database, service } = fixture();
  await database.repository('verificationRun').create({ workspaceId: WORKSPACE_ID, actorId: 'actor', scopeType: 'repository', scopeId: 'repository-1', mode: 'checksum', state: 'queued' });
  await database.repository('verificationRun').create({ workspaceId: WORKSPACE_ID, actorId: 'actor', scopeType: 'repository', scopeId: 'repository-1', mode: 'sample-restore', state: 'running' });
  const reconciled = await service.reconcile(WORKSPACE_ID, 'reconciler');
  assert.equal(reconciled.length, 2);
  assert.ok(reconciled.every((record) => record.state === 'failed' && record.result.error.code === 'VERIFICATION_PROCESS_INTERRUPTED'));
});

test('leaves adapter-owned recovery drills to their dedicated reconciler', async () => {
  const { database, service } = fixture();
  const drill = await database.repository('verificationRun').create({ workspaceId: WORKSPACE_ID, actorId: 'actor', scopeType: 'job', scopeId: 'job-mongodb', mode: 'mongodb-recovery-drill', state: 'running' });
  assert.deepEqual(await service.reconcile(WORKSPACE_ID, 'reconciler'), []);
  assert.equal((await database.repository('verificationRun').get(WORKSPACE_ID, drill.id)).state, 'running');
});

test('persists immutable VerificationRun transitions in the real control database', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-verification-control-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const control = new BackupControlDatabase({ rootPath });
  await control.initialize();
  context.after(() => control.close());
  const record = await control.repository('verificationRun').create({ workspaceId: WORKSPACE_ID, scopeType: 'repository', scopeId: 'repository-1', recoveryPointId: null, mode: 'checksum', state: 'queued' });
  const running = await control.transaction((transaction) => transaction.projectExecution('verificationRun', WORKSPACE_ID, record.id, { state: 'running', progress: { filesVerified: 0 } }, { expectedRevision: record.revision }));
  const completed = await control.transaction((transaction) => transaction.projectExecution('verificationRun', WORKSPACE_ID, record.id, { state: 'succeeded', result: { filesVerified: 1 } }, { expectedRevision: running.revision }));
  assert.equal(completed.state, 'succeeded');
  await assert.rejects(control.transaction((transaction) => transaction.projectExecution('verificationRun', WORKSPACE_ID, record.id, { progress: {} }, { expectedRevision: completed.revision })), (error) => error.code === 'BACKUP_CONTROL_RECORD_TERMINAL');
  const drill = await control.repository('verificationRun').create({ workspaceId: WORKSPACE_ID, scopeType: 'job', scopeId: 'job-mongodb', recoveryPointId: null, mode: 'mongodb-recovery-drill', state: 'queued' });
  const drillRunning = await control.transaction((transaction) => transaction.projectExecution('verificationRun', WORKSPACE_ID, drill.id, { state: 'running' }, { expectedRevision: drill.revision }));
  const drillInterrupted = await control.transaction((transaction) => transaction.projectExecution('verificationRun', WORKSPACE_ID, drill.id, { state: 'interrupted', progress: { phase: 'operator-action-required' } }, { expectedRevision: drillRunning.revision }));
  const drillFailed = await control.transaction((transaction) => transaction.projectExecution('verificationRun', WORKSPACE_ID, drill.id, { state: 'failed' }, { expectedRevision: drillInterrupted.revision }));
  assert.equal(drillFailed.state, 'failed');
});
