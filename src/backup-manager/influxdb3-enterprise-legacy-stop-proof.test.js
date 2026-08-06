const assert = require('node:assert/strict');
const test = require('node:test');
const {
  InfluxDb3EnterpriseLegacyStopProofService,
  SYSTEMD_OUTPUT_LIMIT_BYTES,
  normalizeLegacyClusterStopBindings,
  parseSystemdShow
} = require('./influxdb3-enterprise-legacy-stop-proof');

const NOW = '2026-08-05T12:00:00.000Z';
const DEVICE_ID = 'legacy-proof-device';
const WORKSPACE_ID = 'workspace-legacy-proof';
const TARGET_CONNECTION_ID = 'enterprise-target-a';
const CLUSTER_ID = 'cluster-001';
const STOPPED = 'ActiveState=inactive\nSubState=dead\nMainPID=0\n';

function sshRecord({ id, host, fingerprintCharacter, diagnosticCharacter, testedAt = NOW, nodeId }) {
  const hostKeyFingerprint = `SHA256:${fingerprintCharacter.repeat(43)}`;
  return {
    id,
    revision: 7,
    adapterId: 'deployerx.connection.ssh',
    adapterVersion: '1.0.0',
    scope: 'device',
    endpoint: { host, port: 22, username: 'backup', authType: 'password', timeoutMs: 20000 },
    secretRefIds: [`secret-${nodeId}`],
    trust: { mode: 'pinned-sha256', fingerprint: hostKeyFingerprint, algorithm: 'ssh-ed25519' },
    workerAffinity: [`device:${DEVICE_ID}`],
    lastTest: {
      status: 'success',
      testedAt,
      adapterId: 'deployerx.connection.ssh',
      adapterVersion: '1.0.0',
      diagnosticFingerprint: diagnosticCharacter.repeat(16),
      endpointIdentity: { host, port: 22, hostKeyFingerprint, hostKeyAlgorithm: 'ssh-ed25519' },
      remotePlatform: { os: 'linux' },
      checks: [
        { id: 'host-key', status: 'pass' },
        { id: 'authentication', status: 'pass' },
        { id: 'linux-platform', status: 'pass' },
        { id: 'sftp', status: 'pass' }
      ]
    }
  };
}

function bindingNode(record, nodeId, systemdUnit) {
  return {
    nodeId,
    sshConnectionId: record.id,
    sshConnectionRevision: record.revision,
    sshTestedAt: record.lastTest.testedAt,
    sshDiagnosticFingerprint: record.lastTest.diagnosticFingerprint,
    sshHostKeyFingerprint: record.trust.fingerprint,
    sshHostKeyAlgorithm: record.trust.algorithm,
    systemdUnit
  };
}

function fixture(options = {}) {
  const data = sshRecord({ id: 'ssh-data-a', host: 'private-data-a.internal', fingerprintCharacter: 'A', diagnosticCharacter: 'a', nodeId: 'data-a' });
  const compactor = sshRecord({ id: 'ssh-compactor-a', host: 'private-compactor-a.internal', fingerprintCharacter: 'B', diagnosticCharacter: 'b', nodeId: 'compactor-a' });
  const records = new Map([[data.id, data], [compactor.id, compactor]]);
  const getCounts = new Map();
  const controlDatabase = {
    repository(kind) {
      assert.equal(kind, 'connection');
      return {
        async get(workspaceId, id) {
          assert.equal(workspaceId, WORKSPACE_ID);
          const count = (getCounts.get(id) || 0) + 1;
          getCounts.set(id, count);
          await options.onGet?.({ id, count, records });
          return records.has(id) ? structuredClone(records.get(id)) : null;
        }
      };
    }
  };
  const resolvedSecrets = [];
  const secretStore = {
    async resolve({ workspaceId, id }) {
      assert.equal(workspaceId, WORKSPACE_ID);
      resolvedSecrets.push(id);
      return `private-credential-for-${id}`;
    }
  };
  const sessions = [];
  const outputs = options.outputs || new Map();
  const sessionFactory = async ({ connectionConfig, resolveSecret, signal }) => {
    assert.equal(signal, options.signal || null);
    await resolveSecret(connectionConfig.credentialSecretRefId);
    const session = {
      host: connectionConfig.host,
      runs: 0,
      closed: false,
      async run(command, limits) {
        this.runs += 1;
        assert.equal(command, `'systemctl' 'show' '--no-pager' '--property=ActiveState' '--property=SubState' '--property=MainPID' '${this.host.includes('compactor') ? 'influxdb3-compactor.service' : 'influxdb3-data.service'}'`);
        assert.deepEqual(limits, { stdoutLimitBytes: SYSTEMD_OUTPUT_LIMIT_BYTES, stderrLimitBytes: SYSTEMD_OUTPUT_LIMIT_BYTES });
        const configured = outputs.get(this.host);
        const selected = typeof configured === 'function' ? await configured({ session: this, signal }) : configured?.[this.runs - 1];
        if (selected instanceof Error) throw selected;
        return selected || { stdout: STOPPED, stderr: '', exitCode: 0 };
      },
      close() { this.closed = true; }
    };
    sessions.push(session);
    return session;
  };
  const bindings = [{
    targetConnectionId: TARGET_CONNECTION_ID,
    clusterId: CLUSTER_ID,
    nodes: [
      bindingNode(data, 'data-a', 'influxdb3-data.service'),
      bindingNode(compactor, 'compactor-a', 'influxdb3-compactor.service')
    ]
  }];
  const service = new InfluxDb3EnterpriseLegacyStopProofService({
    controlDatabase,
    secretStore,
    deviceId: DEVICE_ID,
    ...(options.resolveBindings
      ? { resolveBindings: options.resolveBindings }
      : { bindings: options.bindings || bindings }),
    proofKey: options.proofKey || Buffer.alloc(32, 0x41),
    sessionFactory,
    clock: () => NOW,
    ...(options.maxTestAgeMs ? { maxTestAgeMs: options.maxTestAgeMs } : {})
  });
  const request = {
    workspaceId: WORKSPACE_ID,
    targetConnectionId: TARGET_CONNECTION_ID,
    clusterId: CLUSTER_ID,
    nodeIds: ['data-a', 'compactor-a'],
    signal: options.signal || null
  };
  return { service, request, records, bindings, sessions, resolvedSecrets, data, compactor };
}

test('requires exactly one static or dynamic stop-binding source', () => {
  const dependencies = {
    controlDatabase: {},
    secretStore: {},
    deviceId: DEVICE_ID,
    proofKey: Buffer.alloc(32, 0x41),
    sessionFactory: async () => null
  };
  assert.throws(() => new InfluxDb3EnterpriseLegacyStopProofService(dependencies), /exactly one InfluxDB 3 Enterprise stop-binding source/);
  assert.throws(() => new InfluxDb3EnterpriseLegacyStopProofService({ ...dependencies, bindings: [], resolveBindings: async () => [] }), /exactly one InfluxDB 3 Enterprise stop-binding source/);
});

test('proves every exact node twice and returns an authenticated sanitized projection', async () => {
  const current = fixture();
  const proof = await current.service.assertClusterStopped(current.request);
  assert.equal(proof.stopped, true);
  assert.match(proof.proofDigest, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.equal(proof.issuedAt, NOW);
  assert.deepEqual(proof.nodes, [
    { nodeId: 'compactor-a', unitName: 'influxdb3-compactor.service', checkedAt: NOW, recheckedAt: NOW },
    { nodeId: 'data-a', unitName: 'influxdb3-data.service', checkedAt: NOW, recheckedAt: NOW }
  ]);
  assert.equal(current.sessions.length, 2);
  assert.deepEqual(current.sessions.map((session) => session.runs), [2, 2]);
  assert.equal(current.sessions.every((session) => session.closed), true);
  assert.deepEqual(current.resolvedSecrets.sort(), ['secret-compactor-a', 'secret-data-a']);

  const serialized = JSON.stringify(proof);
  for (const forbidden of ['private-data-a.internal', 'private-compactor-a.internal', 'ssh-data-a', 'ssh-compactor-a', 'secret-data-a', 'private-credential', 'systemctl', TARGET_CONNECTION_ID]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(Object.keys(proof).sort(), ['issuedAt', 'nodes', 'proofDigest', 'stopped']);
  assert.deepEqual(Object.keys(proof.nodes[0]).sort(), ['checkedAt', 'nodeId', 'recheckedAt', 'unitName']);
});

test('the stop proof digest is keyed rather than a public stable hash', async () => {
  const first = fixture({ proofKey: Buffer.alloc(32, 0x11) });
  const second = fixture({ proofKey: Buffer.alloc(32, 0x22) });
  const firstProof = await first.service.assertClusterStopped(first.request);
  const secondProof = await second.service.assertClusterStopped(second.request);
  assert.notEqual(firstProof.proofDigest, secondProof.proofDigest);
});

test('verifies the exact sanitized proof with the private key', async () => {
  const current = fixture();
  const proof = await current.service.assertClusterStopped(current.request);
  assert.equal(await current.service.verifyClusterStopProof({ workspaceId: WORKSPACE_ID, targetConnectionId: TARGET_CONNECTION_ID, proof }), true);
  assert.equal(await current.service.verifyClusterStopProof({ workspaceId: WORKSPACE_ID, targetConnectionId: TARGET_CONNECTION_ID, proof: { ...proof, issuedAt: '2026-08-05T12:00:01.000Z' } }), false);
});

test('fails when a node is running or enters an automatic restart during the recheck', async () => {
  for (const secondState of [
    'ActiveState=active\nSubState=running\nMainPID=918\n',
    'ActiveState=activating\nSubState=auto-restart\nMainPID=0\n'
  ]) {
    const outputs = new Map([['private-data-a.internal', [
      { stdout: STOPPED, stderr: '', exitCode: 0 },
      { stdout: secondState, stderr: '', exitCode: 0 }
    ]]]);
    const current = fixture({ outputs });
    await assert.rejects(current.service.assertClusterStopped(current.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_CLUSTER_NOT_STOPPED');
    assert.equal(current.sessions.every((session) => session.closed), true);
  }
});

test('requires the requested cluster and node set to exactly match one configured binding', async () => {
  const current = fixture();
  await assert.rejects(current.service.assertClusterStopped({ ...current.request, clusterId: 'cluster-foreign' }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH');
  await assert.rejects(current.service.assertClusterStopped({ ...current.request, nodeIds: ['data-a'] }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH');
  await assert.rejects(current.service.assertClusterStopped({ ...current.request, nodeIds: ['data-a', 'data-a'] }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH');
  assert.equal(current.sessions.length, 0);

  const secondBinding = structuredClone(current.bindings[0]);
  secondBinding.targetConnectionId = 'enterprise-target-b';
  const ambiguous = fixture({ bindings: [current.bindings[0], secondBinding] });
  const { targetConnectionId: _targetConnectionId, ...withoutTarget } = ambiguous.request;
  await assert.rejects(ambiguous.service.assertClusterStopped(withoutTarget), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_AMBIGUOUS');
});

test('resolves and normalizes the current workspace bindings on every proof request', async () => {
  const calls = [];
  let resolved = [];
  const current = fixture({
    resolveBindings: async (workspaceId) => {
      calls.push(workspaceId);
      return structuredClone(resolved);
    }
  });
  await assert.rejects(current.service.assertClusterStopped(current.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISSING');
  resolved = current.bindings;
  const proof = await current.service.assertClusterStopped(current.request);
  assert.equal(proof.stopped, true);
  resolved = [{ ...current.bindings[0], nodes: current.bindings[0].nodes.slice(0, 1) }];
  await assert.rejects(current.service.assertClusterStopped(current.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_MISMATCH');
  assert.deepEqual(calls, [WORKSPACE_ID, WORKSPACE_ID, WORKSPACE_ID]);
});

test('rejects duplicate configured node and SSH bindings before any execution', () => {
  const current = fixture();
  const duplicateNode = structuredClone(current.bindings[0]);
  duplicateNode.nodes[1].nodeId = duplicateNode.nodes[0].nodeId;
  assert.throws(() => normalizeLegacyClusterStopBindings([duplicateNode]), /duplicate node IDs/);
  const duplicateSsh = structuredClone(current.bindings[0]);
  duplicateSsh.nodes[1].sshConnectionId = duplicateSsh.nodes[0].sshConnectionId;
  assert.throws(() => normalizeLegacyClusterStopBindings([duplicateSsh]), /duplicate SSH bindings/);
  const unsafeUnit = structuredClone(current.bindings[0]);
  unsafeUnit.nodes[0].systemdUnit = 'influxdb3.service; reboot';
  assert.throws(() => normalizeLegacyClusterStopBindings([unsafeUnit]), /systemd unit/);
});

test('fails closed on stale, missing, foreign-device, and changed SSH identity', async () => {
  const stale = fixture();
  stale.records.get(stale.data.id).revision += 1;
  await assert.rejects(stale.service.assertClusterStopped(stale.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_STALE');

  const missing = fixture();
  missing.records.delete(missing.data.id);
  await assert.rejects(missing.service.assertClusterStopped(missing.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_MISSING');

  const foreign = fixture();
  foreign.records.get(foreign.data.id).workerAffinity = ['device:somewhere-else'];
  await assert.rejects(foreign.service.assertClusterStopped(foreign.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_FOREIGN_DEVICE');

  const changed = fixture({ onGet: ({ id, count, records }) => {
    if (id === 'ssh-data-a' && count === 2) records.get(id).endpoint.timeoutMs += 1;
  } });
  await assert.rejects(changed.service.assertClusterStopped(changed.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_CHANGED');
  assert.equal(changed.sessions.every((session) => session.closed), true);
});

test('rejects an SSH test that has aged beyond the configured freshness window', async () => {
  const old = '2026-08-03T11:59:59.000Z';
  const current = fixture();
  for (const record of current.records.values()) record.lastTest.testedAt = old;
  const oldBindings = current.bindings.map((binding) => ({
    ...binding,
    nodes: binding.nodes.map((node) => ({ ...node, sshTestedAt: old }))
  }));
  const stale = fixture({ bindings: oldBindings });
  for (const record of stale.records.values()) record.lastTest.testedAt = old;
  await assert.rejects(stale.service.assertClusterStopped(stale.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_SSH_STALE');
});

test('rejects malformed, duplicated, overflowing, or diagnostic systemd output', async () => {
  assert.throws(() => parseSystemdShow('ActiveState=inactive\nSubState=dead\nMainPID=0\nMainPID=0\n'), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS');
  assert.throws(() => parseSystemdShow('ActiveState=inactive\nSubState=dead\n'), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS');
  assert.throws(() => parseSystemdShow('ActiveState=inactive\nSubState=dead\nMainPID=not-a-pid\n'), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS');
  assert.throws(() => parseSystemdShow('ActiveState=inactive\nSubState=dead\nMainPID=00\n'), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS');
  assert.throws(() => parseSystemdShow(`ActiveState=inactive\nSubState=${'x'.repeat(SYSTEMD_OUTPUT_LIMIT_BYTES)}\nMainPID=0\n`), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS');

  const outputs = new Map([['private-data-a.internal', [{ stdout: 'ActiveState=inactive\nSubState=dead\n', stderr: '', exitCode: 0 }]]]);
  const current = fixture({ outputs });
  await assert.rejects(current.service.assertClusterStopped(current.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_SYSTEMD_STATE_AMBIGUOUS');
  assert.equal(current.sessions.every((session) => session.closed), true);
});

test('cancellation fails closed and closes every opened SSH session', async () => {
  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort();
  const beforeOpen = fixture({ signal: alreadyCanceled.signal });
  await assert.rejects(beforeOpen.service.assertClusterStopped(beforeOpen.request), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_CANCELED');
  assert.equal(beforeOpen.sessions.length, 0);

  const controller = new AbortController();
  const outputs = new Map([['private-data-a.internal', async () => {
    controller.abort();
    throw Object.assign(new Error('private host and command must not escape'), { code: 'SSH_EXECUTION_CANCELED' });
  }]]);
  const duringCheck = fixture({ signal: controller.signal, outputs });
  await assert.rejects(duringCheck.service.assertClusterStopped(duringCheck.request), (error) => {
    assert.equal(error.code, 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_CANCELED');
    assert.equal(error.message.includes('private host'), false);
    return true;
  });
  assert.equal(duringCheck.sessions.every((session) => session.closed), true);
});
