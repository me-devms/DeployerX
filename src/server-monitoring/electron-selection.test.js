const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('selects and connects the first visible SSH server on first monitor entry', async () => {
  const fixture = path.join(__dirname, 'electron-selection-fixture.js');
  const { stdout } = await execFileAsync(require('electron'), [fixture], { windowsHide: true, timeout: 30000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.equal(result.firstVisible, 'Open Elite Fragrances');
  assert.equal(result.selectedBeforeConnect, 'elite');
  assert.equal(result.selectedRowBeforeConnect, 'Open Elite Fragrances');
  assert.deepEqual(result.terminalProjects, ['elite']);
  assert.equal(result.status, 'connecting-ssh');
});
