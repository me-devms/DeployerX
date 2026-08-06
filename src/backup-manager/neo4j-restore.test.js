const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const test = require('node:test');
const { ADAPTER_ID, Neo4jAdapter, Neo4jConnectionService, stableDigest } = require('./neo4j');
const { Neo4jRestoreService, RESTORE_CONFIRMATION } = require('./neo4j-restore');

const WORKSPACE_ID = 'workspace-neo4j-restore';
const DEVICE_ID = 'device-neo4j-restore';
const DUMP_BYTES = Buffer.from('authenticated-neo4j-alternate-restore-dump');

function targetDatabaseOutput(options = {}) {
  const rows = ['name\ttype\taccess\tcurrentStatus\trequestedStatus\trole\twriter\tdefault\thome\tdatabaseID\tserverID\tconstituents'];
  if (options.existingDatabase) rows.push(`${options.existingDatabase}\tstandard\tread-write\toffline\toffline\tprimary\ttrue\ttrue\ttrue\tdb-existing\ttarget-server\tnull`);
  rows.push('system\tsystem\tread-write\tonline\tonline\tprimary\ttrue\tfalse\tfalse\tdb-target-system\ttarget-server\tnull');
  return rows.join('\n');
}

function targetRunner(options = {}) {
  const calls = [];
  let resolveInspectionStarted;
  let resolveLoadStarted;
  const inspectionStarted = new Promise((resolve) => { resolveInspectionStarted = resolve; });
  const loadStarted = new Promise((resolve) => { resolveLoadStarted = resolve; });
  const waitForAbort = (signal) => new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('canceled'), { name: 'AbortError' }));
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'AbortError' })), { once: true });
  });
  const run = async ({ executable, args, signal }) => {
    const name = String(executable).replace(/\\/g, '/').split('/').at(-1);
    calls.push({ name, args: args.slice() });
    if (name === 'neo4j') return { stdout: 'neo4j 5.26.2\n', stderr: '', exitCode: 0 };
    if (name === 'neo4j-admin') {
      if (args[0] === '--version') return { stdout: 'neo4j-admin 5.26.2\n', stderr: '', exitCode: 0 };
      if (args[0] === 'database' && args[1] === 'info') {
        resolveInspectionStarted();
        if (options.blockInspection) await waitForAbort(signal);
        return { stdout: `Database name: ${args.at(-1)}\nStore format: ${options.targetStoreFormat || 'aligned'}\n`, stderr: '', exitCode: 0 };
      }
      if (args[0] === 'database' && args[1] === 'load') {
        resolveLoadStarted();
        if (options.blockLoad) await waitForAbort(signal);
        if (options.failLoad) throw Object.assign(new Error('native load failed'), { exitCode: 2 });
        return { stdout: 'Load completed successfully\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'database' && args[1] === 'check') return { stdout: 'Consistency check successful\n', stderr: '', exitCode: 0 };
    }
    if (name !== 'cypher-shell') throw new Error(`Unexpected executable: ${name}`);
    const statement = args.at(-1);
    if (statement.startsWith('CALL dbms.components')) return { stdout: 'name\tversion\tedition\nNeo4j Kernel\t5.26.2\tcommunity\n', stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW DATABASES')) return { stdout: `${targetDatabaseOutput(options)}\n`, stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW SERVERS')) throw Object.assign(new Error('unsupported'), { exitCode: 1 });
    throw new Error(`Unexpected Neo4j command: ${statement}`);
  };
  run.calls = calls;
  run.inspectionStarted = inspectionStarted;
  run.loadStarted = loadStarted;
  return run;
}

function fixture(options = {}) {
  const repositoryDigest = crypto.createHmac('sha256', 'neo4j-repository-test').update(DUMP_BYTES).digest('hex');
  const metadata = {
    version: 1,
    kind: 'neo4j-offline-dump',
    adapterId: ADAPTER_ID,
    adapterVersion: '0.3.0',
    engine: 'neo4j',
    selection: { databases: { include: [{ name: 'neo4j' }] } },
    selectionDigest: 'selection-neo4j',
    consistency: { proven: true, method: 'offline', achievedLevel: 'application' },
    source: { deploymentFingerprint: `sha256:${'1'.repeat(64)}`, topologyFingerprint: `sha256:${'2'.repeat(64)}` },
    database: { name: 'neo4j', databaseId: 'db-protected', allocations: [] },
    edition: 'community',
    productVersion: '5.26.2',
    metadataScope: 'database-store-only-no-rbac',
    artifact: {
      kind: 'database-dump', path: 'neo4j/neo4j.dump', mediaType: 'application/vnd.neo4j.dump', sizeBytes: DUMP_BYTES.length,
      contentDigest: `sha256:${crypto.createHash('sha256').update(DUMP_BYTES).digest('hex')}`,
      inspectionDigest: stableDigest({ storeFormat: 'aligned' }), storeFormat: 'aligned'
    }
  };
  const targetConnection = {
    id: 'connection-target', adapterId: ADAPTER_ID,
    endpoint: { expectedEdition: 'community', executionMode: 'local', address: 'neo4j://127.0.0.1:7687', username: null, neo4jPath: 'neo4j', neo4jAdminPath: 'neo4j-admin', cypherShellPath: 'cypher-shell', timeoutMs: 30000 },
    secretRefIds: [], trust: { fingerprint: `sha256:${'3'.repeat(64)}` }, workerAffinity: [`device:${DEVICE_ID}`], lastTest: { status: 'success' }
  };
  const records = {
    recoveryPoint: new Map([['point-neo4j', { id: 'point-neo4j', sourceId: 'source-neo4j', jobId: 'job-neo4j', type: 'full', consistency: 'application', verification: { state: 'succeeded' }, retention: { deletionEligible: false }, repositoryCopies: [{ repositoryId: 'repository-a', engineSnapshotId: 'snapshot-a', state: 'available' }] }]]),
    source: new Map([['source-neo4j', { id: 'source-neo4j', adapterId: ADAPTER_ID, connectionId: 'connection-source', consistency: { backupMethod: 'physical' }, selector: { digest: 'selection-neo4j', databases: { include: [{ name: 'neo4j' }] } } }]]),
    connection: new Map([[targetConnection.id, targetConnection]]),
    artifact: new Map([['artifact-neo4j', { id: 'artifact-neo4j', recoveryPointId: 'point-neo4j', repositoryId: 'repository-a', kind: 'database-dump', locator: 'manifest#neo4j%2Fneo4j.dump', sizeBytes: DUMP_BYTES.length, checksum: { algorithm: 'hmac-sha256', digest: repositoryDigest }, metadata }]]),
    restoreRun: new Map()
  };
  let sequence = 0;
  const repository = (name) => ({
    get: async (_workspaceId, id) => records[name].get(id) || null,
    list: async () => [...records[name].values()],
    create: async (input) => {
      const record = { ...input, id: `restore-${++sequence}`, revision: 1 };
      records[name].set(record.id, record);
      return record;
    }
  });
  const controlDatabase = {
    repository,
    transaction: async (callback) => callback({
      get: (name, _workspaceId, id) => records[name].get(id) || null,
      projectExecution: (name, _workspaceId, id, changes) => {
        const current = records[name].get(id);
        const updated = { ...current, ...changes, revision: current.revision + 1 };
        records[name].set(id, updated);
        return updated;
      }
    })
  };
  const streamBytes = options.streamBytes || DUMP_BYTES;
  const snapshot = { manifest: { files: [{ path: metadata.artifact.path, type: 'file', sizeBytes: DUMP_BYTES.length, contentDigest: { algorithm: 'hmac-sha256', digest: repositoryDigest }, metadata: { artifactKind: 'database-dump', database: metadata } }] } };
  const openRepository = async () => ({
    masterKey: Buffer.alloc(32),
    engine: {
      openSnapshot: async () => snapshot,
      streamFile: () => (async function* () { yield streamBytes.subarray(0, 11); yield streamBytes.subarray(11); })()
    }
  });
  const runner = targetRunner(options);
  const adapter = new Neo4jAdapter();
  const connectionService = new Neo4jConnectionService({ controlDatabase, secretStore: {}, deviceId: DEVICE_ID, adapter, localCommandRunner: runner });
  const service = new Neo4jRestoreService({ controlDatabase, deviceId: DEVICE_ID, adapter, connectionService, openRepository, clock: () => '2026-08-05T14:00:00.000Z', now: () => 1000 });
  return { service, runner, records, metadata };
}

test('previews and executes an authenticated empty-target Neo4j offline load', async () => {
  const data = fixture();
  const request = { recoveryPointId: 'point-neo4j', targetConnectionId: 'connection-target', targetDatabase: 'recovered' };
  const preview = await data.service.preview(WORKSPACE_ID, request);
  assert.equal(preview.targetEmpty, true);
  assert.equal(preview.storeFormat, 'aligned');
  assert.equal(preview.serviceStartsAutomatically, false);
  assert.equal(preview.confirmationText, RESTORE_CONFIRMATION);
  assert.match(preview.planDigest, /^sha256:[0-9a-f]{64}$/);

  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { ...request, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(completed.result.bytesRestored, DUMP_BYTES.length);
  assert.equal(completed.result.storeFormat, 'aligned');
  assert.equal(completed.result.serviceStarted, false);
  assert.equal(completed.target.stagePath, null);
  const load = data.runner.calls.find((call) => call.name === 'neo4j-admin' && call.args[1] === 'load');
  assert.deepEqual(load.args.slice(0, 3), ['database', 'load', 'recovered']);
  assert.equal(load.args.includes('--overwrite-destination=false'), true);
  assert.equal(data.runner.calls.some((call) => call.name === 'neo4j-admin' && call.args[1] === 'check'), true);
  assert.equal((await data.service.list(WORKSPACE_ID)).length, 1);
});

test('refuses an existing database before creating a RestoreRun', async () => {
  const data = fixture({ existingDatabase: 'recovered' });
  await assert.rejects(data.service.preview(WORKSPACE_ID, { recoveryPointId: 'point-neo4j', targetConnectionId: 'connection-target', targetDatabase: 'recovered' }), (error) => error.code === 'NEO4J_RESTORE_TARGET_DATABASE_EXISTS');
  assert.equal(data.records.restoreRun.size, 0);
  assert.equal(data.runner.calls.some((call) => call.name === 'neo4j-admin' && call.args[1] === 'load'), false);
});

test('fails digest mismatch before native mutation and clears the owned stage reference', async () => {
  const data = fixture({ streamBytes: Buffer.from('tampered--neo4j-alternate-restore-dump') });
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-neo4j', targetConnectionId: 'connection-target', targetDatabase: 'recovered', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.target.nativeMutationStarted, false);
  assert.equal(completed.target.stagePath, null);
  assert.equal(completed.result.error.code, 'NEO4J_RESTORE_DIGEST_MISMATCH');
  assert.equal(data.runner.calls.some((call) => call.name === 'neo4j-admin' && call.args[1] === 'load'), false);
});

test('refuses changed target-side store-format evidence before native load', async () => {
  const data = fixture({ targetStoreFormat: 'block' });
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-neo4j', targetConnectionId: 'connection-target', targetDatabase: 'recovered', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'NEO4J_RESTORE_MEDIA_IDENTITY_CHANGED');
  assert.equal(completed.target.nativeMutationStarted, false);
  assert.equal(data.runner.calls.some((call) => call.name === 'neo4j-admin' && call.args[1] === 'load'), false);
});

test('preserves the exact owned stage and marks operator action after load starts', async (context) => {
  const data = fixture({ failLoad: true });
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-neo4j', targetConnectionId: 'connection-target', targetDatabase: 'recovered', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  const completed = await data.service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'interrupted');
  assert.equal(completed.target.nativeMutationStarted, true);
  assert.equal(completed.progress.phase, 'operator-action-required');
  assert.equal(completed.result.error.code, 'NEO4J_RESTORE_TARGET_REQUIRES_INSPECTION');
  assert.equal((await fs.lstat(completed.target.stagePath)).isDirectory(), true);
  const owner = JSON.parse(await fs.readFile(`${completed.target.stagePath}/.deployerx-owner.json`, 'utf8'));
  assert.deepEqual(owner, { version: 1, workspaceId: WORKSPACE_ID, ownerType: 'neo4j-restore', ownerId: completed.id });
  context.after(() => fs.rm(completed.target.stagePath, { recursive: true, force: true }));
});

test('cancels before native load and removes the unconsumed owned stage', async () => {
  const data = fixture({ blockInspection: true });
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-neo4j', targetConnectionId: 'connection-target', targetDatabase: 'recovered', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  await data.runner.inspectionStarted;
  const canceled = await data.service.cancel(WORKSPACE_ID, 'actor-a', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.target.nativeMutationStarted, false);
  assert.equal(canceled.target.stagePath, null);
  assert.equal(canceled.result.error.code, 'NEO4J_RESTORE_CANCELED');
  assert.equal(data.runner.calls.some((call) => call.name === 'neo4j-admin' && call.args[1] === 'load'), false);
});

test('cancellation after native load starts preserves the target and stage', async (context) => {
  const data = fixture({ blockLoad: true });
  const started = await data.service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-neo4j', targetConnectionId: 'connection-target', targetDatabase: 'recovered', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  await data.runner.loadStarted;
  const interrupted = await data.service.cancel(WORKSPACE_ID, 'actor-a', started.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.target.nativeMutationStarted, true);
  assert.equal(interrupted.result.error.code, 'NEO4J_RESTORE_TARGET_REQUIRES_INSPECTION');
  assert.equal((await fs.lstat(interrupted.target.stagePath)).isDirectory(), true);
  context.after(() => fs.rm(interrupted.target.stagePath, { recursive: true, force: true }));
});

test('reconciles interrupted native mutation without claiming rollback', async () => {
  const data = fixture();
  data.records.restoreRun.set('restore-interrupted', {
    id: 'restore-interrupted', revision: 1, state: 'running',
    target: { operation: 'neo4j-offline-alternate-load', engine: 'neo4j', nativeMutationStarted: true, stagePath: '/tmp/deployerx-neo4j-owned' },
    progress: { phase: 'loading' }
  });
  const [record] = await data.service.reconcile(WORKSPACE_ID, 'system');
  assert.equal(record.state, 'interrupted');
  assert.equal(record.progress.phase, 'operator-action-required');
  assert.equal(record.result.error.code, 'NEO4J_RESTORE_INTERRUPTED_AFTER_LOAD');
  assert.match(record.result.error.safeMessage, /no rollback is claimed/i);
});
