const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { TabulariumClient, driverManifest, entrypointForPlatform, parseRepositoryUrl, targetFromAsset } = require('./tabularium-client');

function response(value) { return { ok: true, json: async () => structuredClone(value) }; }

test('maps approved registry releases into bounded driver catalog entries', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/api/plugins?')) return response({ plugins: [{ id: 'csv', name: 'CSV', latestVersion: '1.0.0', status: 'approved' }] });
    if (url.endsWith('/api/plugins/csv')) return response({ id: 'csv', name: 'CSV', description: 'CSV folder', latestVersion: '1.0.0', status: 'approved', repoUrl: 'https://github.com/example/csv', extensions: {}, releases: [{ version: '1.0.0', integrity: { jws: 'eyJhbGciOiJFZERTQSIsImtpZCI6ImtleS0xIn0.e30.c2ln', assets: [{ name: 'csv.zip', size: 12, sha256: 'a'.repeat(64) }], manifest_raw: JSON.stringify({ name: 'CSV', version: '1.0.0', executable: 'plugin.py', capabilities: { folder_based: true, readonly: true, sql_dialect: 'sqlite', identifier_quote: '"' } }) } }] });
    if (url.includes('/releases/tags/')) return response({ assets: [{ name: 'csv.zip', browser_download_url: 'https://example.test/csv.zip' }] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const catalog = await new TabulariumClient({ fetchImpl }).loadCatalog();
  assert.equal(catalog.releases.length, 1);
  assert.equal(catalog.releases[0].entrypoint, 'plugin.py');
  assert.deepEqual(catalog.releases[0].target.architectures, ['universal']);
  assert.equal(catalog.releases[0].driverManifest.capabilities.folderBased, true);
  assert.equal(catalog.releases[0].driverManifest.capabilities.schemas, true);
  assert.equal(catalog.releases[0].driverManifest.capabilities.crud, false);
  assert.equal(catalog.releases[0].driverManifest.sqlDialect, 'sqlite');
  assert.equal(catalog.releases[0].driverManifest.identifierQuote, '"');
});

test('retains approved plugins whose current release cannot be resolved', async () => {
  const client = new TabulariumClient({ fetchImpl: async (url) => {
    if (url.includes('/api/plugins?')) return response({ plugins: [{ id: 'missing', name: 'Missing', latestVersion: '2.0.0', status: 'approved' }] });
    return response({ id: 'missing', name: 'Missing', latestVersion: '2.0.0', status: 'approved', releases: [] });
  } });
  const catalog = await client.loadCatalog();
  assert.equal(catalog.releases.length, 0);
  assert.equal(catalog.unavailable[0].pluginId, 'missing');
  assert.match(catalog.unavailable[0].unavailableReason, /signed driver asset/i);
});

test('verifies registry Ed25519 JWS identity and exact asset integrity', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'key-1' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ v: 1, kid: 'key-1', registry: 'https://registry.tabularis.dev', plugin_slug: 'csv', release_version: '1.0.0', manifest_sha256: 'c'.repeat(64), assets: [{ name: 'csv.zip', size: 12, sha256: 'a'.repeat(64) }] })).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
  const client = new TabulariumClient({ fetchImpl: async () => response({ keys: [{ ...publicJwk, kid: 'key-1', alg: 'EdDSA' }] }) });
  const release = { pluginId: 'csv', version: '1.0.0', manifestSha256: 'c'.repeat(64), archive: { name: 'csv.zip', size: 12, sha256: 'a'.repeat(64) }, signature: { value: `${header}.${claims}` + `.${signature}` } };
  assert.equal(await client.verifyRelease(release), true);
  assert.equal(await client.verifyRelease({ ...release, archive: { ...release.archive, sha256: 'b'.repeat(64) } }), false);
  assert.equal(await client.verifyRelease({ ...release, manifestSha256: 'd'.repeat(64) }), false);
});

test('normalizes repository, target, and credential metadata', () => {
  assert.deepEqual(parseRepositoryUrl('https://github.com/example/plugin.git'), { host: 'github.com', owner: 'example', repository: 'plugin' });
  assert.deepEqual(targetFromAsset('driver-windows-x64.zip', 'driver.exe'), { platforms: ['win32'], architectures: ['x64'] });
  assert.equal(entrypointForPlatform('bin/driver', 'driver-windows-x64.zip', 'win32'), 'bin/driver.exe');
  assert.equal(entrypointForPlatform('bin/driver', 'driver-linux-x64.zip', 'linux'), 'bin/driver');
  assert.equal(entrypointForPlatform('plugin.py', 'plugin.zip', 'win32'), 'plugin.py');
  const manifest = driverManifest({ id: 'mongo', name: 'Mongo', latestVersion: '1.0.0', extensions: { default_port: 27017 } }, { capabilities: { connection_uri: true } });
  assert.equal(manifest.credentialSlots[0].id, 'connection-uri');
  const exampleManifest = driverManifest({ id: 'elastic', name: 'Elasticsearch', latestVersion: '1.0.0', extensions: {} }, { capabilities: { no_connection_required: true, connection_string_example: 'http://localhost:9200' } });
  assert.deepEqual(exampleManifest.credentialSlots[0], { id: 'connection-uri', type: 'connection-uri', label: 'Connection URI', required: true });
  assert.equal(exampleManifest.capabilities.crud, false);
  assert.equal(driverManifest({ id: 'explicit-write', latestVersion: '1.0.0', extensions: {} }, { capabilities: { crud: true } }).capabilities.crud, true);
  const db2Manifest = driverManifest({ id: 'db2', name: 'Db2', latestVersion: '0.0.2', extensions: { default_port: 50000 } }, {
    capabilities: { connection_string: true },
    settings: [{ key: 'driver_name', label: 'Driver name' }, { key: 'extra_properties', label: 'Extra properties' }]
  });
  assert.deepEqual(db2Manifest.credentialSlots.map((slot) => slot.id), ['extra-properties', 'connection-uri']);
  assert.deepEqual(db2Manifest.settings.fields.map((field) => field.key), ['driver_name']);
});
