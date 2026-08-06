const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js/dist/sql-asm.js');
const { DatabaseConnectionService } = require('./connection-service');
const { DirectDatabaseDriverRuntime } = require('./direct-driver-runtime');
const { DatabaseDriverRuntimeRegistry } = require('./driver-runtime');
const { DatabaseQueryService } = require('./query-service');
const { DatabaseSchemaService } = require('./schema-service');

test('runs the SQLite connection, schema, and query workflow through the direct runtime', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-direct-db-'));
  const databasePath = path.join(temporaryRoot, 'workflow.sqlite3');
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES (1, 'DeployerX'), (2, 'Tabularis');
  `);
  await fs.writeFile(databasePath, Buffer.from(database.export()), { flag: 'wx' });
  database.close();

  const profile = Object.freeze({
    id: 'profile-direct-sqlite',
    name: 'Direct SQLite',
    revision: 1,
    driverId: 'sqlite',
    endpoint: Object.freeze({ kind: 'file', localResourceRequired: true }),
    database: null,
    defaultSchema: null,
    accessMode: 'read-write',
    environment: 'development',
    ssl: Object.freeze({ mode: 'disabled' }),
    tunnel: Object.freeze({ type: 'none' }),
    settings: Object.freeze({}),
    queryTimeoutMs: 5000,
    credentialSecretRefs: Object.freeze([])
  });
  const profileService = { get: async (_workspaceId, profileId) => profileId === profile.id ? profile : null };
  const secretStore = { resolve: async () => { throw new Error('SQLite must not resolve a secret.'); } };
  const localResourceResolver = async ({ profileId }) => {
    assert.equal(profileId, profile.id);
    return databasePath;
  };
  const runtime = new DirectDatabaseDriverRuntime();
  const runtimeRegistry = new DatabaseDriverRuntimeRegistry().register('sqlite', runtime);
  const connectionService = new DatabaseConnectionService({
    profileService,
    secretStore,
    runtimeRegistry,
    localResourceResolver
  });
  const schemaService = new DatabaseSchemaService({
    profileService,
    secretStore,
    runtimeRegistry,
    connectionService,
    localResourceResolver
  });
  const queryService = new DatabaseQueryService({
    profileService,
    secretStore,
    runtimeRegistry,
    connectionService,
    localResourceResolver
  });

  t.after(async () => {
    await connectionService.closeAll().catch(() => {});
    await runtimeRegistry.stopAll();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  const tested = await connectionService.test('workspace-a', 'tester', profile.id);
  assert.equal(tested.status, 'success');

  const opened = await connectionService.open('workspace-a', 'tester', profile.id);
  assert.equal(opened.state, 'ready');
  assert.equal((await connectionService.status('workspace-a', 'tester', profile.id)).state, 'ready');

  const schema = await schemaService.load('workspace-a', 'tester', {
    requestId: 'schema-direct-workflow',
    profileId: profile.id
  });
  const projects = schema.snapshot.schemas.flatMap((entry) => entry.tables).find((table) => table.name === 'projects');
  assert.deepEqual(projects.columns.map((column) => column.name), ['id', 'name']);
  assert.equal(projects.columns[0].primaryKey, true);

  const query = await queryService.execute('workspace-a', 'tester', {
    requestId: 'query-direct-workflow',
    profileId: profile.id,
    query: 'SELECT id, name FROM projects ORDER BY id',
    page: 1,
    pageSize: 10
  });
  assert.deepEqual(query.result.rows, [[1, 'DeployerX'], [2, 'Tabularis']]);

  const closed = await connectionService.close('workspace-a', 'tester', profile.id);
  assert.equal(closed.closed, true);
  assert.equal((await connectionService.status('workspace-a', 'tester', profile.id)).state, 'closed');
});
