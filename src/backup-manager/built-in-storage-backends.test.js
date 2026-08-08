const assert = require('node:assert/strict');
const test = require('node:test');
const { createBuiltInStorageBackendRegistry, S3_CONNECTION_ADAPTER_ID } = require('./built-in-storage-backends');

function service(calls, kind) {
  return {
    list: async () => [],
    create: async (_workspaceId, _actorId, input) => { calls.push([kind, input]); return input; },
    test: async () => ({}),
    remove: async () => ({}),
    open: async () => ({})
  };
}

function connectionService() {
  return {
    list: async () => [],
    ensure: async () => ({ id: 'local-connection' }),
    create: async () => ({ id: 'storage-connection' }),
    test: async () => ({ status: 'success' }),
    remove: async () => ({})
  };
}

test('registers Local, SFTP, and S3 as storage backends with reusable connections', async () => {
  const calls = [];
  const registry = createBuiltInStorageBackendRegistry({
    localService: service(calls, 'local'),
    sftpService: service(calls, 'sftp'),
    s3Service: service(calls, 's3'),
    localConnectionService: connectionService(),
    sshConnectionService: connectionService(),
    s3ConnectionService: connectionService()
  });
  const manifests = registry.list();
  assert.equal(manifests.length, 3);
  assert.ok(manifests.every((backend) => backend.connection.required && backend.capabilities.sharedConnection));
  assert.equal(manifests.find((backend) => backend.backendId === 'deployerx.repository.local').connection.creation.mode, 'automatic');
  assert.equal(manifests.find((backend) => backend.backendId === 'deployerx.repository.sftp').connection.creation.handlerId, 'ssh');
  assert.equal(manifests.find((backend) => backend.backendId === 'deployerx.repository.s3-compatible').connection.creation.mode, 'form');
  assert.ok(manifests.find((backend) => backend.backendId === 'deployerx.repository.s3-compatible').connection.adapterIds.includes(S3_CONNECTION_ADAPTER_ID));

  await registry.get('deployerx.repository.sftp').driver.create('workspace-a', 'actor-a', {
    name: 'Offsite', connectionId: 'connection-a', location: { rootPath: '/srv/archive' }
  });
  await registry.get('deployerx.repository.s3-compatible').driver.create('workspace-a', 'actor-a', {
    name: 'Cloud', connection: { endpoint: 'https://s3.example.com', accessKeyId: 'key', secretAccessKey: 'secret' }, location: { region: 'eu-west-1', bucket: 'archive', prefix: 'daily' }
  });
  assert.equal(calls[0][1].rootPath, '/srv/archive');
  assert.equal(calls[0][1].connectionId, 'connection-a');
  assert.equal(calls[1][1].endpoint, 'https://s3.example.com');
  assert.equal(calls[1][1].bucket, 'archive');
  assert.equal(calls[1][1].prefix, 'daily');
});
