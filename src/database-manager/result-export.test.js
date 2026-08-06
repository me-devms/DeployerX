const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_EXPORT_INPUT_BYTES,
  normalizeResultExportFileName,
  serializeDatabaseQueryResult,
  serializeDatabaseResultColumns,
  serializeDatabaseResultRows
} = require('./result-export');

function result(overrides = {}) {
  return {
    columns: [{ name: 'name', dataType: 'TEXT' }, { name: 'value', dataType: 'TEXT' }],
    rows: [['A, "quoted"\nrow', '=2+2'], ['plain', null]],
    affectedRows: 0,
    truncated: false,
    pagination: { page: 1, pageSize: 100, totalRows: null, hasMore: false },
    executionTimeMs: 4,
    warnings: [],
    additionalResults: [],
    ...overrides
  };
}

test('serializes RFC-style CSV and neutralizes spreadsheet formulas', () => {
  const serialized = serializeDatabaseQueryResult({ format: 'csv', result: result() });
  assert.equal(serialized.extension, 'csv');
  assert.equal(serialized.content, 'name,value\r\n"A, ""quoted""\nrow",\'=2+2\r\nplain,');
});

test('serializes row-safe TSV for clipboard copy', () => {
  const serialized = serializeDatabaseQueryResult({ format: 'tsv', result: result() });
  assert.equal(serialized.content, 'name\tvalue\r\nA, "quoted"\\nrow\t\'=2+2\r\nplain\t');
});

test('preserves typed JSON values and binary payloads', () => {
  const serialized = serializeDatabaseQueryResult({
    format: 'json',
    result: result({ columns: [{ name: 'payload', dataType: 'BLOB' }], rows: [[{ type: 'binary', byteLength: 3, base64: 'AQID' }]] })
  });
  assert.deepEqual(JSON.parse(serialized.content).rows, [[{ type: 'binary', byteLength: 3, base64: 'AQID' }]]);
});

test('rejects malformed, unsupported, and oversized exports', () => {
  assert.throws(() => serializeDatabaseQueryResult({ format: 'xml', result: result() }), /not supported/);
  assert.throws(() => serializeDatabaseQueryResult({ format: 'csv', result: result({ rows: [['too', 'wide', 'row']] }) }), (error) => error.code === 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  assert.throws(() => serializeDatabaseQueryResult({ format: 'csv', result: result({ rows: [['x'.repeat(MAX_EXPORT_INPUT_BYTES), '']] }) }), (error) => error.code === 'DATABASE_MANAGER_RESULT_EXPORT_TOO_LARGE');
});

test('normalizes safe export file names without accepting renderer paths', () => {
  assert.equal(normalizeResultExportFileName('Production: orders/results', 'csv'), 'Production- orders-results.csv');
  assert.equal(normalizeResultExportFileName('report.JSON', 'json'), 'report.JSON');
});

test('serializes bounded page fragments for streaming exports', () => {
  const value = result();
  assert.equal(serializeDatabaseResultColumns(value.columns, 'csv'), 'name,value');
  assert.equal(serializeDatabaseResultRows(value.rows, 'csv'), '"A, ""quoted""\nrow",\'=2+2\r\nplain,');
  assert.equal(serializeDatabaseResultRows(value.rows, 'json'), '["A, \\"quoted\\"\\nrow","=2+2"],\n["plain",null]');
});
