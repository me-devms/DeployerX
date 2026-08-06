const test = require('node:test');
const assert = require('node:assert/strict');
const { cloudProfileDocument, cloudOnlyProfile, mergeCloudProfiles, normalizeCloudProfileDocument } = require('./cloud-metadata');

function profile(overrides = {}) {
  return {
    id: 'profile-a', revision: 3, name: 'Orders', driverId: 'postgresql', endpoint: { kind: 'network', host: 'db.example.test', port: 5432 },
    database: 'orders', defaultSchema: 'public', environment: 'production', accessMode: 'read-write', tags: ['team'], ssl: { mode: 'disabled' }, tunnel: { type: 'none' },
    credentialSlots: [{ id: 'password', type: 'password', label: 'Password', required: false }], credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-local' }], settings: { username: 'app' }, ...overrides
  };
}

test('cloud profile projection excludes credential references and preserves endpoint policy', () => {
  const document = cloudProfileDocument(profile(), { revision: 7 });
  assert.equal(document.profileId, 'profile-a');
  assert.equal(document.revision, 7);
  assert.equal(document.metadata.credentialSecretRefs, undefined);
  assert.equal(document.metadata.settings, undefined);
  assert.equal(document.metadata.startupScript, undefined);
  assert.equal(document.metadata.queryTimeoutMs, undefined);
  assert.equal(document.metadata.endpoint.host, 'db.example.test');
});

test('removes API query and fragment data from cloud endpoint metadata', () => {
  const document = cloudProfileDocument(profile({
    driverId: 'rest-api',
    endpoint: { kind: 'api', baseUrl: 'https://api.example.test/v1/?token=device-only#private' },
    database: null,
    defaultSchema: null
  }));
  assert.equal(document.metadata.endpoint.baseUrl, 'https://api.example.test/v1/');
});

test('accepts only the exact cloud-safe document and nested metadata schema', () => {
  const document = cloudProfileDocument(profile(), { revision: 7 });
  const normalized = normalizeCloudProfileDocument({
    ...document,
    id: 'profile-a',
    __path: 'projects/test/databases/(default)/documents/teams/team-a/databaseProfiles/profile-a',
    __createTime: '2026-08-05T00:00:00Z',
    __updateTime: '2026-08-06T00:00:00Z'
  });
  assert.deepEqual(Object.keys(normalized.metadata).sort(), Object.keys(document.metadata).sort());
  assert.equal(normalized.id, undefined);
  assert.equal(normalized.__path, undefined);
  assert.equal(normalized.__createTime, undefined);
  assert.equal(normalized.__updateTime, undefined);
  assert.equal(normalized.metadata.settings, undefined);
  assert.throws(() => normalizeCloudProfileDocument({ ...document, revision: '7' }), /revision is invalid/);
  assert.throws(() => normalizeCloudProfileDocument({ ...document, id: 'other-profile' }), /transport identity is invalid/);
  assert.throws(() => normalizeCloudProfileDocument({ ...document, __path: 'teams/team-a/databaseProfiles/other-profile' }), /transport path is invalid/);
  assert.throws(() => normalizeCloudProfileDocument({ ...document, credentialBindings: [] }), /document schema is invalid/);
  assert.throws(() => normalizeCloudProfileDocument({ ...document, metadata: { ...document.metadata, settings: { region: 'device-only' } } }), /metadata schema is invalid/);
  assert.throws(() => normalizeCloudProfileDocument({ ...document, metadata: { ...document.metadata, endpoint: { ...document.metadata.endpoint, connectionUri: 'postgres://secret' } } }), /endpoint schema is invalid/);
  assert.throws(() => normalizeCloudProfileDocument({ ...document, metadata: { ...document.metadata, credentialSlots: [{ ...document.metadata.credentialSlots[0], password: 'secret' }] } }), /credential slot schema is invalid/);
  assert.throws(() => normalizeCloudProfileDocument({ ...document, metadata: { ...document.metadata, tags: [{ token: 'secret' }] } }), /tags are invalid/);
});

test('cloud-only profiles expose explicit driver and credential setup states', () => {
  const cloud = cloudOnlyProfile(cloudProfileDocument(profile({ id: 'shared', driverId: 'mongo' })), { installedDrivers: new Set() });
  assert.equal(cloud.cloudOnly, true);
  assert.equal(cloud.driverState, 'required');
  assert.equal(cloud.credentialState, 'required');
});

test('cloud metadata merges shared profiles without replacing local credentials', () => {
  const local = profile();
  const merged = mergeCloudProfiles([local], [cloudProfileDocument({ ...local, revision: 4, name: 'Cloud name' })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'Orders');
  assert.equal(merged[0].cloudRevision, 4);
  assert.deepEqual(merged[0].credentialSecretRefs, local.credentialSecretRefs);
});
