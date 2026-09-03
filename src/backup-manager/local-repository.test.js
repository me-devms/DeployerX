const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { BackupSecretStore } = require('./secrets');
const { LocalConnectionService } = require('./local-connection');
const { MIN_CHUNK_SIZE_BYTES } = require('./repository-engine');
const {
  ADAPTER_ID,
  LocalFolderRepositoryAdapter,
  LocalRepositoryError,
  LocalRepositoryService,
  STORE_DIRECTORY,
  normalizeLocalRepositoryConfig,
  normalizeObjectKey
} = require('./local-repository');

function fakeSecureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5),
    decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString('utf8')
  };
}

async function readAdapterObject(adapter, key) {
  const chunks = [];
  for await (const chunk of await adapter.read({}, { key })) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function put(adapter, key, body) {
  const buffer = Buffer.from(body);
  const checksum = { algorithm: 'sha256', digest: crypto.createHash('sha256').update(buffer).digest('hex') };
  const session = await adapter.write({}, { key, body: buffer, sizeBytes: buffer.length, checksum, idempotencyKey: `put:${key}` });
  return adapter.commit({}, session);
}

async function rootFixture(context, prefix = 'deployerx-local-repository-test-') {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  return rootPath;
}

async function serviceFixture(context) {
  const rootPath = await rootFixture(context, 'deployerx-local-repository-service-test-');
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control'), clock: () => '2026-08-03T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const secretStore = new BackupSecretStore({
    rootPath: path.join(rootPath, 'secrets'),
    secureStorage: fakeSecureStorage(),
    isReferenced: async ({ workspaceId, id }) => (await controlDatabase.repository('repository').list(workspaceId, { includeDeleted: true, limit: 1000 }))
      .some((repository) => repository.encryptionKeyRefId === id || (!repository.deletedAt && (repository.secretRefIds || []).includes(id)))
  });
  await secretStore.initialize();
  const repositoryPath = path.join(rootPath, 'destination');
  const service = new LocalRepositoryService({ controlDatabase, secretStore, deviceId: 'device-a', clock: () => '2026-08-03T12:00:00.000Z' });
  return { rootPath, repositoryPath, controlDatabase, secretStore, service };
}

test('validates absolute local folders and traversal-safe opaque object keys', () => {
  assert.throws(() => normalizeLocalRepositoryConfig({ rootPath: 'relative' }), /absolute/);
  assert.equal(normalizeLocalRepositoryConfig({ rootPath: 'C:\\Backups' }, path.win32).rootPath, 'C:\\Backups');
  assert.equal(normalizeObjectKey('chunks/v1/ab/object.dxb'), 'chunks/v1/ab/object.dxb');
  for (const key of ['../escape', '/absolute', 'a\\b', 'a//b', 'a/./b', 'a/../../b', 'a:b']) {
    assert.throws(() => normalizeObjectKey(key), (error) => error instanceof LocalRepositoryError && error.code === 'LOCAL_REPOSITORY_KEY_INVALID');
  }
});

test('atomically commits immutable objects and refuses conflicting content', async (context) => {
  const rootPath = await rootFixture(context);
  const adapter = new LocalFolderRepositoryAdapter({ rootPath });
  const body = Buffer.from('encrypted repository object');
  const first = await put(adapter, 'chunks/v1/aa/object.dxb', body);
  assert.equal(first.existing, false);
  assert.deepEqual(await readAdapterObject(adapter, first.key), body);
  assert.equal((await adapter.stat({}, first.key)).sizeBytes, body.length);
  const repeated = await put(adapter, first.key, body);
  assert.equal(repeated.existing, true);

  const conflictingBody = Buffer.from('different bytes');
  const checksum = { algorithm: 'sha256', digest: crypto.createHash('sha256').update(conflictingBody).digest('hex') };
  const session = await adapter.write({}, { key: first.key, body: conflictingBody, sizeBytes: conflictingBody.length, checksum });
  await assert.rejects(adapter.commit({}, session), (error) => error.code === 'LOCAL_REPOSITORY_OBJECT_CONFLICT');
  await adapter.abort({}, session);
  assert.deepEqual(await readAdapterObject(adapter, first.key), body);
  assert.deepEqual(await fs.readdir(path.join(rootPath, STORE_DIRECTORY, 'staging')), []);
});

test('paginates bounded key listings, copies objects, and deletes idempotently', async (context) => {
  const rootPath = await rootFixture(context);
  const adapter = new LocalFolderRepositoryAdapter({ rootPath });
  await put(adapter, 'chunks/v1/aa/one.dxb', Buffer.from('one'));
  await put(adapter, 'chunks/v1/bb/two.dxb', Buffer.from('two'));
  await put(adapter, 'manifests/v1/snp_test.dxb', Buffer.from('manifest'));

  const firstIterator = adapter.list({}, { prefix: 'chunks/', pageSize: 1 });
  const first = (await firstIterator.next()).value;
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  const second = (await adapter.list({}, { prefix: 'chunks/', pageSize: 1, cursor: first.nextCursor }).next()).value;
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false);
  await assert.rejects(async () => adapter.list({}, { prefix: 'manifests/', cursor: first.nextCursor }).next(), (error) => error.code === 'LOCAL_REPOSITORY_CURSOR_INVALID');

  await adapter.copy({}, { sourceKey: first.items[0].key, targetKey: 'indexes/v1/copied.dxb' });
  assert.deepEqual(await readAdapterObject(adapter, 'indexes/v1/copied.dxb'), await readAdapterObject(adapter, first.items[0].key));
  assert.deepEqual(await adapter.delete({}, { key: 'indexes/v1/copied.dxb' }), { key: 'indexes/v1/copied.dxb', deleted: true, absent: false });
  assert.deepEqual(await adapter.delete({}, { key: 'indexes/v1/copied.dxb' }), { key: 'indexes/v1/copied.dxb', deleted: false, absent: true });
});

test('preserves copy-source integrity errors and cleans up failed connection probes', async (context) => {
  const rootPath = await rootFixture(context);
  const adapter = new LocalFolderRepositoryAdapter({ rootPath });
  await adapter.initialize();
  await fs.mkdir(path.join(rootPath, STORE_DIRECTORY, 'objects', 'invalid-source'));
  await assert.rejects(
    adapter.copy({}, { sourceKey: 'invalid-source', targetKey: 'indexes/v1/copied.dxb' }),
    (error) => error.code === 'LOCAL_REPOSITORY_OBJECT_INVALID' && error.category === 'integrity'
  );

  const failingFileSystem = {
    ...fs,
    open: async (...args) => {
      const handle = await fs.open(...args);
      if (!path.basename(args[0]).startsWith('.probe-')) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') return async () => { throw Object.assign(new Error('simulated sync failure'), { code: 'EIO' }); };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
  const failingAdapter = new LocalFolderRepositoryAdapter({ rootPath, fileSystem: failingFileSystem });
  const result = await failingAdapter.testConnection();
  assert.equal(result.status, 'failure');
  assert.deepEqual(await fs.readdir(path.join(rootPath, STORE_DIRECTORY, 'staging')), []);
});

test('coordinates encrypted local repository leases across adapter instances', async (context) => {
  const rootPath = await rootFixture(context);
  const masterKey = crypto.randomBytes(32);
  let now = Date.parse('2026-08-03T12:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  const first = new LocalFolderRepositoryAdapter({ rootPath, clock });
  const second = new LocalFolderRepositoryAdapter({ rootPath, clock });
  const request = { repositoryId: 'repo-local', operation: 'backup', workerId: 'worker-a', runId: 'run-a', ttlMs: 5000 };
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

test('runs the encrypted repository engine against real local-folder object storage', async (context) => {
  const rootPath = await rootFixture(context);
  const adapter = new LocalFolderRepositoryAdapter({ rootPath });
  const { FileRepositoryEngine } = require('./repository-engine');
  const engine = new FileRepositoryEngine({ adapter, clock: () => '2026-08-03T12:00:00.000Z' });
  const masterKey = Buffer.alloc(32, 0x31);
  const content = Buffer.concat([Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x51), Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x51)]);
  const snapshot = await engine.createSnapshot({}, {
    repositoryId: 'repo-real-local', keyVersion: 'secret:1', masterKey, idempotencyKey: 'run-local', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES,
    files: [{ path: '/private/source.txt', type: 'file', metadata: { permissions: { mode: 0o600 } }, content }]
  });
  assert.equal(snapshot.uploadedChunkCount, 1);
  assert.equal(snapshot.reusedBytes, MIN_CHUNK_SIZE_BYTES);
  const reopened = new FileRepositoryEngine({ adapter: new LocalFolderRepositoryAdapter({ rootPath }) });
  const opened = await reopened.openSnapshot({}, { repositoryId: 'repo-real-local', snapshotId: snapshot.snapshotId, masterKey });
  assert.deepEqual(await reopened.readFile({}, { repositoryId: 'repo-real-local', manifest: opened.manifest, path: '/private/source.txt', masterKey }), content);
  const files = await fs.readdir(path.join(rootPath, STORE_DIRECTORY, 'objects', 'manifests', 'v1'));
  const manifestBytes = await fs.readFile(path.join(rootPath, STORE_DIRECTORY, 'objects', 'manifests', 'v1', files[0]));
  assert.equal(manifestBytes.includes(Buffer.from('/private/source.txt')), false);
});

test('persists device-scoped local repositories with generated encryption SecretRefs', async (context) => {
  const fixture = await serviceFixture(context);
  const repository = await fixture.service.create('workspace-a', 'tester', { name: 'Local archive', rootPath: fixture.repositoryPath });
  assert.equal(repository.adapterId, ADAPTER_ID);
  assert.equal(repository.health.status, 'ready');
  assert.equal(repository.connectionId, null);
  assert.deepEqual(repository.workerAffinity, ['device:device-a']);
  assert.match(repository.encryptionKeyRefId, /^sec_/);
  assert.equal((await fixture.service.list('workspace-a')).length, 1);
  assert.deepEqual(await fixture.service.list('workspace-b'), []);
  const keyMetadata = await fixture.controlDatabase.repository('secretRef').get('workspace-a', repository.encryptionKeyRefId);
  assert.equal(keyMetadata.secretType, 'encryption-key');

  const opened = await fixture.service.open('workspace-a', repository.id);
  assert.equal(opened.masterKey.length, 32);
  const healthCheck = await fixture.service.test('workspace-a', 'tester', repository.id);
  assert.equal(healthCheck.repository.health.status, 'ready');
  assert.equal(healthCheck.lockState.status, 'available');
  assert.equal(healthCheck.capacity.reporting, 'exact');
  const snapshot = await opened.engine.createSnapshot({}, {
    repositoryId: repository.id, keyVersion: opened.keyVersion, masterKey: opened.masterKey, idempotencyKey: 'service-run',
    files: [{ path: '/service-secret.txt', type: 'file', metadata: null, content: Buffer.from('service plaintext') }]
  });
  assert.match(snapshot.snapshotId, /^snp_/);
  const persisted = await fs.readFile(path.join(fixture.repositoryPath, STORE_DIRECTORY, 'objects', snapshot.manifestKey.split('/').join(path.sep)));
  assert.equal(persisted.includes(Buffer.from('service plaintext')), false);
  assert.equal(persisted.includes(Buffer.from('/service-secret.txt')), false);

  const otherDevice = new LocalRepositoryService({ controlDatabase: fixture.controlDatabase, secretStore: fixture.secretStore, deviceId: 'device-b' });
  await assert.rejects(otherDevice.open('workspace-a', repository.id), /another device/);
});

test('removes repository configuration without decrypting its retained recovery key', async (context) => {
  const fixture = await serviceFixture(context);
  const repository = await fixture.service.create('workspace-a', 'tester', { name: 'Retained archive', rootPath: fixture.repositoryPath });
  const markerPath = path.join(fixture.repositoryPath, STORE_DIRECTORY, 'objects', 'repository', 'format.json');
  assert.equal((await fs.stat(markerPath)).isFile(), true);
  const originalResolve = fixture.secretStore.resolve;
  fixture.secretStore.resolve = async () => { throw new Error('Secret could not be decrypted on this device.'); };
  let removed;
  try {
    removed = await fixture.service.remove('workspace-a', 'tester', repository.id, repository.revision);
  } finally {
    fixture.secretStore.resolve = originalResolve;
  }
  assert.equal(removed.dataRetainedAt, fixture.repositoryPath);
  assert.deepEqual(await fixture.service.list('workspace-a'), []);
  assert.equal((await fs.stat(markerPath)).isFile(), true);
  assert.equal(removed.encryptionKeyRetained, true);
  assert.equal((await fixture.secretStore.list('workspace-a')).length, 1);
  const keyMetadata = await fixture.controlDatabase.repository('secretRef').get('workspace-a', repository.encryptionKeyRefId);
  assert.equal(keyMetadata.secretType, 'encryption-key');
  await assert.rejects(fixture.secretStore.delete({ workspaceId: 'workspace-a', id: repository.encryptionKeyRefId }), /referenced/);
});

test('links legacy local destinations to the reusable device connection idempotently', async (context) => {
  const fixture = await serviceFixture(context);
  const legacy = await fixture.service.create('workspace-a', 'tester', { name: 'Legacy local archive', rootPath: fixture.repositoryPath });
  assert.equal(legacy.connectionId, null);
  const connectionService = new LocalConnectionService({ controlDatabase: fixture.controlDatabase, deviceId: 'device-a' });
  const service = new LocalRepositoryService({
    controlDatabase: fixture.controlDatabase,
    secretStore: fixture.secretStore,
    deviceId: 'device-a',
    connectionService
  });
  const first = await service.migrateLegacyRepositories('workspace-a', 'tester');
  const second = await service.migrateLegacyRepositories('workspace-a', 'tester');
  assert.equal(first.migrated.length, 1);
  assert.equal(second.migrated.length, 0);
  const destination = await fixture.controlDatabase.repository('repository').get('workspace-a', legacy.id);
  assert.equal(destination.connectionId, first.connection.id);
  assert.equal((await connectionService.list('workspace-a')).length, 1);
  await assert.rejects(
    fixture.controlDatabase.repository('connection').softDelete('workspace-a', first.connection.id, { expectedRevision: first.connection.revision, actorId: 'tester' }),
    /referenced by an active repository/
  );
});
