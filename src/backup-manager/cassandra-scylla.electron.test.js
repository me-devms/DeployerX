const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { CassandraScyllaAdapter, CassandraScyllaConnectionService } = require('./cassandra-scylla');
const { BackupSecretStore } = require('./secrets');

function nativeRunner(credential, observedCredentialFiles) {
  return async ({ executable, args }) => {
    const name = String(executable).replace(/\\/g, '/').split('/').at(-1);
    if (name === 'scylla' && args[0] === '--version') return { stdout: '6.2.1-0.20260804\n', stderr: '', exitCode: 0 };
    if (name === 'cassandra' && args[0] === '-v') throw Object.assign(new Error('missing'), { exitCode: 1 });
    if (name === 'nodetool') {
      if (args[0] === 'version') return { stdout: 'ReleaseVersion: 3.0.8\n', stderr: '', exitCode: 0 };
      if (args[0] === 'info') return { stdout: 'ID: 11111111-1111-1111-1111-111111111111\nGossip active: true\nNative Transport active: true\nCluster Name: electron-ring\n', stderr: '', exitCode: 0 };
      if (args[0] === 'status') return { stdout: 'Datacenter: dc1\n================\nUN  10.0.0.1  100 KiB  2  ?  11111111-1111-1111-1111-111111111111  rack1\n', stderr: '', exitCode: 0 };
      if (args[0] === 'ring') return { stdout: 'Datacenter: dc1\n==========\nAddress Rack Status State Load Owns Token\n10.0.0.1 rack1 Up Normal 100 KiB ? -100\n10.0.0.1 rack1 Up Normal 100 KiB ? 100\n', stderr: '', exitCode: 0 };
      if (args[0] === 'describecluster') return { stdout: 'Cluster Information:\n  Name: electron-ring\n  Schema versions:\n    aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa: [10.0.0.1]\n', stderr: '', exitCode: 0 };
      if (args[0] === 'statusbackup') return { stdout: 'running\n', stderr: '', exitCode: 0 };
      if (args[0] === 'listsnapshots') return { stdout: 'There are no snapshots\n', stderr: '', exitCode: 0 };
    }
    if (name === 'cqlsh') {
      if (args[0] === '--version') return { stdout: 'cqlsh 6.2.0\n', stderr: '', exitCode: 0 };
      const rcIndex = args.indexOf('--cqlshrc');
      if (rcIndex < 0) throw new Error('Protected cqlshrc was not supplied.');
      const rcPath = args[rcIndex + 1];
      const contents = await fs.readFile(rcPath, 'utf8');
      if (!contents.includes(credential)) throw new Error('Protected cqlshrc did not contain the resolved credential.');
      observedCredentialFiles.add(rcPath);
      const statement = args.at(-1);
      if (statement.includes('FROM system.local')) return { stdout: `${JSON.stringify({ cluster_name: 'electron-ring', data_center: 'dc1', host_id: '11111111-1111-1111-1111-111111111111', partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner', rack: 'rack1', release_version: '3.0.8', schema_version: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })}\n`, stderr: '', exitCode: 0 };
      if (statement.includes('FROM system_schema.keyspaces')) return { stdout: `${JSON.stringify({ keyspace_name: 'app', durable_writes: true, replication: { class: 'NetworkTopologyStrategy', dc1: '3' }, tablets: { enabled: false } })}\n`, stderr: '', exitCode: 0 };
      if (statement.includes('FROM system_schema.tables')) return { stdout: `${JSON.stringify({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', keyspace_name: 'app', table_name: 'orders' })}\n`, stderr: '', exitCode: 0 };
      if (statement.includes('FROM system_schema.views')) return { stdout: '', stderr: '', exitCode: 0 };
      if (statement.includes('FROM system_schema.indexes')) return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected native command: ${name} ${args.join(' ')}`);
  };
}

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable on this device.');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cassandra-scylla-electron-test-'));
  const credential = `electron-cql-${Date.now()}-${Math.random()}`;
  const observedCredentialFiles = new Set();
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    const adapter = new CassandraScyllaAdapter();
    const connections = new CassandraScyllaConnectionService({ controlDatabase, secretStore, deviceId: 'cassandra-electron-device', adapter, localCommandRunner: nativeRunner(credential, observedCredentialFiles) });
    const created = await connections.create('local', 'electron-test', {
      name: 'Electron ScyllaDB', expectedProduct: 'auto', executionMode: 'local', contactHost: '127.0.0.1', nativePort: 9042,
      cqlUsername: 'backup_user', cqlPassword: credential
    });
    const tested = await connections.test('local', created.id, 'electron-test');
    const discovered = await connections.discover('local', created.id, { kind: 'tables' });
    const source = await new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([adapter]), deviceId: 'cassandra-electron-device' }).save('local', 'electron-test', {
      name: 'Electron Scylla cluster', connectionId: created.id,
      selector: { databases: { include: [{ name: 'app' }] }, tables: { include: [{ database: 'app', schema: 'app', name: 'orders' }] } },
      consistency: { requestedLevel: 'crash', backupMethod: 'physical', backupMode: 'full', method: 'cassandra-native-snapshot', captureCoordinates: true },
      physicalExecution: {
        topology: 'cluster', nodes: [{ hostId: '11111111-1111-1111-1111-111111111111', connectionId: created.id }],
        tableIds: [{ keyspace: 'app', name: 'orders', tableId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }]
      }
    });

    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const persisted = await controlDatabase.repository('connection').get('local', created.id);
    const persistedSource = await controlDatabase.repository('source').get('local', source.id);
    const controlBytes = await fs.readFile(path.join(rootPath, 'control', 'control.db'));
    const secretBytes = await fs.readFile(path.join(rootPath, 'secrets', 'secrets.json'));
    const cleanupResults = await Promise.all([...observedCredentialFiles].map(async (file) => fs.stat(file).then(() => false, () => true)));
    const ok = tested.result.status === 'success'
      && tested.connection.endpoint.expectedProduct === 'scylladb'
      && tested.connection.endpoint.expectedClusterName === 'electron-ring'
      && tested.connection.trust.fingerprint?.startsWith('sha256:')
      && tested.connection.clusterInventory?.coverage?.tokenCount === 2
      && source.enabled === true
      && persistedSource?.executionStatus === 'ready-for-runtime-preflight'
      && persistedSource?.physicalExecution?.tables?.[0]?.tableId === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      && discovered.items.length === 1
      && discovered.items[0].name === 'orders'
      && persisted.secretRefIds.length === 1
      && observedCredentialFiles.size === 2
      && cleanupResults.every(Boolean)
      && !controlBytes.includes(Buffer.from(credential))
      && !secretBytes.includes(Buffer.from(credential));
    process.stdout.write(`${JSON.stringify({ ok, status: tested.result.status, product: tested.result.endpointIdentity.product, clusterName: tested.result.endpointIdentity.clusterName, tables: discovered.items.map((item) => item.name), sourceEnabled: persistedSource?.enabled, sourceExecutionStatus: persistedSource?.executionStatus, plaintextPersisted: controlBytes.includes(Buffer.from(credential)) || secretBytes.includes(Buffer.from(credential)), credentialFilesRemoved: cleanupResults.every(Boolean) })}\n`);
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
