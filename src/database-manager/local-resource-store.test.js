const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseLocalResourceStore } = require('./local-resource-store');

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-db-resources-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'local.sqlite');
  await fs.writeFile(databasePath, 'sqlite-fixture');
  return { databasePath, root, storeRoot: path.join(root, 'store') };
}

test('persists workspace-scoped local file bindings without returning paths as metadata', async (context) => {
  const value = await fixture(context);
  const store = new DatabaseLocalResourceStore({ rootPath: value.storeRoot, clock: () => '2026-08-05T12:00:00.000Z' });
  const bound = await store.bind({ workspaceId: 'workspace-a', profileId: 'profile-a', kind: 'file', path: value.databasePath });
  assert.deepEqual(bound, { profileId: 'profile-a', kind: 'file', displayName: 'local.sqlite', bound: true });
  assert.equal(await store.resolve({ workspaceId: 'workspace-a', profileId: 'profile-a', kind: 'file' }), await fs.realpath(value.databasePath));
  assert.equal(await store.resolve({ workspaceId: 'workspace-b', profileId: 'profile-a', kind: 'file' }), null);
  assert.deepEqual(await store.metadata({ workspaceId: 'workspace-a', profileId: 'profile-a', kind: 'file' }), { profileId: 'profile-a', kind: 'file', displayName: 'local.sqlite', bound: true });

  const reopened = new DatabaseLocalResourceStore({ rootPath: value.storeRoot });
  assert.equal(await reopened.resolve({ workspaceId: 'workspace-a', profileId: 'profile-a', kind: 'file' }), await fs.realpath(value.databasePath));
});

test('rejects missing or wrong-kind resources and clears bindings on profile removal', async (context) => {
  const value = await fixture(context);
  const store = new DatabaseLocalResourceStore({ rootPath: value.storeRoot });
  await assert.rejects(store.bind({ workspaceId: 'workspace-a', profileId: 'profile-a', kind: 'file', path: path.join(value.root, 'missing.sqlite') }), (error) => error.code === 'DATABASE_MANAGER_LOCAL_RESOURCE_NOT_FOUND');
  await assert.rejects(store.bind({ workspaceId: 'workspace-a', profileId: 'profile-a', kind: 'folder', path: value.databasePath }), (error) => error.code === 'DATABASE_MANAGER_LOCAL_RESOURCE_KIND_INVALID');
  await store.bind({ workspaceId: 'workspace-a', profileId: 'profile-a', kind: 'file', path: value.databasePath });
  assert.equal(await store.remove({ workspaceId: 'workspace-a', profileId: 'profile-a' }), true);
  assert.equal(await store.resolve({ workspaceId: 'workspace-a', profileId: 'profile-a', kind: 'file' }), null);
});

test('refuses corrupt binding stores without replacing their bytes', async (context) => {
  const value = await fixture(context);
  await fs.mkdir(value.storeRoot, { recursive: true });
  const storePath = path.join(value.storeRoot, 'local-resources.json');
  await fs.writeFile(storePath, '{not-json');
  const store = new DatabaseLocalResourceStore({ rootPath: value.storeRoot });
  await assert.rejects(store.initialize(), (error) => error.code === 'DATABASE_MANAGER_LOCAL_RESOURCE_STORE_INVALID');
  assert.equal(await fs.readFile(storePath, 'utf8'), '{not-json');
});
