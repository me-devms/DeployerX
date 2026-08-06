const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const {
  RdpSessionManager,
  endpointAddress,
  normalizeEndpoint,
  parseDestination,
  parseRdcCleanPathRequest
} = require('./rdp-session');

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  return Buffer.from([0x81, length]);
}

function der(tag, value) {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

function request(destination, x224Request = Buffer.from([3, 0, 0, 11])) {
  const version = der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e])));
  const target = der(0xa2, der(0x0c, Buffer.from(destination)));
  const x224 = der(0xa6, der(0x04, x224Request));
  return der(0x30, Buffer.concat([version, target, x224]));
}

test('normalizes RDP endpoints and validates ports', () => {
  assert.deepEqual(normalizeEndpoint({ host: ' SERVER.Example.com ', port: '3391' }), { host: 'server.example.com', port: 3391 });
  assert.deepEqual(normalizeEndpoint({ host: '[2001:DB8::1]' }), { host: '2001:db8::1', port: 3389 });
  assert.throws(() => normalizeEndpoint({ host: '', port: 3389 }), /computer or IP is required/);
  assert.throws(() => normalizeEndpoint({ host: 'server', port: 70000 }), /between 1 and 65535/);
});

test('parses IPv4, host name, and bracketed IPv6 destinations', () => {
  assert.deepEqual(parseDestination('192.168.1.10:3390'), { host: '192.168.1.10', port: 3390 });
  assert.deepEqual(parseDestination('Server.Example.com'), { host: 'server.example.com', port: 3389 });
  assert.deepEqual(parseDestination('[2001:db8::42]:3392'), { host: '2001:db8::42', port: 3392 });
  assert.equal(endpointAddress({ host: '2001:db8::42', port: 3392 }), '[2001:db8::42]:3392');
});

test('parses an RDCleanPath request', () => {
  const x224 = Buffer.from([3, 0, 0, 11]);
  assert.deepEqual(parseRdcCleanPathRequest(request('server.example.com:3389', x224)), {
    destination: 'server.example.com:3389',
    x224Request: x224
  });
});

test('starts and stops a loopback-only proxy', async () => {
  const events = [];
  const manager = new RdpSessionManager({ onEvent: (event) => events.push(event) });
  const session = await manager.start({ projectId: 'project-1', rdp: { host: '127.0.0.1', port: 3389 } });
  assert.match(session.proxyUrl, /^ws:\/\/127\.0\.0\.1:\d+\/rdp\/[a-f0-9]{48}$/);
  assert.equal(session.destination, '127.0.0.1:3389');
  assert.equal(events[0].type, 'proxy-ready');
  assert.equal(await manager.stop(session.sessionId), true);
  assert.equal(events.at(-1).type, 'proxy-stopped');
});

test('rejects a WebSocket request for a different RDP destination', async () => {
  const events = [];
  const manager = new RdpSessionManager({ onEvent: (event) => events.push(event) });
  const session = await manager.start({ projectId: 'project-2', rdp: { host: '127.0.0.1', port: 3389 } });
  const socket = new WebSocket(session.proxyUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', () => socket.send(request('127.0.0.1:3390')));
    socket.once('message', resolve);
    socket.once('error', reject);
  });
  assert.match(events.find((event) => event.type === 'proxy-error')?.message || '', /unexpected destination/);
  await manager.stop(session.sessionId);
});
