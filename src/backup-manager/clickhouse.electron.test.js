const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { DESTINATION_CONFIRMATION, ClickHouseAdapter, ClickHouseConnectionService, QUERIES } = require('./clickhouse');
const { BackupSecretStore } = require('./secrets');

function lines(rows) { return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''); }

function discoveryOutput(query) {
  const outputs = {
    [QUERIES.identity]: lines([{ version: '25.8.3.66', timezone: 'UTC', host_name: 'clickhouse-a', current_user: 'backup_user' }]),
    [QUERIES.databases]: lines([{ name: 'analytics', uuid: '11111111-1111-4111-8111-111111111111', engine: 'Atomic', data_path: '/var/lib/clickhouse/' }]),
    [QUERIES.tables]: lines([{ database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'ReplicatedMergeTree', is_temporary: 0 }]),
    [QUERIES.clusters]: lines([{ cluster: 'production', shard_num: 1, shard_weight: 1, replica_num: 1, host_name: 'clickhouse-a', host_address: '10.0.0.1', port: 9440, is_local: 1, errors_count: 0, estimated_recovery_time: 0 }]),
    [QUERIES.replicas]: lines([{ database: 'analytics', table: 'events', zookeeper_path: '/clickhouse/tables/01/events', replica_name: 'clickhouse-a', is_readonly: 0, is_session_expired: 0, future_parts: 0, queue_size: 0, absolute_delay: 0, total_replicas: 2, active_replicas: 2 }]),
    [QUERIES.partitions]: lines([{ database: 'analytics', table: 'events', partition: '202608', part_count: 3, row_count: 1000, bytes_on_disk: 4096 }]),
    [QUERIES.disks]: lines([{ name: 'backups', type: 'local', path: '/var/lib/clickhouse/backups/', free_space: 100000, total_space: 200000, keep_free_space: 1000, is_read_only: 0, is_write_once: 0 }]),
    [QUERIES.namedCollections]: lines([{ name: 'backup_s3' }]),
    [QUERIES.grants]: lines([{ access_type: 'BACKUP', database: 'analytics', table: '*' }]),
    [QUERIES.backups]: lines([{ row_count: 0 }])
  };
  if (!(query in outputs)) throw new Error(`Unexpected ClickHouse query: ${query}`);
  return outputs[query];
}

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable on this device.');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-clickhouse-electron-test-'));
  const credential = `electron-clickhouse-${Date.now()}-${Math.random()}`;
  const observations = [];
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    const adapter = new ClickHouseAdapter();
    const connections = new ClickHouseConnectionService({
      controlDatabase, secretStore, deviceId: 'clickhouse-electron-device', adapter, temporaryRoot: path.join(rootPath, 'temporary'),
      localCommandRunner: async ({ executable, args }) => {
        const configArgument = args.find((argument) => String(argument).startsWith('--config-file='));
        const configPath = String(configArgument || '').slice('--config-file='.length);
        const config = await fs.readFile(configPath, 'utf8');
        observations.push({ executable, args: [...args], configPath, passwordPresent: config.includes(credential), passwordInArguments: args.some((argument) => String(argument).includes(credential)) });
        return { stdout: discoveryOutput(args.at(-1)), stderr: '', exitCode: 0 };
      }
    });
    await fs.mkdir(path.join(rootPath, 'temporary'), { recursive: true });
    const created = await connections.create('local', 'electron-test', { name: 'Electron ClickHouse', executionMode: 'local', host: 'clickhouse.example.com', port: 9440, tlsMode: 'required', username: 'backup_user', password: credential });
    const tested = await connections.test('local', created.id, 'electron-test');
    const discovered = await connections.discover('local', created.id, { kind: 'all' });
    const approved = await connections.approveDestination('local', created.id, { diskName: 'backups', confirmationText: DESTINATION_CONFIRMATION }, 'electron-test');
    const protectedPaths = [...new Set(observations.map((entry) => entry.configPath))];
    const cleaned = (await Promise.all(protectedPaths.map((configPath) => fs.stat(configPath).then(() => false, () => true)))).every(Boolean);
    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const persisted = await controlDatabase.repository('connection').get('local', created.id);
    const controlBytes = await fs.readFile(path.join(rootPath, 'control', 'control.db'));
    const secretBytes = await fs.readFile(path.join(rootPath, 'secrets', 'secrets.json'));
    const plaintextPersisted = controlBytes.includes(Buffer.from(credential)) || secretBytes.includes(Buffer.from(credential));
    const ok = tested.result.status === 'success'
      && tested.connection.endpoint.expectedVersion === '25.8.3.66'
      && tested.connection.trust.fingerprint?.startsWith('sha256:')
      && tested.connection.clickhouseInventory?.databases?.length === 1
      && tested.connection.clickhouseInventory?.tables?.length === 1
      && approved.destinationTrust.destinationFingerprint?.startsWith('sha256:')
      && discovered.databases[0].name === 'analytics'
      && discovered.tables[0].uuid === '22222222-2222-4222-8222-222222222222'
      && persisted.secretRefIds.length === 1
      && !Object.prototype.hasOwnProperty.call(persisted.endpoint, 'password')
      && observations.length === Object.keys(QUERIES).length * 4
      && observations.every((entry) => entry.executable === 'clickhouse-client' && entry.passwordPresent && !entry.passwordInArguments)
      && protectedPaths.length === 3
      && cleaned
      && !plaintextPersisted;
    process.stdout.write(`${JSON.stringify({ ok, status: tested.result.status, version: tested.result.endpointIdentity.version, databases: discovered.databases.map((item) => item.name), tables: discovered.tables.map((item) => `${item.database}.${item.name}`), observations: observations.length, protectedConfigs: protectedPaths.length, cleaned, plaintextPersisted })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await controlDatabase?.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
}

run();
