const crypto = require('node:crypto');
const path = require('node:path');
const {
  normalizeResultExportFileName,
  serializeDatabaseQueryResult,
  serializeDatabaseResultColumns,
  serializeDatabaseResultRows
} = require('./result-export');

const MAX_STREAM_EXPORT_ROWS = 1_000_000;
const MAX_STREAM_EXPORT_BYTES = 1024 * 1024 * 1024;

function serviceError(message, code) {
  return Object.assign(new Error(message), { code, category: 'database-manager', retryable: false, safeMessage: message });
}

class DatabaseResultExportService {
  constructor({
    showSaveDialog,
    writeFile,
    openFile = null,
    renameFile = null,
    removeFile = null,
    queryService = null,
    randomUUID = crypto.randomUUID,
    maxStreamRows = MAX_STREAM_EXPORT_ROWS,
    maxStreamBytes = MAX_STREAM_EXPORT_BYTES
  } = {}) {
    if (typeof showSaveDialog !== 'function') throw new TypeError('DatabaseResultExportService requires a save dialog.');
    if (typeof writeFile !== 'function') throw new TypeError('DatabaseResultExportService requires a file writer.');
    this.showSaveDialog = showSaveDialog;
    this.writeFile = writeFile;
    this.openFile = openFile;
    this.renameFile = renameFile;
    this.removeFile = removeFile;
    this.queryService = queryService;
    this.randomUUID = randomUUID;
    this.maxStreamRows = maxStreamRows;
    this.maxStreamBytes = maxStreamBytes;
    this.active = new Map();
  }

  serialize(input = {}) {
    return serializeDatabaseQueryResult(input);
  }

  async export(input = {}) {
    const format = String(input.format || '').trim().toLowerCase();
    if (!['csv', 'json'].includes(format)) throw serviceError('Database result file format is not supported.', 'DATABASE_MANAGER_RESULT_EXPORT_FORMAT_INVALID');
    const serialized = serializeDatabaseQueryResult({ format, result: input.result });
    const defaultPath = normalizeResultExportFileName(input.suggestedName, format);
    let selection;
    try {
      selection = await this.showSaveDialog({
        title: format === 'json' ? 'Export database results as JSON' : 'Export database results as CSV',
        defaultPath,
        filters: [{ name: format === 'json' ? 'JSON files' : 'CSV files', extensions: [serialized.extension] }]
      });
    } catch {
      throw serviceError('Could not open the database result export dialog.', 'DATABASE_MANAGER_RESULT_EXPORT_DIALOG_FAILED');
    }
    if (selection?.canceled || !selection?.filePath) return Object.freeze({ cancelled: true, format });
    try {
      await this.writeFile(selection.filePath, serialized.content, 'utf8');
    } catch {
      throw serviceError('Could not write the database result export file.', 'DATABASE_MANAGER_RESULT_EXPORT_WRITE_FAILED');
    }
    return Object.freeze({
      cancelled: false,
      format,
      displayName: path.basename(selection.filePath),
      byteLength: serialized.byteLength
    });
  }

  async exportQuery(workspaceId, actorId, input = {}) {
    this.#requireStreamingDependencies();
    const format = String(input.format || '').trim().toLowerCase();
    if (!['csv', 'json'].includes(format)) throw serviceError('Database result file format is not supported.', 'DATABASE_MANAGER_RESULT_EXPORT_FORMAT_INVALID');
    const requestId = requiredText(input.requestId, 'Database result export request ID');
    const key = JSON.stringify([requiredText(workspaceId, 'Workspace ID'), requiredText(actorId, 'Actor ID'), requestId]);
    if (this.active.has(key)) throw serviceError('A database result export with this request ID is already running.', 'DATABASE_MANAGER_RESULT_EXPORT_ALREADY_RUNNING');
    const defaultPath = normalizeResultExportFileName(input.suggestedName, format);
    let selection;
    try {
      selection = await this.showSaveDialog({
        title: format === 'json' ? 'Export all database query rows as JSON' : 'Export all database query rows as CSV',
        defaultPath,
        filters: [{ name: format === 'json' ? 'JSON files' : 'CSV files', extensions: [format] }]
      });
    } catch {
      throw serviceError('Could not open the database result export dialog.', 'DATABASE_MANAGER_RESULT_EXPORT_DIALOG_FAILED');
    }
    if (selection?.canceled || !selection?.filePath) return Object.freeze({ cancelled: true, format, requestId });

    const operation = { controller: new AbortController(), currentQueryRequestId: null };
    this.active.set(key, operation);
    const temporaryPath = path.join(path.dirname(selection.filePath), `.${path.basename(selection.filePath)}.${this.randomUUID()}.tmp`);
    let handle = null;
    try {
      try {
        handle = await this.openFile(temporaryPath, 'wx');
      } catch {
        throw serviceError('Could not create the database result export file.', 'DATABASE_MANAGER_RESULT_EXPORT_WRITE_FAILED');
      }
      const summary = await this.#writeQueryPages(handle, workspaceId, actorId, requestId, format, input, operation);
      this.#throwIfCancelled(operation);
      await this.#closeHandle(handle, false);
      handle = null;
      this.#throwIfCancelled(operation);
      try {
        await this.renameFile(temporaryPath, selection.filePath);
      } catch {
        throw serviceError('Could not publish the database result export file.', 'DATABASE_MANAGER_RESULT_EXPORT_WRITE_FAILED');
      }
      return Object.freeze({
        cancelled: false,
        format,
        requestId,
        displayName: path.basename(selection.filePath),
        ...summary
      });
    } catch (error) {
      await this.#closeHandle(handle, true);
      await this.removeFile(temporaryPath).catch(() => {});
      if (operation.controller.signal.aborted || error?.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED') {
        return Object.freeze({ cancelled: true, format, requestId });
      }
      throw error;
    } finally {
      this.active.delete(key);
    }
  }

  cancel(workspaceId, actorId, requestId) {
    const id = requiredText(requestId, 'Database result export request ID');
    const operation = this.active.get(JSON.stringify([requiredText(workspaceId, 'Workspace ID'), requiredText(actorId, 'Actor ID'), id]));
    if (operation) {
      operation.controller.abort();
      if (operation.currentQueryRequestId) this.queryService.cancel(workspaceId, actorId, operation.currentQueryRequestId);
    }
    return Object.freeze({ requestId: id, cancelled: Boolean(operation) });
  }

  closeAll() {
    for (const operation of this.active.values()) operation.controller.abort();
    this.active.clear();
  }

  async #writeQueryPages(handle, workspaceId, actorId, requestId, format, input, operation) {
    let byteLength = 0;
    let rowCount = 0;
    let pageCount = 0;
    let page = 1;
    let columns = null;
    let firstJsonRow = true;
    let totalExecutionTimeMs = 0;
    const warnings = [];
    const write = async (content) => {
      if (!content) return;
      this.#throwIfCancelled(operation);
      const chunkBytes = Buffer.byteLength(content, 'utf8');
      if (byteLength + chunkBytes > this.maxStreamBytes) {
        throw serviceError('The database result export exceeds the maximum file size.', 'DATABASE_MANAGER_RESULT_EXPORT_TOO_LARGE');
      }
      try {
        await handle.write(content);
      } catch {
        throw serviceError('Could not write the database result export file.', 'DATABASE_MANAGER_RESULT_EXPORT_WRITE_FAILED');
      }
      byteLength += chunkBytes;
    };

    while (true) {
      this.#throwIfCancelled(operation);
      const queryRequestId = `${requestId.slice(0, 140)}_page_${page}`;
      operation.currentQueryRequestId = queryRequestId;
      const execution = await this.queryService.executeReadPage(workspaceId, actorId, {
        requestId: queryRequestId,
        profileId: input.profileId,
        query: input.query,
        page,
        pageSize: input.pageSize,
        source: 'editor'
      });
      operation.currentQueryRequestId = null;
      this.#throwIfCancelled(operation);
      const result = execution.result;
      if (result.additionalResults.length) throw serviceError('Full-result export supports one query result at a time.', 'DATABASE_MANAGER_RESULT_EXPORT_BATCH_UNSUPPORTED');
      if (result.pagination && result.pagination.page !== page) {
        throw serviceError('The database driver returned an invalid export page.', 'DATABASE_MANAGER_RESULT_EXPORT_PAGINATION_INVALID');
      }
      if (page === 1) {
        columns = result.columns;
        if (format === 'csv') await write(serializeDatabaseResultColumns(columns, format));
        else await write(`{\n  "columns": ${JSON.stringify(columns)},\n  "rows": [`);
      } else if (!sameColumns(columns, result.columns)) {
        throw serviceError('The database result columns changed during export.', 'DATABASE_MANAGER_RESULT_EXPORT_COLUMNS_CHANGED');
      }
      if (rowCount + result.rows.length > this.maxStreamRows || (result.pagination?.totalRows ?? 0) > this.maxStreamRows) {
        throw serviceError('The database result export exceeds the maximum row count.', 'DATABASE_MANAGER_RESULT_EXPORT_TOO_LARGE');
      }
      if (result.rows.length) {
        if (format === 'csv') await write(`${rowCount ? '\r\n' : columns.length ? '\r\n' : ''}${serializeDatabaseResultRows(result.rows, format)}`);
        else {
          const rows = serializeDatabaseResultRows(result.rows, format);
          await write(`${firstJsonRow ? '\n' : ',\n'}${rows}`);
          firstJsonRow = false;
        }
      }
      rowCount += result.rows.length;
      pageCount += 1;
      totalExecutionTimeMs += result.executionTimeMs;
      for (const warning of result.warnings) if (warnings.length < 100 && !warnings.includes(warning)) warnings.push(warning);
      const hasMore = Boolean(result.pagination?.hasMore);
      if (!hasMore) break;
      if (!result.rows.length) throw serviceError('The database driver returned an empty page with more rows indicated.', 'DATABASE_MANAGER_RESULT_EXPORT_PAGINATION_INVALID');
      page += 1;
      if (page > 1_000_000) throw serviceError('The database result export has too many pages.', 'DATABASE_MANAGER_RESULT_EXPORT_TOO_LARGE');
    }
    if (format === 'json') {
      await write(`${firstJsonRow ? '' : '\n'}  ],\n  "affectedRows": 0,\n  "pagination": null,\n  "executionTimeMs": ${totalExecutionTimeMs},\n  "warnings": ${JSON.stringify(warnings)}\n}`);
    }
    return Object.freeze({ byteLength, rowCount, pageCount });
  }

  #requireStreamingDependencies() {
    if (!this.queryService?.executeReadPage || !this.queryService?.cancel || typeof this.openFile !== 'function' || typeof this.renameFile !== 'function' || typeof this.removeFile !== 'function') {
      throw serviceError('Full database result export is unavailable.', 'DATABASE_MANAGER_RESULT_EXPORT_UNAVAILABLE');
    }
  }

  #throwIfCancelled(operation) {
    if (operation.controller.signal.aborted) throw serviceError('Database result export was cancelled.', 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED');
  }

  async #closeHandle(handle, ignoreErrors) {
    if (!handle) return;
    try {
      await Promise.resolve(handle.close());
    } catch {
      if (!ignoreErrors) throw serviceError('Could not finish the database result export file.', 'DATABASE_MANAGER_RESULT_EXPORT_WRITE_FAILED');
    }
  }
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200 || text.includes('\0')) throw serviceError(`${label} is invalid.`, 'DATABASE_MANAGER_RESULT_EXPORT_INVALID');
  return text;
}

function sameColumns(left, right) {
  return left.length === right.length && left.every((column, index) => column.name === right[index].name && column.dataType === right[index].dataType);
}

module.exports = {
  DatabaseResultExportService,
  MAX_STREAM_EXPORT_BYTES,
  MAX_STREAM_EXPORT_ROWS
};
