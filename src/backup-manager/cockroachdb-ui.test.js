const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

test('CockroachDB recovery routes only to alternate native recovery controls', () => {
  assert.match(renderer, /deployerx\.database\.cockroachdb/);
  assert.match(renderer, /openBackupCockroachDbRestore/);
  assert.match(renderer, /previewBackupCockroachDbRestore/);
  assert.match(renderer, /startBackupCockroachDbRestore/);
  assert.match(renderer, /waitBackupCockroachDbRestore/);
  assert.match(renderer, /pauseBackupCockroachDbRestore/);
  assert.match(renderer, /resumeBackupCockroachDbRestore/);
  assert.match(renderer, /cancelBackupCockroachDbRestore/);
  assert.match(renderer, /mode: 'alternate'/);
  assert.doesNotMatch(renderer, /cockroachdb[^\n]{0,120}(?:connectionString|postgresql:\/\/|cockroachdb:\/\/)/i);
});

test('CockroachDB details expose safe native retention, schedule, and test workflows', () => {
  for (const identifier of [
    'previewBackupCockroachDbRetention', 'executeBackupCockroachDbRetention',
    'previewBackupCockroachDbSchedule', 'createBackupCockroachDbSchedule',
    'listBackupCockroachDbSchedules', 'reconcileBackupCockroachDbSchedule',
    'startBackupCockroachDbMetadataTest', 'startBackupCockroachDbVerification',
    'waitBackupCockroachDbVerification', 'cockroachdb-full-drill',
    'listBackupCockroachDbVerificationRuns'
  ]) assert.match(renderer, new RegExp(identifier));
  assert.match(renderer, /CockroachDB native media is preserved/);
  assert.match(markup, /id="backupCockroachDbRestoreModal"/);
  assert.match(markup, /id="backupCockroachDbRetentionModal"/);
  assert.match(markup, /id="backupCockroachDbScheduleModal"/);
});
