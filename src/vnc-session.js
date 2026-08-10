const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');

const VNC_CONNECT_TIMEOUT_MS = 6000;

function normalizeHost(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '').toLocaleLowerCase('en-US');
}

function normalizeEndpoint(vnc = {}) {
  const host = normalizeHost(vnc.host);
  const port = Number(vnc.port || 5900);
  if (!host) throw new Error('VNC server or IP is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VNC port must be between 1 and 65535.');
  return { host, port };
}

function endpointAddress(endpoint) {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  return `${host}:${endpoint.port}`;
}

function connectVncSocket(endpoint, timeoutMs = VNC_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    const timeout = setTimeout(() => {
      const error = new Error(
        `VNC server at ${endpointAddress(endpoint)} did not respond within ${Math.ceil(timeoutMs / 1000)} seconds. ` +
        'Verify TightVNC Server is running and Windows Firewall allows the VNC port.'
      );
      error.code = 'VNC_CONNECT_TIMEOUT';
      fail(error);
    }, timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error.code === 'VNC_CONNECT_TIMEOUT'
        ? error
        : new Error(`Could not reach VNC server at ${endpointAddress(endpoint)}: ${error.message}`));
    };
    socket.setNoDelay(true);
    socket.once('error', fail);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeListener('error', fail);
      socket.pause();
      resolve(socket);
    });
  });
}

function relayTransport(webSocket, socket, onClose, onError) {
  let closed = false;
  const close = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) socket.destroy();
    if (webSocket.readyState === webSocket.OPEN || webSocket.readyState === webSocket.CONNECTING) {
      webSocket.close(code, String(reason || '').slice(0, 120));
    }
    onClose?.();
  };
  socket.on('data', (data) => {
    if (webSocket.readyState === webSocket.OPEN) webSocket.send(data);
  });
  webSocket.on('message', (data) => {
    if (!socket.destroyed) socket.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  socket.once('end', () => {
    const message = 'The VNC server closed the connection.';
    onError?.(message);
    close(1011, message);
  });
  socket.once('error', (error) => {
    const message = `VNC transport failed: ${error.message}`;
    onError?.(message);
    close(1011, message);
  });
  webSocket.once('close', () => close());
  webSocket.once('error', () => close());
  return close;
}

class VncSessionManager {
  constructor({ onEvent = () => {}, connectTimeoutMs = VNC_CONNECT_TIMEOUT_MS } = {}) {
    this.onEvent = onEvent;
    this.connectTimeoutMs = connectTimeoutMs;
    this.session = null;
  }

  emit(session, event) {
    this.onEvent({ sessionId: session.id, projectId: session.projectId, ...event });
  }

  async start({ projectId, vnc } = {}) {
    if (this.session) await this.stop(this.session.id);
    const endpoint = normalizeEndpoint(vnc);
    const socket = await connectVncSocket(endpoint, this.connectTimeoutMs);
    const id = `vnc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const path = `/vnc/${crypto.randomBytes(24).toString('hex')}`;
    const server = http.createServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('Not found');
    });
    const webSocketServer = new WebSocketServer({
      server,
      path,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false
    });
    const session = {
      id,
      projectId: String(projectId || ''),
      endpoint,
      server,
      webSocketServer,
      sockets: new Set(),
      pendingSocket: socket,
      transport: null
    };
    this.session = session;

    const pendingSocketError = (error) => {
      if (session.pendingSocket !== socket) return;
      session.pendingSocket = null;
      this.emit(session, { type: 'proxy-error', message: `VNC connection failed: ${error.message}` });
    };
    socket.once('error', pendingSocketError);

    webSocketServer.on('connection', (webSocket) => {
      session.sockets.add(webSocket);
      webSocket.once('close', () => session.sockets.delete(webSocket));
      const connectedSocket = session.pendingSocket;
      if (!connectedSocket) {
        webSocket.close(1011, 'VNC endpoint is unavailable');
        return;
      }
      session.pendingSocket = null;
      connectedSocket.removeListener('error', pendingSocketError);
      const close = relayTransport(
        webSocket,
        connectedSocket,
        () => { session.transport = null; },
        (message) => this.emit(session, { type: 'proxy-error', message })
      );
      session.transport = { close, socket: connectedSocket };
      connectedSocket.resume();
    });
    webSocketServer.on('error', (error) => this.emit(session, { type: 'proxy-error', message: error.message || 'VNC proxy failed.' }));

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    } catch (error) {
      socket.destroy();
      if (this.session === session) this.session = null;
      throw error;
    }
    const address = server.address();
    const proxyUrl = `ws://127.0.0.1:${address.port}${path}`;
    this.emit(session, { type: 'proxy-ready' });
    return { sessionId: id, proxyUrl, destination: endpointAddress(endpoint) };
  }

  async stop(sessionId) {
    const session = this.session;
    if (!session || (sessionId && session.id !== sessionId)) return false;
    if (this.session === session) this.session = null;
    session.pendingSocket?.destroy();
    session.pendingSocket = null;
    session.transport?.close?.();
    for (const socket of session.sockets) {
      try { socket.terminate(); } catch {}
    }
    await Promise.all([
      new Promise((resolve) => {
        try { session.webSocketServer.close(resolve); } catch { resolve(); }
      }),
      new Promise((resolve) => {
        if (!session.server.listening) return resolve();
        session.server.close(() => resolve());
      })
    ]);
    this.emit(session, { type: 'proxy-stopped' });
    return true;
  }

  async closeAll() {
    await this.stop(this.session?.id);
  }
}

module.exports = { VncSessionManager, endpointAddress, normalizeEndpoint };
