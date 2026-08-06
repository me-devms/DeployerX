const { ADAPTER_ID } = require('./postgresql-logical');
const { LogicalDatabaseSourceReaderService } = require('./mysql-source-reader');
const { PostgresqlPhysicalBackupService } = require('./postgresql-physical');

const MAX_POSTGRESQL_DUMP_BYTES = 1024 * 1024 * 1024 * 1024;

class PostgresqlSourceReaderService extends LogicalDatabaseSourceReaderService {
  constructor(options = {}) {
    const physicalBackupService = options.physicalBackupService || new PostgresqlPhysicalBackupService(options);
    super({
      ...options,
      physicalBackupService,
      profile: {
        adapterId: ADAPTER_ID,
        codePrefix: 'POSTGRESQL',
        label: 'PostgreSQL',
        engine: 'postgresql',
        manifestKind: 'postgresql-logical',
        temporaryPrefix: 'deployerx-postgresql-dump',
        emptyToolName: 'pg_dump',
        maximumDumpBytes: MAX_POSTGRESQL_DUMP_BYTES
      }
    });
  }
}

module.exports = { MAX_POSTGRESQL_DUMP_BYTES, PostgresqlSourceReaderService };
