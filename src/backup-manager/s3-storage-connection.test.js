const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { BackupSecretStore } = require('./secrets');
const { ADAPTER_ID: S3_REPOSITORY_ADAPTER_ID } = require('./s3-repository');
const { ADAPTER_ID, S3StorageConnectionService } = require('./s3-storage-connection');

function fakeSecureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5),
    decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString('utf8')
  };
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-s3-connection-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control'), clock: () => '2026-08-07T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const secretStore = new BackupSecretStore({
    rootPath: path.join(rootPath, 'secrets'),
    secureStorage: fakeSecureStorage(),
    isReferenced: async ({ workspaceId, id }) => {
      const [connections, repositories] = await Promise.all([
        controlDatabase.repository('connection').list(workspaceId, { includeDeleted: true, limit: 1000 }),
        controlDatabase.repository('repository').list(workspaceId, { includeDeleted: true, limit: 1000 })
      ]);
      return connections.some((record) => !record.deletedAt && record.secretRefIds?.includes(id))
        || repositories.some((record) => record.encryptionKeyRefId === id || (!record.deletedAt && record.secretRefIds?.includes(id)));
    }
  });
  await secretStore.initialize();
  const service = new S3StorageConnectionService({ controlDatabase, secretStore, deviceId: 'device-a', clock: () => '2026-08-07T12:00:00.000Z' });
  return { controlDatabase, secretStore, service };
}

test('stores reusable S3 credentials on a storage connection', async (context) => {
  const { secretStore, service } = await fixture(context);
  const connection = await service.create('workspace-a', 'tester', {
    name: 'Production object storage',
    endpoint: 'https://objects.example.com',
    accessKeyId: 'access-key',
    secretAccessKey: 'secret-key',
    forcePathStyle: true
  });
  assert.equal(connection.kind, 'storage');
  assert.equal(connection.adapterId, ADAPTER_ID);
  assert.equal(connection.endpoint.endpoint, 'https://objects.example.com');
  assert.equal(connection.secretRefIds.length, 1);
  assert.equal(JSON.stringify(connection).includes('secret-key'), false);
  assert.equal((await service.list('workspace-a')).length, 1);

  const removed = await service.remove('workspace-a', 'tester', connection.id, connection.revision);
  assert.deepEqual(removed.credentialsNotRemoved, []);
  assert.deepEqual(await service.list('workspace-a'), []);
  assert.deepEqual(await secretStore.list('workspace-a'), []);
});

test('migrates legacy S3 destination credentials into an idempotent reusable connection', async (context) => {
  const { controlDatabase, secretStore, service } = await fixture(context);
  const credentialRef = await secretStore.create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'Legacy S3 credentials', secretType: 'access-key', value: JSON.stringify({ accessKeyId: 'access', secretAccessKey: 'secret' }), scope: 'device' });
  const keyRef = await secretStore.create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'Legacy destination key', secretType: 'encryption-key', value: Buffer.alloc(32, 7).toString('base64'), scope: 'device' });
  const legacy = await controlDatabase.transaction((transaction) => {
    transaction.create('secretRef', secretMetadataInput(credentialRef, 'tester'));
    transaction.create('secretRef', secretMetadataInput(keyRef, 'tester'));
    return transaction.create('repository', {
      workspaceId: 'workspace-a', actorId: 'tester', name: 'Legacy cloud archive', connectionId: null,
      adapterId: S3_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: 'deployerx.repository-engine.file', engineVersion: '1.0.0',
      location: { endpoint: 'https://objects.example.com', region: 'us-east-1', bucket: 'legacy-archive', prefix: 'daily', forcePathStyle: true, allowInsecureEndpoint: false, timeoutMs: 30000 },
      secretRefIds: [credentialRef.id], encryptionKeyRefId: keyRef.id, encryption: { algorithm: 'aes-256-gcm', keyVersion: `secret:${keyRef.version}` },
      scope: 'device', workerAffinity: ['device:device-a'], immutability: { mode: 'none', enforced: false }, storagePolicy: {}, capacity: null, health: { status: 'ready', checkedAt: '2026-08-07T12:00:00.000Z' }
    });
  });

  const first = await service.migrateLegacyRepositories('workspace-a', 'tester');
  const second = await service.migrateLegacyRepositories('workspace-a', 'tester');
  assert.equal(first.migrated.length, 1);
  assert.equal(second.migrated.length, 0);
  const destination = await controlDatabase.repository('repository').get('workspace-a', legacy.id);
  const connection = await controlDatabase.repository('connection').get('workspace-a', destination.connectionId);
  assert.equal(destination.id, legacy.id);
  assert.deepEqual(destination.secretRefIds, []);
  assert.deepEqual(destination.location, { region: 'us-east-1', bucket: 'legacy-archive', prefix: 'daily' });
  assert.equal(connection.adapterId, ADAPTER_ID);
  assert.deepEqual(connection.secretRefIds, [credentialRef.id]);
  assert.equal(connection.endpoint.endpoint, 'https://objects.example.com');
  await assert.rejects(service.remove('workspace-a', 'tester', connection.id, connection.revision), /referenced by an active repository/);
});
