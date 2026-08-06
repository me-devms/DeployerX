const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const PLUGIN_HEALTH_SCHEMA_VERSION = 1;
const MAX_PLUGIN_HEALTH_RECORDS = 200;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

function pluginId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!PLUGIN_ID_PATTERN.test(id)) throw new TypeError('Database plugin ID is invalid.');
  return id;
}

function safeCode(value, fallback = null) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9_]{1,120}$/.test(code) ? code : fallback;
}

function safeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, maximum) : 0;
}

function normalizedRecord(input = {}) {
  const status = String(input.status || 'unknown').toLowerCase();
  if (!['unknown', 'ready', 'warning', 'crashed', 'disabled'].includes(status)) throw new TypeError('Database plugin health status is invalid.');
  return Object.freeze({
    pluginId: pluginId(input.pluginId),
    status,
    lastEvent: String(input.lastEvent || 'unknown').slice(0, 80),
    lastEventAt: input.lastEventAt ? String(input.lastEventAt).slice(0, 100) : null,
    lastCheckedAt: input.lastCheckedAt ? String(input.lastCheckedAt).slice(0, 100) : null,
    lastReadyAt: input.lastReadyAt ? String(input.lastReadyAt).slice(0, 100) : null,
    crashCount: safeInteger(input.crashCount, 1000000),
    stderrEventCount: safeInteger(input.stderrEventCount, 1000000),
    protocolErrorCount: safeInteger(input.protocolErrorCount, 1000000),
    lastExitCode: Number.isInteger(input.lastExitCode) ? input.lastExitCode : null,
    lastSignal: input.lastSignal ? String(input.lastSignal).slice(0, 40) : null,
    lastErrorCode: safeCode(input.lastErrorCode)
  });
}

async function writeJsonAtomically(fileSystem, targetPath, value) {
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fileSystem.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await fileSystem.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

class DatabasePluginHealthStore {
  constructor({ rootPath, fileSystem = fs, clock = () => new Date().toISOString() } = {}) {
    if (!rootPath) throw new TypeError('Database plugin health root path is required.');
    this.rootPath = path.resolve(String(rootPath));
    this.statePath = path.join(this.rootPath, 'health.json');
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.records = new Map();
    this.initialized = false;
    this.queue = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return;
    await this.fileSystem.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await this.fileSystem.readFile(this.statePath, 'utf8'));
      if (raw?.schemaVersion !== PLUGIN_HEALTH_SCHEMA_VERSION || !Array.isArray(raw.plugins) || raw.plugins.length > MAX_PLUGIN_HEALTH_RECORDS) {
        throw new TypeError('Database plugin health state is invalid.');
      }
      this.records = new Map(raw.plugins.map((item) => {
        const record = normalizedRecord(item);
        return [record.pluginId, record];
      }));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async get(pluginIdValue) {
    await this.initialize();
    return this.records.get(pluginId(pluginIdValue)) || null;
  }

  async list() {
    await this.initialize();
    return Object.freeze([...this.records.values()].map((record) => Object.freeze({ ...record })));
  }

  recordDiagnostic(pluginIdValue, eventValue, details = {}) {
    return this.#mutate(pluginIdValue, (current) => {
      const event = String(eventValue || 'unknown').toLowerCase().slice(0, 80);
      const now = this.clock();
      const next = { ...current, status: current.status, lastEvent: event, lastEventAt: now };
      if (event === 'spawn' || event === 'registered') next.status = current.status === 'ready' ? 'ready' : 'unknown';
      if (event === 'stderr') {
        next.status = current.status === 'crashed' ? 'crashed' : 'warning';
        next.stderrEventCount = current.stderrEventCount + 1;
      }
      if (event === 'protocol-error') {
        next.status = 'warning';
        next.protocolErrorCount = current.protocolErrorCount + 1;
        next.lastErrorCode = 'DATABASE_MANAGER_DRIVER_PROTOCOL_ERROR';
      }
      if (event === 'exit') {
        next.status = 'crashed';
        next.crashCount = current.crashCount + 1;
        next.lastExitCode = Number.isInteger(details?.exitCode) ? details.exitCode : null;
        next.lastSignal = details?.signal ? String(details.signal).slice(0, 40) : null;
        next.lastErrorCode = 'DATABASE_MANAGER_DRIVER_HOST_EXITED';
      }
      return next;
    });
  }

  recordHealth(pluginIdValue, { ok, errorCode = null } = {}) {
    return this.#mutate(pluginIdValue, (current) => {
      const now = this.clock();
      return {
        ...current,
        status: ok ? 'ready' : 'warning',
        lastEvent: ok ? 'health-ready' : 'health-failed',
        lastEventAt: now,
        lastCheckedAt: now,
        lastReadyAt: ok ? now : current.lastReadyAt,
        lastErrorCode: ok ? null : safeCode(errorCode, 'DATABASE_MANAGER_PLUGIN_HEALTH_FAILED')
      };
    });
  }

  setDisabled(pluginIdValue) {
    return this.#mutate(pluginIdValue, (current) => ({ ...current, status: 'disabled', lastEvent: 'disabled', lastEventAt: this.clock() }));
  }

  async remove(pluginIdValue) {
    const id = pluginId(pluginIdValue);
    return this.#enqueue(async () => {
      await this.initialize();
      const removed = this.records.delete(id);
      if (removed) await this.#persist();
      return removed;
    });
  }

  #mutate(pluginIdValue, updater) {
    const id = pluginId(pluginIdValue);
    return this.#enqueue(async () => {
      await this.initialize();
      const current = this.records.get(id) || normalizedRecord({ pluginId: id });
      const next = normalizedRecord(updater(current));
      if (!this.records.has(id) && this.records.size >= MAX_PLUGIN_HEALTH_RECORDS) throw new Error('Database plugin health state is full.');
      this.records.set(id, next);
      await this.#persist();
      return next;
    });
  }

  #persist() {
    return writeJsonAtomically(this.fileSystem, this.statePath, { schemaVersion: PLUGIN_HEALTH_SCHEMA_VERSION, plugins: [...this.records.values()] });
  }

  #enqueue(operation) {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
}

module.exports = { DatabasePluginHealthStore, MAX_PLUGIN_HEALTH_RECORDS, PLUGIN_HEALTH_SCHEMA_VERSION, normalizedRecord, safeCode };
