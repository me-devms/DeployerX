const crypto = require('crypto');
const { digestJson } = require('./database-adapter');
const { ADAPTER_ID, RESTORE_CONFIRMATION, readDiscovery } = require('./clickhouse');

const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const RESTORE_OPERATION = 'clickhouse-native-alternate-restore';
const MAX_CHAIN_LENGTH = 1000;

class ClickHouseRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'ClickHouseRestoreError';
    this.code = code;
    this.category = options.category || 'restore';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function databaseName(value, label = 'ClickHouse database') {
  const name = requiredText(value, label, 512);
  if (['system', 'information_schema'].includes(name.toLowerCase())) throw new TypeError(`${label} is invalid.`);
  return name;
}

function normalizeRequest(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ClickHouse restore request must be an object.');
  if (String(input.mode || 'alternate') !== 'alternate') throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_MODE_UNSUPPORTED', 'ClickHouse recovery currently supports an empty alternate target only.', { category: 'compatibility' });
  if (options.requireConfirmation !== false && (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION)) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the ClickHouse alternate-target recovery before continuing.', { category: 'conflict' });
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    targetConnectionId: requiredText(input.targetConnectionId, 'ClickHouse target connection ID', 200),
    targetDatabase: databaseName(input.targetDatabase, 'ClickHouse target database'),
    operationId: input.operationId ? requiredText(input.operationId, 'ClickHouse restore operation ID', 200) : null,
    mode: 'alternate'
  };
}

function publicError(error) {
  if (error instanceof ClickHouseRestoreError || (error?.code && error?.category)) return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The ClickHouse recovery failed.').slice(0, 500) };
  return { code: 'CLICKHOUSE_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the ClickHouse alternate-target recovery.' };
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function metadataDigest(value) {
  return `sha256:${digestJson(value)}`;
}

function restoreOperationId(seed = crypto.randomBytes(32).toString('hex')) {
  return `deployerx-restore-${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 32)}`;
}

class ClickHouseRestoreService {
  constructor({ controlDatabase, deviceId, adapter, connectionService, openRepository, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !adapter || !connectionService || typeof openRepository !== 'function') throw new TypeError('ClickHouse restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.connectionService = connectionService;
    this.openRepository = openRepository;
    this.clock = clock;
    this.active = new Map();
  }

  async preview(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const request = normalizeRequest(input, { requireConfirmation: false });
    request.operationId = restoreOperationId(`preview\0${tenant}\0${request.recoveryPointId}\0${request.targetConnectionId}\0${request.targetDatabase}`);
    const prepared = await this.#prepare(tenant, request, input.signal);
    return {
      mode: 'alternate',
      recoveryPointId: prepared.point.id,
      sourceDatabase: prepared.metadata.selection.database.name,
      targetConnectionId: prepared.targetConnection.id,
      targetDatabase: request.targetDatabase,
      sourceVersion: prepared.metadata.productVersion,
      targetVersion: prepared.plan.target.version,
      backupMode: prepared.point.type,
      tableCount: prepared.metadata.selection.tables.length,
      chainRecoveryPointIds: prepared.entries.map((entry) => entry.point.id),
      targetEmpty: true,
      sourceDeploymentProtected: true,
      nativeValidation: true,
      confirmationText: RESTORE_CONFIRMATION,
      planDigest: digest({ recoveryPointId: prepared.point.id, targetConnectionId: prepared.targetConnection.id, targetDatabase: request.targetDatabase, target: prepared.plan.target, chain: prepared.entries.map((entry) => ({ pointId: entry.point.id, metadataDigest: entry.metadataDigest })) })
    };
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    request.operationId = restoreOperationId();
    const prepared = await this.#prepare(tenant, request, input.signal);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant,
      actorId: actor,
      recoveryPointIds: prepared.entries.map((entry) => entry.point.id),
      targetConnectionId: prepared.targetConnection.id,
      target: {
        operation: RESTORE_OPERATION,
        mode: 'alternate',
        engine: 'clickhouse',
        sourceId: prepared.source.id,
        sourceDatabase: prepared.metadata.selection.database.name,
        targetConnectionId: prepared.targetConnection.id,
        targetDatabase: request.targetDatabase,
        targetDeploymentFingerprint: prepared.plan.target.deploymentFingerprint,
        targetTopologyFingerprint: prepared.plan.target.topologyFingerprint,
        nativeOperationId: request.operationId,
        nativeDestinationName: prepared.plan.destinationName,
        nativeMutationStarted: false,
        restoreEvidence: { source: prepared.sourceEvidence, target: prepared.plan.target }
      },
      mode: 'alternate',
      conflictPolicy: 'fail',
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      progress: { phase: 'queued', itemsTotal: prepared.metadata.selection.tables.length, itemsCompleted: 0, bytesTotal: prepared.totalBytes, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] },
      validation: null,
      result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, request, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== RESTORE_OPERATION || record.target?.engine !== 'clickhouse') throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_RUN_NOT_FOUND', 'The ClickHouse RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== RESTORE_OPERATION || record.target?.engine !== 'clickhouse') throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_RUN_NOT_FOUND', 'The ClickHouse RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_NOT_ACTIVE', 'The ClickHouse recovery is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) }))
      .filter((record) => record.target?.operation === RESTORE_OPERATION && record.target?.engine === 'clickhouse');
  }

  async authenticateRecoveryPoint(workspaceId, recoveryPointId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, requiredText(recoveryPointId, 'RecoveryPoint ID', 200));
    if (!point) throw new ClickHouseRestoreError('CLICKHOUSE_RECOVERY_POINT_NOT_FOUND', 'The ClickHouse RecoveryPoint was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'physical') throw new ClickHouseRestoreError('CLICKHOUSE_RECOVERY_POINT_INVALID', 'The selected RecoveryPoint is not a ClickHouse physical backup.', { category: 'validation' });
    const points = await this.controlDatabase.repository('recoveryPoint').list(tenant, { limit: MAX_CHAIN_LENGTH });
    if (points.length === MAX_CHAIN_LENGTH) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_CHAIN_LIMIT', 'The ClickHouse recovery chain exceeds the bounded scan limit.', { category: 'capacity' });
    const byId = new Map(points.map((item) => [item.id, item]));
    byId.set(point.id, point);
    const newestFirst = [];
    const seen = new Set();
    let current = point;
    while (current) {
      if (seen.has(current.id) || newestFirst.length >= MAX_CHAIN_LENGTH) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_CHAIN_INVALID', 'The ClickHouse recovery chain is cyclic or too long.', { category: 'integrity' });
      seen.add(current.id);
      if (current.sourceId !== point.sourceId || current.jobId !== point.jobId || !['full', 'incremental'].includes(current.type) || current.consistency !== 'application' || current.verification?.state !== 'succeeded' || current.retention?.deletionEligible === true) throw new ClickHouseRestoreError('CLICKHOUSE_RECOVERY_POINT_INVALID', 'Every ClickHouse restore ancestor must be retained, verified, and application-consistent.', { category: 'validation' });
      newestFirst.push(current);
      if (current.type === 'full') break;
      if (!current.parentRecoveryPointId || !(current = byId.get(current.parentRecoveryPointId))) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_CHAIN_INCOMPLETE', 'A required ClickHouse restore ancestor is missing.', { category: 'integrity' });
    }
    const chain = newestFirst.reverse();
    const root = chain[0];
    if (!root || root.type !== 'full' || root.chainRootId !== root.id || chain.some((item, index) => item.chainRootId !== root.id || (index > 0 && item.parentRecoveryPointId !== chain[index - 1].id))) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_CHAIN_INVALID', 'The ClickHouse RecoveryPoint lineage is not a complete ordered chain.', { category: 'integrity' });
    const repositoryId = (root.repositoryCopies || []).find((copy) => copy.state === 'available' && chain.every((item) => (item.repositoryCopies || []).some((candidate) => candidate.repositoryId === copy.repositoryId && candidate.state === 'available')))?.repositoryId;
    if (!repositoryId) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_REPOSITORY_UNAVAILABLE', 'No repository contains the complete ClickHouse restore chain.', { category: 'not-found' });
    const opened = await this.openRepository(tenant, repositoryId);
    const artifacts = await this.controlDatabase.repository('artifact').list(tenant, { limit: 5000 });
    if (artifacts.length === 5000) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_ARTIFACT_LIMIT', 'The ClickHouse Artifact scan exceeds the bounded limit.', { category: 'capacity' });
    const entries = [];
    for (let index = 0; index < chain.length; index += 1) {
      const chainPoint = chain[index];
      const prior = entries[index - 1] || null;
      const copy = chainPoint.repositoryCopies.find((item) => item.repositoryId === repositoryId && item.state === 'available');
      const artifact = artifacts.find((item) => item.recoveryPointId === chainPoint.id && item.repositoryId === repositoryId && item.kind === 'metadata' && item.metadata?.adapterId === ADAPTER_ID && item.metadata?.kind === 'clickhouse-native-backup');
      if (!artifact) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_ARTIFACT_UNAVAILABLE', 'A required ClickHouse metadata Artifact is unavailable.', { category: 'not-found' });
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      if (snapshot.summary?.manifestKey !== copy.manifestLocator || snapshot.summary?.manifestChecksum?.digest !== copy.manifestChecksum?.digest) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_MANIFEST_INVALID', 'A ClickHouse repository manifest no longer matches its RecoveryPoint.', { category: 'integrity' });
      const locatorPath = decodeURIComponent(String(artifact.locator || '').split('#').slice(1).join('#'));
      const file = (snapshot.manifest.files || []).find((candidate) => candidate.type === 'file' && candidate.path === locatorPath && candidate.metadata?.artifactKind === 'metadata' && candidate.metadata?.externalNativeMedia === true && candidate.metadata?.database?.adapterId === ADAPTER_ID);
      const metadata = file?.metadata?.database;
      const expectedAncestors = chain.slice(0, index).map((item) => item.id);
      const destination = metadata?.destination;
      const operation = metadata?.operation;
      const currentDigest = metadata ? metadataDigest(metadata) : null;
      if (!file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest || digestJson(metadata) !== digestJson(artifact.metadata)
        || metadata.kind !== 'clickhouse-native-backup' || metadata.adapterId !== ADAPTER_ID || metadata.selectionDigest !== source.selector?.digest || metadata.sourceId !== source.id || metadata.jobId !== point.jobId
        || metadata.deploymentFingerprint !== source.physicalExecution?.deploymentFingerprint || metadata.topologyFingerprint !== source.physicalExecution?.topologyFingerprint
        || metadata.backupMethod !== 'physical' || metadata.backupMode !== chainPoint.type || metadata.externalNativeMedia !== true || metadata.restoreSupported !== true
        || destination?.type !== 'disk' || destination.diskName !== source.physicalExecution?.diskName || destination.destinationFingerprint !== source.physicalExecution?.destinationFingerprint || !/^deployerx\/[0-9a-f]{16}\/deployerx-[0-9a-f]{32}[.]zip$/.test(String(destination.relativePath || ''))
        || !/^deployerx-[0-9a-f]{32}$/.test(String(operation?.id || '')) || !String(destination.relativePath).endsWith(`${operation.id}.zip`) || destination.backupName !== operation.name || operation.status !== 'BACKUP_CREATED' || operation.files < 1 || operation.entries < 1 || operation.totalBytes < 1
        || !Array.isArray(metadata.selection?.tables) || !metadata.selection.tables.length || !Array.isArray(metadata.selection?.statistics) || metadata.selection.statistics.length !== metadata.selection.tables.length
        || metadata.chain?.parentRecoveryPointId !== (prior ? chainPoint.parentRecoveryPointId : null) || metadata.chain?.chainRootRecoveryPointId !== (prior ? root.id : null) || JSON.stringify(metadata.chain?.ancestorRecoveryPointIds || []) !== JSON.stringify(expectedAncestors)
        || (prior && (metadata.chain?.baseOperationId !== prior.metadata.operation.id || metadata.chain?.baseRelativePath !== prior.metadata.destination.relativePath || metadata.chain?.baseMetadataDigest !== prior.metadataDigest))) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_ARTIFACT_INVALID', 'Authenticated ClickHouse metadata is incomplete or inconsistent with its RecoveryPoint and native chain.', { category: 'integrity' });
      entries.push({ point: chainPoint, copy, artifact, snapshot, file, metadata, metadataDigest: currentDigest });
    }
    return { point, source, repositoryId, opened, entries, metadata: entries.at(-1).metadata, totalBytes: entries.reduce((sum, entry) => sum + entry.metadata.operation.totalBytes, 0) };
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const recovered = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      let nativeStatus = null;
      let validation = null;
      let reconciliationError = null;
      if (record.target?.nativeMutationStarted === true) {
        try {
          const connection = await this.controlDatabase.repository('connection').get(tenant, record.targetConnectionId);
          if (!connection || connection.adapterId !== ADAPTER_ID || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_TARGET_CONNECTION_INVALID', 'The ClickHouse restore target connection is unavailable.', { category: 'connectivity' });
          const reconciled = await this.connectionService.withExecution(tenant, connection, undefined, async (context, config) => {
            const native = await this.adapter.reconcileRestore(context, { operationId: record.target.nativeOperationId, destinationName: record.target.nativeDestinationName, connection: config });
            if (native.status.status !== 'RESTORED') return { native, validation: null };
            const evidence = record.target.restoreEvidence;
            if (!evidence?.source || !evidence?.target) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_RECONCILIATION_EVIDENCE_MISSING', 'ClickHouse restore validation evidence is unavailable.', { category: 'integrity' });
            const plan = { version: 1, operation: RESTORE_OPERATION, operationId: record.target.nativeOperationId, destinationName: record.target.nativeDestinationName, connection: config, source: evidence.source, target: evidence.target };
            const discovery = await readDiscovery(context, { ...config, expectedDeploymentFingerprint: null });
            return { native, validation: await this.adapter.validateRestore(context, { version: 1, plan, status: native.status, discovery, completedAt: this.clock() }) };
          });
          nativeStatus = reconciled.native;
          validation = reconciled.validation;
        } catch (error) { reconciliationError = publicError(error); }
      }
      const mutated = record.target?.nativeMutationStarted === true;
      if (validation?.valid === true) {
        let current = await this.controlDatabase.repository('restoreRun').get(tenant, record.id);
        if (current.state === 'queued') current = await this.#project(tenant, record.id, { state: 'preparing', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
        if (current.state === 'preparing') current = await this.#project(tenant, record.id, { state: 'running', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
        if (current.state === 'running') current = await this.#project(tenant, record.id, { state: 'validating', progress: { ...(current.progress || {}), phase: 'validating', updatedAt: this.clock() } }, actorId);
        recovered.push(await this.#project(tenant, record.id, {
          state: 'succeeded',
          progress: { ...(current.progress || {}), phase: 'complete', itemsCompleted: current.progress?.itemsTotal || validation.mappings.length, updatedAt: this.clock() },
          validation: { state: validation.status, connectivity: 'succeeded', expectedObjects: 'succeeded', nativeIntegrityValidation: true, checks: validation.checks || [], completedAt: this.clock() },
          result: { reconciledAfterRestart: true, targetDatabase: record.target.targetDatabase, tableMappings: validation.mappings, databaseMapping: validation.database, nativeOperation: nativeStatus.status, warnings: [], completedAt: this.clock() }
        }, actorId));
        continue;
      }
      recovered.push(await this.#project(tenant, record.id, {
        state: mutated ? 'interrupted' : 'failed',
        progress: { ...(record.progress || {}), phase: mutated ? 'operator-action-required' : 'failed', updatedAt: this.clock() },
        result: {
          nativeStatus: nativeStatus?.status || null,
          reconciliationError,
          error: { code: mutated ? 'CLICKHOUSE_RESTORE_INTERRUPTED_AFTER_SUBMISSION' : 'CLICKHOUSE_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage: mutated ? 'ClickHouse recovery was interrupted after native submission. Exact native status was reconciled where available; the target is preserved for inspection and no rollback is claimed.' : 'ClickHouse recovery was interrupted before native submission.' },
          completedAt: this.clock()
        }
      }, actorId));
    }
    return recovered;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #prepare(workspaceId, request, signal) {
    const authenticated = await this.authenticateRecoveryPoint(workspaceId, request.recoveryPointId);
    const targetConnection = await this.controlDatabase.repository('connection').get(workspaceId, request.targetConnectionId);
    if (!targetConnection || targetConnection.adapterId !== ADAPTER_ID || targetConnection.lastTest?.status !== 'success' || !targetConnection.trust?.fingerprint || !(targetConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_TARGET_CONNECTION_INVALID', 'Choose a successfully tested ClickHouse target connection on this device.', { category: 'connectivity', retryable: true });
    const destination = authenticated.metadata.destination;
    const destinationTrust = targetConnection.clickhouseDestinationTrust;
    if (!destinationTrust || destinationTrust.diskName !== destination.diskName || destinationTrust.destinationFingerprint !== destination.destinationFingerprint || destinationTrust.deploymentFingerprint !== targetConnection.trust.fingerprint || destinationTrust.topologyFingerprint !== targetConnection.trust.topologyFingerprint) throw new ClickHouseRestoreError('CLICKHOUSE_RESTORE_DESTINATION_UNTRUSTED', 'Approve the authenticated ClickHouse backup disk on the target connection before recovery.', { category: 'integrity' });
    const sourceEvidence = {
      kind: authenticated.metadata.kind,
      adapterId: authenticated.metadata.adapterId,
      productVersion: authenticated.metadata.productVersion,
      deploymentFingerprint: authenticated.metadata.deploymentFingerprint,
      topologyFingerprint: authenticated.metadata.topologyFingerprint,
      destination: authenticated.metadata.destination,
      operation: authenticated.metadata.operation,
      selection: authenticated.metadata.selection
    };
    const plan = await this.connectionService.withExecution(workspaceId, targetConnection, signal, (context, connection) => this.adapter.planRestore(context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: request.operationId, connection, targetDatabase: request.targetDatabase, source: sourceEvidence }));
    return { ...authenticated, targetConnection, sourceEvidence, plan };
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let validationRecord = null;
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const prepared = await this.#prepare(workspaceId, request, signal);
      progress = { ...progress, itemsTotal: prepared.metadata.selection.tables.length, bytesTotal: prepared.totalBytes, updatedAt: this.clock() };
      const outcome = await this.connectionService.withExecution(workspaceId, prepared.targetConnection, signal, async (context, connection) => {
        const plan = await this.adapter.planRestore(context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, operationId: request.operationId, connection, targetDatabase: request.targetDatabase, source: prepared.sourceEvidence });
        const restored = await this.adapter.executeRestore({ ...context, signal, onMutationStarted: async ({ operationId }) => {
          progress = { ...progress, phase: 'restoring', updatedAt: this.clock() };
          const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
          await this.#project(workspaceId, restoreRunId, { state: 'running', progress, target: { ...(current.target || {}), nativeMutationStarted: true, nativeOperationId: operationId } }, actorId);
        } }, plan);
        progress = { ...progress, phase: 'validating', itemsCompleted: prepared.metadata.selection.tables.length, updatedAt: this.clock() };
        const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
        await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
        const validation = await this.adapter.validateRestore(context, restored);
        return { restored, validation, current };
      });
      validationRecord = { state: outcome.validation.status, connectivity: 'succeeded', expectedObjects: 'succeeded', nativeIntegrityValidation: true, checks: outcome.validation.checks || [], completedAt: this.clock() };
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, {
        state: 'succeeded',
        progress,
        validation: validationRecord,
        result: { recoveryPointId: prepared.point.id, chainRecoveryPointIds: prepared.entries.map((entry) => entry.point.id), targetDatabase: request.targetDatabase, tableMappings: outcome.validation.mappings, databaseMapping: outcome.validation.database, nativeOperation: outcome.restored.status, warnings: [], completedAt: this.clock() }
      }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.code === 'CLICKHOUSE_RESTORE_CANCELED';
        const mutated = current.target?.nativeMutationStarted === true;
        const state = mutated ? 'interrupted' : canceled ? 'canceled' : 'failed';
        const safe = mutated ? { code: 'CLICKHOUSE_RESTORE_TARGET_REQUIRES_INSPECTION', category: 'restore', retryable: false, safeMessage: 'ClickHouse native restore was submitted but recovery did not finish. The target is preserved for inspection; no rollback is claimed.' } : canceled ? { code: 'CLICKHOUSE_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The ClickHouse recovery was canceled before native submission.' } : publicError(error);
        return this.#project(workspaceId, restoreRunId, { state, progress: { ...progress, phase: mutated ? 'operator-action-required' : state, updatedAt: this.clock() }, validation: validationRecord, result: { error: safe, completedAt: this.clock() } }, actorId);
      }
      throw error;
    }
  }
}

module.exports = { ClickHouseRestoreError, ClickHouseRestoreService, RESTORE_CONFIRMATION, RESTORE_OPERATION, normalizeRequest, restoreOperationId };
