const crypto = require('crypto');
const {
  ADAPTER_ID: SSH_ADAPTER_ID
} = require('./ssh-connection');
const {
  commandFromArgs,
  connectionConfigFromRecord,
  openSshExecutionSession
} = require('./ssh-execution');

const DEFAULT_MAX_TEST_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_NODES = 1000;
const SYSTEMD_OUTPUT_LIMIT_BYTES = 512;
const SYSTEMD_PROPERTIES = Object.freeze(['ActiveState', 'SubState', 'MainPID']);

class InfluxDb3EnterpriseLegacyStopProofError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseLegacyStopProofError';
    this.code = code;
    this.category = options.category || 'integrity';
    this.retryable = Boolean(options.retryable);
  }
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

function normalizeSystemdUnit(value) {
  const unit = requiredText(value, 'InfluxDB 3 Enterprise systemd unit', 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/.test(unit) || unit.includes('..')) throw new TypeError('InfluxDB 3 Enterprise systemd unit is invalid.');
  return unit;
}

function normalizeNodeBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise node stop binding must be an object.');
  const allowed = [
    'nodeId', 'sshConnectionId', 'sshConnectionRevision', 'sshTestedAt',
    'sshDiagnosticFingerprint', 'sshHostKeyFingerprint', 'sshHostKeyAlgorithm', 'systemdUnit'
  ];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Enterprise node stop-binding field: ${unknown[0]}.`);
  const revision = Number(input.sshConnectionRevision);
  if (!Number.isInteger(revision) || revision < 1) throw new TypeError('InfluxDB 3 Enterprise SSH connection revision is invalid.');
  const diagnosticFingerprint = requiredText(input.sshDiagnosticFingerprint, 'InfluxDB 3 Enterprise SSH diagnostic fingerprint', 32).toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(diagnosticFingerprint)) throw new TypeError('InfluxDB 3 Enterprise SSH diagnostic fingerprint is invalid.');
  const hostKeyFingerprint = requiredText(input.sshHostKeyFingerprint, 'InfluxDB 3 Enterprise SSH host-key fingerprint', 80).replace(/=+$/, '');
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKeyFingerprint)) throw new TypeError('InfluxDB 3 Enterprise SSH host-key fingerprint is invalid.');
  const hostKeyAlgorithm = requiredText(input.sshHostKeyAlgorithm, 'InfluxDB 3 Enterprise SSH host-key algorithm', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9@._+-]{0,79}$/.test(hostKeyAlgorithm)) throw new TypeError('InfluxDB 3 Enterprise SSH host-key algorithm is invalid.');
  return Object.freeze({
    nodeId: normalizeId(input.nodeId, 'InfluxDB 3 Enterprise node ID'),
    sshConnectionId: normalizeId(input.sshConnectionId, 'InfluxDB 3 Enterprise SSH connection ID'),
    sshConnectionRevision: revision,
    sshTestedAt: normalizeTimestamp(input.sshTestedAt, 'InfluxDB 3 Enterprise SSH test timestamp'),
    sshDiagnosticFingerprint: diagnosticFingerprint,
    sshHostKeyFingerprint: hostKeyFingerprint,
    sshHostKeyAlgorithm: hostKeyAlgorithm,
    systemdUnit: normalizeSystemdUnit(input.systemdUnit)
  });
}

function normalizeClusterBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise cluster stop binding must be an object.');
  const allowed = ['targetConnectionId', 'clusterId', 'nodes'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Enterprise cluster stop-binding field: ${unknown[0]}.`);
  if (!Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > MAX_NODES) throw new TypeError('InfluxDB 3 Enterprise cluster stop binding requires one or more nodes.');
  const nodes = input.nodes.map(normalizeNodeBinding).sort((left, right) => left.nodeId.localeCompare(right.nodeId, 'en-US'));
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) throw new TypeError('InfluxDB 3 Enterprise cluster stop binding contains duplicate node IDs.');
  if (new Set(nodes.map((node) => node.sshConnectionId)).size !== nodes.length) throw new TypeError('InfluxDB 3 Enterprise cluster stop binding contains duplicate SSH bindings.');
  return Object.freeze({
    targetConnectionId: normalizeId(input.targetConnectionId, 'InfluxDB 3 Enterprise target connection ID'),
    clusterId: normalizeId(input.clusterId, 'InfluxDB 3 Enterprise cluster ID'),
    nodes: Object.freeze(nodes)
  });
}

function normalizeLegacyClusterStopBindings(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_NODES) throw new TypeError('InfluxDB 3 Enterprise cluster stop bindings must be a non-empty array.');
  const bindings = input.map(normalizeClusterBinding);
  if (new Set(bindings.map((binding) => binding.targetConnectionId)).size !== bindings.length) throw new TypeError('InfluxDB 3 Enterprise cluster stop bindings contain duplicate target bindings.');
  return Object.freeze(bindings);
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function stopProofError(code, safeMessage, options) {
  return new InfluxDb3EnterpriseLegacyStopProofError(code, safeMessage, options);
}

function canceledError() {
  return stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_CANCELED', 'InfluxDB 3 Enterprise cluster stop verification was canceled.', { category: 'canceled' });
}

function assertNotCanceled(signal) {
  if (signal?.aborted) throw canceledError();
}

function parseSystemdShow(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > SYSTEMD_OUTPUT_LIMIT_BYTES || /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(output)) {
    throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS', 'A node returned malformed systemd service state.', { category: 'integrity' });
  }
  const normalized = output.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const lines = normalized ? normalized.split('\n') : [];
  const values = new Map();
  for (const line of lines) {
    const match = /^([A-Za-z]+)=([^\r\n]*)$/.exec(line);
    if (!match || !SYSTEMD_PROPERTIES.includes(match[1]) || values.has(match[1])) {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS', 'A node returned ambiguous systemd service state.', { category: 'integrity' });
    }
    values.set(match[1], match[2]);
  }
  if (values.size !== SYSTEMD_PROPERTIES.length || !SYSTEMD_PROPERTIES.every((property) => values.has(property)) || !/^(?:0|[1-9]\d*)$/.test(values.get('MainPID'))) {
    throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS', 'A node returned incomplete systemd service state.', { category: 'integrity' });
  }
  const mainPid = Number(values.get('MainPID'));
  if (!Number.isSafeInteger(mainPid) || mainPid < 0) throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS', 'A node returned malformed systemd process state.', { category: 'integrity' });
  return Object.freeze({ activeState: values.get('ActiveState'), subState: values.get('SubState'), mainPid });
}

function criticalConnectionDigest(connection) {
  return stableDigest({
    id: connection.id,
    revision: connection.revision,
    adapterId: connection.adapterId,
    adapterVersion: connection.adapterVersion,
    scope: connection.scope,
    endpoint: connection.endpoint,
    secretRefIds: connection.secretRefIds,
    trust: connection.trust,
    workerAffinity: connection.workerAffinity,
    lastTest: connection.lastTest
  });
}

function normalizeProofKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new TypeError('InfluxDB 3 Enterprise stop-proof authentication key is invalid.');
  const key = Buffer.from(value);
  if (key.length < 32 || key.length > 1024) throw new TypeError('InfluxDB 3 Enterprise stop-proof authentication key is invalid.');
  return key;
}

function proofPayload(proof) {
  return {
    stopped: proof?.stopped,
    nodes: proof?.nodes,
    issuedAt: proof?.issuedAt
  };
}

class InfluxDb3EnterpriseLegacyStopProofService {
  constructor({
    controlDatabase,
    secretStore,
    deviceId,
    bindings,
    resolveBindings,
    resolveProofKey,
    proofKey,
    sessionFactory = openSshExecutionSession,
    clock = () => new Date().toISOString(),
    maxTestAgeMs = DEFAULT_MAX_TEST_AGE_MS
  } = {}) {
    if (!controlDatabase || !secretStore || typeof sessionFactory !== 'function') throw new TypeError('InfluxDB 3 Enterprise stop-proof dependencies are required.');
    const hasStaticBindings = bindings !== undefined;
    const hasBindingResolver = typeof resolveBindings === 'function';
    if (hasStaticBindings === hasBindingResolver) throw new TypeError('Provide exactly one InfluxDB 3 Enterprise stop-binding source.');
    if ((typeof resolveProofKey === 'function') === (proofKey !== undefined)) throw new TypeError('Provide exactly one InfluxDB 3 Enterprise stop-proof key source.');
    const age = Number(maxTestAgeMs);
    if (!Number.isInteger(age) || age < 60 * 1000 || age > 30 * 24 * 60 * 60 * 1000) throw new TypeError('InfluxDB 3 Enterprise maximum SSH test age is invalid.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = normalizeId(deviceId, 'Device ID');
    this.bindings = hasStaticBindings ? normalizeLegacyClusterStopBindings(bindings) : null;
    this.resolveBindings = hasBindingResolver ? resolveBindings : null;
    this.resolveProofKey = typeof resolveProofKey === 'function' ? resolveProofKey : async () => proofKey;
    this.sessionFactory = sessionFactory;
    this.clock = clock;
    this.maxTestAgeMs = age;
  }

  #now() {
    let timestamp;
    try { timestamp = normalizeTimestamp(this.clock(), 'InfluxDB 3 Enterprise stop-proof timestamp'); } catch {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_CLOCK_INVALID', 'The local clock could not authenticate cluster stop state.', { category: 'integrity' });
    }
    return { timestamp, milliseconds: new Date(timestamp).getTime() };
  }

  async #authenticateProof(workspaceId, targetConnectionId, proof) {
    let key;
    try {
      key = normalizeProofKey(await this.resolveProofKey({ workspaceId, targetConnectionId }));
      return `hmac-sha256:${crypto.createHmac('sha256', key).update(JSON.stringify(proofPayload(proof))).digest('hex')}`;
    } catch (error) {
      if (error instanceof InfluxDb3EnterpriseLegacyStopProofError) throw error;
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_AUTHENTICATION_FAILED', 'Cluster stop state could not be authenticated.', { category: 'integrity' });
    } finally { key?.fill(0); }
  }

  async #currentBindings(workspaceId) {
    if (this.bindings) return this.bindings;
    let resolved;
    try { resolved = await this.resolveBindings(workspaceId); } catch {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_INVALID', 'Enrolled cluster stop bindings could not be resolved.', { category: 'configuration' });
    }
    if (Array.isArray(resolved) && resolved.length === 0) return Object.freeze([]);
    try { return normalizeLegacyClusterStopBindings(resolved); } catch {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_INVALID', 'Enrolled cluster stop bindings are invalid.', { category: 'integrity' });
    }
  }

  #selectBinding(request, bindings) {
    let clusterId;
    let targetConnectionId = null;
    try {
      clusterId = normalizeId(request?.clusterId, 'InfluxDB 3 Enterprise cluster ID');
      if (request?.targetConnectionId !== undefined && request?.targetConnectionId !== null && request?.targetConnectionId !== '') targetConnectionId = normalizeId(request.targetConnectionId, 'InfluxDB 3 Enterprise target connection ID');
    } catch {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH', 'The requested cluster does not match an enrolled stop binding.', { category: 'configuration' });
    }
    const matches = targetConnectionId
      ? bindings.filter((binding) => binding.targetConnectionId === targetConnectionId)
      : bindings.filter((binding) => binding.clusterId === clusterId);
    if (!matches.length) throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISSING', 'No exact cluster stop binding is enrolled.', { category: 'configuration' });
    if (matches.length !== 1) throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_AMBIGUOUS', 'The cluster stop binding is ambiguous.', { category: 'configuration' });
    const binding = matches[0];
    if (binding.clusterId !== clusterId) throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH', 'The requested cluster does not match the enrolled stop binding.', { category: 'configuration' });
    if (!Array.isArray(request?.nodeIds) || !request.nodeIds.length || request.nodeIds.length > MAX_NODES) throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH', 'The requested nodes do not match the enrolled stop binding.', { category: 'configuration' });
    let requestedNodeIds;
    try { requestedNodeIds = request.nodeIds.map((nodeId) => normalizeId(nodeId, 'InfluxDB 3 Enterprise node ID')).sort((left, right) => left.localeCompare(right, 'en-US')); } catch {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH', 'The requested nodes do not match the enrolled stop binding.', { category: 'configuration' });
    }
    const configuredNodeIds = binding.nodes.map((node) => node.nodeId);
    if (new Set(requestedNodeIds).size !== requestedNodeIds.length || requestedNodeIds.length !== configuredNodeIds.length || requestedNodeIds.some((nodeId, index) => nodeId !== configuredNodeIds[index])) {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH', 'The requested nodes do not exactly match the enrolled stop binding.', { category: 'configuration' });
    }
    return binding;
  }

  async #loadConnection(workspaceId, node, now) {
    let connection;
    try { connection = await this.controlDatabase.repository('connection').get(workspaceId, node.sshConnectionId); } catch {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_UNAVAILABLE', 'A bound SSH connection could not be loaded.', { category: 'connectivity', retryable: true });
    }
    if (!connection) throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_MISSING', 'A bound SSH connection is missing.', { category: 'configuration' });
    if (connection.adapterId !== SSH_ADAPTER_ID || connection.scope !== 'device' || !Array.isArray(connection.workerAffinity) || !connection.workerAffinity.includes(`device:${this.deviceId}`)) {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_FOREIGN_DEVICE', 'A bound SSH connection is not a current-device SSH identity.', { category: 'authorization' });
    }
    const test = connection.lastTest;
    const identity = test?.endpointIdentity;
    const checks = new Map(Array.isArray(test?.checks) ? test.checks.map((check) => [check?.id, check?.status]) : []);
    const testedAt = Date.parse(test?.testedAt);
    const exactTest = connection.revision === node.sshConnectionRevision
      && test?.status === 'success'
      && test?.adapterId === SSH_ADAPTER_ID
      && test?.adapterVersion === connection.adapterVersion
      && test?.diagnosticFingerprint === node.sshDiagnosticFingerprint
      && test?.testedAt === node.sshTestedAt
      && Number.isFinite(testedAt)
      && testedAt <= now.milliseconds + MAX_CLOCK_SKEW_MS
      && now.milliseconds - testedAt <= this.maxTestAgeMs
      && test?.remotePlatform?.os === 'linux'
      && ['host-key', 'authentication', 'linux-platform', 'sftp'].every((check) => checks.get(check) === 'pass')
      && connection.trust?.fingerprint === node.sshHostKeyFingerprint
      && connection.trust?.algorithm === node.sshHostKeyAlgorithm
      && identity?.host === connection.endpoint?.host
      && identity?.port === connection.endpoint?.port
      && identity?.hostKeyFingerprint === node.sshHostKeyFingerprint
      && identity?.hostKeyAlgorithm === node.sshHostKeyAlgorithm;
    if (!exactTest) throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_STALE', 'A bound SSH identity is stale or no longer exactly tested.', { category: 'integrity', retryable: true });
    if (!Array.isArray(connection.secretRefIds) || ![1, 2].includes(connection.secretRefIds.length) || new Set(connection.secretRefIds).size !== connection.secretRefIds.length) {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_STALE', 'A bound SSH identity is malformed.', { category: 'integrity' });
    }
    try { connectionConfigFromRecord(connection); } catch {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_STALE', 'A bound SSH identity is malformed.', { category: 'integrity' });
    }
    return { connection, digest: criticalConnectionDigest(connection) };
  }

  #mapOperationalError(error, signal) {
    if (signal?.aborted || error?.code === 'SSH_EXECUTION_CANCELED' || error?.code === 'ABORT_ERR') return canceledError();
    if (error instanceof InfluxDb3EnterpriseLegacyStopProofError) return error;
    return stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_UNAVAILABLE', 'A bound node could not be verified over SSH.', { category: 'connectivity', retryable: true });
  }

  async #openNode(workspaceId, node, now, signal) {
    assertNotCanceled(signal);
    const loaded = await this.#loadConnection(workspaceId, node, now);
    let session;
    try {
      session = await this.sessionFactory({
        connectionConfig: connectionConfigFromRecord(loaded.connection),
        resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }),
        signal
      });
    } catch (error) { throw this.#mapOperationalError(error, signal); }
    if (!session || typeof session.run !== 'function' || typeof session.close !== 'function') {
      try { session?.close?.(); } catch {}
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_UNAVAILABLE', 'A bound node did not open a valid SSH execution session.', { category: 'connectivity', retryable: true });
    }
    return { node, session, connectionDigest: loaded.digest };
  }

  async #queryNode(workspaceId, opened, now, signal) {
    assertNotCanceled(signal);
    const current = await this.#loadConnection(workspaceId, opened.node, now);
    if (current.digest !== opened.connectionDigest) throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_CHANGED', 'A bound SSH identity changed during cluster stop verification.', { category: 'integrity' });
    const command = commandFromArgs('systemctl', [
      'show', '--no-pager', '--property=ActiveState', '--property=SubState', '--property=MainPID', opened.node.systemdUnit
    ]);
    let result;
    try {
      result = await opened.session.run(command, {
        stdoutLimitBytes: SYSTEMD_OUTPUT_LIMIT_BYTES,
        stderrLimitBytes: SYSTEMD_OUTPUT_LIMIT_BYTES
      });
    } catch (error) { throw this.#mapOperationalError(error, signal); }
    assertNotCanceled(signal);
    if (!result || result.exitCode !== 0 || typeof result.stderr !== 'string' || result.stderr.trim()) {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS', 'A node did not return an unambiguous systemd service state.', { category: 'integrity' });
    }
    const state = parseSystemdShow(result.stdout);
    if (state.activeState !== 'inactive' || state.subState !== 'dead' || state.mainPid !== 0) {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_CLUSTER_NOT_STOPPED', 'Every bound InfluxDB 3 Enterprise node must remain fully stopped.', { category: 'consistency' });
    }
    return { checkedAt: this.#now().timestamp };
  }

  async #runPass(workspaceId, openedNodes, now, signal) {
    const settled = await Promise.allSettled(openedNodes.map((opened) => this.#queryNode(workspaceId, opened, now, signal)));
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected) throw this.#mapOperationalError(rejected.reason, signal);
    return settled.map((result) => result.value);
  }

  async #assertBindingsUnchanged(workspaceId, openedNodes, now, signal) {
    assertNotCanceled(signal);
    const settled = await Promise.allSettled(openedNodes.map(async (opened) => {
      const current = await this.#loadConnection(workspaceId, opened.node, now);
      if (current.digest !== opened.connectionDigest) throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_CHANGED', 'A bound SSH identity changed during cluster stop verification.', { category: 'integrity' });
    }));
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected) throw this.#mapOperationalError(rejected.reason, signal);
  }

  async assertClusterStopped(request = {}) {
    const signal = request.signal || null;
    assertNotCanceled(signal);
    let workspaceId;
    try { workspaceId = normalizeId(request.workspaceId, 'Workspace ID'); } catch {
      throw stopProofError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH', 'The requested workspace is invalid.', { category: 'configuration' });
    }
    const binding = this.#selectBinding(request, await this.#currentBindings(workspaceId));
    const initialNow = this.#now();
    const openedNodes = [];
    try {
      const opened = await Promise.allSettled(binding.nodes.map((node) => this.#openNode(workspaceId, node, initialNow, signal)));
      for (const result of opened) if (result.status === 'fulfilled') openedNodes.push(result.value);
      const rejected = opened.find((result) => result.status === 'rejected');
      if (rejected) throw this.#mapOperationalError(rejected.reason, signal);
      const first = await this.#runPass(workspaceId, openedNodes, this.#now(), signal);
      const second = await this.#runPass(workspaceId, openedNodes, this.#now(), signal);
      const finalNow = this.#now();
      await this.#assertBindingsUnchanged(workspaceId, openedNodes, finalNow, signal);
      assertNotCanceled(signal);
      const nodes = Object.freeze(binding.nodes.map((node, index) => Object.freeze({
        nodeId: node.nodeId,
        unitName: node.systemdUnit,
        checkedAt: first[index].checkedAt,
        recheckedAt: second[index].checkedAt
      })));
      const issuedAt = this.#now().timestamp;
      const proof = { stopped: true, nodes, issuedAt };
      const proofDigest = await this.#authenticateProof(workspaceId, binding.targetConnectionId, proof);
      return Object.freeze({ ...proof, proofDigest });
    } finally {
      for (const opened of openedNodes) {
        try { opened.session.close(); } catch {}
      }
    }
  }

  async verifyClusterStopProof(request = {}) {
    const workspaceId = normalizeId(request.workspaceId, 'Workspace ID');
    const targetConnectionId = normalizeId(request.targetConnectionId, 'InfluxDB 3 Enterprise target connection ID');
    const proof = request.proof;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || typeof proof.proofDigest !== 'string') return false;
    const expected = await this.#authenticateProof(workspaceId, targetConnectionId, proof);
    const actual = String(proof.proofDigest).toLowerCase();
    const expectedBytes = Buffer.from(expected, 'utf8');
    const actualBytes = Buffer.from(actual, 'utf8');
    return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
  }
}

module.exports = {
  DEFAULT_MAX_TEST_AGE_MS,
  InfluxDb3EnterpriseLegacyStopProofError,
  InfluxDb3EnterpriseLegacyStopProofService,
  MAX_NODES,
  SYSTEMD_OUTPUT_LIMIT_BYTES,
  normalizeLegacyClusterStopBindings,
  parseSystemdShow
};
