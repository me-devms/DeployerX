const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererPath = path.join(__dirname, '..', 'renderer', 'renderer.js');
const indexPath = path.join(__dirname, '..', 'renderer', 'index.html');
const renderer = fs.readFileSync(rendererPath, 'utf8');
const index = fs.readFileSync(indexPath, 'utf8');

test('Enterprise RecoveryPoint projection keeps upgraded-native and legacy tiers separate', () => {
  assert.match(renderer, /return point\?\.influxdb3Enterprise\?\.tier \|\| '';/);
  assert.doesNotMatch(renderer, /point\?\.source\?\.physicalExecution\?\.tier/);
  assert.match(renderer, /deployerx\.database\.influxdb3-enterprise[^\n]+return 'influxdb3-enterprise'/);
  assert.match(renderer, /influxdb3EnterpriseInfo\.tier === 'upgraded-native'/);
  assert.match(renderer, /Enterprise upgraded-engine native recovery point/);
  assert.match(renderer, /Legacy restore is separate/);
  assert.match(renderer, /never routed into the upgraded-native live-cluster restore API/);
  assert.match(renderer, /Row-delete state[^\n]+is not captured[^\n]+row deletes[^\n]+may persist/);
});

test('Enterprise restore modal requires preview-derived exact confirmation and states destructive limits', () => {
  assert.match(index, /id="backupInfluxDb3EnterpriseRestoreModal" class="modal hidden"/);
  assert.match(index, /id="backupInfluxDb3EnterpriseRestoreForm" class="modal-card small backup-file-restore-card"/);
  assert.match(index, /Destructive live-cluster restore/);
  assert.match(index, /modifies the original running cluster in place across the whole cluster/);
  assert.match(index, /id="backupInfluxDb3EnterpriseRestoreRowDeleteWarning"/);
  assert.match(index, /Row-delete limitation/);
  assert.match(index, /Row deletes may persist after restore/);
  assert.match(index, /id="backupInfluxDb3EnterpriseRestoreConfirmation"[^>]+disabled required/);

  assert.match(renderer, /previewBackupInfluxDb3EnterpriseRestore\(\{ recoveryPointId: point\.id \}\)/);
  assert.match(renderer, /listBackupInfluxDb3EnterpriseRestoreRuns\(\{ limit: 100 \}\)/);
  assert.match(renderer, /startBackupInfluxDb3EnterpriseRestore\(\{/);
  assert.match(renderer, /waitBackupInfluxDb3EnterpriseRestore\(started\.id\)/);
  assert.match(renderer, /cancelBackupInfluxDb3EnterpriseRestore\(active\.id\)/);
  assert.match(renderer, /backupInfluxDb3EnterpriseRestoreConfirmation\.value !== plan\.confirmationText/);
  assert.match(renderer, /mode: 'in-place',[\s\S]+confirmed: true,[\s\S]+confirmationText: plan\.confirmationText/);
  assert.match(renderer, /Whole live cluster, in place/);
  assert.match(renderer, /Provider rollback[^\n]+Unavailable/);
});

test('Enterprise restore runs appear in Activity with live-cluster evidence', () => {
  assert.match(renderer, /listBackupInfluxDb3EnterpriseRestoreRuns\(\{ limit: 200 \}\)/);
  assert.match(renderer, /InfluxDB 3 Enterprise destructive live-cluster restore/);
  assert.match(renderer, /entry\.raw\.target\?\.engine === 'influxdb3-enterprise'/);
  assert.match(renderer, /\['Row-delete state'/);
  assert.match(renderer, /\['Row deletes after restore'/);
  assert.match(renderer, /\['Provider rollback', 'Unavailable'\]/);
});

test('Enterprise metadata Recovery Test history is scoped to the selected RecoveryPoint', () => {
  assert.match(renderer, /listBackupInfluxDb3EnterpriseVerificationRuns\(\{ limit: 100, recoveryPointId: point\.id \}\)/);
});
