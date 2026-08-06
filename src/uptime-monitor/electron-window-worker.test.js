const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('continues independent monitor checks after the Electron window closes', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-electron-window-worker-test-'));
  const server = http.createServer((request, response) => {
    const delay = request.url === '/healthy' ? 250 : 300;
    setTimeout(() => {
      response.writeHead(request.url === '/healthy' ? 200 : 503, { 'content-type': 'text/plain' });
      response.end(request.url === '/healthy' ? 'healthy' : 'unavailable');
    }, delay);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  const electronPath = require('electron');
  const fixturePath = path.join(__dirname, 'electron-window-worker-fixture.js');
  const parentUserData = path.join(rootPath, 'electron-parent-user-data');
  const address = server.address();
  const { stdout } = await execFileAsync(electronPath, [`--user-data-dir=${parentUserData}`, fixturePath, rootPath, `http://127.0.0.1:${address.port}`], {
    windowsHide: true,
    timeout: 30000
  });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.equal(result.closePrevented, true);
  assert.equal(result.hiddenAfterClose, true);
  assert.notEqual(result.childProcessId, result.parentProcessId);
  assert.deepEqual(result.checks.map((check) => check.outcome).sort(), ['down', 'up']);
  assert.equal(result.checks.every((check) => Date.parse(check.completedAt) >= Date.parse(result.closedAt)), true);
});
