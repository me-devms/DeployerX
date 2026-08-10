const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { WebSocket } = require('ws');
const { VncSessionManager, endpointAddress, normalizeEndpoint } = require('./vnc-session');

test('normalizes VNC endpoints and defaults to port 5900', () => {
  assert.deepEqual(normalizeEndpoint({ host: ' SERVER.Example.com ', port: '5901' }), { host: 'server.example.com', port: 5901 });
  assert.deepEqual(normalizeEndpoint({ host: '[2001:DB8::1]' }), { host: '2001:db8::1', port: 5900 });
  assert.equal(endpointAddress({ host: '2001:db8::1', port: 5900 }), '[2001:db8::1]:5900');
  assert.throws(() => normalizeEndpoint({ host: '' }), /server or IP is required/);
  assert.throws(() => normalizeEndpoint({ host: 'server', port: 70000 }), /between 1 and 65535/);
});

test('rejects an unavailable VNC endpoint before opening the browser proxy', async () => {
  const unavailable = net.createServer();
  await new Promise((resolve, reject) => {
    unavailable.once('error', reject);
    unavailable.listen(0, '127.0.0.1', resolve);
  });
  const port = unavailable.address().port;
  await new Promise((resolve) => unavailable.close(resolve));

  const manager = new VncSessionManager({ connectTimeoutMs: 500 });
  await assert.rejects(
    manager.start({ projectId: 'project-1', vnc: { host: '127.0.0.1', port } }),
    new RegExp(`Could not reach VNC server at 127\\.0\\.0\\.1:${port}`)
  );
  assert.equal(manager.session, null);
});

test('relays raw VNC bytes through a loopback-only WebSocket proxy', async () => {
  const vncServer = net.createServer((socket) => socket.write('RFB 003.008\n'));
  await new Promise((resolve, reject) => {
    vncServer.once('error', reject);
    vncServer.listen(0, '127.0.0.1', resolve);
  });
  const events = [];
  const manager = new VncSessionManager({ onEvent: (event) => events.push(event) });
  const session = await manager.start({
    projectId: 'project-1',
    vnc: { host: '127.0.0.1', port: vncServer.address().port }
  });
  assert.match(session.proxyUrl, /^ws:\/\/127\.0\.0\.1:\d+\/vnc\/[a-f0-9]{48}$/);
  const socket = new WebSocket(session.proxyUrl);
  const banner = await new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()));
    socket.once('error', reject);
  });
  assert.equal(banner, 'RFB 003.008\n');
  assert.equal(events[0].type, 'proxy-ready');
  socket.close();
  assert.equal(await manager.stop(session.sessionId), true);
  await new Promise((resolve) => vncServer.close(resolve));
});

test('reports a server-side disconnect instead of an anonymous WebSocket close', async () => {
  const vncServer = net.createServer((socket) => setTimeout(() => socket.end(), 20));
  await new Promise((resolve, reject) => {
    vncServer.once('error', reject);
    vncServer.listen(0, '127.0.0.1', resolve);
  });
  const events = [];
  const manager = new VncSessionManager({ onEvent: (event) => events.push(event) });
  const session = await manager.start({
    projectId: 'project-1',
    vnc: { host: '127.0.0.1', port: vncServer.address().port }
  });
  const socket = new WebSocket(session.proxyUrl);
  const closed = await new Promise((resolve, reject) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.once('error', reject);
  });
  assert.deepEqual(closed, { code: 1011, reason: 'The VNC server closed the connection.' });
  assert.equal(events.find((event) => event.type === 'proxy-error')?.message, 'The VNC server closed the connection.');
  await manager.stop(session.sessionId);
  await new Promise((resolve) => vncServer.close(resolve));
});
