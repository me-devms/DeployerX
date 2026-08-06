const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { DatabasePluginRegistry, PLUGIN_INSTALLED_STATE_SCHEMA_VERSION, normalizeCatalog, releaseForHost, safeArchiveEntries } = require('./plugin-registry');

function release(overrides = {}) {
  const archive = Buffer.from('plugin-archive');
  return {
    schemaVersion: 1,
    pluginId: 'vendor.redis',
    version: '1.0.0',
    name: 'Redis driver',
    approved: true,
    target: { platforms: ['win32'], architectures: ['x64', 'universal'] },
    archive: { url: 'https://example.test/redis.zip', size: archive.length, sha256: crypto.createHash('sha256').update(archive).digest('hex') },
    signature: { algorithm: 'Ed25519', value: 'signature', keyId: 'test' },
    manifestSha256: 'c'.repeat(64),
    entrypoint: 'bin/driver.exe',
    driverManifest: { id: 'vendor.redis', version: '1.0.0' },
    ...overrides
  };
}

test('normalizes catalog and filters host compatibility', () => {
  const catalog = normalizeCatalog({ schemaVersion: 1, releases: [release({ driverManifest: { id: 'vendor.redis', version: '1.0.0', runtime: { methods: { futureCapability: 'future_method' } } } })] });
  assert.equal(catalog.releases[0].pluginId, 'vendor.redis');
  assert.equal(catalog.releases[0].driverManifest.runtime.methods.futureCapability, 'future_method');
  assert.ok(releaseForHost(catalog.releases[0], 'win32', 'x64'));
  assert.equal(releaseForHost(catalog.releases[0], 'linux', 'x64'), null);
  const registry = new DatabasePluginRegistry({ rootPath: path.join(os.tmpdir(), 'deployerx-plugin-runtime-requirement'), platform: 'win32', arch: 'x64', download: async () => Buffer.alloc(0), extract: async () => [] });
  registry.setCatalog({ schemaVersion: 1, releases: [release({ entrypoint: 'plugin.py' })] });
  assert.deepEqual(registry.list()[0].runtimeRequirement, { id: 'python', label: 'Python', minimumVersion: '3.8' });
});

test('keeps approved unresolved catalog entries visible with their reason', () => {
  const registry = new DatabasePluginRegistry({
    rootPath: path.join(os.tmpdir(), 'deployerx-plugin-unavailable'),
    platform: 'win32',
    arch: 'x64',
    download: async () => Buffer.alloc(0),
    extract: async () => []
  });
  registry.setCatalog({ schemaVersion: 1, releases: [], unavailable: [{ pluginId: 'vendor.db2', version: '2.0.0', name: 'Db2', unavailableReason: 'Windows release metadata is temporarily unavailable.' }] });
  const item = registry.list()[0];
  assert.equal(item.pluginId, 'vendor.db2');
  assert.equal(item.supported, false);
  assert.match(item.unsupportedReason, /temporarily unavailable/i);
});

test('rejects unsafe archive paths and missing entrypoints', () => {
  assert.throws(() => safeArchiveEntries([{ path: '../escape', size: 1 }], 'driver.exe'), /unsafe path/);
  assert.throws(() => safeArchiveEntries([{ path: 'driver.exe', size: 1 }], 'bin/driver.exe'), /does not contain/);
  assert.throws(() => normalizeCatalog({ schemaVersion: 1, releases: [release({ version: '../../escape' })] }), /version/);
  assert.throws(() => normalizeCatalog({ schemaVersion: 1, releases: [release({ driverManifest: { id: 'vendor.redis', version: '1.0.0', runtime: { methods: { executeQuery: 'unsafe method' } } } })] }), /runtime method/);
  assert.throws(() => normalizeCatalog({ schemaVersion: 1, releases: [release({ driverManifest: { id: 'vendor.redis', version: '1.0.0', runtime: { methods: { 'unsafe-key': 'safe_method' } } } })] }), /method key/);
});

async function installedStateFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-state-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const installPath = path.join(root, 'installed', 'vendor.redis', '1.0.0');
  await fs.mkdir(path.join(installPath, 'bin'), { recursive: true });
  await fs.writeFile(path.join(installPath, 'bin', 'driver.exe'), 'binary');
  const driverManifest = normalizeCatalog({ schemaVersion: 1, releases: [release()] }).releases[0].driverManifest;
  const record = {
    pluginId: 'vendor.redis', version: '1.0.0', enabled: true,
    installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    installPath, entrypoint: 'bin/driver.exe', driverManifest, signatureVerified: true, signatureKeyId: 'test'
  };
  const write = (plugins) => fs.writeFile(path.join(root, 'plugins.json'), `${JSON.stringify({ schemaVersion: 1, plugins })}\n`);
  await write([record]);
  return { root, installPath, record, write };
}

function persistedRegistry(root) {
  return new DatabasePluginRegistry({ rootPath: root, platform: 'win32', arch: 'x64', download: async () => Buffer.alloc(0), extract: async () => [] });
}

test('migrates a structurally valid legacy plugin to disabled reinstall-required state', async (context) => {
  const fixture = await installedStateFixture(context);
  const registry = persistedRegistry(fixture.root);
  await registry.initialize();
  assert.equal(registry.getInstalled('vendor.redis'), null);
  const installed = registry.listInstalled({ includeDisabled: true })[0];
  assert.equal(installed.installPath, fixture.installPath);
  assert.equal(installed.entrypoint, 'bin/driver.exe');
  assert.equal(installed.driverManifest.source, 'plugin');
  assert.deepEqual(installed.driverManifest.runtime, { args: [], methods: {} });
  assert.equal(installed.enabled, false);
  assert.equal(installed.integrityStatus, 'reinstall-required');
  await assert.rejects(registry.setEnabled('vendor.redis', true), (error) => error.code === 'DATABASE_PLUGIN_INTEGRITY_REQUIRED');
  const migrated = JSON.parse(await fs.readFile(path.join(fixture.root, 'plugins.json'), 'utf8'));
  assert.equal(migrated.schemaVersion, PLUGIN_INSTALLED_STATE_SCHEMA_VERSION);
  assert.equal(migrated.plugins[0].enabled, false);
  assert.equal(migrated.plugins[0].contentIntegrity, null);
});

test('rejects tampered, duplicate, and missing installed plugin state before runtime registration', async (context) => {
  const outside = await installedStateFixture(context);
  await outside.write([{ ...outside.record, installPath: path.dirname(outside.root) }]);
  await assert.rejects(persistedRegistry(outside.root).initialize(), (error) => error.code === 'DATABASE_PLUGIN_STATE_INVALID');

  const traversal = await installedStateFixture(context);
  await traversal.write([{ ...traversal.record, entrypoint: '../driver.exe' }]);
  await assert.rejects(persistedRegistry(traversal.root).initialize(), (error) => error.code === 'DATABASE_PLUGIN_STATE_INVALID');

  const runtime = await installedStateFixture(context);
  await runtime.write([{ ...runtime.record, driverManifest: { ...runtime.record.driverManifest, runtime: { methods: { executeQuery: 'unsafe method' } } } }]);
  await assert.rejects(persistedRegistry(runtime.root).initialize(), (error) => error.code === 'DATABASE_PLUGIN_STATE_INVALID');

  const duplicate = await installedStateFixture(context);
  await duplicate.write([duplicate.record, duplicate.record]);
  await assert.rejects(persistedRegistry(duplicate.root).initialize(), (error) => error.code === 'DATABASE_PLUGIN_STATE_INVALID');

  const missing = await installedStateFixture(context);
  await fs.rm(path.join(missing.installPath, 'bin', 'driver.exe'));
  await assert.rejects(persistedRegistry(missing.root).initialize(), (error) => error.code === 'DATABASE_PLUGIN_STATE_INVALID');
});

test('installs, disables, updates, and removes a verified release', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-'));
  const archive = Buffer.from('plugin-archive');
  const registry = new DatabasePluginRegistry({
    rootPath: root,
    platform: 'win32',
    arch: 'x64',
    download: async () => archive,
    verifySignature: async () => true,
    extract: async (_data, destination) => {
      await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
      await fs.writeFile(path.join(destination, 'bin', 'driver.exe'), 'binary');
      return [{ path: 'bin/driver.exe', size: 6, executable: true }];
    },
    clock: () => '2026-01-01T00:00:00.000Z'
  });
  registry.setCatalog({ schemaVersion: 1, releases: [release()] });
  const installed = await registry.install('vendor.redis');
  assert.equal(installed.enabled, true);
  assert.equal(registry.getDriverManifest('vendor.redis').source, 'plugin');
  assert.equal(registry.listInstalled()[0].entrypoint, 'bin/driver.exe');
  assert.equal(registry.list()[0].installedVersion, '1.0.0');
  assert.equal((await registry.setEnabled('vendor.redis', false)).enabled, false);
  assert.equal((await registry.remove('vendor.redis')).removed, true);
  assert.equal(registry.list()[0].installed, false);
});

test('rejects unsigned releases before download and disables persisted unsigned state', async (context) => {
  const unsignedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-unsigned-'));
  context.after(() => fs.rm(unsignedRoot, { recursive: true, force: true }));
  let downloaded = false;
  const unsignedRegistry = new DatabasePluginRegistry({
    rootPath: unsignedRoot,
    platform: 'win32',
    arch: 'x64',
    download: async () => { downloaded = true; return Buffer.from('plugin-archive'); },
    extract: async () => []
  });
  unsignedRegistry.setCatalog({ schemaVersion: 1, releases: [release({ signature: null })] });
  const catalogItem = unsignedRegistry.list()[0];
  assert.equal(catalogItem.supported, false);
  assert.match(catalogItem.unsupportedReason, /signed release is required/i);
  await assert.rejects(unsignedRegistry.install('vendor.redis'), (error) => error.code === 'DATABASE_PLUGIN_SIGNATURE_REQUIRED');
  assert.equal(downloaded, false);

  const persistedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-unsigned-state-'));
  context.after(() => fs.rm(persistedRoot, { recursive: true, force: true }));
  const archive = Buffer.from('plugin-archive');
  const installedRegistry = new DatabasePluginRegistry({
    rootPath: persistedRoot,
    platform: 'win32',
    arch: 'x64',
    download: async () => archive,
    verifySignature: async () => true,
    extract: async (_data, destination) => {
      await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
      await fs.writeFile(path.join(destination, 'bin', 'driver.exe'), 'binary');
      return [{ path: 'bin/driver.exe', size: 6, executable: true }];
    }
  });
  installedRegistry.setCatalog({ schemaVersion: 1, releases: [release()] });
  await installedRegistry.install('vendor.redis');
  const statePath = path.join(persistedRoot, 'plugins.json');
  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  persisted.plugins[0].signatureVerified = false;
  persisted.plugins[0].enabled = true;
  await fs.writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`);

  const restarted = persistedRegistry(persistedRoot);
  await restarted.initialize();
  const disabled = restarted.listInstalled({ includeDisabled: true })[0];
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.signatureVerified, false);
  assert.equal(restarted.getInstalled('vendor.redis'), null);
  const fallbackItem = restarted.list()[0];
  assert.equal(fallbackItem.supported, false);
  assert.equal(fallbackItem.signatureVerified, false);
  assert.match(fallbackItem.unsupportedReason, /signed release is required/i);
  await assert.rejects(restarted.verifyInstalled('vendor.redis'), (error) => error.code === 'DATABASE_PLUGIN_SIGNATURE_REQUIRED');
  await assert.rejects(restarted.setEnabled('vendor.redis', true), (error) => error.code === 'DATABASE_PLUGIN_SIGNATURE_REQUIRED');
  const repairedState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(repairedState.plugins[0].enabled, false);
});

test('verifies the complete installed file inventory and quarantines changed content across restart', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-integrity-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = Buffer.from('plugin-archive');
  const registryOptions = {
    rootPath: root,
    platform: 'win32',
    arch: 'x64',
    download: async () => archive,
    verifySignature: async () => true,
    extract: async (_data, destination) => {
      await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
      await fs.mkdir(path.join(destination, 'lib'), { recursive: true });
      await fs.writeFile(path.join(destination, 'bin', 'driver.exe'), 'driver-v1');
      await fs.writeFile(path.join(destination, 'lib', 'adapter.dat'), 'adapter-v1');
      return [{ path: 'bin/driver.exe', size: 9, executable: true }, { path: 'lib/adapter.dat', size: 10, executable: false }];
    }
  };
  const registry = new DatabasePluginRegistry(registryOptions);
  registry.setCatalog({ schemaVersion: 1, releases: [release()] });
  const installed = await registry.install('vendor.redis');
  assert.equal(installed.integrityStatus, 'verified');
  assert.equal(Object.hasOwn(installed, 'contentIntegrity'), false);
  assert.equal(Object.hasOwn(installed, 'installPath'), false);
  const persisted = JSON.parse(await fs.readFile(path.join(root, 'plugins.json'), 'utf8'));
  assert.equal(persisted.schemaVersion, PLUGIN_INSTALLED_STATE_SCHEMA_VERSION);
  assert.deepEqual(persisted.plugins[0].contentIntegrity.files.map((file) => file.path), ['bin/driver.exe', 'lib/adapter.dat']);
  const catalogItem = registry.list()[0];
  assert.equal(Object.hasOwn(catalogItem, 'contentIntegrity'), false);
  assert.equal(Object.hasOwn(catalogItem, 'installPath'), false);

  const restarted = new DatabasePluginRegistry(registryOptions);
  await restarted.initialize();
  assert.equal(restarted.getInstalled('vendor.redis').integrityStatus, 'verified');
  assert.equal(Object.hasOwn(restarted.getInstalled('vendor.redis'), 'contentIntegrity'), false);
  assert.deepEqual(await restarted.verifyInstalled('vendor.redis'), { pluginId: 'vendor.redis', integrityStatus: 'verified' });

  const adapterPath = path.join(root, 'installed', 'vendor.redis', '1.0.0', 'lib', 'adapter.dat');
  await fs.writeFile(adapterPath, 'adapter-tampered');
  await assert.rejects(restarted.verifyInstalled('vendor.redis'), (error) => error.code === 'DATABASE_PLUGIN_INTEGRITY_MISMATCH');
  assert.equal(restarted.getInstalled('vendor.redis'), null);
  const quarantined = new DatabasePluginRegistry(registryOptions);
  await quarantined.initialize();
  assert.equal(quarantined.getInstalled('vendor.redis'), null);
  assert.equal(quarantined.listInstalled({ includeDisabled: true })[0].integrityStatus, 'failed');
  await assert.rejects(quarantined.setEnabled('vendor.redis', true), (error) => error.code === 'DATABASE_PLUGIN_INTEGRITY_MISMATCH');

  await fs.writeFile(adapterPath, 'adapter-v1');
  const restored = new DatabasePluginRegistry(registryOptions);
  await restored.initialize();
  assert.equal(restored.listInstalled({ includeDisabled: true })[0].integrityStatus, 'verified');
  assert.equal((await restored.setEnabled('vendor.redis', true)).enabled, true);

  await fs.writeFile(path.join(root, 'installed', 'vendor.redis', '1.0.0', 'unexpected.dll'), 'unexpected');
  const addedFile = new DatabasePluginRegistry(registryOptions);
  await addedFile.initialize();
  assert.equal(addedFile.listInstalled({ includeDisabled: true })[0].integrityStatus, 'failed');
  assert.equal(addedFile.getInstalled('vendor.redis'), null);

  await fs.rm(path.join(root, 'installed', 'vendor.redis', '1.0.0', 'unexpected.dll'));
  await fs.rm(adapterPath);
  const removedFile = new DatabasePluginRegistry(registryOptions);
  await removedFile.initialize();
  assert.equal(removedFile.listInstalled({ includeDisabled: true })[0].integrityStatus, 'failed');
  assert.equal(removedFile.getInstalled('vendor.redis'), null);
});

test('stages same-version reinstalls without retaining files from the prior tree', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-reinstall-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = Buffer.from('plugin-archive');
  let extraction = 'initial';
  const registry = new DatabasePluginRegistry({
    rootPath: root,
    platform: 'win32',
    arch: 'x64',
    download: async () => archive,
    verifySignature: async () => true,
    extract: async (_data, destination) => {
      await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
      if (extraction === 'invalid') {
        await fs.writeFile(path.join(destination, 'bin', 'wrong.exe'), 'invalid');
        return [{ path: 'bin/wrong.exe', size: 7, executable: true }];
      }
      await fs.writeFile(path.join(destination, 'bin', 'driver.exe'), extraction === 'initial' ? 'driver-v1' : 'driver-v2');
      if (extraction === 'initial') {
        await fs.mkdir(path.join(destination, 'lib'), { recursive: true });
        await fs.writeFile(path.join(destination, 'lib', 'obsolete.dat'), 'obsolete');
        return [{ path: 'bin/driver.exe', size: 9, executable: true }, { path: 'lib/obsolete.dat', size: 8, executable: false }];
      }
      return [{ path: 'bin/driver.exe', size: 9, executable: true }];
    }
  });
  registry.setCatalog({ schemaVersion: 1, releases: [release()] });
  await registry.install('vendor.redis');
  const installPath = path.join(root, 'installed', 'vendor.redis', '1.0.0');
  const persistedBeforeFailure = await fs.readFile(path.join(root, 'plugins.json'), 'utf8');

  extraction = 'invalid';
  await assert.rejects(registry.install('vendor.redis'), (error) => error.code === 'DATABASE_PLUGIN_ENTRYPOINT_MISSING');
  assert.equal(await fs.readFile(path.join(installPath, 'bin', 'driver.exe'), 'utf8'), 'driver-v1');
  assert.equal(await fs.readFile(path.join(installPath, 'lib', 'obsolete.dat'), 'utf8'), 'obsolete');
  assert.equal(await fs.readFile(path.join(root, 'plugins.json'), 'utf8'), persistedBeforeFailure);
  assert.deepEqual(await registry.verifyInstalled('vendor.redis'), { pluginId: 'vendor.redis', integrityStatus: 'verified' });

  extraction = 'replacement';
  await registry.install('vendor.redis');
  assert.equal(await fs.readFile(path.join(installPath, 'bin', 'driver.exe'), 'utf8'), 'driver-v2');
  assert.equal(await fs.access(path.join(installPath, 'lib', 'obsolete.dat')).then(() => true, () => false), false);
  const persisted = JSON.parse(await fs.readFile(path.join(root, 'plugins.json'), 'utf8'));
  assert.deepEqual(persisted.plugins[0].contentIntegrity.files.map((file) => file.path), ['bin/driver.exe']);
  assert.deepEqual(await fs.readdir(path.join(root, 'staging')), []);
});

test('restores the prior same-version install when publishing registry state fails', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-rollback-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = Buffer.from('plugin-archive');
  const statePath = path.join(root, 'plugins.json');
  let replacement = false;
  let rejectStatePublish = false;
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'rename') {
        return async (source, destination) => {
          if (rejectStatePublish && path.resolve(destination) === path.resolve(statePath)) {
            const error = new Error('registry state publish failed');
            error.code = 'EACCES';
            throw error;
          }
          return target.rename(source, destination);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const registry = new DatabasePluginRegistry({
    rootPath: root,
    fileSystem,
    platform: 'win32',
    arch: 'x64',
    download: async () => archive,
    verifySignature: async () => true,
    extract: async (_data, destination) => {
      await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
      await fs.writeFile(path.join(destination, 'bin', 'driver.exe'), replacement ? 'driver-v2' : 'driver-v1');
      return [{ path: 'bin/driver.exe', size: 9, executable: true }];
    }
  });
  registry.setCatalog({ schemaVersion: 1, releases: [release()] });
  await registry.install('vendor.redis');
  const installPath = path.join(root, 'installed', 'vendor.redis', '1.0.0');
  const persistedBeforeFailure = await fs.readFile(statePath, 'utf8');

  replacement = true;
  rejectStatePublish = true;
  await assert.rejects(registry.install('vendor.redis'), /registry state publish failed/);
  rejectStatePublish = false;
  assert.equal(await fs.readFile(path.join(installPath, 'bin', 'driver.exe'), 'utf8'), 'driver-v1');
  assert.equal(await fs.readFile(statePath, 'utf8'), persistedBeforeFailure);
  assert.deepEqual(await registry.verifyInstalled('vendor.redis'), { pluginId: 'vendor.redis', integrityStatus: 'verified' });
  assert.deepEqual((await fs.readdir(path.dirname(installPath))).sort(), ['1.0.0']);
  assert.deepEqual(await fs.readdir(path.join(root, 'staging')), []);
});

test('rejects hash and signature failures before extraction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-'));
  let extracted = false;
  const registry = new DatabasePluginRegistry({ rootPath: root, platform: 'win32', arch: 'x64', download: async () => Buffer.alloc(Buffer.byteLength('plugin-archive'), 0x77), verifySignature: async () => false, extract: async () => { extracted = true; return []; } });
  registry.setCatalog({ schemaVersion: 1, releases: [release()] });
  await assert.rejects(() => registry.install('vendor.redis'), /SHA-256/);
  assert.equal(extracted, false);
});

test('removes a partial install when extraction fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-'));
  const archive = Buffer.from('plugin-archive');
  const registry = new DatabasePluginRegistry({
    rootPath: root,
    platform: 'win32',
    arch: 'x64',
    download: async () => archive,
    verifySignature: async () => true,
    extract: async (_data, destination) => {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, 'partial.bin'), 'partial');
      throw new Error('extract failed');
    }
  });
  registry.setCatalog({ schemaVersion: 1, releases: [release()] });
  await assert.rejects(() => registry.install('vendor.redis'), /extract failed/);
  assert.equal(await fs.access(path.join(root, 'installed', 'vendor.redis', '1.0.0')).then(() => true, () => false), false);
});

test('rejects and removes an extracted entrypoint that is not a file', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = Buffer.from('plugin-archive');
  const registry = new DatabasePluginRegistry({
    rootPath: root,
    platform: 'win32',
    arch: 'x64',
    download: async () => archive,
    verifySignature: async () => true,
    extract: async (_data, destination) => {
      await fs.mkdir(path.join(destination, 'bin', 'driver.exe'), { recursive: true });
      return [{ path: 'bin/driver.exe', size: 0, executable: true }];
    }
  });
  registry.setCatalog({ schemaVersion: 1, releases: [release()] });
  await assert.rejects(registry.install('vendor.redis'), (error) => error.code === 'DATABASE_PLUGIN_ENTRYPOINT_INVALID');
  assert.equal(await fs.access(path.join(root, 'installed', 'vendor.redis', '1.0.0')).then(() => true, () => false), false);
});
