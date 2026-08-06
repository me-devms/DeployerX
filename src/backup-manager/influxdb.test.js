const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  InfluxDbConnectionService,
  InfluxDbOssV2Adapter,
  MAX_BACKUP_TIMEOUT_MS,
  MAX_RESTORE_TIMEOUT_MS,
  RESTORE_CONFIRMATION,
  authorizationHeader,
  inspectBackupDirectory,
  nativeEnvironment,
  normalizeBackupExecution,
  normalizeBuckets,
  normalizeConfig,
  normalizeOrganizations,
  parseCliVersion,
  parseVersion,
  safeApiPath
} = require('./influxdb');

const TOKEN = 'influx-secret-token';
const ORG_ID = '0123456789abcdef';
const BUCKET_ID = 'fedcba9876543210';
const SYSTEM_BUCKET_ID = '1111111111111111';
const SECRET_REF_ID = 'sec_influx_token';
const CONNECTION = {
  host: 'influx.example.com',
  tokenSecretRefId: SECRET_REF_ID,
  cliPath: 'influx'
};

function inventoryTransport(overrides = {}, observations = []) {
  return async ({ config, apiPath, query, authorization }) => {
    observations.push({ config, apiPath, query, authorization });
    if (authorization !== `Token ${TOKEN}`) throw new Error('Unexpected authorization value.');
    if (apiPath === '/health') return { statusCode: 200, body: overrides.health || { name: 'influxdb', status: 'pass', version: '2.7.11' } };
    if (apiPath === '/api/v2/orgs') return { statusCode: 200, body: { orgs: overrides.organizations || [{ id: ORG_ID, name: 'Production', status: 'active' }] } };
    if (apiPath === '/api/v2/buckets') return {
      statusCode: 200,
      body: {
        buckets: overrides.buckets || [
          { id: BUCKET_ID, orgID: ORG_ID, name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: 86400, shardGroupDurationSeconds: 3600 }] },
          { id: SYSTEM_BUCKET_ID, orgID: ORG_ID, name: '_monitoring', type: 'system', retentionRules: [] }
        ]
      }
    };
    throw new Error(`Unexpected InfluxDB API path: ${apiPath}`);
  };
}

function adapterFixture(overrides = {}, observations = []) {
  return new InfluxDbOssV2Adapter({
    transport: inventoryTransport(overrides, observations),
    commandRunner: async ({ executable, args }) => {
      assert.equal(executable, 'influx');
      assert.deepEqual(args, ['version']);
      return { stdout: overrides.cliOutput || 'Influx CLI 2.7.5 (git: abc123) build_date: 2026-01-01', stderr: '', exitCode: 0 };
    },
    clock: () => '2026-08-05T12:00:00.000Z',
    now: (() => { let value = 1000; return () => value += 5; })()
  });
}

function context(resolve = () => TOKEN) {
  return { resolveSecret: async (id) => {
    assert.equal(id, SECRET_REF_ID);
    return resolve();
  } };
}

test('normalizes HTTPS by default and requires explicit approval for plaintext HTTP', () => {
  assert.deepEqual(normalizeConfig(CONNECTION), {
    protocol: 'https', allowInsecureHttp: false, host: 'influx.example.com', port: 8086, basePath: '', tokenSecretRefId: SECRET_REF_ID, caFile: null,
    cliPath: 'influx', timeoutMs: 30000, expectedVersion: null, expectedCliVersion: null, expectedDeploymentFingerprint: null
  });
  assert.equal(normalizeConfig({ ...CONNECTION, protocol: 'http', allowInsecureHttp: true, basePath: '/influx/v2' }).basePath, '/influx/v2');
  assert.throws(() => normalizeConfig({ ...CONNECTION, protocol: 'http' }), /explicit insecure-transport approval/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, allowInsecureHttp: true }), /valid only for HTTP/);
});

test('rejects unsafe endpoint, executable, token, and API path inputs', () => {
  assert.throws(() => normalizeConfig({ ...CONNECTION, host: 'https://influx.example.com' }), /without a URI scheme/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, basePath: '/../admin' }), /base path is invalid/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, cliPath: 'influx --host evil' }), /absolute path or executable name/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, token: TOKEN }), /Unknown InfluxDB connection field/);
  assert.throws(() => authorizationHeader('secret\r\nInjected: yes'), (error) => error.code === 'INFLUXDB_TOKEN_INVALID');
  assert.throws(() => safeApiPath(normalizeConfig(CONNECTION), '/../private'), /API path is invalid/);
});

test('parses only supported OSS v2 server and CLI semantic versions', () => {
  assert.deepEqual(parseVersion('v2.7.11'), { text: '2.7.11', major: 2, minor: 7, patch: 11 });
  assert.deepEqual(parseCliVersion('Influx CLI 2.7.5 (git: abc123)'), { text: '2.7.5', major: 2, minor: 7, patch: 5 });
  assert.throws(() => parseVersion('3.0.0'), (error) => error.code === 'INFLUXDB_VERSION_UNSUPPORTED');
  assert.throws(() => parseCliVersion('influx version latest'), (error) => error.code === 'INFLUXDB_CLI_VERSION_INVALID');
});

test('normalizes organizations, buckets, retention rules, and excludes system scope', () => {
  const organizations = normalizeOrganizations([{ id: ORG_ID.toUpperCase(), name: 'Production', status: 'active' }]);
  const buckets = normalizeBuckets([
    { id: BUCKET_ID, orgID: ORG_ID, name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: '86400', shardGroupDurationSeconds: 3600 }] },
    { id: SYSTEM_BUCKET_ID, orgID: ORG_ID, name: '_monitoring', type: 'system', retentionRules: [] }
  ], new Set([ORG_ID]));
  assert.equal(organizations[0].selectable, true);
  assert.equal(buckets.find((item) => item.id === BUCKET_ID).retentionRules[0].everySeconds, 86400);
  assert.equal(buckets.find((item) => item.id === BUCKET_ID).selectable, true);
  assert.equal(buckets.find((item) => item.id === SYSTEM_BUCKET_ID).selectable, false);
  assert.throws(() => normalizeBuckets([{ id: BUCKET_ID, orgID: '2222222222222222', name: 'orphan', type: 'user' }], new Set([ORG_ID])), (error) => error.code === 'INFLUXDB_BUCKETS_INVALID');
});

test('performs bounded paginated organization discovery', async () => {
  const offsets = [];
  const organizations = Array.from({ length: 101 }, (_, index) => ({ id: index.toString(16).padStart(16, '0'), name: `org-${index}`, status: 'active' }));
  const adapter = new InfluxDbOssV2Adapter({
    transport: async ({ apiPath, query, authorization }) => {
      assert.equal(authorization, `Token ${TOKEN}`);
      if (apiPath === '/health') return { body: { name: 'influxdb', status: 'pass', version: '2.7.11' } };
      if (apiPath === '/api/v2/orgs') {
        const offset = Number(query.offset);
        offsets.push(offset);
        return { body: { orgs: organizations.slice(offset, offset + 100), total: organizations.length } };
      }
      if (apiPath === '/api/v2/buckets') return { body: { buckets: [], total: 0 } };
      throw new Error('Unexpected path.');
    },
    commandRunner: async () => ({ stdout: 'Influx CLI 2.7.5', stderr: '', exitCode: 0 })
  });
  const identity = await adapter.readIdentity(context(), CONNECTION);
  assert.equal(identity.organizations.length, 101);
  assert.deepEqual(offsets, [0, 100]);
});

test('authenticates healthy OSS v2 discovery without exposing token material', async () => {
  const observations = [];
  const adapter = adapterFixture({}, observations);
  const result = await adapter.testConnection(context(), CONNECTION);
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.product, 'influxdb-oss-v2');
  assert.equal(result.endpointIdentity.userBucketCount, 1);
  assert.equal(result.endpointIdentity.recoveryBoundary, 'hash-only-plaintext-unrecoverable');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(observations.length, 3);
  const pages = [];
  for await (const page of adapter.discover(context(), { connection: CONNECTION, kind: 'all' })) pages.push(page);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].organizations.length, 1);
  assert.equal(pages[0].buckets.length, 2);
  assert.deepEqual(pages[0].capabilities, { nativeBackupAvailable: true, nativeRestoreAvailable: true, plaintextTokenRecovery: false });
});

test('fails closed for malformed identity and non-v2 products', async () => {
  const malformed = adapterFixture({ health: { name: 'other-product', status: 'pass', version: '2.7.11' } });
  assert.equal((await malformed.testConnection(context(), CONNECTION)).error.code, 'INFLUXDB_HEALTH_INVALID');
  const nonV2 = adapterFixture({ health: { name: 'influxdb', status: 'pass', version: '3.0.0' } });
  assert.equal((await nonV2.testConnection(context(), CONNECTION)).error.code, 'INFLUXDB_VERSION_UNSUPPORTED');
});

test('pins server, CLI, and deployment identity against drift', async () => {
  const adapter = adapterFixture();
  const identity = await adapter.readIdentity(context(), CONNECTION);
  await adapter.readIdentity(context(), { ...CONNECTION, expectedVersion: identity.version.text, expectedCliVersion: identity.cliVersion.text, expectedDeploymentFingerprint: identity.deploymentFingerprint });
  await assert.rejects(adapter.readIdentity(context(), { ...CONNECTION, expectedVersion: '2.7.10' }), (error) => error.code === 'INFLUXDB_VERSION_CHANGED');
  await assert.rejects(adapter.readIdentity(context(), { ...CONNECTION, expectedCliVersion: '2.7.4' }), (error) => error.code === 'INFLUXDB_CLI_VERSION_CHANGED');
  await assert.rejects(adapter.readIdentity(context(), { ...CONNECTION, expectedDeploymentFingerprint: `sha256:${'0'.repeat(64)}` }), (error) => error.code === 'INFLUXDB_DEPLOYMENT_CHANGED');
});

test('registers native full backup and exact-version alternate-instance restore', () => {
  const adapter = adapterFixture();
  const manifest = new DatabaseAdapterRegistry([adapter]).manifest(ADAPTER_ID);
  assert.equal(manifest.executionReady, true);
  assert.equal(manifest.sourceEnrollmentReady, true);
  assert.deepEqual(manifest.requiredTools[0].operations, ['backup', 'discovery', 'restore']);
  assert.equal(manifest.capabilities.streaming.backup, true);
  assert.equal(manifest.capabilities.restore.alternateTarget, true);
  assert.equal(manifest.capabilities.restore.originalTarget, false);
});

test('restores authenticated native media to a distinct exact-version target and validates retention identity', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb-restore-adapter-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const targetOrgId = 'aaaaaaaaaaaaaaaa';
  const targetBucketId = 'bbbbbbbbbbbbbbbb';
  let restored = false;
  const commands = [];
  const targetTransport = async ({ apiPath, authorization }) => {
    assert.equal(authorization, `Token ${TOKEN}`);
    if (apiPath === '/health') return { body: { name: 'influxdb', status: 'pass', version: '2.7.11' } };
    if (apiPath === '/api/v2/orgs') return { body: { orgs: restored ? [{ id: ORG_ID, name: 'Production', status: 'active' }] : [{ id: targetOrgId, name: 'Empty target', status: 'active' }], total: 1 } };
    if (apiPath === '/api/v2/buckets') return { body: { buckets: restored ? [{ id: BUCKET_ID, orgID: ORG_ID, name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: 86400, shardGroupDurationSeconds: 3600 }] }] : [{ id: targetBucketId, orgID: targetOrgId, name: 'target-system', type: 'system', retentionRules: [] }], total: 1 } };
    throw new Error(`Unexpected API path: ${apiPath}`);
  };
  const adapter = new InfluxDbOssV2Adapter({
    transport: targetTransport,
    commandRunner: async (input) => {
      commands.push({ args: [...input.args], env: input.env, timeoutMs: input.timeoutMs });
      if (input.args[0] === 'version') return { stdout: 'Influx CLI 2.7.5', stderr: '', exitCode: 0 };
      assert.equal(input.args[0], 'restore'); restored = true; return { stdout: '', stderr: '', exitCode: 0 };
    }
  });
  const targetConnection = { ...CONNECTION, host: 'alternate.example.com' };
  const initial = await adapter.readIdentity(context(), targetConnection);
  const config = { ...targetConnection, expectedVersion: initial.version.text, expectedCliVersion: initial.cliVersion.text, expectedDeploymentFingerprint: initial.deploymentFingerprint };
  const native = path.join(root, 'native');
  await fsp.mkdir(native);
  await fsp.writeFile(path.join(native, 'backup.manifest'), 'manifest');
  await fsp.writeFile(path.join(native, 'bucket.tar.gz'), 'native-bucket');
  const media = await inspectBackupDirectory(native);
  const source = {
    product: 'influxdb-oss-v2', productVersion: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: `sha256:${'f'.repeat(64)}`,
    scope: { type: 'bucket', organizationId: ORG_ID, organizationName: 'Production', bucketId: BUCKET_ID, bucketName: 'metrics', buckets: [{ id: BUCKET_ID, name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: 86400, shardGroupDurationSeconds: 3600 }] }] },
    nativeMedia: { fileCount: media.fileCount, totalBytes: media.totalBytes, mediaFingerprint: media.mediaFingerprint }
  };
  const plan = await adapter.planRestore(context(), { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection: config, source });
  assert.deepEqual(plan.args, ['restore', '--host', 'https://alternate.example.com:8086', '--bucket-id', BUCKET_ID]);
  const execution = await adapter.executeRestore({ ...context(), sourceDirectory: native, onMutationStarted: async () => {}, signal: undefined }, plan);
  const validation = await adapter.validateRestore(context(), execution);
  assert.equal(validation.valid, true);
  assert.equal(validation.organization.id, ORG_ID);
  assert.equal(validation.buckets[0].retentionRules[0].everySeconds, 86400);
  const restoreCommand = commands.find((command) => command.args[0] === 'restore');
  assert.equal(restoreCommand.timeoutMs, MAX_RESTORE_TIMEOUT_MS);
  assert.equal(restoreCommand.env.INFLUX_TOKEN, TOKEN);
  assert.equal(restoreCommand.args.some((argument) => String(argument).includes(TOKEN)), false);
  await assert.rejects(adapter.planRestore(context(), { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection: { ...config, expectedDeploymentFingerprint: null }, source: { ...source, deploymentFingerprint: execution.discovery.deploymentFingerprint } }), (error) => error.code === 'INFLUXDB_RESTORE_SOURCE_TARGET_COLLISION');
});

test('plans and authenticates one exact native bucket backup without token arguments', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb-adapter-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const commands = [];
  const adapter = new InfluxDbOssV2Adapter({
    transport: inventoryTransport(),
    commandRunner: async (input) => {
      commands.push({ executable: input.executable, args: [...input.args], env: input.env, timeoutMs: input.timeoutMs });
      if (input.args[0] === 'version') return { stdout: 'Influx CLI 2.7.5', stderr: '', exitCode: 0 };
      assert.equal(input.args[0], 'backup');
      const destination = input.args.at(-1);
      await fsp.mkdir(destination);
      await fsp.writeFile(path.join(destination, '20260805T120000Z.manifest'), '{"version":1}');
      await fsp.writeFile(path.join(destination, '20260805T120000Z.0123456789abcdef.tar.gz'), 'native-bucket-bytes');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    clock: () => '2026-08-05T12:00:00.000Z'
  });
  const identity = await adapter.readIdentity(context(), CONNECTION);
  const connection = { ...CONNECTION, expectedVersion: identity.version.text, expectedCliVersion: identity.cliVersion.text, expectedDeploymentFingerprint: identity.deploymentFingerprint };
  const execution = normalizeBackupExecution({ engine: 'influxdb', scope: 'bucket', organizationId: ORG_ID, organizationName: 'Production', bucketId: BUCKET_ID, bucketName: 'metrics', deploymentFingerprint: identity.deploymentFingerprint, inventoryFingerprint: identity.inventoryFingerprint, connectionRevision: 2 });
  const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), {
    connection,
    selector: { databases: { include: [{ name: 'Production' }] }, tables: { include: [{ database: 'Production', schema: 'Production', name: 'metrics' }] } },
    consistency: { requestedLevel: 'application', method: 'influxdb-v2-native-backup', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true },
    execution
  });
  assert.deepEqual(prepared.adapterPlan.args, ['backup', '--host', 'https://influx.example.com:8086', '--org-id', ORG_ID, '--bucket-id', BUCKET_ID]);
  assert.equal(JSON.stringify(prepared).includes(TOKEN), false);
  const destination = path.join(root, 'native');
  const media = await adapter.createBackupMedia(context(), prepared.adapterPlan, destination);
  assert.equal(media.fileCount, 2);
  assert.equal(media.selection.bucketId, BUCKET_ID);
  assert.match(media.mediaFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(media.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.contentDigest)), true);
  const backupCommand = commands.find((command) => command.args[0] === 'backup');
  assert.equal(backupCommand.timeoutMs, MAX_BACKUP_TIMEOUT_MS);
  assert.equal(backupCommand.env.INFLUX_TOKEN, TOKEN);
  assert.equal(backupCommand.args.some((argument) => String(argument).includes(TOKEN)), false);
  assert.deepEqual(nativeEnvironment(TOKEN).INFLUX_TOKEN, TOKEN);
});

test('rejects incomplete native output and removes only the owned destination', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb-invalid-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const adapter = new InfluxDbOssV2Adapter({
    transport: inventoryTransport(),
    commandRunner: async (input) => {
      if (input.args[0] === 'version') return { stdout: 'Influx CLI 2.7.5', stderr: '', exitCode: 0 };
      await fsp.mkdir(input.args.at(-1));
      await fsp.writeFile(path.join(input.args.at(-1), 'bucket.tar.gz'), 'incomplete');
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  });
  const identity = await adapter.readIdentity(context(), CONNECTION);
  const execution = normalizeBackupExecution({ engine: 'influxdb', scope: 'organization', organizationId: ORG_ID, organizationName: 'Production', deploymentFingerprint: identity.deploymentFingerprint, inventoryFingerprint: identity.inventoryFingerprint, connectionRevision: 1 });
  const config = { ...CONNECTION, expectedVersion: identity.version.text, expectedCliVersion: identity.cliVersion.text, expectedDeploymentFingerprint: identity.deploymentFingerprint };
  const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), { connection: config, selector: { databases: { include: [{ name: 'Production' }] } }, consistency: { requestedLevel: 'application', method: 'influxdb-v2-native-backup', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true }, execution });
  const destination = path.join(root, 'owned-native');
  await assert.rejects(adapter.createBackupMedia(context(), prepared.adapterPlan, destination), (error) => error.code === 'INFLUXDB_BACKUP_MANIFEST_INVALID');
  assert.equal(await fsp.lstat(destination).then(() => true, () => false), false);
  await fsp.mkdir(path.join(root, 'direct'));
  await fsp.writeFile(path.join(root, 'direct', 'one.manifest'), 'manifest');
  assert.equal((await inspectBackupDirectory(path.join(root, 'direct'))).fileCount, 1);
});

function serviceFixture() {
  const connections = new Map();
  const secretRefs = new Map();
  const secrets = new Map();
  let resolveCount = 0;
  const connectionRepository = {
    list: async () => [...connections.values()],
    get: async (_workspaceId, id) => connections.get(id) || null,
    update: async (_workspaceId, id, patch, options) => {
      const current = connections.get(id);
      assert.equal(options.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      connections.set(id, updated);
      return updated;
    }
  };
  const secretRepository = {
    get: async (_workspaceId, id) => secretRefs.get(id) || null,
    update: async (_workspaceId, id, patch, options) => {
      const current = secretRefs.get(id);
      assert.equal(options.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      secretRefs.set(id, updated);
      return updated;
    }
  };
  const controlDatabase = {
    repository: (name) => name === 'connection' ? connectionRepository : secretRepository,
    transaction: async (callback) => callback({
      create: (name, input) => {
        if (name === 'secretRef') {
          const record = { ...input, revision: 1 };
          secretRefs.set(record.id, record);
          return record;
        }
        const record = { ...input, id: 'connection-influx', revision: 1 };
        connections.set(record.id, record);
        return record;
      }
    })
  };
  const secretStore = {
    create: async (input) => {
      secrets.set(SECRET_REF_ID, input.value);
      return { id: SECRET_REF_ID, workspaceId: input.workspaceId, name: input.name, provider: 'electron-safe-storage', scope: input.scope, providerKey: SECRET_REF_ID, secretType: input.secretType, version: 1 };
    },
    resolve: async ({ id }) => {
      resolveCount += 1;
      return secrets.get(id);
    },
    markValidated: async () => ({ lastValidatedAt: '2026-08-05T12:00:00.000Z' }),
    delete: async ({ id }) => secrets.delete(id)
  };
  return { connections, secretRefs, secrets, controlDatabase, secretStore, resolveCount: () => resolveCount };
}

test('persists only a device-scoped token SecretRef and repeats authenticated inventory before discovery', async () => {
  const fixture = serviceFixture();
  const observations = [];
  const service = new InfluxDbConnectionService({ ...fixture, deviceId: 'device-a', adapter: adapterFixture({}, observations) });
  const created = await service.create('workspace-a', 'actor-a', { name: 'Production InfluxDB', host: 'influx.example.com', token: TOKEN, cliPath: 'influx' });
  assert.deepEqual(created.secretRefIds, [SECRET_REF_ID]);
  assert.deepEqual(created.workerAffinity, ['device:device-a']);
  assert.equal(created.endpoint.token, undefined);
  assert.equal(JSON.stringify(created).includes(TOKEN), false);
  assert.equal(fixture.secretRefs.get(SECRET_REF_ID).scope, 'device');
  await assert.rejects(service.discover('workspace-a', created.id), /Test the InfluxDB connection successfully/);
  const tested = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.influxdbInventory.organizations.length, 1);
  assert.equal(tested.connection.influxdbInventory.buckets.length, 2);
  assert.match(tested.connection.endpoint.expectedDeploymentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(fixture.resolveCount(), 2);
  assert.equal(observations.length, 6);
  const discovered = await service.discover('workspace-a', created.id, { kind: 'buckets' });
  assert.equal(discovered.items.length, 2);
  assert.equal(fixture.resolveCount(), 3);
  assert.equal(JSON.stringify([...fixture.connections.values()]).includes(TOKEN), false);
});

test('registers audited InfluxDB desktop connection APIs', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(main, /InfluxDbOssV2Adapter/);
  assert.match(main, /new DatabaseAdapterRegistry\(\[[^\]]*influxDbAdapter[^\]]*\]\)/);
  for (const channel of ['backup:connections:influxdb:list', 'backup:connections:influxdb:create', 'backup:connections:influxdb:test', 'backup:connections:influxdb:discover']) {
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const channel of ['backup:influxdb-restores:preview', 'backup:influxdb-restores:list', 'backup:influxdb-restores:start', 'backup:influxdb-restores:wait', 'backup:influxdb-restores:cancel']) {
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const channel of ['backup:influxdb-verifications:list', 'backup:influxdb-verifications:start', 'backup:influxdb-verifications:wait', 'backup:influxdb-verifications:cancel']) {
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(main, /connection\.create-influxdb/);
  assert.match(main, /connection\.test-influxdb/);
  assert.match(main, /InfluxDbSourceReaderService/);
  assert.match(main, /InfluxDbRestoreService/);
  assert.match(main, /InfluxDbRecoveryTestService/);
  assert.match(main, /restore\.start-influxdb-alternate/);
  assert.match(main, /restore\.cancel-influxdb/);
  assert.match(main, /verification\.start-influxdb/);
  assert.match(main, /verification\.cancel-influxdb/);
  assert.match(main, /\[INFLUXDB_ADAPTER_ID\]: influxDbSourceReader/);
  assert.match(preload, /listBackupInfluxDbConnections/);
  assert.match(preload, /discoverBackupInfluxDbResources/);
});
