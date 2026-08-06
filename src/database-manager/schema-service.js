const { releaseRuntimeConnection, resolveRuntimeConnection } = require('./connection-context');
const { normalizeSchemaSnapshot, normalizeSchemaSnapshotRequest } = require('./domain');

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function schemaOperationKey(workspaceId, actorId, requestId) {
  return JSON.stringify([workspaceId, actorId, requestId]);
}

class DatabaseSchemaService {
  constructor({ profileService, secretStore, runtimeRegistry, connectionService = null, localResourceResolver = null, tunnelProvider = null, clock = () => new Date().toISOString() } = {}) {
    if (!profileService?.get) throw new TypeError('DatabaseSchemaService requires the profile service.');
    if (!secretStore?.resolve) throw new TypeError('DatabaseSchemaService requires the shared secret store.');
    if (!runtimeRegistry?.get) throw new TypeError('DatabaseSchemaService requires a driver runtime registry.');
    if (localResourceResolver !== null && typeof localResourceResolver !== 'function') throw new TypeError('Database schema local resource resolver is invalid.');
    if (connectionService !== null && typeof connectionService.acquire !== 'function') throw new TypeError('Database schema connection service is invalid.');
    if (tunnelProvider !== null && typeof tunnelProvider?.open !== 'function') throw new TypeError('Database schema tunnel provider is invalid.');
    this.profileService = profileService;
    this.secretStore = secretStore;
    this.runtimeRegistry = runtimeRegistry;
    this.connectionService = connectionService;
    this.localResourceResolver = localResourceResolver;
    this.tunnelProvider = tunnelProvider;
    this.clock = clock;
    this.active = new Map();
  }

  async load(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const request = normalizeSchemaSnapshotRequest(input);
    const profile = await this.profileService.get(tenant, request.profileId);
    if (!profile) throw Object.assign(new Error('Database profile was not found.'), { code: 'DATABASE_MANAGER_PROFILE_NOT_FOUND', category: 'database-manager' });
    const key = schemaOperationKey(tenant, actor, request.requestId);
    if (this.active.has(key)) throw Object.assign(new Error('A schema request with this ID is already running.'), { code: 'DATABASE_MANAGER_SCHEMA_ALREADY_RUNNING', category: 'database-manager' });
    const controller = new AbortController();
    this.active.set(key, controller);
    let connection = null;
    let openSession = null;
    try {
      openSession = await this.connectionService?.acquire(tenant, actor, profile);
      const runtime = openSession?.runtime || this.runtimeRegistry.get(profile.driverId);
      if (!openSession?.runtimeSessionId || typeof runtime.discoverSessionSchema !== 'function') {
        connection = await resolveRuntimeConnection({ workspaceId: tenant, profile, secretStore: this.secretStore, localResourceResolver: this.localResourceResolver, tunnelProvider: this.tunnelProvider, signal: controller.signal });
      }
      const raw = openSession?.runtimeSessionId && typeof runtime.discoverSessionSchema === 'function'
        ? await runtime.discoverSessionSchema(openSession.runtimeSessionId, request, { timeoutMs: profile.queryTimeoutMs || 60000, signal: controller.signal })
        : await runtime.discoverSchema(connection, request, { timeoutMs: profile.queryTimeoutMs || 60000, signal: controller.signal });
      return Object.freeze({
        requestId: request.requestId,
        profileId: profile.id,
        driverId: profile.driverId,
        loadedAt: this.clock(),
        snapshot: normalizeSchemaSnapshot(raw)
      });
    } finally {
      await releaseRuntimeConnection(connection);
      await Promise.resolve(openSession?.release?.());
      this.active.delete(key);
    }
  }

  cancel(workspaceId, actorId, requestId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const id = requiredText(requestId, 'Database schema request ID');
    const controller = this.active.get(schemaOperationKey(tenant, actor, id));
    if (controller) controller.abort();
    return Object.freeze({ requestId: id, cancelled: Boolean(controller) });
  }

  closeAll() {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }
}

module.exports = {
  DatabaseSchemaService,
  schemaOperationKey
};
