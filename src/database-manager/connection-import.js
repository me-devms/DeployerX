const path = require('node:path');

const BACKUP_CONNECTION_IMPORTS = Object.freeze({
  'deployerx.database.postgresql.logical': Object.freeze({ driverId: 'postgresql', defaultPort: 5432, defaultSchema: 'public' }),
  'deployerx.database.mysql.logical': Object.freeze({ driverId: 'mysql', defaultPort: 3306, defaultSchema: null }),
  'deployerx.database.mariadb.logical': Object.freeze({ driverId: 'mysql', defaultPort: 3306, defaultSchema: null }),
  'deployerx.database.sqlite.native': Object.freeze({ driverId: 'sqlite', defaultPort: null, defaultSchema: null })
});

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function importedSslMode(value) {
  const mode = String(value || 'disabled').trim().toLowerCase();
  if (mode === 'verify-identity') return 'verify-full';
  return ['disabled', 'preferred', 'required', 'verify-ca', 'verify-full'].includes(mode) ? mode : 'disabled';
}

function importedProfileName(value, usedNames) {
  const base = requiredText(value, 'Backup Manager connection name').slice(0, 120);
  if (!usedNames.has(base.toLowerCase())) return base;
  for (let counter = 1; counter <= 1000; counter += 1) {
    const suffix = counter === 1 ? ' (Backup Manager)' : ` (Backup Manager ${counter})`;
    const candidate = `${base.slice(0, 120 - suffix.length).trimEnd()}${suffix}`;
    if (!usedNames.has(candidate.toLowerCase())) return candidate;
  }
  throw Object.assign(new Error('A unique imported database profile name could not be allocated.'), { code: 'DATABASE_MANAGER_IMPORT_NAME_CONFLICT' });
}

function connectionBelongsToDevice(connection, deviceId) {
  const affinities = Array.isArray(connection.workerAffinity) ? connection.workerAffinity.map(String) : [];
  if (connection.scope !== 'device' && !affinities.length) return true;
  return affinities.includes(`device:${deviceId}`);
}

function profileInputFromConnection(connection, name) {
  const mapping = BACKUP_CONNECTION_IMPORTS[connection.adapterId];
  if (!mapping || connection.kind !== 'database') return null;
  const endpoint = connection.endpoint && typeof connection.endpoint === 'object' && !Array.isArray(connection.endpoint)
    ? connection.endpoint
    : {};
  const passwordSecretRefId = Array.isArray(connection.secretRefIds) ? connection.secretRefIds.find(Boolean) : null;
  const common = {
    name,
    driverId: mapping.driverId,
    sharedConnectionId: connection.id,
    database: null,
    defaultSchema: mapping.defaultSchema,
    environment: 'unclassified',
    accessMode: 'read-write',
    tags: ['backup-manager'],
    tunnel: { type: 'none' },
    credentialSlots: mapping.driverId === 'sqlite'
      ? []
      : [{ id: 'password', type: 'password', label: 'Password', required: false }],
    credentialBindings: passwordSecretRefId ? { password: String(passwordSecretRefId) } : {},
    queryTimeoutMs: Number.isFinite(Number(endpoint.timeoutMs)) ? Number(endpoint.timeoutMs) : undefined,
    settings: endpoint.username ? { username: String(endpoint.username) } : {}
  };
  if (mapping.driverId === 'sqlite') {
    return {
      profile: { ...common, endpoint: { kind: 'file' }, ssl: { mode: 'disabled' } },
      localPath: path.isAbsolute(String(endpoint.databasePath || '')) ? path.normalize(String(endpoint.databasePath)) : null
    };
  }
  return {
    profile: {
      ...common,
      endpoint: { kind: 'network', host: endpoint.host, port: Number(endpoint.port || mapping.defaultPort) },
      database: mapping.driverId === 'postgresql' ? endpoint.database || endpoint.maintenanceDatabase || null : null,
      ssl: { mode: importedSslMode(endpoint.tlsMode) }
    },
    localPath: null
  };
}

class DatabaseConnectionImportService {
  constructor({ controlDatabase, profileStore, localResourceStore, deviceId } = {}) {
    if (!controlDatabase?.repository || !profileStore?.create || !localResourceStore?.bind) {
      throw new TypeError('DatabaseConnectionImportService requires shared connection, profile, and local-resource stores.');
    }
    this.controlDatabase = controlDatabase;
    this.profileStore = profileStore;
    this.localResourceStore = localResourceStore;
    this.deviceId = requiredText(deviceId, 'Device ID');
    this.queue = Promise.resolve();
  }

  reconcile(workspaceId, actorId = 'system') {
    const operation = this.queue.then(() => this.#reconcile(workspaceId, actorId));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async #reconcile(workspaceId, actorId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const [connections, allProfiles] = await Promise.all([
      this.controlDatabase.repository('connection').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('databaseProfile').list(tenant, { includeDeleted: true, limit: 1000 })
    ]);
    const linkedConnectionIds = new Set(allProfiles.map((profile) => profile.sharedConnectionId).filter(Boolean));
    const usedNames = new Set(allProfiles.filter((profile) => !profile.deletedAt).map((profile) => String(profile.name).toLowerCase()));
    const created = [];
    const failures = [];
    let skipped = 0;
    for (const connection of connections.slice().reverse()) {
      if (!BACKUP_CONNECTION_IMPORTS[connection.adapterId] || linkedConnectionIds.has(connection.id) || !connectionBelongsToDevice(connection, this.deviceId)) {
        skipped += 1;
        continue;
      }
      try {
        const name = importedProfileName(connection.name, usedNames);
        const projection = profileInputFromConnection(connection, name);
        if (!projection) {
          skipped += 1;
          continue;
        }
        const profile = await this.profileStore.create(tenant, actor, projection.profile);
        linkedConnectionIds.add(connection.id);
        usedNames.add(profile.name.toLowerCase());
        let localResourceBound = false;
        if (projection.localPath) {
          localResourceBound = await this.localResourceStore.bind({
            workspaceId: tenant,
            profileId: profile.id,
            kind: 'file',
            path: projection.localPath
          }).then(() => true, () => false);
        }
        created.push(Object.freeze({ profile, localResourceBound }));
      } catch (error) {
        failures.push(Object.freeze({
          connectionId: String(connection.id || '').slice(0, 200),
          code: String(error?.code || 'DATABASE_MANAGER_CONNECTION_IMPORT_FAILED').slice(0, 120)
        }));
      }
    }
    return Object.freeze({ created: Object.freeze(created), skipped, failures: Object.freeze(failures) });
  }
}

module.exports = {
  BACKUP_CONNECTION_IMPORTS,
  DatabaseConnectionImportService,
  connectionBelongsToDevice,
  importedProfileName,
  importedSslMode,
  profileInputFromConnection
};
