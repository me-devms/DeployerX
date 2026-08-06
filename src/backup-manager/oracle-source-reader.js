const { LogicalDatabaseSourceReaderService } = require('./mysql-source-reader');
const { ADAPTER_ID } = require('./oracle');
const { OraclePhysicalBackupService } = require('./oracle-physical');

class OracleSourceReaderService extends LogicalDatabaseSourceReaderService {
  constructor(options = {}) {
    const physicalBackupService = options.physicalBackupService || new OraclePhysicalBackupService(options);
    super({
      ...options,
      physicalBackupService,
      profile: {
        adapterId: ADAPTER_ID,
        codePrefix: 'ORACLE',
        label: 'Oracle',
        engine: 'oracle',
        manifestKind: 'oracle-rman',
        temporaryPrefix: 'deployerx-oracle',
        emptyToolName: 'rman',
        maximumDumpBytes: 1
      }
    });
  }
}

module.exports = { OracleSourceReaderService };
