const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('renders CPU, memory, storage, and uptime as four full-width rows', async () => {
  const fixture = path.join(__dirname, 'card-layout-fixture.js');
  const { stdout } = await execFileAsync(require('electron'), [fixture], { windowsHide: true, timeout: 30000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.deepEqual(result.labels, ['CPU', 'Memory', 'Storage', 'Uptime']);
  assert.equal(result.bounds.length, 4);
  assert.equal(result.overflowX, false);
  for (const bounds of result.bounds) {
    assert.ok(bounds.width >= result.cardWidth - 2, 'each metric should span the card width');
    assert.ok(bounds.height >= 54 && bounds.height <= 58, 'each metric should use compact, stable spacing');
  }
  for (const alignment of result.alignment) {
    assert.ok(alignment.valueRightGap <= 13, 'the main value should align to the far-right card edge');
    assert.equal(alignment.detailBeforeValue, true, 'supporting detail should appear before the main value');
    assert.equal(alignment.detailRightAligned, true, 'supporting detail should align right');
  }
  for (let index = 1; index < result.bounds.length; index += 1) {
    assert.ok(result.bounds[index].top >= result.bounds[index - 1].bottom, 'metric rows must not overlap');
  }
});
