const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CockroachDbRetentionService,
  NATIVE_MEDIA_BLOCK_REASON,
  auditRetentionProjection
} = require('./cockroachdb-retention');

const NOW = '2026-08-05T15:00:00.000Z';
const SOURCE_ID = 'source-cockroach-retention';
const JOB_ID = 'job-cockroach-retention';
const REPOSITORY_ID = 'repository-cockroach-retention';
const COLLECTION_FP = `sha256:${'a'.repeat(64)}`;
const COMPACTION_FP = `sha256:${'e'.repeat(64)}`;

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function copy(id, overrides = {}) {
  return {
    repositoryId: REPOSITORY_ID,
    state: 'available',
    engineSnapshotId: `private-native-snapshot-${id}`,
    manifestLocator: `C:\\private\\repository\\${id}\\manifest.dxb`,
    manifestChecksum: { digest: digest(id === 'rp-full' ? '1' : id === 'rp-inc-1' ? '2' : '3') },
    immutableUntil: null,
    externalConnectionName: 'private_external_connection',
    nativeScheduleId: '988888888888888888',
    nativeJobId: '977777777777777777',
    ...overrides
  };
}

function point(id, type, parentRecoveryPointId, chainRootId, completedAt, overrides = {}) {
  return {
    id,
    revision: 1,
    sourceId: SOURCE_ID,
    jobId: JOB_ID,
    type,
    parentRecoveryPointId,
    chainRootId,
    completedAt,
    retention: { deletionEligible: true, legalHold: false },
    repositoryCopies: [copy(id)],
    nativeMedia: {
      externalConnectionName: 'private_external_connection',
      uri: 'external://private_external_connection/private/collection',
      nativeScheduleId: '988888888888888888',
      nativeJobId: '977777777777777777'
    },
    ...overrides
  };
}

function points() {
  return [
    point('rp-full', 'full', null, 'rp-full', '2026-08-05T12:00:00.000Z'),
    point('rp-inc-1', 'incremental', 'rp-full', 'rp-full', '2026-08-05T12:15:00.000Z'),
    point('rp-inc-2', 'incremental', 'rp-inc-1', 'rp-full', '2026-08-05T12:30:00.000Z')
  ];
}

function ancestors(pointId) {
  if (pointId === 'rp-full') return [];
  if (pointId === 'rp-inc-1') return ['rp-full'];
  return ['rp-full', 'rp-inc-1'];
}

function fixture(options = {}) {
  const data = options.points || points();
  const inspections = [];
  const deletions = [];
  const projections = [];
  const locks = [];
  const inspectionOverrides = options.inspectionOverrides || {};
  const catalog = {
    async listRecoveryPoints(_workspaceId, sourceId) {
      assert.equal(sourceId, SOURCE_ID);
      return data;
    },
    async listActiveOperations() {
      return options.activeOperations || [];
    },
    async markRepositoryCopyPruned(_workspaceId, input) {
      projections.push(input);
      if (options.markError) throw new Error(options.markError);
      const current = data.find((item) => item.id === input.recoveryPointId);
      current.repositoryCopies = current.repositoryCopies.map((item) => item.repositoryId === input.repositoryId ? { ...item, state: 'pruned' } : item);
      current.revision += 1;
    }
  };
  const repositoryMedia = {
    async acquireRetentionLock(input) {
      locks.push(['acquire', input]);
      if (options.lockError) throw new Error(options.lockError);
      return { id: 'retention-lease-private' };
    },
    async releaseRetentionLock(lease) {
      locks.push(['release', lease]);
    },
    async inspectOwnedCopy(input) {
      inspections.push(input.recoveryPoint.id);
      const id = input.recoveryPoint.id;
      const sequence = ancestors(id);
      const override = inspectionOverrides[id] || {};
      return {
        ownershipState: 'owned',
        ownerKind: 'deployerx-repository',
        manifestFingerprint: digest(id === 'rp-full' ? '4' : id === 'rp-inc-1' ? '5' : '6'),
        mediaFingerprint: digest(id === 'rp-full' ? '7' : id === 'rp-inc-1' ? '8' : '9'),
        ownershipFingerprint: digest(id === 'rp-full' ? 'a' : id === 'rp-inc-1' ? 'b' : 'c'),
        deletionToken: `opaque-delete-token-${id}-C:\\private\\do-not-project`,
        objectCount: 3,
        exclusiveObjectCount: 2,
        sharedObjectCount: 1,
        sizeBytes: 1024,
        immutableUntil: null,
        chainEvidence: {
          authenticated: true,
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
          recoveryPointId: id,
          backupMode: input.recoveryPoint.type,
          parentRecoveryPointId: input.recoveryPoint.parentRecoveryPointId,
          chainRootId: input.recoveryPoint.chainRootId,
          ancestorRecoveryPointIds: sequence,
          collectionFingerprint: COLLECTION_FP,
          incrementalCount: sequence.length,
          maximumIncrementals: 48,
          compactionEnabled: false,
          compactionSettingFingerprint: null
        },
        ...override,
        chainEvidence: { 
          authenticated: true,
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
          recoveryPointId: id,
          backupMode: input.recoveryPoint.type,
          parentRecoveryPointId: input.recoveryPoint.parentRecoveryPointId,
          chainRootId: input.recoveryPoint.chainRootId,
          ancestorRecoveryPointIds: sequence,
          collectionFingerprint: COLLECTION_FP,
          incrementalCount: sequence.length,
          maximumIncrementals: 48,
          compactionEnabled: false,
          compactionSettingFingerprint: null,
          ...(override.chainEvidence || {})
        }
      };
    },
    async deleteOwnedCopy(input) {
      deletions.push(input);
      if (options.deleteResult) return options.deleteResult(input);
      return { deleted: true, mediaFingerprint: input.mediaFingerprint, exclusiveObjectsDeleted: 2, sharedObjectsPreserved: 1 };
    }
  };
  let clockCalls = 0;
  const service = new CockroachDbRetentionService({
    catalog,
    repositoryMedia,
    clock: () => options.advancingClock ? new Date(Date.parse(NOW) + clockCalls++ * 1000).toISOString() : NOW
  });
  return { service, data, inspections, deletions, projections, locks };
}

function repositoryRequest(recoveryPointIds) {
  return { sourceId: SOURCE_ID, recoveryPointIds, repositoryId: REPOSITORY_ID, mediaDomain: 'deployerx-repository' };
}

test('previews complete descendant closure and executes exact owned copies descendant-first', async () => {
  const current = fixture({ advancingClock: true });
  const preview = await current.service.preview('local', repositoryRequest(['rp-full']));
  assert.equal(preview.eligible, true);
  assert.equal(preview.chain.closureRequired, true);
  assert.equal(preview.chain.descendantsAdded, 2);
  assert.deepEqual(preview.closureRecoveryPointIds, ['rp-inc-2', 'rp-inc-1', 'rp-full']);
  assert.equal(preview.summary.repositoryCopies, 3);
  assert.equal(preview.summary.mediaObjects, 6);
  assert.equal(preview.summary.sharedObjectsPreserved, 3);
  const result = await current.service.execute('local', 'operator', { ...repositoryRequest(['rp-full']), planId: preview.planId });
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(result.recoveryPointIds, ['rp-inc-2', 'rp-inc-1', 'rp-full']);
  assert.equal(result.repositoryCopiesPruned, 3);
  assert.equal(result.mediaObjectsDeleted, 6);
  assert.equal(result.sharedObjectsPreserved, 3);
  assert.equal(result.externalNativeMediaPreserved, true);
  assert.equal(result.nativeMediaDeletionAttempted, false);
  assert.deepEqual(current.deletions.map((item) => item.recoveryPointId), ['rp-inc-2', 'rp-inc-1', 'rp-full']);
  assert.equal(current.deletions.every((item) => item.preserveSharedObjects === true), true);
  assert.deepEqual(current.projections.map((item) => item.recoveryPointId), ['rp-inc-2', 'rp-inc-1', 'rp-full']);
  assert.deepEqual(current.locks.map(([operation]) => operation), ['acquire', 'release']);
});

test('deleting an incremental expands only through its retained descendants', async () => {
  const current = fixture();
  const preview = await current.service.preview('local', repositoryRequest(['rp-inc-1']));
  assert.deepEqual(preview.closureRecoveryPointIds, ['rp-inc-2', 'rp-inc-1']);
  assert.equal(preview.chain.fullBaselines, 0);
  assert.equal(preview.chain.incrementals, 2);
  assert.equal(preview.chain.descendantsAdded, 1);
  await current.service.execute('local', 'operator', { ...repositoryRequest(['rp-inc-1']), planId: preview.planId });
  assert.deepEqual(current.deletions.map((item) => item.recoveryPointId), ['rp-inc-2', 'rp-inc-1']);
  assert.equal(current.data.find((item) => item.id === 'rp-full').repositoryCopies[0].state, 'available');
});

test('never deletes CockroachDB native media and refuses ambiguous or unowned repository media', async () => {
  const native = fixture();
  const nativePreview = await native.service.preview('local', {
    sourceId: SOURCE_ID,
    recoveryPointIds: ['rp-full'],
    mediaDomain: 'cockroachdb-native'
  });
  assert.equal(nativePreview.eligible, false);
  assert.equal(nativePreview.blockedReason, NATIVE_MEDIA_BLOCK_REASON);
  assert.equal(nativePreview.ownership.externalNativeMediaPreserved, true);
  await assert.rejects(native.service.execute('local', 'operator', {
    sourceId: SOURCE_ID,
    recoveryPointIds: ['rp-full'],
    mediaDomain: 'cockroachdb-native',
    planId: nativePreview.planId
  }), (error) => error.code === 'COCKROACH_RETENTION_DELETE_BLOCKED');
  assert.equal(native.deletions.length, 0);

  for (const override of [
    { ownershipState: 'unowned' },
    { ownershipState: 'ambiguous' },
    { ownerKind: 'cockroachdb-native' },
    { chainEvidence: { authenticated: false } }
  ]) {
    const current = fixture({ inspectionOverrides: { 'rp-inc-2': override } });
    const preview = await current.service.preview('local', repositoryRequest(['rp-full']));
    assert.equal(preview.eligible, false);
    assert.equal(preview.blockedReason, 'ownership-ambiguous');
    await assert.rejects(current.service.execute('local', 'operator', { ...repositoryRequest(['rp-full']), planId: preview.planId }), (error) => error.code === 'COCKROACH_RETENTION_DELETE_BLOCKED');
    assert.equal(current.deletions.length, 0);
  }
});

test('blocks active operations, retention rules, legal holds, and immutable copies', async () => {
  const active = fixture({ activeOperations: [{ id: 'restore-active' }] });
  assert.equal((await active.service.preview('local', repositoryRequest(['rp-full']))).blockedReason, 'active-operation');

  const retainedPoints = points();
  retainedPoints[2].retention.deletionEligible = false;
  const retained = fixture({ points: retainedPoints });
  assert.equal((await retained.service.preview('local', repositoryRequest(['rp-full']))).blockedReason, 'retention-not-eligible');

  const heldPoints = points();
  heldPoints[1].retention.legalHold = { reason: 'legal-private-reason' };
  const legal = fixture({ points: heldPoints });
  assert.equal((await legal.service.preview('local', repositoryRequest(['rp-full']))).blockedReason, 'legal-hold');

  const immutablePoints = points();
  immutablePoints[0].repositoryCopies[0].immutableUntil = '2026-08-06T00:00:00.000Z';
  const immutable = fixture({ points: immutablePoints });
  assert.equal((await immutable.service.preview('local', repositoryRequest(['rp-full']))).blockedReason, 'immutable');
  assert.equal(active.deletions.length + retained.deletions.length + legal.deletions.length + immutable.deletions.length, 0);
});

test('rejects stale plans, incomplete ancestors, branches, and changed collection identity', async () => {
  const stale = fixture();
  const preview = await stale.service.preview('local', repositoryRequest(['rp-full']));
  stale.data[1].revision += 1;
  await assert.rejects(stale.service.execute('local', 'operator', { ...repositoryRequest(['rp-full']), planId: preview.planId }), (error) => error.code === 'COCKROACH_RETENTION_PLAN_STALE');
  assert.equal(stale.deletions.length, 0);

  const incompletePoints = points().filter((item) => item.id !== 'rp-inc-1');
  const incomplete = fixture({ points: incompletePoints });
  await assert.rejects(incomplete.service.preview('local', repositoryRequest(['rp-inc-2'])), (error) => error.code === 'COCKROACH_RETENTION_CHAIN_INCOMPLETE');

  const branchedPoints = points();
  branchedPoints.push(point('rp-inc-branch', 'incremental', 'rp-inc-1', 'rp-full', '2026-08-05T12:31:00.000Z', { repositoryCopies: [copy('rp-inc-2')] }));
  const branched = fixture({ points: branchedPoints });
  await assert.rejects(branched.service.preview('local', repositoryRequest(['rp-full'])), (error) => error.code === 'COCKROACH_RETENTION_CHAIN_AMBIGUOUS');

  const changed = fixture({ inspectionOverrides: { 'rp-inc-2': { chainEvidence: { collectionFingerprint: digest('f') } } } });
  assert.equal((await changed.service.preview('local', repositoryRequest(['rp-full']))).blockedReason, 'chain-media-changed');
});

test('requires discovered compaction evidence for the 400-incremental scheduled limit', async () => {
  const unproven = fixture({ inspectionOverrides: { 'rp-inc-2': { chainEvidence: { maximumIncrementals: 400, compactionEnabled: true } } } });
  assert.equal((await unproven.service.preview('local', repositoryRequest(['rp-full']))).blockedReason, 'ownership-ambiguous');

  const proven = fixture({ inspectionOverrides: {
    'rp-full': { chainEvidence: { maximumIncrementals: 400, compactionEnabled: true, compactionSettingFingerprint: COMPACTION_FP } },
    'rp-inc-1': { chainEvidence: { maximumIncrementals: 400, compactionEnabled: true, compactionSettingFingerprint: COMPACTION_FP } },
    'rp-inc-2': { chainEvidence: { maximumIncrementals: 400, compactionEnabled: true, compactionSettingFingerprint: COMPACTION_FP } }
  } });
  const preview = await proven.service.preview('local', repositoryRequest(['rp-full']));
  assert.equal(preview.eligible, true);
  assert.equal(preview.summary.repositoryCopies, 3);
});

test('public and audit retention projections contain no native IDs, locators, URIs, paths, or deletion tokens', async () => {
  const current = fixture();
  const preview = await current.service.preview('local', repositoryRequest(['rp-full']));
  const audit = auditRetentionProjection('previewed', preview);
  const projected = JSON.stringify({ preview, audit });
  for (const secret of [
    '988888888888888888', '977777777777777777', 'private_external_connection', 'external://',
    'C:\\private\\repository', 'opaque-delete-token', 'private-native-snapshot', 'legal-private-reason'
  ]) assert.equal(projected.includes(secret), false, `retention projection leaked ${secret}`);
  assert.equal(audit.externalNativeMediaPreserved, true);
  assert.equal(audit.nativeMediaDeletionAttempted, false);
});

test('repository and state-provider failures are safely redacted', async () => {
  const secret = 'provider://private-user:private-password@private-host/path';
  const locked = fixture({ lockError: secret });
  const lockedPlan = await locked.service.preview('local', repositoryRequest(['rp-inc-2']));
  await assert.rejects(locked.service.execute('local', 'operator', { ...repositoryRequest(['rp-inc-2']), planId: lockedPlan.planId }), (error) => {
    assert.equal(JSON.stringify(error).includes(secret), false);
    return error.code === 'COCKROACH_RETENTION_LOCK_UNAVAILABLE';
  });

  const deletion = fixture({ deleteResult: () => { throw new Error(secret); } });
  const deletionPlan = await deletion.service.preview('local', repositoryRequest(['rp-inc-2']));
  await assert.rejects(deletion.service.execute('local', 'operator', { ...repositoryRequest(['rp-inc-2']), planId: deletionPlan.planId }), (error) => {
    assert.equal(JSON.stringify(error).includes(secret), false);
    return error.code === 'COCKROACH_RETENTION_DELETE_FAILED';
  });

  const state = fixture({ markError: secret });
  const statePlan = await state.service.preview('local', repositoryRequest(['rp-inc-2']));
  await assert.rejects(state.service.execute('local', 'operator', { ...repositoryRequest(['rp-inc-2']), planId: statePlan.planId }), (error) => {
    assert.equal(JSON.stringify(error).includes(secret), false);
    return error.code === 'COCKROACH_RETENTION_STATE_COMMIT_FAILED';
  });
});
