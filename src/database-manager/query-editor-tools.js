(function exposeDatabaseQueryEditorTools(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DatabaseQueryEditorTools = api;
})(typeof globalThis === 'object' ? globalThis : this, function createDatabaseQueryEditorToolsApi() {
  'use strict';

  const MAX_FORMAT_BYTES = 2 * 1024 * 1024;
  const MAX_COMPLETIONS = 500;
  const KEYWORDS = Object.freeze([
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'GROUP BY',
    'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
    'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'WITH', 'AS', 'DISTINCT', 'UNION ALL', 'CASE',
    'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'EXPLAIN'
  ]);

  function byteLength(value) {
    const text = String(value ?? '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    return Buffer.byteLength(text, 'utf8');
  }

  function formatterLanguage(driverId) {
    if (driverId === 'postgresql') return 'postgresql';
    if (driverId === 'mysql') return 'mysql';
    if (driverId === 'sqlite') return 'sqlite';
    return 'sql';
  }

  function formatDatabaseSql(sqlValue, driverId, formatter) {
    const sql = String(sqlValue ?? '');
    if (!sql.trim()) return sql;
    if (byteLength(sql) > MAX_FORMAT_BYTES) {
      const error = new Error('A query larger than 2 MiB cannot be formatted.');
      error.code = 'DATABASE_QUERY_FORMAT_TOO_LARGE';
      throw error;
    }
    if (!formatter || typeof formatter.format !== 'function') {
      const error = new Error('SQL formatting is unavailable.');
      error.code = 'DATABASE_QUERY_FORMATTER_UNAVAILABLE';
      throw error;
    }
    return formatter.format(sql, {
      language: formatterLanguage(driverId),
      keywordCase: 'upper',
      tabWidth: 2,
      useTabs: false,
      linesBetweenQueries: 1
    });
  }

  function quoteIdentifier(identifier, driverId) {
    const value = String(identifier ?? '');
    if (driverId === 'mysql') return `\`${value.replaceAll('`', '``')}\``;
    return `"${value.replaceAll('"', '""')}"`;
  }

  function buildDatabaseSqlCompletions(snapshot, driverId, maximum = MAX_COMPLETIONS) {
    const limit = Math.min(Math.max(Number(maximum) || MAX_COMPLETIONS, 1), MAX_COMPLETIONS);
    const completions = [];
    const seen = new Set();
    const add = (item) => {
      const key = `${item.kind}:${item.label}`.toLocaleLowerCase();
      if (completions.length >= limit || seen.has(key)) return;
      seen.add(key);
      completions.push(Object.freeze(item));
    };
    for (const keyword of KEYWORDS) add({ label: keyword, kind: 'keyword', insertText: keyword, detail: 'SQL keyword' });
    for (const schema of Array.isArray(snapshot?.schemas) ? snapshot.schemas : []) {
      const schemaName = String(schema?.name || '');
      if (!schemaName) continue;
      add({ label: schemaName, kind: 'module', insertText: quoteIdentifier(schemaName, driverId), detail: 'Schema' });
      for (const table of Array.isArray(schema.tables) ? schema.tables : []) {
        const tableName = String(table?.name || '');
        if (!tableName) continue;
        add({
          label: `${schemaName}.${tableName}`,
          kind: table.type === 'view' ? 'interface' : 'class',
          insertText: `${quoteIdentifier(schemaName, driverId)}.${quoteIdentifier(tableName, driverId)}`,
          detail: table.type === 'view' ? 'View' : 'Table'
        });
        add({
          label: tableName,
          kind: table.type === 'view' ? 'interface' : 'class',
          insertText: quoteIdentifier(tableName, driverId),
          detail: `${table.type === 'view' ? 'View' : 'Table'} in ${schemaName}`
        });
        for (const column of Array.isArray(table.columns) ? table.columns : []) {
          const columnName = String(column?.name || '');
          if (!columnName) continue;
          add({
            label: columnName,
            kind: 'field',
            insertText: quoteIdentifier(columnName, driverId),
            detail: `${column.dataType || 'Column'} - ${schemaName}.${tableName}`
          });
        }
      }
    }
    return Object.freeze(completions);
  }

  return Object.freeze({
    MAX_COMPLETIONS,
    MAX_FORMAT_BYTES,
    buildDatabaseSqlCompletions,
    formatDatabaseSql,
    formatterLanguage,
    quoteIdentifier
  });
});
