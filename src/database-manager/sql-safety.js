const READ_PRAGMAS = new Set([
  'COLLATION_LIST', 'COMPILE_OPTIONS', 'DATABASE_LIST', 'FOREIGN_KEY_CHECK', 'FOREIGN_KEY_LIST',
  'FUNCTION_LIST', 'INDEX_INFO', 'INDEX_LIST', 'INDEX_XINFO', 'INTEGRITY_CHECK', 'MODULE_LIST',
  'PRAGMA_LIST', 'QUICK_CHECK', 'TABLE_INFO', 'TABLE_LIST', 'TABLE_XINFO'
]);
const MUTATION_KEYWORDS = new Set([
  'ALTER', 'ANALYZE', 'ATTACH', 'BEGIN', 'CALL', 'COMMENT', 'COMMIT', 'COPY', 'CREATE', 'DELETE',
  'DETACH', 'EXEC', 'EXECUTE', 'GRANT', 'INSERT', 'LOAD', 'LOCK', 'MERGE', 'REINDEX', 'RELEASE',
  'REPLACE', 'RESET', 'REVOKE', 'ROLLBACK', 'SAVEPOINT', 'SET', 'UPDATE', 'UPSERT', 'VACUUM'
]);
const DESTRUCTIVE_KEYWORDS = new Set(['DROP', 'TRUNCATE']);
const MUTATING_SELECT_FUNCTIONS = new Set(['GET_LOCK', 'NEXTVAL', 'PG_ADVISORY_LOCK', 'PG_ADVISORY_XACT_LOCK', 'RELEASE_LOCK', 'SETVAL']);
const RANK = Object.freeze({ read: 0, mutation: 1, unknown: 2, destructive: 3 });
const MAX_BATCH_STATEMENTS = 100;
const SQL_DIALECT_ALIASES = Object.freeze({
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mariadb: 'mysql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  mssql: 'mssql',
  sqlserver: 'mssql',
  oracle: 'oracle',
  generic: 'generic'
});

function normalizeSqlDialect(value) {
  return SQL_DIALECT_ALIASES[String(value || '').trim().toLowerCase()] || 'generic';
}

function scanSql(sqlValue, options = {}) {
  const sql = String(sqlValue ?? '');
  const dialect = normalizeSqlDialect(typeof options === 'string' ? options : options.dialect);
  const statements = [[]];
  const texts = [];
  let statementStart = 0;
  let index = 0;
  let malformed = false;
  const push = (token) => statements.at(-1).push(token);
  while (index < sql.length) {
    const character = sql[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (sql.startsWith('--', index) || (character === '#' && ['generic', 'mysql'].includes(dialect))) {
      const newline = sql.indexOf('\n', index + 1);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) { malformed = true; break; }
      index = end + 2;
      continue;
    }
    if (character === '$' && ['generic', 'postgresql'].includes(dialect)) {
      const tag = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) { malformed = true; break; }
        index = end + tag.length;
        continue;
      }
    }
    const quotedIdentifier = character === '`' && ['generic', 'mysql', 'sqlite'].includes(dialect)
      || character === '[' && ['generic', 'mssql', 'sqlite'].includes(dialect);
    if (character === '\'' || character === '"' || quotedIdentifier) {
      const closing = character === '[' ? ']' : character;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (sql[index + 1] === closing && closing !== ']') { index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        if (sql[index] === '\\' && character === '\'' && index + 1 < sql.length) index += 2;
        else index += 1;
      }
      if (!closed) malformed = true;
      continue;
    }
    if (character === ';') {
      if (statements.at(-1).length) {
        texts.push(sql.slice(statementStart, index).trim());
        statements.push([]);
      }
      statementStart = index + 1;
      index += 1;
      continue;
    }
    const word = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
    if (word) {
      push(word.toUpperCase());
      index += word.length;
      continue;
    }
    if ('=(),'.includes(character)) push(character);
    index += 1;
  }
  if (statements.at(-1).length) texts.push(sql.slice(statementStart).trim());
  return { statements: statements.filter((statement) => statement.length), texts: texts.filter(Boolean), malformed };
}

function splitSqlStatements(sql, options = {}) {
  return Object.freeze(scanSql(sql, options).texts);
}

function containsSequence(tokens, sequence) {
  return tokens.some((token, index) => sequence.every((expected, offset) => tokens[index + offset] === expected));
}

function classifyWithStatement(tokens) {
  if (tokens.some((token) => DESTRUCTIVE_KEYWORDS.has(token))) return 'destructive';
  if (tokens.includes('DELETE') || tokens.includes('UPDATE')) return tokens.includes('WHERE') ? 'mutation' : 'destructive';
  if (tokens.some((token) => MUTATION_KEYWORDS.has(token))) return 'mutation';
  if (tokens.includes('SELECT') || tokens.includes('VALUES')) return 'read';
  return 'unknown';
}

function classifyStatement(tokens, malformed, dialect) {
  if (malformed || !tokens.length) return 'unknown';
  const first = tokens[0];
  if (DESTRUCTIVE_KEYWORDS.has(first)) return 'destructive';
  if (first === 'DELETE' || first === 'UPDATE') return tokens.includes('WHERE') ? 'mutation' : 'destructive';
  if (first === 'ALTER' && tokens.some((token) => ['DROP', 'RENAME', 'TYPE'].includes(token))) return 'destructive';
  if (first === 'SELECT') {
    if (tokens.includes('INTO') || containsSequence(tokens, ['FOR', 'UPDATE']) || containsSequence(tokens, ['FOR', 'SHARE']) || containsSequence(tokens, ['LOCK', 'IN', 'SHARE', 'MODE'])) return 'mutation';
    if (tokens.some((token) => MUTATING_SELECT_FUNCTIONS.has(token))) return 'mutation';
    return 'read';
  }
  if (['SHOW', 'DESCRIBE', 'DESC', 'VALUES'].includes(first)) return 'read';
  if (first === 'PRAGMA' && ['generic', 'sqlite'].includes(dialect)) {
    const pragmaName = tokens.find((token, index) => index > 0 && /^[A-Z_]+$/.test(token));
    return tokens.includes('=') || !READ_PRAGMAS.has(pragmaName) ? 'mutation' : 'read';
  }
  if (first === 'EXPLAIN') {
    if (tokens.some((token) => DESTRUCTIVE_KEYWORDS.has(token))) return 'destructive';
    if (tokens.some((token) => token !== 'ANALYZE' && MUTATION_KEYWORDS.has(token)) || tokens.some((token) => MUTATING_SELECT_FUNCTIONS.has(token))) return 'mutation';
    return 'read';
  }
  if (first === 'WITH') return classifyWithStatement(tokens);
  if (MUTATION_KEYWORDS.has(first)) return 'mutation';
  return 'unknown';
}

function classifySql(sql, options = {}) {
  const dialect = normalizeSqlDialect(typeof options === 'string' ? options : options.dialect);
  const scanned = scanSql(sql, { dialect });
  if (!scanned.statements.length) return Object.freeze({ kind: 'unknown', statementCount: 0, malformed: scanned.malformed, statements: Object.freeze([]) });
  const statements = scanned.statements.map((tokens) => classifyStatement(tokens, scanned.malformed, dialect));
  const kind = statements.reduce((highest, current) => RANK[current] > RANK[highest] ? current : highest, 'read');
  return Object.freeze({ kind, statementCount: statements.length, malformed: scanned.malformed, statements: Object.freeze(statements) });
}

function safetyError(code, safeMessage, details = {}) {
  return Object.assign(new Error(safeMessage), { code, safeMessage, category: 'sql-safety', retryable: false, details });
}

function enforceSqlPolicy({ profile, classification, approval = {}, batch = false } = {}) {
  if (!profile || !classification) throw new TypeError('Database SQL policy requires a profile and classification.');
  if (classification.statementCount === 0 || classification.malformed) {
    throw safetyError('DATABASE_MANAGER_SQL_INVALID', 'The SQL statement is empty or malformed.', { classification: 'unknown' });
  }
  if (classification.statementCount > MAX_BATCH_STATEMENTS) {
    throw safetyError('DATABASE_MANAGER_BATCH_TOO_LARGE', `A SQL batch cannot contain more than ${MAX_BATCH_STATEMENTS} statements.`, { statementCount: classification.statementCount, maximum: MAX_BATCH_STATEMENTS });
  }
  if (classification.statementCount > 1 && !batch) {
    throw safetyError('DATABASE_MANAGER_BATCH_REQUIRED', 'Run multiple SQL statements as an explicit batch.', { statementCount: classification.statementCount, classification: classification.kind });
  }
  if (profile.accessMode === 'read-only' && classification.kind !== 'read') {
    throw safetyError('DATABASE_MANAGER_READ_ONLY_VIOLATION', 'This profile is read only and cannot run this statement.', { classification: classification.kind });
  }
  const production = profile.environment === 'production';
  const destructive = classification.kind === 'destructive';
  const confirmationRequired = destructive || (production && ['mutation', 'unknown'].includes(classification.kind));
  const typedConfirmationRequired = production && destructive;
  if (confirmationRequired && approval.confirmed !== true) {
    throw safetyError('DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED', 'Confirm this database change before running it.', { classification: classification.kind, typedConfirmationRequired });
  }
  if (typedConfirmationRequired && String(approval.typedProfileName || '') !== profile.name) {
    throw safetyError('DATABASE_MANAGER_QUERY_TYPED_CONFIRMATION_REQUIRED', 'Enter the production profile name exactly before running this destructive statement.', { classification: classification.kind, typedConfirmationRequired: true });
  }
  return Object.freeze({ classification: classification.kind, production, confirmationRequired, typedConfirmationRequired });
}

module.exports = {
  MAX_BATCH_STATEMENTS,
  classifySql,
  enforceSqlPolicy,
  normalizeSqlDialect,
  scanSql,
  splitSqlStatements
};
