const assert = require('node:assert/strict');
const test = require('node:test');

const { sanitizeFirebaseConfigForRuntime, validateFirebaseConfig } = require('./firebase-config');

const validConfig = {
  apiKey: 'AIzaSyExampleKeyThatIsLongEnoughForFirebase',
  authDomain: 'deployerx.firebaseapp.com',
  projectId: 'deployerx',
  googleClientId: '123456789012-example.apps.googleusercontent.com',
  googleRedirectUri: 'http://127.0.0.1:42813/oauth/google'
};

test('accepts a complete desktop authentication configuration', () => {
  assert.deepEqual(validateFirebaseConfig(validConfig, { requireGoogle: true }).errors, []);
});

test('rejects the public example placeholders used by the broken release', () => {
  const result = validateFirebaseConfig({
    apiKey: 'YOUR_FIREBASE_WEB_API_KEY',
    projectId: 'YOUR_PROJECT_ID',
    googleClientId: 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com'
  }, { requireGoogle: true });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /apiKey contains a placeholder/);
  assert.match(result.errors.join(' '), /projectId contains a placeholder/);
  assert.match(result.errors.join(' '), /googleClientId contains a placeholder/);
});

test('rejects non-local OAuth redirect URLs', () => {
  const result = validateFirebaseConfig({
    ...validConfig,
    googleRedirectUri: 'https://example.com/oauth/google'
  }, { requireGoogle: true });

  assert.match(result.errors.join(' '), /must use http:\/\/127\.0\.0\.1 or http:\/\/localhost/);
});

test('keeps email login configured when only Google OAuth values are invalid', () => {
  const config = sanitizeFirebaseConfigForRuntime({
    ...validConfig,
    googleClientId: 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com'
  });

  assert.equal(config.apiKey, validConfig.apiKey);
  assert.equal(config.projectId, validConfig.projectId);
  assert.equal(config.googleClientId, '');
});
