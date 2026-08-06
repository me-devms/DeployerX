const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  RESTORE_CONFIRMATION,
  InfluxDb3CoreAdapter
} = require('./influxdb3-core');
const {
  InfluxDb3CoreS3Store,
  OBJECT_COPY_PHASES,
  nodePrefix,
  normalizeCoreS3Config
} = require('./influxdb3-core-s3');

const NODE_ID = 'node-production-01';

function etag(body) {
  return `"${crypto.createHash('md5').update(body).digest('hex')}"`;
}

class MemoryCoreS3Client {
  constructor(objects = {}) {
    this.objects = new Map(Object.entries(objects).map(([key, value]) => [key, { body: Buffer.from(value), lastModified: new Date('2026-08-05T00:00:00.000Z') }]));
    this.onGet = null;
    this.requests = [];
    this.failPutKey = null;
  }

  put(key, value, modifiedAt = '2026-08-05T00:01:00.000Z') {
    this.objects.set(key, { body: Buffer.from(value), lastModified: new Date(modifiedAt) });
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    this.requests.push({ name, input: { ...input } });
    if (name === 'HeadBucketCommand') return { $metadata: { httpStatusCode: 200 } };
    if (name === 'ListObjectsV2Command') {
      const contents = [...this.objects.entries()]
        .filter(([key]) => key.startsWith(input.Prefix))
        .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
        .map(([Key, value]) => ({ Key, Size: value.body.length, ETag: etag(value.body), LastModified: value.lastModified }));
      return { Contents: contents, IsTruncated: false, KeyCount: contents.length };
    }
    if (name === 'GetObjectCommand') {
      const value = this.objects.get(input.Key);
      if (!value) { const error = new Error('missing'); error.name = 'NoSuchKey'; error.$metadata = { httpStatusCode: 404 }; throw error; }
      const identity = etag(value.body);
      if (input.IfMatch !== identity) { const error = new Error('changed'); error.name = 'PreconditionFailed'; error.$metadata = { httpStatusCode: 412 }; throw error; }
      const snapshot = Buffer.from(value.body);
      this.onGet?.(input.Key, this);
      return { ETag: identity, ContentLength: snapshot.length, Body: (async function* body() { yield snapshot; })() };
    }
    if (name === 'PutObjectCommand') {
      if (this.failPutKey === input.Key) { const error = new Error('write failed'); error.name = 'ServiceUnavailable'; error.$metadata = { httpStatusCode: 503 }; throw error; }
      if (input.IfNoneMatch !== '*' || this.objects.has(input.Key)) { const error = new Error('exists'); error.name = 'PreconditionFailed'; error.$metadata = { httpStatusCode: 412 }; throw error; }
      const chunks = []; for await (const chunk of input.Body) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
      assert.equal(body.length, input.ContentLength);
      assert.equal(crypto.createHash('sha256').update(body).digest('base64'), input.ChecksumSHA256);
      this.put(input.Key, body);
      return { ETag: etag(body), ChecksumSHA256: input.ChecksumSHA256, $metadata: { httpStatusCode: 200 } };
    }
    throw new Error(`Unexpected command ${name}`);
  }
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

function config(overrides = {}) {
  return { objectStore: 's3', region: 'us-east-1', bucket: 'core-production-data', prefix: 'production', credentialSecretRefId: 'secret-core-s3', nodeId: NODE_ID, ...overrides };
}

test('normalizes an exact SecretRef-only S3 binding and refuses unsafe variants', async () => {
  assert.deepEqual(normalizeCoreS3Config(config()), {
    objectStore: 's3', endpoint: null, region: 'us-east-1', bucket: 'core-production-data', prefix: 'production', forcePathStyle: false, allowInsecureEndpoint: false, timeoutMs: 30000,
    credentialSecretRefId: 'secret-core-s3', nodeId: NODE_ID
  });
  assert.equal(nodePrefix(normalizeCoreS3Config(config())), `production/${NODE_ID}/`);
  assert.throws(() => normalizeCoreS3Config(config({ objectStore: 'memory' })), /memory and non-S3/);
  assert.throws(() => normalizeCoreS3Config(config({ endpoint: 'http://minio.example.com' })), /explicit insecure-endpoint approval/);
  assert.throws(() => normalizeCoreS3Config(config({ prefix: '../other' })), /prefix is invalid/);

  let credentialOptions;
  const store = new InfluxDb3CoreS3Store({ config: config(), resolveSecret: async (id) => { assert.equal(id, 'secret-core-s3'); return JSON.stringify({ accessKeyId: 'access', secretAccessKey: 'secret' }); }, clientFactory: (options) => { credentialOptions = options; return new MemoryCoreS3Client(coreObjects()); } });
  assert.deepEqual(await credentialOptions.credentials(), { accessKeyId: 'access', secretAccessKey: 'secret' });
  assert.equal(JSON.stringify(store.config).includes('secretAccessKey'), false);
});

test('authenticates the exact Core S3 node inventory in documented order and excludes table snapshots', async () => {
  const client = new MemoryCoreS3Client({ ...coreObjects(), [`production/${NODE_ID}/`]: '', [`production/${NODE_ID}/catalog/`]: '' });
  const store = new InfluxDb3CoreS3Store({ config: config(), client });
  const layout = await store.inspect();
  assert.deepEqual(layout.phaseEvidence.map((phase) => phase.phase), OBJECT_COPY_PHASES.map((phase) => phase.name));
  assert.equal(layout.fileCount, 5);
  assert.equal(layout.members.some((member) => member.relativePath.includes('table-snapshots')), false);
  assert.deepEqual(layout.excluded, ['table-snapshots/']);
  assert.equal(layout.directories.includes('snapshots'), true);
  assert.match(layout.bindingFingerprint, /^sha256:[0-9a-f]{64}$/);

  client.put(`production/${NODE_ID}/unknown/private.bin`, 'unsafe');
  await assert.rejects(store.inspect(), (error) => error.code === 'INFLUXDB3_CORE_S3_LAYOUT_UNSUPPORTED');
});

test('conditionally reads and hashes every S3 object, failing strong capture on drift and recording live-copy drift', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-s3-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const stableClient = new MemoryCoreS3Client(coreObjects());
  const stableStore = new InfluxDb3CoreS3Store({ config: config(), client: stableClient });
  const stable = await stableStore.capture({}, path.join(root, 'stable'), 'atomic-snapshot');
  assert.equal(stable.achievedConsistency, 'application');
  assert.deepEqual(stable.driftPhases, []);
  assert.equal(stable.fileCount, 5);
  assert.equal(await fs.readFile(path.join(stable.directory, '_catalog_checkpoint'), 'utf8'), 'checkpoint-bytes');
  assert.equal(stableClient.requests.filter((request) => request.name === 'GetObjectCommand').every((request) => /^"[0-9a-f]{32}"$/.test(request.input.IfMatch)), true);
  assert.deepEqual(stableClient.requests.filter((request) => request.name === 'GetObjectCommand').map((request) => request.input.Key.split(`/${NODE_ID}/`)[1].split('/')[0]), ['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint']);

  const driftingObjects = coreObjects();
  const changedKey = `production/${NODE_ID}/snapshots/0001/snapshot.parquet`;
  const makeDriftingClient = () => {
    const client = new MemoryCoreS3Client(driftingObjects);
    let changed = false;
    client.onGet = (key, current) => { if (!changed && key.includes('/catalog/')) { changed = true; current.put(changedKey, 'snapshot-bytes-changed'); } };
    return client;
  };
  const atomicDestination = path.join(root, 'atomic-drift');
  await assert.rejects(new InfluxDb3CoreS3Store({ config: config(), client: makeDriftingClient() }).capture({}, atomicDestination, 'atomic-snapshot'), (error) => error.code === 'INFLUXDB3_CORE_S3_SOURCE_CHANGED');
  assert.equal(await fs.lstat(atomicDestination).catch(() => null), null);

  const live = await new InfluxDb3CoreS3Store({ config: config(), client: makeDriftingClient() }).capture({}, path.join(root, 'live-drift'), 'ordered-live-copy');
  assert.equal(live.achievedConsistency, 'crash');
  assert.deepEqual(live.driftPhases, ['snapshots']);
  assert.match(live.mediaFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('restores to an empty stopped S3 target with conditional writes and authenticates every installed object', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-s3-restore-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceStore = new InfluxDb3CoreS3Store({ config: config(), client: new MemoryCoreS3Client(coreObjects()) });
  const captured = await sourceStore.capture({}, path.join(root, 'source'), 'atomic-snapshot');
  const source = {
    product: 'influxdb3-core', productVersion: '3.11.0', objectStore: 's3', nodeId: NODE_ID,
    deploymentFingerprint: `sha256:${'1'.repeat(64)}`, consistency: 'application',
    nativeMedia: { fileCount: captured.fileCount, directoryCount: captured.directoryCount, totalBytes: captured.totalBytes, mediaFingerprint: captured.mediaFingerprint, directoryFingerprint: captured.directoryFingerprint, members: captured.files, directories: captured.directories }
  };
  const targetClient = new MemoryCoreS3Client();
  const targetConfig = config({ bucket: 'core-restore-data', prefix: 'alternate', credentialSecretRefId: 'secret-core-target' });
  const targetStore = new InfluxDb3CoreS3Store({ config: targetConfig, client: targetClient });
  const targetStorageFingerprint = (await targetStore.assertEmpty()).bindingFingerprint;
  const targetDeploymentFingerprint = `sha256:${'2'.repeat(64)}`;
  const connection = {
    protocol: 'http', allowInsecureHttp: true, host: '127.0.0.2', port: 8181, nodeId: NODE_ID,
    objectStore: 's3', s3BindingConfirmed: true, objectStoreRegion: targetConfig.region, objectStoreBucket: targetConfig.bucket, objectStorePrefix: targetConfig.prefix,
    objectStoreForcePathStyle: false, allowInsecureObjectStoreEndpoint: false, objectStoreTimeoutMs: 30000, objectStoreCredentialSecretRefId: targetConfig.credentialSecretRefId,
    expectedVersion: '3.11.0', expectedDeploymentFingerprint: targetDeploymentFingerprint, expectedStorageFingerprint: targetStorageFingerprint
  };
  const adapter = new InfluxDb3CoreAdapter({ transport: async () => { const error = new Error('stopped'); error.category = 'connectivity'; throw error; }, s3StoreFactory: () => targetStore });
  const plan = await adapter.planRestore({}, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection, source, targetIdentity: { version: '3.11.0', deploymentFingerprint: targetDeploymentFingerprint, storageFingerprint: targetStorageFingerprint }, executionId: 's3-restore-1' });
  assert.equal(plan.operation, 'influxdb3-core-alternate-s3-restore');
  let mutationStarted = false;
  const restored = await adapter.executeRestore({ sourceDirectory: captured.directory, onMutationStarted: () => { mutationStarted = true; } }, plan);
  assert.equal(mutationStarted, true);
  assert.equal(restored.validation.valid, true);
  assert.equal(restored.validation.objectStore, 's3');
  assert.equal(restored.validation.fileCount, captured.fileCount);
  assert.deepEqual(targetClient.requests.filter((request) => request.name === 'PutObjectCommand').map((request) => request.input.Key.split(`/${NODE_ID}/`)[1].split('/')[0]), ['_catalog_checkpoint', 'catalog', 'wal', 'dbs', 'snapshots']);
  assert.equal(targetClient.requests.some((request) => request.name.startsWith('Delete')), false);
  await assert.rejects(adapter.planRestore({}, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection, source, targetIdentity: { version: '3.11.0', deploymentFingerprint: targetDeploymentFingerprint, storageFingerprint: targetStorageFingerprint }, executionId: 's3-restore-2' }), (error) => error.code === 'INFLUXDB3_CORE_S3_RESTORE_TARGET_EXISTS');
});

test('preserves partial S3 target objects when a restore write fails after mutation', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-s3-partial-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = await new InfluxDb3CoreS3Store({ config: config(), client: new MemoryCoreS3Client(coreObjects()) }).capture({}, path.join(root, 'source'), 'atomic-snapshot');
  const targetClient = new MemoryCoreS3Client(); const targetConfig = config({ bucket: 'core-partial-data', prefix: 'alternate', credentialSecretRefId: 'secret-partial' }); const targetStore = new InfluxDb3CoreS3Store({ config: targetConfig, client: targetClient });
  const storageFingerprint = (await targetStore.assertEmpty()).bindingFingerprint; const deploymentFingerprint = `sha256:${'3'.repeat(64)}`;
  const source = { product: 'influxdb3-core', productVersion: '3.11.0', objectStore: 's3', nodeId: NODE_ID, deploymentFingerprint: `sha256:${'4'.repeat(64)}`, consistency: 'application', nativeMedia: { fileCount: captured.fileCount, directoryCount: captured.directoryCount, totalBytes: captured.totalBytes, mediaFingerprint: captured.mediaFingerprint, directoryFingerprint: captured.directoryFingerprint, members: captured.files, directories: captured.directories } };
  const connection = { protocol: 'http', allowInsecureHttp: true, host: '127.0.0.3', port: 8181, nodeId: NODE_ID, objectStore: 's3', s3BindingConfirmed: true, objectStoreRegion: targetConfig.region, objectStoreBucket: targetConfig.bucket, objectStorePrefix: targetConfig.prefix, objectStoreForcePathStyle: false, allowInsecureObjectStoreEndpoint: false, objectStoreTimeoutMs: 30000, objectStoreCredentialSecretRefId: targetConfig.credentialSecretRefId, expectedVersion: '3.11.0', expectedDeploymentFingerprint: deploymentFingerprint, expectedStorageFingerprint: storageFingerprint };
  const adapter = new InfluxDb3CoreAdapter({ transport: async () => { const error = new Error('stopped'); error.category = 'connectivity'; throw error; }, s3StoreFactory: () => targetStore });
  const plan = await adapter.planRestore({}, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection, source, targetIdentity: { version: '3.11.0', deploymentFingerprint, storageFingerprint }, executionId: 's3-partial' });
  targetClient.failPutKey = `alternate/${NODE_ID}/wal/0001/wal.log`;
  await assert.rejects(adapter.executeRestore({ sourceDirectory: captured.directory }, plan), (error) => error.code === 'INFLUXDB3_CORE_S3_RESTORE_WRITE_FAILED');
  assert.equal(targetClient.objects.has(`alternate/${NODE_ID}/_catalog_checkpoint`), true);
  assert.equal(targetClient.objects.has(`alternate/${NODE_ID}/catalog/0001/catalog.log`), true);
  assert.equal(targetClient.requests.some((request) => request.name.startsWith('Delete')), false);
});
