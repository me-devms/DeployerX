const {
  ADAPTER_ID,
  NATIVE_CONSISTENCY_METHOD,
  normalizeNativeBackupExecution
} = require('./influxdb3-enterprise');
const {
  exactLegacyConsistency,
  exactWholeClusterSelector,
  normalizeLegacySourceExecution,
  normalizeLegacySourceStorage
} = require('./influxdb3-enterprise-legacy-source-reader');

const NATIVE_TIER = 'upgraded-native';
const LEGACY_TIER = 'legacy-filesystem';

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function exactNativeConsistency(consistency) {
  return consistency?.backupMethod === 'physical'
    && consistency.backupMode === 'full'
    && ['auto', NATIVE_CONSISTENCY_METHOD].includes(consistency.method)
    && consistency.requestedLevel === 'application'
    && consistency.captureCoordinates === true
    && consistency.allowDowngrade !== true;
}

function influxDb3EnterpriseSourceReadiness(source, connection, deviceId) {
  try {
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || source.enabled !== true) throw new TypeError('The InfluxDB 3 Enterprise Source is disabled or unavailable.');
    if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success') throw new TypeError('Retest the InfluxDB 3 Enterprise connection.');
    if (!(connection.workerAffinity || []).includes(`device:${requiredText(deviceId, 'Device ID')}`)) throw new TypeError('The InfluxDB 3 Enterprise Source belongs to another device.');
    if (!exactWholeClusterSelector(source.selector)) throw new TypeError('Re-enroll exact whole-cluster selection.');
    const identity = connection.lastTest.endpointIdentity;
    const commonPinsMatch = connection.trust?.fingerprint === identity?.deploymentFingerprint
      && connection.trust?.capabilityFingerprint === identity?.capabilityFingerprint
      && connection.endpoint?.expectedDeploymentFingerprint === identity?.deploymentFingerprint
      && connection.endpoint?.expectedCapabilityFingerprint === identity?.capabilityFingerprint;
    if (!commonPinsMatch) throw new TypeError('Retest the InfluxDB 3 Enterprise identity.');
    if (source.physicalExecution?.tier === NATIVE_TIER) {
      const execution = normalizeNativeBackupExecution(source.physicalExecution);
      const sameIdentity = connection.revision === execution.connectionRevision
        && identity?.storageEngine === 'upgraded'
        && identity?.compactorCapable === true
        && identity?.nativeBackupAvailable === true
        && identity?.version === execution.productVersion
        && identity?.clusterId === execution.clusterId
        && identity?.nodeId === execution.nodeId
        && identity?.nodeCatalogId === execution.nodeCatalogId
        && identity?.instanceId === execution.instanceId
        && identity?.roleFingerprint === execution.roleFingerprint
        && identity?.deploymentFingerprint === execution.deploymentFingerprint
        && identity?.capabilityFingerprint === execution.capabilityFingerprint;
      if (!sameIdentity || !exactNativeConsistency(source.consistency)) throw new TypeError('Re-enroll the exact upgraded-engine native backup binding.');
    } else if (source.physicalExecution?.tier === LEGACY_TIER) {
      const execution = normalizeLegacySourceExecution(source.physicalExecution);
      normalizeLegacySourceStorage(source.legacyFilesystem, source.physicalExecution);
      const sameIdentity = connection.revision === execution.connectionRevision
        && identity?.storageEngine === 'legacy-parquet'
        && identity?.legacyParquetEngine === true
        && identity?.compactorCapable === true
        && identity?.clusterId === execution.clusterId
        && identity?.nodeId === execution.compactorNodeId
        && identity?.deploymentFingerprint === connection.trust.fingerprint
        && identity?.capabilityFingerprint === connection.trust.capabilityFingerprint;
      if (!sameIdentity || !exactLegacyConsistency(source.consistency, execution)) throw new TypeError('Re-enroll the exact legacy filesystem backup binding.');
    } else throw new TypeError('Choose a supported InfluxDB 3 Enterprise execution tier.');
    return { ready: true, reasonCode: null, message: 'Ready' };
  } catch {
    return { ready: false, reasonCode: 'INFLUXDB3_ENTERPRISE_SOURCE_BINDING_CHANGED', message: 'Retest and re-save the Source because its InfluxDB 3 Enterprise tier, identity, capability, or storage binding changed.' };
  }
}

class InfluxDb3EnterpriseSourceReaderRouter {
  constructor({ controlDatabase, nativeReader, legacyReader } = {}) {
    if (!controlDatabase || !nativeReader || !legacyReader) throw new TypeError('InfluxDB 3 Enterprise Source router dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.readers = new Map([
      [NATIVE_TIER, nativeReader],
      [LEGACY_TIER, legacyReader]
    ]);
    this.executionTiers = new Map();
  }

  #executionKey(workspaceId, executionId) {
    return `${workspaceId}:${executionId}`;
  }

  #readerForTier(tier) {
    const reader = this.readers.get(tier);
    if (!reader) throw new TypeError('The InfluxDB 3 Enterprise Source execution tier is unsupported.');
    return reader;
  }

  async #sourceReader(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const id = requiredText(sourceId, 'Source ID');
    const source = await this.controlDatabase.repository('source').get(tenant, id);
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || source.enabled !== true) throw new Error('The InfluxDB 3 Enterprise Source is unavailable.');
    const tier = source.physicalExecution?.tier;
    return { reader: this.#readerForTier(tier), source, tenant, tier };
  }

  async plan(workspaceId, sourceId) {
    const selected = await this.#sourceReader(workspaceId, sourceId);
    return selected.reader.plan(selected.tenant, sourceId);
  }

  async files(workspaceId, sourceId, options = {}) {
    const selected = await this.#sourceReader(workspaceId, sourceId);
    const executionId = requiredText(options.executionId, 'Backup execution ID');
    this.executionTiers.set(this.#executionKey(selected.tenant, executionId), selected.tier);
    return selected.reader.files(selected.tenant, sourceId, options);
  }

  async release(workspaceId, executionId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const id = requiredText(executionId, 'Backup execution ID');
    const key = this.#executionKey(tenant, id);
    const tier = this.executionTiers.get(key);
    this.executionTiers.delete(key);
    if (tier) return this.#readerForTier(tier).release?.(tenant, id);
    await Promise.all([...this.readers.values()].map((reader) => reader.release?.(tenant, id)));
    return undefined;
  }

  async reconcileRun(workspaceId, run = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const source = run?.configSnapshot?.source;
    if (source?.adapterId !== ADAPTER_ID) return { applicable: false, proven: true, sourceLease: run?.sourceLease || null };
    const reader = this.readers.get(source.physicalExecution?.tier);
    if (!reader?.reconcileRun) return { applicable: true, proven: false, sourceLease: run?.sourceLease || null };
    return reader.reconcileRun(tenant, run);
  }
}

module.exports = {
  InfluxDb3EnterpriseSourceReaderRouter,
  LEGACY_TIER,
  NATIVE_TIER,
  influxDb3EnterpriseSourceReadiness
};
