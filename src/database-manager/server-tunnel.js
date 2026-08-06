const net = require('node:net');
const { Client } = require('ssh2');

const LOCAL_TUNNEL_HOST = '127.0.0.1';
const DEFAULT_TUNNEL_TIMEOUT_MS = 20000;

class DatabaseServerTunnelError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'DatabaseServerTunnelError';
    this.code = code;
    this.safeMessage = safeMessage;
    this.category = 'database-manager';
    this.retryable = Boolean(options.retryable);
  }
}

function tunnelError(code, safeMessage, options) {
  return new DatabaseServerTunnelError(code, safeMessage, options);
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeRemoteEndpoint(endpoint = {}) {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint) || endpoint.kind !== 'network') {
    throw tunnelError('DATABASE_MANAGER_TUNNEL_ENDPOINT_INVALID', 'Linked-server tunnels require a network database endpoint.');
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw tunnelError('DATABASE_MANAGER_TUNNEL_ENDPOINT_INVALID', 'The tunneled database port is invalid.');
  }
  return Object.freeze({ host: requiredText(endpoint.host, 'Database tunnel host', 253), port });
}

function safeTunnelFailure(error) {
  if (error instanceof DatabaseServerTunnelError) return error;
  if (error?.code === 'ABORT_ERR') return tunnelError('DATABASE_MANAGER_TUNNEL_CANCELLED', 'The linked-server tunnel was cancelled.');
  if (error?.code === 'ETIMEDOUT' || error?.level === 'client-timeout') {
    return tunnelError('DATABASE_MANAGER_TUNNEL_TIMEOUT', 'The linked server did not respond before the tunnel timeout.', { retryable: true });
  }
  if (error?.level === 'client-authentication') {
    return tunnelError('DATABASE_MANAGER_TUNNEL_AUTHENTICATION_FAILED', 'The linked server rejected its saved SSH credential.');
  }
  return tunnelError('DATABASE_MANAGER_TUNNEL_CONNECTION_FAILED', 'DeployerX could not open the linked-server tunnel.', { retryable: true });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

async function openSshForward({ sshConfig, remoteHost, remotePort, signal, clientFactory = () => new Client(), serverFactory = (handler) => net.createServer(handler) } = {}) {
  if (!sshConfig || typeof sshConfig !== 'object' || Array.isArray(sshConfig)) throw new TypeError('SSH tunnel configuration is invalid.');
  const destination = normalizeRemoteEndpoint({ kind: 'network', host: remoteHost, port: remotePort });
  const timeoutMs = Number(sshConfig.readyTimeout || DEFAULT_TUNNEL_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new TypeError('SSH tunnel timeout is invalid.');
  const client = clientFactory();
  const sockets = new Set();
  let server = null;
  let closed = false;

  const destroySocket = (socket) => {
    sockets.delete(socket);
    try { socket.destroy(); } catch {}
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of [...sockets]) destroySocket(socket);
    await closeServer(server);
    try { client.end(); } catch {}
  };

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        if (error) reject(safeTunnelFailure(error));
        else resolve();
      };
      const onAbort = () => finish(Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' }));
      const timer = setTimeout(() => finish(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
      timer.unref?.();
      if (signal?.aborted) return onAbort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      client.once('ready', () => finish());
      client.once('error', (error) => finish(error));
      try { client.connect({ ...sshConfig, readyTimeout: timeoutMs }); } catch (error) { finish(error); }
    });
    client.on('error', () => close().catch(() => {}));
    client.once('close', () => close().catch(() => {}));

    server = serverFactory((socket) => {
      if (closed) return destroySocket(socket);
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('error', () => destroySocket(socket));
      client.forwardOut(LOCAL_TUNNEL_HOST, 0, destination.host, destination.port, (error, stream) => {
        if (error || closed) return destroySocket(socket);
        sockets.add(stream);
        stream.once('close', () => sockets.delete(stream));
        stream.once('error', () => {
          sockets.delete(stream);
          destroySocket(socket);
        });
        socket.pipe(stream).pipe(socket);
      });
    });
    server.on('error', () => close().catch(() => {}));
    await new Promise((resolve, reject) => {
      const onError = () => reject(tunnelError('DATABASE_MANAGER_TUNNEL_BIND_FAILED', 'DeployerX could not bind the local database tunnel.', { retryable: true }));
      server.once('error', onError);
      server.listen({ host: LOCAL_TUNNEL_HOST, port: 0, exclusive: true }, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
      throw tunnelError('DATABASE_MANAGER_TUNNEL_BIND_FAILED', 'DeployerX could not bind the local database tunnel.', { retryable: true });
    }
    return Object.freeze({ host: LOCAL_TUNNEL_HOST, port: address.port, close });
  } catch (error) {
    await close();
    throw safeTunnelFailure(error);
  }
}

class DatabaseServerTunnelService {
  constructor({ projectResolver, sshConfigResolver, tunnelFactory = openSshForward } = {}) {
    if (typeof projectResolver !== 'function') throw new TypeError('DatabaseServerTunnelService requires a project resolver.');
    if (typeof sshConfigResolver !== 'function') throw new TypeError('DatabaseServerTunnelService requires an SSH configuration resolver.');
    if (typeof tunnelFactory !== 'function') throw new TypeError('DatabaseServerTunnelService requires a tunnel factory.');
    this.projectResolver = projectResolver;
    this.sshConfigResolver = sshConfigResolver;
    this.tunnelFactory = tunnelFactory;
  }

  async open({ workspaceId, profile, signal } = {}) {
    if (profile?.tunnel?.type !== 'server') throw tunnelError('DATABASE_MANAGER_TUNNEL_CONFIGURATION_INVALID', 'The database profile does not use a linked-server tunnel.');
    const projectId = requiredText(profile.tunnel.projectId, 'Linked server ID', 200);
    const destination = normalizeRemoteEndpoint(profile.endpoint);
    let project;
    try { project = await this.projectResolver({ workspaceId, projectId }); } catch {
      throw tunnelError('DATABASE_MANAGER_TUNNEL_SERVER_UNAVAILABLE', 'The linked server could not be loaded on this device.', { retryable: true });
    }
    if (!project || String(project.id) !== projectId || project.serverType === 'rdp') {
      throw tunnelError('DATABASE_MANAGER_TUNNEL_SERVER_NOT_FOUND', 'The linked SSH server was not found in this workspace.');
    }
    let sshConfig;
    try { sshConfig = this.sshConfigResolver(project); } catch {
      throw tunnelError('DATABASE_MANAGER_TUNNEL_CONFIGURATION_INVALID', 'The linked server SSH configuration is incomplete.');
    }
    try {
      return await this.tunnelFactory({ sshConfig, remoteHost: destination.host, remotePort: destination.port, signal });
    } catch (error) {
      throw safeTunnelFailure(error);
    }
  }
}

module.exports = {
  DEFAULT_TUNNEL_TIMEOUT_MS,
  LOCAL_TUNNEL_HOST,
  DatabaseServerTunnelError,
  DatabaseServerTunnelService,
  normalizeRemoteEndpoint,
  openSshForward,
  safeTunnelFailure
};
