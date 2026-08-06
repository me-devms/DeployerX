const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const STORE_SCHEMA_VERSION = 1;
const SECRET_SCHEMA_VERSION = 1;
const MAX_SECRET_BYTES = 1024 * 1024;
const ALLOWED_SECRET_TYPES = new Set([
  'password',
  'private-key',
  'token',
  'access-key',
  'encryption-key',
  'certificate'
]);

function nowIso() {
  return new Date().toISOString();
}

function requiredText(value, label, maximumLength = 200) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maximumLength) throw new Error(`${label} is too long.`);
  return normalized;
}

function normalizeExpiry(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Secret expiry is invalid.');
  return date.toISOString();
}

function publicSecretRef(entry) {
  const { ref } = entry;
  return structuredClone(ref);
}

class BackupSecretStore {
  constructor({ rootPath, secureStorage, isReferenced }) {
    this.rootPath = requiredText(rootPath, 'Secret store path', 4096);
    this.storePath = path.join(this.rootPath, 'secrets.json');
    this.secureStorage = secureStorage;
    this.isReferenced = isReferenced;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    this.#assertEncryptionAvailable();
    await fs.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    try {
      await fs.access(this.storePath);
    } catch {
      await this.#writeStore({ schemaVersion: STORE_SCHEMA_VERSION, secrets: [] });
    }
  }

  async list(workspaceId) {
    const normalizedWorkspaceId = requiredText(workspaceId, 'Workspace ID');
    const store = await this.#readStore();
    return store.secrets
      .filter((entry) => entry.ref.workspaceId === normalizedWorkspaceId && !entry.ref.deletedAt)
      .map(publicSecretRef)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async create(input = {}) {
    return this.#withWriteLock(async () => {
      this.#assertEncryptionAvailable();
      const workspaceId = requiredText(input.workspaceId, 'Workspace ID');
      const name = requiredText(input.name, 'Secret name', 120);
      const secretType = requiredText(input.secretType, 'Secret type', 40);
      const value = String(input.value || '');
      const actorId = requiredText(input.actorId || 'system', 'Actor ID');
      if (!ALLOWED_SECRET_TYPES.has(secretType)) throw new Error('Secret type is not supported.');
      if (input.scope && input.scope !== 'device') throw new Error('Only device-bound secrets are supported in this version.');
      if (!value) throw new Error('Secret value is required.');
      if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) throw new Error('Secret value is too large.');

      const store = await this.#readStore();
      const duplicate = store.secrets.some(
        (entry) => entry.ref.workspaceId === workspaceId && !entry.ref.deletedAt && entry.ref.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicate) throw new Error('A secret with this name already exists.');

      const id = `sec_${crypto.randomUUID()}`;
      const createdAt = nowIso();
      const ref = {
        id,
        workspaceId,
        schemaVersion: SECRET_SCHEMA_VERSION,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        createdBy: actorId,
        updatedBy: actorId,
        deletedAt: null,
        labels: {},
        name,
        provider: 'electron-safe-storage',
        scope: 'device',
        providerKey: id,
        secretType,
        version: 1,
        fingerprint: null,
        expiresAt: normalizeExpiry(input.expiresAt),
        lastValidatedAt: null
      };
      const entry = {
        ref,
        versions: [this.#encryptVersion(1, value, createdAt)]
      };
      store.secrets.push(entry);
      await this.#writeStore(store);
      return publicSecretRef(entry);
    });
  }

  async rotate(input = {}) {
    return this.#withWriteLock(async () => {
      this.#assertEncryptionAvailable();
      const workspaceId = requiredText(input.workspaceId, 'Workspace ID');
      const id = requiredText(input.id, 'Secret ID');
      const value = String(input.value || '');
      const actorId = requiredText(input.actorId || 'system', 'Actor ID');
      if (!value) throw new Error('Secret value is required.');
      if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) throw new Error('Secret value is too large.');

      const store = await this.#readStore();
      const entry = this.#findActiveEntry(store, workspaceId, id);
      const updatedAt = nowIso();
      const version = entry.ref.version + 1;
      entry.versions.push(this.#encryptVersion(version, value, updatedAt));
      entry.ref = {
        ...entry.ref,
        revision: entry.ref.revision + 1,
        version,
        updatedAt,
        updatedBy: actorId,
        expiresAt: input.expiresAt === undefined ? entry.ref.expiresAt : normalizeExpiry(input.expiresAt),
        lastValidatedAt: null
      };
      await this.#writeStore(store);
      return publicSecretRef(entry);
    });
  }

  async resolve({ workspaceId, id, version = null, allowExpired = false } = {}) {
    this.#assertEncryptionAvailable();
    const normalizedWorkspaceId = requiredText(workspaceId, 'Workspace ID');
    const normalizedId = requiredText(id, 'Secret ID');
    const store = await this.#readStore();
    const entry = this.#findActiveEntry(store, normalizedWorkspaceId, normalizedId);
    if (!allowExpired && entry.ref.expiresAt && new Date(entry.ref.expiresAt).getTime() <= Date.now()) {
      throw new Error('Secret has expired.');
    }
    const requestedVersion = version === null ? entry.ref.version : Number(version);
    const encryptedVersion = entry.versions.find((item) => item.version === requestedVersion);
    if (!encryptedVersion) throw new Error('Secret version was not found.');
    try {
      return this.secureStorage.decryptString(Buffer.from(encryptedVersion.ciphertext, 'base64'));
    } catch {
      throw new Error('Secret could not be decrypted on this device.');
    }
  }

  async markValidated({ workspaceId, id, actorId = 'system' } = {}) {
    return this.#withWriteLock(async () => {
      const store = await this.#readStore();
      const entry = this.#findActiveEntry(
        store,
        requiredText(workspaceId, 'Workspace ID'),
        requiredText(id, 'Secret ID')
      );
      const updatedAt = nowIso();
      entry.ref = {
        ...entry.ref,
        revision: entry.ref.revision + 1,
        updatedAt,
        updatedBy: requiredText(actorId, 'Actor ID'),
        lastValidatedAt: updatedAt
      };
      await this.#writeStore(store);
      return publicSecretRef(entry);
    });
  }

  async delete({ workspaceId, id } = {}) {
    return this.#withWriteLock(async () => {
      const normalizedWorkspaceId = requiredText(workspaceId, 'Workspace ID');
      const normalizedId = requiredText(id, 'Secret ID');
      if (typeof this.isReferenced !== 'function') throw new Error('Secret reference validation is unavailable.');
      if (await this.isReferenced({ workspaceId: normalizedWorkspaceId, id: normalizedId })) {
        throw new Error('Secret is still referenced and cannot be deleted.');
      }
      const store = await this.#readStore();
      const index = store.secrets.findIndex(
        (entry) => entry.ref.workspaceId === normalizedWorkspaceId && entry.ref.id === normalizedId && !entry.ref.deletedAt
      );
      if (index < 0) throw new Error('Secret was not found.');
      store.secrets.splice(index, 1);
      await this.#writeStore(store);
      return true;
    });
  }

  #assertEncryptionAvailable() {
    if (!this.secureStorage?.isEncryptionAvailable?.()) {
      throw new Error('Secure credential storage is unavailable on this device.');
    }
  }

  #encryptVersion(version, value, createdAt) {
    return {
      version,
      createdAt,
      ciphertext: this.secureStorage.encryptString(value).toString('base64')
    };
  }

  #findActiveEntry(store, workspaceId, id) {
    const entry = store.secrets.find(
      (candidate) => candidate.ref.workspaceId === workspaceId && candidate.ref.id === id && !candidate.ref.deletedAt
    );
    if (!entry) throw new Error('Secret was not found.');
    return entry;
  }

  async #readStore() {
    await this.initialize();
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
    } catch (error) {
      throw new Error('Backup Manager secret store could not be read.', { cause: error });
    }
    if (parsed?.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(parsed.secrets)) {
      throw new Error('Backup Manager secret store version is not supported.');
    }
    return parsed;
  }

  async #writeStore(store) {
    await fs.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.storePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async #withWriteLock(operation) {
    const previous = this.writeQueue;
    let release;
    this.writeQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

module.exports = {
  ALLOWED_SECRET_TYPES,
  BackupSecretStore
};
