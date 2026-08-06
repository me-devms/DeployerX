const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('../backup-manager/control-database');
const { DatabaseConnectionImportService } = require('./connection-import');
const { DatabaseLocalResourceStore } = require('./local-resource-store');
const { DatabaseProfileStore } = require('./profile-store');

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-import-'));
  const controlDatabase = new BackupControlDatabase({ rootPath });
  await controlDatabase.initialize();
  const profileStore = new DatabaseProfileStore({ controlDatabase });
  const localResourceStore = new DatabaseLocalResourceStore({ rootPath: path.join(rootPath, 'database-manager') });
  await localResourceStore.initialize();
  const importer = new DatabaseConnectionImportService({ controlDatabase, profileStore, localResourceStore, deviceId: 'device-a' });
  context.after(async () => {
    await controlDatabase.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });
  return { rootPath, controlDatabase, profileStore, localResourceStore, importer };
}

async function secret(controlDatabase, id) {
  return controlDatabase.repository('secretRef').create({
    id,
    workspaceId: 'workspace-a',
    actorId: 'tester',
    name: `${id} password`,
    provider: 'electron-safe-storage',
    scope: 'device',
    providerKey: id,
    secretType: 'password',
    version: 1
  });
}

async function connection(controlDatabase, input) {
  return controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a',
    actorId: 'tester',
    kind: 'database',
    adapterVersion: '1.0.0',
    scope: 'device',
    trust: {},
    lastTest: null,
    ...input
  });
}

test('imports compatible current-device connections without copying credentials or duplicating identity', async (context) => {
  const values = await fixture(context);
  const postgresSecret = await secret(values.controlDatabase, 'secret-postgres');
  const mysqlSecret = await secret(values.controlDatabase, 'secret-mysql');
  const existingConnection = await connection(values.controlDatabase, {
    id: 'connection-existing-profile', name: 'Existing shared identity', adapterId: 'deployerx.database-manager.mysql', scope: 'workspace',
    endpoint: { kind: 'network', host: 'existing.example.test', port: 3306 }, secretRefIds: [], workerAffinity: []
  });
  await values.profileStore.create('workspace-a', 'tester', {
    name: 'Orders', driverId: 'mysql', sharedConnectionId: existingConnection.id,
    endpoint: { kind: 'network', host: 'existing.example.test', port: 3306 }, database: null, defaultSchema: null,
    environment: 'development', accessMode: 'read-write', ssl: { mode: 'disabled' }, tunnel: { type: 'none' },
    credentialSlots: [], credentialBindings: {}
  });
  await connection(values.controlDatabase, {
    id: 'connection-postgres', name: 'Orders', adapterId: 'deployerx.database.postgresql.logical',
    endpoint: { host: 'postgres.example.test', port: 5432, username: 'app_user', database: 'postgres', tlsMode: 'verify-identity', timeoutMs: 45000 },
    secretRefIds: [postgresSecret.id], workerAffinity: ['device:device-a']
  });
  await connection(values.controlDatabase, {
    id: 'connection-mysql', name: 'Reporting', adapterId: 'deployerx.database.mysql.logical',
    endpoint: { host: 'mysql.example.test', port: 3306, username: 'mysql_user', tlsMode: 'required' },
    secretRefIds: [mysqlSecret.id], workerAffinity: ['device:device-a']
  });
  await connection(values.controlDatabase, {
    id: 'connection-other-device', name: 'Remote MariaDB', adapterId: 'deployerx.database.mariadb.logical',
    endpoint: { host: 'maria.example.test', port: 3306, username: 'maria_user', tlsMode: 'required' },
    secretRefIds: [], workerAffinity: ['device:device-b']
  });
  await connection(values.controlDatabase, {
    id: 'connection-unsupported', name: 'MongoDB', adapterId: 'deployerx.database.mongodb.native',
    endpoint: { host: 'mongo.example.test', port: 27017 }, secretRefIds: [], workerAffinity: ['device:device-a']
  });

  const result = await values.importer.reconcile('workspace-a', 'tester');
  assert.equal(result.created.length, 2);
  assert.deepEqual(result.failures, []);
  const profiles = await values.profileStore.list('workspace-a', { limit: 1000 });
  assert.deepEqual(profiles.map((profile) => profile.name).sort(), ['Orders', 'Orders (Backup Manager)', 'Reporting']);
  const postgres = profiles.find((profile) => profile.sharedConnectionId === 'connection-postgres');
  assert.equal(postgres.driverId, 'postgresql');
  assert.equal(postgres.ssl.mode, 'verify-full');
  assert.equal(postgres.settings.username, 'app_user');
  assert.deepEqual(postgres.credentialSecretRefs, [{ slotId: 'password', secretRefId: postgresSecret.id }]);
  assert.equal((await values.controlDatabase.repository('secretRef').list('workspace-a', { limit: 1000 })).length, 2);
  assert.equal((await values.controlDatabase.repository('connection').list('workspace-a', { limit: 1000 })).length, 5);
});

test('is idempotent and preserves deletion as an import opt-out', async (context) => {
  const values = await fixture(context);
  await connection(values.controlDatabase, {
    id: 'connection-mariadb', name: 'Commerce MariaDB', adapterId: 'deployerx.database.mariadb.logical',
    endpoint: { host: 'maria.example.test', port: 3306, username: 'commerce', tlsMode: 'preferred' },
    secretRefIds: [], workerAffinity: ['device:device-a']
  });
  const first = await values.importer.reconcile('workspace-a', 'tester');
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].profile.driverId, 'mysql');
  assert.equal((await values.importer.reconcile('workspace-a', 'tester')).created.length, 0);
  const profile = first.created[0].profile;
  await values.profileStore.delete('workspace-a', 'tester', profile.id, profile.revision);
  assert.equal((await values.importer.reconcile('workspace-a', 'tester')).created.length, 0);
  assert.equal((await values.controlDatabase.repository('databaseProfile').list('workspace-a', { includeDeleted: true, limit: 1000 })).length, 1);
});

test('moves imported SQLite paths into device-local bindings only', async (context) => {
  const values = await fixture(context);
  const databasePath = path.join(values.rootPath, 'orders.sqlite3');
  await fs.writeFile(databasePath, 'SQLite format 3\0fixture');
  await connection(values.controlDatabase, {
    id: 'connection-sqlite', name: 'Local orders', adapterId: 'deployerx.database.sqlite.native',
    endpoint: { databasePath, sqliteExecutable: 'sqlite3', timeoutMs: 30000 },
    secretRefIds: [], workerAffinity: ['device:device-a']
  });
  const result = await values.importer.reconcile('workspace-a', 'tester');
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].localResourceBound, true);
  const profile = result.created[0].profile;
  assert.deepEqual(profile.endpoint, { kind: 'file', localResourceRequired: true });
  assert.equal(JSON.stringify(profile).includes(databasePath), false);
  assert.equal(await values.localResourceStore.resolve({ workspaceId: 'workspace-a', profileId: profile.id, kind: 'file' }), await fs.realpath(databasePath));
});
