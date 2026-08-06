const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID, ADAPTER_VERSION } = require('./cockroachdb');
const { normalizeDestination } = require('./cockroachdb-native');
const { admitCockroachDbSource } = require('./cockroachdb-source-reader');
const { CockroachDbNativeScheduleController } = require('./cockroachdb-schedule');
const { CockroachDbScheduleService, SCHEDULE_FIELD } = require('./cockroachdb-schedule-service');

const NOW = '2026-08-05T12:00:00.000Z';
const CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT = `sha256:${'a'.repeat(64)}`;
const TOPOLOGY = `sha256:${'b'.repeat(64)}`;
const INVENTORY = `sha256:${'c'.repeat(64)}`;
const DESTINATION = normalizeDestination({ type: 'external-connection', externalConnectionName: 'private_archive' });

function selector() {
  return {
    kind: 'database-objects', allDatabases: true,
    databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] },
    includeGlobalObjects: true
  };
}

function consistency() {
  return { backupMethod: 'physical', backupMode: 'full', method: 'cockroachdb-native-backup', requestedLevel: 'application', captureCoordinates: true };
}

function connection() {
  return {
    id: 'connection-cockroach', revision: 7, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION,
    workerAffinity: ['device:device-a'],
    endpoint: { expectedClusterId: CLUSTER_ID, expectedDeploymentFingerprint: DEPLOYMENT, expectedTopologyFingerprint: TOPOLOGY, expectedInventoryFingerprint: INVENTORY },
    trust: { clusterId: CLUSTER_ID, fingerprint: DEPLOYMENT, topologyFingerprint: TOPOLOGY, inventoryFingerprint: INVENTORY },
    lastTest: { status: 'success', endpointIdentity: { clusterId: CLUSTER_ID, deploymentFingerprint: DEPLOYMENT, topologyFingerprint: TOPOLOGY, inventoryFingerprint: INVENTORY } },
    cockroachdbInventory: {
      clusterId: CLUSTER_ID, deploymentFingerprint: DEPLOYMENT, topologyFingerprint: TOPOLOGY, inventoryFingerprint: INVENTORY,
      externalConnections: [{ name: 'private_archive', owner: 'private_owner' }],
      capabilities: { backupIntoSyntax: true, detachedJobs: true, jobsVisible: true, externalConnectionsVisible: true, privilegeEvidenceVisible: true, systemPrivileges: { VIEWJOB: true, CONTROLJOB: true } }
    },
    cockroachdbBackupDestinationTrust: {
      version: 1, connectionRevision: 7, clusterId: CLUSTER_ID, deploymentFingerprint: DEPLOYMENT, topologyFingerprint: TOPOLOGY, inventoryFingerprint: INVENTORY,
      destination: { type: 'external-connection', localities: DESTINATION.localities.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName })) },
      destinationFingerprint: DESTINATION.destinationFingerprint,
      localityFingerprint: DESTINATION.localityFingerprint,
      checkedAt: NOW
    }
  };
}

function source(record) {
  const selected = selector();
  return {
    id: 'source-cockroach', revision: 3, connectionId: record.id, sourceType: 'database', adapterId: ADAPTER_ID, enabled: true,
    selector: selected,
    consistency: consistency(),
    physicalExecution: admitCockroachDbSource({ connection: record, selector: selected, consistency: consistency(), input: { revisionHistory: true }, deviceId: 'device-a' })
  };
}

function database() {
  const record = connection();
  const records = {
    connection: new Map([[record.id, record]]),
    source: new Map([['source-cockroach', source(record)]]),
    policy: new Map([['policy-cockroach', { id: 'policy-cockroach', revision: 1, schedule: { type: 'manual' }, backupMode: 'incremental' }]]),
    backupJob: new Map([['job-cockroach', { id: 'job-cockroach', revision: 1, name: 'Cockroach native', sourceId: 'source-cockroach', policyId: 'policy-cockroach', adapterSettings: {} }]])
  };
  const transitions = [];
  const controlDatabase = {
    repository(type) {
      return {
        async get(_workspaceId, id) { return records[type].get(id) || null; },
        async list() { return [...records[type].values()]; }
      };
    },
    async transaction(callback) {
      return callback({
        get(type, _workspaceId, id) { return records[type].get(id) || null; },
        update(type, _workspaceId, id, changes, options) {
          const current = records[type].get(id);
          assert.equal(current.revision, options.expectedRevision);
          const next = { ...current, ...structuredClone(changes), revision: current.revision + 1, updatedAt: NOW };
          records[type].set(id, next);
          transitions.push(next.adapterSettings?.[SCHEDULE_FIELD]?.state || null);
          return next;
        }
      });
    }
  };
  return { controlDatabase, records, transitions };
}

function serviceFixture() {
  const current = database();
  const discovery = {
    clusterId: CLUSTER_ID, deploymentFingerprint: DEPLOYMENT, topologyFingerprint: TOPOLOGY, inventoryFingerprint: INVENTORY,
    currentUser: 'private_schedule_owner', externalConnections: [{ name: 'private_archive' }],
    capabilities: { backupIntoSyntax: true, externalConnectionsVisible: true },
    privileges: { visible: true, system: { BACKUP: true, CONTROLJOB: true } }
  };
  const planner = new CockroachDbNativeScheduleController({
    clock: () => NOW,
    labelToken: () => '1234567890abcdef',
    discover: async () => discovery,
    runSql: async (_context, _connection, sql) => sql.startsWith('SELECT count(*)')
      ? { stdout: 'visible_schedule_count\n0\n' }
      : { stdout: '' }
  });
  const controls = [];
  const controller = {
    plan: (...args) => planner.plan(...args),
    async create(context, plan) {
      assert.equal(await context.assertNoOwnership({ sourceId: plan.request.sourceId, planDigest: plan.planDigest }), true);
      await context.onSubmissionPrepared({ sourceId: plan.request.sourceId, planDigest: plan.planDigest, labelDigest: plan.labelDigest, preparedAt: NOW });
      const ownership = { sourceId: plan.request.sourceId, planDigest: plan.planDigest, labelDigest: plan.labelDigest, ownershipFingerprint: `sha256:${'f'.repeat(64)}`, scheduleIds: { full: '100', incremental: '101' } };
      await context.onOwnership(ownership);
      return { ownership, public: { version: 1, sourceId: plan.request.sourceId, state: 'active', recreateAllowed: false, schedules: [{ role: 'full', status: 'active' }, { role: 'incremental', status: 'active' }], ownershipFingerprint: ownership.ownershipFingerprint, reconciledAt: NOW } };
    },
    async reconcile(_context, input) {
      controls.push(['reconcile', input.ownership.scheduleIds]);
      return { public: { version: 1, sourceId: input.ownership.sourceId, state: 'active', recreateAllowed: false, schedules: [], ownershipFingerprint: input.ownership.ownershipFingerprint, reconciledAt: NOW } };
    },
    async pause(_context, input) {
      controls.push(['pause', input.ownership.scheduleIds]);
      return { public: { version: 1, sourceId: input.ownership.sourceId, state: 'paused', recreateAllowed: false, schedules: [], ownershipFingerprint: input.ownership.ownershipFingerprint, reconciledAt: NOW } };
    },
    async resume(_context, input) {
      controls.push(['resume', input.ownership.scheduleIds]);
      return { public: { version: 1, sourceId: input.ownership.sourceId, state: 'active', recreateAllowed: false, schedules: [], ownershipFingerprint: input.ownership.ownershipFingerprint, reconciledAt: NOW } };
    }
  };
  const connectionConfig = { executionMode: 'local', authMode: 'password', host: 'private.example', port: 26257, username: 'private_user', database: 'defaultdb', passwordSecretRefId: 'secret-private', sqlPath: 'C:\\private\\cockroach.exe' };
  const connectionService = { withExecution: async (_workspaceId, _connection, _signal, callback) => callback({}, connectionConfig) };
  const service = new CockroachDbScheduleService({ controlDatabase: current.controlDatabase, connectionService, controller, deviceId: 'device-a', clock: () => NOW });
  return { ...current, service, controls, controller };
}

const POLICY = { mode: 'full-incremental', recurringCron: '0 * * * *', fullCron: '0 0 * * *', revisionHistory: true, onPreviousRunning: 'wait', onExecutionFailure: 'reschedule', firstRun: 'next' };

test('previews a redacted native schedule bound to the enrolled Source and manual Job', async () => {
  const current = serviceFixture();
  const preview = await current.service.preview('local', { jobId: 'job-cockroach', policy: POLICY });
  assert.equal(preview.jobId, 'job-cockroach');
  assert.equal(preview.policy.timezone, 'UTC');
  const serialized = JSON.stringify(preview);
  for (const privateValue of ['private_archive', 'private_schedule_owner', 'private.example', 'secret-private', 'cockroach.exe']) assert.equal(serialized.includes(privateValue), false, privateValue);
});

test('persists submission reservation before exact native ownership and reconciles only persisted IDs', async () => {
  const current = serviceFixture();
  const created = await current.service.create('local', 'operator', { jobId: 'job-cockroach', policy: POLICY });
  assert.deepEqual(current.transitions.slice(0, 3), ['submitting', 'owned', 'owned']);
  assert.equal(created.state, 'active');
  assert.equal((await current.service.list('local')).length, 1);
  assert.equal((await current.service.pause('local', 'operator', 'job-cockroach')).state, 'paused');
  assert.equal((await current.service.resume('local', 'operator', 'job-cockroach')).state, 'active');
  assert.deepEqual(current.controls.filter(([operation]) => operation !== 'reconcile').map(([operation, ids]) => [operation, ids]), [
    ['pause', { full: '100', incremental: '101' }],
    ['resume', { full: '100', incremental: '101' }]
  ]);
});

test('blocks duplicate ownership, conflicting local schedules, and interrupted submission recreation', async () => {
  const duplicate = serviceFixture();
  await duplicate.service.create('local', 'operator', { jobId: 'job-cockroach', policy: POLICY });
  await assert.rejects(() => duplicate.service.create('local', 'operator', { jobId: 'job-cockroach', policy: POLICY }), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_ALREADY_OWNED');

  const localConflict = serviceFixture();
  localConflict.records.policy.get('policy-cockroach').schedule = { type: 'cron', expression: '0 * * * *', timezone: 'UTC' };
  await assert.rejects(() => localConflict.service.preview('local', { jobId: 'job-cockroach', policy: POLICY }), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_LOCAL_CONFLICT');

  const interrupted = serviceFixture();
  interrupted.records.backupJob.get('job-cockroach').adapterSettings[SCHEDULE_FIELD] = { state: 'submitting', planDigest: `sha256:${'1'.repeat(64)}`, preparedAt: NOW };
  await assert.rejects(() => interrupted.service.reconcile('local', 'operator', 'job-cockroach'), (error) => error.code === 'COCKROACH_NATIVE_SCHEDULE_SUBMISSION_AMBIGUOUS');
  assert.equal((await interrupted.service.list('local'))[0].recovery.recreateAllowed, false);
});

test('reconcileAll replaces unexpected dependency details with a fixed public error', async () => {
  const current = serviceFixture();
  await current.service.create('local', 'operator', { jobId: 'job-cockroach', policy: POLICY });
  current.controller.reconcile = async () => {
    throw Object.assign(new Error('private.example secret-private C:\\private\\cockroach.exe'), { code: 'PRIVATE_PROVIDER_FAILURE' });
  };

  const [result] = await current.service.reconcileAll('local');
  assert.deepEqual(result.error, {
    code: 'COCKROACH_NATIVE_SCHEDULE_RECONCILIATION_FAILED',
    safeMessage: 'CockroachDB native schedule reconciliation requires operator attention.'
  });
  const serialized = JSON.stringify(result);
  for (const privateValue of ['private.example', 'secret-private', 'cockroach.exe', 'PRIVATE_PROVIDER_FAILURE']) assert.equal(serialized.includes(privateValue), false, privateValue);
});
