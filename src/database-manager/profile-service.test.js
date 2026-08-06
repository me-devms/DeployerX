const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('../backup-manager/control-database');
const { DatabaseProfileStore } = require('./profile-store');
const { DatabaseProfileService } = require('./profile-service');

class FakeSecretStore {
  constructor() {
    this.values = new Map();
    this.counter = 0;
  }

  async create(input) {
    const id = `sec_service_${++this.counter}`;
    const now = new Date().toISOString();
    const ref = { id, workspaceId: input.workspaceId, schemaVersion: 1, revision: 1, createdAt: now, updatedAt: now, createdBy: input.actorId, updatedBy: input.actorId, deletedAt: null, labels: {}, name: input.name, provider: 'electron-safe-storage', scope: 'device', providerKey: id, secretType: input.secretType, version: 1, fingerprint: null, expiresAt: null, lastValidatedAt: null };
    this.values.set(id, { value: input.value, ref });
    return structuredClone(ref);
  }

  async rotate(input) {
    const entry = this.values.get(input.id);
    if (!entry) throw new Error('Secret was not found.');
    entry.value = input.value;
    entry.ref.version += 1;
    entry.ref.revision += 1;
    entry.ref.updatedAt = new Date().toISOString();
    return structuredClone(entry.ref);
  }

  async delete(input) {
    return this.values.delete(input.id);
  }
}

async function fixture(context, options = {}) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-profile-service-'));
  const controlDatabase = new BackupControlDatabase({ rootPath });
  await controlDatabase.initialize();
  const secretStore = new FakeSecretStore();
  const profileStore = new DatabaseProfileStore({ controlDatabase });
  const service = new DatabaseProfileService({ profileStore, controlDatabase, secretStore, ...options });
  context.after(async () => {
    await controlDatabase.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });
  return { controlDatabase, secretStore, service };
}

function profile(overrides = {}) {
  return {
    name: 'Production PostgreSQL',
    driverId: 'postgresql',
    endpoint: { kind: 'network', host: 'db.example.test', port: 5432 },
    database: 'app',
    defaultSchema: 'public',
    environment: 'production',
    accessMode: 'read-only',
    ssl: { mode: 'verify-full' },
    tunnel: { type: 'none' },
    settings: { username: 'app_user' },
    credentials: { password: 'initial-secret' },
    ...overrides
  };
}

test('creates profiles with encrypted credential references and rotates the same reference', async (context) => {
  const values = await fixture(context);
  const created = await values.service.create('workspace-a', 'tester', profile());
  assert.equal(created.credentialSecretRefs.length, 1);
  const secretRefId = created.credentialSecretRefs[0].secretRefId;
  assert.equal(values.secretStore.values.get(secretRefId).value, 'initial-secret');
  assert.equal(JSON.stringify(created).includes('initial-secret'), false);
  const metadata = await values.controlDatabase.repository('secretRef').get('workspace-a', secretRefId);
  assert.equal(metadata.secretType, 'password');

  const updated = await values.service.update('workspace-a', 'tester', created.id, { name: 'Production Primary', credentials: { password: 'rotated-secret' } }, created.revision);
  assert.equal(updated.credentialSecretRefs[0].secretRefId, secretRefId);
  assert.equal(values.secretStore.values.get(secretRefId).value, 'rotated-secret');
  const updatedMetadata = await values.controlDatabase.repository('secretRef').get('workspace-a', secretRefId);
  assert.equal(updatedMetadata.version, 2);
});

test('supports passwordless and SQLite profiles and rejects unavailable drivers', async (context) => {
  const values = await fixture(context);
  const passwordless = await values.service.create('workspace-a', 'tester', profile({ name: 'Local PostgreSQL', credentials: {} }));
  assert.deepEqual(passwordless.credentialSecretRefs, []);
  const sqlite = await values.service.create('workspace-a', 'tester', profile({ name: 'Local SQLite', driverId: 'sqlite', endpoint: { kind: 'file' }, database: null, defaultSchema: null, ssl: { mode: 'disabled' }, settings: {}, credentials: {} }));
  assert.equal(sqlite.endpoint.kind, 'file');
  await assert.rejects(values.service.create('workspace-a', 'tester', profile({ name: 'Unavailable', driverId: 'oracle' })), (error) => error.code === 'DATABASE_MANAGER_DRIVER_NOT_AVAILABLE');
});

test('cleans up a newly created secret when profile persistence fails', async (context) => {
  const values = await fixture(context);
  await values.service.create('workspace-a', 'tester', profile());
  await assert.rejects(values.service.create('workspace-a', 'tester', profile()), (error) => error.code === 'DATABASE_MANAGER_PROFILE_NAME_EXISTS');
  assert.equal(values.secretStore.values.size, 1);
  const refs = await values.controlDatabase.repository('secretRef').list('workspace-a');
  assert.equal(refs.length, 1);
});

test('creates installed plugin profiles with declared credentials and settings only', async (context) => {
  const values = await fixture(context, { driverResolver: (driverId) => driverId === 'vendor.redis' ? {
    credentialSlots: [{ id: 'token', type: 'token', label: 'Access token', required: true }, { id: 'extra-properties', type: 'token', label: 'Extra properties', required: false }],
    settings: { fields: [{ key: 'security', type: 'select', required: true, options: ['none', 'ssl'] }, { key: 'pool_size', type: 'number' }] }
  } : null });
  const created = await values.service.create('workspace-a', 'tester', profile({
    name: 'Managed Redis',
    driverId: 'vendor.redis',
    settings: { security: 'ssl', pool_size: 4 },
    credentials: { token: 'plugin-token', 'extra-properties': 'ApplicationName=DeployerX' }
  }));
  assert.equal(created.driverId, 'vendor.redis');
  assert.deepEqual(created.settings, { security: 'ssl', pool_size: 4 });
  const tokenRef = created.credentialSecretRefs.find((item) => item.slotId === 'token');
  const propertiesRef = created.credentialSecretRefs.find((item) => item.slotId === 'extra-properties');
  assert.equal(values.secretStore.values.get(tokenRef.secretRefId).value, 'plugin-token');
  assert.equal(values.secretStore.values.get(propertiesRef.secretRefId).value, 'ApplicationName=DeployerX');
  await assert.rejects(values.service.create('workspace-a', 'tester', profile({ name: 'Bad Plugin Credential', driverId: 'vendor.redis', settings: { security: 'ssl' }, credentials: { password: 'wrong-slot' } })), (error) => error.code === 'DATABASE_MANAGER_CREDENTIAL_SLOT_INVALID');
  await assert.rejects(values.service.create('workspace-a', 'tester', profile({ name: 'Undeclared Plugin Setting', driverId: 'vendor.redis', settings: { security: 'ssl', extra_properties: 'Pwd=plaintext' }, credentials: { token: 'value' } })), (error) => error.code === 'DATABASE_MANAGER_PLUGIN_SETTING_INVALID');
  await assert.rejects(values.service.create('workspace-a', 'tester', profile({ name: 'Invalid Plugin Setting', driverId: 'vendor.redis', settings: { security: 'optional' }, credentials: { token: 'value' } })), (error) => error.code === 'DATABASE_MANAGER_PLUGIN_SETTING_INVALID');
  await assert.rejects(values.service.create('workspace-a', 'tester', profile({ name: 'Missing Plugin Setting', driverId: 'vendor.redis', settings: {}, credentials: { token: 'value' } })), (error) => error.code === 'DATABASE_MANAGER_PLUGIN_SETTING_REQUIRED');
  await assert.rejects(values.service.create('workspace-a', 'tester', profile({ name: 'Missing Plugin Credential', driverId: 'vendor.redis', settings: { security: 'ssl' }, credentials: { 'extra-properties': 'ApplicationName=DeployerX' } })), (error) => error.code === 'DATABASE_MANAGER_CREDENTIAL_REQUIRED');
});
