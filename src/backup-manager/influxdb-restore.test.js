const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { ADAPTER_ID, RESTORE_CONFIRMATION } = require('./influxdb');
const { InfluxDbRestoreService } = require('./influxdb-restore');

function fingerprint(members) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(members)).digest('hex')}`;
}

test('cancellation after native mutation preserves the alternate target and claims no rollback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb-restore-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  t.after(() => controlDatabase.close());
  const targetConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Alternate InfluxDB', kind: 'database', adapterId: ADAPTER_ID, adapterVersion: '0.3.0',
    endpoint: { protocol: 'https', host: 'alternate.example.com', tokenSecretRefId: 'secret-a', cliPath: 'influx', expectedVersion: '2.7.11', expectedCliVersion: '2.7.5', expectedDeploymentFingerprint: `sha256:${'a'.repeat(64)}` }, secretRefIds: [], workerAffinity: ['device:device-a'],
    lastTest: { status: 'success', endpointIdentity: { version: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: `sha256:${'a'.repeat(64)}` } }, trust: { fingerprint: `sha256:${'a'.repeat(64)}` }
  });
  const source = await controlDatabase.repository('source').create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'Protected InfluxDB', connectionId: targetConnection.id, sourceType: 'database', adapterId: ADAPTER_ID, enabled: true });
  const policy = await controlDatabase.repository('policy').create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'Restore fixture', enabled: true, backupMode: 'full', notificationRouteIds: [] });
  const repository = await controlDatabase.repository('repository').create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'Restore fixture repository', connectionId: null, adapterId: 'deployerx.repository.local-folder', engineId: 'deployerx.repository-engine', secretRefIds: [], encryptionKeyRefId: null });
  const job = await controlDatabase.repository('backupJob').create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'Restore fixture job', sourceId: source.id, policyId: policy.id, state: 'enabled', repositoryBindings: [{ repositoryId: repository.id, role: 'primary' }] });
  const { run } = await controlDatabase.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId: 'workspace-a', actorId: 'tester', jobId: job.id, jobRevision: job.revision, trigger: 'manual', idempotencyKey: 'influx-restore-cancel', state: 'pending' });
    return { run: transaction.create('run', { workspaceId: 'workspace-a', actorId: 'tester', jobId: job.id, jobRevision: job.revision, executionGroupId: group.id, idempotencyKey: 'influx-restore-cancel:1', trigger: 'manual', workerId: 'device:device-a', state: 'queued', attempt: 1, configSnapshot: {} }) };
  });
  const recoveryPointId = 'rp_019fc700-0000-7000-8000-000000000099';
  const recoveryPoint = await controlDatabase.repository('recoveryPoint').create({ id: recoveryPointId, workspaceId: 'workspace-a', actorId: 'tester', jobId: job.id, sourceId: source.id, runId: run.id, type: 'full', consistency: 'application', chainRootId: recoveryPointId, capturedFrom: '2026-08-05T12:00:00.000Z', capturedTo: '2026-08-05T12:01:00.000Z', repositoryCopies: [{ repositoryId: repository.id, engineSnapshotId: 'snapshot-a', state: 'available' }], verification: { state: 'succeeded' }, retention: { deletionEligible: false } });
  const bytes = Buffer.from('native-manifest');
  const memberEvidence = [{ relativePath: 'backup.manifest', sizeBytes: bytes.length, contentDigest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` }];
  const mediaFingerprint = fingerprint(memberEvidence);
  let mutationResolve;
  const mutationStarted = new Promise((resolve) => { mutationResolve = resolve; });
  const adapter = {
    planRestore: async (_context, request) => ({ operation: 'influxdb-oss-v2-alternate-restore', connection: request.connection, source: request.source, target: { productVersion: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: `sha256:${'a'.repeat(64)}`, inventoryFingerprint: `sha256:${'b'.repeat(64)}` } }),
    executeRestore: async (context) => {
      await context.onMutationStarted(); mutationResolve();
      await new Promise((resolve, reject) => {
        if (context.signal.aborted) return reject(Object.assign(new Error('canceled native detail'), { code: 'INFLUXDB_RESTORE_CANCELED', category: 'canceled' }));
        context.signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled native detail'), { code: 'INFLUXDB_RESTORE_CANCELED', category: 'canceled' })), { once: true });
      });
    },
    validateRestore: async () => { throw new Error('Validation must not run after cancellation.'); }
  };
  const connectionService = { withExecution: async (_workspaceId, connection, signal, callback) => callback({ signal }, connection.endpoint) };
  const service = new InfluxDbRestoreService({ controlDatabase, deviceId: 'device-a', adapter, connectionService, openRepository: async () => { throw new Error('unused'); }, temporaryRoot: path.join(root, 'stage') });
  service.authenticateRecoveryPoint = async () => ({
    point: recoveryPoint, source, repositoryId: repository.id, totalBytes: bytes.length,
    metadata: {
      source: { product: 'influxdb-oss-v2', productVersion: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: `sha256:${'c'.repeat(64)}` },
      scope: { type: 'organization', organizationId: '0123456789abcdef', organizationName: 'Production', bucketId: null, bucketName: null, buckets: [] },
      nativeMedia: { fileCount: 1, totalBytes: bytes.length, mediaFingerprint }
    },
    members: [{ ...memberEvidence[0], repositoryPath: 'influxdb/native/backup.manifest' }],
    opened: { masterKey: Buffer.alloc(32), engine: { streamFile: async function* () { yield bytes; } } }, snapshot: { manifest: {} }
  });
  const started = await service.start('workspace-a', 'tester', { recoveryPointId: recoveryPoint.id, targetConnectionId: targetConnection.id, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
  await mutationStarted;
  const canceled = await service.cancel('workspace-a', 'tester', started.id);
  assert.equal(canceled.state, 'interrupted');
  assert.equal(canceled.target.nativeMutationStarted, true);
  assert.equal(canceled.result.targetPreserved, true);
  assert.equal(canceled.result.rollbackClaimed, false);
  assert.equal(canceled.result.error.code, 'INFLUXDB_RESTORE_TARGET_REQUIRES_INSPECTION');
  assert.equal(JSON.stringify(canceled).includes('canceled native detail'), false);
  assert.equal((await service.list('workspace-a')).length, 1);
  assert.deepEqual(await fs.readdir(path.join(root, 'stage')), []);
});
