const crypto = require('node:crypto');

const BUILT_IN_PROFILE_DRIVERS = Object.freeze({
  postgresql: Object.freeze({
    credentialSlots: Object.freeze([Object.freeze({ id: 'password', type: 'password', label: 'Password', required: false })])
  }),
  mysql: Object.freeze({
    credentialSlots: Object.freeze([Object.freeze({ id: 'password', type: 'password', label: 'Password', required: false })])
  }),
  sqlite: Object.freeze({ credentialSlots: Object.freeze([]) })
});

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function profileError(message, code) {
  return Object.assign(new Error(message), { code, category: 'database-manager', retryable: false });
}

function mapProfilePersistenceError(error) {
  if (/UNIQUE constraint failed: (?:connections|database_profiles)\.workspace_id, (?:connections|database_profiles)\.name/i.test(String(error?.message || ''))) {
    return profileError('A database profile with this name already exists.', 'DATABASE_MANAGER_PROFILE_NAME_EXISTS');
  }
  return error;
}

function normalizeCredentials(input) {
  if (input === null || input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('Database credentials must be an object.');
  }
  const entries = Object.entries(input);
  if (entries.length > 20) throw profileError('Database credentials contain too many values.', 'DATABASE_MANAGER_CREDENTIAL_TOO_LARGE');
  const credentials = {};
  for (const [slotId, rawValue] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(slotId)) throw profileError('Database credential slot is invalid.', 'DATABASE_MANAGER_CREDENTIAL_SLOT_INVALID');
    const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
    if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw profileError('Database credential is too large.', 'DATABASE_MANAGER_CREDENTIAL_TOO_LARGE');
    if (value) credentials[slotId] = value;
  }
  return credentials;
}

function normalizePluginSettings(input, driver) {
  const raw = input === null || input === undefined ? {} : input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw profileError('Database plugin settings are invalid.', 'DATABASE_MANAGER_PLUGIN_SETTING_INVALID');
  }
  const fields = Array.isArray(driver?.settings?.fields) ? driver.settings.fields : [];
  const declared = new Map(fields.filter((field) => field && typeof field === 'object' && field.key).map((field) => [String(field.key), field]));
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = declared.get(key);
    if (!field) throw profileError('Database plugin settings contain an undeclared value.', 'DATABASE_MANAGER_PLUGIN_SETTING_INVALID');
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw profileError('Database plugin settings are invalid.', 'DATABASE_MANAGER_PLUGIN_SETTING_INVALID');
      result[key] = value;
      continue;
    }
    if (field.type === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) throw profileError('Database plugin settings are invalid.', 'DATABASE_MANAGER_PLUGIN_SETTING_INVALID');
      result[key] = value;
      continue;
    }
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw profileError('Database plugin settings are invalid.', 'DATABASE_MANAGER_PLUGIN_SETTING_INVALID');
    if (Array.isArray(field.options) && field.options.length) {
      const options = field.options.map((option) => String(option?.value ?? option));
      if (!options.includes(value)) throw profileError('Database plugin settings are invalid.', 'DATABASE_MANAGER_PLUGIN_SETTING_INVALID');
    }
    result[key] = value;
  }
  for (const field of declared.values()) {
    if (field.required === true && (result[field.key] === undefined || result[field.key] === '')) {
      throw profileError('A required database plugin setting is missing.', 'DATABASE_MANAGER_PLUGIN_SETTING_REQUIRED');
    }
  }
  return result;
}

function assertCredentialContract(profile, slotIds) {
  const available = new Set(slotIds);
  for (const slotId of available) {
    if (!profile.credentialSlots.some((slot) => slot.id === slotId)) throw profileError('Database credential slot is not declared by this driver.', 'DATABASE_MANAGER_CREDENTIAL_SLOT_INVALID');
  }
  if (profile.credentialSlots.some((slot) => slot.required && !available.has(slot.id))) {
    throw profileError('A required database credential is missing.', 'DATABASE_MANAGER_CREDENTIAL_REQUIRED');
  }
}

function secretTypeForSlot(slot) {
  if (['password', 'token', 'certificate', 'private-key'].includes(slot?.type)) return slot.type;
  return 'token';
}

function secretMetadataInput(ref, actorId) {
  return {
    ...ref,
    actorId,
    workspaceId: ref.workspaceId,
    name: ref.name,
    provider: ref.provider,
    scope: ref.scope,
    providerKey: ref.providerKey,
    secretType: ref.secretType,
    version: ref.version
  };
}

class DatabaseProfileService {
  constructor({ profileStore, controlDatabase, secretStore, driverResolver = null } = {}) {
    if (!profileStore?.list || !profileStore?.get || !profileStore?.create || !profileStore?.update || !profileStore?.delete) {
      throw new TypeError('DatabaseProfileService requires a profile store.');
    }
    if (!controlDatabase?.repository) throw new TypeError('DatabaseProfileService requires the shared control database.');
    if (!secretStore?.create || !secretStore?.rotate || !secretStore?.delete) {
      throw new TypeError('DatabaseProfileService requires the shared secret store.');
    }
    this.profileStore = profileStore;
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.driverResolver = typeof driverResolver === 'function' ? driverResolver : () => null;
  }

  list(workspaceId, options = {}) {
    return this.profileStore.list(requiredText(workspaceId, 'Workspace ID'), options);
  }

  get(workspaceId, profileId) {
    return this.profileStore.get(requiredText(workspaceId, 'Workspace ID'), requiredText(profileId, 'Database profile ID'));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const profile = this.#prepareProfile(input);
    const credentials = normalizeCredentials(input.credentials);
    assertCredentialContract(profile, Object.keys(credentials));
    const createdSecrets = [];
    try {
      const credentialBindings = {};
      for (const [slotId, value] of Object.entries(credentials)) {
        const slot = profile.credentialSlots.find((candidate) => candidate.id === slotId);
        const created = await this.#createCredentialSecret(tenant, actor, profile.name, slot, value);
        createdSecrets.push(created);
        credentialBindings[slotId] = created.id;
      }
      return await this.profileStore.create(tenant, actor, { ...profile, credentialBindings });
    } catch (error) {
      await Promise.all(createdSecrets.map((secret) => this.#removeUnreferencedSecret(tenant, actor, secret.id)));
      throw mapProfilePersistenceError(error);
    }
  }

  async update(workspaceId, actorId, profileId, input = {}, expectedRevision) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const id = requiredText(profileId, 'Database profile ID');
    const current = await this.profileStore.get(tenant, id);
    if (!current) throw profileError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    if (input.driverId && String(input.driverId).trim().toLowerCase() !== current.driverId) {
      throw profileError('Change the database driver by creating a new profile.', 'DATABASE_MANAGER_DRIVER_CHANGE_UNSUPPORTED');
    }
    const profile = this.#prepareProfile({ ...current, ...input, driverId: current.driverId });
    const credentials = normalizeCredentials(input.credentials);
    const credentialBindings = Object.fromEntries((current.credentialSecretRefs || []).map((item) => [item.slotId, item.secretRefId]));
    assertCredentialContract(profile, [...Object.keys(credentialBindings), ...Object.keys(credentials)]);
    const createdSecrets = [];
    for (const [slotId, value] of Object.entries(credentials)) {
      const slot = profile.credentialSlots.find((candidate) => candidate.id === slotId);
      if (credentialBindings[slotId]) {
        await this.#rotateCredentialSecret(tenant, actor, credentialBindings[slotId], value);
      } else {
        const created = await this.#createCredentialSecret(tenant, actor, profile.name, slot, value);
        createdSecrets.push(created);
        credentialBindings[slotId] = created.id;
      }
    }
    try {
      return await this.profileStore.update(tenant, actor, id, { ...profile, credentialBindings }, expectedRevision);
    } catch (error) {
      await Promise.all(createdSecrets.map((secret) => this.#removeUnreferencedSecret(tenant, actor, secret.id)));
      throw mapProfilePersistenceError(error);
    }
  }

  delete(workspaceId, actorId, profileId, expectedRevision) {
    return this.profileStore.delete(
      requiredText(workspaceId, 'Workspace ID'),
      requiredText(actorId || 'system', 'Actor ID'),
      requiredText(profileId, 'Database profile ID'),
      expectedRevision
    );
  }

  #prepareProfile(input) {
    const driverId = requiredText(input.driverId, 'Database driver ID', 100).toLowerCase();
    const builtInDriver = BUILT_IN_PROFILE_DRIVERS[driverId];
    const driver = builtInDriver || this.driverResolver(driverId);
    if (!driver) throw profileError('This database driver is not installed.', 'DATABASE_MANAGER_DRIVER_NOT_AVAILABLE');
    const profile = structuredClone(input && typeof input === 'object' ? input : {});
    delete profile.credentials;
    delete profile.credentialBindings;
    delete profile.credentialSecretRefs;
    profile.driverId = driverId;
    profile.credentialSlots = Array.isArray(driver.credentialSlots) ? driver.credentialSlots.map((slot) => ({ ...slot })) : [];
    if (!builtInDriver) profile.settings = normalizePluginSettings(profile.settings, driver);
    return profile;
  }

  async #createCredentialSecret(workspaceId, actorId, profileName, slot, value) {
    const ref = await this.secretStore.create({
      workspaceId,
      actorId,
      name: `${String(profileName || 'Database').slice(0, 80)} ${String(slot.label || slot.id).slice(0, 40)} ${crypto.randomBytes(3).toString('hex')}`,
      secretType: secretTypeForSlot(slot),
      value,
      scope: 'device'
    });
    try {
      await this.controlDatabase.repository('secretRef').create(secretMetadataInput(ref, actorId));
      return ref;
    } catch (error) {
      await this.secretStore.delete({ workspaceId, id: ref.id }).catch(() => {});
      throw error;
    }
  }

  async #rotateCredentialSecret(workspaceId, actorId, secretRefId, value) {
    const rotated = await this.secretStore.rotate({ workspaceId, actorId, id: secretRefId, value });
    const repository = this.controlDatabase.repository('secretRef');
    const metadata = await repository.get(workspaceId, secretRefId);
    if (!metadata) throw profileError('Database credential metadata was not found.', 'DATABASE_MANAGER_SECRET_REF_NOT_FOUND');
    await repository.update(workspaceId, secretRefId, {
      version: rotated.version,
      expiresAt: rotated.expiresAt,
      lastValidatedAt: rotated.lastValidatedAt
    }, { expectedRevision: metadata.revision, actorId });
    return rotated;
  }

  async #removeUnreferencedSecret(workspaceId, actorId, secretRefId) {
    const repository = this.controlDatabase.repository('secretRef');
    const metadata = await repository.get(workspaceId, secretRefId);
    if (metadata) {
      await repository.softDelete(workspaceId, secretRefId, { expectedRevision: metadata.revision, actorId }).catch(() => {});
    }
    await this.secretStore.delete({ workspaceId, id: secretRefId }).catch(() => {});
  }
}

module.exports = {
  BUILT_IN_PROFILE_DRIVERS,
  DatabaseProfileService,
  normalizeCredentials,
  normalizePluginSettings,
  assertCredentialContract,
  mapProfilePersistenceError,
  secretMetadataInput
};
