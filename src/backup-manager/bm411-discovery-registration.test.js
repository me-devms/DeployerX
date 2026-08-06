const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { CockroachDbAdapter } = require('./cockroachdb');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { InfluxDb3EnterpriseAdapter } = require('./influxdb3-enterprise');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

function handlerSource(channel) {
  const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(start, -1, `Missing main-process handler for ${channel}.`);
  const end = mainSource.indexOf('\nipcMain.handle(', start + 1);
  return mainSource.slice(start, end === -1 ? mainSource.length : end);
}

test('registers only implemented BM-411 backup and restore capabilities', () => {
  const manifests = new DatabaseAdapterRegistry([
    new InfluxDb3EnterpriseAdapter(),
    new CockroachDbAdapter()
  ]).list();
  assert.deepEqual(manifests.map((manifest) => manifest.adapterId), [
    'deployerx.database.cockroachdb',
    'deployerx.database.influxdb3-enterprise'
  ]);
  for (const manifest of manifests) {
    assert.equal(manifest.executionReady, true);
    assert.equal(manifest.sourceEnrollmentReady, true);
    assert.equal(manifest.capabilities.restore.originalTarget, false);
  }
  const cockroachDb = manifests.find((manifest) => manifest.adapterId === 'deployerx.database.cockroachdb');
  const enterprise = manifests.find((manifest) => manifest.adapterId === 'deployerx.database.influxdb3-enterprise');
  assert.deepEqual(cockroachDb.capabilities.backupModes, ['full', 'incremental']);
  assert.equal(cockroachDb.capabilities.restore.alternateTarget, true);
  assert.equal(cockroachDb.capabilities.restore.nativeValidation, true);
  assert.deepEqual(enterprise.capabilities.backupModes, ['full']);
  assert.equal(enterprise.capabilities.restore.alternateTarget, false);
  assert.match(mainSource, /new CockroachDbSourceReaderService\(/);
  assert.match(mainSource, /\[COCKROACHDB_ADAPTER_ID\]: cockroachDbSourceReader/);
  assert.match(mainSource, /new InfluxDb3EnterpriseSourceReaderRouter\(/);
  assert.match(mainSource, /\[INFLUXDB3_ENTERPRISE_ADAPTER_ID\]: influxDb3EnterpriseSourceReader/);
});

test('exposes audited discovery IPC without credential-bearing audit details', () => {
  for (const engine of ['influxdb3-enterprise', 'cockroachdb']) {
    for (const operation of ['list', 'create', 'test', 'discover']) {
      const channel = `backup:connections:${engine}:${operation}`;
      assert.match(mainSource, new RegExp(`ipcMain[.]handle\\('${channel.replaceAll('-', '[-]')}'`));
      assert.match(preloadSource, new RegExp(`ipcRenderer[.]invoke\\('${channel.replaceAll('-', '[-]')}'`));
    }
    assert.match(handlerSource(`backup:connections:${engine}:create`), new RegExp(`action: 'connection[.]create-${engine.replaceAll('-', '[-]')}'`));
    assert.match(handlerSource(`backup:connections:${engine}:test`), new RegExp(`action: 'connection[.]test-${engine.replaceAll('-', '[-]')}'`));
  }
  assert.doesNotMatch(handlerSource('backup:connections:influxdb3-enterprise:create'), /payload[.](?:token|adminToken|secret)/i);
  assert.doesNotMatch(handlerSource('backup:connections:cockroachdb:create'), /payload[.](?:password|secret|privateKey)/i);
  const destinationHandler = handlerSource('backup:connections:cockroachdb:approve-destination');
  assert.match(destinationHandler, /connection[.]approve-cockroachdb-backup-destination/);
  assert.match(preloadSource, /approveBackupCockroachDbDestination/);
  assert.doesNotMatch(destinationHandler, /details:[\s\S]*externalConnectionName/);
});

test('constructs and reconciles CockroachDB native scheduling with audited IPC', () => {
  assert.match(mainSource, /new CockroachDbScheduleService\(\{[\s\S]*?controlDatabase,[\s\S]*?connectionService: backupCockroachDbConnectionService,[\s\S]*?deviceId: backupDeviceId[\s\S]*?\}\)/);
  assert.match(mainSource, /backupCockroachDbScheduleService[.]reconcileAll\(activeWorkspaceId, 'system'\)/);
  assert.match(mainSource, /const failureDetails = backupAuditFailureDetails\(error, options[.]failureAuditCode\);/);

  const preloadMethods = {
    plan: 'previewBackupCockroachDbSchedule',
    create: 'createBackupCockroachDbSchedule',
    list: 'listBackupCockroachDbSchedules',
    reconcile: 'reconcileBackupCockroachDbSchedule',
    pause: 'pauseBackupCockroachDbSchedule',
    resume: 'resumeBackupCockroachDbSchedule'
  };
  for (const [operation, method] of Object.entries(preloadMethods)) {
    const channel = `backup:cockroachdb-schedules:${operation}`;
    const handler = handlerSource(channel);
    assert.match(handler, /runAuditedBackupMutation\(/);
    assert.match(handler, new RegExp(`action: 'schedule[.]${operation}-cockroachdb-native'`));
    assert.match(handler, /failureAuditCode: 'COCKROACH_NATIVE_SCHEDULE_OPERATION_FAILED'/);
    assert.match(preloadSource, new RegExp(`${method}: [^\n]*ipcRenderer[.]invoke\\('${channel}'`));

    const auditDetails = handler.slice(0, handler.lastIndexOf('() =>'));
    assert.doesNotMatch(
      auditDetails,
      /(?:native(?:Schedule)?Ids?|fullScheduleId|incrementalScheduleId|scheduleLabels?|externalConnectionName|connection(?:Id|Name|Record)?|providerUri|destinationUri|uri|paths?)/i
    );
  }
});

test('normalizes bounded backup mutation failure audit metadata without discarding provider acceptance', () => {
  const start = mainSource.indexOf('function normalizedBackupAuditCode');
  const end = mainSource.indexOf('async function runAuditedBackupMutation', start);
  assert.ok(start >= 0 && end > start, 'Backup audit failure helpers must be present.');
  const helpers = vm.runInNewContext(`${mainSource.slice(start, end)}\n({ backupAuditFailureDetails });`);

  const accepted = helpers.backupAuditFailureDetails({
    code: 'influxdb3_enterprise_retention_delete_reconciliation_required',
    category: 'Integrity',
    operationAccepted: true
  }, 'INFLUXDB3_ENTERPRISE_RETENTION_OPERATION_FAILED');
  assert.equal(accepted.errorCode, 'INFLUXDB3_ENTERPRISE_RETENTION_DELETE_RECONCILIATION_REQUIRED');
  assert.equal(accepted.failureCode, 'INFLUXDB3_ENTERPRISE_RETENTION_OPERATION_FAILED');
  assert.equal(accepted.category, 'integrity');
  assert.equal(accepted.operationAccepted, true);

  const rejected = helpers.backupAuditFailureDetails({
    code: 'unsafe code containing renderer data',
    category: 'unsafe/category',
    details: { operationAccepted: false }
  }, 'INFLUXDB3_ENTERPRISE_RETENTION_OPERATION_FAILED');
  assert.equal(rejected.errorCode, 'INFLUXDB3_ENTERPRISE_RETENTION_OPERATION_FAILED');
  assert.equal(rejected.category, 'unknown');
  assert.equal(rejected.operationAccepted, false);
});

test('exposes CockroachDB repository retention with bounded public and audit projections', () => {
  assert.match(mainSource, /createCockroachDbRetentionAdapters\(\{ controlDatabase, openRepository, deviceId: backupDeviceId \}\)/);
  assert.match(mainSource, /new CockroachDbRetentionService\(cockroachDbRetentionAdapters\)/);
  assert.match(mainSource, /externalNativeMediaPreserved: true/);
  assert.match(mainSource, /nativeMediaDeletionAttempted: false/);

  const preloadMethods = {
    preview: 'previewBackupCockroachDbRetention',
    execute: 'executeBackupCockroachDbRetention'
  };
  for (const [operation, method] of Object.entries(preloadMethods)) {
    const channel = `backup:cockroachdb-retention:${operation}`;
    const handler = handlerSource(channel);
    assert.match(handler, /runAuditedBackupMutation\(/);
    assert.match(handler, new RegExp(`action: 'retention[.]${operation}-cockroachdb'`));
    assert.match(handler, /failureAuditCode: 'COCKROACH_RETENTION_OPERATION_FAILED'/);
    assert.match(handler, new RegExp(`getBackupCockroachDbRetentionService[(][)][.]${operation}`));
    assert.match(preloadSource, new RegExp(`${method}: [^\n]*ipcRenderer[.]invoke\\('${channel}'`));

    const auditEnvelope = handler.slice(0, handler.lastIndexOf('() =>'));
    assert.doesNotMatch(
      auditEnvelope,
      /(?:nativeJob|scheduleId|manifest|chunk|locator|deletionToken|ownershipFingerprint|mediaFingerprint|externalConnection|providerUri|destinationUri|paths?|\berror\b)/i
    );
  }
});

test('exposes CockroachDB alternate-target RestoreRun IPC with redacted audit details', () => {
  assert.match(mainSource, /new CockroachDbRestoreRunService\(/);
  for (const operation of ['preview', 'list', 'start', 'wait', 'pause', 'resume', 'cancel']) {
    const channel = `backup:cockroachdb-restores:${operation}`;
    assert.match(mainSource, new RegExp(`ipcMain[.]handle\\('${channel}'`));
    assert.match(preloadSource, new RegExp(`ipcRenderer[.]invoke\\('${channel}'`));
  }
  const startHandler = handlerSource('backup:cockroachdb-restores:start');
  assert.match(startHandler, /restore[.]start-cockroachdb-alternate/);
  assert.match(startHandler, /COCKROACHDB_RESTORE_CONFIRMATION/);
  assert.doesNotMatch(startHandler, /details:[\s\S]*(?:externalConnection|destinationUri|providerUri|nativeJobId|password|secret)/i);
  for (const operation of ['pause', 'resume', 'cancel']) assert.match(handlerSource(`backup:cockroachdb-restores:${operation}`), /runAuditedBackupMutation/);
});

test('constructs and reconciles audited CockroachDB recovery tests', () => {
  assert.match(mainSource, /new CockroachDbRecoveryTestService\(\{[^\n]*controlDatabase[^\n]*adapter: cockroachDbAdapter[^\n]*connectionService: backupCockroachDbConnectionService[^\n]*restoreService: backupCockroachDbRestoreService[^\n]*notificationService: backupNotificationService[^\n]*\}\)/);
  assert.match(mainSource, /backupCockroachDbRecoveryTestService[.]reconcile\(activeWorkspaceId, String\(settings[.]auth[?][.]uid \|\| 'local-user'\)\)/);

  const preloadMethods = {
    list: 'listBackupCockroachDbVerificationRuns',
    start: 'startBackupCockroachDbVerification',
    wait: 'waitBackupCockroachDbVerification',
    cancel: 'cancelBackupCockroachDbVerification'
  };
  for (const [operation, method] of Object.entries(preloadMethods)) {
    const channel = `backup:cockroachdb-verifications:${operation}`;
    const handler = handlerSource(channel);
    assert.match(handler, /runAuditedBackupMutation\(/);
    assert.match(handler, new RegExp(`action: 'verification[.]${operation}-cockroachdb'`));
    assert.match(handler, /failureAuditCode: 'COCKROACH_VERIFICATION_OPERATION_FAILED'/);
    assert.match(handler, new RegExp(`getBackupCockroachDbRecoveryTestService[(][)][.]${operation}`));
    assert.match(preloadSource, new RegExp(`${method}: [^\n]*ipcRenderer[.]invoke\\('${channel}'`));

    const auditEnvelope = handler.slice(handler.indexOf("{ action:"), handler.lastIndexOf('() =>'));
    assert.doesNotMatch(auditEnvelope, /(?:externalConnection|clusterId|deploymentFingerprint|topologyFingerprint|inventoryFingerprint|destinationFingerprint|nativeJob|password|secret|privateKey|targetConnectionId|targetDatabase|providerUri|destinationUri|paths?)/i);
  }
  const startHandler = handlerSource('backup:cockroachdb-verifications:start');
  assert.match(startHandler, /requestInAppConfirmation\(/);
  assert.match(startHandler, /COCKROACHDB_DRILL_MODE/);
  assert.match(startHandler, /COCKROACHDB_DRILL_CONFIRMATION/);
});

test('exposes InfluxDB 3 Enterprise destructive live-cluster RestoreRun IPC with redacted audit details', () => {
  assert.match(mainSource, /new InfluxDb3EnterpriseRestoreService\(/);
  for (const operation of ['preview', 'list', 'start', 'wait', 'cancel']) {
    const channel = `backup:influxdb3-enterprise-restores:${operation}`;
    assert.match(mainSource, new RegExp(`ipcMain[.]handle\\('${channel}'`));
    assert.match(preloadSource, new RegExp(`ipcRenderer[.]invoke\\('${channel}'`));
  }
  const startHandler = handlerSource('backup:influxdb3-enterprise-restores:start');
  assert.match(startHandler, /restore[.]start-influxdb3-enterprise-in-place/);
  assert.match(startHandler, /requestInAppConfirmation/);
  assert.match(startHandler, /INFLUXDB3_ENTERPRISE_RESTORE_CONFIRMATION/);
  assert.doesNotMatch(startHandler, /details:[\s\S]*(?:token|secret|nativeRestoreId|backupName|backupWatermark|clusterId)/i);
  assert.match(handlerSource('backup:influxdb3-enterprise-restores:cancel'), /runAuditedBackupMutation/);
});

test('wires InfluxDB 3 Enterprise metadata Recovery Test lifecycle and audited IPC without advertising a live drill', () => {
  assert.match(mainSource, /new InfluxDb3EnterpriseRecoveryTestService\(\{ controlDatabase, restoreService: backupInfluxDb3EnterpriseRestoreService, deviceId: backupDeviceId, notificationService: backupNotificationService \}\)/);
  assert.match(mainSource, /backupInfluxDb3EnterpriseRecoveryTestService[.]reconcile\(activeWorkspaceId, String\(settings[.]auth[?][.]uid \|\| 'local-user'\)\)/);
  assert.match(mainSource, /backupInfluxDb3EnterpriseRecoveryTestService = null/);
  assert.match(mainSource, /function getBackupInfluxDb3EnterpriseRecoveryTestService\(\)/);

  const methods = {
    list: 'listBackupInfluxDb3EnterpriseVerificationRuns',
    start: 'startBackupInfluxDb3EnterpriseVerification',
    wait: 'waitBackupInfluxDb3EnterpriseVerification',
    cancel: 'cancelBackupInfluxDb3EnterpriseVerification'
  };
  for (const [operation, method] of Object.entries(methods)) {
    const channel = `backup:influxdb3-enterprise-verifications:${operation}`;
    const handler = handlerSource(channel);
    assert.match(handler, /runAuditedBackupMutation\(/);
    assert.match(handler, new RegExp(`getBackupInfluxDb3EnterpriseRecoveryTestService[(][)][.]${operation}`));
    assert.match(handler, new RegExp(`action: 'verification[.]${operation}-influxdb3-enterprise'`));
    assert.match(handler, /failureAuditCode: 'INFLUXDB3_ENTERPRISE_VERIFICATION_OPERATION_FAILED'/);
    assert.match(preloadSource, new RegExp(`${method}: [^\n]*ipcRenderer[.]invoke\\('${channel}'`));
    const auditEnvelope = handler.slice(handler.indexOf('{ action:'), handler.lastIndexOf('() =>'));
    assert.doesNotMatch(auditEnvelope, /(?:recoveryPointId|verificationRunId|backupName|native(?:Restore)?Id|watermark|endpoint|token|secret|locator|owner|\berror\b)/i);
  }
  const start = handlerSource('backup:influxdb3-enterprise-verifications:start');
  assert.match(start, /mode: INFLUXDB3_ENTERPRISE_METADATA_MODE/);
  assert.doesNotMatch(start, /requestInAppConfirmation|payload[.]mode|full-drill/i);
});

test('exposes authenticated descendant-aware InfluxDB 3 Enterprise native retention through audited IPC', () => {
  assert.match(mainSource, /new InfluxDb3EnterpriseRetentionService\(\{ controlDatabase, secretStore: getBackupSecretStore\(\), deviceId: backupDeviceId, adapter: influxDb3EnterpriseAdapter, recoveryPointAuthenticator: backupInfluxDb3EnterpriseRestoreService \}\)/);
  assert.match(mainSource, /backupInfluxDb3EnterpriseRetentionService[.]reconcile\(activeWorkspaceId, String\(settings[.]auth[?][.]uid \|\| 'local-user'\)\)/);
  assert.match(mainSource, /backupInfluxDb3EnterpriseRetentionService = null/);
  assert.match(mainSource, /function getBackupInfluxDb3EnterpriseRetentionService\(\)/);
  const methods = {
    preview: 'previewBackupInfluxDb3EnterpriseRetention',
    execute: 'executeBackupInfluxDb3EnterpriseRetention'
  };
  for (const [operation, method] of Object.entries(methods)) {
    const channel = `backup:influxdb3-enterprise-retention:${operation}`;
    const handler = handlerSource(channel);
    assert.match(handler, /runAuditedBackupMutation\(/);
    assert.match(handler, new RegExp(`getBackupInfluxDb3EnterpriseRetentionService[(][)][.]${operation}`));
    assert.match(handler, new RegExp(`action: 'retention[.]${operation}-influxdb3-enterprise-native'`));
    assert.match(handler, /failureAuditCode: 'INFLUXDB3_ENTERPRISE_RETENTION_OPERATION_FAILED'/);
    assert.match(preloadSource, new RegExp(`${method}: [^\n]*ipcRenderer[.]invoke\\('${channel}'`));
    const auditEnvelope = handler.slice(handler.indexOf('{ action:'), handler.lastIndexOf('() =>'));
    assert.doesNotMatch(auditEnvelope, /(?:recoveryPointId|backupName|watermark|clusterId|nodeId|endpoint|token|secret|locator|owner|confirmationText|\berror\b)/i);
  }
  const preview = handlerSource('backup:influxdb3-enterprise-retention:preview');
  assert.match(preview, /const details = influxDb3EnterpriseRetentionAuditDetails\(\);/);
  assert.match(preview, /resultAudit: influxDb3EnterpriseRetentionPreviewResultAudit/);
  assert.doesNotMatch(preview, /influxDb3EnterpriseRetentionAuditDetails\(payload\)/);
  assert.match(mainSource, /function influxDb3EnterpriseRetentionPreviewResultAudit\(result = \{\}\)[\s\S]*?planId: result[.]planId[\s\S]*?resourceId: details[.]planId/);
  const execute = handlerSource('backup:influxdb3-enterprise-retention:execute');
  assert.match(execute, /requestInAppConfirmation/);
  assert.match(execute, /INFLUXDB3_ENTERPRISE_DELETE_CONFIRMATION/);
  assert.match(execute, /Delete Native Backups/);
});

test('exposes reviewed InfluxDB 3 Enterprise legacy repository retention IPC', () => {
  assert.match(mainSource, /new InfluxDb3EnterpriseLegacyRetentionService\(/);
  for (const operation of ['plan', 'execute']) {
    const channel = `backup:influxdb3-enterprise-legacy-retention:${operation}`;
    assert.match(mainSource, new RegExp(`ipcMain[.]handle\\('${channel}'`));
    assert.match(preloadSource, new RegExp(`ipcRenderer[.]invoke\\('${channel}'`));
  }
  const executeHandler = handlerSource('backup:influxdb3-enterprise-legacy-retention:execute');
  assert.match(executeHandler, /runAuditedBackupMutation/);
  assert.match(executeHandler, /retention[.]delete-influxdb3-enterprise-legacy-copy/);
  assert.doesNotMatch(executeHandler, /details:[\s\S]*(?:manifest|chunk|locator|path|token|secret)/i);
});

test('wires persisted InfluxDB 3 Enterprise legacy stop proof and audited binding IPC', () => {
  assert.match(mainSource, /const backupInfluxDb3EnterpriseLegacyStopProofKey = crypto[.]randomBytes\(32\)/);
  assert.match(mainSource, /new InfluxDb3EnterpriseLegacyStopBindingService\(\{ controlDatabase, deviceId: backupDeviceId \}\)/);
  assert.match(mainSource, /new InfluxDb3EnterpriseLegacyStopProofService\(\{[\s\S]*?resolveBindings: \(workspaceId\) => backupInfluxDb3EnterpriseLegacyStopBindingService[.]resolveBindings\(workspaceId\),[\s\S]*?resolveProofKey: async \(\) => Buffer[.]from\(backupInfluxDb3EnterpriseLegacyStopProofKey\)[\s\S]*?\}\)/);
  assert.match(mainSource, /new InfluxDb3EnterpriseLegacyRestoreService\(\{ controlDatabase, deviceId: backupDeviceId, openRepository, stopProofService: backupInfluxDb3EnterpriseLegacyStopProofService \}\)/);
  assert.match(mainSource, /new InfluxDb3EnterpriseLegacyRecoveryTestService\(\{[\s\S]*?restoreService: backupInfluxDb3EnterpriseLegacyRestoreService,[\s\S]*?assertTargetIsolated: assertBackupInfluxDb3EnterpriseLegacyTargetIsolated,[\s\S]*?notificationService: backupNotificationService[\s\S]*?\}\)/);
  assert.match(mainSource, /assertBackupInfluxDb3EnterpriseLegacyTargetIsolated[\s\S]*?assertTargetStopped\(workspaceId,[\s\S]*?nodeSetDigest: evidence[.]nodeSetDigest[\s\S]*?serviceExposed: false/);
  assert.match(mainSource, /backupInfluxDb3EnterpriseLegacyRestoreService[.]reconcile\(activeWorkspaceId, String\(settings[.]auth[?][.]uid \|\| 'local-user'\)\)/);
  assert.match(mainSource, /backupInfluxDb3EnterpriseLegacyRecoveryTestService[.]reconcile\(activeWorkspaceId, String\(settings[.]auth[?][.]uid \|\| 'local-user'\)\)/);

  const preloadMethods = {
    list: 'listBackupInfluxDb3EnterpriseLegacyStopBindings',
    create: 'createBackupInfluxDb3EnterpriseLegacyStopBinding',
    remove: 'removeBackupInfluxDb3EnterpriseLegacyStopBinding'
  };
  for (const [operation, method] of Object.entries(preloadMethods)) {
    const channel = `backup:influxdb3-enterprise-legacy-stop-bindings:${operation}`;
    const handler = handlerSource(channel);
    assert.match(handler, /runAuditedBackupMutation\(/);
    assert.match(handler, new RegExp(`action: 'stop-binding[.]${operation}-influxdb3-enterprise-legacy'`));
    assert.match(handler, /failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_STOP_BINDING_OPERATION_FAILED'/);
    assert.match(handler, new RegExp(`getBackupInfluxDb3EnterpriseLegacyStopBindingService[(][)][.]${operation}`));
    assert.match(preloadSource, new RegExp(`${method}: [^\n]*ipcRenderer[.]invoke\\('${channel}'`));
    const auditEnvelope = handler.slice(handler.indexOf('{ action:'), handler.lastIndexOf('() =>'));
    assert.doesNotMatch(auditEnvelope, /(?:nodes?|sshConnection|systemdUnit|host|credential|secret|privateKey|targetConnectionId|clusterId|\berror\b)/i);
    assert.doesNotMatch(handler, /resolveBindings/);
  }
  assert.doesNotMatch(preloadSource, /resolveBackupInfluxDb3EnterpriseLegacyStopBindings/);
});

test('exposes audited InfluxDB 3 Enterprise legacy restore and Recovery Test IPC', () => {
  const restoreMethods = {
    preview: 'previewBackupInfluxDb3EnterpriseLegacyRestore',
    list: 'listBackupInfluxDb3EnterpriseLegacyRestoreRuns',
    start: 'startBackupInfluxDb3EnterpriseLegacyRestore',
    wait: 'waitBackupInfluxDb3EnterpriseLegacyRestore',
    cancel: 'cancelBackupInfluxDb3EnterpriseLegacyRestore'
  };
  for (const [operation, method] of Object.entries(restoreMethods)) {
    const channel = `backup:influxdb3-enterprise-legacy-restores:${operation}`;
    const handler = handlerSource(channel);
    assert.match(handler, new RegExp(`getBackupInfluxDb3EnterpriseLegacyRestoreService[(][)][.]${operation}`));
    assert.match(preloadSource, new RegExp(`${method}: [^\n]*ipcRenderer[.]invoke\\('${channel}'`));
  }
  const restoreStart = handlerSource('backup:influxdb3-enterprise-legacy-restores:start');
  assert.match(restoreStart, /requestInAppConfirmation\(/);
  assert.match(restoreStart, /INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CONFIRMATION/);
  assert.match(restoreStart, /failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_OPERATION_FAILED'/);
  assert.match(restoreStart, /restore[.]start-influxdb3-enterprise-legacy/);
  const restoreAudit = restoreStart.slice(restoreStart.indexOf('{ action:'), restoreStart.lastIndexOf('() =>'));
  assert.doesNotMatch(restoreAudit, /(?:targetConnectionId|dataRoot|paths?|nodes?|sshConnection|systemdUnit|credential|secret|privateKey)/i);

  const verificationMethods = {
    list: 'listBackupInfluxDb3EnterpriseLegacyVerificationRuns',
    start: 'startBackupInfluxDb3EnterpriseLegacyVerification',
    wait: 'waitBackupInfluxDb3EnterpriseLegacyVerification',
    cancel: 'cancelBackupInfluxDb3EnterpriseLegacyVerification'
  };
  for (const [operation, method] of Object.entries(verificationMethods)) {
    const channel = `backup:influxdb3-enterprise-legacy-verifications:${operation}`;
    const handler = handlerSource(channel);
    assert.match(handler, new RegExp(`getBackupInfluxDb3EnterpriseLegacyRecoveryTestService[(][)][.]${operation}`));
    assert.match(preloadSource, new RegExp(`${method}: [^\n]*ipcRenderer[.]invoke\\('${channel}'`));
  }
  const verificationStart = handlerSource('backup:influxdb3-enterprise-legacy-verifications:start');
  assert.match(verificationStart, /requestInAppConfirmation\(/);
  assert.match(verificationStart, /INFLUXDB3_ENTERPRISE_LEGACY_DRILL_MODE/);
  assert.match(verificationStart, /INFLUXDB3_ENTERPRISE_LEGACY_DRILL_CONFIRMATION/);
  assert.match(verificationStart, /failureAuditCode: 'INFLUXDB3_ENTERPRISE_LEGACY_VERIFICATION_OPERATION_FAILED'/);
  assert.match(verificationStart, /verification[.]start-influxdb3-enterprise-legacy/);
  const verificationAudit = verificationStart.slice(verificationStart.indexOf('{ action:'), verificationStart.lastIndexOf('() =>'));
  assert.doesNotMatch(verificationAudit, /(?:targetConnectionId|dataRoot|paths?|nodes?|sshConnection|systemdUnit|credential|secret|privateKey)/i);
});
