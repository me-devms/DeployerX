const { app } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');

function adapter() {
  return {
    manifest() {
      return {
        apiVersion: 1, adapterId: 'deployerx.database.test.logical', adapterVersion: '1.0.0', displayName: 'TestDB logical',
        engine: 'testdb', serverVersionRange: '>=10 <20', restoreVersionRange: '>=10 <21',
        capabilities: {
          backupMethods: ['logical'], backupModes: ['full'], selection: { database: true, schema: true, table: true, globalObjects: false },
          consistencyStrategies: [{ id: 'transaction-snapshot', produces: 'application', backupMethods: ['logical'], lockScope: 'none', capturesCoordinates: true }],
          transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null },
          streaming: { backup: true, restore: true, compression: true, encryption: false },
          restore: { alternateTarget: true, nativeValidation: true }, replicaAware: false
        },
        requiredTools: [], requiredPrivileges: []
      };
    },
    async testConnection() {}, async *discover() {}, async preflight() {}, async planBackup() {}, async executeBackup() {},
    async planRestore() {}, async executeRestore() {}, async validateRestore() {}
  };
}

app.whenReady().then(async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-source-electron-test-'));
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const connection = await controlDatabase.repository('connection').create({
      workspaceId: 'local', actorId: 'electron-test', name: 'TestDB', kind: 'database', adapterId: 'deployerx.database.test.logical',
      endpoint: { host: 'db.example.com', port: 15432, tlsMode: 'verify-full' }
    });
    const service = new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([adapter()]) });
    const source = await service.save('local', 'electron-test', {
      name: 'Electron database', connectionId: connection.id,
      selector: { databases: { include: [{ name: 'orders' }] }, schemas: { include: [{ database: 'orders', name: 'public' }] } },
      consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true }
    });
    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath });
    await controlDatabase.initialize();
    const persisted = await controlDatabase.repository('source').get('local', source.id);
    const ok = persisted?.sourceType === 'database'
      && persisted.selector?.digest?.length === 64
      && persisted.consistency?.requestedLevel === 'application'
      && persisted.lastDiscovery?.consistencyStatus === 'requires-runtime-preflight';
    process.stdout.write(`${JSON.stringify({
      ok,
      adapterId: persisted?.adapterId,
      sourceType: persisted?.sourceType,
      selectionDigestLength: persisted?.selector?.digest?.length,
      consistency: persisted?.consistency?.requestedLevel,
      runtimePreflightRequired: persisted?.lastDiscovery?.consistencyStatus === 'requires-runtime-preflight'
    })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await controlDatabase?.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    app.quit();
  }
});
