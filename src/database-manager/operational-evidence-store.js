const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BUILT_IN_PRINCIPAL_ACTIONS } = require('./principal-administration');
const { BUILT_IN_SCHEMA_ACTIONS } = require('./schema-administration');

const OPERATIONAL_EVIDENCE_SCHEMA_VERSION = 1;
const MAX_OPERATIONAL_EVIDENCE_RECORDS = 5000;
const CONNECTION_OPERATIONS = new Set(['test', 'open', 'close', 'expire', 'driver-reload', 'driver-disable', 'driver-remove']);
const CONNECTION_STATES = new Set(['tested', 'ready', 'closed', 'failed']);
const SCHEMA_OPERATIONS = new Set([
  ...Object.values(BUILT_IN_SCHEMA_ACTIONS).flat(),
  ...Object.values(BUILT_IN_PRINCIPAL_ACTIONS).flat()
]);
const SCHEMA_STATES = new Set(['changed', 'failed', 'cancelled']);

function requiredId(value, label) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
}

function safeCode(value) {
  if (value === null || value === undefined || value === '') return null;
  const code = String(value).trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,120}$/.test(code)) throw new TypeError('Database operational evidence code is invalid.');
  return code;
}

function safeTime(value) {
  const text = String(value || '');
  if (!Number.isFinite(Date.parse(text))) throw new TypeError('Database operational evidence timestamp is invalid.');
  return new Date(text).toISOString();
}

function normalizeEvidenceRecord(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Database operational evidence is invalid.');
  const category = String(input.category || '').toLowerCase();
  const operations = category === 'connection' ? CONNECTION_OPERATIONS : category === 'schema' ? SCHEMA_OPERATIONS : null;
  const states = category === 'connection' ? CONNECTION_STATES : category === 'schema' ? SCHEMA_STATES : null;
  if (!operations || !states) throw new TypeError('Database operational evidence category is invalid.');
  const operation = String(input.operation || '').toLowerCase();
  const state = String(input.state || '').toLowerCase();
  if (!operations.has(operation)) throw new TypeError('Database operational evidence operation is invalid.');
  if (!states.has(state)) throw new TypeError('Database operational evidence state is invalid.');
  return Object.freeze({
    id: requiredId(input.id || `evidence_${crypto.randomUUID()}`, 'Database operational evidence ID'),
    workspaceId: requiredId(input.workspaceId, 'Workspace ID'),
    profileId: requiredId(input.profileId, 'Database profile ID'),
    category,
    operation,
    state,
    code: safeCode(input.code),
    occurredAt: safeTime(input.occurredAt || options.now || new Date().toISOString())
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

class DatabaseOperationalEvidenceStore {
  constructor({ rootPath, fileSystem = fs, clock = () => new Date().toISOString(), maxRecords = MAX_OPERATIONAL_EVIDENCE_RECORDS } = {}) {
    if (!rootPath) throw new TypeError('Database operational evidence root path is required.');
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_OPERATIONAL_EVIDENCE_RECORDS) throw new TypeError('Database operational evidence limit is invalid.');
    this.rootPath = path.resolve(String(rootPath));
    this.statePath = path.join(this.rootPath, 'operational-evidence.json');
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.maxRecords = maxRecords;
    this.records = [];
    this.initialized = false;
    this.queue = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return;
    await this.fileSystem.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await this.fileSystem.readFile(this.statePath, 'utf8'));
      if (raw?.schemaVersion !== OPERATIONAL_EVIDENCE_SCHEMA_VERSION || !Array.isArray(raw.records) || raw.records.length > MAX_OPERATIONAL_EVIDENCE_RECORDS) {
        throw new TypeError('Database operational evidence state is invalid.');
      }
      const ids = new Set();
      this.records = raw.records.map((record) => {
        const normalized = normalizeEvidenceRecord(record);
        if (ids.has(normalized.id)) throw new TypeError('Database operational evidence IDs must be unique.');
        ids.add(normalized.id);
        return normalized;
      }).slice(-this.maxRecords);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  append(workspaceId, input = {}) {
    return this.#enqueue(async () => {
      await this.initialize();
      const record = normalizeEvidenceRecord({ ...input, workspaceId }, { now: this.clock() });
      this.records.push(record);
      if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
      await this.#persist();
      return Object.freeze({ ...record });
    });
  }

  async list(workspaceId, input = {}) {
    await this.initialize();
    const tenant = requiredId(workspaceId, 'Workspace ID');
    const profileId = input.profileId ? requiredId(input.profileId, 'Database profile ID') : null;
    const limit = Math.min(Math.max(Number(input.limit) || 500, 1), 500);
    return Object.freeze(this.records
      .filter((record) => record.workspaceId === tenant && (!profileId || record.profileId === profileId))
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map((record) => Object.freeze({ ...record })));
  }

  #persist() {
    return writeJsonAtomically(this.fileSystem, this.statePath, { schemaVersion: OPERATIONAL_EVIDENCE_SCHEMA_VERSION, records: this.records });
  }

  #enqueue(operation) {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
}

module.exports = {
  CONNECTION_OPERATIONS,
  MAX_OPERATIONAL_EVIDENCE_RECORDS,
  OPERATIONAL_EVIDENCE_SCHEMA_VERSION,
  SCHEMA_OPERATIONS,
  DatabaseOperationalEvidenceStore,
  normalizeEvidenceRecord
};
