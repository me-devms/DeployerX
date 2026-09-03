const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, Notification, safeStorage, clipboard, nativeImage } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');
const net = require('net');
const tls = require('tls');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { autoUpdater } = require('electron-updater');
const nodemailer = require('nodemailer');
const { Client } = require('ssh2');
const { Client: FtpClient } = require('basic-ftp');
const { assertFirebaseConfig, sanitizeFirebaseConfigForRuntime, validateFirebaseConfig } = require('./firebase-config');
const { ServerMonitoringSessionManager } = require('./server-monitoring/session-manager');
const { DeployerXMcpServer } = require('./mcp-server');
const { listMcpClients, connectMcpClient, disconnectMcpClient, readMcpClientToken } = require('./mcp-clients');

const CODEX_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAACXBIWXMAAAsTAAALEwEAmpwYAAAFSUlEQVR4nM2Ze4hVVRTG7x3TsqzUzIIym4wkdSytQDBnpmjSAqs/svorigR7KNlLykykZEroZSUjWT4qIiJEo6AosCgoreglvaR0pJE0x9IsJpvpFyvXdtasu8+558y9NH0wDOy91jrfOXvttb69b6FQAYDDgQuAm4D7gLnA1cCIwv8JwGjgGeB34vgb+Ai4Bij2JdF+wHzgANmxCajtC7KHAS8ZIl3AWuBaYBxwAjASuAR4EthnbH8GFgNvAtt1rk1X4RGgoeorAaxwX21sGfthwIYcK7ERaKwW2StN4NeAI8rYHwcsAzodqW/Vf43+/97Nd+nmLVaaCls04NfAoDK2c4B2R2IVMDHBZyywUu0CHq+E8BUm0OUpdk3AZvfF3gUmZHxOg3vRmb0l/KwGaIstFTAKWOeIbgNm9OJZZ5tS+YukVh7nqVoVOjTA6sjyN5t5wX5gATAwIeaxWkWGpDz3ZhNvSRaitcDblOJ+Z3eXaxTPAyel1O8bgd1qvweYLS8dse0P/GBWKnkDAudrzbREAm53ti3GpqFMbn5GHF9Ia4/4PGhsxhVSduuvxnA9MCUD4b0J8aSJvOwItmtL3+XGxe4U4ytpE3BZLPgA4CtjNF/HT8xLGDgSWAT8YXz/Ap4AhqrNYOBR1+Jlsy2U/AfGm/FZMcLzjMFSM56LMHAV0Oq+3nZgTIqIet3Zb1W9EnBDIbLbfzRJPjAvYeAs4B2S8V5S49BY09wKW1zsjS80k7e5uSyEu1wL3q3dTv5CVQh2TwPHJ5CW6nCrVhCLyd5Q8i3g1F4QDvhTldehGgsM0TGZwzQEEfr9U3SItHKbUidbAxEi0d2eg/ArwOkxAgKZUxsLSYGphQToSwV8CNSECdG0gh0Rp9xVIg0czHeP9Ukvaz6m4LowuFwHJA8HpBCeV0XCW7SNB3Ros+ihBIGjgZ1qI92vKIP3GsceohwYbuZEu06pEuEWaePazm03/fzQ0nf7PGTmz5WB88xAc+Qhn5p5Cf6ibIJKCRe6xyYB35hnjHQ+dWbuHhkoGrHxU2RZjgEedjt9vxH1FREWALeY2KcVSq8SgrhfHgavNw5rrINxPCPSlapFeFYSYZ3foXNrw0CNHgID5qY89FK3hL0pay05Cf9Wosk1L6VIB6xOUvzale5w6i5r48hFWE80AQs9kcn0xB5tl0ldabge/7sytOZOY5eHsHyYgMbYsSgG6UrTYqTV7xzgfZKxQQVSrhxWqRnUX2vJCUWknHFc7FIE3XSjE0iPidhvlTsNY5OX8NIkYRYM5NwVUGfEuL30O6Die7D6DFVxLiLdlj1pSD0uXPIQdg3ty2hayr2DMWoy4yP0BG270i497rTnOIzuzUC4SfWF3UdnxuIV3NFkUWReznifEIeUxUnRwIV/fRvNC6cRth9lZ1rM0PVazUaridhIzZ5pREmb3mBGj+Mc1AzPOSJ3Opu7Ix/gDd+mk0gvKZF0cbujgHrJ84R52eELIqqs2e92oxg7VKtcVJaoK/YhL+Uety6zc3eM6UafBLyVlIvGdkXeZ4UAsuQBsvT1Gf0m6AWgxWa7gRNafcD0XhHWQI+5LrUy5bg+MXJlKqs0J3YdZfwGmdOyXOX2q4RwUWuhJYEuX7iUlkbynZvv1Mvs1JtHqdHAq1mucvMSl1L2AdkhbXhYmZjjgY+Nz7KqkHUPqVchv1EvXvZpK5by84C7RJS5pzQ/a/VsWKe6e51btRcqSoUKXqjWaepy6NArspJa/1+SLuqPiZtco8BAxLjU3VF9RjQGPRDMUD0tvwxJ+5W06nGVkBf/APLOOieCuT2TAAAAAElFTkSuQmCC';
const { RdpSessionManager } = require('./rdp-session');
const { VncSessionManager } = require('./vnc-session');
const { BackupAuditStore, StructuredLogStore } = require('./backup-manager/audit');
const { BackupJobService } = require('./backup-manager/backup-job');
const { BackupControlDatabase } = require('./backup-manager/control-database');
const { CORE_DATABASE_ADAPTER_IDS, isCoreDatabaseAdapterId } = require('./backup-manager/core-database-scope');
const { DatabaseAdapterRegistry } = require('./backup-manager/database-adapter');
const { DatabaseSourceService } = require('./backup-manager/database-source');
const { ADAPTER_ID: CASSANDRA_SCYLLA_ADAPTER_ID, CassandraScyllaAdapter, CassandraScyllaConnectionService } = require('./backup-manager/cassandra-scylla');
const { CassandraScyllaRestoreService } = require('./backup-manager/cassandra-scylla-restore');
const { CassandraScyllaSourceReaderService } = require('./backup-manager/cassandra-scylla-source-reader');
const { FileSourceService } = require('./backup-manager/file-selection');
const { FileSourceReaderService } = require('./backup-manager/file-source-reader');
const { FileRestoreService, createConnectionRestoreTarget } = require('./backup-manager/file-restore');
const { createBuiltInStorageBackendRegistry } = require('./backup-manager/built-in-storage-backends');
const { LocalConnectionService, loadOrCreateBackupDeviceId } = require('./backup-manager/local-connection');
const { LocalRepositoryService } = require('./backup-manager/local-repository');
const { ManualBackupService } = require('./backup-manager/manual-backup');
const { StorageConnectionService, StorageDestinationService } = require('./backup-manager/storage-backend-registry');
const { ADAPTER_ID: MARIADB_ADAPTER_ID, MariadbConnectionService, MariadbLogicalAdapter } = require('./backup-manager/mariadb-logical');
const { MariadbRestoreService, RESTORE_CONFIRMATIONS: MARIADB_RESTORE_CONFIRMATIONS } = require('./backup-manager/mariadb-restore');
const { MariadbSourceReaderService } = require('./backup-manager/mariadb-source-reader');
const { ADAPTER_ID: MYSQL_ADAPTER_ID, MysqlConnectionService, MysqlLogicalAdapter } = require('./backup-manager/mysql-logical');
const { NativeToolManager } = require('./backup-manager/native-tool-manager');
const { MysqlRestoreService, RESTORE_CONFIRMATIONS: MYSQL_RESTORE_CONFIRMATIONS } = require('./backup-manager/mysql-restore');
const { MysqlPhysicalRestoreService, RESTORE_CONFIRMATIONS: MYSQL_PHYSICAL_RESTORE_CONFIRMATIONS } = require('./backup-manager/mysql-physical-restore');
const { MariadbPointInTimeRestoreService, MysqlPointInTimeRestoreService, PROFILES: MYSQL_FAMILY_PITR_PROFILES } = require('./backup-manager/mysql-family-pitr');
const { BackupSourceReaderRouter, MysqlSourceReaderService } = require('./backup-manager/mysql-source-reader');
const execFileAsync = promisify(execFile);
const { BackupNotificationService } = require('./backup-manager/notifications');
const { BackupObjectiveStatusService } = require('./backup-manager/objectives');
const { ADAPTER_ID: MONGODB_ADAPTER_ID, MongoDbConnectionService, MongoDbNativeAdapter } = require('./backup-manager/mongodb');
const { MongoDbRestoreService, RESTORE_CONFIRMATIONS: MONGODB_RESTORE_CONFIRMATIONS } = require('./backup-manager/mongodb-restore');
const { MongoDbSourceReaderService } = require('./backup-manager/mongodb-source-reader');
const { ADAPTER_ID: NEO4J_ADAPTER_ID, Neo4jAdapter, Neo4jConnectionService } = require('./backup-manager/neo4j');
const { ADAPTER_ID: CLICKHOUSE_ADAPTER_ID, DESTINATION_CONFIRMATION: CLICKHOUSE_DESTINATION_CONFIRMATION, ClickHouseAdapter, ClickHouseConnectionService } = require('./backup-manager/clickhouse');
const { ADAPTER_ID: COCKROACHDB_ADAPTER_ID, BACKUP_DESTINATION_CONFIRMATION: COCKROACHDB_BACKUP_DESTINATION_CONFIRMATION, CockroachDbAdapter, CockroachDbConnectionService } = require('./backup-manager/cockroachdb');
const { CockroachDbSourceReaderService } = require('./backup-manager/cockroachdb-source-reader');
const { CockroachDbRetentionService } = require('./backup-manager/cockroachdb-retention');
const { createCockroachDbRetentionAdapters } = require('./backup-manager/cockroachdb-retention-adapters');
const { RESTORE_CONFIRMATION: COCKROACHDB_RESTORE_CONFIRMATION } = require('./backup-manager/cockroachdb-restore');
const { CockroachDbRestoreRunService } = require('./backup-manager/cockroachdb-restore-run');
const { CockroachDbScheduleService } = require('./backup-manager/cockroachdb-schedule-service');
const { DRILL_CONFIRMATION: COCKROACHDB_DRILL_CONFIRMATION, DRILL_MODE: COCKROACHDB_DRILL_MODE, METADATA_MODE: COCKROACHDB_METADATA_MODE, CockroachDbRecoveryTestService } = require('./backup-manager/cockroachdb-verification');
const { ADAPTER_ID: INFLUXDB_ADAPTER_ID, InfluxDbConnectionService, InfluxDbOssV2Adapter } = require('./backup-manager/influxdb');
const { ADAPTER_ID: INFLUXDB3_CORE_ADAPTER_ID, InfluxDb3CoreAdapter, InfluxDb3CoreConnectionService } = require('./backup-manager/influxdb3-core');
const { ADAPTER_ID: INFLUXDB3_ENTERPRISE_ADAPTER_ID, InfluxDb3EnterpriseAdapter, InfluxDb3EnterpriseConnectionService } = require('./backup-manager/influxdb3-enterprise');
const { InfluxDb3EnterpriseSourceReaderService } = require('./backup-manager/influxdb3-enterprise-source-reader');
const { InfluxDb3EnterpriseLegacySourceReaderService } = require('./backup-manager/influxdb3-enterprise-legacy-source-reader');
const { InfluxDb3EnterpriseSourceReaderRouter } = require('./backup-manager/influxdb3-enterprise-source-router');
const { InfluxDb3EnterpriseRestoreService, RESTORE_CONFIRMATION: INFLUXDB3_ENTERPRISE_RESTORE_CONFIRMATION } = require('./backup-manager/influxdb3-enterprise-restore');
const { DELETE_CONFIRMATION: INFLUXDB3_ENTERPRISE_DELETE_CONFIRMATION, InfluxDb3EnterpriseRetentionService } = require('./backup-manager/influxdb3-enterprise-retention');
const { InfluxDb3EnterpriseLegacyRetentionService } = require('./backup-manager/influxdb3-enterprise-legacy-retention');
const { InfluxDb3EnterpriseLegacyRestoreService } = require('./backup-manager/influxdb3-enterprise-legacy-restore');
const { RESTORE_CONFIRMATION: INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CONFIRMATION } = require('./backup-manager/influxdb3-enterprise-legacy');
const { InfluxDb3EnterpriseLegacyStopBindingService } = require('./backup-manager/influxdb3-enterprise-legacy-stop-binding');
const { InfluxDb3EnterpriseLegacyStopProofService } = require('./backup-manager/influxdb3-enterprise-legacy-stop-proof');
const { DRILL_CONFIRMATION: INFLUXDB3_ENTERPRISE_LEGACY_DRILL_CONFIRMATION, DRILL_MODE: INFLUXDB3_ENTERPRISE_LEGACY_DRILL_MODE, METADATA_MODE: INFLUXDB3_ENTERPRISE_LEGACY_METADATA_MODE, InfluxDb3EnterpriseLegacyRecoveryTestService } = require('./backup-manager/influxdb3-enterprise-legacy-verification');
const { METADATA_MODE: INFLUXDB3_ENTERPRISE_METADATA_MODE, InfluxDb3EnterpriseRecoveryTestService } = require('./backup-manager/influxdb3-enterprise-verification');
const { InfluxDb3CoreSourceReaderService } = require('./backup-manager/influxdb3-core-source-reader');
const { InfluxDb3CoreRestoreService, RESTORE_CONFIRMATION: INFLUXDB3_CORE_RESTORE_CONFIRMATION } = require('./backup-manager/influxdb3-core-restore');
const { DRILL_CONFIRMATION: INFLUXDB3_CORE_DRILL_CONFIRMATION, DRILL_MODE: INFLUXDB3_CORE_DRILL_MODE, InfluxDb3CoreRecoveryTestService } = require('./backup-manager/influxdb3-core-verification');
const { InfluxDbRestoreService, RESTORE_CONFIRMATION: INFLUXDB_RESTORE_CONFIRMATION } = require('./backup-manager/influxdb-restore');
const { InfluxDbSourceReaderService } = require('./backup-manager/influxdb-source-reader');
const { DRILL_CONFIRMATION: INFLUXDB_DRILL_CONFIRMATION, DRILL_MODE: INFLUXDB_DRILL_MODE, InfluxDbRecoveryTestService } = require('./backup-manager/influxdb-verification');
const { ClickHouseRestoreService, RESTORE_CONFIRMATION: CLICKHOUSE_RESTORE_CONFIRMATION } = require('./backup-manager/clickhouse-restore');
const { ClickHouseSourceReaderService } = require('./backup-manager/clickhouse-source-reader');
const { DRILL_CONFIRMATION: CLICKHOUSE_DRILL_CONFIRMATION, DRILL_MODE: CLICKHOUSE_DRILL_MODE, ClickHouseRecoveryTestService } = require('./backup-manager/clickhouse-verification');
const { AGGREGATION_CONFIRMATION: NEO4J_AGGREGATION_CONFIRMATION, Neo4jAggregationService } = require('./backup-manager/neo4j-aggregation');
const { Neo4jRestoreService, RESTORE_CONFIRMATION: NEO4J_RESTORE_CONFIRMATION } = require('./backup-manager/neo4j-restore');
const { Neo4jSourceReaderService } = require('./backup-manager/neo4j-source-reader');
const { DRILL_CONFIRMATION: NEO4J_DRILL_CONFIRMATION, DRILL_MODE: NEO4J_DRILL_MODE, Neo4jRecoveryTestService } = require('./backup-manager/neo4j-verification');
const { ADAPTER_ID: REDIS_ADAPTER_ID, RedisConnectionService, RedisNativeAdapter } = require('./backup-manager/redis');
const { RedisRestoreService, RESTORE_CONFIRMATIONS: REDIS_RESTORE_CONFIRMATIONS } = require('./backup-manager/redis-restore');
const { RedisSourceReaderService } = require('./backup-manager/redis-source-reader');
const { ADAPTER_ID: SEARCH_SNAPSHOT_ADAPTER_ID, SearchSnapshotAdapter, SearchSnapshotConnectionService } = require('./backup-manager/search-snapshot');
const {
  CLEANUP_CONFIRMATION: SEARCH_CLEANUP_CONFIRMATION,
  DRILL_CONFIRMATION: SEARCH_DRILL_CONFIRMATION,
  RESTORE_CONFIRMATION: SEARCH_RESTORE_CONFIRMATION,
  SearchSnapshotMaintenanceService,
  SearchSnapshotRecoveryTestService,
  SearchSnapshotRestoreService
} = require('./backup-manager/search-snapshot-operations');
const { SearchSnapshotSourceReaderService } = require('./backup-manager/search-snapshot-source-reader');
const { ADAPTER_ID: SCYLLA_MANAGER_ADAPTER_ID, ScyllaManagerAdapter, ScyllaManagerConnectionService } = require('./backup-manager/scylla-manager');
const { RESTORE_CONFIRMATION: SCYLLA_MANAGER_RESTORE_CONFIRMATION, ScyllaManagerRestoreService } = require('./backup-manager/scylla-manager-restore');
const { ScyllaManagerSourceReaderService } = require('./backup-manager/scylla-manager-source-reader');
const { DRILL_CONFIRMATION: SCYLLA_MANAGER_DRILL_CONFIRMATION, ScyllaManagerRecoveryTestService } = require('./backup-manager/scylla-manager-verification');
const { ADAPTER_ID: SQLITE_ADAPTER_ID, SqliteConnectionService, SqliteNativeAdapter } = require('./backup-manager/sqlite');
const { RESTORE_CONFIRMATIONS: SQLITE_RESTORE_CONFIRMATIONS, SqliteRestoreService } = require('./backup-manager/sqlite-restore');
const { SqliteSourceReaderService } = require('./backup-manager/sqlite-source-reader');
const { ADAPTER_ID: ORACLE_ADAPTER_ID, OracleConnectionService, OracleRmanAdapter } = require('./backup-manager/oracle');
const { OracleRestoreService, RESETLOGS_CONFIRMATION: ORACLE_RESETLOGS_CONFIRMATION, RESTORE_CONFIRMATIONS: ORACLE_RESTORE_CONFIRMATIONS } = require('./backup-manager/oracle-restore');
const { OracleSourceReaderService } = require('./backup-manager/oracle-source-reader');
const { ADAPTER_ID: POSTGRESQL_ADAPTER_ID, PostgresqlConnectionService, PostgresqlLogicalAdapter } = require('./backup-manager/postgresql-logical');
const { PostgresqlRestoreService, RESTORE_CONFIRMATIONS: POSTGRESQL_RESTORE_CONFIRMATIONS } = require('./backup-manager/postgresql-restore');
const { PostgresqlPitrRestoreService, RESTORE_CONFIRMATIONS: POSTGRESQL_PITR_RESTORE_CONFIRMATIONS } = require('./backup-manager/postgresql-pitr-restore');
const { PostgresqlSourceReaderService } = require('./backup-manager/postgresql-source-reader');
const { ADAPTER_ID: SQLSERVER_ADAPTER_ID, SqlServerConnectionService, SqlServerNativeAdapter } = require('./backup-manager/sqlserver');
const { SqlServerSourceReaderService } = require('./backup-manager/sqlserver-source-reader');
const { DAMAGED_TAIL_CONFIRMATION: SQLSERVER_DAMAGED_TAIL_CONFIRMATION, RESTORE_CONFIRMATIONS: SQLSERVER_RESTORE_CONFIRMATIONS, SqlServerRestoreService, TAIL_CONFIRMATION: SQLSERVER_TAIL_CONFIRMATION } = require('./backup-manager/sqlserver-restore');
const { RunCheckpointStore } = require('./backup-manager/run-checkpoint');
const { RepositoryVerificationService } = require('./backup-manager/repository-verification');
const { RepositoryPruningService } = require('./backup-manager/repository-pruning');
const { ScheduledBackupWorkerService, effectiveJobDispatchTime } = require('./backup-manager/scheduled-backup-worker');
const { SnapshotBrowserService } = require('./backup-manager/snapshot-browser');
const { S3RepositoryService } = require('./backup-manager/s3-repository');
const { S3StorageConnectionService } = require('./backup-manager/s3-storage-connection');
const { BackupSecretStore } = require('./backup-manager/secrets');
const { SftpRepositoryService } = require('./backup-manager/sftp-repository');
const { SshConnectionService } = require('./backup-manager/ssh-connection');
const {
  DatabaseAccessCompanionService,
  SUPPORTED_ACCESS_DRIVERS,
  resolveDatabaseAccessCompanionExecutablePath
} = require('./database-manager/access-companion-service');
const { DatabaseBackupHandoffService } = require('./database-manager/backup-handoff');
const { releaseRuntimeConnection, resolveRuntimeConnection } = require('./database-manager/connection-context');
const { DatabaseConnectionService } = require('./database-manager/connection-service');
const { DirectDatabaseDriverRuntime } = require('./database-manager/direct-driver-runtime');
const { DatabaseDriverRuntimeRegistry, SidecarDriverRuntime, createInstalledPluginRuntime, resolveDatabaseDriverHostPath } = require('./database-manager/driver-runtime');
const { DatabaseDefinitionExecutor } = require('./database-manager/definition-executor');
const { DatabaseExplainService } = require('./database-manager/explain-service');
const { DatabaseTransferService } = require('./database-manager/transfer-service');
const { DatabaseConnectionImportService } = require('./database-manager/connection-import');
const { createDatabaseManagerEvent } = require('./database-manager/event-contract');
const { wrapDatabaseManagerIpc } = require('./database-manager/ipc-contract');
const { DatabaseLocalResourceStore } = require('./database-manager/local-resource-store');
const { DatabaseOperationalLogService } = require('./database-manager/operational-log');
const { DatabaseOperationalEvidenceStore } = require('./database-manager/operational-evidence-store');
const { DatabaseProfileService } = require('./database-manager/profile-service');
const { DatabaseProfileStore } = require('./database-manager/profile-store');
const { DatabasePrincipalAdministrationService } = require('./database-manager/principal-administration');
const { DatabaseQueryService } = require('./database-manager/query-service');
const { DatabaseQueryWorkspaceStore } = require('./database-manager/query-workspace-store');
const { DatabaseResultExportService } = require('./database-manager/result-export-service');
const { DatabaseRowCrudService } = require('./database-manager/row-crud');
const { DatabaseSchemaAdministrationService } = require('./database-manager/schema-administration');
const { DatabaseSchemaService } = require('./database-manager/schema-service');
const { DatabaseServerTunnelService } = require('./database-manager/server-tunnel');
const { DatabaseTaskService, DatabaseTaskStore } = require('./database-manager/task-service');
const { DatabasePluginRegistry, safeArchiveEntries } = require('./database-manager/plugin-registry');
const { DatabasePluginHealthStore } = require('./database-manager/plugin-health-store');
const { inspectPluginRuntimeRequirement, pluginRuntimeRequirement } = require('./database-manager/plugin-runtime-requirement');
const { TabulariumClient } = require('./database-manager/tabularium-client');
const { mergeCloudProfiles, normalizeCloudProfileDocument } = require('./database-manager/cloud-metadata');
const { DatabaseCloudSyncOutbox } = require('./database-manager/cloud-sync-outbox');
const { planCloudSyncOperation } = require('./database-manager/cloud-sync-policy');
const {
  SHARED_CONTROL_ENTITY_TYPES,
  compareWorkspaceControlRecords,
  mergeWorkspaceControlRecord,
  projectWorkspaceControlRecord,
  workspaceControlChangeIsShared,
  workspaceControlRecordsEquivalent,
  workspaceControlDocumentId
} = require('./workspace-control-sync');
const { UptimeControlDatabase } = require('./uptime-monitor/control-database');
const { runMonitorCheck } = require('./uptime-monitor/check-engine');
const { normalizeMonitorInput } = require('./uptime-monitor/domain');
const { UptimeIncidentPolicyService } = require('./uptime-monitor/incident-policy');
const { wrapUptimeIpc } = require('./uptime-monitor/ipc-contract');
const { migrateLegacyUptime } = require('./uptime-monitor/legacy-migration');
const { buildUptimeReport, reportToCsv, uptimeReportHtml } = require('./uptime-monitor/reporting');
const { ScheduledUptimeWorkerService, executeUptimeMonitorCheck } = require('./uptime-monitor/scheduled-worker');
const { evaluateWorkerHeartbeat, workerHealthEvent } = require('./uptime-monitor/worker-health');
const { selectDeployerXProcesses } = require('./process-lifecycle');
const {
  buildLinuxAutostartEntry,
  buildLoginItemSettings,
  buildWorkerLaunchArgs,
  isWorkerLockLeaseActive
} = require('./uptime-monitor/worker-launch');
const { uptimeWindowCloseDisposition } = require('./uptime-monitor/window-lifecycle');
const appPackage = require('../package.json');

const STORE_FILE = 'projects.json';
const SETTINGS_FILE = 'settings.json';
const MCP_TOKEN_FILE = 'mcp-token.enc';
const MCP_AUTOSTART_ARGUMENT = '--mcp-autostart';
const APP_ICON = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'deployerx-logo.ico' : 'deployerx-logo.png');
const DATABASE_MANAGER_PACKAGED_SMOKE_ARGUMENT = '--database-manager-packaged-smoke';
const DATABASE_MANAGER_PACKAGED_SMOKE_RELEASE_ARGUMENT = '--database-manager-packaged-smoke-release=';
const DATABASE_MANAGER_PACKAGED_SMOKE_SCHEMA_VERSION = 1;
const RDP_WASM_FILE = path.join(path.dirname(require.resolve('ironrdp-wasm')), 'rdp_client_bg.wasm');
const AUTO_UPDATE_CHECK_DELAY_MS = 12000;
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GITHUB_API_BASE_URL = 'https://api.github.com';
const WINDOWS_UPDATE_MANIFEST = 'latest.yml';
let mainWindow;
const databaseAccessFallbackWindows = new Map();
let databaseManagerPackagedSmokePublished = false;
let rdpSessionManager;
let vncSessionManager;
let vncRestoreWindowState = null;
let serverMonitoringRestoreWindowState = null;
let mainWindowFullscreenOwner = null;
let tray;
let isAppQuitting = false;
let pendingSecondInstanceArguments = null;
let mcpServer;
let mcpRestartTimer = null;
let mcpRestorePromise = null;
let mcpHealthTimer = null;
let mcpClientRendererCache = null;
const activeDeployments = new Map();
const activeTerminals = new Map();
const mcpSshConnections = new Map();
const activeFtpSessions = new Map();
const activeVncNetworkSessions = new Map();
const activeTerminalUploads = new Map();
const activeWindowsVpnProfiles = new Map();
const serverMonitoringSessionManager = new ServerMonitoringSessionManager({
  emit: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server-monitoring:event', event);
  },
  connectionStarter: (connection, state) => connectClientWithProjectRoute(
    connection,
    state.project,
    state.connectionConfig,
    { protocol: 'ssh' }
  )
});
const TEMPLATE_CATEGORIES = ['Server', 'Laravel', 'Node.js', 'Database', 'Docker', 'Maintenance', 'Security', 'Hosting', 'Web Server', 'Cache', 'Control Panel', 'PaaS'];
const FIREBASE_AUTH_URL = 'https://identitytoolkit.googleapis.com/v1';
const FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
const UPTIME_HISTORY_LIMIT = 200;
const UPTIME_CONFIG_REFRESH_MS = 60 * 1000;
const UPTIME_COMMAND_POLL_MS = 4000;
const UPTIME_WORKER_LOCK_RENEW_MS = 5000;
const DATABASE_CLOUD_SYNC_INTERVAL_MS = 60 * 1000;
const WORKSPACE_UPTIME_SYNC_INTERVAL_MS = 60 * 1000;
const WORKSPACE_CONTROL_SYNC_INTERVAL_MS = 15 * 1000;
const UPTIME_RUNTIME_FILE = 'runtime.json';
const APP_USER_DATA_PATH = path.join(app.getPath('appData'), 'deployerx');
const SESSION_DATA_PATH = path.join(os.tmpdir(), `DeployerX-session-${process.pid}`);
app.setPath('userData', APP_USER_DATA_PATH);
app.setPath('sessionData', SESSION_DATA_PATH);
if (process.platform === 'win32') app.setAppUserModelId('com.everythingx.deployerx');
// Development launches should create a fresh window for the current source tree.
// Packaged app instances still retain their single-instance behavior.
const requiresSingleInstanceLock = app.isPackaged && !isWorkerMode() && !isDatabaseManagerPackagedSmokeMode();
const hasSingleInstanceLock = !requiresSingleInstanceLock || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
if (requiresSingleInstanceLock && hasSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => openExistingMainWindow(argv));
}
let settingsCache = null;
let firebaseConfigCache = null;
let authRefreshPromise = null;
let cloudUnlock = { teamId: '', key: null };
const pendingConfirmations = new Map();
const BUILT_IN_TEMPLATE_PREFIX = 'builtin:';
const githubReleaseSource = resolveGitHubReleaseSource();
const updateState = createDefaultUpdateState();
let updaterInitialized = false;
let autoUpdateTimer = null;
const uptimeSubscribers = new Set();
let uptimeRuntimeCache = null;
let uptimeWorkerState = {
  active: false,
  mode: 'window',
  startedAt: '',
  lastHeartbeatAt: '',
  lastConfigRefreshAt: '',
  commandPollAt: '',
  runLoopTickAt: '',
  autostartEnabled: false,
  syncWarning: '',
  projectsLoaded: 0,
  monitorCount: 0,
  pid: process.pid
};
let uptimeWorkerInterval = null;
let uptimeConfigRefreshTimer = null;
let uptimeCommandPollTimer = null;
let databaseCloudSyncTimer = null;
let workspaceUptimeSyncTimer = null;
let workspaceControlSyncTimer = null;
let databaseManagerEventSequence = 0;
const uptimeRunNowQueue = new Set();
let uptimeWorkerOwnsLock = false;
let uptimeWorkerLockOwnerId = '';
let uptimeWorkerLockRenewTimer = null;
let uptimeWorkerLaunchPromise = null;
let uptimeWorkerLaunchError = '';
let detachedUptimeWorkerPid = 0;
let updateInstallRequested = false;
let startupFailureHandled = false;
let backupSecretStore = null;
let backupAuditStore = null;
let backupLogStore = null;
let backupControlDatabase = null;
let backupControlDatabaseError = null;
let workspaceControlChangeHandlerEnabled = false;
let databaseProfileService = null;
let databaseConnectionImportService = null;
let databaseBackupHandoffService = null;
let databaseAccessCompanionService = null;
let databaseAccessContextGeneration = 0;
let databaseAccessContextTransitions = 0;
let databaseConnectionService = null;
let databaseDriverRuntimeRegistry = null;
let databaseLocalResourceStore = null;
let databaseOperationalLogService = null;
let databaseOperationalEvidenceStore = null;
let databaseQueryService = null;
let databaseQueryWorkspaceStore = null;
let databaseResultExportService = null;
let databaseRowCrudService = null;
let databaseSchemaAdministrationService = null;
let databasePrincipalAdministrationService = null;
let databaseDefinitionExecutor = null;
let databaseExplainService = null;
let databaseTransferService = null;
let databaseSchemaService = null;
let databaseTaskService = null;
let databasePluginRegistry = null;
let databasePluginHealthStore = null;
let tabulariumClient = null;
let databaseCloudSyncOutbox = null;
let backupLocalConnectionService = null;
let backupSshConnectionService = null;
let backupMysqlConnectionService = null;
let backupNativeToolManager = null;
let backupMariadbConnectionService = null;
let backupPostgresqlConnectionService = null;
let backupSqlServerConnectionService = null;
let backupOracleConnectionService = null;
let backupMongoDbConnectionService = null;
let backupNeo4jConnectionService = null;
let backupClickHouseConnectionService = null;
let backupCockroachDbConnectionService = null;
let backupCockroachDbScheduleService = null;
let backupCockroachDbRetentionService = null;
let backupInfluxDbConnectionService = null;
let backupInfluxDb3CoreConnectionService = null;
let backupInfluxDb3EnterpriseConnectionService = null;
let backupInfluxDb3EnterpriseRestoreService = null;
let backupInfluxDb3EnterpriseRetentionService = null;
let backupInfluxDb3EnterpriseRecoveryTestService = null;
let backupInfluxDb3EnterpriseLegacyRetentionService = null;
let backupInfluxDb3EnterpriseLegacyStopBindingService = null;
let backupInfluxDb3EnterpriseLegacyStopProofService = null;
let backupInfluxDb3EnterpriseLegacyRestoreService = null;
let backupInfluxDb3EnterpriseLegacyRecoveryTestService = null;
let backupInfluxDb3CoreRestoreService = null;
let backupInfluxDb3CoreRecoveryTestService = null;
let backupInfluxDbRestoreService = null;
let backupInfluxDbRecoveryTestService = null;
let backupClickHouseRestoreService = null;
let backupClickHouseRecoveryTestService = null;
let backupCockroachDbRestoreService = null;
let backupCockroachDbRecoveryTestService = null;
let backupNeo4jRestoreService = null;
let backupNeo4jAggregationService = null;
let backupNeo4jRecoveryTestService = null;
let backupRedisConnectionService = null;
let backupSearchSnapshotConnectionService = null;
let backupCassandraScyllaConnectionService = null;
let backupCassandraScyllaRestoreService = null;
let backupScyllaManagerConnectionService = null;
let backupScyllaManagerRestoreService = null;
let backupScyllaManagerRecoveryTestService = null;
let backupSqliteConnectionService = null;
let backupDatabaseSourceService = null;
let backupFileSourceService = null;
let backupLocalRepositoryService = null;
let backupSftpRepositoryService = null;
let backupS3RepositoryService = null;
let backupS3ConnectionService = null;
let backupStorageBackendRegistry = null;
let backupStorageConnectionService = null;
let backupDestinationService = null;
let backupJobService = null;
let backupManualBackupService = null;
let backupScheduledWorkerService = null;
let backupSnapshotBrowserService = null;
let backupFileRestoreService = null;
let backupMysqlRestoreService = null;
let backupMysqlPhysicalRestoreService = null;
let backupMariadbRestoreService = null;
let backupMysqlPitrService = null;
let backupMariadbPitrService = null;
let backupPostgresqlRestoreService = null;
let backupPostgresqlPitrRestoreService = null;
let backupSqlServerRestoreService = null;
let backupOracleRestoreService = null;
let backupMongoDbRestoreService = null;
let backupRedisRestoreService = null;
let backupSearchSnapshotRestoreService = null;
let backupSearchSnapshotMaintenanceService = null;
let backupSearchSnapshotRecoveryTestService = null;
let backupSqliteRestoreService = null;
let backupRepositoryVerificationService = null;
let backupRepositoryPruningService = null;
let backupNotificationService = null;
let backupObjectiveStatusService = null;
let backupDeviceId = null;
const backupInfluxDb3EnterpriseLegacyStopProofKey = crypto.randomBytes(32);
let uptimeControlDatabase = null;
let uptimeControlDatabaseError = null;
let uptimeIncidentPolicyService = null;
let uptimeScheduledWorkerService = null;
let uptimeWindowPollTimer = null;
let uptimeWindowLastHeartbeat = '';
let uptimeWorkerProjects = [];
const uptimeMonitorRuns = new Set();
const BUILT_IN_TEMPLATES = [
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}ubuntu-host-bootstrap`,
    name: 'Ubuntu Direct Host Bootstrap',
    category: 'Server',
    commands: [
      'export DEBIAN_FRONTEND=noninteractive',
      'sudo apt-get update -y',
      'sudo apt-get upgrade -y',
      'sudo apt-get install -y curl git unzip ufw fail2ban software-properties-common',
      'sudo timedatectl set-timezone {{timezone}}',
      'sudo adduser --disabled-password --gecos "" {{deploy_user}} || true',
      'sudo usermod -aG sudo {{deploy_user}}',
      'sudo mkdir -p /home/{{deploy_user}}/.ssh',
      'sudo cp /root/.ssh/authorized_keys /home/{{deploy_user}}/.ssh/authorized_keys || true',
      'sudo chown -R {{deploy_user}}:{{deploy_user}} /home/{{deploy_user}}/.ssh',
      'sudo chmod 700 /home/{{deploy_user}}/.ssh',
      'sudo chmod 600 /home/{{deploy_user}}/.ssh/authorized_keys || true',
      'sudo ufw allow OpenSSH',
      'sudo ufw allow {{app_port}}/tcp',
      'sudo ufw --force enable',
      'sudo systemctl enable fail2ban',
      'sudo systemctl restart fail2ban'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}nodejs-pm2-nginx`,
    name: 'Node.js 22 + PM2 Direct Deploy',
    category: 'Node.js',
    commands: [
      'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -',
      'sudo apt-get install -y nodejs',
      'sudo npm install -g pm2',
      'cd {{app_path}}',
      'git fetch --all --prune',
      'git checkout {{branch}}',
      'git pull origin {{branch}}',
      'npm ci --omit=dev || npm install --omit=dev',
      'npm run migrate || true',
      'pm2 describe {{pm2_name}} >/dev/null 2>&1 && pm2 reload {{pm2_name}} --update-env || pm2 start {{start_command}} --name {{pm2_name}}',
      'pm2 save'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}laravel-queue-nginx`,
    name: 'Laravel Deploy + Queue Restart',
    category: 'Laravel',
    commands: [
      'cd {{app_path}}',
      'git fetch --all --prune',
      'git checkout {{branch}}',
      'git pull origin {{branch}}',
      'composer install --no-interaction --prefer-dist --optimize-autoloader --no-dev',
      'php artisan down || true',
      'php artisan migrate --force',
      'php artisan config:cache',
      'php artisan route:cache',
      'php artisan view:cache',
      'php artisan queue:restart',
      'php artisan up',
      'sudo systemctl reload php{{php_version}}-fpm',
      'sudo systemctl reload nginx'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}docker-engine-compose-install`,
    name: 'Docker Engine + Compose Install (Ubuntu)',
    category: 'Docker',
    commands: [
      'sudo apt-get update -y',
      'sudo apt-get install -y ca-certificates curl',
      'sudo install -m 0755 -d /etc/apt/keyrings',
      'sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
      'sudo chmod a+r /etc/apt/keyrings/docker.asc',
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${UBUNTU_CODENAME:-$VERSION_CODENAME}) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null',
      'sudo apt-get update -y',
      'sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
      'sudo usermod -aG docker {{ssh_username}}',
      'docker --version',
      'docker compose version'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}docker-compose-refresh`,
    name: 'Docker Compose Pull + Recreate',
    category: 'Docker',
    commands: [
      'cd {{app_path}}',
      'docker compose pull',
      'docker compose up -d --remove-orphans',
      'docker image prune -f'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}postgres-backup-rotate`,
    name: 'PostgreSQL Backup + Retention',
    category: 'Database',
    commands: [
      'mkdir -p {{backup_dir}}',
      'export PGPASSWORD="{{db_password}}"',
      'pg_dump -h {{db_host}} -p {{db_port}} -U {{db_user}} -d {{db_name}} -F c -b -v -f {{backup_dir}}/{{db_name}}-$(date +%F-%H%M).dump',
      'find {{backup_dir}} -type f -name "*.dump" -mtime +{{retention_days}} -delete'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}mysql-backup-rotate`,
    name: 'MySQL Backup + Retention',
    category: 'Database',
    commands: [
      'mkdir -p {{backup_dir}}',
      'mysqldump -u {{db_user}} -p\'{{db_password}}\' {{db_name}} > {{backup_dir}}/{{db_name}}-$(date +%F-%H%M).sql',
      'find {{backup_dir}} -type f -name "*.sql" -mtime +{{retention_days}} -delete'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}mysql-create-db-user`,
    name: 'MySQL Create Database + User',
    category: 'Database',
    commands: [
      'sudo mysql -e "CREATE DATABASE IF NOT EXISTS \\`{{db_name}}\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"',
      'sudo mysql -e "CREATE USER IF NOT EXISTS \'{{db_user}}\'@\'localhost\' IDENTIFIED BY \'{{db_password}}\';"',
      'sudo mysql -e "GRANT ALL PRIVILEGES ON \\`{{db_name}}\\`.* TO \'{{db_user}}\'@\'localhost\'; FLUSH PRIVILEGES;"'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}postgres-create-db-user`,
    name: 'PostgreSQL Create Database + User',
    category: 'Database',
    commands: [
      'sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = \'{{db_user}}\'" | grep -q 1 || sudo -u postgres psql -c "CREATE USER {{db_user}} WITH PASSWORD \'{{db_password}}\';"',
      'sudo -u postgres psql -lqt | cut -d \\| -f 1 | grep -qw {{db_name}} || sudo -u postgres createdb -O {{db_user}} {{db_name}}'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}caddy-install`,
    name: 'Caddy Install (Ubuntu/Debian)',
    category: 'Web Server',
    commands: [
      'sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl',
      'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg',
      'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list',
      'sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg',
      'sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list',
      'sudo apt update',
      'sudo apt install -y caddy'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}caddy-reverse-proxy`,
    name: 'Caddy Reverse Proxy App',
    category: 'Web Server',
    commands: [
      'echo "{{domain}} { reverse_proxy 127.0.0.1:{{upstream_port}} }" | sudo tee /etc/caddy/Caddyfile',
      'sudo systemctl reload caddy'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}redis-install`,
    name: 'Redis Install (Official Repo)',
    category: 'Cache',
    commands: [
      'sudo apt-get install -y lsb-release curl gpg',
      'curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg',
      'sudo chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg',
      'echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list',
      'sudo apt-get update',
      'sudo apt-get install -y redis',
      'sudo systemctl enable redis-server',
      'sudo systemctl start redis-server'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}redis-local-hardening`,
    name: 'Redis Local Hardening',
    category: 'Cache',
    commands: [
      'sudo sed -i "s/^bind .*/bind 127.0.0.1 ::1/" /etc/redis/redis.conf || true',
      'sudo sed -i "s/^protected-mode .*/protected-mode yes/" /etc/redis/redis.conf || true',
      'sudo systemctl restart redis-server'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}letsencrypt-nginx`,
    name: "Let's Encrypt SSL Install (Nginx)",
    category: 'Security',
    commands: [
      'sudo apt-get update -y',
      'sudo apt-get install -y certbot python3-certbot-nginx',
      'sudo certbot --nginx -d {{domain}} --non-interactive --agree-tos -m {{email}} --redirect',
      'sudo systemctl reload nginx'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}certbot-renew-dry-run`,
    name: "Let's Encrypt Renew Dry Run",
    category: 'Security',
    commands: ['sudo certbot renew --dry-run']
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}wordpress-softaculous-prep`,
    name: 'Softaculous / WordPress Host Prep',
    category: 'Hosting',
    commands: [
      'sudo apt-get update -y',
      'sudo apt-get install -y nginx mysql-server php-fpm php-mysql php-curl php-xml php-mbstring php-zip unzip rsync',
      'sudo mkdir -p {{site_root}}',
      'sudo chown -R {{ssh_username}}:{{ssh_username}} {{site_root}}',
      'curl -fsSL https://wordpress.org/latest.zip -o /tmp/wordpress.zip',
      'unzip -o /tmp/wordpress.zip -d /tmp',
      'rsync -av /tmp/wordpress/ {{site_root}}/',
      'sudo systemctl enable nginx',
      'sudo systemctl enable mysql',
      'sudo systemctl restart nginx',
      'sudo systemctl restart mysql'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}softaculous-wordpress-cli`,
    name: 'Softaculous CLI Install WordPress',
    category: 'Hosting',
    commands: [
      'php {{softaculous_php_bin}} {{softaculous_cli_path}} --install --panel_user=\'{{panel_user}}\' --panel_pass=\'{{panel_pass}}\' --soft=26 --softdirectory=\'{{soft_directory}}\' --admin_username=\'{{admin_username}}\' --admin_pass=\'{{admin_password}}\' --site_name=\'{{site_name}}\' --emailto=\'{{email}}\''
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}cloudpanel-install`,
    name: 'CloudPanel Install',
    category: 'Control Panel',
    commands: [
      'sudo apt update -y',
      'sudo apt -y upgrade',
      'sudo apt -y install curl wget sudo',
      'curl -sS https://installer.cloudpanel.io/ce/v2/install.sh -o install.sh',
      'echo "6eac061df80f08b75224fcd7fce2f115e201696d8a6122e31abf7259a813b462 install.sh" | sha256sum -c',
      'sudo DB_ENGINE={{cloudpanel_db_engine}} bash install.sh',
      'echo "Open https://$(hostname -I | awk \'{print $1}\'):8443 quickly to create the CloudPanel admin user."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}hestiacp-install`,
    name: 'HestiaCP Install (Interactive)',
    category: 'Control Panel',
    commands: [
      'sudo apt-get update',
      'sudo apt-get install -y ca-certificates wget',
      'wget https://raw.githubusercontent.com/hestiacp/hestiacp/release/install/hst-install.sh',
      'sudo bash hst-install.sh'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}cwp-install-el9`,
    name: 'CWP Install (EL9 / AlmaLinux 9)',
    category: 'Control Panel',
    commands: [
      'sudo hostnamectl set-hostname {{server_hostname}}',
      'sudo dnf install epel-release -y',
      'sudo dnf -y install wget',
      'sudo dnf -y update',
      'echo "CWP official docs recommend a fresh OS and a reboot after update before installation. Continue only if this server is clean."',
      'cd /usr/local/src',
      'sudo wget http://centos-webpanel.com/cwp-el9-latest',
      'sudo sh cwp-el9-latest -r yes',
      'echo "After install, login at http://$(hostname -I | awk \'{print $1}\'):2030/ with root and the server root password."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}coolify-install`,
    name: 'Coolify Install',
    category: 'PaaS',
    commands: [
      'curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash',
      'echo "Open http://$(hostname -I | awk \'{print $1}\'):8000 and create the admin account immediately."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}dokploy-install`,
    name: 'Dokploy Install',
    category: 'PaaS',
    commands: [
      'curl -sSL https://dokploy.com/install.sh | sh',
      'echo "Open http://$(hostname -I | awk \'{print $1}\'):3000 to finish Dokploy setup."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}dokku-install`,
    name: 'Dokku Install',
    category: 'PaaS',
    commands: [
      'wget -NP . https://dokku.com/install/v0.38.5/bootstrap.sh',
      'sudo DOKKU_TAG=v0.38.5 bash bootstrap.sh',
      'cat ~/.ssh/authorized_keys | sudo dokku ssh-keys:add admin || true',
      'sudo dokku domains:set-global {{dokku_domain}}'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}caprover-install`,
    name: 'CapRover Install',
    category: 'PaaS',
    commands: [
      'command -v docker >/dev/null 2>&1 && docker run -d --restart unless-stopped --name captain-captain -p 80:80 -p 443:443 -p 3000:3000 -e ACCEPTED_TERMS=true -v /var/run/docker.sock:/var/run/docker.sock -v /captain:/captain caprover/caprover || echo "Install Docker first with the Docker Engine + Compose template."',
      'echo "Login at http://$(hostname -I | awk \'{print $1}\'):3000 with the default password captain42, then complete CapRover server setup."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}server-hardening-basics`,
    name: 'Server Hardening Basics',
    category: 'Security',
    commands: [
      'sudo apt-get update -y',
      'sudo apt-get install -y fail2ban unattended-upgrades',
      'sudo sed -i \'s/^#*PasswordAuthentication .*/PasswordAuthentication no/\' /etc/ssh/sshd_config',
      'sudo sed -i \'s/^#*PermitRootLogin .*/PermitRootLogin prohibit-password/\' /etc/ssh/sshd_config',
      'sudo systemctl restart ssh || sudo systemctl restart sshd',
      'sudo dpkg-reconfigure -f noninteractive unattended-upgrades',
      'sudo systemctl enable fail2ban',
      'sudo systemctl restart fail2ban'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}ufw-web-profile`,
    name: 'UFW Web Profile',
    category: 'Security',
    commands: [
      'sudo ufw allow OpenSSH',
      'sudo ufw allow 80/tcp',
      'sudo ufw allow 443/tcp',
      'sudo ufw --force enable',
      'sudo ufw status'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}swapfile-setup`,
    name: 'Swapfile Setup',
    category: 'Server',
    commands: [
      'sudo fallocate -l {{swap_size}} /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count={{swap_size_mb}}',
      'sudo chmod 600 /swapfile',
      'sudo mkswap /swapfile',
      'sudo swapon /swapfile',
      'grep -q "^/swapfile " /etc/fstab || echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab',
      'swapon --show'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}maintenance-cleanup`,
    name: 'Maintenance Cleanup + Health Check',
    category: 'Maintenance',
    commands: [
      'df -h',
      'free -m',
      'sudo apt-get autoremove -y',
      'sudo apt-get autoclean -y',
      'sudo journalctl --vacuum-time={{journal_retention}}',
      'sudo systemctl --failed',
      'uptime'
    ]
  }
];

function resolveGitHubReleaseSource(repository = appPackage.repository) {
  const rawUrl = typeof repository === 'string' ? repository : repository?.url;
  const normalized = String(rawUrl || '')
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/i, '');
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  return {
    owner,
    repo,
    releasesUrl: `https://github.com/${owner}/${repo}/releases`,
    latestReleaseApiUrl: `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/releases/latest`
  };
}

function createDefaultUpdateState() {
  return {
    enabled: false,
    status: 'idle',
    currentVersion: appPackage.version || '0.0.0',
    availableVersion: '',
    downloadedVersion: '',
    releaseName: '',
    releaseDate: '',
    downloadPercent: 0,
    lastCheckedAt: '',
    releasePageUrl: githubReleaseSource?.releasesUrl || '',
    downloadUrl: '',
    message: '',
    error: ''
  };
}

function publicUpdateState() {
  const status = updateState.status || 'idle';
  return {
    ...updateState,
    currentVersion: app.getVersion(),
    releasePageUrl: updateState.releasePageUrl || githubReleaseSource?.releasesUrl || '',
    canCheck: Boolean(updateState.enabled) && !['checking', 'downloading'].includes(status),
    canInstall: status === 'downloaded'
  };
}

function sendUpdateStateToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app:update-event', publicUpdateState());
}

function syncUpdateState(nextState = {}, notify = true) {
  Object.assign(updateState, nextState, {
    currentVersion: app.getVersion(),
    releasePageUrl: nextState.releasePageUrl || updateState.releasePageUrl || githubReleaseSource?.releasesUrl || ''
  });
  if (notify) sendUpdateStateToRenderer();
  return publicUpdateState();
}

function isPortableWindowsBuild() {
  return process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

function parseWindowsProcessList(output) {
  const raw = String(output || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((record) => ({
      pid: Number(record?.pid ?? record?.ProcessId ?? 0),
      parentPid: Number(record?.parentPid ?? record?.ParentProcessId ?? 0),
      name: String(record?.name ?? record?.Name ?? '').trim(),
      executablePath: String(record?.executablePath ?? record?.ExecutablePath ?? '').trim(),
      commandLine: String(record?.commandLine ?? record?.CommandLine ?? '').trim()
    }));
  } catch {
    return [];
  }
}

async function listWindowsDeployerXProcesses() {
  if (process.platform !== 'win32') return [];
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$records = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("DeployerX.exe", "electron.exe") } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine',
    '$records | ConvertTo-Json -Compress'
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
    return parseWindowsProcessList(stdout);
  } catch (error) {
    console.warn(`[process-lifecycle] Could not inspect running DeployerX processes: ${String(error?.message || error)}`);
    return [];
  }
}

async function terminateWindowsProcessTreeElevated(pid) {
  const processId = Number(pid || 0);
  const script = [
    `$result = Start-Process -FilePath "$env:SystemRoot\\System32\\taskkill.exe" -ArgumentList @('/PID','${processId}','/T','/F') -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    'exit $result.ExitCode'
  ].join('; ');
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  return true;
}

async function terminateProcessTree(pid, { allowElevation = false } = {}) {
  const processId = Number(pid || 0);
  if (!Number.isInteger(processId) || processId <= 0 || processId === process.pid) return false;
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024
      });
      return true;
    } catch (error) {
      const failure = String(error?.stderr || error?.message || error);
      // A process may have exited between inspection and taskkill. Treat that
      // race as successful cleanup so a stale PID cannot block startup.
      if (/not found|no running instance|does not exist|cannot find/i.test(failure)) return true;
      if (allowElevation && /access is denied/i.test(failure)) {
        try {
          return await terminateWindowsProcessTreeElevated(processId);
        } catch (elevatedError) {
          console.warn(`[process-lifecycle] Administrator cleanup was declined or failed for process ${processId}: ${String(elevatedError?.message || elevatedError)}`);
          return false;
        }
      }
      console.warn(`[process-lifecycle] Could not stop process ${processId}: ${String(error?.message || error)}`);
      return false;
    }
  }
  try {
    process.kill(processId, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

async function cleanupDeployerXProcesses({ includeCurrentExecutable = false, allowElevation = false } = {}) {
  // The detached worker is a child of the desktop process. It must never
  // perform stale-root cleanup because its parent is the live GUI instance.
  if (isWorkerMode()) return [];
  const records = await listWindowsDeployerXProcesses();
  const stale = selectDeployerXProcesses(records, {
    currentPid: process.pid,
    currentExecutablePath: process.execPath,
    includeCurrentExecutable
  });
  const stopped = [];
  for (const record of stale) {
    if (await terminateProcessTree(record.pid, { allowElevation })) stopped.push(record.pid);
  }
  if (stopped.length) console.info(`[process-lifecycle] Stopped ${stopped.length} stale DeployerX process(es).`);
  return stopped;
}

async function stopDetachedUptimeWorker({ force = false } = {}) {
  if (isWorkerMode()) return [];
  const workerPids = new Set();
  if (detachedUptimeWorkerPid) workerPids.add(Number(detachedUptimeWorkerPid));
  if (force) {
    const runtimePid = Number(uptimeRuntimeCache?.worker?.pid || 0);
    if (runtimePid) workerPids.add(runtimePid);
  }
  const stopped = [];
  for (const pid of workerPids) {
    if (await terminateProcessTree(pid)) stopped.push(pid);
  }
  detachedUptimeWorkerPid = 0;
  uptimeWorkerLaunchPromise = null;
  uptimeWorkerLaunchError = '';
  return stopped;
}

async function prepareForUpdateInstall() {
  updateInstallRequested = true;
  await stopDetachedUptimeWorker({ force: true }).catch(() => {});
  await cleanupDeployerXProcesses({ includeCurrentExecutable: true, allowElevation: true }).catch(() => {});
}

async function handleApplicationStartupFailure(error) {
  if (startupFailureHandled) return;
  startupFailureHandled = true;
  isAppQuitting = true;
  console.error(`[startup] DeployerX could not start: ${String(error?.stack || error?.message || error)}`);
  await stopDetachedUptimeWorker({ force: true }).catch(() => {});
  await cleanupDeployerXProcesses({ includeCurrentExecutable: true, allowElevation: true }).catch(() => {});
  if (app.isReady()) app.quit();
}

function markUpdaterUnavailable(status, message) {
  return syncUpdateState({
    enabled: false,
    status,
    availableVersion: '',
    downloadedVersion: '',
    releaseName: '',
    releaseDate: '',
    downloadPercent: 0,
    downloadUrl: '',
    message,
    error: ''
  });
}

function normalizeVersion(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .replace(/\+.*$/, '');
}

function parseVersion(version) {
  const normalized = normalizeVersion(version);
  const [main = '', preRelease = ''] = normalized.split('-', 2);
  const parts = main
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
  while (parts.length < 3) parts.push(0);
  return { parts, preRelease };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }

  if (!a.preRelease && !b.preRelease) return 0;
  if (!a.preRelease) return 1;
  if (!b.preRelease) return -1;
  return a.preRelease.localeCompare(b.preRelease, undefined, { numeric: true, sensitivity: 'base' });
}

function pickWindowsSetupAsset(assets = []) {
  const candidates = Array.isArray(assets) ? assets : [];
  return (
    candidates.find((asset) => /setup.*\.exe$/i.test(asset?.name || '')) ||
    candidates.find((asset) => /\.exe$/i.test(asset?.name || '') && !/portable/i.test(asset?.name || '')) ||
    null
  );
}

function friendlyUpdateError(error, fallback = 'Could not check GitHub releases.') {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return fallback;

  if (/cannot find latest\.yml/i.test(raw) || (/404/i.test(raw) && /latest\.yml/i.test(raw))) {
    return 'This GitHub release is missing the latest.yml update manifest. Open Releases to download the latest setup build manually.';
  }

  let message = raw
    .replace(/^Error:\s*/i, '')
    .replace(/^HttpError:\s*/i, '')
    .replace(/\\n/g, '\n')
    .replace(/\s*Headers:\s*[\s\S]*$/i, '')
    .replace(/\s+at\s+[\s\S]*$/i, '')
    .replace(/\n+/g, ' ')
    .trim();

  if (/rate limit/i.test(message)) return 'GitHub rate limits prevented checking for updates right now. Please try again shortly.';
  if (/unauthorized|forbidden|authentication token/i.test(message)) {
    return 'GitHub release access is blocked for this build right now. Open Releases to download updates manually.';
  }

  return message || fallback;
}

async function fetchLatestGitHubRelease() {
  if (!githubReleaseSource?.latestReleaseApiUrl) return null;

  const response = await fetch(githubReleaseSource.latestReleaseApiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `${app.getName()}/${app.getVersion()}`
    }
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    const body = await readJsonResponse(response);
    const error = new Error(body?.message || `GitHub release check failed with status ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  const release = await readJsonResponse(response);
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const manifest = assets.find((asset) => String(asset?.name || '').toLowerCase() === WINDOWS_UPDATE_MANIFEST);
  const setupAsset = pickWindowsSetupAsset(assets);

  return {
    version: normalizeVersion(release?.tag_name || release?.name || ''),
    tagName: String(release?.tag_name || '').trim(),
    releaseName: String(release?.name || '').trim(),
    releaseDate: release?.published_at || release?.created_at || '',
    releasePageUrl: String(release?.html_url || githubReleaseSource.releasesUrl || '').trim(),
    downloadUrl: String(setupAsset?.browser_download_url || release?.html_url || githubReleaseSource.releasesUrl || '').trim(),
    hasManifest: Boolean(manifest?.browser_download_url)
  };
}

async function preflightGitHubReleaseCheck() {
  const release = await fetchLatestGitHubRelease();
  if (!release?.version) {
    return {
      mode: 'no-release',
      state: {
        enabled: true,
        status: 'idle',
        availableVersion: '',
        downloadedVersion: '',
        releaseName: '',
        releaseDate: '',
        downloadPercent: 0,
        lastCheckedAt: new Date().toISOString(),
        downloadUrl: '',
        message: 'No published GitHub release was found yet.',
        error: ''
      }
    };
  }

  const currentVersion = app.getVersion();
  const isNewerRelease = compareVersions(release.version, currentVersion) > 0;

  if (!release.hasManifest) {
    return {
      mode: 'manual',
      state: {
        enabled: true,
        status: isNewerRelease ? 'manual-update' : 'up-to-date',
        availableVersion: isNewerRelease ? release.version : '',
        downloadedVersion: '',
        releaseName: release.releaseName,
        releaseDate: release.releaseDate,
        downloadPercent: 0,
        lastCheckedAt: new Date().toISOString(),
        releasePageUrl: release.releasePageUrl,
        downloadUrl: release.downloadUrl,
        message: isNewerRelease
          ? `Version ${release.version} is available, but this release is missing the Windows update manifest. Download the latest setup build from Releases.`
          : 'This installed version matches the latest GitHub release. Automatic update metadata is missing for that release, so future updates may need to be downloaded from Releases.',
        error: ''
      }
    };
  }

  return { mode: 'auto', release };
}

async function checkForAppUpdates({ manual = false } = {}) {
  if (!updaterInitialized) initializeAutoUpdater();
  if (!updateState.enabled) return publicUpdateState();
  if (['checking', 'downloading'].includes(updateState.status)) return publicUpdateState();
  try {
    if (manual) {
      syncUpdateState({
        error: '',
        message: 'Checking GitHub releases for updates...'
      });
    }

    const preflight = await preflightGitHubReleaseCheck();
    if (preflight?.mode === 'manual' || preflight?.mode === 'no-release') {
      return syncUpdateState(preflight.state);
    }

    await autoUpdater.checkForUpdates();
  } catch (error) {
    syncUpdateState({
      status: 'error',
      lastCheckedAt: new Date().toISOString(),
      downloadPercent: 0,
      message: 'Could not check GitHub releases.',
      error: friendlyUpdateError(error)
    });
  }
  return publicUpdateState();
}

function scheduleAutoUpdateChecks() {
  if (autoUpdateTimer) clearInterval(autoUpdateTimer);
  setTimeout(() => {
    checkForAppUpdates().catch(() => {});
    autoUpdateTimer = setInterval(() => {
      checkForAppUpdates().catch(() => {});
    }, AUTO_UPDATE_INTERVAL_MS);
  }, AUTO_UPDATE_CHECK_DELAY_MS);
}

function initializeAutoUpdater() {
  if (updaterInitialized) {
    sendUpdateStateToRenderer();
    return;
  }
  updaterInitialized = true;

  if (!githubReleaseSource) {
    markUpdaterUnavailable('unconfigured', 'GitHub release tracking is not configured for this app yet.');
    return;
  }

  if (!app.isPackaged) {
    markUpdaterUnavailable('development', 'Auto updates are available in packaged builds. Use a packaged setup build to test release tracking.');
    return;
  }

  if (process.platform !== 'win32') {
    markUpdaterUnavailable('unsupported', 'Automatic updates are enabled for the Windows setup build only.');
    return;
  }

  if (isPortableWindowsBuild()) {
    markUpdaterUnavailable('portable', 'Portable builds cannot install updates automatically. Open GitHub releases to download the latest setup build.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    syncUpdateState({
      enabled: true,
      status: 'checking',
      availableVersion: '',
      downloadedVersion: '',
      downloadPercent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: 'Checking GitHub releases for updates...',
      error: ''
    });
  });

  autoUpdater.on('update-available', (info) => {
    syncUpdateState({
      enabled: true,
      status: 'available',
      availableVersion: info?.version || '',
      downloadedVersion: '',
      releaseName: info?.releaseName || '',
      releaseDate: info?.releaseDate || '',
      downloadPercent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: `Update ${info?.version || 'available'} found. Downloading now...`,
      error: ''
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    syncUpdateState({
      enabled: true,
      status: 'downloading',
      downloadPercent: Number(progress?.percent || 0),
      message: `Downloading version ${updateState.availableVersion || 'update'}...`,
      error: ''
    });
  });

  autoUpdater.on('update-not-available', () => {
    syncUpdateState({
      enabled: true,
      status: 'up-to-date',
      availableVersion: '',
      downloadedVersion: '',
      releaseName: '',
      releaseDate: '',
      downloadPercent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: 'You are already on the latest published release.',
      error: ''
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    syncUpdateState({
      enabled: true,
      status: 'downloaded',
      downloadedVersion: info?.version || updateState.availableVersion || '',
      releaseName: info?.releaseName || updateState.releaseName || '',
      releaseDate: info?.releaseDate || updateState.releaseDate || '',
      downloadPercent: 100,
      lastCheckedAt: new Date().toISOString(),
      message: `Version ${info?.version || updateState.availableVersion || 'update'} is ready. Restart DeployerX to install it.`,
      error: ''
    });
  });

  autoUpdater.on('error', (error) => {
    syncUpdateState({
      enabled: true,
      status: 'error',
      downloadPercent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: 'Could not reach the GitHub release feed.',
      error: friendlyUpdateError(error, 'Could not reach the GitHub release feed.')
    });
  });

  syncUpdateState({
    enabled: true,
    status: 'idle',
    message: 'GitHub release tracking is enabled for this installed build.',
    error: ''
  });
  scheduleAutoUpdateChecks();
}

function requestInAppConfirmation({ message, detail = '', confirmLabel = 'Confirm' }) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);

  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(id);
      resolve(false);
    }, 120000);

    pendingConfirmations.set(id, { resolve, timer });

    try {
      mainWindow.webContents.send('ui:confirm-request', { id, message, detail, confirmLabel });
    } catch {
      clearTimeout(timer);
      pendingConfirmations.delete(id);
      resolve(false);
    }
  });
}

ipcMain.handle('ui:confirm-response', async (_event, payload = {}) => {
  const pending = pendingConfirmations.get(payload.id);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingConfirmations.delete(payload.id);
  pending.resolve(Boolean(payload.confirmed));
  return true;
});

function normalizeTemplateCategory(category) {
  const value = String(category || '').trim();
  return TEMPLATE_CATEGORIES.includes(value) ? value : 'Server';
}

function normalizeStoredTemplate(template = {}) {
  const commands = Array.isArray(template.commands)
    ? template.commands.map((command) => String(command)).filter((command) => command.trim())
    : [];
  const variables =
    Array.isArray(template.variables) && template.variables.length
      ? template.variables.map((variable) => String(variable))
      : extractTemplateVariables(commands);

  return {
    ...template,
    category: normalizeTemplateCategory(template.category),
    commands,
    variables,
    builtIn: Boolean(template.builtIn),
    readOnly: Boolean(template.readOnly),
    source: template.source ? String(template.source) : template.builtIn ? 'library' : 'user'
  };
}

function buildBuiltInTemplates() {
  return BUILT_IN_TEMPLATES.map((template) =>
    normalizeStoredTemplate({
      ...template,
      builtIn: true,
      readOnly: true,
      source: 'library',
      updatedAt: '2026-05-16T00:00:00.000Z'
    })
  );
}

function mergeBuiltInTemplates(templates = []) {
  const items = (Array.isArray(templates) ? templates : [])
    .map(normalizeStoredTemplate)
    .filter((template) => !template.builtIn && !String(template.id || '').startsWith(BUILT_IN_TEMPLATE_PREFIX));

  return [...buildBuiltInTemplates(), ...items];
}

function stripBuiltInTemplates(templates = []) {
  return (Array.isArray(templates) ? templates : [])
    .map(normalizeStoredTemplate)
    .filter((template) => !template.builtIn && !String(template.id || '').startsWith(BUILT_IN_TEMPLATE_PREFIX))
    .map((template) => {
      const copy = { ...template };
      delete copy.builtIn;
      delete copy.readOnly;
      if (copy.source === 'user') delete copy.source;
      return copy;
    });
}

function getStorePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function getMcpTokenPath() {
  return path.join(app.getPath('userData'), MCP_TOKEN_FILE);
}

function getUserFirebaseConfigPath() {
  return path.join(app.getPath('userData'), 'firebase.config.json');
}

function getUptimeRootPath() {
  return path.join(app.getPath('userData'), 'uptime');
}

function getUptimeControlRootPath() {
  return path.join(app.getPath('userData'), 'uptime-monitor');
}

function getBackupManagerRootPath() {
  return path.join(app.getPath('userData'), 'backup-manager');
}

function getDatabasePluginRegistry() {
  if (!databasePluginRegistry) throw new Error('Database plugin registry is not initialized.');
  return databasePluginRegistry;
}

function getDatabasePluginHealthStore() {
  if (!databasePluginHealthStore) throw new Error('Database plugin health store is not initialized.');
  return databasePluginHealthStore;
}

async function listDatabasePluginsWithHealth() {
  const plugins = getDatabasePluginRegistry().list();
  const [healthRecords, runtimeRequirements] = await Promise.all([
    getDatabasePluginHealthStore().list(),
    Promise.all(plugins.map((plugin) => inspectCachedPluginRuntimeRequirement(plugin.runtimeRequirement)))
  ]);
  const health = new Map(healthRecords.map((record) => [record.pluginId, record]));
  return plugins.map((plugin, index) => ({ ...plugin, runtimeRequirement: runtimeRequirements[index], health: health.get(plugin.pluginId) || null }));
}

const databasePluginRuntimeRequirementCache = new Map();

async function inspectCachedPluginRuntimeRequirement(requirement) {
  if (!requirement) return null;
  const key = `${requirement.id}:${requirement.minimumVersion || ''}:${requirement.label || ''}`;
  const cached = databasePluginRuntimeRequirementCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await inspectPluginRuntimeRequirement(requirement);
  databasePluginRuntimeRequirementCache.set(key, { value, expiresAt: Date.now() + 30000 });
  return value;
}

async function checkDatabasePluginHealth(pluginId) {
  const installed = getDatabasePluginRegistry().getInstalled(pluginId);
  if (!installed) throw Object.assign(new Error('Enable this plugin before checking its runtime health.'), { code: 'DATABASE_PLUGIN_NOT_ENABLED' });
  try {
    await databaseDriverRuntimeRegistry.get(pluginId).health({ timeoutMs: 5000 });
    const health = await getDatabasePluginHealthStore().recordHealth(pluginId, { ok: true });
    sendDatabaseManagerEvent('device', 'plugin-state', { pluginId, state: health.status });
    return health;
  } catch (error) {
    const health = await getDatabasePluginHealthStore().recordHealth(pluginId, { ok: false, errorCode: error.code });
    sendDatabaseManagerEvent('device', 'plugin-state', { pluginId, state: health.status, code: health.lastErrorCode });
    return health;
  }
}

async function registerDatabasePluginRuntime(pluginId) {
  const installed = getDatabasePluginRegistry().getInstalled(pluginId);
  if (!installed?.entrypoint || !installed.driverManifest) return false;
  const runtimeRequirement = await inspectCachedPluginRuntimeRequirement(pluginRuntimeRequirement(installed.entrypoint, installed.pluginId));
  if (runtimeRequirement?.status === 'unavailable') {
    throw Object.assign(new Error(runtimeRequirement.reason), { code: 'DATABASE_PLUGIN_RUNTIME_UNAVAILABLE' });
  }
  const closedSessions = await databaseConnectionService?.closeDriver(pluginId) || [];
  for (const session of closedSessions) {
    sendDatabaseManagerEvent(session.workspaceId, 'connection-status', { profileId: session.profileId, state: 'closed', operation: 'driver-reload' });
  }
  await databaseDriverRuntimeRegistry.unregister(pluginId);
  databaseDriverRuntimeRegistry.register(pluginId, createInstalledPluginRuntime({
    installed,
    beforeStart: () => getDatabasePluginRegistry().verifyInstalled(pluginId),
    onDiagnostic: (diagnostic) => {
      databasePluginHealthStore?.recordDiagnostic(pluginId, diagnostic.event, diagnostic.details).then((health) => {
        if (['ready', 'warning', 'crashed'].includes(health.status)) sendDatabaseManagerEvent('device', 'plugin-state', { pluginId, state: health.status, code: health.lastErrorCode });
      }).catch(() => {});
      getBackupLogStore().logger({ workspaceId: 'local', component: 'database-plugin-runtime' }).warn('Database plugin runtime diagnostic.', { pluginId, event: diagnostic.event, details: diagnostic.details }).catch(() => {});
    }
  }), installed.driverManifest);
  await databasePluginHealthStore?.recordDiagnostic(pluginId, 'registered').catch(() => {});
  return true;
}

async function refreshDatabasePluginCatalog() {
  if (!tabulariumClient) tabulariumClient = new TabulariumClient();
  const catalog = await tabulariumClient.loadCatalog();
  getDatabasePluginRegistry().setCatalog(catalog);
  databasePluginRuntimeRequirementCache.clear();
  sendDatabaseManagerEvent('device', 'plugin-state', { state: 'catalog-refreshed' });
  return listDatabasePluginsWithHealth();
}

async function recheckDatabasePluginRuntimeRequirements() {
  databasePluginRuntimeRequirementCache.clear();
  return listDatabasePluginsWithHealth();
}

async function extractDatabasePluginArchive(archive, destination, options = {}) {
  const temporaryPath = path.join(os.tmpdir(), `deployerx-plugin-${crypto.randomUUID()}.archive`);
  try {
    await fs.writeFile(temporaryPath, archive, { mode: 0o600 });
    const listing = await new Promise((resolve, reject) => {
      execFile('tar.exe', ['-tf', temporaryPath], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout || '')));
    });
    const entries = listing.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map((entry) => ({ path: entry, size: 0, executable: entry.replaceAll('\\', '/') === String(options.entrypoint || '').replaceAll('\\', '/') }));
    safeArchiveEntries(entries, options.entrypoint);
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    await new Promise((resolve, reject) => {
      execFile('tar.exe', ['-xf', temporaryPath, '-C', destination, '--no-same-owner', '--no-same-permissions'], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error) => error ? reject(error) : resolve());
    });
    return entries;
  } catch (error) {
    throw Object.assign(new Error('The plugin archive could not be safely extracted.'), { code: 'DATABASE_PLUGIN_EXTRACTION_FAILED', category: 'database-plugin', retryable: false, cause: error });
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function getBackupSecretStore() {
  if (!backupSecretStore) {
    backupSecretStore = new BackupSecretStore({
      rootPath: getBackupManagerRootPath(),
      secureStorage: safeStorage,
      isReferenced: async ({ workspaceId, id }) => {
        if (!backupControlDatabase) return true;
        const [connections, repositories, routes, uptimeMonitors] = await Promise.all([
          backupControlDatabase.repository('connection').list(workspaceId, { includeDeleted: true, limit: 1000 }),
          backupControlDatabase.repository('repository').list(workspaceId, { includeDeleted: true, limit: 1000 }),
          backupControlDatabase.repository('notificationRoute').list(workspaceId, { includeDeleted: true, limit: 1000 }),
          uptimeControlDatabase ? uptimeControlDatabase.listMonitors(workspaceId, { includeDeleted: true, limit: 10000 }).catch(() => []) : Promise.resolve([])
        ]);
        return connections.some((record) => !record.deletedAt && record.secretRefIds?.includes(id))
          || routes.some((record) => !record.deletedAt && record.secretRefIds?.includes(id))
          || repositories.some((record) => record.encryptionKeyRefId === id || (!record.deletedAt && record.secretRefIds?.includes(id)))
          || uptimeMonitors.some((monitor) => !monitor.deletedAt && Object.values(monitor.config?.secretHeaderRefs || {}).includes(id));
      }
    });
  }
  return backupSecretStore;
}

function getBackupAuditStore() {
  if (!backupAuditStore) {
    backupAuditStore = new BackupAuditStore({ rootPath: path.join(getBackupManagerRootPath(), 'audit') });
  }
  return backupAuditStore;
}

function getBackupLogStore() {
  if (!backupLogStore) {
    backupLogStore = new StructuredLogStore({ rootPath: path.join(getBackupManagerRootPath(), 'logs') });
  }
  return backupLogStore;
}

async function initializeBackupControlDatabase() {
  const controlDatabase = new BackupControlDatabase({
    rootPath: getBackupManagerRootPath(),
    onChange: (changes) => {
      if (!workspaceControlChangeHandlerEnabled) return;
      syncWorkspaceControlChangesToCloud(changes).catch(async (error) => {
        await logWorkspaceControlSyncFailure(error).catch(() => {});
      });
    }
  });
  try {
    await controlDatabase.initialize();
    backupControlDatabase = controlDatabase;
    backupDeviceId = await loadOrCreateBackupDeviceId(getBackupManagerRootPath());
    const databaseProfileStore = new DatabaseProfileStore({ controlDatabase });
    databaseProfileService = new DatabaseProfileService({
      profileStore: databaseProfileStore,
      controlDatabase,
      secretStore: getBackupSecretStore(),
      driverResolver: (driverId) => databasePluginRegistry?.getDriverManifest(driverId) || null
    });
    const databaseDriverHostPath = resolveDatabaseDriverHostPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    });
    const databaseDriverHostAvailable = await fs.stat(databaseDriverHostPath).then((stat) => stat.isFile()).catch(() => false);
    const databaseDriverHost = databaseDriverHostAvailable
      ? new SidecarDriverRuntime({ executablePath: databaseDriverHostPath })
      : new DirectDatabaseDriverRuntime();
    databaseDriverRuntimeRegistry = new DatabaseDriverRuntimeRegistry()
      .register('postgresql', databaseDriverHost)
      .register('mysql', databaseDriverHost)
      .register('sqlite', databaseDriverHost);
    databaseLocalResourceStore = new DatabaseLocalResourceStore({ rootPath: path.join(getBackupManagerRootPath(), 'database-manager') });
    await databaseLocalResourceStore.initialize();
    databaseConnectionImportService = new DatabaseConnectionImportService({
      controlDatabase,
      profileStore: databaseProfileStore,
      localResourceStore: databaseLocalResourceStore,
      deviceId: backupDeviceId
    });
    databasePluginHealthStore = new DatabasePluginHealthStore({ rootPath: path.join(getBackupManagerRootPath(), 'database-manager', 'plugins') });
    await databasePluginHealthStore.initialize();
    databaseOperationalEvidenceStore = new DatabaseOperationalEvidenceStore({ rootPath: path.join(getBackupManagerRootPath(), 'database-manager') });
    await databaseOperationalEvidenceStore.initialize();
    try {
      databaseCloudSyncOutbox = new DatabaseCloudSyncOutbox({ rootPath: path.join(getBackupManagerRootPath(), 'database-manager') });
      await databaseCloudSyncOutbox.initialize();
    } catch (error) {
      databaseCloudSyncOutbox = null;
      await getBackupLogStore().logger({ workspaceId: 'local', component: 'database-cloud-sync' }).warn(
        'Database profile cloud synchronization could not initialize.',
        { code: error.code || 'DATABASE_MANAGER_CLOUD_SYNC_INIT_FAILED' }
      ).catch(() => {});
    }
    tabulariumClient = new TabulariumClient();
    databasePluginRegistry = new DatabasePluginRegistry({
      rootPath: path.join(getBackupManagerRootPath(), 'database-manager', 'plugins'),
      download: async (url, { maxBytes } = {}) => {
        const response = await fetch(url);
        if (!response.ok) throw Object.assign(new Error('The plugin archive could not be downloaded.'), { code: 'DATABASE_PLUGIN_DOWNLOAD_FAILED', retryable: true });
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > Number(maxBytes || 0)) throw Object.assign(new Error('The plugin archive is larger than its manifest limit.'), { code: 'DATABASE_PLUGIN_RELEASE_TOO_LARGE' });
        return buffer;
      },
      extract: extractDatabasePluginArchive,
      verifySignature: ({ release }) => tabulariumClient.verifyRelease(release)
    });
    await databasePluginRegistry.initialize();
    for (const plugin of databasePluginRegistry.listInstalled()) {
      await registerDatabasePluginRuntime(plugin.pluginId).catch(() => {});
    }
    refreshDatabasePluginCatalog().catch(() => {});
    const databaseTunnelService = new DatabaseServerTunnelService({
      projectResolver: async ({ projectId }) => {
        const store = await readCurrentStore();
        return (store.projects || []).find((project) => String(project.id) === String(projectId)) || null;
      },
      sshConfigResolver: (project) => {
        const validationError = validateConnectionProject(project, { requireSsh: true });
        if (validationError) throw new Error(validationError);
        return toConnectionConfig(project);
      }
    });
    databaseConnectionService = new DatabaseConnectionService({
      profileService: databaseProfileService,
      secretStore: getBackupSecretStore(),
      runtimeRegistry: databaseDriverRuntimeRegistry,
      localResourceResolver: (input) => databaseLocalResourceStore.resolve(input),
      tunnelProvider: databaseTunnelService
    });
    databaseAccessCompanionService = new DatabaseAccessCompanionService({
      executablePath: resolveDatabaseAccessCompanionExecutablePath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      }),
      prepareConnection: async ({ workspaceId, actorId, profileId }) => {
        const context = Object.freeze({ workspaceId, actorId });
        const profile = await requireReadyDatabaseAccessProfile(context, profileId);
        const connection = await resolveRuntimeConnection({
          workspaceId: context.workspaceId,
          profile,
          secretStore: getBackupSecretStore(),
          localResourceResolver: (input) => databaseLocalResourceStore.resolve(input),
          tunnelProvider: databaseTunnelService
        });
        return {
          profileName: profile.name,
          driverId: profile.driverId,
          readOnly: profile.accessMode === 'read-only',
          themeId: readThemePreferenceSync(),
          connection
        };
      },
      cleanupConnection: async (prepared) => releaseRuntimeConnection(prepared.connection),
      onStateChange: ({ workspaceId, profileId, state, reason }) => {
        sendDatabaseManagerEvent(workspaceId, 'access-manager-state', { profileId, state, reason });
      }
    });
    databaseQueryWorkspaceStore = new DatabaseQueryWorkspaceStore({ controlDatabase });
    databaseTaskService = new DatabaseTaskService({
      store: new DatabaseTaskStore({ controlDatabase }),
      onEvent: (workspaceId, task) => sendDatabaseManagerEvent(workspaceId, 'task-state', {
        taskId: task.id,
        profileId: task.profileId,
        state: task.state,
        phase: task.progress?.phase,
        percent: task.progress?.percent
      })
    });
    databaseOperationalLogService = new DatabaseOperationalLogService({
      profileService: databaseProfileService,
      queryWorkspaceStore: databaseQueryWorkspaceStore,
      taskService: databaseTaskService,
      pluginHealthStore: databasePluginHealthStore,
      operationalEvidenceStore: databaseOperationalEvidenceStore
    });
    databaseQueryService = new DatabaseQueryService({
      profileService: databaseProfileService,
      secretStore: getBackupSecretStore(),
      runtimeRegistry: databaseDriverRuntimeRegistry,
      connectionService: databaseConnectionService,
      localResourceResolver: (input) => databaseLocalResourceStore.resolve(input),
      tunnelProvider: databaseTunnelService,
      historyRecorder: (workspaceId, actorId, input) => databaseQueryWorkspaceStore.recordHistory(workspaceId, actorId, input)
    });
    databaseDefinitionExecutor = new DatabaseDefinitionExecutor({
      profileService: databaseProfileService,
      secretStore: getBackupSecretStore(),
      runtimeRegistry: databaseDriverRuntimeRegistry,
      localResourceResolver: (input) => databaseLocalResourceStore.resolve(input),
      tunnelProvider: databaseTunnelService
    });
    databaseExplainService = new DatabaseExplainService({
      profileService: databaseProfileService,
      queryService: databaseQueryService,
      taskService: databaseTaskService
    });
    databaseTransferService = new DatabaseTransferService({
      profileService: databaseProfileService,
      secretStore: getBackupSecretStore(),
      taskService: databaseTaskService,
      localResourceResolver: (input) => databaseLocalResourceStore.resolve(input),
      tunnelProvider: databaseTunnelService,
      showOpenDialog: (options) => dialog.showOpenDialog(mainWindow, options),
      showSaveDialog: (options) => dialog.showSaveDialog(mainWindow, options)
    });
    databaseSchemaService = new DatabaseSchemaService({
      profileService: databaseProfileService,
      secretStore: getBackupSecretStore(),
      runtimeRegistry: databaseDriverRuntimeRegistry,
      connectionService: databaseConnectionService,
      localResourceResolver: (input) => databaseLocalResourceStore.resolve(input),
      tunnelProvider: databaseTunnelService
    });
    databaseSchemaAdministrationService = new DatabaseSchemaAdministrationService({
      profileService: databaseProfileService,
      queryService: databaseQueryService,
      taskService: databaseTaskService,
      definitionExecutor: databaseDefinitionExecutor
    });
    databasePrincipalAdministrationService = new DatabasePrincipalAdministrationService({
      profileService: databaseProfileService,
      queryService: databaseQueryService,
      taskService: databaseTaskService,
      definitionExecutor: databaseDefinitionExecutor
    });
    databaseRowCrudService = new DatabaseRowCrudService({
      profileService: databaseProfileService,
      schemaService: databaseSchemaService,
      queryService: databaseQueryService
    });
    databaseBackupHandoffService = new DatabaseBackupHandoffService({
      controlDatabase,
      profileService: databaseProfileService,
      deviceId: backupDeviceId,
      localResourceResolver: (input) => databaseLocalResourceStore.resolve(input)
    });
    backupLocalConnectionService = new LocalConnectionService({
      controlDatabase,
      deviceId: backupDeviceId
    });
    backupSshConnectionService = new SshConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId });
    const mysqlAdapter = new MysqlLogicalAdapter();
    const mariadbAdapter = new MariadbLogicalAdapter();
    const postgresqlAdapter = new PostgresqlLogicalAdapter();
    const sqlServerAdapter = new SqlServerNativeAdapter();
    const oracleAdapter = new OracleRmanAdapter();
    const mongoDbAdapter = new MongoDbNativeAdapter();
    const neo4jAdapter = new Neo4jAdapter();
    const clickHouseAdapter = new ClickHouseAdapter();
    const cockroachDbAdapter = new CockroachDbAdapter();
    const influxDbAdapter = new InfluxDbOssV2Adapter();
    const influxDb3CoreAdapter = new InfluxDb3CoreAdapter();
    const influxDb3EnterpriseAdapter = new InfluxDb3EnterpriseAdapter();
    const redisAdapter = new RedisNativeAdapter();
    const searchSnapshotAdapter = new SearchSnapshotAdapter();
    const cassandraScyllaAdapter = new CassandraScyllaAdapter();
    const scyllaManagerAdapter = new ScyllaManagerAdapter();
    const sqliteAdapter = new SqliteNativeAdapter();
    const databaseAdapterRegistry = new DatabaseAdapterRegistry([mysqlAdapter, mariadbAdapter, postgresqlAdapter, sqlServerAdapter, oracleAdapter, mongoDbAdapter, neo4jAdapter, clickHouseAdapter, cockroachDbAdapter, influxDbAdapter, influxDb3CoreAdapter, influxDb3EnterpriseAdapter, redisAdapter, searchSnapshotAdapter, cassandraScyllaAdapter, scyllaManagerAdapter, sqliteAdapter]);
    backupMysqlConnectionService = new MysqlConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: mysqlAdapter });
    backupMariadbConnectionService = new MariadbConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: mariadbAdapter });
    backupPostgresqlConnectionService = new PostgresqlConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: postgresqlAdapter });
    backupSqlServerConnectionService = new SqlServerConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: sqlServerAdapter });
    backupOracleConnectionService = new OracleConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: oracleAdapter });
    backupMongoDbConnectionService = new MongoDbConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: mongoDbAdapter });
    backupNeo4jConnectionService = new Neo4jConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: neo4jAdapter });
    backupClickHouseConnectionService = new ClickHouseConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: clickHouseAdapter });
    backupCockroachDbConnectionService = new CockroachDbConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: cockroachDbAdapter });
    backupCockroachDbScheduleService = new CockroachDbScheduleService({ controlDatabase, connectionService: backupCockroachDbConnectionService, deviceId: backupDeviceId });
    backupInfluxDbConnectionService = new InfluxDbConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: influxDbAdapter });
    backupInfluxDb3CoreConnectionService = new InfluxDb3CoreConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: influxDb3CoreAdapter });
    backupInfluxDb3EnterpriseConnectionService = new InfluxDb3EnterpriseConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: influxDb3EnterpriseAdapter });
    backupRedisConnectionService = new RedisConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: redisAdapter });
    backupSearchSnapshotConnectionService = new SearchSnapshotConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: searchSnapshotAdapter });
    backupCassandraScyllaConnectionService = new CassandraScyllaConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: cassandraScyllaAdapter });
    backupScyllaManagerConnectionService = new ScyllaManagerConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: scyllaManagerAdapter });
    backupSqliteConnectionService = new SqliteConnectionService({ controlDatabase, deviceId: backupDeviceId, adapter: sqliteAdapter });
    backupDatabaseSourceService = new DatabaseSourceService({
      controlDatabase,
      adapterRegistry: databaseAdapterRegistry,
      deviceId: backupDeviceId,
      allowedAdapterIds: CORE_DATABASE_ADAPTER_IDS
    });
    backupFileSourceService = new FileSourceService({ controlDatabase });
    backupLocalRepositoryService = new LocalRepositoryService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, connectionService: backupLocalConnectionService });
    backupSftpRepositoryService = new SftpRepositoryService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId });
    backupS3ConnectionService = new S3StorageConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId });
    backupS3RepositoryService = new S3RepositoryService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, connectionService: backupS3ConnectionService });
    backupStorageBackendRegistry = createBuiltInStorageBackendRegistry({
      localService: backupLocalRepositoryService,
      sftpService: backupSftpRepositoryService,
      s3Service: backupS3RepositoryService,
      localConnectionService: backupLocalConnectionService,
      sshConnectionService: backupSshConnectionService,
      s3ConnectionService: backupS3ConnectionService
    });
    backupStorageConnectionService = new StorageConnectionService({ controlDatabase, secretStore: getBackupSecretStore(), registry: backupStorageBackendRegistry });
    backupDestinationService = new StorageDestinationService({ controlDatabase, registry: backupStorageBackendRegistry });
    backupJobService = new BackupJobService({ controlDatabase, deviceId: backupDeviceId });
    backupObjectiveStatusService = new BackupObjectiveStatusService({ controlDatabase });
    backupNotificationService = new BackupNotificationService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      desktopNotifier: async ({ title, body, silent, event }) => {
        if (!Notification.isSupported()) throw new Error('Desktop notifications are unavailable.');
        const notification = new Notification({ title, body, silent });
        notification.on('click', () => openNotificationTarget(event));
        notification.show();
      },
      fetchImpl: global.fetch,
      mailerFactory: (configuration) => nodemailer.createTransport(configuration)
    });
    const fileSourceReader = new FileSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId });
    const mysqlSourceReader = new MysqlSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: mysqlAdapter });
    const mariadbSourceReader = new MariadbSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: mariadbAdapter });
    const postgresqlSourceReader = new PostgresqlSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: postgresqlAdapter });
    const sqlServerSourceReader = new SqlServerSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: sqlServerAdapter });
    const oracleSourceReader = new OracleSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: oracleAdapter });
    const mongoDbSourceReader = new MongoDbSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: mongoDbAdapter });
    let openRepository = null;
    const cockroachDbSourceReader = new CockroachDbSourceReaderService({ controlDatabase, deviceId: backupDeviceId, connectionService: backupCockroachDbConnectionService, adapterRegistry: databaseAdapterRegistry, openRepository: (...args) => openRepository(...args) });
    const neo4jSourceReader = new Neo4jSourceReaderService({ controlDatabase, deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: neo4jAdapter, connectionService: backupNeo4jConnectionService, openRepository: (...args) => openRepository(...args) });
    const clickHouseSourceReader = new ClickHouseSourceReaderService({ controlDatabase, deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: clickHouseAdapter, connectionService: backupClickHouseConnectionService, openRepository: (...args) => openRepository(...args) });
    const influxDbSourceReader = new InfluxDbSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: influxDbAdapter, connectionService: backupInfluxDbConnectionService });
    const influxDb3CoreSourceReader = new InfluxDb3CoreSourceReaderService({ controlDatabase, deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: influxDb3CoreAdapter, connectionService: backupInfluxDb3CoreConnectionService });
    const influxDb3EnterpriseNativeSourceReader = new InfluxDb3EnterpriseSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: influxDb3EnterpriseAdapter });
    const influxDb3EnterpriseLegacySourceReader = new InfluxDb3EnterpriseLegacySourceReaderService({ controlDatabase, deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry });
    const influxDb3EnterpriseSourceReader = new InfluxDb3EnterpriseSourceReaderRouter({ controlDatabase, nativeReader: influxDb3EnterpriseNativeSourceReader, legacyReader: influxDb3EnterpriseLegacySourceReader });
    const sqliteSourceReader = new SqliteSourceReaderService({ controlDatabase, deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: sqliteAdapter });
    const redisSourceReader = new RedisSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: redisAdapter });
    const searchSnapshotSourceReader = new SearchSnapshotSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: searchSnapshotAdapter });
    const cassandraScyllaSourceReader = new CassandraScyllaSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: cassandraScyllaAdapter });
    const scyllaManagerSourceReader = new ScyllaManagerSourceReaderService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapterRegistry: databaseAdapterRegistry, adapter: scyllaManagerAdapter });
    const sourceReader = new BackupSourceReaderRouter({ controlDatabase, fileReader: fileSourceReader, databaseReaders: { [MYSQL_ADAPTER_ID]: mysqlSourceReader, [MARIADB_ADAPTER_ID]: mariadbSourceReader, [POSTGRESQL_ADAPTER_ID]: postgresqlSourceReader, [SQLSERVER_ADAPTER_ID]: sqlServerSourceReader, [ORACLE_ADAPTER_ID]: oracleSourceReader, [MONGODB_ADAPTER_ID]: mongoDbSourceReader, [NEO4J_ADAPTER_ID]: neo4jSourceReader, [CLICKHOUSE_ADAPTER_ID]: clickHouseSourceReader, [COCKROACHDB_ADAPTER_ID]: cockroachDbSourceReader, [INFLUXDB_ADAPTER_ID]: influxDbSourceReader, [INFLUXDB3_CORE_ADAPTER_ID]: influxDb3CoreSourceReader, [INFLUXDB3_ENTERPRISE_ADAPTER_ID]: influxDb3EnterpriseSourceReader, [REDIS_ADAPTER_ID]: redisSourceReader, [SEARCH_SNAPSHOT_ADAPTER_ID]: searchSnapshotSourceReader, [CASSANDRA_SCYLLA_ADAPTER_ID]: cassandraScyllaSourceReader, [SCYLLA_MANAGER_ADAPTER_ID]: scyllaManagerSourceReader, [SQLITE_ADAPTER_ID]: sqliteSourceReader } });
    const checkpointStore = new RunCheckpointStore({ rootPath: path.join(getBackupManagerRootPath(), 'checkpoints') });
    openRepository = (workspaceId, repositoryId) => backupDestinationService.open(workspaceId, repositoryId);
    const cockroachDbRetentionAdapters = createCockroachDbRetentionAdapters({ controlDatabase, openRepository, deviceId: backupDeviceId });
    backupCockroachDbRetentionService = new CockroachDbRetentionService(cockroachDbRetentionAdapters);
    backupManualBackupService = new ManualBackupService({ controlDatabase, sourceReader, checkpointStore, deviceId: backupDeviceId, openRepository, logStore: getBackupLogStore(), notificationService: backupNotificationService });
    backupSnapshotBrowserService = new SnapshotBrowserService({ controlDatabase, openRepository });
    backupCassandraScyllaRestoreService = new CassandraScyllaRestoreService({ controlDatabase, secretStore: getBackupSecretStore(), snapshotBrowser: backupSnapshotBrowserService, adapter: cassandraScyllaAdapter, deviceId: backupDeviceId });
    backupScyllaManagerRestoreService = new ScyllaManagerRestoreService({ controlDatabase, secretStore: getBackupSecretStore(), snapshotBrowser: backupSnapshotBrowserService, adapter: scyllaManagerAdapter, deviceId: backupDeviceId });
    backupFileRestoreService = new FileRestoreService({
      controlDatabase,
      snapshotBrowser: backupSnapshotBrowserService,
      deviceId: backupDeviceId,
      createTarget: (options) => createConnectionRestoreTarget({ ...options, secretStore: getBackupSecretStore() })
    });
    backupMysqlRestoreService = new MysqlRestoreService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      deviceId: backupDeviceId,
      adapter: mysqlAdapter,
      openRepository
    });
    backupMysqlPhysicalRestoreService = new MysqlPhysicalRestoreService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      deviceId: backupDeviceId,
      mysqlAdapter,
      openRepository
    });
    backupMariadbRestoreService = new MariadbRestoreService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      deviceId: backupDeviceId,
      adapter: mariadbAdapter,
      openRepository
    });
    backupMysqlPitrService = new MysqlPointInTimeRestoreService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: mysqlAdapter, baseRestoreService: backupMysqlRestoreService, openRepository });
    backupMariadbPitrService = new MariadbPointInTimeRestoreService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: mariadbAdapter, baseRestoreService: backupMariadbRestoreService, openRepository });
    backupPostgresqlRestoreService = new PostgresqlRestoreService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      deviceId: backupDeviceId,
      adapter: postgresqlAdapter,
      openRepository
    });
    backupPostgresqlPitrRestoreService = new PostgresqlPitrRestoreService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      deviceId: backupDeviceId,
      adapter: postgresqlAdapter,
      openRepository
    });
    backupSqlServerRestoreService = new SqlServerRestoreService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      deviceId: backupDeviceId,
      adapter: sqlServerAdapter,
      openRepository
    });
    backupOracleRestoreService = new OracleRestoreService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      deviceId: backupDeviceId,
      adapter: oracleAdapter,
      openRepository
    });
    backupMongoDbRestoreService = new MongoDbRestoreService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      deviceId: backupDeviceId,
      adapter: mongoDbAdapter,
      openRepository
    });
    backupInfluxDbRestoreService = new InfluxDbRestoreService({ controlDatabase, deviceId: backupDeviceId, adapter: influxDbAdapter, connectionService: backupInfluxDbConnectionService, openRepository });
    backupInfluxDb3CoreRestoreService = new InfluxDb3CoreRestoreService({ controlDatabase, deviceId: backupDeviceId, adapter: influxDb3CoreAdapter, connectionService: backupInfluxDb3CoreConnectionService, openRepository });
    backupInfluxDb3EnterpriseRestoreService = new InfluxDb3EnterpriseRestoreService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: influxDb3EnterpriseAdapter, openRepository });
    backupInfluxDb3EnterpriseRetentionService = new InfluxDb3EnterpriseRetentionService({ controlDatabase, secretStore: getBackupSecretStore(), deviceId: backupDeviceId, adapter: influxDb3EnterpriseAdapter, recoveryPointAuthenticator: backupInfluxDb3EnterpriseRestoreService });
    backupInfluxDb3EnterpriseRecoveryTestService = new InfluxDb3EnterpriseRecoveryTestService({ controlDatabase, restoreService: backupInfluxDb3EnterpriseRestoreService, deviceId: backupDeviceId, notificationService: backupNotificationService });
    backupInfluxDb3EnterpriseLegacyRetentionService = new InfluxDb3EnterpriseLegacyRetentionService({ controlDatabase, deviceId: backupDeviceId, openRepository });
    backupInfluxDb3EnterpriseLegacyStopBindingService = new InfluxDb3EnterpriseLegacyStopBindingService({ controlDatabase, deviceId: backupDeviceId });
    backupInfluxDb3EnterpriseLegacyStopProofService = new InfluxDb3EnterpriseLegacyStopProofService({
      controlDatabase,
      secretStore: getBackupSecretStore(),
      deviceId: backupDeviceId,
      resolveBindings: (workspaceId) => backupInfluxDb3EnterpriseLegacyStopBindingService.resolveBindings(workspaceId),
      resolveProofKey: async () => Buffer.from(backupInfluxDb3EnterpriseLegacyStopProofKey)
    });
    backupInfluxDb3EnterpriseLegacyRestoreService = new InfluxDb3EnterpriseLegacyRestoreService({ controlDatabase, deviceId: backupDeviceId, openRepository, stopProofService: backupInfluxDb3EnterpriseLegacyStopProofService });
    backupInfluxDb3EnterpriseLegacyRecoveryTestService = new InfluxDb3EnterpriseLegacyRecoveryTestService({
      controlDatabase,
      restoreService: backupInfluxDb3EnterpriseLegacyRestoreService,
      assertTargetIsolated: assertBackupInfluxDb3EnterpriseLegacyTargetIsolated,
      deviceId: backupDeviceId,
      notificationService: backupNotificationService
    });
    backupInfluxDb3CoreRecoveryTestService = new InfluxDb3CoreRecoveryTestService({ controlDatabase, deviceId: backupDeviceId, adapter: influxDb3CoreAdapter, connectionService: backupInfluxDb3CoreConnectionService, restoreService: backupInfluxDb3CoreRestoreService, notificationService: backupNotificationService });
    backupInfluxDbRecoveryTestService = new InfluxDbRecoveryTestService({ controlDatabase, deviceId: backupDeviceId, adapter: influxDbAdapter, connectionService: backupInfluxDbConnectionService, restoreService: backupInfluxDbRestoreService, notificationService: backupNotificationService });
    backupClickHouseRestoreService = new ClickHouseRestoreService({ controlDatabase, deviceId: backupDeviceId, adapter: clickHouseAdapter, connectionService: backupClickHouseConnectionService, openRepository });
    backupClickHouseRecoveryTestService = new ClickHouseRecoveryTestService({ controlDatabase, deviceId: backupDeviceId, adapter: clickHouseAdapter, connectionService: backupClickHouseConnectionService, restoreService: backupClickHouseRestoreService, notificationService: backupNotificationService });
    backupCockroachDbRestoreService = new CockroachDbRestoreRunService({ controlDatabase, deviceId: backupDeviceId, connectionService: backupCockroachDbConnectionService, openRepository });
    backupCockroachDbRecoveryTestService = new CockroachDbRecoveryTestService({ controlDatabase, deviceId: backupDeviceId, adapter: cockroachDbAdapter, connectionService: backupCockroachDbConnectionService, restoreService: backupCockroachDbRestoreService, notificationService: backupNotificationService });
    backupNeo4jRestoreService = new Neo4jRestoreService({ controlDatabase, deviceId: backupDeviceId, adapter: neo4jAdapter, connectionService: backupNeo4jConnectionService, openRepository });
    backupNeo4jAggregationService = new Neo4jAggregationService({ controlDatabase, deviceId: backupDeviceId, adapter: neo4jAdapter, connectionService: backupNeo4jConnectionService, chainService: backupNeo4jRestoreService, openRepository });
    backupNeo4jRecoveryTestService = new Neo4jRecoveryTestService({ controlDatabase, deviceId: backupDeviceId, adapter: neo4jAdapter, connectionService: backupNeo4jConnectionService, restoreService: backupNeo4jRestoreService, notificationService: backupNotificationService });
    backupRedisRestoreService = new RedisRestoreService({ controlDatabase, deviceId: backupDeviceId, adapter: redisAdapter, openRepository });
    backupSqliteRestoreService = new SqliteRestoreService({ controlDatabase, deviceId: backupDeviceId, adapter: sqliteAdapter, openRepository });
    backupSearchSnapshotRestoreService = new SearchSnapshotRestoreService({ controlDatabase, secretStore: getBackupSecretStore(), snapshotBrowser: backupSnapshotBrowserService, adapter: searchSnapshotAdapter, deviceId: backupDeviceId });
    backupSearchSnapshotMaintenanceService = new SearchSnapshotMaintenanceService({ controlDatabase, secretStore: getBackupSecretStore(), snapshotBrowser: backupSnapshotBrowserService, adapter: searchSnapshotAdapter, deviceId: backupDeviceId });
    backupSearchSnapshotRecoveryTestService = new SearchSnapshotRecoveryTestService({ controlDatabase, secretStore: getBackupSecretStore(), snapshotBrowser: backupSnapshotBrowserService, adapter: searchSnapshotAdapter, restoreService: backupSearchSnapshotRestoreService, deviceId: backupDeviceId, notificationService: backupNotificationService });
    backupScyllaManagerRecoveryTestService = new ScyllaManagerRecoveryTestService({ controlDatabase, secretStore: getBackupSecretStore(), snapshotBrowser: backupSnapshotBrowserService, adapter: scyllaManagerAdapter, restoreService: backupScyllaManagerRestoreService, deviceId: backupDeviceId, notificationService: backupNotificationService });
    backupRepositoryVerificationService = new RepositoryVerificationService({ controlDatabase, snapshotBrowser: backupSnapshotBrowserService, deviceId: backupDeviceId, notificationService: backupNotificationService });
    backupRepositoryPruningService = new RepositoryPruningService({ controlDatabase, openRepository, deviceId: backupDeviceId });
    backupScheduledWorkerService = new ScheduledBackupWorkerService({
      controlDatabase,
      manualBackupService: backupManualBackupService,
      notificationService: backupNotificationService,
      deviceId: backupDeviceId
    });
    const settings = await readSettings();
    const activeWorkspaceId = settings.mode === 'cloud' ? String(settings.activeTeamId || '') : 'local';
    if (activeWorkspaceId) {
      const localStorageMigration = await backupLocalRepositoryService.migrateLegacyRepositories(activeWorkspaceId, String(settings.auth?.uid || 'local-user'));
      const storageMigration = await backupS3ConnectionService.migrateLegacyRepositories(activeWorkspaceId, String(settings.auth?.uid || 'local-user'));
      if (localStorageMigration.migrated.length || storageMigration.migrated.length) {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-storage-connection' }).info(
          'Legacy destinations were linked to reusable storage connections.',
          { destinationIds: [...localStorageMigration.migrated.map((destination) => destination.id), ...storageMigration.migrated.map(({ destination }) => destination.id)] }
        ).catch(() => {});
      }
      if (settings.mode === 'cloud') {
        await syncWorkspaceControlFromCloud(activeWorkspaceId, { force: true }).catch(async (error) => {
          await logWorkspaceControlSyncFailure(error, activeWorkspaceId);
        });
        await reconcileDatabaseProfileMetadata(activeWorkspaceId).then(async (summary) => {
          if (!summary.failed?.length) return;
          await logDatabaseCloudSyncFailure(activeWorkspaceId, summary.failed[0].code);
        }).catch(async (error) => logDatabaseCloudSyncFailure(activeWorkspaceId, error.code));
      }
      await backupManualBackupService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-manual-execution' }).warn(
          'Backup run reconciliation could not complete.',
          { code: error.code || 'BACKUP_RUN_RECONCILIATION_FAILED', error }
        ).catch(() => {});
      });
      await backupSftpRepositoryService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).then(async (summary) => {
        const failures = summary.repositories.filter((result) => result.status === 'failed');
        if (!failures.length) return;
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-sftp-repository' }).warn(
          'One or more SFTP repository staging directories require attention.',
          { repositories: failures.map((result) => ({ repositoryId: result.repositoryId, status: result.status, code: result.error?.code || 'SFTP_REPOSITORY_RECONCILIATION_FAILED' })) }
        ).catch(() => {});
      }).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-sftp-repository' }).warn(
          'SFTP repository staging reconciliation could not complete.',
          { code: error.code || 'SFTP_REPOSITORY_RECONCILIATION_FAILED', error }
        ).catch(() => {});
      });
      await backupFileRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-file-restore' }).warn(
          'Restore run reconciliation could not complete.',
          { code: error.code || 'RESTORE_RECONCILIATION_FAILED', error }
        ).catch(() => {});
      });
      await backupMysqlRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-mysql-restore' }).warn(
          'MySQL restore run reconciliation could not complete.',
          { code: error.code || 'MYSQL_RESTORE_RECONCILIATION_FAILED', error }
        ).catch(() => {});
      });
      await backupMysqlPhysicalRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-mysql-physical-restore' }).warn(
          'MySQL physical restore run reconciliation could not complete.',
          { code: error.code || 'MYSQL_PHYSICAL_RESTORE_RECONCILIATION_FAILED', error }
        ).catch(() => {});
      });
      await backupMariadbRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-mariadb-restore' }).warn(
          'MariaDB restore run reconciliation could not complete.',
          { code: error.code || 'MARIADB_RESTORE_RECONCILIATION_FAILED', error }
        ).catch(() => {});
      });
      await backupMysqlPitrService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-mysql-pitr' }).warn('MySQL point-in-time recovery reconciliation could not complete.', { code: error.code || 'MYSQL_PITR_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupMariadbPitrService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-mariadb-pitr' }).warn('MariaDB point-in-time recovery reconciliation could not complete.', { code: error.code || 'MARIADB_PITR_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupPostgresqlRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-postgresql-restore' }).warn(
          'PostgreSQL restore run reconciliation could not complete.',
          { code: error.code || 'POSTGRESQL_RESTORE_RECONCILIATION_FAILED', error }
        ).catch(() => {});
      });
      await backupPostgresqlPitrRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-postgresql-pitr' }).warn('PostgreSQL point-in-time recovery reconciliation could not complete.', { code: error.code || 'POSTGRESQL_PITR_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupSqlServerRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-sqlserver-restore' }).warn('SQL Server restore reconciliation could not complete.', { code: error.code || 'SQLSERVER_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupOracleRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-oracle-restore' }).warn('Oracle restore reconciliation could not complete.', { code: error.code || 'ORACLE_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupMongoDbRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-mongodb-restore' }).warn('MongoDB restore reconciliation could not complete.', { code: error.code || 'MONGODB_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupCockroachDbScheduleService.reconcileAll(activeWorkspaceId, 'system').catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-cockroachdb-schedule' }).warn('CockroachDB native schedule reconciliation could not complete.', { code: error.code || 'COCKROACH_NATIVE_SCHEDULE_RECONCILIATION_FAILED' }).catch(() => {});
      });
      await backupCockroachDbRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-cockroachdb-restore' }).warn('CockroachDB recovery reconciliation could not complete.', { code: error.code || 'COCKROACH_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupClickHouseRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-clickhouse-restore' }).warn('ClickHouse recovery reconciliation could not complete.', { code: error.code || 'CLICKHOUSE_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupInfluxDbRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-influxdb-restore' }).warn('InfluxDB recovery reconciliation could not complete.', { code: error.code || 'INFLUXDB_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupInfluxDb3CoreRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-influxdb3-core-restore' }).warn('InfluxDB 3 Core recovery reconciliation could not complete.', { code: error.code || 'INFLUXDB3_CORE_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupInfluxDb3EnterpriseRetentionService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-influxdb3-enterprise-retention' }).warn('InfluxDB 3 Enterprise native retention reconciliation could not complete.', { code: error.code || 'INFLUXDB3_ENTERPRISE_RETENTION_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupInfluxDb3EnterpriseRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-influxdb3-enterprise-restore' }).warn('InfluxDB 3 Enterprise live-cluster recovery reconciliation could not complete.', { code: error.code || 'INFLUXDB3_ENTERPRISE_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupInfluxDb3EnterpriseLegacyRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async () => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-influxdb3-enterprise-legacy-restore' }).warn('InfluxDB 3 Enterprise legacy recovery reconciliation could not complete.', { code: 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_RECONCILIATION_FAILED' }).catch(() => {});
      });
      await backupInfluxDb3EnterpriseRecoveryTestService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async () => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-influxdb3-enterprise-verification' }).warn('InfluxDB 3 Enterprise recovery-test reconciliation could not complete.', { code: 'INFLUXDB3_ENTERPRISE_VERIFICATION_RECONCILIATION_FAILED' }).catch(() => {});
      });
      await backupInfluxDb3EnterpriseLegacyRecoveryTestService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async () => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-influxdb3-enterprise-legacy-verification' }).warn('InfluxDB 3 Enterprise legacy recovery-test reconciliation could not complete.', { code: 'INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_RECONCILIATION_FAILED' }).catch(() => {});
      });
      await backupInfluxDb3CoreRecoveryTestService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-influxdb3-core-verification' }).warn('InfluxDB 3 Core recovery-test reconciliation could not complete.', { code: error.code || 'INFLUXDB3_CORE_VERIFICATION_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupInfluxDbRecoveryTestService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-influxdb-verification' }).warn('InfluxDB recovery-test reconciliation could not complete.', { code: error.code || 'INFLUXDB_VERIFICATION_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupClickHouseRecoveryTestService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-clickhouse-verification' }).warn('ClickHouse recovery-test reconciliation could not complete.', { code: error.code || 'CLICKHOUSE_VERIFICATION_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupCockroachDbRecoveryTestService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-cockroachdb-verification' }).warn('CockroachDB recovery-test reconciliation could not complete.', { code: error.code || 'COCKROACH_VERIFICATION_RECONCILIATION_FAILED' }).catch(() => {});
      });
      await backupNeo4jRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-neo4j-restore' }).warn('Neo4j recovery reconciliation could not complete.', { code: error.code || 'NEO4J_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupNeo4jAggregationService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-neo4j-aggregation' }).warn('Neo4j aggregation reconciliation could not complete.', { code: error.code || 'NEO4J_AGGREGATE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupNeo4jRecoveryTestService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-neo4j-verification' }).warn('Neo4j recovery-test reconciliation could not complete.', { code: error.code || 'NEO4J_VERIFICATION_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupRedisRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-redis-restore' }).warn('Redis restore reconciliation could not complete.', { code: error.code || 'REDIS_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupSqliteRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-sqlite-restore' }).warn('SQLite restore reconciliation could not complete.', { code: error.code || 'SQLITE_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupSearchSnapshotRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-search-restore' }).warn('Search restore reconciliation could not complete.', { code: error.code || 'SEARCH_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupCassandraScyllaRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-cassandra-scylla-restore' }).warn('Cassandra/Scylla recovery reconciliation could not complete.', { code: error.code || 'CASSANDRA_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupScyllaManagerRestoreService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-scylla-manager-restore' }).warn('ScyllaDB Manager recovery reconciliation could not complete.', { code: error.code || 'SCYLLA_MANAGER_RESTORE_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupScyllaManagerRecoveryTestService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-scylla-manager-verification' }).warn('ScyllaDB Manager recovery-test reconciliation could not complete.', { code: error.code || 'SCYLLA_MANAGER_VERIFICATION_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupSearchSnapshotRecoveryTestService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-search-verification' }).warn('Search recovery-test reconciliation could not complete.', { code: error.code || 'SEARCH_VERIFICATION_RECONCILIATION_FAILED', error }).catch(() => {});
      });
      await backupRepositoryVerificationService.reconcile(activeWorkspaceId, String(settings.auth?.uid || 'local-user')).catch(async (error) => {
        await getBackupLogStore().logger({ workspaceId: activeWorkspaceId, component: 'backup-repository-verification' }).warn(
          'Verification run reconciliation could not complete.',
          { code: error.code || 'VERIFICATION_RECONCILIATION_FAILED', error }
        ).catch(() => {});
      });
    }
    if (databaseCloudSyncTimer) clearInterval(databaseCloudSyncTimer);
    databaseCloudSyncTimer = setInterval(async () => {
      const current = await readSettings().catch(() => null);
      const workspaceId = current?.mode === 'cloud' ? String(current.activeTeamId || '') : '';
      if (!workspaceId) return;
      await reconcileDatabaseProfileMetadata(workspaceId).then(async (summary) => {
        if (summary.failed?.length) await logDatabaseCloudSyncFailure(workspaceId, summary.failed[0].code);
      }).catch(async (error) => logDatabaseCloudSyncFailure(workspaceId, error.code));
    }, DATABASE_CLOUD_SYNC_INTERVAL_MS);
    databaseCloudSyncTimer.unref?.();
    if (workspaceControlSyncTimer) clearInterval(workspaceControlSyncTimer);
    workspaceControlSyncTimer = setInterval(async () => {
      const current = await readSettings().catch(() => null);
      const workspaceId = current?.mode === 'cloud' ? String(current.activeTeamId || '') : '';
      if (!workspaceId) return;
      await syncWorkspaceControlFromCloud(workspaceId).catch(async (error) => logWorkspaceControlSyncFailure(error, workspaceId));
    }, WORKSPACE_CONTROL_SYNC_INTERVAL_MS);
    workspaceControlSyncTimer.unref?.();
    workspaceControlChangeHandlerEnabled = true;
    backupControlDatabaseError = null;
  } catch (error) {
    if (databaseCloudSyncTimer) clearInterval(databaseCloudSyncTimer);
    databaseCloudSyncTimer = null;
    if (workspaceControlSyncTimer) clearInterval(workspaceControlSyncTimer);
    workspaceControlSyncTimer = null;
    workspaceControlChangeHandlerEnabled = false;
    await databaseAccessCompanionService?.dispose().catch(() => {});
    disposeDatabaseAccessFallbackWindows();
    databaseAccessCompanionService = null;
    await controlDatabase.close().catch(() => {});
    backupControlDatabase = null;
    databaseProfileService = null;
    databaseConnectionImportService = null;
    databaseBackupHandoffService = null;
    databaseConnectionService = null;
    databaseDriverRuntimeRegistry = null;
    databaseLocalResourceStore = null;
    databaseOperationalLogService = null;
    databaseOperationalEvidenceStore = null;
    databaseQueryService = null;
    databaseQueryWorkspaceStore = null;
    databaseResultExportService = null;
    databaseRowCrudService = null;
    databaseDefinitionExecutor = null;
    databaseExplainService = null;
    databaseTransferService = null;
    databaseSchemaAdministrationService = null;
    databasePrincipalAdministrationService = null;
    databaseSchemaService = null;
    databaseTaskService = null;
    databasePluginRegistry = null;
    databasePluginHealthStore = null;
    tabulariumClient = null;
    databaseCloudSyncOutbox = null;
    backupLocalConnectionService = null;
    backupSshConnectionService = null;
    backupMysqlConnectionService = null;
    backupMariadbConnectionService = null;
    backupPostgresqlConnectionService = null;
    backupSqlServerConnectionService = null;
    backupOracleConnectionService = null;
    backupMongoDbConnectionService = null;
    backupNeo4jConnectionService = null;
    backupClickHouseConnectionService = null;
    backupCockroachDbConnectionService = null;
    backupCockroachDbScheduleService = null;
    backupCockroachDbRetentionService = null;
    backupInfluxDbConnectionService = null;
    backupInfluxDb3CoreConnectionService = null;
    backupInfluxDb3EnterpriseConnectionService = null;
    backupInfluxDb3EnterpriseRestoreService = null;
    backupInfluxDb3EnterpriseRetentionService = null;
    backupInfluxDb3EnterpriseRecoveryTestService = null;
    backupInfluxDb3EnterpriseLegacyRetentionService = null;
    backupInfluxDb3EnterpriseLegacyStopBindingService = null;
    backupInfluxDb3EnterpriseLegacyStopProofService = null;
    backupInfluxDb3EnterpriseLegacyRestoreService = null;
    backupInfluxDb3EnterpriseLegacyRecoveryTestService = null;
    backupInfluxDb3CoreRestoreService = null;
    backupInfluxDb3CoreRecoveryTestService = null;
    backupInfluxDbRestoreService = null;
    backupInfluxDbRecoveryTestService = null;
    backupClickHouseRestoreService = null;
    backupClickHouseRecoveryTestService = null;
    backupCockroachDbRestoreService = null;
    backupCockroachDbRecoveryTestService = null;
    backupNeo4jRestoreService = null;
    backupNeo4jAggregationService = null;
    backupNeo4jRecoveryTestService = null;
    backupRedisConnectionService = null;
    backupSearchSnapshotConnectionService = null;
    backupCassandraScyllaConnectionService = null;
    backupCassandraScyllaRestoreService = null;
    backupScyllaManagerConnectionService = null;
    backupScyllaManagerRestoreService = null;
    backupScyllaManagerRecoveryTestService = null;
    backupSqliteConnectionService = null;
    backupDatabaseSourceService = null;
    backupFileSourceService = null;
    backupLocalRepositoryService = null;
    backupSftpRepositoryService = null;
    backupS3RepositoryService = null;
    backupS3ConnectionService = null;
    backupStorageBackendRegistry = null;
    backupStorageConnectionService = null;
    backupDestinationService = null;
    backupJobService = null;
    backupManualBackupService = null;
    backupScheduledWorkerService = null;
    backupSnapshotBrowserService = null;
    backupFileRestoreService = null;
    backupMysqlRestoreService = null;
    backupMysqlPhysicalRestoreService = null;
    backupMariadbRestoreService = null;
    backupMysqlPitrService = null;
    backupMariadbPitrService = null;
    backupPostgresqlRestoreService = null;
    backupPostgresqlPitrRestoreService = null;
    backupSqlServerRestoreService = null;
    backupOracleRestoreService = null;
    backupMongoDbRestoreService = null;
    backupRedisRestoreService = null;
    backupSearchSnapshotRestoreService = null;
    backupSearchSnapshotMaintenanceService = null;
    backupSearchSnapshotRecoveryTestService = null;
    backupScyllaManagerRecoveryTestService = null;
    backupSqliteRestoreService = null;
    backupRepositoryVerificationService = null;
    backupRepositoryPruningService = null;
    backupNotificationService = null;
    backupObjectiveStatusService = null;
    backupDeviceId = null;
    backupControlDatabaseError = error;
    await getBackupLogStore().logger({ workspaceId: 'local', component: 'control-database' }).error(
      'Backup Manager control database could not be opened.',
      { code: error.code || 'BACKUP_CONTROL_DB_OPEN_FAILED', error }
    );
  }
}

function getBackupControlDatabase() {
  if (backupControlDatabaseError) throw backupControlDatabaseError;
  if (!backupControlDatabase) throw new Error('Backup Manager control database is not initialized.');
  return backupControlDatabase;
}

function getDatabaseProfileService() {
  getBackupControlDatabase();
  if (!databaseProfileService) throw new Error('Database Manager profiles are not initialized.');
  return databaseProfileService;
}

function getDatabaseBackupHandoffService() {
  getBackupControlDatabase();
  if (!databaseBackupHandoffService) throw new Error('Database Manager backup handoff is not initialized.');
  return databaseBackupHandoffService;
}

function getDatabaseAccessCompanionService() {
  getBackupControlDatabase();
  if (!databaseAccessCompanionService) {
    throw Object.assign(new Error('DB Access Manager is not initialized.'), {
      code: 'DATABASE_ACCESS_NOT_INITIALIZED',
      safeMessage: 'DB Access Manager is not available on this device.',
      category: 'database-manager',
      retryable: true
    });
  }
  return databaseAccessCompanionService;
}

function databaseAccessContextChangedError() {
  return Object.assign(new Error('The database workspace changed while DB Access Manager was opening.'), {
    code: 'DATABASE_ACCESS_CONTEXT_CHANGED',
    safeMessage: 'The database workspace changed. Try Access again.',
    category: 'database-manager',
    retryable: true
  });
}

async function withDatabaseAccessContextTransition(action) {
  if (typeof action !== 'function') throw new TypeError('Database access context transition requires an action.');
  databaseAccessContextGeneration += 1;
  databaseAccessContextTransitions += 1;
  try {
    await databaseAccessCompanionService?.dispose().catch(() => {});
    disposeDatabaseAccessFallbackWindows();
    return await action();
  } finally {
    databaseAccessContextGeneration += 1;
    databaseAccessContextTransitions -= 1;
  }
}

async function requireReadyDatabaseAccessProfile(context, profileId) {
  const id = String(profileId || '').trim();
  if (!id || id.length > 200 || id.includes('\0')) {
    throw Object.assign(new Error('The database profile is invalid.'), {
      code: 'DATABASE_ACCESS_PROFILE_INVALID',
      safeMessage: 'The database profile is invalid.',
      category: 'database-manager',
      retryable: false
    });
  }
  const profile = await getDatabaseProfileService().get(context.workspaceId, id);
  if (!profile) {
    throw Object.assign(new Error('Database profile was not found.'), {
      code: 'DATABASE_ACCESS_PROFILE_NOT_FOUND',
      safeMessage: 'Database profile was not found.',
      category: 'database-manager',
      retryable: false
    });
  }
  if (!SUPPORTED_ACCESS_DRIVERS.includes(profile.driverId)) {
    throw Object.assign(new Error('DB Access Manager does not support this database driver yet.'), {
      code: 'DATABASE_ACCESS_DRIVER_UNSUPPORTED',
      safeMessage: 'DB Access Manager does not support this database driver yet.',
      category: 'database-manager',
      retryable: false
    });
  }
  if (profile.ssl?.clientCertificateRequired) {
    throw Object.assign(new Error('DB Access Manager does not support client-certificate database profiles yet.'), {
      code: 'DATABASE_ACCESS_CLIENT_CERTIFICATE_UNSUPPORTED',
      safeMessage: 'DB Access Manager does not support client-certificate database profiles yet.',
      category: 'database-manager',
      retryable: false
    });
  }
  const status = await getDatabaseConnectionService().status(context.workspaceId, context.actorId, id);
  if (status.state !== 'ready') {
    throw Object.assign(new Error('Connect this database profile before opening DB Access Manager.'), {
      code: 'DATABASE_ACCESS_CONNECTION_REQUIRED',
      safeMessage: 'Connect this database profile before opening DB Access Manager.',
      category: 'database-manager',
      retryable: true
    });
  }
  return profile;
}

function getDatabaseConnectionService() {
  getBackupControlDatabase();
  if (!databaseConnectionService) throw new Error('Database Manager connections are not initialized.');
  return databaseConnectionService;
}

function getDatabaseLocalResourceStore() {
  getBackupControlDatabase();
  if (!databaseLocalResourceStore) throw new Error('Database Manager local resources are not initialized.');
  return databaseLocalResourceStore;
}

function getDatabaseQueryService() {
  getBackupControlDatabase();
  if (!databaseQueryService) throw new Error('Database Manager queries are not initialized.');
  return databaseQueryService;
}

function getDatabaseQueryWorkspaceStore() {
  getBackupControlDatabase();
  if (!databaseQueryWorkspaceStore) throw new Error('Database Manager query workspace is not initialized.');
  return databaseQueryWorkspaceStore;
}

function getDatabaseTaskService() {
  getBackupControlDatabase();
  if (!databaseTaskService) throw new Error('Database Manager tasks are not initialized.');
  return databaseTaskService;
}

function getDatabaseOperationalLogService() {
  getBackupControlDatabase();
  if (!databaseOperationalLogService) throw new Error('Database Manager operational logs are not initialized.');
  return databaseOperationalLogService;
}

function getDatabaseExplainService() {
  getBackupControlDatabase();
  if (!databaseExplainService) throw new Error('Database Manager EXPLAIN is not initialized.');
  return databaseExplainService;
}

function getDatabaseTransferService() {
  getBackupControlDatabase();
  if (!databaseTransferService) throw new Error('Database Manager transfers are not initialized.');
  return databaseTransferService;
}

function getDatabaseResultExportService() {
  if (!databaseResultExportService) {
    databaseResultExportService = new DatabaseResultExportService({
      showSaveDialog: (options) => dialog.showSaveDialog(mainWindow, options),
      writeFile: (...args) => fs.writeFile(...args),
      openFile: (...args) => fs.open(...args),
      renameFile: (...args) => fs.rename(...args),
      removeFile: (filePath) => fs.rm(filePath, { force: true }),
      queryService: getDatabaseQueryService()
    });
  }
  return databaseResultExportService;
}

function getDatabaseSchemaService() {
  getBackupControlDatabase();
  if (!databaseSchemaService) throw new Error('Database Manager schema discovery is not initialized.');
  return databaseSchemaService;
}

function getDatabaseSchemaAdministrationService() {
  getBackupControlDatabase();
  if (!databaseSchemaAdministrationService) throw new Error('Database Manager schema administration is not initialized.');
  return databaseSchemaAdministrationService;
}

function getDatabasePrincipalAdministrationService() {
  getBackupControlDatabase();
  if (!databasePrincipalAdministrationService) throw new Error('Database Manager user administration is not initialized.');
  return databasePrincipalAdministrationService;
}

function getDatabaseRowCrudService() {
  getBackupControlDatabase();
  if (!databaseRowCrudService) throw new Error('Database Manager row editing is not initialized.');
  return databaseRowCrudService;
}

function getBackupLocalConnectionService() {
  getBackupControlDatabase();
  if (!backupLocalConnectionService) throw new Error('Local computer connections are not initialized.');
  return backupLocalConnectionService;
}

function getBackupSshConnectionService() {
  getBackupControlDatabase();
  if (!backupSshConnectionService) throw new Error('SSH source connections are not initialized.');
  return backupSshConnectionService;
}

function getBackupMysqlConnectionService() {
  getBackupControlDatabase();
  if (!backupMysqlConnectionService) throw new Error('MySQL source connections are not initialized.');
  return backupMysqlConnectionService;
}

function getBackupNativeToolManager() {
  if (!backupNativeToolManager) {
    backupNativeToolManager = new NativeToolManager({ rootDirectory: path.join(app.getPath('userData'), 'database-tools') });
    backupNativeToolManager.activateInstalledSync();
  }
  return backupNativeToolManager;
}

function getBackupMariadbConnectionService() {
  getBackupControlDatabase();
  if (!backupMariadbConnectionService) throw new Error('MariaDB source connections are not initialized.');
  return backupMariadbConnectionService;
}

function getBackupPostgresqlConnectionService() {
  getBackupControlDatabase();
  if (!backupPostgresqlConnectionService) throw new Error('PostgreSQL source connections are not initialized.');
  return backupPostgresqlConnectionService;
}

function getBackupSqlServerConnectionService() {
  getBackupControlDatabase();
  if (!backupSqlServerConnectionService) throw new Error('SQL Server source connections are not initialized.');
  return backupSqlServerConnectionService;
}

function getBackupOracleConnectionService() {
  getBackupControlDatabase();
  if (!backupOracleConnectionService) throw new Error('Oracle source connections are not initialized.');
  return backupOracleConnectionService;
}

function getBackupMongoDbConnectionService() {
  getBackupControlDatabase();
  if (!backupMongoDbConnectionService) throw new Error('MongoDB source connections are not initialized.');
  return backupMongoDbConnectionService;
}

function getBackupNeo4jConnectionService() {
  getBackupControlDatabase();
  if (!backupNeo4jConnectionService) throw new Error('Neo4j source connections are not initialized.');
  return backupNeo4jConnectionService;
}

function getBackupClickHouseConnectionService() {
  getBackupControlDatabase();
  if (!backupClickHouseConnectionService) throw new Error('ClickHouse source connections are not initialized.');
  return backupClickHouseConnectionService;
}

function getBackupCockroachDbConnectionService() {
  getBackupControlDatabase();
  if (!backupCockroachDbConnectionService) throw new Error('CockroachDB source connections are not initialized.');
  return backupCockroachDbConnectionService;
}

function getBackupCockroachDbScheduleService() {
  getBackupControlDatabase();
  if (!backupCockroachDbScheduleService) throw new Error('CockroachDB native scheduling is not initialized.');
  return backupCockroachDbScheduleService;
}

function getBackupCockroachDbRetentionService() {
  getBackupControlDatabase();
  if (!backupCockroachDbRetentionService) throw new Error('CockroachDB retention is not initialized.');
  return backupCockroachDbRetentionService;
}

function getBackupCockroachDbRestoreService() {
  getBackupControlDatabase();
  if (!backupCockroachDbRestoreService) throw new Error('CockroachDB recovery is not initialized.');
  return backupCockroachDbRestoreService;
}

function getBackupCockroachDbRecoveryTestService() {
  getBackupControlDatabase();
  if (!backupCockroachDbRecoveryTestService) throw new Error('CockroachDB recovery tests are not initialized.');
  return backupCockroachDbRecoveryTestService;
}

function getBackupInfluxDbConnectionService() {
  getBackupControlDatabase();
  if (!backupInfluxDbConnectionService) throw new Error('InfluxDB source connections are not initialized.');
  return backupInfluxDbConnectionService;
}

function getBackupInfluxDb3CoreConnectionService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3CoreConnectionService) throw new Error('InfluxDB 3 Core source connections are not initialized.');
  return backupInfluxDb3CoreConnectionService;
}

function getBackupInfluxDb3EnterpriseConnectionService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3EnterpriseConnectionService) throw new Error('InfluxDB 3 Enterprise source connections are not initialized.');
  return backupInfluxDb3EnterpriseConnectionService;
}

function getBackupInfluxDb3EnterpriseRestoreService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3EnterpriseRestoreService) throw new Error('InfluxDB 3 Enterprise live-cluster recovery is not initialized.');
  return backupInfluxDb3EnterpriseRestoreService;
}

function getBackupInfluxDb3EnterpriseRetentionService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3EnterpriseRetentionService) throw new Error('InfluxDB 3 Enterprise native retention is not initialized.');
  return backupInfluxDb3EnterpriseRetentionService;
}

function getBackupInfluxDb3EnterpriseLegacyRetentionService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3EnterpriseLegacyRetentionService) throw new Error('InfluxDB 3 Enterprise legacy retention is not initialized.');
  return backupInfluxDb3EnterpriseLegacyRetentionService;
}

function getBackupInfluxDb3EnterpriseLegacyStopBindingService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3EnterpriseLegacyStopBindingService) throw new Error('InfluxDB 3 Enterprise legacy stop bindings are not initialized.');
  return backupInfluxDb3EnterpriseLegacyStopBindingService;
}

function getBackupInfluxDb3EnterpriseLegacyStopProofService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3EnterpriseLegacyStopProofService) throw new Error('InfluxDB 3 Enterprise legacy stop proof is not initialized.');
  return backupInfluxDb3EnterpriseLegacyStopProofService;
}

function getBackupInfluxDb3EnterpriseLegacyRestoreService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3EnterpriseLegacyRestoreService) throw new Error('InfluxDB 3 Enterprise legacy recovery is not initialized.');
  return backupInfluxDb3EnterpriseLegacyRestoreService;
}

function getBackupInfluxDb3EnterpriseLegacyRecoveryTestService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3EnterpriseLegacyRecoveryTestService) throw new Error('InfluxDB 3 Enterprise legacy recovery tests are not initialized.');
  return backupInfluxDb3EnterpriseLegacyRecoveryTestService;
}

function getBackupInfluxDb3EnterpriseRecoveryTestService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3EnterpriseRecoveryTestService) throw new Error('InfluxDB 3 Enterprise recovery tests are not initialized.');
  return backupInfluxDb3EnterpriseRecoveryTestService;
}

async function assertBackupInfluxDb3EnterpriseLegacyTargetIsolated({ workspaceId, targetConnectionId, target, targetDigest, owner, signal } = {}) {
  const normalizedOwner = String(owner || '').trim();
  const normalizedTargetConnectionId = String(targetConnectionId || '').trim();
  const normalizedTargetDigest = String(targetDigest || '').trim().toLowerCase();
  if (!normalizedOwner || !normalizedTargetConnectionId || !/^sha256:[0-9a-f]{64}$/.test(normalizedTargetDigest)) throw new TypeError('InfluxDB 3 Enterprise legacy drill isolation request is invalid.');
  const evidence = await getBackupInfluxDb3EnterpriseLegacyRestoreService().assertTargetStopped(workspaceId, { targetConnectionId: normalizedTargetConnectionId, target, signal });
  const bindingFingerprint = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    targetConnectionId: normalizedTargetConnectionId,
    targetDigest: normalizedTargetDigest,
    nodeSetDigest: evidence.nodeSetDigest
  })).digest('hex')}`;
  return Object.freeze({
    owner: normalizedOwner,
    targetId: normalizedTargetConnectionId,
    controllerId: 'deployerx-influxdb3-enterprise-legacy-stop-proof-v1',
    bindingFingerprint,
    targetDigest: normalizedTargetDigest,
    isolated: true,
    serviceExposed: false
  });
}

function getBackupInfluxDb3CoreRestoreService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3CoreRestoreService) throw new Error('InfluxDB 3 Core recovery is not initialized.');
  return backupInfluxDb3CoreRestoreService;
}

function getBackupInfluxDb3CoreRecoveryTestService() {
  getBackupControlDatabase();
  if (!backupInfluxDb3CoreRecoveryTestService) throw new Error('InfluxDB 3 Core recovery tests are not initialized.');
  return backupInfluxDb3CoreRecoveryTestService;
}

function getBackupInfluxDbRestoreService() {
  getBackupControlDatabase();
  if (!backupInfluxDbRestoreService) throw new Error('InfluxDB recovery is not initialized.');
  return backupInfluxDbRestoreService;
}

function getBackupInfluxDbRecoveryTestService() {
  getBackupControlDatabase();
  if (!backupInfluxDbRecoveryTestService) throw new Error('InfluxDB recovery tests are not initialized.');
  return backupInfluxDbRecoveryTestService;
}

function getBackupClickHouseRestoreService() {
  getBackupControlDatabase();
  if (!backupClickHouseRestoreService) throw new Error('ClickHouse recovery is not initialized.');
  return backupClickHouseRestoreService;
}

function getBackupClickHouseRecoveryTestService() {
  getBackupControlDatabase();
  if (!backupClickHouseRecoveryTestService) throw new Error('ClickHouse recovery tests are not initialized.');
  return backupClickHouseRecoveryTestService;
}

function getBackupNeo4jRestoreService() {
  getBackupControlDatabase();
  if (!backupNeo4jRestoreService) throw new Error('Neo4j recovery is not initialized.');
  return backupNeo4jRestoreService;
}

function getBackupNeo4jAggregationService() {
  getBackupControlDatabase();
  if (!backupNeo4jAggregationService) throw new Error('Neo4j aggregation is not initialized.');
  return backupNeo4jAggregationService;
}

function getBackupNeo4jRecoveryTestService() {
  getBackupControlDatabase();
  if (!backupNeo4jRecoveryTestService) throw new Error('Neo4j recovery tests are not initialized.');
  return backupNeo4jRecoveryTestService;
}

function getBackupRedisConnectionService() {
  getBackupControlDatabase();
  if (!backupRedisConnectionService) throw new Error('Redis source connections are not initialized.');
  return backupRedisConnectionService;
}

function getBackupSearchSnapshotConnectionService() {
  getBackupControlDatabase();
  if (!backupSearchSnapshotConnectionService) throw new Error('Search snapshot connections are not initialized.');
  return backupSearchSnapshotConnectionService;
}

function getBackupCassandraScyllaConnectionService() {
  getBackupControlDatabase();
  if (!backupCassandraScyllaConnectionService) throw new Error('Cassandra/Scylla connections are not initialized.');
  return backupCassandraScyllaConnectionService;
}

function getBackupCassandraScyllaRestoreService() {
  getBackupControlDatabase();
  if (!backupCassandraScyllaRestoreService) throw new Error('Cassandra/Scylla recovery is not initialized.');
  return backupCassandraScyllaRestoreService;
}

function getBackupScyllaManagerConnectionService() {
  getBackupControlDatabase();
  if (!backupScyllaManagerConnectionService) throw new Error('ScyllaDB Manager connections are not initialized.');
  return backupScyllaManagerConnectionService;
}

function getBackupScyllaManagerRestoreService() {
  getBackupControlDatabase();
  if (!backupScyllaManagerRestoreService) throw new Error('ScyllaDB Manager recovery is not initialized.');
  return backupScyllaManagerRestoreService;
}

function getBackupScyllaManagerRecoveryTestService() {
  getBackupControlDatabase();
  if (!backupScyllaManagerRecoveryTestService) throw new Error('ScyllaDB Manager recovery tests are not initialized.');
  return backupScyllaManagerRecoveryTestService;
}

function getBackupSqliteConnectionService() {
  getBackupControlDatabase();
  if (!backupSqliteConnectionService) throw new Error('SQLite source connections are not initialized.');
  return backupSqliteConnectionService;
}

function getBackupFileSourceService() {
  getBackupControlDatabase();
  if (!backupFileSourceService) throw new Error('Backup file sources are not initialized.');
  return backupFileSourceService;
}

function getBackupDatabaseSourceService() {
  getBackupControlDatabase();
  if (!backupDatabaseSourceService) throw new Error('Backup database sources are not initialized.');
  return backupDatabaseSourceService;
}

function createCoreDatabaseConnection(adapterId, operation) {
  if (!isCoreDatabaseAdapterId(adapterId)) {
    const error = new Error('New connections for this database engine are outside the active Backup Manager scope. Existing connections remain available for recovery and diagnostics.');
    error.code = 'BACKUP_DATABASE_ADAPTER_OUT_OF_SCOPE';
    throw error;
  }
  return operation();
}

function getBackupLocalRepositoryService() {
  getBackupControlDatabase();
  if (!backupLocalRepositoryService) throw new Error('Backup local repositories are not initialized.');
  return backupLocalRepositoryService;
}

function getBackupSftpRepositoryService() {
  getBackupControlDatabase();
  if (!backupSftpRepositoryService) throw new Error('Backup SFTP repositories are not initialized.');
  return backupSftpRepositoryService;
}

function getBackupS3RepositoryService() {
  getBackupControlDatabase();
  if (!backupS3RepositoryService) throw new Error('Backup S3 repositories are not initialized.');
  return backupS3RepositoryService;
}

function getBackupS3ConnectionService() {
  getBackupControlDatabase();
  if (!backupS3ConnectionService) throw new Error('Backup S3 storage connections are not initialized.');
  return backupS3ConnectionService;
}

function getBackupDestinationService() {
  getBackupControlDatabase();
  if (!backupDestinationService) throw new Error('Backup destinations are not initialized.');
  return backupDestinationService;
}

function getBackupStorageConnectionService() {
  getBackupControlDatabase();
  if (!backupStorageConnectionService) throw new Error('Backup storage connections are not initialized.');
  return backupStorageConnectionService;
}

function getBackupJobService() {
  getBackupControlDatabase();
  if (!backupJobService) throw new Error('Backup jobs are not initialized.');
  return backupJobService;
}

function getBackupManualBackupService() {
  getBackupControlDatabase();
  if (!backupManualBackupService) throw new Error('Manual backup execution is not initialized.');
  return backupManualBackupService;
}

function getBackupScheduledWorkerService() {
  getBackupControlDatabase();
  if (!backupScheduledWorkerService) throw new Error('Scheduled backup worker is not initialized.');
  return backupScheduledWorkerService;
}

function getBackupSnapshotBrowserService() {
  getBackupControlDatabase();
  if (!backupSnapshotBrowserService) throw new Error('Backup snapshot browsing is not initialized.');
  return backupSnapshotBrowserService;
}

function getBackupFileRestoreService() {
  getBackupControlDatabase();
  if (!backupFileRestoreService) throw new Error('Backup file restore is not initialized.');
  return backupFileRestoreService;
}

function getBackupMysqlRestoreService() {
  getBackupControlDatabase();
  if (!backupMysqlRestoreService) throw new Error('MySQL restore is not initialized.');
  return backupMysqlRestoreService;
}

function getBackupMysqlPhysicalRestoreService() {
  getBackupControlDatabase();
  if (!backupMysqlPhysicalRestoreService) throw new Error('MySQL physical restore is not initialized.');
  return backupMysqlPhysicalRestoreService;
}

function getBackupMariadbRestoreService() {
  getBackupControlDatabase();
  if (!backupMariadbRestoreService) throw new Error('MariaDB restore is not initialized.');
  return backupMariadbRestoreService;
}

function getBackupMysqlPitrService() {
  getBackupControlDatabase();
  if (!backupMysqlPitrService) throw new Error('MySQL point-in-time recovery is not initialized.');
  return backupMysqlPitrService;
}

function getBackupMariadbPitrService() {
  getBackupControlDatabase();
  if (!backupMariadbPitrService) throw new Error('MariaDB point-in-time recovery is not initialized.');
  return backupMariadbPitrService;
}

function getBackupPostgresqlRestoreService() {
  getBackupControlDatabase();
  if (!backupPostgresqlRestoreService) throw new Error('PostgreSQL restore is not initialized.');
  return backupPostgresqlRestoreService;
}

function getBackupPostgresqlPitrRestoreService() {
  getBackupControlDatabase();
  if (!backupPostgresqlPitrRestoreService) throw new Error('PostgreSQL point-in-time recovery is not initialized.');
  return backupPostgresqlPitrRestoreService;
}

function getBackupSqlServerRestoreService() {
  getBackupControlDatabase();
  if (!backupSqlServerRestoreService) throw new Error('SQL Server native recovery is not initialized.');
  return backupSqlServerRestoreService;
}

function getBackupOracleRestoreService() {
  getBackupControlDatabase();
  if (!backupOracleRestoreService) throw new Error('Oracle RMAN recovery is not initialized.');
  return backupOracleRestoreService;
}

function getBackupMongoDbRestoreService() {
  getBackupControlDatabase();
  if (!backupMongoDbRestoreService) throw new Error('MongoDB recovery is not initialized.');
  return backupMongoDbRestoreService;
}

function getBackupSqliteRestoreService() {
  getBackupControlDatabase();
  if (!backupSqliteRestoreService) throw new Error('SQLite recovery is not initialized.');
  return backupSqliteRestoreService;
}

function getBackupRedisRestoreService() {
  getBackupControlDatabase();
  if (!backupRedisRestoreService) throw new Error('Redis recovery is not initialized.');
  return backupRedisRestoreService;
}

function getBackupSearchSnapshotRestoreService() {
  getBackupControlDatabase();
  if (!backupSearchSnapshotRestoreService) throw new Error('Search snapshot recovery is not initialized.');
  return backupSearchSnapshotRestoreService;
}

function getBackupSearchSnapshotMaintenanceService() {
  getBackupControlDatabase();
  if (!backupSearchSnapshotMaintenanceService) throw new Error('Search snapshot maintenance is not initialized.');
  return backupSearchSnapshotMaintenanceService;
}

function getBackupSearchSnapshotRecoveryTestService() {
  getBackupControlDatabase();
  if (!backupSearchSnapshotRecoveryTestService) throw new Error('Search snapshot recovery tests are not initialized.');
  return backupSearchSnapshotRecoveryTestService;
}

function getBackupRepositoryVerificationService() {
  getBackupControlDatabase();
  if (!backupRepositoryVerificationService) throw new Error('Backup repository verification is not initialized.');
  return backupRepositoryVerificationService;
}

function getBackupRepositoryPruningService() {
  getBackupControlDatabase();
  if (!backupRepositoryPruningService) throw new Error('Backup repository pruning is not initialized.');
  return backupRepositoryPruningService;
}

function getBackupNotificationService() {
  getBackupControlDatabase();
  if (!backupNotificationService) throw new Error('Backup notifications are not initialized.');
  return backupNotificationService;
}

function getBackupObjectiveStatusService() {
  getBackupControlDatabase();
  if (!backupObjectiveStatusService) throw new Error('Backup objective reporting is not initialized.');
  return backupObjectiveStatusService;
}

async function initializeScheduledBackupWorker() {
  if (!isWorkerMode()) return null;
  const context = await backupSecretContext();
  return getBackupScheduledWorkerService().start(context.workspaceId, 'backup-worker');
}

async function getBackupScheduledWorkerStatus() {
  const context = await backupSecretContext();
  const registrations = await getBackupControlDatabase().repository('workerRegistration').list(context.workspaceId, { limit: 1000 });
  const workerId = backupDeviceId ? `device:${backupDeviceId}` : null;
  const registration = registrations.find((record) => record.workerId === workerId) || null;
  const heartbeatTime = Date.parse(registration?.heartbeatAt || '');
  const online = registration?.state === 'online' && Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime <= 30000;
  const jobs = await getBackupControlDatabase().repository('backupJob').list(context.workspaceId, { limit: 1000 });
  const nextRunAt = jobs.filter((job) => job.state === 'enabled' && Number.isFinite(Date.parse(job.nextRunAt || '')))
    .map(effectiveJobDispatchTime).filter(Boolean).sort()[0] || null;
  return {
    workerId,
    state: online ? 'online' : registration?.state === 'draining' ? 'draining' : 'offline',
    online,
    heartbeatAt: registration?.heartbeatAt || null,
    workerGeneration: registration?.workerGeneration || null,
    activeRunIds: Array.isArray(registration?.activeRunIds) ? registration.activeRunIds : [],
    nextRunAt,
    protocolVersion: registration?.protocolVersion || 1
  };
}

async function backupSecretContext() {
  const settings = await readSettings();
  const workspaceId = settings.mode === 'cloud' ? String(settings.activeTeamId || '') : 'local';
  if (!workspaceId) throw new Error('Select a workspace before managing Backup Manager secrets.');
  if (settings.mode === 'cloud') await syncWorkspaceControlFromCloud(workspaceId).catch(async (error) => logWorkspaceControlSyncFailure(error, workspaceId));
  return {
    workspaceId,
    actorId: String(settings.auth?.uid || 'local-user'),
    actorType: settings.auth?.uid ? 'user' : 'local-user'
  };
}

async function databaseManagerContext() {
  const settings = await readSettings();
  const workspaceId = settings.mode === 'cloud' ? String(settings.activeTeamId || '') : 'local';
  if (!workspaceId) throw Object.assign(new Error('Select a workspace before managing databases.'), { code: 'DATABASE_MANAGER_WORKSPACE_REQUIRED' });
  return {
    workspaceId,
    actorId: String(settings.auth?.uid || 'local-user')
  };
}

function databaseAccessFallbackWindowKey(context, profileId) {
  return JSON.stringify([
    String(context?.workspaceId || ''),
    String(context?.actorId || ''),
    String(profileId || '')
  ]);
}

async function openDatabaseAccessFallbackWindow(context, profile) {
  const profileId = String(profile?.id || '').trim();
  const key = databaseAccessFallbackWindowKey(context, profileId);
  const existing = databaseAccessFallbackWindows.get(key);
  if (existing) {
    try {
      await existing.readyPromise;
      if (existing.window && !existing.window.isDestroyed()) {
        existing.window.show();
        existing.window.focus();
        return { profileId, state: 'focused' };
      }
    } catch {
      // The stale entry is replaced below so Access remains retryable.
    }
    databaseAccessFallbackWindows.delete(key);
  }

  const accessWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1050,
    minHeight: 700,
    title: `${String(profile?.name || 'Database')} - DB Access Manager`,
    icon: APP_ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'database-manager', 'access-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  const entry = {
    window: accessWindow,
    workspaceId: String(context?.workspaceId || ''),
    actorId: String(context?.actorId || ''),
    profileId,
    requestIds: new Set(),
    readyPromise: null
  };
  databaseAccessFallbackWindows.set(key, entry);
  accessWindow.setMenu(null);
  accessWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  accessWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  accessWindow.webContents.on('console-message', (event) => {
    if (!['warning', 'error'].includes(event.level)) return;
    console.error(`[database-access-renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  accessWindow.on('closed', () => {
    if (databaseAccessFallbackWindows.get(key) === entry) databaseAccessFallbackWindows.delete(key);
    sendDatabaseManagerEvent(context.workspaceId, 'access-manager-state', {
      profileId,
      state: 'closed',
      reason: 'window-closed'
    });
  });

  entry.readyPromise = accessWindow.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    {
      query: {
        databaseAccessProfileId: profileId,
        databaseAccessWorkspaceId: String(context?.workspaceId || '')
      }
    }
  );
  try {
    await entry.readyPromise;
    if (accessWindow.isDestroyed()) throw new Error('DB Access Manager window closed during startup.');
    accessWindow.show();
    accessWindow.focus();
    sendDatabaseManagerEvent(context.workspaceId, 'access-manager-state', { profileId, state: 'active', reason: 'embedded-fallback' });
    return { profileId, state: 'active' };
  } catch {
    if (databaseAccessFallbackWindows.get(key) === entry) databaseAccessFallbackWindows.delete(key);
    if (!accessWindow.isDestroyed()) accessWindow.destroy();
    throw Object.assign(new Error('DB Access Manager could not be opened.'), {
      code: 'DATABASE_ACCESS_FALLBACK_FAILED',
      safeMessage: 'DB Access Manager could not be opened.',
      category: 'database-manager',
      retryable: true
    });
  }
}

function closeDatabaseAccessFallbackWindow(context, profileId) {
  const key = databaseAccessFallbackWindowKey(context, profileId);
  const entry = databaseAccessFallbackWindows.get(key);
  if (!entry) return;
  databaseAccessFallbackWindows.delete(key);
  if (entry.window && !entry.window.isDestroyed()) entry.window.close();
}

function disposeDatabaseAccessFallbackWindows() {
  for (const entry of databaseAccessFallbackWindows.values()) {
    if (entry.window && !entry.window.isDestroyed()) entry.window.close();
  }
  databaseAccessFallbackWindows.clear();
}

function databaseAccessFallbackEntryForSender(event) {
  const sender = event?.sender;
  if (!sender) return null;
  return [...databaseAccessFallbackWindows.values()].find((entry) => (
    entry.window && !entry.window.isDestroyed() && entry.window.webContents === sender
  )) || null;
}

function requireDatabaseAccessFallbackProfile(event, context, profileId) {
  const entry = databaseAccessFallbackEntryForSender(event);
  if (!entry) return null;
  const currentWorkspaceId = String(context?.workspaceId || '');
  const currentActorId = String(context?.actorId || '');
  const requestedProfileId = String(profileId || '');
  if (entry.workspaceId !== currentWorkspaceId || entry.actorId !== currentActorId) {
    throw Object.assign(new Error('The database workspace changed.'), {
      code: 'DATABASE_ACCESS_CONTEXT_CHANGED',
      safeMessage: 'The database workspace changed. Close DB Access Manager and open it again.',
      category: 'database-manager',
      retryable: true
    });
  }
  if (requestedProfileId !== entry.profileId) {
    throw Object.assign(new Error('DB Access Manager cannot use a different profile.'), {
      code: 'DATABASE_ACCESS_PROFILE_SCOPE_VIOLATION',
      safeMessage: 'DB Access Manager is limited to the database profile that opened this window.',
      category: 'database-manager',
      retryable: false
    });
  }
  return entry;
}

function requireDatabaseAccessFallbackRequest(event, context, requestId) {
  const entry = databaseAccessFallbackEntryForSender(event);
  if (!entry) return null;
  requireDatabaseAccessFallbackProfile(event, context, entry.profileId);
  if (!entry.requestIds.has(String(requestId || ''))) {
    throw Object.assign(new Error('DB Access Manager cannot control this request.'), {
      code: 'DATABASE_ACCESS_REQUEST_SCOPE_VIOLATION',
      safeMessage: 'DB Access Manager can only control operations started by this window.',
      category: 'database-manager',
      retryable: false
    });
  }
  return entry;
}

function sendDatabaseManagerEvent(workspaceId, type, payload) {
  recordDatabaseOperationalEvidence(workspaceId, type, payload);
  const eventProfileId = String(payload?.profileId || '');
  const targets = [
    mainWindow,
    ...[...databaseAccessFallbackWindows.values()]
      .filter((entry) => entry.workspaceId === String(workspaceId || '')
        && (!eventProfileId || entry.profileId === eventProfileId))
      .map((entry) => entry.window)
  ].filter((window, index, windows) => (
    window && !window.isDestroyed() && !window.webContents?.isDestroyed() && windows.indexOf(window) === index
  ));
  if (!targets.length) return null;
  try {
    if (databaseManagerEventSequence >= Number.MAX_SAFE_INTEGER) databaseManagerEventSequence = 0;
    const event = createDatabaseManagerEvent(type, workspaceId, payload, { sequence: databaseManagerEventSequence + 1 });
    databaseManagerEventSequence = event.sequence;
    for (const target of targets) target.webContents.send('database-manager:event', event);
    return event;
  } catch {
    return null;
  }
}

function recordDatabaseOperationalEvidence(workspaceId, type, payload = {}) {
  if (!databaseOperationalEvidenceStore || !workspaceId || !payload?.profileId) return;
  const category = type === 'connection-status' ? 'connection' : type === 'schema-change' ? 'schema' : null;
  if (!category) return;
  const state = String(payload.state || '').toLowerCase();
  if (category === 'connection' && !['tested', 'ready', 'closed', 'failed'].includes(state)) return;
  if (category === 'schema' && !['changed', 'failed', 'cancelled'].includes(state)) return;
  databaseOperationalEvidenceStore.append(workspaceId, {
    profileId: payload.profileId,
    category,
    operation: payload.operation,
    state,
    code: payload.code
  }).catch(() => {});
}

async function databaseProfileForRenderer(workspaceId, profile) {
  if (!profile || !['file', 'folder'].includes(profile.endpoint?.kind)) return profile;
  const localResource = await getDatabaseLocalResourceStore().metadata({ workspaceId, profileId: profile.id, kind: profile.endpoint.kind });
  return { ...profile, localResource };
}

function databaseInstalledDriverIds() {
  return new Set(['postgresql', 'mysql', 'sqlite', ...(databasePluginRegistry?.listInstalled().map((item) => item.pluginId) || [])]);
}

async function executeDatabaseCloudSyncOperation(operation) {
  await ensureActiveTeamUnlocked();
  const target = ['teams', operation.workspaceId, 'databaseProfiles', operation.profileId];
  const remote = await getDoc(target);
  const plan = planCloudSyncOperation(operation, remote);
  if (plan.action === 'noop') return { profileId: operation.profileId, deleted: true };
  try {
    if (plan.action === 'delete') return deleteDoc(target, { precondition: plan.precondition });
    return patchDoc(target, operation.document, { precondition: plan.precondition });
  } catch (error) {
    const firestoreStatus = String(error?.body?.error?.status || '').toUpperCase();
    if ([409, 412].includes(Number(error?.status)) || ['ABORTED', 'ALREADY_EXISTS', 'FAILED_PRECONDITION'].includes(firestoreStatus)) {
      throw Object.assign(new Error('Cloud database profile metadata changed on another device.'), {
        code: 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT', category: 'database-cloud-sync', retryable: false
      });
    }
    throw error;
  }
}

async function reconcileDatabaseProfileMetadata(workspaceId) {
  if (!databaseCloudSyncOutbox) return { attempted: 0, succeeded: 0, failed: [], pending: null, unavailable: true };
  return databaseCloudSyncOutbox.flush(workspaceId, executeDatabaseCloudSyncOperation, { limit: 100 });
}

async function logDatabaseCloudSyncFailure(workspaceId, code) {
  return getBackupLogStore().logger({ workspaceId, component: 'database-cloud-sync' }).warn(
    'Database profile cloud synchronization remains pending.',
    { code: code || 'DATABASE_MANAGER_CLOUD_SYNC_PENDING' }
  ).catch(() => {});
}

async function listDatabaseProfilesForRenderer(context, options = {}) {
  const imported = databaseConnectionImportService
    ? await databaseConnectionImportService.reconcile(context.workspaceId, context.actorId).catch(async (error) => {
      await getBackupLogStore().logger({ workspaceId: context.workspaceId, component: 'database-connection-import' }).warn(
        'Compatible Backup Manager connections could not be reconciled.',
        { code: error.code || 'DATABASE_MANAGER_CONNECTION_IMPORT_FAILED' }
      ).catch(() => {});
      return { created: [], failures: [] };
    })
    : { created: [], failures: [] };
  if (imported.failures?.length) {
    await getBackupLogStore().logger({ workspaceId: context.workspaceId, component: 'database-connection-import' }).warn(
      'One or more compatible Backup Manager connections could not be imported.',
      { count: imported.failures.length, code: imported.failures[0].code }
    ).catch(() => {});
  }
  const localProfiles = await getDatabaseProfileService().list(context.workspaceId, options);
  const renderedLocal = await Promise.all(localProfiles.map((profile) => databaseProfileForRenderer(context.workspaceId, profile)));
  const settings = await readSettings();
  if (settings.mode !== 'cloud') return renderedLocal;
  if (databaseCloudSyncOutbox && imported.created?.length) {
    await Promise.all(imported.created.map(({ profile }) => databaseCloudSyncOutbox.enqueueUpsert(context.workspaceId, profile, { expectedRevision: 0 }))).catch(async (error) => {
      await logDatabaseCloudSyncFailure(context.workspaceId, error.code);
    });
  }
  const reconciliation = await reconcileDatabaseProfileMetadata(context.workspaceId).catch(async (error) => {
    await logDatabaseCloudSyncFailure(context.workspaceId, error.code);
    return { pending: null, unavailable: true };
  });
  let cloudProfiles;
  try {
    cloudProfiles = await listCollection(['teams', context.workspaceId, 'databaseProfiles']);
  } catch (error) {
    await logDatabaseCloudSyncFailure(context.workspaceId, error.code);
    return renderedLocal.map((profile) => ({ ...profile, cloudSyncState: 'offline' }));
  }
  const pending = databaseCloudSyncOutbox ? await databaseCloudSyncOutbox.listPending(context.workspaceId) : [];
  const pendingById = new Map(pending.map((operation) => [operation.profileId, operation]));
  return mergeCloudProfiles(renderedLocal, cloudProfiles, { installedDrivers: databaseInstalledDriverIds() })
    .map((profile) => {
      const pendingOperation = pendingById.get(profile.id);
      if (profile.cloudOnly && !pendingOperation) return profile;
      return { ...profile, cloudSyncState: pendingOperation?.lastErrorCode === 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT' ? 'conflict' : pendingOperation ? 'pending' : reconciliation.unavailable ? 'unavailable' : 'synced' };
    });
}

async function syncDatabaseProfileMetadata(context, profile, expectedCloudRevision = 0) {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') return profile;
  if (!databaseCloudSyncOutbox) return { ...profile, cloudSyncState: 'unavailable' };
  try {
    await databaseCloudSyncOutbox.enqueueUpsert(context.workspaceId, profile, { expectedRevision: expectedCloudRevision });
    const result = await reconcileDatabaseProfileMetadata(context.workspaceId);
    const pending = await databaseCloudSyncOutbox.listPending(context.workspaceId);
    const pendingOperation = pending.find((operation) => operation.profileId === profile.id);
    const state = pendingOperation?.lastErrorCode === 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT' ? 'conflict' : pendingOperation ? 'pending' : 'synced';
    if (result.failed?.length) await logDatabaseCloudSyncFailure(context.workspaceId, result.failed[0].code);
    return { ...profile, cloudSyncState: state };
  } catch (error) {
    await logDatabaseCloudSyncFailure(context.workspaceId, error.code);
    return { ...profile, cloudSyncState: 'unavailable' };
  }
}

async function removeDatabaseProfileMetadata(context, profileId, expectedCloudRevision = null) {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') return { cloudSyncState: 'local' };
  if (!databaseCloudSyncOutbox) return { cloudSyncState: 'unavailable' };
  try {
    await databaseCloudSyncOutbox.enqueueDelete(context.workspaceId, profileId, { expectedRevision: expectedCloudRevision });
    const result = await reconcileDatabaseProfileMetadata(context.workspaceId);
    const pending = await databaseCloudSyncOutbox.listPending(context.workspaceId);
    if (result.failed?.length) await logDatabaseCloudSyncFailure(context.workspaceId, result.failed[0].code);
    const pendingOperation = pending.find((operation) => operation.profileId === profileId);
    return { cloudSyncState: pendingOperation?.lastErrorCode === 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT' ? 'conflict' : pendingOperation ? 'pending' : 'synced' };
  } catch (error) {
    await logDatabaseCloudSyncFailure(context.workspaceId, error.code);
    return { cloudSyncState: 'unavailable' };
  }
}

async function resolveDatabaseProfileCloudConflict(context, profileIdValue, strategyValue) {
  if (!databaseCloudSyncOutbox) throw Object.assign(new Error('Cloud profile synchronization is unavailable.'), { code: 'DATABASE_MANAGER_CLOUD_SYNC_UNAVAILABLE' });
  const profileId = String(profileIdValue || '').trim();
  const strategy = String(strategyValue || '').trim().toLowerCase();
  if (!profileId || profileId.length > 200 || !['keep-local', 'use-cloud'].includes(strategy)) throw new TypeError('Database cloud conflict resolution is invalid.');
  const pending = await databaseCloudSyncOutbox.getOperation(context.workspaceId, profileId);
  if (!pending || pending.lastErrorCode !== 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT') {
    throw Object.assign(new Error('This database profile no longer has a cloud synchronization conflict.'), { code: 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT_NOT_FOUND' });
  }
  await ensureActiveTeamUnlocked();
  const target = ['teams', context.workspaceId, 'databaseProfiles', profileId];
  const remoteRaw = await getDoc(target);
  const remote = remoteRaw ? normalizeCloudProfileDocument(remoteRaw) : null;
  if (strategy === 'keep-local') {
    await databaseCloudSyncOutbox.rebase(context.workspaceId, profileId, remote?.revision || 0);
    const reconciliation = await reconcileDatabaseProfileMetadata(context.workspaceId);
    const remaining = await databaseCloudSyncOutbox.getOperation(context.workspaceId, profileId);
    return { profileId, strategy, cloudSyncState: remaining?.lastErrorCode === 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT' ? 'conflict' : remaining ? 'pending' : 'synced', reconciliation };
  }
  const local = await getDatabaseProfileService().get(context.workspaceId, profileId);
  if (local && remote && local.driverId !== remote.metadata.driverId) {
    throw Object.assign(new Error('The cloud profile uses a different driver. Remove the local profile before setting it up again.'), { code: 'DATABASE_MANAGER_CLOUD_DRIVER_CONFLICT' });
  }
  if (local && remote && !remote.deletedAt) {
    const cloudInput = { ...remote.metadata };
    delete cloudInput.settings;
    delete cloudInput.startupScript;
    delete cloudInput.queryTimeoutMs;
    await getDatabaseProfileService().update(context.workspaceId, context.actorId, profileId, cloudInput, local.revision);
  } else if (local) {
    await getDatabaseProfileService().delete(context.workspaceId, context.actorId, profileId, local.revision);
    await getDatabaseLocalResourceStore().remove({ workspaceId: context.workspaceId, profileId }).catch(() => {});
  }
  if (local) await getDatabaseConnectionService().closeProfile(context.workspaceId, profileId);
  await databaseCloudSyncOutbox.discard(context.workspaceId, profileId);
  return { profileId, strategy, cloudSyncState: 'synced' };
}

function getUptimeControlDatabaseV2() {
  if (uptimeControlDatabaseError) throw uptimeControlDatabaseError;
  if (!uptimeControlDatabase) throw new Error('Uptime Monitor control database is not initialized.');
  return uptimeControlDatabase;
}

async function uptimeOperationalContext() {
  const settings = await readSettings();
  const workspaceId = settings.mode === 'cloud' ? String(settings.activeTeamId || '') : 'local';
  if (!workspaceId) throw new Error('Select a workspace before managing Uptime Monitor.');
  return {
    workspaceId,
    actorId: String(settings.auth?.uid || 'local-user')
  };
}

async function createUptimeSecretReference({ workspaceId, actorId, monitorName, headerName, value }) {
  const ref = await getBackupSecretStore().create({
    workspaceId,
    actorId,
    name: `${String(monitorName || 'Uptime monitor').slice(0, 80)} ${String(headerName || 'header').slice(0, 30)} ${crypto.randomBytes(3).toString('hex')}`,
    secretType: 'token',
    value,
    scope: 'device'
  });
  try {
    await getBackupControlDatabase().repository('secretRef').create({
      ...ref,
      actorId,
      workspaceId: ref.workspaceId,
      name: ref.name,
      provider: ref.provider,
      scope: ref.scope,
      providerKey: ref.providerKey,
      secretType: ref.secretType,
      version: ref.version
    });
    return ref.id;
  } catch (error) {
    await getBackupSecretStore().delete({ workspaceId, id: ref.id }).catch(() => {});
    throw error;
  }
}

async function deleteUptimeSecretReference(workspaceId, actorId, secretRefId) {
  const id = String(secretRefId || '').trim();
  if (!id) return false;
  await getBackupSecretStore().delete({ workspaceId, id });
  const metadata = await getBackupControlDatabase().repository('secretRef').get(workspaceId, id);
  if (metadata) {
    await getBackupControlDatabase().repository('secretRef').softDelete(workspaceId, id, {
      expectedRevision: metadata.revision,
      actorId
    });
  }
  return true;
}

function splitUptimeMonitorSecrets(input = {}, current = null) {
  const payload = structuredClone(input && typeof input === 'object' ? input : {});
  const currentConfig = current?.config && typeof current.config === 'object' ? current.config : {};
  const suppliedConfig = payload.config && typeof payload.config === 'object' ? payload.config : {};
  const secretHeaders = suppliedConfig.secretHeaders && typeof suppliedConfig.secretHeaders === 'object' && !Array.isArray(suppliedConfig.secretHeaders)
    ? suppliedConfig.secretHeaders
    : {};
  const hasSecretHeaders = Object.prototype.hasOwnProperty.call(suppliedConfig, 'secretHeaders');
  const config = { ...currentConfig, ...suppliedConfig };
  delete config.secretHeaders;
  config.secretHeaderRefs = {
    ...(currentConfig.secretHeaderRefs || {}),
    ...(suppliedConfig.secretHeaderRefs || {})
  };
  payload.config = config;
  return { payload, secretHeaders, hasSecretHeaders };
}

async function applyUptimeServerLinkHierarchy(payload, current = null) {
  const projectId = String(payload.projectId ?? current?.projectId ?? '').trim();
  payload.projectId = projectId || null;
  if (!projectId) {
    payload.parentGroup = '';
    return;
  }

  const store = await readCurrentStore();
  const project = (store.projects || []).find((item) => String(item.id) === projectId);
  if (project) {
    payload.parentGroup = String(project.name || '').trim() || 'Untitled Server';
    return;
  }

  if (current && String(current.projectId || '').trim() === projectId) {
    payload.parentGroup = String(current.parentGroup || '').trim();
    return;
  }

  throw Object.assign(new Error('The selected server link is no longer available.'), {
    code: 'UPTIME_MONITOR_PROJECT_NOT_FOUND'
  });
}

async function prepareUptimeMonitorForSave(context, input, current = null) {
  const { payload, secretHeaders, hasSecretHeaders } = splitUptimeMonitorSecrets(input, current);
  const createdSecretRefIds = [];
  try {
    await applyUptimeServerLinkHierarchy(payload, current);
    if (hasSecretHeaders) {
      for (const [rawHeaderName, rawValue] of Object.entries(secretHeaders)) {
        const headerName = String(rawHeaderName || '').trim().toLowerCase();
        if (!['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(headerName)) {
          throw Object.assign(new Error(`The ${headerName || 'unnamed'} header cannot be stored as a sensitive header.`), { code: 'UPTIME_HTTP_SECRET_HEADER_INVALID' });
        }
        if (rawValue == null || String(rawValue) === '') {
          delete payload.config.secretHeaderRefs[headerName];
          continue;
        }
        const secretRefId = await createUptimeSecretReference({
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          monitorName: payload.name || current?.name,
          headerName,
          value: String(rawValue)
        });
        payload.config.secretHeaderRefs[headerName] = secretRefId;
        createdSecretRefIds.push(secretRefId);
      }
    }
    return { payload, createdSecretRefIds };
  } catch (error) {
    await cleanupUptimeSecretReferences(context, createdSecretRefIds);
    throw error;
  }
}

async function cleanupUptimeSecretReferences(context, secretRefIds) {
  const uniqueIds = [...new Set((secretRefIds || []).map(String).filter(Boolean))];
  await Promise.allSettled(uniqueIds.map((id) => deleteUptimeSecretReference(context.workspaceId, context.actorId, id)));
}

function prepareUptimeMonitorForTest(context, input, current = null) {
  const { payload, secretHeaders, hasSecretHeaders } = splitUptimeMonitorSecrets(input, current);
  const transientSecrets = new Map();
  if (hasSecretHeaders) {
    for (const [rawHeaderName, rawValue] of Object.entries(secretHeaders)) {
      const headerName = String(rawHeaderName || '').trim().toLowerCase();
      if (rawValue == null || String(rawValue) === '') {
        delete payload.config.secretHeaderRefs[headerName];
        continue;
      }
      const reference = `uptime-test-${crypto.randomUUID()}`;
      payload.config.secretHeaderRefs[headerName] = reference;
      transientSecrets.set(reference, String(rawValue));
    }
  }
  return {
    monitor: normalizeMonitorInput({ ...current, ...payload }),
    secretResolver: async (secretRefId) => transientSecrets.has(secretRefId)
      ? transientSecrets.get(secretRefId)
      : getBackupSecretStore().resolve({ workspaceId: context.workspaceId, id: secretRefId })
  };
}

async function migrateLegacyUptimeForWorkspace(context) {
  const store = await readCurrentStore();
  return migrateLegacyUptime({
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    projects: store.projects,
    legacyRootPath: getUptimeRootPath(),
    controlDatabase: getUptimeControlDatabaseV2(),
    importSecret: ({ monitor, headerName, value }) => createUptimeSecretReference({
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      monitorName: monitor.name,
      headerName,
      value
    })
  });
}

async function initializeUptimeControlPlane({ startWorker = false } = {}) {
  const controlDatabase = new UptimeControlDatabase({ rootPath: getUptimeControlRootPath() });
  try {
    await controlDatabase.initialize();
    uptimeControlDatabase = controlDatabase;
    uptimeControlDatabaseError = null;
    const context = await uptimeOperationalContext();
    await migrateLegacyUptimeForWorkspace(context).catch((error) => {
      uptimeWorkerState.syncWarning = `Legacy uptime migration is pending: ${error.message}`;
    });
    uptimeIncidentPolicyService = new UptimeIncidentPolicyService({
      controlDatabase,
      notifier: async (event) => {
        if (!backupNotificationService) return [];
        return backupNotificationService.dispatchEventToRoutes(context.workspaceId, event.routeIds, event);
      }
    });
    const settings = await readSettings();
    const monitoringSettings = settings.uptimeMonitoring || {};
    uptimeScheduledWorkerService = new ScheduledUptimeWorkerService({
      controlDatabase,
      incidentPolicy: uptimeIncidentPolicyService,
      secretResolver: (secretRefId) => getBackupSecretStore().resolve({ workspaceId: context.workspaceId, id: secretRefId }),
      probeId: `local-windows:${backupDeviceId || process.pid}`,
      maximumConcurrency: Math.max(1, Math.min(32, Number(monitoringSettings.maximumConcurrency) || 8)),
      onTransition: async (transition) => queueUptimeTransitionSync(context, transition)
    });
    // Prime the active workspace before the renderer can issue its first read;
    // retain the queued refresh for later best-effort retries.
    queueUptimeWorkspaceSync(context);
    await syncUptimeWorkspaceBestEffort(context, { force: true });
    if (workspaceUptimeSyncTimer) clearInterval(workspaceUptimeSyncTimer);
    workspaceUptimeSyncTimer = setInterval(async () => {
      const current = await readSettings().catch(() => null);
      const workspaceId = current?.mode === 'cloud' ? String(current.activeTeamId || '') : '';
      if (!workspaceId) return;
      await syncUptimeWorkspaceBestEffort({
        workspaceId,
        actorId: String(current.auth?.uid || 'local-user')
      }, { force: true });
    }, WORKSPACE_UPTIME_SYNC_INTERVAL_MS);
    workspaceUptimeSyncTimer.unref?.();
    if (startWorker) {
      if (monitoringSettings.autostartEnabled !== false) await ensureWorkerAutostartEnabled().catch(() => {});
      await uptimeScheduledWorkerService.start(context.workspaceId, 'uptime-worker');
    }
    return controlDatabase;
  } catch (error) {
    if (workspaceUptimeSyncTimer) clearInterval(workspaceUptimeSyncTimer);
    workspaceUptimeSyncTimer = null;
    uptimeControlDatabaseError = error;
    uptimeControlDatabase = null;
    uptimeIncidentPolicyService = null;
    uptimeScheduledWorkerService = null;
    await controlDatabase.close().catch(() => {});
    throw error;
  }
}

async function getUptimeServiceStatusV2() {
  const context = await uptimeOperationalContext();
  const heartbeats = await getUptimeControlDatabaseV2().listWorkerHeartbeats(context.workspaceId);
  const health = evaluateWorkerHeartbeat(heartbeats);
  const heartbeat = health.heartbeat;
  if (health.stale && backupNotificationService) {
    await backupNotificationService.dispatchEvent(context.workspaceId, workerHealthEvent(heartbeat, nowIso())).catch(() => {});
  }
  return {
    active: health.active,
    state: health.active ? 'active' : heartbeat?.state || 'offline',
    heartbeatAt: heartbeat?.heartbeatAt || null,
    probeId: heartbeat?.probeId || null,
    processId: heartbeat?.processId || null,
    startedAt: heartbeat?.startedAt || null,
    activeChecks: Number(heartbeat?.activeChecks || 0),
    maximumConcurrency: Number(heartbeat?.maximumConcurrency || 8),
    autostartEnabled: await resolveWorkerAutostartEnabled().catch(() => false),
    syncWarning: uptimeWorkerLaunchError || uptimeWorkerState.syncWarning || '',
    lastError: heartbeat?.lastError || null
  };
}

async function setWorkerAutostartEnabled(enabled) {
  if (enabled) return ensureWorkerAutostartEnabled();
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings(buildLoginItemSettings({ enabled: false, execPath: process.execPath, args: buildWorkerArgs() }));
  } else {
    const autostartPath = path.join(os.homedir(), '.config', 'autostart', 'deployerx-uptime-worker.desktop');
    await fs.rm(autostartPath, { force: true });
  }
  uptimeWorkerState.autostartEnabled = false;
  return false;
}

async function getUptimeMonitoringSettings() {
  const settings = await readSettings();
  return {
    autostartEnabled: await resolveWorkerAutostartEnabled().catch(() => settings.uptimeMonitoring?.autostartEnabled !== false),
    maximumConcurrency: Math.max(1, Math.min(32, Number(settings.uptimeMonitoring?.maximumConcurrency) || 8)),
    rawCheckRetentionDays: 90,
    rollupRetentionMonths: 13,
    minimumIntervalSec: 30
  };
}

async function updateUptimeMonitoringSettings(input = {}) {
  const settings = await readSettings();
  const maximumConcurrency = Number(input.maximumConcurrency ?? settings.uptimeMonitoring?.maximumConcurrency ?? 8);
  if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1 || maximumConcurrency > 32) {
    throw Object.assign(new Error('Worker concurrency must be between 1 and 32.'), { code: 'UPTIME_CONCURRENCY_INVALID' });
  }
  const autostartEnabled = input.autostartEnabled === undefined
    ? settings.uptimeMonitoring?.autostartEnabled !== false
    : Boolean(input.autostartEnabled);
  await setWorkerAutostartEnabled(autostartEnabled);
  await writeSettings({ ...settings, uptimeMonitoring: { autostartEnabled, maximumConcurrency } });
  return getUptimeMonitoringSettings();
}

function parseUptimeNavigationArgument(argv = process.argv) {
  const raw = argv.find((argument) => String(argument).startsWith('--open-uptime='));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(String(raw).slice('--open-uptime='.length)));
    return {
      monitorId: String(parsed.monitorId || '').trim(),
      incidentId: String(parsed.incidentId || '').trim()
    };
  } catch {
    return null;
  }
}

async function buildWorkspaceUptimeReport(options = {}) {
  const context = await uptimeOperationalContext();
  queueUptimeWorkspaceSync(context);
  const database = getUptimeControlDatabaseV2();
  const toDate = options.to ? new Date(options.to) : new Date();
  const fromDate = options.from ? new Date(options.from) : new Date(toDate.getTime() - 86400000);
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime()) || toDate <= fromDate) {
    throw Object.assign(new Error('Choose a valid Uptime report range.'), { code: 'UPTIME_REPORT_RANGE_INVALID' });
  }
  const to = toDate.toISOString();
  const from = fromDate.toISOString();
  const monitors = await database.listMonitors(context.workspaceId, { includeDeleted: options.includeDeleted !== false, limit: 10000 });
  const selected = monitors.filter((monitor) => {
    if (options.monitorId && monitor.id !== options.monitorId) return false;
    if (options.projectId && monitor.projectId !== options.projectId) return false;
    if (options.group && monitor.group !== options.group) return false;
    return true;
  });
  const [checks, incidents, maintenance] = await Promise.all([
    Promise.all(selected.map(async (monitor) => [monitor.id, await database.listChecks(context.workspaceId, monitor.id, { from, to, limit: 100000 })])),
    database.listIncidents(context.workspaceId, { to, limit: 10000 }),
    database.listMaintenanceWindows(context.workspaceId, { includeDeleted: true, limit: 10000 })
  ]);
  return buildUptimeReport({
    monitors,
    checksByMonitor: Object.fromEntries(checks),
    incidents,
    maintenance,
    from,
    to,
    filters: { monitorId: options.monitorId || '', projectId: options.projectId || '', group: options.group || '', slaTargetPct: options.slaTargetPct || 99.9 }
  });
}

function openNotificationTarget(event = {}) {
  const target = {
    monitorId: String(event.monitorId || '').trim(),
    incidentId: String(event.incidentId || '').trim()
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    if (target.monitorId || target.incidentId || String(event.type || '').startsWith('uptime.')) mainWindow.webContents.send('uptime:navigate', target);
    return;
  }
  const uptimeArgument = target.monitorId || target.incidentId || String(event.type || '').startsWith('uptime.')
    ? [`--open-uptime=${encodeURIComponent(JSON.stringify(target))}`]
    : [];
  const args = process.defaultApp || !app.isPackaged ? [app.getAppPath(), ...uptimeArgument] : uptimeArgument;
  const child = execFile(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
}

function normalizedBackupAuditCode(value, fallback = 'BACKUP_OPERATION_FAILED') {
  const candidate = String(value || '').trim().toUpperCase();
  if (/^[A-Z][A-Z0-9_]{0,127}$/.test(candidate)) return candidate;
  const normalizedFallback = String(fallback || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(normalizedFallback) ? normalizedFallback : 'BACKUP_OPERATION_FAILED';
}

function normalizedBackupAuditCategory(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,63}$/.test(candidate) ? candidate : 'unknown';
}

function backupAuditFailureDetails(error, fallbackCode) {
  const errorCode = normalizedBackupAuditCode(error?.code, fallbackCode);
  return {
    errorCode,
    failureCode: normalizedBackupAuditCode(fallbackCode, errorCode),
    category: normalizedBackupAuditCategory(error?.category ?? error?.details?.category),
    operationAccepted: error?.operationAccepted === true || error?.details?.operationAccepted === true
  };
}

async function runAuditedBackupMutation(context, options, operation) {
  const correlationId = `corr_${crypto.randomUUID()}`;
  const auditStore = getBackupAuditStore();
  const logger = getBackupLogStore().logger({
    workspaceId: context.workspaceId,
    component: options.component || 'backup-manager',
    correlationId
  });
  const baseEvent = {
    workspaceId: context.workspaceId,
    actor: { type: context.actorType, id: context.actorId },
    action: options.action,
    resource: { type: options.resourceType, id: options.resourceId || null },
    correlationId
  };
  await auditStore.append({ ...baseEvent, outcome: 'attempt', details: options.details || {} });
  try {
    const result = await operation();
    const resultAudit = typeof options.resultAudit === 'function' ? options.resultAudit(result) : {};
    await auditStore.append({
      ...baseEvent,
      resource: { type: options.resourceType, id: resultAudit?.resourceId || result?.id || options.resourceId || null },
      outcome: 'success',
      details: { ...(options.details || {}), ...(resultAudit?.details || {}), revision: result?.revision ?? null, version: result?.version ?? null }
    });
    await logger.info(`${options.action} succeeded`, {
      resourceType: options.resourceType,
      resourceId: resultAudit?.resourceId || result?.id || options.resourceId || null
    }).catch(() => {});
    return result;
  } catch (error) {
    const failureDetails = backupAuditFailureDetails(error, options.failureAuditCode);
    await auditStore.append({
      ...baseEvent,
      outcome: 'failure',
      severity: 'warning',
      details: { ...(options.details || {}), ...failureDetails }
    }).catch(() => {});
    await logger.warn(`${options.action} failed`, {
      resourceType: options.resourceType,
      resourceId: options.resourceId || null,
      ...failureDetails
    }).catch(() => {});
    throw error;
  }
}

function influxDb3EnterpriseRetentionAuditDetails(input = {}) {
  const candidatePlanId = String(input.planId || '').trim();
  return {
    planId: /^influxdb3_enterprise_retention_[a-f0-9]{64}$/.test(candidatePlanId) ? candidatePlanId : null,
    mediaDomain: 'influxdb3-enterprise-native',
    deletionConfirmedByOperator: input.confirmed === true,
    exactConfirmationMatched: input.confirmationText === INFLUXDB3_ENTERPRISE_DELETE_CONFIRMATION
  };
}

function influxDb3EnterpriseRetentionPreviewResultAudit(result = {}) {
  const details = influxDb3EnterpriseRetentionAuditDetails({ planId: result.planId });
  return { resourceId: details.planId, details };
}

function cockroachDbRetentionAuditDetails(input = {}) {
  const requestedCount = Array.isArray(input.recoveryPointIds) ? input.recoveryPointIds.length : 0;
  const mediaDomain = ['deployerx-repository', 'cockroachdb-native'].includes(input.mediaDomain) ? input.mediaDomain : null;
  const candidatePlanId = String(input.planId || '').trim();
  return {
    planId: /^cockroach_retention_[a-f0-9]{64}$/.test(candidatePlanId) ? candidatePlanId : null,
    mediaDomain,
    recoveryPointCount: Math.min(requestedCount, 1000),
    externalNativeMediaPreserved: true,
    nativeMediaDeletionAttempted: false
  };
}

function getUptimeRuntimePath() {
  return path.join(getUptimeRootPath(), UPTIME_RUNTIME_FILE);
}

function getUptimeCommandsPath() {
  return path.join(getUptimeRootPath(), 'commands.json');
}

function getUptimeConfigCachePath() {
  return path.join(getUptimeRootPath(), 'config-cache.json');
}

function getUptimeWorkerLockPath() {
  return path.join(getUptimeRootPath(), 'worker.lock');
}

function getUptimeProjectPath(projectId) {
  return path.join(getUptimeRootPath(), 'projects', String(projectId || '').trim());
}

function getUptimeMonitorPath(projectId, monitorId) {
  return path.join(getUptimeProjectPath(projectId), String(monitorId || '').trim());
}

function getUptimeHistoryPath(projectId, monitorId) {
  return path.join(getUptimeMonitorPath(projectId, monitorId), 'history.ndjson');
}

function getUptimeIncidentPath(projectId, monitorId) {
  return path.join(getUptimeMonitorPath(projectId, monitorId), 'incidents.ndjson');
}

function nowMs() {
  return Date.now();
}

function trimStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeMonitorHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') return {};
  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
      .filter(([key, value]) => key && value)
  );
}

function normalizeHeaderAssertions(assertions = []) {
  if (!Array.isArray(assertions)) return [];
  return assertions
    .map((item = {}) => ({
      key: String(item.key || item.name || '').trim(),
      expected: String(item.expected || item.value || '').trim(),
      mode: item.mode === 'contains' ? 'contains' : 'equals'
    }))
    .filter((item) => item.key && item.expected);
}

function normalizeExpectedStatuses(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const normalized = list
    .map((item) => Number(String(item || '').trim()))
    .filter((item) => Number.isInteger(item) && item >= 100 && item <= 599);
  return normalized.length ? [...new Set(normalized)] : [200];
}

function blankHttpMonitorConfig() {
  return {
    method: 'GET',
    url: '',
    headers: {},
    expectedStatusCodes: [200],
    bodyMustContain: [],
    bodyMustNotContain: [],
    headerAssertions: []
  };
}

function blankTcpMonitorConfig() {
  return {
    host: '',
    port: 80
  };
}

function blankUptimeMonitor() {
  return {
    id: '',
    name: '',
    type: 'http',
    enabled: true,
    intervalSec: 300,
    timeoutMs: 10000,
    latencyBudgetMs: 0,
    http: blankHttpMonitorConfig(),
    tcp: blankTcpMonitorConfig()
  };
}

function normalizeUptimeMonitor(monitor = {}) {
  const blank = blankUptimeMonitor();
  const type = monitor.type === 'tcp' ? 'tcp' : 'http';
  const httpConfig = monitor.http || monitor.config || {};
  const tcpConfig = monitor.tcp || monitor.config || {};
  return {
    ...blank,
    ...monitor,
    id: String(monitor.id || createId('uptime')).trim(),
    name: String(monitor.name || '').trim() || `${type.toUpperCase()} monitor`,
    type,
    enabled: monitor.enabled !== false,
    intervalSec: Math.max(30, Number(monitor.intervalSec || blank.intervalSec) || blank.intervalSec),
    timeoutMs: Math.max(1000, Number(monitor.timeoutMs || blank.timeoutMs) || blank.timeoutMs),
    latencyBudgetMs: Math.max(0, Number(monitor.latencyBudgetMs || 0) || 0),
    http: {
      ...blankHttpMonitorConfig(),
      ...httpConfig,
      method: String(httpConfig.method || monitor.method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET',
      url: String(httpConfig.url || monitor.url || '').trim(),
      headers: normalizeMonitorHeaders(httpConfig.headers || monitor.headers),
      expectedStatusCodes: normalizeExpectedStatuses(httpConfig.expectedStatusCodes || monitor.expectedStatusCodes),
      bodyMustContain: trimStringList(httpConfig.bodyMustContain || monitor.bodyMustContain),
      bodyMustNotContain: trimStringList(httpConfig.bodyMustNotContain || monitor.bodyMustNotContain),
      headerAssertions: normalizeHeaderAssertions(httpConfig.headerAssertions || monitor.headerAssertions)
    },
    tcp: {
      ...blankTcpMonitorConfig(),
      ...tcpConfig,
      host: String(tcpConfig.host || monitor.host || '').trim(),
      port: Math.max(1, Math.min(65535, Number(tcpConfig.port || monitor.port || 80) || 80))
    }
  };
}

function normalizeUptimeMonitors(monitors = []) {
  if (!Array.isArray(monitors)) return [];
  return monitors.map(normalizeUptimeMonitor);
}

function defaultRuntimeMonitorState() {
  return {
    status: 'idle',
    consecutiveFailures: 0,
    lastCheckAt: '',
    lastSuccessAt: '',
    lastFailureAt: '',
    lastLatencyMs: null,
    lastError: '',
    nextCheckAt: '',
    activeIncidentId: '',
    incidentOpenSince: '',
    syncWarning: '',
    pausedAt: '',
    summary: '',
    checkCount: 0
  };
}

function defaultUptimeRuntime() {
  return {
    version: 1,
    heartbeatAt: '',
    worker: {
      active: false,
      startedAt: '',
      pid: process.pid,
      mode: 'window',
      lastConfigRefreshAt: '',
      commandPollAt: '',
      runLoopTickAt: '',
      autostartEnabled: false,
      syncWarning: ''
    },
    projects: {}
  };
}

function normalizeRuntimeMonitorState(item = {}) {
  return {
    ...defaultRuntimeMonitorState(),
    ...(item && typeof item === 'object' ? item : {}),
    consecutiveFailures: Math.max(0, Number(item?.consecutiveFailures || 0) || 0),
    checkCount: Math.max(0, Number(item?.checkCount || 0) || 0),
    lastLatencyMs: item?.lastLatencyMs == null ? null : Math.max(0, Number(item.lastLatencyMs) || 0)
  };
}

function normalizeUptimeRuntime(runtime = {}) {
  const projects = runtime?.projects && typeof runtime.projects === 'object' ? runtime.projects : {};
  return {
    ...defaultUptimeRuntime(),
    ...(runtime && typeof runtime === 'object' ? runtime : {}),
    worker: {
      ...defaultUptimeRuntime().worker,
      ...(runtime?.worker && typeof runtime.worker === 'object' ? runtime.worker : {})
    },
    projects: Object.fromEntries(
      Object.entries(projects).map(([projectId, projectState]) => [
        String(projectId || '').trim(),
        {
          monitors: Object.fromEntries(
            Object.entries(projectState?.monitors && typeof projectState.monitors === 'object' ? projectState.monitors : {}).map(
              ([monitorId, monitorState]) => [String(monitorId || '').trim(), normalizeRuntimeMonitorState(monitorState)]
            )
          )
        }
      ])
    )
  };
}

async function ensureUptimeRoot() {
  await fs.mkdir(path.join(getUptimeRootPath(), 'projects'), { recursive: true });
}

async function ensurePathDirectory(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonFileSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFilePretty(filePath, payload) {
  await ensurePathDirectory(filePath);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

async function readUptimeRuntime() {
  if (uptimeRuntimeCache) return structuredClone(uptimeRuntimeCache);
  await ensureUptimeRoot();
  uptimeRuntimeCache = normalizeUptimeRuntime(await readJsonFileSafe(getUptimeRuntimePath(), defaultUptimeRuntime()));
  return structuredClone(uptimeRuntimeCache);
}

async function writeUptimeRuntime(nextRuntime) {
  uptimeRuntimeCache = normalizeUptimeRuntime(nextRuntime);
  await writeJsonFilePretty(getUptimeRuntimePath(), uptimeRuntimeCache);
  return structuredClone(uptimeRuntimeCache);
}

async function mutateUptimeRuntime(mutator) {
  const current = await readUptimeRuntime();
  const next = await mutator(structuredClone(current));
  return writeUptimeRuntime(next || current);
}

function ensureProjectRuntimeState(runtime, projectId) {
  const normalizedProjectId = String(projectId || '').trim();
  if (!normalizedProjectId) return null;
  if (!runtime.projects[normalizedProjectId]) runtime.projects[normalizedProjectId] = { monitors: {} };
  return runtime.projects[normalizedProjectId];
}

function ensureRuntimeMonitorState(runtime, projectId, monitorId) {
  const projectState = ensureProjectRuntimeState(runtime, projectId);
  if (!projectState) return null;
  const normalizedMonitorId = String(monitorId || '').trim();
  if (!projectState.monitors[normalizedMonitorId]) {
    projectState.monitors[normalizedMonitorId] = defaultRuntimeMonitorState();
  } else {
    projectState.monitors[normalizedMonitorId] = normalizeRuntimeMonitorState(projectState.monitors[normalizedMonitorId]);
  }
  return projectState.monitors[normalizedMonitorId];
}

async function appendNdjson(filePath, entry) {
  await ensurePathDirectory(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function readNdjsonTail(filePath, limit = UPTIME_HISTORY_LIMIT) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isWorkerMode() {
  return process.argv.includes('--uptime-worker');
}

function isMcpAutostartMode() {
  return process.argv.includes(MCP_AUTOSTART_ARGUMENT);
}

function serviceModeLabel() {
  return isWorkerMode() ? 'worker' : 'window';
}

function defaultSettings() {
  return {
    setupComplete: false,
    mode: '',
    themeId: '',
    activeTeamId: '',
    activeTeamName: '',
    activeTeamUid: '',
    auth: null,
    cloudWorkspaceCache: null,
    cloudWorkspaceCaches: {},
    mcpIntegration: null,
    projectLocalSettings: {},
    uptimeMonitoring: { autostartEnabled: true, maximumConcurrency: 8 }
  };
}

function readThemePreferenceSync() {
  try {
    const raw = fsSync.readFileSync(getSettingsPath(), 'utf8');
    const settings = JSON.parse(raw);
    return typeof settings?.themeId === 'string' ? settings.themeId : '';
  } catch {
    return '';
  }
}

async function writeThemePreference(themeId) {
  const settings = await readSettings();
  await writeSettings({ ...settings, themeId: String(themeId || '') });
  return true;
}

function normalizeProjectLocalSettings(projectLocalSettings = {}) {
  return {
    ftpLocalPath: String(projectLocalSettings?.ftpLocalPath || '').trim()
  };
}

function normalizeStoredProject(project = {}) {
  const normalized = normalizeProjectImport(project);
  return {
    ...normalized,
    uptimeMonitors: normalizeUptimeMonitors(project?.uptimeMonitors)
  };
}

function projectLocalSettingsMap(settings = {}) {
  if (!settings?.projectLocalSettings || typeof settings.projectLocalSettings !== 'object') return {};

  return Object.fromEntries(
    Object.entries(settings.projectLocalSettings).map(([projectId, value]) => [
      String(projectId || '').trim(),
      normalizeProjectLocalSettings(value)
    ])
  );
}

async function getProjectLocalSettings(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return normalizeProjectLocalSettings();
  const settings = await readSettings();
  return normalizeProjectLocalSettings(projectLocalSettingsMap(settings)[id]);
}

async function setProjectLocalSettings(projectId, nextSettings = {}) {
  const id = String(projectId || '').trim();
  if (!id) return normalizeProjectLocalSettings();
  const settings = await readSettings();
  const projectLocalSettings = projectLocalSettingsMap(settings);
  const normalized = normalizeProjectLocalSettings(nextSettings);

  if (normalized.ftpLocalPath) projectLocalSettings[id] = normalized;
  else delete projectLocalSettings[id];

  await writeSettings({
    ...settings,
    projectLocalSettings
  });

  return normalizeProjectLocalSettings(projectLocalSettings[id]);
}

async function deleteProjectLocalSettings(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return false;
  const settings = await readSettings();
  const projectLocalSettings = projectLocalSettingsMap(settings);
  if (!Object.prototype.hasOwnProperty.call(projectLocalSettings, id)) return false;
  delete projectLocalSettings[id];
  await writeSettings({
    ...settings,
    projectLocalSettings
  });
  return true;
}

async function readSettings() {
  const settingsPath = getSettingsPath();
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    settingsCache = {
      ...defaultSettings(),
      ...JSON.parse(raw)
    };
  } catch {
    settingsCache = defaultSettings();
  }
  return structuredClone(settingsCache);
}

async function writeSettings(nextSettings) {
  settingsCache = {
    ...defaultSettings(),
    ...nextSettings
  };
  await fs.writeFile(getSettingsPath(), JSON.stringify(settingsCache, null, 2));
  return structuredClone(settingsCache);
}

async function saveFirebaseConfig(config) {
  const normalized = assertFirebaseConfig(config);
  if (!normalized.authDomain) normalized.authDomain = `${normalized.projectId}.firebaseapp.com`;
  await fs.writeFile(getUserFirebaseConfigPath(), JSON.stringify(normalized, null, 2));
  firebaseConfigCache = null;
  return firebaseConfigStatus();
}

async function ensureStore() {
  const storePath = getStorePath();
  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify({ projects: [] }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(getStorePath(), 'utf8');
  try {
    const data = JSON.parse(raw);
    return {
      projects: Array.isArray(data.projects) ? data.projects.map(normalizeStoredProject) : [],
      templates: Array.isArray(data.templates) ? data.templates.map(normalizeStoredTemplate) : []
    };
  } catch {
    return { projects: [], templates: [] };
  }
}

async function writeStore(data) {
  const payload = {
    ...data,
    templates: stripBuiltInTemplates(data.templates)
  };
  await fs.writeFile(getStorePath(), JSON.stringify(payload, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix = '') {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prefix ? `${prefix}-${id}` : id;
}

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

function publicSession(auth) {
  if (!auth) return null;
  return {
    uid: auth.uid,
    email: auth.email,
    displayName: auth.displayName || '',
    emailVerified: Boolean(auth.emailVerified),
    provider: auth.provider || ''
  };
}

function authSessionChanged(currentAuth, nextAuth) {
  const fields = ['uid', 'email', 'displayName', 'idToken', 'refreshToken', 'expiresAt', 'emailVerified', 'provider'];
  return fields.some((field) => currentAuth?.[field] !== nextAuth?.[field]);
}

async function loadFirebaseConfig({ refresh = false } = {}) {
  if (!refresh && firebaseConfigCache !== null) return firebaseConfigCache;

  const envConfig =
    process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID
      ? sanitizeFirebaseConfigForRuntime({
          apiKey: process.env.FIREBASE_API_KEY,
          authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
          projectId: process.env.FIREBASE_PROJECT_ID,
          googleClientId: process.env.FIREBASE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
          googleClientSecret: process.env.FIREBASE_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
          googleRedirectUri: process.env.FIREBASE_GOOGLE_REDIRECT_URI || ''
        })
      : null;
  if (envConfig) {
    firebaseConfigCache = { ...envConfig, source: 'environment' };
    return firebaseConfigCache;
  }

  const candidatePaths = [
    path.join(app.getAppPath(), 'firebase.config.json'),
    path.join(app.getAppPath(), '..', 'firebase.config.json'),
    path.join(__dirname, 'firebase.config.json'),
    path.join(path.dirname(app.getPath('exe')), 'firebase.config.json'),
    path.join(app.getPath('userData'), 'firebase.config.json')
  ];

  for (const configPath of candidatePaths) {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const config = sanitizeFirebaseConfigForRuntime(parsed);
      if (config) {
        firebaseConfigCache = {
          ...config,
          source: configPath
        };
        return firebaseConfigCache;
      }
    } catch {
      // Config is optional; setup UI will explain when it is missing.
    }
  }

  firebaseConfigCache = null;
  return firebaseConfigCache;
}

async function firebaseConfigStatus() {
  const config = await loadFirebaseConfig({ refresh: true });
  const validation = config ? validateFirebaseConfig(config, { requireGoogle: true }) : null;
  return {
    configured: Boolean(config?.apiKey && config?.projectId),
    googleConfigured: Boolean(validation?.valid),
    projectId: config?.projectId || '',
    source: config?.source || ''
  };
}

function requireFirebaseConfig(config) {
  if (!config?.apiKey || !config?.projectId) {
    throw new Error('Firebase Web config is missing. Add firebase.config.json with apiKey and projectId.');
  }
}

function firebaseErrorMessage(errorBody) {
  const firstArrayError = Array.isArray(errorBody)
    ? errorBody.find((item) => item?.error)?.error
    : null;
  const message =
    firstArrayError?.message ||
    firstArrayError?.status ||
    errorBody?.error_description ||
    errorBody?.error?.message ||
    errorBody?.error ||
    errorBody?.raw ||
    '';
  const normalized = String(message).replace(/_/g, ' ').toLowerCase();
  if (normalized.includes('email exists')) return 'An account already exists for this email.';
  if (normalized.includes('invalid login credentials') || normalized.includes('invalid password')) return 'Invalid email or password.';
  if (normalized.includes('email not found')) return 'No account was found for this email.';
  if (normalized.includes('invalid email')) return 'Enter a valid email address.';
  if (normalized.includes('weak password')) return 'Use a stronger password with at least 6 characters.';
  if (
    normalized.includes('too many attempts') ||
    normalized.includes('quota exceeded') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('too many requests')
  ) {
    return 'The cloud service is temporarily busy. Please wait a moment and try again.';
  }
  if (normalized.includes('user disabled')) return 'This account has been disabled.';
  if (normalized.includes('operation not allowed')) {
    return 'Email and password login is not enabled for this app.';
  }
  if (normalized.includes('expired oob code') || normalized.includes('invalid oob code')) {
    return 'That link is no longer valid. Request a new one and try again.';
  }
  if (normalized.includes('token expired') || normalized.includes('invalid id token')) {
    return 'Your session expired. Please login again.';
  }
  if (normalized.includes('api key')) return 'Firebase configuration is invalid. Check the app configuration and try again.';
  if (normalized.includes('client secret') || normalized.includes('client authentication')) {
    return 'Google rejected the token exchange. Add googleClientSecret to firebase.config.json for this Web OAuth client, or switch to a Desktop OAuth client.';
  }
  if (normalized.includes('cloud firestore api has not been used') || normalized.includes('firestore.googleapis.com')) {
    return 'Cloud Firestore is not enabled for this Firebase project. Open Firebase Console > Firestore Database, create a database, then retry after a few minutes.';
  }
  if (normalized.includes('permission denied') || normalized.includes('missing or insufficient permissions')) {
    return 'Firestore permissions are blocking cloud data. Deploy the included firestore.rules to this Firebase project, then try again.';
  }
  return message ? 'Firebase request failed. Please try again.' : 'Firebase request failed.';
}

function errorDetails(error) {
  const firstArrayError = Array.isArray(error?.body)
    ? error.body.find((item) => item?.error)?.error
    : null;

  return [
    error?.message,
    firstArrayError?.message,
    firstArrayError?.status,
    error?.body?.error_description,
    error?.body?.error?.message,
    error?.body?.error?.status,
    error?.body?.error,
    error?.body?.raw
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function isRecoverableCloudDataError(error) {
  const details = errorDetails(error);

  return (
    error?.status === 403 ||
    error?.status === 429 ||
    details.includes('missing or insufficient permissions') ||
    details.includes('permission denied') ||
    details.includes('cloud firestore api has not been used') ||
    details.includes('firestore.googleapis.com') ||
    details.includes('firebase web config is missing') ||
    details.includes('firebase web config must include') ||
    details.includes('resource exhausted') ||
    details.includes('quota exceeded') ||
    details.includes('too many requests')
  );
}

function normalizeWorkspaceRole(role, { allowOwner = false } = {}) {
  const normalized = String(role || '').trim().toLowerCase();
  if (allowOwner && normalized === 'owner') return 'owner';
  return normalized === 'admin' ? 'admin' : 'member';
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error(firebaseErrorMessage(body));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function firebaseAuthRequest(action, payload) {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  return fetchJson(`${FIREBASE_AUTH_URL}/${action}?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function tryFirebaseHostingConfig(projectId) {
  if (!projectId) return null;
  const candidates = [
    `https://${projectId}.firebaseapp.com/__/firebase/init.json`,
    `https://${projectId}.web.app/__/firebase/init.json`
  ];
  for (const url of candidates) {
    try {
      const config = await fetchJson(url);
      if (config?.apiKey && config?.projectId) return config;
    } catch {
      // Hosting init config is optional and only works when Firebase Hosting is configured.
    }
  }
  return null;
}

function parseFirebaseConfigJson(parsed) {
  if (parsed?.apiKey && (parsed.projectId || parsed.project_id)) {
    return {
      apiKey: parsed.apiKey,
      authDomain: parsed.authDomain || '',
      projectId: parsed.projectId || parsed.project_id,
      googleClientId: parsed.googleClientId || parsed.googleOAuthClientId || '',
      googleClientSecret: parsed.googleClientSecret || parsed.googleOAuthClientSecret || '',
      googleRedirectUri: parsed.googleRedirectUri || ''
    };
  }

  if (parsed?.project_id && parsed?.client_email && parsed?.private_key) {
    return {
      adminProjectId: parsed.project_id
    };
  }

  return null;
}

function normalizeAuthSession(payload, displayName = '') {
  const expiresIn = Number(payload.expiresIn || 3600);
  return {
    uid: payload.localId || payload.user_id,
    email: payload.email || '',
    displayName,
    idToken: payload.idToken,
    refreshToken: payload.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - 60000,
    emailVerified: Boolean(payload.emailVerified),
    provider: payload.providerId || payload.providerUserInfo?.[0]?.providerId || ''
  };
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();

  // Browsers retain the foreground after an external OAuth flow on Windows.
  // Briefly raising the window makes the completed sign-in visible immediately.
  if (process.platform === 'win32') mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();

  if (process.platform === 'win32') {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setAlwaysOnTop(false);
      mainWindow.focus();
    }, 250);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    if (isMcpAutostartMode()) createTray();
    return;
  }
  if (isMcpAutostartMode()) createTray();
  if (process.platform === 'darwin') app.dock?.show();
  focusMainWindow();
}

function openExistingMainWindow(argv = []) {
  if (!app.isReady() || !mainWindow || mainWindow.isDestroyed()) {
    pendingSecondInstanceArguments = argv;
    return;
  }

  showMainWindow();
  const uptimeTarget = parseUptimeNavigationArgument(argv);
  if (!uptimeTarget) return;
  const navigate = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('uptime:navigate', uptimeTarget);
  };
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', navigate);
  else navigate();
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;

  tray = new Tray(APP_ICON);
  tray.setToolTip('DeployerX - running in the background');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DeployerX', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Quit DeployerX',
      click: () => {
        isAppQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function googleLoginResultHtml({
  tone = 'success',
  eyebrow = 'Google sign in',
  title,
  message,
  detail,
  autoClose = false
}) {
  const logoDataUrl = `data:image/png;base64,${fsSync.readFileSync(path.join(__dirname, '..', 'assets', 'deployerx-logo.png')).toString('base64')}`;
  const dmSansFontUrl = (fileName) => pathToFileURL(path.join(__dirname, 'assets', 'fonts', fileName)).href;
  const dmSansFontFaces = `
      @font-face {
        font-family: "DM Sans";
        font-style: normal;
        font-weight: 400;
        font-display: swap;
        src: url("${dmSansFontUrl('DMSans-Regular.ttf')}") format("truetype");
      }
      @font-face {
        font-family: "DM Sans";
        font-style: normal;
        font-weight: 500;
        font-display: swap;
        src: url("${dmSansFontUrl('DMSans-Medium.ttf')}") format("truetype");
      }
      @font-face {
        font-family: "DM Sans";
        font-style: normal;
        font-weight: 600;
        font-display: swap;
        src: url("${dmSansFontUrl('DMSans-SemiBold.ttf')}") format("truetype");
      }
      @font-face {
        font-family: "DM Sans";
        font-style: normal;
        font-weight: 700;
        font-display: swap;
        src: url("${dmSansFontUrl('DMSans-Bold.ttf')}") format("truetype");
      }
      @font-face {
        font-family: "DM Sans";
        font-style: normal;
        font-weight: 800;
        font-display: swap;
        src: url("${dmSansFontUrl('DMSans-ExtraBold.ttf')}") format("truetype");
      }`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${title} | DeployerX</title>
    <style>
      :root {
        color-scheme: light;
        --page: #f4f6f8;
        --surface: #ffffff;
        --surface-muted: #f7f9fa;
        --ink: #18201f;
        --muted: #687472;
        --line: #dce3e1;
        --brand: #167d68;
        --brand-strong: #0d6554;
        --brand-soft: #e6f4f0;
        --accent: #2874c6;
        --shadow: 0 24px 70px rgba(22, 43, 39, 0.12);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --page: #101514;
          --surface: #18201f;
          --surface-muted: #1d2725;
          --ink: #edf4f2;
          --muted: #9cacaa;
          --line: #30403d;
          --brand: #42c6a5;
          --brand-strong: #70dabc;
          --brand-soft: #173d34;
          --accent: #72aef0;
          --shadow: 0 24px 70px rgba(0, 0, 0, 0.32);
        }
      }
      * { box-sizing: border-box; }
      ${dmSansFontFaces}
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        background-color: var(--page);
        background-image:
          linear-gradient(var(--line) 1px, transparent 1px),
          linear-gradient(90deg, var(--line) 1px, transparent 1px);
        background-size: 42px 42px;
        font-family: "DM Sans", sans-serif;
      }
      body::before {
        content: '';
        position: fixed;
        inset: 0;
        pointer-events: none;
        background: rgba(244, 246, 248, 0.82);
      }
      @media (prefers-color-scheme: dark) {
        body::before { background: rgba(16, 21, 20, 0.86); }
      }
      .shell {
        position: relative;
        z-index: 1;
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto 1fr auto;
        padding: 28px clamp(22px, 5vw, 72px);
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 11px;
        width: max-content;
        color: var(--ink);
        font-size: 16px;
        font-weight: 750;
      }
      .brand-mark {
        width: 34px;
        height: 34px;
        border-radius: 7px;
        object-fit: contain;
      }
      main {
        display: grid;
        place-items: center;
        padding: 48px 0;
      }
      .result {
        width: min(560px, 100%);
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      .result-bar { height: 4px; background: var(--brand); }
      .result[data-tone="cancelled"] .result-bar { background: #d99a2b; }
      .result[data-tone="error"] .result-bar { background: #d85f5f; }
      .content { padding: clamp(30px, 7vw, 48px); }
      .status-icon {
        position: relative;
        width: 52px;
        height: 52px;
        margin-bottom: 28px;
        border: 1px solid color-mix(in srgb, var(--brand) 35%, var(--line));
        border-radius: 50%;
        background: var(--brand-soft);
      }
      .status-icon::before,
      .status-icon::after {
        content: '';
        position: absolute;
        background: var(--brand);
        border-radius: 2px;
      }
      .status-icon::before {
        width: 10px;
        height: 3px;
        left: 14px;
        top: 27px;
        transform: rotate(45deg);
      }
      .status-icon::after {
        width: 22px;
        height: 3px;
        left: 21px;
        top: 23px;
        transform: rotate(-45deg);
      }
      [data-tone="cancelled"] .status-icon {
        border-color: #e7c783;
        background: #fff6df;
      }
      [data-tone="cancelled"] .status-icon::before,
      [data-tone="cancelled"] .status-icon::after {
        width: 20px;
        height: 3px;
        left: 15px;
        top: 24px;
        background: #a86800;
      }
      [data-tone="cancelled"] .status-icon::before { transform: rotate(45deg); }
      [data-tone="cancelled"] .status-icon::after { transform: rotate(-45deg); }
      [data-tone="error"] .status-icon {
        border-color: #e6aaaa;
        background: #fff0f0;
      }
      [data-tone="error"] .status-icon::before {
        width: 3px;
        height: 17px;
        left: 24px;
        top: 12px;
        background: #b53b3b;
        transform: none;
      }
      [data-tone="error"] .status-icon::after {
        width: 4px;
        height: 4px;
        left: 23.5px;
        top: 34px;
        background: #b53b3b;
        transform: none;
      }
      @media (prefers-color-scheme: dark) {
        [data-tone="cancelled"] .status-icon { border-color: #72591e; background: #382e16; }
        [data-tone="cancelled"] .status-icon::before,
        [data-tone="cancelled"] .status-icon::after { background: #efbd55; }
        [data-tone="error"] .status-icon { border-color: #713a3a; background: #3a2020; }
        [data-tone="error"] .status-icon::before,
        [data-tone="error"] .status-icon::after { background: #ef8585; }
      }
      .eyebrow {
        margin: 0 0 10px;
        color: var(--brand);
        font-size: 12px;
        font-weight: 750;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: clamp(27px, 5vw, 36px);
        line-height: 1.18;
        letter-spacing: 0;
      }
      .message {
        margin: 16px 0 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.65;
      }
      .detail {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        margin: 28px 0 0;
        padding: 14px 16px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--muted);
        background: var(--surface-muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .detail-dot {
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        margin-top: 6px;
        border-radius: 50%;
        background: var(--accent);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-top: 30px;
      }
      button {
        min-height: 42px;
        padding: 0 18px;
        border: 1px solid var(--brand-strong);
        border-radius: 6px;
        color: #ffffff;
        background: var(--brand-strong);
        font: inherit;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }
      button:hover { filter: brightness(1.08); }
      button:focus-visible { outline: 3px solid color-mix(in srgb, var(--brand) 28%, transparent); outline-offset: 3px; }
      .hint { color: var(--muted); font-size: 12px; line-height: 1.4; }
      footer {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        color: var(--muted);
        font-size: 12px;
      }
      footer strong { color: var(--ink); font-weight: 650; }
      @media (max-width: 560px) {
        .shell { padding: 20px; }
        main { padding: 34px 0; }
        .content { padding: 30px 24px; }
        .actions { align-items: stretch; flex-direction: column; }
        footer { flex-direction: column; gap: 6px; }
      }
      @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="brand"><img class="brand-mark" src="${logoDataUrl}" alt="DeployerX logo">DeployerX</header>
      <main>
        <section class="result" data-tone="${tone}" aria-labelledby="result-title">
          <div class="result-bar"></div>
          <div class="content">
            <div class="status-icon" aria-hidden="true"></div>
            <p class="eyebrow">${eyebrow}</p>
            <h1 id="result-title">${title}</h1>
            <p class="message">${message}</p>
            <div class="detail"><span class="detail-dot"></span><span>${detail}</span></div>
            <div class="actions">
              <button id="close-window" type="button">Close this tab</button>
              <span class="hint" id="close-hint">Your DeployerX window remains open.</span>
            </div>
          </div>
        </section>
      </main>
      <footer><span><strong>Local authentication callback</strong></span><span>No credentials are displayed on this page.</span></footer>
    </div>
    <script>
      const closeButton = document.getElementById('close-window');
      const closeHint = document.getElementById('close-hint');
      const closeWindow = () => {
        window.close();
        window.setTimeout(() => {
          closeHint.textContent = 'You can now close this browser tab manually.';
          closeButton.textContent = 'Ready to close';
          closeButton.disabled = true;
        }, 250);
      };
      closeButton.addEventListener('click', closeWindow);
      ${autoClose ? "window.setTimeout(closeWindow, 900);" : ''}
    </script>
  </body>
</html>`;
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address()));
  });
}

let cancelPendingGoogleLogin = null;

async function requestGoogleTokens(config) {
  config = assertFirebaseConfig(config, { requireGoogle: true });

  const state = base64Url(crypto.randomBytes(18));
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  let settled = false;

  const redirectUri = config.googleRedirectUri || 'http://127.0.0.1:42813/oauth/google';
  const redirectUrl = new URL(redirectUri);
  if (redirectUrl.hostname !== '127.0.0.1' && redirectUrl.hostname !== 'localhost') {
    throw new Error('Google redirect URI must use localhost or 127.0.0.1 for desktop login.');
  }
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(redirectUrl.port || 80), redirectUrl.hostname, () => resolve());
  });

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      let timeout = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        server.close();
        if (error) reject(error);
        else resolve(value);
      };
      cancelPendingGoogleLogin = () => {
        if (settled) return false;
        finish(new Error('Google login cancelled.'));
        return true;
      };

    server.on('request', (request, response) => {
      const url = new URL(request.url || '/', redirectUri);
      if (url.pathname !== '/oauth/google') {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        response.end(googleLoginResultHtml({
          tone: 'error',
          eyebrow: 'Security check',
          title: 'Sign in could not be verified',
          message: 'DeployerX stopped this sign-in attempt because the security response did not match.',
          detail: 'Return to DeployerX and start Google sign in again. Nothing was changed in your workspace.'
        }));
        finish(new Error('Google login state did not match.'));
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        response.writeHead(400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        response.end(googleLoginResultHtml({
          tone: 'cancelled',
          title: 'Google sign in was cancelled',
          message: 'No account was connected, and your DeployerX workspace has not been changed.',
          detail: 'Close this tab to return to DeployerX. You can try again whenever you are ready.'
        }));
        finish(new Error(`Google login failed: ${error}`));
        return;
      }

      const authCode = url.searchParams.get('code');
      if (!authCode) {
        response.writeHead(400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        response.end(googleLoginResultHtml({
          tone: 'error',
          title: 'Sign in was not completed',
          message: 'Google did not return the authorization needed to connect your account.',
          detail: 'Return to DeployerX and try again. If the issue continues, check the Google OAuth configuration.'
        }));
        finish(new Error('Google login did not return an authorization code.'));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(googleLoginResultHtml({
        title: 'You are signed in',
        message: 'Google authentication is complete. DeployerX is finishing the connection in your app.',
        detail: 'This tab will close automatically. You can also close it now and continue in DeployerX.',
        autoClose: true
      }));
      finish(null, authCode);
    });

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', config.googleClientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'select_account');

      timeout = setTimeout(() => finish(new Error('Google login timed out. Please try again.')), 180000);
      shell.openExternal(authUrl.toString()).catch(finish);
    });
  } finally {
    cancelPendingGoogleLogin = null;
  }

  const tokenBody = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  if (config.googleClientSecret) {
    tokenBody.set('client_secret', config.googleClientSecret);
  }

  return fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString()
  });
}

async function signInWithGoogle() {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  const googleTokens = await requestGoogleTokens(config);
  const credential =
    googleTokens.id_token
      ? `id_token=${encodeURIComponent(googleTokens.id_token)}&providerId=google.com`
      : `access_token=${encodeURIComponent(googleTokens.access_token)}&providerId=google.com`;

  const firebaseAuth = await firebaseAuthRequest('accounts:signInWithIdp', {
    postBody: credential,
    requestUri: 'http://localhost',
    returnIdpCredential: true,
    returnSecureToken: true
  });

  return normalizeAuthSession(firebaseAuth, firebaseAuth.displayName || '');
}

async function lookupAuthUser(auth) {
  if (!auth?.idToken) return auth;
  const lookup = await firebaseAuthRequest('accounts:lookup', { idToken: auth.idToken });
  const user = lookup?.users?.[0] || {};
  const provider = user.providerUserInfo?.[0]?.providerId || auth.provider || '';
  return {
    ...auth,
    email: user.email || auth.email || '',
    displayName: user.displayName || auth.displayName || '',
    emailVerified: Boolean(user.emailVerified),
    provider
  };
}

function needsEmailVerification(auth) {
  return Boolean(auth?.email && auth.provider !== 'google.com' && !auth.emailVerified);
}

async function refreshAuthSession(settings, options = {}) {
  const { forceLookup = false } = options;
  if (!settings.auth?.refreshToken) throw new Error('Login is required.');
  if (settings.auth.idToken && settings.auth.expiresAt > Date.now()) {
    if (!forceLookup) return settings.auth;
    const checkedAuth = await lookupAuthUser(settings.auth);
    const latestSettings = await readSettings();
    if (
      latestSettings.auth?.refreshToken === settings.auth.refreshToken &&
      authSessionChanged(latestSettings.auth, checkedAuth)
    ) {
      await writeSettings({ ...latestSettings, auth: checkedAuth });
    }
    return checkedAuth;
  }

  if (!authRefreshPromise) {
    const refreshSource = structuredClone(settings.auth);
    authRefreshPromise = (async () => {
      const config = await loadFirebaseConfig();
      requireFirebaseConfig(config);
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshSource.refreshToken
      });
      const refreshed = await fetchJson(`${FIREBASE_TOKEN_URL}?key=${encodeURIComponent(config.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const refreshedAuth = normalizeAuthSession(
        {
          ...refreshed,
          localId: refreshed.user_id,
          idToken: refreshed.id_token,
          refreshToken: refreshed.refresh_token,
          expiresIn: refreshed.expires_in,
          email: refreshSource.email,
          emailVerified: refreshSource.emailVerified,
          provider: refreshSource.provider
        },
        refreshSource.displayName || ''
      );
      const latestSettings = await readSettings();
      if (latestSettings.auth?.refreshToken !== refreshSource.refreshToken) {
        if (!latestSettings.auth) throw new Error('Login is required.');
        return latestSettings.auth;
      }
      await writeSettings({ ...latestSettings, auth: refreshedAuth });
      return refreshedAuth;
    })();
  }

  let auth;
  try {
    auth = await authRefreshPromise;
  } finally {
    authRefreshPromise = null;
  }

  const nextAuth = forceLookup ? await lookupAuthUser(auth) : auth;
  if (forceLookup && authSessionChanged(auth, nextAuth)) {
    const latestSettings = await readSettings();
    if (latestSettings.auth?.refreshToken === auth.refreshToken) {
      await writeSettings({ ...latestSettings, auth: nextAuth });
    }
  }
  return nextAuth;
}

async function requireAuthSession() {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') throw new Error('Cloud mode is not enabled.');
  const auth = await refreshAuthSession(settings);
  if (!auth?.idToken || !auth.uid) throw new Error('Login is required.');
  return auth;
}

async function firestoreBaseUrl() {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/(default)/documents`;
}

function encodePath(segments) {
  return segments.map((segment) => encodeURIComponent(String(segment))).join('/');
}

function displayFirestorePath(segments) {
  return segments.map((segment) => String(segment)).join('/');
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.entries(value).reduce((fields, [key, childValue]) => {
          fields[key] = toFirestoreValue(childValue);
          return fields;
        }, {})
      }
    };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if (!value || Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return value.timestampValue;
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    return (value.arrayValue.values || []).map(fromFirestoreValue);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) {
    return Object.entries(value.mapValue.fields || {}).reduce((object, [key, childValue]) => {
      object[key] = fromFirestoreValue(childValue);
      return object;
    }, {});
  }
  return null;
}

function toFirestoreDocument(data) {
  return {
    fields: Object.entries(data || {}).reduce((fields, [key, value]) => {
      if (String(key).startsWith('__')) return fields;
      fields[key] = toFirestoreValue(value);
      return fields;
    }, {})
  };
}

function fromFirestoreDocument(document) {
  const data = Object.entries(document?.fields || {}).reduce((object, [key, value]) => {
    object[key] = fromFirestoreValue(value);
    return object;
  }, {});
  const id = String(document?.name || '').split('/').pop();
  return {
    ...data,
    id: data.id || id,
    __path: document?.name || '',
    __createTime: document?.createTime || '',
    __updateTime: document?.updateTime || ''
  };
}

async function firestoreFetch(segments, options = {}) {
  const auth = await requireAuthSession();
  const baseUrl = await firestoreBaseUrl();
  const query = options.query && typeof options.query === 'object' ? new URLSearchParams(Object.entries(options.query).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, String(value)])).toString() : '';
  const url = `${baseUrl}/${encodePath(segments)}${query ? `?${query}` : ''}`;
  const requestOptions = { ...options };
  delete requestOptions.query;
  try {
    return await fetchJson(url, {
      ...requestOptions,
      headers: {
        Authorization: `Bearer ${auth.idToken}`,
        ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
        ...(requestOptions.headers || {})
      }
    });
  } catch (error) {
    error.firestorePath = displayFirestorePath(segments);
    error.firestoreMethod = options.method || 'GET';
    if (error.status === 403 && !String(error.message || '').includes(error.firestorePath)) {
      error.message = `${error.message} Blocked ${error.firestoreMethod} ${error.firestorePath}.`;
    }
    throw error;
  }
}

async function getDoc(segments) {
  try {
    return fromFirestoreDocument(await firestoreFetch(segments));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function firestorePreconditionQuery(precondition = {}) {
  if (typeof precondition.exists === 'boolean') return { 'currentDocument.exists': precondition.exists };
  if (precondition.updateTime) return { 'currentDocument.updateTime': String(precondition.updateTime) };
  return {};
}

async function patchDoc(segments, data, { precondition = null } = {}) {
  return fromFirestoreDocument(
    await firestoreFetch(segments, {
      method: 'PATCH',
      body: JSON.stringify(toFirestoreDocument(data)),
      query: firestorePreconditionQuery(precondition || {})
    })
  );
}

async function deleteDoc(segments, { precondition = null } = {}) {
  try {
    await firestoreFetch(segments, { method: 'DELETE', query: firestorePreconditionQuery(precondition || {}) });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function listCollection(segments, query = {}) {
  try {
    const documents = [];
    let pageToken = '';
    do {
      const body = await firestoreFetch(segments, {
        query: { pageSize: 1000, ...query, ...(pageToken ? { pageToken } : {}) }
      });
      documents.push(...(body.documents || []).map(fromFirestoreDocument));
      pageToken = String(body.nextPageToken || '');
    } while (pageToken);
    return documents;
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

function firestoreDocumentId(document) {
  return String(document?.__path || '').split('/').pop() || document?.id;
}

async function deleteCollectionDocuments(segments) {
  const documents = await listCollection(segments);
  for (const document of documents) {
    await deleteDoc([...segments, firestoreDocumentId(document)]);
  }
}

function inviteInboxPath(email, inviteId = '') {
  const segments = ['inviteInboxes', emailKey(email), 'items'];
  return inviteId ? [...segments, inviteId] : segments;
}

function normalizeInviteInboxDocument(invite = {}) {
  const email = emailKey(invite.emailLower || invite.email);
  return {
    id: String(invite.id || ''),
    teamId: String(invite.teamId || ''),
    teamName: String(invite.teamName || 'Team'),
    email,
    emailLower: email,
    role: normalizeWorkspaceRole(invite.role),
    status: invite.status || 'pending',
    createdAt: invite.createdAt || nowIso(),
    updatedAt: invite.updatedAt || nowIso()
  };
}

async function syncInviteInboxDocument(invite = {}) {
  const inboxInvite = normalizeInviteInboxDocument(invite);
  if (!inboxInvite.id || !inboxInvite.emailLower || !inboxInvite.teamId) return;
  await patchDoc(inviteInboxPath(inboxInvite.emailLower, inboxInvite.id), inboxInvite);
}

async function deleteInviteInboxDocument(invite = {}) {
  const email = emailKey(invite.emailLower || invite.email);
  const inviteId = String(invite.id || '');
  if (!email || !inviteId) return;
  await deleteDoc(inviteInboxPath(email, inviteId));
}

async function deleteTeamMemberDocuments(teamId, ownerUid) {
  const members = await listCollection(['teams', teamId, 'members']);
  members.sort((left, right) => {
    const leftIsOwner = firestoreDocumentId(left) === ownerUid;
    const rightIsOwner = firestoreDocumentId(right) === ownerUid;
    return Number(leftIsOwner) - Number(rightIsOwner);
  });
  for (const member of members) {
    await deleteDoc(['teams', teamId, 'members', firestoreDocumentId(member)]);
  }
}

async function runFirestoreQuery(structuredQuery) {
  const auth = await requireAuthSession();
  const baseUrl = await firestoreBaseUrl();
  const body = await fetchJson(`${baseUrl}:runQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ structuredQuery })
  });
  return body.filter((row) => row.document).map((row) => fromFirestoreDocument(row.document));
}

function deriveWorkspaceKey(team = {}) {
  const seed = String(team.secretSeed || team.secretSalt || team.id || '');
  if (!seed) throw new Error('This workspace cannot encrypt cloud secrets.');
  return crypto
    .createHash('sha256')
    .update(`deployerx-workspace-key-v2:${team.id || ''}:${seed}`)
    .digest();
}

function encryptWithKey(value, key) {
  if (!String(value || '')) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decryptWithKey(payload, key) {
  if (!payload?.data || !payload?.iv || !payload?.tag) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
}

function encryptJsonWithKey(value, key) {
  return encryptWithKey(JSON.stringify(value || {}), key);
}

function decryptJsonWithKey(payload, key) {
  const raw = decryptWithKey(payload, key);
  return raw ? JSON.parse(raw) : {};
}

const WORKSPACE_CONTROL_CLOUD_COLLECTION = 'workspaceControlRecords';
const workspaceControlSyncPromises = new Map();
const workspaceControlLastSyncAt = new Map();

function workspaceControlCloudDocument(type, record) {
  const projected = projectWorkspaceControlRecord(type, record);
  if (!projected || !cloudUnlock.key) return null;
  return {
    entityType: type,
    entityId: String(projected.id),
    revision: Math.max(1, Number(projected.revision) || 1),
    updatedAt: String(projected.updatedAt || projected.createdAt || nowIso()),
    deletedAt: projected.deletedAt || null,
    encryptedPayload: encryptJsonWithKey(projected, cloudUnlock.key),
    secretStorage: 'workspace-auth-v2'
  };
}

function workspaceControlCloudRecord(document) {
  if (!document?.encryptedPayload || !cloudUnlock.key || !SHARED_CONTROL_ENTITY_TYPES.includes(document.entityType)) return null;
  try {
    const record = decryptJsonWithKey(document.encryptedPayload, cloudUnlock.key);
    if (!record?.id || String(record.id) !== String(document.entityId || '')) return null;
    return { type: document.entityType, record };
  } catch {
    return null;
  }
}

function workspaceControlContextIsCurrent(workspaceId, settings) {
  return settings.mode === 'cloud' && String(settings.activeTeamId || '') === String(workspaceId || '');
}

async function writeWorkspaceControlRecord(workspaceId, type, record) {
  const projected = projectWorkspaceControlRecord(type, record);
  if (!projected) return null;
  const settings = await readSettings();
  if (!workspaceControlContextIsCurrent(workspaceId, settings)) return null;
  await ensureActiveTeamUnlocked();
  const documentId = workspaceControlDocumentId(type, projected.id);
  const target = ['teams', workspaceId, WORKSPACE_CONTROL_CLOUD_COLLECTION, documentId];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentDocument = await getDoc(target);
    const currentCloud = workspaceControlCloudRecord(currentDocument);
    if (currentCloud && (workspaceControlRecordsEquivalent(type, currentCloud.record, projected) || compareWorkspaceControlRecords(currentCloud.record, projected) > 0)) return currentDocument;
    try {
      return await patchDoc(target, workspaceControlCloudDocument(type, projected), {
        precondition: currentDocument?.__updateTime ? { updateTime: currentDocument.__updateTime } : { exists: false }
      });
    } catch (error) {
      if (![409, 412].includes(Number(error?.status)) || attempt === 2) throw error;
    }
  }
  return null;
}

async function syncWorkspaceControlChangesToCloud(changes = []) {
  const settings = await readSettings();
  const workspaceId = settings.mode === 'cloud' ? String(settings.activeTeamId || '') : '';
  if (!workspaceId) return;
  const sharedChanges = changes.filter(({ type, previous, record }) => (
    String(record?.workspaceId || '') === workspaceId && workspaceControlChangeIsShared(type, previous, record)
  ));
  if (!sharedChanges.length) return;
  await ensureActiveTeamUnlocked();
  for (const { type, record } of sharedChanges) await writeWorkspaceControlRecord(workspaceId, type, record);
  workspaceControlLastSyncAt.set(workspaceId, Date.now());
}

async function syncWorkspaceControlFromCloud(workspaceId, { force = false } = {}) {
  const tenant = String(workspaceId || '');
  if (!tenant || !backupControlDatabase) return;
  const settings = await readSettings();
  if (!workspaceControlContextIsCurrent(tenant, settings)) return;
  if (!force && Date.now() - Number(workspaceControlLastSyncAt.get(tenant) || 0) < 3000) return;
  if (workspaceControlSyncPromises.has(tenant)) return workspaceControlSyncPromises.get(tenant);
  const syncPromise = (async () => {
    await ensureActiveTeamUnlocked();
    const database = getBackupControlDatabase();
    const remoteItems = (await listCollection(['teams', tenant, WORKSPACE_CONTROL_CLOUD_COLLECTION]))
      .map(workspaceControlCloudRecord)
      .filter(Boolean);
    const remoteByKey = new Map(remoteItems.map(({ type, record }) => [`${type}:${record.id}`, record]));
    for (const type of SHARED_CONTROL_ENTITY_TYPES) {
      const localRecords = await database.repository(type).list(tenant, { includeDeleted: true, limit: 1000 });
      const localById = new Map(localRecords.map((record) => [String(record.id), record]));
      for (const { type: remoteType, record: remote } of remoteItems.filter((item) => item.type === type)) {
        const local = localById.get(String(remote.id));
        if (!local || (!workspaceControlRecordsEquivalent(type, remote, local) && compareWorkspaceControlRecords(remote, projectWorkspaceControlRecord(type, local)) > 0)) {
          await database.upsertSnapshot(remoteType, tenant, mergeWorkspaceControlRecord(type, local, remote));
        }
      }
      for (const local of localRecords) {
        const remote = remoteByKey.get(`${type}:${local.id}`);
        if (!remote || (!workspaceControlRecordsEquivalent(type, local, remote) && compareWorkspaceControlRecords(projectWorkspaceControlRecord(type, local), remote) > 0)) {
          await writeWorkspaceControlRecord(tenant, type, local);
        }
      }
    }
    workspaceControlLastSyncAt.set(tenant, Date.now());
  })().finally(() => workspaceControlSyncPromises.delete(tenant));
  workspaceControlSyncPromises.set(tenant, syncPromise);
  return syncPromise;
}

async function logWorkspaceControlSyncFailure(error, workspaceId = '') {
  return getBackupLogStore().logger({ workspaceId: workspaceId || 'local', component: 'workspace-control-sync' }).warn(
    'Workspace configuration synchronization remains pending.',
    { code: error?.code || 'WORKSPACE_CONTROL_SYNC_PENDING' }
  ).catch(() => {});
}

async function ensureActiveTeamUnlocked() {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') return null;
  if (!settings.activeTeamId) throw new Error('Select or create a workspace before syncing data.');
  if (cloudUnlock.teamId === settings.activeTeamId && cloudUnlock.key) return settings.activeTeamId;
  const auth = await requireAuthSession();
  const [team, member] = await Promise.all([
    getDoc(['teams', settings.activeTeamId]),
    getDoc(['teams', settings.activeTeamId, 'members', auth.uid])
  ]);
  if (!team || !member) throw new Error('You do not have access to this workspace.');
  cloudUnlock = { teamId: settings.activeTeamId, key: deriveWorkspaceKey(team) };
  return settings.activeTeamId;
}

async function readUserProfile(uid) {
  return (await getDoc(['users', uid])) || null;
}

async function writeUserProfile(auth, patch = {}) {
  const existing = (await readUserProfile(auth.uid)) || {};
  const profile = {
    ...existing,
    ...patch,
    uid: auth.uid,
    email: auth.email || existing.email || '',
    emailLower: emailKey(auth.email || existing.email),
    displayName: auth.displayName || existing.displayName || '',
    teams: Array.isArray(patch.teams) ? patch.teams : Array.isArray(existing.teams) ? existing.teams : [],
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso()
  };
  await patchDoc(['users', auth.uid], profile);
  return profile;
}

async function updateUserTeamRef(uid, teamRef) {
  const user = (await readUserProfile(uid)) || { uid, teams: [] };
  const teams = Array.isArray(user.teams) ? [...user.teams] : [];
  const index = teams.findIndex((item) => item.teamId === teamRef.teamId);
  if (index >= 0) teams[index] = { ...teams[index], ...teamRef };
  else teams.push(teamRef);
  await patchDoc(['users', uid], {
    ...user,
    teams,
    updatedAt: nowIso()
  });
}

async function removeUserTeamRef(uid, teamId) {
  const user = await readUserProfile(uid);
  if (!user) return;
  await patchDoc(['users', uid], {
    ...user,
    teams: (Array.isArray(user.teams) ? user.teams : []).filter((item) => item.teamId !== teamId),
    updatedAt: nowIso()
  });
}

async function currentMember(teamId) {
  const auth = await requireAuthSession();
  return getDoc(['teams', teamId, 'members', auth.uid]);
}

async function ensureTeamManager(teamId) {
  const member = await currentMember(teamId);
  if (member?.role !== 'owner') throw new Error('Only the workspace owner can manage members.');
  return member;
}

function prepareCloudProjectForSave(project) {
  const copy = JSON.parse(JSON.stringify(normalizeStoredProject(project) || {}));
  return {
    id: String(copy.id || ''),
    updatedAt: copy.updatedAt || nowIso(),
    encryptedPayload: encryptJsonWithKey(copy, cloudUnlock.key),
    secretStorage: 'workspace-auth-v2'
  };
}

function prepareCloudProjectForRead(project) {
  if (project?.encryptedPayload && cloudUnlock.key) {
    try {
      return normalizeStoredProject(decryptJsonWithKey(project.encryptedPayload, cloudUnlock.key));
    } catch {
      return normalizeStoredProject({ id: project.id, name: 'Encrypted project', commands: [] });
    }
  }

  const copy = JSON.parse(JSON.stringify(normalizeStoredProject(project) || {}));
  const ssh = { ...(copy.ssh || {}) };
  if (copy.encryptedSsh && cloudUnlock.key) {
    const defaultUser = Array.isArray(ssh.users)
      ? ssh.users.find((user) => user.id === ssh.defaultUserId) || ssh.users[0]
      : null;
    for (const field of ['password', 'privateKey', 'passphrase']) {
      try {
        ssh[field] = decryptWithKey(copy.encryptedSsh[field], cloudUnlock.key);
      } catch {
        ssh[field] = '';
      }
      if (defaultUser) defaultUser[field] = ssh[field];
    }
  }
  delete copy.encryptedSsh;
  delete copy.secretStorage;
  return {
    ...copy,
    ssh: normalizeProjectSsh(ssh)
  };
}

function prepareCloudTemplateForSave(template) {
  const normalized = normalizeStoredTemplate(template);
  return {
    id: String(normalized.id || ''),
    updatedAt: normalized.updatedAt || nowIso(),
    encryptedPayload: encryptJsonWithKey(normalized, cloudUnlock.key),
    secretStorage: 'workspace-auth-v2'
  };
}

function prepareCloudTemplateForRead(template) {
  if (template?.encryptedPayload && cloudUnlock.key) {
    try {
      return normalizeStoredTemplate(decryptJsonWithKey(template.encryptedPayload, cloudUnlock.key));
    } catch {
      return normalizeStoredTemplate({ id: template.id, name: 'Encrypted template', commands: [] });
    }
  }
  return normalizeStoredTemplate(template);
}

async function readCloudStore() {
  const teamId = await ensureActiveTeamUnlocked();
  const [projects, templates] = await Promise.all([
    listCollection(['teams', teamId, 'projects']),
    listCollection(['teams', teamId, 'templates'])
  ]);
  return {
    projects: projects.map(prepareCloudProjectForRead),
    templates: templates.map(prepareCloudTemplateForRead)
  };
}

async function writeCloudStore(data) {
  const teamId = await ensureActiveTeamUnlocked();
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const templates = stripBuiltInTemplates(Array.isArray(data.templates) ? data.templates : []);
  const existingProjects = await listCollection(['teams', teamId, 'projects']);
  const existingTemplates = await listCollection(['teams', teamId, 'templates']);
  const nextProjectIds = new Set(projects.map((project) => String(project.id)));
  const nextTemplateIds = new Set(templates.map((template) => String(template.id)));

  for (const project of existingProjects) {
    if (!nextProjectIds.has(String(project.id))) {
      await deleteDoc(['teams', teamId, 'projects', project.id]);
    }
  }
  for (const template of existingTemplates) {
    if (!nextTemplateIds.has(String(template.id))) {
      await deleteDoc(['teams', teamId, 'templates', template.id]);
    }
  }

  for (const project of projects) {
    await patchDoc(['teams', teamId, 'projects', project.id], prepareCloudProjectForSave(project));
  }
  for (const template of templates) {
    await patchDoc(['teams', teamId, 'templates', template.id], prepareCloudTemplateForSave(template));
  }
}

async function mergeLocalStoreIntoCloud(localData) {
  const teamId = await ensureActiveTeamUnlocked();
  const projects = Array.isArray(localData.projects) ? localData.projects : [];
  const templates = Array.isArray(localData.templates) ? localData.templates : [];

  for (const project of projects) {
    await patchDoc(['teams', teamId, 'projects', project.id], prepareCloudProjectForSave(project));
  }
  for (const template of templates) {
    await patchDoc(['teams', teamId, 'templates', template.id], prepareCloudTemplateForSave(template));
  }
}

async function readCurrentStore() {
  const settings = await readSettings();
  return settings.mode === 'cloud' ? readCloudStore() : readStore();
}

async function writeCurrentStore(data) {
  const settings = await readSettings();
  if (settings.mode === 'cloud') return writeCloudStore(data);
  return writeStore(data);
}

function normalizeMcpIntegration(config = {}) {
  return {
    enabled: config.enabled !== false,
    port: Math.min(65535, Math.max(1024, Math.round(Number(config.port) || 43821))),
    tokenEncrypted: String(config.tokenEncrypted || ''),
    lastError: String(config.lastError || ''),
    updatedAt: String(config.updatedAt || '')
  };
}

function buildMcpAutostartArgs() {
  if (process.defaultApp || !app.isPackaged) return [app.getAppPath(), MCP_AUTOSTART_ARGUMENT];
  return [MCP_AUTOSTART_ARGUMENT];
}

function mcpLinuxAutostartEntry() {
  const quote = (value) => `"${String(value || '').replace(/"/g, '\\"')}"`;
  const launch = [quote(process.execPath), ...buildMcpAutostartArgs().map(quote)].join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=DeployerX MCP',
    'Comment=Keep the DeployerX MCP server available after sign-in',
    `Exec=${launch}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true'
  ].join('\n');
}

async function setMcpAutostartEnabled(enabled) {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings(buildLoginItemSettings({
      enabled,
      execPath: process.execPath,
      args: buildMcpAutostartArgs()
    }));
    return Boolean(app.getLoginItemSettings().openAtLogin);
  }
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const autostartPath = path.join(autostartDir, 'deployerx-mcp.desktop');
  if (!enabled) {
    await fs.rm(autostartPath, { force: true });
    return false;
  }
  await fs.mkdir(autostartDir, { recursive: true });
  await fs.writeFile(autostartPath, `${mcpLinuxAutostartEntry()}\n`, 'utf8');
  return true;
}

async function enableMcpAutostartForConnectedClients() {
  const clients = await listMcpClients();
  if (!clients.some((client) => client.connected)) return false;
  return setMcpAutostartEnabled(true);
}

function encryptMcpToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this device.');
  return safeStorage.encryptString(String(token)).toString('base64');
}

function decryptMcpToken(tokenEncrypted) {
  if (!tokenEncrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this device.');
  return safeStorage.decryptString(Buffer.from(tokenEncrypted, 'base64'));
}

function mcpTokenErrorMessage(error) {
  const message = String(error?.message || error || '');
  if (/decrypt|string.*ciphertext|ciphertext.*decrypt/i.test(message)) {
    return 'The saved MCP credential could not be unlocked on this device. Rotate the token to create a new credential.';
  }
  return message || 'The MCP credential could not be read.';
}

function createMcpToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function writeEncryptedMcpToken(tokenEncrypted) {
  const tokenPath = getMcpTokenPath();
  const temporaryPath = `${tokenPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, String(tokenEncrypted), { mode: 0o600 });
    await fs.rename(temporaryPath, tokenPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function persistMcpToken(token) {
  const tokenEncrypted = encryptMcpToken(token);
  await writeEncryptedMcpToken(tokenEncrypted);
  return tokenEncrypted;
}

async function readPersistedMcpToken(config = {}) {
  let fileTokenEncrypted = '';
  try {
    fileTokenEncrypted = String(await fs.readFile(getMcpTokenPath(), 'utf8')).trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const settingsTokenEncrypted = String(config.tokenEncrypted || '');
  const candidates = [...new Set([fileTokenEncrypted, settingsTokenEncrypted].filter(Boolean))];
  let lastError;
  for (const tokenEncrypted of candidates) {
    try {
      const token = decryptMcpToken(tokenEncrypted);
      if (!fileTokenEncrypted || tokenEncrypted !== fileTokenEncrypted) {
        await writeEncryptedMcpToken(tokenEncrypted);
      }
      return { token, tokenEncrypted };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { token: '', tokenEncrypted: '' };
}

async function readOrCreatePersistedMcpToken(config = {}) {
  try {
    const persisted = await readPersistedMcpToken(config);
    if (persisted.token) return { ...persisted, recovered: false };
  } catch (error) {
    const recoveredToken = await readMcpClientToken().catch(() => '');
    if (recoveredToken) {
      const tokenEncrypted = await persistMcpToken(recoveredToken);
      await writeMcpIntegrationSettings(normalizeMcpIntegration({ ...config, tokenEncrypted, lastError: '', updatedAt: nowIso() }));
      return { token: recoveredToken, tokenEncrypted, recovered: true };
    }
    throw error;
  }
  return createAndPersistMcpToken(config);
}

async function createAndPersistMcpToken(config = {}) {
  const token = createMcpToken();
  const tokenEncrypted = await persistMcpToken(token);
  await writeMcpIntegrationSettings(normalizeMcpIntegration({ ...config, tokenEncrypted, lastError: '', updatedAt: nowIso() }));
  return { token, tokenEncrypted, recovered: true };
}

const UPTIME_CLOUD_COLLECTIONS = Object.freeze({
  monitors: 'uptimeMonitors',
  checks: 'uptimeCheckWindows',
  incidents: 'uptimeIncidents',
  maintenance: 'uptimeMaintenance'
});
const uptimeCloudSyncPromises = new Map();
const uptimeCloudLastSyncAt = new Map();
const UPTIME_CLOUD_SYNC_INTERVAL_MS = 30000;

function uptimeCloudRecordForSave(record, documentId = record?.id) {
  const id = String(documentId || '').trim();
  if (!id || !cloudUnlock.key) throw new Error('The Uptime Monitor workspace is not unlocked.');
  return {
    id,
    revision: Math.max(1, Number(record?.revision) || 1),
    updatedAt: String(record?.updatedAt || record?.completedAt || nowIso()),
    deletedAt: record?.deletedAt || null,
    encryptedPayload: encryptJsonWithKey(record, cloudUnlock.key),
    secretStorage: 'workspace-auth-v2'
  };
}

function uptimeWorkspaceContextIsCurrent(context, settings) {
  const expectedWorkspaceId = settings.mode === 'cloud' ? String(settings.activeTeamId || '') : 'local';
  return String(context?.workspaceId || '') === expectedWorkspaceId;
}

function uptimeCloudRecordForRead(document) {
  if (!document?.encryptedPayload || !cloudUnlock.key) return null;
  try {
    const record = decryptJsonWithKey(document.encryptedPayload, cloudUnlock.key);
    const documentId = firestoreDocumentId(document);
    if (!record?.id || (document.id && String(document.id) !== String(documentId))) return null;
    return record;
  } catch {
    return null;
  }
}

function uptimeRecordTimestamp(record) {
  return Date.parse(record?.updatedAt || record?.completedAt || record?.createdAt || '') || 0;
}

function compareUptimeRecords(left, right) {
  const timeDifference = uptimeRecordTimestamp(left) - uptimeRecordTimestamp(right);
  if (timeDifference) return timeDifference;
  return (Number(left?.revision) || 0) - (Number(right?.revision) || 0);
}

function uptimeCheckWindowId(monitorId, probeId, hour) {
  const suffix = crypto.createHash('sha256').update(`${String(probeId || 'local-windows')}:${hour}`).digest('hex').slice(0, 24);
  return `${String(monitorId || '').slice(0, 160)}_${suffix}`;
}

function compactUptimeCheck(check) {
  return {
    id: check.id,
    monitorId: check.monitorId,
    probeId: check.probeId,
    scheduledAt: check.scheduledAt,
    startedAt: check.startedAt,
    completedAt: check.completedAt,
    outcome: check.outcome,
    latencyMs: check.latencyMs,
    statusCode: check.statusCode,
    failureCategory: check.failureCategory || '',
    summary: check.summary || '',
    details: {}
  };
}

function uptimeCheckWindows(monitorId, probeId, checks = []) {
  const selected = checks
    .filter((check) => String(check.monitorId) === String(monitorId) && String(check.probeId) === String(probeId))
    .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
  const grouped = new Map();
  for (const check of selected) {
    const hour = String(check.completedAt || '').slice(0, 13);
    if (!hour) continue;
    if (!grouped.has(hour)) grouped.set(hour, []);
    grouped.get(hour).push(compactUptimeCheck(check));
  }
  return [...grouped.entries()].map(([hour, windowChecks]) => ({
    id: uptimeCheckWindowId(monitorId, probeId, hour),
    monitorId: String(monitorId),
    probeId: String(probeId),
    hour,
    revision: windowChecks.length,
    updatedAt: windowChecks.at(-1).completedAt,
    checks: windowChecks
  }));
}

async function writeUptimeCloudRecord(context, collection, record, documentId = record?.id) {
  if (!record) return null;
  const settings = await readSettings();
  if (settings.mode !== 'cloud') return null;
  if (!uptimeWorkspaceContextIsCurrent(context, settings)) {
    throw Object.assign(new Error('The Uptime Monitor workspace changed. Refreshing the worker is required.'), { code: 'UPTIME_WORKSPACE_CHANGED' });
  }
  await ensureActiveTeamUnlocked();
  const id = String(documentId || '').trim();
  const pathSegments = ['teams', context.workspaceId, collection, id];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentDocument = await getDoc(pathSegments);
    const currentRecord = uptimeCloudRecordForRead(currentDocument);
    if (currentRecord && compareUptimeRecords(currentRecord, record) > 0) return currentDocument;
    try {
      return await patchDoc(
        pathSegments,
        uptimeCloudRecordForSave(record, id),
        { precondition: currentDocument?.__updateTime ? { updateTime: currentDocument.__updateTime } : { exists: false } }
      );
    } catch (error) {
      if (![409, 412].includes(Number(error?.status)) || attempt === 2) throw error;
    }
  }
  return null;
}

async function syncUptimeTransitionToCloud(context, transition = {}) {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') return;
  const writes = [];
  if (transition.monitor) writes.push(writeUptimeCloudRecord(context, UPTIME_CLOUD_COLLECTIONS.monitors, transition.monitor));
  if (transition.check) {
    const database = getUptimeControlDatabaseV2();
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const checks = await database.listChecks(context.workspaceId, transition.check.monitorId, { from, limit: 100000 });
    const windows = uptimeCheckWindows(transition.check.monitorId, transition.check.probeId, checks);
    const currentWindow = windows.find((window) => window.hour === String(transition.check.completedAt || '').slice(0, 13));
    if (currentWindow) writes.push(writeUptimeCloudRecord(context, UPTIME_CLOUD_COLLECTIONS.checks, currentWindow));
  }
  if (transition.incident) writes.push(writeUptimeCloudRecord(context, UPTIME_CLOUD_COLLECTIONS.incidents, transition.incident));
  if (transition.maintenance) writes.push(writeUptimeCloudRecord(context, UPTIME_CLOUD_COLLECTIONS.maintenance, transition.maintenance));
  await Promise.all(writes);
}

async function syncUptimeWorkspaceFromCloud(context, { force = false } = {}) {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') return;
  if (!uptimeWorkspaceContextIsCurrent(context, settings)) return;
  if (!force && Date.now() - Number(uptimeCloudLastSyncAt.get(context.workspaceId) || 0) < UPTIME_CLOUD_SYNC_INTERVAL_MS) return;
  if (uptimeCloudSyncPromises.has(context.workspaceId)) return uptimeCloudSyncPromises.get(context.workspaceId);
  uptimeCloudLastSyncAt.set(context.workspaceId, Date.now());
  const syncPromise = (async () => {
    await ensureActiveTeamUnlocked();
    const database = getUptimeControlDatabaseV2();
    const collectionEntries = Object.entries(UPTIME_CLOUD_COLLECTIONS);
    const remoteDocuments = Object.fromEntries(await Promise.all(collectionEntries.map(async ([kind, collection]) => [
      kind,
      (await listCollection(['teams', context.workspaceId, collection])).map(uptimeCloudRecordForRead).filter(Boolean)
    ])));
    const expiredCheckWindowCutoff = Date.now() - 26 * 60 * 60 * 1000;
    for (const window of remoteDocuments.checks.filter((item) => uptimeRecordTimestamp(item) < expiredCheckWindowCutoff)) {
      await deleteDoc(['teams', context.workspaceId, UPTIME_CLOUD_COLLECTIONS.checks, String(window.id)]);
    }
    remoteDocuments.checks = remoteDocuments.checks.filter((item) => uptimeRecordTimestamp(item) >= expiredCheckWindowCutoff);

    const localMonitors = await database.listMonitors(context.workspaceId, { includeDeleted: true, limit: 10000 });
    const localMonitorMap = new Map(localMonitors.map((monitor) => [String(monitor.id), monitor]));
    const remoteMonitorMap = new Map(remoteDocuments.monitors.map((monitor) => [String(monitor.id), monitor]));
    for (const remote of remoteDocuments.monitors) {
      const local = localMonitorMap.get(String(remote.id));
      if (!local || compareUptimeRecords(remote, local) > 0) {
        await database.upsertMonitorSnapshot(context.workspaceId, remote);
        localMonitorMap.set(String(remote.id), remote);
      }
    }
    for (const local of localMonitors) {
      const remote = remoteMonitorMap.get(String(local.id));
      if (!remote || compareUptimeRecords(local, remote) > 0) {
        await writeUptimeCloudRecord(context, UPTIME_CLOUD_COLLECTIONS.monitors, local);
      }
    }

    for (const window of remoteDocuments.checks) {
      if (!localMonitorMap.has(String(window.monitorId))) continue;
      for (const check of Array.isArray(window.checks) ? window.checks : []) {
        await database.upsertCheckSnapshot(context.workspaceId, check);
      }
    }
    const remoteCheckWindowMap = new Map(remoteDocuments.checks.map((window) => [String(window.id), window]));
    const checkRangeStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const monitor of await database.listMonitors(context.workspaceId, { includeDeleted: true, limit: 10000 })) {
      const checks = await database.listChecks(context.workspaceId, monitor.id, { from: checkRangeStart, limit: 100000 });
      const probeIds = [...new Set(checks.map((check) => String(check.probeId)).filter(Boolean))];
      for (const probeId of probeIds) {
        for (const window of uptimeCheckWindows(monitor.id, probeId, checks)) {
          const remote = remoteCheckWindowMap.get(String(window.id));
          if (!remote || compareUptimeRecords(window, remote) > 0) {
            await writeUptimeCloudRecord(context, UPTIME_CLOUD_COLLECTIONS.checks, window);
          }
        }
      }
    }

    const localIncidents = await database.listIncidents(context.workspaceId, { limit: 10000 });
    const localIncidentMap = new Map(localIncidents.map((incident) => [String(incident.id), incident]));
    const remoteIncidentMap = new Map(remoteDocuments.incidents.map((incident) => [String(incident.id), incident]));
    for (const remote of remoteDocuments.incidents) {
      const local = localIncidentMap.get(String(remote.id));
      if (!local || compareUptimeRecords(remote, local) > 0) await database.upsertIncidentSnapshot(context.workspaceId, remote);
    }
    for (const local of localIncidents) {
      const remote = remoteIncidentMap.get(String(local.id));
      if (!remote || compareUptimeRecords(local, remote) > 0) {
        await writeUptimeCloudRecord(context, UPTIME_CLOUD_COLLECTIONS.incidents, local);
      }
    }

    const localMaintenance = await database.listMaintenanceWindows(context.workspaceId, { includeDeleted: true, limit: 10000 });
    const localMaintenanceMap = new Map(localMaintenance.map((window) => [String(window.id), window]));
    const remoteMaintenanceMap = new Map(remoteDocuments.maintenance.map((window) => [String(window.id), window]));
    for (const remote of remoteDocuments.maintenance) {
      const local = localMaintenanceMap.get(String(remote.id));
      if (!local || compareUptimeRecords(remote, local) > 0) await database.upsertMaintenanceSnapshot(context.workspaceId, remote);
    }
    for (const local of localMaintenance) {
      const remote = remoteMaintenanceMap.get(String(local.id));
      if (!remote || compareUptimeRecords(local, remote) > 0) {
        await writeUptimeCloudRecord(context, UPTIME_CLOUD_COLLECTIONS.maintenance, local);
      }
    }
  })().finally(() => uptimeCloudSyncPromises.delete(context.workspaceId));
  uptimeCloudSyncPromises.set(context.workspaceId, syncPromise);
  return syncPromise;
}

function setUptimeCloudSyncWarning(error) {
  uptimeWorkerState.syncWarning = `Workspace uptime synchronization is pending: ${String(error?.message || error || 'Cloud service unavailable.').slice(0, 500)}`;
}

function clearUptimeCloudSyncWarning() {
  if (String(uptimeWorkerState.syncWarning || '').startsWith('Workspace uptime synchronization is pending:')) {
    uptimeWorkerState.syncWarning = '';
  }
}

async function syncUptimeWorkspaceBestEffort(context, options = {}) {
  try {
    await syncUptimeWorkspaceFromCloud(context, options);
    clearUptimeCloudSyncWarning();
    return true;
  } catch (error) {
    setUptimeCloudSyncWarning(error);
    return false;
  }
}

async function syncUptimeTransitionBestEffort(context, transition = {}) {
  try {
    await syncUptimeTransitionToCloud(context, transition);
    clearUptimeCloudSyncWarning();
    return true;
  } catch (error) {
    setUptimeCloudSyncWarning(error);
    return false;
  }
}

function queueUptimeWorkspaceSync(context, options = {}) {
  setImmediate(() => syncUptimeWorkspaceBestEffort(context, options).catch(() => {}));
}

function queueUptimeTransitionSync(context, transition = {}, { wait = false } = {}) {
  const sync = () => syncUptimeTransitionBestEffort(context, transition);
  if (wait) return sync();
  setImmediate(() => sync().catch(() => {}));
  return null;
}

async function listUptimeMonitorsOperation(options = {}) {
  const context = await uptimeOperationalContext();
  queueUptimeWorkspaceSync(context);
  await syncUptimeWorkspaceBestEffort(context);
  return getUptimeControlDatabaseV2().listMonitors(context.workspaceId, options);
}

async function getUptimeMonitorOperation(payload = {}) {
  const context = await uptimeOperationalContext();
  queueUptimeWorkspaceSync(context);
  await syncUptimeWorkspaceBestEffort(context);
  return getUptimeControlDatabaseV2().getMonitor(context.workspaceId, payload.id, { includeDeleted: payload.includeDeleted === true });
}

async function createUptimeMonitorOperation(input = {}) {
  const context = await uptimeOperationalContext();
  const prepared = await prepareUptimeMonitorForSave(context, input);
  let monitor;
  try {
    if (!Object.prototype.hasOwnProperty.call(prepared.payload, 'nextCheckAt')) {
      const disabled = ['paused', 'disabled'].includes(String(prepared.payload.state || '').toLowerCase());
      prepared.payload.nextCheckAt = disabled
        ? null
        : new Date(Date.now() + Number(prepared.payload.timeoutMs || 10000) + 5000).toISOString();
    }
    monitor = await getUptimeControlDatabaseV2().createMonitor(context.workspaceId, context.actorId, prepared.payload);
  } catch (error) {
    await cleanupUptimeSecretReferences(context, prepared.createdSecretRefIds);
    throw error;
  }
  let transition = null;
  if (monitor.state === 'enabled') {
    transition = await executeUptimeMonitorCheck({
      controlDatabase: getUptimeControlDatabaseV2(),
      incidentPolicy: uptimeIncidentPolicyService,
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      monitor,
      secretResolver: (secretRefId) => getBackupSecretStore().resolve({ workspaceId: context.workspaceId, id: secretRefId }),
      probeId: `local-windows:${backupDeviceId || process.pid}`,
      scheduledAt: nowIso()
    });
    monitor = transition.monitor;
  }
  await queueUptimeTransitionSync(context, transition || { monitor }, { wait: true });
  emitUptimeEvent('uptime:monitor-created', { monitorId: monitor.id });
  await maybeStartDetachedUptimeWorker().catch(() => {});
  return monitor;
}

async function updateUptimeMonitorOperation(input = {}) {
  const context = await uptimeOperationalContext();
  const database = getUptimeControlDatabaseV2();
  const current = await database.getMonitor(context.workspaceId, input.id);
  if (!current) throw Object.assign(new Error('Monitor was not found.'), { code: 'UPTIME_MONITOR_NOT_FOUND' });
  const prepared = await prepareUptimeMonitorForSave(context, input, current);
  try {
    const monitor = await database.updateMonitor(context.workspaceId, context.actorId, current.id, prepared.payload, input.revision);
    const previousRefs = Object.values(current.config?.secretHeaderRefs || {});
    const currentRefs = new Set(Object.values(monitor.config?.secretHeaderRefs || {}).map(String));
    await cleanupUptimeSecretReferences(context, previousRefs.filter((id) => !currentRefs.has(String(id))));
    if (monitor.state === 'enabled') await maybeStartDetachedUptimeWorker().catch(() => {});
    await queueUptimeTransitionSync(context, { monitor }, { wait: true });
    emitUptimeEvent('uptime:monitor-updated-v2', { monitorId: monitor.id });
    return monitor;
  } catch (error) {
    await cleanupUptimeSecretReferences(context, prepared.createdSecretRefIds);
    throw error;
  }
}

async function deleteUptimeMonitorOperation(payload = {}) {
  const context = await uptimeOperationalContext();
  const database = getUptimeControlDatabaseV2();
  const current = await database.getMonitor(context.workspaceId, payload.id);
  if (!current) return { id: String(payload.id || ''), deleted: false, absent: true };
  const result = await database.deleteMonitor(context.workspaceId, context.actorId, current.id, payload.revision);
  if (result.deleted) {
    const deletedMonitor = await database.getMonitor(context.workspaceId, current.id, { includeDeleted: true });
    await queueUptimeTransitionSync(context, { monitor: deletedMonitor }, { wait: true });
    await cleanupUptimeSecretReferences(context, Object.values(current.config?.secretHeaderRefs || {}));
    emitUptimeEvent('uptime:monitor-deleted-v2', { monitorId: current.id });
  }
  return result;
}

async function testUptimeMonitorOperation(input = {}) {
  const context = await uptimeOperationalContext();
  const current = input.id ? await getUptimeControlDatabaseV2().getMonitor(context.workspaceId, input.id) : null;
  const prepared = prepareUptimeMonitorForTest(context, input, current);
  return runMonitorCheck(prepared.monitor, { secretResolver: prepared.secretResolver });
}

async function runUptimeMonitorNowOperation(payload = {}) {
  const context = await uptimeOperationalContext();
  const database = getUptimeControlDatabaseV2();
  const monitor = await database.getMonitor(context.workspaceId, payload.id);
  if (!monitor) throw Object.assign(new Error('Monitor was not found.'), { code: 'UPTIME_MONITOR_NOT_FOUND' });
  if (monitor.state !== 'enabled') throw Object.assign(new Error('Enable the monitor before running it.'), { code: 'UPTIME_MONITOR_NOT_ENABLED' });
  const scheduledAt = nowIso();
  const leased = await database.updateMonitor(context.workspaceId, context.actorId, monitor.id, {
    nextCheckAt: new Date(Date.now() + Number(monitor.timeoutMs || 10000) + 5000).toISOString()
  }, monitor.revision);
  const transition = await executeUptimeMonitorCheck({
    controlDatabase: database,
    incidentPolicy: uptimeIncidentPolicyService,
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    monitor: leased,
    secretResolver: (secretRefId) => getBackupSecretStore().resolve({ workspaceId: context.workspaceId, id: secretRefId }),
    probeId: `local-windows:${backupDeviceId || process.pid}`,
    scheduledAt
  });
  await queueUptimeTransitionSync(context, transition, { wait: true });
  await maybeStartDetachedUptimeWorker().catch(() => {});
  emitUptimeEvent('uptime:monitor-run-completed-v2', { monitorId: monitor.id });
  return { queued: false, completed: true, monitorId: monitor.id, revision: transition.monitor.revision };
}

async function acknowledgeUptimeIncidentOperation(payload = {}) {
  const context = await uptimeOperationalContext();
  if (!uptimeIncidentPolicyService) throw new Error('Uptime incident policy is not initialized.');
  const incident = await uptimeIncidentPolicyService.acknowledge(context.workspaceId, context.actorId, payload.id, payload.revision, payload.note);
  if (!incident) throw Object.assign(new Error('Incident was not found.'), { code: 'UPTIME_INCIDENT_NOT_FOUND' });
  await queueUptimeTransitionSync(context, { incident }, { wait: true });
  emitUptimeEvent('uptime:incident-acknowledged-v2', { monitorId: incident.monitorId, incidentId: incident.id });
  return incident;
}

async function createUptimeMaintenanceOperation(input = {}) {
  const context = await uptimeOperationalContext();
  const maintenance = await getUptimeControlDatabaseV2().createMaintenanceWindow(context.workspaceId, context.actorId, input);
  await queueUptimeTransitionSync(context, { maintenance }, { wait: true });
  emitUptimeEvent('uptime:maintenance-created', { maintenanceId: maintenance.id });
  return maintenance;
}

async function updateUptimeMaintenanceOperation(input = {}) {
  const context = await uptimeOperationalContext();
  const maintenance = await getUptimeControlDatabaseV2().updateMaintenanceWindow(context.workspaceId, context.actorId, input.id, input, input.revision);
  if (!maintenance) throw Object.assign(new Error('Maintenance window was not found.'), { code: 'UPTIME_MAINTENANCE_NOT_FOUND' });
  await queueUptimeTransitionSync(context, { maintenance }, { wait: true });
  emitUptimeEvent('uptime:maintenance-updated', { maintenanceId: maintenance.id });
  return maintenance;
}

async function deleteUptimeMaintenanceOperation(payload = {}) {
  const context = await uptimeOperationalContext();
  const database = getUptimeControlDatabaseV2();
  const result = await database.deleteMaintenanceWindow(context.workspaceId, context.actorId, payload.id, payload.revision);
  if (result.deleted) {
    const maintenance = (await database.listMaintenanceWindows(context.workspaceId, { includeDeleted: true, limit: 10000 }))
      .find((window) => String(window.id) === String(result.id));
    await queueUptimeTransitionSync(context, { maintenance }, { wait: true });
  }
  if (result.deleted) emitUptimeEvent('uptime:maintenance-deleted', { maintenanceId: result.id });
  return result;
}

async function getUptimeStatusOperation() {
  const context = await uptimeOperationalContext();
  queueUptimeWorkspaceSync(context);
  await syncUptimeWorkspaceBestEffort(context);
  const database = getUptimeControlDatabaseV2();
  const checkedAt = nowIso();
  const [worker, monitors, incidents, activeMaintenance] = await Promise.all([
    getUptimeServiceStatusV2(),
    database.listMonitors(context.workspaceId, { limit: 10000 }),
    database.listIncidents(context.workspaceId, { limit: 10000 }),
    database.listMaintenanceWindows(context.workspaceId, { activeAt: checkedAt, limit: 10000 })
  ]);
  const activeIncidents = incidents.filter((incident) => incident.state !== 'resolved');
  const statusCounts = monitors.reduce((counts, monitor) => {
    const status = String(monitor.runtime?.status || monitor.state || 'unknown');
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  return {
    checkedAt,
    worker,
    summary: { monitorCount: monitors.length, statusCounts, activeIncidentCount: activeIncidents.length, activeMaintenanceCount: activeMaintenance.length },
    monitors,
    activeIncidents,
    activeMaintenance
  };
}

async function writeMcpIntegrationSettings(config) {
  const latestSettings = await readSettings();
  const normalized = normalizeMcpIntegration(config);
  await writeSettings({ ...latestSettings, mcpIntegration: normalized });
  return normalized;
}

function ensureMcpServer() {
  if (!mcpServer) {
    mcpServer = new DeployerXMcpServer({
      getProjects: async () => {
        const data = await readCurrentStore();
        return data.projects || [];
      },
      sshOperations: {
        execute: executeManagedMcpSshCommand
      },
      uptimeOperations: {
        getStatus: getUptimeStatusOperation,
        listMonitors: listUptimeMonitorsOperation,
        getMonitor: getUptimeMonitorOperation,
        createMonitor: createUptimeMonitorOperation,
        updateMonitor: updateUptimeMonitorOperation,
        deleteMonitor: deleteUptimeMonitorOperation,
        testMonitor: testUptimeMonitorOperation,
        runMonitorNow: runUptimeMonitorNowOperation,
        listChecks: async (payload = {}) => {
          const context = await uptimeOperationalContext();
          return getUptimeControlDatabaseV2().listChecks(context.workspaceId, payload.monitorId, payload);
        },
        listIncidents: async (options = {}) => {
          const context = await uptimeOperationalContext();
          return getUptimeControlDatabaseV2().listIncidents(context.workspaceId, options);
        },
        acknowledgeIncident: acknowledgeUptimeIncidentOperation,
        listMaintenance: async (options = {}) => {
          const context = await uptimeOperationalContext();
          return getUptimeControlDatabaseV2().listMaintenanceWindows(context.workspaceId, options);
        },
        createMaintenance: createUptimeMaintenanceOperation,
        updateMaintenance: updateUptimeMaintenanceOperation,
        deleteMaintenance: deleteUptimeMaintenanceOperation,
        getWorkerStatus: getUptimeServiceStatusV2,
        getSettings: getUptimeMonitoringSettings,
        updateSettings: updateUptimeMonitoringSettings,
        getReport: buildWorkspaceUptimeReport
      }
    });
  }
  return mcpServer;
}

function isMcpAddressInUseError(error) {
  return error?.code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(String(error?.message || error || ''));
}

async function startMcpServerWithPortFallback(preferredPort, token) {
  const normalizedPort = Math.min(65535, Math.max(1024, Math.round(Number(preferredPort) || 43821)));
  let lastError;
  for (let offset = 0; offset < 32; offset += 1) {
    const port = 1024 + ((normalizedPort - 1024 + offset) % (65535 - 1024 + 1));
    try {
      await ensureMcpServer().start({ port, token });
      return port;
    } catch (error) {
      if (!isMcpAddressInUseError(error)) throw error;
      lastError = error;
    }
  }
  throw new Error(`No available local port was found near ${normalizedPort}. ${lastError?.message || ''}`.trim());
}

async function publicMcpIntegration(config = null) {
  const normalized = normalizeMcpIntegration(config || {});
  const runtime = ensureMcpServer().status();
  const running = runtime.external ? await ensureMcpServer().isReachable() : runtime.running;
  let token = '';
  let serverCount = 0;
  try {
    ({ token } = await readPersistedMcpToken(normalized));
  } catch (error) {
    normalized.lastError = mcpTokenErrorMessage(error);
  }
  try {
    const data = await readCurrentStore();
    serverCount = (data.projects || []).filter((project) => !['vnc', 'rdp'].includes(project?.serverType) && project?.ssh?.host).length;
  } catch {
    serverCount = 0;
  }
  return {
    configured: Boolean(normalized.tokenEncrypted),
    enabled: normalized.enabled,
    running,
    port: normalized.port,
    url: `http://127.0.0.1:${normalized.port}/mcp`,
    token,
    serverCount,
    tools: ensureMcpServer().tools(),
    clients: await listMcpClientsForRenderer(),
    lastError: runtime.lastError || normalized.lastError,
    updatedAt: normalized.updatedAt
  };
}

async function startMcpIntegration(payload = {}) {
  if (mcpRestorePromise) await mcpRestorePromise.catch(() => {});
  if (mcpRestartTimer) clearTimeout(mcpRestartTimer);
  mcpRestartTimer = null;
  const settings = await readSettings();
  const current = normalizeMcpIntegration(settings.mcpIntegration || {});
  const port = Math.min(65535, Math.max(1024, Math.round(Number(payload.port) || current.port || 43821)));
  const persisted = await readOrCreatePersistedMcpToken(current);
  const token = persisted.token || createMcpToken();
  const tokenEncrypted = persisted.tokenEncrypted || await persistMcpToken(token);
  const next = normalizeMcpIntegration({
    ...current,
    enabled: true,
    port,
    tokenEncrypted,
    lastError: '',
    updatedAt: nowIso()
  });
  await writeMcpIntegrationSettings(next);
  await enableMcpAutostartForConnectedClients().catch(() => {});
  try {
    const actualPort = await startMcpServerWithPortFallback(port, token);
    if (actualPort !== next.port) {
      next.port = actualPort;
      await writeMcpIntegrationSettings(next);
    }
    await refreshConnectedMcpClientConfigurations(actualPort, token);
  } catch (error) {
    const failed = { ...next, lastError: String(error?.message || error), updatedAt: nowIso() };
    await writeMcpIntegrationSettings(failed);
    scheduleMcpRestoreRetry();
    throw new Error(`Could not start the DeployerX MCP server: ${error?.message || error}`);
  }
  return publicMcpIntegration(next);
}

async function listMcpClientsForRenderer() {
  if (mcpClientRendererCache) return mcpClientRendererCache;
  mcpClientRendererCache = Promise.resolve().then(async () => {
    const clients = await listMcpClients();
    return Promise.all(clients.map(async ({ configPath, iconPath, format, installed, ...client }) => {
      let icon = client.id === 'codex'
        ? CODEX_ICON_DATA_URL
        : client.id === 'opencode'
        ? 'assets/agent-logos/opencode.svg'
        : client.id.startsWith('claude') ? 'assets/agent-logos/claude-code.svg' : '';
      if (iconPath && !icon) {
        try {
          const image = ['.png', '.jpg', '.jpeg', '.ico'].includes(path.extname(iconPath).toLowerCase())
            ? nativeImage.createFromPath(iconPath)
            : await app.getFileIcon(iconPath, { size: 'normal' });
          if (image && !image.isEmpty()) icon = image.toDataURL();
        } catch { /* Keep the bundled fallback logo when file icon extraction fails. */ }
      }
      return { ...client, icon };
    }));
  }).catch((error) => {
    mcpClientRendererCache = null;
    throw error;
  });
  return mcpClientRendererCache;
}

async function refreshConnectedMcpClientConfigurations(port, token) {
  const clients = await listMcpClients();
  const url = `http://127.0.0.1:${port}/mcp`;
  await Promise.all(
    clients
      .filter((client) => client.connected)
      .map((client) => connectMcpClient(client.id, { url, token }).catch(() => {}))
  );
  mcpClientRendererCache = null;
}

async function rotateMcpToken() {
  if (mcpRestorePromise) await mcpRestorePromise.catch(() => {});
  const settings = await readSettings();
  const current = normalizeMcpIntegration(settings.mcpIntegration || {});
  const token = createMcpToken();
  const tokenEncrypted = await persistMcpToken(token);
  const next = normalizeMcpIntegration({
    ...current,
    enabled: true,
    tokenEncrypted,
    lastError: '',
    updatedAt: nowIso()
  });
  await writeMcpIntegrationSettings(next);
  await enableMcpAutostartForConnectedClients().catch(() => {});
  try {
    next.port = await startMcpServerWithPortFallback(next.port, token);
    await refreshConnectedMcpClientConfigurations(next.port, token);
    await writeMcpIntegrationSettings(next);
  } catch (error) {
    const failed = { ...next, lastError: String(error?.message || error), updatedAt: nowIso() };
    await writeMcpIntegrationSettings(failed);
    scheduleMcpRestoreRetry();
    throw new Error(`The token was rotated, but the MCP server could not restart: ${error?.message || error}`);
  }
  return publicMcpIntegration(next);
}

async function testMcpIntegration() {
  const settings = await readSettings();
  const config = normalizeMcpIntegration(settings.mcpIntegration || {});
  if (!config.enabled) throw new Error('DeployerX MCP is disconnected. Connect an agent to start it again.');
  const persisted = await readOrCreatePersistedMcpToken(config);
  const server = ensureMcpServer();
  const reachable = server.status().external ? await server.isReachable() : server.status().running;
  if (persisted.recovered || !reachable) {
    const actualPort = await startMcpServerWithPortFallback(config.port, persisted.token);
    await refreshConnectedMcpClientConfigurations(actualPort, persisted.token);
    if (actualPort !== config.port) {
      config.port = actualPort;
      await writeMcpIntegrationSettings({ ...config, tokenEncrypted: persisted.tokenEncrypted, lastError: '', updatedAt: nowIso() });
    }
  }
  const { token } = persisted;
  const ready = server.status().external ? await server.isReachable() : server.status().running;
  if (!token || !ready) throw new Error('The DeployerX MCP server is still starting. Try again shortly.');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'deployerx-test', method: 'tools/list' });
  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: config.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 5000
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    request.on('timeout', () => request.destroy(new Error('MCP connection test timed out.')));
    request.on('error', reject);
    request.end(body);
  });
  const parsed = JSON.parse(result.body || '{}');
  if (result.statusCode !== 200 || !Array.isArray(parsed?.result?.tools)) throw new Error('The MCP endpoint did not return a valid tool list.');
  return {
    ok: true,
    checkedAt: nowIso(),
    ...(await publicMcpIntegration(config)),
    tools: parsed.result.tools.map(({ name, title, description }) => ({ name, title, description }))
  };
}

async function connectMcpClientIntegration(clientId) {
  let config = normalizeMcpIntegration((await readSettings()).mcpIntegration || {});
  const server = ensureMcpServer();
  if (!(server.status().running && await server.isReachable())) {
    await startMcpIntegration({ port: config.port });
    config = normalizeMcpIntegration((await readSettings()).mcpIntegration || {});
  }
  const persisted = await readOrCreatePersistedMcpToken(config);
  if (persisted.recovered) {
    const actualPort = await startMcpServerWithPortFallback(config.port, persisted.token);
    await refreshConnectedMcpClientConfigurations(actualPort, persisted.token);
    if (actualPort !== config.port) {
      config.port = actualPort;
      await writeMcpIntegrationSettings({ ...config, tokenEncrypted: persisted.tokenEncrypted, lastError: '', updatedAt: nowIso() });
    }
  }
  const { token } = persisted;
  if (!token || !ensureMcpServer().status().running) throw new Error('The DeployerX MCP server could not be started.');
  const result = await connectMcpClient(clientId, { url: `http://127.0.0.1:${config.port}/mcp`, token });
  await setMcpAutostartEnabled(true).catch(() => {});
  mcpClientRendererCache = null;
  return result;
}

async function disconnectMcpClientIntegration(clientId) {
  const result = await disconnectMcpClient(clientId);
  const clients = await listMcpClients();
  if (!clients.some((client) => client.connected)) await setMcpAutostartEnabled(false).catch(() => {});
  mcpClientRendererCache = null;
  return result;
}

async function disconnectMcpIntegration() {
  const clients = await listMcpClients();
  const disconnected = [];
  const failures = [];
  for (const client of clients) {
    try {
      disconnected.push(await disconnectMcpClient(client.id));
    } catch (error) {
      failures.push(`${client.name}: ${String(error?.message || error)}`);
    }
  }
  if (failures.length) throw new Error(`Could not disconnect every MCP client. ${failures.join(' ')}`);
  await ensureMcpServer().stop();
  const settings = await readSettings();
  const current = normalizeMcpIntegration(settings.mcpIntegration || {});
  const next = normalizeMcpIntegration({
    ...current,
    enabled: false,
    // Keep the credential so disconnect/reconnect does not invalidate clients.
    tokenEncrypted: current.tokenEncrypted,
    lastError: '',
    updatedAt: nowIso()
  });
  await writeMcpIntegrationSettings(next);
  await setMcpAutostartEnabled(false).catch(() => {});
  mcpClientRendererCache = null;
  return { ...await publicMcpIntegration(next), disconnected };
}

async function connectAllMcpClientsIntegration() {
  const clients = await listMcpClients();
  const results = [];
  for (const client of clients) {
    try { results.push(await connectMcpClientIntegration(client.id)); }
    catch (error) { results.push({ id: client.id, name: client.name, connected: false, error: String(error?.message || error) }); }
  }
  return results;
}

function scheduleMcpRestoreRetry(delayMs = 10000) {
  if (isAppQuitting || mcpRestartTimer) return;
  mcpRestartTimer = setTimeout(() => {
    mcpRestartTimer = null;
    restoreMcpIntegration().catch(() => {});
  }, delayMs);
  mcpRestartTimer.unref?.();
}

function startMcpHealthWatchdog() {
  if (mcpHealthTimer) return;
  mcpHealthTimer = setInterval(() => {
    if (isAppQuitting) return;
    const server = ensureMcpServer();
    const status = server.status();
    Promise.resolve(status.external ? server.isReachable() : status.running)
      .then((running) => { if (!running) return restoreMcpIntegration(); })
      .catch(() => {});
  }, 15000);
  mcpHealthTimer.unref?.();
}

async function restoreMcpIntegrationAttempt() {
  const settings = await readSettings();
  const current = normalizeMcpIntegration(settings.mcpIntegration || {});
  if (!current.enabled) {
    await ensureMcpServer().stop().catch(() => {});
    return publicMcpIntegration(current);
  }
  let token;
  let tokenEncrypted;
  try {
    ({ token, tokenEncrypted } = await readOrCreatePersistedMcpToken(current));
  } catch (error) {
    const failed = normalizeMcpIntegration({
      ...current,
      lastError: mcpTokenErrorMessage(error),
      updatedAt: nowIso()
    });
    await writeMcpIntegrationSettings(failed);
    scheduleMcpRestoreRetry();
    return publicMcpIntegration(failed);
  }
  const config = normalizeMcpIntegration({
    ...current,
    tokenEncrypted,
    lastError: '',
    updatedAt: current.updatedAt || nowIso()
  });
  await writeMcpIntegrationSettings(config);

  let lastError;
  // During an update/restart the previous Electron process may still be
  // releasing the loopback listener. Give it enough time to drain before
  // recording a startup failure; the health watchdog remains the fallback.
  for (const delayMs of [0, 300, 1000, 3000, 10000]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const actualPort = await startMcpServerWithPortFallback(config.port, token);
      config.port = actualPort;
      config.lastError = '';
      config.updatedAt = nowIso();
      await writeMcpIntegrationSettings(config);
      await refreshConnectedMcpClientConfigurations(actualPort, token);
      await enableMcpAutostartForConnectedClients().catch(() => {});
      return publicMcpIntegration(config);
    } catch (error) {
      lastError = error;
    }
  }
  config.lastError = String(lastError?.message || lastError || 'MCP startup failed.');
  config.updatedAt = nowIso();
  await writeMcpIntegrationSettings(config);
  scheduleMcpRestoreRetry();
  return publicMcpIntegration(config);
}

async function restoreMcpIntegration() {
  if (mcpRestorePromise) return mcpRestorePromise;
  mcpRestorePromise = restoreMcpIntegrationAttempt().finally(() => {
    mcpRestorePromise = null;
  });
  return mcpRestorePromise;
}

function sanitizeUptimeProjects(projects = []) {
  return (Array.isArray(projects) ? projects : [])
    .map(normalizeStoredProject)
    .filter((project) => Array.isArray(project.uptimeMonitors) && project.uptimeMonitors.length > 0)
    .map((project) => ({
      id: String(project.id || '').trim(),
      name: String(project.name || 'Project').trim() || 'Project',
      uptimeMonitors: normalizeUptimeMonitors(project.uptimeMonitors)
    }))
    .filter((project) => project.id);
}

function monitorRunKey(projectId, monitorId) {
  return `${String(projectId || '').trim()}:${String(monitorId || '').trim()}`;
}

function countUptimeMonitors(projects = []) {
  return sanitizeUptimeProjects(projects).reduce((count, project) => count + project.uptimeMonitors.length, 0);
}

async function isProcessRunning(pid) {
  const numericPid = Number(pid || 0);
  if (!numericPid) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopUptimeWorkerLockRenewal() {
  if (uptimeWorkerLockRenewTimer) clearInterval(uptimeWorkerLockRenewTimer);
  uptimeWorkerLockRenewTimer = null;
}

async function renewUptimeWorkerLock() {
  if (!uptimeWorkerOwnsLock || !uptimeWorkerLockOwnerId) return false;
  const lockPath = getUptimeWorkerLockPath();
  const current = await readJsonFileSafe(lockPath, null);
  if (current?.ownerId !== uptimeWorkerLockOwnerId || Number(current?.pid) !== process.pid) {
    uptimeWorkerOwnsLock = false;
    uptimeWorkerLockOwnerId = '';
    stopUptimeWorkerLockRenewal();
    return false;
  }
  const now = new Date();
  await fs.utimes(lockPath, now, now);
  return true;
}

function startUptimeWorkerLockRenewal() {
  stopUptimeWorkerLockRenewal();
  uptimeWorkerLockRenewTimer = setInterval(() => {
    renewUptimeWorkerLock().catch(() => {});
  }, UPTIME_WORKER_LOCK_RENEW_MS);
}

async function createUptimeWorkerLock(lockPath, ownerId) {
  const handle = await fs.open(lockPath, 'wx');
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, ownerId, startedAt: nowIso() }, null, 2));
  } finally {
    await handle.close();
  }
  uptimeWorkerOwnsLock = true;
  uptimeWorkerLockOwnerId = ownerId;
  startUptimeWorkerLockRenewal();
  return true;
}

async function acquireUptimeWorkerLock() {
  if (uptimeWorkerOwnsLock) return true;
  await ensureUptimeRoot();
  const lockPath = getUptimeWorkerLockPath();
  const ownerId = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await createUptimeWorkerLock(lockPath, ownerId);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const existing = await readJsonFileSafe(lockPath, null);
    const stats = await fs.stat(lockPath).catch(() => null);
    const processRunning = existing?.pid ? await isProcessRunning(existing.pid) : false;
    if (isWorkerLockLeaseActive(existing, {
      leaseUpdatedAt: stats?.mtime?.toISOString(),
      processRunning
    })) return false;

    const latest = await readJsonFileSafe(lockPath, null);
    if (latest?.ownerId !== existing?.ownerId || latest?.startedAt !== existing?.startedAt || Number(latest?.pid || 0) !== Number(existing?.pid || 0)) {
      continue;
    }
    await fs.rm(lockPath, { force: true });
  }
  return false;
}

async function releaseUptimeWorkerLock() {
  if (!uptimeWorkerOwnsLock) return;
  const ownerId = uptimeWorkerLockOwnerId;
  uptimeWorkerOwnsLock = false;
  uptimeWorkerLockOwnerId = '';
  stopUptimeWorkerLockRenewal();
  const lockPath = getUptimeWorkerLockPath();
  const current = await readJsonFileSafe(lockPath, null);
  if (current?.ownerId === ownerId && Number(current?.pid) === process.pid) {
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

function buildWorkerArgs() {
  return buildWorkerLaunchArgs({ defaultApp: process.defaultApp, isPackaged: app.isPackaged, appPath: app.getAppPath() });
}

async function isLinuxAutostartEnabled() {
  const autostartPath = path.join(os.homedir(), '.config', 'autostart', 'deployerx-uptime-worker.desktop');
  try {
    await fs.access(autostartPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkerAutostartEnabled() {
  const args = buildWorkerArgs();
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings(buildLoginItemSettings({ enabled: true, execPath: process.execPath, args }));
    uptimeWorkerState.autostartEnabled = Boolean(app.getLoginItemSettings().openAtLogin);
    return uptimeWorkerState.autostartEnabled;
  }

  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const autostartPath = path.join(autostartDir, 'deployerx-uptime-worker.desktop');
  const desktopEntry = buildLinuxAutostartEntry({ execPath: process.execPath, args });
  await fs.mkdir(autostartDir, { recursive: true });
  await fs.writeFile(autostartPath, `${desktopEntry}\n`, 'utf8');
  uptimeWorkerState.autostartEnabled = true;
  return true;
}

async function resolveWorkerAutostartEnabled() {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return Boolean(app.getLoginItemSettings().openAtLogin);
  }
  return isLinuxAutostartEnabled();
}

async function queueRunNowCommand(projectId, monitorId = '') {
  await ensureUptimeRoot();
  const queued = await readJsonFileSafe(getUptimeCommandsPath(), []);
  const next = Array.isArray(queued) ? queued : [];
  next.push({
    id: createId('uptime-run'),
    queuedAt: nowIso(),
    projectId: String(projectId || '').trim(),
    monitorId: String(monitorId || '').trim()
  });
  await writeJsonFilePretty(getUptimeCommandsPath(), next);
}

async function readAndClearRunNowCommands() {
  const queued = await readJsonFileSafe(getUptimeCommandsPath(), []);
  await writeJsonFilePretty(getUptimeCommandsPath(), []);
  return Array.isArray(queued) ? queued : [];
}

async function cacheUptimeProjects(projects) {
  await writeJsonFilePretty(getUptimeConfigCachePath(), {
    updatedAt: nowIso(),
    projects: sanitizeUptimeProjects(projects)
  });
}

async function readCachedUptimeProjects() {
  const cached = await readJsonFileSafe(getUptimeConfigCachePath(), { projects: [] });
  return sanitizeUptimeProjects(cached.projects);
}

function parseHeaderMap(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key || '').toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value || '')])
  );
}

async function runHttpMonitorCheck(monitor) {
  const url = String(monitor.http?.url || '').trim();
  if (!url) {
    return { ok: false, summary: 'HTTP URL is required.', error: 'Missing URL' };
  }

  const requestUrl = new URL(url);
  const client = requestUrl.protocol === 'http:' ? http : https;
  const startedAt = nowMs();
  const body = await new Promise((resolve, reject) => {
    const request = client.request(
      requestUrl,
      {
        method: monitor.http.method || 'GET',
        headers: normalizeMonitorHeaders(monitor.http.headers),
        timeout: Number(monitor.timeoutMs || 10000)
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => {
          if ((monitor.http.method || 'GET') === 'HEAD') return;
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            statusCode: Number(response.statusCode || 0),
            headers: parseHeaderMap(response.headers),
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    request.on('timeout', () => request.destroy(new Error('Request timed out.')));
    request.on('error', reject);
    request.end();
  });

  const latencyMs = nowMs() - startedAt;
  const expectedStatuses = normalizeExpectedStatuses(monitor.http.expectedStatusCodes);
  if (!expectedStatuses.includes(body.statusCode)) {
    return {
      ok: false,
      latencyMs,
      summary: `Expected status ${expectedStatuses.join(', ')} but received ${body.statusCode}.`,
      error: `Unexpected status ${body.statusCode}`,
      details: { statusCode: body.statusCode }
    };
  }

  for (const assertion of normalizeHeaderAssertions(monitor.http.headerAssertions)) {
    const actual = String(body.headers[String(assertion.key).toLowerCase()] || '');
    const passed = assertion.mode === 'contains' ? actual.includes(assertion.expected) : actual === assertion.expected;
    if (!passed) {
      return {
        ok: false,
        latencyMs,
        summary: `Header ${assertion.key} did not match ${assertion.mode} assertion.`,
        error: `Header assertion failed for ${assertion.key}`,
        details: { header: assertion.key, actual }
      };
    }
  }

  if ((monitor.http.method || 'GET') !== 'HEAD') {
    for (const text of trimStringList(monitor.http.bodyMustContain)) {
      if (!body.body.includes(text)) {
        return {
          ok: false,
          latencyMs,
          summary: `Response body did not contain required text: ${text}.`,
          error: `Missing body text: ${text}`
        };
      }
    }
    for (const text of trimStringList(monitor.http.bodyMustNotContain)) {
      if (body.body.includes(text)) {
        return {
          ok: false,
          latencyMs,
          summary: `Response body contained blocked text: ${text}.`,
          error: `Blocked body text present: ${text}`
        };
      }
    }
  }

  return {
    ok: true,
    latencyMs,
    summary: `${monitor.http.method || 'GET'} ${body.statusCode} in ${latencyMs} ms`,
    details: { statusCode: body.statusCode }
  };
}

async function runTcpMonitorCheck(monitor) {
  const host = String(monitor.tcp?.host || '').trim();
  const port = Number(monitor.tcp?.port || 0);
  if (!host || !port) {
    return { ok: false, summary: 'TCP host and port are required.', error: 'Missing TCP target' };
  }

  const startedAt = nowMs();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let finished = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(payload);
    };

    socket.setTimeout(Number(monitor.timeoutMs || 10000));
    socket.once('connect', () => {
      const latencyMs = nowMs() - startedAt;
      finish({
        ok: true,
        latencyMs,
        summary: `TCP connect in ${latencyMs} ms`
      });
    });
    socket.once('timeout', () => finish({ ok: false, summary: 'TCP connection timed out.', error: 'Connection timed out' }));
    socket.once('error', (error) =>
      finish({
        ok: false,
        summary: error.message || 'TCP connection failed.',
        error: error.message || 'TCP connection failed'
      })
    );
    socket.connect(port, host);
  });
}

async function runUptimeMonitorCheck(monitor) {
  const result = monitor.type === 'tcp' ? await runTcpMonitorCheck(monitor) : await runHttpMonitorCheck(monitor);
  if (result.ok && Number(monitor.latencyBudgetMs || 0) > 0 && Number(result.latencyMs || 0) > Number(monitor.latencyBudgetMs)) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      summary: `Latency ${result.latencyMs} ms exceeded budget ${monitor.latencyBudgetMs} ms.`,
      error: 'Latency budget exceeded',
      details: result.details || {}
    };
  }
  return result;
}

function summarizeProjectRuntime(monitors = []) {
  const summary = { total: monitors.length, up: 0, degraded: 0, down: 0, paused: 0, idle: 0 };
  for (const monitor of monitors) {
    const status = monitor.runtime?.status || 'idle';
    if (Object.prototype.hasOwnProperty.call(summary, status)) summary[status] += 1;
    else summary.idle += 1;
  }
  return summary;
}

function buildUptimeServiceSnapshot(runtime = null) {
  const workerRuntime = runtime?.worker || {};
  return {
    ...uptimeWorkerState,
    ...workerRuntime,
    pid: Number(workerRuntime.pid || uptimeWorkerState.pid || process.pid),
    active: Boolean(workerRuntime.active || uptimeWorkerState.active),
    autostartEnabled: Boolean(
      Object.prototype.hasOwnProperty.call(workerRuntime, 'autostartEnabled') ? workerRuntime.autostartEnabled : uptimeWorkerState.autostartEnabled
    )
  };
}

async function getUptimeServiceStatus() {
  const runtime = await readUptimeRuntime();
  const snapshot = buildUptimeServiceSnapshot(runtime);
  snapshot.autostartEnabled = await resolveWorkerAutostartEnabled().catch(() => snapshot.autostartEnabled);
  snapshot.active = snapshot.active && (await isProcessRunning(snapshot.pid));
  return snapshot;
}

function emitUptimeEvent(type, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('uptime:event', {
    type,
    payload,
    at: nowIso()
  });
}

async function writeWorkerRuntimeStatus(extra = {}) {
  const autostartEnabled = await resolveWorkerAutostartEnabled().catch(() => uptimeWorkerState.autostartEnabled);
  const heartbeatAt = nowIso();
  uptimeWorkerState.lastHeartbeatAt = heartbeatAt;
  const runtime = await mutateUptimeRuntime((current) => {
    current.heartbeatAt = heartbeatAt;
    current.worker = {
      ...current.worker,
      ...uptimeWorkerState,
      ...extra,
      active: true,
      pid: process.pid,
      mode: serviceModeLabel(),
      autostartEnabled,
      startedAt: uptimeWorkerState.startedAt || current.worker.startedAt || heartbeatAt
    };
    return current;
  });
  uptimeWorkerState = buildUptimeServiceSnapshot(runtime);
}

async function deleteUptimeMonitorArtifacts(projectId, monitorId) {
  const normalizedProjectId = String(projectId || '').trim();
  const normalizedMonitorId = String(monitorId || '').trim();
  if (!normalizedProjectId || !normalizedMonitorId) return;
  await fs.rm(getUptimeMonitorPath(normalizedProjectId, normalizedMonitorId), { recursive: true, force: true }).catch(() => {});
  const runtime = await mutateUptimeRuntime((current) => {
    if (current.projects?.[normalizedProjectId]?.monitors) {
      delete current.projects[normalizedProjectId].monitors[normalizedMonitorId];
      if (!Object.keys(current.projects[normalizedProjectId].monitors).length) delete current.projects[normalizedProjectId];
    }
    return current;
  });
  emitUptimeEvent('uptime:monitor-removed', {
    projectId: normalizedProjectId,
    monitorId: normalizedMonitorId,
    service: buildUptimeServiceSnapshot(runtime)
  });
}

async function deleteUptimeProjectArtifacts(projectId) {
  const normalizedProjectId = String(projectId || '').trim();
  if (!normalizedProjectId) return;
  await fs.rm(getUptimeProjectPath(normalizedProjectId), { recursive: true, force: true }).catch(() => {});
  const runtime = await mutateUptimeRuntime((current) => {
    delete current.projects[normalizedProjectId];
    return current;
  });
  emitUptimeEvent('uptime:project-removed', {
    projectId: normalizedProjectId,
    service: buildUptimeServiceSnapshot(runtime)
  });
}

async function pruneRemovedMonitorArtifacts(previousProject, nextProject) {
  const previousMonitors = new Set(normalizeUptimeMonitors(previousProject?.uptimeMonitors).map((monitor) => String(monitor.id)));
  const nextMonitors = new Set(normalizeUptimeMonitors(nextProject?.uptimeMonitors).map((monitor) => String(monitor.id)));
  for (const monitorId of previousMonitors) {
    if (!nextMonitors.has(monitorId)) {
      await deleteUptimeMonitorArtifacts(nextProject?.id || previousProject?.id, monitorId);
    }
  }
}

function shouldOpenDownIncident(state) {
  return state.consecutiveFailures >= 2 && !state.activeIncidentId;
}

function monitorSummaryText(result) {
  if (result.summary) return String(result.summary);
  if (result.ok) return 'Check passed.';
  return result.error || 'Check failed.';
}

async function showUptimeNotification(title, body) {
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title,
      body,
      silent: false
    }).show();
  } catch {
    // Notification support varies by platform/runtime.
  }
}

async function recordMonitorCheck(project, monitor, result) {
  const checkedAt = nowIso();
  const runtime = await mutateUptimeRuntime((current) => {
    const state = ensureRuntimeMonitorState(current, project.id, monitor.id);
    state.lastCheckAt = checkedAt;
    state.lastLatencyMs = result.latencyMs == null ? state.lastLatencyMs : Number(result.latencyMs || 0);
    state.summary = monitorSummaryText(result);
    state.lastError = result.ok ? '' : String(result.error || result.summary || 'Check failed');
    state.checkCount = Number(state.checkCount || 0) + 1;
    if (!monitor.enabled) {
      state.status = 'paused';
      state.pausedAt = checkedAt;
      state.nextCheckAt = '';
      return current;
    }

    if (result.ok) {
      state.lastSuccessAt = checkedAt;
      state.consecutiveFailures = 0;
      state.status = 'up';
      state.nextCheckAt = new Date(nowMs() + Number(monitor.intervalSec || 300) * 1000).toISOString();
      const incidentId = state.activeIncidentId;
      if (incidentId) {
        appendNdjson(getUptimeIncidentPath(project.id, monitor.id), {
          incidentId,
          event: 'resolved',
          projectId: project.id,
          monitorId: monitor.id,
          monitorName: monitor.name,
          at: checkedAt,
          message: state.summary
        }).catch(() => {});
        showUptimeNotification(`Recovered: ${monitor.name}`, `${project.name} is back up.`).catch(() => {});
      }
      state.activeIncidentId = '';
      state.incidentOpenSince = '';
    } else {
      state.lastFailureAt = checkedAt;
      state.consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
      state.nextCheckAt = new Date(nowMs() + Number(monitor.intervalSec || 300) * 1000).toISOString();
      state.status = state.consecutiveFailures >= 2 ? 'down' : 'degraded';
      if (shouldOpenDownIncident(state)) {
        const incidentId = createId('incident');
        state.activeIncidentId = incidentId;
        state.incidentOpenSince = state.lastFailureAt || checkedAt;
        appendNdjson(getUptimeIncidentPath(project.id, monitor.id), {
          incidentId,
          event: 'opened',
          projectId: project.id,
          monitorId: monitor.id,
          monitorName: monitor.name,
          at: checkedAt,
          message: state.summary
        }).catch(() => {});
        showUptimeNotification(`Down: ${monitor.name}`, `${project.name} requires attention.`).catch(() => {});
      }
    }

    return current;
  });

  const runtimeState = runtime.projects?.[project.id]?.monitors?.[monitor.id] || defaultRuntimeMonitorState();
  await appendNdjson(getUptimeHistoryPath(project.id, monitor.id), {
    id: createId('check'),
    projectId: project.id,
    projectName: project.name,
    monitorId: monitor.id,
    monitorName: monitor.name,
    type: monitor.type,
    at: checkedAt,
    ok: Boolean(result.ok),
    status: runtimeState.status,
    latencyMs: result.latencyMs == null ? null : Number(result.latencyMs || 0),
    summary: monitorSummaryText(result),
    error: result.ok ? '' : String(result.error || ''),
    details: result.details || {}
  });
  emitUptimeEvent('uptime:monitor-updated', {
    projectId: project.id,
    monitorId: monitor.id,
    runtime: runtimeState,
    service: buildUptimeServiceSnapshot(runtime)
  });
  return runtimeState;
}

async function refreshUptimeWorkerProjects() {
  try {
    const store = await readCurrentStore();
    uptimeWorkerProjects = sanitizeUptimeProjects(store.projects);
    await cacheUptimeProjects(uptimeWorkerProjects);
    uptimeWorkerState.syncWarning = '';
    uptimeWorkerState.projectsLoaded = uptimeWorkerProjects.length;
    uptimeWorkerState.monitorCount = countUptimeMonitors(uptimeWorkerProjects);
    uptimeWorkerState.lastConfigRefreshAt = nowIso();
  } catch (error) {
    const cachedProjects = await readCachedUptimeProjects();
    uptimeWorkerProjects = cachedProjects;
    uptimeWorkerState.syncWarning = error.message || 'Could not refresh uptime monitor config.';
    uptimeWorkerState.projectsLoaded = cachedProjects.length;
    uptimeWorkerState.monitorCount = countUptimeMonitors(cachedProjects);
    uptimeWorkerState.lastConfigRefreshAt = nowIso();
  }
  await writeWorkerRuntimeStatus({
    lastConfigRefreshAt: uptimeWorkerState.lastConfigRefreshAt,
    syncWarning: uptimeWorkerState.syncWarning,
    projectsLoaded: uptimeWorkerState.projectsLoaded,
    monitorCount: uptimeWorkerState.monitorCount
  });
}

async function maybePrimePausedMonitorState(project, monitor) {
  if (monitor.enabled) return;
  await mutateUptimeRuntime((current) => {
    const state = ensureRuntimeMonitorState(current, project.id, monitor.id);
    state.status = 'paused';
    state.pausedAt = state.pausedAt || nowIso();
    state.nextCheckAt = '';
    state.summary = 'Monitoring paused.';
    return current;
  });
}

async function runMonitorNow(project, monitor) {
  const key = monitorRunKey(project.id, monitor.id);
  if (uptimeMonitorRuns.has(key)) return;
  uptimeMonitorRuns.add(key);
  try {
    await maybePrimePausedMonitorState(project, monitor);
    if (!monitor.enabled) return;
    let result;
    try {
      result = await runUptimeMonitorCheck(monitor);
    } catch (error) {
      result = {
        ok: false,
        summary: error.message || 'Monitor check failed.',
        error: error.message || 'Monitor check failed'
      };
    }
    await recordMonitorCheck(project, monitor, result);
  } finally {
    uptimeMonitorRuns.delete(key);
  }
}

async function processRunNowCommands() {
  const commands = await readAndClearRunNowCommands();
  if (!commands.length) return;
  const queuedKeys = new Set(
    commands.map((command) => monitorRunKey(command.projectId, command.monitorId || '*'))
  );
  for (const command of commands) {
    if (!command.projectId) continue;
    if (!command.monitorId) {
      for (const project of uptimeWorkerProjects) {
        if (project.id !== command.projectId) continue;
        for (const monitor of project.uptimeMonitors) {
          uptimeRunNowQueue.add(monitorRunKey(project.id, monitor.id));
        }
      }
      continue;
    }
    uptimeRunNowQueue.add(monitorRunKey(command.projectId, command.monitorId));
  }
  uptimeWorkerState.commandPollAt = nowIso();
  await writeWorkerRuntimeStatus({
    commandPollAt: uptimeWorkerState.commandPollAt,
    projectsLoaded: uptimeWorkerState.projectsLoaded,
    monitorCount: uptimeWorkerState.monitorCount
  });
  return queuedKeys;
}

async function runDueUptimeChecks() {
  const runtime = await readUptimeRuntime();
  const now = nowMs();
  for (const project of uptimeWorkerProjects) {
    for (const monitor of project.uptimeMonitors) {
      const runtimeState = runtime.projects?.[project.id]?.monitors?.[monitor.id] || defaultRuntimeMonitorState();
      if (!monitor.enabled) {
        await maybePrimePausedMonitorState(project, monitor);
        continue;
      }

      const queuedKey = monitorRunKey(project.id, monitor.id);
      const isQueued = uptimeRunNowQueue.has(queuedKey);
      const dueAt = runtimeState.nextCheckAt ? new Date(runtimeState.nextCheckAt).getTime() : 0;
      const shouldRun = isQueued || !runtimeState.lastCheckAt || !dueAt || dueAt <= now;
      if (!shouldRun) continue;
      uptimeRunNowQueue.delete(queuedKey);
      try {
        await runMonitorNow(project, monitor);
      } catch {
        // The check itself records failure state; keep the scheduler moving.
      }
    }
  }

  uptimeWorkerState.runLoopTickAt = nowIso();
  await writeWorkerRuntimeStatus({
    runLoopTickAt: uptimeWorkerState.runLoopTickAt,
    projectsLoaded: uptimeWorkerState.projectsLoaded,
    monitorCount: uptimeWorkerState.monitorCount
  });
}

async function startUptimeWindowPolling() {
  if (uptimeWindowPollTimer) clearInterval(uptimeWindowPollTimer);
  uptimeWindowLastHeartbeat = '';
  uptimeWindowPollTimer = setInterval(async () => {
    try {
      const runtime = await readUptimeRuntime();
      const heartbeat = `${runtime.heartbeatAt || ''}:${runtime.worker?.runLoopTickAt || ''}:${runtime.worker?.syncWarning || ''}`;
      if (heartbeat && heartbeat !== uptimeWindowLastHeartbeat) {
        uptimeWindowLastHeartbeat = heartbeat;
        emitUptimeEvent('uptime:heartbeat', {
          service: buildUptimeServiceSnapshot(runtime)
        });
      }
    } catch {
      // Ignore polling errors; explicit IPC calls surface details.
    }
  }, 4000);
}

async function maybeStartDetachedUptimeWorker() {
  if (isWorkerMode()) return;
  if (uptimeWorkerLaunchPromise) return uptimeWorkerLaunchPromise;
  const launch = (async () => {
    const serviceStatus = await getUptimeServiceStatusV2().catch(() => ({ active: false }));
    if (serviceStatus.active && serviceStatus.processId && Number(serviceStatus.processId) !== process.pid) {
      uptimeWorkerLaunchError = '';
      return { started: false, processId: Number(serviceStatus.processId) };
    }
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, buildWorkerArgs(), {
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.once('error', reject);
      child.once('exit', () => {
        if (detachedUptimeWorkerPid === Number(child.pid || 0)) detachedUptimeWorkerPid = 0;
      });
      child.once('spawn', () => {
        detachedUptimeWorkerPid = Number(child.pid || 0);
        child.unref();
        resolve({ started: true, processId: child.pid });
      });
    });
  })();
  uptimeWorkerLaunchPromise = launch;
  try {
    const result = await launch;
    uptimeWorkerLaunchError = '';
    return result;
  } catch (error) {
    uptimeWorkerLaunchError = `Background worker could not start: ${String(error?.message || error)}`;
    throw error;
  } finally {
    if (uptimeWorkerLaunchPromise === launch) uptimeWorkerLaunchPromise = null;
  }
}

async function restartDetachedUptimeWorkerForWorkspaceChange(previousWorkspaceId) {
  if (isWorkerMode()) return;
  const workspaceId = String(previousWorkspaceId || '').trim();
  if (workspaceId && uptimeControlDatabase && backupDeviceId) {
    const probeId = `local-windows:${backupDeviceId}`;
    const heartbeat = (await uptimeControlDatabase.listWorkerHeartbeats(workspaceId).catch(() => []))
      .find((item) => String(item.probeId) === probeId);
    const processId = Number(heartbeat?.processId || 0);
    if (processId && processId !== process.pid && await isProcessRunning(processId)) {
      try { process.kill(processId); } catch {}
      for (let attempt = 0; attempt < 20 && await isProcessRunning(processId); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  uptimeWorkerLaunchPromise = null;
  uptimeWorkerLaunchError = '';
  uptimeCloudLastSyncAt.clear();
  await maybeStartDetachedUptimeWorker().catch(() => {});
}

async function initializeUptimeWorker() {
  const hasLock = await acquireUptimeWorkerLock();
  if (!hasLock) {
    await app.quit();
    return;
  }
  uptimeWorkerState = {
    ...uptimeWorkerState,
    active: true,
    mode: 'worker',
    startedAt: nowIso(),
    lastHeartbeatAt: nowIso(),
    pid: process.pid
  };
  await ensureWorkerAutostartEnabled().catch(() => {});
  await refreshUptimeWorkerProjects();
  await processRunNowCommands();
  await runDueUptimeChecks();
  uptimeWorkerInterval = setInterval(() => {
    runDueUptimeChecks().catch(() => {});
  }, UPTIME_COMMAND_POLL_MS);
  uptimeConfigRefreshTimer = setInterval(() => {
    refreshUptimeWorkerProjects().catch(() => {});
  }, UPTIME_CONFIG_REFRESH_MS);
  uptimeCommandPollTimer = setInterval(() => {
    processRunNowCommands().catch(() => {});
  }, UPTIME_COMMAND_POLL_MS);
}

async function getUptimeProjectState(projectId) {
  const projectKey = String(projectId || '').trim();
  let projects = [];
  let syncWarning = '';
  try {
    const store = await readCurrentStore();
    projects = sanitizeUptimeProjects(store.projects);
  } catch (error) {
    projects = await readCachedUptimeProjects();
    syncWarning = error.message || 'Could not refresh live project data.';
  }
  const project = projects.find((item) => item.id === projectKey) || {
    id: projectKey,
    name: 'Project',
    uptimeMonitors: []
  };
  const runtime = await readUptimeRuntime();
  const service = buildUptimeServiceSnapshot(runtime);
  if (syncWarning && !service.syncWarning) service.syncWarning = syncWarning;
  const monitors = project.uptimeMonitors.map((monitor) => ({
    ...monitor,
    runtime: normalizeRuntimeMonitorState(runtime.projects?.[project.id]?.monitors?.[monitor.id])
  }));
  return {
    projectId: project.id,
    projectName: project.name,
    service,
    summary: summarizeProjectRuntime(monitors),
    monitors
  };
}

async function getUptimeMonitorHistory(projectId, monitorId) {
  const normalizedProjectId = String(projectId || '').trim();
  const normalizedMonitorId = String(monitorId || '').trim();
  return {
    history: await readNdjsonTail(getUptimeHistoryPath(normalizedProjectId, normalizedMonitorId), UPTIME_HISTORY_LIMIT),
    incidents: await readNdjsonTail(getUptimeIncidentPath(normalizedProjectId, normalizedMonitorId), UPTIME_HISTORY_LIMIT)
  };
}

async function deleteProjectFromCurrentStore(id) {
  const existingStore = await readCurrentStore().catch(() => ({ projects: [] }));
  const existingProject = Array.isArray(existingStore.projects)
    ? existingStore.projects.find((project) => String(project.id) === String(id))
    : null;
  const settings = await readSettings();
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await deleteDoc(['teams', teamId, 'projects', id]);
    await deleteProjectLocalSettings(id);
    await deleteUptimeProjectArtifacts(id);
    return;
  }
  const data = await readStore();
  data.projects = data.projects.filter((project) => project.id !== id);
  await writeStore(data);
  await deleteProjectLocalSettings(id);
  await deleteUptimeProjectArtifacts(existingProject?.id || id);
}

async function deleteTemplateFromCurrentStore(id) {
  const settings = await readSettings();
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await deleteDoc(['teams', teamId, 'templates', id]);
    return;
  }
  const data = await readStore();
  data.templates = data.templates.filter((template) => template.id !== id);
  await writeStore(data);
}

async function queryPendingInvites(email) {
  const emailLower = emailKey(email);
  if (!emailLower) return [];
  let invites = [];
  try {
    invites = await listCollection(inviteInboxPath(emailLower));
  } catch {
    invites = [];
  }

  try {
    const collectionGroupInvites = await runFirestoreQuery({
      from: [{ collectionId: 'invites', allDescendants: true }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'emailLower' },
          op: 'EQUAL',
          value: { stringValue: emailLower }
        }
      }
    });
    invites.push(...collectionGroupInvites);
  } catch {
    // Older Firestore rules or missing collection-group permissions can block this path.
  }

  const seen = new Set();
  return invites
    .filter((invite) => invite.status === 'pending')
    .map((invite) => {
      const parts = String(invite.__path || '').split('/');
      const teamIndex = parts.indexOf('teams');
      return {
        ...invite,
        teamId: teamIndex >= 0 ? parts[teamIndex + 1] : invite.teamId
      };
    })
    .filter((invite) => {
      const key = `${invite.teamId || ''}:${invite.id || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function queryUserMemberships(auth) {
  try {
    const memberships = await runFirestoreQuery({
      from: [{ collectionId: 'members', allDescendants: true }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'uid' },
          op: 'EQUAL',
          value: { stringValue: auth.uid }
        }
      }
    });

    return memberships
      .map((membership) => {
        const pathParts = String(membership.__path || '').split('/');
        const teamIndex = pathParts.lastIndexOf('teams');
        const memberUid = pathParts[pathParts.length - 1] || '';
        if (teamIndex < 0 || !pathParts[teamIndex + 1] || memberUid !== auth.uid) return null;
        return {
          teamId: pathParts[teamIndex + 1],
          role: normalizeWorkspaceRole(membership.role, { allowOwner: true })
        };
      })
      .filter(Boolean);
  } catch (error) {
    // Older deployed rules may not allow this collection-group lookup yet.
    if (isRecoverableCloudDataError(error)) return null;
    throw error;
  }
}

async function teamSnapshot(options = {}) {
  const auth = options.auth || (await requireAuthSession());
  const settings = options.settings || (await readSettings());
  const lightweight = Boolean(options.lightweight);
  const profile = options.profile || (await readUserProfile(auth.uid)) || (await writeUserProfile(auth));
  const profileTeamRefs = Array.isArray(profile.teams) ? profile.teams : [];
  const discoveredMemberships = await queryUserMemberships(auth);
  const membershipByTeamId = new Map(
    (discoveredMemberships || []).map((membership) => [String(membership.teamId), membership])
  );
  const teamRefsById = new Map(
    profileTeamRefs
      .filter((teamRef) => teamRef?.teamId)
      .map((teamRef) => [String(teamRef.teamId), teamRef])
  );
  for (const membership of discoveredMemberships || []) {
    const existing = teamRefsById.get(String(membership.teamId)) || {};
    teamRefsById.set(String(membership.teamId), { ...existing, ...membership });
  }
  if (discoveredMemberships === null && settings.activeTeamId && !teamRefsById.has(String(settings.activeTeamId))) {
    const savedForCurrentAccount = String(settings.activeTeamUid || '') === String(auth.uid);
    teamRefsById.set(String(settings.activeTeamId), {
      teamId: settings.activeTeamId,
      name: savedForCurrentAccount ? settings.activeTeamName || '' : ''
    });
  }
  const teamRefs = [...teamRefsById.values()];
  const teamDocumentsById = new Map();
  const teams = (
    await Promise.all(
      teamRefs.map(async (teamRef) => {
        try {
          const discoveredMembership = membershipByTeamId.get(String(teamRef.teamId));
          const [team, member] = await Promise.all([
            getDoc(['teams', teamRef.teamId]),
            discoveredMembership
              ? Promise.resolve(discoveredMembership)
              : getDoc(['teams', teamRef.teamId, 'members', auth.uid])
          ]);
          if (!team || !member) return null;
          teamDocumentsById.set(String(team.id), team);
          return {
            id: team.id,
            name: team.name || teamRef.name || 'Team',
            role: normalizeWorkspaceRole(member.role, { allowOwner: true }),
            createdAt: team.createdAt || ''
          };
        } catch (error) {
          if (error?.status === 403) return null;
          throw error;
        }
      })
    )
  ).filter(Boolean);

  if (discoveredMemberships) {
    const repairedTeamRefs = teams.map((team) => ({
      teamId: team.id,
      name: team.name,
      role: team.role
    }));
    const normalizeRefs = (refs) => (refs || [])
      .map((team) => ({ teamId: String(team.teamId || ''), name: String(team.name || ''), role: String(team.role || '') }))
      .sort((left, right) => left.teamId.localeCompare(right.teamId));
    if (JSON.stringify(normalizeRefs(profileTeamRefs)) !== JSON.stringify(normalizeRefs(repairedTeamRefs))) {
      await writeUserProfile(auth, { teams: repairedTeamRefs });
    }
  }

  let activeTeamId = settings.activeTeamId;
  if (activeTeamId && !teams.some((team) => team.id === activeTeamId)) activeTeamId = '';
  if (!activeTeamId && teams.length) activeTeamId = teams[0].id;
  if (activeTeamId !== settings.activeTeamId) {
    await withDatabaseAccessContextTransition(async () => {
      await writeSettings({
        ...settings,
        activeTeamId,
        activeTeamName: teams.find((team) => team.id === activeTeamId)?.name || '',
        activeTeamUid: activeTeamId ? auth.uid : ''
      });
    });
  }

  const activeTeam = teams.find((team) => team.id === activeTeamId) || null;
  const canManageTeam = activeTeam?.role === 'owner';
  const [activeTeamDoc, members, teamInvites] = await Promise.all([
    activeTeamId ? Promise.resolve(teamDocumentsById.get(String(activeTeamId)) || null) : Promise.resolve(null),
    !lightweight && activeTeamId
      ? listCollection(['teams', activeTeamId, 'members']).then((items) =>
          items.map((member) => ({
            ...member,
            role: normalizeWorkspaceRole(member.role, { allowOwner: true })
          }))
        )
      : Promise.resolve([]),
    !lightweight && activeTeamId && canManageTeam ? listCollection(['teams', activeTeamId, 'invites']) : Promise.resolve([])
  ]);
  if (activeTeamId && activeTeamDoc) {
    cloudUnlock = { teamId: activeTeamId, key: deriveWorkspaceKey(activeTeamDoc) };
  } else {
    cloudUnlock = { teamId: '', key: null };
  }
  const memberEmails = new Set(members.map((member) => emailKey(member.emailLower || member.email)));
  const pendingTeamInvites = teamInvites.filter((invite) =>
    invite.status === 'pending' && !memberEmails.has(emailKey(invite.emailLower || invite.email))
  );
  if (pendingTeamInvites.length) {
    await Promise.allSettled(pendingTeamInvites.map(syncInviteInboxDocument));
  }
  const joinedTeamIds = new Set(teams.map((team) => String(team.id || '')));
  const invites = lightweight
    ? []
    : (await queryPendingInvites(auth.email)).filter((invite) => !joinedTeamIds.has(String(invite.teamId || '')));

  return {
    teams,
    activeTeamId,
    activeTeam,
    members,
    teamInvites: pendingTeamInvites,
    invites,
    unlocked: Boolean(activeTeamId && activeTeamDoc)
  };
}

function emptyTeamSnapshot(cloudError = '') {
  return {
    teams: [],
    activeTeamId: '',
    activeTeam: null,
    members: [],
    teamInvites: [],
    invites: [],
    unlocked: false,
    cloudError
  };
}

function cachedTeamSnapshot(settings, auth, cloudError = '') {
  const authUid = String(auth?.uid || '');
  const accountCaches = settings?.cloudWorkspaceCaches && typeof settings.cloudWorkspaceCaches === 'object'
    ? settings.cloudWorkspaceCaches
    : {};
  const legacyCache = settings?.cloudWorkspaceCache;
  const cache = accountCaches[authUid] || (
    legacyCache && String(legacyCache.uid || '') === authUid ? legacyCache : null
  );
  let teams = cache && String(cache.uid || '') === authUid && Array.isArray(cache.teams)
    ? cache.teams
    : [];
  if (
    !teams.length &&
    settings?.activeTeamId &&
    settings?.activeTeamName &&
    String(settings.activeTeamUid || '') === authUid
  ) {
    teams = [{ id: settings.activeTeamId, name: settings.activeTeamName, role: 'member' }];
  }
  if (!teams.length) return emptyTeamSnapshot(cloudError);
  const cachedActiveTeamId = cache?.activeTeamId || '';
  const activeTeamId = teams.some((team) => team.id === cachedActiveTeamId)
    ? cachedActiveTeamId
    : teams.some((team) => team.id === settings.activeTeamId)
      ? settings.activeTeamId
    : teams[0]?.id || '';
  return {
    ...emptyTeamSnapshot(cloudError),
    teams,
    activeTeamId,
    activeTeam: teams.find((team) => team.id === activeTeamId) || null,
    unlocked: Boolean(activeTeamId)
  };
}

async function cacheTeamSnapshot(auth, snapshot) {
  const latestSettings = await readSettings();
  const activeTeamName = snapshot.teams.find((team) => team.id === snapshot.activeTeamId)?.name || '';
  const snapshotContextStillCurrent = String(latestSettings.auth?.uid || '') === String(auth.uid || '')
    && String(latestSettings.activeTeamId || '') === String(snapshot.activeTeamId || '');
  const cloudWorkspaceCache = {
    uid: auth.uid,
    teams: snapshot.teams,
    activeTeamId: snapshot.activeTeamId,
    updatedAt: nowIso()
  };
  await writeSettings({
    ...latestSettings,
    ...(snapshotContextStillCurrent ? {
      activeTeamName,
      activeTeamUid: snapshot.activeTeamId ? auth.uid : ''
    } : {}),
    cloudWorkspaceCache,
    cloudWorkspaceCaches: {
      ...(latestSettings.cloudWorkspaceCaches || {}),
      [auth.uid]: cloudWorkspaceCache
    }
  });
}

async function safeTeamSnapshot(options = {}) {
  try {
    const auth = options.auth || (await requireAuthSession());
    const snapshot = await teamSnapshot({ ...options, auth });
    await cacheTeamSnapshot(auth, snapshot);
    return snapshot;
  } catch (error) {
    if (!isRecoverableCloudDataError(error)) throw error;
    const settings = options.settings || (await readSettings());
    const auth = options.auth || settings.auth;
    return cachedTeamSnapshot(settings, auth, error.message || 'Cloud data is temporarily unavailable.');
  }
}

async function finishCloudAuth(auth, profilePatch = {}) {
  auth = await lookupAuthUser(auth);
  return withDatabaseAccessContextTransition(async () => {
    const currentSettings = await readSettings();
    const savedWorkspaceBelongsToActor = Boolean(currentSettings.activeTeamId)
      && String(currentSettings.activeTeamUid || '') === String(auth.uid || '');
    if (!savedWorkspaceBelongsToActor) cloudUnlock = { teamId: '', key: null };
    const settings = await writeSettings({
      ...currentSettings,
      setupComplete: true,
      mode: 'cloud',
      auth,
      ...(savedWorkspaceBelongsToActor ? {} : {
        activeTeamId: '',
        activeTeamName: '',
        activeTeamUid: ''
      })
    });
    if (needsEmailVerification(auth)) {
      return { session: publicSession(auth), requiresEmailVerification: true };
    }
    try {
      let profile = await readUserProfile(auth.uid);
      if (!profile || Object.keys(profilePatch).length) {
        profile = await writeUserProfile(auth, profilePatch);
      }
      const teams = await teamSnapshot({ auth, settings, profile, lightweight: true });
      await cacheTeamSnapshot(auth, teams);
      return { session: publicSession(auth), teams };
    } catch (error) {
      if (!isRecoverableCloudDataError(error)) throw error;
      const latestSettings = await readSettings();
      const fallbackTeams = cachedTeamSnapshot(latestSettings, auth, error.message);
      return { session: publicSession(auth), teams: fallbackTeams, cloudError: error.message };
    }
  });
}

function isDatabaseManagerPackagedSmokeMode(argv = process.argv) {
  return argv.includes(DATABASE_MANAGER_PACKAGED_SMOKE_ARGUMENT);
}

function databaseManagerPackagedSmokeFailure(code) {
  return {
    schemaVersion: DATABASE_MANAGER_PACKAGED_SMOKE_SCHEMA_VERSION,
    passed: false,
    checks: [],
    error: { code }
  };
}

function databaseManagerPackagedSmokeReleasePath(argv = process.argv) {
  const argument = argv.find((value) => String(value).startsWith(DATABASE_MANAGER_PACKAGED_SMOKE_RELEASE_ARGUMENT));
  const candidate = path.resolve(String(argument || '').slice(DATABASE_MANAGER_PACKAGED_SMOKE_RELEASE_ARGUMENT.length));
  const userDataPath = path.resolve(app.getPath('userData'));
  const relative = path.relative(userDataPath.toLowerCase(), candidate.toLowerCase());
  if (!argument || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return candidate;
}

function publishDatabaseManagerPackagedSmoke(report) {
  if (databaseManagerPackagedSmokePublished) return;
  databaseManagerPackagedSmokePublished = true;
  process.stdout.write(`DEPLOYERX_DATABASE_MANAGER_SMOKE_PROCESS_ID=${process.pid}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
  let released = false;
  let releasePoll = null;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(releaseTimeout);
    if (releasePoll) clearInterval(releasePoll);
    setImmediate(() => app.quit());
  };
  const releaseTimeout = setTimeout(release, 40000);
  const releasePath = databaseManagerPackagedSmokeReleasePath();
  releasePoll = setInterval(async () => {
    if (!releasePath || released) return;
    try {
      const entry = await fs.lstat(releasePath);
      if (entry.isFile()) release();
    } catch (error) {
      if (error?.code !== 'ENOENT') release();
    }
  }, 100);
  releasePoll.unref();
}

async function runDatabaseManagerPackagedSmoke(window) {
  const preferences = window.webContents.getLastWebPreferences();
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const navigation = document.getElementById('topDatabasesButton');
    const view = document.getElementById('databaseManagerView');
    const tabs = [...document.querySelectorAll('.database-manager-tabs [role="tab"]')].map((tab) => String(tab.textContent || '').trim());
    const bridge = window.deployerx;
    return {
      rendererLoaded: document.readyState === 'complete' && document.title === 'DeployerX',
      preloadBridge: Boolean(bridge && ['listDatabaseProfiles', 'testDatabaseProfile', 'executeDatabaseQuery', 'listDatabasePlugins'].every((name) => typeof bridge[name] === 'function')),
      routeLaunch: Boolean(navigation && typeof bridge?.listDatabaseProfiles === 'function'),
      tabs,
      addControl: String(document.getElementById('databaseProfileAddButton')?.textContent || '').trim(),
      nodeRequireUnavailable: typeof require === 'undefined'
        || (typeof require.resolve !== 'function' && typeof require.cache === 'undefined' && typeof require.main === 'undefined'),
      nodeBufferUnavailable: typeof Buffer === 'undefined',
      privilegedProcessUnavailable: typeof process === 'undefined' || (typeof process.cwd !== 'function' && typeof process.binding !== 'function'),
      rawIpcUnavailable: !Object.hasOwn(bridge || {}, 'ipcRenderer')
    };
  })()`);
  const checks = [
    { name: 'renderer-loaded', passed: evidence?.rendererLoaded === true },
    { name: 'window-policy', passed: preferences.contextIsolation === true && preferences.nodeIntegration === false && preferences.sandbox === true },
    { name: 'preload-bridge', passed: evidence?.preloadBridge === true },
    { name: 'database-route', passed: evidence?.routeLaunch === true },
    { name: 'database-tabs', passed: JSON.stringify(evidence?.tabs) === JSON.stringify(['Connections', 'Query', 'Notebooks', 'Tasks', 'Logs', 'Drivers']) },
    { name: 'database-add-control', passed: evidence?.addControl === 'Add database' },
    { name: 'renderer-node-require', passed: evidence?.nodeRequireUnavailable === true },
    { name: 'renderer-node-buffer', passed: evidence?.nodeBufferUnavailable === true },
    { name: 'renderer-process-isolation', passed: evidence?.privilegedProcessUnavailable === true },
    { name: 'renderer-ipc-isolation', passed: evidence?.rawIpcUnavailable === true }
  ].map((check) => Object.freeze({ name: check.name, status: check.passed ? 'passed' : 'failed' }));
  return Object.freeze({
    schemaVersion: DATABASE_MANAGER_PACKAGED_SMOKE_SCHEMA_VERSION,
    passed: checks.every((check) => check.status === 'passed'),
    checks: Object.freeze(checks)
  });
}

function createWindow(options = {}) {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    title: 'DeployerX',
    icon: APP_ICON,
    show: options.show !== false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  vncSessionManager = new VncSessionManager({
    onEvent: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('vnc:event', event);
    }
  });
  rdpSessionManager = new RdpSessionManager({
    onEvent: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('rdp:event', event);
    }
  });

  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('close', (event) => {
    const disposition = uptimeWindowCloseDisposition({
      isAppQuitting,
      platform: process.platform
    });
    if (!disposition.preventClose) return;
    event.preventDefault();
    if (disposition.hideWindow) mainWindow.hide();
    if (disposition.hideDock) app.dock?.hide();
  });
  mainWindow.on('enter-full-screen', () => {
    if (mainWindowFullscreenOwner === 'vnc') mainWindow?.webContents.send('vnc:fullscreen-changed', true);
    if (mainWindowFullscreenOwner === 'server-monitoring') mainWindow?.webContents.send('server-monitoring:fullscreen-changed', true);
  });
  mainWindow.on('leave-full-screen', () => {
    const owner = mainWindowFullscreenOwner;
    mainWindowFullscreenOwner = null;
    if (owner === 'vnc') {
      mainWindow?.webContents.send('vnc:fullscreen-changed', false);
      restoreVncWindowState();
    }
    if (owner === 'server-monitoring') {
      mainWindow?.webContents.send('server-monitoring:fullscreen-changed', false);
      restoreServerMonitoringWindowState();
    }
  });
  mainWindow.on('closed', () => {
    serverMonitoringSessionManager.stopAll();
    rdpSessionManager?.closeAll().catch(() => {});
    vncSessionManager?.closeAll().catch(() => {});
    releaseAllVncNetworkSessions().catch(() => {});
    releaseAllWindowsVpnProfiles().catch(() => {});
    rdpSessionManager = null;
    vncSessionManager = null;
    vncRestoreWindowState = null;
    mainWindow = null;
  });
  mainWindow.webContents.on('console-message', (event) => {
    if (!['warning', 'error'].includes(event.level)) return;
    console.error(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    sendUpdateStateToRenderer();
    const uptimeTarget = parseUptimeNavigationArgument();
    if (uptimeTarget) mainWindow.webContents.send('uptime:navigate', uptimeTarget);
    if (typeof options.onReady === 'function') {
      Promise.resolve(options.onReady(mainWindow)).catch(() => options.onFailure?.('DATABASE_MANAGER_PACKAGED_SMOKE_EXECUTION_FAILED'));
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || isAppQuitting) return;
    const failureCode = options.onFailure ? 'DATABASE_MANAGER_PACKAGED_SMOKE_LOAD_FAILED' : 'RENDERER_LOAD_FAILED';
    options.onFailure?.(failureCode);
    if (!options.onFailure) {
      handleApplicationStartupFailure(new Error(
        `The DeployerX window could not load (${errorCode}): ${errorDescription || validatedURL || 'unknown renderer error'}`
      ));
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details = {}) => {
    if (isAppQuitting) return;
    const reason = String(details.reason || 'unknown renderer failure');
    handleApplicationStartupFailure(new Error(`The DeployerX renderer stopped unexpectedly: ${reason}.`));
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch((error) => {
    handleApplicationStartupFailure(error);
  });
}

function toConnectionConfig(project) {
  const ssh = project.ssh || {};
  const config = {
    host: ssh.host,
    port: Number(ssh.port || 22),
    username: ssh.username,
    readyTimeout: Number(ssh.timeout || 20000),
    keepaliveInterval: 15000,
    keepaliveCountMax: 4
  };

  if (ssh.authType === 'key') {
    config.privateKey = ssh.privateKey;
    if (ssh.passphrase) config.passphrase = ssh.passphrase;
  } else {
    config.password = ssh.password;
  }

  return config;
}

function normalizeProjectProxy(proxy = {}) {
  return {
    mode: ['none', 'windows-vpn', 'socks5', 'http-connect'].includes(String(proxy.mode || '')) ? String(proxy.mode) : 'none',
    windowsVpnProfile: String(proxy.windowsVpnProfile || '').trim(),
    host: String(proxy.host || '').trim(),
    port: proxy.port === '' || proxy.port == null ? '' : Number(proxy.port || ''),
    username: String(proxy.username || '').trim(),
    password: String(proxy.password || '')
  };
}

function proxyModeUsesManualEndpoint(mode) {
  return mode === 'socks5' || mode === 'http-connect';
}

function projectProxyValidationError(project) {
  const proxy = normalizeProjectProxy(project?.proxy || {});
  if (['vnc', 'rdp'].includes(project?.serverType) && proxyModeUsesManualEndpoint(proxy.mode)) {
    return 'VNC connections currently support only direct access or a Windows VPN profile.';
  }
  if (proxy.mode === 'windows-vpn' && !proxy.windowsVpnProfile) return 'Windows VPN profile is required.';
  if (proxyModeUsesManualEndpoint(proxy.mode) && !proxy.host) return 'Proxy host is required.';
  if (proxyModeUsesManualEndpoint(proxy.mode) && !(Number(proxy.port || 0) > 0)) return 'Proxy port is required.';
  return null;
}

function normalizeWindowsVpnProfilesOutput(stdout = '') {
  const raw = String(stdout || '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((profile) => ({
      name: String(profile?.Name || profile?.name || '').trim(),
      connected: String(profile?.ConnectionStatus || profile?.connectionStatus || '').trim().toLowerCase() === 'connected'
    }))
    .filter((profile) => profile.name);
}

async function listWindowsVpnProfiles() {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-VpnConnection | Select-Object Name, ConnectionStatus | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    return normalizeWindowsVpnProfilesOutput(stdout);
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || '').trim();
    if (/cannot find/i.test(detail) || /no msft_vpnconnection/i.test(detail)) return [];
    throw new Error(detail ? `Could not load Windows VPN profiles. ${detail}` : 'Could not load Windows VPN profiles.');
  }
}

async function connectWindowsVpnProfile(profileName) {
  const name = String(profileName || '').trim();
  if (!name) throw new Error('Windows VPN profile is required.');
  try {
    await execFileAsync('rasdial.exe', [name], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const detail = `${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`.trim();
    if (/already connected/i.test(detail)) return;
    throw new Error(detail ? `Could not connect Windows VPN profile "${name}". ${detail}` : `Could not connect Windows VPN profile "${name}".`);
  }
}

async function disconnectWindowsVpnProfile(profileName) {
  const name = String(profileName || '').trim();
  if (!name) return;
  try {
    await execFileAsync('rasdial.exe', [name, '/disconnect'], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const detail = `${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`.trim();
    if (/no connections/i.test(detail) || /could not find/i.test(detail)) return;
    throw new Error(detail ? `Could not disconnect Windows VPN profile "${name}". ${detail}` : `Could not disconnect Windows VPN profile "${name}".`);
  }
}

async function acquireWindowsVpnProfile(profileName) {
  const name = String(profileName || '').trim();
  if (!name) throw new Error('Windows VPN profile is required.');
  const key = name.toLowerCase();
  const active = activeWindowsVpnProfiles.get(key);
  if (active) {
    active.count += 1;
    return {
      profileName: active.profileName,
      async release() {
        await releaseWindowsVpnProfileLease(key);
      }
    };
  }

  const profiles = await listWindowsVpnProfiles();
  const profile = profiles.find((item) => item.name.toLowerCase() === key);
  if (!profile) throw new Error(`Windows VPN profile "${name}" was not found on this device.`);
  if (!profile.connected) await connectWindowsVpnProfile(profile.name);

  activeWindowsVpnProfiles.set(key, {
    profileName: profile.name,
    count: 1,
    connectedByApp: !profile.connected
  });

  return {
    profileName: profile.name,
    async release() {
      await releaseWindowsVpnProfileLease(key);
    }
  };
}

async function releaseWindowsVpnProfileLease(key) {
  const active = activeWindowsVpnProfiles.get(key);
  if (!active) return;
  active.count -= 1;
  if (active.count > 0) return;
  activeWindowsVpnProfiles.delete(key);
  if (active.connectedByApp) await disconnectWindowsVpnProfile(active.profileName).catch(() => {});
}

async function releaseAllVncNetworkSessions() {
  const sessions = [...activeVncNetworkSessions.values()];
  activeVncNetworkSessions.clear();
  await Promise.all(sessions.map((networkAccess) => networkAccess?.release?.().catch(() => {})));
}

async function releaseAllWindowsVpnProfiles() {
  const profiles = [...activeWindowsVpnProfiles.values()];
  activeWindowsVpnProfiles.clear();
  await Promise.all(
    profiles.map((profile) => (profile?.connectedByApp ? disconnectWindowsVpnProfile(profile.profileName).catch(() => {}) : Promise.resolve()))
  );
}

function onceAsync(fn) {
  let settled = false;
  return async () => {
    if (settled) return;
    settled = true;
    await fn();
  };
}

function createConnectedSocket(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port || 0) });
    const cleanup = () => {
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
    };
    const onConnect = () => {
      cleanup();
      socket.setTimeout(0);
      socket.setNoDelay(true);
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}.`));
    };
    socket.setTimeout(20000);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function readSocketUntil(socket, matcher) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('end', onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Proxy connection closed before the handshake completed.'));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const match = matcher(buffer);
      if (!match) return;
      cleanup();
      if (buffer.length > match.consume) socket.unshift(buffer.subarray(match.consume));
      resolve(buffer.subarray(0, match.consume));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('end', onClose);
  });
}

function socksReplyMessage(code) {
  return {
    0x01: 'general SOCKS failure',
    0x02: 'connection blocked by ruleset',
    0x03: 'network unreachable',
    0x04: 'host unreachable',
    0x05: 'connection refused',
    0x06: 'TTL expired',
    0x07: 'command not supported',
    0x08: 'address type not supported'
  }[code] || `SOCKS server replied with code ${code}`;
}

async function openSocks5Socket(proxy, targetHost, targetPort) {
  const socket = await createConnectedSocket(proxy.host, proxy.port);
  try {
    const methods = proxy.username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const methodReply = await readSocketUntil(socket, (buffer) => (buffer.length >= 2 ? { consume: 2 } : null));
    if (methodReply[0] !== 0x05) throw new Error('SOCKS5 proxy returned an invalid handshake response.');
    if (methodReply[1] === 0xFF) throw new Error('SOCKS5 proxy rejected all authentication methods.');

    if (methodReply[1] === 0x02) {
      const username = Buffer.from(proxy.username || '', 'utf8');
      const password = Buffer.from(proxy.password || '', 'utf8');
      socket.write(Buffer.concat([
        Buffer.from([0x01, username.length]),
        username,
        Buffer.from([password.length]),
        password
      ]));
      const authReply = await readSocketUntil(socket, (buffer) => (buffer.length >= 2 ? { consume: 2 } : null));
      if (authReply[1] !== 0x00) throw new Error('SOCKS5 proxy authentication failed.');
    }

    const hostBytes = Buffer.from(String(targetHost || ''), 'utf8');
    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(Number(targetPort || 0), 0);
    socket.write(Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
      hostBytes,
      portBytes
    ]));

    const reply = await readSocketUntil(socket, (buffer) => {
      if (buffer.length < 5) return null;
      let replyLength = 0;
      if (buffer[3] === 0x01) replyLength = 10;
      else if (buffer[3] === 0x03) replyLength = 7 + buffer[4];
      else if (buffer[3] === 0x04) replyLength = 22;
      else return { consume: buffer.length };
      return buffer.length >= replyLength ? { consume: replyLength } : null;
    });
    if (reply[1] !== 0x00) throw new Error(`SOCKS5 proxy could not reach ${targetHost}:${targetPort} because ${socksReplyMessage(reply[1])}.`);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function openHttpConnectSocket(proxy, targetHost, targetPort) {
  const socket = await createConnectedSocket(proxy.host, proxy.port);
  try {
    const headers = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`
    ];
    if (proxy.username) {
      const credentials = Buffer.from(`${proxy.username}:${proxy.password || ''}`, 'utf8').toString('base64');
      headers.push(`Proxy-Authorization: Basic ${credentials}`);
    }
    headers.push('', '');
    socket.write(headers.join('\r\n'));
    const response = await readSocketUntil(socket, (buffer) => {
      const boundary = buffer.indexOf('\r\n\r\n');
      return boundary >= 0 ? { consume: boundary + 4 } : null;
    });
    const statusLine = response.toString('utf8').split('\r\n')[0] || '';
    const statusCode = Number(statusLine.split(' ')[1] || 0);
    if (statusCode !== 200) throw new Error(`HTTP proxy tunnel failed with ${statusLine || 'an unknown response'}.`);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function prepareProjectNetworkAccess(project, { targetHost, targetPort, protocol = 'ssh' } = {}) {
  const proxy = normalizeProjectProxy(project?.proxy || {});
  if (proxy.mode === 'none') return { sock: null, release: async () => {} };
  if (proxy.mode === 'windows-vpn') {
    const lease = await acquireWindowsVpnProfile(proxy.windowsVpnProfile);
    return {
      sock: null,
      release: onceAsync(async () => {
        await lease.release();
      })
    };
  }
  if (['rdp', 'vnc'].includes(protocol)) {
    throw new Error(`${protocol.toUpperCase()} currently supports only direct access or a Windows VPN profile.`);
  }

  const sock = proxy.mode === 'socks5'
    ? await openSocks5Socket(proxy, targetHost, targetPort)
    : await openHttpConnectSocket(proxy, targetHost, targetPort);

  return {
    sock,
    release: onceAsync(async () => {
      if (!sock.destroyed) sock.destroy();
    })
  };
}

async function connectClientWithProjectRoute(connection, project, config, { protocol = 'ssh' } = {}) {
  const networkAccess = await prepareProjectNetworkAccess(project, {
    targetHost: config.host,
    targetPort: config.port,
    protocol
  });
  try {
    connection.connect(networkAccess.sock ? { ...config, sock: networkAccess.sock } : config);
  } catch (error) {
    await networkAccess.release();
    throw error;
  }
  return networkAccess;
}

function normalizedConnectionPort(value, fallback = 0) {
  const port = Number(value || 0);
  if (!Number.isFinite(port) || port <= 0) return Number(fallback || 0);
  return port;
}

function isPlainFtpPort(value) {
  const port = normalizedConnectionPort(value, 0);
  return port === 21;
}

function toFtpConnectionConfig(project) {
  const ssh = project.ssh || {};
  const ftp = project.ftp || {};
  const sshPort = normalizedConnectionPort(ssh.port, 22) || 22;
  const ftpPort = normalizedConnectionPort(ftp.port, 0);
  const plainFtpEndpoint = isPlainFtpPort(ftpPort);
  const hasFtpKey = String(ftp.privateKey || '').trim() !== '';
  const hasFtpPassword = String(ftp.password || '').trim() !== '';
  const hasSshKey = String(ssh.privateKey || '').trim() !== '';
  const hasSshPassword = String(ssh.password || '').trim() !== '';
  let authType = ssh.authType || 'password';

  if (plainFtpEndpoint) {
    return {
      protocol: 'ftp',
      host: String(ftp.host || '').trim(),
      port: ftpPort || 21,
      user: String(ftp.username || '').trim(),
      password: String(ftp.password || ''),
      secure: false
    };
  }

  if (ftp.authType === 'key') authType = hasFtpKey || hasSshKey ? 'key' : hasSshPassword ? 'password' : 'key';
  else if (ftp.authType === 'password') authType = hasFtpPassword || hasSshPassword ? 'password' : hasSshKey ? 'key' : 'password';
  else if (hasFtpKey) authType = 'key';
  else if (hasFtpPassword) authType = 'password';

  const config = {
    protocol: 'sftp',
    host: ftp.host || ssh.host,
    port: ftpPort || sshPort || 22,
    username: ftp.username || ssh.username,
    readyTimeout: Number(ssh.timeout || 20000)
  };

  if (authType === 'key') {
    config.privateKey = ftp.privateKey || ssh.privateKey;
    if (ftp.passphrase || ssh.passphrase) {
      config.passphrase = ftp.passphrase || ssh.passphrase;
    }
  } else {
    config.password = ftp.password || ssh.password;
  }

  return config;
}

function normalizeFtpConnectionError(error, project, config = {}) {
  const message = String(error?.message || '').trim();
  const handshakeTimeout = error?.level === 'client-timeout' || /timed out while waiting for handshake/i.test(message);
  if (!handshakeTimeout) return error;

  const host = String(config.host || project?.ssh?.host || project?.ftp?.host || '').trim();
  const port = normalizedConnectionPort(config.port, 22) || 22;
  return Object.assign(
    new Error(`Could not reach the SSH/SFTP service at ${host || 'the saved server'}:${port}. Check that SSH is reachable and that the saved file-transfer endpoint is an SFTP server.`),
    { code: 'SFTP_CONNECTION_TIMEOUT', cause: error }
  );
}

function normalizeTerminalConnectionError(error, project, config = {}) {
  const rawMessage = String(error?.message || error || '').trim();
  const message = rawMessage || 'The SSH connection failed without a diagnostic message.';
  const host = String(config.host || project?.ssh?.host || '').trim();
  const port = normalizedConnectionPort(config.port, 22) || 22;
  const username = String(config.username || project?.ssh?.username || '').trim();
  const endpoint = host ? `${host}:${port}` : 'the saved server';
  const lowerMessage = message.toLowerCase();
  let detail = message;

  if (
    error?.code === 'ETIMEDOUT'
    || error?.level === 'client-timeout'
    || /timed out|timeout|handshake/i.test(lowerMessage)
  ) {
    detail = `SSH connection timed out while connecting to ${endpoint}. Check that the server is online, the SSH service is running, and port ${port} is reachable.`;
  } else if (error?.code === 'ECONNREFUSED' || /econnrefused|connection refused/i.test(lowerMessage)) {
    detail = `SSH connection was refused by ${endpoint}. Check that the SSH service is running and listening on port ${port}.`;
  } else if (['ENOTFOUND', 'EAI_AGAIN'].includes(error?.code) || /enotfound|eai_again|getaddrinfo/i.test(lowerMessage)) {
    detail = `The SSH host "${host || 'saved server'}" could not be resolved. Check the hostname or IP address.`;
  } else if (
    /authentication|auth method|permission denied|password.*fail|all configured authentication methods failed/i.test(lowerMessage)
  ) {
    detail = `SSH authentication failed${username ? ` for user "${username}"` : ''} on ${endpoint}. Check the username, password, or private key.`;
  } else if (/enetunreach|ehostunreach|network is unreachable|host is unreachable/i.test(lowerMessage)) {
    detail = `The network could not reach SSH host ${endpoint}. Check the server address, VPN, proxy, and firewall rules.`;
  } else if (!/^ssh\s+connection\s+failed\b/i.test(message)) {
    detail = `SSH connection failed for ${endpoint}: ${message}`;
  }

  return Object.assign(new Error(detail), {
    code: error?.code || 'SSH_CONNECTION_FAILED',
    cause: error
  });
}

function validateProject(project) {
  const connectionError = validateConnectionProject(project, { requireSsh: true });
  if (connectionError) return connectionError;
  if (!Array.isArray(project.commands) || project.commands.length === 0) {
    return 'At least one command is required.';
  }
  return null;
}

function projectHasSshDetails(project = {}) {
  const ssh = project.ssh || {};
  const users = Array.isArray(ssh.users) ? ssh.users : [];
  return Boolean(
    String(ssh.host || '').trim()
    || String(ssh.password || '').length
    || String(ssh.privateKey || '').trim()
    || String(ssh.passphrase || '').length
    || ssh.authType === 'key'
    || users.length > 1
    || !['', 'root'].includes(String(ssh.username || '').trim().toLowerCase())
  );
}

function projectHasFtpDetails(project = {}) {
  const ftp = project.ftp || {};
  return ['host', 'username', 'authType', 'password', 'privateKey', 'passphrase'].some(
    (field) => String(ftp[field] || '').trim() !== ''
  );
}

function validateConnectionProject(project, { requireSsh = false } = {}) {
  const proxyError = projectProxyValidationError(project);
  if (proxyError) return proxyError;
  if (['vnc', 'rdp'].includes(project?.serverType)) {
    const protocol = project.serverType === 'rdp' ? 'RDP' : 'VNC';
    const connection = protocol === 'RDP' ? project.rdp || {} : project.vnc || {};
    if (!project.name) return 'Server Name is required.';
    if (!connection.host) return `${protocol} server or IP is required.`;
    if (protocol === 'RDP' && !connection.username) return 'RDP username is required.';
    if (!connection.password) return `${protocol} password is required.`;
    return null;
  }
  const ssh = project.ssh || {};
  const ftp = project.ftp || {};
  const hasSsh = projectHasSshDetails(project);
  const hasFtp = projectHasFtpDetails(project);
  if (!project.name) return 'Server Name is required.';
  if (requireSsh && !hasSsh) return 'This feature requires an SSH connection for the server.';
  if (!hasSsh && !hasFtp) return 'Configure an SSH or FTP connection for the server.';
  if (!hasSsh) {
    if (!ftp.host) return 'FTP host is required for an FTP-only server.';
    if (!ftp.username) return 'FTP username is required for an FTP-only server.';
    const ftpAuthType = ftp.authType === 'key' ? 'key' : ftp.authType === 'password' ? 'password' : ftp.privateKey ? 'key' : ftp.password ? 'password' : '';
    if (!ftpAuthType) return 'FTP authentication is required for an FTP-only server.';
    if (isPlainFtpPort(ftp.port) && ftpAuthType !== 'password') return 'Plain FTP requires password authentication.';
    if (ftpAuthType === 'key' && !ftp.privateKey) return 'FTP private key is required.';
    if (ftpAuthType !== 'key' && !ftp.password) return 'FTP password is required.';
    return null;
  }
  if (!ssh.host) return 'Server host is required.';
  if (!ssh.username) return 'SSH username is required.';
  if (ssh.authType === 'key' && !ssh.privateKey) return 'SSH private key is required.';
  if (ssh.authType !== 'key' && !ssh.password) return 'SSH password is required.';
  if (requireSsh) return null;
  if (hasFtp && ftp.authType === 'key' && !ftp.privateKey) return 'FTP private key is required.';
  if (hasFtp && isPlainFtpPort(ftp.port) && ftp.authType !== 'password') return 'Plain FTP requires password authentication.';
  if (hasFtp && ftp.authType === 'password' && !ftp.password) return 'FTP password is required.';
  return null;
}

function extractTemplateVariables(commands = []) {
  const variables = new Set();
  for (const command of commands) {
    const matches = String(command).matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g);
    for (const match of matches) variables.add(match[1]);
  }
  return [...variables];
}

function normalizeProjectSsh(ssh = {}) {
  const sourceUsers = Array.isArray(ssh.users) && ssh.users.length
    ? ssh.users
    : [{
        id: ssh.defaultUserId || 'ssh-user-1',
        username: ssh.username || '',
        authType: ssh.authType,
        password: ssh.password,
        privateKey: ssh.privateKey,
        passphrase: ssh.passphrase
      }];
  const usedIds = new Set();
  const users = sourceUsers.map((user = {}, index) => {
    let id = String(user.id || `ssh-user-${index + 1}`).trim() || `ssh-user-${index + 1}`;
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    return {
      id,
      username: String(user.username || '').trim(),
      authType: user.authType === 'key' ? 'key' : 'password',
      password: String(user.password || ''),
      privateKey: String(user.privateKey || ''),
      passphrase: String(user.passphrase || '')
    };
  });
  const requestedDefaultId = String(ssh.defaultUserId || '').trim();
  const defaultUser = users.find((user) => user.id === requestedDefaultId) || users[0];
  return {
    host: String(ssh.host || '').trim(),
    port: Number(ssh.port || 22),
    username: defaultUser.username,
    authType: defaultUser.authType,
    password: defaultUser.password,
    privateKey: defaultUser.privateKey,
    passphrase: defaultUser.passphrase,
    timeout: Number(ssh.timeout || 20000),
    users,
    defaultUserId: defaultUser.id
  };
}

function normalizeProjectFtp(ftp = {}) {
  const sourceUsers = Array.isArray(ftp.users) && ftp.users.length
    ? ftp.users
    : [{
        id: ftp.defaultUserId || 'ftp-user-1',
        username: ftp.username || '',
        authType: ftp.authType || '',
        password: ftp.password || '',
        privateKey: ftp.privateKey || '',
        passphrase: ftp.passphrase || ''
      }];
  const usedIds = new Set();
  const users = sourceUsers.map((user = {}, index) => {
    let id = String(user.id || `ftp-user-${index + 1}`).trim() || `ftp-user-${index + 1}`;
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    return {
      id,
      username: String(user.username || '').trim(),
      authType: user.authType === 'key' ? 'key' : user.authType === 'password' ? 'password' : user.privateKey ? 'key' : user.password ? 'password' : '',
      password: String(user.password || ''),
      privateKey: String(user.privateKey || ''),
      passphrase: String(user.passphrase || '')
    };
  });
  const requestedDefaultId = String(ftp.defaultUserId || '').trim();
  const defaultUser = users.find((user) => user.id === requestedDefaultId) || users[0];
  return {
    host: String(ftp.host || '').trim(),
    port: ftp.port === '' || ftp.port == null ? '' : Number(ftp.port || 22),
    username: defaultUser.username,
    authType: defaultUser.authType,
    password: defaultUser.password,
    privateKey: defaultUser.privateKey,
    passphrase: defaultUser.passphrase,
    users,
    defaultUserId: defaultUser.id
  };
}

function normalizeProjectImport(project) {
  const commands = Array.isArray(project?.commands)
    ? project.commands.map((command) => String(command)).filter((command) => command.trim())
    : typeof project?.commands === 'string'
      ? project.commands
          .split('\n')
          .map((command) => command.trim())
          .filter(Boolean)
      : [];
  const ssh = project?.ssh || {};
  const proxy = project?.proxy || {};
  const vnc = project?.vnc || {};
  const rdp = project?.rdp || {};
  const ftp = project?.ftp || {};

  return {
    ...project,
    id: project?.id ? String(project.id) : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: String(project?.name || 'Imported server').trim() || 'Imported server',
    group: String(project?.group || '').trim(),
    pinned: Boolean(project?.pinned),
    serverType: ['rdp', 'vnc'].includes(project?.serverType) ? project.serverType : project?.serverType || 'ubuntu',
    commands,
    uptimeMonitors: normalizeUptimeMonitors(project?.uptimeMonitors),
    variables: project?.variables && typeof project.variables === 'object' ? project.variables : {},
    proxy: normalizeProjectProxy(proxy),
    ssh: normalizeProjectSsh(ssh),
    rdp: {
      host: rdp.host || '',
      port: Number(rdp.port || 3389),
      username: rdp.username || '',
      domain: rdp.domain || '',
      password: rdp.password || ''
    },
    vnc: {
      host: vnc.host || '',
      port: Number(vnc.port || 5900),
      username: vnc.username || '',
      password: vnc.password || ''
    },
    ftp: normalizeProjectFtp(ftp),
    updatedAt: new Date().toISOString()
  };
}

function readProjectImportFile(raw) {
  const parsed = JSON.parse(raw);
  const projects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(projects)) throw new Error('Import file must contain servers.');
  return projects.map(normalizeProjectImport).filter((project) => project.name);
}

function normalizeTemplateImport(template) {
  const commands = Array.isArray(template?.commands)
    ? template.commands.map((command) => String(command)).filter((command) => command.trim())
    : typeof template?.commands === 'string'
      ? template.commands
          .split('\n')
          .map((command) => command.trim())
          .filter(Boolean)
    : [];
  const variables =
    Array.isArray(template?.variables) && template.variables.length
      ? template.variables.map((variable) => String(variable))
      : extractTemplateVariables(commands);

  return {
    ...template,
    id: template?.id ? String(template.id) : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: String(template?.name || 'Imported template').trim() || 'Imported template',
    category: normalizeTemplateCategory(template?.category),
    commands,
    variables,
    updatedAt: new Date().toISOString()
  };
}

function readTemplateImportFile(raw) {
  const parsed = JSON.parse(raw);
  const templates = Array.isArray(parsed) ? parsed : parsed.templates;
  if (!Array.isArray(templates)) throw new Error('Import file must contain templates.');
  return templates.map(normalizeTemplateImport).filter((template) => template.commands.length).map(normalizeStoredTemplate);
}

function readAccountImportFile(raw) {
  const parsed = JSON.parse(raw);
  const projects = Array.isArray(parsed?.projects) ? parsed.projects.map(normalizeProjectImport) : [];
  const templates = Array.isArray(parsed?.templates) ? parsed.templates.map(normalizeTemplateImport) : [];

  if (!projects.length && !templates.length) {
    throw new Error('Import file must contain servers or templates.');
  }

  return {
    projects: projects.filter((project) => project.name),
    templates: templates.filter((template) => template.commands.length).map(normalizeStoredTemplate)
  };
}

function importNameKey(item) {
  return String(item?.name || '').trim().toLowerCase();
}

function duplicateNames(existingItems, importedItems) {
  const existingNames = new Set(existingItems.map(importNameKey).filter(Boolean));
  const importedNameCounts = new Map();
  for (const item of importedItems) {
    const key = importNameKey(item);
    if (key) importedNameCounts.set(key, (importedNameCounts.get(key) || 0) + 1);
  }

  const names = importedItems
    .filter((item) => {
      const key = importNameKey(item);
      return key && (existingNames.has(key) || importedNameCounts.get(key) > 1);
    })
    .map((item) => String(item.name || '').trim())
    .filter(Boolean);

  return [...new Set(names)];
}

async function shouldReplaceDuplicateNames(itemLabel, names) {
  if (!names.length) return false;

  const preview = names.slice(0, 8).map((name) => `- ${name}`).join('\n');
  const overflow = names.length > 8 ? `\n- and ${names.length - 8} more` : '';
  return requestInAppConfirmation({
    message: `${names.length} duplicate ${itemLabel} name${names.length === 1 ? '' : 's'} found`,
    detail: `Replace will overwrite the duplicate ${itemLabel}${names.length === 1 ? '' : 's'}. Cancel will skip only these duplicates and import the rest.\n\n${preview}${overflow}`,
    confirmLabel: 'Replace'
  });
}

async function mergeImportsByName(existingItems, importedItems, itemLabel, normalizeItem = (item) => item) {
  const items = [...existingItems];
  const duplicates = duplicateNames(items, importedItems);
  const replaceDuplicates = await shouldReplaceDuplicateNames(itemLabel, duplicates);
  const stats = { added: 0, replaced: 0, skipped: 0, duplicates: duplicates.length };

  for (const importedItem of importedItems) {
    const item = normalizeItem(importedItem);
    const name = importNameKey(item);
    const nameIndex = items.findIndex((existingItem) => importNameKey(existingItem) === name);

    if (nameIndex >= 0) {
      if (!replaceDuplicates) {
        stats.skipped += 1;
        continue;
      }
      items[nameIndex] = item;
      stats.replaced += 1;
      continue;
    }

    const idIndex = item.id ? items.findIndex((existingItem) => String(existingItem.id) === String(item.id)) : -1;
    if (idIndex >= 0) {
      items[idIndex] = item;
      stats.replaced += 1;
    } else {
      items.unshift(item);
      stats.added += 1;
    }
  }

  return { items, stats };
}

function emitDeployment(runId, type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deployment:event', { runId, type, payload });
  }
}

function emitTerminal(sessionId, type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:event', { sessionId, type, payload });
  }
}

function runCommand(connection, command, runId, deploymentState) {
  return new Promise((resolve, reject) => {
    emitDeployment(runId, 'log', `$ ${command}\n`);
    connection.exec(command, { pty: true }, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      deploymentState.currentStream = stream;
      stream.on('close', (code) => {
        deploymentState.currentStream = null;
        if (deploymentState.stopped) {
          reject(new Error('Deployment stopped.'));
          return;
        }

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command exited with code ${code}: ${command}`));
        }
      });

      stream.on('data', (data) => emitDeployment(runId, 'log', data.toString()));
      stream.stderr.on('data', (data) => emitDeployment(runId, 'error', data.toString()));
    });
  });
}

function uploadFile(connection, upload, runId) {
  return new Promise((resolve, reject) => {
    connection.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }

      emitDeployment(runId, 'log', `Uploading ${upload.localPath} to ${upload.remotePath}\n`);
      sftp.fastPut(upload.localPath, upload.remotePath, (uploadError) => {
        if (uploadError) {
          reject(uploadError);
          return;
        }

        emitDeployment(runId, 'log', `Upload completed: ${upload.remotePath}\n`);
        resolve();
      });
    });
  });
}

async function executeDeployment(project, upload, runId) {
  const validationError = validateProject(project);
  if (validationError) throw new Error(validationError);

  const connection = new Client();
  const deploymentState = { connection, currentStream: null, stopped: false, networkAccess: null };
  activeDeployments.set(runId, deploymentState);

  try {
    deploymentState.networkAccess = await connectClientWithProjectRoute(connection, project, toConnectionConfig(project), { protocol: 'ssh' });
  } catch (error) {
    activeDeployments.delete(runId);
    throw error;
  }

  return new Promise((resolve, reject) => {
    connection.on('ready', async () => {
      emitDeployment(runId, 'log', 'SSH connected.\n');
      try {
        if (upload && upload.localPath && upload.remotePath) {
          await uploadFile(connection, upload, runId);
        }

        for (const command of project.commands) {
          if (deploymentState.stopped) throw new Error('Deployment stopped.');
          if (command.trim()) await runCommand(connection, command.trim(), runId, deploymentState);
        }

        emitDeployment(runId, 'done', 'Deployment completed.');
        activeDeployments.delete(runId);
        connection.end();
        resolve();
      } catch (error) {
        emitDeployment(runId, 'failed', error.message);
        activeDeployments.delete(runId);
        connection.end();
        reject(error);
      }
    });

    connection.on('error', (error) => {
      emitDeployment(runId, 'failed', error.message);
      activeDeployments.delete(runId);
      deploymentState.networkAccess?.release().catch(() => {});
      reject(error);
    });

    connection.on('close', () => {
      activeDeployments.delete(runId);
      deploymentState.networkAccess?.release().catch(() => {});
    });
  });
}

function emitMcpTerminal(project, type, payload, sessionId = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('mcp-terminal:event', {
    sessionId,
    projectId: String(project?.id || ''),
    projectName: String(project?.name || 'Server'),
    type,
    payload
  });
}

function mcpConnectionEntries(projectId, create = false) {
  const id = String(projectId || '');
  let entries = mcpSshConnections.get(id);
  if (!entries && create) {
    entries = new Set();
    mcpSshConnections.set(id, entries);
  }
  return entries || null;
}

function removeMcpConnectionEntry(projectId, entry) {
  const entries = mcpConnectionEntries(projectId);
  if (!entries) return;
  entries.delete(entry);
  if (!entries.size) mcpSshConnections.delete(String(projectId || ''));
}

function releaseMcpConnectionEntry(entry) {
  if (!entry || entry.busy < 1) return;
  entry.busy -= 1;
}

function reusableSshConnection(projectId) {
  const id = String(projectId || '');
  const terminal = [...activeTerminals.entries()].find(([, entry]) => entry.projectId === id && entry.connection && entry.stream && !entry.mcpBusy);
  if (terminal) {
    terminal[1].mcpBusy = 1;
    return { connection: terminal[1].connection, reused: true, terminalSessionId: terminal[0], terminalEntry: terminal[1] };
  }
  const managed = [...(mcpConnectionEntries(id) || [])].find((entry) => entry.ready && entry.connection && entry.busy === 0);
  if (managed) {
    managed.busy = 1;
    return { connection: managed.connection, reused: true, terminalSessionId: '', entry: managed };
  }
  return null;
}

async function managedMcpSshConnection(project) {
  const projectId = String(project.id || '');
  const reusable = reusableSshConnection(projectId);
  if (reusable) return reusable;

  const connection = new Client();
  const entry = { connection, networkAccess: null, ready: false, promise: null, busy: 1 };
  const entries = mcpConnectionEntries(projectId, true);
  entries.add(entry);
  const promise = new Promise(async (resolve, reject) => {
    let opening = true;
    const fail = (error) => {
      removeMcpConnectionEntry(projectId, entry);
      entry.networkAccess?.release().catch(() => {});
      connection.end();
      if (opening) reject(error);
      else emitMcpTerminal(project, 'connection-error', String(error?.message || error));
    };
    connection.once('ready', () => {
      opening = false;
      entry.ready = true;
      resolve({ connection, reused: false, terminalSessionId: '', entry });
    });
    connection.on('error', fail);
    connection.on('close', () => {
      removeMcpConnectionEntry(projectId, entry);
      entry.networkAccess?.release().catch(() => {});
    });
    try {
      entry.networkAccess = await connectClientWithProjectRoute(connection, project, toConnectionConfig(project), { protocol: 'ssh' });
    } catch (error) {
      fail(error);
    }
  });
  entry.promise = promise;
  return promise;
}

function appendMcpCommandOutput(chunks, data, currentBytes) {
  const buffer = Buffer.from(data);
  const remaining = Math.max(0, 1024 * 1024 - currentBytes);
  if (remaining) chunks.push(buffer.subarray(0, remaining));
  return currentBytes + buffer.length;
}

async function executeManagedMcpSshCommand(project, command, timeoutMs, { onOutput } = {}) {
  const validationError = validateConnectionProject(project, { requireSsh: true });
  if (validationError) throw new Error(validationError);
  const { connection, reused, terminalSessionId, entry, terminalEntry } = await managedMcpSshConnection(project);
  const sessionId = `mcp-${Date.now()}-${crypto.randomUUID()}`;
  const mirror = (type, payload) => {
    if (terminalSessionId) emitTerminal(terminalSessionId, type, payload);
    else emitMcpTerminal(project, type, payload, sessionId);
  };
  mirror('started', { command, reusedConnection: reused });
  mirror('log', `\r\n\x1b[36m[MCP Agent]\x1b[0m $ ${command}\r\n`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let stream;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseMcpConnectionEntry(entry);
      if (terminalEntry) terminalEntry.mcpBusy = Math.max(0, Number(terminalEntry.mcpBusy || 0) - 1);
      if (error) {
        if (terminalSessionId) {
          mirror('error', `\r\n\x1b[31m[MCP Agent]\x1b[0m ${String(error?.message || error)}\r\n`);
        } else {
          mirror('failed', String(error?.message || error));
        }
        reject(error);
      } else {
        mirror('completed', { exitCode: result.exit_code, signal: result.signal });
        mirror('log', `\r\n\x1b[36m[MCP Agent]\x1b[0m command finished with exit code ${result.exit_code ?? 'unknown'}.\r\n`);
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      stream?.close?.();
      finish(new Error(`SSH command timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    connection.exec(command, (error, channel) => {
      if (error) return finish(error);
      stream = channel;
      channel.on('data', (data) => {
        const text = data.toString();
        stdoutBytes = appendMcpCommandOutput(stdout, data, stdoutBytes);
        mirror('log', text);
        onOutput?.('stdout', text);
      });
      channel.stderr?.on('data', (data) => {
        const text = data.toString();
        stderrBytes = appendMcpCommandOutput(stderr, data, stderrBytes);
        mirror('error', text);
        onOutput?.('stderr', text);
      });
      channel.on('close', (exitCode, signal) => finish(null, {
        exit_code: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout_truncated: stdoutBytes > 1024 * 1024,
        stderr_truncated: stderrBytes > 1024 * 1024,
        connection_reused: reused,
        live_session_id: sessionId
      }));
      channel.on('error', finish);
    });
  });
}

function quoteTerminalShellPath(remotePath) {
  return `'${String(remotePath || '').replace(/'/g, `'\\''`)}'`;
}

async function startTerminal(project, sessionId, size = {}) {
  const validationError = validateConnectionProject(project, { requireSsh: true });
  if (validationError) throw new Error(validationError);

  const connection = new Client();
  const connectionConfig = toConnectionConfig(project);
  const terminalState = { connection, stream: null, projectId: String(project.id || ''), networkAccess: null, sftpUnavailable: false };
  activeTerminals.set(sessionId, terminalState);

  try {
    terminalState.networkAccess = await connectClientWithProjectRoute(connection, project, connectionConfig, { protocol: 'ssh' });
  } catch (error) {
    activeTerminals.delete(sessionId);
    throw normalizeTerminalConnectionError(error, project, connectionConfig);
  }

  connection.on('ready', () => {
    emitTerminal(sessionId, 'log', 'SSH connected.\r\n');
    const cols = Math.max(Number(size.cols || 120), 80);
    const rows = Math.max(Number(size.rows || 34), 24);
    const width = cols * 9;
    const height = rows * 18;
    connection.shell(
      {
        term: 'xterm-256color',
        cols,
        rows,
        width,
        height
      },
      (error, stream) => {
        if (error) {
          emitTerminal(sessionId, 'failed', normalizeTerminalConnectionError(error, project, connectionConfig).message);
          activeTerminals.delete(sessionId);
          connection.end();
          return;
        }

        terminalState.stream = stream;
        const startupMarker = '\x1b]1337;DeployerXReady\x07';
        let startupOutput = '';
        let startupComplete = false;
        let startupTimer;
        const emitStartupOutput = (type, data) => {
          const text = data.toString();
          if (startupComplete) {
            emitTerminal(sessionId, type, text);
            return;
          }
          startupOutput += text;
          const markerIndex = startupOutput.indexOf(startupMarker);
          if (markerIndex < 0) return;
          startupComplete = true;
          clearTimeout(startupTimer);
          const visibleOutput = startupOutput.slice(markerIndex + startupMarker.length);
          startupOutput = '';
          if (visibleOutput) emitTerminal(sessionId, type, visibleOutput);
        };
        startupTimer = setTimeout(() => {
          if (startupComplete) return;
          startupComplete = true;
          emitTerminal(sessionId, 'log', startupOutput);
          startupOutput = '';
        }, 5000);
        startupTimer.unref?.();
        stream.on('data', (data) => emitStartupOutput('log', data));
        if (stream.stderr) {
          stream.stderr.on('data', (data) => emitStartupOutput('error', data));
        }
        stream.on('close', () => {
          clearTimeout(startupTimer);
          emitTerminal(sessionId, 'closed', 'Terminal closed.');
          serverMonitoringSessionManager.stopByConnection(connection);
          activeTerminals.delete(sessionId);
          connection.end();
        });

        const promptDirectoryTracking = "if [ -n \"$BASH_VERSION\" ]; then PS1='\\[\\e]1337;DeployerXPwd=$PWD\\a\\]'\"$PS1\"; fi";
        const completionCaseHandling = "if [ -n \"$BASH_VERSION\" ]; then bind 'set completion-ignore-case on'; fi";
        const startupDirectory = String(size.startupDirectory || '').trim();
        const changeDirectory = startupDirectory ? `cd -- ${quoteTerminalShellPath(startupDirectory)}; ` : '';
        stream.write(`stty sane cols ${cols} rows ${rows}; ${promptDirectoryTracking}; ${completionCaseHandling}; ${changeDirectory}printf '\\r\\033[1A\\033[2K\\r'; printf '\\033]1337;DeployerXReady\\a'; stty echo echonl\n`);
        emitTerminal(sessionId, 'connected', 'Terminal connected.');
      }
    );
  });

  connection.on('error', (error) => {
    emitTerminal(sessionId, 'failed', normalizeTerminalConnectionError(error, project, connectionConfig).message);
    serverMonitoringSessionManager.stopByConnection(connection);
    activeTerminals.delete(sessionId);
    terminalState.networkAccess?.release().catch(() => {});
  });

  connection.on('close', () => {
    if (activeTerminals.has(sessionId)) {
      emitTerminal(sessionId, 'closed', 'Terminal closed.');
      serverMonitoringSessionManager.stopByConnection(connection);
      activeTerminals.delete(sessionId);
    }
    terminalState.networkAccess?.release().catch(() => {});
  });
}

function resizeTerminal(sessionId, cols, rows) {
  const terminal = activeTerminals.get(sessionId);
  if (!terminal || !terminal.stream || !terminal.stream.setWindow) return false;
  const nextRows = Math.max(Number(rows || 34), 24);
  const nextCols = Math.max(Number(cols || 120), 80);
  terminal.stream.setWindow(nextRows, nextCols, nextRows * 18, nextCols * 9);
  return true;
}

function terminalSessionOrThrow(sessionId) {
  const terminal = activeTerminals.get(sessionId);
  if (!terminal?.connection) throw new Error('SSH session is not connected.');
  return terminal;
}

function execOnTerminalConnection(connection, command) {
  return new Promise((resolve, reject) => {
    connection.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let stderr = '';
      stream.on('data', (data) => {
        stdout += data.toString();
      });
      if (stream.stderr) {
        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }
      stream.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        reject(new Error(stderr.trim() || stdout.trim() || `Command exited with code ${code}.`));
      });
    });
  });
}

function normalizeRemotePath(remotePath = '.') {
  const value = String(remotePath || '.').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  return value || '.';
}

function remoteBaseName(remotePath = '') {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === '/' || normalized === '.') return '';
  return normalized.split('/').filter(Boolean).pop() || '';
}

function joinRemotePath(parentPath, childName) {
  const parent = normalizeRemotePath(parentPath);
  const child = String(childName || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  if (!child) return parent;
  if (parent === '.') return child;
  if (parent === '/') return `/${child}`;
  return `${parent.replace(/\/$/, '')}/${child}`;
}

function parentRemotePath(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === '/' || normalized === '.') return normalized;
  const absolute = normalized.startsWith('/');
  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  if (!parts.length) return absolute ? '/' : '.';
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function normalizeLocalPath(localPath = '') {
  return path.resolve(String(localPath || app.getPath('home')));
}

function localKind(dirent, filePath) {
  if (dirent.isDirectory()) return 'folder';
  const extension = path.extname(filePath).replace('.', '').toLowerCase();
  return extension || 'file';
}

function assertPlainFileName(fileName, message = 'Enter a name.') {
  const name = String(fileName || '').trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error(message);
  return name;
}

async function listLocalDirectory(localPath = '') {
  const normalizedPath = normalizeLocalPath(localPath);
  const entries = await fs.readdir(normalizedPath, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const itemPath = path.join(normalizedPath, entry.name);
      let stats = null;
      try {
        stats = await fs.stat(itemPath);
      } catch {
        stats = null;
      }

      const isDirectory = entry.isDirectory();
      return {
        name: entry.name,
        path: itemPath,
        type: isDirectory ? 'directory' : 'file',
        size: isDirectory ? 0 : Number(stats?.size || 0),
        modifiedAt: stats?.mtime ? stats.mtime.toISOString() : '',
        mode: localKind(entry, itemPath)
      };
    })
  );

  return {
    path: normalizedPath,
    parentPath: path.dirname(normalizedPath),
    items: items.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
  };
}

async function makeLocalDirectory(localDirectory, folderName) {
  const name = assertPlainFileName(folderName, 'Enter a folder name.');
  const folderPath = path.join(normalizeLocalPath(localDirectory), name);
  await fs.mkdir(folderPath);
  return { path: folderPath };
}

async function openLocalEntry(entry) {
  if (!entry?.path) throw new Error('Choose a local item to open.');
  const result = await shell.openPath(normalizeLocalPath(entry.path));
  if (result) throw new Error(result);
  return true;
}

async function openLocalEntryWith(entry) {
  if (!entry?.path) throw new Error('Choose a local item to open.');
  if (process.platform === 'win32') {
    const child = execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', normalizeLocalPath(entry.path)], {
      detached: true,
      windowsHide: false
    });
    child.unref();
    return true;
  }
  return openLocalEntry(entry);
}

async function renameLocalEntry(entry, nextName) {
  if (!entry?.path) throw new Error('Choose a local item to rename.');
  const name = assertPlainFileName(nextName);
  const currentPath = normalizeLocalPath(entry.path);
  const nextPath = path.join(path.dirname(currentPath), name);
  await fs.rename(currentPath, nextPath);
  return { path: nextPath };
}

async function deleteLocalEntry(entry) {
  if (!entry?.path) throw new Error('Choose a local item to delete.');
  const targetPath = normalizeLocalPath(entry?.path);
  const stats = await fs.stat(targetPath);
  await fs.rm(targetPath, { recursive: stats.isDirectory(), force: false });
  return true;
}

function sftpReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) reject(error);
      else resolve(list || []);
    });
  });
}

function sftpFastPut(sftp, localPath, remotePath, options = {}) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpFastGet(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpMkdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpRmdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpRename(sftp, oldPath, newPath) {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function openSftpChannel(connection) {
  return new Promise((resolve, reject) => {
    connection.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function isSftpSubsystemUnavailableError(error) {
  const message = String(error?.message || error || '');
  return Number(error?.reason) === 2
    || Number(error?.code) === 127
    || /exit code 127.*establishing SFTP session/i.test(message)
    || /SFTP subsystem.*(?:unavailable|not found|failed)/i.test(message)
    || /channel open failure:\s*open failed/i.test(message);
}

function isTerminalChannelClosedError(error) {
  const message = String(error?.message || error || '');
  return /unable to exec|no response from server|channel.*(?:closed|close)|ssh session is not connected/i.test(message);
}

function unavailableTerminalDirectory(remotePath) {
  const normalizedPath = normalizeRemotePath(remotePath);
  return {
    path: normalizedPath,
    parentPath: parentRemotePath(normalizedPath),
    items: [],
    unavailable: true,
    message: 'SFTP file browsing is unavailable on this server. Enable the SSH SFTP subsystem, then reconnect.'
  };
}

async function withTerminalSftp(sessionId, operation) {
  const { connection } = terminalSessionOrThrow(sessionId);
  const sftp = await openSftpChannel(connection);
  try {
    return await operation(sftp);
  } finally {
    try {
      sftp.end();
    } catch {}
  }
}

function sftpReadTextFile(sftp, remotePath, maximumBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const stream = sftp.createReadStream(remotePath);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    stream.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maximumBytes) {
        stream.destroy();
        finish(new Error('This file is larger than the 5 MB editor limit.'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error) => finish(error));
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.includes(0)) {
        finish(new Error('This file appears to be binary and cannot be opened in the text editor.'));
        return;
      }
      finish(null, buffer.toString('utf8'));
    });
  });
}

function sftpWriteTextFile(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath, { flags: 'w', encoding: 'utf8' });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    stream.on('error', finish);
    stream.on('close', () => finish());
    stream.end(content);
  });
}

async function sftpEnsureMkdir(sftp, remotePath) {
  try {
    await sftpMkdir(sftp, remotePath);
  } catch (error) {
    try {
      await sftpReaddir(sftp, remotePath);
    } catch {
      throw error;
    }
  }
}

async function uploadLocalPath(sftp, localPath, remoteDirectory) {
  const stats = await fs.stat(localPath);
  const remotePath = joinRemotePath(remoteDirectory || '.', path.basename(localPath));

  if (stats.isDirectory()) {
    await sftpEnsureMkdir(sftp, remotePath);
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    for (const entry of entries) {
      await uploadLocalPath(sftp, path.join(localPath, entry.name), remotePath);
    }
    return remotePath;
  }

  await sftpFastPut(sftp, localPath, remotePath);
  return remotePath;
}

async function downloadRemotePath(sftp, remotePath, entryType, localDirectory) {
  const localPath = path.join(normalizeLocalPath(localDirectory), remoteBaseName(remotePath) || 'download');

  if (entryType === 'directory') {
    await fs.mkdir(localPath, { recursive: true });
    const entries = await sftpReaddir(sftp, remotePath);
    for (const entry of entries) {
      const childPath = joinRemotePath(remotePath, entry.filename);
      const childType = entry.attrs?.isDirectory?.() ? 'directory' : 'file';
      await downloadRemotePath(sftp, childPath, childType, localPath);
    }
    return localPath;
  }

  await sftpFastGet(sftp, remotePath, localPath);
  return localPath;
}

async function deleteRemotePath(sftp, remotePath, entryType) {
  if (entryType === 'directory') {
    const entries = await sftpReaddir(sftp, remotePath);
    for (const entry of entries) {
      const childPath = joinRemotePath(remotePath, entry.filename);
      const childType = entry.attrs?.isDirectory?.() ? 'directory' : 'file';
      await deleteRemotePath(sftp, childPath, childType);
    }
    await sftpRmdir(sftp, remotePath);
    return;
  }

  await sftpUnlink(sftp, remotePath);
}

function ftpSessionOrThrow(sessionId) {
  const session = activeFtpSessions.get(sessionId);
  if (!session || (!session.sftp && !session.ftp)) throw new Error('FTP session is not connected.');
  return session;
}

async function connectPlainFtp(project, sessionId) {
  const validationError = validateConnectionProject(project);
  if (validationError) throw new Error(validationError);
  const ftp = new FtpClient(20000);
  const config = toFtpConnectionConfig(project);
  activeFtpSessions.set(sessionId, { ftp, sftp: null, connection: null, networkAccess: null });
  try {
    await ftp.access(config);
    return { sessionId, path: '/' };
  } catch (error) {
    ftp.close();
    activeFtpSessions.delete(sessionId);
    throw error;
  }
}

function connectSftp(project, sessionId) {
  const validationError = validateConnectionProject(project);
  if (validationError) throw new Error(validationError);

  const connection = new Client();
  const ftpState = { connection, sftp: null, networkAccess: null };
  activeFtpSessions.set(sessionId, ftpState);
  const config = toFtpConnectionConfig(project);

  return (async () => {
    try {
      ftpState.networkAccess = await connectClientWithProjectRoute(connection, project, config, { protocol: 'sftp' });
    } catch (error) {
      activeFtpSessions.delete(sessionId);
      throw error;
    }
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        activeFtpSessions.delete(sessionId);
        connection.end();
        ftpState.networkAccess?.release().catch(() => {});
        reject(normalizeFtpConnectionError(error, project, config));
      };

      connection.on('ready', () => {
        connection.sftp((error, sftp) => {
          if (error) {
            fail(error);
            return;
          }

          ftpState.sftp = sftp;
          resolve({ sessionId, path: '/' });
        });
      });

      connection.on('error', fail);
      connection.on('close', () => {
        activeFtpSessions.delete(sessionId);
        ftpState.networkAccess?.release().catch(() => {});
      });
    });
  })();
}

function connectFtp(project, sessionId) {
  return isPlainFtpPort(project?.ftp?.port)
    ? connectPlainFtp(project, sessionId)
    : connectSftp(project, sessionId);
}

async function listFtpDirectory(sessionId, remotePath = '/') {
  const session = ftpSessionOrThrow(sessionId);
  const normalizedPath = normalizeRemotePath(remotePath);
  if (session.ftp) {
    const items = await session.ftp.list(normalizedPath);
    return {
      path: normalizedPath,
      parentPath: parentRemotePath(normalizedPath),
      items: items.map((item) => ({
        name: item.name,
        path: joinRemotePath(normalizedPath, item.name),
        type: item.isDirectory ? 'directory' : 'file',
        size: Number(item.size || 0),
        modifiedAt: item.modifiedAt instanceof Date ? item.modifiedAt.toISOString() : '',
        mode: ''
      })).sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
    };
  }
  const { sftp } = session;
  const items = await sftpReaddir(sftp, normalizedPath);
  return {
    path: normalizedPath,
    parentPath: parentRemotePath(normalizedPath),
    items: items
      .map((item) => {
        const attrs = item.attrs || {};
        const isDirectory = Boolean(attrs.isDirectory?.());
        return {
          name: item.filename,
          path: joinRemotePath(normalizedPath, item.filename),
          type: isDirectory ? 'directory' : 'file',
          size: Number(attrs.size || 0),
          modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : '',
          mode: attrs.mode ? attrs.mode.toString(8) : ''
        };
      })
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
  };
}

async function uploadFtpFile(sessionId, localPath, remoteDirectory) {
  const session = ftpSessionOrThrow(sessionId);
  const fileName = path.basename(localPath || '');
  if (!fileName) throw new Error('Choose a local file to upload.');
  if (session.ftp) {
    const remotePath = joinRemotePath(remoteDirectory || '.', fileName);
    const stats = await fs.stat(localPath);
    if (stats.isDirectory()) await session.ftp.uploadFromDir(localPath, remotePath);
    else await session.ftp.uploadFrom(localPath, remotePath);
    return { remotePath };
  }
  const { sftp } = session;
  const remotePath = await uploadLocalPath(sftp, localPath, remoteDirectory || '.');
  return { remotePath };
}

async function readTerminalHomeDirectory(sessionId) {
  const { connection } = terminalSessionOrThrow(sessionId);
  let result;
  try {
    result = await execOnTerminalConnection(connection, 'pwd');
  } catch (error) {
    if (isTerminalChannelClosedError(error)) return { path: '' };
    throw error;
  }
  const currentPath = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  if (!currentPath) throw new Error('Could not determine the SSH home directory.');
  return { path: normalizeRemotePath(currentPath) };
}

async function listTerminalDirectory(sessionId, remotePath = '.') {
  const terminal = terminalSessionOrThrow(sessionId);
  const normalizedPath = normalizeRemotePath(remotePath);
  if (terminal.sftpUnavailable) return unavailableTerminalDirectory(normalizedPath);

  try {
    return await withTerminalSftp(sessionId, async (sftp) => {
      const items = await sftpReaddir(sftp, normalizedPath);
      return {
        path: normalizedPath,
        parentPath: parentRemotePath(normalizedPath),
        items: items
          .map((item) => {
            const attrs = item.attrs || {};
            const isDirectory = Boolean(attrs.isDirectory?.());
            return {
              name: item.filename,
              path: joinRemotePath(normalizedPath, item.filename),
              type: isDirectory ? 'directory' : 'file',
              size: Number(attrs.size || 0),
              modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : '',
              mode: attrs.mode ? attrs.mode.toString(8) : ''
            };
          })
          .sort((left, right) => {
            if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
            return left.name.localeCompare(right.name);
          })
      };
    });
  } catch (error) {
    if (isTerminalChannelClosedError(error)) {
      return {
        path: normalizedPath,
        parentPath: parentRemotePath(normalizedPath),
        items: [],
        closed: true
      };
    }
    if (!isSftpSubsystemUnavailableError(error)) throw error;
    terminal.sftpUnavailable = true;
    return unavailableTerminalDirectory(normalizedPath);
  }
}

async function readTerminalFile(sessionId, remotePath) {
  const normalizedPath = normalizeRemotePath(remotePath);
  if (!normalizedPath || normalizedPath === '.' || normalizedPath === '/') throw new Error('Choose a file to edit.');
  const content = await withTerminalSftp(sessionId, (sftp) => sftpReadTextFile(sftp, normalizedPath));
  return { path: normalizedPath, content };
}

async function writeTerminalFile(sessionId, remotePath, content) {
  const normalizedPath = normalizeRemotePath(remotePath);
  if (!normalizedPath || normalizedPath === '.' || normalizedPath === '/') throw new Error('Choose a file to save.');
  const text = String(content ?? '');
  if (Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) throw new Error('This file is larger than the 5 MB editor limit.');
  await withTerminalSftp(sessionId, (sftp) => sftpWriteTextFile(sftp, normalizedPath, text));
  return { path: normalizedPath, bytes: Buffer.byteLength(text, 'utf8') };
}

async function downloadTerminalFile(sessionId, remotePath, localPath) {
  const normalizedPath = normalizeRemotePath(remotePath);
  if (!normalizedPath || normalizedPath === '.' || normalizedPath === '/') throw new Error('Choose a file to download.');
  await withTerminalSftp(sessionId, (sftp) => sftpFastGet(sftp, normalizedPath, localPath));
  return { path: normalizedPath, localPath };
}

async function downloadTerminalEntryToDirectory(sessionId, entry, localDirectory) {
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/') throw new Error('Choose a server item to download.');
  const localPath = await withTerminalSftp(sessionId, (sftp) =>
    downloadRemotePath(sftp, remotePath, entry?.type, localDirectory)
  );
  return { path: remotePath, localPath };
}

async function makeTerminalDirectory(sessionId, remoteDirectory, folderName) {
  const name = assertPlainFileName(folderName, 'Enter a folder name.');
  const remotePath = joinRemotePath(remoteDirectory || '.', name);
  await withTerminalSftp(sessionId, (sftp) => sftpMkdir(sftp, remotePath));
  return { remotePath };
}

async function renameTerminalEntry(sessionId, entry, nextName) {
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/') throw new Error('Choose a file or folder to rename.');
  const name = assertPlainFileName(nextName);
  const nextPath = joinRemotePath(parentRemotePath(remotePath), name);
  await withTerminalSftp(sessionId, (sftp) => sftpRename(sftp, remotePath, nextPath));
  return { remotePath: nextPath };
}

async function openTerminalEntryWith(sessionId, entry) {
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/' || entry?.type === 'directory') {
    throw new Error('Choose a server file to open.');
  }
  const tempRoot = path.join(app.getPath('temp'), 'DeployerX', 'terminal-open', String(sessionId));
  await fs.mkdir(tempRoot, { recursive: true });
  const localPath = await withTerminalSftp(sessionId, (sftp) => downloadRemotePath(sftp, remotePath, 'file', tempRoot));
  if (process.platform === 'win32') {
    const child = execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', localPath], {
      detached: true,
      windowsHide: false
    });
    child.unref();
    return { localPath };
  }
  const result = await shell.openPath(localPath);
  if (result) throw new Error(result);
  return { localPath };
}

async function deleteTerminalEntry(sessionId, entry) {
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/') throw new Error('Choose a file or folder to delete.');
  await withTerminalSftp(sessionId, (sftp) => deleteRemotePath(sftp, remotePath, entry?.type));
  return true;
}

async function uploadTerminalFile(sessionId, localPath, remoteDirectory) {
  const terminal = terminalSessionOrThrow(sessionId);
  if (activeTerminalUploads.has(sessionId)) throw new Error('An upload is already in progress.');
  const normalizedLocalPath = path.resolve(String(localPath || ''));
  const fileName = path.basename(normalizedLocalPath);
  if (!fileName) throw new Error('Choose a local file to upload.');

  const stats = await fs.stat(normalizedLocalPath);
  if (!stats.isFile()) throw new Error('Choose a file to upload.');

  const remotePath = joinRemotePath(remoteDirectory || '.', fileName);
  const uploadState = {
    sessionId,
    fileName,
    remotePath,
    canceled: false,
    sftp: null
  };
  activeTerminalUploads.set(sessionId, uploadState);
  emitTerminal(sessionId, 'upload-started', {
    fileName,
    remotePath,
    totalBytes: stats.size
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (uploadState.sftp) {
        try {
          uploadState.sftp.end();
        } catch {}
      }
      activeTerminalUploads.delete(sessionId);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    terminal.connection.sftp((error, sftp) => {
      if (error) {
        finish(error);
        return;
      }

      uploadState.sftp = sftp;
      if (uploadState.canceled) {
        finish(new Error('Upload canceled.'));
        return;
      }

      sftpFastPut(sftp, normalizedLocalPath, remotePath, {
        step: (transferredBytes, _chunk, totalBytes) => {
          const total = Number(totalBytes || stats.size || 0);
          const transferred = Number(transferredBytes || 0);
          emitTerminal(sessionId, 'upload-progress', {
            fileName,
            remotePath,
            transferredBytes: transferred,
            totalBytes: total,
            percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0
          });
        }
      })
        .then(() => {
          if (uploadState.canceled) {
            finish(new Error('Upload canceled.'));
            return;
          }
          emitTerminal(sessionId, 'upload-complete', {
            fileName,
            remotePath,
            totalBytes: stats.size
          });
          finish(null, { remotePath });
        })
        .catch((uploadError) => {
          finish(uploadState.canceled ? new Error('Upload canceled.') : uploadError);
        });
    });
  });
}

function cancelTerminalUpload(sessionId) {
  const upload = activeTerminalUploads.get(sessionId);
  if (!upload) return false;
  upload.canceled = true;
  if (upload.sftp) {
    try {
      upload.sftp.end();
    } catch {}
  }
  return true;
}

async function downloadFtpFile(sessionId, remotePath, localPath) {
  const session = ftpSessionOrThrow(sessionId);
  if (session.ftp) {
    await session.ftp.downloadTo(localPath, normalizeRemotePath(remotePath));
    return { localPath };
  }
  const { sftp } = session;
  await sftpFastGet(sftp, normalizeRemotePath(remotePath), localPath);
  return { localPath };
}

async function downloadFtpEntryToDirectory(sessionId, entry, localDirectory) {
  if (!entry?.path) throw new Error('Choose a server item to download.');
  const session = ftpSessionOrThrow(sessionId);
  if (session.ftp) {
    const target = path.join(normalizeLocalPath(localDirectory), remoteBaseName(entry.path) || 'download');
    if (entry.type === 'directory') await session.ftp.downloadToDir(target, normalizeRemotePath(entry.path));
    else await session.ftp.downloadTo(target, normalizeRemotePath(entry.path));
    return { localPath: target };
  }
  const { sftp } = session;
  const localPath = await downloadRemotePath(sftp, normalizeRemotePath(entry.path), entry.type, localDirectory);
  return { localPath };
}

async function makeFtpDirectory(sessionId, remoteDirectory, folderName) {
  const name = assertPlainFileName(folderName, 'Enter a folder name.');
  const remotePath = joinRemotePath(remoteDirectory || '.', name);
  const session = ftpSessionOrThrow(sessionId);
  if (session.ftp) {
    await session.ftp.ensureDir(remotePath);
    return { remotePath };
  }
  const { sftp } = session;
  await sftpMkdir(sftp, remotePath);
  return { remotePath };
}

async function renameFtpEntry(sessionId, entry, nextName) {
  const session = ftpSessionOrThrow(sessionId);
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/') throw new Error('Choose a file or folder to rename.');
  const name = assertPlainFileName(nextName);
  const nextPath = joinRemotePath(parentRemotePath(remotePath), name);
  if (session.ftp) {
    await session.ftp.rename(remotePath, nextPath);
    return { remotePath: nextPath };
  }
  const { sftp } = session;
  await sftpRename(sftp, remotePath, nextPath);
  return { remotePath: nextPath };
}

async function openFtpEntry(sessionId, entry) {
  if (!entry?.path) throw new Error('Choose a server item to open.');
  const session = ftpSessionOrThrow(sessionId);
  const tempRoot = path.join(app.getPath('temp'), 'DeployerX', 'ftp-open', String(sessionId));
  await fs.mkdir(tempRoot, { recursive: true });
  if (session.ftp) {
    const localPath = path.join(tempRoot, remoteBaseName(entry.path) || 'download');
    if (entry.type === 'directory') await session.ftp.downloadToDir(localPath, normalizeRemotePath(entry.path));
    else await session.ftp.downloadTo(localPath, normalizeRemotePath(entry.path));
    const result = await shell.openPath(localPath);
    if (result) throw new Error(result);
    return { localPath };
  }
  const { sftp } = session;
  const localPath = await downloadRemotePath(sftp, normalizeRemotePath(entry.path), entry.type, tempRoot);
  const result = await shell.openPath(localPath);
  if (result) throw new Error(result);
  return { localPath };
}

async function openFtpEntryWith(sessionId, entry) {
  if (!entry?.path) throw new Error('Choose a server item to open.');
  const session = ftpSessionOrThrow(sessionId);
  const tempRoot = path.join(app.getPath('temp'), 'DeployerX', 'ftp-open', String(sessionId));
  await fs.mkdir(tempRoot, { recursive: true });
  if (session.ftp) {
    const localPath = path.join(tempRoot, remoteBaseName(entry.path) || 'download');
    if (entry.type === 'directory') await session.ftp.downloadToDir(localPath, normalizeRemotePath(entry.path));
    else await session.ftp.downloadTo(localPath, normalizeRemotePath(entry.path));
    if (process.platform === 'win32') {
      const child = execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', localPath], { detached: true, windowsHide: false });
      child.unref();
      return { localPath };
    }
    const result = await shell.openPath(localPath);
    if (result) throw new Error(result);
    return { localPath };
  }
  const { sftp } = session;
  const localPath = await downloadRemotePath(sftp, normalizeRemotePath(entry.path), entry.type, tempRoot);
  if (process.platform === 'win32') {
    const child = execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', localPath], {
      detached: true,
      windowsHide: false
    });
    child.unref();
    return { localPath };
  }
  const result = await shell.openPath(localPath);
  if (result) throw new Error(result);
  return { localPath };
}

async function deleteFtpEntry(sessionId, entry) {
  const session = ftpSessionOrThrow(sessionId);
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/') throw new Error('Choose a file or folder to delete.');
  if (session.ftp) {
    if (entry?.type === 'directory') await session.ftp.removeDir(remotePath);
    else await session.ftp.remove(remotePath);
    return true;
  }
  const { sftp } = session;
  await deleteRemotePath(sftp, remotePath, entry?.type);
  return true;
}

function disconnectFtp(sessionId) {
  const session = activeFtpSessions.get(sessionId);
  if (!session) return false;
  if (session.ftp) session.ftp.close();
  else session.connection?.end();
  activeFtpSessions.delete(sessionId);
  session.networkAccess?.release().catch(() => {});
  return true;
}

function stopDeployment(runId) {
  const deployment = activeDeployments.get(runId);
  if (!deployment) return false;
  deployment.stopped = true;
  if (deployment.currentStream) deployment.currentStream.close();
  deployment.connection.end();
  activeDeployments.delete(runId);
  deployment.networkAccess?.release().catch(() => {});
  emitDeployment(runId, 'failed', 'Emergency stop requested.');
  return true;
}

function stopTerminal(sessionId) {
  cancelTerminalUpload(sessionId);
  const terminal = activeTerminals.get(sessionId);
  if (!terminal) return false;
  serverMonitoringSessionManager.stopByConnection(terminal.connection);
  if (terminal.stream) terminal.stream.close();
  terminal.connection.end();
  activeTerminals.delete(sessionId);
  terminal.networkAccess?.release().catch(() => {});
  emitTerminal(sessionId, 'closed', 'Terminal stopped.');
  return true;
}

function emergencyStop() {
  for (const runId of [...activeDeployments.keys()]) {
    stopDeployment(runId);
  }
  for (const sessionId of [...activeTerminals.keys()]) {
    stopTerminal(sessionId);
  }
  for (const sessionId of [...activeTerminalUploads.keys()]) {
    cancelTerminalUpload(sessionId);
  }
  for (const sessionId of [...activeFtpSessions.keys()]) {
    disconnectFtp(sessionId);
  }
  serverMonitoringSessionManager.stopAll();
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  await cleanupDeployerXProcesses({ allowElevation: true }).catch(() => {});
  listMcpClientsForRenderer().catch(() => {});
  await ensureStore();
  await ensureUptimeRoot();
  getBackupNativeToolManager();

  if (isDatabaseManagerPackagedSmokeMode()) {
    try {
      await initializeBackupControlDatabase();
      createWindow({
        show: false,
        onReady: async (window) => publishDatabaseManagerPackagedSmoke(await runDatabaseManagerPackagedSmoke(window)),
        onFailure: (code) => publishDatabaseManagerPackagedSmoke(databaseManagerPackagedSmokeFailure(code))
      });
    } catch {
      publishDatabaseManagerPackagedSmoke(databaseManagerPackagedSmokeFailure('DATABASE_MANAGER_PACKAGED_SMOKE_START_FAILED'));
    }
    return;
  }

  if (isWorkerMode()) {
    const hasWorkerLock = await acquireUptimeWorkerLock();
    if (!hasWorkerLock) {
      app.quit();
      return;
    }
    await initializeBackupControlDatabase();
    await initializeUptimeControlPlane({ startWorker: true });
    await initializeScheduledBackupWorker().catch(async (error) => {
      await getBackupLogStore().logger({ workspaceId: 'local', component: 'backup-scheduled-worker' }).error(
        'Scheduled backup worker could not start.',
        { code: error.code || 'BACKUP_SCHEDULED_WORKER_START_FAILED', error }
      ).catch(() => {});
    });
    return;
  }

  await initializeBackupControlDatabase();
  await initializeUptimeControlPlane().catch(() => {});
  await restoreMcpIntegration().catch(() => {});
  startMcpHealthWatchdog();
  createWindow({ show: !isMcpAutostartMode() });
  if (pendingSecondInstanceArguments) {
    const argv = pendingSecondInstanceArguments;
    pendingSecondInstanceArguments = null;
    openExistingMainWindow(argv);
  }
  if (!isMcpAutostartMode()) createTray();
  initializeAutoUpdater();
  await maybeStartDetachedUptimeWorker().catch(() => {});
  await startUptimeWindowPolling();

  app.on('activate', () => {
    showMainWindow();
  });
}).catch(handleApplicationStartupFailure);

app.on('window-all-closed', () => {
  // The tray owns the application lifetime. Quit is explicit from its menu.
});

app.on('before-quit', () => {
  isAppQuitting = true;
  if (updateInstallRequested || startupFailureHandled || updateState.status === 'downloaded') {
    stopDetachedUptimeWorker({ force: true }).catch(() => {});
    cleanupDeployerXProcesses({ includeCurrentExecutable: true }).catch(() => {});
  }
  serverMonitoringSessionManager.stopAll();
  rdpSessionManager?.closeAll().catch(() => {});
  vncSessionManager?.closeAll().catch(() => {});
  releaseAllVncNetworkSessions().catch(() => {});
  releaseAllWindowsVpnProfiles().catch(() => {});
  databaseQueryService?.closeAll();
  databaseResultExportService?.closeAll();
  databaseDefinitionExecutor?.closeAll();
  databaseTransferService?.closeAll();
  databaseSchemaService?.closeAll();
  databaseAccessCompanionService?.dispose().catch(() => {});
  disposeDatabaseAccessFallbackWindows();
  databaseConnectionService?.closeAll().catch(() => {});
  databaseDriverRuntimeRegistry?.stopAll().catch(() => {});
  for (const entries of mcpSshConnections.values()) {
    for (const entry of entries) entry.connection?.end();
  }
  mcpSshConnections.clear();
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
  if (mcpServer) mcpServer.stop().catch(() => {});
  if (mcpRestartTimer) clearTimeout(mcpRestartTimer);
  mcpRestartTimer = null;
  if (mcpHealthTimer) clearInterval(mcpHealthTimer);
  mcpHealthTimer = null;
  if (backupScheduledWorkerService && isWorkerMode()) backupScheduledWorkerService.stop({ drain: false }).catch(() => {});
  if (uptimeScheduledWorkerService && isWorkerMode()) uptimeScheduledWorkerService.stop({ drain: false }).catch(() => {});
  if (uptimeControlDatabase) uptimeControlDatabase.close().catch(() => {});
  if (backupControlDatabase) backupControlDatabase.close().catch(() => {});
  fs.rm(SESSION_DATA_PATH, { recursive: true, force: true }).catch(() => {});
  if (autoUpdateTimer) clearInterval(autoUpdateTimer);
  if (uptimeWindowPollTimer) clearInterval(uptimeWindowPollTimer);
  if (uptimeWorkerInterval) clearInterval(uptimeWorkerInterval);
  if (uptimeConfigRefreshTimer) clearInterval(uptimeConfigRefreshTimer);
  if (uptimeCommandPollTimer) clearInterval(uptimeCommandPollTimer);
  if (databaseCloudSyncTimer) clearInterval(databaseCloudSyncTimer);
  if (workspaceControlSyncTimer) clearInterval(workspaceControlSyncTimer);
  if (workspaceUptimeSyncTimer) clearInterval(workspaceUptimeSyncTimer);
  workspaceUptimeSyncTimer = null;
  if (isWorkerMode()) {
    mutateUptimeRuntime((current) => {
      current.worker = {
        ...current.worker,
        active: false,
        pid: process.pid,
        lastHeartbeatAt: nowIso()
      };
      return current;
    }).catch(() => {});
    releaseUptimeWorkerLock().catch(() => {});
  }
});

ipcMain.handle('app:metadata', async () => ({
  name: app.getName(),
  version: app.getVersion(),
  updates: publicUpdateState()
}));

ipcMain.handle('database-manager:profiles:list', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const accessEntry = databaseAccessFallbackEntryForSender(_event);
  if (accessEntry) {
    requireDatabaseAccessFallbackProfile(_event, context, accessEntry.profileId);
    const profile = await getDatabaseProfileService().get(context.workspaceId, accessEntry.profileId);
    return profile ? [await databaseProfileForRenderer(context.workspaceId, profile)] : [];
  }
  return listDatabaseProfilesForRenderer(context, { limit: Math.min(1000, Math.max(1, Number(payload.limit) || 500)) });
}));

ipcMain.handle('database-manager:plugins:list', wrapDatabaseManagerIpc(async () => listDatabasePluginsWithHealth()));
ipcMain.handle('database-manager:plugins:refresh', wrapDatabaseManagerIpc(async () => refreshDatabasePluginCatalog()));
ipcMain.handle('database-manager:plugins:requirements:refresh', wrapDatabaseManagerIpc(async () => recheckDatabasePluginRuntimeRequirements()));

ipcMain.handle('database-manager:plugins:install', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const installed = await getDatabasePluginRegistry().install(payload.pluginId, payload.version);
  if (!installed.enabled) return installed;
  try { await registerDatabasePluginRuntime(installed.pluginId); }
  catch (error) { await getDatabasePluginRegistry().setEnabled(installed.pluginId, false).catch(() => {}); throw error; }
  sendDatabaseManagerEvent('device', 'plugin-state', { pluginId: installed.pluginId, state: 'installed' });
  await checkDatabasePluginHealth(installed.pluginId);
  return installed;
}));
ipcMain.handle('database-manager:plugins:enable', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const enabled = await getDatabasePluginRegistry().setEnabled(payload.pluginId, true);
  try { await registerDatabasePluginRuntime(enabled.pluginId); }
  catch (error) { await getDatabasePluginRegistry().setEnabled(enabled.pluginId, false).catch(() => {}); throw error; }
  sendDatabaseManagerEvent('device', 'plugin-state', { pluginId: enabled.pluginId, state: 'enabled' });
  await checkDatabasePluginHealth(enabled.pluginId);
  return enabled;
}));
ipcMain.handle('database-manager:plugins:disable', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const closedSessions = await getDatabaseConnectionService().closeDriver(payload.pluginId);
  for (const session of closedSessions) {
    sendDatabaseManagerEvent(session.workspaceId, 'connection-status', { profileId: session.profileId, state: 'closed', operation: 'driver-disable' });
  }
  await databaseDriverRuntimeRegistry.unregister(payload.pluginId);
  const disabled = await getDatabasePluginRegistry().setEnabled(payload.pluginId, false);
  await getDatabasePluginHealthStore().setDisabled(payload.pluginId);
  sendDatabaseManagerEvent('device', 'plugin-state', { pluginId: disabled.pluginId, state: 'disabled' });
  return disabled;
}));
ipcMain.handle('database-manager:plugins:remove', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const closedSessions = await getDatabaseConnectionService().closeDriver(payload.pluginId);
  for (const session of closedSessions) {
    sendDatabaseManagerEvent(session.workspaceId, 'connection-status', { profileId: session.profileId, state: 'closed', operation: 'driver-remove' });
  }
  await databaseDriverRuntimeRegistry.unregister(payload.pluginId);
  const removed = await getDatabasePluginRegistry().remove(payload.pluginId);
  await getDatabasePluginHealthStore().remove(payload.pluginId);
  sendDatabaseManagerEvent('device', 'plugin-state', { pluginId: payload.pluginId, state: 'removed' });
  return removed;
}));
ipcMain.handle('database-manager:plugins:health', wrapDatabaseManagerIpc(async (_event, payload = {}) => checkDatabasePluginHealth(payload.pluginId)));

ipcMain.handle('database-manager:profiles:get', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const profile = await getDatabaseProfileService().get(context.workspaceId, payload.id);
  return databaseProfileForRenderer(context.workspaceId, profile);
}));

ipcMain.handle('database-manager:profiles:create', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const created = await getDatabaseProfileService().create(context.workspaceId, context.actorId, payload);
  return syncDatabaseProfileMetadata(context, created, payload.cloudRevision ?? 0);
}));

ipcMain.handle('database-manager:profiles:update', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  closeDatabaseAccessFallbackWindow(context, payload.id);
  await databaseAccessCompanionService?.close({ ...context, profileId: payload.id }).catch(() => {});
  const updated = await getDatabaseProfileService().update(context.workspaceId, context.actorId, payload.id, payload.profile || {}, payload.revision);
  await getDatabaseConnectionService().closeProfile(context.workspaceId, payload.id);
  return syncDatabaseProfileMetadata(context, updated, payload.cloudRevision ?? null);
}));

ipcMain.handle('database-manager:profiles:delete', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  closeDatabaseAccessFallbackWindow(context, payload.id);
  await databaseAccessCompanionService?.close({ ...context, profileId: payload.id }).catch(() => {});
  const existing = await getDatabaseProfileService().get(context.workspaceId, payload.id);
  if (!existing) {
    const sync = await removeDatabaseProfileMetadata(context, payload.id, payload.cloudRevision ?? payload.revision ?? null);
    return { id: payload.id, cloudOnly: true, deleted: true, ...sync };
  }
  const deleted = await getDatabaseProfileService().delete(context.workspaceId, context.actorId, payload.id, payload.revision);
  await getDatabaseConnectionService().closeProfile(context.workspaceId, payload.id);
  await getDatabaseLocalResourceStore().remove({ workspaceId: context.workspaceId, profileId: payload.id }).catch(() => {});
  const sync = await removeDatabaseProfileMetadata(context, payload.id, payload.cloudRevision ?? null);
  return { ...deleted, ...sync };
}));

ipcMain.handle('database-manager:profiles:resolve-cloud-conflict', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return resolveDatabaseProfileCloudConflict(context, payload.id, payload.strategy);
}));

ipcMain.handle('database-manager:connections:test', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.id, state: 'testing', operation: 'test' });
  try {
    const result = await getDatabaseConnectionService().test(context.workspaceId, context.actorId, payload.id);
    sendDatabaseManagerEvent(context.workspaceId, 'connection-status', {
      profileId: payload.id,
      state: result.status === 'success' ? 'tested' : 'failed',
      operation: 'test',
      code: result.error?.code
    });
    return result;
  } catch (error) {
    sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.id, state: 'failed', operation: 'test', code: error?.code });
    throw error;
  }
}));

ipcMain.handle('database-manager:connections:open', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.id, state: 'opening', operation: 'open' });
  try {
    closeDatabaseAccessFallbackWindow(context, payload.id);
    await databaseAccessCompanionService?.close({ ...context, profileId: payload.id }).catch(() => {});
    const result = await getDatabaseConnectionService().open(context.workspaceId, context.actorId, payload.id);
    sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.id, state: result.state === 'ready' ? 'ready' : 'failed', operation: 'open', code: result.error?.code });
    return result;
  } catch (error) {
    sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.id, state: 'failed', operation: 'open', code: error?.code });
    throw error;
  }
}));

ipcMain.handle('database-manager:connections:close', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.id, state: 'closing', operation: 'close' });
  closeDatabaseAccessFallbackWindow(context, payload.id);
  await databaseAccessCompanionService?.close({ ...context, profileId: payload.id }).catch(() => {});
  const result = await getDatabaseConnectionService().close(context.workspaceId, context.actorId, payload.id);
  sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.id, state: 'closed', operation: 'close' });
  return result;
}));

ipcMain.handle('database-manager:connections:status', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const result = await getDatabaseConnectionService().status(context.workspaceId, context.actorId, payload.id);
  sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.id, state: result.state, operation: 'status', code: result.code });
  return result;
}));

ipcMain.handle('database-manager:connections:list-status', wrapDatabaseManagerIpc(async (_event) => {
  const context = await databaseManagerContext();
  const accessEntry = databaseAccessFallbackEntryForSender(_event);
  if (accessEntry) {
    requireDatabaseAccessFallbackProfile(_event, context, accessEntry.profileId);
    return [await getDatabaseConnectionService().status(context.workspaceId, context.actorId, accessEntry.profileId)];
  }
  return getDatabaseConnectionService().listStatus(context.workspaceId, context.actorId);
}));

ipcMain.handle('database-manager:access:open', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  if (databaseAccessContextTransitions > 0) throw databaseAccessContextChangedError();
  const contextGeneration = databaseAccessContextGeneration;
  const context = await databaseManagerContext();
  const profile = await requireReadyDatabaseAccessProfile(context, payload.profileId);
  if (databaseAccessContextTransitions > 0 || contextGeneration !== databaseAccessContextGeneration) {
    throw databaseAccessContextChangedError();
  }
  const companion = getDatabaseAccessCompanionService();
  if (companion.isAvailable()) {
    return companion.open({ ...context, profileId: profile.id });
  }
  sendDatabaseManagerEvent(context.workspaceId, 'access-manager-state', {
    profileId: profile.id,
    state: 'launching',
    reason: 'embedded-fallback'
  });
  try {
    return await openDatabaseAccessFallbackWindow(context, profile);
  } catch (error) {
    sendDatabaseManagerEvent(context.workspaceId, 'access-manager-state', {
      profileId: profile.id,
      state: 'failed',
      reason: error?.code || 'fallback-open-failed'
    });
    throw error;
  }
}));

ipcMain.handle('database-manager:backup:prepare', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseBackupHandoffService().prepare(context.workspaceId, context.actorId, payload.id);
}));

ipcMain.handle('database-manager:queries:execute', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const accessEntry = requireDatabaseAccessFallbackProfile(_event, context, payload.profileId);
  if (accessEntry) accessEntry.requestIds.add(String(payload.requestId || ''));
  sendDatabaseManagerEvent(context.workspaceId, 'query-progress', { requestId: payload.requestId, profileId: payload.profileId, state: 'running' });
  try {
    const execution = await getDatabaseQueryService().execute(context.workspaceId, context.actorId, payload);
    const results = [execution.result, ...(execution.result.additionalResults || [])];
    const rowCount = results.reduce((total, result) => total + result.rows.length, 0);
    const completed = { requestId: execution.requestId, profileId: execution.profileId, state: 'succeeded', statementCount: execution.statementCount, rowCount };
    sendDatabaseManagerEvent(context.workspaceId, 'query-progress', completed);
    if (execution.statementCount > 1) sendDatabaseManagerEvent(context.workspaceId, 'batch-completion', completed);
    if (execution.classification !== 'read') {
      sendDatabaseManagerEvent(context.workspaceId, 'schema-change', {
        requestId: execution.requestId,
        profileId: execution.profileId,
        state: 'changed',
        operation: 'query'
      });
    }
    return execution;
  } catch (error) {
    const state = error?.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED' ? 'cancelled' : 'failed';
    const failed = { requestId: payload.requestId, profileId: payload.profileId, state, code: error?.code };
    sendDatabaseManagerEvent(context.workspaceId, 'query-progress', failed);
    if (error?.code === 'DATABASE_MANAGER_CONNECTION_SESSION_CLOSED') {
      await getDatabaseConnectionService().close(context.workspaceId, context.actorId, payload.profileId);
      sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.profileId, state: 'closed', operation: 'expire' });
    }
    if (payload.batch === true) sendDatabaseManagerEvent(context.workspaceId, 'batch-completion', failed);
    throw error;
  } finally {
    if (accessEntry) accessEntry.requestIds.delete(String(payload.requestId || ''));
  }
}));

ipcMain.handle('database-manager:queries:cancel', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  requireDatabaseAccessFallbackRequest(_event, context, payload.requestId);
  return getDatabaseQueryService().cancel(context.workspaceId, context.actorId, payload.requestId);
}));

ipcMain.handle('database-manager:explain:execute', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const accessEntry = requireDatabaseAccessFallbackProfile(_event, context, payload.profileId);
  if (accessEntry) accessEntry.requestIds.add(String(payload.requestId || ''));
  try {
    return await getDatabaseExplainService().execute(context.workspaceId, context.actorId, payload);
  } finally {
    if (accessEntry) accessEntry.requestIds.delete(String(payload.requestId || ''));
  }
}));

ipcMain.handle('database-manager:explain:cancel', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  requireDatabaseAccessFallbackRequest(_event, context, payload.requestId);
  return getDatabaseExplainService().cancel(context.workspaceId, context.actorId, payload.requestId);
}));

ipcMain.handle('database-manager:transfer:execute', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseTransferService().execute(context.workspaceId, context.actorId, payload);
}));

ipcMain.handle('database-manager:rows:mutate', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  requireDatabaseAccessFallbackProfile(_event, context, payload.profileId);
  return getDatabaseRowCrudService().execute(context.workspaceId, context.actorId, payload);
}));

ipcMain.handle('database-manager:schema:load', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const accessEntry = requireDatabaseAccessFallbackProfile(_event, context, payload.profileId);
  if (accessEntry) accessEntry.requestIds.add(String(payload.requestId || ''));
  sendDatabaseManagerEvent(context.workspaceId, 'schema-change', { requestId: payload.requestId, profileId: payload.profileId, state: 'loading', operation: 'load' });
  try {
    const schema = await getDatabaseSchemaService().load(context.workspaceId, context.actorId, payload);
    sendDatabaseManagerEvent(context.workspaceId, 'schema-change', { requestId: payload.requestId, profileId: payload.profileId, state: 'loaded', operation: 'load' });
    return schema;
  } catch (error) {
    sendDatabaseManagerEvent(context.workspaceId, 'schema-change', {
      requestId: payload.requestId,
      profileId: payload.profileId,
      state: error?.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED' ? 'cancelled' : 'failed',
      operation: 'load',
      code: error?.code
    });
    if (error?.code === 'DATABASE_MANAGER_CONNECTION_SESSION_CLOSED') {
      await getDatabaseConnectionService().close(context.workspaceId, context.actorId, payload.profileId);
      sendDatabaseManagerEvent(context.workspaceId, 'connection-status', { profileId: payload.profileId, state: 'closed', operation: 'expire' });
    }
    throw error;
  } finally {
    if (accessEntry) accessEntry.requestIds.delete(String(payload.requestId || ''));
  }
}));

ipcMain.handle('database-manager:schema:cancel', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  requireDatabaseAccessFallbackRequest(_event, context, payload.requestId);
  return getDatabaseSchemaService().cancel(context.workspaceId, context.actorId, payload.requestId);
}));

ipcMain.handle('database-manager:schema:capabilities', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseSchemaAdministrationService().capabilities(context.workspaceId, payload.profileId);
}));

ipcMain.handle('database-manager:schema:execute', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  try {
    const result = await getDatabaseSchemaAdministrationService().execute(context.workspaceId, context.actorId, payload);
    sendDatabaseManagerEvent(context.workspaceId, 'schema-change', {
      requestId: payload.requestId,
      profileId: payload.profileId,
      taskId: result.task?.id,
      state: 'changed',
      operation: result.action?.action || payload.action
    });
    return result;
  } catch (error) {
    sendDatabaseManagerEvent(context.workspaceId, 'schema-change', {
      requestId: payload.requestId,
      profileId: payload.profileId,
      state: error?.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED' ? 'cancelled' : 'failed',
      operation: payload.action,
      code: error?.code
    });
    throw error;
  }
}));

ipcMain.handle('database-manager:principals:capabilities', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabasePrincipalAdministrationService().capabilities(context.workspaceId, payload.profileId);
}));

ipcMain.handle('database-manager:principals:list', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabasePrincipalAdministrationService().list(context.workspaceId, context.actorId, payload.profileId);
}));

ipcMain.handle('database-manager:principals:inspect', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabasePrincipalAdministrationService().inspect(context.workspaceId, context.actorId, payload);
}));

ipcMain.handle('database-manager:principals:execute', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const safeOperation = /^[a-z0-9-]{1,60}$/.test(String(payload.action || '')) ? String(payload.action) : 'principal-action';
  const safeRequestId = /^[A-Za-z0-9_.:-]{1,200}$/.test(String(payload.requestId || '')) ? String(payload.requestId) : null;
  const safeProfileId = /^[A-Za-z0-9_.:-]{1,200}$/.test(String(payload.profileId || '')) ? String(payload.profileId) : 'unknown-profile';
  try {
    const result = await getDatabasePrincipalAdministrationService().execute(context.workspaceId, context.actorId, payload);
    sendDatabaseManagerEvent(context.workspaceId, 'schema-change', {
      requestId: safeRequestId,
      profileId: safeProfileId,
      taskId: result.task?.id,
      state: 'changed',
      operation: result.action?.action || payload.action
    });
    return result;
  } catch (error) {
    sendDatabaseManagerEvent(context.workspaceId, 'schema-change', {
      requestId: safeRequestId,
      profileId: safeProfileId,
      state: error?.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED' ? 'cancelled' : 'failed',
      operation: safeOperation,
      code: error?.code
    });
    throw error;
  }
}));

ipcMain.handle('database-manager:saved-queries:list', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().listSavedQueries(context.workspaceId, payload);
}));

ipcMain.handle('database-manager:saved-queries:create', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().createSavedQuery(context.workspaceId, context.actorId, payload);
}));

ipcMain.handle('database-manager:saved-queries:update', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().updateSavedQuery(context.workspaceId, context.actorId, payload.id, payload.savedQuery || {}, payload.revision);
}));

ipcMain.handle('database-manager:saved-queries:delete', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().deleteSavedQuery(context.workspaceId, context.actorId, payload.id, payload.revision);
}));

ipcMain.handle('database-manager:history:list', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().listHistory(context.workspaceId, payload);
}));

ipcMain.handle('database-manager:history:clear', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().clearHistory(context.workspaceId, payload);
}));

ipcMain.handle('database-manager:notebooks:list', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().listNotebooks(context.workspaceId, payload);
}));

ipcMain.handle('database-manager:notebooks:get', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().getNotebook(context.workspaceId, payload.id);
}));

ipcMain.handle('database-manager:notebooks:create', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().createNotebook(context.workspaceId, context.actorId, payload);
}));

ipcMain.handle('database-manager:notebooks:update', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().updateNotebook(context.workspaceId, context.actorId, payload.id, payload.notebook || {}, payload.revision);
}));

ipcMain.handle('database-manager:notebooks:delete', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseQueryWorkspaceStore().deleteNotebook(context.workspaceId, context.actorId, payload.id, payload.revision);
}));

ipcMain.handle('database-manager:tasks:list', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseTaskService().list(context.workspaceId, payload);
}));

ipcMain.handle('database-manager:tasks:get', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseTaskService().get(context.workspaceId, payload.id);
}));

ipcMain.handle('database-manager:tasks:cancel', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseTaskService().cancel(context.workspaceId, context.actorId, payload.id);
}));

ipcMain.handle('database-manager:logs:list', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  return getDatabaseOperationalLogService().list(context.workspaceId, payload);
}));

ipcMain.handle('database-manager:results:serialize', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  return getDatabaseResultExportService().serialize(payload);
}));

ipcMain.handle('database-manager:results:export', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  return getDatabaseResultExportService().export(payload);
}));

ipcMain.handle('database-manager:results:export-query', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const accessEntry = requireDatabaseAccessFallbackProfile(_event, context, payload.profileId);
  if (accessEntry) accessEntry.requestIds.add(String(payload.requestId || ''));
  try {
    return await getDatabaseResultExportService().exportQuery(context.workspaceId, context.actorId, payload);
  } finally {
    if (accessEntry) accessEntry.requestIds.delete(String(payload.requestId || ''));
  }
}));

ipcMain.handle('database-manager:results:cancel-export', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  requireDatabaseAccessFallbackRequest(_event, context, payload.requestId);
  return getDatabaseResultExportService().cancel(context.workspaceId, context.actorId, payload.requestId);
}));

ipcMain.handle('database-manager:local-resources:bind', wrapDatabaseManagerIpc(async (_event, payload = {}) => {
  const context = await databaseManagerContext();
  const profile = await getDatabaseProfileService().get(context.workspaceId, payload.id);
  if (!profile) throw Object.assign(new Error('Database profile was not found.'), { code: 'DATABASE_MANAGER_PROFILE_NOT_FOUND' });
  const kind = profile.endpoint?.kind;
  if (!['file', 'folder'].includes(kind)) throw Object.assign(new Error('This database profile does not use a local resource.'), { code: 'DATABASE_MANAGER_LOCAL_RESOURCE_UNSUPPORTED' });
  const selection = await dialog.showOpenDialog({
    title: kind === 'file' ? 'Choose database file' : 'Choose database folder',
    properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
    filters: profile.driverId === 'sqlite' ? [
      { name: 'SQLite databases', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] },
      { name: 'All files', extensions: ['*'] }
    ] : undefined
  });
  if (selection.canceled || !selection.filePaths[0]) return { profileId: profile.id, kind, displayName: null, bound: false, cancelled: true };
  return getDatabaseLocalResourceStore().bind({ workspaceId: context.workspaceId, profileId: profile.id, kind, path: selection.filePaths[0] });
}));

ipcMain.handle('vnc:start', async (_event, payload = {}) => {
  if (!vncSessionManager) throw new Error('VNC is not ready.');
  const projectId = String(payload.projectId || '');
  const vnc = payload?.vnc && typeof payload.vnc === 'object' ? payload.vnc : {};
  const store = projectId ? await readCurrentStore().catch(() => ({ projects: [] })) : { projects: [] };
  const project = Array.isArray(store.projects)
    ? store.projects.find((item) => String(item.id || '') === projectId) || null
    : null;
  const networkAccess = project
    ? await prepareProjectNetworkAccess(project, {
        targetHost: String(vnc.host || project.vnc?.host || project.rdp?.host || '').trim(),
        targetPort: Number(vnc.port || project.vnc?.port || 5900),
        protocol: 'vnc'
      })
    : { release: async () => {} };
  try {
    const session = await vncSessionManager.start(payload);
    activeVncNetworkSessions.set(session.sessionId, networkAccess);
    return session;
  } catch (error) {
    await networkAccess.release?.().catch(() => {});
    throw error;
  }
});

ipcMain.handle('rdp:start', async (_event, payload = {}) => {
  if (!rdpSessionManager) throw new Error('Remote Desktop is not ready.');
  const projectId = String(payload.projectId || '');
  const rdp = payload?.rdp && typeof payload.rdp === 'object' ? payload.rdp : {};
  const store = projectId ? await readCurrentStore().catch(() => ({ projects: [] })) : { projects: [] };
  const project = Array.isArray(store.projects)
    ? store.projects.find((item) => String(item.id || '') === projectId) || null
    : null;
  const networkAccess = project
    ? await prepareProjectNetworkAccess(project, {
        targetHost: String(rdp.host || project.rdp?.host || '').trim(),
        targetPort: Number(rdp.port || project.rdp?.port || 3389),
        protocol: 'rdp'
      })
    : { release: async () => {} };
  try {
    const session = await rdpSessionManager.start(payload);
    activeVncNetworkSessions.set(session.sessionId, networkAccess);
    return session;
  } catch (error) {
    await networkAccess.release?.().catch(() => {});
    throw error;
  }
});

ipcMain.handle('rdp:wasm', async () => fs.readFile(RDP_WASM_FILE));

ipcMain.handle('rdp:stop', async (_event, sessionId) => {
  const stopped = rdpSessionManager?.stop(sessionId) || false;
  const networkAccess = activeVncNetworkSessions.get(sessionId);
  activeVncNetworkSessions.delete(sessionId);
  await networkAccess?.release?.().catch(() => {});
  return stopped;
});

ipcMain.handle('vnc:stop', async (_event, sessionId) => {
  const stopped = vncSessionManager?.stop(sessionId) || false;
  const networkAccess = activeVncNetworkSessions.get(sessionId);
  activeVncNetworkSessions.delete(sessionId);
  await networkAccess?.release?.().catch(() => {});
  return stopped;
});

function transitionMainWindowFullscreen(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  if (mainWindow.isFullScreen() === enabled) return Promise.resolve(enabled);
  const window = mainWindow;
  const eventName = enabled ? 'enter-full-screen' : 'leave-full-screen';
  return new Promise((resolve) => {
    let settled = false;
    const retryTimers = [];
    const finish = (transitionCompleted = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      retryTimers.forEach(clearTimeout);
      window.removeListener(eventName, handleTransition);
      resolve(transitionCompleted ? enabled : !window.isDestroyed() && window.isFullScreen());
    };
    const handleTransition = () => finish(true);
    const requestTransition = () => {
      if (window.isDestroyed() || window.isFullScreen() === enabled) {
        finish(true);
        return;
      }
      window.setFullScreen(enabled);
    };
    const fallbackTimer = setTimeout(() => finish(false), 2200);
    window.once(eventName, handleTransition);
    [0, 220, 650].forEach((delay) => retryTimers.push(setTimeout(requestTransition, delay)));
  });
}

function restoreVncWindowState() {
  if (!vncRestoreWindowState) return;
  const restoreState = vncRestoreWindowState;
  vncRestoreWindowState = null;
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
    if (restoreState.maximized) mainWindow.maximize();
    else mainWindow.setBounds(restoreState.bounds);
  }, 120);
}

function restoreServerMonitoringWindowState() {
  if (!serverMonitoringRestoreWindowState) return;
  const restoreState = serverMonitoringRestoreWindowState;
  serverMonitoringRestoreWindowState = null;
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
    if (restoreState.maximized) mainWindow.maximize();
    else mainWindow.setBounds(restoreState.bounds);
  }, 120);
}

ipcMain.handle('vnc:fullscreen', async (_event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const request = payload && typeof payload === 'object' ? payload : { enabled: payload };
  const enabled = Boolean(request.enabled);
  if (!enabled) {
    const fullscreen = await transitionMainWindowFullscreen(false);
    restoreVncWindowState();
    return fullscreen;
  }

  if (mainWindow.isFullScreen() && mainWindowFullscreenOwner !== 'vnc') return false;
  mainWindowFullscreenOwner = 'vnc';

  if (!vncRestoreWindowState) {
    vncRestoreWindowState = {
      bounds: mainWindow.getBounds(),
      maximized: mainWindow.isMaximized()
    };
  }
  const fullscreen = await transitionMainWindowFullscreen(true);
  if (!fullscreen) {
    mainWindowFullscreenOwner = null;
    restoreVncWindowState();
  }
  return fullscreen;
});

ipcMain.handle('server-monitoring:fullscreen', async (_event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const enabled = Boolean(payload && typeof payload === 'object' ? payload.enabled : payload);
  if (!enabled) {
    if (mainWindowFullscreenOwner !== 'server-monitoring') return false;
    const fullscreen = await transitionMainWindowFullscreen(false);
    restoreServerMonitoringWindowState();
    return fullscreen;
  }
  if (mainWindow.isFullScreen() && mainWindowFullscreenOwner !== 'server-monitoring') return false;
  mainWindowFullscreenOwner = 'server-monitoring';
  if (!serverMonitoringRestoreWindowState) {
    serverMonitoringRestoreWindowState = {
      bounds: mainWindow.getBounds(),
      maximized: mainWindow.isMaximized()
    };
  }
  const fullscreen = await transitionMainWindowFullscreen(true);
  if (!fullscreen) {
    mainWindowFullscreenOwner = null;
    restoreServerMonitoringWindowState();
  }
  return fullscreen;
});

ipcMain.handle('backup:secrets:list', async () => {
  const context = await backupSecretContext();
  return getBackupSecretStore().list(context.workspaceId);
});

ipcMain.handle('backup:secrets:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'secret.create', resourceType: 'secret-ref', component: 'backup-secret-store', details: { name: payload.name, secretType: payload.secretType } },
    () => getBackupSecretStore().create({
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      name: payload.name,
      secretType: payload.secretType,
      value: payload.value,
      scope: payload.scope,
      expiresAt: payload.expiresAt
    })
  );
});

ipcMain.handle('backup:secrets:rotate', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'secret.rotate', resourceType: 'secret-ref', resourceId: payload.id, component: 'backup-secret-store' },
    () => getBackupSecretStore().rotate({
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      id: payload.id,
      value: payload.value,
      expiresAt: payload.expiresAt
    })
  );
});

ipcMain.handle('backup:secrets:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'secret.delete', resourceType: 'secret-ref', resourceId: payload.id, component: 'backup-secret-store' },
    async () => {
      await getBackupSecretStore().delete({ workspaceId: context.workspaceId, id: payload.id });
      return { id: payload.id };
    }
  );
});

ipcMain.handle('backup:audit:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupAuditStore().list(context.workspaceId, { limit: payload.limit });
});

ipcMain.handle('backup:audit:verify', async () => {
  const context = await backupSecretContext();
  return getBackupAuditStore().verify(context.workspaceId);
});

ipcMain.handle('backup:connections:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  try {
    return await runAuditedBackupMutation(
      context,
      { action: 'connection.delete', resourceType: 'connection', resourceId: payload.id, component: 'backup-connection' },
      async () => {
        const repository = getBackupControlDatabase().repository('connection');
        const connection = await repository.get(context.workspaceId, payload.id);
        if (!connection) throw new Error('Backup source connection was not found.');
        const deleted = await repository.softDelete(context.workspaceId, connection.id, {
          expectedRevision: payload.revision,
          actorId: context.actorId,
          cascadeSources: true
        });
        const credentialsNotRemoved = [];
        for (const secretRefId of connection.secretRefIds || []) {
          try {
            await getBackupSecretStore().delete({ workspaceId: context.workspaceId, id: secretRefId });
            const secretRef = await getBackupControlDatabase().repository('secretRef').get(context.workspaceId, secretRefId);
            if (secretRef) {
              await getBackupControlDatabase().repository('secretRef').softDelete(context.workspaceId, secretRefId, {
                expectedRevision: secretRef.revision,
                actorId: context.actorId
              });
            }
          } catch {
            credentialsNotRemoved.push(secretRefId);
          }
        }
        return { connection: deleted, credentialsNotRemoved };
      }
    );
  } catch (error) {
    if (error?.code === 'BACKUP_CONTROL_RECORD_REFERENCED') {
      return { blocked: true, error: { code: error.code, message: error.message } };
    }
    throw error;
  }
});

ipcMain.handle('backup:connections:local:list', async () => {
  const context = await backupSecretContext();
  return getBackupLocalConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:local:ensure', async () => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.ensure-local', resourceType: 'connection', component: 'backup-local-connection' },
    () => getBackupLocalConnectionService().ensure(context.workspaceId, context.actorId)
  );
});

ipcMain.handle('backup:connections:local:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-local', resourceType: 'connection', resourceId: payload.id, component: 'backup-local-connection' },
    () => getBackupLocalConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:local:browse', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupLocalConnectionService().browse(context.workspaceId, payload.id, {
    path: payload.path,
    cursor: payload.cursor,
    pageSize: payload.pageSize
  });
});

ipcMain.handle('backup:connections:ssh:list', async () => {
  const context = await backupSecretContext();
  return getBackupSshConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:ssh:scan-host-key', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.scan-ssh-host-key', resourceType: 'connection', component: 'backup-ssh-connection', details: { host: payload.host, port: payload.port } },
    () => getBackupSshConnectionService().scanHostKey({ host: payload.host, port: payload.port, timeoutMs: payload.timeoutMs })
  );
});

ipcMain.handle('backup:connections:ssh:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-ssh', resourceType: 'connection', component: 'backup-ssh-connection', details: { name: payload.name, host: payload.host, port: payload.port, authType: payload.authType } },
    () => getBackupSshConnectionService().create(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:connections:ssh:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-ssh', resourceType: 'connection', resourceId: payload.id, component: 'backup-ssh-connection' },
    () => getBackupSshConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:ssh:browse', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSshConnectionService().browse(context.workspaceId, payload.id, {
    path: payload.path,
    cursor: payload.cursor,
    pageSize: payload.pageSize
  });
});

ipcMain.handle('backup:native-tools:status', async (_event, payload = {}) => {
  return getBackupNativeToolManager().status(payload.engine);
});

ipcMain.handle('backup:native-tools:install', async (_event, payload = {}) => {
  const engine = String(payload.engine || '').trim().toLowerCase();
  const sender = _event.sender;
  let lastProgressSentAt = 0;
  const sendProgress = (progress = {}) => {
    const now = Date.now();
    const percentValue = progress.percent;
    const percent = percentValue !== null && percentValue !== undefined && percentValue !== '' && Number.isFinite(Number(percentValue))
      ? Number(percentValue)
      : null;
    if (percent !== 100 && now - lastProgressSentAt < 100) return;
    lastProgressSentAt = now;
    if (!sender.isDestroyed()) sender.send('backup:native-tools:progress', {
      engine,
      phase: 'download',
      receivedBytes: Number(progress.receivedBytes || 0),
      totalBytes: Number(progress.totalBytes || 0),
      percent
    });
  };
  return getBackupNativeToolManager().install(engine, { onProgress: sendProgress });
});

ipcMain.handle('backup:connections:mysql:list', async () => {
  const context = await backupSecretContext();
  return getBackupMysqlConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:mysql:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-mysql', resourceType: 'connection', component: 'backup-mysql-connection', details: { name: payload.name, host: payload.host, port: payload.port, username: payload.username, tlsMode: payload.tlsMode } },
    () => createCoreDatabaseConnection(MYSQL_ADAPTER_ID, () => getBackupMysqlConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:mysql:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-mysql', resourceType: 'connection', resourceId: payload.id, component: 'backup-mysql-connection' },
    () => getBackupMysqlConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:mysql:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMysqlConnectionService().discover(context.workspaceId, payload.id, { includeSystem: payload.includeSystem, kind: payload.kind, database: payload.database, schema: payload.schema });
});

ipcMain.handle('backup:connections:mariadb:list', async () => {
  const context = await backupSecretContext();
  return getBackupMariadbConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:mariadb:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-mariadb', resourceType: 'connection', component: 'backup-mariadb-connection', details: { name: payload.name, host: payload.host, port: payload.port, username: payload.username, tlsMode: payload.tlsMode } },
    () => createCoreDatabaseConnection(MARIADB_ADAPTER_ID, () => getBackupMariadbConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:mariadb:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-mariadb', resourceType: 'connection', resourceId: payload.id, component: 'backup-mariadb-connection' },
    () => getBackupMariadbConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:mariadb:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMariadbConnectionService().discover(context.workspaceId, payload.id, { includeSystem: payload.includeSystem, kind: payload.kind, database: payload.database, schema: payload.schema });
});

ipcMain.handle('backup:connections:postgresql:list', async () => {
  const context = await backupSecretContext();
  return getBackupPostgresqlConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:postgresql:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-postgresql', resourceType: 'connection', component: 'backup-postgresql-connection', details: { name: payload.name, host: payload.host, port: payload.port, username: payload.username, maintenanceDatabase: payload.maintenanceDatabase, tlsMode: payload.tlsMode } },
    () => createCoreDatabaseConnection(POSTGRESQL_ADAPTER_ID, () => getBackupPostgresqlConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:postgresql:update', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.update-postgresql', resourceType: 'connection', resourceId: payload.id, component: 'backup-postgresql-connection', details: { name: payload.name, host: payload.host, port: payload.port, username: payload.username, maintenanceDatabase: payload.maintenanceDatabase, tlsMode: payload.tlsMode } },
    () => getBackupPostgresqlConnectionService().update(context.workspaceId, context.actorId, payload.id, payload)
  );
});

ipcMain.handle('backup:connections:postgresql:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-postgresql', resourceType: 'connection', resourceId: payload.id, component: 'backup-postgresql-connection' },
    () => getBackupPostgresqlConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:postgresql:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupPostgresqlConnectionService().discover(context.workspaceId, payload.id, { includeSystem: payload.includeSystem, kind: payload.kind, database: payload.database, schema: payload.schema });
});

ipcMain.handle('backup:connections:sqlserver:list', async () => {
  const context = await backupSecretContext();
  return getBackupSqlServerConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:sqlserver:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-sqlserver', resourceType: 'connection', component: 'backup-sqlserver-connection', details: { name: payload.name, host: payload.host, port: payload.port, username: payload.username, tlsMode: payload.tlsMode } },
    () => createCoreDatabaseConnection(SQLSERVER_ADAPTER_ID, () => getBackupSqlServerConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:sqlserver:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-sqlserver', resourceType: 'connection', resourceId: payload.id, component: 'backup-sqlserver-connection' },
    () => getBackupSqlServerConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:sqlserver:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSqlServerConnectionService().discover(context.workspaceId, payload.id, { includeSystem: payload.includeSystem });
});

ipcMain.handle('backup:connections:oracle:list', async () => {
  const context = await backupSecretContext();
  return getBackupOracleConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:oracle:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-oracle', resourceType: 'connection', component: 'backup-oracle-connection', details: { name: payload.name, host: payload.host, port: payload.port, serviceName: payload.serviceName, username: payload.username, tlsMode: payload.tlsMode } },
    () => createCoreDatabaseConnection(ORACLE_ADAPTER_ID, () => getBackupOracleConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:oracle:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-oracle', resourceType: 'connection', resourceId: payload.id, component: 'backup-oracle-connection' },
    () => getBackupOracleConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:oracle:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupOracleConnectionService().discover(context.workspaceId, payload.id);
});

ipcMain.handle('backup:connections:mongodb:list', async () => {
  const context = await backupSecretContext();
  return getBackupMongoDbConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:mongodb:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-mongodb', resourceType: 'connection', component: 'backup-mongodb-connection', details: { name: payload.name, host: payload.host, port: payload.port, username: payload.username, authSource: payload.authSource, replicaSet: payload.replicaSet, expectedTopology: payload.expectedTopology, tlsMode: payload.tlsMode } },
    () => createCoreDatabaseConnection(MONGODB_ADAPTER_ID, () => getBackupMongoDbConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:mongodb:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-mongodb', resourceType: 'connection', resourceId: payload.id, component: 'backup-mongodb-connection' },
    () => getBackupMongoDbConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:mongodb:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMongoDbConnectionService().discover(context.workspaceId, payload.id, { includeSystem: payload.includeSystem });
});

ipcMain.handle('backup:connections:redis:list', async () => {
  const context = await backupSecretContext();
  return getBackupRedisConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:redis:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-redis', resourceType: 'connection', component: 'backup-redis-connection', details: { name: payload.name, host: payload.host, port: payload.port, username: payload.username, expectedTopology: payload.expectedTopology, tlsMode: payload.tlsMode, filesystemConnectionId: payload.filesystemConnectionId } },
    () => createCoreDatabaseConnection(REDIS_ADAPTER_ID, () => getBackupRedisConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:redis:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-redis', resourceType: 'connection', resourceId: payload.id, component: 'backup-redis-connection' },
    () => getBackupRedisConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:redis:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupRedisConnectionService().discover(context.workspaceId, payload.id);
});

ipcMain.handle('backup:connections:neo4j:list', async () => {
  const context = await backupSecretContext();
  return getBackupNeo4jConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:clickhouse:list', async () => {
  const context = await backupSecretContext();
  return getBackupClickHouseConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:influxdb:list', async () => {
  const context = await backupSecretContext();
  return getBackupInfluxDbConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:influxdb:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-influxdb', resourceType: 'connection', component: 'backup-influxdb-connection', details: { name: payload.name, protocol: payload.protocol, allowInsecureHttp: payload.allowInsecureHttp === true, host: payload.host, port: payload.port } },
    () => createCoreDatabaseConnection(INFLUXDB_ADAPTER_ID, () => getBackupInfluxDbConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:influxdb:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-influxdb', resourceType: 'connection', resourceId: payload.id, component: 'backup-influxdb-connection' },
    () => getBackupInfluxDbConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:influxdb:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDbConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:connections:influxdb3-enterprise:list', async () => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:influxdb3-enterprise:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-influxdb3-enterprise', resourceType: 'connection', component: 'backup-influxdb3-enterprise-connection', details: { name: payload.name, protocol: payload.protocol, allowInsecureHttp: payload.allowInsecureHttp === true, host: payload.host, port: payload.port } },
    () => createCoreDatabaseConnection(INFLUXDB3_ENTERPRISE_ADAPTER_ID, () => getBackupInfluxDb3EnterpriseConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:influxdb3-enterprise:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-influxdb3-enterprise', resourceType: 'connection', resourceId: payload.id, component: 'backup-influxdb3-enterprise-connection' },
    () => getBackupInfluxDb3EnterpriseConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:influxdb3-enterprise:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:influxdb3-enterprise-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb3-enterprise-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb3-enterprise-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation({
    message: 'Roll back this InfluxDB 3 Enterprise live cluster?',
    detail: 'This is a destructive, in-place, cluster-wide point-in-time rollback. The catalog is rewritten and WAL is truncated to the backup watermark. Row deletes may persist because row-delete state is not captured, and DeployerX cannot roll back the restore.',
    confirmLabel: 'Roll Back Live Cluster'
  });
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-influxdb3-enterprise-in-place', resourceType: 'restore-run', component: 'backup-influxdb3-enterprise-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId || null, mode: 'in-place', destructive: true, confirmed } },
    () => getBackupInfluxDb3EnterpriseRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: 'in-place', confirmed, confirmationText: confirmed ? INFLUXDB3_ENTERPRISE_RESTORE_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:influxdb3-enterprise-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:influxdb3-enterprise-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-influxdb3-enterprise', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-influxdb3-enterprise-restore' }, () => getBackupInfluxDb3EnterpriseRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:influxdb3-enterprise-retention:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const details = influxDb3EnterpriseRetentionAuditDetails();
  return runAuditedBackupMutation(
    context,
    { action: 'retention.preview-influxdb3-enterprise-native', resourceType: 'retention-plan', component: 'backup-influxdb3-enterprise-retention', details, failureAuditCode: 'INFLUXDB3_ENTERPRISE_RETENTION_OPERATION_FAILED', resultAudit: influxDb3EnterpriseRetentionPreviewResultAudit },
    () => getBackupInfluxDb3EnterpriseRetentionService().preview(context.workspaceId, { recoveryPointId: payload.recoveryPointId })
  );
});

ipcMain.handle('backup:influxdb3-enterprise-retention:execute', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const textMatched = payload.confirmed === true && payload.confirmationText === INFLUXDB3_ENTERPRISE_DELETE_CONFIRMATION;
  const confirmed = textMatched && await requestInAppConfirmation({
    message: 'Delete this InfluxDB 3 Enterprise native backup closure?',
    detail: 'InfluxDB 3 Enterprise will delete the reviewed backup and every incremental descendant. Repository metadata is preserved, but the deleted native recovery points cannot be restored.',
    confirmLabel: 'Delete Native Backups'
  });
  const request = { recoveryPointId: payload.recoveryPointId, planId: payload.planId, confirmed, confirmationText: confirmed ? INFLUXDB3_ENTERPRISE_DELETE_CONFIRMATION : '' };
  const details = influxDb3EnterpriseRetentionAuditDetails(request);
  return runAuditedBackupMutation(
    context,
    { action: 'retention.execute-influxdb3-enterprise-native', resourceType: 'retention-plan', resourceId: details.planId, component: 'backup-influxdb3-enterprise-retention', details, failureAuditCode: 'INFLUXDB3_ENTERPRISE_RETENTION_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseRetentionService().execute(context.workspaceId, context.actorId, request)
  );
});

ipcMain.handle('backup:influxdb3-enterprise-verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'verification.list-influxdb3-enterprise', resourceType: 'verification-run', component: 'backup-influxdb3-enterprise-verification', details: { mode: INFLUXDB3_ENTERPRISE_METADATA_MODE }, failureAuditCode: 'INFLUXDB3_ENTERPRISE_VERIFICATION_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseRecoveryTestService().list(context.workspaceId, payload)
  );
});

ipcMain.handle('backup:influxdb3-enterprise-verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'verification.start-influxdb3-enterprise', resourceType: 'verification-run', component: 'backup-influxdb3-enterprise-verification', details: { mode: INFLUXDB3_ENTERPRISE_METADATA_MODE }, failureAuditCode: 'INFLUXDB3_ENTERPRISE_VERIFICATION_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseRecoveryTestService().start(context.workspaceId, context.actorId, { recoveryPointId: payload.recoveryPointId, mode: INFLUXDB3_ENTERPRISE_METADATA_MODE })
  );
});

ipcMain.handle('backup:influxdb3-enterprise-verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'verification.wait-influxdb3-enterprise', resourceType: 'verification-run', component: 'backup-influxdb3-enterprise-verification', failureAuditCode: 'INFLUXDB3_ENTERPRISE_VERIFICATION_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseRecoveryTestService().wait(context.workspaceId, payload.verificationRunId)
  );
});

ipcMain.handle('backup:influxdb3-enterprise-verifications:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'verification.cancel-influxdb3-enterprise', resourceType: 'verification-run', component: 'backup-influxdb3-enterprise-verification', failureAuditCode: 'INFLUXDB3_ENTERPRISE_VERIFICATION_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseRecoveryTestService().cancel(context.workspaceId, context.actorId, payload.verificationRunId)
  );
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-retention:plan', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseLegacyRetentionService().planDeletion(context.workspaceId, payload.recoveryPointId, payload.repositoryId);
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-retention:execute', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'retention.delete-influxdb3-enterprise-legacy-copy', resourceType: 'recovery-point', resourceId: payload.recoveryPointId, component: 'backup-influxdb3-enterprise-legacy-retention', details: { planId: payload.planId, repositoryId: payload.repositoryId } },
    () => getBackupInfluxDb3EnterpriseLegacyRetentionService().executeDeletion(context.workspaceId, context.actorId, payload.recoveryPointId, payload.repositoryId, payload.planId)
  );
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseLegacyRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseLegacyRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation({
    message: 'Restore this InfluxDB 3 Enterprise legacy cluster to alternate storage?',
    detail: 'DeployerX authenticates the complete legacy filesystem media, requires an empty stopped alternate target, preserves partial target data for inspection, and never claims cleanup or rollback.',
    confirmLabel: 'Restore alternate storage'
  });
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-influxdb3-enterprise-legacy', resourceType: 'restore-run', component: 'backup-influxdb3-enterprise-legacy-restore', details: { recoveryPointId: payload.recoveryPointId, mode: 'alternate', confirmed }, failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseLegacyRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: 'alternate', confirmed, confirmationText: confirmed ? INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseLegacyRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'restore.cancel-influxdb3-enterprise-legacy', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-influxdb3-enterprise-legacy-restore', failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseLegacyRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId)
  );
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseLegacyRecoveryTestService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const requestedMode = String(payload.mode || INFLUXDB3_ENTERPRISE_LEGACY_METADATA_MODE);
  let confirmed = false;
  if (requestedMode === INFLUXDB3_ENTERPRISE_LEGACY_DRILL_MODE) {
    confirmed = await requestInAppConfirmation({
      message: 'Run a full InfluxDB 3 Enterprise legacy recovery drill?',
      detail: 'DeployerX authenticates the complete legacy media, proves the exact cluster is stopped, restores to isolated alternate storage, validates the installed filesystem, and preserves the target for inspection without cleanup or rollback.',
      confirmLabel: 'Run recovery drill'
    });
  }
  const auditMode = [INFLUXDB3_ENTERPRISE_LEGACY_METADATA_MODE, INFLUXDB3_ENTERPRISE_LEGACY_DRILL_MODE].includes(requestedMode) ? requestedMode : null;
  return runAuditedBackupMutation(
    context,
    { action: 'verification.start-influxdb3-enterprise-legacy', resourceType: 'verification-run', component: 'backup-influxdb3-enterprise-legacy-verification', details: { recoveryPointId: payload.recoveryPointId, mode: auditMode, confirmed }, failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseLegacyRecoveryTestService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? INFLUXDB3_ENTERPRISE_LEGACY_DRILL_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3EnterpriseLegacyRecoveryTestService().wait(context.workspaceId, payload.verificationRunId);
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-verifications:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'verification.cancel-influxdb3-enterprise-legacy', resourceType: 'verification-run', resourceId: payload.verificationRunId, component: 'backup-influxdb3-enterprise-legacy-verification', failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseLegacyRecoveryTestService().cancel(context.workspaceId, context.actorId, payload.verificationRunId)
  );
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-stop-bindings:list', async () => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'stop-binding.list-influxdb3-enterprise-legacy', resourceType: 'stop-binding', component: 'backup-influxdb3-enterprise-legacy-stop-binding', failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseLegacyStopBindingService().list(context.workspaceId)
  );
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-stop-bindings:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'stop-binding.create-influxdb3-enterprise-legacy', resourceType: 'stop-binding', component: 'backup-influxdb3-enterprise-legacy-stop-binding', failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseLegacyStopBindingService().create(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:influxdb3-enterprise-legacy-stop-bindings:remove', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'stop-binding.remove-influxdb3-enterprise-legacy', resourceType: 'stop-binding', resourceId: payload.bindingId, component: 'backup-influxdb3-enterprise-legacy-stop-binding', failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_OPERATION_FAILED' },
    () => getBackupInfluxDb3EnterpriseLegacyStopBindingService().remove(context.workspaceId, payload.bindingId, context.actorId, { expectedRevision: payload.expectedRevision })
  );
});

ipcMain.handle('backup:connections:influxdb3-core:list', async () => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3CoreConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:influxdb3-core:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-influxdb3-core', resourceType: 'connection', component: 'backup-influxdb3-core-connection', details: { name: payload.name, protocol: payload.protocol, allowInsecureHttp: payload.allowInsecureHttp === true, host: payload.host, port: payload.port, nodeId: payload.nodeId, objectStore: ['file', 's3', 'azure', 'google'].includes(payload.objectStore) ? payload.objectStore : 'unknown', filesystemBindingConfirmed: payload.confirmationText === 'BIND INFLUXDB CORE FILESYSTEM', s3BindingConfirmed: payload.confirmationText === 'BIND INFLUXDB CORE S3', azureBindingConfirmed: payload.confirmationText === 'BIND INFLUXDB CORE AZURE', gcsBindingConfirmed: payload.confirmationText === 'BIND INFLUXDB CORE GCS' } },
    () => createCoreDatabaseConnection(INFLUXDB3_CORE_ADAPTER_ID, () => getBackupInfluxDb3CoreConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:influxdb3-core:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-influxdb3-core', resourceType: 'connection', resourceId: payload.id, component: 'backup-influxdb3-core-connection' },
    () => getBackupInfluxDb3CoreConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:influxdb3-core:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3CoreConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:influxdb3-core-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3CoreRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb3-core-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3CoreRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb3-core-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = payload.confirmed === true && String(payload.confirmationText || '').trim() === INFLUXDB3_CORE_RESTORE_CONFIRMATION;
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-influxdb3-core-alternate', resourceType: 'restore-run', component: 'backup-influxdb3-core-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, mode: 'alternate', confirmed } },
    () => getBackupInfluxDb3CoreRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: 'alternate', confirmed, confirmationText: confirmed ? INFLUXDB3_CORE_RESTORE_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:influxdb3-core-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3CoreRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:influxdb3-core-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-influxdb3-core', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-influxdb3-core-restore' }, () => getBackupInfluxDb3CoreRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:influxdb3-core-verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3CoreRecoveryTestService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb3-core-verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = String(payload.mode || '') === INFLUXDB3_CORE_DRILL_MODE
    && payload.confirmed === true
    && String(payload.confirmationText || '').trim() === INFLUXDB3_CORE_DRILL_CONFIRMATION;
  return runAuditedBackupMutation(
    context,
    { action: 'verification.start-influxdb3-core', resourceType: 'verification-run', component: 'backup-influxdb3-core-verification', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, mode: payload.mode, confirmed } },
    () => getBackupInfluxDb3CoreRecoveryTestService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? INFLUXDB3_CORE_DRILL_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:influxdb3-core-verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDb3CoreRecoveryTestService().wait(context.workspaceId, payload.verificationRunId);
});

ipcMain.handle('backup:influxdb3-core-verifications:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'verification.cancel-influxdb3-core', resourceType: 'verification-run', resourceId: payload.verificationRunId, component: 'backup-influxdb3-core-verification' }, () => getBackupInfluxDb3CoreRecoveryTestService().cancel(context.workspaceId, context.actorId, payload.verificationRunId));
});

ipcMain.handle('backup:influxdb-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDbRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDbRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation({
    message: 'Restore this InfluxDB backup to the alternate instance?',
    detail: 'DeployerX authenticates every encrypted native member, requires a distinct exact-version target, and validates restored organization, bucket, and retention identities. Once native restore begins, cancellation cannot claim rollback.',
    confirmLabel: 'Recover InfluxDB'
  });
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-influxdb-alternate', resourceType: 'restore-run', component: 'backup-influxdb-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, mode: 'alternate', confirmed } },
    () => getBackupInfluxDbRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: 'alternate', confirmed, confirmationText: confirmed ? INFLUXDB_RESTORE_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:influxdb-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDbRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:influxdb-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-influxdb', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-influxdb-restore' }, () => getBackupInfluxDbRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:influxdb-verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDbRecoveryTestService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:influxdb-verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  let confirmed = false;
  if (String(payload.mode || '') === INFLUXDB_DRILL_MODE) {
    confirmed = await requestInAppConfirmation({
      message: 'Run a full InfluxDB recovery drill?',
      detail: 'The complete encrypted backup will be authenticated, restored to the tested alternate instance, and validated. The alternate instance remains preserved; no cleanup or rollback is claimed.',
      confirmLabel: 'Run Recovery Drill'
    });
  }
  return runAuditedBackupMutation(
    context,
    { action: 'verification.start-influxdb', resourceType: 'verification-run', component: 'backup-influxdb-verification', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, mode: payload.mode, confirmed } },
    () => getBackupInfluxDbRecoveryTestService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? INFLUXDB_DRILL_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:influxdb-verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupInfluxDbRecoveryTestService().wait(context.workspaceId, payload.verificationRunId);
});

ipcMain.handle('backup:influxdb-verifications:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'verification.cancel-influxdb', resourceType: 'verification-run', resourceId: payload.verificationRunId, component: 'backup-influxdb-verification' }, () => getBackupInfluxDbRecoveryTestService().cancel(context.workspaceId, context.actorId, payload.verificationRunId));
});

ipcMain.handle('backup:connections:cockroachdb:list', async () => {
  const context = await backupSecretContext();
  return getBackupCockroachDbConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:cockroachdb:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-cockroachdb', resourceType: 'connection', component: 'backup-cockroachdb-connection', details: { name: payload.name, executionMode: payload.executionMode, sshConnectionId: payload.sshConnectionId, authMode: payload.authMode, allowInsecure: payload.allowInsecure === true, host: payload.host, port: payload.port, username: payload.username, database: payload.database } },
    () => createCoreDatabaseConnection(COCKROACHDB_ADAPTER_ID, () => getBackupCockroachDbConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:cockroachdb:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-cockroachdb', resourceType: 'connection', resourceId: payload.id, component: 'backup-cockroachdb-connection' },
    () => getBackupCockroachDbConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:cockroachdb:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupCockroachDbConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:connections:cockroachdb:approve-destination', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const destination = payload.destination && typeof payload.destination === 'object' ? payload.destination : {};
  return runAuditedBackupMutation(
    context,
    {
      action: 'connection.approve-cockroachdb-backup-destination',
      resourceType: 'connection',
      resourceId: payload.id,
      component: 'backup-cockroachdb-connection',
      details: {
        destinationType: destination.type || payload.type || null,
        localityBindingCount: Array.isArray(destination.localities || payload.localities) ? (destination.localities || payload.localities).length : 1,
        confirmed: String(payload.confirmationText || '').trim() === COCKROACHDB_BACKUP_DESTINATION_CONFIRMATION
      }
    },
    () => getBackupCockroachDbConnectionService().approveDestination(context.workspaceId, payload.id, payload, context.actorId)
  );
});

ipcMain.handle('backup:cockroachdb-schedules:plan', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'schedule.plan-cockroachdb-native', resourceType: 'backup-job', resourceId: payload.jobId, component: 'backup-cockroachdb-schedule', failureAuditCode: 'COCKROACH_NATIVE_SCHEDULE_OPERATION_FAILED' },
    () => getBackupCockroachDbScheduleService().preview(context.workspaceId, payload)
  );
});

ipcMain.handle('backup:cockroachdb-schedules:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'schedule.create-cockroachdb-native', resourceType: 'backup-job', resourceId: payload.jobId, component: 'backup-cockroachdb-schedule', failureAuditCode: 'COCKROACH_NATIVE_SCHEDULE_OPERATION_FAILED' },
    () => getBackupCockroachDbScheduleService().create(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:cockroachdb-schedules:list', async () => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'schedule.list-cockroachdb-native', resourceType: 'backup-job', component: 'backup-cockroachdb-schedule', failureAuditCode: 'COCKROACH_NATIVE_SCHEDULE_OPERATION_FAILED' },
    () => getBackupCockroachDbScheduleService().list(context.workspaceId)
  );
});

ipcMain.handle('backup:cockroachdb-schedules:reconcile', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'schedule.reconcile-cockroachdb-native', resourceType: 'backup-job', resourceId: payload.jobId, component: 'backup-cockroachdb-schedule', failureAuditCode: 'COCKROACH_NATIVE_SCHEDULE_OPERATION_FAILED' },
    () => getBackupCockroachDbScheduleService().reconcile(context.workspaceId, context.actorId, payload.jobId)
  );
});

ipcMain.handle('backup:cockroachdb-schedules:pause', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'schedule.pause-cockroachdb-native', resourceType: 'backup-job', resourceId: payload.jobId, component: 'backup-cockroachdb-schedule', failureAuditCode: 'COCKROACH_NATIVE_SCHEDULE_OPERATION_FAILED' },
    () => getBackupCockroachDbScheduleService().pause(context.workspaceId, context.actorId, payload.jobId)
  );
});

ipcMain.handle('backup:cockroachdb-schedules:resume', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'schedule.resume-cockroachdb-native', resourceType: 'backup-job', resourceId: payload.jobId, component: 'backup-cockroachdb-schedule', failureAuditCode: 'COCKROACH_NATIVE_SCHEDULE_OPERATION_FAILED' },
    () => getBackupCockroachDbScheduleService().resume(context.workspaceId, context.actorId, payload.jobId)
  );
});

ipcMain.handle('backup:cockroachdb-retention:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const details = cockroachDbRetentionAuditDetails(payload);
  return runAuditedBackupMutation(
    context,
    { action: 'retention.preview-cockroachdb', resourceType: 'retention-plan', resourceId: details.planId, component: 'backup-cockroachdb-retention', details, failureAuditCode: 'COCKROACH_RETENTION_OPERATION_FAILED' },
    () => getBackupCockroachDbRetentionService().preview(context.workspaceId, payload)
  );
});

ipcMain.handle('backup:cockroachdb-retention:execute', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const details = cockroachDbRetentionAuditDetails(payload);
  return runAuditedBackupMutation(
    context,
    { action: 'retention.execute-cockroachdb', resourceType: 'retention-plan', resourceId: details.planId, component: 'backup-cockroachdb-retention', details, failureAuditCode: 'COCKROACH_RETENTION_OPERATION_FAILED' },
    () => getBackupCockroachDbRetentionService().execute(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:cockroachdb-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupCockroachDbRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:cockroachdb-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupCockroachDbRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:cockroachdb-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation({
    message: 'Restore this CockroachDB backup to the empty alternate target?',
    detail: 'DeployerX authenticates the complete native chain, validates revision-history bounds and region compatibility, submits one exact detached restore, and preserves the alternate target for inspection. Once native submission begins, cancellation cannot claim rollback.',
    confirmLabel: 'Recover CockroachDB'
  });
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-cockroachdb-alternate', resourceType: 'restore-run', component: 'backup-cockroachdb-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, restoreTimestamp: payload.restoreTimestamp || null, mode: 'alternate', confirmed } },
    () => getBackupCockroachDbRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: 'alternate', confirmed, confirmationText: confirmed ? COCKROACHDB_RESTORE_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:cockroachdb-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupCockroachDbRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:cockroachdb-restores:pause', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.pause-cockroachdb', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-cockroachdb-restore' }, () => getBackupCockroachDbRestoreService().pause(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:cockroachdb-restores:resume', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.resume-cockroachdb', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-cockroachdb-restore' }, () => getBackupCockroachDbRestoreService().resume(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:cockroachdb-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-cockroachdb', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-cockroachdb-restore' }, () => getBackupCockroachDbRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:cockroachdb-verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'verification.list-cockroachdb', resourceType: 'verification-run', component: 'backup-cockroachdb-verification', failureAuditCode: 'COCKROACH_VERIFICATION_OPERATION_FAILED' },
    () => getBackupCockroachDbRecoveryTestService().list(context.workspaceId, payload)
  );
});

ipcMain.handle('backup:cockroachdb-verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const requestedMode = String(payload.mode || COCKROACHDB_METADATA_MODE);
  let confirmed = false;
  if (requestedMode === COCKROACHDB_DRILL_MODE) {
    confirmed = await requestInAppConfirmation({
      message: 'Run a full CockroachDB recovery drill?',
      detail: 'DeployerX authenticates the complete native chain, revalidates the protected cluster, restores the selected point to one empty alternate database, and runs native integrity validation. The alternate target remains preserved for inspection; cleanup and rollback are not claimed.',
      confirmLabel: 'Run recovery drill'
    });
  }
  const auditMode = [COCKROACHDB_METADATA_MODE, COCKROACHDB_DRILL_MODE].includes(requestedMode) ? requestedMode : null;
  return runAuditedBackupMutation(
    context,
    { action: 'verification.start-cockroachdb', resourceType: 'verification-run', component: 'backup-cockroachdb-verification', details: { recoveryPointId: payload.recoveryPointId, mode: auditMode, confirmed }, failureAuditCode: 'COCKROACH_VERIFICATION_OPERATION_FAILED' },
    () => getBackupCockroachDbRecoveryTestService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? COCKROACHDB_DRILL_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:cockroachdb-verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'verification.wait-cockroachdb', resourceType: 'verification-run', resourceId: payload.verificationRunId, component: 'backup-cockroachdb-verification', failureAuditCode: 'COCKROACH_VERIFICATION_OPERATION_FAILED' },
    () => getBackupCockroachDbRecoveryTestService().wait(context.workspaceId, payload.verificationRunId)
  );
});

ipcMain.handle('backup:cockroachdb-verifications:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'verification.cancel-cockroachdb', resourceType: 'verification-run', resourceId: payload.verificationRunId, component: 'backup-cockroachdb-verification', failureAuditCode: 'COCKROACH_VERIFICATION_OPERATION_FAILED' },
    () => getBackupCockroachDbRecoveryTestService().cancel(context.workspaceId, context.actorId, payload.verificationRunId)
  );
});

ipcMain.handle('backup:connections:clickhouse:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-clickhouse', resourceType: 'connection', component: 'backup-clickhouse-connection', details: { name: payload.name, executionMode: payload.executionMode, sshConnectionId: payload.sshConnectionId, host: payload.host, port: payload.port, tlsMode: payload.tlsMode, username: payload.username } },
    () => createCoreDatabaseConnection(CLICKHOUSE_ADAPTER_ID, () => getBackupClickHouseConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:clickhouse:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-clickhouse', resourceType: 'connection', resourceId: payload.id, component: 'backup-clickhouse-connection' },
    () => getBackupClickHouseConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:clickhouse:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupClickHouseConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:connections:clickhouse:approve-destination', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = String(payload.confirmationText || '').trim() === CLICKHOUSE_DESTINATION_CONFIRMATION;
  return runAuditedBackupMutation(
    context,
    { action: 'connection.approve-clickhouse-destination', resourceType: 'connection', resourceId: payload.id, component: 'backup-clickhouse-connection', details: { diskName: payload.diskName, confirmed } },
    () => getBackupClickHouseConnectionService().approveDestination(context.workspaceId, payload.id, { diskName: payload.diskName, confirmationText: payload.confirmationText }, context.actorId)
  );
});

ipcMain.handle('backup:clickhouse-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupClickHouseRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:clickhouse-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupClickHouseRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:clickhouse-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation({
    message: 'Restore the ClickHouse backup into the empty alternate database?',
    detail: 'DeployerX authenticates the complete native chain, revalidates the tested target and backup disk, monitors one exact native restore, and validates restored object and row/part evidence. Once native submission begins, cancellation cannot claim rollback.',
    confirmLabel: 'Recover ClickHouse'
  });
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-clickhouse-alternate', resourceType: 'restore-run', component: 'backup-clickhouse-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, mode: 'alternate', confirmed } },
    () => getBackupClickHouseRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: 'alternate', confirmed, confirmationText: confirmed ? CLICKHOUSE_RESTORE_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:clickhouse-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupClickHouseRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:clickhouse-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-clickhouse', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-clickhouse-restore' }, () => getBackupClickHouseRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:clickhouse-verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupClickHouseRecoveryTestService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:clickhouse-verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  let confirmed = false;
  if (String(payload.mode || '') === CLICKHOUSE_DRILL_MODE) {
    confirmed = await requestInAppConfirmation({
      message: 'Run a full ClickHouse recovery drill?',
      detail: 'DeployerX authenticates the complete backup chain, revalidates the protected source, restores one empty alternate database scope, and validates native object and row/part evidence. The target remains preserved for inspection; cleanup and rollback are not claimed.',
      confirmLabel: 'Run recovery drill'
    });
  }
  return runAuditedBackupMutation(
    context,
    { action: 'verification.start-clickhouse', resourceType: 'verification-run', component: 'backup-clickhouse-verification', details: { recoveryPointId: payload.recoveryPointId, mode: payload.mode, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, confirmed } },
    () => getBackupClickHouseRecoveryTestService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? CLICKHOUSE_DRILL_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:clickhouse-verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupClickHouseRecoveryTestService().wait(context.workspaceId, payload.verificationRunId);
});

ipcMain.handle('backup:clickhouse-verifications:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'verification.cancel-clickhouse', resourceType: 'verification-run', resourceId: payload.verificationRunId, component: 'backup-clickhouse-verification' }, () => getBackupClickHouseRecoveryTestService().cancel(context.workspaceId, context.actorId, payload.verificationRunId));
});

ipcMain.handle('backup:connections:neo4j:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-neo4j', resourceType: 'connection', component: 'backup-neo4j-connection', details: { name: payload.name, expectedEdition: payload.expectedEdition, executionMode: payload.executionMode, sshConnectionId: payload.sshConnectionId, address: payload.address, username: payload.username } },
    () => createCoreDatabaseConnection(NEO4J_ADAPTER_ID, () => getBackupNeo4jConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:neo4j:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-neo4j', resourceType: 'connection', resourceId: payload.id, component: 'backup-neo4j-connection' },
    () => getBackupNeo4jConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:neo4j:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNeo4jConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:connections:cassandra-scylla:list', async () => {
  const context = await backupSecretContext();
  return getBackupCassandraScyllaConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:cassandra-scylla:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-cassandra-scylla', resourceType: 'connection', component: 'backup-cassandra-scylla-connection', details: { name: payload.name, expectedProduct: payload.expectedProduct, executionMode: payload.executionMode, sshConnectionId: payload.sshConnectionId, contactHost: payload.contactHost, nativePort: payload.nativePort, cqlUsername: payload.cqlUsername } },
    () => createCoreDatabaseConnection(CASSANDRA_SCYLLA_ADAPTER_ID, () => getBackupCassandraScyllaConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:cassandra-scylla:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-cassandra-scylla', resourceType: 'connection', resourceId: payload.id, component: 'backup-cassandra-scylla-connection' },
    () => getBackupCassandraScyllaConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:cassandra-scylla:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupCassandraScyllaConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:cassandra-scylla-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupCassandraScyllaRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:cassandra-scylla-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupCassandraScyllaRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:cassandra-scylla-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-cassandra-scylla', resourceType: 'restore-run', component: 'backup-cassandra-scylla-restore', details: { recoveryPointId: payload.recoveryPointId, mode: payload.mode, targetSeedConnectionId: payload.targetSeedConnectionId, conflictPolicy: payload.conflictPolicy } },
    () => getBackupCassandraScyllaRestoreService().start(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:cassandra-scylla-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupCassandraScyllaRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:cassandra-scylla-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'restore.cancel-cassandra-scylla', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-cassandra-scylla-restore' },
    () => getBackupCassandraScyllaRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId)
  );
});

ipcMain.handle('backup:connections:scylla-manager:list', async () => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:scylla-manager:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-scylla-manager', resourceType: 'connection', component: 'backup-scylla-manager-connection', details: { name: payload.name, host: payload.host, port: payload.port, basePath: payload.basePath, authMode: payload.authMode, username: payload.username, managedClusterId: payload.managedClusterId, tlsMode: payload.tlsMode } },
    () => createCoreDatabaseConnection(SCYLLA_MANAGER_ADAPTER_ID, () => getBackupScyllaManagerConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:scylla-manager:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-scylla-manager', resourceType: 'connection', resourceId: payload.id, component: 'backup-scylla-manager-connection' },
    () => getBackupScyllaManagerConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:scylla-manager:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:connections:scylla-manager:verify-target', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.verify-scylla-manager-target', resourceType: 'connection', resourceId: payload.id, component: 'backup-scylla-manager-connection', details: { taskName: payload.taskUpdate?.name, managedClusterId: payload.managedClusterId } },
    () => getBackupScyllaManagerConnectionService().verifyTarget(context.workspaceId, payload.id, { taskUpdate: payload.taskUpdate }, context.actorId)
  );
});

ipcMain.handle('backup:scylla-manager:tasks:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerConnectionService().listTasks(context.workspaceId, payload.connectionId, { type: payload.type });
});

ipcMain.handle('backup:scylla-manager:tasks:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'task.start-scylla-manager', resourceType: 'manager-task', resourceId: payload.taskId, component: 'backup-scylla-manager-task', details: { connectionId: payload.connectionId, type: payload.type, continue: payload.continue === true } }, () => getBackupScyllaManagerConnectionService().startTask(context.workspaceId, payload.connectionId, payload));
});

ipcMain.handle('backup:scylla-manager:tasks:stop', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'task.stop-scylla-manager', resourceType: 'manager-task', resourceId: payload.taskId, component: 'backup-scylla-manager-task', details: { connectionId: payload.connectionId, type: payload.type, disable: payload.disable === true } }, () => getBackupScyllaManagerConnectionService().stopTask(context.workspaceId, payload.connectionId, payload));
});

ipcMain.handle('backup:scylla-manager:tasks:history', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerConnectionService().history(context.workspaceId, payload.connectionId, payload);
});

ipcMain.handle('backup:scylla-manager:tasks:progress', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerConnectionService().progress(context.workspaceId, payload.connectionId, payload);
});

ipcMain.handle('backup:scylla-manager:backups:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerConnectionService().listBackups(context.workspaceId, payload.connectionId, payload);
});

ipcMain.handle('backup:scylla-manager-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:scylla-manager-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:scylla-manager-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = String(payload.confirmationText || '').trim() === SCYLLA_MANAGER_RESTORE_CONFIRMATION;
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-scylla-manager-alternate', resourceType: 'restore-run', component: 'backup-scylla-manager-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, confirmed } },
    () => getBackupScyllaManagerRestoreService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? SCYLLA_MANAGER_RESTORE_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:scylla-manager-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:scylla-manager-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-scylla-manager', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-scylla-manager-restore' }, () => getBackupScyllaManagerRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:scylla-manager-verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerRecoveryTestService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:scylla-manager-verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = String(payload.confirmationText || '').trim() === SCYLLA_MANAGER_DRILL_CONFIRMATION;
  return runAuditedBackupMutation(
    context,
    { action: 'verification.start-scylla-manager', resourceType: 'verification-run', component: 'backup-scylla-manager-verification', details: { recoveryPointId: payload.recoveryPointId, mode: payload.mode, targetConnectionId: payload.targetConnectionId, confirmed } },
    () => getBackupScyllaManagerRecoveryTestService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? SCYLLA_MANAGER_DRILL_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:scylla-manager-verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupScyllaManagerRecoveryTestService().wait(context.workspaceId, payload.verificationRunId);
});

ipcMain.handle('backup:scylla-manager-verifications:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'verification.cancel-scylla-manager', resourceType: 'verification-run', resourceId: payload.verificationRunId, component: 'backup-scylla-manager-verification' }, () => getBackupScyllaManagerRecoveryTestService().cancel(context.workspaceId, context.actorId, payload.verificationRunId));
});

ipcMain.handle('backup:connections:search-snapshot:list', async () => {
  const context = await backupSecretContext();
  return getBackupSearchSnapshotConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:search-snapshot:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-search-snapshot', resourceType: 'connection', component: 'backup-search-snapshot-connection', details: { name: payload.name, host: payload.host, port: payload.port, basePath: payload.basePath, authMode: payload.authMode, username: payload.username, expectedProduct: payload.expectedProduct, tlsMode: payload.tlsMode } },
    () => createCoreDatabaseConnection(SEARCH_SNAPSHOT_ADAPTER_ID, () => getBackupSearchSnapshotConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:search-snapshot:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-search-snapshot', resourceType: 'connection', resourceId: payload.id, component: 'backup-search-snapshot-connection' },
    () => getBackupSearchSnapshotConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:search-snapshot:verify-repository', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.verify-search-repository', resourceType: 'connection', resourceId: payload.id, component: 'backup-search-snapshot-connection', details: { repositoryName: payload.repositoryName } },
    () => getBackupSearchSnapshotConnectionService().verifyRepository(context.workspaceId, payload.id, payload.repositoryName, context.actorId)
  );
});

ipcMain.handle('backup:connections:search-snapshot:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSearchSnapshotConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:search-snapshot-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSearchSnapshotRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:search-snapshot-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSearchSnapshotRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:search-snapshot-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = String(payload.confirmationText || '').trim() === SEARCH_RESTORE_CONFIRMATION;
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-search-alternate', resourceType: 'restore-run', component: 'backup-search-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, renamePrefix: payload.renamePrefix, confirmed } },
    () => getBackupSearchSnapshotRestoreService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? SEARCH_RESTORE_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:search-snapshot-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSearchSnapshotRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:search-snapshot-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-search', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-search-restore' }, () => getBackupSearchSnapshotRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:search-snapshot-retention:plan', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSearchSnapshotMaintenanceService().planRetention(context.workspaceId, payload.recoveryPointId);
});

ipcMain.handle('backup:search-snapshot-retention:execute', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'retention.delete-search-snapshot', resourceType: 'recovery-point', resourceId: payload.recoveryPointId, component: 'backup-search-retention', details: { planId: payload.planId } },
    () => getBackupSearchSnapshotMaintenanceService().executeRetention(context.workspaceId, context.actorId, payload.recoveryPointId, payload.planId)
  );
});

ipcMain.handle('backup:search-snapshot-repositories:cleanup', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = String(payload.confirmationText || '').trim() === SEARCH_CLEANUP_CONFIRMATION;
  return runAuditedBackupMutation(
    context,
    { action: 'repository.cleanup-search-native', resourceType: 'connection', resourceId: payload.connectionId, component: 'backup-search-maintenance', details: { repositoryName: payload.repositoryName, confirmed } },
    () => getBackupSearchSnapshotMaintenanceService().cleanupRepository(context.workspaceId, context.actorId, { ...payload, confirmationText: confirmed ? SEARCH_CLEANUP_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:search-snapshot-verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSearchSnapshotRecoveryTestService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:search-snapshot-verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = String(payload.confirmationText || '').trim() === SEARCH_DRILL_CONFIRMATION;
  return runAuditedBackupMutation(
    context,
    { action: 'verification.start-search-snapshot', resourceType: 'verification-run', component: 'backup-search-verification', details: { recoveryPointId: payload.recoveryPointId, mode: payload.mode, targetConnectionId: payload.targetConnectionId, confirmed } },
    () => getBackupSearchSnapshotRecoveryTestService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? SEARCH_DRILL_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:search-snapshot-verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSearchSnapshotRecoveryTestService().wait(context.workspaceId, payload.verificationRunId);
});

ipcMain.handle('backup:search-snapshot-verifications:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'verification.cancel-search-snapshot', resourceType: 'verification-run', resourceId: payload.verificationRunId, component: 'backup-search-verification' }, () => getBackupSearchSnapshotRecoveryTestService().cancel(context.workspaceId, context.actorId, payload.verificationRunId));
});

ipcMain.handle('backup:connections:sqlite:list', async () => {
  const context = await backupSecretContext();
  return getBackupSqliteConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:connections:sqlite:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.create-sqlite', resourceType: 'connection', component: 'backup-sqlite-connection', details: { name: payload.name } },
    () => createCoreDatabaseConnection(SQLITE_ADAPTER_ID, () => getBackupSqliteConnectionService().create(context.workspaceId, context.actorId, payload))
  );
});

ipcMain.handle('backup:connections:sqlite:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'connection.test-sqlite', resourceType: 'connection', resourceId: payload.id, component: 'backup-sqlite-connection' },
    () => getBackupSqliteConnectionService().test(context.workspaceId, payload.id, context.actorId)
  );
});

ipcMain.handle('backup:connections:sqlite:discover', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSqliteConnectionService().discover(context.workspaceId, payload.id, { kind: payload.kind });
});

ipcMain.handle('backup:file-sources:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupFileSourceService().list(context.workspaceId, { connectionId: payload.connectionId });
});

ipcMain.handle('backup:file-sources:save', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: payload.id ? 'source.update-files' : 'source.create-files', resourceType: 'source', resourceId: payload.id, component: 'backup-file-source', details: { name: payload.name, connectionId: payload.connectionId } },
    () => getBackupFileSourceService().save(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:file-sources:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'source.delete-files', resourceType: 'source', resourceId: payload.id, component: 'backup-file-source' },
    () => getBackupFileSourceService().remove(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:database-adapters:list', async () => {
  await backupSecretContext();
  return getBackupDatabaseSourceService().listAdapters();
});

ipcMain.handle('backup:database-sources:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupDatabaseSourceService().list(context.workspaceId, { connectionId: payload.connectionId });
});

ipcMain.handle('backup:database-sources:save', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: payload.id ? 'source.update-database' : 'source.create-database', resourceType: 'source', resourceId: payload.id, component: 'backup-database-source', details: { name: payload.name, connectionId: payload.connectionId, adapterId: payload.adapterId } },
    () => getBackupDatabaseSourceService().save(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:database-sources:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'source.delete-database', resourceType: 'source', resourceId: payload.id, component: 'backup-database-source' },
    () => getBackupDatabaseSourceService().remove(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:jobs:readiness', async () => {
  const context = await backupSecretContext();
  return getBackupJobService().readiness(context.workspaceId);
});

ipcMain.handle('backup:jobs:list', async () => {
  const context = await backupSecretContext();
  return getBackupJobService().list(context.workspaceId);
});

ipcMain.handle('backup:objectives:status', async () => {
  const context = await backupSecretContext();
  return getBackupObjectiveStatusService().report(context.workspaceId);
});

ipcMain.handle('backup:jobs:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'job.create', resourceType: 'backup-job', component: 'backup-job', details: { name: payload.name, sourceId: payload.sourceId, repositoryCount: Array.isArray(payload.repositoryIds) ? payload.repositoryIds.length : 0, backupMode: payload.backupMode, scheduleType: String(payload.schedule?.type || 'manual').slice(0, 32) } },
    () => getBackupJobService().create(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:jobs:pause', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'job.pause', resourceType: 'backup-job', resourceId: payload.id, component: 'backup-job' },
    () => getBackupJobService().pause(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:jobs:resume', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'job.resume', resourceType: 'backup-job', resourceId: payload.id, component: 'backup-job' },
    () => getBackupJobService().resume(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:jobs:clone', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'job.clone', resourceType: 'backup-job', resourceId: payload.id, component: 'backup-job', details: { requestedName: String(payload.name || '').slice(0, 200) || null } },
    () => getBackupJobService().clone(context.workspaceId, context.actorId, payload.id, payload.revision, { name: payload.name })
  );
});

ipcMain.handle('backup:jobs:disable', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'job.disable', resourceType: 'backup-job', resourceId: payload.id, component: 'backup-job' },
    () => getBackupJobService().disable(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:jobs:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'job.delete', resourceType: 'backup-job', resourceId: payload.id, component: 'backup-job' },
    () => getBackupJobService().delete(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:jobs:runs:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupManualBackupService().list(context.workspaceId, { jobId: payload.jobId, limit: payload.limit });
});

ipcMain.handle('backup:worker:status', async () => getBackupScheduledWorkerStatus());

ipcMain.handle('backup:recovery-points:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSnapshotBrowserService().listRecoveryPoints(context.workspaceId, payload);
});

ipcMain.handle('backup:snapshots:browse', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSnapshotBrowserService().browse(context.workspaceId, payload);
});

ipcMain.handle('backup:snapshots:search', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSnapshotBrowserService().search(context.workspaceId, payload);
});

ipcMain.handle('backup:snapshots:file-versions', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSnapshotBrowserService().fileVersions(context.workspaceId, payload);
});

ipcMain.handle('backup:restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupFileRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-selected-files', resourceType: 'restore-run', component: 'backup-file-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, mode: payload.mode, conflictPolicy: payload.conflictPolicy, itemCount: Array.isArray(payload.paths) ? payload.paths.length : 0 } },
    () => getBackupFileRestoreService().start(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupFileRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

function databaseRestorePrompt(engineLabel, targetKind, payload = {}) {
  const mode = String(payload.mode || 'original');
  if (!['original', 'alternate', 'new-database'].includes(mode)) throw new TypeError('Database restore target mode is invalid.');
  if (mode === 'new-database') return {
    mode,
    message: `Create and restore the new ${engineLabel} database?`,
    detail: `The database is created only if the requested name is absent. The authenticated dump and native validation run against the new database.`,
    confirmLabel: 'Create and restore'
  };
  if (mode === 'alternate') return {
    mode,
    message: `Restore this backup to the alternate ${engineLabel} ${targetKind}?`,
    detail: payload.conflictPolicy === 'overwrite'
      ? `Protected database objects and data on the selected alternate ${targetKind} can be replaced. The verified alternate identity and native validation evidence are recorded.`
      : `The restore stops before streaming if a protected database already exists on the selected alternate ${targetKind}.`,
    confirmLabel: `Restore ${engineLabel}`
  };
  return {
    mode,
    message: `Restore this ${engineLabel} backup to its original ${targetKind}?`,
    detail: `Protected database objects and data on the original ${targetKind} can be replaced. Server identity and native integrity are validated.`,
    confirmLabel: `Restore ${engineLabel}`
  };
}

ipcMain.handle('backup:mysql-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMysqlRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:mysql-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const prompt = databaseRestorePrompt('MySQL', 'server', payload);
  const confirmed = await requestInAppConfirmation(prompt);
  return runAuditedBackupMutation(
    context,
    { action: `restore.start-mysql-${prompt.mode}`, resourceType: 'restore-run', component: 'backup-mysql-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, conflictPolicy: payload.conflictPolicy, mode: prompt.mode, confirmed } },
    () => getBackupMysqlRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: prompt.mode, confirmed, confirmationText: confirmed ? MYSQL_RESTORE_CONFIRMATIONS[prompt.mode] : '' })
  );
});

ipcMain.handle('backup:mysql-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMysqlRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:mysql-physical-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMysqlPhysicalRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:mysql-physical-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const mode = String(payload.mode || 'original');
  if (!MYSQL_PHYSICAL_RESTORE_CONFIRMATIONS[mode]) throw new TypeError('MySQL physical restore target mode is invalid.');
  const confirmed = await requestInAppConfirmation({
    message: mode === 'alternate' ? 'Restore this physical backup to the alternate MySQL server?' : 'Restore this physical backup to the original MySQL server?',
    detail: 'MySQL will be stopped. The configured datadir must already be empty; DeployerX will not delete or overwrite existing datadir files. The authenticated XtraBackup chain is prepared and copied back before MySQL is restarted and validated.',
    confirmLabel: 'Restore physical backup'
  });
  return runAuditedBackupMutation(
    context,
    { action: `restore.start-mysql-physical-${mode}`, resourceType: 'restore-run', component: 'backup-mysql-physical-restore', details: { recoveryPointId: payload.recoveryPointId, targetSourceId: payload.targetSourceId, mode, confirmed } },
    () => getBackupMysqlPhysicalRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode, confirmed, confirmationText: confirmed ? MYSQL_PHYSICAL_RESTORE_CONFIRMATIONS[mode] : '' })
  );
});

ipcMain.handle('backup:mysql-physical-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMysqlPhysicalRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:mysql-physical-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'restore.cancel-mysql-physical', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-mysql-physical-restore' },
    () => getBackupMysqlPhysicalRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId)
  );
});

ipcMain.handle('backup:mariadb-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMariadbRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:mariadb-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const prompt = databaseRestorePrompt('MariaDB', 'server', payload);
  const confirmed = await requestInAppConfirmation(prompt);
  return runAuditedBackupMutation(
    context,
    { action: `restore.start-mariadb-${prompt.mode}`, resourceType: 'restore-run', component: 'backup-mariadb-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, conflictPolicy: payload.conflictPolicy, mode: prompt.mode, confirmed } },
    () => getBackupMariadbRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: prompt.mode, confirmed, confirmationText: confirmed ? MARIADB_RESTORE_CONFIRMATIONS[prompt.mode] : '' })
  );
});

ipcMain.handle('backup:mariadb-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMariadbRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

function pointInTimeRestorePrompt(engineLabel, payload = {}) {
  const target = payload.stop?.timestamp ? `timestamp ${String(payload.stop.timestamp).slice(0, 40)}` : `binary-log coordinate ${String(payload.stop?.coordinate?.file || '').slice(0, 255)}:${Number(payload.stop?.coordinate?.position) || 0}`;
  return {
    message: `Recover ${engineLabel} to the selected point in time?`,
    detail: `The logical full anchor is restored first, then authenticated binary logs are replayed through ${target}. Existing target data can be replaced.`,
    confirmLabel: `Recover ${engineLabel}`
  };
}

ipcMain.handle('backup:mysql-pitr:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMysqlPitrService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:mysql-pitr:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation(pointInTimeRestorePrompt('MySQL', payload));
  return runAuditedBackupMutation(context, { action: 'restore.start-mysql-point-in-time', resourceType: 'restore-run', component: 'backup-mysql-pitr', details: { terminalRecoveryPointId: payload.terminalRecoveryPointId, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, mode: payload.mode, stopType: payload.stop?.timestamp ? 'timestamp' : 'coordinate', stopFile: payload.stop?.coordinate?.file, stopPosition: payload.stop?.coordinate?.position, confirmed } }, () => getBackupMysqlPitrService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? MYSQL_FAMILY_PITR_PROFILES.mysql.confirmation : '' }));
});

ipcMain.handle('backup:mysql-pitr:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMysqlPitrService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:mariadb-pitr:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMariadbPitrService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:mariadb-pitr:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation(pointInTimeRestorePrompt('MariaDB', payload));
  return runAuditedBackupMutation(context, { action: 'restore.start-mariadb-point-in-time', resourceType: 'restore-run', component: 'backup-mariadb-pitr', details: { terminalRecoveryPointId: payload.terminalRecoveryPointId, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, mode: payload.mode, stopType: payload.stop?.timestamp ? 'timestamp' : 'coordinate', stopFile: payload.stop?.coordinate?.file, stopPosition: payload.stop?.coordinate?.position, confirmed } }, () => getBackupMariadbPitrService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? MYSQL_FAMILY_PITR_PROFILES.mariadb.confirmation : '' }));
});

ipcMain.handle('backup:mariadb-pitr:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMariadbPitrService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:postgresql-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupPostgresqlRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:postgresql-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const prompt = databaseRestorePrompt('PostgreSQL', 'cluster', payload);
  const confirmed = await requestInAppConfirmation(prompt);
  return runAuditedBackupMutation(
    context,
    { action: `restore.start-postgresql-${prompt.mode}`, resourceType: 'restore-run', component: 'backup-postgresql-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, conflictPolicy: payload.conflictPolicy, mode: prompt.mode, confirmed } },
    () => getBackupPostgresqlRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: prompt.mode, confirmed, confirmationText: confirmed ? POSTGRESQL_RESTORE_CONFIRMATIONS[prompt.mode] : '' })
  );
});

ipcMain.handle('backup:postgresql-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupPostgresqlRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:postgresql-pitr:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupPostgresqlPitrRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:postgresql-pitr:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const mode = String(payload.mode || 'original');
  if (!POSTGRESQL_PITR_RESTORE_CONFIRMATIONS[mode]) throw new TypeError('PostgreSQL physical restore target mode is invalid.');
  const confirmed = await requestInAppConfirmation({
    message: mode === 'alternate' ? 'Recover PostgreSQL to the alternate host?' : 'Recover PostgreSQL to the original host?',
    detail: 'PostgreSQL will be stopped. The configured data directory must already be empty. DeployerX verifies the base backup and archived WAL before copy-back, then PostgreSQL replays to the selected target and promotes.',
    confirmLabel: 'Recover PostgreSQL'
  });
  return runAuditedBackupMutation(
    context,
    { action: `restore.start-postgresql-pitr-${mode}`, resourceType: 'restore-run', component: 'backup-postgresql-pitr', details: { recoveryPointId: payload.recoveryPointId, targetSourceId: payload.targetSourceId, mode, recoveryTarget: payload.recoveryTarget, confirmed } },
    () => getBackupPostgresqlPitrRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode, confirmed, confirmationText: confirmed ? POSTGRESQL_PITR_RESTORE_CONFIRMATIONS[mode] : '' })
  );
});

ipcMain.handle('backup:postgresql-pitr:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupPostgresqlPitrRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:postgresql-pitr:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-postgresql-pitr', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-postgresql-pitr' }, () => getBackupPostgresqlPitrRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:sqlserver-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSqlServerRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:sqlserver-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const mode = String(payload.mode || 'original');
  if (!SQLSERVER_RESTORE_CONFIRMATIONS[mode]) throw new TypeError('SQL Server restore target mode is invalid.');
  const confirmed = await requestInAppConfirmation({
    message: mode === 'alternate' ? 'Restore SQL Server to the alternate instance?' : 'Restore SQL Server to the original instance?',
    detail: 'DeployerX authenticates and re-verifies every native backup before restoring the database. Existing database files are never selected as relocation targets.',
    confirmLabel: 'Restore SQL Server'
  });
  let tailConfirmed = false;
  let damagedTailConfirmed = false;
  if (confirmed && mode === 'original' && payload.tailMode && payload.tailMode !== 'none') {
    tailConfirmed = await requestInAppConfirmation({ message: 'Capture and publish the SQL Server tail log?', detail: payload.tailMode === 'online' ? 'The database will enter the restoring state after the tail is captured. The restore will stop if repository publication fails.' : 'This high-risk tail operation is intended for an offline or damaged database and may produce incomplete metadata.', confirmLabel: 'Capture tail log' });
    if (tailConfirmed && payload.tailMode === 'damaged') damagedTailConfirmed = await requestInAppConfirmation({ message: 'Allow damaged tail-log media?', detail: 'SQL Server will use NO_TRUNCATE and CONTINUE_AFTER_ERROR. The resulting RecoveryPoint is marked as degraded evidence.', confirmLabel: 'Allow damaged media' });
  }
  return runAuditedBackupMutation(
    context,
    { action: `restore.start-sqlserver-${mode}`, resourceType: 'restore-run', component: 'backup-sqlserver-restore', details: { recoveryPointId: payload.recoveryPointId, targetSourceId: payload.targetSourceId, targetDatabase: payload.targetDatabase, mode, recoveryTarget: payload.recoveryTarget, tailMode: payload.tailMode, confirmed, tailConfirmed, damagedTailConfirmed } },
    () => getBackupSqlServerRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode, confirmed, confirmationText: confirmed ? SQLSERVER_RESTORE_CONFIRMATIONS[mode] : '', tailConfirmed, tailConfirmationText: tailConfirmed ? SQLSERVER_TAIL_CONFIRMATION : '', damagedTailConfirmed, damagedTailConfirmationText: damagedTailConfirmed ? SQLSERVER_DAMAGED_TAIL_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:sqlserver-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSqlServerRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:sqlserver-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-sqlserver', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-sqlserver-restore' }, () => getBackupSqlServerRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:oracle-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupOracleRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:oracle-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const mode = String(payload.mode || 'original');
  if (!ORACLE_RESTORE_CONFIRMATIONS[mode]) throw new TypeError('Oracle RMAN recovery target mode is invalid.');
  const confirmed = await requestInAppConfirmation({
    message: mode === 'alternate' ? 'Recover Oracle to the alternate instance?' : 'Recover Oracle to the original instance?',
    detail: mode === 'alternate'
      ? 'DeployerX will refuse existing SID markers and destination paths, then use the authenticated RMAN chain to create an independent database with a new DBID under the configured Oracle-managed destinations.'
      : 'DeployerX will authenticate and stage the required RMAN chain, replace the selected Oracle database, and recover it to the requested SCN, archived-log sequence, or time.',
    confirmLabel: 'Recover Oracle'
  });
  const resetlogsConfirmed = confirmed && await requestInAppConfirmation({
    message: 'Open the recovered Oracle database with RESETLOGS?',
    detail: 'OPEN RESETLOGS creates a new database incarnation. Existing backups remain evidence for the prior incarnation and cannot be appended to the new recovery chain.',
    confirmLabel: 'Open with RESETLOGS'
  });
  return runAuditedBackupMutation(
    context,
    { action: `restore.start-oracle-${mode}`, resourceType: 'restore-run', component: 'backup-oracle-restore', details: { recoveryPointId: payload.recoveryPointId, targetSourceId: payload.targetSourceId, targetSshConnectionId: payload.targetProfile?.sshConnectionId || null, targetOracleSid: payload.targetProfile?.oracleSid || null, targetDatabaseUniqueName: payload.targetProfile?.databaseUniqueName || null, mode, recoveryTarget: payload.recoveryTarget, deepValidation: Boolean(payload.deepValidation), confirmed, resetlogsConfirmed } },
    () => getBackupOracleRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode, confirmed, confirmationText: confirmed ? ORACLE_RESTORE_CONFIRMATIONS[mode] : '', resetlogsConfirmed, resetlogsConfirmationText: resetlogsConfirmed ? ORACLE_RESETLOGS_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:oracle-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupOracleRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:oracle-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-oracle', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-oracle-restore' }, () => getBackupOracleRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:mongodb-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMongoDbRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:mongodb-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const mode = String(payload.mode || 'original');
  if (!MONGODB_RESTORE_CONFIRMATIONS[mode]) throw new TypeError('MongoDB recovery target mode is invalid.');
  const timestamp = payload.stop?.coordinate?.timestamp?.$timestamp;
  const confirmed = await requestInAppConfirmation({
    message: mode === 'alternate' ? 'Recover MongoDB to the alternate deployment?' : 'Recover MongoDB to the original deployment?',
    detail: mode === 'alternate' && payload.conflictPolicy !== 'overwrite'
      ? 'Recovery stops before archive streaming if a protected database already exists on the verified alternate deployment.'
      : 'The authenticated logical anchor is restored with drop enabled, then continuous BSON oplog intervals are replayed through the selected boundary.',
    confirmLabel: 'Recover MongoDB'
  });
  return runAuditedBackupMutation(
    context,
    { action: `restore.start-mongodb-${mode}`, resourceType: 'restore-run', component: 'backup-mongodb-restore', details: { recoveryPointId: payload.recoveryPointId || payload.terminalRecoveryPointId, targetConnectionId: payload.targetConnectionId, mode, conflictPolicy: payload.conflictPolicy, stopType: payload.stop?.type || 'latest', stopSeconds: Number(timestamp?.t) || null, stopIncrement: Number(timestamp?.i) || null, confirmed } },
    () => getBackupMongoDbRestoreService().start(context.workspaceId, context.actorId, { ...payload, recoveryPointId: payload.recoveryPointId || payload.terminalRecoveryPointId, mode, confirmed, confirmationText: confirmed ? MONGODB_RESTORE_CONFIRMATIONS[mode] : '' })
  );
});

ipcMain.handle('backup:mongodb-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupMongoDbRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:mongodb-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-mongodb', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-mongodb-restore' }, () => getBackupMongoDbRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:sqlite-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSqliteRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:neo4j-restores:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNeo4jRestoreService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:neo4j-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNeo4jRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:neo4j-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation({
    message: 'Load the Neo4j backup into the empty alternate database?',
    detail: 'DeployerX revalidates the separate target, authenticates the complete dump, runs native offline load and consistency checks, and leaves the database stopped. Once load begins, cancellation cannot claim rollback.',
    confirmLabel: 'Recover Neo4j'
  });
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-neo4j-alternate', resourceType: 'restore-run', component: 'backup-neo4j-restore', details: { recoveryPointId: payload.recoveryPointId, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, mode: 'alternate', confirmed } },
    () => getBackupNeo4jRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: 'alternate', confirmed, confirmationText: confirmed ? NEO4J_RESTORE_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:neo4j-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNeo4jRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:neo4j-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-neo4j', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-neo4j-restore' }, () => getBackupNeo4jRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:neo4j-verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNeo4jRecoveryTestService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:neo4j-verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  let confirmed = false;
  if (String(payload.mode || '') === NEO4J_DRILL_MODE) {
    confirmed = await requestInAppConfirmation({
      message: 'Run a full Neo4j recovery drill?',
      detail: 'DeployerX authenticates the complete backup chain, revalidates the protected source, loads an empty alternate database, runs native consistency checks, and leaves the target stopped for inspection. Cleanup and rollback are not claimed.',
      confirmLabel: 'Run recovery drill'
    });
  }
  return runAuditedBackupMutation(
    context,
    { action: 'verification.start-neo4j', resourceType: 'verification-run', component: 'backup-neo4j-verification', details: { recoveryPointId: payload.recoveryPointId, mode: payload.mode, targetConnectionId: payload.targetConnectionId, targetDatabase: payload.targetDatabase, confirmed } },
    () => getBackupNeo4jRecoveryTestService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? NEO4J_DRILL_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:neo4j-verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNeo4jRecoveryTestService().wait(context.workspaceId, payload.verificationRunId);
});

ipcMain.handle('backup:neo4j-verifications:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'verification.cancel-neo4j', resourceType: 'verification-run', resourceId: payload.verificationRunId, component: 'backup-neo4j-verification' }, () => getBackupNeo4jRecoveryTestService().cancel(context.workspaceId, context.actorId, payload.verificationRunId));
});

ipcMain.handle('backup:neo4j-aggregations:preview', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNeo4jAggregationService().preview(context.workspaceId, payload);
});

ipcMain.handle('backup:neo4j-aggregations:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNeo4jAggregationService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:neo4j-aggregations:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation({
    message: 'Aggregate this Neo4j backup chain?',
    detail: 'DeployerX authenticates every chain member, preserves the original backup media, and publishes one independently restorable full baseline. Additional temporary and repository capacity is required.',
    confirmLabel: 'Aggregate chain'
  });
  return runAuditedBackupMutation(
    context,
    { action: 'backup.aggregate-neo4j', resourceType: 'backup-run', component: 'backup-neo4j-aggregation', details: { recoveryPointId: payload.recoveryPointId, repositoryId: payload.repositoryId, expectedPlanId: payload.expectedPlanId, confirmed } },
    () => getBackupNeo4jAggregationService().start(context.workspaceId, context.actorId, { ...payload, confirmed, confirmationText: confirmed ? NEO4J_AGGREGATION_CONFIRMATION : '' })
  );
});

ipcMain.handle('backup:neo4j-aggregations:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNeo4jAggregationService().wait(context.workspaceId, payload.runId);
});

ipcMain.handle('backup:neo4j-aggregations:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'backup.cancel-neo4j-aggregation', resourceType: 'backup-run', resourceId: payload.runId, component: 'backup-neo4j-aggregation' }, () => getBackupNeo4jAggregationService().cancel(context.workspaceId, context.actorId, payload.runId));
});

ipcMain.handle('backup:redis-restores:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupRedisRestoreService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:redis-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const recoveryPointId = String(payload.recoveryPointId || '');
  const point = recoveryPointId ? await controlDatabase.repository('recoveryPoint').get(context.workspaceId, recoveryPointId) : null;
  const source = point ? await controlDatabase.repository('source').get(context.workspaceId, point.sourceId) : null;
  const cluster = source?.physicalExecution?.topology === 'cluster';
  const confirmed = await requestInAppConfirmation({
    message: cluster ? 'Recover the Redis Cluster to an offline alternate bundle?' : 'Recover Redis to the isolated alternate directory?',
    detail: cluster
      ? 'The target must be absent. DeployerX authenticates the complete cluster set, natively validates every master in isolation, shuts every process down, and publishes a non-running recovery bundle.'
      : 'The target must be absent. DeployerX authenticates every artifact, starts a loopback-only disposable Redis validation copy, shuts it down, and then publishes the untouched target directory.',
    confirmLabel: 'Recover Redis'
  });
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-redis-alternate', resourceType: 'restore-run', component: 'backup-redis-restore', details: { recoveryPointId: payload.recoveryPointId, targetName: path.basename(String(payload.targetDirectory || '')), mode: 'alternate', topology: cluster ? 'cluster' : 'standalone', confirmed } },
    () => getBackupRedisRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: 'alternate', confirmed, confirmationText: confirmed ? cluster ? REDIS_RESTORE_CONFIRMATIONS.clusterAlternate : REDIS_RESTORE_CONFIRMATIONS.alternate : '' })
  );
});

ipcMain.handle('backup:redis-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupRedisRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:redis-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-redis', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-redis-restore' }, () => getBackupRedisRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:sqlite-restores:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const confirmed = await requestInAppConfirmation({
    message: 'Recover SQLite to the alternate path?',
    detail: 'The target must be absent. DeployerX authenticates and validates the database in same-directory staging before atomic publication.',
    confirmLabel: 'Recover SQLite'
  });
  return runAuditedBackupMutation(
    context,
    { action: 'restore.start-sqlite-alternate', resourceType: 'restore-run', component: 'backup-sqlite-restore', details: { recoveryPointId: payload.recoveryPointId, targetName: path.basename(String(payload.targetPath || '')), mode: 'alternate', confirmed } },
    () => getBackupSqliteRestoreService().start(context.workspaceId, context.actorId, { ...payload, mode: 'alternate', confirmed, confirmationText: confirmed ? SQLITE_RESTORE_CONFIRMATIONS.alternate : '' })
  );
});

ipcMain.handle('backup:sqlite-restores:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupSqliteRestoreService().wait(context.workspaceId, payload.restoreRunId);
});

ipcMain.handle('backup:sqlite-restores:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(context, { action: 'restore.cancel-sqlite', resourceType: 'restore-run', resourceId: payload.restoreRunId, component: 'backup-sqlite-restore' }, () => getBackupSqliteRestoreService().cancel(context.workspaceId, context.actorId, payload.restoreRunId));
});

ipcMain.handle('backup:verifications:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupRepositoryVerificationService().list(context.workspaceId, payload);
});

ipcMain.handle('backup:verifications:start', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: payload.mode === 'checksum' ? 'verification.start-repository-checksum' : 'verification.start-sampled-restore', resourceType: 'verification-run', component: 'backup-repository-verification', details: { mode: payload.mode, repositoryId: payload.repositoryId, recoveryPointId: payload.recoveryPointId, samplePercent: payload.samplePercent } },
    () => getBackupRepositoryVerificationService().start(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:verifications:wait', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupRepositoryVerificationService().wait(context.workspaceId, payload.verificationRunId);
});

ipcMain.handle('backup:logs:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  const runId = String(payload.runId || '').trim();
  const run = runId ? await getBackupControlDatabase().repository('run').get(context.workspaceId, runId) : null;
  if (!run) throw new Error('The backup run was not found.');
  return getBackupLogStore().list(context.workspaceId, {
    limit: payload.limit,
    correlationId: run.id,
    component: 'backup-run',
    levels: payload.levels
  });
});

ipcMain.handle('backup:notifications:routes:list', async () => {
  const context = await backupSecretContext();
  return getBackupNotificationService().listRoutes(context.workspaceId);
});

ipcMain.handle('backup:notifications:routes:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'notification-route.create', resourceType: 'notification-route', component: 'backup-notifications', details: { type: payload.type, eventCount: Array.isArray(payload.events) ? payload.events.length : 0 } },
    () => getBackupNotificationService().createRoute(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:notifications:routes:update', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'notification-route.update', resourceType: 'notification-route', resourceId: payload.id, component: 'backup-notifications', details: { enabled: payload.enabled, eventCount: Array.isArray(payload.events) ? payload.events.length : undefined } },
    () => getBackupNotificationService().updateRoute(context.workspaceId, context.actorId, payload.id, payload)
  );
});

ipcMain.handle('backup:notifications:routes:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'notification-route.delete', resourceType: 'notification-route', resourceId: payload.id, component: 'backup-notifications' },
    () => getBackupNotificationService().deleteRoute(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:notifications:routes:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'notification-route.test', resourceType: 'notification-route', resourceId: payload.id, component: 'backup-notifications' },
    () => getBackupNotificationService().testRoute(context.workspaceId, payload.id)
  );
});

ipcMain.handle('backup:notifications:deliveries:list', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupNotificationService().listDeliveries(context.workspaceId, payload);
});

ipcMain.handle('backup:jobs:run', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'run.start-manual-file-backup', resourceType: 'run', component: 'backup-manual-execution', details: { jobId: payload.jobId } },
    () => getBackupManualBackupService().start(context.workspaceId, context.actorId, payload.jobId)
  );
});

ipcMain.handle('backup:runs:resume', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'run.resume-manual-file-backup', resourceType: 'run', component: 'backup-manual-execution', details: { interruptedRunId: payload.runId } },
    () => getBackupManualBackupService().resume(context.workspaceId, context.actorId, payload.runId)
  );
});

ipcMain.handle('backup:runs:cancel', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'run.cancel-file-backup', resourceType: 'run', resourceId: payload.runId, component: 'backup-manual-execution' },
    () => getBackupManualBackupService().cancel(context.workspaceId, context.actorId, payload.runId)
  );
});

ipcMain.handle('backup:runs:retry', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'run.retry-file-backup', resourceType: 'run', resourceId: payload.runId, component: 'backup-manual-execution' },
    () => getBackupManualBackupService().retry(context.workspaceId, context.actorId, payload.runId)
  );
});

ipcMain.handle('backup:repositories:local:list', async () => {
  const context = await backupSecretContext();
  return getBackupLocalRepositoryService().list(context.workspaceId);
});

ipcMain.handle('backup:storage-connections:s3:list', async () => {
  const context = await backupSecretContext();
  return getBackupS3ConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:storage-connections:s3:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'storage-connection.create-s3', resourceType: 'connection', component: 'backup-storage-connection', details: { name: payload.name, endpoint: payload.endpoint } },
    () => getBackupS3ConnectionService().create(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:storage-connections:s3:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'storage-connection.test-s3', resourceType: 'connection', resourceId: payload.id, component: 'backup-storage-connection' },
    () => getBackupS3ConnectionService().test(context.workspaceId, context.actorId, payload.id, payload.location)
  );
});

ipcMain.handle('backup:storage-connections:s3:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'storage-connection.delete-s3', resourceType: 'connection', resourceId: payload.id, component: 'backup-storage-connection' },
    () => getBackupS3ConnectionService().remove(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:storage-backends:list', async () => {
  await backupSecretContext();
  return getBackupDestinationService().listBackends();
});

ipcMain.handle('backup:storage-connections:list', async () => {
  const context = await backupSecretContext();
  return getBackupStorageConnectionService().list(context.workspaceId);
});

ipcMain.handle('backup:storage-connections:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'storage-connection.create', resourceType: 'connection', component: 'backup-storage-connection', details: { backendId: payload.backendId, name: payload.input?.name } },
    () => getBackupStorageConnectionService().create(context.workspaceId, context.actorId, payload.backendId, payload.input)
  );
});

ipcMain.handle('backup:storage-connections:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'storage-connection.test', resourceType: 'connection', resourceId: payload.id, component: 'backup-storage-connection', details: { backendId: payload.backendId } },
    () => getBackupStorageConnectionService().test(context.workspaceId, context.actorId, payload.backendId, payload.id, payload.location)
  );
});

ipcMain.handle('backup:storage-connections:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'storage-connection.delete', resourceType: 'connection', resourceId: payload.id, component: 'backup-storage-connection', details: { backendId: payload.backendId } },
    () => getBackupStorageConnectionService().remove(context.workspaceId, context.actorId, payload.backendId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:destinations:list', async () => {
  const context = await backupSecretContext();
  return getBackupDestinationService().list(context.workspaceId);
});

ipcMain.handle('backup:destinations:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'destination.create', resourceType: 'repository', component: 'backup-destination', details: { name: payload.name, backendId: payload.backendId } },
    () => getBackupDestinationService().create(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:destinations:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'destination.test', resourceType: 'repository', resourceId: payload.id, component: 'backup-destination' },
    () => getBackupDestinationService().test(context.workspaceId, context.actorId, payload.id)
  );
});

ipcMain.handle('backup:destinations:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'destination.delete', resourceType: 'repository', resourceId: payload.id, component: 'backup-destination' },
    () => getBackupDestinationService().remove(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:repositories:storage-policy:update', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.update-storage-policy', resourceType: 'repository', resourceId: payload.repositoryId, component: 'backup-repository-pruning' },
    () => getBackupRepositoryPruningService().configure(context.workspaceId, context.actorId, payload.repositoryId, payload)
  );
});

ipcMain.handle('backup:repositories:prune-plan', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return getBackupRepositoryPruningService().plan(context.workspaceId, payload.repositoryId);
});

ipcMain.handle('backup:repositories:prune', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.prune', resourceType: 'repository', resourceId: payload.repositoryId, component: 'backup-repository-pruning', details: { planId: payload.planId } },
    () => getBackupRepositoryPruningService().execute(context.workspaceId, context.actorId, payload.repositoryId, payload.planId)
  );
});

ipcMain.handle('backup:repositories:local:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.test-local', resourceType: 'repository', resourceId: payload.id, component: 'backup-local-repository' },
    () => getBackupLocalRepositoryService().test(context.workspaceId, context.actorId, payload.id)
  );
});

ipcMain.handle('backup:repositories:local:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.create-local', resourceType: 'repository', component: 'backup-local-repository', details: { name: payload.name, rootPath: payload.rootPath } },
    () => getBackupLocalRepositoryService().create(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:repositories:local:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.delete-local-config', resourceType: 'repository', resourceId: payload.id, component: 'backup-local-repository' },
    () => getBackupLocalRepositoryService().remove(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:repositories:sftp:list', async () => {
  const context = await backupSecretContext();
  return getBackupSftpRepositoryService().list(context.workspaceId);
});

ipcMain.handle('backup:repositories:sftp:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.test-sftp', resourceType: 'repository', resourceId: payload.id, component: 'backup-sftp-repository' },
    () => getBackupSftpRepositoryService().test(context.workspaceId, context.actorId, payload.id)
  );
});

ipcMain.handle('backup:repositories:sftp:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.create-sftp', resourceType: 'repository', component: 'backup-sftp-repository', details: { name: payload.name, connectionId: payload.connectionId, rootPath: payload.rootPath } },
    () => getBackupSftpRepositoryService().create(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:repositories:sftp:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.delete-sftp-config', resourceType: 'repository', resourceId: payload.id, component: 'backup-sftp-repository' },
    () => getBackupSftpRepositoryService().remove(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('backup:repositories:s3:list', async () => {
  const context = await backupSecretContext();
  return getBackupS3RepositoryService().list(context.workspaceId);
});

ipcMain.handle('backup:repositories:s3:test', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.test-s3', resourceType: 'repository', resourceId: payload.id, component: 'backup-s3-repository' },
    () => getBackupS3RepositoryService().test(context.workspaceId, context.actorId, payload.id)
  );
});

ipcMain.handle('backup:repositories:s3:create', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.create-s3', resourceType: 'repository', component: 'backup-s3-repository', details: { name: payload.name, endpoint: payload.endpoint, region: payload.region, bucket: payload.bucket, prefix: payload.prefix } },
    () => getBackupS3RepositoryService().create(context.workspaceId, context.actorId, payload)
  );
});

ipcMain.handle('backup:repositories:s3:delete', async (_event, payload = {}) => {
  const context = await backupSecretContext();
  return runAuditedBackupMutation(
    context,
    { action: 'repository.delete-s3-config', resourceType: 'repository', resourceId: payload.id, component: 'backup-s3-repository' },
    () => getBackupS3RepositoryService().remove(context.workspaceId, context.actorId, payload.id, payload.revision)
  );
});

ipcMain.handle('app:update-state', async () => publicUpdateState());

ipcMain.handle('app:update-check', async () => checkForAppUpdates({ manual: true }));

ipcMain.handle('app:update-open-releases', async () => {
  const targetUrl = updateState.releasePageUrl || githubReleaseSource?.releasesUrl || '';
  if (!targetUrl) return false;
  await shell.openExternal(targetUrl);
  return true;
});

const ABOUT_EXTERNAL_URLS = new Set([
  'https://everythingx.in/',
  'mailto:info@everythingx.in',
  'https://wa.me/917897892129',
  'https://dev.mysql.com/downloads/installer/',
  'https://www.postgresql.org/download/windows/',
  'https://mariadb.com/downloads/community/community-server/',
  'https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-download-install',
  'https://www.oracle.com/database/technologies/instant-client/downloads.html',
  'https://www.mongodb.com/try/download/database-tools',
  'https://redis.io/docs/latest/operate/oss_and_stack/install/',
  'https://clickhouse.com/docs/en/install',
  'https://docs.influxdata.com/influxdb/v2/tools/influx-cli/',
  'https://www.cockroachlabs.com/docs/stable/install-cockroachdb-windows',
  'https://neo4j.com/download-center/',
  'https://www.sqlite.org/download.html',
  'https://cassandra.apache.org/_/download.html'
]);

ipcMain.handle('app:open-external-url', async (_event, targetUrl) => {
  const safeUrl = String(targetUrl || '');
  if (!ABOUT_EXTERNAL_URLS.has(safeUrl)) throw new Error('This external destination is not allowed.');
  await shell.openExternal(safeUrl);
  return true;
});

ipcMain.handle('app:update-install', async () => {
  if (updateState.status !== 'downloaded') {
    throw new Error('There is no downloaded update ready to install yet.');
  }
  setImmediate(() => {
    prepareForUpdateInstall()
      .then(() => autoUpdater.quitAndInstall(false, true))
      .catch(handleApplicationStartupFailure);
  });
  return true;
});

ipcMain.handle('setup:get', async () => {
  const settings = await readSettings();
  return {
    setupComplete: settings.setupComplete,
    mode: settings.mode,
    activeTeamId: settings.activeTeamId,
    firebase: await firebaseConfigStatus(),
    session: publicSession(settings.auth),
    unlocked: Boolean(settings.activeTeamId)
  };
});

ipcMain.handle('setup:setMode', async (_event, mode) => {
  if (!['offline', 'cloud'].includes(mode)) throw new Error('Choose Cloud or Offline mode.');
  return withDatabaseAccessContextTransition(async () => {
    const current = await readSettings();
    if (mode === 'offline') {
      cloudUnlock = { teamId: '', key: null };
      const settings = await writeSettings({
        ...current,
        setupComplete: true,
        mode: 'offline',
        activeTeamId: '',
        activeTeamName: '',
        activeTeamUid: '',
        auth: null
      });
      return { ...settings, firebase: await firebaseConfigStatus() };
    }
    const settings = await writeSettings({ ...current, setupComplete: true, mode: 'cloud' });
    return { ...settings, firebase: await firebaseConfigStatus() };
  });
});

ipcMain.handle('setup:select-firebase-config', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Firebase Web Config',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, firebase: await firebaseConfigStatus() };

  const parsed = parseFirebaseConfigJson(JSON.parse(await fs.readFile(result.filePaths[0], 'utf8')));
  if (!parsed) throw new Error('Selected JSON is not a Firebase Web config.');

  if (parsed.adminProjectId) {
    const discovered = await tryFirebaseHostingConfig(parsed.adminProjectId);
    if (!discovered) {
      throw new Error(
        'That file is a Firebase Admin SDK service account. It does not include the Web API key needed for Firebase Auth. Download the Firebase Web App config from Firebase Console > Project settings > Your apps, or enable Firebase Hosting init config.'
      );
    }
    return { canceled: false, firebase: await saveFirebaseConfig(discovered) };
  }

  return { canceled: false, firebase: await saveFirebaseConfig(parsed) };
});

ipcMain.handle('auth:register', async (_event, payload = {}) => {
  const email = emailKey(payload.email);
  const password = String(payload.password || '');
  const firstName = String(payload.firstName || '').trim();
  const lastName = String(payload.lastName || '').trim();
  const displayName = String(payload.displayName || `${firstName} ${lastName}`.trim()).trim();
  if (!email || !password) throw new Error('Email and password are required.');

  const registered = await firebaseAuthRequest('accounts:signUp', {
    email,
    password,
    returnSecureToken: true
  });
  let auth = normalizeAuthSession(registered, displayName);
  if (displayName) {
    const updated = await firebaseAuthRequest('accounts:update', {
      idToken: auth.idToken,
      displayName,
      returnSecureToken: false
    });
    auth = {
      ...auth,
      displayName: updated.displayName || displayName
    };
  }

  await firebaseAuthRequest('accounts:sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: auth.idToken
  });

  return finishCloudAuth(auth, { displayName, firstName, lastName, emailVerified: false });
});

ipcMain.handle('auth:login', async (_event, payload = {}) => {
  const email = emailKey(payload.email);
  const password = String(payload.password || '');
  if (!email || !password) throw new Error('Email and password are required.');

  const signedIn = await firebaseAuthRequest('accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true
  });
  const auth = normalizeAuthSession(signedIn, signedIn.displayName || '');
  return finishCloudAuth(auth);
});

ipcMain.handle('auth:forgotPassword', async (_event, payload = {}) => {
  const email = emailKey(payload.email);
  if (!email) throw new Error('Enter your email address first.');
  await firebaseAuthRequest('accounts:sendOobCode', {
    requestType: 'PASSWORD_RESET',
    email
  });
  return true;
});

ipcMain.handle('auth:resendVerification', async () => {
  const auth = await requireAuthSession();
  await firebaseAuthRequest('accounts:sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: auth.idToken
  });
  return true;
});

ipcMain.handle('auth:google', async () => {
  try {
    const auth = await signInWithGoogle();
    const result = await finishCloudAuth(auth);
    setImmediate(focusMainWindow);
    return result;
  } catch (error) {
    setImmediate(focusMainWindow);
    throw error;
  }
});

ipcMain.handle('auth:google-cancel', () => cancelPendingGoogleLogin?.() || false);

ipcMain.handle('auth:logout', async () => {
  return withDatabaseAccessContextTransition(async () => {
    const settings = await readSettings();
    cloudUnlock = { teamId: '', key: null };
    await writeSettings({ ...settings, auth: null });
    return true;
  });
});

ipcMain.handle('mcp-integration:get', async () => {
  const settings = await readSettings();
  return publicMcpIntegration(settings.mcpIntegration);
});
ipcMain.handle('mcp-integration:start', async (_event, payload = {}) => startMcpIntegration(payload));
ipcMain.handle('mcp-integration:rotate-token', async () => rotateMcpToken());
ipcMain.handle('mcp-integration:test', async () => testMcpIntegration());
ipcMain.handle('mcp-integration:clients', async () => listMcpClientsForRenderer());
ipcMain.handle('mcp-integration:connect-client', async (_event, clientId) => connectMcpClientIntegration(clientId));
ipcMain.handle('mcp-integration:disconnect-client', async (_event, clientId) => disconnectMcpClientIntegration(clientId));
ipcMain.handle('mcp-integration:connect-all', async () => connectAllMcpClientsIntegration());
ipcMain.handle('mcp-integration:disconnect', async () => disconnectMcpIntegration());

ipcMain.handle('auth:changePassword', async (_event, payload = {}) => {
  const currentPassword = String(payload.currentPassword || '');
  const newPassword = String(payload.newPassword || '');
  if (!currentPassword || !newPassword) throw new Error('Current and new passwords are required.');
  if (newPassword.length < 6) throw new Error('Password must be at least 6 characters.');

  const auth = await requireAuthSession();
  // Reauthenticate before changing the credential so a stale session cannot update it.
  const reauthenticated = await firebaseAuthRequest('accounts:signInWithPassword', {
    email: auth.email,
    password: currentPassword,
    returnSecureToken: true
  });
  const updated = await firebaseAuthRequest('accounts:update', {
    idToken: reauthenticated.idToken,
    password: newPassword,
    returnSecureToken: true
  });
  const nextAuth = normalizeAuthSession(
    { ...updated, email: auth.email, emailVerified: auth.emailVerified, provider: auth.provider },
    auth.displayName || ''
  );
  const settings = await readSettings();
  await writeSettings({ ...settings, auth: nextAuth });
  return true;
});

ipcMain.handle('auth:session', async () => {
  const settings = await readSettings();
  if (settings.mode !== 'cloud' || !settings.auth) return { session: null };
  let auth;
  try {
    auth = await refreshAuthSession(settings);
  } catch (error) {
    return {
      session: publicSession(settings.auth),
      cloudError: error.message || 'Could not refresh your cloud session right now.',
      stale: true
    };
  }

  if (needsEmailVerification(auth)) {
    return { session: publicSession(auth), requiresEmailVerification: true };
  }
  return { session: publicSession(auth), teams: await safeTeamSnapshot() };
});

ipcMain.handle('teams:list', async () => safeTeamSnapshot());

ipcMain.handle('teams:create', async (_event, payload = {}) => {
  const auth = await requireAuthSession();
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Team name is required.');

  const teamId = createId('team');
  const team = {
    id: teamId,
    name,
    ownerUid: auth.uid,
    secretSeed: crypto.randomBytes(32).toString('base64'),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  const member = {
    uid: auth.uid,
    email: auth.email,
    emailLower: emailKey(auth.email),
    displayName: auth.displayName || '',
    role: 'owner',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await patchDoc(['teams', teamId], team);
  await patchDoc(['teams', teamId, 'members', auth.uid], member);
  await updateUserTeamRef(auth.uid, { teamId, name, role: 'owner' });

  return withDatabaseAccessContextTransition(async () => {
    const settings = await readSettings();
    const previousWorkspaceId = settings.mode === 'cloud' ? String(settings.activeTeamId || '') : 'local';
    cloudUnlock = { teamId, key: deriveWorkspaceKey(team) };
    await writeSettings({ ...settings, activeTeamId: teamId, activeTeamName: name, activeTeamUid: auth.uid });
    await restartDetachedUptimeWorkerForWorkspaceChange(previousWorkspaceId);
    await syncWorkspaceControlFromCloud(teamId, { force: true }).catch(async (error) => logWorkspaceControlSyncFailure(error, teamId));
    return teamSnapshot();
  });
});

ipcMain.handle('teams:switch', async (_event, teamId) => {
  const auth = await requireAuthSession();
  const team = await getDoc(['teams', teamId]);
  const member = team ? await getDoc(['teams', teamId, 'members', auth.uid]) : null;
  if (!team || !member) throw new Error('You do not have access to this team.');
  return withDatabaseAccessContextTransition(async () => {
    const settings = await readSettings();
    const previousWorkspaceId = String(settings.activeTeamId || '');
    cloudUnlock = { teamId, key: deriveWorkspaceKey(team) };
    await writeSettings({
      ...settings,
      activeTeamId: teamId,
      activeTeamName: team.name || 'Workspace',
      activeTeamUid: auth.uid
    });
    if (previousWorkspaceId !== String(teamId)) await restartDetachedUptimeWorkerForWorkspaceChange(previousWorkspaceId);
    await syncUptimeWorkspaceBestEffort({ workspaceId: String(teamId), actorId: auth.uid }, { force: true });
    await syncWorkspaceControlFromCloud(String(teamId), { force: true }).catch(async (error) => logWorkspaceControlSyncFailure(error, String(teamId)));
    return teamSnapshot();
  });
});

ipcMain.handle('teams:invite', async (_event, payload = {}) => {
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  const email = emailKey(payload.email);
  const role = normalizeWorkspaceRole(payload.role);
  if (!teamId) throw new Error('Select a team first.');
  if (!email) throw new Error('Invite email is required.');
  await ensureTeamManager(teamId);
  const team = await getDoc(['teams', teamId]);
  const inviteId = createId('invite');
  const invite = {
    id: inviteId,
    teamId,
    teamName: team?.name || 'Team',
    email,
    emailLower: email,
    role,
    status: 'pending',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  await patchDoc(['teams', teamId, 'invites', inviteId], invite);
  await syncInviteInboxDocument(invite).catch(() => {});
  return teamSnapshot();
});

ipcMain.handle('teams:revokeInvite', async (_event, payload = {}) => {
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  const inviteId = String(payload.inviteId || payload.id || '');
  if (!teamId || !inviteId) throw new Error('Invite is missing.');
  await ensureTeamManager(teamId);
  const invite = await getDoc(['teams', teamId, 'invites', inviteId]);
  if (!invite || invite.status !== 'pending') throw new Error('Invite is no longer pending.');
  await deleteDoc(['teams', teamId, 'invites', inviteId]);
  await deleteInviteInboxDocument(invite).catch(() => {});
  return teamSnapshot();
});

ipcMain.handle('teams:acceptInvite', async (_event, payload = {}) => {
  const auth = await requireAuthSession();
  const teamId = String(payload.teamId || '');
  const inviteId = String(payload.inviteId || payload.id || '');
  if (!teamId || !inviteId) throw new Error('Invite is missing.');
  const invite = await getDoc(['teams', teamId, 'invites', inviteId]);
  if (!invite || invite.status !== 'pending') throw new Error('Invite is no longer available.');
  if (emailKey(invite.emailLower || invite.email) !== emailKey(auth.email)) throw new Error('This invite belongs to another email.');

  const acceptedAt = nowIso();
  const member = {
    uid: auth.uid,
    email: auth.email,
    emailLower: emailKey(auth.email),
    displayName: auth.displayName || '',
    role: normalizeWorkspaceRole(invite.role),
    acceptedInviteId: inviteId,
    createdAt: acceptedAt,
    updatedAt: acceptedAt
  };
  await patchDoc(['teams', teamId, 'members', auth.uid], member);
  const team = await getDoc(['teams', teamId]).catch(() => null);
  await updateUserTeamRef(auth.uid, { teamId, name: team?.name || invite.teamName || 'Team', role: member.role });
  return withDatabaseAccessContextTransition(async () => {
    const previousSettings = await readSettings();
    const previousWorkspaceId = String(previousSettings.activeTeamId || '');
    await writeSettings({
      ...previousSettings,
      activeTeamId: teamId,
      activeTeamName: team?.name || invite.teamName || 'Team',
      activeTeamUid: auth.uid
    });
    if (team) cloudUnlock = { teamId, key: deriveWorkspaceKey(team) };
    const acceptedInvite = { ...invite, status: 'accepted', acceptedBy: auth.uid, updatedAt: acceptedAt };
    await patchDoc(['teams', teamId, 'invites', inviteId], acceptedInvite).catch(() => {});
    await deleteInviteInboxDocument(acceptedInvite).catch(() => {});
    if (previousWorkspaceId !== String(teamId)) await restartDetachedUptimeWorkerForWorkspaceChange(previousWorkspaceId);
    await syncUptimeWorkspaceBestEffort({ workspaceId: String(teamId), actorId: auth.uid }, { force: true });
    return teamSnapshot();
  });
});

ipcMain.handle('teams:removeMember', async (_event, payload = {}) => {
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  const uid = String(payload.uid || '');
  if (!teamId || !uid) throw new Error('Member is required.');
  await ensureTeamManager(teamId);
  const member = await getDoc(['teams', teamId, 'members', uid]);
  if (member?.role === 'owner') throw new Error('Owner cannot be removed.');
  await deleteDoc(['teams', teamId, 'members', uid]);
  return teamSnapshot();
});

ipcMain.handle('teams:delete', async (_event, payload = {}) => {
  const auth = await requireAuthSession();
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  if (!teamId) throw new Error('Select a workspace first.');

  const team = await getDoc(['teams', teamId]);
  if (!team) throw new Error('Workspace was not found.');
  const member = await getDoc(['teams', teamId, 'members', auth.uid]);
  if (team.ownerUid !== auth.uid || member?.role !== 'owner') {
    throw new Error('Only the workspace owner can delete this workspace.');
  }

  const deleteTeam = async () => {
    await deleteCollectionDocuments(['teams', teamId, 'projects']);
    await deleteCollectionDocuments(['teams', teamId, 'templates']);
    await deleteCollectionDocuments(['teams', teamId, UPTIME_CLOUD_COLLECTIONS.monitors]);
    await deleteCollectionDocuments(['teams', teamId, UPTIME_CLOUD_COLLECTIONS.checks]);
    await deleteCollectionDocuments(['teams', teamId, UPTIME_CLOUD_COLLECTIONS.incidents]);
    await deleteCollectionDocuments(['teams', teamId, UPTIME_CLOUD_COLLECTIONS.maintenance]);
    await deleteCollectionDocuments(['teams', teamId, WORKSPACE_CONTROL_CLOUD_COLLECTION]);
    await deleteCollectionDocuments(['teams', teamId, 'invites']);
    await deleteTeamMemberDocuments(teamId, auth.uid);
    await deleteDoc(['teams', teamId]);
    try {
      await removeUserTeamRef(auth.uid, teamId);
    } catch (error) {
      if (!isRecoverableCloudDataError(error)) throw error;
    }

    if (settings.activeTeamId === teamId) {
      cloudUnlock = { teamId: '', key: null };
      await writeSettings({
        ...settings,
        activeTeamId: '',
        activeTeamName: '',
        activeTeamUid: ''
      });
    }
    return safeTeamSnapshot();
  };

  return settings.activeTeamId === teamId
    ? withDatabaseAccessContextTransition(deleteTeam)
    : deleteTeam();
});

ipcMain.handle('cloud:import-local', async () => {
  await ensureActiveTeamUnlocked();
  const localData = await readStore();
  if (!localData.projects.length && !localData.templates.length) {
    return { projectCount: 0, templateCount: 0, projects: [], templates: buildBuiltInTemplates() };
  }
  await mergeLocalStoreIntoCloud(localData);
  const cloudData = await readCloudStore();
  return {
    projectCount: localData.projects.length,
    templateCount: localData.templates.length,
    projects: cloudData.projects,
    templates: mergeBuiltInTemplates(cloudData.templates)
  };
});

ipcMain.handle('projects:list', async () => {
  let data;
  try {
    data = await readCurrentStore();
  } catch (error) {
    // Login and the dashboard should remain usable when Firestore is briefly
    // rate-limited or unavailable. Reads can be retried from the dashboard.
    if (!isRecoverableCloudDataError(error)) throw error;
    return {
      projects: [],
      templates: mergeBuiltInTemplates([]),
      cloudError: error.message || 'Cloud data is temporarily unavailable.'
    };
  }
  return {
    ...data,
    templates: mergeBuiltInTemplates(data.templates)
  };
});

ipcMain.handle('projects:save', async (_event, project) => {
  const settings = await readSettings();
  const currentStore = await readCurrentStore().catch(() => ({ projects: [] }));
  const id = project.id || `${Date.now()}`;
  const normalized = {
    ...normalizeStoredProject(project),
    id,
    updatedAt: nowIso()
  };
  const previousProject = Array.isArray(currentStore.projects)
    ? currentStore.projects.find((item) => String(item.id) === String(id)) || null
    : null;
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await patchDoc(['teams', teamId, 'projects', id], prepareCloudProjectForSave(normalized));
    await pruneRemovedMonitorArtifacts(previousProject, normalized);
    emitUptimeEvent('uptime:project-saved', { projectId: id });
    return normalized;
  }
  const data = await readStore();
  const index = data.projects.findIndex((item) => item.id === id);
  if (index >= 0) data.projects[index] = normalized;
  else data.projects.unshift(normalized);
  await writeStore(data);
  await pruneRemovedMonitorArtifacts(previousProject, normalized);
  emitUptimeEvent('uptime:project-saved', { projectId: id });
  return normalized;
});

ipcMain.handle('network:vpn-profiles:list', async () => listWindowsVpnProfiles());

ipcMain.handle('projects:delete', async (_event, id) => {
  await deleteProjectFromCurrentStore(id);
  return true;
});

ipcMain.handle('projects:export', async (_event, projectIds) => {
  const data = await readCurrentStore();
  const selectedIds = Array.isArray(projectIds) ? new Set(projectIds.map(String)) : null;
  const projects = selectedIds ? (data.projects || []).filter((project) => selectedIds.has(String(project.id))) : data.projects || [];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Servers',
    defaultPath: 'deployerx-servers.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const payload = {
    app: 'DeployerX',
    type: 'projects',
    exportedAt: nowIso(),
    projects
  };

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2));
  return { canceled: false, count: payload.projects.length };
});

ipcMain.handle('projects:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Servers',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const importedProjects = readProjectImportFile(await fs.readFile(result.filePaths[0], 'utf8'));
  if (!importedProjects.length) throw new Error('No servers were found in that file.');

  const data = await readCurrentStore();
  const mergedProjects = await mergeImportsByName(
    Array.isArray(data.projects) ? [...data.projects] : [],
    importedProjects,
    'project'
  );
  const projects = mergedProjects.items;

  data.projects = projects;
  await writeCurrentStore(data);
  return {
    canceled: false,
    count: mergedProjects.stats.added + mergedProjects.stats.replaced,
    skippedDuplicateCount: mergedProjects.stats.skipped,
    replacedDuplicateCount: mergedProjects.stats.replaced,
    projects
  };
});

ipcMain.handle('account:export', async () => {
  const data = await readCurrentStore();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Account',
    defaultPath: 'deployerx-account.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const payload = {
    app: 'DeployerX',
    type: 'account',
    exportedAt: nowIso(),
    projects: data.projects || [],
    templates: stripBuiltInTemplates(data.templates || []).map(normalizeStoredTemplate)
  };

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2));
  return {
    canceled: false,
    projectCount: payload.projects.length,
    templateCount: payload.templates.length
  };
});

ipcMain.handle('account:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Account',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const imported = readAccountImportFile(await fs.readFile(result.filePaths[0], 'utf8'));
  const data = await readCurrentStore();
  const mergedProjects = await mergeImportsByName(
    Array.isArray(data.projects) ? [...data.projects] : [],
    imported.projects,
    'project'
  );
  const mergedTemplates = await mergeImportsByName(
    stripBuiltInTemplates(Array.isArray(data.templates) ? data.templates.map(normalizeStoredTemplate) : []),
    imported.templates,
    'template',
    normalizeStoredTemplate
  );
  const projects = mergedProjects.items;
  const templates = mergedTemplates.items;

  data.projects = projects;
  data.templates = templates;
  await writeCurrentStore(data);

  return {
    canceled: false,
    projectCount: mergedProjects.stats.added + mergedProjects.stats.replaced,
    templateCount: mergedTemplates.stats.added + mergedTemplates.stats.replaced,
    skippedProjectDuplicateCount: mergedProjects.stats.skipped,
    skippedTemplateDuplicateCount: mergedTemplates.stats.skipped,
    replacedProjectDuplicateCount: mergedProjects.stats.replaced,
    replacedTemplateDuplicateCount: mergedTemplates.stats.replaced,
    projects,
    templates
  };
});

ipcMain.handle('templates:save', async (_event, template) => {
  const settings = await readSettings();
  const incomingId = String(template.id || '');
  const id = !incomingId || incomingId.startsWith(BUILT_IN_TEMPLATE_PREFIX) ? `${Date.now()}` : incomingId;
  const category = TEMPLATE_CATEGORIES.includes(String(template.category || '').trim()) ? String(template.category).trim() : '';
  if (!category) throw new Error('Template category is required.');
  const normalized = normalizeStoredTemplate({
    ...template,
    id,
    category,
    builtIn: false,
    readOnly: false,
    source: 'user',
    updatedAt: new Date().toISOString()
  });
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await patchDoc(['teams', teamId, 'templates', id], prepareCloudTemplateForSave(normalized));
    return normalized;
  }
  const data = await readStore();
  const index = data.templates.findIndex((item) => item.id === id);
  if (index >= 0) data.templates[index] = normalized;
  else data.templates.unshift(normalized);
  await writeStore(data);
  return normalized;
});

ipcMain.handle('templates:delete', async (_event, id) => {
  if (String(id || '').startsWith(BUILT_IN_TEMPLATE_PREFIX)) {
    throw new Error('Built-in library templates cannot be deleted. Duplicate one to customize it.');
  }
  await deleteTemplateFromCurrentStore(id);
  return true;
});

ipcMain.handle('templates:export', async (_event, templateIds) => {
  const data = await readCurrentStore();
  const selectedIds = Array.isArray(templateIds) ? new Set(templateIds.map(String)) : null;
  const templates = selectedIds
    ? stripBuiltInTemplates((data.templates || []).filter((template) => selectedIds.has(String(template.id))))
    : stripBuiltInTemplates(data.templates || []);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Command Templates',
    defaultPath: 'deployerx-command-templates.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const payload = {
    app: 'DeployerX',
    type: 'command-templates',
    exportedAt: nowIso(),
    templates: templates.map(normalizeStoredTemplate)
  };

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2));
  return { canceled: false, count: payload.templates.length };
});

ipcMain.handle('templates:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Command Templates',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const importedTemplates = readTemplateImportFile(await fs.readFile(result.filePaths[0], 'utf8'));
  if (!importedTemplates.length) throw new Error('No command templates were found in that file.');

  const data = await readCurrentStore();
  const mergedTemplates = await mergeImportsByName(
    stripBuiltInTemplates(Array.isArray(data.templates) ? data.templates.map(normalizeStoredTemplate) : []),
    importedTemplates,
    'template',
    normalizeStoredTemplate
  );
  const templates = mergedTemplates.items;

  data.templates = templates;
  await writeCurrentStore(data);
  return {
    canceled: false,
    count: mergedTemplates.stats.added + mergedTemplates.stats.replaced,
    skippedDuplicateCount: mergedTemplates.stats.skipped,
    replacedDuplicateCount: mergedTemplates.stats.replaced,
    templates
  };
});

ipcMain.handle('dialog:select-key', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select SSH Private Key',
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return fs.readFile(result.filePaths[0], 'utf8');
});

ipcMain.handle('dialog:select-upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select File to Upload',
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:select-ftp-upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select FTP Upload File',
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:select-local-folder', async (_event, defaultPath = '') => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Local Folder',
    defaultPath: String(defaultPath || '').trim() || undefined,
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:select-ftp-download', async (_event, defaultName = 'download') => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save FTP Download',
    defaultPath: String(defaultName || 'download')
  });

  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('dialog:select-terminal-download', async (_event, defaultName = 'download') => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Server File',
    defaultPath: String(defaultName || 'download')
  });

  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('deployment:run', async (_event, payload) => {
  const runId = payload.runId || `${Date.now()}`;
  executeDeployment(payload.project, payload.upload, runId).catch(() => {});
  return { runId };
});

ipcMain.handle('deployment:stop', async (_event, runId) => stopDeployment(runId));

ipcMain.handle('terminal:start', async (_event, payload) => {
  const sessionId = payload.sessionId || `${Date.now()}`;
  startTerminal(payload.project, sessionId, {
    cols: payload.cols,
    rows: payload.rows,
    startupDirectory: payload.startupDirectory
  }).catch((error) => {
    emitTerminal(sessionId, 'failed', normalizeTerminalConnectionError(error, payload.project).message);
  });
  return { sessionId };
});

ipcMain.handle('server-monitoring:start', async (_event, payload = {}) => {
  const project = payload.project || {};
  if (['vnc', 'rdp'].includes(project.serverType)) throw new Error('Real-time monitoring currently requires an SSH-capable server.');
  const validationError = validateConnectionProject(project, { requireSsh: true });
  if (validationError) throw new Error(validationError);
  const sessionId = String(payload.sessionId || `${Date.now()}-${crypto.randomUUID()}`);
  return serverMonitoringSessionManager.start({
    sessionId,
    projectId: String(project.id || ''),
    project,
    connectionConfig: toConnectionConfig(project)
  });
});

ipcMain.handle('server-monitoring:pause', async (_event, payload = {}) =>
  serverMonitoringSessionManager.setPaused(String(payload.sessionId || ''), Boolean(payload.paused))
);

ipcMain.handle('server-monitoring:stop', async (_event, sessionId) =>
  serverMonitoringSessionManager.stop(String(sessionId || ''))
);

ipcMain.handle('terminal:home-directory', async (_event, sessionId) => readTerminalHomeDirectory(sessionId));

ipcMain.handle('terminal:list-directory', async (_event, payload) =>
  listTerminalDirectory(payload.sessionId, payload.path)
);

ipcMain.handle('terminal:read-file', async (_event, payload) =>
  readTerminalFile(payload.sessionId, payload.path)
);

ipcMain.handle('terminal:write-file', async (_event, payload) =>
  writeTerminalFile(payload.sessionId, payload.path, payload.content)
);

ipcMain.handle('terminal:download', async (_event, payload) =>
  downloadTerminalFile(payload.sessionId, payload.path, payload.localPath)
);

ipcMain.handle('terminal:download-to-directory', async (_event, payload) =>
  downloadTerminalEntryToDirectory(payload.sessionId, payload.entry, payload.localDirectory)
);

ipcMain.handle('terminal:mkdir', async (_event, payload) =>
  makeTerminalDirectory(payload.sessionId, payload.remoteDirectory, payload.name)
);

ipcMain.handle('terminal:rename', async (_event, payload) =>
  renameTerminalEntry(payload.sessionId, payload.entry, payload.name)
);

ipcMain.handle('terminal:open-with', async (_event, payload) =>
  openTerminalEntryWith(payload.sessionId, payload.entry)
);

ipcMain.handle('terminal:delete', async (_event, payload) =>
  deleteTerminalEntry(payload.sessionId, payload.entry)
);

ipcMain.handle('terminal:upload', async (_event, payload) =>
  uploadTerminalFile(payload.sessionId, payload.localPath, payload.remoteDirectory)
);

ipcMain.handle('terminal:upload-cancel', async (_event, sessionId) => cancelTerminalUpload(sessionId));

ipcMain.handle('terminal:input', async (_event, payload) => {
  const terminal = activeTerminals.get(payload.sessionId);
  if (!terminal || !terminal.stream) return false;
  terminal.stream.write(payload.input);
  return true;
});

ipcMain.on('terminal:input:send', (_event, payload) => {
  const terminal = activeTerminals.get(payload.sessionId);
  if (!terminal || !terminal.stream) return;
  terminal.stream.write(payload.input);
});

ipcMain.handle('terminal:resize', async (_event, payload) => resizeTerminal(payload.sessionId, payload.cols, payload.rows));

ipcMain.handle('terminal:stop', async (_event, sessionId) => stopTerminal(sessionId));

ipcMain.handle('local:list', async (_event, payload = {}) => listLocalDirectory(payload.path || app.getPath('home')));

ipcMain.handle('project-local-settings:get', async (_event, projectId) => getProjectLocalSettings(projectId));

ipcMain.handle('project-local-settings:set', async (_event, projectId, payload = {}) =>
  setProjectLocalSettings(projectId, payload)
);

ipcMain.handle('project-local-settings:delete', async (_event, projectId) => deleteProjectLocalSettings(projectId));

ipcMain.on('clipboard:read-sync', (event) => {
  event.returnValue = clipboard.readText();
});

ipcMain.on('clipboard:write-sync', (event, text) => {
  clipboard.writeText(String(text ?? ''));
  event.returnValue = true;
});

ipcMain.on('theme:get-sync', (event) => {
  event.returnValue = readThemePreferenceSync();
});

ipcMain.handle('theme:set', async (_event, themeId) => writeThemePreference(themeId));

const uptimeIpcMain = {
  handle(channel, handler) {
    return ipcMain.handle(channel, wrapUptimeIpc(handler));
  }
};

uptimeIpcMain.handle('uptime:monitors:list', async (_event, options = {}) => listUptimeMonitorsOperation(options));
uptimeIpcMain.handle('uptime:monitors:get', async (_event, payload = {}) => getUptimeMonitorOperation(payload));

uptimeIpcMain.handle('uptime:monitors:create', async (_event, input = {}) => createUptimeMonitorOperation(input));
uptimeIpcMain.handle('uptime:monitors:update', async (_event, input = {}) => updateUptimeMonitorOperation(input));
uptimeIpcMain.handle('uptime:monitors:delete', async (_event, payload = {}) => deleteUptimeMonitorOperation(payload));

uptimeIpcMain.handle('uptime:monitors:test', async (_event, input = {}) => testUptimeMonitorOperation(input));

uptimeIpcMain.handle('uptime:monitors:run-now', async (_event, payload = {}) => runUptimeMonitorNowOperation(payload));

uptimeIpcMain.handle('uptime:checks:list', async (_event, payload = {}) => {
  const context = await uptimeOperationalContext();
  queueUptimeWorkspaceSync(context);
  await syncUptimeWorkspaceBestEffort(context);
  return getUptimeControlDatabaseV2().listChecks(context.workspaceId, payload.monitorId, payload);
});

uptimeIpcMain.handle('uptime:incidents:list', async (_event, options = {}) => {
  const context = await uptimeOperationalContext();
  queueUptimeWorkspaceSync(context);
  await syncUptimeWorkspaceBestEffort(context);
  return getUptimeControlDatabaseV2().listIncidents(context.workspaceId, options);
});

uptimeIpcMain.handle('uptime:incidents:acknowledge', async (_event, payload = {}) => acknowledgeUptimeIncidentOperation(payload));

uptimeIpcMain.handle('uptime:maintenance:list', async (_event, options = {}) => {
  const context = await uptimeOperationalContext();
  queueUptimeWorkspaceSync(context);
  await syncUptimeWorkspaceBestEffort(context);
  return getUptimeControlDatabaseV2().listMaintenanceWindows(context.workspaceId, options);
});

uptimeIpcMain.handle('uptime:maintenance:create', async (_event, input = {}) => createUptimeMaintenanceOperation(input));
uptimeIpcMain.handle('uptime:maintenance:update', async (_event, input = {}) => updateUptimeMaintenanceOperation(input));
uptimeIpcMain.handle('uptime:maintenance:delete', async (_event, payload = {}) => deleteUptimeMaintenanceOperation(payload));

uptimeIpcMain.handle('uptime:worker:status', async () => getUptimeServiceStatusV2());
uptimeIpcMain.handle('uptime:settings:get', async () => getUptimeMonitoringSettings());
uptimeIpcMain.handle('uptime:settings:update', async (_event, input = {}) => updateUptimeMonitoringSettings(input));

uptimeIpcMain.handle('uptime:reports:get', async (_event, options = {}) => buildWorkspaceUptimeReport(options));

uptimeIpcMain.handle('uptime:reports:export-csv', async (_event, options = {}) => {
  const report = await buildWorkspaceUptimeReport(options);
  const dataset = String(options.dataset || 'summary').toLowerCase();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Uptime report CSV',
    defaultPath: `deployerx-uptime-${dataset}-${report.period.from.slice(0, 10)}.csv`,
    filters: [{ name: 'CSV file', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, reportToCsv(report, dataset), 'utf8');
  return { canceled: false, filePath: result.filePath, dataset };
});

uptimeIpcMain.handle('uptime:reports:export-pdf', async (_event, options = {}) => {
  const report = await buildWorkspaceUptimeReport(options);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Uptime report PDF',
    defaultPath: `deployerx-uptime-report-${report.period.from.slice(0, 10)}.pdf`,
    filters: [{ name: 'PDF file', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const reportWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(uptimeReportHtml(report))}`);
    const bytes = await reportWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    await fs.writeFile(result.filePath, bytes);
    return { canceled: false, filePath: result.filePath };
  } finally {
    reportWindow.destroy();
  }
});

ipcMain.handle('uptime:getProjectState', async (_event, projectId) => getUptimeProjectState(projectId));

ipcMain.handle('uptime:getMonitorHistory', async (_event, payload = {}) =>
  getUptimeMonitorHistory(payload.projectId, payload.monitorId)
);

ipcMain.handle('uptime:getServiceStatus', async () => getUptimeServiceStatus());

ipcMain.handle('uptime:runNow', async (_event, payload = {}) => {
  const projectId = String(payload.projectId || '').trim();
  const monitorId = String(payload.monitorId || '').trim();
  if (!projectId) throw new Error('Project id is required.');
  if (isWorkerMode()) {
    if (!monitorId) {
      for (const project of uptimeWorkerProjects) {
        if (project.id !== projectId) continue;
        for (const monitor of project.uptimeMonitors) {
          uptimeRunNowQueue.add(monitorRunKey(project.id, monitor.id));
        }
      }
    } else {
      uptimeRunNowQueue.add(monitorRunKey(projectId, monitorId));
    }
  } else {
    await queueRunNowCommand(projectId, monitorId);
    await maybeStartDetachedUptimeWorker().catch(() => {});
  }
  emitUptimeEvent('uptime:run-queued', { projectId, monitorId });
  return { queued: true };
});

ipcMain.handle('local:open', async (_event, payload = {}) => openLocalEntry(payload.entry));

ipcMain.handle('local:open-with', async (_event, payload = {}) => openLocalEntryWith(payload.entry));

ipcMain.handle('local:mkdir', async (_event, payload = {}) => makeLocalDirectory(payload.directory, payload.name));

ipcMain.handle('local:rename', async (_event, payload = {}) => renameLocalEntry(payload.entry, payload.name));

ipcMain.handle('local:delete', async (_event, payload = {}) => deleteLocalEntry(payload.entry));

ipcMain.handle('ftp:connect', async (_event, payload) => {
  const sessionId = payload.sessionId || `${Date.now()}`;
  try {
    const result = await connectFtp(payload.project, sessionId);
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: String(error?.code || 'FTP_CONNECT_FAILED'),
        message: String(error?.message || 'Could not connect the file browser.')
      }
    };
  }
});

ipcMain.handle('ftp:list', async (_event, payload) => listFtpDirectory(payload.sessionId, payload.path));

ipcMain.handle('ftp:upload', async (_event, payload) => uploadFtpFile(payload.sessionId, payload.localPath, payload.remoteDirectory));

ipcMain.handle('ftp:download', async (_event, payload) => downloadFtpFile(payload.sessionId, payload.remotePath, payload.localPath));

ipcMain.handle('ftp:download-to-directory', async (_event, payload) =>
  downloadFtpEntryToDirectory(payload.sessionId, payload.entry, payload.localDirectory)
);

ipcMain.handle('ftp:open', async (_event, payload) => openFtpEntry(payload.sessionId, payload.entry));

ipcMain.handle('ftp:open-with', async (_event, payload) => openFtpEntryWith(payload.sessionId, payload.entry));

ipcMain.handle('ftp:mkdir', async (_event, payload) => makeFtpDirectory(payload.sessionId, payload.remoteDirectory, payload.name));

ipcMain.handle('ftp:rename', async (_event, payload) => renameFtpEntry(payload.sessionId, payload.entry, payload.name));

ipcMain.handle('ftp:delete', async (_event, payload) => deleteFtpEntry(payload.sessionId, payload.entry));

ipcMain.handle('ftp:disconnect', async (_event, sessionId) => disconnectFtp(sessionId));

ipcMain.handle('emergency:stop', async () => {
  emergencyStop();
  await rdpSessionManager?.closeAll();
  await vncSessionManager?.closeAll();
  await releaseAllVncNetworkSessions();
  await releaseAllWindowsVpnProfiles();
  return true;
});
