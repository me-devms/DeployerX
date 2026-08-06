const crypto = require('crypto');
const http = require('http');
const net = require('net');
const tls = require('tls');
const { WebSocketServer } = require('ws');

const RDCLEANPATH_VERSION = 3390;
const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8STRING = 0x0c;
const TAG_CONTEXT = (value) => 0xa0 + value;

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function wrapDer(tag, content) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function encodeInteger(value) {
  if (value === 0) return wrapDer(TAG_INTEGER, Buffer.from([0]));
  const bytes = [];
  for (let remaining = value; remaining > 0; remaining >>= 8) bytes.unshift(remaining & 0xff);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return wrapDer(TAG_INTEGER, Buffer.from(bytes));
}

function wrapContext(tag, content) {
  return wrapDer(TAG_CONTEXT(tag), content);
}

function decodeLength(buffer, offset) {
  const first = buffer[offset];
  if (first === undefined) throw new Error('Invalid RDCleanPath length.');
  if (first < 0x80) return { length: first, bytesRead: 1 };
  const count = first & 0x7f;
  if (!count || count > 4 || offset + count >= buffer.length) throw new Error('Invalid RDCleanPath length.');
  let length = 0;
  for (let index = 0; index < count; index += 1) length = (length << 8) | buffer[offset + 1 + index];
  return { length, bytesRead: count + 1 };
}

function decodeTlv(buffer, offset = 0) {
  if (offset >= buffer.length) throw new Error('Incomplete RDCleanPath message.');
  const tag = buffer[offset];
  const decodedLength = decodeLength(buffer, offset + 1);
  const headerLength = 1 + decodedLength.bytesRead;
  const end = offset + headerLength + decodedLength.length;
  if (end > buffer.length) throw new Error('Incomplete RDCleanPath value.');
  return {
    tag,
    value: buffer.subarray(offset + headerLength, end),
    totalLength: headerLength + decodedLength.length
  };
}

function decodeChildren(buffer) {
  const children = [];
  for (let offset = 0; offset < buffer.length;) {
    const child = decodeTlv(buffer, offset);
    children.push(child);
    offset += child.totalLength;
  }
  return children;
}

function decodeInteger(buffer) {
  let value = 0;
  for (const byte of buffer) value = (value << 8) | byte;
  return value;
}

function parseRdcCleanPathRequest(data) {
  const outer = decodeTlv(Buffer.isBuffer(data) ? data : Buffer.from(data));
  if (outer.tag !== TAG_SEQUENCE) throw new Error('Invalid RDCleanPath request.');
  let version;
  let destination;
  let x224Request;
  for (const child of decodeChildren(outer.value)) {
    const inner = decodeTlv(child.value);
    const contextTag = child.tag & 0x1f;
    if (contextTag === 0) version = decodeInteger(inner.value);
    if (contextTag === 2) destination = inner.value.toString('utf8');
    if (contextTag === 6) x224Request = Buffer.from(inner.value);
  }
  if (version !== RDCLEANPATH_VERSION) throw new Error('Unsupported RDCleanPath version.');
  if (!destination || !x224Request?.length) throw new Error('Incomplete RDCleanPath request.');
  return { destination, x224Request };
}

function buildRdcCleanPathResponse(serverAddress, x224Response, certificates) {
  const certificateSequence = wrapDer(
    TAG_SEQUENCE,
    Buffer.concat(certificates.map((certificate) => wrapDer(TAG_OCTET_STRING, certificate)))
  );
  return wrapDer(TAG_SEQUENCE, Buffer.concat([
    wrapContext(0, encodeInteger(RDCLEANPATH_VERSION)),
    wrapContext(6, wrapDer(TAG_OCTET_STRING, x224Response)),
    wrapContext(7, certificateSequence),
    wrapContext(9, wrapDer(TAG_UTF8STRING, Buffer.from(serverAddress, 'utf8')))
  ]));
}

function buildRdcCleanPathError(errorCode = 1, httpStatus = 502) {
  const details = wrapDer(TAG_SEQUENCE, Buffer.concat([
    wrapContext(0, encodeInteger(errorCode)),
    wrapContext(1, encodeInteger(httpStatus))
  ]));
  return wrapDer(TAG_SEQUENCE, Buffer.concat([
    wrapContext(0, encodeInteger(RDCLEANPATH_VERSION)),
    wrapContext(1, details)
  ]));
}

function normalizeHost(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '').toLocaleLowerCase('en-US');
}

function normalizeEndpoint(rdp = {}) {
  const host = normalizeHost(rdp.host);
  const port = Number(rdp.port || 3389);
  if (!host) throw new Error('Windows computer or IP is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Windows RDP port must be between 1 and 65535.');
  return { host, port };
}

function parseDestination(value) {
  const destination = String(value || '').trim();
  if (destination.startsWith('[')) {
    const closingBracket = destination.indexOf(']');
    if (closingBracket < 0) throw new Error('Invalid IPv6 RDP destination.');
    const host = destination.slice(1, closingBracket);
    const portText = destination.slice(closingBracket + 1).replace(/^:/, '');
    return { host: normalizeHost(host), port: portText ? Number(portText) : 3389 };
  }
  const separator = destination.lastIndexOf(':');
  if (separator < 0) return { host: normalizeHost(destination), port: 3389 };
  const port = Number(destination.slice(separator + 1));
  if (!Number.isInteger(port)) return { host: normalizeHost(destination), port: 3389 };
  return { host: normalizeHost(destination.slice(0, separator)), port };
}

function endpointAddress(endpoint) {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  return `${host}:${endpoint.port}`;
}

function certificateChain(peerCertificate) {
  const certificates = [];
  const seen = new Set();
  let current = peerCertificate;
  while (current?.raw) {
    const fingerprint = current.fingerprint256 || current.raw.toString('hex');
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    certificates.push(Buffer.from(current.raw));
    current = current.issuerCertificate && current.issuerCertificate !== current ? current.issuerCertificate : null;
  }
  return certificates;
}

function connectRdpTransportAttempt(endpoint, x224Request, timeoutMs, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const tcpSocket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    tcpSocket.setNoDelay(true);
    tcpSocket.setTimeout(timeoutMs, () => {
      tcpSocket.destroy();
      fail(new Error('The RDP server connection timed out.'));
    });
    tcpSocket.once('error', (error) => fail(new Error(`Could not reach the RDP server: ${error.message}`)));
    tcpSocket.once('connect', () => tcpSocket.write(x224Request));
    tcpSocket.once('data', (x224Response) => {
      tcpSocket.removeAllListeners('error');
      tcpSocket.removeAllListeners('data');
      tcpSocket.setTimeout(0);
      const tlsSocket = tls.connect({
        socket: tcpSocket,
        servername: net.isIP(endpoint.host) ? undefined : endpoint.host,
        rejectUnauthorized: false,
        ...tlsOptions
      });
      tlsSocket.setNoDelay(true);
      tlsSocket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        resolve({
          tlsSocket,
          x224Response: Buffer.from(x224Response),
          certificates: certificateChain(tlsSocket.getPeerCertificate(true))
        });
      });
      tlsSocket.once('error', (error) => {
        tlsSocket.destroy();
        const wrappedError = new Error(`RDP TLS negotiation failed: ${error.message}`);
        wrappedError.code = error.code;
        fail(wrappedError);
      });
    });
  });
}

async function connectRdpTransport(endpoint, x224Request, timeoutMs = 20000) {
  try {
    return await connectRdpTransportAttempt(endpoint, x224Request, timeoutMs);
  } catch (error) {
    if (error.code !== 'ERR_SSL_KEY_USAGE_BIT_INCORRECT') throw error;
    return connectRdpTransportAttempt(endpoint, x224Request, timeoutMs, {
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      ciphers: 'AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA'
    });
  }
}

function relayTransport(webSocket, tlsSocket, onClose) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (!tlsSocket.destroyed) tlsSocket.destroy();
    if (webSocket.readyState === webSocket.OPEN || webSocket.readyState === webSocket.CONNECTING) webSocket.close();
    onClose?.();
  };
  tlsSocket.on('data', (data) => {
    if (webSocket.readyState === webSocket.OPEN) webSocket.send(data);
  });
  webSocket.on('message', (data) => {
    if (!tlsSocket.destroyed) tlsSocket.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  tlsSocket.once('end', close);
  tlsSocket.once('error', close);
  webSocket.once('close', close);
  webSocket.once('error', close);
  return close;
}

async function handleProxyConnection(webSocket, endpoint, onTransport, onError) {
  webSocket.once('message', async (data) => {
    try {
      const request = parseRdcCleanPathRequest(data);
      const requestedEndpoint = parseDestination(request.destination);
      if (requestedEndpoint.host !== endpoint.host || requestedEndpoint.port !== endpoint.port) {
        throw new Error('The RDP proxy rejected an unexpected destination.');
      }
      const transport = await connectRdpTransport(endpoint, request.x224Request);
      if (!transport.certificates.length) throw new Error('The RDP server did not provide a TLS certificate.');
      webSocket.send(buildRdcCleanPathResponse(endpointAddress(endpoint), transport.x224Response, transport.certificates));
      const close = relayTransport(webSocket, transport.tlsSocket, () => onTransport?.(null));
      onTransport?.({ close, socket: transport.tlsSocket });
    } catch (error) {
      onError?.(error);
      try { webSocket.send(buildRdcCleanPathError()); } catch {}
      try { webSocket.close(); } catch {}
    }
  });
}

class RdpSessionManager {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.session = null;
  }

  emit(session, event) {
    this.onEvent({ sessionId: session.id, projectId: session.projectId, ...event });
  }

  async start({ projectId, rdp } = {}) {
    if (this.session) await this.stop(this.session.id);
    const endpoint = normalizeEndpoint(rdp);
    const id = `rdp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const token = crypto.randomBytes(24).toString('hex');
    const path = `/rdp/${token}`;
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
      transport: null
    };
    this.session = session;

    webSocketServer.on('connection', (webSocket) => {
      session.sockets.add(webSocket);
      webSocket.once('close', () => session.sockets.delete(webSocket));
      handleProxyConnection(
        webSocket,
        endpoint,
        (transport) => { session.transport = transport; },
        (error) => this.emit(session, { type: 'proxy-error', message: error.message || 'RDP transport failed.' })
      );
    });
    webSocketServer.on('error', (error) => this.emit(session, { type: 'proxy-error', message: error.message || 'RDP proxy failed.' }));

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const proxyUrl = `ws://127.0.0.1:${address.port}${path}`;
    this.emit(session, { type: 'proxy-ready' });
    return { sessionId: id, proxyUrl, destination: endpointAddress(endpoint) };
  }

  async stop(sessionId) {
    const session = this.session;
    if (!session || (sessionId && session.id !== sessionId)) return false;
    if (this.session === session) this.session = null;
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

module.exports = {
  RdpSessionManager,
  buildRdcCleanPathError,
  buildRdcCleanPathResponse,
  endpointAddress,
  normalizeEndpoint,
  parseDestination,
  parseRdcCleanPathRequest
};
