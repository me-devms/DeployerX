const { normalizeQueryResult } = require('./domain');

const MAX_EXPORT_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_EXPORT_OUTPUT_BYTES = 64 * 1024 * 1024;
const EXPORT_FORMATS = new Set(['csv', 'json', 'tsv']);

function exportError(message, code = 'DATABASE_MANAGER_RESULT_EXPORT_INVALID') {
  return Object.assign(new Error(message), { code, category: 'database-manager', retryable: false });
}

function encodedByteLength(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { throw exportError(`${label} is not serializable.`); }
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > MAX_EXPORT_INPUT_BYTES) throw exportError(`${label} is too large.`, 'DATABASE_MANAGER_RESULT_EXPORT_TOO_LARGE');
  return bytes;
}

function scalarText(value) {
  if (value === null || value === undefined) return '';
  if (value && typeof value === 'object' && value.type === 'binary') return String(value.base64 || `[Binary ${Number(value.byteLength) || 0} bytes]`);
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function neutralizeSpreadsheetFormula(value) {
  return /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value) {
  const text = neutralizeSpreadsheetFormula(scalarText(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tsvCell(value) {
  return neutralizeSpreadsheetFormula(scalarText(value)).replaceAll('\t', ' ').replace(/\r?\n/g, '\\n');
}

function tabularContent(result, format) {
  const cell = format === 'csv' ? csvCell : tsvCell;
  const separator = format === 'csv' ? ',' : '\t';
  return [
    result.columns.map((column) => cell(column.name)).join(separator),
    ...result.rows.map((row) => row.map(cell).join(separator))
  ].join('\r\n');
}

function serializeDatabaseResultColumns(columns, format) {
  if (!['csv', 'tsv'].includes(format)) throw exportError('Database result export format is not supported.');
  const cell = format === 'csv' ? csvCell : tsvCell;
  const separator = format === 'csv' ? ',' : '\t';
  return columns.map((column) => cell(column.name)).join(separator);
}

function serializeDatabaseResultRows(rows, format) {
  if (format === 'json') return rows.map((row) => JSON.stringify(row)).join(',\n');
  if (!['csv', 'tsv'].includes(format)) throw exportError('Database result export format is not supported.');
  const cell = format === 'csv' ? csvCell : tsvCell;
  const separator = format === 'csv' ? ',' : '\t';
  return rows.map((row) => row.map(cell).join(separator)).join('\r\n');
}

function serializeDatabaseQueryResult(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw exportError('Database result export request is invalid.');
  const format = String(input.format || '').trim().toLowerCase();
  if (!EXPORT_FORMATS.has(format)) throw exportError('Database result export format is not supported.');
  encodedByteLength(input.result, 'Database query result');
  const result = normalizeQueryResult(input.result);
  const content = format === 'json'
    ? JSON.stringify({ columns: result.columns, rows: result.rows, affectedRows: result.affectedRows, pagination: result.pagination, executionTimeMs: result.executionTimeMs, warnings: result.warnings }, null, 2)
    : tabularContent(result, format);
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_EXPORT_OUTPUT_BYTES) throw exportError('Serialized database query result is too large.', 'DATABASE_MANAGER_RESULT_EXPORT_TOO_LARGE');
  return Object.freeze({
    format,
    content,
    byteLength,
    extension: format === 'tsv' ? 'txt' : format,
    mimeType: format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/tab-separated-values'
  });
}

function normalizeResultExportFileName(value, format) {
  const extension = format === 'json' ? 'json' : 'csv';
  const base = String(value || 'database-results')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || 'database-results';
  return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
}

module.exports = {
  MAX_EXPORT_INPUT_BYTES,
  MAX_EXPORT_OUTPUT_BYTES,
  normalizeResultExportFileName,
  serializeDatabaseResultColumns,
  serializeDatabaseResultRows,
  serializeDatabaseQueryResult
};
