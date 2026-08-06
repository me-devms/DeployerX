const crypto = require('crypto');
const { RESTORE_CONFIRMATION } = require('./influxdb3-enterprise-legacy');
const { normalizeRestoreRequest } = require('./influxdb3-enterprise-legacy-restore');
const { ARTIFACT_KIND, SOURCE_TIER } = require('./influxdb3-enterprise-legacy-source-reader');

const METADATA_MODE = 'influxdb3-enterprise-legacy-metadata';
const DRILL_MODE = 'influxdb3-enterprise-legacy-full-drill';
const DRILL_CONFIRMATION = 'RUN INFLUXDB3 ENTERPRISE LEGACY RECOVERY DRILL';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const MAX_CLUSTER_STOP_EVIDENCE_CHECKS = 64;

class InfluxDb3EnterpriseLegacyVerificationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseLegacyVerificationError';
    this.code = code;
    this.category = options.category || 'verification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function exactOwner(workspaceId, verificationRunId) {
  return `legacy-drill:${crypto.createHash('sha256').update(`${workspaceId}\0${verificationRunId}`).digest('hex')}`;
}

function publicError(error) {
  if (error?.code) return { code: String(error.code).slice(0, 120), category: String(error.category || 'verification').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The InfluxDB 3 Enterprise legacy recovery test failed.').slice(0, 500) };
  return { code: 'INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_FAILED', category: 'verification', retryable: false, safeMessage: 'DeployerX could not complete the InfluxDB 3 Enterprise legacy recovery test.' };
}

function assertRestorableArtifact(selected) {
  const metadata = selected?.metadata;
  if (metadata?.kind !== ARTIFACT_KIND || metadata?.tier !== SOURCE_TIER || metadata?.artifact?.restoreSupported !== true || metadata?.capture?.completeMediaAuthenticated !== true || metadata?.publication?.localPathsPublished !== false || selected?.artifact?.metadata?.kind !== metadata.kind) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_ARTIFACT_INVALID', 'The authenticated InfluxDB 3 Enterprise legacy Artifact is not approved for recovery validation.', { category: 'integrity' });
}

function targetDigest(target) {
  return stableDigest({ kind: target?.kind, dataRoot: target?.dataRoot, clusterId: target?.clusterId, compactorNodeId: target?.compactorNodeId, dataNodeIds: target?.dataNodeIds });
}

function expectedTargetNodeSet(target) {
  const nodes = [target?.compactorNodeId, ...(Array.isArray(target?.dataNodeIds) ? target.dataNodeIds : [])]
    .map((nodeId) => requiredText(nodeId, 'Drill target node ID', 200))
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  if (!nodes.length || new Set(nodes).size !== nodes.length) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_STOP_PROOF_INVALID', 'The recovery drill target node set is invalid.', { category: 'integrity' });
  return Object.freeze(nodes);
}

function normalizeClusterStopEvidence(input, target) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['version', 'checkCount', 'firstIssuedAt', 'lastIssuedAt', 'finalProofDigest', 'nodeCount', 'nodeSetDigest', 'proofChainDigest'].includes(key))) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_STOP_PROOF_INVALID', 'The bounded cluster stop-proof evidence is invalid.', { category: 'integrity' });
  const checkCount = Number(input.checkCount);
  const nodeCount = Number(input.nodeCount);
  const expectedNodes = expectedTargetNodeSet(target);
  const firstIssuedAt = new Date(input.firstIssuedAt);
  const lastIssuedAt = new Date(input.lastIssuedAt);
  const valid = input.version === 1
    && Number.isInteger(checkCount) && checkCount >= 1 && checkCount <= MAX_CLUSTER_STOP_EVIDENCE_CHECKS
    && Number.isInteger(nodeCount) && nodeCount === expectedNodes.length
    && !Number.isNaN(firstIssuedAt.getTime()) && firstIssuedAt.toISOString() === input.firstIssuedAt
    && !Number.isNaN(lastIssuedAt.getTime()) && lastIssuedAt.toISOString() === input.lastIssuedAt
    && firstIssuedAt.getTime() <= lastIssuedAt.getTime()
    && /^hmac-sha256:[0-9a-f]{64}$/.test(input.finalProofDigest || '')
    && input.nodeSetDigest === stableDigest(expectedNodes)
    && /^sha256:[0-9a-f]{64}$/.test(input.proofChainDigest || '');
  if (!valid) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_STOP_PROOF_INVALID', 'The bounded cluster stop-proof evidence does not match the exact drill target.', { category: 'integrity' });
  return Object.freeze({
    version: 1,
    checkCount,
    firstIssuedAt: input.firstIssuedAt,
    lastIssuedAt: input.lastIssuedAt,
    finalProofDigest: input.finalProofDigest,
    nodeCount,
    nodeSetDigest: input.nodeSetDigest,
    proofChainDigest: input.proofChainDigest
  });
}

function compactDrillStopEvidence(entries, target) {
  if (!Array.isArray(entries) || entries.length < 3 || entries.length > 8) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_STOP_PROOF_INVALID', 'The recovery drill stop-proof boundary set is invalid.', { category: 'integrity' });
  const normalized = entries.map((entry) => {
    const boundary = requiredText(entry?.boundary, 'Recovery drill stop-proof boundary', 80);
    if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(boundary)) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_STOP_PROOF_INVALID', 'The recovery drill stop-proof boundary is invalid.', { category: 'integrity' });
    return Object.freeze({ boundary, evidence: normalizeClusterStopEvidence(entry.evidence, target) });
  });
  const checkCount = normalized.reduce((total, entry) => total + entry.evidence.checkCount, 0);
  const first = normalized[0].evidence;
  const last = normalized[normalized.length - 1].evidence;
  if (checkCount > MAX_CLUSTER_STOP_EVIDENCE_CHECKS || normalized.some((entry) => entry.evidence.nodeCount !== first.nodeCount || entry.evidence.nodeSetDigest !== first.nodeSetDigest)) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_STOP_PROOF_CHANGED', 'The exact drill target node set changed across stopped-cluster boundaries.', { category: 'integrity' });
  return Object.freeze({
    version: 1,
    checkCount,
    firstIssuedAt: first.firstIssuedAt,
    lastIssuedAt: last.lastIssuedAt,
    finalProofDigest: last.finalProofDigest,
    nodeCount: first.nodeCount,
    nodeSetDigest: first.nodeSetDigest,
    proofChainDigest: stableDigest(normalized)
  });
}

function normalizeIsolationEvidence(input, owner, expectedTargetDigest) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.owner !== owner || input.isolated !== true || input.serviceExposed !== false || input.targetDigest !== expectedTargetDigest) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_ISOLATION_UNPROVEN', 'The InfluxDB 3 Enterprise legacy drill target isolation could not be proven.', { category: 'authorization' });
  const bindingFingerprint = requiredText(input.bindingFingerprint, 'Drill target binding fingerprint', 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(bindingFingerprint)) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_ISOLATION_UNPROVEN', 'The InfluxDB 3 Enterprise legacy drill target binding is invalid.', { category: 'integrity' });
  return Object.freeze({
    owner,
    targetId: requiredText(input.targetId, 'Drill target ID', 200),
    controllerId: requiredText(input.controllerId, 'Drill isolation controller ID', 200),
    bindingFingerprint,
    targetDigest: expectedTargetDigest,
    isolated: true,
    serviceExposed: false
  });
}

class InfluxDb3EnterpriseLegacyRecoveryTestService {
  constructor({ controlDatabase, restoreService, assertTargetIsolated, deviceId, notificationService = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !restoreService || typeof restoreService.authenticateRecoveryPoint !== 'function' || typeof restoreService.preview !== 'function' || typeof restoreService.assertTargetStopped !== 'function' || typeof restoreService.start !== 'function' || typeof restoreService.wait !== 'function' || typeof restoreService.cancel !== 'function') throw new TypeError('InfluxDB 3 Enterprise legacy recovery-test dependencies are required.');
    if (typeof assertTargetIsolated !== 'function') throw new TypeError('InfluxDB 3 Enterprise legacy recovery drills require an isolation proof provider.');
    this.controlDatabase = controlDatabase;
    this.restoreService = restoreService;
    this.assertTargetIsolated = assertTargetIsolated;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.notificationService = notificationService;
    this.clock = clock;
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const mode = String(input.mode || METADATA_MODE);
    if (![METADATA_MODE, DRILL_MODE].includes(mode)) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_MODE_INVALID', 'Choose legacy metadata authentication or a full isolated alternate-storage drill.', { category: 'validation' });
    if (mode === DRILL_MODE && (input.confirmed !== true || input.confirmationText !== DRILL_CONFIRMATION)) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_CONFIRMATION_REQUIRED', 'Confirm the full isolated InfluxDB 3 Enterprise legacy recovery drill exactly before continuing.', { category: 'conflict' });
    const recoveryPointId = requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200);
    const selected = await this.restoreService.authenticateRecoveryPoint(tenant, recoveryPointId, input.signal);
    assertRestorableArtifact(selected);
    let executionInput = input;
    let drillTargetDigest = null;
    if (mode === DRILL_MODE) {
      let normalized;
      try { normalized = normalizeRestoreRequest({ recoveryPointId, targetConnectionId: input.targetConnectionId, target: input.target, mode: 'alternate' }, { requireConfirmation: false }); }
      catch { throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_TARGET_INVALID', 'Choose an exact isolated alternate local target for the recovery drill.', { category: 'validation' }); }
      executionInput = { ...input, targetConnectionId: normalized.targetConnectionId, target: normalized.target };
      drillTargetDigest = targetDigest(normalized.target);
    }
    const now = this.clock();
    const record = await this.controlDatabase.repository('verificationRun').create({
      workspaceId: tenant,
      actorId: actor,
      scopeType: 'recovery-point',
      scopeId: selected.point.id,
      recoveryPointId: selected.point.id,
      recoveryPointIds: [selected.point.id],
      repositoryId: selected.repositoryId,
      mode,
      targetConnectionId: mode === DRILL_MODE ? requiredText(input.targetConnectionId, 'Drill target connection ID', 200) : null,
      targetDigest: drillTargetDigest,
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      restoreRunId: null,
      isolation: null,
      progress: { phase: 'queued', startedAt: null, updatedAt: now },
      evidence: null,
      result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, executionInput, controller.signal).catch(() => this.controlDatabase.repository('verificationRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller, restoreRunId: null, restoreCancelRequested: false });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(verificationRunId, 'Verification Run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!this.#owns(record)) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_NOT_FOUND', 'The InfluxDB 3 Enterprise legacy recovery test was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(verificationRunId, 'Verification Run ID', 200);
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!this.#owns(record)) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_NOT_FOUND', 'The InfluxDB 3 Enterprise legacy recovery test was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_NOT_ACTIVE', 'The InfluxDB 3 Enterprise legacy recovery test is not active in this process.', { category: 'conflict' });
    active.controller.abort(new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_CANCELED', 'The InfluxDB 3 Enterprise legacy recovery test was canceled.', { category: 'canceled' }));
    await this.#cancelRestore(tenant, actor, active);
    await active.operation;
    return this.controlDatabase.repository('verificationRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    const records = await this.controlDatabase.repository('verificationRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) });
    return records.filter((record) => this.#owns(record));
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const records = (await this.list(tenant, { limit: 200 })).filter((record) => !TERMINAL_STATES.has(record.state) && !this.active.has(record.id));
    if (records.some((record) => record.mode === DRILL_MODE && record.restoreRunId) && typeof this.restoreService.reconcile === 'function') await this.restoreService.reconcile(tenant, actor).catch(() => {});
    const projected = [];
    for (const record of records) {
      const restore = record.restoreRunId ? await this.controlDatabase.repository('restoreRun').get(tenant, record.restoreRunId) : null;
      const targetPreserved = record.mode === DRILL_MODE && (restore?.target?.targetMutationStarted === true || restore?.target?.filesystemMutationStarted === true || restore?.result?.targetPreserved === true);
      projected.push(await this.#project(tenant, record.id, {
        state: 'interrupted',
        progress: { ...(record.progress || {}), phase: targetPreserved ? 'operator-action-required' : 'interrupted', updatedAt: this.clock() },
        result: {
          state: 'interrupted',
          recoveryPointId: record.recoveryPointId,
          restoreRunId: record.restoreRunId || null,
          targetPreserved,
          targetCleanupAttempted: false,
          rollbackPerformed: false,
          isolationRecheckPossible: false,
          error: { code: 'INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_PROCESS_INTERRUPTED', category: 'verification', retryable: false, safeMessage: targetPreserved ? 'The legacy recovery drill was interrupted. The stopped alternate target is preserved for inspection; no cleanup or rollback is claimed.' : record.mode === DRILL_MODE ? 'The legacy recovery drill was interrupted before target preservation was proven.' : 'Legacy repository metadata authentication was interrupted.' },
          completedAt: null
        }
      }, actor));
    }
    return projected;
  }

  async #execute(workspaceId, actorId, verificationRunId, input, signal) {
    const startedAt = this.clock();
    try {
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt, progress: { phase: 'authenticating-recovery-media', startedAt, updatedAt: startedAt } }, actorId);
      this.#throwIfAborted(signal);
      const selected = await this.restoreService.authenticateRecoveryPoint(workspaceId, requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200), signal);
      this.#throwIfAborted(signal);
      assertRestorableArtifact(selected);
      const mediaEvidence = {
        nativeFileCount: selected.media.fileCount,
        nativeDirectoryCount: selected.media.directoryCount,
        sizeBytes: selected.media.totalBytes,
        mediaFingerprint: selected.media.mediaFingerprint,
        directoryFingerprint: selected.media.directoryFingerprint
      };
      if (String(input.mode || METADATA_MODE) === METADATA_MODE) {
        const completed = await this.#project(workspaceId, verificationRunId, {
          state: 'succeeded',
          completedAt: this.clock(),
          progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
          evidence: {
            verificationClass: 'influxdb3-enterprise-legacy-metadata',
            repositoryManifestAuthenticated: true,
            metadataArtifactAuthenticated: true,
            completeMediaAuthenticated: true,
            fullRestorePerformed: false,
            consistency: selected.point.consistency,
            clusterId: selected.media.clusterId,
            topologyFingerprint: selected.media.topologyFingerprint,
            ...mediaEvidence
          },
          result: { state: 'succeeded', mode: METADATA_MODE, recoveryPointId: selected.point.id, targetPreserved: false, completedAt: this.clock() }
        }, actorId);
        await this.#notify(workspaceId, completed);
        return completed;
      }
      const owner = exactOwner(workspaceId, verificationRunId);
      const expectedTargetDigest = targetDigest(input.target);
      const preview = await this.restoreService.preview(workspaceId, { recoveryPointId: selected.point.id, targetConnectionId: requiredText(input.targetConnectionId, 'Drill target connection ID', 200), target: input.target, signal });
      this.#throwIfAborted(signal);
      if (preview.completeMediaAuthenticated !== true || preview.targetEmpty !== true || preview.targetStopped !== true || preview.separateAlternateStorage !== true || preview.originalStorageProtected !== true) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_PREVIEW_INVALID', 'The isolated alternate-storage drill target failed restore admission.', { category: 'integrity' });
      const previewStopEvidence = normalizeClusterStopEvidence(preview.clusterStopEvidence, input.target);
      const beforeIsolation = normalizeIsolationEvidence(await this.assertTargetIsolated({ workspaceId, verificationRunId, owner, recoveryPointId: selected.point.id, targetConnectionId: input.targetConnectionId, target: input.target, targetDigest: expectedTargetDigest, phase: 'before-restore', signal }), owner, expectedTargetDigest);
      await this.#project(workspaceId, verificationRunId, { isolation: beforeIsolation, progress: { phase: 'restoring-isolated-alternate-target', startedAt, updatedAt: this.clock() } }, actorId);
      const beforeMutationStopEvidence = normalizeClusterStopEvidence(await this.restoreService.assertTargetStopped(workspaceId, { targetConnectionId: input.targetConnectionId, target: input.target, signal }), input.target);
      this.#throwIfAborted(signal);
      const startedRestore = await this.restoreService.start(workspaceId, actorId, { recoveryPointId: selected.point.id, targetConnectionId: input.targetConnectionId, target: input.target, mode: 'alternate', confirmed: true, confirmationText: RESTORE_CONFIRMATION, signal });
      const active = this.active.get(verificationRunId);
      if (active) active.restoreRunId = startedRestore.id;
      await this.#project(workspaceId, verificationRunId, { restoreRunId: startedRestore.id }, actorId);
      if (signal.aborted) {
        await this.#cancelRestore(workspaceId, actorId, active);
        this.#throwIfAborted(signal);
      }
      const restored = await this.#abortable(signal, this.restoreService.wait(workspaceId, startedRestore.id));
      if (restored.state !== 'succeeded' || restored.validation?.completeMediaAuthenticated !== true || restored.validation?.clusterStopped !== true || restored.result?.targetStopped !== true || restored.result?.targetPreserved !== true || restored.result?.rollbackClaimed !== false || restored.result?.automaticStartup !== false) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_RESTORE_FAILED', 'The full InfluxDB 3 Enterprise legacy drill did not pass stopped-target validation.', { category: 'integrity' });
      const restoreStopEvidence = normalizeClusterStopEvidence(restored.validation.clusterStopEvidence, input.target);
      const afterMutationStopEvidence = normalizeClusterStopEvidence(await this.restoreService.assertTargetStopped(workspaceId, { targetConnectionId: input.targetConnectionId, target: input.target, signal }), input.target);
      const afterIsolation = normalizeIsolationEvidence(await this.assertTargetIsolated({ workspaceId, verificationRunId, owner, recoveryPointId: selected.point.id, targetConnectionId: input.targetConnectionId, target: input.target, targetDigest: expectedTargetDigest, phase: 'after-restore', restoreRunId: restored.id, signal }), owner, expectedTargetDigest);
      if (afterIsolation.targetId !== beforeIsolation.targetId || afterIsolation.controllerId !== beforeIsolation.controllerId || afterIsolation.bindingFingerprint !== beforeIsolation.bindingFingerprint) throw new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_DRILL_ISOLATION_CHANGED', 'The isolated drill target identity changed during recovery.', { category: 'integrity' });
      const finalStopEvidence = normalizeClusterStopEvidence(await this.restoreService.assertTargetStopped(workspaceId, { targetConnectionId: input.targetConnectionId, target: input.target, signal }), input.target);
      this.#throwIfAborted(signal);
      const clusterStopEvidence = compactDrillStopEvidence([
        { boundary: 'admission-preview', evidence: previewStopEvidence },
        { boundary: 'before-mutation', evidence: beforeMutationStopEvidence },
        { boundary: 'restore-mutations', evidence: restoreStopEvidence },
        { boundary: 'after-mutation', evidence: afterMutationStopEvidence },
        { boundary: 'before-publication', evidence: finalStopEvidence }
      ], input.target);
      const completed = await this.#project(workspaceId, verificationRunId, {
        state: 'succeeded',
        completedAt: this.clock(),
        isolation: afterIsolation,
        progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
        evidence: {
          verificationClass: 'influxdb3-enterprise-legacy-full-drill',
          repositoryManifestAuthenticated: true,
          metadataArtifactAuthenticated: true,
          completeMediaAuthenticated: true,
          fullRestorePerformed: true,
          installedMediaAuthenticated: true,
          isolated: true,
          serviceExposed: false,
          targetId: afterIsolation.targetId,
          bindingFingerprint: afterIsolation.bindingFingerprint,
          targetDigest: expectedTargetDigest,
          targetPreserved: true,
          targetStopped: true,
          clusterStopEvidence,
          ownershipReviewRequired: true,
          licenseReviewRequired: true,
          automaticStartup: false,
          targetCleanupAttempted: false,
          rollbackPerformed: false,
          consistency: selected.point.consistency,
          clusterId: selected.media.clusterId,
          topologyFingerprint: selected.media.topologyFingerprint,
          ...mediaEvidence
        },
        result: { state: 'succeeded', mode: DRILL_MODE, recoveryPointId: selected.point.id, restoreRunId: restored.id, targetPreserved: true, targetStopped: true, finalStopProofDigest: clusterStopEvidence.finalProofDigest, ownershipReviewRequired: true, licenseReviewRequired: true, automaticStartup: false, targetCleanupAttempted: false, rollbackPerformed: false, completedAt: this.clock() }
      }, actorId);
      await this.#notify(workspaceId, completed);
      return completed;
    } catch (error) {
      const current = await this.controlDatabase.repository('verificationRun').get(workspaceId, verificationRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const restore = current.restoreRunId ? await this.controlDatabase.repository('restoreRun').get(workspaceId, current.restoreRunId) : null;
        const targetPreserved = current.mode === DRILL_MODE && (restore?.target?.targetMutationStarted === true || restore?.target?.filesystemMutationStarted === true || restore?.result?.targetPreserved === true);
        const canceled = signal.aborted || error?.category === 'canceled';
        const state = targetPreserved ? 'interrupted' : canceled ? 'canceled' : 'failed';
        const failed = await this.#project(workspaceId, verificationRunId, {
          state,
          completedAt: state === 'interrupted' ? null : this.clock(),
          progress: { ...(current.progress || {}), phase: targetPreserved ? 'operator-action-required' : state, updatedAt: this.clock() },
          result: { state, recoveryPointId: current.recoveryPointId, restoreRunId: current.restoreRunId || null, targetPreserved, targetCleanupAttempted: false, rollbackPerformed: false, error: targetPreserved ? { code: 'INFLUXDB3_ENTERPRISE_LEGACY_DRILL_TARGET_REQUIRES_INSPECTION', category: 'verification', retryable: false, safeMessage: 'The recovery drill stopped after target mutation. The isolated stopped target is preserved for inspection; no cleanup or rollback is claimed.' } : publicError(error), completedAt: state === 'interrupted' ? null : this.clock() }
        }, actorId);
        await this.#notify(workspaceId, failed);
        return failed;
      }
      throw error;
    }
  }

  async #abortable(signal, promise) {
    if (signal.aborted) throw signal.reason;
    let listener;
    const aborted = new Promise((_resolve, reject) => { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true }); });
    try { return await Promise.race([promise, aborted]); }
    finally { signal.removeEventListener('abort', listener); }
  }

  #throwIfAborted(signal) {
    if (signal.aborted) throw signal.reason || new InfluxDb3EnterpriseLegacyVerificationError('INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_CANCELED', 'The InfluxDB 3 Enterprise legacy recovery test was canceled.', { category: 'canceled' });
  }

  async #cancelRestore(workspaceId, actorId, active) {
    if (!active?.restoreRunId || active.restoreCancelRequested) return;
    active.restoreCancelRequested = true;
    await this.restoreService.cancel(workspaceId, actorId, active.restoreRunId).catch(() => {});
  }

  #owns(record) {
    return [METADATA_MODE, DRILL_MODE].includes(record?.mode);
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('verificationRun', workspaceId, id);
      return transaction.projectExecution('verificationRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #notify(workspaceId, run) {
    if (this.notificationService && ['succeeded', 'warning', 'failed', 'interrupted'].includes(run?.state)) await this.notificationService.notifyVerificationRun(workspaceId, run).catch(() => {});
  }
}

module.exports = {
  DRILL_CONFIRMATION,
  DRILL_MODE,
  METADATA_MODE,
  InfluxDb3EnterpriseLegacyRecoveryTestService,
  InfluxDb3EnterpriseLegacyVerificationError,
  assertRestorableArtifact,
  compactDrillStopEvidence,
  exactOwner,
  normalizeClusterStopEvidence,
  normalizeIsolationEvidence,
  targetDigest
};
