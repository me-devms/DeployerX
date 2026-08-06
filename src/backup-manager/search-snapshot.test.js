const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseAdapterError, DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  SearchSnapshotAdapter,
  SearchSnapshotConnectionService,
  authorizationHeader,
  detectProduct,
  normalizeConfig,
  normalizeRepositories,
  parseVersion,
  safeApiPath
} = require('./search-snapshot');

const CREDENTIAL = 'search-secret-value';

function connectionConfig(overrides = {}) {
  return {
    host: 'search01.example.com',
    port: 9200,
    authMode: 'basic',
    username: 'backup-user',
    credentialSecretRefId: 'sec_search123',
    tlsMode: 'verify-identity',
    expectedProduct: 'auto',
    ...overrides
  };
}

function elasticResponses(overrides = {}) {
  return {
    '/': {
      headers: { 'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch' },
      body: { name: 'es-node-1', cluster_name: 'production-search', cluster_uuid: 'cluster-elastic-001', version: { number: '9.1.2', build_flavor: 'default' }, tagline: 'You Know, for Search' }
    },
    '/_cluster/health': { body: { cluster_name: 'production-search', status: 'green', timed_out: false, number_of_nodes: 3, number_of_data_nodes: 2, active_primary_shards: 12, initializing_shards: 0, unassigned_shards: 0 } },
    '/_snapshot/_all': {
      body: {
        archive: { type: 's3', settings: { bucket: 'search-backups', base_path: 'prod', readonly: 'false', client: 'backup', password: 'must-not-escape', endpoint: 'https://storage.example.com' } },
        migration: { type: 'url', settings: { url: 'https://reader.example.com/snapshots', readonly: 'true' } }
      }
    },
    '/_snapshot/_status': { body: { snapshots: [] } },
    '/_cluster/state/blocks': { body: { cluster_uuid: 'cluster-elastic-001', blocks: {} } },
    '/_resolve/index/*': {
      body: {
        indices: [
          { name: 'orders', aliases: ['orders-current'], attributes: ['open'] },
          { name: '.ds-logs-2026.08.04-000001', aliases: [], attributes: ['open', 'hidden'], data_stream: 'logs' },
          { name: '.security-9', aliases: [], attributes: ['open', 'hidden'] }
        ],
        aliases: [],
        data_streams: [{ name: 'logs', backing_indices: ['.ds-logs-2026.08.04-000001'], timestamp_field: '@timestamp' }]
      }
    },
    '/_all/_settings/index.uuid,index.creation_date,index.number_of_shards,index.hidden': {
      body: {
        orders: { settings: { 'index.uuid': 'uuid-orders', 'index.creation_date': '1785801600000', 'index.number_of_shards': '2', 'index.hidden': 'false' } },
        '.ds-logs-2026.08.04-000001': { settings: { 'index.uuid': 'uuid-logs-000001', 'index.creation_date': '1785801600000', 'index.number_of_shards': '1', 'index.hidden': 'true' } },
        '.security-9': { settings: { 'index.uuid': 'uuid-security', 'index.creation_date': '1785801600000', 'index.number_of_shards': '1', 'index.hidden': 'true' } }
      }
    },
    '/_snapshot/archive/_verify': { body: { nodes: { 'node-1': { name: 'es-node-1' }, 'node-2': { name: 'es-node-2' } } } },
    '/_features': { body: { features: [{ name: 'security', description: 'Security configuration' }, { name: 'kibana', description: 'Kibana saved objects' }] } },
    ...overrides
  };
}

function openSearchResponses(overrides = {}) {
  const responses = elasticResponses();
  responses['/'] = {
    headers: { 'content-type': 'application/json' },
    body: { name: 'os-node-1', cluster_name: 'logs-search', cluster_uuid: 'cluster-opensearch-001', version: { distribution: 'opensearch', number: '3.7.0' }, tagline: 'The OpenSearch Project: https://opensearch.org/' }
  };
  responses['/_cluster/health'] = { body: { cluster_name: 'logs-search', status: 'yellow', timed_out: false, number_of_nodes: 2, number_of_data_nodes: 2, active_primary_shards: 8, initializing_shards: 0, unassigned_shards: 1 } };
  responses['/_cluster/state/blocks'] = { body: { cluster_uuid: 'cluster-opensearch-001', blocks: {} } };
  delete responses['/_features'];
  return { ...responses, ...overrides };
}

class Transport {
  constructor(responses = elasticResponses()) {
    this.responses = responses;
    this.calls = [];
  }

  async request(input) {
    this.calls.push(input);
    const response = this.responses[input.apiPath];
    if (!response) throw new Error(`Unexpected search request: ${input.apiPath}`);
    if (response.error) throw response.error;
    return { statusCode: 200, headers: { 'content-type': 'application/json', ...(response.headers || {}) }, body: response.body };
  }
}

test('normalizes only verified-HTTPS search connection settings', () => {
  const normalized = normalizeConfig(connectionConfig({ basePath: '/managed/cluster-a', clientCertificateFile: 'C:\\certs\\client.crt', clientKeyFile: 'C:\\certs\\client.key' }));
  assert.equal(normalized.host, 'search01.example.com');
  assert.equal(normalized.basePath, '/managed/cluster-a');
  assert.equal(safeApiPath(normalized, '/_snapshot/_all', { filter_path: 'name,type' }), '/managed/cluster-a/_snapshot/_all?filter_path=name%2Ctype');
  assert.throws(() => normalizeConfig(connectionConfig({ host: 'https://search.example.com' })), /without a URI scheme/);
  assert.throws(() => normalizeConfig(connectionConfig({ tlsMode: 'disabled' })), /TLS certificate identity verification/);
  assert.throws(() => normalizeConfig(connectionConfig({ basePath: '/../admin' })), /base path is invalid/);
  assert.throws(() => normalizeConfig(connectionConfig({ authMode: 'bearer', username: 'backup-user' })), /only valid with Basic/);
  assert.throws(() => normalizeConfig(connectionConfig({ clientCertificateFile: 'C:\\certs\\client.crt' })), /both a client certificate/);
});

test('detects supported Elasticsearch and OpenSearch identities and rejects other products', () => {
  assert.equal(detectProduct(elasticResponses()['/'].body, elasticResponses()['/'].headers), 'elasticsearch');
  assert.equal(detectProduct(openSearchResponses()['/'].body, openSearchResponses()['/'].headers), 'opensearch');
  assert.equal(parseVersion('7.17.28', 'elasticsearch').major, 7);
  assert.equal(parseVersion('3.7.0', 'opensearch').major, 3);
  assert.throws(() => parseVersion('7.16.2', 'elasticsearch'), (error) => error.code === 'SEARCH_VERSION_UNSUPPORTED');
  assert.throws(() => parseVersion('4.0.0', 'opensearch'), (error) => error.code === 'SEARCH_VERSION_UNSUPPORTED');
  assert.throws(() => detectProduct({ version: { number: '1.0.0' }, tagline: 'Unknown service' }, {}), (error) => error.code === 'SEARCH_PRODUCT_UNSUPPORTED');
});

test('passes credentials only through the authorization header and returns bounded identity', async () => {
  const transport = new Transport();
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z', now: () => 10 });
  const result = await adapter.testConnection({ resolveSecret: async () => CREDENTIAL }, connectionConfig());
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.product, 'elasticsearch');
  assert.equal(result.endpointIdentity.clusterUuid, 'cluster-elastic-001');
  assert.equal(result.endpointIdentity.repositoryCount, 2);
  assert.match(result.endpointIdentity.deploymentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes(CREDENTIAL), false);
  assert.equal(transport.calls.length, 5);
  for (const call of transport.calls) {
    assert.equal(call.authorization, authorizationHeader(normalizeConfig(connectionConfig()), CREDENTIAL));
    assert.equal(JSON.stringify({ config: call.config, apiPath: call.apiPath, query: call.query }).includes(CREDENTIAL), false);
  }
});

test('supports OpenSearch discovery while preserving yellow health as a warning', async () => {
  const transport = new Transport(openSearchResponses());
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z', now: () => 20 });
  const result = await adapter.testConnection({ resolveSecret: async () => CREDENTIAL }, connectionConfig({ expectedProduct: 'opensearch' }));
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.product, 'opensearch');
  assert.equal(result.endpointIdentity.health, 'yellow');
  assert.equal(result.checks.find((check) => check.id === 'cluster-health').status, 'warning');
  assert.equal(result.endpointIdentity.featureStatesSupported, false);
});

test('refuses changed product or cluster identity before discovery succeeds', async () => {
  const transport = new Transport();
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport) });
  const product = await adapter.testConnection({ resolveSecret: async () => CREDENTIAL }, connectionConfig({ expectedProduct: 'opensearch' }));
  assert.equal(product.status, 'failure');
  assert.equal(product.error.code, 'SEARCH_PRODUCT_MISMATCH');
  const cluster = await adapter.testConnection({ resolveSecret: async () => CREDENTIAL }, connectionConfig({ expectedClusterUuid: 'different-cluster' }));
  assert.equal(cluster.status, 'failure');
  assert.equal(cluster.error.code, 'SEARCH_CLUSTER_IDENTITY_CHANGED');
});

test('discovers safe repository metadata without leaking secure settings', async () => {
  const transport = new Transport();
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport) });
  const pages = [];
  for await (const page of adapter.discover({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), kind: 'repositories' })) pages.push(page);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].items.map((item) => [item.name, item.type, item.readOnly, item.selectable]), [
    ['archive', 's3', false, true],
    ['migration', 'url', true, false]
  ]);
  assert.match(pages[0].items[0].repositoryFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(pages[0].items[0].settingsKeys.includes('password'), false);
  assert.equal(JSON.stringify(pages).includes('must-not-escape'), false);
});

test('discovers Elasticsearch feature states and refuses them on OpenSearch', async () => {
  const elasticTransport = new Transport();
  const elasticAdapter = new SearchSnapshotAdapter({ transport: elasticTransport.request.bind(elasticTransport) });
  const pages = [];
  for await (const page of elasticAdapter.discover({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), kind: 'features' })) pages.push(page);
  assert.deepEqual(pages[0].items.map((item) => item.name), ['kibana', 'security']);
  const openSearchTransport = new Transport(openSearchResponses());
  const openSearchAdapter = new SearchSnapshotAdapter({ transport: openSearchTransport.request.bind(openSearchTransport) });
  await assert.rejects(async () => {
    for await (const _page of openSearchAdapter.discover({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig({ expectedProduct: 'opensearch' }), kind: 'features' })) {}
  }, (error) => error.code === 'SEARCH_FEATURE_STATES_UNAVAILABLE');
});

test('discovers exact regular indices, data streams, UUIDs, and excluded system resources', async () => {
  const transport = new Transport();
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport) });
  const pages = [];
  for await (const page of adapter.discover({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), kind: 'resources' })) pages.push(page);
  const orders = pages[0].items.find((item) => item.name === 'orders');
  const logs = pages[0].items.find((item) => item.name === 'logs');
  const security = pages[0].items.find((item) => item.name === '.security-9');
  assert.equal(orders.uuid, 'uuid-orders');
  assert.equal(orders.primaryShards, 2);
  assert.deepEqual(orders.aliases, ['orders-current']);
  assert.equal(logs.kind, 'search-data-stream');
  assert.deepEqual(logs.backingIndices, ['.ds-logs-2026.08.04-000001']);
  assert.equal(security.selectable, false);
  assert.equal(security.state, 'feature-state-required');
});

test('verifies a writable repository on cluster nodes and refuses read-only repositories', async () => {
  const transport = new Transport();
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z' });
  const verification = await adapter.verifyRepository({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), repositoryName: 'archive' });
  assert.equal(verification.repositoryName, 'archive');
  assert.equal(verification.verificationNodeCount, 2);
  assert.equal(verification.writerClusterUuid, 'cluster-elastic-001');
  assert.match(verification.repositoryFingerprint, /^sha256:/);
  await assert.rejects(adapter.verifyRepository({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), repositoryName: 'migration' }), (error) => error.code === 'SEARCH_REPOSITORY_READ_ONLY');
});

test('registers native snapshot backup and alternate-target restore execution', async () => {
  const adapter = new SearchSnapshotAdapter({ transport: new Transport().request });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const manifest = registry.manifest(ADAPTER_ID);
  assert.equal(manifest.executionReady, true);
  assert.deepEqual(manifest.capabilities.backupModes, ['native']);
  assert.deepEqual(manifest.capabilities.consistencyStrategies.map((item) => item.id), ['search-native-snapshot']);
  assert.equal(manifest.capabilities.restore.alternateTarget, true);
  assert.equal(manifest.capabilities.restore.nativeValidation, true);
});

function successfulSnapshot(snapshot, metadata, overrides = {}) {
  return {
    snapshots: [{
      snapshot,
      uuid: 'snapshot-uuid-001',
      state: 'SUCCESS',
      version: '9.1.2',
      indices: ['orders'],
      data_streams: [],
      feature_states: [],
      include_global_state: false,
      metadata,
      shards: { total: 2, successful: 2, failed: 0 },
      start_time_in_millis: 1785801600000,
      end_time_in_millis: 1785801660000,
      failures: [],
      ...overrides
    }]
  };
}

class SnapshotTransport extends Transport {
  constructor(options = {}) {
    super(elasticResponses());
    this.snapshotReads = 0;
    this.snapshotDeleted = false;
    this.createBody = null;
    this.options = options;
  }

  async request(input) {
    this.calls.push(input);
    if (input.apiPath.startsWith('/_snapshot/archive/deployerx-')) {
      if (input.method === 'PUT') {
        this.createBody = input.body;
        return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { accepted: true } };
      }
      if (input.method === 'DELETE') {
        this.snapshotDeleted = true;
        return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { acknowledged: true } };
      }
      if (this.snapshotDeleted) throw new DatabaseAdapterError('SEARCH_API_UNAVAILABLE', 'Snapshot is absent.', { category: 'connectivity' });
      this.snapshotReads += 1;
      const metadata = {
        deployerx_run_id: this.options.executionId || 'run-search-001',
        deployerx_plan_digest: this.options.planDigest,
        deployerx_adapter: ADAPTER_ID,
        deployerx_snapshot_plan: this.options.snapshotPlanFingerprint,
        deployerx_source_id: 'source-search'
      };
      const state = this.options.state || (this.snapshotReads === 1 && this.options.inProgressFirst ? 'IN_PROGRESS' : 'SUCCESS');
      if (this.options.abortController && this.snapshotReads === 1) queueMicrotask(() => this.options.abortController.abort());
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: successfulSnapshot(input.apiPath.split('/').at(-1), metadata, { state, shards: this.options.shards || { total: 2, successful: 2, failed: 0 }, failures: this.options.failures || [] }) };
    }
    const response = this.responses[input.apiPath];
    if (!response) throw new Error(`Unexpected search request: ${input.apiPath}`);
    return { statusCode: 200, headers: { 'content-type': 'application/json', ...(response.headers || {}) }, body: response.body };
  }
}

async function prepareSnapshot(adapter, transport, executionId = 'run-search-001') {
  const identity = await adapter.readIdentity({ resolveSecret: async () => CREDENTIAL }, connectionConfig());
  const repository = identity.repositories.find((item) => item.name === 'archive');
  const registry = new DatabaseAdapterRegistry([adapter]);
  const prepared = await registry.prepareBackup(ADAPTER_ID, { resolveSecret: async () => CREDENTIAL }, {
    connection: connectionConfig({ expectedProduct: 'elasticsearch', expectedClusterUuid: 'cluster-elastic-001' }),
    selector: { allDatabases: false, databases: { include: [{ name: 'orders' }] } },
    consistency: { requestedLevel: 'crash', method: 'search-native-snapshot', backupMethod: 'physical', backupMode: 'native', captureCoordinates: true },
    execution: { repositoryName: 'archive', repositoryFingerprint: repository.repositoryFingerprint, includeGlobalState: false, featureStates: [], executionId, sourceId: 'source-search' }
  });
  transport.options.executionId = executionId;
  transport.options.planDigest = prepared.planDigest;
  transport.options.snapshotPlanFingerprint = prepared.adapterPlan.snapshotPlanFingerprint;
  return prepared;
}

test('publishes only an exact successful native snapshot with all primary shards', async () => {
  const transport = new SnapshotTransport({ inProgressFirst: true });
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z', now: (() => { let value = 0; return () => value += 100; })(), delay: async () => {} });
  const prepared = await prepareSnapshot(adapter, transport);
  const owners = [];
  const result = await adapter.executeBackup({ resolveSecret: async () => CREDENTIAL, planDigest: prepared.planDigest, onOwnership: async (owner) => owners.push(owner) }, prepared.adapterPlan);
  assert.equal(result.snapshot.state, 'SUCCESS');
  assert.equal(result.snapshot.shards.successful, 2);
  assert.deepEqual(result.selectedResources.map((item) => item.name), ['orders']);
  assert.equal(result.snapshotSemantics.physicallyIncremental, true);
  assert.equal(transport.createBody.partial, false);
  assert.equal(transport.createBody.indices, 'orders');
  assert.equal(owners[0].snapshotName, prepared.adapterPlan.snapshotName);
  assert.equal(owners.at(-1), null);
  assert.equal(transport.snapshotDeleted, false);
});

test('cancellation deletes only the exactly owned in-progress snapshot', async () => {
  const controller = new AbortController();
  const transport = new SnapshotTransport({ state: 'IN_PROGRESS', abortController: controller, executionId: 'run-search-cancel' });
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z', now: (() => { let value = 0; return () => value += 100; })(), delay: async () => {} });
  const prepared = await prepareSnapshot(adapter, transport, 'run-search-cancel');
  const owners = [];
  await assert.rejects(adapter.executeBackup({ resolveSecret: async () => CREDENTIAL, signal: controller.signal, planDigest: prepared.planDigest, onOwnership: async (owner) => owners.push(owner) }, prepared.adapterPlan), (error) => error.code === 'SEARCH_OPERATION_CANCELED');
  assert.equal(transport.snapshotDeleted, true);
  assert.equal(owners.at(-1), null);
});

test('partial shard success refuses publication and removes the owned snapshot', async () => {
  const transport = new SnapshotTransport({ shards: { total: 2, successful: 1, failed: 1 }, failures: [{ reason: 'unsafe raw detail' }] });
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z', now: () => 100, delay: async () => {} });
  const prepared = await prepareSnapshot(adapter, transport);
  await assert.rejects(adapter.executeBackup({ resolveSecret: async () => CREDENTIAL, planDigest: prepared.planDigest }, prepared.adapterPlan), (error) => error.code === 'SEARCH_SNAPSHOT_SHARDS_INCOMPLETE');
  assert.equal(transport.snapshotDeleted, true);
});

function recoveryMetadata() {
  const discoveredRepository = normalizeRepositories(elasticResponses()['/_snapshot/_all'].body).find((item) => item.name === 'archive');
  const repository = { ...discoveredRepository, repositoryName: discoveredRepository.name };
  return {
    kind: 'search-native-snapshot', adapterId: ADAPTER_ID, product: 'elasticsearch', serverVersion: '9.1.2',
    clusterUuid: 'cluster-elastic-001', repository,
    snapshot: { name: 'deployerx-20260804t000000z-1234567890abcdef1234', uuid: 'snapshot-uuid-001', state: 'SUCCESS', version: '9.1.2', shards: { total: 2, successful: 2, failed: 0 } },
    selectedResources: [{ kind: 'search-index', name: 'orders', uuid: 'uuid-orders', primaryShards: 2, aliases: ['orders-current'], hidden: false, system: false, closed: false, selectable: true, state: 'available' }],
    featureStates: [], includeGlobalState: false, planDigest: 'sha256:recovery-plan'
  };
}

class RecoveryTransport extends Transport {
  constructor({ conflict = false, product = 'elasticsearch', target = true } = {}) {
    const responses = product === 'opensearch' ? openSearchResponses() : elasticResponses();
    const clusterUuid = target ? 'cluster-restore-002' : 'cluster-elastic-001';
    responses['/'].body = {
      ...(responses['/'].body || {}), cluster_uuid: clusterUuid, cluster_name: target ? 'alternate-search' : 'production-search'
    };
    responses['/_cluster/state/blocks'].body = { cluster_uuid: clusterUuid, blocks: {} };
    responses['/_snapshot/_all'].body.archive.settings.readonly = target ? 'true' : 'false';
    super(responses);
    this.conflict = conflict;
    this.deleted = false;
    this.restoreBody = null;
  }

  async request(input) {
    this.calls.push(input);
    const metadata = recoveryMetadata();
    const snapshotPath = `/_snapshot/archive/${metadata.snapshot.name}`;
    if (input.apiPath === snapshotPath) {
      if (input.method === 'DELETE') {
        this.deleted = true;
        return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { acknowledged: true } };
      }
      if (this.deleted) throw new DatabaseAdapterError('SEARCH_API_UNAVAILABLE', 'Snapshot is absent.', { category: 'connectivity' });
      return {
        statusCode: 200, headers: { 'content-type': 'application/json' },
        body: successfulSnapshot(metadata.snapshot.name, { deployerx_run_id: 'run-search-retention', deployerx_source_id: 'source-search', deployerx_plan_digest: metadata.planDigest, deployerx_adapter: ADAPTER_ID })
      };
    }
    if (input.apiPath === `${snapshotPath}/_restore`) {
      this.restoreBody = structuredClone(input.body);
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { accepted: true } };
    }
    if (input.apiPath.startsWith('/_resolve/index/dxr-')) {
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: this.conflict ? { indices: [{ name: 'dxr-test-orders' }], aliases: [], data_streams: [] } : { indices: [], aliases: [], data_streams: [] } };
    }
    if (input.apiPath.startsWith('/_cluster/health/dxr-')) {
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { cluster_name: 'alternate-search', status: 'green', timed_out: false, number_of_nodes: 2, number_of_data_nodes: 2, active_primary_shards: 2, initializing_shards: 0, unassigned_shards: 0 } };
    }
    if (input.apiPath === '/_resolve/index/*') {
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { indices: [{ name: 'dxr-test-orders', aliases: ['dxr-test-orders-current'], attributes: ['open'] }], aliases: [], data_streams: [] } };
    }
    if (input.apiPath === '/_all/_settings/index.uuid,index.creation_date,index.number_of_shards,index.hidden') {
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { 'dxr-test-orders': { settings: { 'index.uuid': 'restored-orders-uuid', 'index.creation_date': '1785801700000', 'index.number_of_shards': '2', 'index.hidden': 'false' } } } };
    }
    if (input.apiPath === '/_snapshot/archive/_cleanup') {
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { results: { deleted_bytes: 4096, deleted_blobs: 3 } } };
    }
    const response = this.responses[input.apiPath];
    if (!response) throw new Error(`Unexpected search request: ${input.apiPath}`);
    return { statusCode: 200, headers: { 'content-type': 'application/json', ...(response.headers || {}) }, body: response.body };
  }
}

test('native retention deletes only an exact recovery-point-owned snapshot on the writer cluster', async () => {
  const transport = new RecoveryTransport({ target: false });
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T01:00:00.000Z' });
  const identity = await adapter.readIdentity({ resolveSecret: async () => CREDENTIAL }, connectionConfig({ expectedProduct: 'elasticsearch', expectedClusterUuid: 'cluster-elastic-001' }));
  assert.equal(identity.repositories.find((item) => item.name === 'archive').locationIdentity, recoveryMetadata().repository.locationIdentity);
  const result = await adapter.deleteRecoverySnapshot({ resolveSecret: async () => CREDENTIAL }, {
    connection: connectionConfig({ expectedProduct: 'elasticsearch', expectedClusterUuid: 'cluster-elastic-001' }), metadata: recoveryMetadata(),
    owner: { workspaceId: null, sourceId: 'source-search', executionId: 'run-search-retention' }
  });
  assert.equal(result.deleted, true);
  assert.equal(transport.deleted, true);
  const foreign = new RecoveryTransport({ target: false });
  const foreignAdapter = new SearchSnapshotAdapter({ transport: foreign.request.bind(foreign) });
  await assert.rejects(foreignAdapter.deleteRecoverySnapshot({ resolveSecret: async () => CREDENTIAL }, {
    connection: connectionConfig({ expectedProduct: 'elasticsearch', expectedClusterUuid: 'cluster-elastic-001' }), metadata: recoveryMetadata(), owner: { sourceId: 'other-source', executionId: 'run-search-retention' }
  }), (error) => error.code === 'SEARCH_RECOVERY_SNAPSHOT_OWNERSHIP_CHANGED');
  assert.equal(foreign.deleted, false);
});

test('guarded native repository cleanup requires confirmation and fresh verification', async () => {
  const transport = new RecoveryTransport({ target: false });
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T01:00:00.000Z' });
  const fingerprint = recoveryMetadata().repository.repositoryFingerprint;
  await assert.rejects(adapter.cleanupRepository({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), repositoryName: 'archive', repositoryFingerprint: fingerprint }), (error) => error.code === 'SEARCH_REPOSITORY_CLEANUP_CONFIRMATION_REQUIRED');
  const result = await adapter.cleanupRepository({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), repositoryName: 'archive', repositoryFingerprint: fingerprint, confirmationText: 'CLEANUP SEARCH REPOSITORY' });
  assert.deepEqual({ deletedBytes: result.deletedBytes, deletedBlobs: result.deletedBlobs }, { deletedBytes: 4096, deletedBlobs: 3 });
});

test('plans, executes, and validates a conflict-free alternate Elasticsearch restore', async () => {
  const transport = new RecoveryTransport();
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T01:00:00.000Z', now: () => 1000, delay: async () => {} });
  const context = { resolveSecret: async () => CREDENTIAL, owner: { sourceId: 'source-search', executionId: 'run-search-retention' } };
  const plan = await adapter.planRestore(context, { connection: connectionConfig({ expectedProduct: 'elasticsearch', expectedClusterUuid: 'cluster-restore-002' }), metadata: recoveryMetadata(), renamePrefix: 'dxr-test-', owner: context.owner });
  assert.deepEqual(plan.preview.map((item) => item.targetName), ['dxr-test-orders']);
  assert.equal(plan.includeGlobalState, false);
  const result = await adapter.executeRestore(context, plan);
  assert.equal(result.state, 'succeeded');
  assert.equal(transport.restoreBody.include_global_state, false);
  assert.equal(transport.restoreBody.rename_replacement, 'dxr-test-$1');
  const validation = await adapter.validateRestore(context, { plan, result });
  assert.equal(validation.nativeIntegrityValidation, true);
  assert.equal(validation.expectedObjects, 'pass');
  assert.deepEqual(validation.restoredResources.map((item) => item.targetName), ['dxr-test-orders']);
});

test('alternate restore refuses target conflicts, writable repositories, and cross-product targets before mutation', async () => {
  const metadata = recoveryMetadata();
  const conflict = new RecoveryTransport({ conflict: true });
  const conflictAdapter = new SearchSnapshotAdapter({ transport: conflict.request.bind(conflict) });
  await assert.rejects(conflictAdapter.planRestore({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig({ expectedClusterUuid: 'cluster-restore-002' }), metadata, renamePrefix: 'dxr-test-', owner: { sourceId: 'source-search', executionId: 'run-search-retention' } }), (error) => error.code === 'SEARCH_RESTORE_TARGET_CONFLICT');
  assert.equal(conflict.restoreBody, null);
  const writable = new RecoveryTransport({ target: false });
  const writableAdapter = new SearchSnapshotAdapter({ transport: writable.request.bind(writable) });
  await assert.rejects(writableAdapter.planRestore({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig(), metadata, renamePrefix: 'dxr-test-', owner: { sourceId: 'source-search', executionId: 'run-search-retention' } }), (error) => ['SEARCH_RESTORE_REPOSITORY_WRITABLE', 'SEARCH_RESTORE_TARGET_NOT_ALTERNATE'].includes(error.code));
  const openSearch = new RecoveryTransport({ product: 'opensearch' });
  const openSearchAdapter = new SearchSnapshotAdapter({ transport: openSearch.request.bind(openSearch) });
  await assert.rejects(openSearchAdapter.planRestore({ resolveSecret: async () => CREDENTIAL }, { connection: connectionConfig({ expectedProduct: 'opensearch', expectedClusterUuid: 'cluster-restore-002' }), metadata, renamePrefix: 'dxr-test-', owner: { sourceId: 'source-search', executionId: 'run-search-retention' } }), (error) => error.code === 'SEARCH_RESTORE_PRODUCT_INCOMPATIBLE');
  assert.equal(openSearch.restoreBody, null);
});

function serviceFixture() {
  const connections = new Map();
  const secretRefs = new Map();
  const deletedSecrets = [];
  const connectionRepository = {
    list: async () => [...connections.values()],
    get: async (_workspaceId, id) => connections.get(id) || null,
    update: async (_workspaceId, id, patch, options) => {
      const current = connections.get(id);
      assert.equal(options.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      connections.set(id, updated);
      return updated;
    }
  };
  const secretRepository = {
    get: async (_workspaceId, id) => secretRefs.get(id) || null,
    update: async (_workspaceId, id, patch, options) => {
      const current = secretRefs.get(id);
      assert.equal(options.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      secretRefs.set(id, updated);
      return updated;
    }
  };
  const controlDatabase = {
    repository: (name) => name === 'connection' ? connectionRepository : secretRepository,
    transaction: async (callback) => callback({
      create: (name, input) => {
        if (name === 'secretRef') {
          const record = { ...input, revision: 1 };
          secretRefs.set(record.id, record);
          return record;
        }
        const record = { ...input, id: 'connection-search', revision: 1 };
        connections.set(record.id, record);
        return record;
      }
    })
  };
  const secretStore = {
    create: async (input) => ({ id: 'sec_search123', workspaceId: input.workspaceId, name: input.name, provider: 'local-safe-storage', scope: input.scope, providerKey: 'search-key', secretType: input.secretType, version: 1 }),
    resolve: async () => CREDENTIAL,
    markValidated: async () => ({ lastValidatedAt: '2026-08-04T00:00:00.000Z' }),
    delete: async ({ id }) => deletedSecrets.push(id)
  };
  return { connections, deletedSecrets, controlDatabase, secretStore };
}

test('persists only a device-scoped SecretRef and pins product plus cluster identity after testing', async () => {
  const fixture = serviceFixture();
  const transport = new Transport();
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z', now: () => 0 });
  const service = new SearchSnapshotConnectionService({ ...fixture, deviceId: 'device-a', adapter });
  const created = await service.create('workspace-a', 'actor-a', { name: 'Production Search', host: 'search01.example.com', username: 'backup-user', credential: CREDENTIAL, tlsMode: 'verify-identity', expectedProduct: 'auto' });
  assert.equal(created.adapterId, ADAPTER_ID);
  assert.deepEqual(created.secretRefIds, ['sec_search123']);
  assert.equal(created.endpoint.credential, undefined);
  assert.equal(JSON.stringify(created).includes(CREDENTIAL), false);
  await assert.rejects(service.discover('workspace-a', created.id), /Test the search snapshot connection successfully/);
  const tested = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.endpoint.expectedProduct, 'elasticsearch');
  assert.equal(tested.connection.endpoint.expectedClusterUuid, 'cluster-elastic-001');
  assert.match(tested.connection.trust.fingerprint, /^sha256:/);
  const verified = await service.verifyRepository('workspace-a', created.id, 'archive', 'actor-a');
  assert.equal(verified.verification.verificationNodeCount, 2);
  assert.equal(verified.connection.repositoryTrusts[0].repositoryName, 'archive');
  const discovered = await service.discover('workspace-a', created.id, { kind: 'repositories' });
  assert.deepEqual(discovered.items.map((item) => item.name), ['archive', 'migration']);
  assert.equal((await service.list('workspace-a'))[0].currentDevice, true);
  assert.equal(fixture.deletedSecrets.length, 0);
  assert.equal(JSON.stringify([...fixture.connections.values()]).includes(CREDENTIAL), false);
});
