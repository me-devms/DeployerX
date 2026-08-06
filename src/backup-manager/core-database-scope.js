'use strict';

const CORE_DATABASE_ADAPTER_IDS = Object.freeze([
  'deployerx.database.mysql.logical',
  'deployerx.database.mariadb.logical',
  // PostgreSQL and Supabase share the same logical adapter.
  'deployerx.database.postgresql.logical',
  'deployerx.database.mongodb.native',
  'deployerx.database.redis.native',
  'deployerx.database.sqlite.native',
  'deployerx.database.clickhouse'
]);

const CORE_DATABASE_ADAPTER_ID_SET = new Set(CORE_DATABASE_ADAPTER_IDS);

function isCoreDatabaseAdapterId(adapterId) {
  return CORE_DATABASE_ADAPTER_ID_SET.has(adapterId);
}

module.exports = {
  CORE_DATABASE_ADAPTER_IDS,
  isCoreDatabaseAdapterId
};
