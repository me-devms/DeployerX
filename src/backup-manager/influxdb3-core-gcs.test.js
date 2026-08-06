const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const {
  GCS_COPY_PHASES,
  InfluxDb3CoreGcsStore,
  nodePrefix,
  normalizeCoreGcsConfig,
  normalizeGcsCredential
} = require('./influxdb3-core-gcs');

const NODE_ID = 'node-production-01';
const PRIVATE_KEY_BODY = Buffer.alloc(1024, 7).toString('base64');
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;

function serviceAccount(overrides = {}) {
  return {
    type: 'service_account',
    project_id: 'deployerx-core-prod',
    private_key_id: 'a'.repeat(40),
    private_key: PRIVATE_KEY,
    client_email: 'core-backup@deployerx-core-prod.iam.gserviceaccount.com',
    client_id: '123456789012345678901',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/core-backup%40deployerx-core-prod.iam.gserviceaccount.com',
    universe_domain: 'googleapis.com',
    ...overrides
  };
}

class MemoryGcsBucket {
  constructor(objects = {}) {
    this.objects = new Map();
    this.requests = [];
    this.onDownload = null;
    this.failUploadName = null;
    this.nextGeneration = 1000000000000000000n;
    for (const [name, value] of Object.entries(objects)) this.put(name, value, '2026-08-05T00:00:00.000Z');
  }

  put(name, value, updated = '2026-08-05T00:01:00.000Z') {
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
        if (!current) {
          const stream = new Readable({ read() {} });
          process.nextTick(() => { const error = new Error('missing'); error.code = 404; stream.destroy(error); });
          return stream;
        }
        if (requestedGeneration !== current.generation) {
          const stream = new Readable({ read() {} });
          process.nextTick(() => { const error = new Error('changed'); error.code = 404; stream.destroy(error); });
          return stream;
        }
        const snapshot = Buffer.from(current.body);
        const generation = current.generation;
        bucket.onDownload?.(name, bucket);
        const stream = Readable.from([snapshot]);
        process.nextTick(() => stream.emit('response', { headers: { 'x-goog-generation': generation, 'content-length': String(snapshot.length) } }));
        return stream;
      },
      createWriteStream(options = {}) {
        bucket.requests.push({ operation: 'upload', name, options });
        const chunks = [];
        return new Writable({
          write(raw, _encoding, callback) {
            if (bucket.failUploadName === name) {
              const error = new Error('write failed');
              error.code = 503;
              callback(error);
              return;
            }
            if (options.preconditionOpts?.ifGenerationMatch !== 0 || bucket.objects.has(name)) {
              const error = new Error('precondition failed');
              error.code = 412;
              callback(error);
              return;
            }
            chunks.push(Buffer.from(raw));
            callback();
          },
          final(callback) {
            bucket.put(name, Buffer.concat(chunks));
            callback();
          }
        });
      }
    };
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
  return { objectStore: 'google', bucket: 'deployerx-core-prod-data', prefix: 'production', credentialSecretRefId: 'secret-core-gcs', nodeId: NODE_ID, ...overrides };
}

function restoreSource(captured, targetStorageFingerprint) {
  return {
    product: 'influxdb3-core',
    productVersion: '3.11.0',
    objectStore: 'google',
    nodeId: NODE_ID,
    deploymentFingerprint: `sha256:${'1'.repeat(64)}`,
    targetStorageFingerprint,
    consistency: 'application',
    nativeMedia: {
      fileCount: captured.fileCount,
      directoryCount: captured.directoryCount,
      totalBytes: captured.totalBytes,
      mediaFingerprint: captured.mediaFingerprint,
      directoryFingerprint: captured.directoryFingerprint,
      members: captured.files,
      directories: captured.directories
    }
  };
}

test('normalizes an exact service-account SecretRef-only GCS binding and refuses unsafe variants', async () => {
  assert.deepEqual(normalizeCoreGcsConfig(config()), {
    objectStore: 'google', bucket: 'deployerx-core-prod-data', prefix: 'production', timeoutMs: 30000,
    credentialSecretRefId: 'secret-core-gcs', nodeId: NODE_ID
  });
  const credential = normalizeGcsCredential(serviceAccount());
  assert.equal(credential.projectId, 'deployerx-core-prod');
  assert.equal(credential.clientEmail, 'core-backup@deployerx-core-prod.iam.gserviceaccount.com');
  assert.equal(credential.privateKey, PRIVATE_KEY);
  assert.equal(nodePrefix(normalizeCoreGcsConfig(config())), `production/${NODE_ID}/`);
  assert.throws(() => normalizeCoreGcsConfig(config({ objectStore: 'memory' })), /memory and non-GCS/);
  assert.throws(() => normalizeCoreGcsConfig(config({ endpoint: 'https://storage.googleapis.com' })), /Unknown InfluxDB 3 Core GCS field/);
  assert.throws(() => normalizeCoreGcsConfig(config({ prefix: '../other' })), /prefix is invalid/);
  assert.throws(() => normalizeGcsCredential(serviceAccount({ type: 'authorized_user' })), /service-account document/);
  assert.throws(() => normalizeGcsCredential(serviceAccount({ token_uri: 'https://attacker.example/token' })), /token URI is invalid/);
  assert.throws(() => normalizeGcsCredential(serviceAccount({ private_key: 'not-a-private-key' })), /private key is invalid/);

  let resolved = 0;
  const client = new MemoryGcsBucket(coreObjects());
  const store = new InfluxDb3CoreGcsStore({
    config: config(),
    resolveSecret: async (id) => { resolved += 1; assert.equal(id, 'secret-core-gcs'); return JSON.stringify(serviceAccount()); },
    clientFactory: async (options) => {
      assert.equal(options.projectId, 'deployerx-core-prod');
      assert.equal(options.bucket, 'deployerx-core-prod-data');
      assert.equal(options.credentials.client_email, 'core-backup@deployerx-core-prod.iam.gserviceaccount.com');
      assert.equal(options.credentials.private_key, PRIVATE_KEY);
      return client;
    }
  });
  const [first, second] = await Promise.all([store.inspect(), store.inspect()]);
  assert.equal(resolved, 1);
  assert.equal(JSON.stringify(store.config).includes('private'), false);
  assert.equal(JSON.stringify(first).includes(PRIVATE_KEY_BODY.slice(0, 24)), false);
  assert.deepEqual(first, second);
});

test('authenticates the exact Core GCS inventory in documented order and excludes table snapshots', async () => {
  const client = new MemoryGcsBucket({ ...coreObjects(), [`production/${NODE_ID}/`]: '', [`production/${NODE_ID}/catalog/`]: '' });
  const store = new InfluxDb3CoreGcsStore({ config: config(), bucketClient: client });
  const layout = await store.inspect();
  assert.equal(layout.objectStore, 'google');
  assert.deepEqual(layout.phaseEvidence.map((phase) => phase.phase), GCS_COPY_PHASES.map((phase) => phase.name));
  assert.equal(layout.fileCount, 5);
  assert.equal(layout.members.some((member) => member.relativePath.includes('table-snapshots')), false);
  assert.deepEqual(layout.excluded, ['table-snapshots/']);
  assert.equal(layout.directories.includes('snapshots'), true);
  assert.match(layout.bindingFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(layout).includes('deployerx-core-prod-data'), false);

  client.put(`production/${NODE_ID}/unknown/private.bin`, 'unsafe');
  await assert.rejects(store.inspect(), (error) => error.code === 'INFLUXDB3_CORE_GCS_LAYOUT_UNSUPPORTED');
});

test('refuses incomplete, escaping, oversized, and cursor-loop GCS listings', async () => {
  const withoutCheckpoint = coreObjects();
  delete withoutCheckpoint[`production/${NODE_ID}/_catalog_checkpoint`];
  await assert.rejects(new InfluxDb3CoreGcsStore({ config: config(), bucketClient: new MemoryGcsBucket(withoutCheckpoint) }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_GCS_LAYOUT_INVALID');

  const listedClient = (files, nextQuery = {}) => ({
    async getMetadata() { return [{}]; },
    async getFiles() { return [files, nextQuery, {}]; },
    file() { throw new Error('not used'); }
  });
  const metadata = { name: `production/${NODE_ID}/_catalog_checkpoint`, size: '1', generation: '1000000000000000001', updated: '2026-08-05T00:00:00.000Z' };
  await assert.rejects(new InfluxDb3CoreGcsStore({ config: config(), bucketClient: listedClient([{ name: `other/${NODE_ID}/_catalog_checkpoint`, metadata: { ...metadata, name: `other/${NODE_ID}/_catalog_checkpoint` } }]) }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_GCS_NAME_INVALID');
  await assert.rejects(new InfluxDb3CoreGcsStore({ config: config(), bucketClient: listedClient([{ name: metadata.name, metadata: { ...metadata, size: String(64 * 1024 * 1024 * 1024 * 1024 + 1) } }]) }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_GCS_OBJECT_INVALID');
  await assert.rejects(new InfluxDb3CoreGcsStore({ config: config(), bucketClient: listedClient([{ name: metadata.name, metadata: { ...metadata, generation: 'not-a-generation' } }]) }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_GCS_OBJECT_INVALID');
  await assert.rejects(new InfluxDb3CoreGcsStore({ config: config(), bucketClient: listedClient([{ name: metadata.name, metadata: { ...metadata, updated: 'not-a-date' } }]) }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_GCS_OBJECT_INVALID');
  await assert.rejects(new InfluxDb3CoreGcsStore({ config: config(), bucketClient: listedClient([{ name: metadata.name, metadata }], { pageToken: 'repeated-token' }) }).inspect(), (error) => error.code === 'INFLUXDB3_CORE_GCS_LIST_INVALID');
});

test('downloads exact generations and hashes GCS objects, failing strong capture on drift and recording live-copy drift', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-gcs-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const stableClient = new MemoryGcsBucket(coreObjects());
  const stableStore = new InfluxDb3CoreGcsStore({ config: config(), bucketClient: stableClient });
  const stable = await stableStore.capture({}, path.join(root, 'stable'), 'atomic-snapshot');
  assert.equal(stable.achievedConsistency, 'application');
  assert.deepEqual(stable.driftPhases, []);
  assert.equal(stable.fileCount, 5);
  assert.equal(await fs.readFile(path.join(stable.directory, '_catalog_checkpoint'), 'utf8'), 'checkpoint-bytes');
  assert.equal(stableClient.requests.filter((request) => request.operation === 'download').every((request) => /^[1-9][0-9]{18}$/.test(request.generation) && request.options.validation === 'crc32c' && request.options.decompress === false), true);
  assert.deepEqual(stableClient.requests.filter((request) => request.operation === 'download').map((request) => request.name.split(`/${NODE_ID}/`)[1].split('/')[0]), ['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint']);
  const checkpoint = stable.files.find((file) => file.relativePath === '_catalog_checkpoint');
  assert.equal(checkpoint.contentDigest, `sha256:${crypto.createHash('sha256').update('checkpoint-bytes').digest('hex')}`);

  const changedName = `production/${NODE_ID}/snapshots/0001/snapshot.parquet`;
  const makeDriftingClient = () => {
    const client = new MemoryGcsBucket(coreObjects());
    let changed = false;
    client.onDownload = (name, current) => { if (!changed && name.includes('/catalog/')) { changed = true; current.put(changedName, 'snapshot-bytes-changed'); } };
    return client;
  };
  const atomicDestination = path.join(root, 'atomic-drift');
  await assert.rejects(new InfluxDb3CoreGcsStore({ config: config(), bucketClient: makeDriftingClient() }).capture({}, atomicDestination, 'atomic-snapshot'), (error) => error.code === 'INFLUXDB3_CORE_GCS_SOURCE_CHANGED');
  assert.equal(await fs.lstat(atomicDestination).catch(() => null), null);

  const live = await new InfluxDb3CoreGcsStore({ config: config(), bucketClient: makeDriftingClient() }).capture({}, path.join(root, 'live-drift'), 'ordered-live-copy');
  assert.equal(live.achievedConsistency, 'crash');
  assert.deepEqual(live.driftPhases, ['snapshots']);
  assert.match(live.mediaFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('restores only to the exact empty GCS node prefix and authenticates every installed generation', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-gcs-restore-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = await new InfluxDb3CoreGcsStore({ config: config(), bucketClient: new MemoryGcsBucket(coreObjects()) }).capture({}, path.join(root, 'source'), 'atomic-snapshot');
  const targetConfig = config({ bucket: 'deployerx-core-restore-data', prefix: 'alternate', credentialSecretRefId: 'secret-core-gcs-target' });
  const siblingName = `alternate/${NODE_ID}-other/snapshots/0001/sibling.parquet`;
  const targetClient = new MemoryGcsBucket({ [siblingName]: 'sibling-bytes' });
  const targetStore = new InfluxDb3CoreGcsStore({ config: targetConfig, bucketClient: targetClient });
  const targetStorageFingerprint = (await targetStore.assertEmpty()).bindingFingerprint;
  const source = restoreSource(captured, targetStorageFingerprint);

  for (const member of captured.files) await targetStore.uploadRestoreMember({}, captured.directory, member);
  const uploads = targetClient.requests.filter((request) => request.operation === 'upload');
  assert.equal(uploads.length, captured.fileCount);
  assert.equal(uploads.every((request) => request.options.resumable === false && request.options.validation === 'crc32c' && request.options.preconditionOpts?.ifGenerationMatch === 0), true);
  assert.deepEqual(uploads.map((request) => request.name.split(`/${NODE_ID}/`)[1].split('/')[0]), ['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint']);

  const installed = await targetStore.authenticateInstalled({}, source);
  assert.equal(installed.files.length, captured.fileCount);
  assert.equal(installed.totalBytes, captured.totalBytes);
  assert.deepEqual(installed.directories, captured.directories);
  assert.equal(installed.bindingFingerprint, targetStorageFingerprint);
  const validationDownloads = targetClient.requests.filter((request) => request.operation === 'download');
  assert.equal(validationDownloads.length, captured.fileCount);
  assert.equal(validationDownloads.every((request) => typeof request.generation === 'string' && /^[1-9][0-9]{18}$/.test(request.generation) && !Number.isSafeInteger(Number(request.generation)) && request.options.validation === 'crc32c' && request.options.decompress === false), true);

  const first = captured.files[0];
  const firstTargetName = `alternate/${NODE_ID}/${first.relativePath}`;
  const firstBefore = targetClient.objects.get(firstTargetName);
  await assert.rejects(targetStore.uploadRestoreMember({}, captured.directory, first), (error) => error.code === 'INFLUXDB3_CORE_GCS_RESTORE_TARGET_CHANGED');
  assert.equal(targetClient.objects.get(firstTargetName).generation, firstBefore.generation);
  assert.deepEqual(targetClient.objects.get(firstTargetName).body, firstBefore.body);

  targetClient.put(`alternate/${NODE_ID}/snapshots/9999/unexpected.parquet`, 'unexpected');
  await assert.rejects(targetStore.authenticateInstalled({}, source), (error) => error.code === 'INFLUXDB3_CORE_GCS_RESTORE_VALIDATION_FAILED');
  assert.equal(targetClient.requests.some((request) => request.operation === 'delete'), false);

  const nonEmptyClient = new MemoryGcsBucket({ [`alternate/${NODE_ID}/_catalog_checkpoint`]: 'occupied' });
  await assert.rejects(new InfluxDb3CoreGcsStore({ config: targetConfig, bucketClient: nonEmptyClient }).assertEmpty(), (error) => error.code === 'INFLUXDB3_CORE_GCS_RESTORE_TARGET_EXISTS');
});

test('refuses unauthenticated staged GCS media and preserves partial target objects after write failure', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb3-core-gcs-partial-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = await new InfluxDb3CoreGcsStore({ config: config(), bucketClient: new MemoryGcsBucket(coreObjects()) }).capture({}, path.join(root, 'source'), 'atomic-snapshot');
  const targetConfig = config({ bucket: 'deployerx-core-partial-data', prefix: 'alternate', credentialSecretRefId: 'secret-core-gcs-partial' });

  const tamperedRoot = path.join(root, 'tampered');
  await fs.cp(captured.directory, tamperedRoot, { recursive: true });
  const tamperedMember = captured.files[0];
  await fs.writeFile(path.join(tamperedRoot, ...tamperedMember.relativePath.split('/')), Buffer.alloc(tamperedMember.sizeBytes, 120));
  const untouchedClient = new MemoryGcsBucket();
  const untouchedStore = new InfluxDb3CoreGcsStore({ config: targetConfig, bucketClient: untouchedClient });
  await assert.rejects(untouchedStore.uploadRestoreMember({}, tamperedRoot, tamperedMember), (error) => error.code === 'INFLUXDB3_CORE_GCS_RESTORE_MEDIA_INVALID');
  assert.equal(untouchedClient.objects.size, 0);

  const targetClient = new MemoryGcsBucket();
  const targetStore = new InfluxDb3CoreGcsStore({ config: targetConfig, bucketClient: targetClient });
  await targetStore.uploadRestoreMember({}, captured.directory, captured.files[0]);
  await targetStore.uploadRestoreMember({}, captured.directory, captured.files[1]);
  const failedMember = captured.files[2];
  targetClient.failUploadName = `alternate/${NODE_ID}/${failedMember.relativePath}`;
  await assert.rejects(targetStore.uploadRestoreMember({}, captured.directory, failedMember), (error) => error.code === 'INFLUXDB3_CORE_GCS_RESTORE_WRITE_FAILED');
  assert.equal(targetClient.objects.has(`alternate/${NODE_ID}/${captured.files[0].relativePath}`), true);
  assert.equal(targetClient.objects.has(`alternate/${NODE_ID}/${captured.files[1].relativePath}`), true);
  assert.equal(targetClient.objects.has(`alternate/${NODE_ID}/${failedMember.relativePath}`), false);
  assert.equal(targetClient.requests.some((request) => request.operation === 'delete'), false);
});
