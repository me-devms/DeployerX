const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { CLOUD_DOCUMENT_KEYS, CLOUD_METADATA_KEYS } = require('./cloud-metadata');

const rulesPath = path.join(__dirname, '..', '..', 'firestore.rules');
const firebaseConfigPath = path.join(__dirname, '..', '..', 'firebase.database-manager.json');
const packagePath = path.join(__dirname, '..', '..', 'package.json');
const emulatorRunnerPath = path.join(__dirname, 'firestore-rules-emulator.js');

async function rulesSource() {
  return fs.readFile(rulesPath, 'utf8');
}

async function jsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function sourceBlock(source, startPattern, endPattern) {
  const start = source.search(startPattern);
  assert.notEqual(start, -1);
  const remainder = source.slice(start);
  const end = remainder.search(endPattern);
  assert.notEqual(end, -1);
  return remainder.slice(0, end);
}

test('authorizes profile reads without dereferencing write-only request resources', async () => {
  const source = await rulesSource();
  const profileMatch = sourceBlock(source, /match \/databaseProfiles\/\{profileId\}/, /\n\s{6}\}/);
  assert.match(profileMatch, /allow read: if isTeamMember\(teamId\);/);
  const readRule = profileMatch.match(/allow read:[^;]+;/)?.[0] || '';
  assert.doesNotMatch(readRule, /request\.resource/);
  assert.doesNotMatch(profileMatch, /allow read, create/);
});

test('guards profile creates and updates with exact schema and monotonic revisions', async () => {
  const source = await rulesSource();
  const profileMatch = sourceBlock(source, /match \/databaseProfiles\/\{profileId\}/, /\n\s{6}\}/);
  assert.match(profileMatch, /allow create:[\s\S]*validDatabaseProfileDocument\(profileId\)[\s\S]*revision >= 1;/);
  assert.match(profileMatch, /allow update:[\s\S]*validDatabaseProfileDocument\(profileId\)[\s\S]*revision == resource\.data\.revision \+ 1;/);
  const documentContract = sourceBlock(source, /function validDatabaseProfileDocument\(profileId\)/, /\n\s{4}\}/);
  const metadataContract = sourceBlock(source, /function validDatabaseProfileMetadata\(metadata\)/, /\n\s{4}\}/);
  for (const key of CLOUD_DOCUMENT_KEYS) assert.match(documentContract, new RegExp(`'${key}'`));
  for (const key of CLOUD_METADATA_KEYS) assert.match(metadataContract, new RegExp(`'${key}'`));
  assert.match(documentContract, /keys\(\)\.hasAll/);
  assert.match(documentContract, /keys\(\)\.hasOnly/);
  assert.match(metadataContract, /keys\(\)\.hasAll/);
  assert.match(metadataContract, /keys\(\)\.hasOnly/);
});

test('bounds nested credential slots and strips excluded local profile fields from rules', async () => {
  const source = await rulesSource();
  const metadataContract = sourceBlock(source, /function validDatabaseProfileMetadata\(metadata\)/, /\n\s{4}\}/);
  assert.match(metadataContract, /metadata\.tags is list/);
  assert.match(metadataContract, /metadata\.tags\.size\(\) <= 50/);
  const slotsContract = sourceBlock(source, /function validDatabaseCredentialSlots\(slots\)/, /\n\s{4}\}/);
  assert.match(slotsContract, /slots\.size\(\) <= 20/);
  for (let index = 0; index < 20; index += 1) assert.match(slotsContract, new RegExp(`validDatabaseCredentialSlotAt\\(slots, ${index}\\)`));
  for (const excluded of ['settings', 'startupScript', 'queryTimeoutMs', 'credentialBindings', 'credentialSecretRefs', 'localResource']) {
    assert.doesNotMatch(metadataContract, new RegExp(`'${excluded}'`));
  }
  assert.match(source, /endpoint\.baseUrl\.matches\('\^\[\^\?\#\]\+\$'\)/);
});

test('keeps the Firestore acceptance emulator isolated and bound to the Database Manager rules', async () => {
  const [config, packageManifest] = await Promise.all([
    jsonFile(firebaseConfigPath),
    jsonFile(packagePath)
  ]);
  assert.deepEqual(config.firestore, { rules: 'firestore.rules' });
  assert.deepEqual(config.emulators.firestore, { host: '127.0.0.1', port: 8180 });
  assert.deepEqual(config.emulators.ui, { enabled: false });
  assert.equal(config.emulators.singleProjectMode, true);
  assert.equal(
    packageManifest.scripts['database-firestore:accept'],
    'firebase emulators:exec --config firebase.database-manager.json --only firestore --project demo-deployerx-database-manager "node --test src/database-manager/firestore-rules-emulator.js"'
  );
});

test('keeps the emulator acceptance runner authorization and revision matrix intact', async () => {
  const source = await fs.readFile(emulatorRunnerPath, 'utf8');
  assert.match(source, /initializeTestEnvironment\(/);
  assert.match(source, /FIRESTORE_EMULATOR_HOST/);
  assert.match(source, /authenticatedContext\('owner-user'\)/);
  assert.match(source, /authenticatedContext\('member-user'\)/);
  assert.match(source, /authenticatedContext\('stranger-user'\)/);
  assert.match(source, /unauthenticatedContext\(\)/);
  assert.match(source, /assertSucceeds\(getDocs\(profiles\)\)/);
  assert.match(source, /assertFails\(getDoc\(profilePath\(stranger,/);
  assert.match(source, /assertFails\(getDoc\(profilePath\(anonymous,/);
  assert.match(source, /profile-revision-zero/);
  assert.match(source, /profile-path-mismatch/);
  assert.match(source, /profile-extra-document/);
  assert.match(source, /profile-settings/);
  assert.match(source, /profile-slot-secret/);
  assert.match(source, /profile-api-query/);
  assert.match(source, /Stale write/);
  assert.match(source, /Skipped revision/);
  assert.match(source, /assertFails\(deleteDoc\(profilePath\(stranger,/);
  assert.match(source, /assertSucceeds\(deleteDoc\(profilePath\(member,/);
});
