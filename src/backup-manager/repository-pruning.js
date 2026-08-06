const crypto = require('crypto');
const { DEFAULT_MINIMUM_BACKUP_BYTES, evaluateRepositoryCapacity, normalizeStoragePolicy } = require('./repository-capacity');

const MAXIMUM_PRUNE_POINTS = 60001;
const MAXIMUM_PRUNE_OBJECTS = 1000000;
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);

class RepositoryPruningError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'RepositoryPruningError';
    this.code = code;
    this.category = options.category || 'repository';
    this.retryable = Boolean(options.retryable);
  }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function planId(plan) {
  return `prune_${crypto.createHash('sha256').update(stable(plan)).digest('hex')}`;
}

function immutable(value, now) {
  if (value === null || value === undefined || value === '') return false;
  const parsed = Date.parse(String(value || ''));
  return !Number.isFinite(parsed) || parsed > now;
}

function legalHold(point, copy) {
  const held = (value) => value !== undefined && value !== null && value !== false;
  return held(point.legalHold) || held(point.retention?.legalHold) || held(copy.legalHold);
}

async function listKeys(adapter, context, prefix) {
  const keys = [];
  let cursor = null;
  do {
    let page = null;
    for await (const value of adapter.list(context, { prefix, cursor, pageSize: 200 })) {
      if (page) throw new RepositoryPruningError('REPOSITORY_PRUNE_LIST_INVALID', 'The repository returned more than one page for a list request.', { category: 'integrity' });
      page = value;
    }
    if (!page || !Array.isArray(page.items)) throw new RepositoryPruningError('REPOSITORY_PRUNE_LIST_INVALID', 'The repository returned an invalid object listing.', { category: 'integrity' });
    for (const item of page.items) {
      const key = String(item?.key || '');
      if (!key.startsWith(prefix)) throw new RepositoryPruningError('REPOSITORY_PRUNE_LIST_INVALID', 'The repository returned an object outside the requested prefix.', { category: 'integrity' });
      keys.push(key);
      if (keys.length > MAXIMUM_PRUNE_OBJECTS) throw new RepositoryPruningError('REPOSITORY_PRUNE_LIMIT_EXCEEDED', 'Repository pruning exceeded its bounded object limit.', { category: 'capacity' });
    }
    cursor = page.hasMore ? page.nextCursor : null;
    if (page.hasMore && !cursor) throw new RepositoryPruningError('REPOSITORY_PRUNE_LIST_INVALID', 'The repository list continuation is invalid.', { category: 'integrity' });
  } while (cursor);
  return keys;
}

class RepositoryPruningService {
  constructor({ controlDatabase, openRepository, deviceId, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || typeof openRepository !== 'function') throw new TypeError('Repository pruning dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.openRepository = openRepository;
    this.deviceId = String(deviceId || '').trim();
    this.clock = clock;
  }

  async #activePointIds(workspaceId, repositoryId) {
    const [runs, restores, verifications] = await Promise.all([
      this.controlDatabase.repository('run').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('restoreRun').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('verificationRun').list(workspaceId, { limit: 1000 })
    ]);
    if (runs.length === 1000 || restores.length === 1000 || verifications.length === 1000) throw new RepositoryPruningError('REPOSITORY_PRUNE_ACTIVE_SCAN_LIMIT', 'Repository pruning could not prove that every active operation was inspected.', { category: 'capacity' });
    const ids = new Set();
    const allOperationIds = new Set();
    const pointOperationIds = new Map();
    const protectPoint = (pointId, operationId) => {
      ids.add(pointId);
      if (!pointOperationIds.has(pointId)) pointOperationIds.set(pointId, new Set());
      pointOperationIds.get(pointId).add(operationId);
    };
    for (const run of runs) {
      if (TERMINAL_STATES.has(run.state)) continue;
      if ((run.configSnapshot?.repositories || []).some((repository) => repository.id === repositoryId)) { ids.add('*'); allOperationIds.add(run.id); }
    }
    for (const run of restores) if (!TERMINAL_STATES.has(run.state)) for (const id of run.recoveryPointIds || []) protectPoint(id, run.id);
    for (const run of verifications) {
      if (TERMINAL_STATES.has(run.state)) continue;
      if (run.repositoryId === repositoryId || (run.scopeType === 'repository' && run.scopeId === repositoryId)) { ids.add('*'); allOperationIds.add(run.id); }
      if (run.recoveryPointId) protectPoint(run.recoveryPointId, run.id);
      for (const id of run.recoveryPointIds || []) protectPoint(id, run.id);
    }
    return { ids, allOperationIds, pointOperationIds };
  }

  async #build(workspaceId, repositoryId, opened, nowText) {
    const now = Date.parse(nowText);
    if (!Number.isFinite(now)) throw new RepositoryPruningError('REPOSITORY_PRUNE_CLOCK_INVALID', 'Repository pruning time is invalid.', { category: 'internal' });
    const points = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: MAXIMUM_PRUNE_POINTS });
    if (points.length === MAXIMUM_PRUNE_POINTS) throw new RepositoryPruningError('REPOSITORY_PRUNE_LIMIT_EXCEEDED', 'Recovery-point pruning requires a narrower bounded set.', { category: 'capacity' });
    const active = await this.#activePointIds(workspaceId, repositoryId);
    const repositoryPoints = points.map((point) => ({ point, copy: (point.repositoryCopies || []).find((copy) => copy.repositoryId === repositoryId) })).filter((entry) => entry.copy?.state === 'available');
    const pointById = new Map(repositoryPoints.map((entry) => [entry.point.id, entry]));
    const protectedAncestors = new Set();
    const protectedByDescendants = new Map();
    for (const entry of repositoryPoints) {
      if (entry.point.retention?.deletionEligible === true) continue;
      let parentId = entry.point.parentRecoveryPointId;
      const seen = new Set();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        protectedAncestors.add(parentId);
        if (!protectedByDescendants.has(parentId)) protectedByDescendants.set(parentId, new Set());
        protectedByDescendants.get(parentId).add(entry.point.id);
        parentId = pointById.get(parentId)?.point.parentRecoveryPointId || null;
      }
    }
    const blocked = [];
    const candidates = [];
    for (const entry of repositoryPoints) {
      if (entry.point.retention?.deletionEligible !== true) continue;
      let reason = null;
      if (legalHold(entry.point, entry.copy)) reason = 'legal-hold';
      else if (immutable(entry.copy.immutableUntil, now) || immutable(entry.point.immutableUntil, now)) reason = 'immutable';
      else if (active.ids.has('*') || active.ids.has(entry.point.id)) reason = 'active-operation';
      else if (protectedAncestors.has(entry.point.id)) reason = 'dependency';
      if (reason) blocked.push({ recoveryPointId: entry.point.id, reason });
      else candidates.push(entry);
    }

    const manifestKeys = await listKeys(opened.adapter, {}, 'manifests/v1/');
    const manifests = new Map();
    for (const key of manifestKeys) {
      const match = /^manifests\/v1\/(snp_[a-f0-9]{40})\.dxb$/.exec(key);
      if (!match) throw new RepositoryPruningError('REPOSITORY_PRUNE_UNKNOWN_MANIFEST', 'The repository contains an unrecognized manifest object.', { category: 'integrity' });
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: match[1], masterKey: opened.masterKey });
      manifests.set(key, snapshot.manifest);
    }
    const candidateKeys = new Set(candidates.map((entry) => entry.copy.manifestLocator));
    const retainedChunks = new Set();
    const candidateChunks = new Set();
    let chunkReferences = 0;
    for (const [key, manifest] of manifests) {
      const target = candidateKeys.has(key) ? candidateChunks : retainedChunks;
      for (const file of manifest.files || []) {
        for (const chunk of file.chunks || []) {
          chunkReferences += 1;
          if (chunkReferences > MAXIMUM_PRUNE_OBJECTS) throw new RepositoryPruningError('REPOSITORY_PRUNE_LIMIT_EXCEEDED', 'Repository pruning exceeded its bounded chunk-reference limit.', { category: 'capacity' });
          target.add(chunk.key);
        }
      }
    }
    const deletableChunks = [...candidateChunks].filter((key) => !retainedChunks.has(key)).sort();
    const copies = candidates.map(({ point, copy }) => ({ recoveryPointId: point.id, recoveryPointRevision: point.revision, snapshotId: copy.engineSnapshotId, manifestKey: copy.manifestLocator, manifestPresent: manifests.has(copy.manifestLocator) })).sort((a, b) => a.recoveryPointId.localeCompare(b.recoveryPointId, 'en-US'));
    const protection = {
      chainDependencies: [...protectedByDescendants].sort(([left], [right]) => left.localeCompare(right, 'en-US')).map(([recoveryPointId, descendants]) => ({ recoveryPointId, protectedByRecoveryPointIds: [...descendants].sort() })),
      activeOperations: {
        repositoryWideOperationIds: [...active.allOperationIds].sort(),
        recoveryPoints: [...active.pointOperationIds].sort(([left], [right]) => left.localeCompare(right, 'en-US')).map(([recoveryPointId, operationIds]) => ({ recoveryPointId, operationIds: [...operationIds].sort() }))
      }
    };
    const evidence = { version: 1, repositoryId, copies, chunkKeys: deletableChunks, blocked: blocked.sort((a, b) => a.recoveryPointId.localeCompare(b.recoveryPointId, 'en-US')), protection, manifestCount: manifests.size, chunkReferenceCount: chunkReferences };
    return { ...evidence, evaluatedAt: nowText, planId: planId(evidence), summary: { eligibleCopies: copies.length, blockedCopies: blocked.length, manifestsToDelete: copies.filter((copy) => copy.manifestPresent).length, chunksToDelete: deletableChunks.length } };
  }

  async plan(workspaceId, repositoryId) {
    const repository = await this.controlDatabase.repository('repository').get(workspaceId, repositoryId);
    if (!repository) throw new RepositoryPruningError('REPOSITORY_NOT_FOUND', 'Repository was not found.', { category: 'validation' });
    if (!(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new RepositoryPruningError('REPOSITORY_OTHER_DEVICE', 'Repository pruning must run on the repository owner device.', { category: 'authorization' });
    const opened = await this.openRepository(workspaceId, repositoryId);
    const plan = await this.#build(workspaceId, repositoryId, opened, this.clock());
    return {
      version: plan.version,
      repositoryId: plan.repositoryId,
      evaluatedAt: plan.evaluatedAt,
      planId: plan.planId,
      summary: plan.summary,
      candidates: plan.copies.map((copy) => ({ recoveryPointId: copy.recoveryPointId })),
      blocked: plan.blocked,
      protection: plan.protection
    };
  }

  async configure(workspaceId, actorId, repositoryId, input = {}) {
    const repository = await this.controlDatabase.repository('repository').get(workspaceId, repositoryId);
    if (!repository) throw new RepositoryPruningError('REPOSITORY_NOT_FOUND', 'Repository was not found.', { category: 'validation' });
    if (!(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new RepositoryPruningError('REPOSITORY_OTHER_DEVICE', 'Repository policy must be changed on the repository owner device.', { category: 'authorization' });
    const storagePolicy = normalizeStoragePolicy(input.storagePolicy || input);
    const capacityStatus = evaluateRepositoryCapacity(repository.capacity, storagePolicy, 0, this.clock());
    return this.controlDatabase.repository('repository').update(workspaceId, repositoryId, { storagePolicy, capacityStatus }, {
      expectedRevision: input.expectedRevision ?? repository.revision,
      actorId
    });
  }

  async execute(workspaceId, actorId, repositoryId, expectedPlanId) {
    const repository = await this.controlDatabase.repository('repository').get(workspaceId, repositoryId);
    if (!repository) throw new RepositoryPruningError('REPOSITORY_NOT_FOUND', 'Repository was not found.', { category: 'validation' });
    if (!(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new RepositoryPruningError('REPOSITORY_OTHER_DEVICE', 'Repository pruning must run on the repository owner device.', { category: 'authorization' });
    const opened = await this.openRepository(workspaceId, repositoryId);
    let lease = await opened.adapter.acquireLock({ masterKey: opened.masterKey }, {
      repositoryId, operation: 'prune', scope: `repository:${repositoryId}:mutation`, workerId: `device:${this.deviceId}`,
      runId: `prune:${crypto.randomUUID()}`, ttlMs: 15 * 60 * 1000
    });
    try {
      const plan = await this.#build(workspaceId, repositoryId, opened, this.clock());
      if (!expectedPlanId || plan.planId !== expectedPlanId) throw new RepositoryPruningError('REPOSITORY_PRUNE_PLAN_STALE', 'The repository changed after the dry-run plan. Review a new prune plan.', { category: 'conflict' });
      const copyResults = [];
      for (const item of plan.copies) {
        const currentPoint = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, item.recoveryPointId);
        const currentCopy = currentPoint?.repositoryCopies?.find((copy) => copy.repositoryId === repositoryId);
        if (!currentPoint || currentPoint.revision !== item.recoveryPointRevision || currentPoint.retention?.deletionEligible !== true
          || currentCopy?.state !== 'available' || legalHold(currentPoint, currentCopy)
          || immutable(currentPoint.immutableUntil, Date.parse(this.clock())) || immutable(currentCopy.immutableUntil, Date.parse(this.clock()))) {
          throw new RepositoryPruningError('REPOSITORY_PRUNE_PLAN_STALE', 'A recovery point changed after the dry-run plan. Review a new prune plan.', { category: 'conflict' });
        }
        const deletion = await opened.adapter.delete({}, { key: item.manifestKey });
        if (!deletion?.deleted && !deletion?.absent) throw new RepositoryPruningError('REPOSITORY_PRUNE_DELETE_UNCONFIRMED', 'The repository did not confirm manifest deletion.', { retryable: true });
        const projected = await this.controlDatabase.transaction((transaction) => {
          const point = transaction.get('recoveryPoint', workspaceId, item.recoveryPointId);
          if (!point) throw new RepositoryPruningError('REPOSITORY_PRUNE_POINT_MISSING', 'A recovery point changed during pruning.', { category: 'conflict' });
          const copies = point.repositoryCopies.map((copy) => copy.repositoryId === repositoryId ? {
            ...copy, state: 'pruned', prunedAt: this.clock(), prunePlanId: plan.planId,
            manifestDeletion: { confirmed: true, absent: deletion.absent === true }
          } : copy);
          return transaction.projectRecoveryPointRepositoryCopies(workspaceId, point.id, copies, { expectedRevision: item.recoveryPointRevision, actorId });
        });
        copyResults.push({ recoveryPointId: item.recoveryPointId, state: projected.repositoryCopies.find((copy) => copy.repositoryId === repositoryId).state });
        lease = await opened.adapter.renewLock({ masterKey: opened.masterKey }, lease);
      }
      const chunkResults = [];
      for (let index = 0; index < plan.chunkKeys.length; index += 1) {
        const key = plan.chunkKeys[index];
        const deletion = await opened.adapter.delete({}, { key });
        if (!deletion?.deleted && !deletion?.absent) throw new RepositoryPruningError('REPOSITORY_PRUNE_DELETE_UNCONFIRMED', 'The repository did not confirm chunk deletion.', { retryable: true });
        chunkResults.push({ key, absent: deletion.absent === true });
        if ((index + 1) % 100 === 0) lease = await opened.adapter.renewLock({ masterKey: opened.masterKey }, lease);
      }
      return { planId: plan.planId, completedAt: this.clock(), copies: copyResults, chunks: chunkResults, blocked: plan.blocked };
    } finally {
      await opened.adapter.releaseLock({ masterKey: opened.masterKey }, lease).catch(() => {});
    }
  }
}

module.exports = {
  DEFAULT_MINIMUM_BACKUP_BYTES,
  MAXIMUM_PRUNE_OBJECTS,
  MAXIMUM_PRUNE_POINTS,
  RepositoryPruningError,
  RepositoryPruningService,
  evaluateRepositoryCapacity,
  normalizeStoragePolicy
};
