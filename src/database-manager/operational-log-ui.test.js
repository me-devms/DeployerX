const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('renders filtered safe operational logs without desktop or mobile overflow', async (context) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-operational-log-ui-'));
  context.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(require('electron'), [path.join(__dirname, 'operational-log-ui-fixture.js'), outputDirectory], { windowsHide: true, timeout: 30000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.desktop.entryCount, 5);
  assert.deepEqual(result.desktop.states, ['ready', 'changed', 'succeeded', 'interrupted', 'crashed']);
  assert.equal(result.desktop.partialWarning, true);
  assert.equal(result.desktop.rawEvidenceVisible, false);
  assert.equal(result.desktop.entriesInsideViewport, true);
  assert.equal(result.desktop.entriesOverlap, false);
  assert.deepEqual(result.filtered.options.categories, ['schema']);
  assert.equal(result.filtered.entryCount, 1);
  assert.equal(result.mobile.bodyOverflowX, false);
  assert.equal(result.mobile.toolbarInsideViewport, true);
  assert.equal(result.mobile.entriesInsideViewport, true);
  assert.equal(result.mobile.entriesOverlap, false);
  for (const imagePath of result.imagePaths) {
    const bytes = await fs.readFile(imagePath);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(bytes.length > 10000);
  }
});
