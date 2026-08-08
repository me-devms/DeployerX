const {
  ADAPTER_ID: S3_REPOSITORY_ADAPTER_ID,
  S3CompatibleRepositoryAdapter,
  normalizeS3ConnectionConfig,
  normalizeS3Credential,
  normalizeS3LocationConfig,
  normalizeS3RepositoryConfig
} = require('./s3-repository');

const ADAPTER_ID = 'deployerx.storage-connection.s3-compatible';
const ADAPTER_VERSION = '1.0.0';

function requiredText(value, label, maximumLength = 200) {
  const result = String(value || '').trim();
  if (!result || result.includes('\0') || result.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return result;
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

class S3StorageConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapterFactory = (config) => new S3CompatibleRepositoryAdapter(config), clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID');
    this.adapterFactory = adapterFactory;
    this.clock = clock;
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    return (await this.controlDatabase.repository('connection').list(tenant, { limit: 1000 }))
      .filter((connection) => connection.adapterId === ADAPTER_ID)
      .map((connection) => ({ ...connection, currentDevice: (connection.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const name = requiredText(input.name, 'S3 connection name');
    const endpoint = normalizeS3ConnectionConfig({
      endpoint: input.endpoint,
      forcePathStyle: input.forcePathStyle,
      allowInsecureEndpoint: input.allowInsecureEndpoint,
      timeoutMs: input.timeoutMs
    });
    const credential = normalizeS3Credential(input);
    const credentialRef = await this.secretStore.create({
      workspaceId: tenant,
      actorId: actor,
      name: `${name} credentials`,
      secretType: 'access-key',
      value: JSON.stringify(credential),
      scope: 'device'
    });
    try {
      return await this.controlDatabase.transaction((transaction) => {
        transaction.create('secretRef', secretMetadataInput(credentialRef, actor));
        return transaction.create('connection', {
          workspaceId: tenant,
          actorId: actor,
          name,
          kind: 'storage',
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          scope: 'device',
          endpoint,
          secretRefIds: [credentialRef.id],
          trust: { mode: endpoint.allowInsecureEndpoint ? 'explicit-http' : 'tls' },
          workerAffinity: [`device:${this.deviceId}`],
          lastTest: null
        });
      });
    } catch (error) {
      await this.secretStore.delete({ workspaceId: tenant, id: credentialRef.id }).catch(() => {});
      throw error;
    }
  }

  async resolve(workspaceId, connectionId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const connection = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'S3 connection ID'));
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new Error('Choose a saved S3 storage connection.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This S3 storage connection belongs to another device.');
    const credentialSecretRefId = connection.secretRefIds?.[0];
    if (!credentialSecretRefId) throw new Error('S3 connection credentials are unavailable.');
    return { connection, config: normalizeS3ConnectionConfig(connection.endpoint || {}), credentialSecretRefId };
  }

  async test(workspaceId, actorId, connectionId, location = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const resolved = await this.resolve(tenant, connectionId);
    const repositoryConfig = normalizeS3RepositoryConfig({ ...resolved.config, ...normalizeS3LocationConfig(location) });
    const adapter = this.adapterFactory({
      config: repositoryConfig,
      credentialSecretRefId: resolved.credentialSecretRefId,
      resolveSecret: (id) => this.secretStore.resolve({ workspaceId: tenant, id }),
      clock: this.clock
    });
    const probe = await adapter.probeCapabilities({});
    const updated = await this.controlDatabase.repository('connection').update(tenant, resolved.connection.id, {
      lastTest: probe.connectionTest || { status: probe.status, testedAt: this.clock() },
      adapterVersion: ADAPTER_VERSION
    }, { expectedRevision: resolved.connection.revision, actorId: actor });
    return { connection: updated, probe };
  }

  async remove(workspaceId, actorId, connectionId, revision) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const connection = await this.controlDatabase.repository('connection').get(tenant, requiredText(connectionId, 'S3 connection ID'));
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new Error('S3 storage connection was not found.');
    const expectedRevision = Number(revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('S3 connection revision is required for removal.');
    const removed = await this.controlDatabase.repository('connection').softDelete(tenant, connection.id, { expectedRevision, actorId: actor });
    const credentialsNotRemoved = [];
    for (const secretRefId of connection.secretRefIds || []) {
      try {
        await this.secretStore.delete({ workspaceId: tenant, id: secretRefId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').softDelete(tenant, secretRefId, { expectedRevision: metadata.revision, actorId: actor });
      } catch {
        credentialsNotRemoved.push(secretRefId);
      }
    }
    return { connection: removed, credentialsNotRemoved };
  }

  async migrateLegacyRepositories(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const repositories = (await this.controlDatabase.repository('repository').list(tenant, { limit: 1000 }))
      .filter((repository) => repository.adapterId === S3_REPOSITORY_ADAPTER_ID && !repository.connectionId);
    const existingNames = new Set((await this.controlDatabase.repository('connection').list(tenant, { limit: 1000 })).map((connection) => connection.name.toLocaleLowerCase('en-US')));
    const migrated = [];
    for (const repository of repositories) {
      const credentialSecretRefId = repository.secretRefIds?.[0];
      if (!credentialSecretRefId) throw new Error(`Legacy S3 destination ${repository.name} has no credential reference.`);
      const endpoint = normalizeS3ConnectionConfig({
        endpoint: repository.location?.endpoint,
        forcePathStyle: repository.location?.forcePathStyle,
        allowInsecureEndpoint: repository.location?.allowInsecureEndpoint,
        timeoutMs: repository.location?.timeoutMs
      });
      const location = normalizeS3LocationConfig({
        region: repository.location?.region,
        bucket: repository.location?.bucket,
        prefix: repository.location?.prefix
      });
      const baseName = `${repository.name} connection`;
      let name = baseName;
      let suffix = 2;
      while (existingNames.has(name.toLocaleLowerCase('en-US'))) name = `${baseName} ${suffix++}`;
      existingNames.add(name.toLocaleLowerCase('en-US'));
      const result = await this.controlDatabase.transaction((transaction) => {
        const connection = transaction.create('connection', {
          workspaceId: tenant,
          actorId: actor,
          name,
          kind: 'storage',
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          scope: 'device',
          endpoint,
          secretRefIds: [credentialSecretRefId],
          trust: { mode: endpoint.allowInsecureEndpoint ? 'explicit-http' : 'tls' },
          workerAffinity: repository.workerAffinity || [`device:${this.deviceId}`],
          lastTest: repository.health?.checkedAt ? { status: repository.health.status === 'ready' ? 'success' : 'failure', testedAt: repository.health.checkedAt } : null,
          migratedFromRepositoryId: repository.id
        });
        const destination = transaction.update('repository', tenant, repository.id, {
          connectionId: connection.id,
          location,
          secretRefIds: []
        }, { expectedRevision: repository.revision, actorId: actor });
        return { connection, destination };
      });
      migrated.push(result);
    }
    return { migrated };
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  S3StorageConnectionService
};
