const { ADAPTER_ID: LOCAL_CONNECTION_ADAPTER_ID } = require('./local-connection');
const { ADAPTER_ID: SSH_CONNECTION_ADAPTER_ID } = require('./ssh-connection');
const { ADAPTER_ID: LOCAL_BACKEND_ID, ADAPTER_VERSION: LOCAL_BACKEND_VERSION } = require('./local-repository');
const { ADAPTER_ID: SFTP_BACKEND_ID, ADAPTER_VERSION: SFTP_BACKEND_VERSION } = require('./sftp-repository');
const { ADAPTER_ID: S3_BACKEND_ID, ADAPTER_VERSION: S3_BACKEND_VERSION } = require('./s3-repository');
const { ADAPTER_ID: S3_CONNECTION_ADAPTER_ID } = require('./s3-storage-connection');
const { StorageBackendRegistry } = require('./storage-backend-registry');

function requireService(value, label) {
  if (!value) throw new TypeError(`${label} is required.`);
  return value;
}

function repositoryDriver(service, mapCreateInput) {
  return {
    list: (workspaceId) => service.list(workspaceId),
    create: (workspaceId, actorId, input) => service.create(workspaceId, actorId, mapCreateInput(input)),
    test: (workspaceId, actorId, destinationId) => service.test(workspaceId, actorId, destinationId),
    remove: (workspaceId, actorId, destinationId, revision) => service.remove(workspaceId, actorId, destinationId, revision),
    open: (workspaceId, destinationId) => service.open(workspaceId, destinationId)
  };
}

function localConnectionDriver(service) {
  return {
    list: (workspaceId) => service.list(workspaceId),
    create: (workspaceId, actorId) => service.ensure(workspaceId, actorId),
    test: (workspaceId, actorId, connectionId) => service.test(workspaceId, connectionId, actorId)
  };
}

function sshConnectionDriver(service) {
  return {
    list: (workspaceId) => service.list(workspaceId),
    test: (workspaceId, actorId, connectionId) => service.test(workspaceId, connectionId, actorId)
  };
}

function s3ConnectionDriver(service) {
  return {
    list: (workspaceId) => service.list(workspaceId),
    create: (workspaceId, actorId, input) => service.create(workspaceId, actorId, input),
    test: (workspaceId, actorId, connectionId, location) => service.test(workspaceId, actorId, connectionId, location),
    remove: (workspaceId, actorId, connectionId, revision) => service.remove(workspaceId, actorId, connectionId, revision)
  };
}

function createBuiltInStorageBackendRegistry({ localService, sftpService, s3Service, localConnectionService, sshConnectionService, s3ConnectionService } = {}) {
  const registry = new StorageBackendRegistry();
  registry.register({
    apiVersion: 1,
    backendId: LOCAL_BACKEND_ID,
    version: LOCAL_BACKEND_VERSION,
    displayName: 'Local folder',
    description: 'Store backups in a folder available to this device.',
    icon: 'folder-open',
    connection: { required: true, adapterIds: [LOCAL_CONNECTION_ADAPTER_ID], fields: [], creation: { mode: 'automatic' } },
    location: {
      label: 'Folder',
      fields: [{ id: 'rootPath', label: 'Folder', type: 'path', placeholder: 'Choose a folder' }]
    },
    capabilities: { capacityReporting: true, immutability: false, sharedConnection: true }
  }, repositoryDriver(requireService(localService, 'Local storage service'), (input) => ({
    name: input.name,
    connectionId: input.connectionId,
    rootPath: input.location?.rootPath ?? input.rootPath,
    storagePolicy: input.storagePolicy
  })), localConnectionDriver(requireService(localConnectionService, 'Local connection service')));

  registry.register({
    apiVersion: 1,
    backendId: SFTP_BACKEND_ID,
    version: SFTP_BACKEND_VERSION,
    displayName: 'SFTP',
    description: 'Store backups on a reusable SSH server connection.',
    icon: 'server',
    connection: {
      required: true,
      adapterIds: [SSH_CONNECTION_ADAPTER_ID],
      creation: { mode: 'external', handlerId: 'ssh' },
      fields: [
        { id: 'name', label: 'Connection name', type: 'text' },
        { id: 'host', label: 'Host', type: 'text' },
        { id: 'port', label: 'Port', type: 'number', defaultValue: 22 },
        { id: 'username', label: 'Username', type: 'text' },
        { id: 'authType', label: 'Authentication', type: 'select', options: [{ value: 'password', label: 'Password' }, { value: 'private-key', label: 'Private key' }] },
        { id: 'credential', label: 'Credential', type: 'secret' }
      ]
    },
    location: {
      label: 'Remote folder',
      fields: [{ id: 'rootPath', label: 'Remote folder', type: 'path', placeholder: '/srv/backups' }]
    },
    capabilities: { capacityReporting: true, immutability: false, sharedConnection: true }
  }, repositoryDriver(requireService(sftpService, 'SFTP storage service'), (input) => ({
    name: input.name,
    connectionId: input.connectionId,
    rootPath: input.location?.rootPath ?? input.rootPath,
    storagePolicy: input.storagePolicy
  })), sshConnectionDriver(requireService(sshConnectionService, 'SSH connection service')));

  registry.register({
    apiVersion: 1,
    backendId: S3_BACKEND_ID,
    version: S3_BACKEND_VERSION,
    displayName: 'S3-compatible storage',
    description: 'Store backups in S3, Wasabi, Backblaze B2, or another compatible service.',
    icon: 'cloud',
    connection: {
      required: true,
      adapterIds: [S3_CONNECTION_ADAPTER_ID],
      creation: { mode: 'form' },
      fields: [
        { id: 'name', label: 'Connection name', type: 'text' },
        { id: 'endpoint', label: 'Endpoint', type: 'text', required: false, placeholder: 'Default AWS endpoint' },
        { id: 'accessKeyId', label: 'Access key ID', type: 'text' },
        { id: 'secretAccessKey', label: 'Secret access key', type: 'secret' },
        { id: 'sessionToken', label: 'Session token', type: 'secret', required: false },
        { id: 'forcePathStyle', label: 'Use path-style requests', type: 'boolean', required: false, defaultValue: false },
        { id: 'allowInsecureEndpoint', label: 'Allow HTTP endpoint', type: 'boolean', required: false, defaultValue: false }
      ]
    },
    location: {
      label: 'Bucket location',
      fields: [
        { id: 'region', label: 'Region', type: 'text', defaultValue: 'us-east-1' },
        { id: 'bucket', label: 'Bucket', type: 'text' },
        { id: 'prefix', label: 'Prefix', type: 'path', required: false, placeholder: 'team/production' }
      ]
    },
    capabilities: { capacityReporting: false, immutability: true, sharedConnection: true }
  }, repositoryDriver(requireService(s3Service, 'S3 storage service'), (input) => ({
    name: input.name,
    connectionId: input.connectionId,
    endpoint: input.connection?.endpoint ?? input.endpoint,
    accessKeyId: input.connection?.accessKeyId ?? input.accessKeyId,
    secretAccessKey: input.connection?.secretAccessKey ?? input.secretAccessKey,
    sessionToken: input.connection?.sessionToken ?? input.sessionToken,
    forcePathStyle: input.connection?.forcePathStyle ?? input.forcePathStyle,
    allowInsecureEndpoint: input.connection?.allowInsecureEndpoint ?? input.allowInsecureEndpoint,
    region: input.location?.region ?? input.region,
    bucket: input.location?.bucket ?? input.bucket,
    prefix: input.location?.prefix ?? input.prefix,
    storagePolicy: input.storagePolicy
  })), s3ConnectionDriver(requireService(s3ConnectionService, 'S3 connection service')));
  return registry;
}

module.exports = {
  S3_CONNECTION_ADAPTER_ID,
  createBuiltInStorageBackendRegistry
};
