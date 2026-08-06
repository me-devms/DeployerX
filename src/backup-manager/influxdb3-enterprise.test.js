const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  InfluxDb3EnterpriseAdapter,
  InfluxDb3EnterpriseConnectionService,
  LEGACY_CONSISTENCY_METHOD,
  MAX_BACKUPS,
  MAX_NODES,
  MAX_RESPONSE_BYTES,
  NATIVE_CONSISTENCY_METHOD,
  nativeBackupName,
  normalizeConfig,
  normalizeNativeBackupExecution,
  parseProductIdentity,
  parseVersion
} = require('./influxdb3-enterprise');

const TOKEN = 'apiv3_private_admin_token_material_123456789';
const ROTATED_TOKEN = 'apiv3_rotated_admin_token_material_987654321';
const SECRET_REF_ID = 'sec_enterprise_admin';
const CLUSTER_ID = 'catalog-uuid-001';
const NODE_ID = 'enterprise-node-01';
const PROCESS_ID = 'instance-uuid-001';

function config(overrides = {}) {
  return { host: 'enterprise.example.com', adminTokenSecretRefId: SECRET_REF_ID, ...overrides };
}

function headers(clusterId = CLUSTER_ID, version = '3.11.0', build = 'Enterprise') {
  return { 'x-influxdb-build': build, 'x-influxdb-version': version, 'cluster-uuid': clusterId };
}

function pingResponse(state) {
  const version = state.version || '3.11.0';
  return {
    statusCode: state.pingStatus || 200,
    headers: headers(state.clusterId || CLUSTER_ID, state.headerVersion || version, state.build || 'Enterprise'),
    body: state.pingBody === undefined ? JSON.stringify({ product_name: 'InfluxDB 3 Enterprise', version, revision: 'abc123def', process_id: state.processId || PROCESS_ID }) : state.pingBody
  };
}

function nodeRows(state) {
  return state.nodes || [
    { node_id: state.nodeId || NODE_ID, node_catalog_id: state.nodeCatalogId ?? 7, instance_id: state.processId || PROCESS_ID, mode: state.roles || ['compact'], state: 'running' },
    { node_id: 'enterprise-node-02', node_catalog_id: 8, instance_id: 'instance-uuid-002', mode: ['query'], state: 'running' }
  ];
}

function nodesResponse(state) {
  return {
    statusCode: state.nodesStatus || 200,
    headers: { 'cluster-uuid': state.nodesClusterId || state.clusterId || CLUSTER_ID },
    body: state.nodesBody === undefined ? JSON.stringify(nodeRows(state)) : state.nodesBody
  };
}

function backupResponse(state) {
  return {
    statusCode: state.backupStatus || 200,
    headers: { 'cluster-uuid': state.backupClusterId || state.clusterId || CLUSTER_ID },
    body: state.backupBody === undefined ? JSON.stringify({ backups: state.backups || [] }) : state.backupBody
  };
}

function adapterFixture(overrides = {}) {
  const state = { ...overrides };
  const observations = [];
  const resolvedTokens = [];
  const transport = async (request) => {
    observations.push(request);
    const token = await request.resolveSecret(request.config.adminTokenSecretRefId);
    resolvedTokens.push(token);
    if (state.throwTransport) throw new Error(state.throwTransport);
    if (request.apiPath.endsWith('/ping')) return pingResponse(state);
    if (request.apiPath.endsWith('/api/v3/query_sql')) return nodesResponse(state);
    if (request.apiPath.endsWith('/api/v3/enterprise/backup')) return backupResponse(state);
    throw new Error('Unexpected request path.');
  };
  return {
    adapter: new InfluxDb3EnterpriseAdapter({ transport, nativeController: state.nativeController || null, clock: () => '2026-08-05T12:00:00.000Z', now: () => 100 }),
    state,
    observations,
    resolvedTokens
  };
}

function context(token = TOKEN) {
  return { resolveSecret: async (id) => { assert.equal(id, SECRET_REF_ID); return token; } };
}

function pinned(identity, overrides = {}) {
  return config({
    expectedVersion: identity.version.text,
    expectedStorageEngine: identity.storageEngine,
    expectedClusterId: identity.clusterId,
    expectedNodeId: identity.nodeId,
    expectedNodeCatalogId: identity.nodeCatalogId,
    expectedInstanceId: identity.instanceId,
    expectedRoleFingerprint: identity.roleFingerprint,
    expectedDeploymentFingerprint: identity.deploymentFingerprint,
    expectedCapabilityFingerprint: identity.capabilityFingerprint,
    ...overrides
  });
}

test('normalizes a strict HTTPS SecretRef-only endpoint and validates exact Enterprise 3.x identity', () => {
  assert.deepEqual(normalizeConfig(config()), {
    protocol: 'https', allowInsecureHttp: false, host: 'enterprise.example.com', port: 8181, basePath: '', caFile: null, timeoutMs: 30000,
    adminTokenSecretRefId: SECRET_REF_ID, expectedVersion: null, expectedStorageEngine: null, expectedClusterId: null, expectedNodeId: null,
    expectedNodeCatalogId: null, expectedInstanceId: null, expectedRoleFingerprint: null, expectedDeploymentFingerprint: null, expectedCapabilityFingerprint: null
  });
  assert.equal(normalizeConfig(config({ protocol: 'http', allowInsecureHttp: true })).protocol, 'http');
  assert.throws(() => normalizeConfig(config({ protocol: 'http' })), /explicit insecure-transport approval/);
  assert.throws(() => normalizeConfig(config({ allowInsecureHttp: true })), /valid only for HTTP/);
  assert.throws(() => normalizeConfig(config({ basePath: '/../admin' })), /base path is invalid/);
  assert.throws(() => normalizeConfig(config({ host: 'https:\/\/enterprise.example.com' })), /without a URI scheme/);
  assert.throws(() => normalizeConfig(config({ timeoutMs: 999 })), /between 1 and 300 seconds/);
  assert.throws(() => normalizeConfig(config({ token: TOKEN })), (error) => !String(error).includes(TOKEN));
  assert.deepEqual(parseVersion('3.11.0'), { text: '3.11.0', major: 3, minor: 11, patch: 0 });
  assert.throws(() => parseVersion('2.7.11'), (error) => error.code === 'INFLUXDB3_ENTERPRISE_VERSION_UNSUPPORTED');
  const product = parseProductIdentity(pingResponse({}));
  assert.equal(product.product, 'influxdb3-enterprise');
  assert.equal(product.clusterId, CLUSTER_ID);
  assert.throws(() => parseProductIdentity(pingResponse({ build: 'Core' })), (error) => error.code === 'INFLUXDB3_ENTERPRISE_PRODUCT_UNSUPPORTED');
  assert.throws(() => parseProductIdentity(pingResponse({ headerVersion: '3.10.0' })), (error) => error.code === 'INFLUXDB3_ENTERPRISE_IDENTITY_INVALID');
});

test('proves upgraded-engine native capability only through product, cluster, node, role, and backup evidence', async () => {
  const fixture = adapterFixture({ backups: [{ name: 'base' }] });
  const manifest = new DatabaseAdapterRegistry([fixture.adapter]).manifest(ADAPTER_ID);
  assert.equal(manifest.executionReady, true);
  assert.equal(manifest.sourceEnrollmentReady, true);
  assert.deepEqual(manifest.capabilities.backupModes, ['full']);
  assert.deepEqual(manifest.capabilities.consistencyStrategies, [
    { id: NATIVE_CONSISTENCY_METHOD, produces: 'application', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: true },
    { id: 'influxdb3-enterprise-legacy-stopped-copy', produces: 'application', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: true, capturesCoordinates: false },
    { id: 'influxdb3-enterprise-legacy-atomic-snapshot-copy', produces: 'application', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: false },
    { id: LEGACY_CONSISTENCY_METHOD, produces: 'crash', backupMethods: ['physical'], lockScope: 'cluster', requiresDowntime: false, capturesCoordinates: false }
  ]);
  assert.match(manifest.serverVersionRange, /upgraded-native/);
  assert.match(manifest.serverVersionRange, /legacy-compactor/);
  assert.deepEqual(manifest.capabilities.restore, { alternateTarget: false, offlineBundle: false, originalTarget: false, nativeValidation: false });
  const identity = await fixture.adapter.readIdentity(context(), config());
  assert.equal(identity.storageEngine, 'upgraded');
  assert.equal(identity.nodeId, NODE_ID);
  assert.equal(identity.nodeCatalogId, 7);
  assert.equal(identity.instanceId, PROCESS_ID);
  assert.deepEqual(identity.roles, ['compact']);
  assert.equal(identity.compactorCapable, true);
  assert.equal(identity.nativeBackupAvailable, true);
  assert.equal(identity.observedBackupCount, 1);
  assert.equal(fixture.observations.length, 3);
  assert.equal(fixture.observations.find((item) => item.apiPath.endsWith('/query_sql')).body.q.includes('system.nodes'), true);
  for (const observation of fixture.observations) assert.equal(JSON.stringify(observation).includes(TOKEN), false);
  assert.deepEqual(fixture.resolvedTokens, [TOKEN, TOKEN, TOKEN]);
  const pages = [];
  for await (const page of fixture.adapter.discover(context(), { connection: pinned(identity), kind: 'all' })) pages.push(page);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].items[0].selectable, false);
  assert.equal(pages[0].capabilities.nativeBackupAvailable, true);
  assert.equal(pages[0].capabilities.incrementalBackupAvailable, false);
  assert.equal(JSON.stringify(pages).includes(TOKEN), false);
  for (const method of ['planRestore', 'executeRestore', 'validateRestore']) {
    await assert.rejects(fixture.adapter[method](), (error) => error.code === 'INFLUXDB3_ENTERPRISE_OPERATION_UNSUPPORTED');
  }
});

test('plans and executes only an exact upgraded-engine full backup through the native controller', async () => {
  const accepted = [];
  const nativeController = {
    async createBackup(operationContext, request) {
      const connection = request.connection;
      const owner = {
        version: 1,
        operationKind: NATIVE_CONSISTENCY_METHOD,
        backupName: request.name,
        clusterId: connection.expectedClusterId,
        storageEngine: connection.expectedStorageEngine,
        nodeId: connection.expectedNodeId,
        nodeCatalogId: connection.expectedNodeCatalogId,
        instanceId: connection.expectedInstanceId,
        roleFingerprint: connection.expectedRoleFingerprint,
        deploymentFingerprint: connection.expectedDeploymentFingerprint,
        capabilityFingerprint: connection.expectedCapabilityFingerprint,
        acceptedAt: '2026-08-05T12:00:00.000Z'
      };
      await operationContext.onOwnership(owner);
      accepted.push({ request, owner });
      return {
        ownership: owner,
        identity: {
          version: connection.expectedVersion,
          storageEngine: connection.expectedStorageEngine,
          clusterId: connection.expectedClusterId,
          nodeId: connection.expectedNodeId,
          nodeCatalogId: connection.expectedNodeCatalogId,
          instanceId: connection.expectedInstanceId,
          roleFingerprint: connection.expectedRoleFingerprint,
          deploymentFingerprint: connection.expectedDeploymentFingerprint,
          capabilityFingerprint: connection.expectedCapabilityFingerprint
        },
        backup: { name: request.name, type: 'full', parentName: null, status: 'completed', watermark: 'wal:42', createdAt: '2026-08-05T12:00:00.000Z', completedAt: '2026-08-05T12:00:05.000Z' }
      };
    }
  };
  const fixture = adapterFixture({ nativeController });
  const identity = await fixture.adapter.readIdentity(context(), config());
  const connection = pinned(identity);
  const execution = normalizeNativeBackupExecution({
    tier: 'upgraded-native', productVersion: identity.version.text, clusterId: identity.clusterId, storageEngine: identity.storageEngine,
    nodeId: identity.nodeId, nodeCatalogId: identity.nodeCatalogId, instanceId: identity.instanceId, roleFingerprint: identity.roleFingerprint,
    deploymentFingerprint: identity.deploymentFingerprint, capabilityFingerprint: identity.capabilityFingerprint, compactorCapable: true,
    nativeBackupAvailable: true, connectionRevision: 9, workspaceId: 'workspace-a', sourceId: 'source-a', executionId: 'execution-a'
  });
  const selector = { kind: 'database-objects', allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false };
  const registry = new DatabaseAdapterRegistry([fixture.adapter]);
  const prepared = await registry.prepareBackup(ADAPTER_ID, context(), {
    connection,
    selector,
    consistency: { backupMethod: 'physical', backupMode: 'full', method: NATIVE_CONSISTENCY_METHOD, requestedLevel: 'application', captureCoordinates: true, allowDowngrade: false },
    execution
  });
  assert.equal(prepared.adapterPlan.backupName, nativeBackupName('workspace-a', 'source-a', 'execution-a'));
  assert.equal(prepared.consistency.achievedLevel, 'application');
  const owners = [];
  const result = await fixture.adapter.executeBackup({ ...context(), onOwnership: async (owner) => owners.push(owner) }, prepared.adapterPlan);
  assert.equal(result.kind, 'influxdb3-enterprise-native-backup');
  assert.equal(result.backupMode, 'full');
  assert.equal(result.consistency.persistedDataWatermark, 'wal:42');
  assert.equal(result.externalNativeMedia.includedInRepository, false);
  assert.equal(result.restoreSupported, false);
  assert.equal(accepted.length, 1);
  assert.equal(owners.length, 1);
  assert.equal(JSON.stringify(result).includes(SECRET_REF_ID), false);
  assert.equal(JSON.stringify(result).includes('enterprise.example.com'), false);
  await assert.rejects(registry.prepareBackup(ADAPTER_ID, context(), { connection, selector, consistency: { backupMethod: 'physical', backupMode: 'incremental', method: NATIVE_CONSISTENCY_METHOD, requestedLevel: 'application', captureCoordinates: true }, execution }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_INCREMENTAL_WIRE_CONTRACT_UNAVAILABLE');
  assert.throws(() => normalizeNativeBackupExecution({ ...execution, tier: 'legacy-copy' }), /upgraded-engine compactor/);
});

test('maps documented 404 and 503 responses to fail-closed engine and role evidence', async () => {
  const cases = [
    { state: { backupStatus: 404, roles: ['compact'] }, engine: 'legacy-parquet', reason: 'legacy-parquet-engine' },
    { state: { backupStatus: 404, roles: ['ingest'] }, engine: 'unknown', reason: 'ingest-only-node' },
    { state: { backupStatus: 503, roles: ['query'] }, engine: 'unknown', reason: 'query-only-node' }
  ];
  for (const entry of cases) {
    const fixture = adapterFixture(entry.state);
    const identity = await fixture.adapter.readIdentity(context(), config());
    assert.equal(identity.storageEngine, entry.engine);
    assert.equal(identity.unavailableReason, entry.reason);
    assert.equal(identity.nativeBackupAvailable, false);
    const result = await fixture.adapter.testConnection(context(), config());
    assert.equal(result.status, 'success');
    assert.equal(result.endpointIdentity.nativeBackupAvailable, false);
  }
  const inconsistent = adapterFixture({ backupStatus: 503, roles: ['compact'] });
  await assert.rejects(inconsistent.adapter.readIdentity(context(), config()), (error) => error.code === 'INFLUXDB3_ENTERPRISE_CAPABILITY_INCONSISTENT');
});

test('detects exact version, engine, cluster, node, catalog, instance, role, deployment, and capability drift', async () => {
  const fixture = adapterFixture();
  const baseline = await fixture.adapter.readIdentity(context(), config());
  const expected = pinned(baseline);
  const cases = [
    ['INFLUXDB3_ENTERPRISE_VERSION_CHANGED', () => { fixture.state.version = '3.12.0'; }],
    ['INFLUXDB3_ENTERPRISE_STORAGE_ENGINE_CHANGED', () => { fixture.state.backupStatus = 404; }],
    ['INFLUXDB3_ENTERPRISE_CLUSTER_CHANGED', () => { fixture.state.clusterId = 'catalog-uuid-002'; }],
    ['INFLUXDB3_ENTERPRISE_NODE_CHANGED', () => { fixture.state.nodeId = 'enterprise-node-09'; }],
    ['INFLUXDB3_ENTERPRISE_NODE_CATALOG_CHANGED', () => { fixture.state.nodeCatalogId = 99; }],
    ['INFLUXDB3_ENTERPRISE_NODE_INSTANCE_CHANGED', () => { fixture.state.processId = 'instance-uuid-099'; }],
    ['INFLUXDB3_ENTERPRISE_ROLE_CHANGED', () => { fixture.state.roles = ['all']; }]
  ];
  for (const [code, mutate] of cases) {
    Object.keys(fixture.state).forEach((key) => delete fixture.state[key]);
    mutate();
    await assert.rejects(fixture.adapter.readIdentity(context(), expected), (error) => error.code === code, code);
  }
  Object.keys(fixture.state).forEach((key) => delete fixture.state[key]);
  await assert.rejects(fixture.adapter.readIdentity(context(), { ...expected, host: 'alternate.example.com' }), (error) => error.code === 'INFLUXDB3_ENTERPRISE_DEPLOYMENT_CHANGED');
  const queryFixture = adapterFixture({ backupStatus: 503, roles: ['query'] });
  const queryBaseline = await queryFixture.adapter.readIdentity(context(), config());
  queryFixture.state.backupStatus = 404;
  await assert.rejects(queryFixture.adapter.readIdentity(context(), pinned(queryBaseline)), (error) => error.code === 'INFLUXDB3_ENTERPRISE_CAPABILITY_CHANGED');
});

test('bounds every response and never discloses a token echoed by a server or thrown by a transport', async () => {
  const cases = [
    { pingBody: 'x'.repeat(MAX_RESPONSE_BYTES + 1), code: 'INFLUXDB3_ENTERPRISE_RESPONSE_TOO_LARGE' },
    { pingBody: TOKEN, code: 'INFLUXDB3_ENTERPRISE_RESPONSE_INVALID' },
    { throwTransport: TOKEN, code: 'INFLUXDB3_ENTERPRISE_UNREACHABLE' },
    { nodes: Array.from({ length: MAX_NODES + 1 }, (_, index) => ({ node_id: `node-${index}`, node_catalog_id: index, instance_id: `instance-${index}`, mode: ['query'], state: 'running' })), code: 'INFLUXDB3_ENTERPRISE_NODE_COLLECTION_INVALID' },
    { backups: Array.from({ length: MAX_BACKUPS + 1 }, (_, index) => ({ name: `backup-${index}` })), code: 'INFLUXDB3_ENTERPRISE_BACKUP_COLLECTION_INVALID' }
  ];
  for (const entry of cases) {
    const fixture = adapterFixture(entry);
    const result = await fixture.adapter.testConnection(context(), config());
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, entry.code);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(String(result.error.safeMessage).includes(TOKEN), false);
  }
  const tls = new InfluxDb3EnterpriseAdapter();
  const result = await tls.testConnection(context(), config({ caFile: path.resolve('missing-enterprise-ca.pem') }));
  assert.equal(result.error.code, 'INFLUXDB3_ENTERPRISE_TLS_FILE_INVALID');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

function serviceFixture(options = {}) {
  const connections = new Map();
  const secretRefs = new Map();
  const secrets = new Map();
  const deleted = [];
  let markedValidated = 0;
  let resolved = 0;
  const connectionRepository = {
    list: async () => [...connections.values()],
    get: async (_workspaceId, id) => connections.get(id) || null,
    update: async (_workspaceId, id, patch, updateOptions) => {
      const current = connections.get(id);
      assert.equal(updateOptions.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      connections.set(id, updated);
      return updated;
    }
  };
  const secretRepository = {
    get: async (_workspaceId, id) => secretRefs.get(id) || null,
    update: async (_workspaceId, id, patch, updateOptions) => {
      const current = secretRefs.get(id);
      assert.equal(updateOptions.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      secretRefs.set(id, updated);
      return updated;
    }
  };
  const controlDatabase = {
    repository: (name) => name === 'connection' ? connectionRepository : secretRepository,
    transaction: async (callback) => {
      if (options.failTransaction) throw new Error(TOKEN);
      return callback({
        create: (name, input) => {
          if (name === 'secretRef') {
            const record = { ...input, revision: 1 };
            secretRefs.set(record.id, record);
            return record;
          }
          const record = { ...input, id: 'connection-enterprise', revision: 1 };
          connections.set(record.id, record);
          return record;
        }
      });
    }
  };
  const secretStore = {
    create: async (input) => {
      secrets.set(SECRET_REF_ID, input.value);
      return { id: SECRET_REF_ID, workspaceId: input.workspaceId, name: input.name, provider: 'electron-safe-storage', scope: input.scope, providerKey: SECRET_REF_ID, secretType: input.secretType, version: 1 };
    },
    resolve: async ({ workspaceId, id }) => {
      assert.equal(workspaceId, 'workspace-a');
      assert.equal(id, SECRET_REF_ID);
      resolved += 1;
      return secrets.get(id);
    },
    markValidated: async ({ id }) => {
      assert.equal(id, SECRET_REF_ID);
      markedValidated += 1;
      return { lastValidatedAt: '2026-08-05T12:00:00.000Z' };
    },
    delete: async ({ id }) => {
      deleted.push(id);
      return secrets.delete(id);
    }
  };
  return { connections, secretRefs, secrets, deleted, controlDatabase, secretStore, markedValidated: () => markedValidated, resolved: () => resolved };
}

test('enrolls one device-scoped encrypted SecretRef, repeats pinned discovery, and resolves rotations without disclosure', async () => {
  const storage = serviceFixture();
  const transport = adapterFixture();
  const service = new InfluxDb3EnterpriseConnectionService({ ...storage, deviceId: 'device-a', adapter: transport.adapter });
  const created = await service.create('workspace-a', 'actor-a', { name: 'Production Enterprise', host: 'enterprise.example.com', token: TOKEN });
  assert.deepEqual(created.secretRefIds, [SECRET_REF_ID]);
  assert.deepEqual(created.workerAffinity, ['device:device-a']);
  assert.equal(created.endpoint.adminTokenSecretRefId, undefined);
  assert.equal(storage.secretRefs.get(SECRET_REF_ID).scope, 'device');
  assert.equal(JSON.stringify(created).includes(TOKEN), false);
  await assert.rejects(service.discover('workspace-a', created.id), /Test the InfluxDB 3 Enterprise connection successfully/);
  const tested = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.endpoint.expectedNodeId, NODE_ID);
  assert.equal(tested.connection.endpoint.expectedNodeCatalogId, 7);
  assert.equal(tested.connection.influxdb3EnterpriseInventory.capabilities.nativeBackupAvailable, true);
  assert.equal(storage.markedValidated(), 1);
  assert.equal(storage.resolved(), 6);
  assert.equal(JSON.stringify([...storage.connections.values()]).includes(TOKEN), false);
  const fingerprint = tested.connection.endpoint.expectedDeploymentFingerprint;
  storage.secrets.set(SECRET_REF_ID, ROTATED_TOKEN);
  const discovery = await service.discover('workspace-a', created.id);
  assert.equal(discovery.deploymentFingerprint, fingerprint);
  assert.equal(transport.resolvedTokens.slice(-3).every((value) => value === ROTATED_TOKEN), true);
  assert.equal(JSON.stringify(discovery).includes(ROTATED_TOKEN), false);
  const otherDevice = new InfluxDb3EnterpriseConnectionService({ ...storage, deviceId: 'device-b', adapter: transport.adapter });
  await assert.rejects(otherDevice.discover('workspace-a', created.id), /belongs to another device/);
});

test('deletes newly-created token ciphertext when connection persistence fails without echoing it', async () => {
  const storage = serviceFixture({ failTransaction: true });
  const service = new InfluxDb3EnterpriseConnectionService({ ...storage, deviceId: 'device-a', adapter: adapterFixture().adapter });
  await assert.rejects(service.create('workspace-a', 'actor-a', { name: 'Broken Enterprise', host: 'enterprise.example.com', token: TOKEN }), (error) => {
    assert.equal(error.code, 'INFLUXDB3_ENTERPRISE_CONNECTION_CREATE_FAILED');
    return !String(error).includes(TOKEN);
  });
  assert.deepEqual(storage.deleted, [SECRET_REF_ID]);
  assert.equal(storage.secrets.size, 0);
  assert.equal(JSON.stringify([...storage.secretRefs.values()]).includes(TOKEN), false);
});
