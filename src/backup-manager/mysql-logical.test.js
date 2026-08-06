const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  MysqlLogicalAdapter,
  dumpArguments,
  mysqlVersion,
  normalizeConfig,
  optionFileContents,
  serverVersion
} = require('./mysql-logical');

class FakeMysqlRunner {
  constructor(options = {}) {
    this.calls = [];
    this.nonTransactionalTables = options.nonTransactionalTables || 0;
    this.grants = options.grants || 'GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON *.* TO `backup`@`%`';
    this.dump = Buffer.from(options.dump || '-- MySQL dump\nCREATE DATABASE `orders`;\n');
    this.restored = Buffer.alloc(0);
    this.optionFiles = [];
    this.inventoryCalls = 0;
    this.missingAfterBackup = Boolean(options.missingAfterBackup);
    this.checkFailure = Boolean(options.checkFailure);
    this.binlogVariables = options.binlogVariables || '1\tROW\tFULL\tCRC32';
  }

  async inspect(input) {
    this.calls.push({ executable: input.executable, args: [...input.args] });
    const option = input.args.find((argument) => argument.startsWith('--defaults-extra-file='));
    if (option) this.optionFiles.push(await fs.readFile(option.slice('--defaults-extra-file='.length), 'utf8'));
  }

  async run(input) {
    await this.inspect(input);
    if (input.args.includes('--version')) return { exitCode: 0, stdout: `${path.basename(input.executable)}  Ver 8.0.36 for Win64 on x86_64`, stderr: '' };
    if (path.basename(input.executable).toLowerCase().startsWith('mysqlbinlog') && input.args.includes('--raw')) {
      const destination = input.args.find((argument) => argument.startsWith('--result-file=')).slice('--result-file='.length);
      await fs.writeFile(path.join(destination, input.args.at(-1)), Buffer.alloc(12000, 7));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const query = input.args.find((argument) => argument.startsWith('--execute='))?.slice('--execute='.length) || '';
    if (query === 'SHOW DATABASES;') return { exitCode: 0, stdout: 'information_schema\norders\naccounts\nmysql\n', stderr: '' };
    if (query.startsWith('SHOW GRANTS')) return { exitCode: 0, stdout: `${this.grants}\n`, stderr: '' };
    if (query.includes('@@global.log_bin')) return { exitCode: 0, stdout: `${this.binlogVariables}\n`, stderr: '' };
    if (query === 'SHOW BINARY LOG STATUS;') return { exitCode: 0, stdout: 'mysql-bin.000043\t7000\t\t\tuuid:1-30\n', stderr: '' };
    if (query === 'SHOW BINARY LOGS;') return { exitCode: 0, stdout: 'mysql-bin.000042\t10000\nmysql-bin.000043\t9000\n', stderr: '' };
    if (query.startsWith('SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables')) return { exitCode: 0, stdout: 'audit_view\tVIEW\ninvoices\tBASE TABLE\n', stderr: '' };
    if (query.startsWith("SELECT SCHEMA_NAME, '', 'database'")) {
      this.inventoryCalls += 1;
      const partial = query.includes('TABLE_NAME IN');
      const missing = this.missingAfterBackup && this.inventoryCalls > 1;
      const objects = partial
        ? (missing ? '' : 'orders\tinvoices\trelation\ttable\n')
        : `${missing ? '' : 'orders\tinvoices\trelation\ttable\n'}orders\taudit_view\trelation\tview\norders\tinvoices_after\ttrigger\ttrigger\norders\trefresh_orders\troutine\tprocedure\norders\tdaily_rollup\tevent\tevent\n`;
      return { exitCode: 0, stdout: `orders\t\tdatabase\t\n${objects}`, stderr: '' };
    }
    if (query.includes('information_schema.tables')) return { exitCode: 0, stdout: `${this.nonTransactionalTables}\n`, stderr: '' };
    if (query.startsWith('CHECK TABLE')) {
      if (this.checkFailure) return { exitCode: 0, stdout: 'orders.invoices\tcheck\terror\tCorrupt\n', stderr: '' };
      const rows = [...query.matchAll(/`([^`]+)`\.`([^`]+)`/g)].map((match) => `${match[1]}.${match[2]}\tcheck\tstatus\tOK`).join('\n');
      return { exitCode: 0, stdout: `${rows}\n`, stderr: '' };
    }
    if (query === 'SELECT 1;') return { exitCode: 0, stdout: '1\n', stderr: '' };
    if (query.includes('@@character_set_server')) return { exitCode: 0, stdout: '8.0.36\tuuid-123\tMySQL Community Server\tutf8mb4\tutf8mb4_0900_ai_ci\n', stderr: '' };
    return { exitCode: 0, stdout: '8.0.36\tuuid-123\tMySQL Community Server\n', stderr: '' };
  }

  stream(input) {
    const preparation = this.inspect(input);
    return { stdout: Readable.from((async function* (self) { await preparation; yield self.dump; })(this)), completion: preparation.then(() => ({ exitCode: 0, stderr: '' })), cancel() {} };
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
  return { host: 'db.example.com', port: 3306, username: 'backup', passwordSecretRefId: 'sec_12345678', tlsMode: 'verify-identity', timeoutMs: 5000, ...overrides };
}

function context() {
  return { resolveSecret: async () => 'p@ss word # not-in-args' };
}

test('normalizes MySQL 8 connection, tool, and option-file configuration', () => {
  assert.deepEqual(mysqlVersion('mysql  Ver 8.0.36 for Win64').text, '8.0.36');
  assert.equal(serverVersion('8.4.1-commercial').supported, true);
  assert.equal(serverVersion('5.7.44').supported, false);
  assert.equal(normalizeConfig(config()).port, 3306);
  assert.throws(() => normalizeConfig(config({ host: 'https://db.example.com' })));
  assert.throws(() => normalizeConfig(config({ mysqlExecutable: 'powershell.exe' })));
  const optionFile = optionFileContents(normalizeConfig(config()), 'line1\nline2"quoted');
  assert.match(optionFile, /password="line1\\nline2\\"quoted"/);
  assert.match(optionFile, /ssl-mode=VERIFY_IDENTITY/);
});

test('tests connections with a temporary option file and never puts passwords in arguments', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mysql-adapter-test-'));
  try {
    const runner = new FakeMysqlRunner();
    const adapter = new MysqlLogicalAdapter({ processRunner: runner, temporaryRoot, clock: () => '2026-08-04T00:00:00.000Z', now: (() => { let value = 0; return () => value += 5; })() });
    const result = await adapter.testConnection(context(), config());
    assert.equal(result.status, 'success');
    assert.equal(result.remotePlatform.version, '8.0.36');
    assert.match(result.endpointIdentity.serverFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(runner.calls.some((call) => call.args.some((argument) => argument.includes('p@ss word'))), false);
    assert.equal(runner.optionFiles.some((contents) => contents.includes('p@ss word # not-in-args')), true);
    assert.deepEqual(await fs.readdir(temporaryRoot), []);
  } finally { await fs.rm(temporaryRoot, { recursive: true, force: true }); }
});

test('discovers only user databases by default', async () => {
  const runner = new FakeMysqlRunner();
  const adapter = new MysqlLogicalAdapter({ processRunner: runner });
  const pages = [];
  for await (const page of adapter.discover(context(), { connection: config() })) pages.push(page);
  assert.deepEqual(pages[0].items.map((item) => item.name), ['accounts', 'orders']);
  assert.equal(pages[0].nextCursor, null);
});

test('discovers and restores an exact MySQL table selection within one database', async () => {
  const runner = new FakeMysqlRunner({ dump: '-- selected MySQL tables\n' });
  const adapter = new MysqlLogicalAdapter({ processRunner: runner, clock: () => '2026-08-04T00:00:00.000Z' });
  assert.equal(adapter.manifest().adapterVersion, '1.4.0');
  assert.equal(adapter.manifest().capabilities.restore.alternateTarget, true);
  assert.equal(adapter.manifest().capabilities.restore.nativeValidation, true);
  assert.equal(adapter.manifest().capabilities.selection.table, true);
  const pages = [];
  for await (const page of adapter.discover(context(), { connection: config(), kind: 'table', database: 'orders' })) pages.push(page);
  assert.deepEqual(pages[0].items.map((item) => [item.schema, item.name, item.objectType]), [['orders', 'audit_view', 'view'], ['orders', 'invoices', 'table']]);
  const selector = { databases: { include: [{ name: 'orders' }] }, tables: { include: [{ database: 'orders', schema: 'orders', name: 'invoices' }] } };
  const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), { connection: config(), selector, consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' } });
  assert.equal(prepared.adapterPlan.restoreDatabase, 'orders');
  assert.equal(prepared.adapterPlan.dumpArguments.includes('--databases'), false);
  assert.equal(prepared.adapterPlan.dumpArguments.includes('--routines'), false);
  assert.deepEqual(prepared.adapterPlan.dumpArguments.slice(-3), ['--skip-events', 'orders', 'invoices']);
  let stored;
  await adapter.executeBackup(context(), prepared.adapterPlan, { async write(artifact) { const chunks = []; for await (const chunk of artifact.content) chunks.push(Buffer.from(chunk)); stored = { ...artifact, content: Buffer.concat(chunks) }; return stored; } });
  const plan = await adapter.planRestore({}, { mode: 'original', confirmation: 'RESTORE_MYSQL_ORIGINAL', connection: config(), metadata: stored.metadata, serverIdentityFingerprint: prepared.consistency.evidence.serverIdentityFingerprint, artifactPath: stored.path });
  assert.equal(plan.restoreDatabase, 'orders');
  await adapter.executeRestore(context(), plan, { async open() { return Readable.from(stored.content); } });
  assert.equal(runner.calls.at(-1).args.at(-1), 'orders');
});

test('proves opt-in MySQL anchor coordinates only for one whole ROW/FULL database', async () => {
  const grants = 'GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, RELOAD, REPLICATION CLIENT, REPLICATION SLAVE ON *.* TO `backup`@`%`';
  const adapter = new MysqlLogicalAdapter({ processRunner: new FakeMysqlRunner({ grants }), clock: () => '2026-08-04T00:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const prepared = await registry.prepareBackup(ADAPTER_ID, context(), {
    connection: config(), selector: { databases: { include: [{ name: 'orders' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true }
  });
  assert.equal(prepared.consistency.captureCoordinates, true);
  assert.equal(prepared.adapterPlan.dumpArguments.includes('--source-data=2'), true);
  assert.deepEqual(prepared.adapterPlan.databaseMetadata.binaryLog, { enabled: true, format: 'ROW', rowImage: 'FULL', checksum: 'CRC32', privilegesVerified: true, toolVerified: true });
  await assert.rejects(registry.prepareBackup(ADAPTER_ID, context(), {
    connection: config(), selector: { databases: { include: [{ name: 'orders' }, { name: 'accounts' }] } }, consistency: { requestedLevel: 'application', captureCoordinates: true }
  }), (error) => error.code === 'MYSQL_PITR_SCOPE_INVALID');
  const unsafe = new DatabaseAdapterRegistry([new MysqlLogicalAdapter({ processRunner: new FakeMysqlRunner({ grants, binlogVariables: '1\tMIXED\tFULL\tCRC32' }) })]);
  await assert.rejects(unsafe.prepareBackup(ADAPTER_ID, context(), {
    connection: config(), selector: { databases: { include: [{ name: 'orders' }] } }, consistency: { requestedLevel: 'application', captureCoordinates: true }
  }), (error) => error.code === 'DATABASE_COORDINATE_CAPTURE_UNPROVEN');
});

test('plans and downloads a contiguous raw MySQL binary-log interval', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mysql-binlog-test-'));
  try {
    const grants = 'GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, RELOAD, REPLICATION CLIENT, REPLICATION SLAVE ON *.* TO `backup`@`%`';
    const runner = new FakeMysqlRunner({ grants });
    const adapter = new MysqlLogicalAdapter({ processRunner: runner, temporaryRoot, clock: () => '2026-08-04T10:15:00.000Z' });
    const tested = await adapter.testConnection(context(), config());
    const plan = await adapter.prepareBinaryLogCapture(context(), {
      connection: config(), selector: { databases: { include: [{ name: 'orders' }] } },
      startCoordinate: { engine: 'mysql', file: 'mysql-bin.000042', position: 8192, capturedAt: '2026-08-04T10:00:00.000Z', serverIdentityFingerprint: tested.endpointIdentity.serverFingerprint }
    });
    assert.deepEqual(plan.segments.map((segment) => [segment.file, segment.startPosition, segment.stopPosition]), [['mysql-bin.000042', 8192, 10000], ['mysql-bin.000043', 4, 7000]]);
    const destination = path.join(temporaryRoot, 'raw');
    await fs.mkdir(destination);
    const files = await adapter.captureBinaryLogs(context(), plan, destination);
    assert.deepEqual(files.map((file) => [file.file, file.sizeBytes]), [['mysql-bin.000042', 12000], ['mysql-bin.000043', 12000]]);
    assert.equal(runner.calls.some((call) => call.args.some((argument) => argument.includes('p@ss word'))), false);
  } finally { await fs.rm(temporaryRoot, { recursive: true, force: true }); }
});

test('preflights MySQL tools, privileges, identity, and transactional consistency before planning', async () => {
  const runner = new FakeMysqlRunner();
  const adapter = new MysqlLogicalAdapter({ processRunner: runner, clock: () => '2026-08-04T00:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const prepared = await registry.prepareBackup(ADAPTER_ID, context(), {
    connection: config(),
    selector: { databases: { include: [{ name: 'orders' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' }
  });
  assert.equal(prepared.consistency.proven, true);
  assert.equal(prepared.consistency.method, 'transaction-snapshot');
  assert.equal(prepared.adapterPlan.operation, 'mysql-logical-backup');
  assert.deepEqual(prepared.adapterPlan.dumpArguments.slice(-2), ['--databases', 'orders']);
  assert.equal(prepared.adapterPlan.databaseMetadata.characterSet, 'utf8mb4');
  assert.equal(dumpArguments(config(), { allDatabases: true }).at(-1), '--all-databases');
});

test('refuses non-InnoDB selections and insufficient logical-backup grants', async () => {
  const nonTransactional = new DatabaseAdapterRegistry([new MysqlLogicalAdapter({ processRunner: new FakeMysqlRunner({ nonTransactionalTables: 2 }) })]);
  const request = { connection: config(), selector: { databases: { include: [{ name: 'orders' }] } }, consistency: { requestedLevel: 'application' } };
  await assert.rejects(nonTransactional.prepareBackup(ADAPTER_ID, context(), request), (error) => error.code === 'DATABASE_CONSISTENCY_UNPROVEN');
  const missingGrant = new DatabaseAdapterRegistry([new MysqlLogicalAdapter({ processRunner: new FakeMysqlRunner({ grants: 'GRANT SELECT ON *.* TO `backup`@`%`' }) })]);
  await assert.rejects(missingGrant.prepareBackup(ADAPTER_ID, context(), request), (error) => error.code === 'DATABASE_PRIVILEGE_MISSING');
});

test('streams a logical dump through the artifact sink and restores it through mysql stdin', async () => {
  const runner = new FakeMysqlRunner({ dump: '-- dump bytes\nSELECT 1;\n' });
  const adapter = new MysqlLogicalAdapter({ processRunner: runner });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const prepared = await registry.prepareBackup(ADAPTER_ID, context(), {
    connection: config(), selector: { databases: { include: [{ name: 'orders' }] } }, consistency: { requestedLevel: 'application' }
  });
  let stored = null;
  const result = await adapter.executeBackup(context(), prepared.adapterPlan, { async write(artifact) { const chunks = []; for await (const chunk of artifact.content) chunks.push(Buffer.from(chunk)); stored = { ...artifact, content: Buffer.concat(chunks) }; return { kind: artifact.kind, path: artifact.path }; } });
  assert.equal(result.status, 'succeeded');
  assert.equal(stored.content.toString(), '-- dump bytes\nSELECT 1;\n');
  assert.equal(stored.kind, 'database-dump');
  const fingerprint = prepared.consistency.evidence.metadata.serverIdentityFingerprint;
  const restorePlan = await adapter.planRestore({}, { mode: 'original', confirmation: 'RESTORE_MYSQL_ORIGINAL', connection: config(), metadata: stored.metadata, serverIdentityFingerprint: fingerprint, artifactPath: stored.path });
  const restored = await adapter.executeRestore(context(), restorePlan, { async open() { return Readable.from(stored.content); } });
  assert.equal(restored.status, 'succeeded');
  assert.equal(runner.restored.toString(), stored.content.toString());
  const validation = await adapter.validateRestore({ ...context(), connection: config() }, restored);
  assert.equal(validation.valid, true);
  assert.equal(validation.nativeIntegrityValidation, true);
  assert.deepEqual(validation.checks.map((check) => check.status), ['pass', 'pass', 'pass']);
});

test('fails MySQL restore validation for missing objects and native table corruption', async () => {
  const validate = async (runner) => {
    const adapter = new MysqlLogicalAdapter({ processRunner: runner });
    const prepared = await new DatabaseAdapterRegistry([adapter]).prepareBackup(ADAPTER_ID, context(), { connection: config(), selector: { databases: { include: [{ name: 'orders' }] } }, consistency: { requestedLevel: 'application' } });
    return adapter.validateRestore({ ...context(), connection: config() }, { status: 'succeeded', metadata: prepared.consistency.evidence.metadata });
  };
  const missing = await validate(new FakeMysqlRunner({ missingAfterBackup: true }));
  assert.equal(missing.valid, false);
  assert.equal(missing.checks.find((check) => check.id === 'expected-objects').status, 'fail');
  const corrupt = await validate(new FakeMysqlRunner({ checkFailure: true }));
  assert.equal(corrupt.valid, false);
  assert.equal(corrupt.checks.find((check) => check.id === 'native-integrity').status, 'fail');
});

module.exports = { FakeMysqlRunner, config, context };
