const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js/dist/sql-asm.js');
const {
  BackupControlDatabase,
  CONTROL_DATABASE_VERSION,
  ControlDatabaseCorruptionError,
  ENTITY_TYPES
} = require('./control-database');

async function fixture(context, prefix = 'deployerx-control-db-test-') {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const control = new BackupControlDatabase({ rootPath });
  await control.initialize();
  context.after(() => control.close());
  return { rootPath, control };
}

function connection(workspaceId, name, extra = {}) {
  return {
    workspaceId,
    name,
    kind: 'local',
    adapterId: 'deployerx.local',
    adapterVersion: '1.0.0',
    scope: 'device',
    endpoint: {},
    secretRefIds: [],
    trust: {},
    workerAffinity: [],
    ...extra
  };
}

test('initializes the versioned schema and exposes every entity repository', async (context) => {
  const { rootPath, control } = await fixture(context);
  assert.equal((await fs.stat(path.join(rootPath, 'control.db'))).isFile(), true);
  assert.deepEqual(Object.keys(control.repositories), ENTITY_TYPES);

  const SQL = await initSqlJs();
  const database = new SQL.Database(await fs.readFile(path.join(rootPath, 'control.db')));
  assert.equal(database.exec('PRAGMA user_version')[0].values[0][0], CONTROL_DATABASE_VERSION);
  assert.equal(database.exec('PRAGMA foreign_key_check').length, 0);
  database.close();
});

test('persists records across restart and isolates all workspace reads', async (context) => {
  const { rootPath, control } = await fixture(context);
  const first = await control.repository('connection').create(connection('workspace-a', 'Primary server'));
  const second = await control.repository('connection').create(connection('workspace-b', 'Primary server'));
  assert.equal(await control.repository('connection').get('workspace-b', first.id), null);
  assert.deepEqual((await control.repository('connection').list('workspace-a')).map((entry) => entry.id), [first.id]);
  assert.deepEqual((await control.repository('connection').list('workspace-b')).map((entry) => entry.id), [second.id]);

  await control.close();
  const reopened = new BackupControlDatabase({ rootPath });
  context.after(() => reopened.close());
  await reopened.initialize();
  assert.equal((await reopened.repository('connection').get('workspace-a', first.id)).name, 'Primary server');
});

test('serializes independent process-style instances without losing committed writes', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-control-shared-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const first = new BackupControlDatabase({ rootPath });
  const second = new BackupControlDatabase({ rootPath });
  await Promise.all([first.initialize(), second.initialize()]);
  context.after(() => Promise.all([first.close(), second.close()]));
  await Promise.all([
    first.repository('connection').create(connection('local', 'First process')),
    second.repository('connection').create(connection('local', 'Second process'))
  ]);
  assert.deepEqual((await first.repository('connection').list('local')).map((record) => record.name).sort(), ['First process', 'Second process']);
  assert.deepEqual((await second.repository('connection').list('local')).map((record) => record.name).sort(), ['First process', 'Second process']);
  const duplicateResults = await Promise.allSettled([
    first.repository('connection').create(connection('local', 'One occurrence')),
    second.repository('connection').create(connection('local', 'one occurrence'))
  ]);
  assert.equal(duplicateResults.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(duplicateResults.filter((result) => result.status === 'rejected').length, 1);
});

test('rolls back the database and disk file when a transaction fails', async (context) => {
  const { rootPath, control } = await fixture(context);
  const before = await fs.readFile(path.join(rootPath, 'control.db'));
  await assert.rejects(
    control.transaction((transaction) => {
      transaction.create('connection', connection('local', 'Will roll back'));
      throw new Error('stop transaction');
    }),
    /stop transaction/
  );
  assert.equal((await control.repository('connection').list('local')).length, 0);
  assert.deepEqual(await fs.readFile(path.join(rootPath, 'control.db')), before);
});

test('enforces active-name uniqueness, foreign keys, and cross-workspace references', async (context) => {
  const { control } = await fixture(context);
  await control.repository('connection').create(connection('local', 'Server'));
  await assert.rejects(control.repository('connection').create(connection('local', 'server')), /UNIQUE constraint failed/);
  await assert.rejects(control.repository('source').create({
    workspaceId: 'local', name: 'Missing host', connectionId: 'conn_missing', sourceType: 'files', adapterId: 'deployerx.files', enabled: true
  }), /FOREIGN KEY constraint failed/);

  const otherConnection = await control.repository('connection').create(connection('other', 'Other server'));
  await assert.rejects(control.repository('source').create({
    workspaceId: 'local', name: 'Wrong workspace', connectionId: otherConnection.id, sourceType: 'files', adapterId: 'deployerx.files', enabled: true
  }), /FOREIGN KEY constraint failed/);
});

test('uses optimistic revisions and preserves active names after soft deletion', async (context) => {
  const { control } = await fixture(context);
  const created = await control.repository('connection').create(connection('local', 'Server'));
  const updated = await control.repository('connection').update('local', created.id, { name: 'Renamed server' }, { expectedRevision: 1, actorId: 'tester' });
  assert.equal(updated.revision, 2);
  await assert.rejects(
    control.repository('connection').update('local', created.id, { name: 'Stale' }, { expectedRevision: 1 }),
    (error) => error.code === 'BACKUP_CONTROL_REVISION_CONFLICT'
  );
  const deleted = await control.repository('connection').softDelete('local', created.id, { expectedRevision: 2, actorId: 'tester' });
  assert.equal(deleted.revision, 3);
  assert.equal(await control.repository('connection').get('local', created.id), null);
  assert.equal((await control.repository('connection').get('local', created.id, { includeDeleted: true })).deletedAt, deleted.deletedAt);
  assert.equal((await control.repository('connection').create(connection('local', 'Renamed server'))).name, 'Renamed server');
});

test('imports exact workspace snapshots without emitting another local change', async (context) => {
  const changes = [];
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-control-snapshot-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const control = new BackupControlDatabase({ rootPath, onChange: (items) => changes.push(...items) });
  await control.initialize();
  context.after(() => control.close());
  const created = await control.repository('connection').create(connection('workspace-a', 'Shared server'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changes.length, 1);

  const snapshot = {
    ...created,
    name: 'Shared server renamed remotely',
    revision: 4,
    updatedAt: '2026-08-12T10:00:00.000Z',
    updatedBy: 'remote-user'
  };
  await control.upsertSnapshot('connection', 'workspace-a', snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changes.length, 1);
  assert.deepEqual(await control.repository('connection').get('workspace-a', created.id), snapshot);
});

test('rejects plaintext credential fields before persistence', async (context) => {
  const { control } = await fixture(context);
  await assert.rejects(
    control.repository('connection').create(connection('local', 'Unsafe', { endpoint: { password: 'do-not-store' } })),
    /Plaintext credential field/
  );
});

test('persists the complete constrained domain entity graph', async (context) => {
  const { control } = await fixture(context);
  const workspaceId = 'local';
  const secret = await control.repository('secretRef').create({
    workspaceId, name: 'Repository key', provider: 'electron-safe-storage', scope: 'device',
    providerKey: 'opaque-provider-key', secretType: 'encryption-key', version: 1
  });
  const host = await control.repository('connection').create(connection(workspaceId, 'Backup host', { secretRefIds: [secret.id] }));
  const databaseProfile = await control.repository('databaseProfile').create({
    workspaceId,
    name: 'Database workspace profile',
    sharedConnectionId: host.id,
    driverId: 'sqlite',
    environment: 'unclassified',
    accessMode: 'read-only',
    credentialSecretRefs: []
  });
  await control.repository('databaseSavedQuery').create({
    workspaceId, name: 'Inspect schema', profileId: databaseProfile.id, query: 'SELECT 1', tags: []
  });
  await control.repository('databaseQueryHistory').create({
    workspaceId, profileId: databaseProfile.id, query: 'SELECT 1', source: 'editor', status: 'succeeded',
    classification: 'read', executionTimeMs: 1, rowCount: 1, affectedRows: 0
  });
  await control.repository('databaseNotebook').create({
    workspaceId, name: 'Schema review', profileId: databaseProfile.id,
    cells: [{ id: 'query', type: 'sql', content: 'SELECT 1', collapsed: false }], tags: []
  });
  await control.repository('databaseTask').create({
    workspaceId, profileId: databaseProfile.id, type: 'schema', label: 'Refresh schema', state: 'succeeded', canCancel: false,
    progress: { phase: 'complete', percent: 100, itemsTotal: 1, itemsCompleted: 1, bytesTotal: 0, bytesCompleted: 0, message: null },
    safeMessage: null, startedAt: '2026-08-03T11:00:00.000Z', completedAt: '2026-08-03T11:00:01.000Z'
  });
  const source = await control.repository('source').create({
    workspaceId, name: 'Application files', connectionId: host.id, sourceType: 'files', adapterId: 'deployerx.files', enabled: true
  });
  const route = await control.repository('notificationRoute').create({
    workspaceId, name: 'Desktop alerts', type: 'desktop', enabled: true, secretRefIds: []
  });
  const policy = await control.repository('policy').create({
    workspaceId, name: 'Daily', enabled: true, backupMode: 'incremental', notificationRouteIds: [route.id]
  });
  const repository = await control.repository('repository').create({
    workspaceId, name: 'Local repository', connectionId: null, adapterId: 'deployerx.local-folder',
    engineId: 'restic', secretRefIds: [], encryptionKeyRefId: secret.id
  });
  const job = await control.repository('backupJob').create({
    workspaceId, name: 'Application backup', sourceId: source.id, policyId: policy.id, state: 'enabled',
    repositoryBindings: [{ repositoryId: repository.id, role: 'primary' }]
  });
  const worker = await control.repository('workerRegistration').create({
    workspaceId, name: 'This computer', workerId: 'worker_local', deviceId: 'device_local', state: 'online'
  });
  const { group, run } = await control.transaction((transaction) => {
    const createdGroup = transaction.create('executionGroup', {
      workspaceId, jobId: job.id, jobRevision: job.revision, trigger: 'manual',
      idempotencyKey: 'manual:test:1', state: 'pending'
    });
    const createdRun = transaction.create('run', {
      workspaceId, jobId: job.id, jobRevision: job.revision, executionGroupId: createdGroup.id,
      idempotencyKey: 'manual:test:1:attempt:1', trigger: 'manual', workerId: worker.workerId,
      state: 'queued', attempt: 1, configSnapshot: {}
    });
    return { group: createdGroup, run: createdRun };
  });
  const recoveryPointId = 'rp_019fc700-0000-7000-8000-000000000001';
  const recoveryPoint = await control.repository('recoveryPoint').create({
    id: recoveryPointId, workspaceId, jobId: job.id, sourceId: source.id, runId: run.id,
    type: 'full', consistency: 'filesystem', chainRootId: recoveryPointId,
    capturedFrom: '2026-08-03T00:00:00.000Z', capturedTo: '2026-08-03T00:01:00.000Z',
    repositoryCopies: [{ repositoryId: repository.id, engineSnapshotId: 'snapshot-1', state: 'available' }],
    retention: { expireAt: '2026-09-03T00:00:00.000Z' }
  });
  await control.repository('artifact').create({
    workspaceId, recoveryPointId: recoveryPoint.id, repositoryId: repository.id,
    kind: 'manifest', locator: 'snapshots/snapshot-1', sizeBytes: 1024
  });
  await control.repository('restoreRun').create({
    workspaceId, recoveryPointIds: [recoveryPoint.id], targetConnectionId: host.id, state: 'queued'
  });
  await control.repository('verificationRun').create({
    workspaceId, scopeType: 'recovery-point', scopeId: recoveryPoint.id,
    recoveryPointId: recoveryPoint.id, state: 'queued'
  });

  for (const type of ENTITY_TYPES) {
    assert.equal((await control.repository(type).list(workspaceId)).length, 1, `${type} repository did not retain its record`);
  }
  assert.equal(group.jobId, job.id);
});

test('blocks soft deletion while domain references are active', async (context) => {
  const { control } = await fixture(context);
  const host = await control.repository('connection').create(connection('local', 'Referenced host'));
  await control.repository('source').create({
    workspaceId: 'local', name: 'Referenced source', connectionId: host.id,
    sourceType: 'files', adapterId: 'deployerx.files', enabled: true
  });
  await assert.rejects(
    control.repository('connection').softDelete('local', host.id),
    (error) => error.code === 'BACKUP_CONTROL_RECORD_REFERENCED'
  );
});

test('projects validated Run and ExecutionGroup state without enabling ordinary CRUD', async (context) => {
  const { control } = await fixture(context);
  const workspaceId = 'local';
  const host = await control.repository('connection').create(connection(workspaceId, 'Execution host'));
  const source = await control.repository('source').create({ workspaceId, name: 'Execution source', connectionId: host.id, sourceType: 'files', adapterId: 'deployerx.files', enabled: true });
  const policy = await control.repository('policy').create({ workspaceId, name: 'On demand', enabled: true, backupMode: 'incremental' });
  const job = await control.repository('backupJob').create({ workspaceId, name: 'Execution job', sourceId: source.id, policyId: policy.id, state: 'enabled', repositoryBindings: [] });
  const records = await control.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId, jobId: job.id, jobRevision: job.revision, trigger: 'manual', idempotencyKey: 'manual:projection', state: 'pending' });
    const run = transaction.create('run', { workspaceId, jobId: job.id, jobRevision: job.revision, executionGroupId: group.id, idempotencyKey: 'manual:projection:attempt:1', trigger: 'manual', workerId: 'device:test', state: 'queued', attempt: 1, configSnapshot: {}, progress: {} });
    return { group, run };
  });
  const projected = await control.transaction((transaction) => {
    const group = transaction.projectExecution('executionGroup', workspaceId, records.group.id, { state: 'running', latestRunId: records.run.id }, { expectedRevision: records.group.revision });
    const run = transaction.projectExecution('run', workspaceId, records.run.id, { state: 'preparing', progress: { phase: 'preparing' } }, { expectedRevision: records.run.revision });
    return { group, run };
  });
  assert.equal(projected.group.state, 'running');
  assert.equal(projected.run.state, 'preparing');
  await assert.rejects(control.repository('run').update(workspaceId, projected.run.id, { state: 'running' }), /ordinary CRUD/);
  await assert.rejects(control.transaction((transaction) => transaction.projectExecution('run', workspaceId, projected.run.id, { state: 'succeeded' }, { expectedRevision: projected.run.revision })), (error) => error.code === 'BACKUP_CONTROL_STATE_TRANSITION_INVALID');
});

test('projects RestoreRun progress through validated immutable state transitions', async (context) => {
  const { control } = await fixture(context);
  const workspaceId = 'local';
  const target = await control.repository('connection').create(connection(workspaceId, 'Restore target'));
  const restore = await control.repository('restoreRun').create({
    workspaceId,
    recoveryPointIds: [],
    targetConnectionId: target.id,
    state: 'queued',
    progress: { phase: 'queued' }
  });
  let current = restore;
  for (const state of ['preparing', 'running', 'validating', 'succeeded']) {
    current = await control.transaction((transaction) => transaction.projectExecution(
      'restoreRun', workspaceId, current.id, { state, progress: { phase: state } }, { expectedRevision: current.revision }
    ));
  }
  assert.equal(current.state, 'succeeded');
  await assert.rejects(
    control.transaction((transaction) => transaction.projectExecution('restoreRun', workspaceId, current.id, { progress: { phase: 'changed' } }, { expectedRevision: current.revision })),
    (error) => error.code === 'BACKUP_CONTROL_RECORD_TERMINAL'
  );
  await assert.rejects(control.repository('restoreRun').update(workspaceId, current.id, { state: 'failed' }), /ordinary CRUD/);
});

test('projects VerificationRun through its append-only execution lifecycle', async (context) => {
  const { control } = await fixture(context);
  const workspaceId = 'local';
  const verification = await control.repository('verificationRun').create({ workspaceId, scopeType: 'repository', scopeId: 'repo-test', recoveryPointId: null, mode: 'checksum', state: 'queued' });
  const running = await control.transaction((transaction) => transaction.projectExecution('verificationRun', workspaceId, verification.id, { state: 'running', progress: { filesVerified: 0 } }, { expectedRevision: verification.revision }));
  const succeeded = await control.transaction((transaction) => transaction.projectExecution('verificationRun', workspaceId, verification.id, { state: 'succeeded', result: { filesVerified: 1 } }, { expectedRevision: running.revision }));
  assert.equal(succeeded.state, 'succeeded');
  await assert.rejects(control.transaction((transaction) => transaction.projectExecution('verificationRun', workspaceId, verification.id, { progress: {} }, { expectedRevision: succeeded.revision })), (error) => error.code === 'BACKUP_CONTROL_RECORD_TERMINAL');
  await assert.rejects(control.repository('verificationRun').update(workspaceId, verification.id, { state: 'failed' }), /ordinary CRUD/);
});

test('projects only retention metadata on immutable RecoveryPoints', async (context) => {
  const { control } = await fixture(context);
  const workspaceId = 'local';
  const connectionRecord = await control.repository('connection').create(connection(workspaceId, 'Retention host'));
  const source = await control.repository('source').create({ workspaceId, name: 'Retention source', connectionId: connectionRecord.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true });
  const policy = await control.repository('policy').create({ workspaceId, name: 'Retention policy', enabled: true, schedule: { type: 'manual' }, backupMode: 'full' });
  const job = await control.repository('backupJob').create({ workspaceId, name: 'Retention job', sourceId: source.id, policyId: policy.id, state: 'enabled' });
  const records = await control.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId, jobId: job.id, jobRevision: job.revision, trigger: 'manual', idempotencyKey: 'retention:test', state: 'running' });
    const run = transaction.create('run', { workspaceId, jobId: job.id, jobRevision: job.revision, executionGroupId: group.id, idempotencyKey: 'retention:test:attempt:1', trigger: 'manual', workerId: 'device:test', state: 'running', attempt: 1 });
    const id = 'rp_019fc700-0000-7000-8000-000000000099';
    const point = transaction.create('recoveryPoint', { id, workspaceId, jobId: job.id, sourceId: source.id, runId: run.id, type: 'full', consistency: 'filesystem', chainRootId: id, capturedFrom: '2026-08-03T00:00:00Z', capturedTo: '2026-08-03T00:01:00Z', retention: { ruleMatches: ['last-n'] } });
    const projected = transaction.projectRecoveryPointRetention(workspaceId, point.id, { ruleMatches: [], deletionEligible: true, expireAt: '2026-08-04T00:00:00.000Z' }, { expectedRevision: point.revision, actorId: 'retention-worker' });
    return { point, projected };
  });
  assert.equal(records.projected.revision, records.point.revision + 1);
  assert.equal(records.projected.retention.deletionEligible, true);
  assert.equal(records.projected.capturedTo, records.point.capturedTo);
  await assert.rejects(control.repository('recoveryPoint').update(workspaceId, records.point.id, { capturedTo: '2030-01-01T00:00:00Z' }), /ordinary CRUD/);
});

test('freezes retention and repository-copy projections behind a native media deletion claim', async (context) => {
  const { control } = await fixture(context);
  const workspaceId = 'local';
  const connectionRecord = await control.repository('connection').create(connection(workspaceId, 'Claimed host'));
  const source = await control.repository('source').create({ workspaceId, name: 'Claimed source', connectionId: connectionRecord.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true });
  const policy = await control.repository('policy').create({ workspaceId, name: 'Claimed policy', enabled: true, schedule: { type: 'manual' }, backupMode: 'full' });
  const job = await control.repository('backupJob').create({ workspaceId, name: 'Claimed job', sourceId: source.id, policyId: policy.id, state: 'enabled' });
  const point = await control.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId, jobId: job.id, jobRevision: job.revision, trigger: 'manual', idempotencyKey: 'claim:test', state: 'running' });
    const run = transaction.create('run', { workspaceId, jobId: job.id, jobRevision: job.revision, executionGroupId: group.id, idempotencyKey: 'claim:test:attempt:1', trigger: 'manual', workerId: 'device:test', state: 'running', attempt: 1 });
    const id = 'rp_019fc700-0000-7000-8000-000000000299';
    return transaction.create('recoveryPoint', { id, workspaceId, jobId: job.id, sourceId: source.id, runId: run.id, type: 'full', consistency: 'filesystem', chainRootId: id, capturedFrom: '2026-08-03T00:00:00Z', capturedTo: '2026-08-03T00:01:00Z', repositoryCopies: [], retention: { deletionEligible: true } });
  });
  const claimId = `influxdb3_enterprise_retention_${'c'.repeat(64)}`;
  const claimed = await control.transaction((transaction) => transaction.projectRecoveryPointRetention(workspaceId, point.id, {
    ...point.retention,
    nativeMediaDeletionClaim: { version: 1, claimId, state: 'claimed' }
  }, { expectedRevision: point.revision, actorId: 'retention-worker' }));
  await assert.rejects(
    control.transaction((transaction) => transaction.projectRecoveryPointRetention(workspaceId, claimed.id, { ...claimed.retention, legalHold: true }, { expectedRevision: claimed.revision, actorId: 'hold-worker' })),
    (error) => error.code === 'BACKUP_CONTROL_NATIVE_MEDIA_DELETION_CLAIM_ACTIVE'
  );
  await assert.rejects(
    control.transaction((transaction) => transaction.projectRecoveryPointRepositoryCopies(workspaceId, claimed.id, [], { expectedRevision: claimed.revision, actorId: 'prune-worker' })),
    (error) => error.code === 'BACKUP_CONTROL_NATIVE_MEDIA_DELETION_CLAIM_ACTIVE'
  );
  const released = await control.transaction((transaction) => transaction.projectRecoveryPointRetention(workspaceId, claimed.id, {
    ...claimed.retention,
    nativeMediaDeletionClaim: null
  }, { expectedRevision: claimed.revision, actorId: 'retention-worker', nativeMediaDeletionClaimId: claimId }));
  assert.equal(released.retention.nativeMediaDeletionClaim, null);
});

test('projects only provider-confirmed repository-copy pruning evidence on immutable RecoveryPoints', async (context) => {
  const { control } = await fixture(context);
  const workspaceId = 'local';
  const connectionRecord = await control.repository('connection').create(connection(workspaceId, 'Prune host'));
  const repository = await control.repository('repository').create({ workspaceId, name: 'Prune repository', adapterId: 'deployerx.repository.local-folder', adapterVersion: '1.0.0', engineId: 'deployerx.repository-engine.files', engineVersion: '1.0.0', location: { path: '/archive' }, workerAffinity: ['device:test'] });
  const source = await control.repository('source').create({ workspaceId, name: 'Prune source', connectionId: connectionRecord.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true });
  const policy = await control.repository('policy').create({ workspaceId, name: 'Prune policy', enabled: true, schedule: { type: 'manual' }, backupMode: 'full' });
  const job = await control.repository('backupJob').create({ workspaceId, name: 'Prune job', sourceId: source.id, policyId: policy.id, state: 'enabled' });
  const records = await control.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId, jobId: job.id, jobRevision: job.revision, trigger: 'manual', idempotencyKey: 'prune:test', state: 'running' });
    const run = transaction.create('run', { workspaceId, jobId: job.id, jobRevision: job.revision, executionGroupId: group.id, idempotencyKey: 'prune:test:attempt:1', trigger: 'manual', workerId: 'device:test', state: 'running', attempt: 1 });
    const id = 'rp_019fc700-0000-7000-8000-000000000199';
    const point = transaction.create('recoveryPoint', { id, workspaceId, jobId: job.id, sourceId: source.id, runId: run.id, type: 'full', consistency: 'filesystem', chainRootId: id, capturedFrom: '2026-08-03T00:00:00Z', capturedTo: '2026-08-03T00:01:00Z', repositoryCopies: [{ repositoryId: repository.id, engineSnapshotId: 'snp-one', state: 'available' }], retention: { deletionEligible: true } });
    const copies = [{ ...point.repositoryCopies[0], state: 'pruned', prunedAt: '2026-08-04T00:00:00Z', manifestDeletion: { confirmed: true, absent: false } }];
    const projected = transaction.projectRecoveryPointRepositoryCopies(workspaceId, point.id, copies, { expectedRevision: point.revision, actorId: 'prune-worker' });
    return { point, projected };
  });
  assert.equal(records.projected.repositoryCopies[0].state, 'pruned');
  assert.equal(records.projected.capturedTo, records.point.capturedTo);
  await assert.rejects(control.transaction((transaction) => transaction.projectRecoveryPointRepositoryCopies(workspaceId, records.point.id, [], { expectedRevision: records.projected.revision })), (error) => error.code === 'BACKUP_CONTROL_PROJECTION_INVALID');
});

test('creates a pre-migration copy and re-applies an idempotent migration', async (context) => {
  const { rootPath, control } = await fixture(context);
  await control.repository('connection').create(connection('local', 'Migrated server'));
  await control.close();

  const databasePath = path.join(rootPath, 'control.db');
  const SQL = await initSqlJs();
  const rawDatabase = new SQL.Database(await fs.readFile(databasePath));
  rawDatabase.run('PRAGMA user_version = 0');
  await fs.writeFile(databasePath, Buffer.from(rawDatabase.export()));
  rawDatabase.close();

  const migrated = new BackupControlDatabase({ rootPath, clock: () => '2026-08-03T12:00:00.000Z' });
  context.after(() => migrated.close());
  await migrated.initialize();
  assert.equal((await migrated.repository('connection').list('local')).length, 1);
  assert.equal((await fs.readdir(rootPath)).filter((name) => name.includes('.pre-migration-v0-')).length, 1);
});

test('refuses a corrupted database without replacing its bytes', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-control-corrupt-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const databasePath = path.join(rootPath, 'control.db');
  const corrupt = Buffer.from('this is not a sqlite database');
  await fs.writeFile(databasePath, corrupt);
  const control = new BackupControlDatabase({ rootPath });
  await assert.rejects(control.initialize(), ControlDatabaseCorruptionError);
  assert.deepEqual(await fs.readFile(databasePath), corrupt);
});
