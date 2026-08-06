const crypto = require('node:crypto');
const { releaseRuntimeConnection, resolveRuntimeConnection, takeRuntimeTunnel } = require('./connection-context');

const DEFAULT_CONNECTION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OPEN_CONNECTIONS = 32;

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function serviceError(code, safeMessage, options = {}) {
  return Object.assign(new Error(safeMessage), {
    code,
    safeMessage,
    category: options.category || 'database-manager',
    retryable: Boolean(options.retryable),
    details: options.details || {}
  });
}

function normalizeConnectionTestResult(input, profileId, driverId, measuredLatencyMs) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw serviceError('DATABASE_MANAGER_DRIVER_RESPONSE_INVALID', 'The database driver returned an invalid connection-test result.', { category: 'driver-runtime' });
  }
  const status = String(input.status || '').toLowerCase();
  if (!['success', 'failure'].includes(status)) {
    throw serviceError('DATABASE_MANAGER_DRIVER_RESPONSE_INVALID', 'The database driver returned an invalid connection-test status.', { category: 'driver-runtime' });
  }
  const latencyMs = Number(input.latencyMs ?? measuredLatencyMs);
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 30 * 60 * 1000) {
    throw serviceError('DATABASE_MANAGER_DRIVER_RESPONSE_INVALID', 'The database driver returned an invalid connection-test duration.', { category: 'driver-runtime' });
  }
  const result = {
    profileId,
    driverId,
    status,
    latencyMs,
    serverVersion: input.serverVersion === null || input.serverVersion === undefined ? null : String(input.serverVersion).slice(0, 200),
    database: input.database === null || input.database === undefined ? null : String(input.database).slice(0, 512),
    readOnly: Boolean(input.readOnly),
    checkedAt: new Date().toISOString()
  };
  if (status === 'failure') {
    result.error = {
      code: String(input.error?.code || 'DATABASE_MANAGER_CONNECTION_FAILED').slice(0, 120),
      safeMessage: String(input.error?.safeMessage || 'The database connection failed.').slice(0, 1000),
      retryable: Boolean(input.error?.retryable)
    };
  }
  return Object.freeze(result);
}

function sessionKey(workspaceId, actorId, profileId) {
  return JSON.stringify([workspaceId, actorId, profileId]);
}

function normalizeSessionResult(session, state = 'ready') {
  if (!session) return Object.freeze({ state: 'closed', sessionId: null, profileId: null, driverId: null, connectionMode: null, openedAt: null, lastUsedAt: null, expiresAt: null });
  return Object.freeze({
    state,
    sessionId: session.id,
    profileId: session.profileId,
    driverId: session.driverId,
    connectionMode: session.connectionMode,
    openedAt: new Date(session.openedAtMs).toISOString(),
    lastUsedAt: new Date(session.lastUsedAtMs).toISOString(),
    expiresAt: new Date(session.lastUsedAtMs + session.idleTimeoutMs).toISOString()
  });
}

function safeStatusCode(value, fallback = 'DATABASE_MANAGER_CONNECTION_HEALTH_FAILED') {
  const code = String(value || '').slice(0, 120);
  return /^[A-Za-z0-9_.-]+$/.test(code) ? code : fallback;
}

function failedSessionResult(session, code) {
  return Object.freeze({
    ...normalizeSessionResult(session, 'failed'),
    sessionId: null,
    expiresAt: null,
    code: safeStatusCode(code)
  });
}

class DatabaseConnectionService {
  constructor({ profileService, secretStore, runtimeRegistry, localResourceResolver = null, tunnelProvider = null, clock = () => Date.now(), idleTimeoutMs = DEFAULT_CONNECTION_IDLE_TIMEOUT_MS, maxOpenConnections = DEFAULT_MAX_OPEN_CONNECTIONS } = {}) {
    if (!profileService?.get) throw new TypeError('DatabaseConnectionService requires the profile service.');
    if (!secretStore?.resolve) throw new TypeError('DatabaseConnectionService requires the shared secret store.');
    if (!runtimeRegistry?.get) throw new TypeError('DatabaseConnectionService requires a driver runtime registry.');
    if (localResourceResolver !== null && typeof localResourceResolver !== 'function') throw new TypeError('Database local resource resolver is invalid.');
    if (tunnelProvider !== null && typeof tunnelProvider?.open !== 'function') throw new TypeError('Database tunnel provider is invalid.');
    this.profileService = profileService;
    this.secretStore = secretStore;
    this.runtimeRegistry = runtimeRegistry;
    this.localResourceResolver = localResourceResolver;
    this.tunnelProvider = tunnelProvider;
    this.clock = clock;
    this.idleTimeoutMs = Number(idleTimeoutMs);
    this.maxOpenConnections = Number(maxOpenConnections);
    if (!Number.isInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 1000 || this.idleTimeoutMs > 24 * 60 * 60 * 1000) throw new TypeError('Database connection idle timeout is invalid.');
    if (!Number.isInteger(this.maxOpenConnections) || this.maxOpenConnections < 1 || this.maxOpenConnections > 1000) throw new TypeError('Database connection limit is invalid.');
    this.sessions = new Map();
  }

  async test(workspaceId, actorId, profileId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const id = requiredText(profileId, 'Database profile ID');
    const profile = await this.profileService.get(tenant, id);
    if (!profile) throw serviceError('DATABASE_MANAGER_PROFILE_NOT_FOUND', 'Database profile was not found.');
    const runtime = this.runtimeRegistry.get(profile.driverId);
    const connection = await resolveRuntimeConnection({ workspaceId: tenant, profile, secretStore: this.secretStore, localResourceResolver: this.localResourceResolver, tunnelProvider: this.tunnelProvider, signal: options.signal });
    const startedAt = this.clock();
    try {
      const raw = await runtime.testConnection(connection, {
        timeoutMs: Math.min(profile.queryTimeoutMs || 60000, Number(options.timeoutMs) || profile.queryTimeoutMs || 60000),
        signal: options.signal
      });
      const result = normalizeConnectionTestResult(raw, profile.id, profile.driverId, Math.max(0, this.clock() - startedAt));
      if (result.status === 'success' && this.secretStore.markValidated) {
        await Promise.all((profile.credentialSecretRefs || []).map((item) => this.secretStore.markValidated({ workspaceId: tenant, id: item.secretRefId, actorId: actor })));
      }
      return result;
    } finally {
      await releaseRuntimeConnection(connection);
    }
  }

  async open(workspaceId, actorId, profileId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const id = requiredText(profileId, 'Database profile ID');
    await this.#pruneExpired();
    const profile = await this.profileService.get(tenant, id);
    if (!profile) throw serviceError('DATABASE_MANAGER_PROFILE_NOT_FOUND', 'Database profile was not found.');
    const key = sessionKey(tenant, actor, id);
    if (this.sessions.has(key)) await this.#closeRecord(key, this.sessions.get(key));
    if (this.sessions.size >= this.maxOpenConnections) {
      throw serviceError('DATABASE_MANAGER_CONNECTION_LIMIT_REACHED', 'Too many database connections are open. Close one and try again.');
    }
    const runtime = this.runtimeRegistry.get(profile.driverId);
    const connection = await resolveRuntimeConnection({ workspaceId: tenant, profile, secretStore: this.secretStore, localResourceResolver: this.localResourceResolver, tunnelProvider: this.tunnelProvider, signal: options.signal });
    const startedAt = this.clock();
    try {
      const raw = typeof runtime.openConnection === 'function'
        ? await runtime.openConnection(connection, { timeoutMs: Math.min(profile.queryTimeoutMs || 60000, Number(options.timeoutMs) || profile.queryTimeoutMs || 60000), signal: options.signal })
        : { status: 'success', connectionMode: 'operation-scoped', evidence: await runtime.testConnection(connection, { timeoutMs: profile.queryTimeoutMs || 60000, signal: options.signal }) };
      const evidence = normalizeConnectionTestResult(raw.evidence || raw, profile.id, profile.driverId, Math.max(0, this.clock() - startedAt));
      if (evidence.status !== 'success') {
        if (raw.runtimeSessionId && typeof runtime.closeConnection === 'function') await runtime.closeConnection(raw.runtimeSessionId).catch(() => {});
        return Object.freeze({ ...evidence, state: 'failed', sessionId: null, connectionMode: raw.connectionMode || 'operation-scoped' });
      }
      const now = this.clock();
      const session = {
        id: `dbconn_${crypto.randomUUID()}`,
        workspaceId: tenant,
        actorId: actor,
        profileId: profile.id,
        profileRevision: Number(profile.revision || 0),
        driverId: profile.driverId,
        runtime,
        runtimeSessionId: raw.runtimeSessionId || null,
        connectionMode: ['physical-pool', 'logical'].includes(raw.connectionMode) ? raw.connectionMode : 'operation-scoped',
        openedAtMs: now,
        lastUsedAtMs: now,
        idleTimeoutMs: this.idleTimeoutMs,
        activeOperations: 0
      };
      if (raw.runtimeSessionId) session.tunnel = takeRuntimeTunnel(connection);
      this.sessions.set(key, session);
      if (this.secretStore.markValidated) {
        await Promise.all((profile.credentialSecretRefs || []).map((item) => this.secretStore.markValidated({ workspaceId: tenant, id: item.secretRefId, actorId: actor })));
      }
      return Object.freeze({ ...normalizeSessionResult(session), evidence });
    } finally {
      await releaseRuntimeConnection(connection);
    }
  }

  async status(workspaceId, actorId, profileId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const id = requiredText(profileId, 'Database profile ID');
    await this.#pruneExpired();
    const key = sessionKey(tenant, actor, id);
    const session = this.sessions.get(key);
    if (!session) return Object.freeze({ ...normalizeSessionResult(null), profileId: id });
    const profile = await this.profileService.get(tenant, id);
    if (!profile || Number(profile.revision || 0) !== session.profileRevision || profile.driverId !== session.driverId) {
      await this.#closeRecord(key, session);
      return Object.freeze({ ...normalizeSessionResult(null), profileId: id });
    }
    if (session.runtimeSessionId && typeof session.runtime.connectionStatus === 'function') {
      let runtimeStatus;
      try {
        runtimeStatus = await session.runtime.connectionStatus(session.runtimeSessionId);
      } catch (error) {
        await this.#closeRecord(key, session);
        return failedSessionResult(session, error?.code);
      }
      if (runtimeStatus?.status !== 'ready') {
        await this.#closeRecord(key, session);
        if (runtimeStatus?.status === 'failed') return failedSessionResult(session, runtimeStatus.code);
        return Object.freeze({ ...normalizeSessionResult(null), profileId: id });
      }
    }
    return normalizeSessionResult(session);
  }

  async listStatus(workspaceId, actorId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    await this.#pruneExpired();
    const sessions = [...this.sessions.values()]
      .filter((session) => session.workspaceId === tenant && session.actorId === actor);
    return Object.freeze(await Promise.all(sessions.map((session) => this.status(tenant, actor, session.profileId))));
  }

  async close(workspaceId, actorId, profileId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const id = requiredText(profileId, 'Database profile ID');
    const key = sessionKey(tenant, actor, id);
    const session = this.sessions.get(key);
    if (session) await this.#closeRecord(key, session);
    return Object.freeze({ state: 'closed', sessionId: session?.id || null, profileId: id, driverId: session?.driverId || null, connectionMode: session?.connectionMode || null, closed: Boolean(session) });
  }

  async acquire(workspaceId, actorId, profile) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    if (!profile?.id) return null;
    await this.#pruneExpired();
    const key = sessionKey(tenant, actor, profile.id);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (Number(profile.revision || 0) !== session.profileRevision || profile.driverId !== session.driverId) {
      await this.#closeRecord(key, session);
      return null;
    }
    session.lastUsedAtMs = this.clock();
    session.activeOperations += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      session.activeOperations = Math.max(0, session.activeOperations - 1);
      if (this.sessions.get(key) === session) session.lastUsedAtMs = this.clock();
    };
    return Object.freeze({ runtime: session.runtime, runtimeSessionId: session.runtimeSessionId, connectionMode: session.connectionMode, release });
  }

  async closeProfile(workspaceId, profileId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const id = requiredText(profileId, 'Database profile ID');
    const matches = [...this.sessions.entries()].filter(([, session]) => session.workspaceId === tenant && session.profileId === id);
    await Promise.all(matches.map(([key, session]) => this.#closeRecord(key, session)));
  }

  async closeDriver(driverId) {
    const id = requiredText(driverId, 'Database driver ID');
    const matches = [...this.sessions.entries()].filter(([, session]) => session.driverId === id);
    await Promise.all(matches.map(([key, session]) => this.#closeRecord(key, session)));
    return Object.freeze(matches.map(([, session]) => Object.freeze({ workspaceId: session.workspaceId, profileId: session.profileId })));
  }

  async closeAll() {
    await Promise.all([...this.sessions.entries()].map(([key, session]) => this.#closeRecord(key, session)));
  }

  async #pruneExpired() {
    const now = this.clock();
    const expired = [...this.sessions.entries()].filter(([, session]) => session.activeOperations === 0 && now - session.lastUsedAtMs >= session.idleTimeoutMs);
    await Promise.all(expired.map(([key, session]) => this.#closeRecord(key, session)));
  }

  async #closeRecord(key, session) {
    if (this.sessions.get(key) !== session) return;
    this.sessions.delete(key);
    if (session.runtimeSessionId && typeof session.runtime.closeConnection === 'function') {
      await session.runtime.closeConnection(session.runtimeSessionId).catch(() => {});
    }
    await Promise.resolve(session.tunnel?.close?.()).catch(() => {});
  }
}

module.exports = {
  DatabaseConnectionService,
  DEFAULT_CONNECTION_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_OPEN_CONNECTIONS,
  normalizeConnectionTestResult,
  failedSessionResult,
  normalizeSessionResult,
  safeStatusCode,
  sessionKey,
  serviceError
};
