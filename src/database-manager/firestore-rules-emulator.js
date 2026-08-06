const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} = require('@firebase/rules-unit-testing');
const {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc
} = require('firebase/firestore');

const PROJECT_ID = 'demo-deployerx-database-manager';
const TEAM_ID = 'team-database-manager';
const RULES_PATH = path.join(__dirname, '..', '..', 'firestore.rules');

function emulatorAddress() {
  const value = String(process.env.FIRESTORE_EMULATOR_HOST || '').trim();
  const separator = value.lastIndexOf(':');
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('FIRESTORE_EMULATOR_HOST is invalid.');
  return Object.freeze({ host, port });
}

function metadata(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'Orders',
    driverId: 'postgresql',
    sharedConnectionId: null,
    projectId: null,
    endpoint: { kind: 'network', host: 'db.example.test', port: 5432 },
    database: 'orders',
    defaultSchema: 'public',
    environment: 'production',
    accessMode: 'read-write',
    tags: ['orders', 'production'],
    ssl: { mode: 'verify-full', caPathRequired: true, clientCertificateRequired: false },
    tunnel: { type: 'none' },
    credentialSlots: [{ id: 'password', type: 'password', required: true, label: 'Password' }],
    appearance: { icon: null, accentColor: '#167d5a' },
    ...overrides
  };
}

function profile(profileId, revision = 1, metadataOverrides = {}) {
  return {
    schemaVersion: 1,
    profileId,
    revision,
    metadata: metadata(metadataOverrides),
    updatedAt: `2026-08-06T00:00:0${Math.min(revision, 9)}.000Z`,
    deletedAt: null
  };
}

test('enforces Database Manager profile authorization and schema in the Firestore emulator', async () => {
  const { host, port } = emulatorAddress();
  const environment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host, port, rules: fs.readFileSync(RULES_PATH, 'utf8') }
  });
  try {
    await environment.withSecurityRulesDisabled(async (context) => {
      const database = context.firestore();
      await setDoc(doc(database, 'teams', TEAM_ID), { ownerUid: 'owner-user' });
      await setDoc(doc(database, 'teams', TEAM_ID, 'members', 'owner-user'), { uid: 'owner-user', role: 'owner' });
      await setDoc(doc(database, 'teams', TEAM_ID, 'members', 'member-user'), { uid: 'member-user', role: 'member' });
    });

    const owner = environment.authenticatedContext('owner-user').firestore();
    const member = environment.authenticatedContext('member-user').firestore();
    const stranger = environment.authenticatedContext('stranger-user').firestore();
    const anonymous = environment.unauthenticatedContext().firestore();
    const profiles = collection(member, 'teams', TEAM_ID, 'databaseProfiles');
    const profilePath = (database, profileId) => doc(database, 'teams', TEAM_ID, 'databaseProfiles', profileId);

    await assertSucceeds(setDoc(profilePath(owner, 'profile-owner'), profile('profile-owner')));
    await assertSucceeds(getDocs(profiles));
    await assertSucceeds(getDoc(profilePath(member, 'profile-owner')));
    await assertFails(getDoc(profilePath(stranger, 'profile-owner')));
    await assertFails(getDoc(profilePath(anonymous, 'profile-owner')));

    await assertSucceeds(setDoc(profilePath(member, 'profile-member'), profile('profile-member')));
    await assertFails(setDoc(profilePath(member, 'profile-revision-zero'), profile('profile-revision-zero', 0)));
    await assertFails(setDoc(profilePath(member, 'profile-path-mismatch'), profile('different-profile')));
    await assertFails(setDoc(profilePath(member, 'profile-extra-document'), { ...profile('profile-extra-document'), credentialBindings: [] }));
    await assertFails(setDoc(profilePath(member, 'profile-settings'), profile('profile-settings', 1, { settings: { region: 'device-only' } })));
    await assertFails(setDoc(profilePath(member, 'profile-slot-secret'), profile('profile-slot-secret', 1, {
      credentialSlots: [{ id: 'password', type: 'password', required: true, label: 'Password', password: 'must-not-store' }]
    })));
    await assertFails(setDoc(profilePath(member, 'profile-api-query'), profile('profile-api-query', 1, {
      endpoint: { kind: 'api', baseUrl: 'https://api.example.test/v1?token=must-not-store' }
    })));
    await assertFails(setDoc(profilePath(stranger, 'profile-stranger'), profile('profile-stranger')));

    await assertSucceeds(setDoc(profilePath(member, 'profile-member'), profile('profile-member', 2, { name: 'Orders primary' })));
    await assertFails(setDoc(profilePath(member, 'profile-member'), profile('profile-member', 2, { name: 'Stale write' })));
    await assertFails(setDoc(profilePath(member, 'profile-member'), profile('profile-member', 4, { name: 'Skipped revision' })));
    await assertFails(setDoc(profilePath(stranger, 'profile-member'), profile('profile-member', 3, { name: 'Unauthorized write' })));

    await assertFails(deleteDoc(profilePath(stranger, 'profile-member')));
    await assertSucceeds(deleteDoc(profilePath(member, 'profile-member')));
  } finally {
    await environment.cleanup();
  }
});
