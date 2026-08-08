const BACKEND_API_VERSION = 1;
const DRIVER_METHODS = Object.freeze(['list', 'create', 'test', 'remove', 'open']);
const FIELD_TYPES = new Set(['text', 'secret', 'boolean', 'number', 'path', 'select']);
const CONNECTION_CREATION_MODES = new Set(['automatic', 'form', 'external']);

class StorageBackendRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageBackendRegistryError';
    this.code = code;
  }
}

function requiredText(value, label, maximumLength = 200) {
  const result = String(value || '').trim();
  if (!result || result.includes('\0') || result.length > maximumLength) {
    throw new StorageBackendRegistryError('STORAGE_BACKEND_MANIFEST_INVALID', `${label} is invalid.`);
  }
  return result;
}

function textList(value, label) {
  if (!Array.isArray(value)) throw new StorageBackendRegistryError('STORAGE_BACKEND_MANIFEST_INVALID', `${label} must be an array.`);
  return [...new Set(value.map((item) => requiredText(item, `${label} entry`)))];
}

function normalizeFields(value, label) {
  if (!Array.isArray(value)) throw new StorageBackendRegistryError('STORAGE_BACKEND_MANIFEST_INVALID', `${label} must be an array.`);
  const seen = new Set();
  return value.map((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw new StorageBackendRegistryError('STORAGE_BACKEND_MANIFEST_INVALID', `${label} contains an invalid field.`);
    const id = requiredText(field.id, `${label} field ID`, 100);
    if (seen.has(id)) throw new StorageBackendRegistryError('STORAGE_BACKEND_MANIFEST_INVALID', `${label} field IDs must be unique.`);
    seen.add(id);
    const type = requiredText(field.type, `${label} field type`, 40);
    if (!FIELD_TYPES.has(type)) throw new StorageBackendRegistryError('STORAGE_BACKEND_MANIFEST_INVALID', `${label} field type is not supported.`);
    const result = {
      id,
      label: requiredText(field.label, `${label} field label`, 100),
      type,
      required: field.required !== false
    };
    if (field.placeholder) result.placeholder = requiredText(field.placeholder, `${label} field placeholder`, 200);
    if (field.defaultValue !== undefined) result.defaultValue = structuredClone(field.defaultValue);
    if (type === 'select') {
      if (!Array.isArray(field.options) || field.options.length === 0) throw new StorageBackendRegistryError('STORAGE_BACKEND_MANIFEST_INVALID', `${label} select options are required.`);
      result.options = field.options.map((option) => ({
        value: requiredText(option?.value, `${label} option value`, 100),
        label: requiredText(option?.label, `${label} option label`, 100)
      }));
    }
    return result;
  });
}

function normalizeManifest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StorageBackendRegistryError('STORAGE_BACKEND_MANIFEST_INVALID', 'Storage backend manifest must be an object.');
  const apiVersion = Number(input.apiVersion ?? BACKEND_API_VERSION);
  if (apiVersion !== BACKEND_API_VERSION) throw new StorageBackendRegistryError('STORAGE_BACKEND_API_UNSUPPORTED', `Storage backend API version ${apiVersion} is not supported.`);
  const connection = input.connection || {};
  const location = input.location || {};
  const connectionFields = normalizeFields(connection.fields || [], 'Storage connection fields');
  const creationMode = requiredText(connection.creation?.mode || (connectionFields.length ? 'form' : 'automatic'), 'Storage connection creation mode', 40);
  if (!CONNECTION_CREATION_MODES.has(creationMode)) throw new StorageBackendRegistryError('STORAGE_BACKEND_MANIFEST_INVALID', 'Storage connection creation mode is not supported.');
  const creation = { mode: creationMode };
  if (creationMode === 'external') creation.handlerId = requiredText(connection.creation?.handlerId, 'Storage connection creation handler ID', 100);
  return {
    apiVersion,
    backendId: requiredText(input.backendId, 'Storage backend ID'),
    version: requiredText(input.version, 'Storage backend version', 80),
    displayName: requiredText(input.displayName, 'Storage backend display name', 100),
    description: requiredText(input.description, 'Storage backend description', 300),
    icon: requiredText(input.icon, 'Storage backend icon', 100),
    connection: {
      required: connection.required !== false,
      adapterIds: textList(connection.adapterIds || [], 'Storage connection adapter IDs'),
      fields: connectionFields,
      creation
    },
    location: {
      label: requiredText(location.label, 'Storage location label', 100),
      fields: normalizeFields(location.fields || [], 'Storage location fields')
    },
    capabilities: {
      capacityReporting: Boolean(input.capabilities?.capacityReporting),
      immutability: Boolean(input.capabilities?.immutability),
      sharedConnection: input.capabilities?.sharedConnection !== false
    }
  };
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

class StorageBackendRegistry {
  constructor() {
    this.backends = new Map();
  }

  register(manifest, driver, connectionDriver = null) {
    const normalized = freeze(normalizeManifest(manifest));
    if (this.backends.has(normalized.backendId)) throw new StorageBackendRegistryError('STORAGE_BACKEND_DUPLICATE', `Storage backend ${normalized.backendId} is already registered.`);
    if (!driver || typeof driver !== 'object') throw new StorageBackendRegistryError('STORAGE_BACKEND_DRIVER_INVALID', `Storage backend ${normalized.backendId} requires a driver.`);
    for (const method of DRIVER_METHODS) {
      if (typeof driver[method] !== 'function') throw new StorageBackendRegistryError('STORAGE_BACKEND_DRIVER_INVALID', `Storage backend ${normalized.backendId} driver must implement ${method}().`);
    }
    if (connectionDriver !== null) {
      if (!connectionDriver || typeof connectionDriver !== 'object' || typeof connectionDriver.list !== 'function' || typeof connectionDriver.test !== 'function') {
        throw new StorageBackendRegistryError('STORAGE_CONNECTION_DRIVER_INVALID', `Storage backend ${normalized.backendId} connection driver must implement list() and test().`);
      }
      if (normalized.connection.creation.mode !== 'external' && typeof connectionDriver.create !== 'function') {
        throw new StorageBackendRegistryError('STORAGE_CONNECTION_DRIVER_INVALID', `Storage backend ${normalized.backendId} connection driver must implement create().`);
      }
    }
    this.backends.set(normalized.backendId, { manifest: normalized, driver, connectionDriver });
    return this;
  }

  list() {
    return [...this.backends.values()].map(({ manifest }) => structuredClone(manifest));
  }

  get(backendId) {
    const id = requiredText(backendId, 'Storage backend ID');
    const entry = this.backends.get(id);
    if (!entry) throw new StorageBackendRegistryError('STORAGE_BACKEND_NOT_FOUND', `Storage backend ${id} is not registered.`);
    return entry;
  }
}

class StorageConnectionService {
  constructor({ controlDatabase, secretStore, registry } = {}) {
    if (!controlDatabase || !secretStore || !(registry instanceof StorageBackendRegistry)) throw new TypeError('Control database, SecretRef store, and storage backend registry are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.registry = registry;
  }

  async list(workspaceId) {
    const groups = await Promise.all(this.registry.list().map(async (manifest) => {
      const { connectionDriver } = this.registry.get(manifest.backendId);
      if (!connectionDriver) return [];
      const connections = await connectionDriver.list(workspaceId);
      return connections.map((connection) => ({ ...connection, backendId: manifest.backendId, backend: manifest }));
    }));
    return groups.flat();
  }

  create(workspaceId, actorId, backendId, input = {}) {
    const { manifest, connectionDriver } = this.#connectionDriver(backendId);
    if (manifest.connection.creation.mode === 'external') throw new StorageBackendRegistryError('STORAGE_CONNECTION_EXTERNAL_FLOW_REQUIRED', `Storage backend ${manifest.backendId} uses an external connection enrollment flow.`);
    return connectionDriver.create(workspaceId, actorId, input);
  }

  async test(workspaceId, actorId, backendId, connectionId, location = {}) {
    const { manifest, connectionDriver } = this.#connectionDriver(backendId);
    await this.#validateConnection(workspaceId, connectionId, manifest);
    return connectionDriver.test(workspaceId, actorId, connectionId, location);
  }

  async remove(workspaceId, actorId, backendId, connectionId, revision) {
    const { manifest, connectionDriver } = this.#connectionDriver(backendId);
    const connection = await this.#validateConnection(workspaceId, connectionId, manifest);
    if (typeof connectionDriver.remove === 'function') return connectionDriver.remove(workspaceId, actorId, connectionId, revision);
    const deleted = await this.controlDatabase.repository('connection').softDelete(workspaceId, connection.id, { expectedRevision: revision, actorId });
    const credentialsNotRemoved = [];
    for (const secretRefId of connection.secretRefIds || []) {
      try {
        await this.secretStore.delete({ workspaceId, id: secretRefId });
        const metadata = await this.controlDatabase.repository('secretRef').get(workspaceId, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').softDelete(workspaceId, secretRefId, { expectedRevision: metadata.revision, actorId });
      } catch {
        credentialsNotRemoved.push(secretRefId);
      }
    }
    return { connection: deleted, credentialsNotRemoved };
  }

  #connectionDriver(backendId) {
    const entry = this.registry.get(backendId);
    if (!entry.connectionDriver) throw new StorageBackendRegistryError('STORAGE_CONNECTION_DRIVER_UNAVAILABLE', `Storage backend ${entry.manifest.backendId} does not manage reusable connections.`);
    return entry;
  }

  async #validateConnection(workspaceId, connectionId, manifest) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, requiredText(connectionId, 'Storage connection ID'));
    if (!connection || !manifest.connection.adapterIds.includes(connection.adapterId)) throw new StorageBackendRegistryError('STORAGE_CONNECTION_NOT_FOUND', 'Storage connection was not found for this backend.');
    return connection;
  }
}

class StorageDestinationService {
  constructor({ controlDatabase, registry } = {}) {
    if (!controlDatabase || !(registry instanceof StorageBackendRegistry)) throw new TypeError('Control database and storage backend registry are required.');
    this.controlDatabase = controlDatabase;
    this.registry = registry;
  }

  listBackends() {
    return this.registry.list();
  }

  async list(workspaceId) {
    const groups = await Promise.all(this.registry.list().map(async (manifest) => {
      const { driver } = this.registry.get(manifest.backendId);
      const destinations = await driver.list(workspaceId);
      return destinations.map((destination) => ({ ...destination, backendId: manifest.backendId, backend: manifest }));
    }));
    return groups.flat();
  }

  create(workspaceId, actorId, input = {}) {
    return this.registry.get(input.backendId).driver.create(workspaceId, actorId, input);
  }

  async test(workspaceId, actorId, destinationId) {
    const { driver } = await this.#driverForDestination(workspaceId, destinationId);
    return driver.test(workspaceId, actorId, destinationId);
  }

  async remove(workspaceId, actorId, destinationId, revision) {
    const { driver } = await this.#driverForDestination(workspaceId, destinationId);
    return driver.remove(workspaceId, actorId, destinationId, revision);
  }

  async open(workspaceId, destinationId) {
    const { driver } = await this.#driverForDestination(workspaceId, destinationId);
    return driver.open(workspaceId, destinationId);
  }

  async #driverForDestination(workspaceId, destinationId) {
    const repository = await this.controlDatabase.repository('repository').get(workspaceId, destinationId);
    if (!repository) throw new StorageBackendRegistryError('STORAGE_DESTINATION_NOT_FOUND', 'Storage destination was not found.');
    return this.registry.get(repository.adapterId);
  }
}

module.exports = {
  BACKEND_API_VERSION,
  StorageBackendRegistry,
  StorageBackendRegistryError,
  StorageConnectionService,
  StorageDestinationService,
  normalizeManifest
};
