const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BACKUP_OPERATION_KIND,
  BACKUP_STATES,
  BACKUP_TERMINAL_STATES,
  InfluxDb3EnterpriseNativeController,
  RESTORE_CONFIRMATION,
  RESTORE_OPERATION_KIND,
  RESTORE_STATES,
  RESTORE_TERMINAL_STATES,
  normalizeBackupName,
  normalizeBackupRecord,
  normalizeCreateBackupRequest,
  normalizeCreateRestoreRequest,
  normalizeRestoreId,
  normalizeRestoreRecord,
  reconstructBackupChain
} = require('./influxdb3-enterprise-native');

const CLUSTER_ID = 'cluster-001';
const DEPLOYMENT_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const CAPABILITY_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
const ROLE_FINGERPRINT = `sha256:${'c'.repeat(64)}`;
const TOKEN = 'private_admin_token_material_that_must_not_escape';
const RESTORE_ID = '01K1RESTORE000000000000001';

const CONNECTION = Object.freeze({
  host: 'enterprise.example.com',
  basePath: '/tenant',
  adminTokenSecretRefId: 'sec-admin',
  expectedVersion: '3.11.0',
  expectedStorageEngine: 'upgraded',
  expectedClusterId: CLUSTER_ID,
  expectedNodeId: 'node-01',
  expectedNodeCatalogId: 7,
  expectedInstanceId: 'instance-01',
  expectedRoleFingerprint: ROLE_FINGERPRINT,
  expectedDeploymentFingerprint: DEPLOYMENT_FINGERPRINT,
  expectedCapabilityFingerprint: CAPABILITY_FINGERPRINT
});

const IDENTITY = Object.freeze({
  version: Object.freeze({ text: '3.11.0', major: 3, minor: 11, patch: 0 }),
  storageEngine: 'upgraded',
  upgradedStorageEngine: true,
  clusterId: CLUSTER_ID,
  nodeId: 'node-01',
  nodeCatalogId: 7,
  instanceId: 'instance-01',
  roleFingerprint: ROLE_FINGERPRINT,
  deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
  capabilityFingerprint: CAPABILITY_FINGERPRINT,
  compactorCapable: true,
  nativeBackupAvailable: true
});

function response(statusCode, body, clusterId = CLUSTER_ID) {
  return { statusCode, headers: { 'cluster-uuid': clusterId }, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function full(name, status = 'completed', extra = {}) {
  return { backup_name: name, type: 'full', status, ...extra };
}

function incremental(name, parent, status = 'completed', extra = {}) {
  return { backup_name: name, type: 'incremental', parent, status, ...extra };
}

function fixture(handler, options = {}) {
  const observations = [];
  let identityReads = 0;
  const normalized = Object.freeze({ protocol: 'https', port: 8181, timeoutMs: 30000, allowInsecureHttp: false, caFile: null, ...CONNECTION });
  const adapter = {
    normalizeConfig: (input) => options.normalizeConfig ? options.normalizeConfig(input) : normalized,
    readIdentity: async () => {
      identityReads += 1;
      if (options.readIdentityError) throw options.readIdentityError;
      return options.identityForRead ? options.identityForRead(identityReads) : IDENTITY;
    },
    request: async (context, config, method, apiPath, body) => {
      const observation = { context, config, method, apiPath, body };
      observations.push(observation);
      return handler(observation, observations.length);
    }
  };
  const controller = new InfluxDb3EnterpriseNativeController({
    adapter,
    clock: () => '2026-08-05T12:00:00.000Z',
    now: options.now || (() => 100),
    sleep: options.sleep || (async () => {}),
    pollIntervalMs: options.pollIntervalMs ?? 0,
    operationTimeoutMs: options.operationTimeoutMs ?? 10000,
    maxPollAttempts: options.maxPollAttempts ?? 10
  });
  return { controller, observations, identityReads: () => identityReads };
}

function context(overrides = {}) {
  return { resolveSecret: async () => TOKEN, ...overrides };
}

function ownership(name) {
  return Object.freeze({ version: 1, operationKind: BACKUP_OPERATION_KIND, backupName: name, clusterId: CLUSTER_ID, storageEngine: 'upgraded', nodeId: 'node-01', nodeCatalogId: 7, instanceId: 'instance-01', roleFingerprint: ROLE_FINGERPRINT, deploymentFingerprint: DEPLOYMENT_FINGERPRINT, capabilityFingerprint: CAPABILITY_FINGERPRINT, acceptedAt: '2026-08-05T12:00:00.000Z' });
}

function mutation(restoreId = RESTORE_ID, backupName = 'inc-2') {
  return Object.freeze({ version: 1, operationKind: RESTORE_OPERATION_KIND, restoreId, backupName, clusterId: CLUSTER_ID, storageEngine: 'upgraded', nodeId: 'node-01', nodeCatalogId: 7, instanceId: 'instance-01', roleFingerprint: ROLE_FINGERPRINT, deploymentFingerprint: DEPLOYMENT_FINGERPRINT, capabilityFingerprint: CAPABILITY_FINGERPRINT, acceptedAt: '2026-08-05T12:00:00.000Z', targetMutationStarted: true });
}

function restoreRequest(backupName, overrides = {}) {
  return { connection: CONNECTION, backupName, confirmed: true, confirmationText: RESTORE_CONFIRMATION, ...overrides };
}

test('exports strict public normalizers, state constants, and immutable root-to-leaf chains', () => {
  assert.equal(BACKUP_STATES.IN_PROGRESS, 'in_progress');
  assert.equal(RESTORE_STATES.COMPLETED, 'completed');
  assert.equal(BACKUP_TERMINAL_STATES.has('failed'), true);
  assert.equal(RESTORE_TERMINAL_STATES.has('completed'), true);
  assert.equal(normalizeBackupName('base-20260805'), 'base-20260805');
  assert.equal(normalizeRestoreId(RESTORE_ID), RESTORE_ID);
  assert.deepEqual(normalizeCreateBackupRequest({ name: 'inc-1', type: 'incremental', parent: 'base' }), { name: 'inc-1', type: 'incremental', parentName: 'base' });
  assert.deepEqual(normalizeCreateRestoreRequest(restoreRequest('inc-1')), { backupName: 'inc-1' });
  assert.deepEqual(normalizeRestoreRecord({ restore_id: RESTORE_ID, backup_name: 'inc-1', status: 'in_progress' }), { id: RESTORE_ID, backupName: 'inc-1', status: 'in_progress', createdAt: null, completedAt: null });
  assert.throws(() => normalizeBackupName('../escape'), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_NAME_INVALID');
  assert.throws(() => normalizeRestoreId('id/other'), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RESTORE_ID_INVALID');
  assert.throws(() => normalizeCreateBackupRequest({ name: 'base', type: 'incremental', parent: 'base' }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_CHAIN_INVALID');
  assert.throws(() => normalizeCreateRestoreRequest({ backupName: 'base', confirmed: true, confirmationText: 'RESTORE' }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RESTORE_CONFIRMATION_REQUIRED');
  const backups = [normalizeBackupRecord(full('base')), normalizeBackupRecord(incremental('inc-1', 'base')), normalizeBackupRecord(incremental('inc-2', 'inc-1'))];
  const chain = reconstructBackupChain(backups, 'inc-2', { requireCompleted: true });
  assert.deepEqual(chain.map((item) => item.name), ['base', 'inc-1', 'inc-2']);
  assert.equal(Object.isFrozen(chain), true);
  const cyclic = [normalizeBackupRecord(incremental('a', 'b')), normalizeBackupRecord(incremental('b', 'a'))];
  assert.throws(() => reconstructBackupChain(cyclic, 'a'), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_CHAIN_INVALID');
});

test('lists and reads bounded backups and restores through exact encoded native API paths', async () => {
  const routes = new Map([
    ['GET /tenant/api/v3/enterprise/backup', response(200, { backups: [full('base')] })],
    ['GET /tenant/api/v3/enterprise/backup/base', response(200, full('base'))],
    ['GET /tenant/api/v3/enterprise/restore', response(200, { restores: [{ restore_id: RESTORE_ID, backup_name: 'base', status: 'completed' }] })],
    [`GET /tenant/api/v3/enterprise/restore/${RESTORE_ID}`, response(200, { restore_id: RESTORE_ID, backup_name: 'base', status: 'completed' })]
  ]);
  const current = fixture(({ method, apiPath }) => routes.get(`${method} ${apiPath}`));
  assert.deepEqual((await current.controller.listBackups(context(), { connection: CONNECTION })).backups.map((item) => item.name), ['base']);
  assert.equal((await current.controller.getBackup(context(), { connection: CONNECTION, name: 'base' })).backup.status, 'completed');
  assert.deepEqual((await current.controller.listRestores(context(), { connection: CONNECTION })).restores.map((item) => item.id), [RESTORE_ID]);
  assert.equal((await current.controller.getRestore(context(), { connection: CONNECTION, restoreId: RESTORE_ID })).restore.backupName, 'base');
  assert.deepEqual(current.observations.map((item) => `${item.method} ${item.apiPath}`), [...routes.keys()]);
  assert.equal(current.identityReads(), 4);
});

test('creates a full backup with force false and durably records ownership before exact-name polling', async () => {
  const order = [];
  let polls = 0;
  const current = fixture(({ method, apiPath, body }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [] });
    if (method === 'POST' && apiPath.endsWith('/backup')) {
      order.push('accepted');
      assert.deepEqual(body, { force: false, name: 'nightly', type: 'full' });
      return response(202, { backup_name: 'nightly', status: 'in_progress' });
    }
    if (method === 'GET' && apiPath.endsWith('/backup/nightly')) {
      order.push(`poll-${++polls}`);
      return response(200, full('nightly', polls === 1 ? 'in_progress' : 'completed', { backup_watermark: 42 }));
    }
    throw new Error('Unexpected route.');
  });
  const owned = [];
  const result = await current.controller.createBackup(context({ onOwnership: async (value) => { order.push('ownership'); owned.push(value); } }), { connection: CONNECTION, name: 'nightly', type: 'full' });
  assert.deepEqual(order, ['accepted', 'ownership', 'poll-1', 'poll-2']);
  assert.equal(owned[0].operationKind, BACKUP_OPERATION_KIND);
  assert.equal(owned[0].backupName, 'nightly');
  assert.equal(owned[0].clusterId, CLUSTER_ID);
  assert.equal(owned[0].storageEngine, 'upgraded');
  assert.equal(owned[0].nodeId, 'node-01');
  assert.equal(owned[0].nodeCatalogId, 7);
  assert.equal(result.backup.status, 'completed');
  assert.equal(result.backup.watermark, 42);
  assert.equal(result.consistency, 'application');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('fails closed instead of inventing the unpublished incremental backup HTTP request fields', async () => {
  const current = fixture(() => { throw new Error('Incremental mutation must remain gated.'); });
  await assert.rejects(current.controller.createBackup(context({ onOwnership: async () => {} }), { connection: CONNECTION, name: 'inc-2', type: 'incremental', parentName: 'inc-1' }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_INCREMENTAL_WIRE_CONTRACT_UNAVAILABLE');
  assert.equal(current.identityReads(), 0);
  assert.equal(current.observations.length, 0);
});

test('requires durable acceptance callbacks and bounds polling even when the clock never advances', async () => {
  let polls = 0;
  const current = fixture(({ method, apiPath }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [] });
    if (method === 'POST') return response(202, { backup_name: 'bounded', status: 'in_progress' });
    if (apiPath.endsWith('/backup/bounded')) { polls += 1; return response(200, full('bounded', 'in_progress')); }
    throw new Error('Unexpected route.');
  }, { maxPollAttempts: 2, now: () => 50 });
  await assert.rejects(current.controller.createBackup(context(), { connection: CONNECTION, name: 'missing-callback' }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_CALLBACK_REQUIRED');
  assert.equal(current.observations.length, 0);
  let ownershipCalls = 0;
  await assert.rejects(current.controller.createBackup(context({ onOwnership: async () => { ownershipCalls += 1; } }), { connection: CONNECTION, name: 'bounded' }), (error) => {
    assert.equal(error.code, 'INFLUXDB3_ENTERPRISE_BACKUP_POLL_LIMIT');
    assert.equal(error.details.ownershipPreserved, true);
    return true;
  });
  assert.equal(ownershipCalls, 1);
  assert.equal(polls, 2);
  assert.equal(current.observations.some((item) => item.method === 'DELETE'), false);

  const times = [0, 2];
  const deadline = fixture(({ method, apiPath }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [] });
    if (method === 'POST') return response(202, { backup_name: 'deadline', status: 'in_progress' });
    throw new Error('Polling must not pass the elapsed-time deadline.');
  }, { operationTimeoutMs: 1, now: () => times.shift() ?? 2, maxPollAttempts: 10 });
  let deadlineOwned = false;
  await assert.rejects(deadline.controller.createBackup(context({ onOwnership: async () => { deadlineOwned = true; } }), { connection: CONNECTION, name: 'deadline' }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_POLL_TIMEOUT');
  assert.equal(deadlineOwned, true);
  assert.equal(deadline.observations.filter((item) => item.apiPath.endsWith('/backup/deadline')).length, 0);
});

test('does not start a destructive restore without exact confirmation and an authenticated backup watermark', async () => {
  const current = fixture(({ method, apiPath }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [full('base')] });
    throw new Error('Restore creation must not be attempted without a watermark.');
  });
  await assert.rejects(current.controller.createRestore(context({ onMutationStarted: async () => {} }), { connection: CONNECTION, backupName: 'base', confirmed: true, confirmationText: 'RESTORE' }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RESTORE_CONFIRMATION_REQUIRED');
  assert.equal(current.observations.length, 0);
  await assert.rejects(current.controller.createRestore(context({ onMutationStarted: async () => {} }), restoreRequest('base')), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_WATERMARK_UNPROVEN');
  assert.equal(current.observations.some((item) => item.method === 'POST'), false);
});

test('persists the exact accepted restore ID before polling and returns live rollback safety evidence', async () => {
  const order = [];
  let polls = 0;
  const backups = [full('base', 'completed', { backup_watermark: 'wal-100' }), incremental('inc-1', 'base', 'completed', { backup_watermark: 'wal-200' }), incremental('inc-2', 'inc-1', 'completed', { backup_watermark: 'wal-300' })];
  const current = fixture(({ method, apiPath, body }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups });
    if (method === 'POST' && apiPath.endsWith('/restore')) {
      order.push('accepted');
      assert.deepEqual(body, { backup_name: 'inc-2' });
      return response(202, { restore_id: RESTORE_ID, status: 'in_progress' });
    }
    if (method === 'GET' && apiPath.endsWith(`/restore/${RESTORE_ID}`)) {
      order.push(`poll-${++polls}`);
      return response(200, { restore_id: RESTORE_ID, backup_name: 'inc-2', status: polls === 1 ? 'in_progress' : 'completed' });
    }
    throw new Error('Unexpected route.');
  });
  const persisted = [];
  const result = await current.controller.createRestore(context({ onMutationStarted: async (value) => { order.push('mutation'); persisted.push(value); } }), restoreRequest('inc-2'));
  assert.deepEqual(order, ['accepted', 'mutation', 'poll-1', 'poll-2']);
  assert.equal(persisted[0].restoreId, RESTORE_ID);
  assert.equal(persisted[0].targetMutationStarted, true);
  assert.equal(persisted[0].clusterId, CLUSTER_ID);
  assert.equal(persisted[0].storageEngine, 'upgraded');
  assert.equal(persisted[0].nodeId, 'node-01');
  assert.equal(current.identityReads(), 2);
  assert.equal(result.evidence.restoreMode, 'live-cluster-in-place');
  assert.equal(result.evidence.effect, 'point-in-time-rollback');
  assert.equal(result.evidence.walTruncatedToBackupWatermark, true);
  assert.equal(result.evidence.backupWatermark, 'wal-300');
  assert.equal(result.evidence.rowDeleteStateCapturedByBackup, false);
  assert.equal(result.evidence.rowDeletesMayPersist, true);
  assert.equal(result.evidence.identityRevalidated, true);
  assert.deepEqual(result.evidence.compactorEndpoint, { nodeId: 'node-01', nodeCatalogId: 7, instanceId: 'instance-01', roleFingerprint: ROLE_FINGERPRINT });
});

test('classifies the cluster-wide restore conflict without exposing the response body', async () => {
  const current = fixture(({ method, apiPath }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [full('base', 'completed', { backup_watermark: 'wal-100' })] });
    if (method === 'POST' && apiPath.endsWith('/restore')) return response(409, TOKEN);
    throw new Error('Unexpected route.');
  });
  let callbackCalled = false;
  await assert.rejects(current.controller.createRestore(context({ onMutationStarted: async () => { callbackCalled = true; } }), restoreRequest('base')), (error) => {
    assert.equal(error.code, 'INFLUXDB3_ENTERPRISE_RESTORE_CONFLICT');
    assert.equal(String(error).includes(TOKEN), false);
    assert.equal(JSON.stringify(error.details).includes(TOKEN), false);
    return true;
  });
  assert.equal(callbackCalled, false);
});

test('cancels only exact owned in-progress operations and never infers ownership from a name or ID', async () => {
  const current = fixture(({ method, apiPath, body }) => {
    if (method === 'GET' && apiPath.endsWith('/backup/running')) return response(200, full('running', 'in_progress'));
    if (method === 'DELETE' && apiPath.endsWith('/backup')) { assert.deepEqual(body, { name: 'running' }); return response(200, { backup_name: 'running' }); }
    if (method === 'GET' && apiPath.endsWith(`/restore/${RESTORE_ID}`)) return response(200, { restore_id: RESTORE_ID, backup_name: 'inc-2', status: 'in_progress' });
    if (method === 'DELETE' && apiPath.endsWith(`/restore/${RESTORE_ID}`)) { assert.equal(body, null); return response(204, ''); }
    throw new Error('Unexpected route.');
  });
  assert.equal((await current.controller.cancelBackup(context(), { connection: CONNECTION, name: 'running', ownership: ownership('running') })).cancellationAccepted, true);
  assert.equal((await current.controller.cancelRestore(context(), { connection: CONNECTION, restoreId: RESTORE_ID, mutation: mutation() })).cancellationAccepted, true);
  await assert.rejects(current.controller.cancelBackup(context(), { connection: CONNECTION, name: 'running', ownership: { ...ownership('other'), backupName: 'other' } }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_INVALID');
  assert.equal(current.observations.filter((item) => item.method === 'DELETE').length, 2);
});

test('previews incremental deletion descendants leaf-first without issuing any DELETE', async () => {
  const backups = [full('base'), incremental('inc-1', 'base'), incremental('inc-2', 'inc-1'), incremental('inc-3', 'inc-2'), full('other')];
  const current = fixture(({ method, apiPath }) => {
    assert.equal(method, 'GET');
    assert.equal(apiPath.endsWith('/backup'), true);
    return response(200, { backups });
  });
  const preview = await current.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'inc-1' });
  assert.deepEqual(preview.descendants.map((item) => item.name), ['inc-3', 'inc-2']);
  assert.deepEqual(preview.deletionOrder, ['inc-3', 'inc-2', 'inc-1']);
  assert.match(preview.closureFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(preview.providerCascade, true);
  assert.equal(preview.completedOnly, true);
  assert.equal(preview.ownershipVerified, false);
  assert.equal(preview.previewOnly, true);
  assert.equal(preview.deleteIssued, false);
  assert.equal(current.observations.some((item) => item.method === 'DELETE'), false);
});

test('deletes one exact completed owned closure through the single provider cascade request', async () => {
  const backups = [full('base'), incremental('inc-1', 'base'), incremental('inc-2', 'inc-1'), incremental('inc-3', 'inc-2'), full('other')];
  let deleted = false;
  const current = fixture(({ method, apiPath, body }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: deleted ? [full('base'), full('other')] : backups });
    if (method === 'DELETE' && apiPath.endsWith('/backup')) {
      assert.deepEqual(body, { name: 'inc-1' });
      deleted = true;
      return response(200, { backup_name: 'inc-1' });
    }
    throw new Error('Unexpected route.');
  });
  const preview = await current.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'inc-1' });
  const result = await current.controller.deleteBackup(context(), {
    connection: CONNECTION,
    name: 'inc-1',
    ownerships: preview.deletionOrder.map(ownership),
    expectedDeletionOrder: preview.deletionOrder,
    expectedClosureFingerprint: preview.closureFingerprint
  });
  assert.equal(result.deletionAccepted, true);
  assert.equal(result.evidence.targetName, 'inc-1');
  assert.deepEqual(result.evidence.deletionOrder, ['inc-3', 'inc-2', 'inc-1']);
  assert.equal(result.evidence.closureFingerprint, preview.closureFingerprint);
  assert.equal(result.evidence.memberCount, 3);
  assert.equal(result.evidence.cascadeCount, 2);
  assert.equal(result.evidence.exactOwnershipVerified, true);
  assert.equal(result.evidence.responseClusterVerified, true);
  assert.equal(result.evidence.deletionConfirmed, true);
  assert.equal(result.evidence.reconciliationRequired, false);
  assert.equal(current.observations.filter((item) => item.method === 'DELETE').length, 1);
  assert.deepEqual(current.observations.map((item) => item.method), ['GET', 'GET', 'DELETE', 'GET']);
  assert.equal(current.identityReads(), 3);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('fails closed when the reviewed descendant closure becomes stale before deletion', async () => {
  const reviewed = [full('base'), incremental('inc-1', 'base'), incremental('inc-2', 'inc-1'), incremental('inc-3', 'inc-2')];
  let listings = 0;
  const current = fixture(({ method, apiPath }) => {
    assert.equal(method, 'GET');
    assert.equal(apiPath.endsWith('/backup'), true);
    listings += 1;
    const backups = listings === 1 ? reviewed : [...reviewed, incremental('inc-4', 'inc-3')];
    return response(200, { backups });
  });
  const preview = await current.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'inc-1' });
  await assert.rejects(current.controller.deleteBackup(context(), {
    connection: CONNECTION,
    name: 'inc-1',
    ownerships: preview.deletionOrder.map(ownership),
    expectedDeletionOrder: preview.deletionOrder,
    expectedClosureFingerprint: preview.closureFingerprint
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_REVIEW_STALE' && error.details.reviewRequired === true);
  assert.equal(current.observations.some((item) => item.method === 'DELETE'), false);
});

test('fails closed when a reviewed backup name is reused with changed provider identity', async (t) => {
  const originalIdentity = {
    backup_watermark: 'wal-100',
    backup_generation: 'generation-1',
    created_at: '2026-08-05T01:00:00.000Z',
    completed_at: '2026-08-05T01:00:05.000Z'
  };
  const replacements = [
    ['watermark', { backup_watermark: 'wal-101' }],
    ['generation', { backup_generation: 'generation-2' }],
    ['creation timestamp', { created_at: '2026-08-05T02:00:00.000Z' }],
    ['completion timestamp', { completed_at: '2026-08-05T02:00:05.000Z' }]
  ];
  for (const [label, replacement] of replacements) {
    await t.test(label, async () => {
      let listings = 0;
      const current = fixture(({ method, apiPath }) => {
        assert.equal(method, 'GET');
        assert.equal(apiPath.endsWith('/backup'), true);
        listings += 1;
        const providerIdentity = listings === 1 ? originalIdentity : { ...originalIdentity, ...replacement };
        return response(200, { backups: [full('base', 'completed', providerIdentity)] });
      });
      const preview = await current.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'base' });
      assert.equal(preview.target.generation, 'generation-1');
      await assert.rejects(current.controller.deleteBackup(context(), {
        connection: CONNECTION,
        name: 'base',
        ownerships: [ownership('base')],
        expectedDeletionOrder: preview.deletionOrder,
        expectedClosureFingerprint: preview.closureFingerprint
      }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_REVIEW_STALE' && error.details.reviewRequired === true);
      assert.equal(current.observations.some((item) => item.method === 'DELETE'), false);
    });
  }
});

test('requires one exact durable authenticated ownership for every deletion member', async () => {
  const backups = [full('base'), incremental('inc-1', 'base'), incremental('inc-2', 'inc-1')];
  const current = fixture(({ method, apiPath }) => {
    assert.equal(method, 'GET');
    assert.equal(apiPath.endsWith('/backup'), true);
    return response(200, { backups });
  });
  const preview = await current.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'inc-1' });
  const reviewed = {
    connection: CONNECTION,
    name: 'inc-1',
    expectedDeletionOrder: preview.deletionOrder,
    expectedClosureFingerprint: preview.closureFingerprint
  };
  await assert.rejects(current.controller.deleteBackup(context(), { ...reviewed, ownerships: [ownership('inc-1')] }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_INVALID');
  await assert.rejects(current.controller.deleteBackup(context(), {
    ...reviewed,
    ownerships: [ownership('inc-2'), { ...ownership('inc-1'), clusterId: 'cluster-002' }]
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_INVALID');
  await assert.rejects(current.controller.deleteBackup(context(), {
    ...reviewed,
    ownerships: [ownership('inc-2'), { ...ownership('inc-1'), acceptedAt: null }]
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_INVALID');
  assert.equal(current.observations.some((item) => item.method === 'DELETE'), false);
});

test('rejects in-progress and failed closure members before issuing completed-backup deletion', async () => {
  for (const status of ['in_progress', 'failed']) {
    const current = fixture(({ method, apiPath }) => {
      assert.equal(method, 'GET');
      assert.equal(apiPath.endsWith('/backup'), true);
      return response(200, { backups: [full(`blocked-${status}`, status)] });
    });
    const name = `blocked-${status}`;
    const preview = await current.controller.previewDeleteBackup(context(), { connection: CONNECTION, name });
    assert.equal(preview.completedOnly, false);
    await assert.rejects(current.controller.deleteBackup(context(), {
      connection: CONNECTION,
      name,
      ownerships: [ownership(name)],
      expectedDeletionOrder: preview.deletionOrder,
      expectedClosureFingerprint: preview.closureFingerprint
    }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_NOT_COMPLETED' && error.details.status === status);
    assert.equal(current.observations.some((item) => item.method === 'DELETE'), false);
  }
});

test('validates completed-backup deletion response identity and exact accepted name', async () => {
  async function invoke(deleteResponse) {
    const current = fixture(({ method, apiPath }) => {
      if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [full('base')] });
      if (method === 'DELETE' && apiPath.endsWith('/backup')) return deleteResponse;
      throw new Error('Unexpected route.');
    });
    const preview = await current.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'base' });
    return current.controller.deleteBackup(context(), {
      connection: CONNECTION,
      name: 'base',
      ownerships: [ownership('base')],
      expectedDeletionOrder: preview.deletionOrder,
      expectedClosureFingerprint: preview.closureFingerprint
    });
  }
  await assert.rejects(invoke(response(200, { backup_name: 'base' }, 'cluster-002')), (error) => error.code === 'INFLUXDB3_ENTERPRISE_CLUSTER_CHANGED');
  await assert.rejects(invoke(response(200, { backup_name: 'other' })), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_RESPONSE_INVALID');
  await assert.rejects(invoke(response(200, {})), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_RESPONSE_INVALID');
});

test('returns redacted unconfirmed evidence when accepted deletion is not absent or identity drifts', async () => {
  const remaining = fixture(({ method, apiPath }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [full('base')] });
    if (method === 'DELETE' && apiPath.endsWith('/backup')) return response(200, { backup_name: 'base' });
    throw new Error('Unexpected route.');
  });
  const remainingPreview = await remaining.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'base' });
  await assert.rejects(remaining.controller.deleteBackup(context(), {
    connection: CONNECTION,
    name: 'base',
    ownerships: [ownership('base')],
    expectedDeletionOrder: remainingPreview.deletionOrder,
    expectedClosureFingerprint: remainingPreview.closureFingerprint
  }), (error) => {
    assert.equal(error.code, 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_UNCONFIRMED');
    assert.deepEqual(error.details, { operationAccepted: true, reconciliationRequired: true });
    return true;
  });

  const drifted = fixture(({ method, apiPath }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [full('base')] });
    if (method === 'DELETE' && apiPath.endsWith('/backup')) return response(200, { backup_name: 'base' });
    throw new Error('Post-delete listing must not run after identity drift.');
  }, { identityForRead: (read) => read < 3 ? IDENTITY : { ...IDENTITY, clusterId: 'cluster-002' } });
  const driftedPreview = await drifted.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'base' });
  await assert.rejects(drifted.controller.deleteBackup(context(), {
    connection: CONNECTION,
    name: 'base',
    ownerships: [ownership('base')],
    expectedDeletionOrder: driftedPreview.deletionOrder,
    expectedClosureFingerprint: driftedPreview.closureFingerprint
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_UNCONFIRMED' && error.details.operationAccepted === true);

  const capabilityDrifted = fixture(({ method, apiPath }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [full('base')] });
    if (method === 'DELETE' && apiPath.endsWith('/backup')) return response(200, { backup_name: 'base' });
    throw new Error('Post-delete listing must not run after capability drift.');
  }, { identityForRead: (read) => read < 3 ? IDENTITY : { ...IDENTITY, nativeBackupAvailable: false } });
  const capabilityPreview = await capabilityDrifted.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'base' });
  await assert.rejects(capabilityDrifted.controller.deleteBackup(context(), {
    connection: CONNECTION,
    name: 'base',
    ownerships: [ownership('base')],
    expectedDeletionOrder: capabilityPreview.deletionOrder,
    expectedClosureFingerprint: capabilityPreview.closureFingerprint
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_UNCONFIRMED' && error.details.reconciliationRequired === true);
});

test('redacts post-delete confirmation-list failures after provider acceptance', async () => {
  let listings = 0;
  const current = fixture(({ method, apiPath }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) {
      listings += 1;
      if (listings === 3) throw new Error(TOKEN);
      return response(200, { backups: [full('base')] });
    }
    if (method === 'DELETE' && apiPath.endsWith('/backup')) return response(200, { backup_name: 'base' });
    throw new Error('Unexpected route.');
  });
  const preview = await current.controller.previewDeleteBackup(context(), { connection: CONNECTION, name: 'base' });
  await assert.rejects(current.controller.deleteBackup(context(), {
    connection: CONNECTION,
    name: 'base',
    ownerships: [ownership('base')],
    expectedDeletionOrder: preview.deletionOrder,
    expectedClosureFingerprint: preview.closureFingerprint
  }), (error) => {
    assert.equal(error.code, 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_UNCONFIRMED');
    assert.equal(String(error).includes(TOKEN), false);
    assert.equal(JSON.stringify(error.details).includes(TOKEN), false);
    return true;
  });
});

test('fails closed for unpinned connections, identity drift, oversized responses, and thrown secret text', async () => {
  let identityRead = false;
  const unpinned = fixture(() => { throw new Error('No request expected.'); }, {
    normalizeConfig: () => ({ ...CONNECTION, basePath: '', expectedCapabilityFingerprint: null }),
    readIdentityError: new Error('must not run')
  });
  unpinned.controller.adapter.readIdentity = async () => { identityRead = true; return IDENTITY; };
  await assert.rejects(unpinned.controller.listBackups(context(), { connection: CONNECTION }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_NATIVE_CONNECTION_UNPINNED');
  assert.equal(identityRead, false);

  const changed = fixture(({ method, apiPath }) => {
    if (method === 'GET' && apiPath.endsWith('/backup')) return response(200, { backups: [full('base', 'completed', { backup_watermark: 'wal-100' })] });
    if (method === 'POST') return response(202, { restore_id: RESTORE_ID, status: 'in_progress' });
    if (method === 'GET' && apiPath.endsWith(RESTORE_ID)) return response(200, { restore_id: RESTORE_ID, backup_name: 'base', status: 'completed' });
    throw new Error('Unexpected route.');
  }, { identityForRead: (read) => read === 1 ? IDENTITY : { ...IDENTITY, clusterId: 'cluster-002' } });
  await assert.rejects(changed.controller.createRestore(context({ onMutationStarted: async () => {} }), restoreRequest('base')), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RESTORE_IDENTITY_CHANGED');

  const oversized = fixture(() => response(200, 'x'.repeat((1024 * 1024) + 1)));
  await assert.rejects(oversized.controller.listBackups(context(), { connection: CONNECTION }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RESPONSE_TOO_LARGE');

  const thrown = fixture(() => { throw new Error(TOKEN); });
  await assert.rejects(thrown.controller.listBackups(context(), { connection: CONNECTION }), (error) => {
    assert.equal(error.code, 'INFLUXDB3_ENTERPRISE_NATIVE_REQUEST_FAILED');
    return !String(error).includes(TOKEN);
  });
});
