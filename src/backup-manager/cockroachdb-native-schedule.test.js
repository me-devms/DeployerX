const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CockroachDbNativeScheduleController,
  auditSchedulePlanProjection,
  auditScheduleProjection,
  buildCreateScheduleStatement,
  defaultFullCadence,
  normalizeNativeSchedulePolicy,
  publicSchedulePlan
} = require('./cockroachdb-native-schedule');

const NOW = '2026-08-05T12:00:00.000Z';
const CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const FP_DEPLOYMENT = `sha256:${'a'.repeat(64)}`;
const FP_TOPOLOGY = `sha256:${'b'.repeat(64)}`;
const FP_INVENTORY = `sha256:${'c'.repeat(64)}`;
const FULL_ID = '900000000000000001';
const INCREMENTAL_ID = '900000000000000002';
const CONNECTION = Object.freeze({
  executionMode: 'local',
  authMode: 'password',
  host: 'roach.private.example',
  port: 26257,
  username: 'private_schedule_user',
  database: 'defaultdb',
  passwordSecretRefId: 'sec_private_password',
  sqlPath: 'C:\\private\\cockroach.exe'
});

function tsv(headers, rows = []) {
  return [headers.join('\t'), ...rows.map((row) => row.map((value) => String(value)).join('\t'))].join('\n') + '\n';
}

function request(policy = {}) {
  return {
    connection: CONNECTION,
    binding: {
      clusterId: CLUSTER_ID,
      deploymentFingerprint: FP_DEPLOYMENT,
      topologyFingerprint: FP_TOPOLOGY,
      inventoryFingerprint: FP_INVENTORY,
      connectionRevision: 7
    },
    sourceId: 'source-cockroach-schedule',
    selection: { scope: 'database', database: 'app' },
    destination: { type: 'external-connection', externalConnectionName: 'private_backup_archive' },
    policy: {
      mode: 'full-incremental',
      recurringCron: '0 * * * *',
      fullCron: '0 0 * * *',
      revisionHistory: true,
      onPreviousRunning: 'skip',
      onExecutionFailure: 'pause',
      firstRun: 'now',
      ...policy
    }
  };
}

function discovery(overrides = {}) {
  return {
    clusterId: CLUSTER_ID,
    deploymentFingerprint: FP_DEPLOYMENT,
    topologyFingerprint: FP_TOPOLOGY,
    inventoryFingerprint: FP_INVENTORY,
    currentUser: 'private_schedule_user',
    capabilities: { backupIntoSyntax: true, externalConnectionsVisible: true },
    privileges: { visible: true, system: { BACKUP: true, CONTROLJOB: true } },
    externalConnections: [{ name: 'private_backup_archive' }],
    ...overrides
  };
}

function fixture(options = {}) {
  const calls = [];
  const events = [];
  const scheduleStates = new Map([[FULL_ID, 'ACTIVE'], [INCREMENTAL_ID, 'PAUSED']]);
  let label = null;
  const runSql = async (_context, _connection, sql) => {
    calls.push(sql);
    if (sql.startsWith('SELECT has_database_privilege')) return { stdout: tsv(['allowed'], [[true]]) };
    if (sql.startsWith('CHECK EXTERNAL CONNECTION')) return { stdout: '' };
    if (sql === 'SELECT count(*)::STRING AS visible_schedule_count FROM [SHOW SCHEDULES FOR BACKUP]') return { stdout: tsv(['visible_schedule_count'], [[2]]) };
    if (sql.startsWith('CREATE SCHEDULE')) {
      events.push('submitted');
      label = /CREATE SCHEDULE "([^"]+)"/.exec(sql)?.[1];
      if (options.createRows) return { stdout: options.createRows(label) };
      return { stdout: tsv(
        ['schedule_id', 'name', 'status', 'first_run', 'schedule', 'backup_stmt'],
        [
          [INCREMENTAL_ID, label, 'PAUSED: Waiting for initial backup to complete', '', '0 * * * *', "BACKUP DATABASE app INTO LATEST IN 'external://private_backup_archive' WITH revision_history, detached"],
          [FULL_ID, label, 'ACTIVE', NOW, '0 0 * * *', "BACKUP DATABASE app INTO 'external://private_backup_archive' WITH revision_history, detached"]
        ]
      ) };
    }
    if (sql.startsWith('WITH schedules AS (SHOW SCHEDULES FOR BACKUP)')) {
      if (options.reconcileRows) return { stdout: options.reconcileRows(label) };
      return { stdout: tsv(
        ['schedule_id', 'label', 'schedule_status', 'next_run', 'recurrence', 'jobs_running', 'owner', 'created', 'on_previous_running', 'on_execution_failure', 'backup_type'],
        [
          [FULL_ID, label, scheduleStates.get(FULL_ID), '2026-08-06T00:00:00.000Z', '0 0 * * *', 0, 'private_schedule_user', NOW, 'skip', 'PAUSE_SCHED', 'FULL'],
          [INCREMENTAL_ID, label, scheduleStates.get(INCREMENTAL_ID), '', '0 * * * *', 0, 'private_schedule_user', NOW, 'wait', 'PAUSE_SCHED', 'INCREMENTAL']
        ]
      ) };
    }
    const control = /^(PAUSE|RESUME) SCHEDULE ([1-9][0-9]*)$/.exec(sql);
    if (control) {
      scheduleStates.set(control[2], control[1] === 'PAUSE' ? 'PAUSED' : 'ACTIVE');
      return { stdout: '' };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const controller = new CockroachDbNativeScheduleController({
    clock: () => NOW,
    labelToken: () => '0123456789abcdef01234567',
    discover: async () => discovery(options.discovery),
    runSql
  });
  const context = {
    assertNoOwnership: async () => { events.push('checked-empty'); return options.hasOwnership !== true; },
    onSubmissionPrepared: async () => { events.push('reserved'); },
    onOwnership: async () => { events.push('owned'); }
  };
  return { controller, context, calls, events, getLabel: () => label };
}

test('normalizes five-field UTC policy, resolves CockroachDB full cadence, and binds compaction limits', () => {
  assert.equal(defaultFullCadence('*/15 * * * *'), '0 0 * * *');
  assert.equal(defaultFullCadence('0 2 * * *'), '0 0 * * 0');
  assert.equal(defaultFullCadence('0 2 * * 1'), 'always');
  const policy = normalizeNativeSchedulePolicy({ mode: 'full-incremental', recurringCron: '0 * * * *' });
  assert.equal(policy.timezone, 'UTC');
  assert.equal(policy.fullCron, '0 0 * * *');
  assert.equal(policy.onPreviousRunning.incremental, 'wait');
  assert.equal(policy.chainLimit.maximumIncrementals, 48);
  assert.throws(() => normalizeNativeSchedulePolicy({ mode: 'full-incremental', recurringCron: '@hourly' }), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_CRON_INVALID');
  assert.throws(() => normalizeNativeSchedulePolicy({ mode: 'full-incremental', recurringCron: '* * * * *', fullCron: '0 0 * * *' }), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_CADENCE_INVALID');
  assert.throws(() => normalizeNativeSchedulePolicy({ mode: 'full-incremental', recurringCron: '*/15 * * * *', fullCron: '0 0 * * *' }), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_CHAIN_LIMIT');
  assert.throws(() => normalizeNativeSchedulePolicy({ mode: 'full-incremental', recurringCron: '0 0 * * 1' }), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_FULL_CADENCE_REQUIRED');
  assert.throws(() => normalizeNativeSchedulePolicy({ mode: 'full-incremental', recurringCron: '0 * * * *', fullCron: '*/15 * * * *' }), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_CADENCE_INVALID');
  assert.throws(() => normalizeNativeSchedulePolicy({ mode: 'full-only', recurringCron: '0 0 * * *', chainLimit: { compactionEnabled: true, maximumIncrementals: 400 } }), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_COMPACTION_UNPROVEN');
  const compacted = normalizeNativeSchedulePolicy({
    mode: 'full-incremental', recurringCron: '*/15 * * * *', fullCron: '0 0 * * *',
    chainLimit: { compactionEnabled: true, maximumIncrementals: 400, settingFingerprint: `sha256:${'d'.repeat(64)}` }
  });
  assert.equal(compacted.chainLimit.maximumIncrementals, 400);
});

test('creates and durably owns exact full/incremental IDs before reconciling them', async () => {
  const current = fixture();
  const plan = await current.controller.plan({}, request());
  assert.equal(plan.statement, buildCreateScheduleStatement(plan.request, plan.label));
  assert.match(plan.statement, /RECURRING '0 \* \* \* \*' FULL BACKUP '0 0 \* \* \*'/);
  assert.match(plan.statement, /on_previous_running = 'skip'/);
  assert.match(plan.statement, /on_execution_failure = 'pause'/);
  assert.match(plan.statement, /first_run = 'now'/);
  const result = await current.controller.create(current.context, plan);
  assert.deepEqual(current.events, ['checked-empty', 'reserved', 'submitted', 'owned']);
  assert.equal(result.ownership.scheduleIds.full, FULL_ID);
  assert.equal(result.ownership.scheduleIds.incremental, INCREMENTAL_ID);
  assert.equal(result.schedules.length, 2);
  assert.equal(result.public.state, 'active');
  assert.equal(result.public.recreateAllowed, false);
  assert.deepEqual(result.public.schedules.map((item) => item.role), ['full', 'incremental']);
  const reconcileSql = current.calls.find((sql) => sql.startsWith('WITH schedules AS'));
  assert.match(reconcileSql, new RegExp(`id IN \\(${FULL_ID}, ${INCREMENTAL_ID}\\)`));
  assert.equal(/command|state::string/i.test(reconcileSql), false);
});

test('public and audit schedule projections redact native IDs, labels, users, connections, URIs, credentials, and paths', async () => {
  const current = fixture();
  const privatePlan = await current.controller.plan({}, request());
  const plan = publicSchedulePlan(privatePlan);
  const planAudit = auditSchedulePlanProjection('planned', privatePlan);
  const result = await current.controller.create(current.context, privatePlan);
  const audit = auditScheduleProjection('created', result.public);
  const projected = JSON.stringify({ plan, planAudit, public: result.public, audit });
  for (const secret of [
    FULL_ID, INCREMENTAL_ID, current.getLabel(), 'private_schedule_user', 'private_backup_archive',
    'external://', 'sec_private_password', 'roach.private.example', 'C:\\private\\cockroach.exe'
  ]) assert.equal(projected.includes(secret), false, `projection leaked ${secret}`);
  assert.equal(result.public.policy.timezone, 'UTC');
  assert.equal(plan.selection.scope, 'database');
  assert.equal(plan.destination.bindingCount, 1);
  assert.equal(audit.scheduleCount, 2);
});

test('pauses incremental before full and resumes full before incremental using only persisted IDs', async () => {
  const current = fixture();
  const created = await current.controller.create(current.context, await current.controller.plan({}, request()));
  current.calls.length = 0;
  const paused = await current.controller.pause({}, { connection: CONNECTION, ownership: created.ownership });
  assert.deepEqual(current.calls.filter((sql) => sql.startsWith('PAUSE SCHEDULE')), [
    `PAUSE SCHEDULE ${INCREMENTAL_ID}`,
    `PAUSE SCHEDULE ${FULL_ID}`
  ]);
  assert.equal(paused.public.schedules.every((schedule) => schedule.status === 'paused'), true);
  current.calls.length = 0;
  const resumed = await current.controller.resume({}, { connection: CONNECTION, ownership: created.ownership });
  assert.deepEqual(current.calls.filter((sql) => sql.startsWith('RESUME SCHEDULE')), [
    `RESUME SCHEDULE ${FULL_ID}`,
    `RESUME SCHEDULE ${INCREMENTAL_ID}`
  ]);
  assert.equal(resumed.public.schedules.every((schedule) => schedule.status === 'active'), true);
});

test('missing exact owned schedules reconcile as missing and never authorize duplicate recreation', async () => {
  const current = fixture();
  const created = await current.controller.create(current.context, await current.controller.plan({}, request()));
  const missing = fixture({ reconcileRows: () => tsv(
    ['schedule_id', 'label', 'schedule_status', 'next_run', 'recurrence', 'jobs_running', 'owner', 'created', 'on_previous_running', 'on_execution_failure', 'backup_type'],
    []
  ) });
  const reconciled = await missing.controller.reconcile({}, { connection: CONNECTION, ownership: created.ownership });
  assert.equal(reconciled.complete, false);
  assert.equal(reconciled.public.state, 'missing');
  assert.equal(reconciled.public.recreateAllowed, false);
  assert.equal(missing.calls.some((sql) => sql.startsWith('CREATE SCHEDULE')), false);
});

test('fails closed for existing ownership, ambiguous creation, and changed native owner/policy evidence', async () => {
  const duplicate = fixture({ hasOwnership: true });
  await assert.rejects(duplicate.controller.create(duplicate.context, await duplicate.controller.plan({}, request())), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_ALREADY_OWNED');
  assert.equal(duplicate.calls.some((sql) => sql.startsWith('CREATE SCHEDULE')), false);

  const ambiguous = fixture({ createRows: (label) => tsv(
    ['schedule_id', 'name', 'status', 'first_run', 'schedule', 'backup_stmt'],
    [[FULL_ID, label, 'ACTIVE', NOW, '0 0 * * *', "BACKUP DATABASE app INTO 'external://private_backup_archive'"]]
  ) });
  await assert.rejects(ambiguous.controller.create(ambiguous.context, await ambiguous.controller.plan({}, request())), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_CREATE_AMBIGUOUS');
  assert.deepEqual(ambiguous.events, ['checked-empty', 'reserved', 'submitted']);

  const original = fixture();
  const created = await original.controller.create(original.context, await original.controller.plan({}, request()));
  const changed = fixture({ reconcileRows: (label) => tsv(
    ['schedule_id', 'label', 'schedule_status', 'next_run', 'recurrence', 'jobs_running', 'owner', 'created', 'on_previous_running', 'on_execution_failure', 'backup_type'],
    [
      [FULL_ID, label, 'ACTIVE', NOW, '0 0 * * *', 0, 'different_user', NOW, 'skip', 'PAUSE_SCHED', 'FULL'],
      [INCREMENTAL_ID, label, 'ACTIVE', NOW, '0 * * * *', 0, 'private_schedule_user', NOW, 'start', 'PAUSE_SCHED', 'INCREMENTAL']
    ]
  ) });
  await assert.rejects(changed.controller.reconcile({}, { connection: CONNECTION, ownership: created.ownership }), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_OWNERSHIP_CHANGED');
});

test('full-only schedules own one full ID and expose every-run full cadence', async () => {
  const fullOnly = fixture({
    createRows: (label) => tsv(
      ['schedule_id', 'name', 'status', 'first_run', 'schedule', 'backup_stmt'],
      [[FULL_ID, label, 'ACTIVE', NOW, '0 3 * * *', "BACKUP DATABASE app INTO 'external://private_backup_archive'"]]
    ),
    reconcileRows: (label) => tsv(
      ['schedule_id', 'label', 'schedule_status', 'next_run', 'recurrence', 'jobs_running', 'owner', 'created', 'on_previous_running', 'on_execution_failure', 'backup_type'],
      [[FULL_ID, label, 'ACTIVE', '2026-08-06T03:00:00.000Z', '0 3 * * *', 0, 'private_schedule_user', NOW, 'wait', 'RETRY_SCHED', 'FULL']]
    )
  });
  const plan = await fullOnly.controller.plan({}, request({
    mode: 'full-only', recurringCron: '0 3 * * *', fullCron: undefined,
    onPreviousRunning: 'wait', onExecutionFailure: 'reschedule', firstRun: 'next'
  }));
  assert.match(plan.statement, /FULL BACKUP ALWAYS/);
  const result = await fullOnly.controller.create(fullOnly.context, plan);
  assert.equal(result.ownership.scheduleIds.incremental, null);
  assert.equal(result.public.policy.resolvedFullCadence, '0 3 * * *');
  assert.equal(result.public.schedules.length, 1);
});
