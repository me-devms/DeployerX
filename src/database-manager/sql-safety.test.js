const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_BATCH_STATEMENTS, classifySql, enforceSqlPolicy, scanSql, splitSqlStatements } = require('./sql-safety');

test('tokenizes comments and literals without treating their contents as statements', () => {
  const scanned = scanSql("-- DROP TABLE users\nSELECT '; DELETE FROM users', $$; TRUNCATE t$$; /* UPDATE x */");
  assert.equal(scanned.malformed, false);
  assert.equal(scanned.statements.length, 1);
  assert.equal(classifySql("SELECT 'DROP TABLE x'").kind, 'read');
  assert.equal(classifySql("SELECT 1; DELETE FROM users WHERE id = 1").statementCount, 2);
  assert.equal(classifySql("SELECT 'unterminated").kind, 'unknown');
});

test('classifies reads, mutations, destructive statements, and conservative unknowns', () => {
  for (const sql of ['SELECT * FROM users', 'SHOW TABLES', 'DESCRIBE users', 'PRAGMA table_info(users)', 'EXPLAIN SELECT 1', 'EXPLAIN ANALYZE SELECT 1']) assert.equal(classifySql(sql).kind, 'read', sql);
  for (const sql of ['INSERT INTO users VALUES (1)', 'UPDATE users SET active = 1 WHERE id = 2', 'SELECT nextval(\'seq\')', 'PRAGMA journal_mode = WAL', 'EXPLAIN ANALYZE UPDATE users SET active = 1 WHERE id = 2']) assert.equal(classifySql(sql).kind, 'mutation', sql);
  for (const sql of ['DROP TABLE users', 'TRUNCATE users', 'DELETE FROM users', 'UPDATE users SET active = 0', 'ALTER TABLE users DROP COLUMN name']) assert.equal(classifySql(sql).kind, 'destructive', sql);
  assert.equal(classifySql('WITH recent AS (SELECT * FROM users) SELECT * FROM recent', { dialect: 'postgres' }).kind, 'read');
  assert.equal(classifySql('WITH changed AS (DELETE FROM users WHERE inactive = 1 RETURNING *) SELECT * FROM changed', { dialect: 'postgresql' }).kind, 'mutation');
  assert.equal(classifySql('WITH changed AS (DELETE FROM users RETURNING *) SELECT * FROM changed', { dialect: 'postgresql' }).kind, 'destructive');
  assert.equal(classifySql('PRAGMA table_info(users)', { dialect: 'postgresql' }).kind, 'unknown');
  assert.equal(classifySql('PRAGMA table_info(users)', { dialect: 'sqlite' }).kind, 'read');
});

test('uses dialect-specific comments and quoted blocks while splitting statements', () => {
  assert.equal(scanSql('SELECT 1 # mysql comment\n; SELECT 2', { dialect: 'mysql' }).statements.length, 2);
  assert.equal(scanSql("SELECT payload #> '{path}' FROM events; SELECT 2", { dialect: 'postgresql' }).statements.length, 2);
  assert.equal(scanSql('SELECT $$value;inside$$; SELECT 2', { dialect: 'postgresql' }).statements.length, 2);
});

test('enforces read-only, destructive, and production confirmation policy', () => {
  const development = { name: 'Development', environment: 'development', accessMode: 'read-write' };
  const production = { name: 'Orders Production', environment: 'production', accessMode: 'read-write' };
  const readOnly = { ...production, accessMode: 'read-only' };
  assert.equal(enforceSqlPolicy({ profile: readOnly, classification: classifySql('SELECT 1') }).classification, 'read');
  assert.throws(() => enforceSqlPolicy({ profile: readOnly, classification: classifySql('UPDATE users SET active = 1 WHERE id = 2') }), (error) => error.code === 'DATABASE_MANAGER_READ_ONLY_VIOLATION');
  assert.throws(() => enforceSqlPolicy({ profile: development, classification: classifySql('DROP TABLE users') }), (error) => error.code === 'DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED');
  assert.equal(enforceSqlPolicy({ profile: development, classification: classifySql('DROP TABLE users'), approval: { confirmed: true } }).confirmationRequired, true);
  assert.throws(() => enforceSqlPolicy({ profile: production, classification: classifySql('UPDATE users SET active = 1 WHERE id = 2') }), (error) => error.code === 'DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED');
  assert.throws(() => enforceSqlPolicy({ profile: production, classification: classifySql('DROP TABLE users'), approval: { confirmed: true, typedProfileName: 'wrong' } }), (error) => error.code === 'DATABASE_MANAGER_QUERY_TYPED_CONFIRMATION_REQUIRED');
  assert.equal(enforceSqlPolicy({ profile: production, classification: classifySql('DROP TABLE users'), approval: { confirmed: true, typedProfileName: 'Orders Production' } }).typedConfirmationRequired, true);
});

test('requires explicit batch mode for multiple statements', () => {
  const profile = { name: 'Development', environment: 'development', accessMode: 'read-write' };
  const classification = classifySql('SELECT 1; SELECT 2');
  assert.throws(() => enforceSqlPolicy({ profile, classification }), (error) => error.code === 'DATABASE_MANAGER_BATCH_REQUIRED');
  assert.equal(enforceSqlPolicy({ profile, classification, batch: true }).classification, 'read');
  assert.throws(
    () => enforceSqlPolicy({ profile, classification: classifySql(Array.from({ length: MAX_BATCH_STATEMENTS + 1 }, () => 'SELECT 1').join(';')), batch: true }),
    (error) => error.code === 'DATABASE_MANAGER_BATCH_TOO_LARGE'
  );
});

test('splits statement text without breaking comments, quoted values, or dollar blocks', () => {
  assert.deepEqual(splitSqlStatements("-- first;\nSELECT ';' AS value; /* middle; */ SELECT $$last;value$$;"), [
    "-- first;\nSELECT ';' AS value",
    '/* middle; */ SELECT $$last;value$$'
  ]);
});
