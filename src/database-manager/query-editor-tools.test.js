const assert = require('node:assert/strict');
const test = require('node:test');
const sqlFormatter = require('sql-formatter');
const {
  MAX_COMPLETIONS,
  buildDatabaseSqlCompletions,
  formatDatabaseSql,
  formatterLanguage,
  quoteIdentifier
} = require('./query-editor-tools');

test('maps built-in drivers to supported formatter dialects', () => {
  assert.equal(formatterLanguage('postgresql'), 'postgresql');
  assert.equal(formatterLanguage('mysql'), 'mysql');
  assert.equal(formatterLanguage('sqlite'), 'sqlite');
  assert.equal(formatterLanguage('plugin.unknown'), 'sql');
});

test('formats bounded SQL with stable uppercase keywords', () => {
  const formatted = formatDatabaseSql('select id,name from users where active=1 order by name', 'postgresql', sqlFormatter);
  assert.match(formatted, /^SELECT\s+/);
  assert.match(formatted, /\nFROM\n\s+users/);
  assert.match(formatted, /\nWHERE\n\s+active = 1/);
  assert.throws(
    () => formatDatabaseSql('x'.repeat((2 * 1024 * 1024) + 1), 'sqlite', sqlFormatter),
    (error) => error.code === 'DATABASE_QUERY_FORMAT_TOO_LARGE'
  );
});

test('builds bounded dialect-quoted keyword and schema completions', () => {
  const snapshot = {
    schemas: [{ name: 'sales', tables: [{
      name: 'order items', type: 'table',
      columns: [{ name: 'order_id', dataType: 'BIGINT' }, { name: 'total', dataType: 'DECIMAL' }]
    }] }]
  };
  const postgres = buildDatabaseSqlCompletions(snapshot, 'postgresql');
  assert.ok(postgres.some((item) => item.kind === 'keyword' && item.label === 'SELECT'));
  assert.ok(postgres.some((item) => item.label === 'sales.order items' && item.insertText === '"sales"."order items"'));
  assert.ok(postgres.some((item) => item.label === 'order_id' && item.detail.includes('BIGINT')));
  assert.equal(quoteIdentifier('odd`name', 'mysql'), '`odd``name`');
  assert.ok(buildDatabaseSqlCompletions(snapshot, 'sqlite', 2).length <= 2);
  assert.ok(postgres.length <= MAX_COMPLETIONS);
});
