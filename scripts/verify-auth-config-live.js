'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertFirebaseConfig } = require('../src/firebase-config');

const configPath = path.resolve(process.argv[2] || 'firebase.config.json');
const config = assertFirebaseConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')), { requireGoogle: true });

async function verifyFirebaseAuth() {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `deployerx-release-preflight-${Date.now()}@example.invalid`,
      password: 'DeployerXReleasePreflightOnly1!',
      returnSecureToken: true
    })
  });
  const body = await response.text();
  let code = '';
  try {
    code = JSON.parse(body)?.error?.message || '';
  } catch {
    // The status below will report a sanitized failure without response details.
  }
  if (response.ok || /INVALID_(LOGIN_CREDENTIALS|PASSWORD)|EMAIL_NOT_FOUND/.test(code)) return;
  throw new Error(`Firebase email/password preflight failed: ${code || `HTTP_${response.status}`}`);
}

async function verifyGoogleOAuth() {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', config.googleClientId);
  authUrl.searchParams.set('redirect_uri', config.googleRedirectUri || 'http://127.0.0.1:42813/oauth/google');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', 'deployerx-release-preflight');
  authUrl.searchParams.set('code_challenge', '0'.repeat(43));
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const response = await fetch(authUrl, { redirect: 'follow' });
  const body = await response.text();
  const explicitClientError = response.url.includes('/signin/oauth/error') || /invalid_client|OAuth client was not found/i.test(body);
  if (explicitClientError) throw new Error('Google OAuth preflight failed: invalid_client.');
  if (/redirect_uri_mismatch/i.test(body)) throw new Error('Google OAuth preflight failed: redirect_uri_mismatch.');
  if (!response.ok) throw new Error(`Google OAuth preflight failed: HTTP_${response.status}`);
}

Promise.all([verifyFirebaseAuth(), verifyGoogleOAuth()])
  .then(() => console.log('Firebase Authentication and Google OAuth live preflight passed.'))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
