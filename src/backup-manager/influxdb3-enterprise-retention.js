const { digestJson } = require('./database-adapter');
const { ADAPTER_ID } = require('./influxdb3-enterprise');
const {
  BACKUP_STATES,
  InfluxDb3EnterpriseNativeController,
  RESTORE_STATES,
  normalizeBackupOwnership
} = require('./influxdb3-enterprise-native');
const { SOURCE_LEASE_KIND } = require('./influxdb3-enterprise-source-reader');

const DELETE_CONFIRMATION = 'DELETE INFLUXDB 3 ENTERPRISE NATIVE BACKUP AND ALL DESCENDANTS';
const MAXIMUM_ARTIFACTS = 2000;
const MAXIMUM_JOBS = 1000;
const MAXIMUM_OPERATIONS = 1000;
const MAXIMUM_POINTS = 1000;
const TERMINAL_BACKUP_RUN_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const TERMINAL_RECOVERY_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const NATIVE_MEDIA_DELETION_CLAIM_VERSION = 1;
const NATIVE_MEDIA_DELETION_CLAIM_STATES = new Set(['claimed', 'reconciliation-required']);

class InfluxDb3EnterpriseRetentionError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseRetentionError';
    this.code = code;
    this.category = options.category || 'retention';
    this.retryable = Boolean(options.retryable);
    if (options.operationAccepted === true) this.operationAccepted = true;
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function stableDigest(value) {
  return `sha256:${digestJson(value)}`;
}

function held(value) {
  return value !== undefined && value !== null && value !== false;
}

function immutable(value, evaluatedAtMs) {
  if (value === null || value === undefined || value === '') return false;
  const parsed = Date.parse(String(value));
  return !Number.isFinite(parsed) || parsed > evaluatedAtMs;
}

function sameValue(left, right) {
  return digestJson(left) === digestJson(right);
}

function sameIdentity(execution, identity) {
  return execution.productVersion === identity?.version
    && execution.clusterId === identity?.clusterId
    && execution.storageEngine === identity?.storageEngine
    && execution.nodeId === identity?.nodeId
    && execution.nodeCatalogId === identity?.nodeCatalogId
    && execution.instanceId === identity?.instanceId
    && execution.roleFingerprint === identity?.roleFingerprint
    && execution.deploymentFingerprint === identity?.deploymentFingerprint
    && execution.capabilityFingerprint === identity?.capabilityFingerprint;
}

function sameOwnershipIdentity(execution, ownership) {
  return execution.clusterId === ownership?.clusterId
    && execution.storageEngine === ownership?.storageEngine
    && execution.nodeId === ownership?.nodeId
    && execution.nodeCatalogId === ownership?.nodeCatalogId
    && execution.instanceId === ownership?.instanceId
    && execution.roleFingerprint === ownership?.roleFingerprint
    && execution.deploymentFingerprint === ownership?.deploymentFingerprint
    && execution.capabilityFingerprint === ownership?.capabilityFingerprint;
}

function sameExecutionIdentity(left, right) {
  return left?.productVersion === right?.productVersion
    && left?.clusterId === right?.clusterId
    && left?.storageEngine === right?.storageEngine
    && left?.nodeId === right?.nodeId
    && left?.nodeCatalogId === right?.nodeCatalogId
    && left?.instanceId === right?.instanceId
    && left?.roleFingerprint === right?.roleFingerprint
    && left?.deploymentFingerprint === right?.deploymentFingerprint
    && left?.capabilityFingerprint === right?.capabilityFingerprint;
}

function publicIdentity(execution) {
  return Object.freeze({
    productVersion: execution.productVersion,
    clusterId: execution.clusterId,
    storageEngine: execution.storageEngine,
    nodeId: execution.nodeId,
    nodeCatalogId: execution.nodeCatalogId,
    instanceId: execution.instanceId,
    roleFingerprint: execution.roleFingerprint,
    deploymentFingerprint: execution.deploymentFingerprint,
    capabilityFingerprint: execution.capabilityFingerprint
  });
}

function activeLocalOperationIds({ sourceId, clusterId, closurePointIds, runs, jobs, restores, verifications }) {
  const sourceJobIds = new Set(jobs.filter((job) => job.sourceId === sourceId).map((job) => job.id));
  const active = [];
  for (const run of runs) if (sourceJobIds.has(run.jobId) && !TERMINAL_BACKUP_RUN_STATES.has(run.state)) active.push(run.id);
  for (const restore of restores) {
    const related = (restore.recoveryPointIds || []).some((id) => closurePointIds.has(id)) || restore.target?.sourceId === sourceId || restore.target?.clusterId === clusterId;
    if (related && !TERMINAL_RECOVERY_STATES.has(restore.state)) active.push(restore.id);
  }
  for (const verification of verifications) {
    const ids = [verification.recoveryPointId, ...(verification.recoveryPointIds || [])].filter(Boolean);
    if (ids.some((id) => closurePointIds.has(id)) && !TERMINAL_RECOVERY_STATES.has(verification.state)) active.push(verification.id);
  }
  return [...new Set(active)].sort();
}

function withoutDeletionClaim(retention) {
  const next = { ...(retention || {}) };
  delete next.nativeMediaDeletionClaim;
  return next;
}

function validDigest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function validDeletionClaim(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== NATIVE_MEDIA_DELETION_CLAIM_VERSION
    || !/^influxdb3_enterprise_retention_[a-f0-9]{64}$/.test(value.claimId || '')
    || !NATIVE_MEDIA_DELETION_CLAIM_STATES.has(value.state)
    || typeof value.sourceId !== 'string' || typeof value.targetRecoveryPointId !== 'string'
    || typeof value.connectionId !== 'string' || !Number.isInteger(value.connectionRevision)
    || !validDigest(value.closureFingerprint) || !Array.isArray(value.deletionOrder)
    || !Array.isArray(value.members) || value.members.length < 1 || value.members.length !== value.memberCount
    || value.deletionOrder.length !== value.members.length) return false;
  const pointIds = new Set();
  const backupNames = new Set();
  for (const member of value.members) {
    if (!member || typeof member !== 'object' || Array.isArray(member)
      || typeof member.recoveryPointId !== 'string' || !Number.isInteger(member.claimedRevision) || member.claimedRevision < 1
      || typeof member.backupName !== 'string' || !validDigest(member.watermarkDigest)
      || !validDigest(member.createdAtDigest) || !validDigest(member.completedAtDigest)
      || pointIds.has(member.recoveryPointId) || backupNames.has(member.backupName)) return false;
    pointIds.add(member.recoveryPointId);
    backupNames.add(member.backupName);
  }
  return pointIds.has(value.targetRecoveryPointId)
    && value.deletionOrder.every((name, index) => name === value.members[index].backupName);
}

function normalizeRetentionRequest(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise retention request must be an object.');
  const request = {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    planId: input.planId === undefined || input.planId === null || input.planId === '' ? null : requiredText(input.planId, 'Retention plan ID', 100)
  };
  if (options.requireConfirmation === true) {
    if (!/^influxdb3_enterprise_retention_[a-f0-9]{64}$/.test(request.planId || '')) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_PLAN_REQUIRED', 'Review the current native backup deletion closure before execution.', { category: 'conflict' });
    }
    if (input.confirmed !== true || input.confirmationText !== DELETE_CONFIRMATION) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_CONFIRMATION_REQUIRED', 'Enter the exact native backup deletion confirmation.', { category: 'conflict' });
    }
  }
  return request;
}

function publicPlan(plan) {
  return Object.freeze({
    version: 1,
    planId: plan.planId,
    evaluatedAt: plan.evaluatedAt,
    recoveryPointId: plan.recoveryPointId,
    sourceId: plan.sourceId,
    engine: 'influxdb3-enterprise',
    tier: 'upgraded-native',
    mediaDomain: 'influxdb3-enterprise-native',
    identity: publicIdentity(plan.execution),
    backupName: plan.targetName,
    eligible: plan.blockedReason === null,
    blockedReason: plan.blockedReason,
    activeOperationIds: plan.activeOperationIds,
    closure: Object.freeze(plan.members.map((member) => Object.freeze({
      recoveryPointId: member.point?.id || null,
      backupName: member.backup.name,
      type: member.backup.type,
      parentName: member.backup.parentName,
      status: member.backup.status,
      ownershipAuthenticated: Boolean(member.ownership)
    }))),
    deletionOrder: plan.deletionOrder,
    closureFingerprint: plan.closureFingerprint,
    cascadeCount: plan.deletionOrder.length - 1,
    providerCascade: plan.deletionOrder.length > 1,
    ownership: Object.freeze({
      recoveryPointArtifactAuthenticated: true,
      targetNativeOwnershipAuthenticated: Boolean(plan.members.find((member) => member.backup.name === plan.targetName)?.ownership),
      completeClosureAuthenticated: plan.members.every((member) => Boolean(member.ownership))
    }),
    confirmationText: DELETE_CONFIRMATION,
    previewOnly: true,
    deleteIssued: false
  });
}

class InfluxDb3EnterpriseRetentionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter, nativeController = null, recoveryPointAuthenticator, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !adapter || !recoveryPointAuthenticator || typeof recoveryPointAuthenticator.authenticateRecoveryPoint !== 'function') {
      throw new TypeError('InfluxDB 3 Enterprise retention dependencies are required.');
    }
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.nativeController = nativeController || new InfluxDb3EnterpriseNativeController({ adapter });
    this.recoveryPointAuthenticator = recoveryPointAuthenticator;
    this.clock = clock;
  }

  async preview(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const request = normalizeRetentionRequest(input);
    return publicPlan(await this.#build(tenant, request));
  }

  async execute(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRetentionRequest(input, { requireConfirmation: true });
    const plan = await this.#build(tenant, request);
    if (plan.planId !== request.planId) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_PLAN_STALE', 'The RecoveryPoint, native closure, ownership, policy, identity, or active-operation state changed after review.', { category: 'conflict' });
    }
    if (plan.blockedReason) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_DELETE_BLOCKED', 'Native backup deletion remains blocked by ownership, lifecycle, policy, hold, immutability, or active-operation safety.', { category: 'conflict' });
    }
    const claimed = await this.#acquireDeletionClaim(tenant, actor, plan);
    let claim = claimed.claim;
    let deleted;
    try {
      deleted = await this.nativeController.deleteBackup(this.#nativeContext(tenant), {
        connection: plan.connectionConfig,
        name: plan.targetName,
        ownerships: plan.members.map((member) => member.ownership),
        expectedDeletionOrder: plan.deletionOrder,
        expectedClosureFingerprint: plan.closureFingerprint
      });
    } catch (error) {
      if (error?.details?.operationAccepted === true || error?.operationAccepted === true) {
        await this.#markReconciliationRequired(tenant, actor, claim).catch(() => {});
        throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_DELETE_RECONCILIATION_REQUIRED', 'InfluxDB 3 Enterprise accepted native deletion, but complete removal could not be proven. Reconcile the native catalog before retrying.', { category: 'integrity', operationAccepted: true });
      }
      try { await this.#clearDeletionClaim(tenant, actor, claim); }
      catch {
        throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_DELETE_RECONCILIATION_REQUIRED', 'The native deletion claim could not be released safely. Reconcile the native catalog before retrying.', { category: 'integrity' });
      }
      throw error;
    }
    if (deleted?.deletionAccepted !== true || deleted.evidence?.deletionConfirmed !== true || deleted.evidence?.reconciliationRequired !== false
      || deleted.evidence?.closureFingerprint !== plan.closureFingerprint || !sameValue(deleted.evidence?.deletionOrder, plan.deletionOrder)
      || deleted.evidence?.memberCount !== plan.members.length || !sameIdentity(plan.execution, deleted.identity)) {
      await this.#markReconciliationRequired(tenant, actor, claim).catch(() => {});
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_DELETE_UNCONFIRMED', 'InfluxDB 3 Enterprise did not prove complete deletion of the reviewed native backup closure.', { category: 'integrity', operationAccepted: deleted?.deletionAccepted === true });
    }
    const deletedAt = this.clock();
    let projected;
    try {
      projected = await this.#finalizeDeletionClaim(tenant, actor, claim, deletedAt, { reconciled: false });
    } catch (error) {
      if (error instanceof InfluxDb3EnterpriseRetentionError && error.operationAccepted) throw error;
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_STATE_COMMIT_FAILED', 'Native backup deletion completed, but RecoveryPoint state could not be committed. Catalog reconciliation is required.', { category: 'integrity', operationAccepted: true });
    }
    return Object.freeze({
      version: 1,
      planId: plan.planId,
      state: 'succeeded',
      recoveryPointId: plan.recoveryPointId,
      recoveryPointIds: Object.freeze(projected.map((point) => point.id)),
      backupName: plan.targetName,
      deletionOrder: plan.deletionOrder,
      closureFingerprint: plan.closureFingerprint,
      nativeBackupsDeleted: plan.members.length,
      providerCascade: plan.members.length > 1,
      deletionConfirmed: true,
      repositoryMetadataPreserved: true,
      completedAt: deletedAt
    });
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const points = await this.controlDatabase.repository('recoveryPoint').list(tenant, { limit: MAXIMUM_POINTS });
    if (points.length >= MAXIMUM_POINTS) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_SCAN_LIMIT', 'Retention reconciliation could not prove the complete bounded RecoveryPoint catalog.', { category: 'capacity' });
    }
    const groups = new Map();
    for (const point of points.filter((candidate) => candidate.retention?.nativeMediaDeletionClaim)) {
      const claim = point.retention.nativeMediaDeletionClaim;
      const key = typeof claim?.claimId === 'string' ? claim.claimId : `invalid:${point.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(point);
    }
    const results = [];
    for (const records of groups.values()) {
      const claim = records[0].retention.nativeMediaDeletionClaim;
      const exactMembers = validDeletionClaim(claim)
        && records.length === claim.memberCount
        && records.every((point) => sameValue(point.retention.nativeMediaDeletionClaim, claim))
        && claim.members.every((member) => records.some((point) => point.id === member.recoveryPointId && point.revision === member.claimedRevision));
      if (!exactMembers) {
        results.push(Object.freeze({ version: 1, claimId: validDeletionClaim(claim) ? claim.claimId : null, state: 'reconciliation-required', nativeMediaDeleted: false, recoveryPointIds: Object.freeze(records.map((point) => point.id).sort()) }));
        continue;
      }
      try {
        results.push(await this.#reconcileDeletionClaim(tenant, actor, claim));
      } catch {
        await this.#markReconciliationRequired(tenant, actor, claim).catch(() => {});
        results.push(Object.freeze({ version: 1, claimId: claim.claimId, state: 'reconciliation-required', nativeMediaDeleted: false, recoveryPointIds: Object.freeze(claim.members.map((member) => member.recoveryPointId)) }));
      }
    }
    return Object.freeze(results);
  }

  async #acquireDeletionClaim(workspaceId, actorId, plan) {
    const claimedAt = this.clock();
    const claimedAtMs = Date.parse(claimedAt);
    if (!Number.isFinite(claimedAtMs)) throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_CLOCK_INVALID', 'Retention claim time is invalid.', { category: 'internal' });
    const claim = {
      version: NATIVE_MEDIA_DELETION_CLAIM_VERSION,
      claimId: plan.planId,
      state: 'claimed',
      sourceId: plan.sourceId,
      sourceRevision: plan.sourceRevision,
      connectionId: plan.connection.id,
      connectionRevision: plan.connection.revision,
      targetRecoveryPointId: plan.recoveryPointId,
      closureFingerprint: plan.closureFingerprint,
      memberCount: plan.members.length,
      deletionOrder: [...plan.deletionOrder],
      members: plan.members.map((member) => ({
        recoveryPointId: member.point.id,
        claimedRevision: member.point.revision + 1,
        backupName: member.backup.name,
        backupType: member.backup.type,
        parentName: member.backup.parentName,
        status: member.backup.status,
        watermarkDigest: stableDigest(member.backup.watermark),
        createdAtDigest: stableDigest(member.backup.createdAt || null),
        completedAtDigest: stableDigest(member.backup.completedAt || null)
      })),
      identity: publicIdentity(plan.execution),
      createdAt: claimedAt,
      updatedAt: claimedAt
    };
    try {
      const points = await this.controlDatabase.transaction((transaction) => {
        const currentMembers = plan.members.map((member) => transaction.get('recoveryPoint', workspaceId, member.point.id));
        if (currentMembers.some((point, index) => !point || point.revision !== plan.members[index].point.revision || point.sourceId !== plan.sourceId
          || point.retention?.nativeMediaDeletionClaim || point.retention?.nativeMediaDeleted === true
          || point.retention?.deletionEligible !== true || held(point.legalHold) || held(point.retention?.legalHold)
          || immutable(point.immutableUntil, claimedAtMs) || (point.repositoryCopies || []).some((copy) => immutable(copy.immutableUntil, claimedAtMs) || held(copy.legalHold)))) {
          throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_STATE_CHANGED', 'A RecoveryPoint policy, hold, immutability, or revision changed before native deletion admission.', { category: 'conflict' });
        }
        const runs = transaction.list('run', workspaceId, { limit: MAXIMUM_OPERATIONS });
        const jobs = transaction.list('backupJob', workspaceId, { limit: MAXIMUM_JOBS });
        const restores = transaction.list('restoreRun', workspaceId, { limit: MAXIMUM_OPERATIONS });
        const verifications = transaction.list('verificationRun', workspaceId, { limit: MAXIMUM_OPERATIONS });
        if (runs.length >= MAXIMUM_OPERATIONS || jobs.length >= MAXIMUM_JOBS || restores.length >= MAXIMUM_OPERATIONS || verifications.length >= MAXIMUM_OPERATIONS) {
          throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_SCAN_LIMIT', 'Retention claim admission could not prove the complete bounded active-operation catalogs.', { category: 'capacity' });
        }
        const active = activeLocalOperationIds({
          sourceId: plan.sourceId,
          clusterId: plan.execution.clusterId,
          closurePointIds: new Set(plan.members.map((member) => member.point.id)),
          runs,
          jobs,
          restores,
          verifications
        });
        if (active.length) throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_DELETE_BLOCKED', 'A backup, restore, or verification became active before native deletion admission.', { category: 'conflict' });
        return currentMembers.map((point) => transaction.projectRecoveryPointRetention(workspaceId, point.id, {
          ...(point.retention || {}),
          nativeMediaDeletionClaim: claim
        }, { expectedRevision: point.revision, actorId, nativeMediaDeletionClaimId: claim.claimId }));
      });
      return { claim: Object.freeze(structuredClone(claim)), points: Object.freeze(points) };
    } catch (error) {
      if (error instanceof InfluxDb3EnterpriseRetentionError) throw error;
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_CLAIM_FAILED', 'The native backup deletion claim could not be acquired atomically.', { category: 'conflict', retryable: true });
    }
  }

  async #clearDeletionClaim(workspaceId, actorId, claim) {
    return this.controlDatabase.transaction((transaction) => claim.members.map((member) => {
      const current = transaction.get('recoveryPoint', workspaceId, member.recoveryPointId);
      if (!current || current.revision !== member.claimedRevision || !sameValue(current.retention?.nativeMediaDeletionClaim, claim)) {
        throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_STATE_CHANGED', 'The durable native deletion claim changed before it could be released.', { category: 'integrity' });
      }
      return transaction.projectRecoveryPointRetention(workspaceId, current.id, withoutDeletionClaim(current.retention), {
        expectedRevision: current.revision,
        actorId,
        nativeMediaDeletionClaimId: claim.claimId
      });
    }));
  }

  async #markReconciliationRequired(workspaceId, actorId, claim) {
    const updatedAt = this.clock();
    return this.controlDatabase.transaction((transaction) => {
      const currentPoints = claim.members.map((member) => transaction.get('recoveryPoint', workspaceId, member.recoveryPointId));
      if (currentPoints.some((point, index) => !point || point.revision !== claim.members[index].claimedRevision || !sameValue(point.retention?.nativeMediaDeletionClaim, claim))) {
        throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_STATE_CHANGED', 'The durable native deletion claim changed before reconciliation state could be recorded.', { category: 'integrity' });
      }
      const updatedClaim = {
        ...claim,
        state: 'reconciliation-required',
        members: claim.members.map((member, index) => ({ ...member, claimedRevision: currentPoints[index].revision + 1 })),
        updatedAt
      };
      return {
        claim: Object.freeze(structuredClone(updatedClaim)),
        points: currentPoints.map((point) => transaction.projectRecoveryPointRetention(workspaceId, point.id, {
          ...(point.retention || {}),
          nativeMediaDeletionClaim: updatedClaim
        }, { expectedRevision: point.revision, actorId, nativeMediaDeletionClaimId: claim.claimId }))
      };
    });
  }

  async #finalizeDeletionClaim(workspaceId, actorId, claim, deletedAt, options = {}) {
    return this.controlDatabase.transaction((transaction) => claim.members.map((member) => {
      const current = transaction.get('recoveryPoint', workspaceId, member.recoveryPointId);
      if (!current || current.revision !== member.claimedRevision || !sameValue(current.retention?.nativeMediaDeletionClaim, claim) || current.retention?.nativeMediaDeleted === true) {
        throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_STATE_CHANGED', 'A RecoveryPoint changed while native deletion was being reconciled.', { category: 'integrity', operationAccepted: true });
      }
      return transaction.projectRecoveryPointRetention(workspaceId, current.id, {
        ...withoutDeletionClaim(current.retention),
        deletionEligible: false,
        nativeMediaDeleted: true,
        nativeMediaState: 'deleted',
        nativeMediaDeletedAt: deletedAt,
        nativeMediaDeletionPlanId: claim.claimId,
        nativeMediaDeletionEvidence: {
          version: 1,
          closureFingerprint: claim.closureFingerprint,
          targetBackupNameDigest: stableDigest(claim.members.find((candidate) => candidate.recoveryPointId === claim.targetRecoveryPointId)?.backupName),
          memberCount: claim.memberCount,
          providerCascade: claim.memberCount > 1,
          deletionConfirmed: true,
          reconciledAfterRestart: options.reconciled === true
        }
      }, { expectedRevision: current.revision, actorId, nativeMediaDeletionClaimId: claim.claimId });
    }));
  }

  async #reconcileDeletionClaim(workspaceId, actorId, claim) {
    const source = await this.controlDatabase.repository('source').get(workspaceId, claim.sourceId);
    if (!source || source.revision !== claim.sourceRevision || source.connectionId !== claim.connectionId) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_BINDING_CHANGED', 'The Source binding changed before native deletion reconciliation.', { category: 'integrity' });
    }
    const execution = { ...claim.identity, connectionRevision: claim.connectionRevision };
    const admitted = await this.#admitConnection(workspaceId, source, execution);
    const catalog = await this.nativeController.listBackups(this.#nativeContext(workspaceId), { connection: admitted.connectionConfig });
    if (!sameIdentity(execution, catalog.identity)) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_NATIVE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise identity changed during native deletion reconciliation.', { category: 'integrity' });
    }
    const byName = new Map(catalog.backups.map((backup) => [backup.name, backup]));
    const states = claim.members.map((member) => {
      const remote = byName.get(member.backupName);
      if (!remote) return 'absent';
      const exact = remote.type === member.backupType && remote.parentName === member.parentName && remote.status === member.status
        && stableDigest(remote.watermark) === member.watermarkDigest
        && stableDigest(remote.createdAt || null) === member.createdAtDigest
        && stableDigest(remote.completedAt || null) === member.completedAtDigest;
      return exact ? 'present' : 'mismatch';
    });
    if (states.every((state) => state === 'absent')) {
      const completedAt = this.clock();
      const projected = await this.#finalizeDeletionClaim(workspaceId, actorId, claim, completedAt, { reconciled: true });
      return Object.freeze({ version: 1, claimId: claim.claimId, state: 'succeeded', nativeMediaDeleted: true, recoveryPointIds: Object.freeze(projected.map((point) => point.id)), completedAt });
    }
    if (states.every((state) => state === 'present')) {
      const projected = await this.#clearDeletionClaim(workspaceId, actorId, claim);
      return Object.freeze({ version: 1, claimId: claim.claimId, state: 'released', nativeMediaDeleted: false, recoveryPointIds: Object.freeze(projected.map((point) => point.id)), completedAt: this.clock() });
    }
    await this.#markReconciliationRequired(workspaceId, actorId, claim);
    return Object.freeze({ version: 1, claimId: claim.claimId, state: 'reconciliation-required', nativeMediaDeleted: false, recoveryPointIds: Object.freeze(claim.members.map((member) => member.recoveryPointId)) });
  }

  async #build(workspaceId, request) {
    const evaluatedAt = this.clock();
    const evaluatedAtMs = Date.parse(evaluatedAt);
    if (!Number.isFinite(evaluatedAtMs)) throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_CLOCK_INVALID', 'Retention evaluation time is invalid.', { category: 'internal' });
    const target = await this.recoveryPointAuthenticator.authenticateRecoveryPoint(workspaceId, request.recoveryPointId, { allowDeletionEligible: true });
    const admitted = await this.#admitConnection(workspaceId, target.source, target.execution);
    const context = this.#nativeContext(workspaceId);
    const nativePreview = await this.nativeController.previewDeleteBackup(context, { connection: admitted.connectionConfig, name: target.metadata.operation.backupName });
    if (!sameIdentity(target.execution, nativePreview.identity)
      || nativePreview.target?.name !== target.metadata.operation.backupName
      || nativePreview.target?.status !== BACKUP_STATES.COMPLETED
      || !sameValue(nativePreview.target?.watermark, target.metadata.operation.watermark)) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_NATIVE_IDENTITY_INVALID', 'The native backup no longer matches the authenticated RecoveryPoint and cluster.', { category: 'integrity' });
    }
    const [points, artifacts, runs, jobs, restores, verifications, nativeBackups, nativeRestores] = await Promise.all([
      this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: MAXIMUM_POINTS }),
      this.controlDatabase.repository('artifact').list(workspaceId, { limit: MAXIMUM_ARTIFACTS }),
      this.controlDatabase.repository('run').list(workspaceId, { limit: MAXIMUM_OPERATIONS }),
      this.controlDatabase.repository('backupJob').list(workspaceId, { limit: MAXIMUM_JOBS }),
      this.controlDatabase.repository('restoreRun').list(workspaceId, { limit: MAXIMUM_OPERATIONS }),
      this.controlDatabase.repository('verificationRun').list(workspaceId, { limit: MAXIMUM_OPERATIONS }),
      this.nativeController.listBackups(context, { connection: admitted.connectionConfig }),
      this.nativeController.listRestores(context, { connection: admitted.connectionConfig })
    ]);
    if (points.length >= MAXIMUM_POINTS || artifacts.length >= MAXIMUM_ARTIFACTS || runs.length >= MAXIMUM_OPERATIONS || jobs.length >= MAXIMUM_JOBS || restores.length >= MAXIMUM_OPERATIONS || verifications.length >= MAXIMUM_OPERATIONS) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_SCAN_LIMIT', 'Retention could not prove the complete bounded RecoveryPoint and active-operation catalogs.', { category: 'capacity' });
    }
    if (!sameIdentity(target.execution, nativeBackups.identity) || !sameIdentity(target.execution, nativeRestores.identity)) {
      throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_NATIVE_IDENTITY_INVALID', 'InfluxDB 3 Enterprise identity changed during retention planning.', { category: 'integrity' });
    }
    const pointById = new Map(points.filter((point) => point.sourceId === target.source.id).map((point) => [point.id, point]));
    pointById.set(target.point.id, target.point);
    const remoteByName = new Map(nativeBackups.backups.map((backup) => [backup.name, backup]));
    const authenticatedByPointId = new Map([[target.point.id, target]]);
    const members = [];
    for (const backupName of nativePreview.deletionOrder) {
      const remote = remoteByName.get(backupName);
      const memberBackup = remote || { name: backupName, type: 'unknown', parentName: null, status: null, watermark: null };
      const candidateIds = [...new Set(artifacts
        .filter((artifact) => pointById.has(artifact.recoveryPointId) && artifact.kind === 'metadata' && artifact.metadata?.adapterId === ADAPTER_ID && artifact.metadata?.kind === SOURCE_LEASE_KIND && artifact.metadata?.operation?.backupName === backupName)
        .map((artifact) => artifact.recoveryPointId))];
      let authenticated = null;
      if (backupName === target.metadata.operation.backupName) authenticated = target;
      else if (candidateIds.length === 1) {
        try {
          authenticated = authenticatedByPointId.get(candidateIds[0]) || await this.recoveryPointAuthenticator.authenticateRecoveryPoint(workspaceId, candidateIds[0], { allowDeletionEligible: true });
          authenticatedByPointId.set(candidateIds[0], authenticated);
        } catch {}
      }
      let ownership = null;
      if (authenticated && remote && authenticated.source.id === target.source.id && sameExecutionIdentity(target.execution, authenticated.execution) && authenticated.metadata.operation.backupName === backupName
        && authenticated.metadata.operation.backupType === remote.type
        && authenticated.metadata.operation.status === remote.status
        && sameValue(authenticated.metadata.operation.watermark, remote.watermark)) {
        const run = runs.find((candidate) => candidate.id === authenticated.point.runId);
        ownership = this.#ownedBackup(workspaceId, authenticated, run);
      }
      members.push({ backup: memberBackup, point: authenticated?.point || null, authenticated, ownership });
    }
    const closurePointIds = new Set(members.filter((member) => member.point).map((member) => member.point.id));
    const sourceJobIds = new Set(jobs.filter((job) => job.sourceId === target.source.id).map((job) => job.id));
    const activeOperationIds = [];
    for (const run of runs) if (sourceJobIds.has(run.jobId) && !TERMINAL_BACKUP_RUN_STATES.has(run.state)) activeOperationIds.push(run.id);
    for (const restore of restores) {
      const related = (restore.recoveryPointIds || []).some((id) => closurePointIds.has(id)) || restore.target?.sourceId === target.source.id || restore.target?.clusterId === target.execution.clusterId;
      if (related && !TERMINAL_RECOVERY_STATES.has(restore.state)) activeOperationIds.push(restore.id);
    }
    for (const verification of verifications) {
      const ids = [verification.recoveryPointId, ...(verification.recoveryPointIds || [])].filter(Boolean);
      if (ids.some((id) => closurePointIds.has(id)) && !TERMINAL_RECOVERY_STATES.has(verification.state)) activeOperationIds.push(verification.id);
    }
    for (const backup of nativeBackups.backups) if (backup.status === BACKUP_STATES.IN_PROGRESS) activeOperationIds.push(`native-backup:${stableDigest(backup.name)}`);
    for (const restore of nativeRestores.restores) if (restore.status === RESTORE_STATES.IN_PROGRESS) activeOperationIds.push(`native-restore:${stableDigest(restore.id)}`);
    const boundedActiveOperationIds = [...new Set(activeOperationIds)].sort();
    let blockedReason = null;
    if (nativePreview.completedOnly !== true || members.some((member) => !member.backup || member.backup.status !== BACKUP_STATES.COMPLETED)) blockedReason = 'native-backup-not-completed';
    else if (members.some((member) => !member.point || !member.ownership)) blockedReason = 'native-ownership-incomplete';
    else if (members.some((member) => member.point.retention?.nativeMediaDeleted === true)) blockedReason = 'native-media-already-deleted';
    else if (members.some((member) => member.point.retention?.deletionEligible !== true)) blockedReason = 'retention-not-eligible';
    else if (members.some((member) => held(member.point.legalHold) || held(member.point.retention?.legalHold))) blockedReason = 'legal-hold';
    else if (members.some((member) => immutable(member.point.immutableUntil, evaluatedAtMs) || (member.point.repositoryCopies || []).some((copy) => immutable(copy.immutableUntil, evaluatedAtMs) || held(copy.legalHold)))) blockedReason = 'immutable-or-copy-hold';
    else if (boundedActiveOperationIds.length) blockedReason = 'active-operation';
    const memberEvidence = members.map((member) => ({
      backupName: member.backup.name,
      backupType: member.backup.type,
      parentName: member.backup.parentName,
      status: member.backup.status,
      watermarkDigest: stableDigest(member.backup.watermark),
      recoveryPointId: member.point?.id || null,
      recoveryPointRevision: member.point?.revision || null,
      metadataDigest: member.authenticated?.metadataDigest || null,
      ownershipDigest: member.ownership ? stableDigest(member.ownership) : null,
      retentionDigest: member.point ? stableDigest(member.point.retention || {}) : null
    }));
    const evidence = {
      version: 1,
      recoveryPointId: target.point.id,
      sourceId: target.source.id,
      sourceRevision: target.source.revision,
      connectionId: admitted.connection.id,
      connectionRevision: admitted.connection.revision,
      targetName: target.metadata.operation.backupName,
      targetMetadataDigest: target.metadataDigest,
      closureFingerprint: nativePreview.closureFingerprint,
      deletionOrder: nativePreview.deletionOrder,
      members: memberEvidence,
      activeOperationIds: boundedActiveOperationIds,
      blockedReason
    };
    return {
      ...evidence,
      evaluatedAt,
      planId: `influxdb3_enterprise_retention_${digestJson(evidence)}`,
      execution: target.execution,
      connection: admitted.connection,
      connectionConfig: admitted.connectionConfig,
      members,
      ownerships: members.map((member) => member.ownership)
    };
  }

  #ownedBackup(workspaceId, authenticated, run) {
    const lease = run?.sourceLease;
    if (!run || run.state !== 'succeeded' || lease?.version !== 1 || lease.kind !== SOURCE_LEASE_KIND || lease.state !== 'released'
      || lease.releaseReason !== 'repository-committed' || lease.workspaceId !== workspaceId || lease.sourceId !== authenticated.source.id
      || lease.executionId !== run.id || lease.connectionId !== authenticated.source.connectionId || lease.backupName !== authenticated.metadata.operation.backupName
      || lease.ownerId !== stableDigest({ workspaceId, executionId: run.id })) return null;
    let ownership;
    try { ownership = normalizeBackupOwnership(lease.ownership, lease.backupName); }
    catch { return null; }
    return sameOwnershipIdentity(authenticated.execution, ownership) ? ownership : null;
  }

  async #admitConnection(workspaceId, source, execution) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, source.connectionId);
    const identity = connection?.lastTest?.endpointIdentity;
    const pinsMatch = connection?.adapterId === ADAPTER_ID
      && connection.revision === execution.connectionRevision
      && connection.lastTest?.status === 'success'
      && (connection.workerAffinity || []).includes(`device:${this.deviceId}`)
      && connection.endpoint?.expectedVersion === execution.productVersion
      && connection.endpoint?.expectedStorageEngine === execution.storageEngine
      && connection.endpoint?.expectedClusterId === execution.clusterId
      && connection.endpoint?.expectedNodeId === execution.nodeId
      && connection.endpoint?.expectedNodeCatalogId === execution.nodeCatalogId
      && connection.endpoint?.expectedInstanceId === execution.instanceId
      && connection.endpoint?.expectedRoleFingerprint === execution.roleFingerprint
      && connection.endpoint?.expectedDeploymentFingerprint === execution.deploymentFingerprint
      && connection.endpoint?.expectedCapabilityFingerprint === execution.capabilityFingerprint
      && connection.trust?.fingerprint === execution.deploymentFingerprint
      && connection.trust?.clusterId === execution.clusterId
      && connection.trust?.nodeId === execution.nodeId
      && connection.trust?.nodeCatalogId === execution.nodeCatalogId
      && connection.trust?.instanceId === execution.instanceId
      && connection.trust?.roleFingerprint === execution.roleFingerprint
      && connection.trust?.capabilityFingerprint === execution.capabilityFingerprint
      && identity?.compactorCapable === true
      && identity?.nativeBackupAvailable === true
      && sameIdentity(execution, identity);
    if (!pinsMatch) throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_CONNECTION_INVALID', 'Retest the exact upgraded-engine compactor connection before native retention.', { category: 'integrity', retryable: true });
    if (!Array.isArray(connection.secretRefIds) || connection.secretRefIds.length !== 1) throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_CONNECTION_INVALID', 'The InfluxDB 3 Enterprise admin-token binding is invalid.', { category: 'authentication' });
    let connectionConfig;
    try { connectionConfig = this.adapter.normalizeConfig({ ...connection.endpoint, adminTokenSecretRefId: connection.secretRefIds[0] }); }
    catch { throw new InfluxDb3EnterpriseRetentionError('INFLUXDB3_ENTERPRISE_RETENTION_CONNECTION_INVALID', 'The tested InfluxDB 3 Enterprise connection binding is invalid.', { category: 'configuration' }); }
    return { connection, connectionConfig };
  }

  #nativeContext(workspaceId) {
    return { resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }) };
  }
}

module.exports = {
  DELETE_CONFIRMATION,
  InfluxDb3EnterpriseRetentionError,
  InfluxDb3EnterpriseRetentionService,
  MAXIMUM_ARTIFACTS,
  MAXIMUM_JOBS,
  MAXIMUM_OPERATIONS,
  MAXIMUM_POINTS,
  normalizeRetentionRequest,
  publicPlan,
  stableDigest
};
