const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');
const { DatabaseServerTunnelService, openSshForward, safeTunnelFailure } = require('./server-tunnel');

class EchoStream extends Duplex {
  _read() {}
  _write(chunk, _encoding, callback) {
    this.push(Buffer.from(chunk));
    callback();
  }
  _final(callback) {
    this.push(null);
    callback();
  }
}

class FakeSshClient extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this.forwarded = [];
    this.ended = false;
  }
  connect(config) {
    this.config = config;
    queueMicrotask(() => this.emit('ready'));
  }
  forwardOut(sourceHost, sourcePort, destinationHost, destinationPort, callback) {
    this.forwarded.push({ sourceHost, sourcePort, destinationHost, destinationPort });
    callback(null, new EchoStream());
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.emit('close');
  }
}

function roundTrip(host, port, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Tunnel round trip timed out.'));
    }, 2000);
    socket.once('error', reject);
    socket.once('connect', () => socket.write(value));
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      socket.end();
      resolve(chunk.toString('utf8'));
    });
  });
}

test('binds an ephemeral loopback port and forwards sockets to the exact database endpoint', async () => {
  const client = new FakeSshClient();
  const tunnel = await openSshForward({
    sshConfig: { host: 'server.example.test', port: 22, username: 'deploy', password: 'private', readyTimeout: 2000 },
    remoteHost: 'database.internal',
    remotePort: 5432,
    clientFactory: () => client
  });
  assert.equal(tunnel.host, '127.0.0.1');
  assert.ok(Number.isInteger(tunnel.port) && tunnel.port > 0);
  assert.equal(await roundTrip(tunnel.host, tunnel.port, 'database-probe'), 'database-probe');
  assert.deepEqual(client.forwarded, [{ sourceHost: '127.0.0.1', sourcePort: 0, destinationHost: 'database.internal', destinationPort: 5432 }]);
  await tunnel.close();
  await tunnel.close();
  assert.equal(client.ended, true);
});

test('resolves only the selected workspace server and forwards a safe configuration failure', async () => {
  const observed = [];
  const service = new DatabaseServerTunnelService({
    projectResolver: async (input) => { observed.push(input); return { id: 'server-a', ssh: { host: 'server.example.test' } }; },
    sshConfigResolver: () => ({ host: 'server.example.test', port: 22, username: 'deploy', password: 'private', readyTimeout: 2000 }),
    tunnelFactory: async (input) => {
      assert.equal(input.remoteHost, 'database.internal');
      assert.equal(input.remotePort, 3306);
      return { host: '127.0.0.1', port: 43123, close: async () => {} };
    }
  });
  const tunnel = await service.open({
    workspaceId: 'workspace-a',
    profile: { tunnel: { type: 'server', projectId: 'server-a' }, endpoint: { kind: 'network', host: 'database.internal', port: 3306 } }
  });
  assert.equal(tunnel.port, 43123);
  assert.deepEqual(observed, [{ workspaceId: 'workspace-a', projectId: 'server-a' }]);

  const missing = new DatabaseServerTunnelService({ projectResolver: async () => null, sshConfigResolver: () => ({}), tunnelFactory: async () => ({}) });
  await assert.rejects(missing.open({ workspaceId: 'workspace-a', profile: { tunnel: { type: 'server', projectId: 'missing' }, endpoint: { kind: 'network', host: 'private', port: 5432 } } }), (error) => error.code === 'DATABASE_MANAGER_TUNNEL_SERVER_NOT_FOUND' && !JSON.stringify(error).includes('private'));
  assert.equal(safeTunnelFailure(Object.assign(new Error('password=secret'), { level: 'client-authentication' })).code, 'DATABASE_MANAGER_TUNNEL_AUTHENTICATION_FAILED');
});

test('cancels before SSH authentication without binding a local listener', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new FakeSshClient();
  await assert.rejects(openSshForward({
    sshConfig: { host: 'server.example.test', port: 22, username: 'deploy', password: 'private', readyTimeout: 2000 },
    remoteHost: 'database.internal',
    remotePort: 5432,
    signal: controller.signal,
    clientFactory: () => client
  }), (error) => error.code === 'DATABASE_MANAGER_TUNNEL_CANCELLED');
  assert.equal(client.ended, true);
  assert.equal(client.config, null);
});
