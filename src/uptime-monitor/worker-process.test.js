const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('runs multiple monitors independently in a detached worker process', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-uptime-process-test-'));
  const server = http.createServer((request, response) => {
    if (request.url === '/healthy') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('healthy');
      return;
    }
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('unavailable');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  const address = server.address();
  const fixturePath = path.join(__dirname, 'worker-process-fixture.js');
  const { stdout } = await execFileAsync(process.execPath, [fixturePath, rootPath, `http://127.0.0.1:${address.port}`, String(process.pid)], {
    detached: true,
    windowsHide: true,
    timeout: 15000
  });
  const result = JSON.parse(stdout.trim());

  assert.notEqual(result.processId, result.parentPid);
  assert.deepEqual(result.checks.map((check) => check.outcome).sort(), ['down', 'up']);
  assert.equal(result.heartbeat.processId, result.processId);
  assert.equal(result.heartbeat.state, 'stopping');
});
