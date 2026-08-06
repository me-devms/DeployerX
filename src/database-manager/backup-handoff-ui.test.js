const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('hands a profile to Backup Manager source discovery without creating a Source', async (context) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-backup-handoff-ui-'));
  context.after(async () => fs.rm(outputDirectory, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(require('electron'), [path.join(__dirname, 'backup-handoff-ui-fixture.js'), outputDirectory], { windowsHide: true, timeout: 30000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.desktop.currentView, 'backup');
  assert.equal(result.desktop.activeTab, 'sources');
  assert.equal(result.desktop.modalVisible, true);
  assert.equal(result.desktop.engine, 'postgresql');
  assert.equal(result.desktop.connectionId, 'connection-postgresql');
  assert.match(result.desktop.discoveredText, /orders/);
  assert.equal(result.desktop.sourceConnectionVisible, true);
  assert.equal(result.desktop.unavailableDisabled, true);
  assert.match(result.desktop.unavailableReason, /password/i);
  assert.equal(result.desktop.sourceWrites, 0, 'handoff must not silently create a Backup Manager Source');
  assert.equal(result.mobile.bodyOverflowX, false);
  assert.ok(result.mobile.card.left >= 0 && result.mobile.card.right <= result.mobile.viewport.width);
  assert.ok(result.mobile.card.top >= 0 && result.mobile.card.bottom <= result.mobile.viewport.height);
  for (const imagePath of [result.desktopPath, result.mobilePath]) {
    const bytes = await fs.readFile(imagePath);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(bytes.length > 10000);
  }
});
