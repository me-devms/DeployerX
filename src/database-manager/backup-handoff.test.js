const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('../backup-manager/control-database');
const { DatabaseBackupHandoffService, backupConnectionProjection } = require('./backup-handoff');

function profile(overrides = {}) {
  return {
    id: 'profile-a', name: 'Orders PostgreSQL', driverId: 'postgresql', sharedConnectionId: 'connection-a',
    endpoint: { kind: 'network', host: 'db.example.test', port: 5432 }, database: 'orders',
    ssl: { mode: 'verify-full' }, tunnel: { type: 'none' }, queryTimeoutMs: 60000,
    settings: { username: 'backup_user' }, credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-a' }],
    ...overrides
  };
}

test('projects supported profiles into native Backup Manager connection contracts', () => {
  const postgres = backupConnectionProjection(profile(), { deviceId: 'device-a' });
  assert.equal(postgres.adapterId, 'deployerx.database.postgresql.logical');
  assert.equal(postgres.endpoint.maintenanceDatabase, 'postgres');
  assert.equal(postgres.endpoint.tlsMode, 'verify-identity');
  assert.deepEqual(postgres.workerAffinity, ['device:device-a']);
  assert.deepEqual(postgres.secretRefIds, ['secret-a']);

  const mysql = backupConnectionProjection(profile({ driverId: 'mysql', endpoint: { kind: 'network', host: 'mysql.example.test', port: 3306 } }), { deviceId: 'device-a' });
  assert.equal(mysql.adapterId, 'deployerx.database.mysql.logical');
  assert.equal(mysql.endpoint.mysqlExecutable, 'mysql');

  const sqlite = backupConnectionProjection(profile({ driverId: 'sqlite', endpoint: { kind: 'file' }, settings: {}, credentialSecretRefs: [] }), { deviceId: 'device-a', localPath: 'C:\\data\\orders.sqlite3' });
  assert.equal(sqlite.adapterId, 'deployerx.database.sqlite.native');
  assert.equal(sqlite.endpoint.databasePath, 'C:\\data\\orders.sqlite3');
  assert.deepEqual(sqlite.secretRefIds, []);
});

test('rejects handoffs that Backup Manager cannot execute', () => {
  assert.throws(() => backupConnectionProjection(profile({ credentialSecretRefs: [] }), { deviceId: 'device-a' }), (error) => error.code === 'DATABASE_MANAGER_BACKUP_CREDENTIAL_REQUIRED');
  assert.throws(() => backupConnectionProjection(profile({ tunnel: { type: 'server', projectId: 'server-a' } }), { deviceId: 'device-a' }), (error) => error.code === 'DATABASE_MANAGER_BACKUP_TUNNEL_UNAVAILABLE');
  assert.throws(() => backupConnectionProjection(profile({ driverId: 'oracle' }), { deviceId: 'device-a' }), (error) => error.code === 'DATABASE_MANAGER_BACKUP_DRIVER_UNSUPPORTED');
});

test('prepares the existing shared connection without creating a Source or duplicate connection', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-backup-handoff-'));
  const controlDatabase = new BackupControlDatabase({ rootPath });
  await controlDatabase.initialize();
  context.after(async () => { await controlDatabase.close(); await fs.rm(rootPath, { recursive: true, force: true }); });
  await controlDatabase.repository('secretRef').create({
    id: 'secret-a', workspaceId: 'workspace-a', actorId: 'tester', name: 'Orders password',
    provider: 'electron-safe-storage', scope: 'device', providerKey: 'orders-password', secretType: 'password', version: 1
  });
  const connection = await controlDatabase.repository('connection').create({
    id: 'connection-a', workspaceId: 'workspace-a', actorId: 'tester', name: 'Orders PostgreSQL', kind: 'database',
    adapterId: 'deployerx.database-manager.postgresql', adapterVersion: '1.0.0', scope: 'workspace',
    endpoint: { kind: 'network', host: 'db.example.test', port: 5432 }, secretRefIds: ['secret-a'], trust: {}, workerAffinity: []
  });
  const service = new DatabaseBackupHandoffService({
    controlDatabase, deviceId: 'device-a', profileService: { get: async () => profile() }, localResourceResolver: async () => null
  });
  const prepared = await service.prepare('workspace-a', 'tester', 'profile-a');
  assert.equal(prepared.connectionId, connection.id);
  assert.equal(prepared.connection.adapterId, 'deployerx.database.postgresql.logical');
  assert.equal((await controlDatabase.repository('connection').list('workspace-a')).length, 1);
  assert.equal((await controlDatabase.repository('source').list('workspace-a')).length, 0);
  const again = await service.prepare('workspace-a', 'tester', 'profile-a');
  assert.equal(again.connection.revision, prepared.connection.revision, 'idempotent handoff must not reset tested connection state');
});

test('requires a bound file before preparing SQLite', async () => {
  const service = new DatabaseBackupHandoffService({
    controlDatabase: { repository() { throw new Error('must not read connections'); } },
    deviceId: 'device-a', profileService: { get: async () => profile({ driverId: 'sqlite', endpoint: { kind: 'file' }, settings: {}, credentialSecretRefs: [] }) },
    localResourceResolver: async () => null
  });
  await assert.rejects(service.prepare('workspace-a', 'tester', 'profile-a'), (error) => error.code === 'DATABASE_MANAGER_BACKUP_LOCAL_RESOURCE_REQUIRED');
});
