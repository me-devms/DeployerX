const test = require('node:test');
const assert = require('node:assert/strict');

const { ADAPTER_ID, NATIVE_CONSISTENCY_METHOD } = require('./influxdb3-enterprise');
const { BACKUP_STATES, RESTORE_STATES } = require('./influxdb3-enterprise-native');
const { SOURCE_LEASE_KIND } = require('./influxdb3-enterprise-source-reader');
const {
  DELETE_CONFIRMATION,
  InfluxDb3EnterpriseRetentionService,
  stableDigest
} = require('./influxdb3-enterprise-retention');

const WORKSPACE_ID = 'workspace-retention';
const DEVICE_ID = 'device-retention';
const SOURCE_ID = 'source-retention';
const CONNECTION_ID = 'connection-retention';
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const CAPABILITY_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
const ROLE_FINGERPRINT = `sha256:${'c'.repeat(64)}`;

function execution() {
  return {
    productVersion: '3.11.0',
    clusterId: 'cluster-retention',
    storageEngine: 'upgraded',
    nodeId: 'node-compactor',
    nodeCatalogId: 7,
    instanceId: 'instance-retention',
    roleFingerprint: ROLE_FINGERPRINT,
    deploymentFingerprint: FINGERPRINT,
    capabilityFingerprint: CAPABILITY_FINGERPRINT,
    compactorCapable: true,
    nativeBackupAvailable: true,
    connectionRevision: 4
  };
}

function identity() {
  const value = execution();
  return {
    version: value.productVersion,
    clusterId: value.clusterId,
    storageEngine: value.storageEngine,
    nodeId: value.nodeId,
    nodeCatalogId: value.nodeCatalogId,
    instanceId: value.instanceId,
    roleFingerprint: value.roleFingerprint,
    deploymentFingerprint: value.deploymentFingerprint,
    capabilityFingerprint: value.capabilityFingerprint,
    compactorCapable: true,
    nativeBackupAvailable: true
  };
}

function source() {
  return {
    id: SOURCE_ID,
    revision: 2,
    connectionId: CONNECTION_ID,
    adapterId: ADAPTER_ID,
    adapterVersion: '1.0.0',
    sourceType: 'database',
    enabled: true,
    consistency: { backupMethod: 'physical', backupMode: 'full', method: NATIVE_CONSISTENCY_METHOD }
  };
}

function point(id, runId, options = {}) {
  return {
    id,
    revision: options.revision || 1,
    sourceId: SOURCE_ID,
    runId,
    type: options.type || 'full',
    parentRecoveryPointId: options.parentRecoveryPointId || null,
    chainRootId: options.chainRootId || id,
    consistency: 'application',
    verification: { state: 'succeeded' },
    retention: { deletionEligible: options.deletionEligible !== false, legalHold: Boolean(options.legalHold) },
    repositoryCopies: [{ repositoryId: 'repository-retention', state: 'available', immutableUntil: options.immutableUntil || null }]
  };
}

function backup(name, options = {}) {
  return {
    name,
    type: options.type || 'full',
    parentName: options.parentName || null,
    status: options.status || BACKUP_STATES.COMPLETED,
    watermark: options.watermark || `watermark-${name}`,
    createdAt: '2026-08-05T01:00:00.000Z',
    completedAt: '2026-08-05T01:00:05.000Z'
  };
}

function ownership(name) {
  const value = execution();
  return {
    version: 1,
    operationKind: NATIVE_CONSISTENCY_METHOD,
    backupName: name,
    clusterId: value.clusterId,
    storageEngine: value.storageEngine,
    nodeId: value.nodeId,
    nodeCatalogId: value.nodeCatalogId,
    instanceId: value.instanceId,
    roleFingerprint: value.roleFingerprint,
    deploymentFingerprint: value.deploymentFingerprint,
    capabilityFingerprint: value.capabilityFingerprint,
    acceptedAt: '2026-08-05T01:00:00.000Z'
  };
}

function run(id, name, options = {}) {
  return {
    id,
    jobId: 'job-retention',
    state: options.state || 'succeeded',
    sourceLease: {
      version: 1,
      kind: SOURCE_LEASE_KIND,
      state: 'released',
      ownerId: stableDigest({ workspaceId: WORKSPACE_ID, executionId: id }),
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID,
      executionId: id,
      connectionId: CONNECTION_ID,
      backupName: name,
      ownership: ownership(name),
      releaseReason: 'repository-committed'
    }
  };
}

function authenticated(pointValue, backupValue) {
  return {
    point: pointValue,
    source: source(),
    execution: execution(),
    metadata: {
      operation: {
        backupName: backupValue.name,
        backupType: backupValue.type,
        status: backupValue.status,
        watermark: backupValue.watermark
      }
    },
    metadataDigest: stableDigest({ pointId: pointValue.id, backupName: backupValue.name })
  };
}

function connection() {
  const value = execution();
  const tested = identity();
  return {
    id: CONNECTION_ID,
    revision: value.connectionRevision,
    adapterId: ADAPTER_ID,
    workerAffinity: [`device:${DEVICE_ID}`],
    secretRefIds: ['secret-admin-token'],
    endpoint: {
      protocol: 'https',
      host: 'private.invalid',
      port: 8181,
      expectedVersion: value.productVersion,
      expectedStorageEngine: value.storageEngine,
      expectedClusterId: value.clusterId,
      expectedNodeId: value.nodeId,
      expectedNodeCatalogId: value.nodeCatalogId,
      expectedInstanceId: value.instanceId,
      expectedRoleFingerprint: value.roleFingerprint,
      expectedDeploymentFingerprint: value.deploymentFingerprint,
      expectedCapabilityFingerprint: value.capabilityFingerprint
    },
    trust: {
      fingerprint: value.deploymentFingerprint,
      clusterId: value.clusterId,
      nodeId: value.nodeId,
      nodeCatalogId: value.nodeCatalogId,
      instanceId: value.instanceId,
      roleFingerprint: value.roleFingerprint,
      capabilityFingerprint: value.capabilityFingerprint
    },
    lastTest: { status: 'success', endpointIdentity: tested }
  };
}

function fixture(options = {}) {
  const backups = options.backups || [backup('base')];
  const points = options.points || [point('rp-base', 'run-base', options.pointOptions)];
  const runs = options.runs || [run('run-base', 'base')];
  const authentications = new Map();
  for (const pointValue of points) {
    const remote = backups.find((candidate) => candidate.name === (pointValue.id === 'rp-base' ? 'base' : pointValue.id.replace(/^rp-/, '')));
    if (remote) authentications.set(pointValue.id, authenticated(pointValue, remote));
  }
  for (const [id, value] of Object.entries(options.authentications || {})) authentications.set(id, value);
  const records = {
    recoveryPoint: points,
    source: [source()],
    artifact: options.artifacts || points.map((pointValue) => {
      const value = authentications.get(pointValue.id);
      return { id: `artifact-${pointValue.id}`, recoveryPointId: pointValue.id, kind: 'metadata', metadata: { adapterId: ADAPTER_ID, kind: SOURCE_LEASE_KIND, operation: { backupName: value?.metadata.operation.backupName } } };
    }),
    run: runs,
    backupJob: [{ id: 'job-retention', sourceId: SOURCE_ID }],
    restoreRun: options.restores || [],
    verificationRun: options.verifications || [],
    connection: [connection()]
  };
  const calls = { authenticate: [], delete: [], projected: [] };
  const repositories = Object.fromEntries(Object.entries(records).map(([type, values]) => [type, {
    async get(_workspaceId, id) { return structuredClone(values.find((value) => value.id === id) || null); },
    async list() { return structuredClone(values); }
  }]));
  const controlDatabase = {
    repository(type) { return repositories[type]; },
    async transaction(callback) {
      if (options.beforeTransaction) await options.beforeTransaction({ records, calls });
      const transaction = {
        get(type, _workspaceId, id) { return structuredClone(records[type].find((value) => value.id === id) || null); },
        list(type) { return structuredClone(records[type]); },
        projectRecoveryPointRetention(_workspaceId, id, retention, projectionOptions) {
          const index = records.recoveryPoint.findIndex((value) => value.id === id);
          const current = records.recoveryPoint[index];
          assert.equal(projectionOptions.expectedRevision, current.revision);
          const currentClaimId = current.retention?.nativeMediaDeletionClaim?.claimId;
          if (currentClaimId) assert.equal(projectionOptions.nativeMediaDeletionClaimId, currentClaimId);
          if (options.failReconciliationMark && retention.nativeMediaDeletionClaim?.state === 'reconciliation-required') throw new Error('simulated process termination');
          const projected = { ...current, retention: structuredClone(retention), revision: current.revision + 1 };
          records.recoveryPoint[index] = projected;
          calls.projected.push(projected);
          return structuredClone(projected);
        }
      };
      return callback(transaction);
    }
  };
  const closureFingerprint = `sha256:${'d'.repeat(64)}`;
  const nativeController = {
    async previewDeleteBackup(_context, request) {
      const target = backups.find((value) => value.name === request.name);
      const descendants = backups.filter((value) => value.name !== request.name);
      return {
        identity: identity(),
        target,
        descendants,
        deletionOrder: options.deletionOrder || [...descendants.map((value) => value.name).reverse(), request.name],
        closureFingerprint,
        completedOnly: backups.every((value) => value.status === BACKUP_STATES.COMPLETED)
      };
    },
    async listBackups() { return { identity: identity(), backups: structuredClone(backups) }; },
    async listRestores() { return { identity: identity(), restores: structuredClone(options.nativeRestores || []) }; },
    async deleteBackup(_context, request) {
      calls.delete.push(structuredClone(request));
      if (options.onDelete) await options.onDelete({ backups, records, request });
      if (options.deleteError) throw options.deleteError;
      return {
        identity: identity(),
        deletionAccepted: true,
        evidence: {
          deletionConfirmed: true,
          reconciliationRequired: false,
          closureFingerprint,
          deletionOrder: request.expectedDeletionOrder,
          memberCount: request.expectedDeletionOrder.length
        }
      };
    }
  };
  const recoveryPointAuthenticator = {
    async authenticateRecoveryPoint(_workspaceId, id, authenticationOptions) {
      calls.authenticate.push({ id, options: authenticationOptions });
      const value = authentications.get(id);
      if (!value) throw new Error('RecoveryPoint is not authenticated.');
      return structuredClone(value);
    }
  };
  const createService = () => new InfluxDb3EnterpriseRetentionService({
    controlDatabase,
    secretStore: { async resolve() { return 'private-admin-token'; } },
    deviceId: DEVICE_ID,
    adapter: { normalizeConfig(value) { return structuredClone(value); } },
    nativeController,
    recoveryPointAuthenticator,
    clock: () => '2026-08-05T12:00:00.000Z'
  });
  const service = createService();
  return { service, restart: createService, calls, records, backups, points, runs };
}

test('previews and executes exact authenticated native deletion before projecting RecoveryPoints', async () => {
  const value = fixture({
    onDelete({ records }) {
      const claim = records.recoveryPoint[0].retention.nativeMediaDeletionClaim;
      assert.equal(claim.state, 'claimed');
      assert.equal(claim.claimId.startsWith('influxdb3_enterprise_retention_'), true);
      assert.equal(claim.members[0].claimedRevision, records.recoveryPoint[0].revision);
    }
  });
  const preview = await value.service.preview(WORKSPACE_ID, { recoveryPointId: 'rp-base' });
  assert.equal(preview.eligible, true);
  assert.equal(preview.ownership.completeClosureAuthenticated, true);
  assert.deepEqual(preview.deletionOrder, ['base']);
  const result = await value.service.execute(WORKSPACE_ID, 'operator-a', {
    recoveryPointId: 'rp-base',
    planId: preview.planId,
    confirmed: true,
    confirmationText: DELETE_CONFIRMATION
  });
  assert.equal(result.deletionConfirmed, true);
  assert.equal(result.repositoryMetadataPreserved, true);
  assert.equal(value.calls.delete.length, 1);
  assert.deepEqual(value.calls.delete[0].expectedDeletionOrder, ['base']);
  assert.equal(value.calls.delete[0].ownerships[0].backupName, 'base');
  assert.equal(value.calls.projected.length, 2);
  assert.equal(value.calls.projected[0].retention.nativeMediaDeletionClaim.state, 'claimed');
  assert.equal(value.calls.projected[1].retention.nativeMediaDeleted, true);
  assert.equal(value.calls.projected[1].retention.deletionEligible, false);
  assert.equal(value.calls.projected[1].retention.nativeMediaDeletionClaim, undefined);
  assert.equal(value.calls.authenticate.every((call) => call.options.allowDeletionEligible === true), true);
});

test('executes an authenticated incremental-descendant cascade and projects every RecoveryPoint', async () => {
  const base = backup('base');
  const child = backup('inc-1', { type: 'incremental', parentName: 'base' });
  const points = [
    point('rp-base', 'run-base'),
    point('rp-inc-1', 'run-inc-1', { type: 'incremental', chainRootId: 'rp-base', parentRecoveryPointId: 'rp-base' })
  ];
  const value = fixture({
    backups: [base, child],
    points,
    runs: [run('run-base', 'base'), run('run-inc-1', 'inc-1')],
    deletionOrder: ['inc-1', 'base']
  });
  const preview = await value.service.preview(WORKSPACE_ID, { recoveryPointId: 'rp-base' });
  assert.equal(preview.eligible, true);
  assert.equal(preview.ownership.completeClosureAuthenticated, true);
  assert.deepEqual(preview.closure.map((member) => [member.backupName, member.recoveryPointId]), [['inc-1', 'rp-inc-1'], ['base', 'rp-base']]);

  const result = await value.service.execute(WORKSPACE_ID, 'operator-a', {
    recoveryPointId: 'rp-base',
    planId: preview.planId,
    confirmed: true,
    confirmationText: DELETE_CONFIRMATION
  });
  assert.deepEqual(result.recoveryPointIds, ['rp-inc-1', 'rp-base']);
  assert.equal(result.nativeBackupsDeleted, 2);
  assert.equal(result.providerCascade, true);
  assert.deepEqual(value.calls.delete[0].ownerships.map((item) => item.backupName), ['inc-1', 'base']);
  assert.deepEqual(value.calls.projected.slice(-2).map((item) => item.id), ['rp-inc-1', 'rp-base']);
  assert.equal(value.calls.projected.slice(-2).every((item) => item.retention.nativeMediaDeleted === true && item.retention.deletionEligible === false), true);
  assert.equal(value.calls.authenticate.every((call) => call.options.allowDeletionEligible === true), true);
});

test('displays the full descendant closure but blocks deletion when any native member lacks durable ownership', async () => {
  const base = backup('base');
  const child = backup('inc-1', { type: 'incremental', parentName: 'base' });
  const value = fixture({ backups: [base, child], deletionOrder: ['inc-1', 'base'] });
  const preview = await value.service.preview(WORKSPACE_ID, { recoveryPointId: 'rp-base' });
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockedReason, 'native-ownership-incomplete');
  assert.deepEqual(preview.closure.map((member) => member.backupName), ['inc-1', 'base']);
  await assert.rejects(value.service.execute(WORKSPACE_ID, 'operator-a', {
    recoveryPointId: 'rp-base', planId: preview.planId, confirmed: true, confirmationText: DELETE_CONFIRMATION
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RETENTION_DELETE_BLOCKED');
  assert.equal(value.calls.delete.length, 0);
});

test('blocks retention for policy, hold, immutable copy, and active local or native operations', async () => {
  const cases = [
    { options: { pointOptions: { deletionEligible: false } }, reason: 'retention-not-eligible' },
    { options: { pointOptions: { legalHold: true } }, reason: 'legal-hold' },
    { options: { pointOptions: { immutableUntil: '2026-08-06T00:00:00.000Z' } }, reason: 'immutable-or-copy-hold' },
    { options: { runs: [run('run-base', 'base'), { id: 'run-active', jobId: 'job-retention', state: 'running', sourceLease: null }] }, reason: 'active-operation' },
    { options: { nativeRestores: [{ id: 'restore-native', status: RESTORE_STATES.IN_PROGRESS }] }, reason: 'active-operation' }
  ];
  for (const entry of cases) {
    const preview = await fixture(entry.options).service.preview(WORKSPACE_ID, { recoveryPointId: 'rp-base' });
    assert.equal(preview.eligible, false);
    assert.equal(preview.blockedReason, entry.reason);
  }
});

test('rechecks active local operations atomically while acquiring the deletion claim', async () => {
  let injected = false;
  const value = fixture({
    beforeTransaction({ records }) {
      if (injected) return;
      injected = true;
      records.run.push({ id: 'run-raced', jobId: 'job-retention', state: 'running', sourceLease: null });
    }
  });
  const preview = await value.service.preview(WORKSPACE_ID, { recoveryPointId: 'rp-base' });
  assert.equal(preview.eligible, true);
  await assert.rejects(value.service.execute(WORKSPACE_ID, 'operator-a', {
    recoveryPointId: 'rp-base', planId: preview.planId, confirmed: true, confirmationText: DELETE_CONFIRMATION
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RETENTION_DELETE_BLOCKED');
  assert.equal(value.calls.delete.length, 0);
  assert.equal(value.records.recoveryPoint[0].retention.nativeMediaDeletionClaim, undefined);
});

test('rejects stale plans and preserves reconciliation-required evidence after provider acceptance', async () => {
  const stale = fixture();
  const preview = await stale.service.preview(WORKSPACE_ID, { recoveryPointId: 'rp-base' });
  stale.records.recoveryPoint[0].revision += 1;
  await assert.rejects(stale.service.execute(WORKSPACE_ID, 'operator-a', {
    recoveryPointId: 'rp-base', planId: preview.planId, confirmed: true, confirmationText: DELETE_CONFIRMATION
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RETENTION_PLAN_STALE');
  assert.equal(stale.calls.delete.length, 0);

  const acceptedError = new Error('private provider failure');
  acceptedError.details = { operationAccepted: true, reconciliationRequired: true };
  const accepted = fixture({ deleteError: acceptedError });
  const acceptedPreview = await accepted.service.preview(WORKSPACE_ID, { recoveryPointId: 'rp-base' });
  await assert.rejects(accepted.service.execute(WORKSPACE_ID, 'operator-a', {
    recoveryPointId: 'rp-base', planId: acceptedPreview.planId, confirmed: true, confirmationText: DELETE_CONFIRMATION
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RETENTION_DELETE_RECONCILIATION_REQUIRED' && !String(error).includes('private provider failure'));
  assert.equal(accepted.records.recoveryPoint[0].retention.nativeMediaDeletionClaim.state, 'reconciliation-required');
});

test('reconciles a crash after provider acceptance from the durable pre-delete claim', async () => {
  const acceptedError = new Error('process stopped after provider acceptance');
  acceptedError.details = { operationAccepted: true, reconciliationRequired: true };
  const value = fixture({
    deleteError: acceptedError,
    failReconciliationMark: true,
    onDelete({ backups }) { backups.splice(0, backups.length); }
  });
  const preview = await value.service.preview(WORKSPACE_ID, { recoveryPointId: 'rp-base' });
  await assert.rejects(value.service.execute(WORKSPACE_ID, 'operator-a', {
    recoveryPointId: 'rp-base', planId: preview.planId, confirmed: true, confirmationText: DELETE_CONFIRMATION
  }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_RETENTION_DELETE_RECONCILIATION_REQUIRED');
  assert.equal(value.records.recoveryPoint[0].retention.nativeMediaDeletionClaim.state, 'claimed');
  assert.equal(value.records.recoveryPoint[0].retention.nativeMediaDeleted, undefined);

  const reconciled = await value.restart().reconcile(WORKSPACE_ID, 'startup-reconciler');
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].state, 'succeeded');
  assert.equal(reconciled[0].nativeMediaDeleted, true);
  assert.equal(value.records.recoveryPoint[0].retention.nativeMediaDeleted, true);
  assert.equal(value.records.recoveryPoint[0].retention.nativeMediaDeletionClaim, undefined);
  assert.equal(value.records.recoveryPoint[0].retention.nativeMediaDeletionEvidence.reconciledAfterRestart, true);
});

test('releases a durable claim on restart when the provider never removed the exact backup', async () => {
  const value = fixture();
  const preview = await value.service.preview(WORKSPACE_ID, { recoveryPointId: 'rp-base' });
  const claim = {
    version: 1,
    claimId: preview.planId,
    state: 'claimed',
    sourceId: SOURCE_ID,
    sourceRevision: source().revision,
    connectionId: CONNECTION_ID,
    connectionRevision: connection().revision,
    targetRecoveryPointId: 'rp-base',
    closureFingerprint: preview.closureFingerprint,
    memberCount: 1,
    deletionOrder: ['base'],
    members: [{
      recoveryPointId: 'rp-base',
      claimedRevision: value.records.recoveryPoint[0].revision + 1,
      backupName: 'base',
      backupType: 'full',
      parentName: null,
      status: BACKUP_STATES.COMPLETED,
      watermarkDigest: stableDigest('watermark-base'),
      createdAtDigest: stableDigest('2026-08-05T01:00:00.000Z'),
      completedAtDigest: stableDigest('2026-08-05T01:00:05.000Z')
    }],
    identity: execution(),
    createdAt: '2026-08-05T12:00:00.000Z',
    updatedAt: '2026-08-05T12:00:00.000Z'
  };
  delete claim.identity.connectionRevision;
  await value.service.controlDatabase.transaction((transaction) => {
    const current = transaction.get('recoveryPoint', WORKSPACE_ID, 'rp-base');
    return transaction.projectRecoveryPointRetention(WORKSPACE_ID, current.id, { ...current.retention, nativeMediaDeletionClaim: claim }, {
      expectedRevision: current.revision,
      actorId: 'operator-a',
      nativeMediaDeletionClaimId: claim.claimId
    });
  });
  const reconciled = await value.restart().reconcile(WORKSPACE_ID, 'startup-reconciler');
  assert.equal(reconciled[0].state, 'released');
  assert.equal(value.records.recoveryPoint[0].retention.nativeMediaDeletionClaim, undefined);
  assert.equal(value.records.recoveryPoint[0].retention.nativeMediaDeleted, undefined);
});
