const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ACCESS_PROTOCOL_VERSION,
  APPROVED_ACCESS_THEME_IDS,
  DatabaseAccessCompanionService,
  SUPPORTED_ACCESS_DRIVERS,
  createSafeEnvironment,
  createWindowsPipeName,
  normalizeAccessThemeId,
  normalizePreparedConnection,
  resolveDatabaseAccessCompanionExecutablePath
} = require('./access-companion-service');

const PASSWORD = 'correct horse battery staple';

function accessRequest(profileId, overrides = {}) {
  return {
    workspaceId: 'workspace-a',
    actorId: 'actor-a',
    profileId,
    ...overrides
  };
}

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.killed = false;
  }

  kill() {
    if (this.exitCode != null) return false;
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }

  exit(code = 0) {
    if (this.exitCode != null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

function preparedConnection(overrides = {}) {
  return {
    driverId: 'postgresql',
    readOnly: true,
    profileName: 'Orders PostgreSQL',
    themeId: 'gruvbox-dark',
    connection: {
      host: 'database.example.test',
      port: 5432,
      database: 'orders',
      username: 'deployerx',
      credentials: { password: PASSWORD }
    },
    tunnel: { id: 'tunnel-a' },
    ...overrides
  };
}

function companionClient(pipeName, capturePayload, captureControl, { acknowledge = true } = {}) {
  const socket = net.createConnection(pipeName);
  let buffer = '';
  socket.once('connect', () => {
    socket.write(`${JSON.stringify({
      protocolVersion: ACCESS_PROTOCOL_VERSION,
      type: 'deployerx.db-access.ready'
    })}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const frame = JSON.parse(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      if (frame.type === 'deployerx.db-access.connection') {
        capturePayload(frame);
        if (acknowledge) {
          socket.write(`${JSON.stringify({
            protocolVersion: ACCESS_PROTOCOL_VERSION,
            type: 'deployerx.db-access.accepted',
            profileId: frame.profileId
          })}\n`);
        }
      } else {
        captureControl(frame);
      }
    }
  });
  socket.on('error', () => {});
  return socket;
}

function serviceFixture({
  prepare = async () => preparedConnection(),
  cleanup = async () => {},
  focus = async () => true,
  connect = true,
  acknowledge = true,
  launchTimeoutMs = 250,
  handshakeTimeoutMs = 250,
  environment = {},
  fileExists = () => true
} = {}) {
  const spawnCalls = [];
  const payloads = [];
  const controlFrames = [];
  const children = [];
  const sockets = [];
  const service = new DatabaseAccessCompanionService({
    executablePath: 'C:\\Program Files\\DeployerX\\DeployerX DB Access Manager.exe',
    prepareConnection: prepare,
    cleanupConnection: cleanup,
    focusExisting: focus,
    fileExists,
    launchTimeoutMs,
    handshakeTimeoutMs,
    environment,
    platform: 'win32',
    spawn(executablePath, args, options) {
      const child = new FakeChild(4200 + children.length);
      children.push(child);
      spawnCalls.push({ executablePath, args, options });
      if (connect) {
        setImmediate(() => sockets.push(companionClient(
          args[2],
          (payload) => payloads.push(payload),
          (frame) => controlFrames.push(frame),
          { acknowledge }
        )));
      }
      return child;
    }
  });
  return { service, spawnCalls, payloads, controlFrames, children, sockets };
}

test('uses a random Windows pipe and sends credentials only through the bounded handoff', async (context) => {
  const cleanupCalls = [];
  const prepared = preparedConnection();
  const fixture = serviceFixture({
    prepare: async () => prepared,
    environment: {
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\System32',
      DATABASE_PASSWORD: PASSWORD,
      DEPLOYERX_API_TOKEN: 'must-not-be-inherited'
    },
    cleanup: async (prepared, details) => cleanupCalls.push({ prepared, details })
  });
  context.after(() => fixture.service.dispose());

  const result = await fixture.service.open(accessRequest('profile-a'));
  assert.deepEqual(result, { profileId: 'profile-a', state: 'active' });
  assert.deepEqual(SUPPORTED_ACCESS_DRIVERS, ['postgresql', 'mysql', 'sqlite']);
  assert.equal(fixture.spawnCalls.length, 1);
  const [spawnCall] = fixture.spawnCalls;
  assert.equal(spawnCall.executablePath, 'C:\\Program Files\\DeployerX\\DeployerX DB Access Manager.exe');
  assert.deepEqual(spawnCall.args.slice(0, 2), ['--deployerx-access', '--pipe']);
  assert.match(spawnCall.args[2], /^\\\\\.\\pipe\\deployerx-db-access-[a-f0-9]{64}$/);
  assert.equal(spawnCall.args.length, 3);
  assert.deepEqual(spawnCall.options.env, { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' });
  assert.equal(spawnCall.options.stdio, 'ignore');
  assert.equal(spawnCall.options.shell, false);
  assert.doesNotMatch(JSON.stringify(spawnCall), /correct horse|must-not-be-inherited/);
  assert.equal(fixture.payloads.length, 1);
  assert.equal(fixture.payloads[0].protocolVersion, ACCESS_PROTOCOL_VERSION);
  assert.equal(fixture.payloads[0].profileName, 'Orders PostgreSQL');
  assert.equal(fixture.payloads[0].driverId, 'postgresql');
  assert.equal(fixture.payloads[0].readOnly, true);
  assert.equal(fixture.payloads[0].themeId, 'gruvbox-dark');
  assert.equal(fixture.payloads[0].connection.credentials.password, PASSWORD);
  assert.equal(prepared.connection.credentials.password, '', 'retained credential fields must be scrubbed after acceptance');
  assert.doesNotMatch(JSON.stringify(result), /correct horse/);

  await fixture.service.close(accessRequest('profile-a'));
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].prepared.tunnel.id, 'tunnel-a');
  assert.equal(cleanupCalls[0].details.workspaceId, 'workspace-a');
  assert.equal(cleanupCalls[0].details.actorId, 'actor-a');
  assert.equal(cleanupCalls[0].details.reason, 'requested-close');
});

test('fails before preparing credentials when the companion artifact is missing', async () => {
  let prepareCalls = 0;
  const fixture = serviceFixture({
    fileExists: () => false,
    prepare: async () => {
      prepareCalls += 1;
      return preparedConnection();
    }
  });

  assert.equal(fixture.service.isAvailable(), false);

  await assert.rejects(
    fixture.service.open(accessRequest('missing-companion')),
    (error) => error.code === 'DATABASE_ACCESS_COMPANION_MISSING'
      && error.safeMessage.includes('not installed')
  );
  assert.equal(prepareCalls, 0);
});

test('falls back to a development release artifact when the staged path is absent', (context) => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'deployerx-db-access-'));
  const releaseDirectory = path.join(
    appPath,
    'DeployerX DB Manager',
    'src-tauri',
    'target',
    'release'
  );
  const executablePath = path.join(releaseDirectory, 'deployerx-db-access-manager.exe');
  fs.mkdirSync(releaseDirectory, { recursive: true });
  fs.writeFileSync(executablePath, 'test executable');
  context.after(() => fs.rmSync(appPath, { recursive: true, force: true }));

  assert.equal(
    resolveDatabaseAccessCompanionExecutablePath({ isPackaged: false, appPath }),
    executablePath
  );
});

test('reuses one active child per profile and invokes the focus contract', async (context) => {
  let prepareCount = 0;
  const focused = [];
  const fixture = serviceFixture({
    prepare: async () => {
      prepareCount += 1;
      return preparedConnection();
    },
    focus: async (details) => focused.push(details)
  });
  context.after(() => fixture.service.dispose());

  const first = fixture.service.open(accessRequest('profile-a'));
  const repeated = fixture.service.open(accessRequest('profile-a'));
  assert.deepEqual(await first, { profileId: 'profile-a', state: 'active' });
  assert.deepEqual(await repeated, { profileId: 'profile-a', state: 'focused' });
  assert.deepEqual(await fixture.service.open(accessRequest('profile-a')), { profileId: 'profile-a', state: 'focused' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepareCount, 1);
  assert.equal(fixture.spawnCalls.length, 1);
  assert.deepEqual(fixture.controlFrames, [
    { protocolVersion: 1, type: 'deployerx.db-access.focus', profileId: 'profile-a' },
    { protocolVersion: 1, type: 'deployerx.db-access.focus', profileId: 'profile-a' }
  ]);
  assert.deepEqual(focused, [
    { profileId: 'profile-a', pid: 4200 },
    { profileId: 'profile-a', pid: 4200 }
  ]);
});

test('isolates identical profile IDs across workspace and actor contexts', async (context) => {
  const preparedRequests = [];
  const fixture = serviceFixture({
    prepare: async (request) => {
      preparedRequests.push(request);
      return preparedConnection();
    }
  });
  context.after(() => fixture.service.dispose());
  const first = accessRequest('shared-profile');
  const second = accessRequest('shared-profile', { workspaceId: 'workspace-b', actorId: 'actor-b' });

  assert.deepEqual(await fixture.service.open(first), { profileId: 'shared-profile', state: 'active' });
  assert.deepEqual(await fixture.service.open(second), { profileId: 'shared-profile', state: 'active' });
  assert.equal(fixture.spawnCalls.length, 2);
  assert.deepEqual(preparedRequests, [first, second]);
  assert.equal(fixture.service.isActive(first), true);
  assert.equal(fixture.service.isActive(second), true);

  await fixture.service.close(first);
  assert.equal(fixture.service.isActive(first), false);
  assert.equal(fixture.service.isActive(second), true);
});

test('fails repeat Access explicitly when the persistent focus channel closes', async (context) => {
  const fixture = serviceFixture();
  context.after(() => fixture.service.dispose());
  await fixture.service.open(accessRequest('profile-a'));
  fixture.sockets[0].destroy();
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    fixture.service.open(accessRequest('profile-a')),
    (error) => error.code === 'DATABASE_ACCESS_FOCUS_CHANNEL_CLOSED'
      && error.safeMessage.includes('Close it and try Access again.')
  );
});

test('cleans caller-owned connection resources exactly once when the child exits', async () => {
  const cleanupCalls = [];
  const states = [];
  const fixture = serviceFixture({
    cleanup: async (prepared, details) => cleanupCalls.push({ prepared, details })
  });
  fixture.service.onStateChange = (state) => states.push(state);
  await fixture.service.open(accessRequest('profile-a'));
  fixture.children[0].exit(7);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.service.isActive(accessRequest('profile-a')), false);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].details.reason, 'child-exit');
  assert.deepEqual(states.map((state) => state.state), ['active', 'closed']);
});

test('times out a companion that never connects and releases prepared tunnels', async () => {
  const cleanupCalls = [];
  const fixture = serviceFixture({
    connect: false,
    launchTimeoutMs: 20,
    cleanup: async (_prepared, details) => cleanupCalls.push(details)
  });

  await assert.rejects(
    fixture.service.open(accessRequest('profile-timeout')),
    (error) => error.code === 'DATABASE_ACCESS_LAUNCH_TIMEOUT'
      && error.safeMessage === 'DB Access Manager took too long to start.'
      && !error.message.includes(PASSWORD)
  );
  assert.equal(fixture.children[0].killed, true);
  assert.deepEqual(cleanupCalls, [{
    workspaceId: 'workspace-a', actorId: 'actor-a', profileId: 'profile-timeout', reason: 'launch-failed'
  }]);
});

test('cancels an in-flight launch when the caller closes the profile', async () => {
  const cleanupCalls = [];
  const fixture = serviceFixture({
    connect: false,
    launchTimeoutMs: 1000,
    cleanup: async (_prepared, details) => cleanupCalls.push(details)
  });
  const opening = fixture.service.open(accessRequest('profile-cancelled'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await fixture.service.close(accessRequest('profile-cancelled')), {
    profileId: 'profile-cancelled',
    state: 'closed'
  });
  await assert.rejects(opening, (error) => error.code === 'DATABASE_ACCESS_LAUNCH_CANCELLED');
  assert.equal(fixture.children[0].killed, true);
  assert.deepEqual(cleanupCalls, [{
    workspaceId: 'workspace-a', actorId: 'actor-a', profileId: 'profile-cancelled', reason: 'requested-close'
  }]);
});

test('cleans a late prepared tunnel and never spawns after cancellation', async () => {
  let resolvePreparation;
  const cleanupCalls = [];
  const fixture = serviceFixture({
    prepare: () => new Promise((resolve) => { resolvePreparation = resolve; }),
    cleanup: async (_prepared, details) => cleanupCalls.push(details)
  });
  const opening = fixture.service.open(accessRequest('profile-late'));
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.service.close(accessRequest('profile-late'));
  resolvePreparation(preparedConnection());

  await assert.rejects(opening, (error) => error.code === 'DATABASE_ACCESS_LAUNCH_CANCELLED');
  assert.equal(fixture.spawnCalls.length, 0);
  assert.deepEqual(cleanupCalls, [{
    workspaceId: 'workspace-a', actorId: 'actor-a', profileId: 'profile-late', reason: 'requested-close'
  }]);
});

test('times out an incomplete handshake without exposing the prepared connection', async () => {
  const cleanupCalls = [];
  const fixture = serviceFixture({
    acknowledge: false,
    handshakeTimeoutMs: 20,
    cleanup: async (_prepared, details) => cleanupCalls.push(details)
  });

  await assert.rejects(
    fixture.service.open(accessRequest('profile-handshake')),
    (error) => error.code === 'DATABASE_ACCESS_HANDSHAKE_TIMEOUT'
      && !JSON.stringify(error).includes(PASSWORD)
  );
  assert.equal(fixture.children[0].killed, true);
  assert.equal(cleanupCalls.length, 1);
});

test('maps preparation failures and unsupported drivers to safe public errors', async () => {
  const failed = serviceFixture({
    prepare: async () => { throw new Error(`Unable to use password ${PASSWORD}`); }
  });
  await assert.rejects(
    failed.service.open(accessRequest('profile-a')),
    (error) => error.code === 'DATABASE_ACCESS_PREPARATION_FAILED'
      && !error.message.includes(PASSWORD)
      && !JSON.stringify(error).includes(PASSWORD)
  );
  assert.equal(failed.spawnCalls.length, 0);

  const cleanupCalls = [];
  const unsupported = serviceFixture({
    prepare: async () => preparedConnection({ driverId: 'mssql' }),
    cleanup: async () => cleanupCalls.push(true)
  });
  await assert.rejects(
    unsupported.service.open(accessRequest('profile-a')),
    (error) => error.code === 'DATABASE_ACCESS_DRIVER_UNSUPPORTED'
  );
  assert.equal(unsupported.spawnCalls.length, 0);
  assert.equal(cleanupCalls.length, 1);
});

test('validates protocol bounds, context identity, read-only state, and environment allowlisting', async () => {
  const service = serviceFixture().service;
  await assert.rejects(
    service.open({ profileId: 'profile-a' }),
    (error) => error.code === 'DATABASE_ACCESS_CONTEXT_INVALID'
  );
  assert.equal(createWindowsPipeName(() => Buffer.alloc(32, 0xab)), '\\\\.\\pipe\\deployerx-db-access-' + 'ab'.repeat(32));
  assert.deepEqual(createSafeEnvironment({ PATH: 'safe', password: PASSWORD, API_TOKEN: 'hidden' }), { PATH: 'safe' });
  assert.equal(normalizeAccessThemeId('solarized-light'), 'solarized-light');
  assert.equal(normalizeAccessThemeId('arbitrary-theme'), 'deployerx-light');
  assert.deepEqual(APPROVED_ACCESS_THEME_IDS, [
    'deployerx-light',
    'termius-dark',
    'tokyo-day',
    'catppuccin-mocha',
    'gruvbox-dark',
    'solarized-light'
  ]);
  assert.throws(
    () => normalizePreparedConnection(preparedConnection({ readOnly: 'yes' }), 'profile-a', 4096),
    (error) => error.code === 'DATABASE_ACCESS_PREPARATION_INVALID'
  );
  assert.throws(
    () => normalizePreparedConnection(preparedConnection({ connection: { sql: 'x'.repeat(5000) } }), 'profile-a', 1024),
    (error) => error.code === 'DATABASE_ACCESS_HANDOFF_TOO_LARGE'
  );
  assert.equal(
    resolveDatabaseAccessCompanionExecutablePath({ isPackaged: false, appPath: 'C:\\DeployerX' }),
    'C:\\DeployerX\\native\\dist\\deployerx-db-access-manager\\win32-x64\\deployerx-db-access-manager.exe'
  );
  assert.equal(
    resolveDatabaseAccessCompanionExecutablePath({ isPackaged: true, resourcesPath: 'C:\\Program Files\\DeployerX\\resources' }),
    'C:\\Program Files\\DeployerX\\resources\\db-access-manager\\deployerx-db-access-manager.exe'
  );
});
