const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { RedisConnectionService, RedisNativeAdapter } = require('./redis');
const { BackupSecretStore } = require('./secrets');

const REPLICATION_ID = '0123456789abcdef0123456789abcdef01234567';

class Runner {
  constructor() { this.calls = []; }

  async run(input) {
    this.calls.push({ args: [...input.args], passwordInEnvironment: Boolean(input.env?.REDISCLI_AUTH) });
    const commandMap = [
      { suffix: ['PING'], value: 'PONG' },
      { suffix: ['INFO', 'server'], value: '# Server\nredis_version:8.10.0\nredis_mode:standalone\nrun_id:electron-redis-run\n' },
      { suffix: ['INFO', 'persistence'], value: 'loading:0\nrdb_bgsave_in_progress:0\nrdb_last_bgsave_status:ok\nrdb_last_save_time:100\naof_enabled:1\naof_rewrite_in_progress:0\naof_last_bgrewrite_status:ok\naof_last_write_status:ok\n' },
      { suffix: ['INFO', 'replication'], value: `role:master\nmaster_replid:${REPLICATION_ID}\nmaster_repl_offset:200\nconnected_slaves:0\n` },
      { suffix: ['INFO', 'keyspace'], value: 'db0:keys=21,expires=3,avg_ttl=5000\n' },
      { suffix: ['ROLE'], value: ['master', 200, []] },
      { suffix: ['CONFIG', 'GET', 'dir', 'dbfilename', 'appendonly', 'appendfilename', 'appenddirname', 'auto-aof-rewrite-percentage', 'backupdirname', 'backup-sealed-ttl'], value: ['dir', '/var/lib/redis', 'dbfilename', 'dump.rdb', 'appendonly', 'yes', 'appendfilename', 'appendonly.aof', 'appenddirname', 'appendonlydir', 'auto-aof-rewrite-percentage', '100', 'backupdirname', 'backupdir', 'backup-sealed-ttl', '0'] },
      { suffix: ['COMMAND', 'INFO', 'BACKUP'], value: [['backup', -2, ['write'], 0, 0, 0]] }
    ];
    const entry = commandMap.find(({ suffix }) => suffix.every((part, index) => input.args[input.args.length - suffix.length + index] === part));
    if (!entry) throw new Error(`Unexpected redis-cli command: ${input.args.join(' ')}`);
    return { exitCode: 0, stdout: JSON.stringify(entry.value), stderr: '' };
  }
}

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable on this device.');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-electron-test-'));
  const password = `electron-redis-${Date.now()}-${Math.random()}`;
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    const runner = new Runner();
    const adapter = new RedisNativeAdapter({ processRunner: runner });
    const connections = new RedisConnectionService({ controlDatabase, secretStore, deviceId: 'redis-electron-device', adapter });
    const created = await connections.create('local', 'electron-test', {
      name: 'Electron Redis', host: 'redis01.example.com', username: 'backup-user', password,
      expectedTopology: 'standalone', tlsMode: 'verify-identity'
    });
    const tested = await connections.test('local', created.id, 'electron-test');
    const discovered = await connections.discover('local', created.id);

    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const persisted = await controlDatabase.repository('connection').get('local', created.id);
    const controlBytes = await fs.readFile(path.join(rootPath, 'control', 'control.db'));
    const secretBytes = await fs.readFile(path.join(rootPath, 'secrets', 'secrets.json'));
    const argumentsOnly = JSON.stringify(runner.calls.map((call) => call.args));
    const ok = tested.result.status === 'success'
      && tested.connection.trust.fingerprint?.startsWith('sha256:')
      && discovered.items.length === 1
      && discovered.items[0].keyCount === 21
      && persisted.secretRefIds.length === 1
      && runner.calls.every((call) => call.passwordInEnvironment)
      && !argumentsOnly.includes(password)
      && !controlBytes.includes(Buffer.from(password))
      && !secretBytes.includes(Buffer.from(password));
    process.stdout.write(`${JSON.stringify({ ok, status: tested.result.status, strategy: tested.result.endpointIdentity.backupStrategy, databases: discovered.items.map((item) => item.name), plaintextPersisted: controlBytes.includes(Buffer.from(password)) || secretBytes.includes(Buffer.from(password)), passwordInArguments: argumentsOnly.includes(password) })}\n`);
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
