const crypto = require('crypto');
const { ADAPTER_ID } = require('./cockroachdb');

const RETENTION_CONTROLLER_VERSION = '0.1.0';
const MAXIMUM_RECOVERY_POINTS = 1000;
const MAXIMUM_ACTIVE_OPERATIONS = 1000;
const MAXIMUM_MEDIA_OBJECTS = 1000000;
const NATIVE_MEDIA_BLOCK_REASON = 'native-lifecycle-unavailable';

class CockroachDbRetentionError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CockroachDbRetentionError';
    this.code = code;
    this.category = options.category || 'retention';
    this.retryable = Boolean(options.retryable);
  }
}

function fail(code, message, category = 'retention', retryable = false) {
  throw new CockroachDbRetentionError(code, message, { category, retryable });
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function plainObject(value, label, allowedFields = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  if (allowedFields) {
    const unknown = Object.keys(value).filter((key) => !allowedFields.includes(key));
    if (unknown.length) throw new TypeError(`Unknown ${label} field: ${unknown[0]}.`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TypeError(`${label} is invalid.`);
  return number;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(stable(value)).digest('hex')}`;
}

function fingerprint(value, label) {
  const text = requiredText(value, label, 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
}

function timestamp(value, label, nullable = false) {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  const date = new Date(requiredText(value, label, 100));
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} is invalid.`);
  return date.toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function held(value) {
  return value !== undefined && value !== null && value !== false;
}

function immutable(value, evaluatedAtMs) {
  if (value === undefined || value === null || value === '') return false;
  const parsed = Date.parse(String(value));
  return !Number.isFinite(parsed) || parsed > evaluatedAtMs;
}

function normalizeRetentionRequest(input = {}) {
  const raw = plainObject(input, 'CockroachDB retention request', ['sourceId', 'recoveryPointIds', 'repositoryId', 'mediaDomain']);
  if (!Array.isArray(raw.recoveryPointIds) || raw.recoveryPointIds.length < 1 || raw.recoveryPointIds.length > MAXIMUM_RECOVERY_POINTS) throw new TypeError('CockroachDB retention requires a bounded RecoveryPoint selection.');
  const recoveryPointIds = [...new Set(raw.recoveryPointIds.map((id) => requiredText(id, 'CockroachDB RecoveryPoint ID', 200)))].sort();
  const mediaDomain = String(raw.mediaDomain || 'deployerx-repository').toLowerCase();
  if (!['deployerx-repository', 'cockroachdb-native'].includes(mediaDomain)) throw new TypeError('CockroachDB retention media domain is invalid.');
  const repositoryId = mediaDomain === 'deployerx-repository'
    ? requiredText(raw.repositoryId, 'Backup repository ID', 200)
    : raw.repositoryId === undefined || raw.repositoryId === null ? null : (() => { throw new TypeError('CockroachDB native-media retention cannot include a DeployerX repository.'); })();
  return deepFreeze({
    sourceId: requiredText(raw.sourceId, 'CockroachDB Source ID', 200),
    recoveryPointIds,
    repositoryId,
    mediaDomain
  });
}

function normalizePoint(input, sourceId) {
  const point = structuredClone(plainObject(input, 'CockroachDB RecoveryPoint'));
  const id = requiredText(point.id, 'CockroachDB RecoveryPoint ID', 200);
  if (point.sourceId !== sourceId || !['full', 'incremental'].includes(point.type)) fail('COCKROACH_RETENTION_POINT_INVALID', 'A selected RecoveryPoint is not an exact CockroachDB full or incremental point.', 'integrity');
  const parentRecoveryPointId = point.parentRecoveryPointId === null ? null : requiredText(point.parentRecoveryPointId, 'CockroachDB parent RecoveryPoint ID', 200);
  const chainRootId = requiredText(point.chainRootId, 'CockroachDB chain-root RecoveryPoint ID', 200);
  return {
    raw: point,
    id,
    revision: positiveInteger(point.revision, 'CockroachDB RecoveryPoint revision'),
    sourceId,
    jobId: requiredText(point.jobId, 'CockroachDB Backup Job ID', 200),
    type: point.type,
    parentRecoveryPointId,
    chainRootId,
    completedAt: timestamp(point.completedAt || point.createdAt, 'CockroachDB RecoveryPoint completion time'),
    retention: point.retention && typeof point.retention === 'object' && !Array.isArray(point.retention) ? point.retention : {},
    repositoryCopies: Array.isArray(point.repositoryCopies) ? point.repositoryCopies : []
  };
}

function validateGraph(points) {
  const byId = new Map();
  for (const point of points) {
    if (byId.has(point.id)) fail('COCKROACH_RETENTION_CHAIN_AMBIGUOUS', 'CockroachDB RecoveryPoint identity is duplicated.', 'integrity');
    byId.set(point.id, point);
  }
  const children = new Map(points.map((point) => [point.id, []]));
  for (const point of points) {
    if (point.type === 'full') {
      if (point.parentRecoveryPointId !== null || point.chainRootId !== point.id) fail('COCKROACH_RETENTION_CHAIN_INCOMPLETE', 'A CockroachDB full RecoveryPoint is not an exact chain root.', 'integrity');
      continue;
    }
    const parent = byId.get(point.parentRecoveryPointId);
    const root = byId.get(point.chainRootId);
    if (!parent || !root || root.type !== 'full' || parent.chainRootId !== point.chainRootId || Date.parse(parent.completedAt) >= Date.parse(point.completedAt)) {
      fail('COCKROACH_RETENTION_CHAIN_INCOMPLETE', 'CockroachDB incremental ancestry is missing, changed, or out of order.', 'integrity');
    }
    children.get(parent.id).push(point.id);
  }
  for (const childIds of children.values()) {
    if (childIds.length > 1) fail('COCKROACH_RETENTION_CHAIN_AMBIGUOUS', 'CockroachDB incremental ancestry branches ambiguously.', 'integrity');
  }
  for (const point of points) {
    const seen = new Set();
    let current = point;
    while (current.parentRecoveryPointId) {
      if (seen.has(current.id)) fail('COCKROACH_RETENTION_CHAIN_AMBIGUOUS', 'CockroachDB RecoveryPoint ancestry contains a cycle.', 'integrity');
      seen.add(current.id);
      current = byId.get(current.parentRecoveryPointId);
      if (!current) fail('COCKROACH_RETENTION_CHAIN_INCOMPLETE', 'CockroachDB RecoveryPoint ancestry is incomplete.', 'integrity');
    }
    if (current.id !== point.chainRootId) fail('COCKROACH_RETENTION_CHAIN_INCOMPLETE', 'CockroachDB RecoveryPoint chain-root evidence changed.', 'integrity');
  }
  return { byId, children };
}

function descendantClosure(requestedIds, graph) {
  const closure = new Set();
  const visit = (id) => {
    if (closure.has(id)) return;
    closure.add(id);
    for (const child of graph.children.get(id) || []) visit(child);
  };
  for (const id of requestedIds) visit(id);
  return closure;
}

function ancestry(point, graph) {
  const result = [];
  let current = point;
  while (current.parentRecoveryPointId) {
    current = graph.byId.get(current.parentRecoveryPointId);
    result.push(current.id);
  }
  return result.reverse();
}

function deletionOrder(closure, graph) {
  const depth = (point) => ancestry(point, graph).length;
  return [...closure].map((id) => graph.byId.get(id)).sort((left, right) => {
    const difference = depth(right) - depth(left);
    if (difference) return difference;
    return right.completedAt.localeCompare(left.completedAt) || left.id.localeCompare(right.id);
  });
}

function exactCopy(point, repositoryId) {
  const copies = point.repositoryCopies.filter((copy) => copy.repositoryId === repositoryId && copy.state === 'available');
  if (copies.length !== 1) return null;
  const copy = copies[0];
  if (!copy.engineSnapshotId || !copy.manifestLocator || !copy.manifestChecksum?.digest) return null;
  return copy;
}

function normalizeInspection(input, point, graph) {
  const raw = plainObject(input, 'CockroachDB repository-copy ownership inspection', [
    'ownershipState', 'ownerKind', 'manifestFingerprint', 'mediaFingerprint', 'ownershipFingerprint',
    'deletionToken', 'objectCount', 'exclusiveObjectCount', 'sharedObjectCount', 'sizeBytes', 'immutableUntil',
    'chainEvidence'
  ]);
  const chain = plainObject(raw.chainEvidence, 'CockroachDB authenticated chain evidence', [
    'authenticated', 'sourceId', 'jobId', 'recoveryPointId', 'backupMode', 'parentRecoveryPointId', 'chainRootId',
    'ancestorRecoveryPointIds', 'collectionFingerprint', 'incrementalCount', 'maximumIncrementals',
    'compactionEnabled', 'compactionSettingFingerprint'
  ]);
  const expectedAncestors = ancestry(point, graph);
  const maximumIncrementals = positiveInteger(chain.maximumIncrementals, 'CockroachDB authenticated maximum incrementals', 400);
  const compactionEnabled = chain.compactionEnabled === true;
  const expectedMaximum = compactionEnabled ? 400 : 48;
  const settingFingerprint = chain.compactionSettingFingerprint === null || chain.compactionSettingFingerprint === undefined
    ? null
    : fingerprint(chain.compactionSettingFingerprint, 'CockroachDB compaction-setting fingerprint');
  const chainRootId = point.type === 'full' ? point.id : point.chainRootId;
  if (raw.ownershipState !== 'owned' || raw.ownerKind !== 'deployerx-repository' || chain.authenticated !== true
    || chain.sourceId !== point.sourceId || chain.jobId !== point.jobId || chain.recoveryPointId !== point.id
    || chain.backupMode !== point.type || chain.parentRecoveryPointId !== point.parentRecoveryPointId || chain.chainRootId !== chainRootId
    || !Array.isArray(chain.ancestorRecoveryPointIds) || stable(chain.ancestorRecoveryPointIds) !== stable(expectedAncestors)
    || positiveInteger(chain.incrementalCount, 'CockroachDB authenticated incremental count', 400, 0) !== expectedAncestors.length
    || maximumIncrementals !== expectedMaximum || expectedAncestors.length > maximumIncrementals
    || compactionEnabled && !settingFingerprint) {
    return deepFreeze({ owned: false, blockedReason: 'ownership-ambiguous' });
  }
  const objectCount = positiveInteger(raw.objectCount, 'CockroachDB repository media-object count', MAXIMUM_MEDIA_OBJECTS);
  const exclusiveObjectCount = positiveInteger(raw.exclusiveObjectCount, 'CockroachDB exclusive media-object count', objectCount, 0);
  const sharedObjectCount = positiveInteger(raw.sharedObjectCount, 'CockroachDB shared media-object count', objectCount, 0);
  if (exclusiveObjectCount + sharedObjectCount !== objectCount) throw new TypeError('CockroachDB repository media-object accounting is invalid.');
  const sizeBytes = positiveInteger(raw.sizeBytes, 'CockroachDB repository copy size', Number.MAX_SAFE_INTEGER, 0);
  return deepFreeze({
    owned: true,
    blockedReason: null,
    manifestFingerprint: fingerprint(raw.manifestFingerprint, 'CockroachDB manifest fingerprint'),
    mediaFingerprint: fingerprint(raw.mediaFingerprint, 'CockroachDB media fingerprint'),
    ownershipFingerprint: fingerprint(raw.ownershipFingerprint, 'CockroachDB repository ownership fingerprint'),
    deletionToken: requiredText(raw.deletionToken, 'CockroachDB opaque repository deletion token', 4096),
    deletionTokenFingerprint: stableDigest(raw.deletionToken),
    objectCount,
    exclusiveObjectCount,
    sharedObjectCount,
    sizeBytes,
    immutableUntil: timestamp(raw.immutableUntil, 'CockroachDB inspected immutability time', true),
    chain: {
      collectionFingerprint: fingerprint(chain.collectionFingerprint, 'CockroachDB collection fingerprint'),
      incrementalCount: expectedAncestors.length,
      maximumIncrementals,
      compactionEnabled,
      compactionSettingFingerprint: settingFingerprint,
      ancestorFingerprint: stableDigest(expectedAncestors)
    }
  });
}

function publicRetentionPlan(plan) {
  return deepFreeze({
    version: 1,
    planId: plan.planId,
    evaluatedAt: plan.evaluatedAt,
    sourceId: plan.request.sourceId,
    repositoryId: plan.request.repositoryId,
    mediaDomain: plan.request.mediaDomain,
    eligible: plan.blockedReason === null,
    blockedReason: plan.blockedReason,
    requestedRecoveryPointIds: plan.request.recoveryPointIds,
    closureRecoveryPointIds: plan.order.map((point) => point.id),
    activeOperationIds: plan.activeOperationIds,
    ownership: {
      exactRepositoryOwnership: plan.request.mediaDomain === 'deployerx-repository' && plan.inspections.length === plan.order.length && plan.inspections.every((item) => item.inspection.owned),
      nativeMediaDeletionAttempted: false,
      externalNativeMediaPreserved: true
    },
    chain: {
      deletionOrder: 'descendant-first',
      fullBaselines: plan.order.filter((point) => point.type === 'full').length,
      incrementals: plan.order.filter((point) => point.type === 'incremental').length,
      descendantsAdded: plan.order.length - plan.request.recoveryPointIds.length,
      closureRequired: plan.order.length > plan.request.recoveryPointIds.length
    },
    summary: {
      repositoryCopies: plan.blockedReason ? 0 : plan.inspections.length,
      mediaObjects: plan.blockedReason ? 0 : plan.inspections.reduce((total, item) => total + item.inspection.exclusiveObjectCount, 0),
      sharedObjectsPreserved: plan.inspections.reduce((total, item) => total + (item.inspection.sharedObjectCount || 0), 0),
      bytesReviewed: plan.inspections.reduce((total, item) => total + (item.inspection.sizeBytes || 0), 0)
    }
  });
}

function auditRetentionProjection(action, input = {}) {
  const plan = input.planId ? input : publicRetentionPlan(input);
  return deepFreeze({
    adapterId: ADAPTER_ID,
    operation: `cockroachdb-retention-${requiredText(action, 'CockroachDB retention audit action', 40)}`,
    planId: plan.planId,
    mediaDomain: plan.mediaDomain,
    eligible: plan.eligible,
    blockedReason: plan.blockedReason,
    recoveryPointCount: plan.closureRecoveryPointIds.length,
    fullBaselines: plan.chain.fullBaselines,
    incrementals: plan.chain.incrementals,
    externalNativeMediaPreserved: true,
    nativeMediaDeletionAttempted: false
  });
}

class CockroachDbRetentionService {
  constructor({ catalog, repositoryMedia, clock = () => new Date().toISOString() } = {}) {
    if (!catalog || typeof catalog.listRecoveryPoints !== 'function' || typeof catalog.listActiveOperations !== 'function'
      || typeof catalog.markRepositoryCopyPruned !== 'function' || !repositoryMedia
      || typeof repositoryMedia.inspectOwnedCopy !== 'function' || typeof repositoryMedia.deleteOwnedCopy !== 'function'
      || typeof repositoryMedia.acquireRetentionLock !== 'function' || typeof repositoryMedia.releaseRetentionLock !== 'function'
      || typeof clock !== 'function') throw new TypeError('CockroachDB retention dependencies are required.');
    this.catalog = catalog;
    this.repositoryMedia = repositoryMedia;
    this.clock = clock;
  }

  async preview(workspaceId, input = {}) {
    const plan = await this.#build(requiredText(workspaceId, 'Workspace ID', 200), normalizeRetentionRequest(input));
    return publicRetentionPlan(plan);
  }

  async execute(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const raw = plainObject(input, 'CockroachDB retention execution', ['sourceId', 'recoveryPointIds', 'repositoryId', 'mediaDomain', 'planId']);
    const expectedPlanId = requiredText(raw.planId, 'CockroachDB retention plan ID', 100);
    const request = normalizeRetentionRequest({
      sourceId: raw.sourceId,
      recoveryPointIds: raw.recoveryPointIds,
      repositoryId: raw.repositoryId,
      mediaDomain: raw.mediaDomain
    });
    let lease = null;
    if (request.mediaDomain === 'deployerx-repository') {
      try {
        lease = await this.repositoryMedia.acquireRetentionLock({
          workspaceId: tenant,
          repositoryId: request.repositoryId,
          sourceId: request.sourceId,
          scope: `cockroachdb-retention:${request.repositoryId}`
        });
      } catch {
        fail('COCKROACH_RETENTION_LOCK_UNAVAILABLE', 'The repository retention mutation lease is unavailable.', 'conflict', true);
      }
    }
    try {
      const plan = await this.#build(tenant, request);
      if (plan.planId !== expectedPlanId) fail('COCKROACH_RETENTION_PLAN_STALE', 'CockroachDB RecoveryPoint, chain, operation, policy, or repository ownership changed after review.', 'conflict');
      if (plan.blockedReason) fail('COCKROACH_RETENTION_DELETE_BLOCKED', 'CockroachDB retention execution remains blocked by chain, policy, operation, ownership, or native-media safety.', 'conflict');
      const completed = [];
      for (const item of plan.inspections) {
        let deleted;
        try {
          deleted = await this.repositoryMedia.deleteOwnedCopy({
            workspaceId: tenant,
            repositoryId: request.repositoryId,
            recoveryPointId: item.point.id,
            recoveryPointRevision: item.point.revision,
            deletionToken: item.inspection.deletionToken,
            ownershipFingerprint: item.inspection.ownershipFingerprint,
            mediaFingerprint: item.inspection.mediaFingerprint,
            preserveSharedObjects: true
          });
        } catch {
          fail('COCKROACH_RETENTION_DELETE_FAILED', 'The repository could not delete the exact owned CockroachDB metadata copy.', 'execution', true);
        }
        if (!deleted || deleted.deleted !== true || deleted.mediaFingerprint !== item.inspection.mediaFingerprint
          || positiveInteger(deleted.exclusiveObjectsDeleted, 'CockroachDB deleted media-object count', MAXIMUM_MEDIA_OBJECTS, 0) !== item.inspection.exclusiveObjectCount
          || positiveInteger(deleted.sharedObjectsPreserved, 'CockroachDB preserved shared-object count', MAXIMUM_MEDIA_OBJECTS, 0) < item.inspection.sharedObjectCount) {
          fail('COCKROACH_RETENTION_DELETE_UNCONFIRMED', 'The repository did not confirm exact owned CockroachDB metadata-copy deletion.', 'integrity', true);
        }
        try {
          await this.catalog.markRepositoryCopyPruned(tenant, {
            actorId: actor,
            recoveryPointId: item.point.id,
            recoveryPointRevision: item.point.revision,
            repositoryId: request.repositoryId,
            planId: plan.planId,
            ownershipFingerprint: item.inspection.ownershipFingerprint,
            mediaFingerprint: item.inspection.mediaFingerprint,
            prunedAt: this.clock(),
            externalNativeMediaPreserved: true
          });
        } catch {
          fail('COCKROACH_RETENTION_STATE_COMMIT_FAILED', 'Repository deletion completed but CockroachDB RecoveryPoint state could not be committed; reconciliation is required.', 'integrity');
        }
        completed.push({
          recoveryPointId: item.point.id,
          mediaFingerprint: item.inspection.mediaFingerprint,
          exclusiveObjectsDeleted: item.inspection.exclusiveObjectCount,
          sharedObjectsPreserved: item.inspection.sharedObjectCount
        });
      }
      return deepFreeze({
        version: 1,
        planId: plan.planId,
        mediaDomain: 'deployerx-repository',
        state: 'succeeded',
        recoveryPointIds: completed.map((item) => item.recoveryPointId),
        repositoryCopiesPruned: completed.length,
        mediaObjectsDeleted: completed.reduce((total, item) => total + item.exclusiveObjectsDeleted, 0),
        sharedObjectsPreserved: completed.reduce((total, item) => total + item.sharedObjectsPreserved, 0),
        externalNativeMediaPreserved: true,
        nativeMediaDeletionAttempted: false,
        completedAt: this.clock()
      });
    } finally {
      if (lease !== null) await this.repositoryMedia.releaseRetentionLock(lease).catch(() => {});
    }
  }

  async #build(workspaceId, request) {
    const evaluatedAt = timestamp(this.clock(), 'CockroachDB retention evaluation time');
    const evaluatedAtMs = Date.parse(evaluatedAt);
    const records = await this.catalog.listRecoveryPoints(workspaceId, request.sourceId, { limit: MAXIMUM_RECOVERY_POINTS });
    if (!Array.isArray(records) || records.length >= MAXIMUM_RECOVERY_POINTS) fail('COCKROACH_RETENTION_SCAN_LIMIT', 'CockroachDB retention could not prove the complete bounded RecoveryPoint catalog.', 'capacity');
    const points = records.map((record) => normalizePoint(record, request.sourceId));
    const graph = validateGraph(points);
    for (const id of request.recoveryPointIds) if (!graph.byId.has(id)) fail('COCKROACH_RETENTION_POINT_NOT_FOUND', 'A selected CockroachDB RecoveryPoint was not found.', 'not-found');
    const closure = descendantClosure(request.recoveryPointIds, graph);
    const order = deletionOrder(closure, graph);
    const active = await this.catalog.listActiveOperations(workspaceId, order.map((point) => point.id), { limit: MAXIMUM_ACTIVE_OPERATIONS });
    if (!Array.isArray(active) || active.length >= MAXIMUM_ACTIVE_OPERATIONS) fail('COCKROACH_RETENTION_SCAN_LIMIT', 'CockroachDB retention could not prove the complete bounded active-operation catalog.', 'capacity');
    const activeOperationIds = [...new Set(active.map((operation) => requiredText(operation.id, 'CockroachDB active operation ID', 200)))].sort();
    const inspections = [];
    let blockedReason = request.mediaDomain === 'cockroachdb-native' ? NATIVE_MEDIA_BLOCK_REASON : null;
    if (!blockedReason && activeOperationIds.length) blockedReason = 'active-operation';
    for (const point of order) {
      if (!blockedReason && point.retention.deletionEligible !== true) blockedReason = 'retention-not-eligible';
      if (!blockedReason && (held(point.retention.legalHold) || held(point.raw.legalHold))) blockedReason = 'legal-hold';
      if (request.mediaDomain !== 'deployerx-repository') continue;
      const copy = exactCopy(point, request.repositoryId);
      if (!copy) {
        if (!blockedReason) blockedReason = 'ownership-ambiguous';
        continue;
      }
      if (!blockedReason && (immutable(copy.immutableUntil, evaluatedAtMs) || immutable(point.raw.immutableUntil, evaluatedAtMs))) blockedReason = 'immutable';
      let inspection;
      try {
        inspection = normalizeInspection(await this.repositoryMedia.inspectOwnedCopy({
          workspaceId,
          repositoryId: request.repositoryId,
          recoveryPoint: point.raw,
          copy
        }), point, graph);
      } catch (error) {
        if (error instanceof CockroachDbRetentionError) throw error;
        inspection = deepFreeze({ owned: false, blockedReason: 'ownership-ambiguous' });
      }
      if (!inspection.owned && !blockedReason) blockedReason = inspection.blockedReason;
      inspections.push({ point, copy, inspection });
    }
    const authenticated = inspections.filter((item) => item.inspection.owned);
    const collectionByRoot = new Map();
    for (const item of authenticated) {
      const current = collectionByRoot.get(item.point.chainRootId);
      if (current && current !== item.inspection.chain.collectionFingerprint) blockedReason = blockedReason || 'chain-media-changed';
      collectionByRoot.set(item.point.chainRootId, item.inspection.chain.collectionFingerprint);
    }
    const evidence = {
      version: 1,
      controllerVersion: RETENTION_CONTROLLER_VERSION,
      request,
      evaluatedAt,
      points: order.map((point) => ({ id: point.id, revision: point.revision, type: point.type, parentRecoveryPointId: point.parentRecoveryPointId, chainRootId: point.chainRootId })),
      inspections: inspections.map((item) => item.inspection.owned ? {
        pointId: item.point.id,
        manifestFingerprint: item.inspection.manifestFingerprint,
        mediaFingerprint: item.inspection.mediaFingerprint,
        ownershipFingerprint: item.inspection.ownershipFingerprint,
        deletionTokenFingerprint: item.inspection.deletionTokenFingerprint,
        objectCount: item.inspection.objectCount,
        exclusiveObjectCount: item.inspection.exclusiveObjectCount,
        sharedObjectCount: item.inspection.sharedObjectCount,
        sizeBytes: item.inspection.sizeBytes,
        chain: item.inspection.chain
      } : { pointId: item.point.id, owned: false }),
      activeOperationIds,
      blockedReason
    };
    const { evaluatedAt: _evaluatedAt, ...reviewEvidence } = evidence;
    const planId = `cockroach_retention_${crypto.createHash('sha256').update(stable(reviewEvidence)).digest('hex')}`;
    return deepFreeze({ ...evidence, planId, order, inspections, activeOperationIds, blockedReason });
  }
}

module.exports = {
  MAXIMUM_ACTIVE_OPERATIONS,
  MAXIMUM_MEDIA_OBJECTS,
  MAXIMUM_RECOVERY_POINTS,
  NATIVE_MEDIA_BLOCK_REASON,
  RETENTION_CONTROLLER_VERSION,
  CockroachDbRetentionError,
  CockroachDbRetentionService,
  auditRetentionProjection,
  normalizeRetentionRequest,
  publicRetentionPlan,
  stableDigest
};
