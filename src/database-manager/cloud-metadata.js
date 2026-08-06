const { projectProfileForCloud, normalizeProfileInput } = require('./domain');

const CLOUD_PROFILE_SCHEMA_VERSION = 1;
const CLOUD_DOCUMENT_KEYS = Object.freeze(['schemaVersion', 'profileId', 'revision', 'metadata', 'updatedAt', 'deletedAt']);
const CLOUD_TRANSPORT_KEYS = Object.freeze(['id', '__path', '__createTime', '__updateTime']);
const CLOUD_METADATA_KEYS = Object.freeze(['schemaVersion', 'name', 'driverId', 'sharedConnectionId', 'projectId', 'endpoint', 'database', 'defaultSchema', 'environment', 'accessMode', 'tags', 'ssl', 'tunnel', 'credentialSlots', 'appearance']);

function assertObjectShape(value, allowedKeys, requiredKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid.`);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !keys.includes(key))) throw new TypeError(`${label} schema is invalid.`);
}

function assertNestedCloudShape(metadata) {
  assertObjectShape(metadata, CLOUD_METADATA_KEYS, CLOUD_METADATA_KEYS, 'Cloud database profile metadata');
  const endpointKeys = metadata.endpoint?.kind === 'network' ? ['kind', 'host', 'port']
    : ['file', 'folder'].includes(metadata.endpoint?.kind) ? ['kind', 'localResourceRequired']
      : metadata.endpoint?.kind === 'api' ? ['kind', 'baseUrl'] : ['kind'];
  assertObjectShape(metadata.endpoint, endpointKeys, endpointKeys, 'Cloud database endpoint');
  assertObjectShape(metadata.ssl, ['mode', 'caPathRequired', 'clientCertificateRequired'], ['mode', 'caPathRequired', 'clientCertificateRequired'], 'Cloud database SSL metadata');
  const tunnelKeys = metadata.tunnel?.type === 'server' ? ['type', 'projectId'] : ['type'];
  assertObjectShape(metadata.tunnel, tunnelKeys, tunnelKeys, 'Cloud database tunnel metadata');
  assertObjectShape(metadata.appearance, ['icon', 'accentColor'], ['icon', 'accentColor'], 'Cloud database appearance metadata');
  if (!Array.isArray(metadata.tags) || metadata.tags.some((tag) => typeof tag !== 'string')) throw new TypeError('Cloud database profile tags are invalid.');
  if (!Array.isArray(metadata.credentialSlots)) throw new TypeError('Cloud database credential slots are invalid.');
  for (const slot of metadata.credentialSlots) {
    assertObjectShape(slot, ['id', 'type', 'required', 'label'], ['id', 'type', 'required', 'label'], 'Cloud database credential slot');
  }
  if (metadata.endpoint.kind === 'api' && metadata.endpoint.baseUrl) {
    const cloudUrl = new URL(metadata.endpoint.baseUrl);
    if (cloudUrl.search || cloudUrl.hash) throw new TypeError('Cloud database API endpoints must not contain query or fragment data.');
  }
}

function cloudProfileDocument(profile, { now = new Date().toISOString(), deletedAt = null, revision = profile?.revision } = {}) {
  const normalized = projectProfileForCloud(profile);
  const profileId = String(profile?.id || '').trim();
  if (!profileId || profileId.length > 200 || profileId.includes('\0')) throw new TypeError('Cloud database profile ID is invalid.');
  const cloudRevision = Number(revision || 0);
  if (!Number.isSafeInteger(cloudRevision) || cloudRevision < 0) throw new TypeError('Cloud database profile revision is invalid.');
  return Object.freeze({
    schemaVersion: CLOUD_PROFILE_SCHEMA_VERSION,
    profileId,
    revision: cloudRevision,
    metadata: normalized,
    updatedAt: String(profile.updatedAt || now),
    deletedAt: deletedAt || null
  });
}

function normalizeCloudProfileDocument(input = {}, { allowLegacyLocalFields = false } = {}) {
  assertObjectShape(input, [...CLOUD_DOCUMENT_KEYS, ...CLOUD_TRANSPORT_KEYS], CLOUD_DOCUMENT_KEYS, 'Cloud database profile document');
  if (input.schemaVersion !== CLOUD_PROFILE_SCHEMA_VERSION) throw new TypeError('Cloud database profile schema version is invalid.');
  if (allowLegacyLocalFields) {
    if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) throw new TypeError('Cloud database profile metadata is invalid.');
  } else {
    assertNestedCloudShape(input.metadata);
  }
  const metadata = input.metadata;
  const profileId = String(input.profileId || '').trim();
  if (!profileId || profileId.length > 200 || profileId.includes('\0')) throw new TypeError('Cloud database profile ID is invalid.');
  if (input.id !== undefined && input.id !== profileId) throw new TypeError('Cloud database profile transport identity is invalid.');
  if (input.__path !== undefined && (typeof input.__path !== 'string' || !input.__path || input.__path.length > 4000 || input.__path.split('/').pop() !== profileId)) throw new TypeError('Cloud database profile transport path is invalid.');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new TypeError('Cloud database profile revision is invalid.');
  if (typeof input.updatedAt !== 'string' || !input.updatedAt || input.updatedAt.length > 100 || (input.deletedAt !== null && (typeof input.deletedAt !== 'string' || !input.deletedAt || input.deletedAt.length > 100))) throw new TypeError('Cloud database profile timestamps are invalid.');
  if (input.__createTime !== undefined && (typeof input.__createTime !== 'string' || !input.__createTime || input.__createTime.length > 100)) throw new TypeError('Cloud database profile transport timestamp is invalid.');
  if (input.__updateTime !== undefined && (typeof input.__updateTime !== 'string' || !input.__updateTime || input.__updateTime.length > 100)) throw new TypeError('Cloud database profile precondition metadata is invalid.');
  const profile = normalizeProfileInput({ ...metadata, id: profileId });
  const cloudMetadata = projectProfileForCloud({ ...profile, id: profileId });
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    profileId,
    revision: input.revision,
    metadata: cloudMetadata,
    updatedAt: String(input.updatedAt || ''),
    deletedAt: input.deletedAt ? String(input.deletedAt) : null
  });
}

function cloudOnlyProfile(document, { installedDrivers = new Set(), hasLocalResource = false } = {}) {
  const normalized = normalizeCloudProfileDocument(document);
  const profile = {
    ...normalized.metadata,
    id: normalized.profileId,
    revision: normalized.revision,
    cloudOnly: true,
    cloudUpdatedAt: normalized.updatedAt || null,
    deletedAt: normalized.deletedAt,
    credentialState: normalized.metadata.credentialSlots.length ? 'required' : 'ready',
    driverState: installedDrivers.has(normalized.metadata.driverId) ? 'ready' : 'required',
    localResource: ['file', 'folder'].includes(normalized.metadata.endpoint.kind)
      ? { bound: Boolean(hasLocalResource), required: true }
      : null
  };
  return Object.freeze(profile);
}

function mergeCloudProfiles(localProfiles = [], cloudDocuments = [], options = {}) {
  const local = new Map((Array.isArray(localProfiles) ? localProfiles : []).map((profile) => [String(profile.id), profile]));
  const merged = [];
  for (const raw of Array.isArray(cloudDocuments) ? cloudDocuments : []) {
    const document = normalizeCloudProfileDocument(raw);
    if (document.deletedAt) {
      local.delete(document.profileId);
      continue;
    }
    const existing = local.get(document.profileId);
    if (existing) {
      merged.push(Object.freeze({ ...existing, cloudUpdatedAt: document.updatedAt || null, cloudRevision: document.revision }));
      local.delete(document.profileId);
    } else {
      merged.push(cloudOnlyProfile(document, options));
    }
  }
  for (const profile of local.values()) merged.push(profile);
  return Object.freeze(merged);
}

module.exports = { CLOUD_DOCUMENT_KEYS, CLOUD_METADATA_KEYS, CLOUD_PROFILE_SCHEMA_VERSION, CLOUD_TRANSPORT_KEYS, assertNestedCloudShape, cloudProfileDocument, normalizeCloudProfileDocument, cloudOnlyProfile, mergeCloudProfiles };
