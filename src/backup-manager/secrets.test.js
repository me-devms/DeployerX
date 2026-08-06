const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupSecretStore } = require('./secrets');

function fakeSecureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^encrypted:/, '')
  };
}

async function createFixture(isReferenced = async () => false) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-secrets-test-'));
  const store = new BackupSecretStore({ rootPath, secureStorage: fakeSecureStorage(), isReferenced });
  await store.initialize();
  return {
    rootPath,
    store,
    cleanup: () => fs.rm(rootPath, { recursive: true, force: true })
  };
}

test('creates encrypted SecretRefs and returns metadata only', async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const created = await fixture.store.create({
    workspaceId: 'local',
    name: 'SSH key passphrase',
    secretType: 'password',
    value: 'plain-secret',
    actorId: 'tester'
  });

  assert.equal(created.provider, 'electron-safe-storage');
  assert.equal(created.version, 1);
  assert.equal(Object.hasOwn(created, 'value'), false);
  assert.equal((await fixture.store.list('local')).length, 1);
  assert.equal(await fixture.store.resolve({ workspaceId: 'local', id: created.id }), 'plain-secret');
  const rawStore = await fs.readFile(path.join(fixture.rootPath, 'secrets.json'), 'utf8');
  assert.equal(rawStore.includes('plain-secret'), false);
});

test('rotates secrets while retaining addressable prior versions', async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const created = await fixture.store.create({
    workspaceId: 'local',
    name: 'Repository token',
    secretType: 'token',
    value: 'version-one'
  });
  const rotated = await fixture.store.rotate({
    workspaceId: 'local',
    id: created.id,
    value: 'version-two'
  });

  assert.equal(rotated.version, 2);
  assert.equal(await fixture.store.resolve({ workspaceId: 'local', id: created.id, version: 1 }), 'version-one');
  assert.equal(await fixture.store.resolve({ workspaceId: 'local', id: created.id }), 'version-two');
});

test('enforces workspace isolation and expiry', async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const created = await fixture.store.create({
    workspaceId: 'workspace-a',
    name: 'Access key',
    secretType: 'access-key',
    value: 'secret',
    expiresAt: '2000-01-01T00:00:00.000Z'
  });

  await assert.rejects(
    fixture.store.resolve({ workspaceId: 'workspace-b', id: created.id }),
    /not found/i
  );
  await assert.rejects(
    fixture.store.resolve({ workspaceId: 'workspace-a', id: created.id }),
    /expired/i
  );
});

test('blocks referenced deletion and removes unreferenced ciphertext', async (context) => {
  let referenced = true;
  const fixture = await createFixture(async () => referenced);
  context.after(fixture.cleanup);
  const created = await fixture.store.create({
    workspaceId: 'local',
    name: 'Database password',
    secretType: 'password',
    value: 'secret'
  });

  await assert.rejects(
    fixture.store.delete({ workspaceId: 'local', id: created.id }),
    /still referenced/i
  );
  referenced = false;
  assert.equal(await fixture.store.delete({ workspaceId: 'local', id: created.id }), true);
  assert.deepEqual(await fixture.store.list('local'), []);
  await assert.rejects(
    fixture.store.resolve({ workspaceId: 'local', id: created.id }),
    /not found/i
  );
});
