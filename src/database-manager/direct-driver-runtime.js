// Portions adapt Tabularis v0.18.0 driver behavior (Copyright 2026 Andrea Debernardi).
// Modified for DeployerX's in-process fallback runtime. Apache-2.0; see THIRD_PARTY_NOTICES.md.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { boundedMysqlQuery, boundedPostgresQuery } = require('./bounded-query');
const { classifySql } = require('./sql-safety');

const SUPPORTED_DRIVERS = new Set(['postgresql', 'mysql', 'sqlite']);
const MAX_PAGE_SIZE = 5000;
const MAX_SCHEMA_METADATA_ITEMS = 500;
const MAX_SCHEMA_METADATA_COLUMNS = 100;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runtimeError(code, safeMessage, retryable = false) {
  return Object.assign(new Error(safeMessage), { code, safeMessage, category: 'driver-runtime', retryable });
}

function driverName(value) {
  const driver = String(value || '').trim().toLowerCase();
  if (driver === 'postgres' || driver === 'postgresql') return 'postgresql';
  if (driver === 'mysql' || driver === 'mariadb') return 'mysql';
  if (driver === 'sqlite' || driver === 'sqlite3') return 'sqlite';
  return driver;
}

function checkAbort(options = {}) {
  if (options.signal?.aborted) throw runtimeError('DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED', 'The database operation was cancelled.');
}

function requestPage(request = {}) {
  const page = Number(request.page ?? 1);
  const pageSize = Number(request.pageSize ?? request.page_size ?? 100);
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE || !Number.isSafeInteger(offset)) {
    throw runtimeError('DATABASE_MANAGER_QUERY_PAGE_INVALID', 'The database query page is invalid.');
  }
  return { page, pageSize, offset };
}

function wireValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(wireValue);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wireValue(item)]));
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function queryResult(columns, rows, affectedRows, started, page = null, hasMore = false) {
  return {
    columns,
    rows: rows.map((row) => row.map(wireValue)),
    affectedRows: Number.isSafeInteger(Number(affectedRows)) && Number(affectedRows) >= 0 ? Number(affectedRows) : 0,
    truncated: hasMore,
    pagination: page ? { page: page.page, pageSize: page.pageSize, totalRows: null, hasMore } : null,
    executionTimeMs: Number(process.hrtime.bigint() - started) / 1e6,
    warnings: [],
    additionalResults: []
  };
}

function sqliteRows(database, sql, bindings = []) {
  const statement = database.prepare(sql);
  const rows = [];
  try {
    if (bindings.length) statement.bind(bindings);
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function groupIndexes(rows) {
  const grouped = new Map();
  let truncated = false;
  for (const row of rows) {
    const name = String(row.index_name || '');
    const column = String(row.column_name || '');
    if (!name || !column) continue;
    let index = grouped.get(name);
    if (!index) {
      if (grouped.size >= MAX_SCHEMA_METADATA_ITEMS) {
        truncated = true;
        continue;
      }
      index = { name, unique: row.is_unique === true || Number(row.is_unique) === 1, columns: [] };
      grouped.set(name, index);
    }
    if (index.columns.length >= MAX_SCHEMA_METADATA_COLUMNS) truncated = true;
    else index.columns.push(column);
  }
  return { items: [...grouped.values()], truncated };
}

function groupForeignKeys(rows) {
  const grouped = new Map();
  let truncated = false;
  for (const row of rows) {
    const name = String(row.constraint_name || '');
    const sourceColumn = String(row.source_column || '');
    const referencedColumn = String(row.referenced_column || '');
    if (!name || !sourceColumn || !referencedColumn || !row.referenced_table) continue;
    let foreignKey = grouped.get(name);
    if (!foreignKey) {
      if (grouped.size >= MAX_SCHEMA_METADATA_ITEMS) {
        truncated = true;
        continue;
      }
      foreignKey = {
        name,
        columns: [],
        referencedSchema: String(row.referenced_schema || ''),
        referencedTable: String(row.referenced_table),
        referencedColumns: [],
        onDelete: row.on_delete == null ? null : String(row.on_delete),
        onUpdate: row.on_update == null ? null : String(row.on_update)
      };
      grouped.set(name, foreignKey);
    }
    if (foreignKey.columns.length >= MAX_SCHEMA_METADATA_COLUMNS) truncated = true;
    else {
      foreignKey.columns.push(sourceColumn);
      foreignKey.referencedColumns.push(referencedColumn);
    }
  }
  return { items: [...grouped.values()], truncated };
}

class DirectDatabaseDriverRuntime {
  constructor({ driverId = null, fileSystem = fs, loaders = {} } = {}) {
    this.driverId = driverId === null ? null : driverName(driverId);
    if (this.driverId !== null && !SUPPORTED_DRIVERS.has(this.driverId)) throw new TypeError('Direct database driver is not supported.');
    this.fileSystem = fileSystem;
    this.loaders = {
      postgresql: loaders.postgresql || (() => require('pg')),
      mysql: loaders.mysql || (() => require('mysql2/promise')),
      sqlite: loaders.sqlite || (() => require('sql.js/dist/sql-asm.js'))
    };
    this.dependencies = new Map();
    this.sessions = new Map();
    this.sqliteHandles = new Map();
  }

  async health() {
    return {
      status: 'ready',
      protocolVersion: 1,
      hostVersion: 'direct-1',
      drivers: this.driverId ? [this.driverId] : [...SUPPORTED_DRIVERS],
      connectionModes: ['physical-pool']
    };
  }

  async testConnection(connection, options = {}) {
    const adapter = await this.#open(connection, options);
    try { return adapter.evidence; }
    finally { await this.#closeAdapter(adapter); }
  }

  async openConnection(connection, options = {}) {
    const adapter = await this.#open(connection, options);
    const runtimeSessionId = `direct_${crypto.randomUUID()}`;
    this.sessions.set(runtimeSessionId, adapter);
    return { status: 'success', connectionMode: 'physical-pool', runtimeSessionId, evidence: adapter.evidence };
  }

  async closeConnection(runtimeSessionId) {
    const adapter = this.sessions.get(String(runtimeSessionId || ''));
    if (!adapter) return { status: 'closed', closed: false };
    this.sessions.delete(String(runtimeSessionId));
    await this.#closeAdapter(adapter);
    return { status: 'closed', closed: true };
  }

  async connectionStatus(runtimeSessionId, options = {}) {
    const id = String(runtimeSessionId || '');
    const adapter = this.sessions.get(id);
    if (!adapter) return { status: 'closed', connectionMode: 'physical-pool' };
    try {
      await this.#probe(adapter, options);
      return { status: 'ready', connectionMode: 'physical-pool' };
    } catch (error) {
      this.sessions.delete(id);
      await this.#closeAdapter(adapter).catch(() => {});
      return { status: 'failed', connectionMode: 'physical-pool', code: error.code || 'DATABASE_MANAGER_CONNECTION_HEALTH_FAILED' };
    }
  }

  async executeQuery(connection, request, options = {}) {
    const adapter = await this.#open(connection, options);
    try { return await this.#execute(adapter, request, options); }
    finally { await this.#closeAdapter(adapter); }
  }

  executeSessionQuery(runtimeSessionId, request, options = {}) {
    return this.#execute(this.#session(runtimeSessionId), request, options);
  }

  async discoverSchema(connection, request, options = {}) {
    const adapter = await this.#open(connection, options);
    try { return await this.#schema(adapter, request, options); }
    finally { await this.#closeAdapter(adapter); }
  }

  discoverSessionSchema(runtimeSessionId, request, options = {}) {
    return this.#schema(this.#session(runtimeSessionId), request, options);
  }

  async stop() {
    const adapters = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(adapters.map((adapter) => this.#closeAdapter(adapter).catch(() => {})));
  }

  #session(runtimeSessionId) {
    const adapter = this.sessions.get(String(runtimeSessionId || ''));
    if (!adapter) throw runtimeError('DATABASE_MANAGER_CONNECTION_SESSION_CLOSED', 'The database connection is closed.');
    return adapter;
  }

  #connectionDriver(connection) {
    const driver = driverName(connection?.driverId || this.driverId);
    if (!SUPPORTED_DRIVERS.has(driver) || (this.driverId && driver !== this.driverId)) {
      throw runtimeError('DATABASE_MANAGER_DRIVER_NOT_AVAILABLE', 'This database driver is not available.');
    }
    return driver;
  }

  async #dependency(driver) {
    if (!this.dependencies.has(driver)) {
      this.dependencies.set(driver, Promise.resolve().then(this.loaders[driver]).then(async (loaded) => {
        const module = loaded?.default || loaded;
        return driver === 'sqlite' && typeof module === 'function' ? module() : module;
      }).catch(() => {
        this.dependencies.delete(driver);
        throw runtimeError('DATABASE_MANAGER_DRIVER_DEPENDENCY_MISSING', `The ${driver === 'postgresql' ? 'PostgreSQL' : driver === 'mysql' ? 'MySQL/MariaDB' : 'SQLite'} runtime dependency is not installed.`);
      }));
    }
    return this.dependencies.get(driver);
  }

  async #open(connection, options) {
    checkAbort(options);
    const driver = this.#connectionDriver(connection);
    if (driver === 'sqlite') return this.#openSqlite(connection);
    const endpoint = connection?.endpoint || {};
    if (endpoint.kind !== 'network' || !endpoint.host) throw runtimeError('DATABASE_MANAGER_NETWORK_ENDPOINT_INVALID', 'A valid database network endpoint is required.');
    const timeout = Math.max(1000, Math.min(Number(options.timeoutMs) || 15000, 120000));
    const username = connection.credentials?.username || connection.settings?.username || (driver === 'postgresql' ? 'postgres' : 'root');
    const sslMode = connection.ssl?.mode || 'disabled';
    const ssl = sslMode === 'disabled' ? false : { rejectUnauthorized: ['verify-ca', 'verify-full'].includes(sslMode) };
    let resource;
    try {
      if (driver === 'postgresql') {
        const pg = await this.#dependency(driver);
        if (typeof pg?.Pool !== 'function') throw new Error('invalid pg module');
        resource = new pg.Pool({ host: endpoint.host, port: endpoint.port || 5432, database: connection.database || undefined, user: username, password: connection.credentials?.password || undefined, ssl, max: 4, connectionTimeoutMillis: timeout, query_timeout: timeout });
        const result = await resource.query('SELECT version() AS version, current_database() AS database');
        const first = result.rows?.[0] || {};
        return this.#adapter(driver, resource, connection, first.version, first.database);
      }
      const mysql = await this.#dependency(driver);
      if (typeof mysql?.createPool !== 'function') throw new Error('invalid mysql module');
      resource = mysql.createPool({ host: endpoint.host, port: endpoint.port || 3306, database: connection.database || undefined, user: username, password: connection.credentials?.password || undefined, ssl, connectionLimit: 4, connectTimeout: timeout, multipleStatements: false });
      const [rows] = await resource.query('SELECT VERSION() AS version, DATABASE() AS current_database_name');
      const first = rows?.[0] || {};
      return this.#adapter(driver, resource, connection, first.version, first.current_database_name);
    } catch (error) {
      await Promise.resolve(resource?.end?.()).catch(() => {});
      if (error?.code === 'DATABASE_MANAGER_DRIVER_DEPENDENCY_MISSING') throw error;
      throw runtimeError(`DATABASE_MANAGER_${driver === 'postgresql' ? 'POSTGRESQL' : 'MYSQL'}_CONNECTION_FAILED`, `Could not connect to the ${driver === 'postgresql' ? 'PostgreSQL' : 'MySQL or MariaDB'} database.`, true);
    }
  }

  #adapter(driver, resource, connection, serverVersion, database) {
    return {
      driver, resource, readOnly: connection.accessMode === 'read-only', closed: false,
      evidence: { status: 'success', latencyMs: 0, serverVersion: serverVersion == null ? null : String(serverVersion), database: database ?? connection.database ?? null, readOnly: connection.accessMode === 'read-only' }
    };
  }

  async #openSqlite(connection) {
    const filePath = path.resolve(String(connection?.endpoint?.path || ''));
    if (connection?.endpoint?.kind !== 'file' || !connection.endpoint.path) throw runtimeError('DATABASE_MANAGER_LOCAL_RESOURCE_REQUIRED', 'Choose the local SQLite database file first.');
    let handle = this.sqliteHandles.get(filePath);
    if (!handle) {
      try {
        const stat = await this.fileSystem.stat(filePath);
        if (!stat.isFile()) throw new Error('not file');
        const SQL = await this.#dependency('sqlite');
        if (typeof SQL?.Database !== 'function') throw new Error('invalid sql.js module');
        const fileBytes = await this.fileSystem.readFile(filePath);
        handle = { filePath, SQL, database: new SQL.Database(new Uint8Array(fileBytes)), digest: sha256(fileBytes), refs: 0, tail: Promise.resolve(), failed: false };
        handle.database.run('PRAGMA foreign_keys = ON');
        const integrity = sqliteRows(handle.database, 'PRAGMA quick_check')[0];
        if (String(integrity?.quick_check || Object.values(integrity || {})[0]).toLowerCase() !== 'ok') throw new Error('integrity');
        this.sqliteHandles.set(filePath, handle);
      } catch (error) {
        if (error?.code === 'DATABASE_MANAGER_DRIVER_DEPENDENCY_MISSING') throw error;
        throw runtimeError('DATABASE_MANAGER_SQLITE_OPEN_FAILED', 'Could not open the selected SQLite database.');
      }
    }
    handle.refs += 1;
    const version = sqliteRows(handle.database, 'SELECT sqlite_version() AS version')[0]?.version;
    return this.#adapter('sqlite', handle, connection, version, connection.database || path.basename(filePath));
  }

  async #closeAdapter(adapter) {
    if (!adapter || adapter.closed) return;
    adapter.closed = true;
    if (adapter.driver !== 'sqlite') return Promise.resolve(adapter.resource.end());
    const handle = adapter.resource;
    handle.refs -= 1;
    if (handle.refs > 0) return;
    this.sqliteHandles.delete(handle.filePath);
    await handle.tail;
    handle.database.close();
  }

  async #probe(adapter, options) {
    checkAbort(options);
    if (adapter.driver === 'sqlite') return this.#sqliteQueue(adapter.resource, () => sqliteRows(adapter.resource.database, 'SELECT 1'));
    if (adapter.driver === 'postgresql') return adapter.resource.query('SELECT 1');
    return adapter.resource.query('SELECT 1');
  }

  async #execute(adapter, request = {}, options = {}) {
    checkAbort(options);
    const query = String(request.query || '');
    if (!query.trim()) throw runtimeError('DATABASE_MANAGER_QUERY_INVALID', 'The database query is empty.');
    const classification = classifySql(query, { dialect: adapter.driver === 'postgresql' ? 'postgres' : adapter.driver });
    if (adapter.readOnly && classification.kind !== 'read') throw runtimeError('DATABASE_MANAGER_READ_ONLY_VIOLATION', 'This profile is read only and cannot run the requested statement.');
    const page = requestPage(request);
    if (adapter.driver === 'sqlite') return this.#sqliteQueue(adapter.resource, () => this.#executeSqlite(adapter, query, classification, page));
    const started = process.hrtime.bigint();
    const timeoutMs = Math.min(Number(options.timeoutMs) || 60000, 120000);
    try {
      if (adapter.driver === 'postgresql') {
        const dependency = await this.#dependency('postgresql');
        if (typeof dependency?.Query === 'function' && typeof adapter.resource.connect === 'function') {
          const result = await boundedPostgresQuery({
            pool: adapter.resource,
            Query: dependency.Query,
            text: query,
            offset: page.offset,
            limit: page.pageSize,
            timeoutMs,
            signal: options.signal,
            cancelOnLimit: classification.kind === 'read'
          });
          return queryResult((result.fields || []).map((field) => ({ name: field.name, dataType: String(field.dataTypeID || '') || null })), result.rows, result.fields?.length ? 0 : result.affectedRows, started, result.fields?.length ? page : null, result.hasMore);
        }
        const result = await adapter.resource.query({ text: query, rowMode: 'array', query_timeout: timeoutMs });
        const rows = Array.isArray(result.rows) ? result.rows : [];
        const selected = rows.slice(page.offset, page.offset + page.pageSize + 1);
        const hasMore = selected.length > page.pageSize;
        if (hasMore) selected.pop();
        return queryResult((result.fields || []).map((field) => ({ name: field.name, dataType: String(field.dataTypeID || '') || null })), selected, result.fields?.length ? 0 : result.rowCount, started, result.fields?.length ? page : null, hasMore);
      }
      if (typeof adapter.resource?.pool?.getConnection === 'function' || typeof adapter.resource?.getConnection === 'function') {
        const result = await boundedMysqlQuery({
          pool: adapter.resource,
          sql: query,
          offset: page.offset,
          limit: page.pageSize,
          timeoutMs,
          signal: options.signal,
          cancelOnLimit: classification.kind === 'read'
        });
        return queryResult((result.fields || []).map((field) => ({ name: field.name, dataType: String(field.type || field.columnType || '') || null })), result.rows, result.fields?.length ? 0 : result.affectedRows, started, result.fields?.length ? page : null, result.hasMore);
      }
      const [rawRows, fields] = await adapter.resource.query({ sql: query, rowsAsArray: true, timeout: timeoutMs });
      if (Array.isArray(rawRows)) {
        const selected = rawRows.slice(page.offset, page.offset + page.pageSize + 1);
        const hasMore = selected.length > page.pageSize;
        if (hasMore) selected.pop();
        return queryResult((fields || []).map((field) => ({ name: field.name, dataType: String(field.type || field.columnType || '') || null })), selected, 0, started, page, hasMore);
      }
      return queryResult([], [], rawRows?.affectedRows || 0, started);
    } catch (error) {
      if (['DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED', 'DATABASE_MANAGER_DRIVER_TIMEOUT'].includes(error?.code)) throw error;
      throw runtimeError('DATABASE_MANAGER_QUERY_FAILED', 'The database could not execute the requested statement.');
    }
  }

  async #executeSqlite(adapter, query, classification, page) {
    const started = process.hrtime.bigint();
    const handle = adapter.resource;
    const mutable = classification.kind !== 'read';
    let snapshot = null;
    let statement = null;
    let result = null;
    let failure = null;
    try {
      if (mutable) {
        snapshot = Buffer.from(handle.database.export());
        handle.database.run('PRAGMA foreign_keys = ON');
      }
      statement = handle.database.prepare(query);
      const names = statement.getColumnNames();
      const rows = [];
      let seen = 0;
      while (statement.step()) {
        if (seen++ < page.offset) continue;
        rows.push(statement.get());
        if (rows.length > page.pageSize) break;
      }
      const hasMore = rows.length > page.pageSize;
      if (hasMore) rows.pop();
      const affectedRows = names.length ? 0 : handle.database.getRowsModified();
      if (mutable) await this.#persistSqlite(handle);
      result = queryResult(names.map((name) => ({ name, dataType: null })), rows, affectedRows, started, names.length ? page : null, hasMore);
    } catch (error) {
      failure = ['DATABASE_MANAGER_SQLITE_PERSIST_FAILED', 'DATABASE_MANAGER_SQLITE_EXTERNAL_CHANGE_CONFLICT'].includes(error?.code)
        ? error
        : runtimeError('DATABASE_MANAGER_QUERY_FAILED', 'SQLite could not execute the requested statement.');
    } finally {
      statement?.free();
    }
    if (failure && snapshot) this.#restoreSqlite(handle, snapshot);
    if (failure) throw failure;
    return result;
  }

  #restoreSqlite(handle, snapshot) {
    try {
      const restored = new handle.SQL.Database(new Uint8Array(snapshot));
      restored.run('PRAGMA foreign_keys = ON');
      handle.database.close();
      handle.database = restored;
    } catch {
      handle.failed = true;
      try { handle.database.close(); } catch {}
      throw runtimeError('DATABASE_MANAGER_SQLITE_RECOVERY_FAILED', 'SQLite could not restore the database after a failed write. Reopen the connection.');
    }
  }

  async #persistSqlite(handle) {
    const temporary = path.join(path.dirname(handle.filePath), `.${path.basename(handle.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let output;
    try {
      let currentBytes;
      try { currentBytes = await this.fileSystem.readFile(handle.filePath); }
      catch { throw runtimeError('DATABASE_MANAGER_SQLITE_EXTERNAL_CHANGE_CONFLICT', 'The SQLite database file changed outside DeployerX. Reopen the connection and try again.'); }
      if (sha256(currentBytes) !== handle.digest) {
        throw runtimeError('DATABASE_MANAGER_SQLITE_EXTERNAL_CHANGE_CONFLICT', 'The SQLite database file changed outside DeployerX. Reopen the connection and try again.');
      }
      const exported = Buffer.from(handle.database.export());
      output = await this.fileSystem.open(temporary, 'wx');
      await output.writeFile(exported);
      await output.sync();
      await output.close();
      output = null;
      await this.fileSystem.rename(temporary, handle.filePath);
      handle.digest = sha256(exported);
    } catch (error) {
      await Promise.resolve(output?.close?.()).catch(() => {});
      await this.fileSystem.rm(temporary, { force: true }).catch(() => {});
      if (error?.code === 'DATABASE_MANAGER_SQLITE_EXTERNAL_CHANGE_CONFLICT') throw error;
      throw runtimeError('DATABASE_MANAGER_SQLITE_PERSIST_FAILED', 'SQLite could not save the database file.');
    }
  }

  async #schema(adapter, request = {}, options = {}) {
    checkAbort(options);
    if (adapter.driver === 'sqlite') return this.#sqliteQueue(adapter.resource, () => this.#sqliteSchema(adapter, request));
    const maxTables = Math.max(1, Math.min(Number(request.maxTables) || 500, 1000));
    const maxColumns = Math.max(1, Math.min(Number(request.maxColumnsPerTable) || 500, 1000));
    try {
      const pg = adapter.driver === 'postgresql';
      const tableSql = pg
        ? `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE ($1::text IS NULL OR table_schema = $1) AND ($2 OR table_schema NOT IN ('pg_catalog','information_schema')) ORDER BY table_schema, table_name LIMIT $3`
        : `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE (? IS NULL OR table_schema = ?) AND (? OR table_schema NOT IN ('mysql','information_schema','performance_schema','sys')) ORDER BY table_schema, table_name LIMIT ?`;
      const schema = request.schema || (pg ? null : adapter.evidence.database || null);
      const tableResult = pg
        ? await adapter.resource.query(tableSql, [schema, Boolean(request.includeSystem), maxTables + 1])
        : await adapter.resource.query(tableSql, [schema, schema, Boolean(request.includeSystem), maxTables + 1]);
      const rawTables = pg ? tableResult.rows : tableResult[0];
      const tablesTruncated = rawTables.length > maxTables;
      let columnsTruncated = false;
      let metadataTruncated = false;
      const grouped = new Map();
      for (const table of rawTables.slice(0, maxTables)) {
        const columnSql = pg
          ? `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_catalog=tc.constraint_catalog AND kcu.constraint_schema=tc.constraint_schema AND kcu.constraint_name=tc.constraint_name WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_catalog=c.table_catalog AND tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND kcu.column_name=c.column_name) AS is_primary_key FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position LIMIT $3`
          : `SELECT c.column_name, c.column_type AS data_type, c.is_nullable, c.column_default, EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_catalog=tc.constraint_catalog AND kcu.constraint_schema=tc.constraint_schema AND kcu.constraint_name=tc.constraint_name AND kcu.table_name=tc.table_name WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND kcu.column_name=c.column_name) AS is_primary_key FROM information_schema.columns c WHERE c.table_schema=? AND c.table_name=? ORDER BY c.ordinal_position LIMIT ?`;
        const columnResult = pg
          ? await adapter.resource.query(columnSql, [table.table_schema, table.table_name, maxColumns + 1])
          : await adapter.resource.query(columnSql, [table.table_schema, table.table_name, maxColumns + 1]);
        const rawColumns = pg ? columnResult.rows : columnResult[0];
        if (rawColumns.length > maxColumns) columnsTruncated = true;
        const columns = rawColumns.slice(0, maxColumns).map((column) => ({ name: column.column_name, dataType: column.data_type, nullable: column.is_nullable === 'YES', primaryKey: column.is_primary_key === true || Number(column.is_primary_key) === 1, defaultValue: column.column_default ?? null }));
        const indexSql = pg
          ? `WITH bounded_indexes AS (SELECT i.indexrelid, i.indrelid, i.indkey, i.indnkeyatts, i.indisunique AS is_unique, ic.relname AS index_name FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class tc ON tc.oid=i.indrelid JOIN pg_catalog.pg_namespace ns ON ns.oid=tc.relnamespace JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE ns.nspname=$1 AND tc.relname=$2 AND i.indisvalid AND i.indisready AND i.indexprs IS NULL ORDER BY ic.relname, i.indexrelid LIMIT $3) SELECT b.index_name, b.is_unique, a.attname AS column_name, k.ordinality AS ordinal_position FROM bounded_indexes b CROSS JOIN LATERAL unnest(b.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ordinality) JOIN pg_catalog.pg_attribute a ON a.attrelid=b.indrelid AND a.attnum=k.attnum WHERE k.ordinality<=b.indnkeyatts AND k.ordinality<=$4 ORDER BY b.index_name, k.ordinality`
          : `SELECT s.index_name, (s.non_unique=0) AS is_unique, s.column_name, s.seq_in_index AS ordinal_position FROM information_schema.statistics s JOIN (SELECT index_name FROM information_schema.statistics WHERE table_schema=? AND table_name=? GROUP BY index_name HAVING COUNT(*)=COUNT(column_name) ORDER BY index_name LIMIT ?) b ON b.index_name=s.index_name WHERE s.table_schema=? AND s.table_name=? AND s.seq_in_index<=? ORDER BY s.index_name, s.seq_in_index`;
        const indexResult = pg
          ? await adapter.resource.query(indexSql, [table.table_schema, table.table_name, MAX_SCHEMA_METADATA_ITEMS + 1, MAX_SCHEMA_METADATA_COLUMNS + 1])
          : await adapter.resource.query(indexSql, [table.table_schema, table.table_name, MAX_SCHEMA_METADATA_ITEMS + 1, table.table_schema, table.table_name, MAX_SCHEMA_METADATA_COLUMNS + 1]);
        const indexes = groupIndexes(pg ? indexResult.rows : indexResult[0]);
        const foreignKeySql = pg
          ? `WITH bounded_foreign_keys AS (SELECT c.oid, c.conname, c.conrelid, c.confrelid, c.conkey, c.confkey, c.confdeltype, c.confupdtype, rn.nspname AS referenced_schema, rt.relname AS referenced_table FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class st ON st.oid=c.conrelid JOIN pg_catalog.pg_namespace sn ON sn.oid=st.relnamespace JOIN pg_catalog.pg_class rt ON rt.oid=c.confrelid JOIN pg_catalog.pg_namespace rn ON rn.oid=rt.relnamespace WHERE c.contype='f' AND sn.nspname=$1 AND st.relname=$2 ORDER BY c.conname, c.oid LIMIT $3) SELECT fk.conname AS constraint_name, sa.attname AS source_column, fk.referenced_schema, fk.referenced_table, ra.attname AS referenced_column, CASE fk.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS on_delete, CASE fk.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS on_update, p.ordinality AS ordinal_position FROM bounded_foreign_keys fk CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) WITH ORDINALITY AS p(source_attnum, referenced_attnum, ordinality) JOIN pg_catalog.pg_attribute sa ON sa.attrelid=fk.conrelid AND sa.attnum=p.source_attnum JOIN pg_catalog.pg_attribute ra ON ra.attrelid=fk.confrelid AND ra.attnum=p.referenced_attnum WHERE p.ordinality<=$4 ORDER BY fk.conname, p.ordinality`
          : `SELECT k.constraint_name, k.column_name AS source_column, k.referenced_table_schema AS referenced_schema, k.referenced_table_name AS referenced_table, k.referenced_column_name AS referenced_column, r.delete_rule AS on_delete, r.update_rule AS on_update, k.ordinal_position FROM (SELECT constraint_schema, constraint_name, table_name, delete_rule, update_rule FROM information_schema.referential_constraints WHERE constraint_schema=? AND table_name=? ORDER BY constraint_name LIMIT ?) r JOIN information_schema.key_column_usage k ON k.constraint_schema=r.constraint_schema AND k.constraint_name=r.constraint_name AND k.table_name=r.table_name WHERE k.ordinal_position<=? ORDER BY k.constraint_name, k.ordinal_position`;
        const foreignKeyResult = pg
          ? await adapter.resource.query(foreignKeySql, [table.table_schema, table.table_name, MAX_SCHEMA_METADATA_ITEMS + 1, MAX_SCHEMA_METADATA_COLUMNS + 1])
          : await adapter.resource.query(foreignKeySql, [table.table_schema, table.table_name, MAX_SCHEMA_METADATA_ITEMS + 1, MAX_SCHEMA_METADATA_COLUMNS + 1]);
        const foreignKeys = groupForeignKeys(pg ? foreignKeyResult.rows : foreignKeyResult[0]);
        metadataTruncated ||= indexes.truncated || foreignKeys.truncated;
        if (!grouped.has(table.table_schema)) grouped.set(table.table_schema, []);
        grouped.get(table.table_schema).push({ name: table.table_name, type: String(table.table_type).includes('VIEW') ? 'view' : 'table', columns, indexes: indexes.items, foreignKeys: foreignKeys.items });
      }
      const warnings = [];
      if (tablesTruncated) warnings.push('The schema contains additional tables beyond the configured limit.');
      if (columnsTruncated) warnings.push('One or more tables contain additional columns beyond the configured limit.');
      if (metadataTruncated) warnings.push('One or more tables contain additional indexes or foreign keys beyond the configured limit.');
      return { database: adapter.evidence.database, schemas: [...grouped].map(([name, tables]) => ({ name, tables })), truncated: tablesTruncated || columnsTruncated || metadataTruncated, warnings };
    } catch {
      throw runtimeError('DATABASE_MANAGER_SCHEMA_DISCOVERY_FAILED', 'Database schema discovery failed.');
    }
  }

  #sqliteSchema(adapter, request) {
    const maxTables = Math.max(1, Math.min(Number(request.maxTables) || 500, 1000));
    const maxColumns = Math.max(1, Math.min(Number(request.maxColumnsPerTable) || 500, 1000));
    const database = adapter.resource.database;
    const catalog = sqliteRows(database, `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ${request.includeSystem ? '' : "AND name NOT LIKE 'sqlite_%'"} ORDER BY type, name LIMIT ?`, [maxTables + 1]);
    const truncated = catalog.length > maxTables;
    const tables = catalog.slice(0, maxTables).map((entry) => {
      const columns = sqliteRows(database, 'SELECT name, type, "notnull" AS not_null, dflt_value, pk FROM pragma_table_xinfo(?) LIMIT ?', [entry.name, maxColumns]).map((column) => ({ name: column.name, dataType: column.type || null, nullable: !column.not_null, primaryKey: Number(column.pk) > 0, defaultValue: column.dflt_value ?? null }));
      const indexes = sqliteRows(database, 'SELECT name, "unique" AS is_unique FROM pragma_index_list(?) WHERE name IS NOT NULL LIMIT 500', [entry.name]).map((index) => ({ name: index.name, unique: Boolean(index.is_unique), columns: sqliteRows(database, 'SELECT name FROM pragma_index_info(?) WHERE name IS NOT NULL ORDER BY seqno LIMIT 100', [index.name]).map((column) => column.name) })).filter((index) => index.columns.length);
      const groupedForeignKeys = new Map();
      for (const foreignKey of sqliteRows(database, 'SELECT id, seq, "table" AS referenced_table, "from" AS source_column, "to" AS referenced_column, on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq LIMIT 500', [entry.name])) {
        if (!groupedForeignKeys.has(foreignKey.id)) groupedForeignKeys.set(foreignKey.id, { name: `fk_${entry.name}_${foreignKey.id}`, columns: [], referencedSchema: 'main', referencedTable: foreignKey.referenced_table, referencedColumns: [], onDelete: foreignKey.on_delete, onUpdate: foreignKey.on_update });
        const item = groupedForeignKeys.get(foreignKey.id);
        item.columns.push(foreignKey.source_column);
        item.referencedColumns.push(foreignKey.referenced_column);
      }
      return { name: entry.name, type: entry.type === 'view' ? 'view' : 'table', columns, indexes, foreignKeys: [...groupedForeignKeys.values()] };
    });
    return { database: adapter.evidence.database, schemas: [{ name: 'main', tables }], truncated, warnings: truncated ? ['The schema contains additional tables beyond the configured limit.'] : [] };
  }

  async #sqliteQueue(handle, operation) {
    const previous = handle.tail;
    let release;
    handle.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    if (handle.failed) {
      release();
      throw runtimeError('DATABASE_MANAGER_SQLITE_RECOVERY_FAILED', 'SQLite must be reopened before another operation.');
    }
    try { return await operation(); }
    finally { release(); }
  }
}

module.exports = { DirectDatabaseDriverRuntime };
