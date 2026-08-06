const crypto = require('crypto');
const { BandwidthLimiter } = require('./execution-policy');
const { MAXIMUM_RETENTION_EVALUATION_POINTS, evaluateRetention, normalizeRetentionPolicy } = require('./retention-policy');
const { ENGINE_VERSION, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { evaluateRepositoryCapacity, normalizeStoragePolicy } = require('./repository-capacity');
const { CHECKPOINT_VERSION } = require('./run-checkpoint');
const { generateUuidV7 } = require('./control-database');

const NONTERMINAL_RUN_STATES = new Set(['queued', 'preparing', 'running', 'verifying']);
const TERMINAL_RUN_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);
const RUN_LEASE_MS = 60000;
const REPOSITORY_LEASE_MS = 5 * 60 * 1000;
const PROGRESS_WRITE_INTERVAL_MS = 250;

class ManualBackupError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ManualBackupError';
    this.code = code;
    this.category = options.category || 'execution';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 300) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is required.`);
  return text;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function safeFailure(error) {
  const code = String(error?.code || 'BACKUP_RUN_FAILED').toUpperCase();
  const safeCode = /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : 'BACKUP_RUN_FAILED';
  const known = new Set(['ManualBackupError', 'FileSourceReaderError', 'RepositoryEngineError', 'RepositoryLockError', 'LocalRepositoryError', 'SftpRepositoryError', 'S3RepositoryError', 'RunCheckpointError']);
  return {
    safeErrorCode: safeCode,
    safeMessage: known.has(error?.name) ? String(error.message).slice(0, 300) : 'The backup run could not be completed.',
    category: String(error?.category || 'execution').slice(0, 80),
    retryable: Boolean(error?.retryable)
  };
}

function leaseFor(runId, workerId, fencingToken, clock) {
  const now = new Date(clock());
  if (!Number.isFinite(now.getTime())) throw new ManualBackupError('BACKUP_RUN_CLOCK_INVALID', 'Backup run time is invalid.');
  return {
    leaseId: `run-lease_${crypto.randomUUID()}`,
    runId,
    workerId,
    workerGeneration: `process:${process.pid}`,
    fencingToken,
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RUN_LEASE_MS).toISOString()
  };
}

function renewedLease(lease, clock) {
  const now = new Date(clock());
  return { ...lease, heartbeatAt: now.toISOString(), expiresAt: new Date(now.getTime() + RUN_LEASE_MS).toISOString() };
}

function initialProgress(clock) {
  return {
    phase: 'queued',
    repositoryIndex: 0,
    repositoryCount: 0,
    itemsScanned: 0,
    files: 0,
    directories: 0,
    symbolicLinks: 0,
    sourceBytes: 0,
    bytesRead: 0,
    uploadedBytes: 0,
    reusedBytes: 0,
    committedRepositories: 0,
    currentPath: null,
    bandwidthLimitBytesPerSecond: null,
    throttleWaitMilliseconds: 0,
    throughputBytesPerSecond: 0,
    etaSeconds: null,
    startedAt: null,
    updatedAt: clock()
  };
}

function publicRun(run) {
  const progress = run.progress || {};
  const scannedBytes = Math.max(Number(progress.sourceBytes || 0), Number(run.result?.sourceBytes || 0));
  const uploadedBytes = Math.max(Number(progress.uploadedBytes || 0), Number(run.result?.uploadedBytes || 0));
  const reusedBytes = Math.max(Number(progress.reusedBytes || 0), Number(run.result?.reusedBytes || 0));
  const startedAt = run.startedAt || null;
  const finishedAt = run.finishedAt || null;
  const durationMs = startedAt ? Math.max(0, Date.parse(finishedAt || run.updatedAt || startedAt) - Date.parse(startedAt)) : 0;
  return {
    id: run.id,
    executionGroupId: run.executionGroupId,
    jobId: run.jobId,
    jobRevision: run.jobRevision,
    state: run.state,
    trigger: run.trigger,
    attempt: run.attempt,
    parentRunId: run.parentRunId,
    retryOfRunId: run.retryOfRunId || null,
    progress,
    metrics: {
      scannedItems: Number(progress.itemsScanned || 0), scannedBytes, readBytes: Number(progress.bytesRead || 0), uploadedBytes, reusedBytes,
      deduplicationSavingsPercent: scannedBytes > 0 ? Math.min(100, Math.round(reusedBytes / scannedBytes * 1000) / 10) : 0,
      throughputBytesPerSecond: Number(progress.throughputBytesPerSecond || 0), durationMs
    },
    startedAt,
    finishedAt,
    result: run.result || null,
    cancellation: run.cancellation || null,
    retryState: run.retryState || null,
    priority: run.configSnapshot?.policy?.performance?.priority || 'normal',
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    revision: run.revision,
    resumable: run.state === 'interrupted' && Boolean(run.checkpoint?.available)
  };
}

class ManualBackupService {
  constructor({ controlDatabase, sourceReader, checkpointStore, deviceId, openRepository, logStore = null, notificationService = null, clock = () => new Date().toISOString(), now = () => Date.now(), randomUUID = crypto.randomUUID } = {}) {
    if (!controlDatabase || !sourceReader || !checkpointStore || typeof openRepository !== 'function') throw new TypeError('Control database, source reader, checkpoint store, and repository opener are required.');
    this.controlDatabase = controlDatabase;
    this.sourceReader = sourceReader;
    this.checkpointStore = checkpointStore;
    this.deviceId = requiredText(deviceId, 'Device ID');
    this.workerId = `device:${this.deviceId}`;
    this.openRepository = openRepository;
    this.logStore = logStore;
    this.notificationService = notificationService;
    this.clock = clock;
    this.now = now;
    this.randomUUID = randomUUID;
    this.activeRuns = new Map();
  }

  async #configuration(workspaceId, jobId) {
    const [job, sources, policies, repositories] = await Promise.all([
      this.controlDatabase.repository('backupJob').get(workspaceId, jobId),
      this.controlDatabase.repository('source').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('policy').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('repository').list(workspaceId, { limit: 1000 })
    ]);
    if (!job || job.state !== 'enabled') throw new ManualBackupError('BACKUP_JOB_NOT_RUNNABLE', 'The backup job is not enabled.');
    const source = sources.find((record) => record.id === job.sourceId);
    const policy = policies.find((record) => record.id === job.policyId);
    if (!source || !policy || !policy.enabled) throw new ManualBackupError('BACKUP_JOB_CONFIGURATION_MISSING', 'The backup job source or policy is unavailable.');
    const sourcePlan = await this.sourceReader.plan(workspaceId, source.id);
    const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
    const selectedRepositories = (job.repositoryBindings || []).map((binding) => ({ binding, repository: repositoryById.get(binding.repositoryId) }));
    if (!selectedRepositories.length || selectedRepositories.some((selection) => !selection.repository)) throw new ManualBackupError('BACKUP_JOB_REPOSITORY_MISSING', 'A configured backup repository is unavailable.');
    for (const { repository } of selectedRepositories) {
      if (!(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new ManualBackupError('BACKUP_REPOSITORY_OTHER_DEVICE', `${repository.name} belongs to another device.`);
      if (repository.health?.status !== 'ready' || repository.health?.lockState?.status === 'unavailable') throw new ManualBackupError('BACKUP_REPOSITORY_UNHEALTHY', `${repository.name} is not ready for backup.`);
    }
    const secretRefIds = [...new Set([
      ...(source.secretRefIds || []),
      ...(sourcePlan.connection.secretRefIds || []),
      ...(sourcePlan.executionConnection?.secretRefIds || []),
      ...selectedRepositories.flatMap(({ repository }) => [...(repository.secretRefIds || []), repository.encryptionKeyRefId].filter(Boolean))
    ])];
    const secretRefs = (await Promise.all(secretRefIds.map((id) => this.controlDatabase.repository('secretRef').get(workspaceId, id))))
      .filter(Boolean).map((ref) => ({ id: ref.id, version: ref.version, secretType: ref.secretType }));
    const snapshot = {
      version: 1,
      job: { id: job.id, revision: job.revision, name: job.name, selection: job.selection, consistency: job.consistency, adapterSettings: job.adapterSettings, lastRecoveryPointId: job.lastRecoveryPointId || null },
      policy: { id: policy.id, revision: policy.revision, schedule: policy.schedule, backupMode: policy.backupMode, retention: policy.retention, retry: policy.retry, verification: policy.verification, performance: policy.performance },
      source: { id: source.id, revision: source.revision, sourceType: source.sourceType, connectionId: source.connectionId, adapterId: source.adapterId, selector: source.selector, consistency: source.consistency || null, physicalExecution: source.physicalExecution || null, platform: source.platform },
      connection: {
        id: sourcePlan.connection.id,
        revision: sourcePlan.connection.revision,
        adapterId: sourcePlan.connection.adapterId,
        adapterVersion: sourcePlan.connection.adapterVersion,
        secretRefIds: [...(sourcePlan.connection.secretRefIds || [])]
      },
      executionConnection: sourcePlan.executionConnection ? {
        id: sourcePlan.executionConnection.id,
        revision: sourcePlan.executionConnection.revision,
        adapterId: sourcePlan.executionConnection.adapterId,
        adapterVersion: sourcePlan.executionConnection.adapterVersion,
        secretRefIds: [...(sourcePlan.executionConnection.secretRefIds || [])],
        hostKeyFingerprint: sourcePlan.executionConnection.trust?.fingerprint || null
      } : null,
      repositories: selectedRepositories.map(({ binding, repository }) => ({
        binding: structuredClone(binding),
        id: repository.id,
        revision: repository.revision,
        adapterId: repository.adapterId,
        adapterVersion: repository.adapterVersion,
        engineId: repository.engineId,
        engineVersion: repository.engineVersion,
        repositoryFormatVersion: repository.health?.repositoryFormatVersion,
        storagePolicy: normalizeStoragePolicy(repository.storagePolicy || {}),
        encryptionKeyRefId: repository.encryptionKeyRefId,
        encryptionKeyVersion: repository.encryption?.keyVersion
      })),
      secretRefs,
      worker: { workerId: this.workerId, deviceId: this.deviceId, engineVersion: ENGINE_VERSION, checkpointFormatVersion: CHECKPOINT_VERSION }
    };
    return { job, source, policy, repositories: selectedRepositories.map((selection) => selection.repository), snapshot, planDigest: digest(snapshot) };
  }

  async start(workspaceId, actorId, jobId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const configuration = await this.#configuration(tenant, requiredText(jobId, 'Backup job ID'));
    return this.#startOccurrence(tenant, actor, configuration, {
      trigger: 'manual',
      scheduledFor: null,
      occurrenceKey: `manual:${configuration.job.id}:${this.randomUUID()}`
    });
  }

  async startScheduled(workspaceId, actorId, jobId, scheduledFor) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const scheduledDate = new Date(requiredText(scheduledFor, 'Scheduled occurrence time', 100));
    if (!Number.isFinite(scheduledDate.getTime())) throw new ManualBackupError('BACKUP_SCHEDULE_TIME_INVALID', 'The scheduled backup occurrence time is invalid.', { category: 'validation' });
    const occurrenceTime = scheduledDate.toISOString();
    const configuration = await this.#configuration(tenant, requiredText(jobId, 'Backup job ID'));
    const occurrenceKey = `schedule:${digest({ workspaceId: tenant, jobId: configuration.job.id, jobRevision: configuration.job.revision, scheduledFor: occurrenceTime })}`;
    const existing = await this.#existingOccurrence(tenant, occurrenceKey);
    if (existing) return { ...publicRun(existing), occurrenceCreated: false };
    return this.#startOccurrence(tenant, actor, configuration, { trigger: 'schedule', scheduledFor: occurrenceTime, occurrenceKey });
  }

  async #existingOccurrence(workspaceId, occurrenceKey) {
    const group = (await this.controlDatabase.repository('executionGroup').list(workspaceId, { limit: 1000 }))
      .find((candidate) => candidate.idempotencyKey === occurrenceKey);
    if (!group?.latestRunId) return null;
    return this.controlDatabase.repository('run').get(workspaceId, group.latestRunId);
  }

  async #startOccurrence(tenant, actor, configuration, occurrence) {
    const active = (await this.controlDatabase.repository('run').list(tenant, { limit: 1000 })).find((run) => run.jobId === configuration.job.id && NONTERMINAL_RUN_STATES.has(run.state));
    if (active) throw new ManualBackupError('BACKUP_JOB_ALREADY_RUNNING', 'This backup job already has an active run.', { category: 'conflict' });
    let created;
    try {
      created = await this.controlDatabase.transaction((transaction) => {
        const group = transaction.create('executionGroup', {
          workspaceId: tenant, actorId: actor, jobId: configuration.job.id, jobRevision: configuration.job.revision,
          trigger: occurrence.groupTrigger || occurrence.trigger, scheduledFor: occurrence.scheduledFor, idempotencyKey: occurrence.occurrenceKey,
          retryOfRunId: occurrence.retryOfRunId || null, state: 'pending', latestRunId: null, terminalRunId: null
        });
        const run = transaction.create('run', {
          workspaceId: tenant, actorId: actor, jobId: configuration.job.id, jobRevision: configuration.job.revision,
          executionGroupId: group.id, scheduledFor: occurrence.scheduledFor, idempotencyKey: `${occurrence.occurrenceKey}:attempt:1`, trigger: occurrence.trigger,
          workerId: this.workerId, state: 'queued', attempt: 1, parentRunId: null, retryOfRunId: occurrence.retryOfRunId || null,
          configSnapshot: configuration.snapshot, planDigest: configuration.planDigest, progress: initialProgress(this.clock),
          lease: null, checkpoint: { available: false, sequence: 0, runId: null }, startedAt: null, finishedAt: null, result: null
        });
        const projectedGroup = transaction.projectExecution('executionGroup', tenant, group.id, { latestRunId: run.id }, { expectedRevision: group.revision, actorId: actor });
        return { group: projectedGroup, run };
      });
    } catch (error) {
      if (occurrence.trigger !== 'schedule' || !/UNIQUE constraint failed/i.test(String(error?.message || ''))) throw error;
      const existing = await this.#existingOccurrence(tenant, occurrence.occurrenceKey);
      if (!existing) throw error;
      return { ...publicRun(existing), occurrenceCreated: false };
    }
    this.#launch(tenant, actor, created.run.id, null);
    return { ...publicRun(created.run), occurrenceCreated: true };
  }

  async resume(workspaceId, actorId, interruptedRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const interrupted = await this.controlDatabase.repository('run').get(tenant, requiredText(interruptedRunId, 'Interrupted run ID'));
    if (!interrupted || interrupted.state !== 'interrupted') throw new ManualBackupError('BACKUP_RUN_NOT_RESUMABLE', 'Only an interrupted backup run can be resumed.');
    if (interrupted.configSnapshot?.source?.sourceType === 'database') throw new ManualBackupError('DATABASE_BACKUP_NOT_RESUMABLE', 'A partially completed database backup must be retried as a fresh run.', { category: 'consistency' });
    const currentJob = await this.controlDatabase.repository('backupJob').get(tenant, interrupted.jobId);
    const currentPolicy = currentJob ? await this.controlDatabase.repository('policy').get(tenant, currentJob.policyId) : null;
    if (!currentJob || currentJob.state !== 'enabled' || !currentPolicy?.enabled) throw new ManualBackupError('BACKUP_JOB_NOT_RUNNABLE', 'The backup job is not enabled.');
    const active = (await this.controlDatabase.repository('run').list(tenant, { limit: 1000 })).find((run) => run.jobId === interrupted.jobId && NONTERMINAL_RUN_STATES.has(run.state));
    if (active) throw new ManualBackupError('BACKUP_JOB_ALREADY_RUNNING', 'This backup job already has an active run.', { category: 'conflict' });
    const primaryId = interrupted.configSnapshot?.repositories?.[0]?.id;
    if (!primaryId) throw new ManualBackupError('BACKUP_RUN_CHECKPOINT_INVALID', 'The interrupted run has no primary repository snapshot.');
    const primary = await this.#openSnapshotRepository(tenant, interrupted.configSnapshot.repositories[0]);
    const checkpointRunId = interrupted.checkpoint?.runId || interrupted.id;
    let checkpoint = await this.checkpointStore.read(tenant, checkpointRunId, primaryId, primary.masterKey);
    try { await this.#validateCheckpoint(tenant, interrupted, checkpoint); }
    catch (error) {
      await this.checkpointStore.quarantine(tenant, checkpointRunId);
      if (interrupted.checkpoint?.available) throw new ManualBackupError('BACKUP_RUN_CHECKPOINT_INVALID', 'The saved backup checkpoint is missing, changed, or no longer compatible.', { category: 'integrity' });
      checkpoint = null;
    }
    const group = await this.controlDatabase.repository('executionGroup').get(tenant, interrupted.executionGroupId);
    if (!group || TERMINAL_RUN_STATES.has(group.state)) throw new ManualBackupError('BACKUP_RUN_GROUP_TERMINAL', 'The interrupted execution group is already terminal.');
    const run = await this.controlDatabase.transaction((transaction) => {
      const created = transaction.create('run', {
        workspaceId: tenant, actorId: actor, jobId: interrupted.jobId, jobRevision: interrupted.jobRevision,
        executionGroupId: interrupted.executionGroupId, scheduledFor: null, idempotencyKey: `${group.idempotencyKey}:attempt:${interrupted.attempt + 1}`,
        trigger: 'retry', workerId: this.workerId, state: 'queued', attempt: interrupted.attempt + 1, parentRunId: interrupted.id,
        configSnapshot: interrupted.configSnapshot, planDigest: interrupted.planDigest,
        progress: checkpoint?.progress || initialProgress(this.clock), lease: null,
        checkpoint: { available: Boolean(checkpoint), sequence: checkpoint?.sequence || 0, runId: checkpoint?.runId || null },
        startedAt: null, finishedAt: null, result: null
      });
      transaction.projectExecution('executionGroup', tenant, group.id, { latestRunId: created.id }, { expectedRevision: group.revision, actorId: actor });
      return created;
    });
    this.#launch(tenant, actor, run.id, checkpoint);
    return publicRun(run);
  }

  async cancel(workspaceId, actorId, runId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const id = requiredText(runId, 'Backup run ID');
    const canceledAt = this.clock();
    const active = this.activeRuns.get(id);
    if (active) {
      const current = await this.controlDatabase.repository('run').get(tenant, id);
      if (!current || !NONTERMINAL_RUN_STATES.has(current.state)) throw new ManualBackupError('BACKUP_RUN_NOT_CANCELABLE', 'Only an active backup run can be canceled.', { category: 'conflict' });
      active.controller.abort();
      await active.operation;
    }
    const canceled = await this.controlDatabase.transaction((transaction) => {
      const run = transaction.get('run', tenant, id);
      if (!run || !NONTERMINAL_RUN_STATES.has(run.state)) throw new ManualBackupError('BACKUP_RUN_NOT_CANCELABLE', 'Only an active backup run can be canceled.', { category: 'conflict' });
      const group = transaction.get('executionGroup', tenant, run.executionGroupId);
      if (!group || TERMINAL_RUN_STATES.has(group.state)) throw new ManualBackupError('BACKUP_RUN_GROUP_TERMINAL', 'The backup execution group is already terminal.', { category: 'conflict' });
      const cleanupUnproven = ['acquiring', 'active'].includes(run.sourceLease?.state);
      const projected = transaction.projectExecution('run', tenant, run.id, {
        state: cleanupUnproven ? 'interrupted' : 'canceled',
        lease: null,
        finishedAt: canceledAt,
        progress: { ...(run.progress || {}), phase: cleanupUnproven ? 'operator-action-required' : 'canceled', updatedAt: canceledAt },
        cancellation: { requestedAt: canceledAt, requestedBy: actor, acknowledgedAt: cleanupUnproven ? null : canceledAt, reasonCode: 'user-requested' },
        result: cleanupUnproven
          ? { safeErrorCode: 'BACKUP_SOURCE_LEASE_CLEANUP_UNPROVEN', safeMessage: 'The backup stopped, but cleanup of its owned source lease could not be proven.', category: 'consistency', retryable: false }
          : { safeErrorCode: 'BACKUP_RUN_CANCELED', safeMessage: 'The backup was canceled by the user.', category: 'cancellation', retryable: false }
      }, { expectedRevision: run.revision, actorId: actor });
      if (!cleanupUnproven) transaction.projectExecution('executionGroup', tenant, group.id, {
        state: 'canceled', latestRunId: run.id, terminalRunId: run.id
      }, { expectedRevision: group.revision, actorId: actor });
      return projected;
    });
    await this.#log(tenant, id, 'warning', canceled.state === 'canceled' ? 'Backup run canceled.' : 'Backup cancellation requires source lease inspection.', { state: canceled.state, reasonCode: 'user-requested' });
    return publicRun((await this.controlDatabase.repository('run').get(tenant, id)) || canceled);
  }

  async retry(workspaceId, actorId, runId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const previous = await this.controlDatabase.repository('run').get(tenant, requiredText(runId, 'Backup run ID'));
    if (!previous || !['failed', 'canceled'].includes(previous.state)) throw new ManualBackupError('BACKUP_RUN_NOT_RETRYABLE', 'Only a failed or canceled backup run can be retried.', { category: 'conflict' });
    const configuration = await this.#configuration(tenant, previous.jobId);
    return this.#startOccurrence(tenant, actor, configuration, {
      trigger: 'retry',
      groupTrigger: 'manual',
      scheduledFor: null,
      occurrenceKey: `retry:${previous.id}:${this.randomUUID()}`,
      retryOfRunId: previous.id
    });
  }

  async #validateCheckpoint(workspaceId, run, checkpoint) {
    if (!checkpoint || checkpoint.executionGroupId !== run.executionGroupId || checkpoint.planDigest !== run.planDigest || checkpoint.repositoryEngineVersion !== ENGINE_VERSION || checkpoint.formatVersion !== CHECKPOINT_VERSION) throw new ManualBackupError('BACKUP_RUN_CHECKPOINT_INVALID', 'The interrupted backup checkpoint is incompatible.');
    await this.#validateConfiguration(workspaceId, run.configSnapshot);
    for (const artifact of checkpoint.committedArtifacts) {
      const repositorySnapshot = run.configSnapshot.repositories.find((repository) => repository.id === artifact.repositoryId);
      if (!repositorySnapshot) throw new ManualBackupError('BACKUP_RUN_CHECKPOINT_INVALID', 'The checkpoint references a repository outside the run plan.');
      const opened = await this.#openSnapshotRepository(workspaceId, repositorySnapshot);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: artifact.repositoryId, snapshotId: artifact.snapshotId, masterKey: opened.masterKey });
      const stat = await opened.adapter.stat({}, artifact.locator);
      if (snapshot.summary.manifestKey !== artifact.locator || snapshot.summary.manifestChecksum.digest !== artifact.checksum.digest || Number(stat?.sizeBytes) !== Number(artifact.sizeBytes)) throw new ManualBackupError('BACKUP_RUN_CHECKPOINT_ARTIFACT_MISSING', 'A checkpointed repository manifest could not be confirmed.');
    }
  }

  async #validateConfiguration(workspaceId, snapshot) {
    const sourcePlan = await this.sourceReader.plan(workspaceId, snapshot.source.id);
    if (sourcePlan.source.revision !== snapshot.source.revision || sourcePlan.source.selector?.digest !== snapshot.source.selector?.digest) throw new ManualBackupError('BACKUP_RUN_SOURCE_CHANGED', 'The source configuration changed after this run started.');
    if (snapshot.connection && (sourcePlan.connection.id !== snapshot.connection.id || sourcePlan.connection.revision !== snapshot.connection.revision)) throw new ManualBackupError('BACKUP_RUN_CONNECTION_CHANGED', 'The source connection changed after this run started.');
    if (snapshot.executionConnection && (!sourcePlan.executionConnection || sourcePlan.executionConnection.id !== snapshot.executionConnection.id || sourcePlan.executionConnection.revision !== snapshot.executionConnection.revision || sourcePlan.executionConnection.trust?.fingerprint !== snapshot.executionConnection.hostKeyFingerprint)) throw new ManualBackupError('BACKUP_RUN_EXECUTION_CONNECTION_CHANGED', 'The physical backup SSH execution connection changed after this run started.', { category: 'integrity' });
    for (const expected of snapshot.secretRefs || []) {
      const current = await this.controlDatabase.repository('secretRef').get(workspaceId, expected.id);
      if (!current || current.version !== expected.version) throw new ManualBackupError('BACKUP_RUN_SECRET_CHANGED', 'A credential or encryption key changed after this run started.', { category: 'encryption' });
    }
    return sourcePlan;
  }

  async #openSnapshotRepository(workspaceId, snapshot) {
    const opened = await this.openRepository(workspaceId, snapshot.id);
    const repository = opened?.repository;
    if (!repository || repository.id !== snapshot.id || repository.revision !== snapshot.revision
      || repository.adapterId !== snapshot.adapterId || repository.adapterVersion !== snapshot.adapterVersion
      || repository.engineId !== snapshot.engineId || repository.engineVersion !== snapshot.engineVersion
      || repository.encryption?.keyVersion !== snapshot.encryptionKeyVersion) {
      throw new ManualBackupError('BACKUP_RUN_REPOSITORY_CHANGED', 'A backup repository changed after this run started.', { category: 'integrity' });
    }
    return opened;
  }

  #launch(workspaceId, actorId, runId, checkpoint) {
    const controller = new AbortController();
    const execution = this.#execute(workspaceId, actorId, runId, checkpoint, controller.signal).catch(() => {}).finally(() => this.activeRuns.delete(runId));
    this.activeRuns.set(runId, { controller, operation: execution });
  }

  async wait(runId) {
    await this.activeRuns.get(runId)?.operation;
    return runId;
  }

  async #log(workspaceId, runId, level, message, context = {}) {
    if (!this.logStore) return;
    const logger = this.logStore.logger({ workspaceId, component: 'backup-run', correlationId: runId, baseContext: { runId } });
    const method = level === 'error' ? 'error' : level === 'warning' ? 'warn' : level === 'debug' ? 'debug' : 'info';
    await logger[method](message, context).catch(() => {});
  }

  async #notify(workspaceId, run) {
    if (!this.notificationService || !['succeeded', 'warning', 'failed'].includes(run?.state)) return;
    await this.notificationService.notifyBackupRun(workspaceId, publicRun(run)).catch(() => {});
  }

  async list(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const jobId = options.jobId ? requiredText(options.jobId, 'Backup job ID') : null;
    return (await this.controlDatabase.repository('run').list(tenant, { limit: options.limit || 200 }))
      .filter((run) => !jobId || run.jobId === jobId)
      .map(publicRun);
  }

  async reconcile(workspaceId, actorId = 'system', options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const runs = await this.controlDatabase.repository('run').list(tenant, { limit: 1000 });
    const recovered = [];
    const currentTime = this.now();
    const stale = (run) => {
      if (options.force) return true;
      if (run.state === 'queued') return currentTime - Date.parse(run.createdAt) >= RUN_LEASE_MS;
      return !run.lease?.expiresAt || Date.parse(run.lease.expiresAt) <= currentTime;
    };
    const hasActiveSourceLease = (run) => ['acquiring', 'active'].includes(run.sourceLease?.state);
    const candidates = runs.filter((candidate) => (['queued', 'preparing', 'running', 'verifying'].includes(candidate.state) && stale(candidate)) || (candidate.state === 'interrupted' && hasActiveSourceLease(candidate)));
    for (const run of candidates) {
      if (hasActiveSourceLease(run)) {
        let cleanup = null;
        try { cleanup = await this.sourceReader.reconcileRun?.(tenant, run); }
        catch (_error) {}
        const cleanupProven = cleanup?.applicable === true && cleanup.proven === true;
        if (!cleanupProven && run.state === 'interrupted') {
          recovered.push(publicRun(run));
          continue;
        }
        const projected = await this.controlDatabase.transaction((transaction) => {
          const current = transaction.get('run', tenant, run.id);
          const group = transaction.get('executionGroup', tenant, current.executionGroupId);
          const next = transaction.projectExecution('run', tenant, current.id, {
            state: cleanupProven ? 'failed' : 'interrupted', lease: null, finishedAt: current.finishedAt || this.clock(),
            sourceLease: cleanupProven ? cleanup.sourceLease : current.sourceLease,
            progress: { ...(current.progress || {}), phase: cleanupProven ? 'failed' : 'operator-action-required', updatedAt: this.clock() },
            checkpoint: { ...(current.checkpoint || {}), available: false },
            result: cleanupProven
              ? { safeErrorCode: 'BACKUP_RUN_PROCESS_INTERRUPTED', safeMessage: 'The backup process stopped and its owned source lease was cleaned up. Start a fresh backup.', category: 'execution', retryable: false }
              : { safeErrorCode: 'BACKUP_SOURCE_LEASE_CLEANUP_UNPROVEN', safeMessage: 'The backup process stopped and cleanup of its source lease could not be proven. Inspect the provider before retrying.', category: 'consistency', retryable: false }
          }, { expectedRevision: current.revision, actorId });
          if (cleanupProven && group && !TERMINAL_RUN_STATES.has(group.state)) transaction.projectExecution('executionGroup', tenant, group.id, {
            state: 'failed', latestRunId: current.id, terminalRunId: current.id
          }, { expectedRevision: group.revision, actorId });
          return next;
        });
        recovered.push(publicRun(projected));
        continue;
      }
      const projected = await this.controlDatabase.transaction((transaction) => transaction.projectExecution('run', tenant, run.id, {
        state: 'interrupted', lease: null, finishedAt: this.clock(), checkpoint: { ...(run.checkpoint || {}), available: Boolean(run.checkpoint?.available) },
        result: { safeErrorCode: 'BACKUP_RUN_PROCESS_INTERRUPTED', safeMessage: 'The DeployerX process stopped before this backup completed.', retryable: true }
      }, { expectedRevision: run.revision, actorId }));
      recovered.push(publicRun(projected));
    }
    return recovered;
  }

  async failInterrupted(workspaceId, actorId, interruptedRunId, failure = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const runId = requiredText(interruptedRunId, 'Interrupted run ID');
    const finalized = await this.controlDatabase.transaction((transaction) => {
      const run = transaction.get('run', tenant, runId);
      if (!run || run.state !== 'interrupted') throw new ManualBackupError('BACKUP_RUN_NOT_INTERRUPTED', 'Only an interrupted backup run can be finalized.');
      const group = transaction.get('executionGroup', tenant, run.executionGroupId);
      if (!group || TERMINAL_RUN_STATES.has(group.state)) return publicRun(run);
      const result = {
        safeErrorCode: String(failure.safeErrorCode || 'BACKUP_RETRY_LIMIT_REACHED').slice(0, 128),
        safeMessage: String(failure.safeMessage || 'The scheduled backup reached its retry limit.').slice(0, 300),
        category: String(failure.category || 'execution').slice(0, 80),
        retryable: false
      };
      const projected = transaction.projectExecution('run', tenant, run.id, {
        state: 'failed', finishedAt: run.finishedAt || this.clock(), result
      }, { expectedRevision: run.revision, actorId: actor });
      transaction.projectExecution('executionGroup', tenant, group.id, {
        state: 'failed', latestRunId: run.id, terminalRunId: run.id
      }, { expectedRevision: group.revision, actorId: actor });
      return publicRun(projected);
    });
    await this.#notify(tenant, finalized);
    return finalized;
  }

  async #execute(workspaceId, actorId, runId, resumeCheckpoint, signal) {
    let run = await this.controlDatabase.repository('run').get(workspaceId, runId);
    const group = await this.controlDatabase.repository('executionGroup').get(workspaceId, run.executionGroupId);
    const snapshot = run.configSnapshot;
    const fencingToken = Math.max(1, Number(resumeCheckpoint?.fencingToken || 0) + 1);
    let runLease = leaseFor(run.id, this.workerId, fencingToken, this.clock);
    let checkpointSequence = Number(resumeCheckpoint?.sequence || 0);
    let checkpointRunId = resumeCheckpoint?.runId || null;
    const committedArtifacts = [...(resumeCheckpoint?.committedArtifacts || [])];
    const bandwidthPolicy = snapshot.policy.performance?.bandwidth || {
      timezone: snapshot.policy.schedule?.timezone || 'UTC',
      defaultLimitBytesPerSecond: snapshot.policy.performance?.bandwidthLimitBytesPerSecond ?? null,
      windows: []
    };
    const bandwidthLimiter = new BandwidthLimiter({ policy: bandwidthPolicy, now: this.now });
    const progress = { ...initialProgress(this.clock), ...(resumeCheckpoint?.progress || {}), phase: 'preparing', repositoryCount: snapshot.repositories.length, startedAt: this.clock(), updatedAt: this.clock() };
    const throughputSamples = [{ at: this.now(), bytes: Number(progress.bytesRead || 0) }];
    const warnings = [];
    let sourceExecutionManifest = null;
    let noChange = false;
    let sourceReleased = false;
    if (snapshot.source.adapterId === 'deployerx.files.ssh' && !snapshot.source.selector?.options?.crossMounts) warnings.push({ code: 'SSH_MOUNT_BOUNDARY_UNAVAILABLE', safeMessage: 'SFTP cannot prove filesystem mount boundaries; selected paths were traversed without crossing detection.' });
    let lastProgressWrite = 0;
    const project = async (changes) => {
      run = await this.controlDatabase.transaction((transaction) => transaction.projectExecution('run', workspaceId, run.id, changes, { expectedRevision: run.revision, actorId: this.workerId }));
      return run;
    };
    const releaseSource = async () => {
      if (sourceReleased) return false;
      await this.sourceReader.release?.(workspaceId, run.id);
      sourceReleased = true;
      return true;
    };
    const updateProgress = async (event = {}, force = false) => {
      progress.phase = event.phase || progress.phase;
      progress.itemsScanned += Number(event.itemsScanned || 0);
      progress.bytesRead += Number(event.bytesRead || 0);
      progress.sourceBytes += Number(event.sizeBytes || 0);
      progress.throttleWaitMilliseconds += Number(event.throttleWaitMilliseconds || 0);
      if (event.bandwidthLimitBytesPerSecond !== undefined) progress.bandwidthLimitBytesPerSecond = event.bandwidthLimitBytesPerSecond;
      if (event.path) progress.currentPath = event.path;
      const now = this.now();
      throughputSamples.push({ at: now, bytes: progress.bytesRead });
      while (throughputSamples.length > 2 && throughputSamples[1].at < now - 5000) throughputSamples.shift();
      const baseline = throughputSamples[0];
      const elapsedSeconds = Math.max(0.001, (now - baseline.at) / 1000);
      progress.throughputBytesPerSecond = Math.max(0, Math.round((progress.bytesRead - baseline.bytes) / elapsedSeconds));
      progress.updatedAt = this.clock();
      if (!force && now - lastProgressWrite < PROGRESS_WRITE_INTERVAL_MS) return;
      lastProgressWrite = now;
      runLease = renewedLease(runLease, this.clock);
      await project({ progress: structuredClone(progress), lease: runLease });
    };
    try {
      if (signal?.aborted) throw new ManualBackupError('BACKUP_RUN_CANCELED', 'The backup was canceled by the user.', { category: 'cancellation' });
      await this.#log(workspaceId, run.id, 'info', 'Backup run started.', { jobId: run.jobId, trigger: run.trigger, attempt: run.attempt, repositoryCount: snapshot.repositories.length });
      run = await this.controlDatabase.transaction((transaction) => {
        transaction.projectExecution('executionGroup', workspaceId, group.id, { state: 'running', latestRunId: run.id }, { expectedRevision: group.revision, actorId: this.workerId });
        return transaction.projectExecution('run', workspaceId, run.id, { state: 'preparing', lease: runLease, progress, startedAt: progress.startedAt }, { expectedRevision: run.revision, actorId: this.workerId });
      });
      const primaryId = snapshot.repositories[0].id;
      const primary = await this.#openSnapshotRepository(workspaceId, snapshot.repositories[0]);
      await this.#validateConfiguration(workspaceId, snapshot);
      await project({ state: 'running', progress: { ...progress, phase: 'scanning' } });
      progress.phase = 'scanning';

      const previousPoints = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 });
      const jobPoints = previousPoints.filter((point) => point.jobId === run.jobId);
      const previousPoint = jobPoints.find((point) => point.id === snapshot.job.lastRecoveryPointId)
        || jobPoints.sort((left, right) => String(right.capturedTo || '').localeCompare(String(left.capturedTo || ''), 'en-US') || right.id.localeCompare(left.id, 'en-US'))[0]
        || null;
      const cassandraCommitLogJob = snapshot.policy.backupMode === 'native' && snapshot.source.adapterId === 'deployerx.database.cassandra-scylla';
      const databaseChained = snapshot.source.sourceType === 'database' && (['incremental', 'differential'].includes(snapshot.policy.backupMode) || (snapshot.policy.backupMode === 'native' && ['deployerx.database.oracle.rman', 'deployerx.database.cassandra-scylla'].includes(snapshot.source.adapterId)));
      let effectiveBackupMode = databaseChained && !previousPoint ? 'full' : snapshot.policy.backupMode;
      let baselineReason = databaseChained && !previousPoint ? 'initial-baseline' : null;
      if (snapshot.source.adapterId === 'deployerx.database.cassandra-scylla' && snapshot.policy.backupMode === 'incremental' && previousPoint) {
        const maximumChainLength = Number(snapshot.job.adapterSettings?.cassandraIncremental?.maximumChainLength || 30);
        const chainRootId = previousPoint.chainRootId || previousPoint.id;
        const incrementalCount = previousPoints.filter((point) => point.jobId === run.jobId && point.chainRootId === chainRootId && point.type === 'incremental').length;
        if (incrementalCount >= maximumChainLength) {
          effectiveBackupMode = 'full';
          baselineReason = 'maximum-chain-length';
        }
      }
      if (cassandraCommitLogJob && previousPoint) {
        const maximumChainLength = Number(snapshot.job.adapterSettings?.cassandraCommitLog?.maximumChainLength || 1440);
        const chainRootId = previousPoint.chainRootId || previousPoint.id;
        const logCount = previousPoints.filter((point) => point.jobId === run.jobId && point.chainRootId === chainRootId && point.type === 'log').length;
        if (logCount >= maximumChainLength) {
          effectiveBackupMode = 'full';
          baselineReason = 'maximum-commit-log-chain-length';
        }
      }
      for (let index = 0; index < snapshot.repositories.length; index += 1) {
        const repositorySnapshot = snapshot.repositories[index];
        progress.repositoryIndex = index + 1;
        progress.phase = 'transferring';
        const existingArtifact = committedArtifacts.find((artifact) => artifact.repositoryId === repositorySnapshot.id);
        if (existingArtifact) {
          progress.committedRepositories += 1;
          continue;
        }
        const opened = await this.#openSnapshotRepository(workspaceId, repositorySnapshot);
        let repositoryLease = await opened.adapter.acquireLock({ masterKey: opened.masterKey }, {
          repositoryId: repositorySnapshot.id, operation: 'backup', scope: `repository:${repositorySnapshot.id}:mutation`,
          workerId: this.workerId, runId: run.id, ttlMs: REPOSITORY_LEASE_MS
        });
        let lastRepositoryRenewal = this.now();
        try {
          if (typeof opened.adapter.reconcileStaging === 'function') {
            const reconciliation = await opened.adapter.reconcileStaging(
              { masterKey: opened.masterKey },
              { lease: repositoryLease, minimumAgeMs: REPOSITORY_LEASE_MS }
            );
            if (reconciliation.removed?.length) {
              await this.#log(workspaceId, run.id, 'warning', 'Abandoned repository staging files were reconciled before backup.', {
                repositoryId: repositorySnapshot.id,
                removedStagingFiles: reconciliation.removed.length
              });
            }
          }
          const capacityStatus = evaluateRepositoryCapacity(
            await opened.adapter.getCapacity({}),
            repositorySnapshot.storagePolicy,
            repositorySnapshot.storagePolicy.minimumBackupBytes,
            this.clock()
          );
          if (!capacityStatus.allowed) throw new ManualBackupError('BACKUP_REPOSITORY_CAPACITY_BLOCKED', 'The repository cannot prove enough capacity for this backup.', { category: 'capacity', retryable: true });
          const sourceFiles = await this.sourceReader.files(workspaceId, snapshot.source.id, {
            executionId: run.id,
            jobId: run.jobId,
            backupMode: effectiveBackupMode,
            requestedBackupMode: snapshot.policy.backupMode,
            baselineReason,
            previousRecoveryPoint: previousPoint || null,
            repositoryIds: snapshot.repositories.map((repository) => repository.id),
            signal,
            onSourceLease: async (sourceLease) => project({ sourceLease: structuredClone(sourceLease), lease: renewedLease(runLease, this.clock) }),
            bandwidthLimiter,
            onProgress: async (event) => {
              if (this.now() - lastRepositoryRenewal >= 60000) {
                repositoryLease = await opened.adapter.renewLock({ masterKey: opened.masterKey }, repositoryLease);
                lastRepositoryRenewal = this.now();
              }
              await updateProgress(event);
            }
          });
          const reportedBackupMode = sourceFiles.manifest?.database?.backupMode;
          if (snapshot.source.sourceType === 'database' && reportedBackupMode && reportedBackupMode !== effectiveBackupMode) {
            const neo4jDifferentialFallback = snapshot.policy.backupMode === 'differential'
              && snapshot.source.adapterId === 'deployerx.database.neo4j'
              && sourceFiles.manifest?.database?.kind === 'neo4j-enterprise-backup'
              && sourceFiles.manifest?.database?.requestedBackupMode === 'differential';
            const validChainedBaseline = reportedBackupMode === 'full' && ((snapshot.policy.backupMode === 'incremental') || cassandraCommitLogJob || neo4jDifferentialFallback);
            if (!validChainedBaseline) throw new ManualBackupError('DATABASE_BACKUP_MODE_CHANGED', 'The database backup executor returned an unexpected backup mode.', { category: 'integrity' });
            effectiveBackupMode = 'full';
          }
          if (!sourceExecutionManifest) sourceExecutionManifest = structuredClone(sourceFiles.manifest || null);
          else if (snapshot.source.sourceType === 'database' && sourceExecutionManifest.database?.selectionDigest !== sourceFiles.manifest?.database?.selectionDigest) throw new ManualBackupError('DATABASE_BACKUP_COPY_PLAN_CHANGED', 'The database backup plan changed between repository copies.', { category: 'integrity' });
          if (snapshot.source.sourceType === 'database' && sourceFiles.manifest?.noChange === true) {
            noChange = true;
            break;
          }
          const parentCopy = previousPoint?.repositoryCopies?.find((copy) => copy.repositoryId === repositorySnapshot.id);
          const summary = await opened.engine.createSnapshot({}, {
            repositoryId: repositorySnapshot.id,
            masterKey: opened.masterKey,
            keyVersion: opened.keyVersion,
            idempotencyKey: `${group.idempotencyKey}:repository:${repositorySnapshot.id}`,
            parentSnapshotId: ['incremental', 'differential', 'native'].includes(effectiveBackupMode) ? parentCopy?.engineSnapshotId || null : null,
            files: sourceFiles.create()
          });
          const manifestStat = await opened.adapter.stat({}, summary.manifestKey);
          if (!manifestStat || manifestStat.sizeBytes < 1) throw new ManualBackupError('BACKUP_MANIFEST_COMMIT_UNCONFIRMED', 'The repository did not confirm its committed backup manifest.', { retryable: true });
          const openedSnapshot = snapshot.source.sourceType === 'database'
            ? await opened.engine.openSnapshot({}, { repositoryId: repositorySnapshot.id, snapshotId: summary.snapshotId, masterKey: opened.masterKey })
            : null;
          const databasePaths = sourceExecutionManifest?.artifactPaths || (sourceExecutionManifest?.artifactPath ? [sourceExecutionManifest.artifactPath] : []);
          const databaseFiles = databasePaths.map((artifactPath) => openedSnapshot?.manifest?.files?.find((file) => file.path === artifactPath));
          if (snapshot.source.sourceType === 'database' && (!databaseFiles.length || databaseFiles.some((file) => !file || file.type !== 'file'))) throw new ManualBackupError('DATABASE_ARTIFACT_MISSING', 'The committed repository snapshot does not contain every planned database artifact.', { category: 'integrity' });
          const publishedDatabaseManifest = databaseFiles.find((file) => file?.metadata?.componentId === 'cluster-manifest' && file.metadata?.database?.publication?.state === 'sealed')?.metadata?.database;
          if (publishedDatabaseManifest) sourceExecutionManifest.database = structuredClone(publishedDatabaseManifest);
          const artifact = {
            repositoryId: repositorySnapshot.id, snapshotId: summary.snapshotId, locator: summary.manifestKey,
            checksum: summary.manifestChecksum, sizeBytes: manifestStat.sizeBytes, summary,
            databaseArtifacts: databaseFiles.filter(Boolean).map((file) => ({ kind: file.metadata?.artifactKind || 'database-dump', path: file.path, sizeBytes: file.sizeBytes, checksum: file.contentDigest, metadata: file.metadata?.database || null }))
          };
          committedArtifacts.push(artifact);
          progress.committedRepositories = committedArtifacts.length;
          progress.uploadedBytes += Number(summary.uploadedBytes || 0);
          progress.reusedBytes += Number(summary.reusedBytes || 0);
          progress.files = Math.max(progress.files, Number(summary.files || 0));
          progress.directories = Math.max(progress.directories, Number(summary.directories || 0));
          progress.symbolicLinks = Math.max(progress.symbolicLinks, Number(summary.symbolicLinks || 0));
          await this.#log(workspaceId, run.id, 'info', 'Repository copy committed.', {
            repositoryId: repositorySnapshot.id, sourceBytes: Number(summary.sourceBytes || 0), uploadedBytes: Number(summary.uploadedBytes || 0), reusedBytes: Number(summary.reusedBytes || 0)
          });
          checkpointSequence += 1;
          const checkpoint = await this.checkpointStore.write({
            checkpointId: `checkpoint_${generateUuidV7()}`, workspaceId, executionGroupId: run.executionGroupId, runId: run.id,
            fencingToken, sequence: checkpointSequence, planDigest: run.planDigest,
            adapterVersions: Object.fromEntries(snapshot.repositories.map((repository) => [repository.adapterId, repository.adapterVersion || 'unknown'])),
            repositoryEngineVersion: ENGINE_VERSION, formatVersion: CHECKPOINT_VERSION, phase: 'repository-committed',
            committedArtifacts: committedArtifacts.map((item) => ({ repositoryId: item.repositoryId, snapshotId: item.snapshotId, locator: item.locator, checksum: item.checksum, sizeBytes: item.sizeBytes })),
            adapterState: { sourceId: snapshot.source.id, sourceRevision: snapshot.source.revision, selectionDigest: snapshot.source.selector?.digest || null },
            progress: structuredClone(progress), createdAt: this.clock()
          }, primaryId, primary.masterKey);
          checkpointRunId = run.id;
          await project({ progress: structuredClone(progress), lease: runLease, checkpoint: { available: true, sequence: checkpoint.sequence, runId: run.id, phase: checkpoint.phase, updatedAt: checkpoint.createdAt } });
        } finally {
          await opened.adapter.releaseLock({ masterKey: opened.masterKey }, repositoryLease).catch(() => {});
        }
      }

      await releaseSource();
      if (signal?.aborted) throw new ManualBackupError('BACKUP_RUN_CANCELED', 'The backup was canceled by the user.', { category: 'cancellation' });

      if (noChange) {
        const finishedAt = this.clock();
        progress.phase = 'verifying'; progress.currentPath = null; progress.updatedAt = finishedAt;
        await project({ state: 'verifying', progress: structuredClone(progress), lease: renewedLease(runLease, this.clock) });
        progress.phase = 'completed';
        run = await this.controlDatabase.transaction((transaction) => {
          const currentRun = transaction.get('run', workspaceId, run.id);
          const currentGroup = transaction.get('executionGroup', workspaceId, group.id);
          const projected = transaction.projectExecution('run', workspaceId, currentRun.id, {
            state: 'succeeded', progress: structuredClone(progress), lease: null, finishedAt,
            result: { recoveryPointIds: [], warnings: [], safeErrorCode: null, noChange: true, sourceBytes: 0, uploadedBytes: 0, reusedBytes: 0 }
          }, { expectedRevision: currentRun.revision, actorId: this.workerId });
          transaction.projectExecution('executionGroup', workspaceId, currentGroup.id, { state: 'succeeded', latestRunId: currentRun.id, terminalRunId: currentRun.id }, { expectedRevision: currentGroup.revision, actorId: this.workerId });
          const currentJob = transaction.get('backupJob', workspaceId, run.jobId);
          if (currentJob) transaction.update('backupJob', workspaceId, currentJob.id, { lastSuccessfulRunId: run.id }, { expectedRevision: currentJob.revision, actorId: this.workerId });
          return projected;
        });
        await this.checkpointStore.remove(workspaceId, run.id);
        await this.#log(workspaceId, run.id, 'info', 'Binary-log capture completed with no new database events.', { state: run.state, noChange: true });
        await this.#notify(workspaceId, run);
        return null;
      }

      progress.phase = 'verifying';
      await project({ state: 'verifying', progress: structuredClone(progress), lease: renewedLease(runLease, this.clock) });
      for (const artifact of committedArtifacts) {
        const repositorySnapshot = snapshot.repositories.find((repository) => repository.id === artifact.repositoryId);
        const opened = await this.#openSnapshotRepository(workspaceId, repositorySnapshot);
        const verified = await opened.engine.openSnapshot({}, { repositoryId: artifact.repositoryId, snapshotId: artifact.snapshotId, masterKey: opened.masterKey });
        const manifestStat = await opened.adapter.stat({}, artifact.locator);
        if (verified.summary.manifestKey !== artifact.locator || verified.summary.manifestChecksum.digest !== artifact.checksum.digest || Number(manifestStat?.sizeBytes) !== Number(artifact.sizeBytes)) throw new ManualBackupError('BACKUP_MANIFEST_VERIFICATION_FAILED', 'A repository manifest failed verification.');
      }
      const finishedAt = this.clock();
      const recoveryPointId = `rp_${generateUuidV7()}`;
      const incremental = effectiveBackupMode === 'incremental' && Boolean(previousPoint);
      const differential = effectiveBackupMode === 'differential' && Boolean(previousPoint);
      const databasePhysical = sourceExecutionManifest?.database?.backupMethod === 'physical';
      const postgresqlWal = sourceExecutionManifest?.database?.kind === 'postgresql-wal' ? sourceExecutionManifest.database.wal : null;
      const sqlServerBackup = sourceExecutionManifest?.database?.kind === 'sqlserver-native' ? sourceExecutionManifest.database.backup : null;
      const oracleBackup = sourceExecutionManifest?.database?.kind === 'oracle-rman' ? sourceExecutionManifest.database.backup : null;
      const oracleRedo = sourceExecutionManifest?.database?.kind === 'oracle-rman' ? sourceExecutionManifest.database.archivedRedo : null;
      const cassandraCommitLog = sourceExecutionManifest?.database?.engine === 'cassandra-scylla' ? sourceExecutionManifest.database.commitLog || null : null;
      const cassandraLogPoint = sourceExecutionManifest?.database?.kind === 'cassandra-commit-log' && Boolean(cassandraCommitLog);
      const databaseLog = snapshot.source.sourceType === 'database' && ((incremental && (!databasePhysical || Boolean(postgresqlWal))) || cassandraLogPoint);
      const binaryLog = sourceExecutionManifest?.database?.binaryLog || null;
      const recoveryPoint = await this.controlDatabase.transaction((transaction) => {
        let point = transaction.create('recoveryPoint', {
          id: recoveryPointId, workspaceId, actorId: this.workerId, jobId: run.jobId, sourceId: snapshot.source.id, runId: run.id,
          type: oracleBackup?.type === 'archived-redo' ? 'log' : oracleBackup?.type === 'level-1-cumulative' ? 'differential' : oracleBackup?.type === 'level-1-differential' ? 'incremental' : sqlServerBackup?.type === 'log' ? 'log' : sqlServerBackup?.type === 'differential' ? 'differential' : databaseLog ? 'log' : incremental ? 'incremental' : differential ? 'differential' : 'full', consistency: snapshot.source.sourceType === 'database' ? sourceExecutionManifest?.consistency?.achievedLevel || 'unknown' : 'filesystem',
          chainRootId: cassandraLogPoint ? sourceExecutionManifest.database.chain?.chainRootRecoveryPointId : oracleBackup && !['full', 'level-0'].includes(oracleBackup.type) ? sourceExecutionManifest.database.chain?.chainRootRecoveryPointId : sqlServerBackup && sqlServerBackup.type !== 'full' ? sourceExecutionManifest.database.chain?.chainRootRecoveryPointId : incremental || differential ? previousPoint.chainRootId || previousPoint.id : recoveryPointId,
          parentRecoveryPointId: cassandraLogPoint ? sourceExecutionManifest.database.chain?.parentRecoveryPointId : oracleBackup && !['full', 'level-0'].includes(oracleBackup.type) ? sourceExecutionManifest.database.chain?.parentRecoveryPointId : sqlServerBackup && sqlServerBackup.type !== 'full' ? sourceExecutionManifest.database.chain?.parentRecoveryPointId : incremental || differential ? previousPoint.id : null,
          capturedFrom: progress.startedAt, capturedTo: finishedAt,
          pointInTime: cassandraCommitLog ? {
            version: 1,
            type: 'cassandra-commit-log',
            precision: cassandraCommitLog.precision,
            earliest: cassandraCommitLog.recoveryWindow?.earliest || null,
            previous: cassandraCommitLog.recoveryWindow?.previous || null,
            latest: cassandraCommitLog.recoveryWindow?.latest || null,
            gaps: structuredClone(cassandraCommitLog.gaps || [])
          } : binaryLog ? {
            version: 1,
            anchorCoordinate: binaryLog.anchorCoordinate || null,
            startCoordinate: binaryLog.startCoordinate || null,
            endCoordinate: binaryLog.endCoordinate || null
          } : postgresqlWal ? {
            version: 1,
            type: 'postgresql-wal',
            timeline: postgresqlWal.timeline,
            firstSegment: postgresqlWal.firstSegment || null,
            lastSegment: postgresqlWal.lastSegment,
            segmentSizeBytes: postgresqlWal.segmentSizeBytes
          } : sqlServerBackup ? {
            version: 1,
            type: 'sql-server-lsn',
            firstLsn: sqlServerBackup.firstLsn,
            lastLsn: sqlServerBackup.lastLsn,
            checkpointLsn: sqlServerBackup.checkpointLsn,
            recoveryForkId: sqlServerBackup.recoveryForkId,
            hasBulkLoggedData: sqlServerBackup.hasBulkLoggedData
          } : oracleBackup ? {
            version: 1,
            type: 'oracle-scn',
            dbid: sourceExecutionManifest.database.database?.dbid,
            incarnation: sourceExecutionManifest.database.database?.incarnation,
            resetlogsChange: sourceExecutionManifest.database.database?.resetlogsChange,
            checkpointScn: oracleBackup.checkpointScn,
            startScn: oracleRedo?.startScn || null,
            endScn: oracleRedo?.endScn || null,
            firstSequence: oracleRedo?.firstSequence || null,
            lastSequence: oracleRedo?.lastSequence || null
          } : null,
          repositoryCopies: committedArtifacts.map((artifact) => ({ repositoryId: artifact.repositoryId, engineSnapshotId: artifact.snapshotId, state: 'available', manifestLocator: artifact.locator, manifestChecksum: artifact.checksum, immutableUntil: null })),
          verification: { mode: 'manifest-checksum', state: 'succeeded', verifiedAt: finishedAt, verificationRunId: null },
          retention: { ...normalizeRetentionPolicy(snapshot.policy.retention || {}, { timezone: snapshot.policy.schedule?.timezone }), expireAt: null, ruleMatches: [], deletionEligible: false, evaluatedAt: finishedAt, policyRevision: snapshot.policy.revision },
          manifestChecksum: digest(committedArtifacts.map((artifact) => ({ repositoryId: artifact.repositoryId, checksum: artifact.checksum })))
        });
        const retentionPolicy = normalizeRetentionPolicy(snapshot.policy.retention || {}, { timezone: snapshot.policy.schedule?.timezone });
        const jobPoints = transaction.list('recoveryPoint', workspaceId, { limit: MAXIMUM_RETENTION_EVALUATION_POINTS }).filter((candidate) => candidate.jobId === run.jobId);
        const retentionDecisions = evaluateRetention(jobPoints, retentionPolicy, finishedAt);
        for (const decision of retentionDecisions) {
          const currentPoint = transaction.get('recoveryPoint', workspaceId, decision.id);
          const retention = {
            ...decision.retention,
            policyRevision: snapshot.policy.revision
          };
          if (retention.deletionEligible && currentPoint.retention?.deletionEligible && currentPoint.retention?.expireAt) {
            retention.expireAt = currentPoint.retention.expireAt;
            retention.evaluatedAt = currentPoint.retention.evaluatedAt || retention.evaluatedAt;
          }
          const comparable = (value = {}) => canonical({ ...value, evaluatedAt: undefined });
          if (comparable(currentPoint.retention) === comparable(retention)) {
            if (currentPoint.id === point.id) point = currentPoint;
            continue;
          }
          const projected = transaction.projectRecoveryPointRetention(workspaceId, decision.id, retention, { expectedRevision: currentPoint.revision, actorId: this.workerId });
          if (projected.id === point.id) point = projected;
        }
        for (const artifact of committedArtifacts) {
          transaction.create('artifact', {
            workspaceId, actorId: this.workerId, recoveryPointId: point.id, repositoryId: artifact.repositoryId,
            kind: 'manifest', locator: artifact.locator, sizeBytes: artifact.sizeBytes, checksum: artifact.checksum,
            encryption: { algorithm: 'aes-256-gcm', keyVersion: artifact.summary?.keyVersion || null },
            compression: { mode: snapshot.policy.performance?.compression || 'balanced' }
          });
          for (const databaseArtifact of artifact.databaseArtifacts || []) transaction.create('artifact', {
            workspaceId, actorId: this.workerId, recoveryPointId: point.id, repositoryId: artifact.repositoryId,
            kind: databaseArtifact.kind, locator: `${artifact.locator}#${encodeURIComponent(databaseArtifact.path)}`,
            sizeBytes: databaseArtifact.sizeBytes, checksum: databaseArtifact.checksum,
            encryption: { algorithm: 'aes-256-gcm', keyVersion: artifact.summary?.keyVersion || null },
            compression: { mode: snapshot.policy.performance?.compression || 'balanced' },
            metadata: databaseArtifact.metadata
          });
        }
        const currentJob = transaction.get('backupJob', workspaceId, run.jobId);
        if (currentJob) transaction.update('backupJob', workspaceId, currentJob.id, { lastSuccessfulRunId: run.id, lastRecoveryPointId: point.id }, { expectedRevision: currentJob.revision, actorId: this.workerId });
        progress.phase = 'completed'; progress.currentPath = null; progress.updatedAt = finishedAt;
        const terminalState = warnings.length ? 'warning' : 'succeeded';
        run = transaction.projectExecution('run', workspaceId, run.id, {
          state: terminalState, progress: structuredClone(progress), lease: null, finishedAt,
          result: { recoveryPointIds: [point.id], warnings, safeErrorCode: null, sourceBytes: Math.max(...committedArtifacts.map((artifact) => artifact.summary?.sourceBytes || 0)), uploadedBytes: progress.uploadedBytes, reusedBytes: progress.reusedBytes }
        }, { expectedRevision: run.revision, actorId: this.workerId });
        transaction.projectExecution('executionGroup', workspaceId, group.id, { state: terminalState, latestRunId: run.id, terminalRunId: run.id }, { expectedRevision: group.revision + 1, actorId: this.workerId });
        return point;
      });
      await this.checkpointStore.remove(workspaceId, run.id);
      if (run.parentRunId) await this.checkpointStore.remove(workspaceId, run.parentRunId);
      await this.#log(workspaceId, run.id, warnings.length ? 'warning' : 'info', warnings.length ? 'Backup run completed with warnings.' : 'Backup run completed.', {
        state: run.state, scannedBytes: progress.sourceBytes, uploadedBytes: progress.uploadedBytes, reusedBytes: progress.reusedBytes, recoveryPointId: recoveryPoint.id
      });
      await this.#notify(workspaceId, run);
      return recoveryPoint;
    } catch (error) {
      let cleanupError = null;
      try { await releaseSource(); }
      catch (releaseError) { cleanupError = releaseError; }
      const failure = safeFailure(cleanupError || error);
      failure.failedAt = this.clock();
      const current = await this.controlDatabase.repository('run').get(workspaceId, run.id);
      if (!signal?.aborted && current && !TERMINAL_RUN_STATES.has(current.state) && current.state !== 'interrupted') {
        const sourceCleanupUnproven = ['acquiring', 'active'].includes(current.sourceLease?.state);
        const interrupted = sourceCleanupUnproven || (snapshot.source.sourceType !== 'database' && (failure.retryable || committedArtifacts.length > 0));
        run = await this.controlDatabase.transaction((transaction) => {
          const projected = transaction.projectExecution('run', workspaceId, current.id, {
            state: interrupted ? 'interrupted' : 'failed', lease: null, finishedAt: this.clock(),
            progress: { ...progress, phase: sourceCleanupUnproven ? 'operator-action-required' : interrupted ? 'interrupted' : 'failed', updatedAt: this.clock() },
            checkpoint: { available: Boolean(checkpointRunId), sequence: checkpointSequence, runId: checkpointRunId },
            result: failure
          }, { expectedRevision: current.revision, actorId: this.workerId });
          if (!interrupted) {
            const currentGroup = transaction.get('executionGroup', workspaceId, current.executionGroupId);
            if (currentGroup && !TERMINAL_RUN_STATES.has(currentGroup.state)) transaction.projectExecution('executionGroup', workspaceId, currentGroup.id, { state: 'failed', latestRunId: current.id, terminalRunId: current.id }, { expectedRevision: currentGroup.revision, actorId: this.workerId });
          }
          return projected;
        });
      }
      await this.#log(workspaceId, run.id, 'warning', 'Backup run stopped.', { state: run.state, error: failure });
      await this.#notify(workspaceId, run);
      throw error;
    } finally {
      await releaseSource().catch(() => {});
    }
  }
}

module.exports = {
  ManualBackupError,
  ManualBackupService,
  NONTERMINAL_RUN_STATES,
  PROGRESS_WRITE_INTERVAL_MS,
  RUN_LEASE_MS,
  TERMINAL_RUN_STATES,
  canonical,
  digest,
  publicRun,
  safeFailure
};
