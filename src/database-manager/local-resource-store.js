const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const LOCAL_RESOURCE_SCHEMA_VERSION = 1;
const STORE_FILE_NAME = 'local-resources.json';

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function bindingKey(workspaceId, profileId, kind) {
  return JSON.stringify([workspaceId, profileId, kind]);
}

function validateKind(value) {
  const kind = String(value || '').toLowerCase();
  if (!['file', 'folder'].includes(kind)) throw new TypeError('Database local resource kind is invalid.');
  return kind;
}

function normalizeStoredRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Database local resource binding is invalid.');
  const resourcePath = requiredText(input.path, 'Database local resource path');
  if (!path.isAbsolute(resourcePath)) throw new TypeError('Database local resource path must be absolute.');
  return Object.freeze({
    workspaceId: requiredText(input.workspaceId, 'Workspace ID', 200),
    profileId: requiredText(input.profileId, 'Database profile ID', 200),
    kind: validateKind(input.kind),
    path: path.normalize(resourcePath),
    updatedAt: requiredText(input.updatedAt, 'Database local resource update time', 100)
  });
}

async function writeJsonAtomically(fileSystem, targetPath, value) {
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

class DatabaseLocalResourceStore {
  constructor({ rootPath, fileSystem = fs, clock = () => new Date().toISOString() } = {}) {
    this.rootPath = path.resolve(requiredText(rootPath, 'Database Manager local resource root'));
    this.storePath = path.join(this.rootPath, STORE_FILE_NAME);
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.records = new Map();
    this.initialized = false;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return;
    await this.fileSystem.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await this.fileSystem.readFile(this.storePath, 'utf8'));
      if (parsed?.schemaVersion !== LOCAL_RESOURCE_SCHEMA_VERSION || !Array.isArray(parsed.bindings)) {
        throw new TypeError('Database local resource store version is invalid.');
      }
      const loaded = new Map();
      for (const input of parsed.bindings) {
        const record = normalizeStoredRecord(input);
        const key = bindingKey(record.workspaceId, record.profileId, record.kind);
        if (loaded.has(key)) throw new TypeError('Database local resource store contains duplicate bindings.');
        loaded.set(key, record);
      }
      this.records = loaded;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const wrapped = Object.assign(new Error('Database local resource bindings could not be opened.'), {
          code: 'DATABASE_MANAGER_LOCAL_RESOURCE_STORE_INVALID',
          category: 'storage',
          retryable: false
        });
        wrapped.cause = error;
        throw wrapped;
      }
    }
    this.initialized = true;
  }

  async bind({ workspaceId, profileId, kind, path: inputPath } = {}) {
    await this.initialize();
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(profileId, 'Database profile ID', 200);
    const resourceKind = validateKind(kind);
    const requestedPath = path.resolve(requiredText(inputPath, 'Database local resource path'));
    const canonicalPath = await this.fileSystem.realpath(requestedPath).catch(() => {
      throw Object.assign(new Error('The selected database resource is unavailable.'), { code: 'DATABASE_MANAGER_LOCAL_RESOURCE_NOT_FOUND', category: 'validation' });
    });
    const stat = await this.fileSystem.stat(canonicalPath).catch(() => {
      throw Object.assign(new Error('The selected database resource is unavailable.'), { code: 'DATABASE_MANAGER_LOCAL_RESOURCE_NOT_FOUND', category: 'validation' });
    });
    if ((resourceKind === 'file' && !stat.isFile()) || (resourceKind === 'folder' && !stat.isDirectory())) {
      throw Object.assign(new Error(`The selected database resource must be a ${resourceKind}.`), { code: 'DATABASE_MANAGER_LOCAL_RESOURCE_KIND_INVALID', category: 'validation' });
    }
    return this.#mutate(async () => {
      const record = Object.freeze({ workspaceId: tenant, profileId: id, kind: resourceKind, path: canonicalPath, updatedAt: this.clock() });
      const key = bindingKey(tenant, id, resourceKind);
      const previous = this.records.get(key);
      this.records.set(key, record);
      try {
        await this.#persist();
      } catch (error) {
        if (previous) this.records.set(key, previous);
        else this.records.delete(key);
        throw error;
      }
      return Object.freeze({ profileId: id, kind: resourceKind, displayName: path.basename(canonicalPath), bound: true });
    });
  }

  async resolve({ workspaceId, profileId, kind } = {}) {
    await this.initialize();
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(profileId, 'Database profile ID', 200);
    const resourceKind = validateKind(kind);
    const record = this.records.get(bindingKey(tenant, id, resourceKind));
    if (!record) return null;
    try {
      const stat = await this.fileSystem.stat(record.path);
      if ((resourceKind === 'file' && !stat.isFile()) || (resourceKind === 'folder' && !stat.isDirectory())) return null;
      return record.path;
    } catch {
      return null;
    }
  }

  async metadata({ workspaceId, profileId, kind } = {}) {
    const resolved = await this.resolve({ workspaceId, profileId, kind });
    return Object.freeze({ profileId: requiredText(profileId, 'Database profile ID', 200), kind: validateKind(kind), bound: Boolean(resolved), displayName: resolved ? path.basename(resolved) : null });
  }

  async remove({ workspaceId, profileId, kind = null } = {}) {
    await this.initialize();
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(profileId, 'Database profile ID', 200);
    return this.#mutate(async () => {
      let changed = false;
      const kinds = kind ? [validateKind(kind)] : ['file', 'folder'];
      const removed = [];
      for (const resourceKind of kinds) {
        const key = bindingKey(tenant, id, resourceKind);
        const record = this.records.get(key);
        if (record) removed.push([key, record]);
        changed = this.records.delete(key) || changed;
      }
      try {
        if (changed) await this.#persist();
      } catch (error) {
        for (const [key, record] of removed) this.records.set(key, record);
        throw error;
      }
      return changed;
    });
  }

  #mutate(operation) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  #persist() {
    const bindings = [...this.records.values()].sort((left, right) =>
      `${left.workspaceId}\0${left.profileId}\0${left.kind}`.localeCompare(`${right.workspaceId}\0${right.profileId}\0${right.kind}`, 'en-US')
    );
    return writeJsonAtomically(this.fileSystem, this.storePath, { schemaVersion: LOCAL_RESOURCE_SCHEMA_VERSION, bindings });
  }
}

module.exports = {
  DatabaseLocalResourceStore,
  LOCAL_RESOURCE_SCHEMA_VERSION,
  STORE_FILE_NAME,
  bindingKey,
  normalizeStoredRecord,
  writeJsonAtomically
};
