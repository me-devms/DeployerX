const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { agentArguments, parseAgentEvent, buildAgentPrompt, createProjectArchive, normalizeAiDeployment, normalizeAiDeploymentRunOptions, validateAiDeployment } = require('./ai-deployment');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createDeploymentSshBridge } = require('./deployment-ssh');
const { compareVersions } = require('./local-agents');

test('normalizes, validates, and builds a bounded deployment request', () => {
  const deployment = validateAiDeployment({
    id: ' deployment-1 ',
    name: ' Production ',
    projectId: ' server-1 ',
    localPath: ' C:\\work\\app ',
    remotePath: ' /var/www/app ',
    agentId: 'codex',
    prompt: 'Deploy main safely.',
    instructions: 'Stop on failed checks.',
    lastRunAt: '2026-09-14T10:00:00.000Z',
    log: '[2026-09-14T10:00:00.000Z] INFO Deployment started.'
  });
  assert.equal(deployment.name, 'Production');
  assert.equal(deployment.promptReusable, true);
  assert.equal(normalizeAiDeployment({ promptReusable: false }).promptReusable, false);
  assert.equal(normalizeAiDeployment({ status: 'unknown' }).status, 'never-run');
  const prompt = buildAgentPrompt(deployment, { id: 'server-1', name: 'Web Server' }, '.deployerx/uploads/deployment-1.zip');
  assert.match(prompt, /"serverName": "Web Server"/);
  assert.match(prompt, /"uploadedArchive": "\.deployerx\/uploads\/deployment-1\.zip"/);
  assert.match(prompt, /"targetPath": "\/var\/www\/app"/);
  assert.match(prompt, /already been compressed and uploaded/);
  assert.match(deployment.log, /Deployment started/);
  assert.equal(deployment.runs.length, 1);
  assert.equal(deployment.runs[0].log, deployment.log);
  assert.equal(agentArguments('codex', 'Deploy.').at(-1), '-');
  assert.ok(agentArguments('claude-code', 'Deploy.').includes('--strict-mcp-config'));
  assert.doesNotMatch(prompt, /using DeployerX MCP|required MCP/);
  assert.throws(() => agentArguments('cursor', 'Deploy.'), /does not support unattended deployments/);
});

test('decodes local agent sessions, output and structured failures', () => {
  assert.equal(parseAgentEvent('{"type":"thread.started","thread_id":"session-1"}').sessionId, 'session-1');
  assert.equal(parseAgentEvent('{"type":"turn.failed","error":{"message":"Model unavailable"}}').error, 'Model unavailable');
  assert.equal(parseAgentEvent('{"type":"result","is_error":true,"result":"Permission denied"}').error, 'Permission denied');
  assert.equal(parseAgentEvent('{"type":"item.completed","item":{"type":"agent_message","text":"Verified"}}').result, 'Verified');
  assert.ok(compareVersions('codex-cli 0.154.0-alpha.6.2', 'codex-cli 0.147.0') > 0);
});

test('direct SSH helper isolates concurrent deployments and preserves output and exit status', async () => {
  const bridges = await Promise.all(['server-a', 'server-b'].map((server) => createDeploymentSshBridge(async (command, _timeout, output) => {
    output('stdout', `${server}: ${command}\n`);
    return { exitCode: command === 'fail' ? 7 : 0 };
  })));
  try {
    const outputs = await Promise.all(bridges.map((bridge) => promisify(execFile)(process.execPath,
      [path.join(__dirname, 'deployment-ssh.js'), 'echo "quoted"; $literal'], { env: { ...process.env, ...bridge.env } })));
    assert.equal(outputs[0].stdout, 'server-a: echo "quoted"; $literal\n');
    assert.equal(outputs[1].stdout, 'server-b: echo "quoted"; $literal\n');
    await assert.rejects(promisify(execFile)(process.execPath, [path.join(__dirname, 'deployment-ssh.js'), 'fail'],
      { env: { ...process.env, ...bridges[0].env } }), (error) => error.code === 7);
    const rejected = await fetch(`http://127.0.0.1:${bridges[0].env.DEPLOYERX_SSH_PORT}/exec`, {
      method: 'POST', headers: { Authorization: `Bearer ${bridges[1].env.DEPLOYERX_SSH_TOKEN}` }, body: '{"command":"wrong server"}'
    });
    assert.equal(rejected.status, 401);
  } finally { bridges.forEach((bridge) => bridge.close()); }
});

test('30 simultaneous deployment status writes retain every run', async () => {
  const source = await fs.readFile(path.join(__dirname, 'main.js'), 'utf8');
  let settings = { aiDeployments: Array.from({ length: 30 }, (_, index) => normalizeAiDeployment({
    id: `deployment-${index}`, name: `Deployment ${index}`, projectId: 'server', localPath: '/project', agentId: 'codex', prompt: 'Deploy'
  })) };
  const context = vm.createContext({
    normalizeAiDeployment, validateAiDeployment,
    activeAiDeployments: new Map(),
    readSettings: async () => structuredClone(settings),
    writeSettings: async (value) => { await new Promise((resolve) => setImmediate(resolve)); settings = structuredClone(value); },
    nowIso: () => new Date().toISOString()
  });
  vm.runInContext(source.slice(source.indexOf('function aiDeploymentsFromSettings('), source.indexOf('function workspaceControlCloudRecord(')), context);
  await Promise.all(settings.aiDeployments.map((deployment, index) => context.updateAiDeploymentStatus(deployment.id, 'running', 'Started', `Log ${index}`, `run-${index}`)));
  assert.equal(settings.aiDeployments.filter((deployment) => deployment.status === 'running').length, 30);
  await Promise.all(settings.aiDeployments.map((deployment, index) => context.updateAiDeploymentStatus(deployment.id, index % 2 ? 'failed' : 'successful', 'Finished', `Final ${index}`, `run-${index}`)));
  settings.aiDeployments.forEach((deployment, index) => {
    assert.equal(deployment.runs.length, 1);
    assert.equal(deployment.runs[0].log, `Final ${index}`);
    assert.equal(deployment.status, index % 2 ? 'failed' : 'successful');
  });
});

test('confirmation closes before startup finishes and keeps temporary input', async () => {
  const source = await fs.readFile(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');
  const state = { aiDeployments: { runDeploymentId: 'deployment-1', runSubmitting: false, temporaryFiles: [{ path: '/notes.txt' }] } };
  let open = true;
  let submitted;
  let finish;
  const context = vm.createContext({ state, els: { aiDeploymentTemporaryPrompt: { value: 'Run prompt' } },
    closeAiDeploymentRunDialog: () => { open = false; state.aiDeployments.temporaryFiles = []; },
    startSavedAiDeployment: (id, options) => { assert.equal(open, false); submitted = { id, options }; return new Promise((resolve) => { finish = resolve; }); }
  });
  vm.runInContext(source.slice(source.indexOf('async function submitAiDeploymentRun('), source.indexOf('async function duplicateAiDeployment(')), context);
  const pending = context.submitAiDeploymentRun({ preventDefault() {} });
  assert.equal(open, false);
  assert.equal(submitted.id, 'deployment-1');
  assert.equal(submitted.options.temporaryPrompt, 'Run prompt');
  assert.equal(submitted.options.temporaryFiles[0], '/notes.txt');
  finish();
  await pending;
});

test('startup acknowledges before compression and stopping preparation is safe', async () => {
  const source = await fs.readFile(path.join(__dirname, 'main.js'), 'utf8');
  const deployment = normalizeAiDeployment({ id: 'deployment-1', name: 'Production', projectId: 'server', localPath: '/project', agentId: 'codex', prompt: 'Deploy' });
  let releaseArchive;
  let failed;
  const completion = new Promise((resolve) => { failed = resolve; });
  const active = new Map();
  const statuses = [];
  const context = vm.createContext({ path, console, validateAiDeployment, normalizeAiDeploymentRunOptions,
    activeAiDeployments: active, app: { getPath: () => os.tmpdir() }, createId: () => 'run-1', nowIso: () => new Date().toISOString(),
    listAiDeployments: async () => [deployment], readCurrentStore: async () => ({ projects: [{ id: 'server' }] }),
    listLocalAgents: async () => [{ id: 'codex', installed: true, commandPath: 'codex' }],
    updateAiDeploymentStatus: async (_id, status) => { statuses.push(status); return { ...deployment, status }; },
    createProjectArchive: () => new Promise((resolve) => { releaseArchive = resolve; }),
    emitAiDeployment: (_id, type, payload) => { if (type === 'failed') failed(payload); },
    fs: { rm: async () => {} }
  });
  vm.runInContext(source.slice(source.indexOf('const startingAiDeployments ='), source.indexOf('function emitMcpTerminal(')), context);
  const accepted = await context.runAiDeployment(deployment.id);
  assert.equal(accepted.runId, 'run-1');
  assert.equal(active.size, 1);
  await assert.rejects(context.runAiDeployment(deployment.id), /already running/);
  assert.equal(context.stopAiDeployment('run-1'), true);
  releaseArchive();
  assert.match((await completion).message, /stopped/);
  assert.equal(active.size, 0);
  assert.deepEqual(statuses, ['running', 'failed']);
});

test('interleaved session events keep logs and progress with the correct deployment', async () => {
  const source = await fs.readFile(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');
  const state = { aiDeployments: { items: [], runs: new Map(), logDeploymentId: 'deployment-2', logRunId: 'run-2' } };
  let handler;
  let renders = 0;
  const context = vm.createContext({ state, window: { deployerx: { onAiDeploymentEvent: (callback) => { handler = callback; } } },
    els: { aiDeploymentLogDialog: { open: false }, aiDeploymentLogDetailDialog: { open: true } },
    renderAiDeploymentLogDetail: () => { renders++; }, renderAiDeploymentFilters() {}, renderAiDeployments() {}, showToast() {}, showAlert() {}
  });
  vm.runInContext(source.slice(source.indexOf('window.deployerx?.onAiDeploymentEvent?.('), source.indexOf('window.deployerx?.onVncEvent?.(')), context);
  for (let index = 0; index < 30; index++) {
    handler({ runId: `run-${index}`, type: 'started', payload: { deployment: { id: `deployment-${index}`, status: 'running', runs: [{ id: `run-${index}`, status: 'running', log: '' }] } } });
    handler({ runId: `run-${index}`, type: 'progress', payload: { deploymentId: `deployment-${index}`, percent: index, label: `Stage ${index}` } });
    handler({ runId: `run-${index}`, type: 'log', payload: { deploymentId: `deployment-${index}`, message: `Only session ${index}` } });
  }
  assert.equal(renders, 3);
  state.aiDeployments.items.forEach((deployment) => {
    const index = Number(deployment.id.split('-')[1]);
    assert.equal(deployment.runs[0].percent, index);
    assert.ok(deployment.runs[0].log.endsWith(`Only session ${index}`));
  });
});

test('keeps deployment logs newest first and bounded', () => {
  const runs = Array.from({ length: 52 }, (_, index) => ({
    id: `run-${index}`,
    startedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 8, 1, 0, index + 1)).toISOString(),
    status: index % 2 ? 'successful' : 'failed',
    message: `Run ${index}`,
    log: `Log ${index}`
  }));
  const deployment = normalizeAiDeployment({ runs });
  assert.equal(deployment.runs.length, 50);
  assert.equal(deployment.runs[0].id, 'run-51');
  assert.equal(deployment.runs.at(-1).id, 'run-2');
});

test('keeps temporary run input bounded and separate from the saved deployment', () => {
  const deployment = validateAiDeployment({ name: 'Production', projectId: 'server-1', localPath: 'C:\\work', remotePath: '/srv/app', agentId: 'codex', prompt: 'Saved prompt.' });
  const options = normalizeAiDeploymentRunOptions({ temporaryPrompt: 'Saved prompt. Also clear the cache.', temporaryFiles: [' C:\\temp\\notes.txt ', 'C:\\temp\\notes.txt'] });
  const prompt = buildAgentPrompt(deployment, { name: 'Web Server' }, '/uploads/project.zip', {
    temporaryPrompt: options.temporaryPrompt,
    temporaryFiles: [{ name: 'notes.txt', remotePath: '/uploads/notes.txt' }]
  });
  assert.deepEqual(options.temporaryFiles, ['C:\\temp\\notes.txt']);
  assert.match(prompt, /Saved prompt\. Also clear the cache\./);
  assert.match(prompt, /"remotePath": "\/uploads\/notes\.txt"/);
  assert.equal(deployment.prompt, 'Saved prompt.');
});

test('requires core deployment fields while allowing the agent to choose the server folder', () => {
  assert.throws(() => validateAiDeployment({ name: 'Missing target' }), /Target server is required/);
  const deployment = validateAiDeployment({ name: 'Agent-selected folder', projectId: 'server-1', localPath: 'C:\\work', agentId: 'codex', prompt: 'Deploy beside the existing app.' });
  assert.equal(deployment.remotePath, '');
  assert.match(buildAgentPrompt(deployment, { name: 'Web Server' }, '/uploads/project.zip'), /No target path was provided/);
});

test('creates a ZIP from a local project folder', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-ai-deployment-'));
  try {
    const projectPath = path.join(temporaryRoot, 'project');
    const archivePath = path.join(temporaryRoot, 'project.zip');
    await fs.mkdir(projectPath);
    await fs.writeFile(path.join(projectPath, 'composer.json'), '{}');
    await createProjectArchive(projectPath, archivePath);
    const signature = await fs.readFile(archivePath);
    assert.equal(signature.subarray(0, 2).toString(), 'PK');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
