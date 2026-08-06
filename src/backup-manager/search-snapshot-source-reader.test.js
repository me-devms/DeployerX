const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterError, DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { ADAPTER_ID, SearchSnapshotAdapter, SearchSnapshotConnectionService } = require('./search-snapshot');
const { SearchSnapshotSourceReaderService, preparationPrefix } = require('./search-snapshot-source-reader');

const CREDENTIAL = 'source-reader-search-secret';

class LifecycleTransport {
  constructor() {
    this.calls = [];
    this.created = null;
    this.deleted = false;
  }

  async request(input) {
    this.calls.push({ apiPath: input.apiPath, method: input.method, authenticated: /^Basic /.test(input.authorization || '') });
    if (input.apiPath.startsWith('/_snapshot/archive/deployerx-')) {
      if (input.method === 'PUT') {
        this.created = { name: input.apiPath.split('/').at(-1), body: structuredClone(input.body) };
        return this.#response({ accepted: true });
      }
      if (input.method === 'DELETE') {
        this.deleted = true;
        return this.#response({ acknowledged: true });
      }
      if (this.deleted) {
        throw new DatabaseAdapterError('SEARCH_API_UNAVAILABLE', 'Snapshot is absent.', { category: 'connectivity' });
      }
      if (!this.created) throw new Error('Snapshot was queried before creation.');
      return this.#response({
        snapshots: [{
          snapshot: this.created.name,
          uuid: 'native-snapshot-uuid',
          state: 'SUCCESS',
          version: '9.1.2',
          indices: ['orders'],
          data_streams: [],
          feature_states: [],
          include_global_state: false,
          metadata: this.created.body.metadata,
          shards: { total: 2, successful: 2, failed: 0 },
          start_time_in_millis: 1785801600000,
          end_time_in_millis: 1785801660000,
          failures: []
        }]
      });
    }
    const responses = {
      '/': { cluster_name: 'source-reader-search', cluster_uuid: 'source-reader-cluster-001', version: { number: '9.1.2', build_flavor: 'default' }, tagline: 'You Know, for Search' },
      '/_cluster/health': { cluster_name: 'source-reader-search', status: 'green', timed_out: false, number_of_nodes: 3, number_of_data_nodes: 2, active_primary_shards: 2, initializing_shards: 0, unassigned_shards: 0 },
      '/_snapshot/_all': { archive: { type: 's3', settings: { bucket: 'source-reader-backups', base_path: 'production', readonly: 'false' } } },
      '/_snapshot/_status': { snapshots: [] },
      '/_cluster/state/blocks': { cluster_uuid: 'source-reader-cluster-001', blocks: {} },
      '/_snapshot/archive/_verify': { nodes: { 'node-1': { name: 'search-node-1' }, 'node-2': { name: 'search-node-2' } } },
      '/_resolve/index/*': { indices: [{ name: 'orders', aliases: ['orders-current'], attributes: ['open'] }], aliases: [], data_streams: [] },
      '/_all/_settings/index.uuid,index.creation_date,index.number_of_shards,index.hidden': { orders: { settings: { 'index.uuid': 'orders-uuid', 'index.creation_date': '1785801600000', 'index.number_of_shards': '2', 'index.hidden': 'false' } } }
    };
    if (!(input.apiPath in responses)) throw new Error(`Unexpected search API path: ${input.apiPath}`);
    return this.#response(responses[input.apiPath], input.apiPath === '/' ? { 'x-elastic-product': 'Elasticsearch' } : {});
  }

  #response(body, headers = {}) {
    return { statusCode: 200, headers: { 'content-type': 'application/json', ...headers }, body };
  }
}

function secretStore() {
  return {
    create: async (input) => ({ id: 'sec_searchsource123', workspaceId: input.workspaceId, name: input.name, provider: 'electron-safe-storage', scope: input.scope, providerKey: 'encrypted-search-source', secretType: input.secretType, version: 1 }),
    resolve: async () => CREDENTIAL,
    markValidated: async () => ({ lastValidatedAt: '2026-08-04T00:00:00.000Z' }),
    delete: async () => {}
  };
}

async function setup(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-search-source-reader-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const transport = new LifecycleTransport();
  const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport), clock: () => '2026-08-04T00:00:00.000Z', now: () => 1000, delay: async () => {} });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const secrets = secretStore();
  const connections = new SearchSnapshotConnectionService({ controlDatabase, secretStore: secrets, deviceId: 'device-search', adapter });
  const created = await connections.create('workspace-search', 'actor-search', { name: 'Production Search', host: 'search01.example.com', authMode: 'basic', username: 'backup-user', credential: CREDENTIAL, expectedProduct: 'auto', tlsMode: 'verify-identity' });
  const tested = await connections.test('workspace-search', created.id, 'actor-search');
  const verified = await connections.verifyRepository('workspace-search', created.id, 'archive', 'actor-search');
  const sourceService = new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, deviceId: 'device-search', clock: () => '2026-08-04T00:00:00.000Z' });
  const source = await sourceService.save('workspace-search', 'actor-search', {
    name: 'Orders Search Snapshot',
    connectionId: created.id,
    adapterId: ADAPTER_ID,
    selector: { allDatabases: false, databases: { include: [{ name: 'orders' }] }, includeGlobalObjects: false },
    consistency: { requestedLevel: 'crash', method: 'search-native-snapshot', backupMethod: 'physical', backupMode: 'native', captureCoordinates: true },
    physicalExecution: { repositoryName: 'archive', includeGlobalState: false, featureStates: [] }
  });
  const reader = new SearchSnapshotSourceReaderService({ controlDatabase, secretStore: secrets, deviceId: 'device-search', adapterRegistry: registry, adapter, temporaryRoot: path.join(root, 'staging') });
  return { root, controlDatabase, transport, adapter, registry, connections, tested, verified, source, reader };
}

test('binds a Source to a verified writable repository and rejects stale trust', async (context) => {
  const fixture = await setup(context);
  assert.equal(fixture.source.platform.engine, 'search-cluster');
  assert.equal(fixture.source.physicalExecution.repositoryName, 'archive');
  assert.equal(fixture.source.physicalExecution.clusterUuid, 'source-reader-cluster-001');
  assert.equal(fixture.source.physicalExecution.writerClusterUuid, 'source-reader-cluster-001');
  assert.match(fixture.source.physicalExecution.repositoryFingerprint, /^sha256:/);
  const connection = fixture.verified.connection;
  await fixture.controlDatabase.repository('connection').update('workspace-search', connection.id, { repositoryTrusts: [] }, { expectedRevision: connection.revision, actorId: 'actor-search' });
  await assert.rejects(fixture.reader.plan('workspace-search', fixture.source.id), (error) => error.code === 'SEARCH_REPOSITORY_TRUST_CHANGED');
});

test('creates one native snapshot and streams only authenticated DeployerX metadata', async (context) => {
  const fixture = await setup(context);
  const executionId = 'run-search-source-001';
  const files = await fixture.reader.files('workspace-search', fixture.source.id, { executionId, backupMode: 'native' });
  const entries = [];
  for await (const entry of files.create()) {
    const chunks = [];
    for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
    entries.push({ path: entry.path, metadata: entry.metadata, bytes: Buffer.concat(chunks) });
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'search/snapshot-metadata.json');
  assert.equal(entries[0].metadata.externalNativeMedia, true);
  const manifest = JSON.parse(entries[0].bytes.toString('utf8'));
  assert.equal(manifest.kind, 'search-native-snapshot');
  assert.equal(manifest.snapshot.state, 'SUCCESS');
  assert.equal(manifest.snapshot.shards.successful, 2);
  assert.deepEqual(manifest.selectedResources.map((item) => item.name), ['orders']);
  assert.equal(manifest.repository.repositoryName, 'archive');
  assert.equal(files.manifest.externalNativeMedia, true);
  assert.equal(JSON.stringify(manifest).includes(CREDENTIAL), false);
  assert.equal(fixture.transport.created.body.partial, false);
  assert.equal(fixture.transport.created.body.indices, 'orders');
  assert.equal(fixture.transport.deleted, false);
  assert.equal(await fixture.reader.release('workspace-search', executionId), true);
  const stagingEntries = await fs.readdir(path.join(fixture.root, 'staging'));
  assert.deepEqual(stagingEntries, []);
});

test('reconciles only a persisted run-owned snapshot before removing staging', async (context) => {
  const fixture = await setup(context);
  const executionId = 'run-search-reconcile-001';
  const files = await fixture.reader.files('workspace-search', fixture.source.id, { executionId, backupMode: 'native' });
  assert.equal(files.manifest.database.snapshot.state, 'SUCCESS');
  const stagingRoot = path.join(fixture.root, 'staging');
  const entries = await fs.readdir(stagingRoot, { withFileTypes: true });
  const directory = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(preparationPrefix('workspace-search', executionId)));
  assert.ok(directory);
  const ownerPath = path.join(stagingRoot, directory.name, '.owner.json');
  const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  owner.searchSnapshot = {
    version: 1,
    adapterId: ADAPTER_ID,
    clusterUuid: 'source-reader-cluster-001',
    repositoryName: 'archive',
    repositoryFingerprint: fixture.source.physicalExecution.repositoryFingerprint,
    snapshotName: fixture.transport.created.name,
    executionId,
    planDigest: fixture.transport.created.body.metadata.deployerx_plan_digest
  };
  await fs.writeFile(ownerPath, JSON.stringify(owner));
  const reconciled = await fixture.reader.reconcileRun('workspace-search', { id: executionId, sourceLease: { id: 'lease-search' } });
  assert.equal(reconciled.proven, true);
  assert.equal(reconciled.reconciledSnapshots, 1);
  assert.equal(fixture.transport.deleted, true);
  assert.equal(await fs.stat(path.join(stagingRoot, directory.name)).catch(() => null), null);
});
