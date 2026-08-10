const { Client } = require('ssh2');
const { buildCollectorCommand, executeCollectorCommand, parseCollectorOutput } = require('./linux-collector');

class ServerMonitoringSessionManager {
  constructor({ emit = () => {}, clientFactory = () => new Client(), pollIntervalMs = 2000, processIntervalMs = 5000, storageIntervalMs = 10000 } = {}) {
    this.emit = emit;
    this.clientFactory = clientFactory;
    this.pollIntervalMs = pollIntervalMs;
    this.processIntervalMs = processIntervalMs;
    this.storageIntervalMs = storageIntervalMs;
    this.sessions = new Map();
  }

  start({ sessionId, projectId, connectionConfig, connection = null }) {
    if (!sessionId || !projectId || (!connection && (!connectionConfig?.host || !connectionConfig?.username))) throw new Error('A valid monitoring session and SSH server are required.');
    this.stop(sessionId, { emit: false });
    const state = {
      sessionId,
      projectId,
      connectionConfig,
      connection,
      ownsConnection: !connection,
      timer: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      polling: false,
      paused: false,
      stopped: false,
      staticLoaded: false,
      lastStorageAt: 0,
      lastProcessesAt: 0,
      previousCounters: {},
      lastSample: null
    };
    this.sessions.set(sessionId, state);
    if (connection) {
      this.#emit(state, 'status', { status: 'live' });
      this.#startPolling(state);
    } else this.#connect(state);
    return { sessionId, projectId };
  }

  setPaused(sessionId, paused) {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    state.paused = Boolean(paused);
    clearInterval(state.timer);
    state.timer = null;
    if (state.paused) this.#emit(state, 'status', { status: 'paused' });
    else if (state.connection) {
      this.#emit(state, 'status', { status: 'live' });
      this.#startPolling(state);
    } else this.#connect(state);
    return true;
  }

  stop(sessionId, options = {}) {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    state.stopped = true;
    clearInterval(state.timer);
    clearTimeout(state.reconnectTimer);
    if (state.ownsConnection) state.connection?.end();
    this.sessions.delete(sessionId);
    if (options.emit !== false) this.#emit(state, 'status', { status: 'stopped' });
    return true;
  }

  stopAll() {
    for (const sessionId of [...this.sessions.keys()]) this.stop(sessionId, { emit: false });
  }

  stopByConnection(connection) {
    for (const [sessionId, state] of this.sessions) {
      if (state.connection === connection) this.stop(sessionId);
    }
  }

  #emit(state, type, payload = {}) {
    this.emit({ sessionId: state.sessionId, projectId: state.projectId, type, ...payload });
  }

  #connect(state) {
    if (state.stopped || !this.sessions.has(state.sessionId)) return;
    clearTimeout(state.reconnectTimer);
    this.#emit(state, 'status', { status: state.reconnectAttempt ? 'reconnecting' : 'connecting', attempt: state.reconnectAttempt });
    const connection = this.clientFactory();
    state.connection = connection;
    connection.on('ready', () => {
      if (state.stopped || state.connection !== connection) return connection.end();
      state.reconnectAttempt = 0;
      this.#emit(state, 'status', { status: state.paused ? 'paused' : 'live' });
      if (!state.paused) this.#startPolling(state);
    });
    connection.on('error', (error) => {
      if (!state.stopped && state.connection === connection) this.#emit(state, 'error', { message: error.message || 'The monitoring SSH connection failed.' });
    });
    connection.on('close', () => {
      if (state.stopped || state.connection !== connection) return;
      state.connection = null;
      clearInterval(state.timer);
      state.timer = null;
      this.#scheduleReconnect(state);
    });
    connection.connect(state.connectionConfig);
  }

  #scheduleReconnect(state) {
    if (state.stopped || state.paused || !this.sessions.has(state.sessionId)) return;
    state.reconnectAttempt += 1;
    const delayMs = Math.min(30000, 1000 * (2 ** Math.min(state.reconnectAttempt - 1, 5)));
    this.#emit(state, 'status', { status: 'reconnecting', attempt: state.reconnectAttempt, retryInMs: delayMs });
    state.reconnectTimer = setTimeout(() => this.#connect(state), delayMs);
  }

  #startPolling(state) {
    clearInterval(state.timer);
    this.#poll(state);
    state.timer = setInterval(() => this.#poll(state), this.pollIntervalMs);
  }

  async #poll(state) {
    if (state.stopped || state.paused || state.polling || !state.connection) return;
    state.polling = true;
    const now = Date.now();
    const includeStatic = !state.staticLoaded;
    const includeStorage = !state.lastStorageAt || now - state.lastStorageAt >= this.storageIntervalMs;
    const includeProcesses = !state.lastProcessesAt || now - state.lastProcessesAt >= this.processIntervalMs;
    try {
      const output = await executeCollectorCommand(state.connection, buildCollectorCommand({ includeStatic, includeStorage, includeProcesses }));
      if (state.stopped || !this.sessions.has(state.sessionId)) return;
      const parsed = parseCollectorOutput(output, { previousCounters: state.previousCounters, previousSample: state.lastSample, sampledAt: Date.now() });
      state.previousCounters = parsed.counters;
      state.lastSample = parsed.sample;
      if (includeStatic) state.staticLoaded = true;
      if (includeStorage) state.lastStorageAt = now;
      if (includeProcesses) state.lastProcessesAt = now;
      this.#emit(state, 'sample', { sample: parsed.sample });
    } catch (error) {
      if (!state.stopped) this.#emit(state, 'error', { message: error.message || 'Could not collect server metrics.' });
    } finally {
      state.polling = false;
    }
  }
}

module.exports = { ServerMonitoringSessionManager };
