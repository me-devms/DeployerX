const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { BackupJobService } = require('./backup-job');

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-job-test-'));
  const database = new BackupControlDatabase({ rootPath, clock: () => '2026-08-03T12:00:00.000Z' });
  await database.initialize();
  context.after(async () => { await database.close(); await fs.rm(rootPath, { recursive: true, force: true }); });
  const connection = await database.repository('connection').create({
    workspaceId: 'local', name: 'This computer', kind: 'local', adapterId: 'deployerx.connection.local',
    workerAffinity: ['device:test-device'], lastTest: { status: 'success' }
  });
  const source = await database.repository('source').create({
    workspaceId: 'local', name: 'Application files', connectionId: connection.id, sourceType: 'files',
    adapterId: 'deployerx.files.local', enabled: true,
    selector: { version: 1, kind: 'file-paths', roots: [{ path: 'C:\\app', type: 'directory' }], includePatterns: [], excludePatterns: [], options: {}, metadataPolicy: { preserve: { timestamps: true } }, digest: 'selection-digest' }
  });
  const repository = await database.repository('repository').create({
    workspaceId: 'local', name: 'Archive', adapterId: 'deployerx.repository.local-folder', adapterVersion: '1.0.0',
    engineId: 'deployerx.file-repository', engineVersion: '1.0.0', workerAffinity: ['device:test-device'],
    health: { status: 'ready', lockState: { status: 'available' } }, location: { path: 'C:\\backup' }
  });
  return { database, service: new BackupJobService({ controlDatabase: database, deviceId: 'test-device', clock: () => '2026-08-03T12:00:00.000Z' }), connection, source, repository };
}

test('reports source and repository readiness for the current device', async (context) => {
  const { service, connection, source, repository } = await fixture(context);
  const readiness = await service.readiness('local');
  assert.equal(readiness.sources[0].id, source.id);
  assert.equal(readiness.sources[0].readiness.ready, true);
  assert.equal(readiness.sourceConnections[0].id, connection.id);
  assert.equal(readiness.sourceConnections[0].connectionKind, 'local');
  assert.equal(readiness.sourceConnections[0].currentDevice, true);
  assert.equal(readiness.repositories[0].id, repository.id);
  assert.equal(readiness.repositories[0].readiness.ready, true);
});

test('Oracle true-full Sources reject level-1 jobs but allow archived-redo policies', async (context) => {
  const { database, service, repository } = await fixture(context);
  const oracleConnection = await database.repository('connection').create({
    workspaceId: 'local', name: 'Orders Oracle', kind: 'database', adapterId: 'deployerx.database.oracle.rman', adapterVersion: '0.1.0',
    workerAffinity: ['device:test-device'], lastTest: { status: 'success', endpointIdentity: { databaseFingerprint: 'sha256:oracle', dbid: '1234567890' } }, trust: { mode: 'verify-identity' }
  });
  const sshConnection = await database.repository('connection').create({
    workspaceId: 'local', name: 'Orders Linux', kind: 'ssh', adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0',
    workerAffinity: ['device:test-device'], lastTest: { status: 'success' }, trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
  });
  const source = await database.repository('source').create({
    workspaceId: 'local', name: 'Orders RMAN', connectionId: oracleConnection.id, sourceType: 'database', adapterId: oracleConnection.adapterId, adapterVersion: oracleConnection.adapterVersion, enabled: true,
    selector: { version: 1, kind: 'database-objects', allDatabases: false, databases: { include: [{ name: 'ORDERS_PROD' }], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false, digest: 'oracle-selection' },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', method: 'oracle-rman' },
    physicalExecution: { engine: 'oracle', sshConnectionId: sshConnection.id, anchorMode: 'full' }
  });
  await assert.rejects(service.create('local', 'tester', { name: 'Invalid Oracle differential', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'incremental' }), /level-0 anchors/);
  await assert.rejects(service.create('local', 'tester', { name: 'Invalid Oracle cumulative', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'differential' }), /level-0 anchors/);
  const archivedRedo = await service.create('local', 'tester', { name: 'Oracle archived redo', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'native' });
  assert.equal(archivedRedo.policy.backupMode, 'native');
});

test('reports and snapshots partial database object selection in jobs', async (context) => {
  const { database, service, repository } = await fixture(context);
  const connection = await database.repository('connection').create({
    workspaceId: 'local', name: 'Orders MySQL', kind: 'database', adapterId: 'deployerx.database.mysql.logical', adapterVersion: '1.2.0',
    workerAffinity: ['device:test-device'], lastTest: { status: 'success' }, trust: { fingerprint: 'sha256:server' }
  });
  const selector = {
    version: 1, kind: 'database-objects', allDatabases: false,
    databases: { include: [{ name: 'orders' }], exclude: [] }, schemas: { include: [], exclude: [] },
    tables: { include: [{ database: 'orders', schema: 'orders', name: 'customers' }, { database: 'orders', schema: 'orders', name: 'invoices' }], exclude: [] },
    includeGlobalObjects: false, digest: 'table-selection-digest'
  };
  const source = await database.repository('source').create({
    workspaceId: 'local', name: 'Orders tables', connectionId: connection.id, sourceType: 'database',
    adapterId: connection.adapterId, adapterVersion: connection.adapterVersion, enabled: true, selector,
    consistency: { requestedLevel: 'application', method: 'transaction-snapshot' }
  });

  const readiness = await service.readiness('local');
  const summary = readiness.sources.find((candidate) => candidate.id === source.id);
  assert.equal(summary.objectKind, 'table');
  assert.equal(summary.objectCount, 2);
  assert.deepEqual(summary.selection.tables.include, selector.tables.include);

  const created = await service.create('local', 'tester', {
    name: 'Orders table protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full'
  });
  assert.equal(created.job.selection.digest, 'table-selection-digest');
  assert.deepEqual(created.job.selection.tables.include, selector.tables.include);
});

test('atomically creates a manual policy and enabled backup job', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  const created = await service.create('local', 'tester', {
    name: 'Application protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'incremental',
    keepLast: 14, compression: 'fast', verifyAfterBackup: true
  });
  assert.equal(created.job.state, 'enabled');
  assert.equal(created.job.selection.digest, 'selection-digest');
  assert.equal(created.job.repositoryBindings[0].role, 'primary');
  assert.equal(created.policy.schedule.type, 'manual');
  assert.equal(created.job.nextRunAt, null);
  assert.equal(created.policy.retention.keepLast, 14);
  assert.equal((await database.repository('backupJob').list('local')).length, 1);
  assert.equal((await database.repository('policy').list('local')).length, 1);
  const listed = await service.list('local');
  assert.equal(listed[0].source.name, 'Application files');
  assert.equal(listed[0].repositories[0].repository.name, 'Archive');
  assert.equal(listed[0].ready, true);
});

test('persists recovery objectives and enabled notification route assignments', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  const route = await database.repository('notificationRoute').create({
    workspaceId: 'local', name: 'Operations desktop', type: 'desktop', enabled: true,
    events: ['backup.failed', 'backup.rpo-overdue'], config: { silent: false }, secretRefIds: [], deliveryHistory: []
  });
  const created = await service.create('local', 'tester', {
    name: 'Objective monitored', sourceId: source.id, repositoryIds: [repository.id], rpoMinutes: 60, rtoMinutes: 30, notificationRouteIds: [route.id]
  });
  assert.equal(created.policy.objectives.rpoMinutes, 60);
  assert.equal(created.policy.objectives.rtoMinutes, 30);
  assert.deepEqual(created.policy.notificationRouteIds, [route.id]);
});

test('rejects invalid objectives and unavailable notification routes before policy creation', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  await assert.rejects(service.create('local', 'tester', {
    name: 'Invalid RPO', sourceId: source.id, repositoryIds: [repository.id], rpoMinutes: 0
  }), /RPO target/);
  await assert.rejects(service.create('local', 'tester', {
    name: 'Invalid RTO', sourceId: source.id, repositoryIds: [repository.id], rtoMinutes: 525601
  }), /RTO target/);
  await assert.rejects(service.create('local', 'tester', {
    name: 'Missing route', sourceId: source.id, repositoryIds: [repository.id], notificationRouteIds: ['notification-route-missing']
  }), /notification route was not found/);
  const disabled = await database.repository('notificationRoute').create({
    workspaceId: 'local', name: 'Disabled route', type: 'desktop', enabled: false,
    events: ['backup.failed'], config: { silent: false }, secretRefIds: [], deliveryHistory: []
  });
  await assert.rejects(service.create('local', 'tester', {
    name: 'Disabled route job', sourceId: source.id, repositoryIds: [repository.id], notificationRouteIds: [disabled.id]
  }), /Disabled notification routes/);
  assert.equal((await database.repository('policy').list('local')).length, 0);
});

test('pauses and resumes with optimistic revisions while preserving schedule state', async (context) => {
  const { service, source, repository } = await fixture(context);
  const created = await service.create('local', 'tester', {
    name: 'Lifecycle job', sourceId: source.id, repositoryIds: [repository.id],
    schedule: { type: 'daily', time: '14:00' }
  });
  const paused = await service.pause('local', 'operator', created.job.id, created.job.revision);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.nextRunAt, created.job.nextRunAt);
  assert.equal(paused.lifecycle.pausedBy, 'operator');
  await assert.rejects(service.resume('local', 'operator', paused.id, created.job.revision), /changed/);
  const resumed = await service.resume('local', 'operator', paused.id, paused.revision);
  assert.equal(resumed.state, 'enabled');
  assert.equal(resumed.nextRunAt, created.job.nextRunAt);
  assert.equal(resumed.lifecycle.resumedBy, 'operator');
});

test('requires an idle disabled job before soft deletion and preserves run history', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  const created = await service.create('local', 'tester', { name: 'Disposable job', sourceId: source.id, repositoryIds: [repository.id] });
  const execution = await database.transaction((transaction) => {
    const group = transaction.create('executionGroup', {
      workspaceId: 'local', actorId: 'tester', jobId: created.job.id, jobRevision: created.job.revision,
      trigger: 'manual', scheduledFor: null, idempotencyKey: 'lifecycle-active', state: 'pending', latestRunId: null, terminalRunId: null
    });
    const run = transaction.create('run', {
      workspaceId: 'local', actorId: 'tester', jobId: created.job.id, jobRevision: created.job.revision,
      executionGroupId: group.id, scheduledFor: null, idempotencyKey: 'lifecycle-active:attempt:1', trigger: 'manual',
      workerId: 'device:test-device', state: 'queued', attempt: 1, parentRunId: null, configSnapshot: {}, progress: {}, lease: null, startedAt: null, finishedAt: null, result: null
    });
    const projectedGroup = transaction.projectExecution('executionGroup', 'local', group.id, { latestRunId: run.id }, { expectedRevision: group.revision, actorId: 'tester' });
    return { group: projectedGroup, run };
  });
  await assert.rejects(service.disable('local', 'operator', created.job.id, created.job.revision), /active backup/);
  await database.transaction((transaction) => {
    transaction.projectExecution('run', 'local', execution.run.id, { state: 'canceled', finishedAt: '2026-08-03T12:00:00.000Z' }, { expectedRevision: execution.run.revision, actorId: 'operator' });
    transaction.projectExecution('executionGroup', 'local', execution.group.id, { state: 'canceled', terminalRunId: execution.run.id }, { expectedRevision: execution.group.revision, actorId: 'operator' });
  });
  await assert.rejects(service.delete('local', 'operator', created.job.id, created.job.revision), /Disable/);
  const disabled = await service.disable('local', 'operator', created.job.id, created.job.revision);
  const deleted = await service.delete('local', 'operator', disabled.id, disabled.revision);
  assert.deepEqual(deleted, { id: created.job.id, policyId: created.policy.id, deleted: true, policyDeleted: true });
  assert.equal((await database.repository('backupJob').list('local')).length, 0);
  assert.equal((await database.repository('policy').list('local')).length, 0);
  assert.equal((await database.repository('run').list('local')).length, 1);
  assert.ok(await database.repository('backupJob').get('local', created.job.id, { includeDeleted: true }));
});

test('clones current configuration into fresh job and policy identities', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  const created = await service.create('local', 'tester', {
    name: 'Primary protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full',
    compression: 'maximum', rpoMinutes: 90, rtoMinutes: 45, retention: { keepLast: 9 }
  });
  const cloned = await service.clone('local', 'operator', created.job.id, created.job.revision);
  assert.equal(cloned.job.name, 'Primary protection copy');
  assert.notEqual(cloned.job.id, created.job.id);
  assert.notEqual(cloned.policy.id, created.policy.id);
  assert.equal(cloned.job.state, 'enabled');
  assert.equal(cloned.job.lastSuccessfulRunId, null);
  assert.equal(cloned.policy.backupMode, 'full');
  assert.equal(cloned.policy.performance.compression, 'maximum');
  assert.deepEqual(cloned.policy.objectives, { rpoMinutes: 90, rtoMinutes: 45 });
  assert.equal(cloned.policy.retention.keepLast, 9);
  const second = await service.clone('local', 'operator', created.job.id, created.job.revision);
  assert.equal(second.job.name, 'Primary protection copy 2');
  await assert.rejects(service.clone('local', 'operator', created.job.id, created.job.revision + 1), /changed/);
  assert.equal((await database.repository('backupJob').list('local')).length, 3);
});

test('normalizes supported recurring schedules and calculates the first occurrence', async (context) => {
  const { service, source, repository } = await fixture(context);
  const cases = [
    [{ type: 'interval', intervalMinutes: 30 }, '2026-08-03T12:30:00.000Z'],
    [{ type: 'cron', expression: '15 13 * * 1-5' }, '2026-08-03T13:15:00.000Z'],
    [{ type: 'hourly', minute: 45 }, '2026-08-03T12:45:00.000Z'],
    [{ type: 'daily', time: '02:30' }, '2026-08-04T02:30:00.000Z'],
    [{ type: 'weekly', daysOfWeek: [1, 5], time: '18:00' }, '2026-08-03T18:00:00.000Z'],
    [{ type: 'monthly', dayOfMonth: 15, time: '04:00' }, '2026-08-15T04:00:00.000Z']
  ];
  for (const [schedule, expected] of cases) {
    const created = await service.create('local', 'tester', {
      name: `Schedule ${schedule.type}`, sourceId: source.id, repositoryIds: [repository.id], schedule
    });
    assert.equal(created.policy.schedule.type, schedule.type);
    assert.equal(created.policy.schedule.timezone, 'UTC');
    assert.equal(created.job.nextRunAt, expected);
  }
});

test('rejects invalid schedule input before creating policy records', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  await assert.rejects(service.create('local', 'tester', {
    name: 'Invalid cron', sourceId: source.id, repositoryIds: [repository.id], schedule: { type: 'cron', expression: '80 * * * *' }
  }), /five-field/);
  assert.equal((await database.repository('backupJob').list('local')).length, 0);
  assert.equal((await database.repository('policy').list('local')).length, 0);
});

test('persists timezone, DST, missed-run, maintenance, and blackout policy atomically', async (context) => {
  const { service, source, repository } = await fixture(context);
  const created = await service.create('local', 'tester', {
    name: 'Calendar policy', sourceId: source.id, repositoryIds: [repository.id],
    schedule: {
      type: 'daily', time: '02:30', timezone: 'America/New_York',
      dstBehavior: { nonexistentTime: 'skip', ambiguousTime: 'second' },
      missedRun: { behavior: 'run-latest', graceMinutes: 20 },
      executionCalendar: {
        maintenanceWindows: [{ daysOfWeek: [1, 2, 3, 4, 5], startTime: '22:00', endTime: '04:00' }],
        outsideMaintenanceBehavior: 'defer',
        blackouts: [{ startsAt: '2026-12-24T00:00:00Z', endsAt: '2026-12-26T00:00:00Z' }],
        blackoutBehavior: 'skip'
      }
    }
  });
  assert.equal(created.policy.schedule.timezone, 'America/New_York');
  assert.equal(created.policy.schedule.dstBehavior.ambiguousTime, 'second');
  assert.equal(created.policy.schedule.missedRun.graceMinutes, 20);
  assert.equal(created.policy.schedule.executionCalendar.maintenanceWindows[0].crossesMidnight, true);
  assert.equal(created.policy.schedule.executionCalendar.blackouts.length, 1);
  assert.equal(created.job.nextRunAt, '2026-08-04T06:30:00.000Z');
});

test('normalizes retry, priority, and scheduled bandwidth policy atomically', async (context) => {
  const { service, source, repository } = await fixture(context);
  const created = await service.create('local', 'tester', {
    name: 'Controlled transfer', sourceId: source.id, repositoryIds: [repository.id],
    schedule: { type: 'daily', time: '01:00', timezone: 'Asia/Kolkata' },
    priority: 'critical',
    retry: { maximumAttempts: 5, backoff: 'linear', initialDelaySeconds: 45, maximumDelaySeconds: 600, jitterPercent: 10, retryableCategories: ['timeout', 'connectivity'] },
    bandwidth: {
      timezone: 'Asia/Kolkata', defaultLimitBytesPerSecond: 1048576,
      windows: [{ daysOfWeek: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '18:00', limitBytesPerSecond: 262144 }]
    }
  });
  assert.equal(created.policy.performance.priority, 'critical');
  assert.equal(created.policy.performance.bandwidthLimitBytesPerSecond, 1048576);
  assert.equal(created.policy.performance.bandwidth.timezone, 'Asia/Kolkata');
  assert.equal(created.policy.performance.bandwidth.windows[0].limitBytesPerSecond, 262144);
  assert.deepEqual(created.policy.retry, {
    maximumAttempts: 5, backoff: 'linear', initialDelaySeconds: 45, maximumDelaySeconds: 600,
    jitterPercent: 10, retryableCategories: ['connectivity', 'timeout']
  });
});

test('rejects invalid execution policy before creating policy records', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  await assert.rejects(service.create('local', 'tester', {
    name: 'Invalid execution policy', sourceId: source.id, repositoryIds: [repository.id],
    retry: { maximumAttempts: 11 }
  }), /Maximum retry attempts/);
  assert.equal((await database.repository('backupJob').list('local')).length, 0);
  assert.equal((await database.repository('policy').list('local')).length, 0);
});

test('normalizes GFS retention in the schedule timezone', async (context) => {
  const { service, source, repository } = await fixture(context);
  const created = await service.create('local', 'tester', {
    name: 'GFS protection', sourceId: source.id, repositoryIds: [repository.id],
    schedule: { type: 'daily', time: '02:00', timezone: 'Asia/Kolkata' },
    retention: { keepLast: 8, hourly: 24, daily: 14, weekly: 8, monthly: 12, yearly: 7 }
  });
  assert.deepEqual(created.policy.retention, {
    version: 1, timezone: 'Asia/Kolkata', keepLast: 8, hourly: 24, daily: 14, weekly: 8, monthly: 12, yearly: 7, legalHold: false
  });
});

test('rejects invalid retention before creating policy records', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  await assert.rejects(service.create('local', 'tester', {
    name: 'Invalid retention', sourceId: source.id, repositoryIds: [repository.id], retention: { keepLast: 1, monthly: 10001 }
  }), /Monthly recovery points/);
  assert.equal((await database.repository('backupJob').list('local')).length, 0);
  assert.equal((await database.repository('policy').list('local')).length, 0);
});

test('rejects unavailable resources without leaving an orphan policy', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  await database.repository('repository').update('local', repository.id, { health: { status: 'needs-attention', lockState: { status: 'unavailable' } } }, { expectedRevision: repository.revision });
  await assert.rejects(service.create('local', 'tester', { name: 'Unsafe job', sourceId: source.id, repositoryIds: [repository.id] }), /Test the repository successfully/);
  assert.equal((await database.repository('backupJob').list('local')).length, 0);
  assert.equal((await database.repository('policy').list('local')).length, 0);
});

test('rejects duplicate job names and cross-workspace identifiers', async (context) => {
  const { database, service, source, repository } = await fixture(context);
  await service.create('local', 'tester', { name: 'Files', sourceId: source.id, repositoryIds: [repository.id] });
  await assert.rejects(service.create('local', 'tester', { name: 'files', sourceId: source.id, repositoryIds: [repository.id] }), /already exists/);
  const otherConnection = await database.repository('connection').create({ workspaceId: 'other', name: 'Other', kind: 'local', adapterId: 'deployerx.connection.local', workerAffinity: ['device:test-device'], lastTest: { status: 'success' } });
  const otherSource = await database.repository('source').create({ workspaceId: 'other', name: 'Other source', connectionId: otherConnection.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true });
  await assert.rejects(service.create('local', 'tester', { name: 'Cross tenant', sourceId: otherSource.id, repositoryIds: [repository.id] }), /not found in this workspace/);
});
