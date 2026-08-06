const BACKUP_ADAPTERS = Object.freeze({
  postgresql: Object.freeze({ adapterId: 'deployerx.database.postgresql.logical', adapterVersion: '1.4.0' }),
  mysql: Object.freeze({ adapterId: 'deployerx.database.mysql.logical', adapterVersion: '1.4.0' }),
  sqlite: Object.freeze({ adapterId: 'deployerx.database.sqlite.native', adapterVersion: '0.1.0' })
});

function handoffError(message, code) {
  return Object.assign(new Error(message), { code, safeMessage: message, category: 'database-manager', retryable: false });
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw handoffError(`${label} is invalid.`, 'DATABASE_MANAGER_BACKUP_HANDOFF_INVALID');
  return text;
}

function passwordSecretRef(profile) {
  return (profile.credentialSecretRefs || []).find((binding) => binding.slotId === 'password')?.secretRefId || null;
}

function backupTlsMode(mode) {
  return mode === 'verify-full' ? 'verify-identity' : mode || 'disabled';
}

function boundedTimeout(value) {
  const timeout = Number(value || 30000);
  return Math.min(300000, Math.max(1000, Number.isFinite(timeout) ? Math.round(timeout) : 30000));
}

function backupConnectionProjection(profile, { deviceId, localPath } = {}) {
  const adapter = BACKUP_ADAPTERS[profile?.driverId];
  if (!adapter) throw handoffError('Backup Manager does not support this database driver yet.', 'DATABASE_MANAGER_BACKUP_DRIVER_UNSUPPORTED');
  if (profile.tunnel?.type && profile.tunnel.type !== 'none') {
    throw handoffError('Backup protection is unavailable until this linked-server tunnel can be used by Backup Manager.', 'DATABASE_MANAGER_BACKUP_TUNNEL_UNAVAILABLE');
  }

  const workerId = `device:${requiredText(deviceId, 'Backup device ID', 200)}`;
  const common = {
    name: requiredText(profile.name, 'Database profile name', 200),
    kind: 'database',
    adapterId: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
    scope: 'device',
    workerAffinity: [workerId],
    lastTest: null
  };

  if (profile.driverId === 'sqlite') {
    return {
      ...common,
      endpoint: {
        databasePath: requiredText(localPath, 'Bound SQLite database path'),
        sqliteExecutable: String(profile.settings?.sqliteExecutable || 'sqlite3').trim() || 'sqlite3',
        timeoutMs: boundedTimeout(profile.queryTimeoutMs)
      },
      secretRefIds: [],
      trust: { mode: 'local-file-identity', fingerprint: null }
    };
  }

  const passwordSecretRefId = passwordSecretRef(profile);
  if (!passwordSecretRefId) {
    throw handoffError('Save a database password on this device before protecting this profile.', 'DATABASE_MANAGER_BACKUP_CREDENTIAL_REQUIRED');
  }
  const endpoint = {
    host: requiredText(profile.endpoint?.host, 'Database host', 253),
    port: Number(profile.endpoint?.port),
    username: requiredText(profile.settings?.username, 'Database username', 200),
    tlsMode: backupTlsMode(profile.ssl?.mode),
    timeoutMs: boundedTimeout(profile.queryTimeoutMs)
  };
  if (profile.driverId === 'postgresql') {
    endpoint.database = String(profile.settings?.maintenanceDatabase || (profile.database === 'postgres' ? 'template1' : 'postgres'));
    endpoint.maintenanceDatabase = endpoint.database;
    endpoint.psqlExecutable = String(profile.settings?.psqlExecutable || 'psql');
    endpoint.pgDumpExecutable = String(profile.settings?.pgDumpExecutable || 'pg_dump');
  } else {
    endpoint.mysqlExecutable = String(profile.settings?.mysqlExecutable || 'mysql');
    endpoint.mysqldumpExecutable = String(profile.settings?.mysqldumpExecutable || 'mysqldump');
    endpoint.mysqlbinlogExecutable = String(profile.settings?.mysqlbinlogExecutable || 'mysqlbinlog');
  }
  return { ...common, endpoint, secretRefIds: [passwordSecretRefId], trust: { mode: endpoint.tlsMode, fingerprint: null } };
}

function samePreparedConnection(connection, projection) {
  return ['name', 'kind', 'adapterId', 'adapterVersion', 'scope', 'endpoint', 'secretRefIds', 'workerAffinity']
    .every((key) => JSON.stringify(connection?.[key]) === JSON.stringify(projection[key]));
}

class DatabaseBackupHandoffService {
  constructor({ controlDatabase, profileService, localResourceResolver, deviceId } = {}) {
    if (!controlDatabase?.repository) throw new TypeError('Database backup handoff requires the shared control database.');
    if (!profileService?.get) throw new TypeError('Database backup handoff requires the profile service.');
    if (typeof localResourceResolver !== 'function') throw new TypeError('Database backup handoff requires a local resource resolver.');
    this.controlDatabase = controlDatabase;
    this.profileService = profileService;
    this.localResourceResolver = localResourceResolver;
    this.deviceId = requiredText(deviceId, 'Backup device ID', 200);
  }

  async prepare(workspaceId, actorId, profileId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId || 'system', 'Actor ID', 200);
    const profile = await this.profileService.get(tenant, requiredText(profileId, 'Database profile ID', 200));
    if (!profile) throw handoffError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    const localPath = profile.driverId === 'sqlite'
      ? await this.localResourceResolver({ workspaceId: tenant, profileId: profile.id, kind: 'file' })
      : null;
    if (profile.driverId === 'sqlite' && !localPath) {
      throw handoffError('Choose the local SQLite database file before protecting this profile.', 'DATABASE_MANAGER_BACKUP_LOCAL_RESOURCE_REQUIRED');
    }
    const projection = backupConnectionProjection(profile, { deviceId: this.deviceId, localPath });
    const repository = this.controlDatabase.repository('connection');
    const connection = await repository.get(tenant, profile.sharedConnectionId);
    if (!connection || connection.kind !== 'database') {
      throw handoffError('The shared database connection is unavailable.', 'DATABASE_MANAGER_CONNECTION_NOT_FOUND');
    }
    const prepared = samePreparedConnection(connection, projection)
      ? connection
      : await repository.update(tenant, connection.id, projection, { expectedRevision: connection.revision, actorId: actor });
    return Object.freeze({ profileId: profile.id, driverId: profile.driverId, connectionId: prepared.id, connection: prepared });
  }
}

module.exports = {
  BACKUP_ADAPTERS,
  DatabaseBackupHandoffService,
  backupConnectionProjection,
  backupTlsMode,
  passwordSecretRef,
  samePreparedConnection
};
