const { normalizeProfileInput } = require('./domain');
const { BACKUP_ADAPTERS, backupConnectionProjection } = require('./backup-handoff');

const DATABASE_CONNECTION_ADAPTER_PREFIX = 'deployerx.database-manager.';

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeCredentialBindings(input = {}) {
  if (input === null || input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('Database credential bindings must be an object.');
  }
  const result = {};
  for (const [slotId, secretRefId] of Object.entries(input)) {
    const slot = requiredText(slotId, 'Credential slot ID', 100).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(slot)) throw new TypeError('Credential slot ID is invalid.');
    result[slot] = requiredText(secretRefId, 'SecretRef ID');
  }
  return Object.freeze(result);
}

function connectionProjection(profile, secretRefIds) {
  return {
    name: profile.name,
    kind: 'database',
    adapterId: `${DATABASE_CONNECTION_ADAPTER_PREFIX}${profile.driverId}`,
    adapterVersion: '1.0.0',
    scope: 'workspace',
    endpoint: profile.endpoint,
    database: profile.database,
    defaultSchema: profile.defaultSchema,
    projectId: profile.projectId,
    tunnel: profile.tunnel,
    ssl: profile.ssl,
    secretRefIds: [...new Set(secretRefIds)].sort(),
    trust: {},
    workerAffinity: []
  };
}

function preparedBackupProjection(profile, connection, credentialBindings) {
  const adapter = BACKUP_ADAPTERS[profile.driverId];
  if (!adapter || connection.adapterId !== adapter.adapterId) return null;
  const workerId = (connection.workerAffinity || []).find((value) => String(value).startsWith('device:'));
  if (!workerId) return null;
  return backupConnectionProjection({ ...profile, credentialSecretRefs: credentialReferences(credentialBindings) }, {
    deviceId: workerId.slice('device:'.length),
    localPath: profile.driverId === 'sqlite' ? connection.endpoint?.databasePath : null
  });
}

function credentialReferences(bindings) {
  return Object.entries(bindings).map(([slotId, secretRefId]) => Object.freeze({ slotId, secretRefId }));
}

function bindingsFromReferences(references = []) {
  if (!Array.isArray(references)) return {};
  return Object.fromEntries(references.map((reference) => [reference.slotId, reference.secretRefId]));
}

class DatabaseProfileStore {
  constructor({ controlDatabase } = {}) {
    if (!controlDatabase?.repository || !controlDatabase?.transaction || !controlDatabase?.read) {
      throw new TypeError('DatabaseProfileStore requires the shared control database.');
    }
    this.controlDatabase = controlDatabase;
  }

  list(workspaceId, options = {}) {
    return this.controlDatabase.repository('databaseProfile').list(requiredText(workspaceId, 'Workspace ID'), options);
  }

  get(workspaceId, profileId, options = {}) {
    return this.controlDatabase.repository('databaseProfile').get(requiredText(workspaceId, 'Workspace ID'), requiredText(profileId, 'Database profile ID'), options);
  }

  create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const requestedId = input.id ? requiredText(input.id, 'Database profile ID') : null;
    const profile = normalizeProfileInput(input);
    const credentialBindings = normalizeCredentialBindings(input.credentialBindings);
    return this.controlDatabase.transaction((transaction) => {
      const secretRefIds = this.#validateCredentialBindings(transaction, tenant, profile, credentialBindings);
      let connection;
      if (profile.sharedConnectionId) {
        connection = transaction.get('connection', tenant, profile.sharedConnectionId);
        if (!connection || connection.kind !== 'database') throw Object.assign(new Error('Shared database connection was not found in this workspace.'), { code: 'DATABASE_MANAGER_CONNECTION_NOT_FOUND' });
        const currentRefs = [...(connection.secretRefIds || [])].sort();
        const mergedSecretRefs = [...new Set([...currentRefs, ...secretRefIds])].sort();
        if (JSON.stringify(mergedSecretRefs) !== JSON.stringify(currentRefs)) {
          connection = transaction.update('connection', tenant, connection.id, { secretRefIds: mergedSecretRefs }, { expectedRevision: connection.revision, actorId: actor });
        }
      } else {
        connection = transaction.create('connection', {
          workspaceId: tenant,
          actorId: actor,
          ...connectionProjection(profile, secretRefIds)
        });
      }
      return transaction.create('databaseProfile', {
        ...(requestedId ? { id: requestedId } : {}),
        workspaceId: tenant,
        actorId: actor,
        ...profile,
        sharedConnectionId: connection.id,
        credentialSecretRefs: credentialReferences(credentialBindings)
      });
    });
  }

  update(workspaceId, actorId, profileId, changes = {}, expectedRevision) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const id = requiredText(profileId, 'Database profile ID');
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('databaseProfile', tenant, id);
      if (!current) throw Object.assign(new Error('Database profile was not found.'), { code: 'DATABASE_MANAGER_PROFILE_NOT_FOUND' });
      const normalized = normalizeProfileInput({ ...current, ...changes, sharedConnectionId: current.sharedConnectionId });
      const credentialBindings = changes.credentialBindings === undefined
        ? normalizeCredentialBindings(bindingsFromReferences(current.credentialSecretRefs))
        : normalizeCredentialBindings(changes.credentialBindings);
      const secretRefIds = this.#validateCredentialBindings(transaction, tenant, normalized, credentialBindings);
      const connection = transaction.get('connection', tenant, current.sharedConnectionId);
      if (!connection) throw Object.assign(new Error('Shared database connection was not found.'), { code: 'DATABASE_MANAGER_CONNECTION_NOT_FOUND' });
      const mergedSecretRefs = [...new Set([...(connection.secretRefIds || []), ...secretRefIds])].sort();
      const sharedProjection = preparedBackupProjection(normalized, connection, credentialBindings) || connectionProjection(normalized, mergedSecretRefs);
      transaction.update('connection', tenant, connection.id, sharedProjection, { expectedRevision: connection.revision, actorId: actor });
      return transaction.update('databaseProfile', tenant, current.id, {
        ...normalized,
        sharedConnectionId: current.sharedConnectionId,
        credentialSecretRefs: credentialReferences(credentialBindings)
      }, { expectedRevision: Number(expectedRevision), actorId: actor });
    });
  }

  delete(workspaceId, actorId, profileId, expectedRevision) {
    return this.controlDatabase.repository('databaseProfile').softDelete(
      requiredText(workspaceId, 'Workspace ID'),
      requiredText(profileId, 'Database profile ID'),
      { expectedRevision: Number(expectedRevision), actorId: requiredText(actorId || 'system', 'Actor ID') }
    );
  }

  #validateCredentialBindings(transaction, workspaceId, profile, bindings) {
    const slots = new Map(profile.credentialSlots.map((slot) => [slot.id, slot]));
    for (const slotId of Object.keys(bindings)) {
      if (!slots.has(slotId)) throw Object.assign(new Error(`Credential slot ${slotId} is not declared by the driver.`), { code: 'DATABASE_MANAGER_CREDENTIAL_SLOT_INVALID' });
    }
    for (const slot of slots.values()) {
      if (slot.required && !bindings[slot.id]) throw Object.assign(new Error(`${slot.label} is required.`), { code: 'DATABASE_MANAGER_CREDENTIAL_REQUIRED' });
    }
    const secretRefIds = Object.values(bindings);
    for (const secretRefId of secretRefIds) {
      if (!transaction.get('secretRef', workspaceId, secretRefId)) {
        throw Object.assign(new Error('Database credential reference was not found in this workspace.'), { code: 'DATABASE_MANAGER_SECRET_REF_NOT_FOUND' });
      }
    }
    return secretRefIds;
  }
}

module.exports = {
  DATABASE_CONNECTION_ADAPTER_PREFIX,
  DatabaseProfileStore,
  normalizeCredentialBindings
};
