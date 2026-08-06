const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { Neo4jAdapter, Neo4jConnectionService } = require('./neo4j');
const { BackupSecretStore } = require('./secrets');

function databaseOutput() {
  return [
    'name\ttype\taccess\tcurrentStatus\trequestedStatus\trole\twriter\tdefault\thome\tdatabaseID\tserverID\tconstituents',
    'neo4j\tstandard\tread-write\tonline\tonline\tprimary\ttrue\ttrue\ttrue\tdb-neo4j\tserver-a\tnull',
    'system\tsystem\tread-write\tonline\tonline\tprimary\ttrue\tfalse\tfalse\tdb-system\tserver-a\tnull'
  ].join('\n');
}

function nativeRunner(credential, observations) {
  return async ({ executable, args, env = {} }) => {
    const name = String(executable).replace(/\\/g, '/').split('/').at(-1);
    if (args.some((argument) => String(argument).includes(credential))) throw new Error('Neo4j credential entered native command arguments.');
    if (name === 'neo4j') return { stdout: 'neo4j 5.26.2\n', stderr: '', exitCode: 0 };
    if (name === 'neo4j-admin') return { stdout: 'neo4j-admin 5.26.2\n', stderr: '', exitCode: 0 };
    if (name !== 'cypher-shell') throw new Error(`Unexpected executable: ${name}`);
    observations.push({ username: env.NEO4J_USERNAME, passwordMatched: env.NEO4J_PASSWORD === credential, uri: env.NEO4J_URI });
    if (env.NEO4J_USERNAME !== 'backup-user' || env.NEO4J_PASSWORD !== credential) throw new Error('Resolved Neo4j credential was not supplied through the protected environment.');
    const statement = args.at(-1);
    if (statement.startsWith('CALL dbms.components')) return { stdout: 'name\tversion\tedition\nNeo4j Kernel\t5.26.2\tenterprise\n', stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW DATABASES')) return { stdout: `${databaseOutput()}\n`, stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW SERVERS')) return { stdout: 'serverId\tname\taddress\tstate\thealth\thosting\nserver-a\tneo-a\t10.0.0.1:7688\tenabled\tavailable\t[neo4j, system]\n', stderr: '', exitCode: 0 };
    throw new Error(`Unexpected Cypher statement: ${statement}`);
  };
}

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable on this device.');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-neo4j-electron-test-'));
  const credential = `electron-neo4j-${Date.now()}-${Math.random()}`;
  const observations = [];
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    const adapter = new Neo4jAdapter();
    const connections = new Neo4jConnectionService({ controlDatabase, secretStore, deviceId: 'neo4j-electron-device', adapter, localCommandRunner: nativeRunner(credential, observations) });
    const created = await connections.create('local', 'electron-test', {
      name: 'Electron Neo4j', expectedEdition: 'auto', executionMode: 'local', address: 'neo4j://127.0.0.1:7687',
      username: 'backup-user', password: credential
    });
    const tested = await connections.test('local', created.id, 'electron-test');
    const discovered = await connections.discover('local', created.id, { kind: 'databases' });
    const source = await new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([adapter]), deviceId: 'neo4j-electron-device' }).save('local', 'electron-test', {
      name: 'Neo4j offline Source', connectionId: created.id,
      selector: { databases: { include: [{ name: 'neo4j' }] } },
      consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full', method: 'offline', captureCoordinates: false }
    });
    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const persisted = await controlDatabase.repository('connection').get('local', created.id);
    const controlBytes = await fs.readFile(path.join(rootPath, 'control', 'control.db'));
    const secretBytes = await fs.readFile(path.join(rootPath, 'secrets', 'secrets.json'));
    const plaintextPersisted = controlBytes.includes(Buffer.from(credential)) || secretBytes.includes(Buffer.from(credential));
    const ok = tested.result.status === 'success'
      && tested.connection.endpoint.expectedEdition === 'enterprise'
      && tested.connection.endpoint.expectedVersion === '5.26.2'
      && tested.connection.trust.fingerprint?.startsWith('sha256:')
      && tested.connection.neo4jInventory?.databases?.length === 2
      && discovered.items.some((database) => database.name === 'neo4j' && database.selectable)
      && discovered.items.some((database) => database.name === 'system' && !database.selectable)
      && persisted.secretRefIds.length === 1
      && observations.length === 9
      && observations.every((entry) => entry.passwordMatched && entry.username === 'backup-user')
      && source.enabled === true
      && source.executionStatus === 'ready-for-runtime-preflight'
      && source.physicalExecution === null
      && !plaintextPersisted;
    process.stdout.write(`${JSON.stringify({ ok, status: tested.result.status, edition: tested.result.endpointIdentity.edition, databases: discovered.items.map((item) => item.name), observations: observations.length, sourceEnabled: source.enabled, sourceExecutionStatus: source.executionStatus, plaintextPersisted })}\n`);
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
