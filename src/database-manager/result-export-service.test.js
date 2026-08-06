const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseResultExportService } = require('./result-export-service');

function result(overrides = {}) {
  return {
    columns: [{ name: 'id', dataType: 'INTEGER' }], rows: [[1]], affectedRows: 0, truncated: false,
    pagination: { page: 1, pageSize: 100, totalRows: null, hasMore: false }, executionTimeMs: 2, warnings: [], additionalResults: [],
    ...overrides
  };
}

function streamingFixture(pages, overrides = {}) {
  const observed = { opened: [], renamed: [], removed: [], requests: [], cancelled: [], content: '' };
  const queryService = {
    async executeReadPage(workspaceId, actorId, request) {
      observed.requests.push({ workspaceId, actorId, ...request });
      const pageResult = pages[request.page - 1];
      if (pageResult instanceof Error) throw pageResult;
      return { classification: 'read', result: pageResult };
    },
    cancel(workspaceId, actorId, requestId) {
      observed.cancelled.push({ workspaceId, actorId, requestId });
      return { requestId, cancelled: true };
    }
  };
  const service = new DatabaseResultExportService({
    showSaveDialog: async () => ({ canceled: false, filePath: 'C:\\Exports\\orders.csv' }),
    writeFile: async () => {},
    openFile: async (filePath, flags) => {
      observed.opened.push({ filePath, flags });
      return {
        write: async (content) => { observed.content += content; },
        close: async () => {}
      };
    },
    renameFile: async (...args) => { observed.renamed.push(args); },
    removeFile: async (filePath) => { observed.removed.push(filePath); },
    queryService,
    randomUUID: () => 'fixed-id',
    ...overrides
  });
  return { observed, queryService, service };
}

test('writes only to the native-dialog selection and returns path-free evidence', async () => {
  const observed = { dialog: null, write: null };
  const service = new DatabaseResultExportService({
    showSaveDialog: async (options) => { observed.dialog = options; return { canceled: false, filePath: 'C:\\Exports\\orders.csv' }; },
    writeFile: async (...args) => { observed.write = args; }
  });
  const exported = await service.export({ format: 'csv', suggestedName: 'Orders: page 1', filePath: 'C:\\untrusted\\ignored.csv', result: result() });
  assert.equal(observed.dialog.defaultPath, 'Orders- page 1.csv');
  assert.equal(observed.write[0], 'C:\\Exports\\orders.csv');
  assert.equal(observed.write[2], 'utf8');
  assert.deepEqual(exported, { cancelled: false, format: 'csv', displayName: 'orders.csv', byteLength: 5 });
  assert.equal(JSON.stringify(exported).includes('Exports'), false);
});

test('handles cancellation without writing and rejects non-file formats', async () => {
  let writes = 0;
  const service = new DatabaseResultExportService({ showSaveDialog: async () => ({ canceled: true }), writeFile: async () => { writes += 1; } });
  assert.deepEqual(await service.export({ format: 'json', result: result() }), { cancelled: true, format: 'json' });
  assert.equal(writes, 0);
  await assert.rejects(service.export({ format: 'tsv', result: result() }), (error) => error.code === 'DATABASE_MANAGER_RESULT_EXPORT_FORMAT_INVALID');
});

test('maps dialog and file failures to path-free safe errors', async () => {
  const dialogFailure = new DatabaseResultExportService({ showSaveDialog: async () => { throw new Error('native dialog details'); }, writeFile: async () => {} });
  await assert.rejects(dialogFailure.export({ format: 'csv', result: result() }), (error) => error.code === 'DATABASE_MANAGER_RESULT_EXPORT_DIALOG_FAILED' && !error.message.includes('details'));
  const writeFailure = new DatabaseResultExportService({ showSaveDialog: async () => ({ filePath: 'C:\\private\\orders.csv' }), writeFile: async () => { throw new Error('C:\\private\\orders.csv denied'); } });
  await assert.rejects(writeFailure.export({ format: 'csv', result: result() }), (error) => error.code === 'DATABASE_MANAGER_RESULT_EXPORT_WRITE_FAILED' && !error.message.includes('private'));
});

test('streams full CSV exports page by page and atomically publishes path-free evidence', async () => {
  const pages = [
    result({ rows: [[1], ['=2+2']], pagination: { page: 1, pageSize: 2, totalRows: 3, hasMore: true } }),
    result({ rows: [[3]], pagination: { page: 2, pageSize: 2, totalRows: 3, hasMore: false } })
  ];
  const values = streamingFixture(pages);
  const exported = await values.service.exportQuery('workspace-a', 'tester', {
    requestId: 'export-a', profileId: 'profile-a', query: 'SELECT id FROM orders', pageSize: 2, format: 'csv', suggestedName: 'Orders all rows'
  });
  assert.equal(values.observed.content, "id\r\n1\r\n'=2+2\r\n3");
  assert.deepEqual(values.observed.requests.map(({ requestId, page, pageSize }) => ({ requestId, page, pageSize })), [
    { requestId: 'export-a_page_1', page: 1, pageSize: 2 },
    { requestId: 'export-a_page_2', page: 2, pageSize: 2 }
  ]);
  assert.match(values.observed.opened[0].filePath, /\.orders\.csv\.fixed-id\.tmp$/);
  assert.equal(values.observed.opened[0].flags, 'wx');
  assert.deepEqual(values.observed.renamed[0], [values.observed.opened[0].filePath, 'C:\\Exports\\orders.csv']);
  assert.deepEqual(exported, { cancelled: false, format: 'csv', requestId: 'export-a', displayName: 'orders.csv', byteLength: Buffer.byteLength(values.observed.content), rowCount: 3, pageCount: 2 });
  assert.equal(JSON.stringify(exported).includes('Exports'), false);
});

test('streams valid typed JSON across page boundaries', async () => {
  const pages = [
    result({ rows: [[{ type: 'binary', byteLength: 1, base64: 'AQ==' }]], pagination: { page: 1, pageSize: 1, totalRows: null, hasMore: true }, warnings: ['First warning'] }),
    result({ rows: [[null]], pagination: { page: 2, pageSize: 1, totalRows: null, hasMore: false }, executionTimeMs: 3, warnings: ['Second warning'] })
  ];
  const values = streamingFixture(pages, { showSaveDialog: async () => ({ filePath: 'C:\\Exports\\orders.json' }) });
  const exported = await values.service.exportQuery('workspace-a', 'tester', {
    requestId: 'export-json', profileId: 'profile-a', query: 'SELECT payload FROM orders', pageSize: 1, format: 'json'
  });
  const parsed = JSON.parse(values.observed.content);
  assert.deepEqual(parsed.rows, [[{ type: 'binary', byteLength: 1, base64: 'AQ==' }], [null]]);
  assert.deepEqual(parsed.warnings, ['First warning', 'Second warning']);
  assert.equal(parsed.executionTimeMs, 5);
  assert.equal(exported.rowCount, 2);
});

test('removes temporary output when a streaming export exceeds its row limit', async () => {
  const values = streamingFixture([
    result({ rows: [[1], [2]], pagination: { page: 1, pageSize: 2, totalRows: 3, hasMore: true } })
  ], { maxStreamRows: 2 });
  await assert.rejects(
    values.service.exportQuery('workspace-a', 'tester', { requestId: 'export-large', profileId: 'profile-a', query: 'SELECT id FROM orders', pageSize: 2, format: 'csv' }),
    (error) => error.code === 'DATABASE_MANAGER_RESULT_EXPORT_TOO_LARGE'
  );
  assert.deepEqual(values.observed.removed, [values.observed.opened[0].filePath]);
  assert.equal(values.observed.renamed.length, 0);
});

test('removes temporary output when a streaming export exceeds its byte limit', async () => {
  const values = streamingFixture([result()], { maxStreamBytes: 2 });
  await assert.rejects(
    values.service.exportQuery('workspace-a', 'tester', { requestId: 'export-bytes', profileId: 'profile-a', query: 'SELECT id FROM orders', pageSize: 100, format: 'csv' }),
    (error) => error.code === 'DATABASE_MANAGER_RESULT_EXPORT_TOO_LARGE'
  );
  assert.deepEqual(values.observed.removed, [values.observed.opened[0].filePath]);
  assert.equal(values.observed.renamed.length, 0);
});

test('cancels an active page query and removes partial output', async () => {
  let release;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const values = streamingFixture([]);
  values.queryService.executeReadPage = async (_workspaceId, _actorId, request) => {
    values.observed.requests.push(request);
    started();
    return new Promise((_resolve, reject) => { release = () => reject(Object.assign(new Error('cancelled'), { code: 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED' })); });
  };
  values.queryService.cancel = (workspaceId, actorId, requestId) => {
    values.observed.cancelled.push({ workspaceId, actorId, requestId });
    release();
    return { requestId, cancelled: true };
  };
  const exporting = values.service.exportQuery('workspace-a', 'tester', {
    requestId: 'export-cancel', profileId: 'profile-a', query: 'SELECT id FROM orders', pageSize: 100, format: 'csv'
  });
  await running;
  assert.deepEqual(values.service.cancel('workspace-a', 'tester', 'export-cancel'), { requestId: 'export-cancel', cancelled: true });
  assert.deepEqual(await exporting, { cancelled: true, format: 'csv', requestId: 'export-cancel' });
  assert.equal(values.observed.cancelled[0].requestId, 'export-cancel_page_1');
  assert.deepEqual(values.observed.removed, [values.observed.opened[0].filePath]);
});
