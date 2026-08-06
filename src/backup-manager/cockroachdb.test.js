const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ADAPTER_ID,
  BACKUP_DESTINATION_CONFIRMATION,
  CockroachDbAdapter,
  CockroachDbConnectionService,
  QUERIES,
  normalizeBackupDestination,
  normalizeConfig,
  parseClusterVersion,
  parseTsv,
  parseVersion,
  passwordEnvironmentContents,
  readDiscovery,
  sqlUrl
} = require('./cockroachdb');

const PASSWORD = "correct horse battery staple ' 2026";
const SECRET_REF_ID = 'sec_cockroach_password';
const CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION = {
  executionMode: 'local',
  authMode: 'password',
  host: 'roach.example.com',
  port: 26257,
  username: 'backup_user',
  database: 'defaultdb',
  passwordSecretRefId: SECRET_REF_ID,
  sqlPath: 'cockroach'
};

function tsv(headers, rows = []) {
  return [headers.join('\t'), ...rows.map((row) => row.map((value) => String(value)).join('\t'))].join('\n') + '\n';
}

function discoveryOutputs(overrides = {}) {
  return {
    [QUERIES.identity]: tsv(['version', 'cluster_id', 'node_id', 'current_user', 'current_database'], [[
      'CockroachDB CCL v25.2.3 (x86_64-pc-linux-gnu, built 2026/07/10)', CLUSTER_ID, 1, 'backup_user', 'defaultdb'
    ]]),
    [QUERIES.clusterVersion]: tsv(['version'], [['25.2']]),
    [QUERIES.nodes]: tsv(['node_id', 'address', 'sql_address', 'build_tag', 'started_at', 'locality', 'is_available', 'is_live'], [
      [1, 'roach-a:26257', 'roach-a:26257', 'v25.2.3', '2026-08-05T01:00:00.000Z', 'region=us-east1,zone=a', true, true],
      [2, 'roach-b:26257', 'roach-b:26257', 'v25.2.3', '2026-08-05T01:00:01.000Z', 'region=us-east1,zone=b', true, true]
    ]),
    [QUERIES.databases]: tsv(['database_name', 'owner'], [
      ['app', 'app_owner'],
      ['defaultdb', 'root'],
      ['system', 'node']
    ]),
    [QUERIES.systemPrivileges]: tsv(['backup', 'restore', 'viewjob', 'controljob', 'externalioimplicitaccess'], [[true, true, true, true, false]]),
    [QUERIES.jobs]: tsv(['visible_job_count'], [[4]]),
    [QUERIES.externalConnections]: tsv(['connection_name', 'owner'], [['backup_archive', 'backup_user']]),
    ...overrides
  };
}

function runner(resultMap, observations = []) {
  return async (request) => {
    const query = request.args.at(-1);
    observations.push({ ...request, args: [...request.args], query, env: request.env ? { ...request.env } : undefined });
    if (!(query in resultMap)) throw new Error(`Unexpected CockroachDB query: ${query}`);
    const result = resultMap[query];
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: '', exitCode: 0 };
  };
}

test('normalizes strict password, client-certificate, and explicitly insecure connection modes', () => {
  assert.deepEqual(normalizeConfig(CONNECTION), {
    ...CONNECTION,
    sshConnectionId: null,
    allowInsecure: false,
    caFile: null,
    certsDir: null,
    timeoutMs: 30000,
    expectedVersion: null,
    expectedClusterVersion: null,
    expectedClusterId: null,
    expectedDeploymentFingerprint: null,
    expectedTopologyFingerprint: null,
    expectedInventoryFingerprint: null
  });
  const certificates = normalizeConfig({
    executionMode: 'ssh', sshConnectionId: 'ssh-a', authMode: 'client-certificate', host: '10.0.0.5',
    username: 'backup_user', database: 'app', certsDir: '/etc/cockroach/certs', sqlPath: '/usr/local/bin/cockroach'
  });
  assert.equal(certificates.passwordSecretRefId, null);
  assert.match(sqlUrl(certificates), /sslcert=%2Fetc%2Fcockroach%2Fcerts%2Fclient.backup_user.crt/);
  const insecure = normalizeConfig({ executionMode: 'local', authMode: 'insecure', allowInsecure: true, host: '127.0.0.1' });
  assert.match(sqlUrl(insecure), /sslmode=disable/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, password: PASSWORD }), /Unknown CockroachDB connection field/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, passwordSecretRefId: null }), /requires a password SecretRef/);
  assert.throws(() => normalizeConfig({ executionMode: 'local', authMode: 'insecure' }), /requires explicit approval/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, host: 'postgresql://roach.example.com' }), /without a URI scheme/);
  assert.throws(() => normalizeConfig({ ...CONNECTION, sqlPath: 'cockroach --insecure' }), /absolute path or executable name/);
  assert.throws(() => normalizeConfig({ executionMode: 'ssh', sshConnectionId: 'ssh-a', authMode: 'client-certificate', certsDir: 'relative/certs' }), /absolute POSIX path/);
});

test('builds password-free SQL URLs and quotes SSH password environments safely', () => {
  const url = sqlUrl({ ...CONNECTION, caFile: 'C:\\Cockroach\\ca.crt' });
  assert.equal(url.includes(PASSWORD), false);
  assert.match(url, /^postgresql:\/\/backup_user@roach\.example\.com:26257\/defaultdb\?/);
  assert.match(url, /sslmode=verify-full/);
  assert.match(url, /sslrootcert=C%3A%5CCockroach%5Cca.crt/);
  const environment = passwordEnvironmentContents(PASSWORD);
  assert.equal(environment, "export PGPASSWORD='correct horse battery staple '" + '"\'"' + "' 2026'\n");
  assert.throws(() => passwordEnvironmentContents('line-one\nline-two'), /password is invalid/);
});

test('parses only supported CockroachDB server and active cluster versions', () => {
  assert.deepEqual(parseVersion('CockroachDB CCL v25.2.3 (linux)'), { text: '25.2.3', major: 25, minor: 2, patch: 3, prerelease: null, distribution: 'ccl' });
  assert.deepEqual(parseClusterVersion('v26.2'), { text: '26.2', major: 26, minor: 2, patch: null, prerelease: null });
  assert.throws(() => parseVersion('PostgreSQL 17.4'), (error) => error.code === 'COCKROACH_PRODUCT_INVALID');
  assert.throws(() => parseVersion('CockroachDB CCL v24.2.9'), (error) => error.code === 'COCKROACH_VERSION_UNSUPPORTED');
  assert.throws(() => parseClusterVersion('latest'), (error) => error.code === 'COCKROACH_VERSION_INVALID');
});

test('parses bounded strict TSV output including zero-row result sets', () => {
  assert.deepEqual(parseTsv('name\towner\napp\troot\n', 'test'), [{ name: 'app', owner: 'root' }]);
  assert.deepEqual(parseTsv('name\towner\n', 'test'), []);
  assert.throws(() => parseTsv('name\tname\n', 'test'), (error) => error.code === 'COCKROACH_OUTPUT_INVALID');
  assert.throws(() => parseTsv('name\towner\napp\n', 'test'), (error) => error.code === 'COCKROACH_OUTPUT_INVALID');
  assert.throws(() => parseTsv(`name\n${'row\n'.repeat(10001)}`, 'test'), (error) => error.code === 'COCKROACH_ROW_LIMIT');
});

test('discovers exact cluster, node, database, privilege, job, and external-connection evidence', async () => {
  const observations = [];
  const discovered = await readDiscovery({ runNativeCommand: runner(discoveryOutputs(), observations) }, CONNECTION);
  assert.equal(discovered.version.text, '25.2.3');
  assert.equal(discovered.version.distribution, 'ccl');
  assert.equal(discovered.clusterVersion.text, '25.2');
  assert.equal(discovered.clusterId, CLUSTER_ID);
  assert.equal(discovered.currentNodeId, 1);
  assert.equal(discovered.nodes.length, 2);
  assert.equal(discovered.nodes[1].locality, 'region=us-east1,zone=b');
  assert.equal(discovered.databases.find((database) => database.name === 'system').selectable, false);
  assert.deepEqual(discovered.externalConnections, [{ name: 'backup_archive', owner: 'backup_user' }]);
  assert.equal(discovered.capabilities.systemPrivileges.BACKUP, true);
  assert.equal(discovered.capabilities.systemPrivileges.EXTERNALIOIMPLICITACCESS, false);
  assert.equal(discovered.capabilities.perObjectPrivilegeProofComplete, false);
  assert.equal(discovered.capabilities.externalConnectionsChecked, false);
  assert.equal(discovered.capabilities.executionReady, false);
  assert.equal(discovered.capabilities.normalIncrementalChainLimit, 48);
  assert.equal(discovered.capabilities.minimumIncrementalCadenceSeconds, 300);
  assert.equal(discovered.capabilities.backupCompactionVersionEligible, false);
  assert.match(discovered.deploymentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(discovered.topologyFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(discovered.inventoryFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(observations.length, Object.keys(QUERIES).length);
  assert.equal(observations.every((item) => item.executable === 'cockroach' && item.args[0] === 'sql' && item.args[2] === '--format=tsv' && item.args[3] === '--execute'), true);
  assert.equal(observations.some((item) => item.args.join(' ').includes(PASSWORD)), false);
});

test('returns bounded diagnostics and advertises only the implemented native backup tier', async () => {
  const adapter = new CockroachDbAdapter({ clock: () => '2026-08-05T12:00:00.000Z', now: (() => { let value = 1000; return () => value += 5; })() });
  const context = { runNativeCommand: runner(discoveryOutputs()) };
  const result = await adapter.testConnection(context, CONNECTION);
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.product, 'cockroachdb');
  assert.equal(result.endpointIdentity.clusterId, CLUSTER_ID);
  assert.equal(result.endpointIdentity.nodeCount, 2);
  assert.equal(result.endpointIdentity.executionReady, false);
  assert.equal(result.checks.find((check) => check.id === 'backup-restore-privileges').status, 'pass');
  const pages = [];
  for await (const page of adapter.discover(context, { connection: CONNECTION, kind: 'all' })) pages.push(page);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].nodes.length, 2);
  assert.equal(pages[0].databases.length, 3);
  assert.equal(pages[0].capabilities.executionReady, false);
  const manifest = adapter.manifest();
  assert.equal(manifest.adapterId, ADAPTER_ID);
  assert.equal(manifest.executionReady, true);
  assert.equal(manifest.sourceEnrollmentReady, true);
  assert.deepEqual(manifest.capabilities.backupModes, ['full', 'incremental']);
  assert.equal(manifest.capabilities.streaming.encryption, false);
  assert.equal(manifest.capabilities.restore.alternateTarget, true);
  assert.equal(manifest.capabilities.restore.nativeValidation, true);
  assert.equal(manifest.capabilities.restore.originalTarget, false);
  assert.equal(manifest.capabilities.restore.offlineBundle, false);
  const calls = [];
  const delegated = new CockroachDbAdapter({
    nativeBackupController: {
      preflight: async (...args) => { calls.push(['preflight', ...args]); return 'preflight'; },
      planBackup: async (...args) => { calls.push(['planBackup', ...args]); return 'plan'; },
      executeBackup: async (...args) => { calls.push(['executeBackup', ...args]); return 'result'; }
    },
    nativeRestoreController: {
      planRestore: async (...args) => { calls.push(['planRestore', ...args]); return 'restore-plan'; },
      executeRestore: async (...args) => { calls.push(['executeRestore', ...args]); return 'restore-result'; },
      validateRestore: async (...args) => { calls.push(['validateRestore', ...args]); return 'restore-validation'; }
    }
  });
  assert.equal(await delegated.preflight('context', 'request'), 'preflight');
  assert.equal(await delegated.planBackup('context', 'request'), 'plan');
  assert.equal(await delegated.executeBackup('context', 'plan'), 'result');
  assert.equal(await delegated.planRestore('context', 'request'), 'restore-plan');
  assert.equal(await delegated.executeRestore('context', 'restore-plan'), 'restore-result');
  assert.equal(await delegated.validateRestore('context', 'restore-result'), 'restore-validation');
  assert.deepEqual(calls.map(([operation]) => operation), ['preflight', 'planBackup', 'executeBackup', 'planRestore', 'executeRestore', 'validateRestore']);
});

test('keeps optional privilege, job, and external-storage evidence unavailable instead of inferring readiness', async () => {
  const unavailable = discoveryOutputs({
    [QUERIES.systemPrivileges]: new Error(`denied ${PASSWORD}`),
    [QUERIES.jobs]: new Error('denied'),
    [QUERIES.externalConnections]: new Error('denied')
  });
  const adapter = new CockroachDbAdapter();
  const discovered = await readDiscovery({ runNativeCommand: runner(unavailable) }, CONNECTION);
  assert.equal(discovered.privileges.visible, false);
  assert.equal(discovered.capabilities.systemPrivileges.BACKUP, null);
  assert.equal(discovered.capabilities.jobsVisible, false);
  assert.equal(discovered.capabilities.externalConnectionsVisible, false);
  assert.equal(discovered.capabilities.executionReady, false);
  const result = await adapter.testConnection({ runNativeCommand: runner(unavailable) }, CONNECTION);
  assert.equal(result.status, 'success');
  assert.equal(result.checks.find((check) => check.id === 'backup-restore-privileges').status, 'warning');
  assert.equal(JSON.stringify(result).includes(PASSWORD), false);
});

test('fails closed on version, cluster, topology, inventory, and session drift', async () => {
  const first = await readDiscovery({ runNativeCommand: runner(discoveryOutputs()) }, CONNECTION);
  const pinned = {
    ...CONNECTION,
    expectedVersion: first.version.text,
    expectedClusterVersion: first.clusterVersion.text,
    expectedClusterId: first.clusterId,
    expectedDeploymentFingerprint: first.deploymentFingerprint,
    expectedTopologyFingerprint: first.topologyFingerprint,
    expectedInventoryFingerprint: first.inventoryFingerprint
  };
  await readDiscovery({ runNativeCommand: runner(discoveryOutputs()) }, pinned);
  const newVersion = discoveryOutputs({
    [QUERIES.identity]: tsv(['version', 'cluster_id', 'node_id', 'current_user', 'current_database'], [['CockroachDB CCL v25.2.4 (linux)', CLUSTER_ID, 1, 'backup_user', 'defaultdb']])
  });
  await assert.rejects(readDiscovery({ runNativeCommand: runner(newVersion) }, pinned), (error) => error.code === 'COCKROACH_VERSION_CHANGED');
  const newTopology = discoveryOutputs({
    [QUERIES.nodes]: tsv(['node_id', 'address', 'sql_address', 'build_tag', 'started_at', 'locality', 'is_available', 'is_live'], [
      [1, 'roach-a:26257', 'roach-a:26257', 'v25.2.3', '2026-08-05T01:00:00.000Z', 'region=us-east1,zone=a', true, true],
      [2, 'roach-c:26257', 'roach-c:26257', 'v25.2.3', '2026-08-05T01:00:01.000Z', 'region=us-east1,zone=c', true, true]
    ])
  });
  await assert.rejects(readDiscovery({ runNativeCommand: runner(newTopology) }, pinned), (error) => error.code === 'COCKROACH_TOPOLOGY_CHANGED');
  const changedPrivileges = discoveryOutputs({
    [QUERIES.systemPrivileges]: tsv(['backup', 'restore', 'viewjob', 'controljob', 'externalioimplicitaccess'], [[false, true, true, true, false]])
  });
  await assert.rejects(readDiscovery({ runNativeCommand: runner(changedPrivileges) }, pinned), (error) => error.code === 'COCKROACH_INVENTORY_CHANGED');
  const wrongSession = discoveryOutputs({
    [QUERIES.identity]: tsv(['version', 'cluster_id', 'node_id', 'current_user', 'current_database'], [['CockroachDB CCL v25.2.3 (linux)', CLUSTER_ID, 1, 'other_user', 'defaultdb']])
  });
  await assert.rejects(readDiscovery({ runNativeCommand: runner(wrongSession) }, CONNECTION), (error) => error.code === 'COCKROACH_SESSION_IDENTITY_CHANGED');
});

test('rejects malformed, incomplete, duplicate, and oversized discovery evidence', async () => {
  const duplicateNodes = discoveryOutputs({
    [QUERIES.nodes]: tsv(['node_id', 'address', 'sql_address', 'build_tag', 'started_at', 'locality', 'is_available', 'is_live'], [
      [1, 'roach-a:26257', 'roach-a:26257', 'v25.2.3', '2026-08-05T01:00:00.000Z', '', true, true],
      [1, 'roach-b:26257', 'roach-b:26257', 'v25.2.3', '2026-08-05T01:00:01.000Z', '', true, true]
    ])
  });
  await assert.rejects(readDiscovery({ runNativeCommand: runner(duplicateNodes) }, CONNECTION), (error) => error.code === 'COCKROACH_NODE_INVENTORY_INVALID');
  const malformedEmptyExternal = discoveryOutputs({ [QUERIES.externalConnections]: tsv(['connection_uri'], []) });
  await assert.rejects(readDiscovery({ runNativeCommand: runner(malformedEmptyExternal) }, CONNECTION), (error) => error.code === 'COCKROACH_OUTPUT_INVALID');
  const nodes = Array.from({ length: 1001 }, (_, index) => [index + 1, `roach-${index}:26257`, `roach-${index}:26257`, 'v25.2.3', '2026-08-05T01:00:00.000Z', '', true, true]);
  const oversized = discoveryOutputs({ [QUERIES.nodes]: tsv(['node_id', 'address', 'sql_address', 'build_tag', 'started_at', 'locality', 'is_available', 'is_live'], nodes) });
  await assert.rejects(readDiscovery({ runNativeCommand: runner(oversized) }, CONNECTION), (error) => error.code === 'COCKROACH_NODE_INVENTORY_INVALID');
});

function serviceFixture({ transactionFailure = false } = {}) {
  const connections = new Map();
  const secretRefs = new Map();
  const secrets = new Map();
  let resolveCount = 0;
  let validatedCount = 0;
  let deletedCount = 0;
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
    transaction: async (callback) => {
      if (transactionFailure) throw new Error('transaction failed');
      return callback({
        create: (name, input) => {
          if (name === 'secretRef') {
            const record = { ...input, revision: 1 };
            secretRefs.set(record.id, record);
            return record;
          }
          const record = { ...input, id: 'connection-cockroach', revision: 1 };
          connections.set(record.id, record);
          return record;
        }
      });
    }
  };
  const secretStore = {
    create: async (input) => {
      secrets.set(SECRET_REF_ID, input.value);
      return { id: SECRET_REF_ID, workspaceId: input.workspaceId, name: input.name, provider: 'electron-safe-storage', scope: input.scope, providerKey: SECRET_REF_ID, secretType: input.secretType, version: 1 };
    },
    resolve: async ({ id }) => { resolveCount += 1; return secrets.get(id); },
    markValidated: async () => { validatedCount += 1; return { lastValidatedAt: '2026-08-05T12:00:00.000Z' }; },
    delete: async ({ id }) => { deletedCount += 1; return secrets.delete(id); }
  };
  return { connections, secretRefs, secrets, controlDatabase, secretStore, resolveCount: () => resolveCount, validatedCount: () => validatedCount, deletedCount: () => deletedCount };
}

test('persists only an encrypted device-scoped password SecretRef and repeats pinned discovery before trust', async () => {
  const fixture = serviceFixture();
  const observations = [];
  const adapter = new CockroachDbAdapter({ clock: () => '2026-08-05T12:00:00.000Z', now: () => 1000 });
  const service = new CockroachDbConnectionService({ ...fixture, deviceId: 'device-a', adapter, localCommandRunner: runner(discoveryOutputs(), observations) });
  const created = await service.create('workspace-a', 'actor-a', { name: 'Production CockroachDB', executionMode: 'local', authMode: 'password', host: 'roach.example.com', username: 'backup_user', database: 'defaultdb', password: PASSWORD });
  assert.deepEqual(created.secretRefIds, [SECRET_REF_ID]);
  assert.deepEqual(created.workerAffinity, ['device:device-a']);
  assert.equal(created.endpoint.password, undefined);
  assert.equal(created.endpoint.passwordSecretRefId, undefined);
  assert.equal(fixture.secretRefs.get(SECRET_REF_ID).scope, 'device');
  assert.equal(JSON.stringify(created).includes(PASSWORD), false);
  assert.throws(() => service.config({ ...created, secretRefIds: [SECRET_REF_ID, 'sec_unexpected'] }), /exactly one SecretRef/);
  assert.throws(() => service.config({ ...created, endpoint: { ...created.endpoint, authMode: 'insecure', allowInsecure: true }, secretRefIds: [SECRET_REF_ID] }), /cannot reference password SecretRefs/);
  await assert.rejects(service.discover('workspace-a', created.id), /Test the CockroachDB connection successfully/);
  const tested = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.cockroachdbInventory.clusterId, CLUSTER_ID);
  assert.equal(tested.connection.cockroachdbInventory.nodes.length, 2);
  assert.equal(tested.connection.trust.fingerprint, tested.connection.endpoint.expectedDeploymentFingerprint);
  assert.equal(fixture.resolveCount(), 1);
  assert.equal(fixture.validatedCount(), 1);
  assert.equal(observations.length, Object.keys(QUERIES).length * 2);
  assert.equal(observations.every((item) => item.env.PGPASSWORD === PASSWORD && !item.args.join(' ').includes(PASSWORD)), true);
  const discovered = await service.discover('workspace-a', created.id, { kind: 'nodes' });
  assert.equal(discovered.items.length, 2);
  assert.equal(fixture.resolveCount(), 2);
  assert.equal(JSON.stringify([...fixture.connections.values()]).includes(PASSWORD), false);
});

test('normalizes exact single and locality-aware external-connection destinations', () => {
  const single = normalizeBackupDestination({ type: 'external-connection', externalConnectionName: 'backup_archive' });
  assert.equal(single.localityAware, false);
  assert.equal(single.localities[0].locality, 'default');
  const localityAware = normalizeBackupDestination({
    type: 'external-connection',
    localities: [
      { locality: 'region=us-east1', externalConnectionName: 'backup_east' },
      { locality: 'default', externalConnectionName: 'backup_archive' }
    ]
  });
  assert.equal(localityAware.localityAware, true);
  assert.deepEqual(localityAware.localities.map((item) => item.locality), ['default', 'region=us-east1']);
  assert.match(localityAware.destinationFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(localityAware.localityFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => normalizeBackupDestination({ type: 'external-connection', externalConnectionName: "backup'; DROP DATABASE app; --" }), /name is invalid/);
  assert.throws(() => normalizeBackupDestination({ type: 'external-connection', localities: [
    { locality: 'default', externalConnectionName: 'backup_a' },
    { locality: 'default', externalConnectionName: 'backup_b' }
  ] }), /unique/);
});

test('checks and privately persists one exact CockroachDB backup destination, then retains only a current binding', async () => {
  const fixture = serviceFixture();
  const checkQuery = "CHECK EXTERNAL CONNECTION 'external://backup_archive'";
  const outputs = { ...discoveryOutputs(), [checkQuery]: '' };
  const observations = [];
  const adapter = new CockroachDbAdapter({ clock: () => '2026-08-05T12:00:00.000Z', now: () => 1000 });
  const service = new CockroachDbConnectionService({ ...fixture, deviceId: 'device-a', adapter, localCommandRunner: runner(outputs, observations), clock: () => '2026-08-05T12:30:00.000Z' });
  const created = await service.create('workspace-a', 'actor-a', { name: 'Production CockroachDB', executionMode: 'local', authMode: 'password', host: 'roach.example.com', username: 'backup_user', database: 'defaultdb', password: PASSWORD });
  await service.test('workspace-a', created.id, 'actor-a');
  await assert.rejects(service.approveDestination('workspace-a', created.id, { externalConnectionName: 'backup_archive', confirmationText: 'wrong' }, 'actor-a'), /USE COCKROACHDB BACKUP DESTINATION/);
  const approved = await service.approveDestination('workspace-a', created.id, { externalConnectionName: 'backup_archive', confirmationText: BACKUP_DESTINATION_CONFIRMATION }, 'actor-a');
  assert.equal(approved.destinationTrust.bindingCount, 1);
  assert.equal(approved.destinationTrust.checkedAt, '2026-08-05T12:30:00.000Z');
  assert.equal(approved.destinationTrust.destination, undefined);
  assert.equal(approved.connection.cockroachdbBackupDestinationTrust.destination, undefined);
  const persisted = fixture.connections.get(created.id);
  assert.equal(persisted.cockroachdbBackupDestinationTrust.connectionRevision, persisted.revision);
  assert.deepEqual(persisted.cockroachdbBackupDestinationTrust.destination.localities, [{ locality: 'default', externalConnectionName: 'backup_archive' }]);
  assert.equal(observations.filter((item) => item.query === checkQuery).length, 1);

  const listed = await service.list('workspace-a');
  assert.equal(listed[0].cockroachdbBackupDestinationTrust.bindingCount, 1);
  assert.equal(JSON.stringify(listed[0].cockroachdbBackupDestinationTrust).includes('backup_archive'), false);
  const retested = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(retested.connection.cockroachdbBackupDestinationTrust.bindingCount, 1);
  assert.equal(fixture.connections.get(created.id).cockroachdbBackupDestinationTrust.connectionRevision, fixture.connections.get(created.id).revision);

  const changedInventory = discoveryOutputs({ [QUERIES.externalConnections]: tsv(['connection_name', 'owner'], [['backup_replacement', 'backup_user']]) });
  service.localCommandRunner = runner(changedInventory);
  const invalidated = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(invalidated.result.status, 'failure');
  assert.equal(fixture.connections.get(created.id).cockroachdbBackupDestinationTrust, null);
});

test('does not publish provider errors when destination checking fails', async () => {
  const fixture = serviceFixture();
  const checkQuery = "CHECK EXTERNAL CONNECTION 'external://backup_archive'";
  const adapter = new CockroachDbAdapter({ clock: () => '2026-08-05T12:00:00.000Z', now: () => 1000 });
  const service = new CockroachDbConnectionService({ ...fixture, deviceId: 'device-a', adapter, localCommandRunner: runner(discoveryOutputs()) });
  const created = await service.create('workspace-a', 'actor-a', { name: 'Production CockroachDB', executionMode: 'local', authMode: 'password', host: 'roach.example.com', username: 'backup_user', database: 'defaultdb', password: PASSWORD });
  await service.test('workspace-a', created.id, 'actor-a');
  service.localCommandRunner = runner({ ...discoveryOutputs(), [checkQuery]: new Error('private provider credential and bucket detail') });
  await assert.rejects(service.approveDestination('workspace-a', created.id, { externalConnectionName: 'backup_archive', confirmationText: BACKUP_DESTINATION_CONFIRMATION }, 'actor-a'), (error) => error.code === 'COCKROACH_COMMAND_FAILED' && !error.message.includes('private provider'));
  assert.equal(fixture.connections.get(created.id).cockroachdbBackupDestinationTrust, null);
});

test('deletes a newly encrypted password when connection persistence fails', async () => {
  const fixture = serviceFixture({ transactionFailure: true });
  const service = new CockroachDbConnectionService({ ...fixture, deviceId: 'device-a' });
  await assert.rejects(service.create('workspace-a', 'actor-a', { name: 'Broken CockroachDB', executionMode: 'local', authMode: 'password', host: 'roach.example.com', username: 'backup_user', password: PASSWORD }), /transaction failed/);
  assert.equal(fixture.secrets.size, 0);
  assert.equal(fixture.deletedCount(), 1);
});

test('uses a mode-0600 SSH password environment and proves cleanup without command disclosure', async () => {
  const fixture = serviceFixture();
  const normalized = normalizeConfig({ executionMode: 'ssh', sshConnectionId: 'ssh-a', authMode: 'password', host: 'roach.internal', username: 'backup_user', passwordSecretRefId: SECRET_REF_ID });
  const { passwordSecretRefId: _secretRefId, ...endpoint } = normalized;
  fixture.secrets.set(SECRET_REF_ID, PASSWORD);
  fixture.connections.set('ssh-a', {
    id: 'ssh-a',
    adapterId: 'deployerx.connection.ssh',
    endpoint: { host: 'jump.example.com', port: 22, username: 'deploy', authType: 'password', timeoutMs: 20000 },
    secretRefIds: ['sec_ssh_password'],
    workerAffinity: ['device:device-a'],
    lastTest: { status: 'success' },
    trust: { fingerprint: `SHA256:${'A'.repeat(43)}`, algorithm: 'ssh-ed25519' }
  });
  const connection = { id: 'connection-cockroach', endpoint, secretRefIds: [SECRET_REF_ID], adapterId: ADAPTER_ID, workerAffinity: ['device:device-a'] };
  const writes = [];
  const commands = [];
  let closed = 0;
  const session = {
    writeFile: async (file, contents, options) => writes.push({ file, contents, options }),
    run: async (command) => { commands.push(command); return { stdout: '', stderr: '', exitCode: 0 }; },
    close: () => { closed += 1; }
  };
  const service = new CockroachDbConnectionService({ ...fixture, deviceId: 'device-a', sessionFactory: async () => session });
  await service.withExecution('workspace-a', connection, undefined, async (context) => {
    await context.runNativeCommand({ executable: 'cockroach', args: ['sql', '--execute', 'SELECT 1'], timeoutMs: 1000 });
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.mode, 0o600);
  assert.equal(writes[0].contents, passwordEnvironmentContents(PASSWORD));
  assert.equal(commands.length, 2);
  assert.equal(commands[0].includes(PASSWORD), false);
  assert.match(commands[0], /deployerx-cockroachdb-[0-9a-f]{32}\.env/);
  assert.match(commands[1], /rm/);
  assert.equal(commands[1].includes(PASSWORD), false);
  assert.equal(closed, 1);
});
