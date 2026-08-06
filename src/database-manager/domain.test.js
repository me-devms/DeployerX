const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DatabaseManagerValidationError,
  MAX_QUERY_PAGE_SIZE,
  normalizeDatabaseTaskInput,
  normalizeDriverManifest,
  normalizeNotebookInput,
  normalizeProfileInput,
  normalizeQueryRequest,
  normalizeQueryResult,
  normalizeQueryHistoryInput,
  normalizeSavedQueryInput,
  normalizeSchemaSnapshot,
  normalizeSchemaSnapshotRequest,
  projectProfileForCloud
} = require('./domain');

function profile(overrides = {}) {
  return {
    name: 'Production PostgreSQL',
    driverId: 'postgresql',
    sharedConnectionId: 'conn_database_1',
    projectId: 'project-1',
    endpoint: { kind: 'network', host: 'DB.Example.COM.', port: 5432 },
    database: 'app',
    defaultSchema: 'public',
    environment: 'production',
    accessMode: 'read-only',
    tags: ['Critical', 'production', 'critical'],
    ssl: { mode: 'verify-full', caPathRequired: true },
    tunnel: { type: 'server', projectId: 'project-1' },
    credentialSlots: [{ id: 'password', type: 'password', label: 'Password' }],
    settings: { applicationName: 'DeployerX' },
    startupScript: 'SET statement_timeout = 60000',
    appearance: { icon: 'database', accentColor: '#2563eb' },
    ...overrides
  };
}

test('normalizes workspace database profiles without accepting secrets', () => {
  const normalized = normalizeProfileInput(profile());
  assert.equal(normalized.endpoint.host, 'db.example.com');
  assert.equal(normalized.projectId, 'project-1');
  assert.equal(normalized.accessMode, 'read-only');
  assert.deepEqual(normalized.tags, ['critical', 'production']);
  assert.equal(normalized.queryTimeoutMs, 60000);
  assert.throws(
    () => normalizeProfileInput(profile({ settings: { apiToken: 'plaintext' } })),
    (error) => error instanceof DatabaseManagerValidationError && error.code === 'DATABASE_MANAGER_SECRET_REFERENCE_REQUIRED'
  );
  assert.throws(
    () => normalizeProfileInput(profile({ endpoint: { kind: 'network', host: 'postgres://user:pass@example.test/db', port: 5432 } })),
    (error) => error.code === 'DATABASE_MANAGER_HOST_INVALID'
  );
});

test('projects only cloud-safe profile metadata', () => {
  const projected = projectProfileForCloud(profile());
  assert.equal(projected.name, 'Production PostgreSQL');
  assert.equal(projected.endpoint.host, 'db.example.com');
  assert.equal(projected.startupScript, undefined);
  assert.equal(projected.settings, undefined);
  assert.equal(JSON.stringify(projected).includes('plaintext'), false);

  const localFile = projectProfileForCloud(profile({
    driverId: 'sqlite',
    endpoint: { kind: 'file', path: 'C:\\secret\\database.sqlite' },
    tunnel: { type: 'none' },
    projectId: null
  }));
  assert.deepEqual(localFile.endpoint, { kind: 'file', localResourceRequired: true });
  assert.equal(JSON.stringify(localFile).includes('C:\\secret'), false);
});

test('normalizes built-in and plugin driver manifests', () => {
  const manifest = normalizeDriverManifest({
    id: 'clickhouse',
    name: 'ClickHouse',
    version: '0.1.1',
    source: 'plugin',
    defaultPort: 8123,
    sqlDialect: 'postgres',
    identifierQuote: '"',
    capabilities: { query: true, batch: true, explain: true, supportsSsl: true },
    credentialSlots: [{ id: 'password', type: 'password', label: 'Password', required: false }],
    settings: { fields: [{ key: 'region', label: 'Region' }, { key: 'extra_properties', label: 'Extra properties' }] }
  });
  assert.equal(manifest.id, 'clickhouse');
  assert.equal(manifest.capabilities.explain, true);
  assert.equal(manifest.capabilities.supportsSsh, true);
  assert.equal(manifest.sqlDialect, 'postgresql');
  assert.equal(manifest.identifierQuote, '"');
  assert.deepEqual(manifest.settings.fields.map((field) => field.key), ['region']);
  assert.deepEqual(manifest.credentialSlots.map((slot) => slot.id), ['password', 'extra-properties']);
  assert.throws(() => normalizeDriverManifest({ id: '../unsafe', name: 'Unsafe', version: '1.0.0' }));
  assert.throws(() => normalizeDriverManifest({ id: 'vendor', name: 'Vendor', version: '1.0.0', sqlDialect: 'untrusted-script' }));
});

test('normalizes query requests with bounded pagination', () => {
  const request = normalizeQueryRequest({ profileId: 'profile-1', query: 'select * from users', source: 'editor' });
  assert.match(request.requestId, /^dbq_/);
  assert.equal(request.page, 1);
  assert.equal(request.pageSize, 100);
  assert.throws(() => normalizeQueryRequest({ profileId: 'profile-1', query: 'select 1', pageSize: MAX_QUERY_PAGE_SIZE + 1 }));
  assert.throws(() => normalizeQueryRequest({ profileId: 'profile-1', query: '   ' }));
});

test('normalizes typed query results and rejects malformed row widths', () => {
  const result = normalizeQueryResult({
    columns: [{ name: 'id', dataType: 'integer' }, 'payload'],
    rows: [[1, { ok: true }], [2, Buffer.from('binary')]],
    affectedRows: 0,
    pagination: { page: 1, pageSize: 100, totalRows: 2, hasMore: false },
    executionTimeMs: 4.5,
    warnings: ['Sample warning']
  });
  assert.equal(result.columns[0].dataType, 'integer');
  assert.equal(result.rows[1][1].type, 'binary');
  assert.equal(result.pagination.totalRows, 2);
  assert.throws(
    () => normalizeQueryResult({ columns: ['id', 'name'], rows: [[1]] }),
    (error) => error.code === 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID'
  );
});

test('normalizes bounded schema requests and snapshots', () => {
  const request = normalizeSchemaSnapshotRequest({ profileId: 'profile-a', maxTables: 200, maxColumnsPerTable: 300 });
  assert.equal(request.maxTables, 200);
  assert.match(request.requestId, /^dbs_/);
  const snapshot = normalizeSchemaSnapshot({
    database: 'orders',
    schemas: [{ name: 'public', tables: [{ name: 'customers', type: 'table', columns: [{ name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true }, { name: 'email', dataType: 'TEXT' }] }] }],
    warnings: [], truncated: false
  });
  assert.equal(snapshot.schemas[0].tables[0].columns[0].primaryKey, true);
  assert.equal(snapshot.schemas[0].tables[0].columns[1].nullable, true);
  assert.throws(() => normalizeSchemaSnapshotRequest({ profileId: 'profile-a', maxTables: 1001 }), /table limit/);
  assert.throws(() => normalizeSchemaSnapshot({ schemas: [{ name: 'public', tables: [{ name: 'bad', columns: 'invalid' }] }] }), (error) => error.code === 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
});

test('normalizes saved queries and safe query history metadata', () => {
  assert.deepEqual(normalizeSavedQueryInput({
    profileId: 'dbp_orders',
    name: ' Latest orders ',
    description: 'Operations dashboard source',
    query: ' SELECT * FROM orders; ',
    tags: ['Ops', 'ops', 'Recent']
  }), {
    profileId: 'dbp_orders',
    name: 'Latest orders',
    description: 'Operations dashboard source',
    query: 'SELECT * FROM orders;',
    tags: ['ops', 'recent']
  });
  assert.deepEqual(normalizeQueryHistoryInput({
    profileId: 'dbp_orders', query: 'SELECT 1', status: 'succeeded', classification: 'read',
    source: 'editor', executionTimeMs: 8.5, rowCount: 1, affectedRows: 0
  }), {
    profileId: 'dbp_orders', query: 'SELECT 1', status: 'succeeded', classification: 'read',
    source: 'editor', executionTimeMs: 8.5, rowCount: 1, affectedRows: 0, errorCode: null, safeMessage: null
  });
  assert.throws(() => normalizeSavedQueryInput({ profileId: 'dbp_orders', name: 'Empty', query: '' }), /empty or too large/);
  assert.throws(() => normalizeQueryHistoryInput({ profileId: 'dbp_orders', query: 'SELECT 1', status: 'pending' }), /status/);
  assert.throws(() => normalizeQueryHistoryInput({ profileId: 'dbp_orders', query: 'SELECT 1', status: 'failed', errorCode: 'x'.repeat(121) }), /error code/);
});

test('normalizes bounded SQL, Markdown, and chart notebook cells without runtime results', () => {
  assert.deepEqual(normalizeNotebookInput({
    profileId: 'dbp_orders', name: 'Daily review', description: 'Operations runbook', tags: ['Ops', 'ops'],
    cells: [
      { id: 'intro', type: 'markdown', content: '# Daily review', collapsed: true },
      { id: 'query', type: 'sql', content: 'SELECT * FROM orders' },
      { id: 'chart', type: 'chart', content: 'not persisted', chart: { sourceCellId: 'query', chartType: 'line', categoryColumn: 'day', valueColumn: 'total' } }
    ]
  }), {
    profileId: 'dbp_orders', name: 'Daily review', description: 'Operations runbook', tags: ['ops'],
    cells: [
      { id: 'intro', type: 'markdown', content: '# Daily review', collapsed: true },
      { id: 'query', type: 'sql', content: 'SELECT * FROM orders', collapsed: false },
      { id: 'chart', type: 'chart', content: '', collapsed: false, chart: { sourceCellId: 'query', chartType: 'line', categoryColumn: 'day', valueColumn: 'total' } }
    ]
  });
  assert.throws(() => normalizeNotebookInput({ profileId: 'dbp_orders', name: 'Empty', cells: [] }), (error) => error.code === 'DATABASE_MANAGER_NOTEBOOK_INVALID');
  assert.throws(() => normalizeNotebookInput({ profileId: 'dbp_orders', name: 'Duplicate', cells: [{ id: 'same', type: 'sql', content: '' }, { id: 'same', type: 'markdown', content: '' }] }), /unique/);
  assert.throws(() => normalizeNotebookInput({ profileId: 'dbp_orders', name: 'Unknown', cells: [{ id: 'cell', type: 'diagram', content: '' }] }), /type/);
  assert.throws(() => normalizeNotebookInput({ profileId: 'dbp_orders', name: 'Broken chart', cells: [{ id: 'chart', type: 'chart', chart: { sourceCellId: 'missing' } }] }), /reference a SQL cell/);
});

test('normalizes bounded persistent database task progress', () => {
  assert.deepEqual(normalizeDatabaseTaskInput({
    profileId: 'dbp_orders', type: 'import', label: 'Import customers', state: 'running', canCancel: true,
    progress: { phase: 'loading', percent: 35.5, itemsTotal: 100, itemsCompleted: 35, bytesTotal: 2048, bytesCompleted: 1024, message: 'Loading rows' },
    startedAt: '2026-08-05T12:00:00.000Z'
  }), {
    profileId: 'dbp_orders', type: 'import', label: 'Import customers', state: 'running', canCancel: true,
    progress: { phase: 'loading', percent: 35.5, itemsTotal: 100, itemsCompleted: 35, bytesTotal: 2048, bytesCompleted: 1024, message: 'Loading rows' },
    safeMessage: null, startedAt: '2026-08-05T12:00:00.000Z', completedAt: null
  });
  assert.equal(normalizeDatabaseTaskInput({ profileId: 'dbp_orders', type: 'dump', label: 'Dump', state: 'succeeded', canCancel: true }).canCancel, false);
  assert.throws(() => normalizeDatabaseTaskInput({ profileId: 'dbp_orders', type: 'unknown', label: 'Bad' }), /type/);
  assert.throws(() => normalizeDatabaseTaskInput({ profileId: 'dbp_orders', type: 'import', label: 'Bad', progress: { percent: 101 } }), /percentage/);
  assert.throws(() => normalizeDatabaseTaskInput({ profileId: 'dbp_orders', type: 'import', label: 'Bad', progress: { itemsTotal: 2, itemsCompleted: 3 } }), /exceeds/);
});
