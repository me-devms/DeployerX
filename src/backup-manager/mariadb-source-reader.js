const { ADAPTER_ID } = require('./mariadb-logical');
const { LogicalDatabaseSourceReaderService } = require('./mysql-source-reader');

const MAX_MARIADB_DUMP_BYTES = 1024 * 1024 * 1024 * 1024;

class MariadbSourceReaderService extends LogicalDatabaseSourceReaderService {
  constructor(options = {}) {
    super({
      ...options,
      profile: {
        adapterId: ADAPTER_ID,
        codePrefix: 'MARIADB',
        label: 'MariaDB',
        engine: 'mariadb',
        manifestKind: 'mariadb-logical',
        binlogManifestKind: 'mariadb-binlog',
        temporaryPrefix: 'deployerx-mariadb-dump',
        emptyToolName: 'mariadb-dump',
        maximumDumpBytes: MAX_MARIADB_DUMP_BYTES
      }
    });
  }
}

module.exports = { MAX_MARIADB_DUMP_BYTES, MariadbSourceReaderService };
