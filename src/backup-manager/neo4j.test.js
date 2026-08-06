const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  Neo4jAdapter,
  Neo4jConnectionService,
  authEnvironmentContents,
  normalizeConfig,
  normalizeOnlineExecution,
  parseOnlineBackupInspection,
  parseTsv,
  parseVersion,
  supportsPreferDiffAsParent
} = require('./neo4j');

function config(overrides = {}) {
  return {
    executionMode: 'local',
    address: 'neo4j://127.0.0.1:7687',
    ...overrides
  };
}

function databaseOutput(serverId = 'server-a', databaseStatus = 'online') {
  return [
    'name\ttype\taccess\tcurrentStatus\trequestedStatus\trole\twriter\tdefault\thome\tdatabaseID\tserverID\tconstituents',
    `neo4j\tstandard\tread-write\t${databaseStatus}\t${databaseStatus}\tprimary\ttrue\ttrue\ttrue\tdb-neo4j\t${serverId}\tnull`,
    `system\tsystem\tread-write\tonline\tonline\tprimary\ttrue\tfalse\tfalse\tdb-system\t${serverId}\tnull`
  ].join('\n');
}

function runner({ edition = 'enterprise', version = '5.26.2', serverId = 'server-a', serverHealth = 'available', databaseStatus = 'online', dumpBytes = Buffer.from('neo4j-offline-dump') } = {}) {
  return async ({ executable, args }) => {
    const name = String(executable).replace(/\\/g, '/').split('/').at(-1);
    if (name === 'neo4j') return { stdout: `neo4j ${version}\n`, stderr: '', exitCode: 0 };
    if (name === 'neo4j-admin') {
      if (args[0] === '--version') return { stdout: `neo4j-admin ${version}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'database' && args[1] === 'dump') {
        const directory = args.find((item) => item.startsWith('--to-path=')).slice('--to-path='.length);
        await fs.writeFile(path.join(directory, `${args[2]}.dump`), dumpBytes, { flag: 'wx', mode: 0o600 });
        return { stdout: 'Dump completed successfully\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'database' && args[1] === 'info') return { stdout: `Database name: ${args.at(-1)}\nStore format: aligned\n`, stderr: '', exitCode: 0 };
    }
    if (name !== 'cypher-shell') throw new Error(`Unexpected executable: ${name}`);
    const statement = args.at(-1);
    if (statement.startsWith('CALL dbms.components')) return { stdout: `name\tversion\tedition\nNeo4j Kernel\t${version}\t${edition}\n`, stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW DATABASES')) return { stdout: `${databaseOutput(serverId, databaseStatus)}\n`, stderr: '', exitCode: 0 };
    if (statement.startsWith('SHOW SERVERS')) {
      if (edition === 'community') throw Object.assign(new Error('unsupported'), { exitCode: 1 });
      return { stdout: `serverId\tname\taddress\tstate\thealth\thosting\n${serverId}\tneo-a\t10.0.0.1:7688\tenabled\t${serverHealth}\t[neo4j, system]\n`, stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected statement: ${statement}`);
  };
}

test('normalizes local and SSH bindings without accepting inline credentials', () => {
  const local = normalizeConfig(config());
  assert.equal(local.executionMode, 'local');
  assert.equal(local.neo4jAdminPath, 'neo4j-admin');
  assert.equal(normalizeConfig(config({ executionMode: 'ssh', sshConnectionId: 'ssh-a' })).sshConnectionId, 'ssh-a');
  assert.throws(() => normalizeConfig(config({ password: 'plaintext' })), /Unknown Neo4j connection field/);
  assert.throws(() => normalizeConfig(config({ username: 'backup' })), /username and password SecretRef/);
  assert.throws(() => normalizeConfig(config({ executionMode: 'ssh' })), /saved SSH connection/);
  assert.throws(() => normalizeConfig(config({ address: 'https://neo4j.example.com' })), /Bolt or Neo4j URI scheme/);
  assert.throws(() => normalizeConfig(config({ address: 'neo4j://user:secret@db.example.com:7687' })), /cannot contain credentials/);
});

test('parses supported LTS and calendar versions and rejects unsupported releases', () => {
  assert.equal(parseVersion('neo4j 5.26.4').text, '5.26.4');
  assert.equal(parseVersion('Neo4j 2026.06.1').major, 2026);
  assert.equal(supportsPreferDiffAsParent('neo4j 5.26.4'), false);
  assert.equal(supportsPreferDiffAsParent('Neo4j 2025.04.0'), true);
  assert.throws(() => parseVersion('neo4j 5.25.9'), (error) => error.code === 'NEO4J_VERSION_UNSUPPORTED');
  assert.throws(() => parseVersion('unknown'), (error) => error.code === 'NEO4J_VERSION_INVALID');
});

test('parses bounded tabular Cypher output and rejects malformed rows', () => {
  const rows = parseTsv('name\tdatabaseID\nneo4j\tdb-a\nsystem\tdb-system\n', 'Database discovery');
  assert.deepEqual(rows, [{ name: 'neo4j', databaseID: 'db-a' }, { name: 'system', databaseID: 'db-system' }]);
  assert.throws(() => parseTsv('name\tid\nneo4j\n', 'Database discovery'), (error) => error.code === 'NEO4J_DISCOVERY_INVALID');
});

test('discovers Enterprise edition, databases, server topology, and stable identities', async () => {
  const adapter = new Neo4jAdapter({ clock: () => '2026-08-05T00:00:00.000Z', now: () => 10 });
  const context = { runNativeCommand: runner() };
  const result = await adapter.testConnection(context, config());
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.edition, 'enterprise');
  assert.equal(result.endpointIdentity.databaseCount, 2);
  assert.equal(result.endpointIdentity.serverCount, 1);
  assert.equal(result.endpointIdentity.defaultDatabase, 'neo4j');
  assert.match(result.endpointIdentity.deploymentFingerprint, /^sha256:[0-9a-f]{64}$/);
  const pages = [];
  for await (const page of adapter.discover(context, { connection: config(), kind: 'all' })) pages.push(page);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].databases.find((database) => database.name === 'system').selectable, false);
  assert.equal(pages[0].databases.find((database) => database.name === 'neo4j').selectable, true);
  assert.equal(pages[0].servers[0].health, 'available');
});

test('supports Community discovery without SHOW SERVERS and refuses Enterprise without topology evidence', async () => {
  const adapter = new Neo4jAdapter();
  const community = await adapter.testConnection({ runNativeCommand: runner({ edition: 'community' }) }, config({ expectedEdition: 'community' }));
  assert.equal(community.status, 'success');
  assert.equal(community.endpointIdentity.serverCount, 1);
  const missingTopology = await adapter.testConnection({ runNativeCommand: async (request) => {
    if (request.executable === 'cypher-shell' && request.args.at(-1).startsWith('SHOW SERVERS')) throw Object.assign(new Error('forbidden'), { exitCode: 1 });
    return runner()(request);
  } }, config({ expectedEdition: 'enterprise' }));
  assert.equal(missingTopology.status, 'failure');
  assert.equal(missingTopology.error.code, 'NEO4J_SERVER_INVENTORY_REQUIRED');
});

test('pins edition, version, deployment, and topology identities', async () => {
  const adapter = new Neo4jAdapter();
  const first = await adapter.testConnection({ runNativeCommand: runner() }, config());
  const pinned = config({
    expectedEdition: first.endpointIdentity.edition,
    expectedVersion: first.endpointIdentity.version,
    expectedDeploymentFingerprint: first.endpointIdentity.deploymentFingerprint,
    expectedTopologyFingerprint: first.endpointIdentity.topologyFingerprint
  });
  assert.equal((await adapter.testConnection({ runNativeCommand: runner() }, pinned)).status, 'success');
  const changed = await adapter.testConnection({ runNativeCommand: runner({ serverId: 'server-b' }) }, pinned);
  assert.equal(changed.status, 'failure');
  assert.equal(changed.error.code, 'NEO4J_DEPLOYMENT_CHANGED');
});

test('advertises offline full and Enterprise online full/differential backup', async () => {
  const adapter = new Neo4jAdapter();
  const manifest = new DatabaseAdapterRegistry([adapter]).manifest(ADAPTER_ID);
  assert.equal(manifest.executionReady, true);
  assert.equal(manifest.sourceEnrollmentReady, true);
  assert.deepEqual(manifest.capabilities.backupModes, ['differential', 'full']);
  assert.deepEqual(manifest.capabilities.consistencyStrategies.map((strategy) => strategy.id), ['offline', 'neo4j-native-backup']);
  assert.equal(manifest.capabilities.streaming.backup, true);
  assert.equal(manifest.capabilities.streaming.restore, true);
  assert.equal(manifest.capabilities.restore.alternateTarget, true);
  assert.equal(manifest.capabilities.restore.originalTarget, false);
  await assert.rejects(adapter.planRestore(), (error) => error.code === 'NEO4J_RESTORE_MODE_UNSUPPORTED');
});

test('normalizes backup-service addresses and parses bounded native inspection evidence', () => {
  assert.deepEqual(normalizeOnlineExecution({ backupAddresses: ['neo-a.example.com:6362', '[2001:db8::1]:6362'] }).backupAddresses, ['[2001:db8::1]:6362', 'neo-a.example.com:6362']);
  assert.throws(() => normalizeOnlineExecution({ backupAddresses: ['neo-a.example.com:6362', 'NEO-A.EXAMPLE.COM:6362'] }), /unique/);
  const inspected = parseOnlineBackupInspection([
    'Database name: neo4j',
    'Database ID: db-neo4j',
    'Backup type: DIFF',
    'Backup time: 2026-08-05T12:00:00.000Z',
    'Lowest transaction ID: 11',
    'Highest transaction ID: 15',
    'Store format: aligned'
  ].join('\n'));
  assert.deepEqual(inspected, { databaseName: 'neo4j', databaseId: 'db-neo4j', backupMode: 'differential', backupTime: '2026-08-05T12:00:00.000Z', lowestTransactionId: 11, highestTransactionId: 15, storeFormat: 'aligned' });
  assert.throws(() => parseOnlineBackupInspection('Database name: neo4j\nDatabase ID: db-neo4j\nBackup type: DIFF\nBackup time: never\nLowest transaction ID: 11\nHighest transaction ID: 15\nStore format: aligned'), (error) => error.code === 'NEO4J_BACKUP_TIME_INVALID');
});

test('refuses Enterprise RBAC-bearing media until its separate system-database mutation can be previewed', async () => {
  const adapter = new Neo4jAdapter();
  await assert.rejects(adapter.planRestore({}, {
    mode: 'alternate', confirmation: 'RESTORE_NEO4J_ALTERNATE', targetDatabase: 'neo4j', connection: config({ expectedEdition: 'enterprise' }),
    source: {
      kind: 'neo4j-enterprise-backup', adapterId: ADAPTER_ID, edition: 'enterprise', productVersion: '2026.06.1', metadataScope: 'database-store-and-rbac',
      deploymentFingerprint: `sha256:${'1'.repeat(64)}`, topologyFingerprint: `sha256:${'2'.repeat(64)}`, database: { name: 'neo4j', databaseId: 'db-neo4j' },
      chain: [{}]
    }
  }), (error) => error.code === 'NEO4J_RESTORE_RBAC_UNSUPPORTED');
});

test('uses the Neo4j 5.26 aggregate-backup command and preserves the materialized source chain', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-neo4j-aggregate-526-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = [Buffer.from('neo4j-full'), Buffer.from('neo4j-diff')];
  const nativeDirectories = new Set();
  const calls = [];
  const execution = {
    async createNativeTemporaryDirectory() {
      const directory = await fs.mkdtemp(path.join(root, 'native-'));
      nativeDirectories.add(directory);
      return directory.replace(/\\/g, '/');
    },
    async writeNativeFile(destination, content) {
      const chunks = [];
      for await (const chunk of content) chunks.push(Buffer.from(chunk));
      await fs.writeFile(destination, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
    },
    async listNativeDirectory(directory) {
      return Promise.all((await fs.readdir(directory)).map(async (name) => ({ name, sizeBytes: (await fs.lstat(path.join(directory, name))).size, path: `${directory}/${name}` })));
    },
    copyNativeFileToLocal: (source, destination) => fs.copyFile(source, destination),
    async removeNativeDirectory(directory) { await fs.rm(directory, { recursive: true, force: true }); nativeDirectories.delete(path.normalize(directory)); nativeDirectories.delete(directory); },
    async runNativeCommand({ executable, args }) {
      calls.push({ executable, args: args.slice() });
      if (args[0] === 'database' && args[1] === 'aggregate-backup') {
        const directory = args.find((item) => item.startsWith('--from-path=')).slice('--from-path='.length);
        assert.equal(args.includes('--keep-old-backup=true'), true);
        assert.deepEqual((await fs.readdir(directory)).sort(), ['neo4j-diff.backup', 'neo4j-full.backup']);
        await fs.writeFile(path.join(directory, 'neo4j-aggregate.backup'), Buffer.from('neo4j-aggregate'), { flag: 'wx', mode: 0o600 });
        return { stdout: 'Aggregation completed\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'database' && args[1] === 'backup') return { stdout: 'Database name: neo4j\nDatabase ID: db-neo4j\nBackup type: FULL\nBackup time: 2026-08-05T12:00:00.000Z\nLowest transaction ID: 1\nHighest transaction ID: 15\nStore format: aligned\n', stderr: '', exitCode: 0 };
      throw new Error(`Unexpected aggregate command: ${args.join(' ')}`);
    }
  };
  const chain = bytes.map((content, index) => ({
    fileName: index ? 'neo4j-diff.backup' : 'neo4j-full.backup', sizeBytes: content.length, contentDigest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    databaseId: 'db-neo4j', backupMode: index ? 'differential' : 'full', storeFormat: 'aligned', highestTransactionId: index ? 15 : 10,
    open: async () => (async function* () { yield content; })()
  }));
  const destination = path.join(root, 'aggregate.backup');
  const media = await new Neo4jAdapter().aggregateOnlineBackupMedia(execution, { connection: config({ expectedEdition: 'enterprise' }), productVersion: '5.26.2', databaseName: 'neo4j', databaseId: 'db-neo4j', totalBytes: bytes.reduce((sum, item) => sum + item.length, 0), chain }, destination);
  assert.equal(media.nativeFileName, 'neo4j-aggregate.backup');
  assert.equal((await fs.readFile(destination, 'utf8')), 'neo4j-aggregate');
  assert.equal(calls.some((call) => call.args[0] === 'backup' && call.args[1] === 'aggregate'), false);
  assert.equal(nativeDirectories.size, 0);
});

test('creates, inspects, authenticates, and cleans an exact stopped-database dump', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-neo4j-adapter-test-'));
  const nativeDirectories = new Set();
  try {
    const adapter = new Neo4jAdapter({ temporaryRoot });
    const registry = new DatabaseAdapterRegistry([adapter]);
    const context = {
      runNativeCommand: runner({ edition: 'community', databaseStatus: 'offline' }),
      createNativeTemporaryDirectory: async () => {
        const directory = await fs.mkdtemp(path.join(temporaryRoot, 'native-'));
        nativeDirectories.add(directory);
        return directory.replace(/\\/g, '/');
      },
      copyNativeFileToLocal: (source, destination) => fs.copyFile(source, destination),
      removeNativeDirectory: async (directory) => {
        assert.equal(nativeDirectories.has(directory.replace(/\//g, path.sep)) || nativeDirectories.has(directory), true);
        await fs.rm(directory, { recursive: true, force: true });
        nativeDirectories.delete(directory.replace(/\//g, path.sep));
        nativeDirectories.delete(directory);
      }
    };
    const prepared = await registry.prepareBackup(ADAPTER_ID, context, {
      connection: config({ expectedEdition: 'community' }),
      selector: { databases: { include: [{ name: 'neo4j' }] } },
      consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full', method: 'offline', captureCoordinates: false }
    });
    assert.equal(prepared.adapterPlan.operation, 'neo4j-offline-dump');
    assert.equal(prepared.consistency.proven, true);
    const destination = path.join(temporaryRoot, 'protected.dump');
    const media = await adapter.createBackupMedia(context, prepared.adapterPlan, destination);
    assert.equal(media.database.name, 'neo4j');
    assert.equal(media.database.databaseId, 'db-neo4j');
    assert.equal(media.metadataScope, 'database-store-only-no-rbac');
    assert.match(media.digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(media.inspectionDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(media.storeFormat, 'aligned');
    assert.equal((await fs.readFile(destination, 'utf8')), 'neo4j-offline-dump');
    assert.equal(nativeDirectories.size, 0);
  } finally { await fs.rm(temporaryRoot, { recursive: true, force: true }); }
});

test('refuses an online database and filtered or incremental selections', async () => {
  const adapter = new Neo4jAdapter();
  const registry = new DatabaseAdapterRegistry([adapter]);
  const request = {
    connection: config({ expectedEdition: 'community' }),
    selector: { databases: { include: [{ name: 'neo4j' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full', method: 'offline', captureCoordinates: false }
  };
  await assert.rejects(registry.prepareBackup(ADAPTER_ID, { runNativeCommand: runner({ edition: 'community', databaseStatus: 'online' }) }, request), (error) => error.code === 'NEO4J_DATABASE_NOT_OFFLINE');
  await assert.rejects(registry.prepareBackup(ADAPTER_ID, { runNativeCommand: runner({ edition: 'community', databaseStatus: 'offline' }) }, { ...request, selector: { databases: { include: [{ name: 'neo4j' }] }, tables: { include: [{ database: 'neo4j', schema: 'neo4j', name: 'orders' }] } } }), (error) => error.code === 'DATABASE_SELECTION_UNSUPPORTED');
  await assert.rejects(registry.prepareBackup(ADAPTER_ID, { runNativeCommand: runner({ edition: 'community', databaseStatus: 'offline' }) }, { ...request, consistency: { ...request.consistency, backupMode: 'incremental' } }), (error) => error.code === 'DATABASE_BACKUP_MODE_UNSUPPORTED');
});

test('creates shell-safe temporary authentication environment content', () => {
  const contents = authEnvironmentContents('backup-user', "pa'ss word", 'neo4j://127.0.0.1:7687');
  assert.match(contents, /^export NEO4J_USERNAME='backup-user'/m);
  assert.match(contents, /export NEO4J_PASSWORD='pa'"'"'ss word'/);
  assert.doesNotMatch(contents, /--password|-p\s/);
  assert.throws(() => authEnvironmentContents('backup', 'line\nbreak', 'neo4j://127.0.0.1:7687'), /line breaks/);
});

test('registers Neo4j discovery, restore, and aggregation through audited main and preload APIs', async () => {
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preloadSource = await fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(mainSource, /Neo4jAdapter/);
  assert.match(mainSource, /new DatabaseAdapterRegistry\(\[[^\]]*neo4jAdapter[^\]]*\]\)/);
  assert.match(mainSource, /Neo4jSourceReaderService/);
  assert.match(mainSource, /Neo4jRestoreService/);
  assert.match(mainSource, /Neo4jAggregationService/);
  assert.match(mainSource, /\[NEO4J_ADAPTER_ID\]: neo4jSourceReader/);
  assert.match(mainSource, /backup:connections:neo4j:create/);
  assert.match(mainSource, /connection\.create-neo4j/);
  assert.match(mainSource, /backup:connections:neo4j:test/);
  assert.match(mainSource, /connection\.test-neo4j/);
  assert.match(mainSource, /backup:connections:neo4j:discover/);
  assert.match(preloadSource, /listBackupNeo4jConnections/);
  assert.match(preloadSource, /createBackupNeo4jConnection/);
  assert.match(preloadSource, /testBackupNeo4jConnection/);
  assert.match(preloadSource, /discoverBackupNeo4jResources/);
  assert.match(preloadSource, /previewBackupNeo4jRestore/);
  assert.match(preloadSource, /startBackupNeo4jRestore/);
  assert.match(preloadSource, /cancelBackupNeo4jRestore/);
  assert.match(mainSource, /backup:neo4j-aggregations:preview/);
  assert.match(mainSource, /backup\.aggregate-neo4j/);
  assert.match(mainSource, /backup:neo4j-aggregations:cancel/);
  assert.match(preloadSource, /previewBackupNeo4jAggregation/);
  assert.match(preloadSource, /startBackupNeo4jAggregation/);
  assert.match(preloadSource, /cancelBackupNeo4jAggregation/);
});

test('streams restore media into an exact owned SSH stage and preserves it after mutation', async () => {
  const ssh = {
    id: 'ssh-neo4j-restore', adapterId: 'deployerx.connection.ssh',
    endpoint: { host: 'neo4j.example.com', port: 22, username: 'backup', authType: 'password', timeoutMs: 30000 },
    secretRefIds: ['ssh-secret'], trust: { fingerprint: `SHA256:${'B'.repeat(43)}` },
    workerAffinity: ['device:neo4j-device'], lastTest: { status: 'success' }
  };
  const controlDatabase = { repository: () => ({ get: async (_workspaceId, id) => id === ssh.id ? ssh : null }) };
  const commands = [];
  const uploads = new Map();
  const session = {
    async run(command) {
      commands.push(command);
      if (command.includes("'mktemp'")) return { stdout: '/tmp/deployerx-neo4j-Restore123\n', stderr: '', exitCode: 0 };
      if (command.includes("'find'")) return { stdout: '.deployerx-owner.json\tf\t100\nrecovered.dump\tf\t13\n', stderr: '', exitCode: 0 };
      throw new Error(`Unexpected SSH command: ${command}`);
    },
    async writeFile(remotePath, content, options) {
      const chunks = [];
      if (content && typeof content[Symbol.asyncIterator] === 'function') for await (const chunk of content) chunks.push(Buffer.from(chunk));
      else chunks.push(Buffer.from(content));
      uploads.set(remotePath, { bytes: Buffer.concat(chunks), options });
    },
    close() { this.closed = true; }
  };
  const connections = new Neo4jConnectionService({ controlDatabase, secretStore: {}, deviceId: 'neo4j-device', sessionFactory: async () => session });
  const connection = {
    endpoint: { expectedEdition: 'community', executionMode: 'ssh', sshConnectionId: ssh.id, address: 'neo4j://127.0.0.1:7687', username: null, neo4jPath: 'neo4j', neo4jAdminPath: 'neo4j-admin', cypherShellPath: 'cypher-shell', timeoutMs: 30000 },
    secretRefIds: []
  };
  await connections.withExecution('local', connection, null, async (execution) => {
    const directory = await execution.createNativeTemporaryDirectory({ ownerType: 'neo4j-restore', ownerId: 'restore-ssh-1' });
    await execution.writeNativeFile(`${directory}/recovered.dump`, (async function* () { yield Buffer.from('neo4j-'); yield Buffer.from('restore'); })());
    assert.deepEqual(await execution.listNativeDirectory(directory), [{ name: 'recovered.dump', sizeBytes: 13, path: `${directory}/recovered.dump` }]);
    await execution.preserveNativeDirectory(directory);
  });
  assert.deepEqual(JSON.parse(uploads.get('/tmp/deployerx-neo4j-Restore123/.deployerx-owner.json').bytes.toString('utf8')), { version: 1, workspaceId: 'local', ownerType: 'neo4j-restore', ownerId: 'restore-ssh-1' });
  assert.equal(uploads.get('/tmp/deployerx-neo4j-Restore123/recovered.dump').bytes.toString('utf8'), 'neo4j-restore');
  assert.equal(commands.some((command) => command.includes("'rm' '-rf'")), false);
  assert.equal(session.closed, true);
});
