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
