const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ServerMonitoringSessionManager } = require('./session-manager');

const output = [
  '__DEPLOYERX_CPU__', 'cpu 1 0 1 8 0 0 0 0 0 0',
  '__DEPLOYERX_LOAD__', '0.01 0.02 0.03 1/1 1',
  '__DEPLOYERX_UPTIME__', '10 2',
  '__DEPLOYERX_MEMORY__', 'MemTotal: 1000 kB', 'MemAvailable: 500 kB',
  '__DEPLOYERX_NETWORK__', 'header', 'header', 'eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0',
  '__DEPLOYERX_HOSTNAME__', 'test-host',
  '__DEPLOYERX_CORES__', '2',
  '__DEPLOYERX_STORAGE__', 'Filesystem Type 1024-blocks Used Available Capacity Mounted on', '/dev/sda ext4 1000 500 500 50% /',
  '__DEPLOYERX_PROCESSES__', '1 init 0.1 0.2'
].join('\n');

class FakeClient extends EventEmitter {
  connect() { queueMicrotask(() => this.emit('ready')); }
  exec(_command, callback) {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    callback(null, stream);
    queueMicrotask(() => {
      stream.emit('data', Buffer.from(output));
      stream.emit('close', 0);
    });
  }
  end() { queueMicrotask(() => this.emit('close')); }
}

class FlakyClient extends FakeClient {
  constructor(failures) {
    super();
    this.failures = failures;
  }
  exec(command, callback) {
    if (this.failures > 0) {
      this.failures -= 1;
      callback(new Error('SSH channel is still opening.'));
      return;
    }
    super.exec(command, callback);
  }
}

const waitFor = async (predicate, timeoutMs = 250) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for monitoring event.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('starts, samples, pauses, and stops a monitoring session', async () => {
  const events = [];
  const manager = new ServerMonitoringSessionManager({ emit: (event) => events.push(event), clientFactory: () => new FakeClient(), pollIntervalMs: 60000 });
  manager.start({ sessionId: 'session-1', projectId: 'project-1', connectionConfig: { host: 'localhost', username: 'tester' } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === 'sample' && event.sample.system.hostname === 'test-host'));
  assert.equal(manager.setPaused('session-1', true), true);
  assert.ok(events.some((event) => event.status === 'paused'));
  assert.equal(manager.stop('session-1'), true);
  assert.equal(manager.sessions.size, 0);
});

test('reconnects an owned monitoring connection after transport loss until explicitly stopped', async () => {
  const events = [];
  const clients = [];
  const manager = new ServerMonitoringSessionManager({
    emit: (event) => events.push(event),
    clientFactory: () => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
    pollIntervalMs: 60000
  });

  manager.start({ sessionId: 'persistent-monitor', projectId: 'project-1', connectionConfig: { host: 'localhost', username: 'tester' } });
  await waitFor(() => events.filter((event) => event.type === 'sample').length === 1);
  clients[0].emit('close');

  await waitFor(() => clients.length === 2, 1500);
  await waitFor(() => events.filter((event) => event.type === 'sample').length === 2);
  assert.ok(events.some((event) => event.status === 'reconnecting'));

  manager.stop('persistent-monitor');
  const clientCount = clients.length;
  clients.at(-1).emit('close');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(clients.length, clientCount);
});

test('borrows an existing terminal SSH client without connecting or closing it', async () => {
  const events = [];
  const connection = new FakeClient();
  let ended = false;
  connection.end = () => { ended = true; };
  const manager = new ServerMonitoringSessionManager({ emit: (event) => events.push(event), pollIntervalMs: 60000 });
  manager.start({ sessionId: 'shared-monitor', projectId: 'project-1', connection });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === 'sample' && event.sample.system.hostname === 'test-host'));
  assert.equal(manager.stop('shared-monitor'), true);
  assert.equal(ended, false);
});

test('does not show an error when a borrowed SSH client succeeds after a transient poll failure', async () => {
  const events = [];
  const manager = new ServerMonitoringSessionManager({ emit: (event) => events.push(event), pollIntervalMs: 5 });
  manager.start({ sessionId: 'transient-monitor', projectId: 'project-1', connection: new FlakyClient(1) });
  await waitFor(() => events.some((event) => event.type === 'sample'));
  assert.equal(events.some((event) => event.type === 'error'), false);
  manager.stop('transient-monitor');
});

test('keeps a borrowed SSH client connecting until its first metric sample', async () => {
  const events = [];
  const manager = new ServerMonitoringSessionManager({ emit: (event) => events.push(event), pollIntervalMs: 60000, startupRetryMs: 1 });
  manager.start({ sessionId: 'settling-monitor', projectId: 'project-1', connection: new FlakyClient(2) });
  assert.equal(events.at(-1)?.status, 'connecting');
  await waitFor(() => events.some((event) => event.type === 'sample'));
  assert.equal(events.some((event) => event.type === 'error'), false);
  manager.stop('settling-monitor');
});

test('shows an error after three consecutive metric collection failures', async () => {
  const events = [];
  const manager = new ServerMonitoringSessionManager({ emit: (event) => events.push(event), pollIntervalMs: 5, startupGraceMs: 0 });
  manager.start({ sessionId: 'failed-monitor', projectId: 'project-1', connection: new FlakyClient(3) });
  await waitFor(() => events.some((event) => event.type === 'error'));
  assert.match(events.find((event) => event.type === 'error').message, /still opening/);
  manager.stop('failed-monitor');
});

test('recycles an owned connection after repeated collector failures', async () => {
  const events = [];
  const clients = [];
  const manager = new ServerMonitoringSessionManager({
    emit: (event) => events.push(event),
    clientFactory: () => {
      const client = clients.length ? new FakeClient() : new FlakyClient(3);
      clients.push(client);
      return client;
    },
    pollIntervalMs: 5,
    startupGraceMs: 0
  });

  manager.start({ sessionId: 'stalled-monitor', projectId: 'project-1', connectionConfig: { host: 'localhost', username: 'tester' } });
  await waitFor(() => clients.length === 2, 1500);
  await waitFor(() => events.some((event) => event.type === 'sample'), 1500);
  assert.ok(events.some((event) => event.status === 'reconnecting'));
  manager.stop('stalled-monitor');
});
