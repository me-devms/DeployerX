const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { MariadbConnectionService, MariadbLogicalAdapter } = require('./mariadb-logical');
const { BackupSecretStore } = require('./secrets');

class Runner {
  async run(input) {
    if (input.args.includes('--version')) return { stdout: `${path.basename(input.executable)} Ver 15.1 Distrib 10.11.6-MariaDB`, exitCode: 0, stderr: '' };
    const query = input.args.find((argument) => argument.startsWith('--execute='))?.slice(10) || '';
    if (query === 'SHOW DATABASES;') return { stdout: 'orders\nanalytics\nmysql\nsys\n', exitCode: 0, stderr: '' };
    if (query.startsWith('SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables')) return { stdout: 'invoices\tBASE TABLE\ninvoice_view\tVIEW\n', exitCode: 0, stderr: '' };
    return { stdout: '10.11.6-MariaDB\t81\tmariadb-node-a\tMariaDB Server\n', exitCode: 0, stderr: '' };
  }

  stream() { throw new Error('Backup streaming is outside this integration.'); }
  async consume() { throw new Error('Restore streaming is outside this integration.'); }
}

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable on this device.');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mariadb-electron-test-'));
  const password = `electron-mariadb-${Date.now()}-${Math.random()}`;
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    const credentialRoot = path.join(rootPath, 'credentials');
    await fs.mkdir(credentialRoot, { recursive: true });
    const adapter = new MariadbLogicalAdapter({ processRunner: new Runner(), temporaryRoot: credentialRoot });
    const connections = new MariadbConnectionService({ controlDatabase, secretStore, deviceId: 'mariadb-electron-device', adapter });
    const created = await connections.create('local', 'electron-test', { name: 'Electron MariaDB', host: 'db.example.com', username: 'backup', password, tlsMode: 'verify-identity' });
    const tested = await connections.test('local', created.id, 'electron-test');
    const discovered = await connections.discover('local', created.id);
    const objects = await connections.discover('local', created.id, { kind: 'table', database: 'orders' });
    const source = await new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([adapter]) }).save('local', 'electron-test', {
      name: 'Electron MariaDB orders', connectionId: created.id,
      selector: { databases: { include: [{ name: 'orders' }] }, tables: { include: [{ database: 'orders', schema: 'orders', name: objects.items.find((item) => item.name === 'invoices').name }] } },
      consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' }
    });
    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const [persistedConnection] = await controlDatabase.repository('connection').list('local');
    const persistedSource = await controlDatabase.repository('source').get('local', source.id);
    const controlBytes = await fs.readFile(path.join(rootPath, 'control', 'control.db'));
    const secretBytes = await fs.readFile(path.join(rootPath, 'secrets', 'secrets.json'));
    const plaintextPersisted = controlBytes.includes(Buffer.from(password)) || secretBytes.includes(Buffer.from(password));
    const ok = tested.result.status === 'success'
      && tested.connection.trust.fingerprint?.startsWith('sha256:')
      && discovered.items.map((item) => item.name).join(',') === 'analytics,orders'
      && persistedConnection.adapterId === 'deployerx.database.mariadb.logical'
      && persistedConnection.secretRefIds.length === 1
      && persistedSource.selector.digest.length === 64
      && persistedSource.selector.tables.include[0].name === 'invoices'
      && !plaintextPersisted;
    process.stdout.write(`${JSON.stringify({ ok, connectionStatus: tested.result.status, serverIdentity: tested.connection.trust.fingerprint, databases: discovered.items.map((item) => item.name), objects: objects.items.map((item) => item.name), sourceType: persistedSource.sourceType, plaintextPersisted })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await controlDatabase?.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    app.quit();
  }
}

run();
