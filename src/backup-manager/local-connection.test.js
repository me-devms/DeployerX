const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const {
  ADAPTER_ID,
  LocalComputerConnectionAdapter,
  LocalConnectionService,
  loadOrCreateBackupDeviceId
} = require('./local-connection');

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-local-connection-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const deviceId = await loadOrCreateBackupDeviceId(rootPath);
  return { rootPath, controlDatabase, deviceId };
}

test('persists one stable Backup Manager device identity', async (context) => {
  const { rootPath, deviceId } = await fixture(context);
  assert.match(deviceId, /^device_[0-9a-f-]+$/);
  assert.equal(await loadOrCreateBackupDeviceId(rootPath), deviceId);
});

test('declares credential-free local capabilities and validates configuration', () => {
  const adapter = new LocalComputerConnectionAdapter({ platform: 'win32', architecture: 'x64', hostname: 'TEST-PC', homeDirectory: 'C:\\Users\\Test' });
  const manifest = adapter.manifest();
  assert.equal(manifest.adapterId, ADAPTER_ID);
  assert.deepEqual(manifest.secretSchema, []);
  assert.deepEqual(manifest.capabilities.workloadTypes, ['files']);
  assert.equal(manifest.capabilities.consistencyModes.includes('filesystem-snapshot'), false);
  assert.deepEqual(adapter.normalizeConfig({ deviceId: 'device_test' }), { deviceId: 'device_test' });
  assert.throws(() => adapter.normalizeConfig({ deviceId: 'device_test', password: 'unsafe' }), /Unknown local connection field/);
});

test('returns actionable success and failure connection results', async () => {
  const success = new LocalComputerConnectionAdapter({ hostname: 'TEST-PC' });
  assert.equal((await success.testConnection({}, { deviceId: 'device_test' })).status, 'success');

  const denied = new LocalComputerConnectionAdapter({
    hostname: 'TEST-PC',
    fileSystem: {
      access: async () => { throw new Error('sensitive platform error'); },
      stat: async () => ({ isDirectory: () => true })
    }
  });
  const result = await denied.testConnection({}, { deviceId: 'device_test' });
  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'LOCAL_SOURCE_READ_DENIED');
  assert.equal(JSON.stringify(result).includes('sensitive platform error'), false);
});

test('lazily browses local directories with stable paginated entries', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-local-browse-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootPath, 'folder'));
  await fs.writeFile(path.join(rootPath, 'alpha.txt'), 'alpha');
  await fs.writeFile(path.join(rootPath, 'beta.txt'), 'beta');
  const adapter = new LocalComputerConnectionAdapter({ homeDirectory: rootPath });
  const first = await adapter.browse({}, { deviceId: 'device_test', path: rootPath, pageSize: 2 });
  const second = await adapter.browse({}, { deviceId: 'device_test', path: rootPath, pageSize: 2, cursor: first.nextCursor });
  assert.equal(first.path, rootPath);
  assert.equal(first.items[0].type, 'directory');
  assert.equal(first.items.length, 2);
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((entry) => entry.id)).size, 3);
  assert.equal([...first.items, ...second.items].find((entry) => entry.name === 'alpha.txt').size, 5);
  await assert.rejects(adapter.browse({}, { deviceId: 'device_test', path: 'relative/path' }), /absolute local directory/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapter.browse({ signal: controller.signal }, { deviceId: 'device_test', path: rootPath }), (error) => error.code === 'DISCOVERY_CANCELED');
});

test('keeps unreadable local entry metadata in the listing without exposing platform errors', async () => {
  const adapter = new LocalComputerConnectionAdapter({
    homeDirectory: 'C:\\source',
    pathModule: path.win32,
    fileSystem: {
      readdir: async () => [{ name: 'protected.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }],
      lstat: async () => { throw new Error('sensitive path details'); }
    }
  });
  const result = await adapter.browse({}, { deviceId: 'device_test', path: 'C:\\source' });
  assert.equal(result.items[0].accessible, false);
  assert.equal(result.items[0].metadataErrorCode, 'FILE_METADATA_CAPTURE_FAILED');
  assert.equal(JSON.stringify(result).includes('sensitive path details'), false);
});

test('idempotently creates one device-scoped connection per workspace', async (context) => {
  const { controlDatabase, deviceId } = await fixture(context);
  const service = new LocalConnectionService({ controlDatabase, deviceId });
  const first = await service.ensure('workspace-a', 'tester');
  const repeated = await service.ensure('workspace-a', 'tester');
  const otherWorkspace = await service.ensure('workspace-b', 'tester');
  assert.equal(repeated.id, first.id);
  assert.notEqual(otherWorkspace.id, first.id);
  assert.equal(first.scope, 'device');
  assert.deepEqual(first.secretRefIds, []);
  assert.equal(first.endpoint.deviceId, deviceId);
  assert.equal((await service.list('workspace-a')).length, 1);

  const secondDevice = new LocalConnectionService({ controlDatabase, deviceId: 'device_second' });
  const secondConnection = await secondDevice.ensure('workspace-a', 'tester');
  assert.notEqual(secondConnection.id, first.id);
  assert.notEqual(secondConnection.name, first.name);
  assert.equal((await service.list('workspace-a')).length, 2);
});

test('tests only the current device connection and persists the safe result', async (context) => {
  const { controlDatabase, deviceId } = await fixture(context);
  const service = new LocalConnectionService({ controlDatabase, deviceId });
  const connection = await service.ensure('local', 'tester');
  const tested = await service.test('local', connection.id, 'tester');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.revision, 2);
  assert.equal((await service.list('local'))[0].lastTest.status, 'success');

  const otherService = new LocalConnectionService({ controlDatabase, deviceId: 'device_other' });
  await assert.rejects(otherService.test('local', connection.id, 'tester'), /belongs to another device/);
  const listing = await service.browse('local', connection.id, { pageSize: 5 });
  assert.equal(listing.endpointIdentity.deviceId, deviceId);
});
