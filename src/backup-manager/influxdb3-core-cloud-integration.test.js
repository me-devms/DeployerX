const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { FileSourceReaderService } = require('./file-source-reader');
const {
  ADAPTER_ID,
  AZURE_BIND_CONFIRMATION,
  CONSISTENCY_CONFIRMATIONS,
  CONSISTENCY_METHODS,
  GCS_BIND_CONFIRMATION,
  InfluxDb3CoreAdapter,
  InfluxDb3CoreConnectionService
} = require('./influxdb3-core');
const { InfluxDb3CoreAzureStore } = require('./influxdb3-core-azure');
const { InfluxDb3CoreGcsStore } = require('./influxdb3-core-gcs');
const { InfluxDb3CoreSourceReaderService } = require('./influxdb3-core-source-reader');
const { LocalFolderRepositoryAdapter, ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const { BackupSecretStore } = require('./secrets');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'influxdb3-core-cloud-device';
const NODE_ID = 'node-production-01';
const AZURE_ACCESS_KEY = Buffer.alloc(64, 7).toString('base64');
const GCS_PRIVATE_KEY_BODY = Buffer.alloc(1024, 11).toString('base64');
const GCS_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${GCS_PRIVATE_KEY_BODY.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;

function pingResponse() {
  return {
    statusCode: 200,
    headers: { 'x-influxdb-build': 'Core', 'x-influxdb-version': '3.11.0' },
    body: JSON.stringify({ version: '3.11.0', revision: 'cloud-revision', process_id: '1234' })
  };
}

function etag(body) {
  return `"${crypto.createHash('md5').update(body).digest('hex')}"`;
}

function coreObjects(prefix = 'production') {
  const root = `${prefix}/${NODE_ID}`;
  return {
    [`${root}/snapshots/0001/snapshot.parquet`]: 'snapshot-bytes',
    [`${root}/dbs/db-a/data.parquet`]: 'database-bytes',
    [`${root}/wal/0001/wal.log`]: 'wal-bytes',
    [`${root}/catalog/0001/catalog.log`]: 'catalog-bytes',
    [`${root}/_catalog_checkpoint`]: 'checkpoint-bytes',
    [`${root}/table-snapshots/db-a/derived.parquet`]: 'excluded-bytes'
  };
}

function serviceAccount() {
  return {
    type: 'service_account',
    project_id: 'deployerx-core-prod',
    private_key_id: 'a'.repeat(40),
    private_key: GCS_PRIVATE_KEY,
    client_email: 'core-backup@deployerx-core-prod.iam.gserviceaccount.com',
    client_id: '123456789012345678901',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/core-backup%40deployerx-core-prod.iam.gserviceaccount.com',
    universe_domain: 'googleapis.com'
  };
}

class MemoryAzureContainerClient {
  constructor(objects = coreObjects()) {
    this.objects = new Map(Object.entries(objects).map(([name, value]) => [name, { body: Buffer.from(value), lastModified: new Date('2026-08-05T00:00:00.000Z') }]));
    this.requests = [];
  }

  async getProperties(options = {}) {
    this.requests.push({ operation: 'container-properties', options });
    return { etag: '"container"' };
  }

  listBlobsFlat(options = {}) {
    this.requests.push({ operation: 'list', prefix: options.prefix });
    const current = this;
    return {
      byPage(settings = {}) {
        let consumed = false;
        return {
          async next() {
            if (consumed) return { done: true, value: undefined };
            consumed = true;
            const blobItems = [...current.objects.entries()]
              .filter(([name]) => name.startsWith(options.prefix || ''))
              .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
              .map(([name, value]) => ({ name, deleted: false, properties: { blobType: 'BlockBlob', contentLength: value.body.length, etag: etag(value.body), lastModified: value.lastModified } }));
            return { done: false, value: { segment: { blobItems }, continuationToken: null, marker: settings.continuationToken } };
          }
        };
      }
    };
  }

  getBlobClient(name) {
    const current = this;
    return {
      async download(_offset, _count, options = {}) {
        current.requests.push({ operation: 'download', name, ifMatch: options.conditions?.ifMatch });
        const value = current.objects.get(name);
        if (!value) {
          const error = new Error('missing');
          error.statusCode = 404;
          error.code = 'BlobNotFound';
          throw error;
        }
        const identity = etag(value.body);
        if (options.conditions?.ifMatch !== identity) {
          const error = new Error('changed');
          error.statusCode = 412;
          error.code = 'ConditionNotMet';
          throw error;
        }
        const snapshot = Buffer.from(value.body);
        return { etag: identity, contentLength: snapshot.length, readableStreamBody: (async function* body() { yield snapshot; })() };
      }
    };
  }
}

class MemoryGcsBucket {
  constructor(objects = coreObjects()) {
    this.objects = new Map();
    this.requests = [];
    this.nextGeneration = 1000000000000000000n;
    for (const [name, value] of Object.entries(objects)) this.put(name, value);
  }

  put(name, value, updated = '2026-08-05T00:00:00.000Z') {
    this.nextGeneration += 1n;
    this.objects.set(name, { body: Buffer.from(value), generation: this.nextGeneration.toString(), updated });
  }

  async getMetadata() {
    this.requests.push({ operation: 'bucket-metadata' });
    return [{ name: 'deployerx-core-prod-data' }];
  }

  async getFiles(options = {}) {
    this.requests.push({ operation: 'list', ...options });
    const files = [...this.objects.entries()]
      .filter(([name]) => name.startsWith(options.prefix || ''))
      .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
      .map(([name, value]) => ({ name, metadata: { name, size: String(value.body.length), generation: value.generation, updated: value.updated } }));
    return [files, {}, {}];
  }

  file(name) {
    const bucket = this;
    return {
      generation: null,
      createReadStream(options = {}) {
        const requestedGeneration = String(this.generation);
        bucket.requests.push({ operation: 'download', name, generation: requestedGeneration, options });
        const current = bucket.objects.get(name);
        if (!current || requestedGeneration !== current.generation) {
          const stream = new Readable({ read() {} });
          process.nextTick(() => {
            const error = new Error(current ? 'changed' : 'missing');
            error.code = 404;
            stream.destroy(error);
          });
          return stream;
        }
        const snapshot = Buffer.from(current.body);
        const stream = Readable.from([snapshot]);
        process.nextTick(() => stream.emit('response', { headers: { 'x-goog-generation': current.generation, 'content-length': String(snapshot.length) } }));
        return stream;
      }
    };
  }
}

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, '')
  };
}

const PROVIDERS = [
  {
    id: 'azure',
    label: 'Azure Blob',
    artifactKind: 'influxdb3-core-azure-full',
    confirmationText: () => AZURE_BIND_CONFIRMATION,
    secretType: 'access-key',
    privateValues: [AZURE_ACCESS_KEY],
    locatorValues: ['corestorageaccount', 'core-production-data', 'production/'],
    createInput(overrides = {}) {
      return {
        name: 'Core Azure production', protocol: 'http', allowInsecureHttp: true, host: '127.0.0.1', port: 8181,
        objectStore: 'azure', objectStoreAccountName: 'corestorageaccount', objectStoreBucket: 'core-production-data', objectStorePrefix: 'production',
        nodeId: NODE_ID, accessKey: AZURE_ACCESS_KEY, confirmationText: AZURE_BIND_CONFIRMATION, ...overrides
      };
    },
    invalidInput() { return this.createInput({ name: 'Invalid Core Azure', objectStoreBucket: 'invalid_container' }); },
    makeClient: () => new MemoryAzureContainerClient(),
    makeStore(options, client, factoryInputs) {
      return new InfluxDb3CoreAzureStore({
        ...options,
        clientFactory: async (input) => { factoryInputs.push(input); return client; }
      });
    },
    assertFactoryInput(input) {
      assert.equal(input.accountName, 'corestorageaccount');
      assert.equal(input.container, 'core-production-data');
      assert.equal(input.endpoint, 'https://corestorageaccount.blob.core.windows.net');
    }
  },
  {
    id: 'google',
    label: 'GCS',
    artifactKind: 'influxdb3-core-gcs-full',
    confirmationText: () => GCS_BIND_CONFIRMATION,
    secretType: 'private-key',
    privateValues: [GCS_PRIVATE_KEY, GCS_PRIVATE_KEY_BODY.slice(0, 64), 'core-backup@deployerx-core-prod.iam.gserviceaccount.com'],
    locatorValues: ['deployerx-core-prod-data', 'production/'],
    createInput(overrides = {}) {
      return {
        name: 'Core GCS production', protocol: 'http', allowInsecureHttp: true, host: '127.0.0.1', port: 8181,
        objectStore: 'google', objectStoreBucket: 'deployerx-core-prod-data', objectStorePrefix: 'production',
        nodeId: NODE_ID, serviceAccountJson: JSON.stringify(serviceAccount()), confirmationText: GCS_BIND_CONFIRMATION, ...overrides
      };
    },
    invalidInput() { return this.createInput({ name: 'Invalid Core GCS', objectStoreBucket: 'INVALID_BUCKET' }); },
    makeClient: () => new MemoryGcsBucket(),
    makeStore(options, client, factoryInputs) {
      return new InfluxDb3CoreGcsStore({
        ...options,
        clientFactory: async (input) => { factoryInputs.push(input); return client; }
      });
    },
    assertFactoryInput(input) {
      assert.equal(input.projectId, 'deployerx-core-prod');
      assert.equal(input.bucket, 'deployerx-core-prod-data');
      assert.equal(input.credentials.client_email, 'core-backup@deployerx-core-prod.iam.gserviceaccount.com');
      assert.equal(input.credentials.private_key, GCS_PRIVATE_KEY);
    }
  }
];

async function fixture(context, provider) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `deployerx-influxdb3-core-${provider.id}-integration-`));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const secretStore = new BackupSecretStore({ rootPath: path.join(root, 'secrets'), secureStorage: secureStorage(), isReferenced: async () => false });
  await secretStore.initialize();
  const client = provider.makeClient();
  const factoryInputs = [];
  const adapter = new InfluxDb3CoreAdapter({
    transport: async () => pingResponse(),
    clock: () => '2026-08-05T12:00:00.000Z',
    azureStoreFactory: (options) => provider.id === 'azure' ? provider.makeStore(options, client, factoryInputs) : new InfluxDb3CoreAzureStore(options),
    gcsStoreFactory: (options) => provider.id === 'google' ? provider.makeStore(options, client, factoryInputs) : new InfluxDb3CoreGcsStore(options)
  });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new InfluxDb3CoreConnectionService({ controlDatabase, secretStore, deviceId: DEVICE_ID, adapter });
  return { root, controlDatabase, secretStore, client, factoryInputs, adapter, registry, connections };
}

async function createRepository(current) {
  const repositoryRoot = path.join(current.root, 'repository');
  await fs.mkdir(repositoryRoot);
  const repository = await current.controlDatabase.repository('repository').create({
    workspaceId: WORKSPACE_ID,
    actorId: 'tester',
    name: 'Core cloud repository',
    connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID,
    adapterVersion: '1.0.0',
    engineId: ENGINE_ID,
    engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot },
    secretRefIds: [],
    encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'core-cloud-key-v1' },
    workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 23);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  return { repositoryRoot, repository, repositoryAdapter, engine, masterKey };
}

for (const provider of PROVIDERS) {
  test(`${provider.label} stores one encrypted SecretRef and authenticates bounded restorable discovery`, async (context) => {
    const current = await fixture(context, provider);
    assert.equal(typeof provider.confirmationText(), 'string');
    const created = await current.connections.create(WORKSPACE_ID, 'tester', provider.createInput());
    assert.equal(created.secretRefIds.length, 1);
    assert.equal(created.endpoint.objectStore, provider.id);
    assert.equal(created.endpoint.objectStoreCredentialSecretRefId, undefined);
    assert.equal(JSON.stringify(created.endpoint).includes(created.secretRefIds[0]), false);
    for (const privateValue of provider.privateValues) assert.equal(JSON.stringify(created).includes(privateValue), false, `Connection disclosed ${provider.label} credential material.`);

    const refsBeforeTest = await current.secretStore.list(WORKSPACE_ID);
    assert.equal(refsBeforeTest.length, 1);
    assert.equal(refsBeforeTest[0].secretType, provider.secretType);
    assert.equal(refsBeforeTest[0].lastValidatedAt, null);
    const ciphertext = await fs.readFile(path.join(current.root, 'secrets', 'secrets.json'), 'utf8');
    for (const privateValue of provider.privateValues) assert.equal(ciphertext.includes(privateValue), false, `Encrypted SecretRef file disclosed ${provider.label} credential material.`);

    const tested = await current.connections.test(WORKSPACE_ID, created.id, 'tester');
    assert.equal(tested.result.status, 'success', JSON.stringify(tested.result));
    assert.equal(tested.result.endpointIdentity.objectStore, provider.id);
    assert.equal(tested.result.endpointIdentity.restoreSupported, true);
    assert.equal(tested.connection.trust.objectStore, provider.id);
    assert.equal(tested.connection.influxdb3CoreInventory.nodes.length, 1);
    assert.equal(tested.connection.influxdb3CoreInventory.nodes[0].objectStore, provider.id);
    assert.equal(tested.connection.influxdb3CoreInventory.nodes[0].restoreSupported, true);
    assert.ok(current.factoryInputs.length >= 1);
    provider.assertFactoryInput(current.factoryInputs[0]);
    assert.ok((await current.secretStore.list(WORKSPACE_ID))[0].lastValidatedAt);

    const discovered = await current.connections.discover(WORKSPACE_ID, created.id);
    assert.equal(discovered.items.length, 1);
    assert.equal(discovered.items[0].objectStore, provider.id);
    assert.equal(discovered.items[0].restoreSupported, true);
    assert.equal(discovered.capabilities.restoreAvailable, true);
    const boundedEvidence = JSON.stringify({ result: tested.result, trust: tested.connection.trust, inventory: tested.connection.influxdb3CoreInventory, discovered });
    assert.ok(boundedEvidence.length < 100000);
    for (const privateValue of [...provider.privateValues, created.secretRefIds[0], ...provider.locatorValues]) {
      assert.equal(boundedEvidence.includes(privateValue), false, `Connection evidence disclosed ${privateValue}.`);
    }
  });

  test(`${provider.label} removes failed-create secrets and retains failed-test secrets without validation`, async (context) => {
    const current = await fixture(context, provider);
    await assert.rejects(current.connections.create(WORKSPACE_ID, 'tester', provider.invalidInput()));
    assert.deepEqual(await current.secretStore.list(WORKSPACE_ID), []);
    assert.deepEqual(await current.controlDatabase.repository('secretRef').list(WORKSPACE_ID, { limit: 20 }), []);
    assert.deepEqual(await current.connections.list(WORKSPACE_ID), []);

    current.adapter.transport = async () => { throw new Error('offline'); };
    const created = await current.connections.create(WORKSPACE_ID, 'tester', provider.createInput({ name: `Core ${provider.label} offline` }));
    const tested = await current.connections.test(WORKSPACE_ID, created.id, 'tester');
    assert.equal(tested.result.status, 'failure');
    const refs = await current.secretStore.list(WORKSPACE_ID);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, created.secretRefIds[0]);
    assert.equal(refs[0].lastValidatedAt, null);
    const persisted = await current.controlDatabase.repository('connection').get(WORKSPACE_ID, created.id);
    assert.deepEqual(persisted.secretRefIds, created.secretRefIds);
    const failureEvidence = JSON.stringify({ lastTest: persisted.lastTest, trust: persisted.trust });
    for (const privateValue of [...provider.privateValues, created.secretRefIds[0], ...provider.locatorValues]) {
      assert.equal(failureEvidence.includes(privateValue), false, `Failure evidence disclosed ${privateValue}.`);
    }
  });

  test(`${provider.label} admits an exact whole-node Source and publishes an encrypted restorable full RecoveryPoint`, async (context) => {
    const current = await fixture(context, provider);
    const created = await current.connections.create(WORKSPACE_ID, 'tester', provider.createInput());
    const tested = await current.connections.test(WORKSPACE_ID, created.id, 'tester');
    assert.equal(tested.result.status, 'success', JSON.stringify(tested.result));
    const source = await new DatabaseSourceService({ controlDatabase: current.controlDatabase, adapterRegistry: current.registry, deviceId: DEVICE_ID }).save(WORKSPACE_ID, 'tester', {
      name: `Core ${provider.label} node protection`,
      connectionId: created.id,
      selector: { allDatabases: true },
      consistency: { requestedLevel: 'application', method: CONSISTENCY_METHODS['atomic-snapshot'], backupMethod: 'physical', backupMode: 'full', captureCoordinates: false },
      physicalExecution: { consistencyMode: 'atomic-snapshot', confirmationText: CONSISTENCY_CONFIRMATIONS['atomic-snapshot'] }
    });
    assert.equal(source.physicalExecution.objectStore, provider.id);
    assert.equal(source.physicalExecution.nodeId, NODE_ID);
    assert.equal(JSON.stringify(source.physicalExecution).includes(created.secretRefIds[0]), false);
    for (const locator of provider.locatorValues) assert.equal(JSON.stringify(source.physicalExecution).includes(locator), false);

    const plan = await current.adapter.planBackup({}, {
      connection: current.connections.config(tested.connection),
      execution: source.physicalExecution,
      consistency: source.consistency
    });
    assert.equal(plan.operation, provider.artifactKind);
    assert.deepEqual(plan.artifact, { kind: 'physical-backup', path: 'influxdb3-core/backup-metadata.json', mediaType: 'application/json', restoreSupported: true });

    const opened = await createRepository(current);
    const jobs = new BackupJobService({ controlDatabase: current.controlDatabase, deviceId: DEVICE_ID });
    const { job } = await jobs.create(WORKSPACE_ID, 'tester', {
      name: `Core ${provider.label} full`,
      sourceId: source.id,
      repositoryIds: [opened.repository.id],
      backupMode: 'full',
      verifyAfterBackup: true
    });
    const temporaryRoot = path.join(current.root, 'source-temp');
    const reader = new InfluxDb3CoreSourceReaderService({
      controlDatabase: current.controlDatabase,
      deviceId: DEVICE_ID,
      adapterRegistry: current.registry,
      adapter: current.adapter,
      connectionService: current.connections,
      temporaryRoot
    });
    const router = new BackupSourceReaderRouter({
      controlDatabase: current.controlDatabase,
      fileReader: new FileSourceReaderService({ controlDatabase: current.controlDatabase, secretStore: {}, deviceId: DEVICE_ID }),
      databaseReaders: { [ADAPTER_ID]: reader }
    });
    const service = new ManualBackupService({
      controlDatabase: current.controlDatabase,
      sourceReader: router,
      checkpointStore: new RunCheckpointStore({ rootPath: path.join(current.root, 'checkpoints') }),
      deviceId: DEVICE_ID,
      openRepository: async () => ({ repository: opened.repository, adapter: opened.repositoryAdapter, engine: opened.engine, masterKey: opened.masterKey, keyVersion: 'core-cloud-key-v1' })
    });
    const started = await service.start(WORKSPACE_ID, 'tester', job.id);
    await service.wait(started.id);
    const completed = await current.controlDatabase.repository('run').get(WORKSPACE_ID, started.id);
    assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));

    const [point] = await current.controlDatabase.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
    const artifact = (await current.controlDatabase.repository('artifact').list(WORKSPACE_ID, { limit: 20 })).find((item) => item.metadata?.kind === provider.artifactKind);
    assert.equal(point.type, 'full');
    assert.equal(point.consistency, 'application');
    assert.ok(artifact);
    assert.equal(artifact.kind, 'metadata');
    assert.equal(artifact.encryption.algorithm, 'aes-256-gcm');
    assert.equal(artifact.encryption.keyVersion, 'core-cloud-key-v1');
    assert.equal(artifact.metadata.kind, provider.artifactKind);
    assert.equal(artifact.metadata.source.objectStore, provider.id);
    assert.equal(artifact.metadata.artifact.kind, 'metadata');
    assert.equal(artifact.metadata.artifact.restoreSupported, true);
    assert.deepEqual(artifact.metadata.capture.copyOrder, ['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint']);
    assert.equal(artifact.metadata.nativeMedia.fileCount, 5);
    assert.match(artifact.metadata.nativeMedia.mediaFingerprint, /^sha256:[0-9a-f]{64}$/);

    const snapshot = await opened.engine.openSnapshot({}, { repositoryId: opened.repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey: opened.masterKey });
    assert.equal(snapshot.manifest.files.some((file) => file.path.includes('table-snapshots')), false);
    assert.equal(snapshot.manifest.files.some((file) => file.path.endsWith('/_catalog_checkpoint')), true);
    assert.deepEqual(await fs.readdir(temporaryRoot), []);

    const boundedEvidence = JSON.stringify({ point, artifact, runResult: completed.result });
    const internalRunEvidence = JSON.stringify(completed);
    assert.ok(boundedEvidence.length < 100000);
    for (const privateValue of [...provider.privateValues, ...provider.locatorValues]) {
      assert.equal(internalRunEvidence.includes(privateValue), false, `Run evidence disclosed ${privateValue}.`);
    }
    assert.equal(boundedEvidence.includes(created.secretRefIds[0]), false, 'Published evidence disclosed its credential SecretRef.');
  });
}
