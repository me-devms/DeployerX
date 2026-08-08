const assert = require('node:assert/strict');
const test = require('node:test');
const {
  StorageBackendRegistry,
  StorageBackendRegistryError,
  StorageConnectionService,
  StorageDestinationService
} = require('./storage-backend-registry');

function manifest(backendId = 'deployerx.repository.test') {
  return {
    apiVersion: 1,
    backendId,
    version: '1.0.0',
    displayName: 'Test storage',
    description: 'Storage used by registry contract tests.',
    icon: 'cloud',
    connection: {
      required: true,
      adapterIds: ['deployerx.connection.test'],
      fields: [{ id: 'endpoint', label: 'Endpoint', type: 'text' }]
    },
    location: {
      label: 'Remote path',
      fields: [{ id: 'path', label: 'Path', type: 'path' }]
    },
    capabilities: { capacityReporting: true, immutability: false, sharedConnection: true }
  };
}

function driver(calls) {
  return {
    list: async (workspaceId) => [{ id: 'repo-1', adapterId: 'deployerx.repository.test', workspaceId }],
    create: async (...args) => { calls.push(['create', ...args]); return { id: 'repo-created' }; },
    test: async (...args) => { calls.push(['test', ...args]); return { status: 'ready' }; },
    remove: async (...args) => { calls.push(['remove', ...args]); return { id: args[2] }; },
    open: async (...args) => { calls.push(['open', ...args]); return { repository: { id: args[1] } }; }
  };
}

test('registers immutable backend manifests and rejects duplicate IDs', () => {
  const registry = new StorageBackendRegistry();
  registry.register(manifest(), driver([]));
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].connection.adapterIds[0], 'deployerx.connection.test');
  assert.throws(() => registry.register(manifest(), driver([])), (error) => error instanceof StorageBackendRegistryError && error.code === 'STORAGE_BACKEND_DUPLICATE');
});

test('rejects backend drivers that do not implement the generic contract', () => {
  assert.throws(
    () => new StorageBackendRegistry().register(manifest(), { list() {} }),
    (error) => error instanceof StorageBackendRegistryError && error.code === 'STORAGE_BACKEND_DRIVER_INVALID'
  );
});

test('dispatches destination operations through the registered backend', async () => {
  const calls = [];
  const registry = new StorageBackendRegistry().register(manifest(), driver(calls));
  const controlDatabase = {
    repository: (type) => {
      assert.equal(type, 'repository');
      return { get: async () => ({ id: 'repo-1', adapterId: 'deployerx.repository.test' }) };
    }
  };
  const service = new StorageDestinationService({ controlDatabase, registry });

  const destinations = await service.list('workspace-a');
  assert.equal(destinations[0].backend.displayName, 'Test storage');
  assert.equal((await service.create('workspace-a', 'actor-a', { backendId: 'deployerx.repository.test', name: 'Archive' })).id, 'repo-created');
  assert.equal((await service.test('workspace-a', 'actor-a', 'repo-1')).status, 'ready');
  assert.equal((await service.open('workspace-a', 'repo-1')).repository.id, 'repo-1');
  assert.equal((await service.remove('workspace-a', 'actor-a', 'repo-1', 4)).id, 'repo-1');
  assert.deepEqual(calls.map(([operation]) => operation), ['create', 'test', 'open', 'remove']);
});

test('dispatches reusable connection operations through the backend registry', async () => {
  const calls = [];
  const connectionDriver = {
    list: async () => [{ id: 'connection-1', adapterId: 'deployerx.connection.test' }],
    create: async (...args) => { calls.push(['create', ...args]); return { id: 'connection-created' }; },
    test: async (...args) => { calls.push(['test', ...args]); return { status: 'success' }; },
    remove: async (...args) => { calls.push(['remove', ...args]); return { id: args[2] }; }
  };
  const registry = new StorageBackendRegistry().register(manifest(), driver([]), connectionDriver);
  const controlDatabase = {
    repository: (type) => {
      assert.equal(type, 'connection');
      return { get: async () => ({ id: 'connection-1', adapterId: 'deployerx.connection.test', revision: 2 }) };
    }
  };
  const service = new StorageConnectionService({ controlDatabase, secretStore: {}, registry });

  const connections = await service.list('workspace-a');
  assert.equal(connections[0].backendId, 'deployerx.repository.test');
  assert.equal((await service.create('workspace-a', 'actor-a', 'deployerx.repository.test', { endpoint: 'example.test' })).id, 'connection-created');
  assert.equal((await service.test('workspace-a', 'actor-a', 'deployerx.repository.test', 'connection-1', { path: '/archive' })).status, 'success');
  assert.equal((await service.remove('workspace-a', 'actor-a', 'deployerx.repository.test', 'connection-1', 2)).id, 'connection-1');
  assert.deepEqual(calls.map(([operation]) => operation), ['create', 'test', 'remove']);
});

test('removes generic connection records and credential metadata when a driver has no custom remover', async () => {
  const connection = { id: 'connection-1', adapterId: 'deployerx.connection.test', revision: 3, secretRefIds: ['secret-1'] };
  const calls = [];
  const repositories = {
    connection: {
      get: async () => connection,
      softDelete: async (_workspaceId, id, options) => { calls.push(['connection-delete', id, options.expectedRevision]); return { ...connection, deletedAt: 'now' }; }
    },
    secretRef: {
      get: async () => ({ id: 'secret-1', revision: 2 }),
      softDelete: async (_workspaceId, id, options) => { calls.push(['secret-delete', id, options.expectedRevision]); return { id }; }
    }
  };
  const registry = new StorageBackendRegistry().register(manifest(), driver([]), {
    list: async () => [connection], create: async () => connection, test: async () => ({ status: 'success' })
  });
  const service = new StorageConnectionService({
    controlDatabase: { repository: (type) => repositories[type] },
    secretStore: { delete: async ({ id }) => calls.push(['credential-delete', id]) },
    registry
  });

  const removed = await service.remove('workspace-a', 'actor-a', 'deployerx.repository.test', connection.id, connection.revision);
  assert.equal(removed.connection.deletedAt, 'now');
  assert.deepEqual(removed.credentialsNotRemoved, []);
  assert.deepEqual(calls, [
    ['connection-delete', 'connection-1', 3],
    ['credential-delete', 'secret-1'],
    ['secret-delete', 'secret-1', 2]
  ]);
});

test('requires provider enrollment for externally managed connections', () => {
  const externalManifest = manifest('deployerx.repository.external');
  externalManifest.connection.creation = { mode: 'external', handlerId: 'oauth-provider' };
  const registry = new StorageBackendRegistry().register(externalManifest, driver([]), {
    list: async () => [], test: async () => ({ status: 'success' })
  });
  const service = new StorageConnectionService({ controlDatabase: {}, secretStore: {}, registry });
  assert.throws(
    () => service.create('workspace-a', 'actor-a', externalManifest.backendId, {}),
    (error) => error instanceof StorageBackendRegistryError && error.code === 'STORAGE_CONNECTION_EXTERNAL_FLOW_REQUIRED'
  );
});
