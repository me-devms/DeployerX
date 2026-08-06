const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_ROW_HEIGHT,
  MAX_RENDER_ROWS,
  getVisibleRange,
  inspectValue,
  normalizeSelection
} = require('./result-grid');

test('computes a bounded visible result window with stable spacer heights', () => {
  const range = getVisibleRange({ rowCount: 5000, scrollTop: 3400, viewportHeight: 680, rowHeight: DEFAULT_ROW_HEIGHT, overscanRows: 8 });
  assert.equal(range.start, 92);
  assert.equal(range.end - range.start, 36);
  assert.ok(range.end - range.start <= MAX_RENDER_ROWS);
  assert.equal(range.topSpacer, 92 * DEFAULT_ROW_HEIGHT);
  assert.equal(range.bottomSpacer, (5000 - range.end) * DEFAULT_ROW_HEIGHT);
  assert.deepEqual(getVisibleRange({ rowCount: 0 }), { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0, rowHeight: DEFAULT_ROW_HEIGHT });
});

test('normalizes row and cell selection to the current result bounds', () => {
  assert.deepEqual(normalizeSelection({ selectedRows: [5, 2, 2, -1, 100], cell: { row: 5, column: 2 } }, 10, 4), {
    selectedRows: [2, 5],
    cell: { row: 5, column: 2 }
  });
  assert.deepEqual(normalizeSelection({ selectedRows: ['x'], cell: { row: 11, column: 1 } }, 10, 4), { selectedRows: [], cell: null });
});

test('classifies null, JSON, and binary values for safe inspection', () => {
  assert.deepEqual(inspectValue(null), { kind: 'null', label: 'NULL', display: 'NULL', formatted: 'NULL', byteLength: 0 });
  const json = inspectValue({ status: 'paid', total: 12900 });
  assert.equal(json.kind, 'json');
  assert.match(json.formatted, /"status": "paid"/);
  const blob = inspectValue({ type: 'binary', byteLength: 4, bytes: [0, 15, 16, 255] });
  assert.equal(blob.kind, 'binary');
  assert.equal(blob.byteLength, 4);
  assert.match(blob.formatted, /^00 0f 10 ff/);
  const longText = inspectValue('x'.repeat(600000));
  assert.equal(longText.display.length, 240);
  assert.match(longText.formatted, /value truncated$/);
});
