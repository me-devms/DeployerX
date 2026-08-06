const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('renders production Uptime report HTML to valid PDF bytes in Electron', async (context) => {
  const electronPath = require('electron');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-uptime-pdf-test-'));
  const outputPath = path.join(rootPath, 'uptime-report.pdf');
  context.after(async () => { await fs.rm(rootPath, { recursive: true, force: true }); });

  const fixturePath = path.join(__dirname, 'electron-pdf-fixture.js');
  const { stdout } = await execFileAsync(electronPath, [fixturePath, outputPath], { windowsHide: true, timeout: 30000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  const bytes = await fs.readFile(outputPath);

  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(bytes.length, result.byteLength);
  assert.ok(bytes.length > 1000, 'generated report should contain substantive PDF content');
});
