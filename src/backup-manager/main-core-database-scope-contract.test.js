'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const DATABASE_CREATE_ADAPTERS = Object.freeze({
  mysql: 'MYSQL_ADAPTER_ID',
  mariadb: 'MARIADB_ADAPTER_ID',
  postgresql: 'POSTGRESQL_ADAPTER_ID',
  sqlserver: 'SQLSERVER_ADAPTER_ID',
  oracle: 'ORACLE_ADAPTER_ID',
  mongodb: 'MONGODB_ADAPTER_ID',
  redis: 'REDIS_ADAPTER_ID',
  influxdb: 'INFLUXDB_ADAPTER_ID',
  'influxdb3-enterprise': 'INFLUXDB3_ENTERPRISE_ADAPTER_ID',
  'influxdb3-core': 'INFLUXDB3_CORE_ADAPTER_ID',
  cockroachdb: 'COCKROACHDB_ADAPTER_ID',
  clickhouse: 'CLICKHOUSE_ADAPTER_ID',
  neo4j: 'NEO4J_ADAPTER_ID',
  'cassandra-scylla': 'CASSANDRA_SCYLLA_ADAPTER_ID',
  'scylla-manager': 'SCYLLA_MANAGER_ADAPTER_ID',
  'search-snapshot': 'SEARCH_SNAPSHOT_ADAPTER_ID',
  sqlite: 'SQLITE_ADAPTER_ID'
});

function ipcHandlers(source) {
  const starts = Array.from(source.matchAll(/ipcMain\.handle\(\s*(['"])([^'"]+)\1/g), (match) => ({
    channel: match[2],
    index: match.index
  }));

  return starts.map((handler, index) => ({
    channel: handler.channel,
    source: source.slice(handler.index, starts[index + 1]?.index ?? source.length)
  }));
}

test('passes the core adapter scope to the production DatabaseSourceService', () => {
  assert.match(
    MAIN_SOURCE,
    /const\s*\{[^}]*\bCORE_DATABASE_ADAPTER_IDS\b[^}]*\}\s*=\s*require\(\s*['"]\.\/backup-manager\/core-database-scope['"]\s*\);/
  );

  const constructors = Array.from(MAIN_SOURCE.matchAll(/backupDatabaseSourceService\s*=\s*new\s+DatabaseSourceService\s*\(\s*\{([\s\S]*?)\}\s*\);/g));
  assert.equal(constructors.length, 1, 'production should construct DatabaseSourceService exactly once');
  assert.match(constructors[0][1], /\ballowedAdapterIds\s*:\s*CORE_DATABASE_ADAPTER_IDS\b/);
});

test('guards every database connection create IPC handler with its adapter constant', () => {
  const databaseHandlers = ipcHandlers(MAIN_SOURCE)
    .map((handler) => {
      const match = /^backup:connections:([^:]+):create$/.exec(handler.channel);
      return match ? { ...handler, engine: match[1] } : null;
    })
    .filter((handler) => handler && handler.engine !== 'ssh');

  assert.deepEqual(
    databaseHandlers.map((handler) => handler.engine).sort(),
    Object.keys(DATABASE_CREATE_ADAPTERS).sort(),
    'the contract mapping must cover every database connection create channel'
  );

  for (const handler of databaseHandlers) {
    const guardConstants = Array.from(
      handler.source.matchAll(/createCoreDatabaseConnection\s*\(\s*([A-Z][A-Z0-9_]*)\s*,/g),
      (match) => match[1]
    );
    assert.deepEqual(
      guardConstants,
      [DATABASE_CREATE_ADAPTERS[handler.engine]],
      `${handler.channel} must use its matching adapter constant exactly once`
    );
  }
});
