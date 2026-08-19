const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { DeployerXMcpServer } = require('./mcp-server');

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('MCP publishes live monitoring and complete uptime management tools', async () => {
  const server = new DeployerXMcpServer({ getProjects: async () => [] });
  const response = await server.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = new Set(response.result.tools.map((tool) => tool.name));
  assert.equal(server.tools().length, response.result.tools.length);

  for (const name of [
    'deployerx_get_server_metrics',
    'deployerx_uptime_status',
    'deployerx_uptime_list_monitors',
    'deployerx_uptime_get_monitor',
    'deployerx_uptime_create_monitor',
    'deployerx_uptime_update_monitor',
    'deployerx_uptime_delete_monitor',
    'deployerx_uptime_test_monitor',
    'deployerx_uptime_run_monitor_now',
    'deployerx_uptime_list_checks',
    'deployerx_uptime_list_incidents',
    'deployerx_uptime_acknowledge_incident',
    'deployerx_uptime_list_maintenance',
    'deployerx_uptime_create_maintenance',
    'deployerx_uptime_update_maintenance',
    'deployerx_uptime_delete_maintenance',
    'deployerx_uptime_worker_status',
    'deployerx_uptime_get_settings',
    'deployerx_uptime_update_settings',
    'deployerx_uptime_get_report'
  ]) {
    assert.equal(names.has(name), true, `${name} should be published`);
  }
});

test('MCP routes uptime calls through the application uptime control plane', async () => {
  let received;
  const server = new DeployerXMcpServer({
    getProjects: async () => { throw new Error('server lookup should not be used'); },
    uptimeOperations: {
      createMonitor: async (input) => {
        received = input;
        return { id: 'monitor-1', revision: 1, runtime: { status: 'up' } };
      }
    }
  });
  const input = { name: 'API', type: 'http', config: { url: 'https://example.com/' } };
  const response = await server.handleRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'deployerx_uptime_create_monitor', arguments: input }
  });

  assert.deepEqual(received, input);
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.id, 'monitor-1');
  assert.equal(response.result.structuredContent.runtime.status, 'up');
});

test('MCP delegates SSH to DeployerX without exposing credentials and emits live output notifications', async () => {
  const project = {
    id: 'server-1',
    name: 'Production',
    ssh: { host: 'private.example', username: 'deploy', password: 'never-return-this' }
  };
  const notifications = [];
  let received;
  const server = new DeployerXMcpServer({
    getProjects: async () => [project],
    sshOperations: {
      execute: async (selectedProject, command, timeoutMs, { onOutput }) => {
        received = { selectedProject, command, timeoutMs };
        onOutput('stdout', 'live stdout\n');
        onOutput('stderr', 'live stderr\n');
        return { exit_code: 0, stdout: 'live stdout\n', stderr: 'live stderr\n' };
      }
    }
  });

  const response = await server.handleRpc({
    jsonrpc: '2.0', id: 22, method: 'tools/call',
    params: { name: 'deployerx_ssh_execute', arguments: { server_id: 'server-1', command: 'uptime', timeout_ms: 5000 } }
  }, { notify: (notification) => notifications.push(notification) });

  assert.equal(received.selectedProject, project);
  assert.deepEqual({ command: received.command, timeoutMs: received.timeoutMs }, { command: 'uptime', timeoutMs: 5000 });
  assert.deepEqual(notifications.map((item) => item.params.data.stream), ['stdout', 'stderr']);
  assert.equal(JSON.stringify(response).includes('never-return-this'), false);
  assert.equal(response.result.structuredContent.exit_code, 0);

  server.sshOperations.execute = async () => { throw new Error(`authentication failed: ${project.ssh.password}`); };
  const failed = await server.handleRpc({
    jsonrpc: '2.0', id: 24, method: 'tools/call',
    params: { name: 'deployerx_ssh_execute', arguments: { server_id: 'server-1', command: 'false' } }
  });
  assert.equal(JSON.stringify(failed).includes('never-return-this'), false);
  assert.match(failed.result.content[0].text, /\[redacted\]/);
});

test('MCP Streamable HTTP sends progress and the final tool result as SSE events', async () => {
  const port = await availablePort();
  const server = new DeployerXMcpServer({
    getProjects: async () => [{ id: 'server-1', name: 'Production', ssh: { host: 'private.example' } }],
    sshOperations: {
      execute: async (_project, _command, _timeoutMs, { onOutput }) => {
        onOutput('stdout', 'one\n');
        onOutput('stdout', 'two\n');
        return { exit_code: 0, stdout: 'one\ntwo\n', stderr: '' };
      }
    }
  });
  try {
    const status = await server.start({ port, token: 'stream-token' });
    const response = await fetch(status.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer stream-token',
        Accept: 'text/event-stream',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 23, method: 'tools/call',
        params: { name: 'deployerx_ssh_execute', arguments: { server_id: 'server-1', command: 'watch-task' } }
      })
    });
    const body = await response.text();
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.match(body, /"method":"notifications\/message"/);
    assert.match(body, /"chunk":"one\\n"/);
    assert.match(body, /"id":23/);
    assert.match(body, /"exit_code":0/);
  } finally {
    await server.stop();
  }
});

test('MCP accepts an authenticated Streamable HTTP ping', async () => {
  const server = new DeployerXMcpServer({ getProjects: async () => [] });
  const port = await availablePort();
  const token = 'test-token';
  try {
    const status = await server.start({ port, token });
    assert.equal(status.running, true);
    const response = await fetch(status.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 3, result: {} });
  } finally {
    await server.stop();
  }
});

test('MCP can recover after its configured port was temporarily unavailable', async () => {
  const blocker = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const port = blocker.address().port;
  const server = new DeployerXMcpServer({ getProjects: async () => [] });

  await assert.rejects(server.start({ port, token: 'retry-token' }), (error) => error.code === 'EADDRINUSE');
  assert.equal(server.status().running, false);
  await new Promise((resolve) => blocker.close(resolve));

  try {
    const status = await server.start({ port, token: 'retry-token' });
    assert.equal(status.running, true);
    const response = await fetch(status.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer retry-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })
    });
    assert.equal(response.status, 200);
  } finally {
    await server.stop();
  }
});

test('MCP adopts an existing DeployerX listener during a restart handoff', async () => {
  const port = await availablePort();
  const owner = new DeployerXMcpServer({ getProjects: async () => [] });
  const restarting = new DeployerXMcpServer({ getProjects: async () => [] });
  try {
    await owner.start({ port, token: 'handoff-token' });
    const status = await restarting.start({ port, token: 'handoff-token' });
    assert.equal(status.running, true);
    assert.equal(status.external, true);
    await restarting.stop();
    const response = await fetch(owner.status().url, {
      method: 'POST',
      headers: { Authorization: 'Bearer handoff-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })
    });
    assert.equal(response.status, 200);
  } finally {
    await restarting.stop();
    await owner.stop();
  }
});

test('desktop integration keeps MCP always on and exposes no stop control', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'renderer', 'index.html'), 'utf8');

  assert.match(main, /function normalizeMcpIntegration[\s\S]*enabled: true/);
  assert.match(main, /await initializeUptimeControlPlane\(\)\.catch\(\(\) => \{\}\);\s*await restoreMcpIntegration\(\)\.catch\(\(\) => \{\}\);\s*startMcpHealthWatchdog\(\);\s*createWindow\(/);
  assert.doesNotMatch(main, /mcp-integration:stop|function stopMcpIntegration/);
  assert.doesNotMatch(preload, /stopMcpIntegration|mcp-integration:stop/);
  assert.doesNotMatch(renderer, /mcpIntegrationStopButton|stopMcpIntegration/);
  assert.doesNotMatch(html, /mcpIntegrationStopButton|Start MCP|Stop MCP/);
  assert.match(html, /DeployerX starts MCP automatically and keeps credentials inside this app/);
  assert.match(html, /id="mcpToolList"/);
  assert.doesNotMatch(html, /<div><code>deployerx_list_servers<\/code>/);
  assert.match(renderer, /config\.tools[\s\S]*mcpToolList\.innerHTML/);
  assert.match(main, /tools:\s*ensureMcpServer\(\)\.tools\(\)/);
});

test('desktop restart preserves the MCP token and retries the listener handoff', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const restore = main.match(/async function restoreMcpIntegrationAttempt\(\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(restore, /readOrCreatePersistedMcpToken\(current\)/);
  assert.match(restore, /catch \(error\) \{[\s\S]*writeMcpIntegrationSettings\(failed\)[\s\S]*scheduleMcpRestoreRetry\(\)[\s\S]*return publicMcpIntegration\(failed\)/);
  assert.doesNotMatch(restore, /catch[^}]*tokenEncrypted = ''/);
  assert.match(restore, /startMcpServerWithPortFallback\(config\.port, token\)/);
});
