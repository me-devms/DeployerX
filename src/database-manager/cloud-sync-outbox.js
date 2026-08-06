const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { cloudProfileDocument, normalizeCloudProfileDocument } = require('./cloud-metadata');

const CLOUD_SYNC_OUTBOX_SCHEMA_VERSION = 3;
const MAX_OUTBOX_OPERATIONS = 1000;

function requiredText(value, label, maximum = 200) {
  const result = String(value ?? '').trim();
  if (!result || result.length > maximum || result.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return result;
}

function safeErrorCode(error) {
  const value = String(error?.code || 'DATABASE_MANAGER_CLOUD_SYNC_FAILED').toUpperCase();
  return /^[A-Z0-9_]{1,120}$/.test(value) ? value : 'DATABASE_MANAGER_CLOUD_SYNC_FAILED';
}

function expectedRevision(value) {
  if (value === null || value === undefined || value === '') return null;
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Database cloud sync expected revision is invalid.');
  return revision;
}

function normalizeOperation(input = {}, { allowLegacyCloudMetadata = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Database cloud sync operation is invalid.');
  const workspaceId = requiredText(input.workspaceId, 'Workspace ID');
  const profileId = requiredText(input.profileId, 'Database profile ID');
  const type = String(input.type || '').toLowerCase();
  if (!['upsert', 'delete'].includes(type)) throw new TypeError('Database cloud sync operation type is invalid.');
  const document = type === 'upsert' ? normalizeCloudProfileDocument(input.document, { allowLegacyLocalFields: allowLegacyCloudMetadata }) : null;
  if (document && document.profileId !== profileId) throw new TypeError('Database cloud sync profile identity does not match its document.');
  return Object.freeze({
    id: `${workspaceId}:${profileId}`,
    workspaceId,
    profileId,
    type,
    document,
    expectedRevision: expectedRevision(input.expectedRevision),
    enqueuedAt: String(input.enqueuedAt || ''),
    updatedAt: String(input.updatedAt || ''),
    attempts: Math.max(0, Math.min(1000000, Number(input.attempts) || 0)),
    lastAttemptAt: input.lastAttemptAt ? String(input.lastAttemptAt) : null,
    lastErrorCode: input.lastErrorCode ? safeErrorCode({ code: input.lastErrorCode }) : null
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

class DatabaseCloudSyncOutbox {
  constructor({ rootPath, fileSystem = fs, clock = () => new Date().toISOString() } = {}) {
    if (!rootPath) throw new TypeError('Database cloud sync outbox root path is required.');
    this.rootPath = path.resolve(String(rootPath));
    this.statePath = path.join(this.rootPath, 'cloud-profile-outbox.json');
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.operations = new Map();
    this.initialized = false;
    this.queue = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return;
    await this.fileSystem.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    let migrated = false;
    try {
      const raw = JSON.parse(await this.fileSystem.readFile(this.statePath, 'utf8'));
      if (![1, 2, CLOUD_SYNC_OUTBOX_SCHEMA_VERSION].includes(raw?.schemaVersion) || !Array.isArray(raw.operations) || raw.operations.length > MAX_OUTBOX_OPERATIONS) {
        throw new TypeError('Database cloud sync outbox state is invalid.');
      }
      this.operations = new Map(raw.operations.map((operation) => {
        const normalized = normalizeOperation(operation, { allowLegacyCloudMetadata: raw.schemaVersion < CLOUD_SYNC_OUTBOX_SCHEMA_VERSION });
        return [normalized.id, normalized];
      }));
      migrated = raw.schemaVersion < CLOUD_SYNC_OUTBOX_SCHEMA_VERSION;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.initialized = true;
    if (migrated) await this.#persist();
  }

  async enqueueUpsert(workspaceId, profile, { expectedRevision: baseRevision = null } = {}) {
    return this.#enqueueMutation(async () => {
      const document = cloudProfileDocument(profile);
      return this.#put({ workspaceId, profileId: document.profileId, type: 'upsert', document, expectedRevision: baseRevision });
    });
  }

  async enqueueDelete(workspaceId, profileId, { expectedRevision: baseRevision = null } = {}) {
    return this.#enqueueMutation(() => this.#put({ workspaceId, profileId, type: 'delete', document: null, expectedRevision: baseRevision }));
  }

  async rebase(workspaceId, profileId, baseRevision) {
    return this.#enqueueMutation(async () => {
      await this.initialize();
      const key = `${requiredText(workspaceId, 'Workspace ID')}:${requiredText(profileId, 'Database profile ID')}`;
      const operation = this.operations.get(key);
      if (!operation) throw Object.assign(new Error('The database cloud sync operation was not found.'), { code: 'DATABASE_MANAGER_CLOUD_SYNC_OPERATION_NOT_FOUND' });
      return this.#put({ ...operation, expectedRevision: expectedRevision(baseRevision), replaceExpectedRevision: true });
    });
  }

  async discard(workspaceId, profileId) {
    return this.#enqueueMutation(async () => {
      await this.initialize();
      const key = `${requiredText(workspaceId, 'Workspace ID')}:${requiredText(profileId, 'Database profile ID')}`;
      const removed = this.operations.delete(key);
      if (removed) await this.#persist();
      return Object.freeze({ profileId: requiredText(profileId, 'Database profile ID'), removed });
    });
  }

  async getOperation(workspaceId, profileId) {
    await this.initialize();
    const operation = this.operations.get(`${requiredText(workspaceId, 'Workspace ID')}:${requiredText(profileId, 'Database profile ID')}`);
    return operation ? structuredClone(operation) : null;
  }

  async flush(workspaceId, executor, { limit = 100 } = {}) {
    if (typeof executor !== 'function') throw new TypeError('Database cloud sync executor is required.');
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const maximum = Math.max(1, Math.min(100, Number(limit) || 100));
    return this.#enqueueMutation(async () => {
      const candidates = [...this.operations.values()]
        .filter((operation) => operation.workspaceId === tenant && operation.lastErrorCode !== 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT')
        .slice(0, maximum);
      let succeeded = 0;
      const failed = [];
      for (const operation of candidates) {
        try {
          await executor(structuredClone(operation));
          this.operations.delete(operation.id);
          succeeded += 1;
        } catch (error) {
          const failedOperation = normalizeOperation({
            ...operation,
            attempts: operation.attempts + 1,
            lastAttemptAt: this.clock(),
            lastErrorCode: safeErrorCode(error)
          });
          this.operations.set(operation.id, failedOperation);
          failed.push(Object.freeze({ profileId: operation.profileId, type: operation.type, code: failedOperation.lastErrorCode }));
        }
        await this.#persist();
      }
      return Object.freeze({ attempted: candidates.length, succeeded, failed: Object.freeze(failed), pending: this.#pendingForWorkspace(tenant) });
    });
  }

  async listPending(workspaceId) {
    await this.initialize();
    const tenant = requiredText(workspaceId, 'Workspace ID');
    return Object.freeze([...this.operations.values()].filter((operation) => operation.workspaceId === tenant).map((operation) => Object.freeze({
      profileId: operation.profileId,
      type: operation.type,
      expectedRevision: operation.expectedRevision,
      attempts: operation.attempts,
      lastAttemptAt: operation.lastAttemptAt,
      lastErrorCode: operation.lastErrorCode
    })));
  }

  async #put(input) {
    await this.initialize();
    const now = this.clock();
    const key = `${requiredText(input.workspaceId, 'Workspace ID')}:${requiredText(input.profileId, 'Database profile ID')}`;
    const previous = this.operations.get(key);
    const baseRevision = previous && input.replaceExpectedRevision !== true ? previous.expectedRevision : expectedRevision(input.expectedRevision);
    const document = input.type === 'upsert' && baseRevision !== null
      ? normalizeCloudProfileDocument({ ...input.document, revision: baseRevision + 1 })
      : input.document;
    const operation = normalizeOperation({
      ...input,
      document,
      expectedRevision: baseRevision,
      enqueuedAt: previous?.enqueuedAt || now,
      updatedAt: now,
      attempts: 0,
      lastAttemptAt: null,
      lastErrorCode: null
    });
    if (!previous && this.operations.size >= MAX_OUTBOX_OPERATIONS) throw Object.assign(new Error('The database cloud sync queue is full.'), { code: 'DATABASE_MANAGER_CLOUD_SYNC_QUEUE_FULL' });
    this.operations.set(operation.id, operation);
    await this.#persist();
    return operation;
  }

  #pendingForWorkspace(workspaceId) {
    return [...this.operations.values()].filter((operation) => operation.workspaceId === workspaceId).length;
  }

  #persist() {
    return writeJsonAtomically(this.fileSystem, this.statePath, {
      schemaVersion: CLOUD_SYNC_OUTBOX_SCHEMA_VERSION,
      operations: [...this.operations.values()]
    });
  }

  #enqueueMutation(operation) {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
}

module.exports = { CLOUD_SYNC_OUTBOX_SCHEMA_VERSION, DatabaseCloudSyncOutbox, MAX_OUTBOX_OPERATIONS, normalizeOperation, safeErrorCode };
