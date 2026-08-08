const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('uses a dialog picker for backup job source selection', async () => {
  const [html, renderer, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8')
  ]);

  assert.match(html, /id="backupJobAddSourceButton"[\s\S]*?aria-haspopup="dialog"[\s\S]*?aria-controls="backupJobSourcePicker"/);
  assert.match(html, /id="backupJobSourcePicker" class="backup-job-source-picker hidden" role="dialog"/);
  assert.match(html, /id="backupJobSourcePickerBody" class="backup-job-source-picker-body"/);
  assert.match(html, /id="backupJobSourcePickerCloseButton" class="icon-button"/);
  assert.match(renderer, /host: els\.backupJobSourcePickerBody,[\s\S]*?context: 'backup-job'/);
  assert.match(renderer, /backupJobSourcePickerCloseButton\.addEventListener\('click',[\s\S]*?closeBackupSourceAddMenu/);
  assert.match(renderer, /const clickedTrigger = backupSourceAddMenuTrigger\?\.contains\(event\.target\);[\s\S]*?if \(!clickedHost && !clickedTrigger\) closeBackupSourceAddMenu\(\);/);
  assert.match(styles, /\.backup-job-source-picker\s*\{[\s\S]*?position: absolute;[\s\S]*?place-items: center;/);
  assert.match(styles, /\.backup-job-source-picker-body \.backup-source-add-menu\s*\{[\s\S]*?position: static;[\s\S]*?box-shadow: none;/);
});
