const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererPath = path.join(__dirname, '..', 'renderer', 'renderer.js');
const indexPath = path.join(__dirname, '..', 'renderer', 'index.html');
const renderer = fs.readFileSync(rendererPath, 'utf8');
const index = fs.readFileSync(indexPath, 'utf8');

test('InfluxDB 3 Core renderer exposes filesystem, S3, Azure Blob, and GCS Source contracts', () => {
  assert.match(index, /id="backupAddInfluxDb3CoreConnectionButton"/);
  assert.match(index, /id="backupInfluxDb3CoreModal"/);
  assert.match(index, /id="backupInfluxDb3CoreDataRoot"/);
  assert.match(index, /id="backupInfluxDb3CoreObjectStore"/);
  assert.match(index, /<option value="file">Filesystem<\/option><option value="s3">S3 \/ S3-compatible<\/option><option value="azure">Azure Blob<\/option><option value="google">Google Cloud Storage<\/option>/);

  assert.match(index, /id="backupInfluxDb3CoreObjectStoreEndpoint"/);
  assert.match(index, /id="backupInfluxDb3CoreObjectStoreRegion"/);
  assert.match(index, /id="backupInfluxDb3CoreObjectStoreBucket"/);
  assert.match(index, /id="backupInfluxDb3CoreObjectStorePrefix"/);
  assert.match(index, /id="backupInfluxDb3CoreObjectStoreTimeout"/);
  assert.match(index, /id="backupInfluxDb3CoreObjectStoreForcePathStyle"/);
  assert.match(index, /id="backupInfluxDb3CoreAllowInsecureObjectStoreEndpoint"/);
  assert.match(index, /id="backupInfluxDb3CoreAccessKeyId" type="password"/);
  assert.match(index, /id="backupInfluxDb3CoreSecretAccessKey" type="password"/);
  assert.match(index, /id="backupInfluxDb3CoreSessionToken" type="password"/);

  assert.match(index, /id="backupInfluxDb3CoreAzureFields"/);
  assert.match(index, /id="backupInfluxDb3CoreAzureAccountName"/);
  assert.match(index, /id="backupInfluxDb3CoreAzureContainer"/);
  assert.match(index, /id="backupInfluxDb3CoreAzureEndpoint" type="url"/);
  assert.match(index, /id="backupInfluxDb3CoreAzurePrefix"/);
  assert.match(index, /id="backupInfluxDb3CoreAzureTimeout"/);
  assert.match(index, /id="backupInfluxDb3CoreAzureAccessKey" type="password"[^>]+autocomplete="new-password"/);
  assert.match(index, /id="backupInfluxDb3CoreAzureAllowInsecureEndpoint"/);

  assert.match(index, /id="backupInfluxDb3CoreGcsFields"/);
  assert.match(index, /id="backupInfluxDb3CoreGcsBucket"/);
  assert.match(index, /id="backupInfluxDb3CoreGcsPrefix"/);
  assert.match(index, /id="backupInfluxDb3CoreGcsTimeout"/);
  assert.match(index, /<textarea id="backupInfluxDb3CoreGcsServiceAccountJson"[^>]+autocomplete="new-password"/);

  assert.match(renderer, /confirmationText: 'BIND INFLUXDB CORE FILESYSTEM'/);
  assert.match(renderer, /confirmationText: 'BIND INFLUXDB CORE S3'/);
  assert.match(renderer, /confirmationText: 'BIND INFLUXDB CORE AZURE'/);
  assert.match(renderer, /confirmationText: 'BIND INFLUXDB CORE GCS'/);
  assert.match(renderer, /objectStoreAccountName: els\.backupInfluxDb3CoreAzureAccountName\.value\.trim\(\)/);
  assert.match(renderer, /objectStoreBucket: els\.backupInfluxDb3CoreAzureContainer\.value\.trim\(\)/);
  assert.match(renderer, /objectStoreEndpoint: els\.backupInfluxDb3CoreAzureEndpoint\.value\.trim\(\) \|\| null/);
  assert.match(renderer, /accessKey: els\.backupInfluxDb3CoreAzureAccessKey\.value/);
  assert.match(renderer, /objectStoreBucket: els\.backupInfluxDb3CoreGcsBucket\.value\.trim\(\)/);
  assert.match(renderer, /serviceAccountJson: els\.backupInfluxDb3CoreGcsServiceAccountJson\.value/);
  assert.match(renderer, /querySelectorAll\('input, select, textarea'\)/);

  const googlePayloadStart = renderer.indexOf("} : objectStore === 'google' ? {");
  const googlePayloadEnd = renderer.indexOf('} : {', googlePayloadStart);
  assert.ok(googlePayloadStart > -1 && googlePayloadEnd > googlePayloadStart, 'GCS payload branch must exist');
  assert.doesNotMatch(renderer.slice(googlePayloadStart, googlePayloadEnd), /objectStoreEndpoint|allowInsecureObjectStoreEndpoint/);

  assert.match(renderer, /els\.backupInfluxDb3CoreAzureAccessKey\.value = ''/);
  assert.match(renderer, /els\.backupInfluxDb3CoreGcsServiceAccountJson\.value = ''/);
  assert.match(renderer, /clearBackupInfluxDb3CoreCredentials\(\);\s+setBackupInfluxDb3CoreExistingConnection\(true\)/);
  assert.match(renderer, /els\.backupInfluxDb3CoreAzureEndpoint\.value = ''/);
  assert.match(renderer, /els\.backupInfluxDb3CoreGcsBucket\.value = ''/);

  assert.match(index, /id="backupInfluxDb3CoreNodeId"/);
  assert.match(index, /value="stopped">Node is stopped/);
  assert.match(index, /value="atomic-snapshot">Operator-proven atomic snapshot/);
  assert.match(index, /value="ordered-live-copy">Ordered live copy/);
  assert.match(renderer, /operator-proven atomic \$\{influxDb3CoreStoreUi\(backupInfluxDb3CoreObjectStore\(\)\)\.cloud \? 'object-store' : 'filesystem'\} snapshot/);
  assert.match(renderer, /stopped: \{ requestedLevel: 'application', method: 'influxdb3-core-stopped', confirmationText: 'NODE IS STOPPED'/);
  assert.match(renderer, /'atomic-snapshot': \{ requestedLevel: 'application', method: 'influxdb3-core-atomic-snapshot', confirmationText: 'USE ATOMIC SNAPSHOT'/);
  assert.match(renderer, /'ordered-live-copy': \{ requestedLevel: 'crash', method: 'influxdb3-core-ordered-copy', confirmationText: 'ACCEPT CRASH CONSISTENCY'/);
  assert.match(renderer, /createBackupInfluxDb3CoreConnection\(/);
  assert.match(renderer, /testBackupInfluxDb3CoreConnection\(/);
  assert.match(renderer, /discoverBackupInfluxDb3CoreResources\([^\n]+, 'all'\)/);
  assert.match(renderer, /selector: \{ allDatabases: true, databases: \{ include: \[\], exclude: \[\] \}, schemas: \{ include: \[\], exclude: \[\] \}, tables: \{ include: \[\], exclude: \[\] \}, includeGlobalObjects: false \}/);
  assert.match(renderer, /backupMethod: 'physical', backupMode: 'full'/);
});

test('InfluxDB 3 Core Jobs, Recovery, tests, and Activity use provider-aware bounded behavior', () => {
  assert.match(renderer, /objectStore === 'azure'[^\n]+label: 'Azure Blob'[^\n]+itemPlural: 'objects'[^\n]+reviewMetricLabel: 'Operator review'/);
  assert.match(renderer, /objectStore === 'google'[^\n]+label: 'GCS'[^\n]+itemPlural: 'objects'[^\n]+reviewMetricLabel: 'Operator review'/);
  assert.match(renderer, /objectStore: 'file'[^\n]+label: 'filesystem'[^\n]+itemPlural: 'files'[^\n]+reviewMetricLabel: 'Ownership review'/);
  assert.match(renderer, /Core \$\{influxDb3CoreStore\.label\} recovery point/);
  assert.match(renderer, /independent authenticated full recovery points only/);
  assert.match(renderer, /influxDb3CoreStore\.cloud \? 'object and logical-directory' : 'file and directory'/);
  assert.doesNotMatch(renderer, /const influxDb3CoreS3/);
  assert.doesNotMatch(renderer, /influxDb3CoreRunObjectStore\([^\n]+=== 's3'/);

  assert.match(renderer, /identity\?\.objectStore \|\| 'file'\) === \(point\?\.influxdb3Core\?\.objectStore \|\| 'file'/);
  assert.match(renderer, /identity\?\.restoreSupported === true/);
  assert.match(renderer, /point\.influxdb3Core\?\.restoreSupported === true/);
  assert.match(renderer, /backupRecoveryRestoreButton\.disabled = !influxdb3CoreRestoreAvailable/);
  assert.match(renderer, /Core restore unavailable/);
  assert.match(renderer, /backupRecoveryRestoreButton\.disabled = false;\s+els\.backupRecoveryRestoreButton\.title = ''/);
  assert.match(renderer, /coreDrillAvailable = !core \|\| point\.influxdb3Core\?\.restoreSupported === true/);
  assert.match(renderer, /modes\[1\]\.disabled = !coreDrillAvailable/);
  assert.match(renderer, /metadata validation available/);

  assert.match(renderer, /previewBackupInfluxDb3CoreRestore/);
  assert.match(renderer, /startBackupInfluxDb3CoreRestore/);
  assert.match(renderer, /waitBackupInfluxDb3CoreRestore/);
  assert.match(renderer, /RESTORE INFLUXDB3 CORE ALTERNATE/);
  assert.match(renderer, /influxdb3-core-metadata/);
  assert.match(renderer, /influxdb3-core-full-drill/);
  assert.match(renderer, /startBackupInfluxDb3CoreVerification/);
  assert.match(renderer, /waitBackupInfluxDb3CoreVerification/);
  assert.match(renderer, /RUN INFLUXDB3 CORE RECOVERY DRILL/);
  assert.match(renderer, /listBackupInfluxDb3CoreRestoreRuns/);
  assert.match(renderer, /listBackupInfluxDb3CoreVerificationRuns/);
  assert.match(renderer, /influxDb3CoreStore\.mediaLabel/);
  assert.match(renderer, /influxDb3CoreStore\.reviewMetricLabel/);
  assert.match(renderer, /Partial target objects preserved; deletion not claimed/);
});
