const assert = require('node:assert/strict');
const test = require('node:test');
const { QUERIES, readDiscovery } = require('./cockroachdb');
const { normalizeDestination, normalizeSelection } = require('./cockroachdb-native');
const {
  RESTORE_CONFIRMATION,
  CockroachDbNativeRestoreController,
  buildRestoreStatement,
  normalizeRestoreRequest,
  sealRecoveryEvidence
} = require('./cockroachdb-restore');

const CLOCK = '2026-08-05T12:00:00.000Z';
const JOB_ID = '900000000000000101';
const TARGET_CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_CLUSTER_ID = '22222222-2222-4222-8222-222222222222';
const CONNECTION = Object.freeze({
  executionMode: 'local',
  authMode: 'password',
  host: 'target.example.com',
  port: 26257,
  username: 'restore_user',
  database: 'defaultdb',
  passwordSecretRefId: 'sec_cockroach_restore',
  sqlPath: 'cockroach'
});
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const DIGEST_D = `sha256:${'d'.repeat(64)}`;

function tsv(headers, rows = []) {
  return [headers.join('\t'), ...rows.map((row) => row.map((value) => String(value)).join('\t'))].join('\n') + '\n';
}

function restoreJobOutput(status = 'succeeded') {
  const terminal = ['succeeded', 'failed', 'canceled', 'revert-failed'].includes(status);
  return tsv(
    ['job_id', 'job_type', 'user_name', 'status', 'created', 'started', 'finished', 'modified', 'fraction_completed', 'coordinator_id', 'has_error'],
    [[
      JOB_ID,
      'RESTORE',
      'restore_user',
      status,
      '2026-08-05T12:00:01.000Z',
      '2026-08-05T12:00:02.000Z',
      terminal ? '2026-08-05T12:00:30.000Z' : '',
      '2026-08-05T12:00:30.000Z',
      status === 'succeeded' ? 1 : 0.5,
      1,
      status === 'failed' || status === 'revert-failed'
    ]]
  );
}

function createRunner(options = {}) {
  const calls = [];
  const events = [];
  let jobRead = 0;
  let restored = false;
  const jobStatuses = options.jobStatuses || ['succeeded'];
  const runNativeCommand = async (request) => {
    const query = request.args.at(-1);
    calls.push(query);
    if (query === QUERIES.identity) return { stdout: tsv(
      ['version', 'cluster_id', 'node_id', 'current_user', 'current_database'],
      [[`CockroachDB CCL v${options.targetVersion || '25.2.3'} (linux)`, options.clusterId || TARGET_CLUSTER_ID, 1, options.currentUser || 'restore_user', 'defaultdb']]
    ), stderr: '', exitCode: 0 };
    if (query === QUERIES.clusterVersion) return { stdout: tsv(['version'], [[options.targetClusterVersion || (options.targetVersion || '25.2.3').split('.').slice(0, 2).join('.')]]), stderr: '', exitCode: 0 };
    if (query === QUERIES.nodes) return { stdout: tsv(
      ['node_id', 'address', 'sql_address', 'build_tag', 'started_at', 'locality', 'is_available', 'is_live'],
      [[1, 'target-a:26257', 'target-a:26257', `v${options.targetVersion || '25.2.3'}`, '2026-08-05T01:00:00.000Z', options.locality || 'region=us-east1,zone=a', true, true]]
    ), stderr: '', exitCode: 0 };
    if (query === QUERIES.databases) return { stdout: tsv(
      ['database_name', 'owner'],
      options.databases || (restored ? [['app_restored', 'restore_user'], ['defaultdb', 'root'], ['system', 'node']] : [['defaultdb', 'root'], ['system', 'node']])
    ), stderr: '', exitCode: 0 };
    if (query === QUERIES.systemPrivileges) return { stdout: tsv(
      ['backup', 'restore', 'viewjob', 'controljob', 'externalioimplicitaccess'],
      [[true, options.restorePrivilege !== false, true, true, false]]
    ), stderr: '', exitCode: 0 };
    if (query === QUERIES.jobs) return { stdout: tsv(['visible_job_count'], [[1]]), stderr: '', exitCode: 0 };
    if (query === QUERIES.externalConnections) return { stdout: tsv(['connection_name', 'owner'], [['backup_archive', 'restore_user']]), stderr: '', exitCode: 0 };
    if (query.startsWith('CHECK EXTERNAL CONNECTION')) {
      events.push('external-check');
      if (options.providerError) throw new Error(options.providerError);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (query.startsWith('SHOW BACKUP')) {
      events.push('show-backup');
      return { stdout: tsv(['database_name'], [['app']]), stderr: '', exitCode: 0 };
    }
    if (query.startsWith('RESTORE DATABASE')) {
      events.push('restore-submit');
      restored = true;
      return { stdout: tsv(['job_id'], [[JOB_ID]]), stderr: '', exitCode: 0 };
    }
    if (query.startsWith('SELECT job_id::STRING AS job_id')) {
      events.push('job-read');
      const status = jobStatuses[Math.min(jobRead, jobStatuses.length - 1)];
      jobRead += 1;
      return { stdout: restoreJobOutput(status), stderr: '', exitCode: 0 };
    }
    if (query.startsWith('SHOW CREATE DATABASE')) {
      events.push('descriptor-read');
      return { stdout: tsv(['database_name', 'create_statement'], [['app_restored', 'CREATE DATABASE app_restored']]), stderr: '', exitCode: 0 };
    }
    if (query.startsWith('SELECT count(*)::STRING AS invalid_object_count')) {
      events.push('dependency-read');
      return { stdout: tsv(['invalid_object_count'], [[options.invalidObjectCount || 0]]), stderr: '', exitCode: 0 };
    }
    if (/^(PAUSE|RESUME|CANCEL) JOB [1-9][0-9]*$/.test(query)) {
      events.push(query);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected CockroachDB query: ${query}`);
  };
  return { calls, events, runNativeCommand };
}

function recoveryEvidence(overrides = {}) {
  const selection = normalizeSelection({ scope: 'database', database: 'app' });
  const collection = normalizeDestination({ type: 'external-connection', externalConnectionName: 'backup_archive' });
  const revisionHistory = overrides.revisionHistory !== false;
  const backupMode = overrides.backupMode || 'incremental';
  const points = backupMode === 'full'
    ? [{ recoveryPointId: 'rp-full', parentRecoveryPointId: null, type: 'full', asOfTimestamp: '2026-08-05T11:00:00.000Z', verificationState: 'succeeded', retained: true }]
    : [
        { recoveryPointId: 'rp-full', parentRecoveryPointId: null, type: 'full', asOfTimestamp: '2026-08-05T11:00:00.000Z', verificationState: 'succeeded', retained: true },
        { recoveryPointId: 'rp-inc', parentRecoveryPointId: 'rp-full', type: 'incremental', asOfTimestamp: '2026-08-05T11:50:00.000Z', verificationState: 'succeeded', retained: true }
      ];
  return sealRecoveryEvidence({
    version: 1,
    kind: 'cockroachdb-native-backup',
    adapterId: 'deployerx.database.cockroachdb',
    recoveryPointId: points.at(-1).recoveryPointId,
    artifactId: backupMode === 'full' ? 'artifact-full' : 'artifact-inc',
    sourceId: 'source-roach',
    sourceClusterId: SOURCE_CLUSTER_ID,
    sourceVersion: overrides.sourceVersion || '25.2.3',
    sourceClusterVersion: overrides.sourceClusterVersion || '25.2',
    sourceDeploymentFingerprint: DIGEST_A,
    sourceTopologyFingerprint: DIGEST_B,
    selection,
    collection,
    backupMode,
    asOfTimestamp: points.at(-1).asOfTimestamp,
    revisionHistory,
    encryptionMode: 'none',
    consistency: 'application',
    verificationState: 'succeeded',
    deletionEligible: false,
    restoreSupported: true,
    externalNativeMedia: true,
    multiRegion: (overrides.requiredRegions || []).length > 0,
    requiredRegions: overrides.requiredRegions || [],
    dependencyPolicy: 'reject-unresolved',
    manifestDigest: DIGEST_C,
    artifactDigest: DIGEST_D,
    chain: { version: 1, complete: true, points, revisionStartTimestamp: revisionHistory ? points[0].asOfTimestamp : null }
  });
}

async function restoreRequest(runner, overrides = {}) {
  const discovery = await readDiscovery({ runNativeCommand: runner.runNativeCommand }, CONNECTION);
  return {
    connection: CONNECTION,
    targetBinding: {
      clusterId: discovery.clusterId,
      deploymentFingerprint: discovery.deploymentFingerprint,
      topologyFingerprint: discovery.topologyFingerprint,
      inventoryFingerprint: discovery.inventoryFingerprint,
      connectionRevision: 7
    },
    recovery: overrides.recovery || recoveryEvidence(),
    targetDatabase: 'app_restored',
    restoreTimestamp: '2026-08-05T11:25:00.000Z',
    mode: 'alternate',
    confirmed: true,
    confirmationText: RESTORE_CONFIRMATION,
    execution: { workspaceId: 'ws-1', restoreRunId: 'restore-run-1', connectionRevision: 7 },
    ...overrides
  };
}

function controller() {
  return new CockroachDbNativeRestoreController({ clock: () => CLOCK, now: () => Date.parse(CLOCK), delay: async () => {}, pollIntervalMs: 100, maximumWaitMs: 1000 });
}

test('builds exact alternate-database SQL and admits arbitrary revision-history timestamps only inside the authenticated range', async () => {
  const runner = createRunner();
  const request = await restoreRequest(runner);
  const normalized = normalizeRestoreRequest(request);
  assert.equal(
    buildRestoreStatement(normalized),
    "RESTORE DATABASE \"app\" FROM LATEST IN 'external://backup_archive' AS OF SYSTEM TIME '2026-08-05T11:25:00.000Z' WITH new_db_name = 'app_restored', detached"
  );
  assert.throws(
    () => normalizeRestoreRequest({ ...request, restoreTimestamp: '2026-08-05T10:59:59.999Z' }),
    (error) => error.code === 'COCKROACH_RESTORE_TIMESTAMP_UNAVAILABLE'
  );
  const boundaryOnly = recoveryEvidence({ revisionHistory: false });
  assert.throws(
    () => normalizeRestoreRequest({ ...request, recovery: boundaryOnly, restoreTimestamp: '2026-08-05T11:25:00.000Z' }),
    (error) => error.code === 'COCKROACH_RESTORE_TIMESTAMP_UNAVAILABLE'
  );
});

test('rejects older, more-than-next-major, missing-region, and existing alternate targets before submission', async () => {
  const cases = [
    { runner: createRunner({ targetVersion: '25.2.3' }), recovery: recoveryEvidence({ sourceVersion: '26.1.0', sourceClusterVersion: '26.1' }), code: 'COCKROACH_RESTORE_VERSION_INCOMPATIBLE' },
    { runner: createRunner({ targetVersion: '26.1.2' }), recovery: recoveryEvidence({ sourceVersion: '24.3.8', sourceClusterVersion: '24.3' }), code: 'COCKROACH_RESTORE_VERSION_INCOMPATIBLE' },
    { runner: createRunner(), recovery: recoveryEvidence({ requiredRegions: ['us-west1'] }), code: 'COCKROACH_RESTORE_REGION_INCOMPATIBLE' },
    { runner: createRunner({ databases: [['app_restored', 'root'], ['defaultdb', 'root'], ['system', 'node']] }), recovery: recoveryEvidence(), code: 'COCKROACH_RESTORE_TARGET_NOT_EMPTY' }
  ];
  for (const item of cases) {
    const request = await restoreRequest(item.runner, { recovery: item.recovery });
    await assert.rejects(controller().planRestore({ runNativeCommand: item.runner.runNativeCommand }, request), (error) => error.code === item.code);
    assert.equal(item.runner.events.includes('restore-submit'), false);
  }
});

test('persists exact detached ownership before polling and validates descriptors and dependencies after success', async () => {
  const runner = createRunner();
  const request = await restoreRequest(runner);
  const native = controller();
  const plan = await native.planRestore({ runNativeCommand: runner.runNativeCommand }, request);
  runner.events.length = 0;
  const result = await native.executeRestore({
    runNativeCommand: runner.runNativeCommand,
    onOwnership: async (ownership) => {
      assert.equal(ownership.jobId, JOB_ID);
      assert.equal(ownership.restoreRunId, 'restore-run-1');
      runner.events.push('ownership-persisted');
    }
  }, plan);
  assert.deepEqual(runner.events.slice(0, 3), ['external-check', 'show-backup', 'restore-submit']);
  assert.ok(runner.events.indexOf('ownership-persisted') < runner.events.indexOf('job-read'));
  assert.deepEqual(runner.events.slice(-2), ['descriptor-read', 'dependency-read']);
  assert.equal(result.validation.dependenciesValid, true);
  assert.equal(result.validation.nativeDescriptorRead, true);
  assert.equal(result.rollbackClaimed, false);
  assert.equal(JSON.stringify(result).includes('external://'), false);

  const validation = await native.validateRestore({ runNativeCommand: runner.runNativeCommand }, { connection: CONNECTION, ownership: result.ownership });
  assert.equal(validation.valid, true);
  assert.equal(validation.nativeIntegrityValidation, true);
  const reconciled = await native.reconcile({ runNativeCommand: runner.runNativeCommand }, { connection: CONNECTION, ownership: result.ownership });
  assert.equal(reconciled.job.status, 'succeeded');
  assert.equal(reconciled.nativeValidation.dependenciesValid, true);

  const controls = [
    ['pause', ['running', 'paused'], 'paused'],
    ['resume', ['paused', 'running'], 'running'],
    ['cancel', ['running', 'canceled'], 'canceled']
  ];
  for (const [operation, jobStatuses, expectedStatus] of controls) {
    const controlRunner = createRunner({ jobStatuses });
    const controlled = await native[operation]({ runNativeCommand: controlRunner.runNativeCommand }, { connection: CONNECTION, ownership: result.ownership });
    assert.equal(controlled.job.status, expectedStatus);
    assert.equal(controlRunner.events.includes(`${operation.toUpperCase()} JOB ${JOB_ID}`), true);
    assert.equal(controlled.rollbackClaimed, false);
  }
});

test('preserves the alternate target and claims no rollback when native completion fails', async () => {
  const runner = createRunner({ jobStatuses: ['failed'] });
  const request = await restoreRequest(runner);
  const native = controller();
  const plan = await native.planRestore({ runNativeCommand: runner.runNativeCommand }, request);
  await assert.rejects(
    native.executeRestore({ runNativeCommand: runner.runNativeCommand, onOwnership: async () => {} }, plan),
    (error) => error.code === 'COCKROACH_RESTORE_FAILED' && error.details.targetPreserved === true
  );
});

test('redacts provider failures and rejects unresolved restored dependencies', async () => {
  const secret = 's3://access:secret@provider/private';
  const unavailable = createRunner({ providerError: secret });
  const unavailableRequest = await restoreRequest(unavailable);
  await assert.rejects(controller().planRestore({ runNativeCommand: unavailable.runNativeCommand }, unavailableRequest), (error) => {
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });

  const runner = createRunner({ invalidObjectCount: 2 });
  const request = await restoreRequest(runner);
  const native = controller();
  const plan = await native.planRestore({ runNativeCommand: runner.runNativeCommand }, request);
  await assert.rejects(
    native.executeRestore({ runNativeCommand: runner.runNativeCommand, onOwnership: async () => {} }, plan),
    (error) => error.code === 'COCKROACH_RESTORE_DEPENDENCY_UNRESOLVED' && error.details.targetPreserved === true
  );
});
