const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase, CONTROL_DATABASE_VERSION } = require('../backup-manager/control-database');
const { DatabaseBackupHandoffService } = require('./backup-handoff');
const { DatabaseProfileStore } = require('./profile-store');

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-profile-test-'));
  let currentMs = Date.parse('2026-08-05T10:00:00.000Z');
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => new Date(currentMs).toISOString() });
  await controlDatabase.initialize();
  context.after(async () => {
    await controlDatabase.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });
  return { controlDatabase, store: new DatabaseProfileStore({ controlDatabase }), advance(ms) { currentMs += ms; } };
}

function profile(overrides = {}) {
  return {
    name: 'Orders PostgreSQL',
    driverId: 'postgresql',
    endpoint: { kind: 'network', host: 'db.example.test', port: 5432 },
    database: 'orders',
    defaultSchema: 'public',
    environment: 'production',
    accessMode: 'read-only',
    tags: ['orders'],
    ssl: { mode: 'verify-full', caPathRequired: true },
    tunnel: { type: 'none' },
    credentialSlots: [{ id: 'password', type: 'password', label: 'Password' }],
    credentialBindings: {},
    ...overrides
  };
}

async function secret(controlDatabase, workspaceId = 'workspace-a') {
  return controlDatabase.repository('secretRef').create({
    workspaceId,
    actorId: 'tester',
    name: 'Database password',
    provider: 'electron-safe-storage',
    scope: 'device',
    providerKey: 'opaque-database-password',
    secretType: 'password',
    version: 1
  });
}

test('extends the shared control schema with database profile repositories', async (context) => {
  const values = await fixture(context);
  assert.equal(CONTROL_DATABASE_VERSION, 7);
  assert.ok(values.controlDatabase.repositories.databaseProfile);
});

test('creates workspace profiles and shared database connections atomically', async (context) => {
  const values = await fixture(context);
  const password = await secret(values.controlDatabase);
  const created = await values.store.create('workspace-a', 'tester', profile({ credentialBindings: { password: password.id } }));
  const connection = await values.controlDatabase.repository('connection').get('workspace-a', created.sharedConnectionId);

  assert.equal(created.revision, 1);
  assert.equal(created.driverId, 'postgresql');
  assert.deepEqual(created.credentialSecretRefs, [{ slotId: 'password', secretRefId: password.id }]);
  assert.equal(connection.kind, 'database');
  assert.equal(connection.adapterId, 'deployerx.database-manager.postgresql');
  assert.deepEqual(connection.secretRefIds, [password.id]);
  assert.equal(await values.store.get('workspace-b', created.id), null);
  await assert.rejects(
    values.controlDatabase.repository('connection').softDelete('workspace-a', connection.id, { expectedRevision: connection.revision, actorId: 'tester' }),
    /active database profile/
  );
});

test('preserves an explicit shared profile ID when importing cloud metadata', async (context) => {
  const values = await fixture(context);
  const created = await values.store.create('workspace-a', 'tester', profile({ id: 'shared-profile-a', credentialSlots: [] }));
  assert.equal(created.id, 'shared-profile-a');
  assert.ok(created.sharedConnectionId);
});

test('links existing Backup Manager connections without duplicating identity', async (context) => {
  const values = await fixture(context);
  const connection = await values.controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Existing MySQL', kind: 'database',
    adapterId: 'deployerx.database.mysql.logical', adapterVersion: '1.0.0', endpoint: { host: 'mysql.example.test', port: 3306 },
    secretRefIds: [], trust: {}, workerAffinity: []
  });
  const created = await values.store.create('workspace-a', 'tester', profile({
    name: 'Existing MySQL workspace', driverId: 'mysql', sharedConnectionId: connection.id,
    endpoint: { kind: 'network', host: 'mysql.example.test', port: 3306 }, credentialSlots: []
  }));
  assert.equal(created.sharedConnectionId, connection.id);
  assert.equal((await values.controlDatabase.repository('connection').list('workspace-a')).length, 1);
});

test('updates profiles with revisions and releases profile-only references on delete', async (context) => {
  const values = await fixture(context);
  const created = await values.store.create('workspace-a', 'tester', profile({ credentialSlots: [] }));
  values.advance(1000);
  const updated = await values.store.update('workspace-a', 'editor', created.id, { name: 'Orders read replica', environment: 'staging' }, created.revision);
  assert.equal(updated.name, 'Orders read replica');
  assert.equal(updated.environment, 'staging');
  assert.equal(updated.revision, 2);
  await assert.rejects(values.store.update('workspace-a', 'editor', created.id, { name: 'Stale' }, created.revision), (error) => error.code === 'BACKUP_CONTROL_REVISION_CONFLICT');
  const deleted = await values.store.delete('workspace-a', 'editor', created.id, updated.revision);
  assert.equal(deleted.revision, 3);
  assert.equal(await values.store.get('workspace-a', created.id), null);
  const connection = await values.controlDatabase.repository('connection').get('workspace-a', created.sharedConnectionId);
  const removedConnection = await values.controlDatabase.repository('connection').softDelete('workspace-a', connection.id, { expectedRevision: connection.revision, actorId: 'editor' });
  assert.ok(removedConnection.deletedAt);
});

test('keeps a prepared Backup Manager connection compatible after profile edits', async (context) => {
  const values = await fixture(context);
  const password = await secret(values.controlDatabase);
  const created = await values.store.create('workspace-a', 'tester', profile({
    settings: { username: 'backup_user' }, credentialBindings: { password: password.id }
  }));
  const handoff = new DatabaseBackupHandoffService({
    controlDatabase: values.controlDatabase,
    profileService: { get: (...args) => values.store.get(...args) },
    localResourceResolver: async () => null,
    deviceId: 'device-a'
  });
  await handoff.prepare('workspace-a', 'tester', created.id);
  const updated = await values.store.update('workspace-a', 'editor', created.id, { name: 'Orders protected primary' }, created.revision);
  const connection = await values.controlDatabase.repository('connection').get('workspace-a', updated.sharedConnectionId);
  assert.equal(connection.name, 'Orders protected primary');
  assert.equal(connection.adapterId, 'deployerx.database.postgresql.logical');
  assert.equal(connection.endpoint.username, 'backup_user');
  assert.deepEqual(connection.workerAffinity, ['device:device-a']);
});

test('rejects missing, cross-workspace, and undeclared credential references', async (context) => {
  const values = await fixture(context);
  const otherSecret = await secret(values.controlDatabase, 'workspace-b');
  await assert.rejects(values.store.create('workspace-a', 'tester', profile()), (error) => error.code === 'DATABASE_MANAGER_CREDENTIAL_REQUIRED');
  await assert.rejects(
    values.store.create('workspace-a', 'tester', profile({ credentialBindings: { password: otherSecret.id } })),
    (error) => error.code === 'DATABASE_MANAGER_SECRET_REF_NOT_FOUND'
  );
  await assert.rejects(
    values.store.create('workspace-a', 'tester', profile({ credentialSlots: [], credentialBindings: { token: otherSecret.id } })),
    (error) => error.code === 'DATABASE_MANAGER_CREDENTIAL_SLOT_INVALID'
  );
});
