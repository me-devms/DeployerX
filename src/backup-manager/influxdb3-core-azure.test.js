const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  AZURE_COPY_PHASES,
  InfluxDb3CoreAzureStore,
  nodePrefix,
  normalizeAzureCredential,
  normalizeCoreAzureConfig
} = require('./influxdb3-core-azure');

const NODE_ID = 'node-production-01';
const ACCESS_KEY = Buffer.alloc(64, 7).toString('base64');

function etag(body) {
  return `"${crypto.createHash('md5').update(body).digest('hex')}"`;
}

class MemoryAzureContainerClient {
  constructor(objects = {}) {
    this.objects = new Map(Object.entries(objects).map(([name, value]) => [name, { body: Buffer.from(value), lastModified: new Date('2026-08-05T00:00:00.000Z') }]));
    this.requests = [];
    this.onDownload = null;
    this.failUploadName = null;
  }

  put(name, value, modifiedAt = '2026-08-05T00:01:00.000Z') {
    this.objects.set(name, { body: Buffer.from(value), lastModified: new Date(modifiedAt) });
  }

  async getProperties(options) {
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
        if (!value) { const error = new Error('missing'); error.statusCode = 404; error.code = 'BlobNotFound'; throw error; }
        const identity = etag(value.body);
        if (options.conditions?.ifMatch !== identity) { const error = new Error('changed'); error.statusCode = 412; error.code = 'ConditionNotMet'; throw error; }
        const snapshot = Buffer.from(value.body);
        current.onDownload?.(name, current);
        return { etag: identity, contentLength: snapshot.length, readableStreamBody: (async function* body() { yield snapshot; })() };
      }
    };
  }

  getBlockBlobClient(name) {
    const current = this;
    return {
      async uploadFile(source, options = {}) {
        current.requests.push({ operation: 'upload', name, ifNoneMatch: options.conditions?.ifNoneMatch, contentChecksumAlgorithm: options.contentChecksumAlgorithm });
        if (current.failUploadName === name) { const error = new Error('write failed'); error.statusCode = 503; error.code = 'ServerBusy'; throw error; }
        if (options.conditions?.ifNoneMatch !== '*' || current.objects.has(name)) { const error = new Error('exists'); error.statusCode = 412; error.code = 'ConditionNotMet'; throw error; }
        const body = await fs.readFile(source);
        current.put(name, body);
        return { etag: etag(body) };
      }
    };
  }
}

function coreBlobs(prefix = 'production') {
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
  return { objectStore: 'azure', accountName: 'corestorageaccount', container: 'core-production-data', prefix: 'production', credentialSecretRefId: 'secret-core-azure', nodeId: NODE_ID, ...overrides };
}

test('normalizes an exact SecretRef-only Azure binding and refuses unsafe variants', async () => {
  assert.deepEqual(normalizeCoreAzureConfig(config()), {
    objectStore: 'azure', accountName: 'corestorageaccount', container: 'core-production-data', endpoint: 'https://corestorageaccount.blob.core.windows.net', prefix: 'production', allowInsecureEndpoint: false, timeoutMs: 30000,
    credentialSecretRefId: 'secret-core-azure', nodeId: NODE_ID
  });
  assert.deepEqual(normalizeAzureCredential({ accountName: 'corestorageaccount', accessKey: ACCESS_KEY }, 'corestorageaccount'), { accountName: 'corestorageaccount', accessKey: ACCESS_KEY });
  assert.equal(nodePrefix(normalizeCoreAzureConfig(config())), `production/${NODE_ID}/`);
  assert.throws(() => normalizeCoreAzureConfig(config({ objectStore: 'memory' })), /memory and non-Azure/);
  assert.throws(() => normalizeCoreAzureConfig(config({ endpoint: 'http://azurite.example.com/account' })), /explicit insecure-endpoint approval/);
  assert.throws(() => normalizeCoreAzureConfig(config({ prefix: '../other' })), /prefix is invalid/);
  assert.throws(() => normalizeAzureCredential({ accountName: 'otherstorageaccount', accessKey: ACCESS_KEY }, 'corestorageaccount'), /does not match/);
  assert.throws(() => normalizeAzureCredential({ accountName: 'corestorageaccount', accessKey: 'not-base64' }, 'corestorageaccount'), /access key is invalid/);

  let resolved = 0;
  const client = new MemoryAzureContainerClient(coreBlobs());
  const store = new InfluxDb3CoreAzureStore({
    config: config(),
    resolveSecret: async (id) => { resolved += 1; assert.equal(id, 'secret-core-azure'); return JSON.stringify({ accountName: 'corestorageaccount', accessKey: ACCESS_KEY }); },
    clientFactory: async (options) => { assert.equal(options.endpoint, 'https://corestorageaccount.blob.core.windows.net'); assert.equal(options.accountName, 'corestorageaccount'); assert.equal(options.container, 'core-production-data'); return client; }
  });
  await Promise.all([store.inspect(), store.inspect()]);
  assert.equal(resolved, 1);
  assert.equal(JSON.stringify(store.config).includes('accessKey'), false);
});

test('authenticates the exact Core Azure inventory in documented order and excludes table snapshots', async () => {
  const client = new MemoryAzureContainerClient({ ...coreBlobs(), [`production/${NODE_ID}/`]: '', [`production/${NODE_ID}/catalog/`]: '' });
  const store = new InfluxDb3CoreAzureStore({ config: config(), containerClient: client });
  const layout = await store.inspect();
  assert.equal(layout.objectStore, 'azure');
  assert.deepEqual(layout.phaseEvidence.map((phase) => phase.phase), AZURE_COPY_PHASES.map((phase) => phase.name));
  assert.equal(layout.fileCount, 5);
  assert.equal(layout.members.some((member) => member.relativePath.includes('table-snapshots')), false);
  assert.deepEqual(layout.excluded, ['table-snapshots/']);
  assert.equal(layout.directories.includes('snapshots'), true);
  assert.match(layout.bindingFingerprint, /^sha256:[0-9a-f]{64}$/);

  client.put(`production/${NODE_ID}/unknown/private.bin`, 'unsafe');
  await assert.rejects(store.inspect(), (error) => error.code === 'INFLUXDB3_CORE_AZURE_LAYOUT_UNSUPPORTED');
});

test('refuses incomplete, escaping, oversized, and cursor-loop Azure listings', async () => {
  const withoutCheckpoint = coreBlobs();
  delete withoutCheckpoint[`production/${NODE_ID}/_catalog_checkpoint`];
  await assert.rejects(new InfluxDb3CoreAzureStore({ config: config(), containerClient: new MemoryAzureContainerClient(withoutCheckpoint) }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_AZURE_LAYOUT_INVALID');

  const listedClient = (blobItems, continuationToken = null) => ({
    async getProperties() { return {}; },
    listBlobsFlat() {
      return { byPage: () => ({ async next() { return { done: false, value: { segment: { blobItems }, continuationToken } }; } }) };
    },
    getBlobClient() { throw new Error('not used'); }
  });
  const properties = { blobType: 'BlockBlob', contentLength: 1, etag: '"identity"', lastModified: new Date('2026-08-05T00:00:00.000Z') };
  await assert.rejects(new InfluxDb3CoreAzureStore({ config: config(), containerClient: listedClient([{ name: `other/${NODE_ID}/_catalog_checkpoint`, deleted: false, properties }]) }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_AZURE_NAME_INVALID');
  await assert.rejects(new InfluxDb3CoreAzureStore({ config: config(), containerClient: listedClient([{ name: `production/${NODE_ID}/_catalog_checkpoint`, deleted: false, properties: { ...properties, contentLength: 64 * 1024 * 1024 * 1024 * 1024 + 1 } }]) }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_AZURE_BLOB_INVALID');
  await assert.rejects(new InfluxDb3CoreAzureStore({ config: config(), containerClient: listedClient([{ name: `production/${NODE_ID}/_catalog_checkpoint`, deleted: false, properties }], 'repeated-token') }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_AZURE_LIST_INVALID');
});

test('conditionally downloads and hashes Azure blobs, failing strong capture on drift and recording live-copy drift', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-azure-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const stableClient = new MemoryAzureContainerClient(coreBlobs());
  const stableStore = new InfluxDb3CoreAzureStore({ config: config(), containerClient: stableClient });
  const stable = await stableStore.capture({}, path.join(root, 'stable'), 'atomic-snapshot');
  assert.equal(stable.achievedConsistency, 'application');
  assert.deepEqual(stable.driftPhases, []);
  assert.equal(stable.fileCount, 5);
  assert.equal(await fs.readFile(path.join(stable.directory, '_catalog_checkpoint'), 'utf8'), 'checkpoint-bytes');
  assert.equal(stableClient.requests.filter((request) => request.operation === 'download').every((request) => /^"[0-9a-f]{32}"$/.test(request.ifMatch)), true);
  assert.deepEqual(stableClient.requests.filter((request) => request.operation === 'download').map((request) => request.name.split(`/${NODE_ID}/`)[1].split('/')[0]), ['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint']);

  const changedName = `production/${NODE_ID}/snapshots/0001/snapshot.parquet`;
  const makeDriftingClient = () => {
    const client = new MemoryAzureContainerClient(coreBlobs());
    let changed = false;
    client.onDownload = (name, current) => { if (!changed && name.includes('/catalog/')) { changed = true; current.put(changedName, 'snapshot-bytes-changed'); } };
    return client;
  };
  const atomicDestination = path.join(root, 'atomic-drift');
  await assert.rejects(new InfluxDb3CoreAzureStore({ config: config(), containerClient: makeDriftingClient() }).capture({}, atomicDestination, 'atomic-snapshot'), (error) => error.code === 'INFLUXDB3_CORE_AZURE_SOURCE_CHANGED');
  assert.equal(await fs.lstat(atomicDestination).catch(() => null), null);

  const live = await new InfluxDb3CoreAzureStore({ config: config(), containerClient: makeDriftingClient() }).capture({}, path.join(root, 'live-drift'), 'ordered-live-copy');
  assert.equal(live.achievedConsistency, 'crash');
  assert.deepEqual(live.driftPhases, ['snapshots']);
  assert.match(live.mediaFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('restores authenticated files with create-only Azure uploads and authenticates the complete installed node', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-azure-restore-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceStore = new InfluxDb3CoreAzureStore({ config: config(), containerClient: new MemoryAzureContainerClient(coreBlobs()) });
  const captured = await sourceStore.capture({}, path.join(root, 'source'), 'atomic-snapshot');
  const nativeMedia = {
    fileCount: captured.fileCount,
    directoryCount: captured.directoryCount,
    totalBytes: captured.totalBytes,
    mediaFingerprint: captured.mediaFingerprint,
    directoryFingerprint: captured.directoryFingerprint,
    members: captured.files,
    directories: captured.directories
  };
  const targetConfig = config({ container: 'core-restore-data', prefix: 'alternate', credentialSecretRefId: 'secret-core-target' });
  const targetClient = new MemoryAzureContainerClient({
    [`alternate/${NODE_ID}-shadow/_catalog_checkpoint`]: 'unrelated-node',
    'another-prefix/unrelated.bin': 'unrelated-prefix'
  });
  const targetStore = new InfluxDb3CoreAzureStore({ config: targetConfig, containerClient: targetClient });
  const targetStorageFingerprint = (await targetStore.assertEmpty()).bindingFingerprint;

  const invalidRoot = path.join(root, 'invalid-source');
  const first = captured.files[0];
  await fs.mkdir(path.join(invalidRoot, path.dirname(first.relativePath)), { recursive: true });
  await fs.writeFile(path.join(invalidRoot, first.relativePath), Buffer.alloc(first.sizeBytes, 1));
  await assert.rejects(targetStore.uploadRestoreMember({}, invalidRoot, first), (error) => error.code === 'INFLUXDB3_CORE_AZURE_RESTORE_MEDIA_INVALID');
  assert.equal(targetClient.requests.some((request) => request.operation === 'upload'), false);

  for (const member of captured.files) await targetStore.uploadRestoreMember({}, captured.directory, member);
  const uploads = targetClient.requests.filter((request) => request.operation === 'upload');
  assert.equal(uploads.length, captured.fileCount);
  assert.equal(uploads.every((request) => request.ifNoneMatch === '*' && request.contentChecksumAlgorithm === 'StorageCrc64'), true);
  assert.equal(targetClient.requests.some((request) => request.operation === 'delete'), false);

  const installed = await targetStore.authenticateInstalled({}, { targetStorageFingerprint, nativeMedia });
  assert.equal(installed.files.length, captured.fileCount);
  assert.equal(installed.totalBytes, captured.totalBytes);
  assert.deepEqual(installed.directories, captured.directories);
  assert.equal(installed.bindingFingerprint, targetStorageFingerprint);
  const validationDownloads = targetClient.requests.filter((request) => request.operation === 'download');
  assert.equal(validationDownloads.length, captured.fileCount);
  assert.equal(validationDownloads.every((request) => /^"[0-9a-f]{32}"$/.test(request.ifMatch)), true);

  const unexpectedName = `alternate/${NODE_ID}/snapshots/9999/unexpected.parquet`;
  targetClient.onDownload = (_name, client) => {
    if (!client.objects.has(unexpectedName)) client.put(unexpectedName, 'unexpected');
  };
  await assert.rejects(targetStore.authenticateInstalled({}, { targetStorageFingerprint, nativeMedia }), (error) => error.code === 'INFLUXDB3_CORE_AZURE_RESTORE_TARGET_CHANGED');
  targetClient.onDownload = null;
  targetClient.objects.delete(unexpectedName);

  await assert.rejects(targetStore.assertEmpty(), (error) => error.code === 'INFLUXDB3_CORE_AZURE_RESTORE_TARGET_EXISTS');
  await assert.rejects(targetStore.uploadRestoreMember({}, captured.directory, first), (error) => error.code === 'INFLUXDB3_CORE_AZURE_RESTORE_TARGET_CHANGED');
  assert.equal(targetClient.objects.get(`alternate/${NODE_ID}/${first.relativePath}`).body.toString(), await fs.readFile(path.join(captured.directory, first.relativePath), 'utf8'));

  targetClient.put(`alternate/${NODE_ID}/${first.relativePath}`, Buffer.alloc(first.sizeBytes, 2));
  await assert.rejects(targetStore.authenticateInstalled({}, { targetStorageFingerprint, nativeMedia }), (error) => error.code === 'INFLUXDB3_CORE_AZURE_RESTORE_VALIDATION_FAILED');
});

test('preserves partial Azure target blobs when a restore upload fails', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-azure-partial-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = await new InfluxDb3CoreAzureStore({ config: config(), containerClient: new MemoryAzureContainerClient(coreBlobs()) }).capture({}, path.join(root, 'source'), 'atomic-snapshot');
  const targetConfig = config({ container: 'core-partial-data', prefix: 'alternate', credentialSecretRefId: 'secret-core-partial' });
  const targetClient = new MemoryAzureContainerClient();
  const targetStore = new InfluxDb3CoreAzureStore({ config: targetConfig, containerClient: targetClient });
  await targetStore.assertEmpty();
  await targetStore.uploadRestoreMember({}, captured.directory, captured.files[0]);
  targetClient.failUploadName = `alternate/${NODE_ID}/${captured.files[1].relativePath}`;
  await assert.rejects(targetStore.uploadRestoreMember({}, captured.directory, captured.files[1]), (error) => error.code === 'INFLUXDB3_CORE_AZURE_RESTORE_WRITE_FAILED');
  assert.equal(targetClient.objects.has(`alternate/${NODE_ID}/${captured.files[0].relativePath}`), true);
  assert.equal(targetClient.objects.has(targetClient.failUploadName), false);
  assert.equal(targetClient.requests.some((request) => request.operation === 'delete'), false);
});
