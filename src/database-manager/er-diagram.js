const MAX_ER_NODES = 1000;
const MAX_ER_EDGES = 2000;

function safeText(value, fallback = '') {
  const text = String(value ?? fallback).trim();
  return text.length > 512 ? text.slice(0, 512) : text;
}

function tableId(schema, table) {
  return `${schema}\0${table}`;
}

function normalizeErDiagram(snapshot = {}) {
  const nodes = [];
  const nodeIds = new Set();
  const edges = [];
  for (const schema of Array.isArray(snapshot.schemas) ? snapshot.schemas : []) {
    for (const table of Array.isArray(schema.tables) ? schema.tables : []) {
      if (nodes.length >= MAX_ER_NODES) break;
      const id = tableId(schema.name, table.name);
      if (nodeIds.has(id)) continue;
      nodeIds.add(id);
      nodes.push(Object.freeze({
        id,
        schema: safeText(schema.name),
        name: safeText(table.name),
        type: safeText(table.type, 'table'),
        columns: Object.freeze((Array.isArray(table.columns) ? table.columns : []).slice(0, 1000).map((column) => Object.freeze({
          name: safeText(column.name), dataType: safeText(column.dataType, 'unknown'), primaryKey: column.primaryKey === true, nullable: column.nullable !== false
        })))
      }));
    }
  }
  for (const schema of Array.isArray(snapshot.schemas) ? snapshot.schemas : []) {
    for (const table of Array.isArray(schema.tables) ? schema.tables : []) {
      for (const foreignKey of Array.isArray(table.foreignKeys) ? table.foreignKeys : []) {
        if (edges.length >= MAX_ER_EDGES) break;
        const source = tableId(schema.name, table.name);
        const target = tableId(foreignKey.referencedSchema || schema.name, foreignKey.referencedTable);
        if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
        const columns = Array.isArray(foreignKey.columns) ? foreignKey.columns : [];
        const referencedColumns = Array.isArray(foreignKey.referencedColumns) ? foreignKey.referencedColumns : [];
        edges.push(Object.freeze({
          id: `${source}\0${safeText(foreignKey.name, `fk-${edges.length + 1}`)}`,
          source,
          target,
          name: safeText(foreignKey.name, 'Foreign key'),
          columns: Object.freeze(columns.map((column) => safeText(column))),
          referencedColumns: Object.freeze(referencedColumns.map((column) => safeText(column))),
          onDelete: safeText(foreignKey.onDelete),
          onUpdate: safeText(foreignKey.onUpdate)
        }));
      }
    }
  }
  return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges), truncated: nodes.length >= MAX_ER_NODES || edges.length >= MAX_ER_EDGES });
}

const api = { MAX_ER_EDGES, MAX_ER_NODES, normalizeErDiagram, tableId };
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis === 'object') globalThis.DatabaseErDiagram = api;
