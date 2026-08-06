const INTERNAL_PAGE_COMPLETE = 'DATABASE_MANAGER_DRIVER_PAGE_COMPLETE';

function queryError(code, safeMessage, retryable = false) {
  return Object.assign(new Error(safeMessage), { code, safeMessage, category: 'driver-runtime', retryable });
}

function bounds(offsetValue, limitValue, timeoutValue) {
  const offset = Number(offsetValue ?? 0);
  const limit = Number(limitValue ?? 100);
  const timeoutMs = Number(timeoutValue ?? 60000);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new TypeError('Bounded database query page is invalid.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) {
    throw new TypeError('Bounded database query timeout is invalid.');
  }
  return { offset, limit, timeoutMs };
}

function cancelledError() {
  return queryError('DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED', 'The database operation was cancelled.');
}

function timeoutError() {
  return queryError('DATABASE_MANAGER_DRIVER_TIMEOUT', 'The database operation timed out.', true);
}

function pageCompleteError() {
  return queryError(INTERNAL_PAGE_COMPLETE, 'The requested database result page is complete.');
}

function boundedPostgresQuery({ pool, Query, text, offset = 0, limit = 100, timeoutMs = 60000, signal = null, cancelOnLimit = true } = {}) {
  if (!pool?.connect || typeof Query !== 'function') throw new TypeError('Bounded PostgreSQL query requires a pool and Query constructor.');
  const page = bounds(offset, limit, timeoutMs);
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    let client = null;
    let command = null;
    let settled = false;
    let released = false;
    let terminalReleaseError = null;
    let fields = [];
    let affectedRows = 0;
    let seen = 0;
    let hasMore = false;
    const rows = [];

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const release = (error = null) => {
      if (!client || released) return;
      released = true;
      try { client.release(error || undefined); } catch {}
    };
    const result = () => ({ fields, rows, affectedRows, hasMore });
    const settle = (error = null, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminalReleaseError = destroy ? (error || pageCompleteError()) : null;
      release(terminalReleaseError);
      if (error) reject(error);
      else resolve(result());
    };
    const onAbort = () => settle(cancelledError(), true);
    const timer = setTimeout(() => settle(timeoutError(), true), page.timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    Promise.resolve().then(() => pool.connect()).then((acquired) => {
      if (settled) {
        try { acquired.release(terminalReleaseError || cancelledError()); } catch {}
        return;
      }
      client = acquired;
      command = new Query({ text: String(text || ''), rowMode: 'array' });
      command.on('row', (row, queryResult) => {
        if (settled) return;
        if (!fields.length && Array.isArray(queryResult?.fields)) fields = queryResult.fields;
        seen += 1;
        if (seen <= page.offset) return;
        if (rows.length < page.limit) rows.push(row);
        else {
          hasMore = true;
          if (cancelOnLimit) settle(null, true);
        }
      });
      command.once('end', (rawResult) => {
        if (settled) return;
        const queryResult = Array.isArray(rawResult) ? rawResult[0] : rawResult;
        if (!fields.length && Array.isArray(queryResult?.fields)) fields = queryResult.fields;
        affectedRows = fields.length ? 0 : Number(queryResult?.rowCount || 0);
        settle();
      });
      command.on('error', (error) => settle(error, true));
      try { client.query(command); }
      catch (error) { settle(error, true); }
    }).catch((error) => settle(error, true));
  });
}

function boundedMysqlQuery({ pool, sql, offset = 0, limit = 100, timeoutMs = 60000, signal = null, cancelOnLimit = true } = {}) {
  const rawPool = typeof pool?.pool?.getConnection === 'function' ? pool.pool : pool;
  if (typeof rawPool?.getConnection !== 'function') throw new TypeError('Bounded MySQL query requires a callback pool.');
  const page = bounds(offset, limit, timeoutMs);
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    let connection = null;
    let settled = false;
    let closed = false;
    let terminalDestroy = false;
    let fields = [];
    let affectedRows = 0;
    let seen = 0;
    let hasMore = false;
    const rows = [];

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const close = (destroy) => {
      if (!connection || closed) return;
      closed = true;
      try { destroy ? connection.destroy() : connection.release(); } catch {}
    };
    const settle = (error = null, destroy = false) => {
      if (settled) return;
      settled = true;
      terminalDestroy = destroy;
      cleanup();
      close(destroy);
      if (error) reject(error);
      else resolve({ fields, rows, affectedRows, hasMore });
    };
    const onAbort = () => settle(cancelledError(), true);
    const timer = setTimeout(() => settle(timeoutError(), true), page.timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    rawPool.getConnection((acquireError, acquired) => {
      if (acquireError) return settle(acquireError, true);
      if (settled) {
        try { terminalDestroy ? acquired.destroy() : acquired.release(); } catch {}
        return;
      }
      connection = acquired;
      let command;
      try { command = connection.query({ sql: String(sql || ''), rowsAsArray: true }); }
      catch (error) { settle(error, true); return; }
      command.on('fields', (queryFields) => {
        if (!settled && !fields.length && Array.isArray(queryFields)) fields = queryFields;
      });
      command.on('result', (value, resultIndex = 0) => {
        if (settled || resultIndex !== 0) return;
        if (!Array.isArray(value)) {
          affectedRows = Number(value?.affectedRows || 0);
          return;
        }
        seen += 1;
        if (seen <= page.offset) return;
        if (rows.length < page.limit) rows.push(value);
        else {
          hasMore = true;
          if (cancelOnLimit) settle(null, true);
        }
      });
      command.once('end', () => settle());
      command.on('error', (error) => settle(error, true));
    });
  });
}

module.exports = { boundedMysqlQuery, boundedPostgresQuery };
