const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  PostgresqlConnectionService,
  PostgresqlLogicalAdapter,
  SUPABASE_MANAGED_SCHEMAS,
  SUPABASE_TRANSACTION_POOLER_ERROR_CODE,
  dumpArguments,
  normalizeConfig,
  pgpassContents,
  postgresToolVersion,
  serverVersion,
  sslMode
} = require('./postgresql-logical');

class FakePostgresqlRunner {
  constructor(options = {}) {
    this.calls = [];
    this.passfiles = [];
    this.restored = Buffer.alloc(0);
    this.dumps = options.dumps || { accounts: '-- accounts\n', orders: '-- orders\n' };
    this.privileges = options.privileges || 't\t0\t0\t0\n';
    this.serverVersion = options.serverVersion || '16.4';
    this.toolVersion = options.toolVersion || '16.4';
    this.inventoryCalls = 0;
    this.missingAfterBackup = Boolean(options.missingAfterBackup);
    this.invalidAfterBackup = Boolean(options.invalidAfterBackup);
  }

  async inspect(input) {
    this.calls.push({ executable: input.executable, args: [...input.args], env: { ...(input.env || {}) } });
    if (input.env?.PGPASSFILE) this.passfiles.push(await fs.readFile(input.env.PGPASSFILE, 'utf8'));
  }

  async run(input) {
    await this.inspect(input);
    if (input.args.includes('--version')) return { exitCode: 0, stdout: `${path.basename(input.executable)} (PostgreSQL) ${this.toolVersion}`, stderr: '' };
    const query = input.args.find((argument) => argument.startsWith('--command='))?.slice('--command='.length) || '';
    if (query.includes('FROM pg_database')) return { exitCode: 0, stdout: 'accounts\norders\npostgres\n', stderr: '' };
    if (query.startsWith('SELECT nspname FROM pg_namespace')) return { exitCode: 0, stdout: 'audit\npublic\n', stderr: '' };
    if (query.startsWith('SELECT n.nspname, c.relname, c.relkind FROM pg_class')) return { exitCode: 0, stdout: 'audit\tevents\tp\npublic\tinvoice_view\tv\npublic\tinvoices\tr\n', stderr: '' };
    if (query.startsWith("SELECT 'schema'")) {
      this.inventoryCalls += 1;
      const afterBackup = this.inventoryCalls > 1;
      const missing = this.missingAfterBackup && afterBackup;
      const valid = this.invalidAfterBackup && afterBackup ? 'f' : 't';
      const auditScope = query.includes("decode('6175646974'");
      const schema = auditScope ? 'audit' : 'public';
      const relation = auditScope ? 'events' : 'invoices';
      return { exitCode: 0, stdout: `schema\t${schema}\t\tschema\tt\n${missing ? '' : `relation\t${schema}\t${relation}\t${auditScope ? 'partitioned-table' : 'table'}\tt\n`}index\t${schema}\t${relation}_pkey\tindex\t${valid}\ntrigger\t${schema}\t${relation}.audit_trg\ttrigger\tt\nroutine\t${schema}\trefresh_${relation}()\tfunction\tt\n`, stderr: '' };
    }
    if (query.includes('has_database_privilege')) return { exitCode: 0, stdout: this.privileges, stderr: '' };
    if (query === 'SELECT 1;') return { exitCode: 0, stdout: '1\n', stderr: '' };
    if (query.includes("current_setting('server_encoding')")) return { exitCode: 0, stdout: query.includes('pg_control_system') ? `${this.serverVersion}\t160004\t7395820012345678901\tUTF8\ten_US.UTF-8\ten_US.UTF-8\n` : `${this.serverVersion}\t160004\tUTF8\ten_US.UTF-8\ten_US.UTF-8\n`, stderr: '' };
    return { exitCode: 0, stdout: query.includes('pg_control_system') ? `${this.serverVersion}\t160004\t7395820012345678901\n` : `${this.serverVersion}\t160004\n`, stderr: '' };
  }

  stream(input) {
    const preparation = this.inspect(input);
    const dump = Buffer.from(this.dumps[input.env.PGDATABASE] || `-- ${input.env.PGDATABASE}\n`);
    return { stdout: Readable.from((async function* () { await preparation; yield dump; })()), completion: preparation.then(() => ({ exitCode: 0, stderr: '' })), cancel() {} };
  }

  async consume(input) {
    await this.inspect(input);
    const chunks = [];
    for await (const chunk of input.stdin) chunks.push(Buffer.from(chunk));
    this.restored = Buffer.concat(chunks);
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

function config(overrides = {}) {
  return { host: 'pg.example.com', port: 5432, username: 'backup', maintenanceDatabase: 'postgres', passwordSecretRefId: 'sec_12345678', tlsMode: 'verify-identity', timeoutMs: 5000, ...overrides };
}

const SUPABASE_PROJECT_REF = 'abcdefghijklmnopqrst';

function supabaseConfig(connectionMode = 'direct', overrides = {}) {
  const projectRef = overrides.projectRef || SUPABASE_PROJECT_REF;
  const pooler = connectionMode !== 'direct';
  return config({
    deploymentProfile: 'supabase', connectionMode, projectRef,
    host: pooler ? 'aws-0-us-east-1.pooler.supabase.com' : `db.${projectRef}.supabase.co`,
    port: connectionMode === 'transaction-pooler' ? 6543 : 5432,
    username: pooler ? `postgres.${projectRef}` : 'postgres',
    maintenanceDatabase: 'postgres',
    ...overrides
  });
}

function context() {
  return { resolveSecret: async () => 'p@ss:word\\private' };
}

function request(databases = ['orders'], connection = config()) {
  return { connection, selector: { databases: { include: databases.map((name) => ({ name })) } }, consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' } };
}

test('normalizes PostgreSQL 14-18 versions, executables, TLS, and escaped passfiles', () => {
  assert.equal(postgresToolVersion('pg_dump (PostgreSQL) 18.1').text, '18.1.0');
  assert.equal(postgresToolVersion('pg_dump 16.4').supported, false);
  assert.equal(serverVersion('14.19 (Debian)').supported, true);
  assert.equal(serverVersion('13.22').supported, false);
  assert.equal(serverVersion('19beta1').supported, false);
  assert.equal(sslMode('verify-identity'), 'verify-full');
  assert.equal(sslMode('disabled'), 'disable');
  assert.equal(sslMode('preferred'), 'prefer');
  assert.equal(sslMode('required'), 'require');
  const normalized = normalizeConfig(config());
  assert.equal(normalized.psqlExecutable, 'psql');
  assert.equal(normalized.pgDumpExecutable, 'pg_dump');
  assert.throws(() => normalizeConfig(config({ pgDumpExecutable: 'pg_restore.exe' })));
  assert.equal(pgpassContents(normalized, 'a:b\\c'), 'pg.example.com:5432:*:backup:a\\:b\\\\c\n');
  assert.throws(() => pgpassContents(normalized, 'line1\nline2'));
});

test('normalizes and endpoint-binds the Supabase profile while requiring TLS', () => {
  assert.equal(normalizeConfig(config()).deploymentProfile, 'postgresql');
  const direct = normalizeConfig(supabaseConfig());
  assert.equal(direct.deploymentProfile, 'supabase');
  assert.equal(direct.connectionMode, 'direct');
  assert.equal(direct.projectRef, SUPABASE_PROJECT_REF);
  assert.equal(Object.hasOwn(direct, 'supabaseEndpointMode'), false);
  const legacy = supabaseConfig();
  legacy.supabaseEndpointMode = legacy.connectionMode;
  delete legacy.connectionMode;
  assert.equal(normalizeConfig(legacy).connectionMode, 'direct');
  assert.equal(normalizeConfig(supabaseConfig('transaction-pooler', { port: undefined })).port, 6543);
  assert.throws(() => normalizeConfig(supabaseConfig('direct', { tlsMode: 'disabled' })), /require TLS/i);
  assert.throws(() => normalizeConfig(supabaseConfig('direct', { tlsMode: 'preferred' })), /require TLS/i);
  assert.throws(() => normalizeConfig(supabaseConfig('direct', { projectRef: 'too-short', host: 'db.too-short.supabase.co' })), /20 lowercase/i);
  assert.throws(() => normalizeConfig(supabaseConfig('direct', { host: 'postgres.example.com' })), /project-bound/i);
  assert.throws(() => normalizeConfig(supabaseConfig('session-pooler', { username: 'postgres.otherprojectrefxx' })), /project reference/i);
  assert.throws(() => normalizeConfig({ ...supabaseConfig(), connectionMode: 'direct', supabaseEndpointMode: 'session-pooler' }), /Conflicting/i);
});

test('advertises a logical-only bounded Supabase capability profile', () => {
  const manifest = new PostgresqlLogicalAdapter({ processRunner: new FakePostgresqlRunner() }).manifest({ deploymentProfile: 'supabase' });
  assert.equal(manifest.adapterId, ADAPTER_ID);
  assert.equal(manifest.adapterVersion, ADAPTER_VERSION);
  assert.deepEqual(manifest.capabilities.backupMethods, ['logical']);
  assert.deepEqual(manifest.capabilities.backupModes, ['full']);
  assert.equal(manifest.capabilities.transactionLogs.supported, false);
  assert.equal(manifest.capabilities.transactionLogs.pointInTimeRecovery, false);
  assert.deepEqual(manifest.requiredTools.map((tool) => tool.name), ['psql', 'pg_dump']);
  assert.equal(manifest.requiredPrivileges.some((privilege) => privilege.id === 'postgresql-cluster-identity'), false);
  assert.equal(JSON.stringify(manifest).includes('pg_basebackup'), false);
  assert.equal(JSON.stringify(manifest).includes('pg_waldump'), false);
});

test('tests all Supabase endpoint modes without cluster-control identity queries', async () => {
  const runner = new FakePostgresqlRunner();
  const adapter = new PostgresqlLogicalAdapter({ processRunner: runner, clock: () => '2026-08-05T00:00:00.000Z' });
  const direct = await adapter.testConnection(context(), supabaseConfig('direct'));
  const session = await adapter.testConnection(context(), supabaseConfig('session-pooler'));
  const transaction = await adapter.testConnection(context(), supabaseConfig('transaction-pooler'));
  assert.equal(direct.status, 'success');
  assert.equal(session.status, 'success');
  assert.equal(transaction.status, 'success');
  assert.equal(direct.endpointIdentity.projectRef, SUPABASE_PROJECT_REF);
  assert.equal(direct.endpointIdentity.connectionMode, 'direct');
  assert.equal(direct.endpointIdentity.serverFingerprint, session.endpointIdentity.serverFingerprint);
  assert.equal(direct.remotePlatform.distribution, 'Supabase Postgres');
  assert.equal(transaction.checks.find((check) => check.id === 'backup-restore-eligibility').status, 'warning');
  assert.equal(runner.calls.some((call) => call.args.some((argument) => argument.includes('pg_control_system'))), false);
  assert.equal(runner.calls.every((call) => JSON.stringify(call).includes('p@ss:word') === false), true);
});

test('tests PostgreSQL with a temporary passfile and captures the cluster system identifier', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-postgresql-adapter-test-'));
  try {
    const runner = new FakePostgresqlRunner();
    const adapter = new PostgresqlLogicalAdapter({ processRunner: runner, temporaryRoot, clock: () => '2026-08-04T00:00:00.000Z', now: (() => { let value = 0; return () => value += 5; })() });
    const result = await adapter.testConnection(context(), config());
    assert.equal(result.status, 'success');
    assert.equal(result.remotePlatform.version, '16.4.0');
    assert.match(result.endpointIdentity.serverFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(runner.calls.every((call) => JSON.stringify(call).includes('p@ss:word') === false), true);
    assert.equal(runner.passfiles.some((value) => value.includes('p@ss\\:word')), true);
    assert.deepEqual(await fs.readdir(temporaryRoot), []);
  } finally { await fs.rm(temporaryRoot, { recursive: true, force: true }); }
});

test('discovers databases and proves per-database snapshots, privileges, and tool compatibility', async () => {
  const runner = new FakePostgresqlRunner();
  const adapter = new PostgresqlLogicalAdapter({ processRunner: runner, clock: () => '2026-08-04T00:00:00.000Z' });
  const pages = [];
  for await (const page of adapter.discover(context(), { connection: config() })) pages.push(page);
  assert.deepEqual(pages[0].items.map((item) => item.name), ['accounts', 'orders']);
  const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), request(['orders', 'accounts']));
  assert.equal(prepared.consistency.proven, true);
  assert.equal(prepared.adapterPlan.operation, 'postgresql-logical-backup');
  assert.deepEqual(prepared.adapterPlan.databases, ['accounts', 'orders']);
  assert.equal(prepared.consistency.evidence.warnings.some((warning) => warning.includes('cross-database')), true);
  assert.equal(runner.calls.filter((call) => call.args.some((argument) => argument.includes('has_database_privilege'))).length, 2);
  assert.deepEqual(dumpArguments(), ['--format=plain', '--create', '--clean', '--if-exists', '--no-owner', '--no-privileges', '--encoding=UTF8', '--no-password']);
});

test('backs up and restores the configured Supabase database through direct and session-pooler endpoints', async () => {
  for (const connectionMode of ['direct', 'session-pooler']) {
    const connection = supabaseConfig(connectionMode);
    const runner = new FakePostgresqlRunner();
    const adapter = new PostgresqlLogicalAdapter({ processRunner: runner, clock: () => '2026-08-05T00:00:00.000Z' });
    const pages = [];
    for await (const page of adapter.discover(context(), { connection })) pages.push(page);
    assert.equal(pages[0].items.some((item) => item.name === 'postgres' && item.selectable), true);
    const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), request(['postgres'], connection));
    assert.equal(prepared.adapterPlan.connection.connectionMode, connectionMode);
    assert.equal(prepared.adapterPlan.restoreDatabase, 'postgres');
    assert.equal(prepared.adapterPlan.dumpArguments.includes('--create'), false);
    assert.equal(prepared.adapterPlan.dumpArguments.includes('--exclude-schema="auth"'), true);
    assert.deepEqual(prepared.consistency.evidence.metadata.excludedManagedSchemas, SUPABASE_MANAGED_SCHEMAS);
    assert.equal(prepared.consistency.evidence.metadata.platformSnapshotsIncluded, false);
    assert.equal(prepared.consistency.evidence.warnings.some((warning) => warning.includes('Storage objects')), true);
    assert.equal(runner.calls.some((call) => call.args.some((argument) => argument.includes('pg_control_system'))), false);
    let stored;
    await adapter.executeBackup(context(), prepared.adapterPlan, { async write(artifact) { const chunks = []; for await (const chunk of artifact.content) chunks.push(Buffer.from(chunk)); stored = { ...artifact, content: Buffer.concat(chunks) }; return stored; } });
    const restorePlan = await adapter.planRestore({}, { mode: 'original', confirmation: 'RESTORE_POSTGRESQL_ORIGINAL', connection, metadata: stored.metadata, artifactPath: stored.path });
    assert.equal(restorePlan.restoreDatabase, 'postgres');
    const restored = await adapter.executeRestore(context(), restorePlan, { async open() { return Readable.from(stored.content); } });
    assert.equal(restored.status, 'succeeded');
    assert.equal(runner.restored.equals(stored.content), true);
    assert.equal(runner.calls.at(-1).env.PGDATABASE, 'postgres');
  }
});

test('pins Supabase original restore by project and allows prepared alternate-project restore without superuser probes', async () => {
  const runner = new FakePostgresqlRunner();
  const adapter = new PostgresqlLogicalAdapter({ processRunner: runner, clock: () => '2026-08-05T00:00:00.000Z' });
  const source = supabaseConfig('direct');
  const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), request(['postgres'], source));
  const metadata = prepared.consistency.evidence.metadata;
  const alternateRef = 'zyxwvutsrqponmlkjihg';
  const alternate = supabaseConfig('session-pooler', { projectRef: alternateRef, username: `postgres.${alternateRef}` });
  runner.calls.length = 0;
  const target = await adapter.prepareRestoreTarget(context(), { mode: 'alternate', connection: alternate, metadata, conflictPolicy: 'overwrite' });
  assert.deepEqual(target.collisions, ['postgres']);
  assert.equal(runner.calls.some((call) => call.args.some((argument) => argument.includes('pg_roles') || argument.includes('rolsuper'))), false);
  const plan = await adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_POSTGRESQL_ALTERNATE', connection: alternate, metadata, targetPrepared: true, artifactPath: 'postgresql/logical-dump.sql' });
  assert.equal(plan.restoreDatabase, 'postgres');
  await assert.rejects(adapter.planRestore({}, { mode: 'original', confirmation: 'RESTORE_POSTGRESQL_ORIGINAL', connection: alternate, metadata, artifactPath: 'postgresql/logical-dump.sql' }), (error) => error.code === 'POSTGRESQL_SUPABASE_RESTORE_PROJECT_MISMATCH');
  await assert.rejects(adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_POSTGRESQL_ALTERNATE', connection: source, metadata, targetPrepared: true, artifactPath: 'postgresql/logical-dump.sql' }), (error) => error.code === 'POSTGRESQL_SUPABASE_ALTERNATE_TARGET_IS_ORIGINAL');
  await assert.rejects(adapter.planRestore({}, { mode: 'new-database', confirmation: 'RESTORE_POSTGRESQL_NEW_DATABASE', connection: source, metadata, targetPrepared: true, artifactPath: 'postgresql/logical-dump.sql' }), (error) => error.code === 'POSTGRESQL_SUPABASE_NEW_DATABASE_RESTORE_UNSUPPORTED');
});

test('keeps transaction-pooler diagnostics but refuses backup and restore with one stable code', async () => {
  const runner = new FakePostgresqlRunner();
  const adapter = new PostgresqlLogicalAdapter({ processRunner: runner });
  const connection = supabaseConfig('transaction-pooler');
  assert.equal((await adapter.testConnection(context(), connection)).status, 'success');
  runner.calls.length = 0;
  let secretResolved = false;
  const diagnosticOnlyContext = { resolveSecret: async () => { secretResolved = true; return 'unused'; } };
  await assert.rejects(new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, diagnosticOnlyContext, request(['postgres'], connection)), (error) => error.code === SUPABASE_TRANSACTION_POOLER_ERROR_CODE);
  const metadata = { deploymentProfile: 'supabase', connectionMode: 'transaction-pooler', projectRef: SUPABASE_PROJECT_REF, selectedDatabases: ['postgres'], selectionMode: 'databases' };
  await assert.rejects(adapter.planRestore({}, { mode: 'original', confirmation: 'RESTORE_POSTGRESQL_ORIGINAL', connection, metadata, artifactPath: 'postgresql/logical-dump.sql' }), (error) => error.code === SUPABASE_TRANSACTION_POOLER_ERROR_CODE);
  await assert.rejects(adapter.prepareRestoreTarget(diagnosticOnlyContext, { mode: 'original', connection, metadata }), (error) => error.code === SUPABASE_TRANSACTION_POOLER_ERROR_CODE);
  assert.equal(secretResolved, false);
  assert.equal(runner.calls.length, 0);
});

test('rejects explicit Supabase platform-managed schema enrollment', async () => {
  const adapter = new PostgresqlLogicalAdapter({ processRunner: new FakePostgresqlRunner() });
  await assert.rejects(new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), {
    connection: supabaseConfig(),
    selector: { databases: { include: [{ name: 'postgres' }] }, schemas: { include: [{ database: 'postgres', name: 'auth' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' }
  }), (error) => error.code === 'POSTGRESQL_SUPABASE_MANAGED_SCHEMA_UNSUPPORTED');
});

test('discovers PostgreSQL objects and uses scope-safe partial dump and restore targets', async () => {
  const runner = new FakePostgresqlRunner();
  const adapter = new PostgresqlLogicalAdapter({ processRunner: runner, clock: () => '2026-08-04T00:00:00.000Z' });
  assert.equal(adapter.manifest().adapterVersion, ADAPTER_VERSION);
  assert.equal(adapter.manifest().capabilities.restore.alternateTarget, true);
  assert.equal(adapter.manifest().capabilities.restore.nativeValidation, true);
  assert.deepEqual(adapter.manifest().capabilities.selection, { database: true, schema: true, table: true, globalObjects: false });
  const schemaPages = [];
  for await (const page of adapter.discover(context(), { connection: config(), kind: 'schema', database: 'orders' })) schemaPages.push(page);
  assert.deepEqual(schemaPages[0].items.map((item) => item.name), ['audit', 'public']);
  const tablePages = [];
  for await (const page of adapter.discover(context(), { connection: config(), kind: 'table', database: 'orders' })) tablePages.push(page);
  assert.deepEqual(tablePages[0].items.map((item) => `${item.schema}.${item.name}:${item.objectType}`), ['audit.events:table', 'public.invoice_view:view', 'public.invoices:table']);
  const selector = { databases: { include: [{ name: 'orders' }] }, schemas: { include: [{ database: 'orders', name: 'audit' }] } };
  const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), { connection: config(), selector, consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' } });
  assert.equal(prepared.adapterPlan.restoreDatabase, 'orders');
  assert.equal(prepared.adapterPlan.dumpArguments.includes('--create'), false);
  assert.equal(prepared.adapterPlan.dumpArguments.includes('--schema="audit"'), true);
  let stored;
  await adapter.executeBackup(context(), prepared.adapterPlan, { async write(artifact) { const chunks = []; for await (const chunk of artifact.content) chunks.push(Buffer.from(chunk)); stored = { ...artifact, content: Buffer.concat(chunks) }; return stored; } });
  const plan = await adapter.planRestore({}, { mode: 'original', confirmation: 'RESTORE_POSTGRESQL_ORIGINAL', connection: config(), metadata: stored.metadata, serverIdentityFingerprint: prepared.consistency.evidence.serverIdentityFingerprint, artifactPath: stored.path });
  assert.equal(plan.restoreDatabase, 'orders');
  await adapter.executeRestore(context(), plan, { async open() { return Readable.from(stored.content); } });
  assert.equal(runner.calls.at(-1).env.PGDATABASE, 'orders');
  await assert.rejects(new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), {
    connection: config(),
    selector: { databases: { include: [{ name: 'orders' }] }, schemas: { include: [{ database: 'orders', name: 'audit' }] }, tables: { include: [{ database: 'orders', schema: 'public', name: 'invoices' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' }
  }), (error) => error.code === 'POSTGRESQL_OBJECT_SELECTION_MIXED');
});

test('refuses maintenance-database selection, missing privileges, and older client tools', async () => {
  const adapter = new PostgresqlLogicalAdapter({ processRunner: new FakePostgresqlRunner() });
  await assert.rejects(new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), request(['postgres'])), (error) => error.code === 'POSTGRESQL_MAINTENANCE_DATABASE_SELECTED');
  const missing = new PostgresqlLogicalAdapter({ processRunner: new FakePostgresqlRunner({ privileges: 't\t0\t1\t0\n' }) });
  await assert.rejects(new DatabaseAdapterRegistry([missing]).prepareBackup(ADAPTER_ID, context(), request()), (error) => error.code === 'DATABASE_CONSISTENCY_UNPROVEN');
  const oldClient = new PostgresqlLogicalAdapter({ processRunner: new FakePostgresqlRunner({ serverVersion: '16.4', toolVersion: '15.8' }) });
  await assert.rejects(new DatabaseAdapterRegistry([oldClient]).prepareBackup(ADAPTER_ID, context(), request()), (error) => error.code === 'DATABASE_NATIVE_TOOL_UNAVAILABLE');
});

test('streams selected PostgreSQL dumps in deterministic order and restores through psql stdin', async () => {
  const runner = new FakePostgresqlRunner();
  const adapter = new PostgresqlLogicalAdapter({ processRunner: runner });
  const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), request(['orders', 'accounts']));
  let stored = null;
  await adapter.executeBackup(context(), prepared.adapterPlan, { async write(artifact) { const chunks = []; for await (const chunk of artifact.content) chunks.push(Buffer.from(chunk)); stored = { ...artifact, content: Buffer.concat(chunks) }; return stored; } });
  const text = stored.content.toString();
  assert.equal(text.indexOf('-- accounts'), text.indexOf('-- DeployerX') + '-- DeployerX PostgreSQL logical backup\n'.length);
  assert.equal(text.indexOf('-- accounts') < text.indexOf('-- orders'), true);
  const fingerprint = prepared.consistency.evidence.metadata.serverIdentityFingerprint;
  const restorePlan = await adapter.planRestore({}, { mode: 'original', confirmation: 'RESTORE_POSTGRESQL_ORIGINAL', connection: config(), metadata: stored.metadata, serverIdentityFingerprint: fingerprint, artifactPath: stored.path });
  const restored = await adapter.executeRestore(context(), restorePlan, { async open() { return Readable.from(stored.content); } });
  assert.equal(runner.restored.equals(stored.content), true);
  const validation = await adapter.validateRestore({ ...context(), connection: config() }, restored);
  assert.equal(validation.valid, true);
  assert.equal(validation.nativeIntegrityValidation, true);
  assert.equal(runner.calls.filter((call) => path.basename(call.executable) === 'pg_dump' && call.env.PGDATABASE).map((call) => call.env.PGDATABASE).join(','), 'accounts,orders');
});

test('fails PostgreSQL restore validation for missing objects and invalid indexes', async () => {
  const validate = async (runner) => {
    const adapter = new PostgresqlLogicalAdapter({ processRunner: runner });
    const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), request());
    return adapter.validateRestore({ ...context(), connection: config() }, { status: 'succeeded', metadata: prepared.consistency.evidence.metadata });
  };
  const missing = await validate(new FakePostgresqlRunner({ missingAfterBackup: true }));
  assert.equal(missing.valid, false);
  assert.equal(missing.checks.find((check) => check.id === 'expected-objects').status, 'fail');
  const invalid = await validate(new FakePostgresqlRunner({ invalidAfterBackup: true }));
  assert.equal(invalid.valid, false);
  assert.equal(invalid.checks.find((check) => check.id === 'native-integrity').status, 'fail');
});

test('persists canonical Supabase profile metadata while keeping the password SecretRef-backed', async () => {
  let persistedConnection = null;
  let storedSecret = null;
  const controlDatabase = {
    async transaction(work) {
      return work({
        create(kind, input) {
          if (kind === 'connection') {
            persistedConnection = { ...structuredClone(input), id: 'conn_supabase_1', revision: 1 };
            return structuredClone(persistedConnection);
          }
          return { ...structuredClone(input), revision: 1 };
        }
      });
    },
    repository(kind) {
      return {
        async list() { return kind === 'connection' && persistedConnection ? [structuredClone(persistedConnection)] : []; }
      };
    }
  };
  const secretStore = {
    async create(input) {
      storedSecret = input.value;
      return { id: 'sec_supabase_1', workspaceId: input.workspaceId, name: input.name, provider: 'test', scope: input.scope, providerKey: 'supabase-password', secretType: input.secretType, version: 1 };
    },
    async delete() {}
  };
  const adapter = new PostgresqlLogicalAdapter({ processRunner: new FakePostgresqlRunner() });
  const service = new PostgresqlConnectionService({ controlDatabase, secretStore, deviceId: 'device-1', adapter });
  const input = { ...supabaseConfig('session-pooler'), name: 'Supabase production', password: 'not-persisted-password' };
  delete input.passwordSecretRefId;
  const created = await service.create('workspace-1', 'actor-1', input);
  assert.equal(storedSecret, input.password);
  assert.equal(created.endpoint.deploymentProfile, 'supabase');
  assert.equal(created.endpoint.connectionMode, 'session-pooler');
  assert.equal(created.endpoint.projectRef, SUPABASE_PROJECT_REF);
  assert.equal(Object.hasOwn(created.endpoint, 'supabaseEndpointMode'), false);
  assert.deepEqual(created.secretRefIds, ['sec_supabase_1']);
  assert.equal(JSON.stringify(created).includes(input.password), false);
  const reconstructed = service.config(created);
  assert.equal(reconstructed.connectionMode, 'session-pooler');
  assert.equal(reconstructed.passwordSecretRefId, 'sec_supabase_1');
  const [listed] = await service.list('workspace-1');
  assert.deepEqual(listed.capabilities.backupMethods, ['logical']);
  assert.equal(listed.capabilities.transactionLogs.supported, false);
});

module.exports = { FakePostgresqlRunner, config, context, supabaseConfig };
