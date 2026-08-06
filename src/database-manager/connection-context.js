function connectionContextError(code, safeMessage) {
  return Object.assign(new Error(safeMessage), { code, safeMessage, category: 'database-manager', retryable: false });
}

const RUNTIME_TUNNEL = Symbol('database-runtime-tunnel');

async function resolveRuntimeConnection({ workspaceId, profile, secretStore, localResourceResolver = null, tunnelProvider = null, signal = null } = {}) {
  if (!profile || !profile.id || !profile.driverId) throw new TypeError('Database profile is required for a runtime connection.');
  if (!secretStore?.resolve) throw new TypeError('Database runtime connection requires a secret store.');
  const endpoint = { ...profile.endpoint };
  let tunnel = null;
  if (profile.tunnel?.type === 'server') {
    if (!tunnelProvider?.open) throw connectionContextError('DATABASE_MANAGER_TUNNEL_NOT_AVAILABLE', 'Linked-server database tunnels are unavailable on this device.');
    try {
      tunnel = await tunnelProvider.open({ workspaceId, profile, signal });
      if (!tunnel || tunnel.host !== '127.0.0.1' || !Number.isInteger(tunnel.port) || tunnel.port < 1 || tunnel.port > 65535 || typeof tunnel.close !== 'function') throw new Error('invalid tunnel');
      endpoint.host = tunnel.host;
      endpoint.port = tunnel.port;
    } catch (error) {
      await Promise.resolve(tunnel?.close?.()).catch(() => {});
      if (/^DATABASE_MANAGER_TUNNEL_[A-Z0-9_]+$/.test(String(error?.code || ''))) throw error;
      throw connectionContextError('DATABASE_MANAGER_TUNNEL_CONNECTION_FAILED', 'DeployerX could not open the linked-server tunnel.');
    }
  }
  if (endpoint.kind === 'file' || endpoint.kind === 'folder') {
    if (typeof localResourceResolver !== 'function') {
      throw connectionContextError('DATABASE_MANAGER_LOCAL_RESOURCE_REQUIRED', 'Choose the local database file before using this profile.');
    }
    const localPath = await localResourceResolver({ workspaceId, profileId: profile.id, kind: endpoint.kind });
    if (!localPath || typeof localPath !== 'string' || localPath.includes('\0')) {
      throw connectionContextError('DATABASE_MANAGER_LOCAL_RESOURCE_REQUIRED', 'Choose the local database file before using this profile.');
    }
    endpoint.path = localPath;
    delete endpoint.localResourceRequired;
  }
  const credentials = {};
  try {
    for (const binding of profile.credentialSecretRefs || []) {
      credentials[binding.slotId] = await secretStore.resolve({ workspaceId, id: binding.secretRefId });
    }
  } catch {
    clearRuntimeCredentials({ credentials });
    await Promise.resolve(tunnel?.close?.()).catch(() => {});
    throw connectionContextError('DATABASE_MANAGER_CREDENTIAL_RESOLUTION_FAILED', 'The saved database credential could not be resolved on this device.');
  }
  const connection = {
    profileId: profile.id,
    driverId: profile.driverId,
    endpoint,
    database: profile.database,
    defaultSchema: profile.defaultSchema,
    accessMode: profile.accessMode,
    ssl: profile.ssl,
    settings: profile.settings,
    credentials
  };
  if (tunnel) Object.defineProperty(connection, RUNTIME_TUNNEL, { value: tunnel, writable: true, enumerable: false });
  return connection;
}

function clearRuntimeCredentials(connection) {
  if (!connection?.credentials || typeof connection.credentials !== 'object') return;
  for (const key of Object.keys(connection.credentials)) connection.credentials[key] = '';
}

function takeRuntimeTunnel(connection) {
  const tunnel = connection?.[RUNTIME_TUNNEL] || null;
  if (tunnel) connection[RUNTIME_TUNNEL] = null;
  return tunnel;
}

async function releaseRuntimeConnection(connection) {
  clearRuntimeCredentials(connection);
  const tunnel = takeRuntimeTunnel(connection);
  await Promise.resolve(tunnel?.close?.()).catch(() => {});
}

module.exports = {
  clearRuntimeCredentials,
  connectionContextError,
  releaseRuntimeConnection,
  takeRuntimeTunnel,
  resolveRuntimeConnection
};
