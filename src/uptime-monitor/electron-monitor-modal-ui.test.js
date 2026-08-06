const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('keeps the monitor modal and its actions usable at responsive viewport sizes', async (context) => {
  const electronPath = require('electron');
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-monitor-modal-ui-'));
  context.after(async () => { await fs.rm(outputDirectory, { recursive: true, force: true }); });

  const fixturePath = path.join(__dirname, 'electron-monitor-modal-ui-fixture.js');
  const { stdout } = await execFileAsync(electronPath, [fixturePath, outputDirectory], { windowsHide: true, timeout: 30000 });
  const results = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.equal(results.length, 4);
  for (const result of results) {
    const bytes = await fs.readFile(result.outputPath);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${result.name} screenshot format`);
    assert.ok(bytes.length > 10000, `${result.name} screenshot should contain rendered UI`);
    assert.equal(result.cardInsideViewport, true, `${result.name} card outside viewport`);
    assert.equal(result.footerInsideCard, true, `${result.name} footer clipped by card`);
    assert.equal(result.footerInsideViewport, true, `${result.name} footer outside viewport`);
    assert.equal(result.buttonsInsideFooter, true, `${result.name} actions clipped by footer`);
    assert.equal(result.buttonsInsideViewport, true, `${result.name} actions outside viewport`);
    assert.equal(result.buttonOverlap, false, `${result.name} actions overlap`);
    assert.equal(result.bodyHasUsableHeight, true, `${result.name} body collapsed`);
    assert.equal(result.bodyScrollsWhenNeeded, true, `${result.name} body cannot scroll`);
    assert.equal(result.bodyOverflowX, false, `${result.name} body overflows horizontally`);
    assert.equal(result.documentOverflowX, false, `${result.name} document overflows horizontally`);
  }
});
