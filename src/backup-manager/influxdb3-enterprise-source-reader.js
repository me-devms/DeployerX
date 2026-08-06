const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const {
  ADAPTER_ID,
  NATIVE_CONSISTENCY_METHOD,
  nativeBackupName,
  normalizeNativeBackupExecution
} = require('./influxdb3-enterprise');
const {
  BACKUP_STATES,
  InfluxDb3EnterpriseNativeController,
  normalizeBackupOwnership
} = require('./influxdb3-enterprise-native');

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_PREPARATION_DIRECTORIES = 10000;
const MAX_RECOVERY_POINTS = 60001;
const METADATA_PATH = 'influxdb3-enterprise/native-backup-metadata.json';
const SOURCE_LEASE_KIND = 'influxdb3-enterprise-native-backup';
const ADMITTED_RUN_STATES = new Set(['preparing', 'running']);

class InfluxDb3EnterpriseSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseSourceReaderError';
    this.code = code;
    this.category = options.category || 'source';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function preparationPrefix(workspaceId, executionId) {
  return `run-${crypto.createHash('sha256').update(`${workspaceId}\0${executionId}`).digest('hex').slice(0, 32)}-`;
}

function emptyRules(value) {
  return !value?.include?.length && !value?.exclude?.length;
}

function exactWholeClusterSelector(selector) {
  return selector?.kind === 'database-objects'
    && selector.allDatabases === true
    && emptyRules(selector.databases)
    && emptyRules(selector.schemas)
    && emptyRules(selector.tables)
    && selector.includeGlobalObjects !== true;
}

function exactNativeConsistency(consistency) {
  return consistency?.backupMethod === 'physical'
    && consistency.backupMode === 'full'
    && ['auto', NATIVE_CONSISTENCY_METHOD].includes(consistency.method)
    && consistency.requestedLevel === 'application'
    && consistency.captureCoordinates === true
    && consistency.allowDowngrade !== true;
}

function sameExecutionIdentity(execution, identity) {
  return execution.productVersion === identity.version
    && execution.clusterId === identity.clusterId
    && execution.storageEngine === identity.storageEngine
    && execution.nodeId === identity.nodeId
    && execution.nodeCatalogId === identity.nodeCatalogId
    && execution.instanceId === identity.instanceId
    && execution.roleFingerprint === identity.roleFingerprint
    && execution.deploymentFingerprint === identity.deploymentFingerprint
    && execution.capabilityFingerprint === identity.capabilityFingerprint;
}

function publicMetadata(plan, result) {
  const backup = result?.backup;
  const identity = result?.identity;
  if (!backup || backup.status !== BACKUP_STATES.COMPLETED || backup.type !== 'full' || backup.parentName !== null || backup.watermark === null) {
    throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_BACKUP_RESULT_INVALID', 'InfluxDB 3 Enterprise did not return a completed full backup with a persisted-data watermark.', { category: 'integrity' });
  }
  if (!identity || !sameExecutionIdentity(plan.execution, identity)) {
    throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_BACKUP_IDENTITY_CHANGED', 'InfluxDB 3 Enterprise identity changed during native backup execution.', { category: 'integrity' });
  }
  return Object.freeze({
    version: 1,
    kind: SOURCE_LEASE_KIND,
    adapterId: ADAPTER_ID,
    adapterVersion: plan.manifest.adapterVersion,
    engine: 'influxdb3-enterprise',
    backupMethod: 'physical',
    backupMode: 'full',
    sourceId: plan.source.id,
    selectionDigest: plan.source.selector.digest,
    consistency: Object.freeze({ level: 'application', method: NATIVE_CONSISTENCY_METHOD, persistedDataWatermark: backup.watermark }),
    source: Object.freeze({
      product: 'InfluxDB 3 Enterprise',
      productVersion: identity.version,
      clusterId: identity.clusterId,
      storageEngine: identity.storageEngine,
      nodeId: identity.nodeId,
      nodeCatalogId: identity.nodeCatalogId,
      instanceId: identity.instanceId,
      roleFingerprint: identity.roleFingerprint,
      deploymentFingerprint: identity.deploymentFingerprint,
      capabilityFingerprint: identity.capabilityFingerprint,
      compactorCapable: true
    }),
    operation: Object.freeze({
      backupName: backup.name,
      backupType: backup.type,
      status: backup.status,
      watermark: backup.watermark,
      createdAt: backup.createdAt,
      completedAt: backup.completedAt
    }),
    publication: Object.freeze({ artifactKind: 'metadata', path: METADATA_PATH, mediaType: 'application/vnd.deployerx.influxdb3-enterprise-native-backup+json' }),
    externalNativeMedia: Object.freeze({ managedByServer: true, authoritativeOwner: 'influxdb3-enterprise', includedInRepository: false, deletionIssued: false }),
    restoreSupported: false
  });
}

class InfluxDb3EnterpriseSourceReaderService {
  constructor({ controlDatabase, secretStore, deviceId, adapterRegistry, adapter, nativeController = null, temporaryRoot = path.join(os.tmpdir(), 'deployerx-influxdb3-enterprise'), fileSystem = fs, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !adapterRegistry || !adapter) throw new TypeError('InfluxDB 3 Enterprise source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.nativeController = nativeController || new InfluxDb3EnterpriseNativeController({ adapter });
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'InfluxDB 3 Enterprise temporary root'));
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || source.enabled !== true) throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_UNAVAILABLE', 'The InfluxDB 3 Enterprise Source is unavailable.');
    if (!exactWholeClusterSelector(source.selector)) throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_SELECTION_INVALID', 'InfluxDB 3 Enterprise native backup requires exact whole-cluster selection.', { category: 'compatibility' });
    if (!exactNativeConsistency(source.consistency)) throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_CONSISTENCY_INVALID', 'InfluxDB 3 Enterprise native backup requires application-consistent physical full backup.', { category: 'compatibility' });
    let execution;
    try { execution = normalizeNativeBackupExecution(source.physicalExecution); }
    catch { throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_BINDING_INVALID', 'Re-enroll the exact tested InfluxDB 3 Enterprise backup binding.', { category: 'integrity' }); }
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_CONNECTION_MISSING', 'The InfluxDB 3 Enterprise connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_OTHER_DEVICE', 'The InfluxDB 3 Enterprise Source belongs to another device.', { category: 'authorization' });
    const testedIdentity = connection.lastTest?.endpointIdentity;
    const endpoint = connection.endpoint || {};
    const trust = connection.trust || {};
    const pinsMatch = connection.lastTest?.status === 'success'
      && connection.revision === execution.connectionRevision
      && endpoint.expectedVersion === execution.productVersion
      && endpoint.expectedStorageEngine === execution.storageEngine
      && endpoint.expectedClusterId === execution.clusterId
      && endpoint.expectedNodeId === execution.nodeId
      && endpoint.expectedNodeCatalogId === execution.nodeCatalogId
      && endpoint.expectedInstanceId === execution.instanceId
      && endpoint.expectedRoleFingerprint === execution.roleFingerprint
      && endpoint.expectedDeploymentFingerprint === execution.deploymentFingerprint
      && endpoint.expectedCapabilityFingerprint === execution.capabilityFingerprint
      && trust.fingerprint === execution.deploymentFingerprint
      && trust.clusterId === execution.clusterId
      && trust.nodeId === execution.nodeId
      && trust.nodeCatalogId === execution.nodeCatalogId
      && trust.instanceId === execution.instanceId
      && trust.roleFingerprint === execution.roleFingerprint
      && trust.capabilityFingerprint === execution.capabilityFingerprint
      && testedIdentity?.compactorCapable === true
      && testedIdentity?.nativeBackupAvailable === true
      && sameExecutionIdentity(execution, testedIdentity || {});
    if (!pinsMatch) throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_CONNECTION_UNHEALTHY', 'Retest and re-enroll the exact InfluxDB 3 Enterprise Source before backup.', { category: 'integrity', retryable: true });
    const secretRefIds = Array.isArray(connection.secretRefIds) ? connection.secretRefIds : [];
    if (secretRefIds.length !== 1) throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_SECRET_INVALID', 'The InfluxDB 3 Enterprise admin-token SecretRef binding is invalid.', { category: 'authentication' });
    let connectionConfig;
    try { connectionConfig = this.adapter.normalizeConfig({ ...connection.endpoint, adminTokenSecretRefId: secretRefIds[0] }); }
    catch { throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_CONNECTION_INVALID', 'The tested InfluxDB 3 Enterprise connection binding is invalid.', { category: 'configuration' }); }
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    if (!manifest.executionReady || manifest.sourceEnrollmentReady !== true || JSON.stringify(manifest.capabilities.backupModes) !== JSON.stringify(['full'])) throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_EXECUTION_NOT_READY', 'InfluxDB 3 Enterprise native full-backup execution is unavailable.', { category: 'compatibility' });
    return {
      source,
      connection,
      connectionConfig,
      execution,
      manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: source.selector.digest, sourceRevision: source.revision }
    };
  }

  async #writeOwner(ownerPath, owner) {
    const nextPath = `${ownerPath}.next`;
    await this.fileSystem.writeFile(nextPath, JSON.stringify(owner), { flag: 'w', mode: 0o600 });
    await this.fileSystem.rename(nextPath, ownerPath);
  }

  async #prepare(workspaceId, executionId, plan, options) {
    let directory = null;
    try {
      await this.#assertNativeBackupAdmission(workspaceId, executionId, plan.source.id);
      await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId)));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const ownerPath = path.join(directory, '.owner.json');
      const backupName = nativeBackupName(workspaceId, plan.source.id, executionId);
      let owner = { version: 1, workspaceId, sourceId: plan.source.id, executionId, connectionId: plan.connection.id, connectionRevision: plan.connection.revision, backupName, ownership: null, reconciliation: null };
      await this.fileSystem.writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      const ownerId = stableDigest({ workspaceId, executionId });
      let lease = {
        version: 1,
        kind: SOURCE_LEASE_KIND,
        state: 'acquiring',
        ownerId,
        workspaceId,
        sourceId: plan.source.id,
        executionId,
        connectionId: plan.connection.id,
        backupName,
        ownership: null,
        acquiredAt: this.clock(),
        updatedAt: this.clock()
      };
      await options.onSourceLease(structuredClone(lease));
      const onOwnership = async (ownershipValue) => {
        const ownership = normalizeBackupOwnership(ownershipValue, backupName);
        const nextOwner = { ...owner, ownership };
        await this.#writeOwner(ownerPath, nextOwner);
        owner = nextOwner;
        lease = { ...lease, state: 'active', ownership, acquiredAt: ownership.acceptedAt || lease.acquiredAt, updatedAt: this.clock() };
        await options.onSourceLease(structuredClone(lease));
      };
      const result = await this.nativeController.createBackup({
        resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }),
        signal: options.signal,
        onOwnership
      }, { connection: plan.connectionConfig, name: backupName, type: 'full' });
      const databaseManifest = publicMetadata(plan, result);
      const bytes = Buffer.from(JSON.stringify(databaseManifest));
      if (bytes.length < 1 || bytes.length > MAX_METADATA_BYTES) throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_METADATA_INVALID', 'InfluxDB 3 Enterprise backup metadata exceeds the supported size.', { category: 'integrity' });
      return { directory, ownerPath, bytes, databaseManifest, onSourceLease: options.onSourceLease, lease: () => lease };
    } catch (error) {
      if (directory) await this.#reconcileDirectory(workspaceId, executionId, directory, { removeWhenProven: false }).catch(() => {});
      if (error instanceof InfluxDb3EnterpriseSourceReaderError) throw error;
      if (error instanceof DatabaseAdapterError) throw new InfluxDb3EnterpriseSourceReaderError(error.code, error.message, { category: error.category, retryable: error.retryable });
      if (/^INFLUXDB3_ENTERPRISE_[A-Z0-9_]+$/.test(String(error?.code || ''))) throw new InfluxDb3EnterpriseSourceReaderError(error.code, 'InfluxDB 3 Enterprise native backup preparation failed safely.', { category: error.category, retryable: error.retryable });
      throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_BACKUP_PREPARATION_FAILED', 'DeployerX could not prepare the InfluxDB 3 Enterprise native backup.', { retryable: true });
    }
  }

  async #assertNativeBackupAdmission(workspaceId, executionId, sourceId) {
    return this.controlDatabase.read((transaction) => {
      const run = transaction.get('run', workspaceId, executionId);
      const job = run ? transaction.get('backupJob', workspaceId, run.jobId) : null;
      if (!run || !job || job.sourceId !== sourceId || !ADMITTED_RUN_STATES.has(run.state)) {
        throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_BACKUP_ADMISSION_INVALID', 'The durable InfluxDB 3 Enterprise backup run is not active for this Source.', { category: 'conflict', retryable: true });
      }
      const points = transaction.list('recoveryPoint', workspaceId, { limit: MAX_RECOVERY_POINTS });
      if (points.length >= MAX_RECOVERY_POINTS) {
        throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_BACKUP_ADMISSION_LIMIT', 'The RecoveryPoint catalog is too large to prove native deletion exclusion.', { category: 'capacity', retryable: true });
      }
      if (points.some((point) => point.sourceId === sourceId && point.retention?.nativeMediaDeletionClaim !== undefined && point.retention?.nativeMediaDeletionClaim !== null)) {
        throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_NATIVE_MEDIA_DELETION_ACTIVE', 'A native media deletion operation currently owns this InfluxDB 3 Enterprise Source.', { category: 'conflict', retryable: true });
      }
      return true;
    });
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    if (typeof options.onSourceLease !== 'function') throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_SOURCE_LEASE_CALLBACK_REQUIRED', 'Durable InfluxDB 3 Enterprise Source lease persistence is required before native backup submission.', { category: 'configuration' });
    if ((options.backupMode || 'full') !== 'full' || options.requestedBackupMode === 'incremental') throw new InfluxDb3EnterpriseSourceReaderError('INFLUXDB3_ENTERPRISE_INCREMENTAL_WIRE_CONTRACT_UNAVAILABLE', 'InfluxDB 3 Enterprise incremental backup creation is disabled until the provider publishes an exact versioned HTTP request contract.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, options);
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    return {
      ...plan,
      manifest: {
        ...plan.manifest,
        workloadType: 'database',
        resumable: false,
        consistency: { achievedLevel: 'application', method: NATIVE_CONSISTENCY_METHOD, backupMethod: 'physical', backupMode: 'full', captureCoordinates: true, proven: true },
        database: prepared.databaseManifest,
        artifactPath: METADATA_PATH,
        artifactPaths: [METADATA_PATH],
        sizeBytes: prepared.bytes.length,
        externalNativeMedia: true
      },
      create: async function* createEnterpriseNativeMetadata() {
        yield {
          path: METADATA_PATH,
          type: 'file',
          metadata: { workload: 'database', artifactKind: 'metadata', externalNativeMedia: true, database: prepared.databaseManifest },
          content: (async function* content() { yield prepared.bytes; })()
        };
      }
    };
  }

  async release(workspaceId, executionId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(executionId, 'Backup execution ID', 200);
    const key = `${tenant}:${id}`;
    const promise = this.preparations.get(key);
    this.preparations.delete(key);
    if (!promise) return false;
    const prepared = await promise.catch(() => null);
    if (!prepared?.directory) return false;
    const owner = await this.#readOwner(prepared.directory);
    if (!this.#owns(owner, tenant, id)) return false;
    const lease = prepared.lease();
    const releasedAt = this.clock();
    await prepared.onSourceLease(structuredClone({ ...lease, state: 'released', releasedAt, releaseReason: 'repository-committed', updatedAt: releasedAt }));
    await this.fileSystem.rm(prepared.directory, { recursive: true, force: true });
    return true;
  }

  async #readOwner(directory) {
    return this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
  }

  #owns(owner, workspaceId, executionId) {
    return owner?.version === 1 && owner.workspaceId === workspaceId && owner.executionId === executionId;
  }

  async #reconcileDirectory(workspaceId, executionId, directory, options = {}) {
    let owner = await this.#readOwner(directory);
    if (!this.#owns(owner, workspaceId, executionId)) return { proven: false, removed: false, canceled: false, status: null };
    const expectedLease = options.expectedLease || null;
    const expectedOwnerId = stableDigest({ workspaceId, executionId });
    if (expectedLease && (expectedLease.kind !== SOURCE_LEASE_KIND || !['acquiring', 'active'].includes(expectedLease.state) || expectedLease.ownerId !== expectedOwnerId || expectedLease.workspaceId !== workspaceId || expectedLease.executionId !== executionId || expectedLease.sourceId !== owner.sourceId || expectedLease.connectionId !== owner.connectionId || expectedLease.backupName !== owner.backupName)) return { proven: false, removed: false, canceled: false, status: null };
    if (!owner.ownership) {
      if (expectedLease && (expectedLease.state !== 'acquiring' || expectedLease.ownership !== null)) return { proven: false, removed: false, canceled: false, status: null };
      let removed = false;
      if (options.removeWhenProven) {
        await this.fileSystem.rm(directory, { recursive: true, force: true });
        removed = true;
      }
      return { proven: true, removed, canceled: false, status: 'not-submitted', ownership: null };
    }
    let ownership;
    try { ownership = normalizeBackupOwnership(owner.ownership, owner.backupName); }
    catch { return { proven: false, removed: false, canceled: false, status: null }; }
    if (expectedLease?.state === 'active') {
      let leaseOwnership;
      try { leaseOwnership = normalizeBackupOwnership(expectedLease.ownership, owner.backupName); }
      catch { return { proven: false, removed: false, canceled: false, status: null }; }
      if (stableDigest(leaseOwnership) !== stableDigest(ownership)) return { proven: false, removed: false, canceled: false, status: null };
    } else if (expectedLease && expectedLease.ownership !== null) {
      return { proven: false, removed: false, canceled: false, status: null };
    }
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, owner.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID || connection.revision !== owner.connectionRevision || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) return { proven: false, removed: false, canceled: false, status: null };
    const secretRefIds = Array.isArray(connection.secretRefIds) ? connection.secretRefIds : [];
    if (secretRefIds.length !== 1) return { proven: false, removed: false, canceled: false, status: null };
    let config;
    try { config = this.adapter.normalizeConfig({ ...connection.endpoint, adminTokenSecretRefId: secretRefIds[0] }); }
    catch { return { proven: false, removed: false, canceled: false, status: null }; }
    const context = { resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }) };
    let status = null;
    let canceled = false;
    try {
      const current = await this.nativeController.getBackup(context, { connection: config, name: owner.backupName });
      status = current.backup.status;
      if (status === BACKUP_STATES.IN_PROGRESS) {
        await this.nativeController.cancelBackup(context, { connection: config, name: owner.backupName, ownership });
        owner = { ...owner, reconciliation: { cancellationAccepted: true, reconciledAt: this.clock() } };
        await this.#writeOwner(path.join(directory, '.owner.json'), owner);
        let after;
        try { after = await this.nativeController.getBackup(context, { connection: config, name: owner.backupName }); }
        catch (error) {
          if (error?.code !== 'INFLUXDB3_ENTERPRISE_BACKUP_NOT_FOUND') return { proven: false, removed: false, canceled: false, status };
          canceled = true;
          status = 'canceled';
        }
        if (after) {
          status = after.backup.status;
          if (status === BACKUP_STATES.IN_PROGRESS) return { proven: false, removed: false, canceled: false, status };
          if (![BACKUP_STATES.COMPLETED, BACKUP_STATES.FAILED].includes(status)) return { proven: false, removed: false, canceled: false, status };
        }
      } else if (![BACKUP_STATES.COMPLETED, BACKUP_STATES.FAILED].includes(status)) {
        return { proven: false, removed: false, canceled: false, status };
      }
    } catch (error) {
      if (!(error?.code === 'INFLUXDB3_ENTERPRISE_BACKUP_NOT_FOUND' && owner.reconciliation?.cancellationAccepted === true)) return { proven: false, removed: false, canceled: false, status };
      canceled = true;
      status = 'canceled';
    }
    let removed = false;
    if (options.removeWhenProven) {
      await this.fileSystem.rm(directory, { recursive: true, force: true });
      removed = true;
    }
    return { proven: true, removed, canceled, status, ownership };
  }

  async reconcileRun(workspaceId, run = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(run.id, 'Backup execution ID', 200);
    const prefix = preparationPrefix(tenant, executionId);
    const entries = await this.fileSystem.readdir(this.temporaryRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    const candidates = entries.slice(0, MAX_PREPARATION_DIRECTORIES).filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix));
    const lease = run.sourceLease || null;
    const leaseValid = !lease || (lease.kind === SOURCE_LEASE_KIND && ['acquiring', 'active'].includes(lease.state) && lease.workspaceId === tenant && lease.executionId === executionId);
    if (!leaseValid) return { applicable: candidates.length > 0 || lease?.kind === SOURCE_LEASE_KIND, proven: false, removedTemporaryDirectories: 0, canceledOwnedBackups: 0, preservedTerminalBackups: 0, nativeMediaDeleted: false, sourceLease: lease };
    let removed = 0;
    let canceled = 0;
    let preserved = 0;
    let proven = candidates.length > 0;
    let reconciledOwnership = null;
    for (const entry of candidates) {
      const result = await this.#reconcileDirectory(tenant, executionId, path.join(this.temporaryRoot, entry.name), { removeWhenProven: true, expectedLease: run.sourceLease || null });
      if (!result.proven) { proven = false; continue; }
      if (result.removed) removed += 1;
      if (result.canceled) canceled += 1;
      if ([BACKUP_STATES.COMPLETED, BACKUP_STATES.FAILED].includes(result.status)) preserved += 1;
      if (result.ownership) reconciledOwnership = result.ownership;
    }
    const releasedAt = this.clock();
    return {
      applicable: candidates.length > 0 || lease?.kind === SOURCE_LEASE_KIND,
      proven,
      removedTemporaryDirectories: removed,
      canceledOwnedBackups: canceled,
      preservedTerminalBackups: preserved,
      nativeMediaDeleted: false,
      sourceLease: proven && lease ? { ...lease, ownership: reconciledOwnership || lease.ownership, state: 'released', releasedAt, releaseReason: 'process-interrupted', updatedAt: releasedAt } : lease
    };
  }
}

module.exports = {
  InfluxDb3EnterpriseSourceReaderError,
  InfluxDb3EnterpriseSourceReaderService,
  MAX_METADATA_BYTES,
  METADATA_PATH,
  SOURCE_LEASE_KIND,
  nativeBackupName,
  preparationPrefix,
  publicMetadata
};
