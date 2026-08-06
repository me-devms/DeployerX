const {
  ADAPTER_ID: ENTERPRISE_ADAPTER_ID
} = require('./influxdb3-enterprise');
const {
  ADAPTER_ID: SSH_ADAPTER_ID
} = require('./ssh-connection');
const {
  connectionConfigFromRecord
} = require('./ssh-execution');
const {
  DEFAULT_MAX_TEST_AGE_MS,
  MAX_NODES,
  normalizeLegacyClusterStopBindings
} = require('./influxdb3-enterprise-legacy-stop-proof');

const ADAPTER_ID = 'deployerx.connection.influxdb3-enterprise-legacy-stop-binding';
const ADAPTER_VERSION = '1.0.0';
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const REQUIRED_SSH_CHECKS = Object.freeze(['host-key', 'authentication', 'linux-platform', 'sftp']);

class InfluxDb3EnterpriseLegacyStopBindingError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseLegacyStopBindingError';
    this.code = code;
    this.category = options.category || 'configuration';
    this.retryable = Boolean(options.retryable);
  }
}

function bindingError(code, safeMessage, options) {
  return new InfluxDb3EnterpriseLegacyStopBindingError(code, safeMessage, options);
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeId(value, label) {
  const id = requiredText(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) || id === '.' || id === '..') throw new TypeError(`${label} is invalid.`);
  return id;
}

function normalizeTimestamp(value, label) {
  const input = requiredText(value, label, 40);
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} is invalid.`);
  return parsed.toISOString();
}

function normalizeDigest(value, label) {
  const digest = requiredText(value, label, 80).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new TypeError(`${label} is invalid.`);
  return digest;
}

function normalizeSystemdUnit(value) {
  const unit = requiredText(value, 'InfluxDB 3 Enterprise systemd unit', 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/.test(unit) || unit.includes('..')) throw new TypeError('InfluxDB 3 Enterprise systemd unit is invalid.');
  return unit;
}

function exactObject(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${label} must be an object.`);
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown ${label} field: ${unknown[0]}.`);
  return input;
}

function normalizeEnrollmentNode(input) {
  exactObject(input, ['nodeId', 'sshConnectionId', 'systemdUnit'], 'InfluxDB 3 Enterprise legacy stop-binding node');
  return Object.freeze({
    nodeId: normalizeId(input.nodeId, 'InfluxDB 3 Enterprise node ID'),
    sshConnectionId: normalizeId(input.sshConnectionId, 'InfluxDB 3 Enterprise SSH connection ID'),
    systemdUnit: normalizeSystemdUnit(input.systemdUnit)
  });
}

function normalizeCreateInput(input) {
  exactObject(input, ['name', 'targetConnectionId', 'clusterId', 'nodes'], 'InfluxDB 3 Enterprise legacy stop-binding enrollment');
  if (!Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > MAX_NODES) throw new TypeError('InfluxDB 3 Enterprise legacy stop-binding enrollment requires one or more nodes.');
  const nodes = input.nodes.map(normalizeEnrollmentNode).sort((left, right) => left.nodeId.localeCompare(right.nodeId, 'en-US'));
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) throw new TypeError('InfluxDB 3 Enterprise legacy stop-binding enrollment contains duplicate node IDs.');
  if (new Set(nodes.map((node) => node.sshConnectionId)).size !== nodes.length) throw new TypeError('InfluxDB 3 Enterprise legacy stop-binding enrollment contains duplicate SSH connections.');
  return Object.freeze({
    name: requiredText(input.name, 'InfluxDB 3 Enterprise legacy stop-binding name', 200),
    targetConnectionId: normalizeId(input.targetConnectionId, 'InfluxDB 3 Enterprise target connection ID'),
    clusterId: normalizeId(input.clusterId, 'InfluxDB 3 Enterprise cluster ID'),
    nodes: Object.freeze(nodes)
  });
}

function normalizeStoredBinding(input) {
  exactObject(input, [
    'version', 'targetConnectionId', 'targetConnectionRevision', 'targetAdapterVersion', 'targetTestedAt',
    'targetDeploymentFingerprint', 'targetCapabilityFingerprint', 'targetNodeId', 'clusterId', 'nodes'
  ], 'persisted InfluxDB 3 Enterprise legacy stop binding');
  if (input.version !== 1) throw new TypeError('Persisted InfluxDB 3 Enterprise legacy stop-binding version is invalid.');
  const targetConnectionRevision = Number(input.targetConnectionRevision);
  if (!Number.isInteger(targetConnectionRevision) || targetConnectionRevision < 1) throw new TypeError('Persisted InfluxDB 3 Enterprise target connection revision is invalid.');
  const binding = normalizeLegacyClusterStopBindings([{
    targetConnectionId: input.targetConnectionId,
    clusterId: input.clusterId,
    nodes: input.nodes
  }])[0];
  const normalized = Object.freeze({
    version: 1,
    targetConnectionId: binding.targetConnectionId,
    targetConnectionRevision,
    targetAdapterVersion: requiredText(input.targetAdapterVersion, 'InfluxDB 3 Enterprise target adapter version', 40),
    targetTestedAt: normalizeTimestamp(input.targetTestedAt, 'InfluxDB 3 Enterprise target test timestamp'),
    targetDeploymentFingerprint: normalizeDigest(input.targetDeploymentFingerprint, 'InfluxDB 3 Enterprise target deployment fingerprint'),
    targetCapabilityFingerprint: normalizeDigest(input.targetCapabilityFingerprint, 'InfluxDB 3 Enterprise target capability fingerprint'),
    targetNodeId: normalizeId(input.targetNodeId, 'InfluxDB 3 Enterprise target node ID'),
    clusterId: binding.clusterId,
    nodes: binding.nodes
  });
  if (!normalized.nodes.some((node) => node.nodeId === normalized.targetNodeId)) throw new TypeError('Persisted InfluxDB 3 Enterprise legacy stop binding does not contain its tested compactor node.');
  return normalized;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicBinding(record, stored, deviceId) {
  return Object.freeze({
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    revision: record.revision,
    adapterId: record.adapterId,
    adapterVersion: record.adapterVersion,
    scope: record.scope,
    currentDevice: Array.isArray(record.workerAffinity) && record.workerAffinity.includes(`device:${deviceId}`),
    targetConnectionId: stored.targetConnectionId,
    clusterId: stored.clusterId,
    targetNodeId: stored.targetNodeId,
    nodes: Object.freeze(stored.nodes.map((node) => Object.freeze({
      nodeId: node.nodeId,
      sshConnectionId: node.sshConnectionId,
      systemdUnit: node.systemdUnit
    }))),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  });
}

class InfluxDb3EnterpriseLegacyStopBindingService {
  constructor({
    controlDatabase,
    deviceId,
    clock = () => new Date().toISOString(),
    maxTestAgeMs = DEFAULT_MAX_TEST_AGE_MS
  } = {}) {
    if (!controlDatabase || typeof controlDatabase.repository !== 'function' || typeof controlDatabase.transaction !== 'function') throw new TypeError('InfluxDB 3 Enterprise legacy stop-binding persistence is required.');
    const age = Number(maxTestAgeMs);
    if (!Number.isInteger(age) || age < 60 * 1000 || age > 30 * 24 * 60 * 60 * 1000) throw new TypeError('InfluxDB 3 Enterprise maximum SSH test age is invalid.');
    this.controlDatabase = controlDatabase;
    this.deviceId = normalizeId(deviceId, 'Device ID');
    this.clock = clock;
    this.maxTestAgeMs = age;
  }

  #now() {
    const timestamp = normalizeTimestamp(this.clock(), 'InfluxDB 3 Enterprise stop-binding timestamp');
    return { timestamp, milliseconds: new Date(timestamp).getTime() };
  }

  #assertCurrentDevice(connection, label, code) {
    if (connection?.scope !== 'device' || !Array.isArray(connection.workerAffinity) || connection.workerAffinity.length !== 1 || connection.workerAffinity[0] !== `device:${this.deviceId}`) {
      throw bindingError(code, `${label} does not belong exclusively to this device.`, { category: 'authorization' });
    }
  }

  #targetSnapshot(connection, clusterId) {
    if (!connection || connection.adapterId !== ENTERPRISE_ADAPTER_ID) {
      throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_TARGET_NOT_LEGACY', 'Choose a tested InfluxDB 3 Enterprise legacy target connection.');
    }
    this.#assertCurrentDevice(connection, 'The InfluxDB 3 Enterprise target connection', 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_FOREIGN_DEVICE');
    const identity = connection.lastTest?.endpointIdentity;
    const inventory = connection.influxdb3EnterpriseInventory;
    const inventoryNode = inventory?.node;
    let deploymentFingerprint;
    let capabilityFingerprint;
    let targetNodeId;
    let targetTestedAt;
    try {
      deploymentFingerprint = normalizeDigest(identity?.deploymentFingerprint, 'InfluxDB 3 Enterprise target deployment fingerprint');
      capabilityFingerprint = normalizeDigest(identity?.capabilityFingerprint, 'InfluxDB 3 Enterprise target capability fingerprint');
      targetNodeId = normalizeId(identity?.nodeId, 'InfluxDB 3 Enterprise target node ID');
      targetTestedAt = normalizeTimestamp(connection.lastTest?.testedAt, 'InfluxDB 3 Enterprise target test timestamp');
    } catch {
      throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_TARGET_NOT_LEGACY', 'Retest an exact legacy-engine InfluxDB 3 Enterprise compactor connection before enrollment.', { category: 'integrity', retryable: true });
    }
    const exactLegacyIdentity = connection.lastTest?.status === 'success'
      && connection.lastTest?.adapterId === ENTERPRISE_ADAPTER_ID
      && connection.lastTest?.adapterVersion === connection.adapterVersion
      && identity?.storageEngine === 'legacy-parquet'
      && identity?.legacyParquetEngine === true
      && identity?.compactorCapable === true
      && identity?.nativeBackupAvailable === false
      && identity?.clusterId === clusterId
      && connection.endpoint?.expectedClusterId === clusterId
      && connection.endpoint?.expectedStorageEngine === 'legacy-parquet'
      && connection.endpoint?.expectedDeploymentFingerprint === deploymentFingerprint
      && connection.endpoint?.expectedCapabilityFingerprint === capabilityFingerprint
      && connection.trust?.fingerprint === deploymentFingerprint
      && connection.trust?.capabilityFingerprint === capabilityFingerprint
      && inventory?.clusterId === clusterId
      && inventory?.deploymentFingerprint === deploymentFingerprint
      && inventory?.capabilityFingerprint === capabilityFingerprint
      && inventoryNode?.id === targetNodeId
      && inventoryNode?.storageEngine === 'legacy-parquet'
      && inventoryNode?.legacyParquetEngine === true
      && inventoryNode?.compactorCapable === true
      && inventoryNode?.nativeBackupAvailable === false;
    if (!exactLegacyIdentity) {
      throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_TARGET_NOT_LEGACY', 'Retest an exact legacy-engine InfluxDB 3 Enterprise compactor connection before enrollment.', { category: 'integrity', retryable: true });
    }
    return Object.freeze({
      targetConnectionId: normalizeId(connection.id, 'InfluxDB 3 Enterprise target connection ID'),
      targetConnectionRevision: connection.revision,
      targetAdapterVersion: requiredText(connection.adapterVersion, 'InfluxDB 3 Enterprise target adapter version', 40),
      targetTestedAt,
      targetDeploymentFingerprint: deploymentFingerprint,
      targetCapabilityFingerprint: capabilityFingerprint,
      targetNodeId,
      clusterId
    });
  }

  #sshSnapshot(connection, requested, now) {
    if (!connection || connection.adapterId !== SSH_ADAPTER_ID) {
      throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_SSH_MISSING', 'A selected SSH connection is missing.', { category: 'configuration' });
    }
    this.#assertCurrentDevice(connection, 'A selected SSH connection', 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_SSH_FOREIGN_DEVICE');
    const test = connection.lastTest;
    const identity = test?.endpointIdentity;
    const checks = Array.isArray(test?.checks) ? test.checks : [];
    const checkStates = new Map(checks.map((check) => [check?.id, check?.status]));
    const testedAt = Date.parse(test?.testedAt);
    const diagnosticFingerprint = String(test?.diagnosticFingerprint || '').toLowerCase();
    const hostKeyFingerprint = String(connection.trust?.fingerprint || '').replace(/=+$/, '');
    const hostKeyAlgorithm = String(connection.trust?.algorithm || '');
    const exactTest = Number.isInteger(connection.revision)
      && connection.revision >= 1
      && test?.status === 'success'
      && test?.adapterId === SSH_ADAPTER_ID
      && test?.adapterVersion === connection.adapterVersion
      && /^[0-9a-f]{16}$/.test(diagnosticFingerprint)
      && Number.isFinite(testedAt)
      && new Date(testedAt).toISOString() === test.testedAt
      && testedAt <= now.milliseconds + MAX_CLOCK_SKEW_MS
      && now.milliseconds - testedAt <= this.maxTestAgeMs
      && test?.remotePlatform?.os === 'linux'
      && checks.length === new Set(checks.map((check) => check?.id)).size
      && REQUIRED_SSH_CHECKS.every((check) => checkStates.get(check) === 'pass')
      && /^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKeyFingerprint)
      && /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,79}$/.test(hostKeyAlgorithm)
      && identity?.host === connection.endpoint?.host
      && identity?.port === connection.endpoint?.port
      && identity?.hostKeyFingerprint === hostKeyFingerprint
      && identity?.hostKeyAlgorithm === hostKeyAlgorithm
      && Array.isArray(connection.secretRefIds)
      && [1, 2].includes(connection.secretRefIds.length)
      && new Set(connection.secretRefIds).size === connection.secretRefIds.length;
    try { connectionConfigFromRecord(connection); } catch {
      throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_SSH_STALE', 'A selected SSH connection is malformed or no longer exactly tested.', { category: 'integrity', retryable: true });
    }
    if (!exactTest) {
      throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_SSH_STALE', 'Retest every selected Linux SSH connection before enrollment.', { category: 'integrity', retryable: true });
    }
    return Object.freeze({
      nodeId: requested.nodeId,
      sshConnectionId: connection.id,
      sshConnectionRevision: connection.revision,
      sshTestedAt: test.testedAt,
      sshDiagnosticFingerprint: diagnosticFingerprint,
      sshHostKeyFingerprint: hostKeyFingerprint,
      sshHostKeyAlgorithm: hostKeyAlgorithm,
      systemdUnit: requested.systemdUnit
    });
  }

  #decodeRecord(record) {
    if (!record || record.adapterId !== ADAPTER_ID) return null;
    this.#assertCurrentDevice(record, 'The InfluxDB 3 Enterprise legacy stop binding', 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_FOREIGN_DEVICE');
    if (record.kind !== 'database' || record.adapterVersion !== ADAPTER_VERSION || !Array.isArray(record.secretRefIds) || record.secretRefIds.length || record.lastTest !== null || record.trust?.mode !== 'exact-tested-identities') {
      throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_INVALID', 'A persisted InfluxDB 3 Enterprise legacy stop binding is invalid.', { category: 'integrity' });
    }
    exactObject(record.endpoint, ['targetConnectionId', 'clusterId'], 'persisted InfluxDB 3 Enterprise legacy stop-binding endpoint');
    const stored = normalizeStoredBinding(record.legacyStopBinding);
    if (record.endpoint.targetConnectionId !== stored.targetConnectionId || record.endpoint.clusterId !== stored.clusterId) {
      throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_INVALID', 'A persisted InfluxDB 3 Enterprise legacy stop binding has conflicting identity.', { category: 'integrity' });
    }
    return stored;
  }

  async list(workspaceId) {
    const tenant = normalizeId(workspaceId, 'Workspace ID');
    const records = await this.controlDatabase.repository('connection').list(tenant, { includeDeleted: false, limit: 1000 });
    const output = [];
    for (const record of records) {
      if (record.adapterId !== ADAPTER_ID || !Array.isArray(record.workerAffinity) || !record.workerAffinity.includes(`device:${this.deviceId}`)) continue;
      const stored = this.#decodeRecord(record);
      output.push(publicBinding(record, stored, this.deviceId));
    }
    return Object.freeze(output);
  }

  async get(workspaceId, bindingId) {
    const tenant = normalizeId(workspaceId, 'Workspace ID');
    const id = normalizeId(bindingId, 'InfluxDB 3 Enterprise legacy stop-binding ID');
    const record = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!record || record.adapterId !== ADAPTER_ID) return null;
    return publicBinding(record, this.#decodeRecord(record), this.deviceId);
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = normalizeId(workspaceId, 'Workspace ID');
    const actor = normalizeId(actorId, 'Actor ID');
    const enrollment = normalizeCreateInput(input);
    const now = this.#now();
    const created = await this.controlDatabase.transaction((transaction) => {
      const existing = transaction.list('connection', tenant, { includeDeleted: false, limit: 1000 })
        .filter((record) => record.adapterId === ADAPTER_ID);
      for (const record of existing) {
        const stored = this.#decodeRecord(record);
        if (stored.targetConnectionId === enrollment.targetConnectionId) {
          throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_DUPLICATE', 'This InfluxDB 3 Enterprise target already has an active cluster stop binding.', { category: 'conflict' });
        }
      }
      const targetConnection = transaction.get('connection', tenant, enrollment.targetConnectionId);
      const target = this.#targetSnapshot(targetConnection, enrollment.clusterId);
      const nodes = enrollment.nodes.map((node) => this.#sshSnapshot(transaction.get('connection', tenant, node.sshConnectionId), node, now));
      if (!nodes.some((node) => node.nodeId === target.targetNodeId)) {
        throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_NODE_MISMATCH', 'The enrolled node set must include the tested Enterprise compactor node.', { category: 'integrity' });
      }
      const normalized = normalizeLegacyClusterStopBindings([{
        targetConnectionId: target.targetConnectionId,
        clusterId: target.clusterId,
        nodes
      }])[0];
      const stored = Object.freeze({ ...target, version: 1, nodes: normalized.nodes });
      return transaction.create('connection', {
        workspaceId: tenant,
        actorId: actor,
        name: enrollment.name,
        kind: 'database',
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        scope: 'device',
        endpoint: { targetConnectionId: target.targetConnectionId, clusterId: target.clusterId },
        secretRefIds: [],
        trust: { mode: 'exact-tested-identities' },
        workerAffinity: [`device:${this.deviceId}`],
        lastTest: null,
        legacyStopBinding: stored
      });
    });
    return publicBinding(created, this.#decodeRecord(created), this.deviceId);
  }

  async remove(workspaceId, bindingId, actorId = 'system', input = {}) {
    const tenant = normalizeId(workspaceId, 'Workspace ID');
    const id = normalizeId(bindingId, 'InfluxDB 3 Enterprise legacy stop-binding ID');
    const actor = normalizeId(actorId, 'Actor ID');
    exactObject(input, ['expectedRevision'], 'InfluxDB 3 Enterprise legacy stop-binding removal');
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_NOT_FOUND', 'The InfluxDB 3 Enterprise legacy stop binding was not found.', { category: 'not-found' });
    const stored = this.#decodeRecord(current);
    const expectedRevision = input.expectedRevision === undefined ? current.revision : Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('InfluxDB 3 Enterprise legacy stop-binding revision is invalid.');
    const removed = await this.controlDatabase.repository('connection').softDelete(tenant, id, { expectedRevision, actorId: actor });
    return publicBinding(removed, stored, this.deviceId);
  }

  async resolveBindings(workspaceId) {
    const tenant = normalizeId(workspaceId, 'Workspace ID');
    const now = this.#now();
    const records = (await this.controlDatabase.repository('connection').list(tenant, { includeDeleted: false, limit: 1000 }))
      .filter((record) => record.adapterId === ADAPTER_ID && Array.isArray(record.workerAffinity) && record.workerAffinity.includes(`device:${this.deviceId}`));
    if (!records.length) return Object.freeze([]);
    const targetIds = new Set();
    const resolved = [];
    for (const record of records) {
      const stored = this.#decodeRecord(record);
      if (targetIds.has(stored.targetConnectionId)) throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_DUPLICATE', 'Multiple active cluster stop bindings target the same InfluxDB 3 Enterprise connection.', { category: 'integrity' });
      targetIds.add(stored.targetConnectionId);
      const targetConnection = await this.controlDatabase.repository('connection').get(tenant, stored.targetConnectionId);
      let currentTarget;
      try { currentTarget = this.#targetSnapshot(targetConnection, stored.clusterId); }
      catch (error) {
        if (error instanceof InfluxDb3EnterpriseLegacyStopBindingError) {
          throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_TARGET_STALE', 'The enrolled InfluxDB 3 Enterprise target identity is stale; retest and re-enroll it.', { category: 'integrity', retryable: true });
        }
        throw error;
      }
      const pinnedTarget = {
        targetConnectionId: stored.targetConnectionId,
        targetConnectionRevision: stored.targetConnectionRevision,
        targetAdapterVersion: stored.targetAdapterVersion,
        targetTestedAt: stored.targetTestedAt,
        targetDeploymentFingerprint: stored.targetDeploymentFingerprint,
        targetCapabilityFingerprint: stored.targetCapabilityFingerprint,
        targetNodeId: stored.targetNodeId,
        clusterId: stored.clusterId
      };
      if (!sameValue(currentTarget, pinnedTarget)) {
        throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_TARGET_STALE', 'The enrolled InfluxDB 3 Enterprise target identity changed; retest and re-enroll it.', { category: 'integrity', retryable: true });
      }
      const nodes = [];
      for (const pinnedNode of stored.nodes) {
        const connection = await this.controlDatabase.repository('connection').get(tenant, pinnedNode.sshConnectionId);
        const currentNode = this.#sshSnapshot(connection, pinnedNode, now);
        if (!sameValue(currentNode, pinnedNode)) {
          throw bindingError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_SSH_STALE', 'An enrolled SSH identity changed; retest and re-enroll every affected node.', { category: 'integrity', retryable: true });
        }
        nodes.push(currentNode);
      }
      resolved.push({ targetConnectionId: stored.targetConnectionId, clusterId: stored.clusterId, nodes });
    }
    return normalizeLegacyClusterStopBindings(resolved);
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  InfluxDb3EnterpriseLegacyStopBindingError,
  InfluxDb3EnterpriseLegacyStopBindingService,
  normalizeCreateInput,
  normalizeStoredBinding
};
