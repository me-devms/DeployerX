const assert = require('node:assert/strict');
const test = require('node:test');
const { QUERIES, readDiscovery } = require('./cockroachdb');
const {
  MAX_INCREMENTALS,
  CockroachDbNativeBackupController,
  buildBackupStatement,
  jobStatusQuery,
  normalizeBackupRequest,
  normalizeDestination,
  normalizeSelection
} = require('./cockroachdb-native');

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const CLOCK = '2026-08-05T12:00:00.000Z';
const AS_OF = '2026-08-05T11:59:00.000Z';
const CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const CHANGED_CLUSTER_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '900000000000000001';
const CONNECTION = Object.freeze({
  executionMode: 'local',
  authMode: 'password',
  host: 'roach.example.com',
  port: 26257,
  username: 'backup_user',
  database: 'defaultdb',
  passwordSecretRefId: 'sec_cockroach_password',
  sqlPath: 'cockroach'
});

function tsv(headers, rows = []) {
  return [headers.join('\t'), ...rows.map((row) => row.map((value) => String(value)).join('\t'))].join('\n') + '\n';
}

function jobOutput(status = 'succeeded') {
  const terminal = ['succeeded', 'failed', 'canceled', 'revert-failed'].includes(status);
  return tsv(
    ['job_id', 'job_type', 'user_name', 'status', 'created', 'started', 'finished', 'modified', 'fraction_completed', 'coordinator_id', 'has_error'],
    [[
      JOB_ID,
      'BACKUP',
      'backup_user',
      status,
      '2026-08-05T11:59:01.000Z',
      '2026-08-05T11:59:02.000Z',
      terminal ? '2026-08-05T11:59:30.000Z' : '',
      '2026-08-05T11:59:30.000Z',
      status === 'succeeded' ? 1 : 0.5,
      1,
      status === 'failed' || status === 'revert-failed'
    ]]
  );
}

function createRunner(options = {}) {
  const calls = [];
  const events = [];
  let identityReads = 0;
  let jobReads = 0;
  const jobStatuses = options.jobStatuses || ['succeeded'];
  const runNativeCommand = async (request) => {
    const query = request.args.at(-1);
    calls.push(query);
    if (query === QUERIES.identity) {
      identityReads += 1;
      const identity = options.identityForRead?.(identityReads) || {};
      return { stdout: tsv(['version', 'cluster_id', 'node_id', 'current_user', 'current_database'], [[
        'CockroachDB CCL v25.2.3 (x86_64-pc-linux-gnu)',
        identity.clusterId || CLUSTER_ID,
        1,
        identity.currentUser || 'backup_user',
        'defaultdb'
      ]]), stderr: '', exitCode: 0 };
    }
    if (query === QUERIES.clusterVersion) return { stdout: tsv(['version'], [['25.2']]), stderr: '', exitCode: 0 };
    if (query === QUERIES.nodes) return { stdout: tsv(
      ['node_id', 'address', 'sql_address', 'build_tag', 'started_at', 'locality', 'is_available', 'is_live'],
      [[1, options.nodeAddress || 'roach-a:26257', 'roach-a:26257', 'v25.2.3', '2026-08-05T01:00:00.000Z', 'region=us-east1,zone=a', true, true]]
    ), stderr: '', exitCode: 0 };
    if (query === QUERIES.databases) return { stdout: tsv(['database_name', 'owner'], (options.databases || [
      ['app', 'app_owner'], ['defaultdb', 'root'], ['system', 'node']
    ])), stderr: '', exitCode: 0 };
    if (query === QUERIES.systemPrivileges) {
      if (options.systemPrivilegesUnavailable) throw new Error('privilege catalog unavailable');
      const privileges = { backup: true, restore: true, viewjob: true, controljob: true, externalioimplicitaccess: false, ...options.systemPrivileges };
      return { stdout: tsv(['backup', 'restore', 'viewjob', 'controljob', 'externalioimplicitaccess'], [[
        privileges.backup, privileges.restore, privileges.viewjob, privileges.controljob, privileges.externalioimplicitaccess
      ]]), stderr: '', exitCode: 0 };
    }
    if (query === QUERIES.jobs) {
      if (options.jobsUnavailable) throw new Error('job catalog unavailable');
      return { stdout: tsv(['visible_job_count'], [[4]]), stderr: '', exitCode: 0 };
    }
    if (query === QUERIES.externalConnections) {
      if (options.externalConnectionsUnavailable) throw new Error('external connection catalog unavailable');
      return { stdout: tsv(['connection_name', 'owner'], options.externalConnections || [['backup_archive', 'backup_user']]), stderr: '', exitCode: 0 };
    }
    if (query.startsWith('SELECT has_database_privilege') || query.startsWith('SELECT has_table_privilege')) {
      events.push('scope-privilege');
      return { stdout: tsv(['allowed'], [[options.scopePrivilege !== false]]), stderr: '', exitCode: 0 };
    }
    if (query.startsWith('CHECK EXTERNAL CONNECTION')) {
      events.push('external-check');
      if (options.externalCheckError) throw new Error(options.externalCheckError);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (query.startsWith('BACKUP')) {
      events.push('backup-submit');
      return { stdout: options.backupOutput || tsv(['job_id'], [[JOB_ID]]), stderr: '', exitCode: 0 };
    }
    if (query.startsWith('SELECT job_id::STRING AS job_id')) {
      events.push('job-read');
      const status = jobStatuses[Math.min(jobReads, jobStatuses.length - 1)];
      jobReads += 1;
      return { stdout: typeof status === 'string' && status.includes('\t') ? status : jobOutput(status), stderr: '', exitCode: 0 };
    }
    if (/^(PAUSE|RESUME|CANCEL) JOB [1-9][0-9]*$/.test(query)) {
      events.push(query);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected CockroachDB query: ${query}`);
  };
  return { calls, events, runNativeCommand, get identityReads() { return identityReads; }, get jobReads() { return jobReads; } };
}

let defaultDiscoveryPromise;
function defaultDiscovery() {
  if (!defaultDiscoveryPromise) defaultDiscoveryPromise = readDiscovery({ runNativeCommand: createRunner().runNativeCommand }, CONNECTION);
  return defaultDiscoveryPromise;
}

async function requestInput(overrides = {}, discoveryOptions = {}) {
  const discovery = Object.keys(discoveryOptions).length
    ? await readDiscovery({ runNativeCommand: createRunner(discoveryOptions).runNativeCommand }, CONNECTION)
    : await defaultDiscovery();
  return {
    connection: CONNECTION,
    binding: {
      clusterId: discovery.clusterId,
      deploymentFingerprint: discovery.deploymentFingerprint,
      topologyFingerprint: discovery.topologyFingerprint,
      inventoryFingerprint: discovery.inventoryFingerprint,
      connectionRevision: 7
    },
    selection: { scope: 'cluster' },
    destination: { type: 'external-connection', externalConnectionName: 'backup_archive' },
    backupMode: 'full',
    asOfTimestamp: AS_OF,
    revisionHistory: false,
    encryptionMode: 'none',
    execution: { workspaceId: 'ws-1', sourceId: 'source-roach', executionId: 'exec-full-1', connectionRevision: 7 },
    ...overrides
  };
}

function parentChain(input, overrides = {}) {
  const selection = normalizeSelection(input.selection);
  const destination = normalizeDestination(input.destination);
  return {
    version: 1,
    rootExecutionId: 'exec-full-1',
    headExecutionId: 'exec-incremental-previous',
    incrementalCount: 1,
    lastAsOfTimestamp: '2026-08-05T11:50:00.000Z',
    clusterId: input.binding.clusterId,
    deploymentFingerprint: input.binding.deploymentFingerprint,
    topologyFingerprint: input.binding.topologyFingerprint,
    destinationFingerprint: destination.destinationFingerprint,
    localityFingerprint: destination.localityFingerprint,
    selectionFingerprint: selection.fingerprint,
    revisionHistory: input.revisionHistory === true,
    encryptionMode: 'none',
    ...overrides
  };
}

function controller(options = {}) {
  return new CockroachDbNativeBackupController({
    clock: () => CLOCK,
    now: () => NOW,
    delay: async () => {},
    pollIntervalMs: 100,
    maximumWaitMs: 1000,
    ...options
  });
}

test('builds exact cluster, database, and whole-table BACKUP INTO statements', async () => {
  const cluster = normalizeBackupRequest(await requestInput(), NOW);
  assert.equal(buildBackupStatement(cluster), `BACKUP INTO 'external://backup_archive' AS OF SYSTEM TIME '${AS_OF}' WITH detached`);

  const database = normalizeBackupRequest(await requestInput({ selection: { scope: 'database', database: 'app' }, revisionHistory: true }), NOW);
  assert.equal(buildBackupStatement(database), `BACKUP DATABASE "app" INTO 'external://backup_archive' AS OF SYSTEM TIME '${AS_OF}' WITH revision_history, detached`);

  const rawTable = await requestInput({
    selection: { scope: 'table', tables: [
      { database: 'app', schema: 'sales', name: 'z_orders' },
      { database: 'app', schema: 'public', name: 'a"orders' }
    ] },
    backupMode: 'incremental',
    execution: { workspaceId: 'ws-1', sourceId: 'source-roach', executionId: 'exec-inc-2', connectionRevision: 7 }
  });
  rawTable.parentChain = parentChain(rawTable);
  const table = normalizeBackupRequest(rawTable, NOW);
  assert.equal(
    buildBackupStatement(table),
    `BACKUP TABLE "app"."public"."a""orders", "app"."sales"."z_orders" INTO LATEST IN 'external://backup_archive' AS OF SYSTEM TIME '${AS_OF}' WITH detached`
  );
});

test('pins incremental lineage, cadence, and the 48-increment chain limit', async () => {
  const raw = await requestInput({
    backupMode: 'incremental',
    execution: { workspaceId: 'ws-1', sourceId: 'source-roach', executionId: 'exec-inc-2', connectionRevision: 7 }
  });
  raw.parentChain = parentChain(raw);
  const normalized = normalizeBackupRequest(raw, NOW);
  assert.equal(normalized.chainEvidence.rootExecutionId, 'exec-full-1');
  assert.equal(normalized.chainEvidence.parentExecutionId, 'exec-incremental-previous');
  assert.equal(normalized.chainEvidence.chainIndex, 2);

  assert.throws(
    () => normalizeBackupRequest({ ...raw, parentChain: parentChain(raw, { incrementalCount: MAX_INCREMENTALS }) }, NOW),
    (error) => error.code === 'COCKROACH_INCREMENTAL_LIMIT_REACHED'
  );
  assert.throws(
    () => normalizeBackupRequest({ ...raw, parentChain: parentChain(raw, { lastAsOfTimestamp: '2026-08-05T11:54:01.000Z' }) }, NOW),
    (error) => error.code === 'COCKROACH_INCREMENTAL_CADENCE_INVALID'
  );
});

test('rejects destination injection and safely quotes hostile SQL identifiers', async () => {
  assert.throws(
    () => normalizeDestination({ type: 'external-connection', externalConnectionName: "archive'; DROP DATABASE app; --" }),
    /external connection name is invalid/
  );
  assert.throws(
    () => normalizeSelection({ scope: 'table', tables: [{ database: 'app', schema: 'public', name: 'orders\nDROP TABLE app.orders' }] }),
    /table name is invalid/
  );
  const raw = await requestInput({ selection: { scope: 'database', database: 'app"; DROP DATABASE app; --' } });
  const statement = buildBackupStatement(normalizeBackupRequest(raw, NOW));
  assert.match(statement, /^BACKUP DATABASE "app""; DROP DATABASE app; --" INTO/);
});

test('rejects stale Source identity, missing scope or job privileges, and unavailable external connections', async () => {
  const staleInput = await requestInput();
  const staleRunner = createRunner({ identityForRead: () => ({ clusterId: CHANGED_CLUSTER_ID }) });
  await assert.rejects(
    () => controller().preflight({ runNativeCommand: staleRunner.runNativeCommand }, staleInput),
    (error) => error.code === 'COCKROACH_SOURCE_IDENTITY_CHANGED'
  );

  const databaseInput = await requestInput({ selection: { scope: 'database', database: 'app' } });
  const deniedRunner = createRunner({ scopePrivilege: false });
  await assert.rejects(
    () => controller().preflight({ runNativeCommand: deniedRunner.runNativeCommand }, databaseInput),
    (error) => error.code === 'COCKROACH_BACKUP_PRIVILEGE_MISSING'
  );

  const jobOptions = { systemPrivileges: { viewjob: false } };
  const jobInput = await requestInput({}, jobOptions);
  const jobRunner = createRunner(jobOptions);
  await assert.rejects(
    () => controller().preflight({ runNativeCommand: jobRunner.runNativeCommand }, jobInput),
    (error) => error.code === 'COCKROACH_NATIVE_CAPABILITY_UNPROVEN'
  );

  const missingOptions = { externalConnections: [] };
  const missingInput = await requestInput({}, missingOptions);
  const missingRunner = createRunner(missingOptions);
  await assert.rejects(
    () => controller().preflight({ runNativeCommand: missingRunner.runNativeCommand }, missingInput),
    (error) => error.code === 'COCKROACH_EXTERNAL_CONNECTION_CHANGED'
  );
});

test('requires a successful CHECK EXTERNAL CONNECTION without leaking provider errors', async () => {
  const input = await requestInput();
  const runner = createRunner({ externalCheckError: 's3://access-key:private-token@secret-bucket failed' });
  await assert.rejects(
    () => controller().preflight({ runNativeCommand: runner.runNativeCommand }, input),
    (error) => {
      assert.equal(error.code, 'COCKROACH_COMMAND_FAILED');
      assert.equal(`${error.message} ${JSON.stringify(error.details)}`.includes('private-token'), false);
      assert.equal(`${error.message} ${JSON.stringify(error.details)}`.includes('s3://'), false);
      return true;
    }
  );
  assert.equal(runner.calls.filter((query) => query === "CHECK EXTERNAL CONNECTION 'external://backup_archive'").length, 1);
});

test('captures one detached job, persists ownership before polling, and returns reusable head evidence', async () => {
  const input = await requestInput();
  const runner = createRunner({ jobStatuses: ['running', 'succeeded'] });
  const native = controller();
  const plan = await native.planBackup({ runNativeCommand: runner.runNativeCommand }, input);
  runner.events.length = 0;
  const result = await native.executeBackup({
    runNativeCommand: runner.runNativeCommand,
    onOwnership: async (ownership) => {
      runner.events.push('ownership-persisted');
      assert.equal(Object.isFrozen(ownership), true);
      assert.equal(ownership.jobId, JOB_ID);
    }
  }, plan);

  assert.deepEqual(runner.events.slice(0, 5), ['external-check', 'backup-submit', 'ownership-persisted', 'job-read', 'job-read']);
  assert.equal(result.job.status, 'succeeded');
  assert.equal(result.chain.rootExecutionId, 'exec-full-1');
  assert.equal(result.chain.headExecutionId, 'exec-full-1');
  assert.equal('parentExecutionId' in result.chain, false);
  assert.equal(result.publicationReady, false);
  assert.equal(result.restoreSupported, false);
  assert.equal(runner.identityReads, 3);
  const evidence = JSON.stringify(result);
  assert.equal(evidence.includes('sec_cockroach_password'), false);
  assert.equal(evidence.includes('external://'), false);
  assert.equal(evidence.includes('s3://'), false);
});

test('rejects ambiguous detached job output and stops before ownership persistence', async () => {
  const input = await requestInput();
  const runner = createRunner({ backupOutput: tsv(['job_id'], [[JOB_ID], ['900000000000000002']]) });
  const native = controller();
  const plan = await native.planBackup({ runNativeCommand: runner.runNativeCommand }, input);
  let persisted = false;
  await assert.rejects(
    () => native.executeBackup({ runNativeCommand: runner.runNativeCommand, onOwnership: async () => { persisted = true; } }, plan),
    (error) => error.code === 'COCKROACH_JOB_ID_INVALID'
  );
  assert.equal(persisted, false);
  assert.equal(runner.events.includes('job-read'), false);
});

test('fails safely when durable ownership persistence fails and does not poll', async () => {
  const input = await requestInput();
  const runner = createRunner();
  const native = controller();
  const plan = await native.planBackup({ runNativeCommand: runner.runNativeCommand }, input);
  runner.events.length = 0;
  await assert.rejects(
    () => native.executeBackup({
      runNativeCommand: runner.runNativeCommand,
      onOwnership: async () => { runner.events.push('ownership-persisted'); throw new Error('storage offline'); }
    }, plan),
    (error) => error.code === 'COCKROACH_OWNERSHIP_PERSIST_FAILED'
  );
  assert.deepEqual(runner.events, ['external-check', 'backup-submit', 'ownership-persisted']);
});

test('cancels monitoring while waiting without canceling the owned native job', async () => {
  const input = await requestInput();
  const runner = createRunner({ jobStatuses: ['running'] });
  const abort = new AbortController();
  const native = controller({ delay: () => {
    setImmediate(() => abort.abort());
    return new Promise(() => {});
  } });
  const plan = await native.planBackup({ runNativeCommand: runner.runNativeCommand }, input);
  await assert.rejects(
    () => native.executeBackup({ runNativeCommand: runner.runNativeCommand, signal: abort.signal, onOwnership: async () => {} }, plan),
    (error) => error.code === 'COCKROACH_MONITOR_CANCELED' && error.details.jobId === JOB_ID
  );
  assert.equal(runner.calls.some((query) => query === `CANCEL JOB ${JOB_ID}`), false);
});

test('bounds polling even when the injected clock never advances', async () => {
  const input = await requestInput();
  const runner = createRunner({ jobStatuses: ['running'] });
  const native = controller({ now: () => NOW });
  const plan = await native.planBackup({ runNativeCommand: runner.runNativeCommand }, input);
  await assert.rejects(
    () => native.executeBackup({ runNativeCommand: runner.runNativeCommand, onOwnership: async () => {} }, plan),
    (error) => error.code === 'COCKROACH_BACKUP_TIMEOUT'
  );
  assert.equal(runner.jobReads, 11);
});

test('re-proves cluster identity after terminal success before accepting evidence', async () => {
  const input = await requestInput();
  const runner = createRunner({
    jobStatuses: ['succeeded'],
    identityForRead: (read) => read === 3 ? { clusterId: CHANGED_CLUSTER_ID } : {}
  });
  const native = controller();
  const plan = await native.planBackup({ runNativeCommand: runner.runNativeCommand }, input);
  await assert.rejects(
    () => native.executeBackup({ runNativeCommand: runner.runNativeCommand, onOwnership: async () => {} }, plan),
    (error) => error.code === 'COCKROACH_COMPLETION_IDENTITY_CHANGED'
  );
  assert.equal(runner.identityReads, 3);
});

test('reconciles and controls only exact owned numeric job IDs without exposing job text', async () => {
  const input = await requestInput();
  const executionRunner = createRunner();
  const native = controller();
  const plan = await native.planBackup({ runNativeCommand: executionRunner.runNativeCommand }, input);
  const result = await native.executeBackup({ runNativeCommand: executionRunner.runNativeCommand, onOwnership: async () => {} }, plan);

  const reconcileRunner = createRunner({ jobStatuses: ['running'] });
  const reconciled = await native.reconcile({ runNativeCommand: reconcileRunner.runNativeCommand }, { connection: CONNECTION, ownership: result.ownership });
  assert.equal(reconciled.job.jobId, JOB_ID);
  assert.equal(reconciled.job.status, 'running');
  const statusSql = reconcileRunner.calls.find((query) => query.startsWith('SELECT job_id::STRING AS job_id'));
  assert.equal(statusSql, jobStatusQuery(JOB_ID));
  assert.equal(/description|statement/i.test(statusSql), false);
  assert.equal(/\berror\s+AS\s+error\b/i.test(statusSql), false);

  const cases = [
    ['pause', ['running', 'paused'], `PAUSE JOB ${JOB_ID}`],
    ['resume', ['paused', 'running'], `RESUME JOB ${JOB_ID}`],
    ['cancel', ['running', 'canceled'], `CANCEL JOB ${JOB_ID}`]
  ];
  for (const [method, statuses, expectedSql] of cases) {
    const runner = createRunner({ jobStatuses: statuses });
    const controlled = await native[method]({ runNativeCommand: runner.runNativeCommand }, { connection: CONNECTION, ownership: result.ownership });
    assert.equal(runner.calls.includes(expectedSql), true);
    assert.equal(controlled.job.status, statuses[1]);
    assert.equal(JSON.stringify(controlled).includes('description'), false);
  }
});
