const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { BackupSecretStore } = require('./secrets');
const { MIN_CHUNK_SIZE_BYTES } = require('./repository-engine');
const {
  ADAPTER_ID,
  DIRECT_UPLOAD_LIMIT_BYTES,
  S3CompatibleRepositoryAdapter,
  S3RepositoryService,
  normalizeS3Credential,
  normalizeS3RepositoryConfig
} = require('./s3-repository');

async function bodyBuffer(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  const parts = [];
  for await (const part of body) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

function providerError(name, status) {
  return Object.assign(new Error('provider detail must not escape'), { name, $metadata: { httpStatusCode: status } });
}

class MemoryS3Client {
  constructor({ conditionalWrites = true, conditionalMatches = true, versioning = true, objectLock = false } = {}) {
    this.conditionalWrites = conditionalWrites;
    this.conditionalMatches = conditionalMatches;
    this.versioning = versioning;
    this.objectLock = objectLock;
    this.objects = new Map();
    this.uploads = new Map();
  }

  async send(command) {
    const input = command.input;
    switch (command.constructor.name) {
      case 'HeadBucketCommand': return { $metadata: { httpStatusCode: 200 } };
      case 'PutObjectCommand': {
        if (input.IfNoneMatch === '*' && this.conditionalWrites && this.objects.has(input.Key)) throw providerError('PreconditionFailed', 412);
        if (input.IfMatch && this.conditionalMatches && this.objects.get(input.Key)?.etag !== input.IfMatch) throw providerError('PreconditionFailed', 412);
        const body = await bodyBuffer(input.Body);
        if (input.ContentLength !== body.length) throw providerError('InvalidRequest', 400);
        if (input.ChecksumSHA256 && crypto.createHash('sha256').update(body).digest('base64') !== input.ChecksumSHA256) throw providerError('BadDigest', 400);
        this.objects.set(input.Key, { body, metadata: input.Metadata || {}, modifiedAt: new Date('2026-08-03T12:00:00.000Z'), etag: `"${crypto.createHash('md5').update(body).digest('hex')}"`, versionId: this.versioning ? crypto.randomUUID() : null });
        return { ETag: this.objects.get(input.Key).etag, VersionId: this.objects.get(input.Key).versionId };
      }
      case 'HeadObjectCommand': {
        const object = this.objects.get(input.Key);
        if (!object) throw providerError('NotFound', 404);
        return { ContentLength: object.body.length, LastModified: object.modifiedAt, ETag: object.etag, VersionId: object.versionId, Metadata: object.metadata, ChecksumSHA256: crypto.createHash('sha256').update(object.body).digest('base64') };
      }
      case 'GetObjectCommand': {
        const object = this.objects.get(input.Key);
        if (!object) throw providerError('NoSuchKey', 404);
        let body = object.body;
        let contentRange;
        if (input.Range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(input.Range);
          if (!match) throw providerError('InvalidRange', 416);
          const start = Number(match[1]);
          const end = match[2] ? Number(match[2]) : body.length - 1;
          body = body.subarray(start, Math.min(end + 1, body.length));
          contentRange = `bytes ${start}-${start + body.length - 1}/${object.body.length}`;
        }
        return { Body: (async function* stream() { yield body; })(), ContentLength: body.length, ContentRange: contentRange, ETag: object.etag };
      }
      case 'DeleteObjectCommand': {
        if (input.IfMatch && this.conditionalMatches && this.objects.get(input.Key)?.etag !== input.IfMatch) throw providerError('PreconditionFailed', 412);
        const deleted = this.objects.delete(input.Key);
        return { DeleteMarker: this.versioning && deleted, VersionId: this.versioning && deleted ? crypto.randomUUID() : null };
      }
      case 'ListObjectsV2Command': {
        const keys = [...this.objects.keys()].filter((key) => key.startsWith(input.Prefix || '')).sort();
        const offset = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
        const selected = keys.slice(offset, offset + input.MaxKeys);
        const next = offset + selected.length;
        return {
          Contents: selected.map((key) => ({ Key: key, Size: this.objects.get(key).body.length, LastModified: this.objects.get(key).modifiedAt, ETag: this.objects.get(key).etag })),
          IsTruncated: next < keys.length,
          NextContinuationToken: next < keys.length ? String(next) : undefined
        };
      }
      case 'CreateMultipartUploadCommand': {
        const uploadId = crypto.randomUUID();
        this.uploads.set(uploadId, { key: input.Key, metadata: input.Metadata || {}, parts: new Map() });
        return { UploadId: uploadId };
      }
      case 'UploadPartCommand': {
        const upload = this.uploads.get(input.UploadId);
        if (!upload) throw providerError('NoSuchUpload', 404);
        const body = await bodyBuffer(input.Body);
        const checksum = crypto.createHash('sha256').update(body).digest('base64');
        if (input.ChecksumSHA256 !== checksum) throw providerError('BadDigest', 400);
        upload.parts.set(input.PartNumber, body);
        return { ETag: `"part-${input.PartNumber}"`, ChecksumSHA256: checksum };
      }
      case 'CompleteMultipartUploadCommand': {
        const upload = this.uploads.get(input.UploadId);
        if (!upload) throw providerError('NoSuchUpload', 404);
        if (input.IfNoneMatch === '*' && this.conditionalWrites && this.objects.has(input.Key)) throw providerError('PreconditionFailed', 412);
        const body = Buffer.concat([...upload.parts.entries()].sort(([left], [right]) => left - right).map(([, part]) => part));
        const object = { body, metadata: upload.metadata, modifiedAt: new Date('2026-08-03T12:00:00.000Z'), etag: '"multipart"', versionId: this.versioning ? crypto.randomUUID() : null };
        this.objects.set(input.Key, object);
        this.uploads.delete(input.UploadId);
        return { ETag: object.etag, VersionId: object.versionId };
      }
      case 'AbortMultipartUploadCommand': this.uploads.delete(input.UploadId); return {};
      case 'GetBucketVersioningCommand': return { Status: this.versioning ? 'Enabled' : 'Suspended' };
      case 'GetObjectLockConfigurationCommand': return { ObjectLockConfiguration: this.objectLock ? { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } } } : { ObjectLockEnabled: 'Disabled' } };
      default: throw new Error(`Unexpected command: ${command.constructor.name}`);
    }
  }
}

function adapterFor(client, overrides = {}) {
  return new S3CompatibleRepositoryAdapter({
    config: { endpoint: 'https://objects.example.com', region: 'us-east-1', bucket: 'deployerx-tests', prefix: 'workspace-a', forcePathStyle: true, ...overrides },
    credentialSecretRefId: 'sec_s3', resolveSecret: async () => JSON.stringify({ accessKeyId: 'access-key', secretAccessKey: 'secret-key' }), client,
    clock: () => '2026-08-03T12:00:00.000Z'
  });
}

async function put(adapter, key, body) {
  const bytes = Buffer.from(body);
  const checksum = { algorithm: 'sha256', digest: crypto.createHash('sha256').update(bytes).digest('hex') };
  const session = await adapter.write({}, { key, body: bytes, sizeBytes: bytes.length, checksum });
  return adapter.commit({}, session);
}

async function readObject(adapter, key, options = {}) {
  const parts = [];
  for await (const part of await adapter.read({}, { key, ...options })) parts.push(part);
  return Buffer.concat(parts);
}

function fakeSecureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5),
    decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString('utf8')
  };
}

test('normalizes provider-neutral S3 configuration and keeps credentials separate', () => {
  assert.deepEqual(normalizeS3RepositoryConfig({ endpoint: 'https://objects.example.com/', region: 'US-EAST-1', bucket: 'deployerx-tests', prefix: 'team/archive', forcePathStyle: true }), {
    endpoint: 'https://objects.example.com', region: 'us-east-1', bucket: 'deployerx-tests', prefix: 'team/archive', forcePathStyle: true, allowInsecureEndpoint: false, timeoutMs: 30000
  });
  assert.deepEqual(normalizeS3Credential({ accessKeyId: 'access', secretAccessKey: 'secret', sessionToken: 'token' }), { accessKeyId: 'access', secretAccessKey: 'secret', sessionToken: 'token' });
  assert.throws(() => normalizeS3RepositoryConfig({ endpoint: 'http://minio.local', bucket: 'valid-bucket' }), /explicit insecure-endpoint approval/);
  assert.throws(() => normalizeS3RepositoryConfig({ bucket: '../escape' }), /bucket name/);
  assert.throws(() => normalizeS3RepositoryConfig({ bucket: 'valid-bucket', prefix: '../escape' }), /prefix/);
});

test('removes a partially created credential SecretRef when encryption-key creation fails', async () => {
  const deleted = [];
  let createCount = 0;
  const service = new S3RepositoryService({
    controlDatabase: { repository: () => ({ list: async () => [] }) },
    secretStore: {
      create: async () => {
        createCount += 1;
        if (createCount === 2) throw new Error('secure storage unavailable');
        return { id: 'sec_credentials' };
      },
      delete: async ({ id }) => deleted.push(id)
    },
    deviceId: 'device-a'
  });
  await assert.rejects(service.create('workspace-a', 'tester', {
    name: 'S3 archive', region: 'us-east-1', bucket: 'deployerx-tests',
    accessKeyId: 'access-key', secretAccessKey: 'secret-key'
  }), /secure storage unavailable/);
  assert.deepEqual(deleted, ['sec_credentials']);
});

test('uses conditional immutable puts, ranged reads, bounded listings, copy, and idempotent delete', async () => {
  const client = new MemoryS3Client();
  const adapter = adapterFor(client);
  const first = await put(adapter, 'chunks/v1/aa/one.dxb', Buffer.from('encrypted-one'));
  assert.equal(first.existing, false);
  assert.equal((await put(adapter, first.key, Buffer.from('encrypted-one'))).existing, true);
  await assert.rejects(put(adapter, first.key, Buffer.from('different')), (error) => error.code === 'S3_REPOSITORY_OBJECT_CONFLICT');
  assert.deepEqual(await readObject(adapter, first.key, { offset: 2, length: 5 }), Buffer.from('crypt'));
  await put(adapter, 'chunks/v1/bb/two.dxb', Buffer.from('encrypted-two'));
  const firstPage = (await adapter.list({}, { prefix: 'chunks/', pageSize: 1 }).next()).value;
  const secondPage = (await adapter.list({}, { prefix: 'chunks/', pageSize: 1, cursor: firstPage.nextCursor }).next()).value;
  assert.equal(firstPage.hasMore, true);
  assert.equal(secondPage.hasMore, false);
  await adapter.copy({}, { sourceKey: first.key, targetKey: 'indexes/v1/copied.dxb' });
  assert.deepEqual(await readObject(adapter, 'indexes/v1/copied.dxb'), Buffer.from('encrypted-one'));
  assert.equal((await adapter.delete({}, { key: 'indexes/v1/copied.dxb' })).deleted, true);
  assert.equal((await adapter.delete({}, { key: 'indexes/v1/copied.dxb' })).absent, true);
});

test('uploads large repository objects with bounded multipart parts', async () => {
  const client = new MemoryS3Client();
  const adapter = adapterFor(client);
  const body = Buffer.alloc(DIRECT_UPLOAD_LIMIT_BYTES + 257, 0x4a);
  const committed = await put(adapter, 'chunks/v1/cc/multipart.dxb', body);
  assert.equal(committed.multipart, true);
  assert.deepEqual(await readObject(adapter, committed.key), body);
  assert.equal(client.uploads.size, 0);
});

test('coordinates encrypted conditional S3 leases with renewal and expired takeover', async () => {
  const client = new MemoryS3Client();
  const masterKey = crypto.randomBytes(32);
  let now = Date.parse('2026-08-03T12:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  const first = adapterFor(client);
  const second = new S3CompatibleRepositoryAdapter({
    config: { endpoint: 'https://objects.example.com', region: 'us-east-1', bucket: 'deployerx-tests', prefix: 'workspace-a', forcePathStyle: true },
    credentialSecretRefId: 'sec_s3', resolveSecret: async () => JSON.stringify({ accessKeyId: 'access-key', secretAccessKey: 'secret-key' }), client, clock
  });
  first.clock = clock;
  const request = { repositoryId: 'repo-s3', operation: 'backup', workerId: 'worker-a', runId: 'run-a', ttlMs: 5000 };
  const lease = await first.acquireLock({ masterKey }, request);
  await assert.rejects(second.acquireLock({ masterKey }, { ...request, workerId: 'worker-b', runId: 'run-b' }), (error) => error.code === 'REPOSITORY_LOCK_CONTENDED');
  now += 1000;
  const renewed = await first.renewLock({ masterKey }, lease);
  assert.equal(Date.parse(renewed.expiresAt), now + 5000);
  assert.deepEqual(await first.releaseLock({ masterKey }, renewed), { released: true, absent: false });
  const replacement = await second.acquireLock({ masterKey }, { ...request, workerId: 'worker-b', runId: 'run-b' });
  now += 6000;
  const takeover = await first.acquireLock({ masterKey }, { ...request, workerId: 'worker-c', runId: 'run-c' });
  assert.notEqual(takeover.leaseId, replacement.leaseId);
  assert.deepEqual(await first.releaseLock({ masterKey }, takeover), { released: true, absent: false });
});

test('probes conditional writes, range reads, versioning, and Object Lock without overclaiming', async () => {
  const capable = adapterFor(new MemoryS3Client({ versioning: true, objectLock: true }));
  const result = await capable.probeCapabilities();
  assert.equal(result.status, 'available');
  assert.equal(result.capabilities.versioning, true);
  assert.equal(result.capabilities.objectImmutability, true);
  assert.equal((await capable.validateImmutability()).enforced, true);

  const unsafe = adapterFor(new MemoryS3Client({ conditionalWrites: false }));
  const refused = await unsafe.probeCapabilities();
  assert.equal(refused.status, 'unavailable');
  assert.equal(refused.connectionTest.error.code, 'S3_REPOSITORY_CONDITIONAL_WRITE_UNAVAILABLE');
  assert.equal(refused.connectionTest.error.safeMessage.includes('provider detail'), false);
  const unsafeLocking = await adapterFor(new MemoryS3Client({ conditionalMatches: false })).probeCapabilities();
  assert.equal(unsafeLocking.status, 'unavailable');
  assert.equal(unsafeLocking.connectionTest.error.code, 'S3_REPOSITORY_LOCKING_UNAVAILABLE');
});

test('runs the encrypted repository engine over S3-compatible object storage', async () => {
  const client = new MemoryS3Client();
  const adapter = adapterFor(client);
  const { FileRepositoryEngine } = require('./repository-engine');
  const engine = new FileRepositoryEngine({ adapter, clock: () => '2026-08-03T12:00:00.000Z' });
  const masterKey = Buffer.alloc(32, 0x37);
  const plaintext = Buffer.concat([Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x29), Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x29)]);
  const snapshot = await engine.createSnapshot({}, {
    repositoryId: 'repo-s3', keyVersion: 'secret:1', masterKey, idempotencyKey: 's3-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES,
    files: [{ path: '/private/s3-source.txt', type: 'file', metadata: null, content: plaintext }]
  });
  assert.equal(snapshot.uploadedChunkCount, 1);
  const reopened = new FileRepositoryEngine({ adapter: adapterFor(client) });
  const opened = await reopened.openSnapshot({}, { repositoryId: 'repo-s3', snapshotId: snapshot.snapshotId, masterKey });
  assert.deepEqual(await reopened.readFile({}, { repositoryId: 'repo-s3', manifest: opened.manifest, path: '/private/s3-source.txt', masterKey }), plaintext);
  const stored = Buffer.concat([...client.objects.values()].map((object) => object.body));
  assert.equal(stored.includes(plaintext), false);
  assert.equal(stored.includes(Buffer.from('/private/s3-source.txt')), false);
});

test('persists device-scoped S3 repositories and removes credentials while retaining data and recovery keys', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-s3-repository-service-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control'), clock: () => '2026-08-03T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const secretStore = new BackupSecretStore({
    rootPath: path.join(rootPath, 'secrets'), secureStorage: fakeSecureStorage(),
    isReferenced: async ({ workspaceId, id }) => (await controlDatabase.repository('repository').list(workspaceId, { includeDeleted: true, limit: 1000 }))
      .some((repository) => repository.encryptionKeyRefId === id || (!repository.deletedAt && (repository.secretRefIds || []).includes(id)))
  });
  await secretStore.initialize();
  const client = new MemoryS3Client({ versioning: true });
  const service = new S3RepositoryService({
    controlDatabase, secretStore, deviceId: 'device-a', clock: () => '2026-08-03T12:00:00.000Z',
    adapterFactory: (config) => new S3CompatibleRepositoryAdapter({ ...config, client })
  });
  const repository = await service.create('workspace-a', 'tester', {
    name: 'S3 archive', endpoint: 'https://objects.example.com', region: 'us-east-1', bucket: 'deployerx-tests', prefix: 'workspace-a', forcePathStyle: true,
    accessKeyId: 'access-key', secretAccessKey: 'secret-key'
  });
  assert.equal(repository.adapterId, ADAPTER_ID);
  assert.equal(repository.health.status, 'ready');
  assert.equal(repository.secretRefIds.length, 1);
  assert.match(repository.encryptionKeyRefId, /^sec_/);
  assert.equal(JSON.stringify(repository).includes('secret-key'), false);
  assert.equal((await service.list('workspace-a')).length, 1);
  assert.deepEqual(await service.list('workspace-b'), []);
  const opened = await service.open('workspace-a', repository.id);
  assert.equal(opened.masterKey.length, 32);
  const healthCheck = await service.test('workspace-a', 'tester', repository.id);
  assert.equal(healthCheck.repository.health.status, 'ready');
  assert.equal(healthCheck.lockState.status, 'available');
  assert.equal(healthCheck.capacity.reporting, 'unavailable');
  const removed = await service.remove('workspace-a', 'tester', repository.id, healthCheck.repository.revision);
  assert.equal(removed.encryptionKeyRetained, true);
  assert.equal(removed.credentialsRemoved, true);
  assert.equal(client.objects.size > 0, true);
  assert.deepEqual(await service.list('workspace-a'), []);
  const refs = await secretStore.list('workspace-a');
  assert.equal(refs.some((ref) => ref.id === repository.encryptionKeyRefId), true);
  assert.equal(refs.some((ref) => repository.secretRefIds.includes(ref.id)), false);
});
