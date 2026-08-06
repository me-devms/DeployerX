const { LogicalDatabaseSourceReaderService } = require('./mysql-source-reader');
const { ADAPTER_ID } = require('./sqlserver');
const { SqlServerPhysicalBackupService } = require('./sqlserver-physical');

class SqlServerSourceReaderService extends LogicalDatabaseSourceReaderService {
  constructor(options = {}) {
    const physicalBackupService = options.physicalBackupService || new SqlServerPhysicalBackupService(options);
    super({
      ...options,
      physicalBackupService,
      profile: {
        adapterId: ADAPTER_ID,
        codePrefix: 'SQLSERVER',
        label: 'SQL Server',
        engine: 'sqlserver',
        manifestKind: 'sqlserver-native',
        temporaryPrefix: 'deployerx-sqlserver',
        emptyToolName: 'sqlcmd',
        maximumDumpBytes: 1
      }
    });
  }
}

module.exports = { SqlServerSourceReaderService };
