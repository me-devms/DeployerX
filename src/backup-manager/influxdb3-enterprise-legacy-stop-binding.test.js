const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const {
  ADAPTER_ID,
  InfluxDb3EnterpriseLegacyStopBindingService
} = require('./influxdb3-enterprise-legacy-stop-binding');

const NOW = '2026-08-05T12:00:00.000Z';
const OLD = '2026-08-03T11:59:59.000Z';
const WORKSPACE_ID = 'workspace-legacy-binding';
const DEVICE_ID = 'legacy-binding-device';
const ACTOR_ID = 'backup-operator';
const CLUSTER_ID = 'cluster-legacy-001';
const TARGET_ID = 'enterprise-target-legacy';
const DEPLOYMENT_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const CAPABILITY_FINGERPRINT = `sha256:${'b'.repeat(64)}`;

function secretRecord(id, name) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name,
    provider: 'electron-safe-storage',
    scope: 'device',
    providerKey: `opaque-${id}`,
    secretType: 'password',
    version: 1
  };
}

function enterpriseRecord(storageEngine = 'legacy-parquet') {
  const legacy = storageEngine === 'legacy-parquet';
  const node = {
    id: 'compactor-a',
    storageEngine,
    legacyParquetEngine: legacy,
    compactorCapable: true,
    nativeBackupAvailable: !legacy
  };
  return {
    id: TARGET_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Private Enterprise target',
    kind: 'database',
    adapterId: 'deployerx.database.influxdb3-enterprise',
    adapterVersion: '1.0.0',
    scope: 'device',
    endpoint: {
      protocol: 'https',
      host: 'enterprise-private.internal',
      port: 8181,
      basePath: '',
      timeoutMs: 30000,
      expectedClusterId: CLUSTER_ID,
      expectedStorageEngine: storageEngine,
      expectedDeploymentFingerprint: DEPLOYMENT_FINGERPRINT,
      expectedCapabilityFingerprint: CAPABILITY_FINGERPRINT
    },
    secretRefIds: ['secret-enterprise-token'],
    trust: {
      mode: 'https',
      fingerprint: DEPLOYMENT_FINGERPRINT,
      capabilityFingerprint: CAPABILITY_FINGERPRINT
    },
    workerAffinity: [`device:${DEVICE_ID}`],
    lastTest: {
      status: 'success',
      adapterId: 'deployerx.database.influxdb3-enterprise',
      adapterVersion: '1.0.0',
      testedAt: NOW,
      endpointIdentity: {
        clusterId: CLUSTER_ID,
        nodeId: 'compactor-a',
        storageEngine,
        legacyParquetEngine: legacy,
        compactorCapable: true,
        nativeBackupAvailable: !legacy,
        deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
        capabilityFingerprint: CAPABILITY_FINGERPRINT
      }
    },
    influxdb3EnterpriseInventory: {
      version: 1,
      capturedAt: NOW,
      clusterId: CLUSTER_ID,
      deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
      capabilityFingerprint: CAPABILITY_FINGERPRINT,
      node
    }
  };
}

function sshRecord({ id, nodeId, host, fingerprintCharacter, diagnosticCharacter, testedAt = NOW, status = 'success', deviceId = DEVICE_ID }) {
  const hostKeyFingerprint = `SHA256:${fingerprintCharacter.repeat(43)}`;
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name: `Private SSH ${nodeId}`,
    kind: 'ssh',
    adapterId: 'deployerx.connection.ssh',
    adapterVersion: '1.0.0',
    scope: 'device',
    endpoint: { host, port: 22, username: 'private-backup-user', authType: 'password', timeoutMs: 20000 },
    secretRefIds: [`secret-${nodeId}`],
    trust: { mode: 'pinned-sha256', fingerprint: hostKeyFingerprint, algorithm: 'ssh-ed25519' },
    workerAffinity: [`device:${deviceId}`],
    lastTest: {
      status,
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

function enrollment(overrides = {}) {
  return {
    name: 'Legacy target stop proof',
    targetConnectionId: TARGET_ID,
    clusterId: CLUSTER_ID,
    nodes: [
      { nodeId: 'compactor-a', sshConnectionId: 'ssh-compactor-a', systemdUnit: 'influxdb3-compactor.service' },
      { nodeId: 'data-a', sshConnectionId: 'ssh-data-a', systemdUnit: 'influxdb3-data.service' }
    ],
    ...overrides
  };
}

async function fixture(context, options = {}) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-legacy-stop-binding-'));
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => NOW });
  await controlDatabase.initialize();
  context.after(async () => {
    await controlDatabase.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });
  const secretRepository = controlDatabase.repository('secretRef');
  for (const [id, name] of [
    ['secret-enterprise-token', 'Enterprise token'],
    ['secret-compactor-a', 'Compactor SSH password'],
    ['secret-data-a', 'Data SSH password']
  ]) await secretRepository.create(secretRecord(id, name));
  const connectionRepository = controlDatabase.repository('connection');
  await connectionRepository.create(enterpriseRecord(options.targetStorageEngine));
  await connectionRepository.create(sshRecord({
    id: 'ssh-compactor-a', nodeId: 'compactor-a', host: 'private-compactor.internal', fingerprintCharacter: 'A', diagnosticCharacter: 'a',
    testedAt: options.sshTestedAt, status: options.sshStatus, deviceId: options.sshDeviceId
  }));
  await connectionRepository.create(sshRecord({
    id: 'ssh-data-a', nodeId: 'data-a', host: 'private-data.internal', fingerprintCharacter: 'B', diagnosticCharacter: 'b',
    testedAt: options.sshTestedAt, status: options.sshStatus, deviceId: options.sshDeviceId
  }));
  const service = new InfluxDb3EnterpriseLegacyStopBindingService({ controlDatabase, deviceId: DEVICE_ID, clock: () => NOW });
  return { controlDatabase, connectionRepository, service };
}

test('persists an exact enrollment, exposes a redacted lifecycle, and resolves private proof bindings', async (context) => {
  const current = await fixture(context);
  const created = await current.service.create(WORKSPACE_ID, ACTOR_ID, enrollment());
  assert.equal(created.adapterId, ADAPTER_ID);
  assert.equal(created.currentDevice, true);
  assert.deepEqual(created.nodes.map((node) => node.nodeId), ['compactor-a', 'data-a']);
  assert.deepEqual(Object.keys(created.nodes[0]).sort(), ['nodeId', 'sshConnectionId', 'systemdUnit']);

  const raw = (await current.connectionRepository.list(WORKSPACE_ID, { limit: 1000 })).find((record) => record.id === created.id);
  assert.equal(raw.legacyStopBinding.targetConnectionRevision, 1);
  assert.equal(raw.legacyStopBinding.nodes[0].sshConnectionRevision, 1);
  assert.equal(raw.legacyStopBinding.nodes[0].sshDiagnosticFingerprint, 'a'.repeat(16));
  assert.equal(raw.legacyStopBinding.nodes[0].sshHostKeyFingerprint, `SHA256:${'A'.repeat(43)}`);

  const restartedService = new InfluxDb3EnterpriseLegacyStopBindingService({ controlDatabase: current.controlDatabase, deviceId: DEVICE_ID, clock: () => NOW });
  assert.deepEqual((await restartedService.list(WORKSPACE_ID)).map((item) => item.id), [created.id]);
  assert.equal((await restartedService.get(WORKSPACE_ID, created.id)).id, created.id);
  const publicJson = JSON.stringify(await restartedService.list(WORKSPACE_ID));
  for (const forbidden of [
    'private-compactor.internal', 'private-data.internal', 'private-backup-user', 'secret-compactor-a',
    'secret-data-a', 'aaaaaaaaaaaaaaaa', `SHA256:${'A'.repeat(43)}`, DEPLOYMENT_FINGERPRINT, CAPABILITY_FINGERPRINT
  ]) assert.equal(publicJson.includes(forbidden), false);

  const resolved = await restartedService.resolveBindings(WORKSPACE_ID);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].targetConnectionId, TARGET_ID);
  assert.equal(resolved[0].nodes[0].sshDiagnosticFingerprint, 'a'.repeat(16));
  assert.equal(resolved[0].nodes[1].sshConnectionId, 'ssh-data-a');

  const removed = await restartedService.remove(WORKSPACE_ID, created.id, ACTOR_ID, { expectedRevision: created.revision });
  assert.equal(removed.revision, 2);
  assert.deepEqual(await restartedService.list(WORKSPACE_ID), []);
  assert.deepEqual(await restartedService.resolveBindings(WORKSPACE_ID), []);
});

test('refuses duplicate target enrollments and unknown enrollment fields', async (context) => {
  const current = await fixture(context);
  await current.service.create(WORKSPACE_ID, ACTOR_ID, enrollment());
  await assert.rejects(
    current.service.create(WORKSPACE_ID, ACTOR_ID, enrollment({ name: 'Duplicate target proof' })),
    (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_DUPLICATE'
  );
  await assert.rejects(
    current.service.create(WORKSPACE_ID, ACTOR_ID, { ...enrollment(), privateHost: 'must-not-be-accepted' }),
    /Unknown InfluxDB 3 Enterprise legacy stop-binding enrollment field/
  );
  const withUnknownNode = enrollment();
  withUnknownNode.nodes[0].sshDiagnosticFingerprint = 'caller-must-not-pin-this';
  await assert.rejects(current.service.create(WORKSPACE_ID, ACTOR_ID, withUnknownNode), /Unknown InfluxDB 3 Enterprise legacy stop-binding node field/);
});

test('refuses non-legacy targets, foreign devices, stale or failed SSH tests, and node mismatches', async (context) => {
  await context.test('non-legacy target', async (subcontext) => {
    const current = await fixture(subcontext, { targetStorageEngine: 'upgraded' });
    await assert.rejects(current.service.create(WORKSPACE_ID, ACTOR_ID, enrollment()), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_TARGET_NOT_LEGACY');
  });
  await context.test('foreign SSH device', async (subcontext) => {
    const current = await fixture(subcontext, { sshDeviceId: 'another-device' });
    await assert.rejects(current.service.create(WORKSPACE_ID, ACTOR_ID, enrollment()), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_SSH_FOREIGN_DEVICE');
  });
  await context.test('stale SSH test', async (subcontext) => {
    const current = await fixture(subcontext, { sshTestedAt: OLD });
    await assert.rejects(current.service.create(WORKSPACE_ID, ACTOR_ID, enrollment()), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_SSH_STALE');
  });
  await context.test('failed SSH test', async (subcontext) => {
    const current = await fixture(subcontext, { sshStatus: 'failure' });
    await assert.rejects(current.service.create(WORKSPACE_ID, ACTOR_ID, enrollment()), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_SSH_STALE');
  });
  await context.test('missing compactor node', async (subcontext) => {
    const current = await fixture(subcontext);
    const input = enrollment({ nodes: [{ nodeId: 'data-a', sshConnectionId: 'ssh-data-a', systemdUnit: 'influxdb3-data.service' }] });
    await assert.rejects(current.service.create(WORKSPACE_ID, ACTOR_ID, input), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_NODE_MISMATCH');
  });
});

test('fresh resolution fails closed after the pinned Enterprise or SSH identity changes', async (context) => {
  await context.test('Enterprise target revision changes', async (subcontext) => {
    const current = await fixture(subcontext);
    await current.service.create(WORKSPACE_ID, ACTOR_ID, enrollment());
    const target = await current.connectionRepository.get(WORKSPACE_ID, TARGET_ID);
    await current.connectionRepository.update(WORKSPACE_ID, TARGET_ID, { name: 'Retested target identity' }, { expectedRevision: target.revision, actorId: ACTOR_ID });
    await assert.rejects(current.service.resolveBindings(WORKSPACE_ID), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_TARGET_STALE');
  });
  await context.test('SSH revision changes', async (subcontext) => {
    const current = await fixture(subcontext);
    await current.service.create(WORKSPACE_ID, ACTOR_ID, enrollment());
    const ssh = await current.connectionRepository.get(WORKSPACE_ID, 'ssh-data-a');
    await current.connectionRepository.update(WORKSPACE_ID, ssh.id, { endpoint: { ...ssh.endpoint, timeoutMs: 25000 } }, { expectedRevision: ssh.revision, actorId: ACTOR_ID });
    await assert.rejects(current.service.resolveBindings(WORKSPACE_ID), (error) => error.code === 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_SSH_STALE');
  });
});
