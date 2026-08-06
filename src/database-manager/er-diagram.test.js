const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSchemaSnapshot } = require('./domain');
const { normalizeErDiagram, tableId } = require('./er-diagram');

test('normalizes bounded table relationships into ER nodes and edges', () => {
  const snapshot = normalizeSchemaSnapshot({
    database: 'orders',
    schemas: [{ name: 'public', tables: [
      { name: 'customers', columns: [{ name: 'id', dataType: 'bigint', primaryKey: true }], indexes: [{ name: 'customers_pkey', unique: true, columns: ['id'] }] },
      { name: 'orders', columns: [{ name: 'customer_id', dataType: 'bigint' }], foreignKeys: [{ name: 'orders_customer_fk', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'], onDelete: 'cascade' }] }
    ] }]
  });
  const diagram = normalizeErDiagram(snapshot);
  assert.equal(diagram.nodes.length, 2);
  assert.equal(diagram.edges.length, 1);
  assert.equal(diagram.edges[0].source, tableId('public', 'orders'));
  assert.equal(diagram.edges[0].target, tableId('public', 'customers'));
  assert.equal(snapshot.schemas[0].tables[0].indexes[0].unique, true);
});

test('drops relationship edges whose target is outside the bounded snapshot', () => {
  const diagram = normalizeErDiagram({ schemas: [{ name: 'public', tables: [{ name: 'orders', columns: [], foreignKeys: [{ name: 'missing', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'] }] }] }] });
  assert.equal(diagram.nodes.length, 1);
  assert.equal(diagram.edges.length, 0);
});
