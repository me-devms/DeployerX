const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');
const { Client } = require('ssh2');

const STORE_FILE = 'projects.json';
const SETTINGS_FILE = 'settings.json';
const APP_ICON = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'deployerx-logo.ico' : 'deployerx-logo.png');
let mainWindow;
const activeDeployments = new Map();
const activeTerminals = new Map();
const activeFtpSessions = new Map();
const TEMPLATE_CATEGORIES = ['Server', 'Laravel', 'Node.js', 'Database', 'Docker', 'Maintenance'];
const FIREBASE_AUTH_URL = 'https://identitytoolkit.googleapis.com/v1';
const FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
const SECRET_PROBE = 'deployerx-team-secret-v1';
const SECRET_ITERATIONS = 210000;
let settingsCache = null;
let firebaseConfigCache = null;
let cloudUnlock = { teamId: '', key: null };
const pendingConfirmations = new Map();

function requestInAppConfirmation({ message, detail = '', confirmLabel = 'Confirm' }) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);

  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(id);
      resolve(false);
    }, 120000);

    pendingConfirmations.set(id, { resolve, timer });

    try {
      mainWindow.webContents.send('ui:confirm-request', { id, message, detail, confirmLabel });
    } catch {
      clearTimeout(timer);
      pendingConfirmations.delete(id);
      resolve(false);
    }
  });
}

ipcMain.handle('ui:confirm-response', async (_event, payload = {}) => {
  const pending = pendingConfirmations.get(payload.id);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingConfirmations.delete(payload.id);
  pending.resolve(Boolean(payload.confirmed));
  return true;
});

function normalizeTemplateCategory(category) {
  const value = String(category || '').trim();
  return TEMPLATE_CATEGORIES.includes(value) ? value : 'Server';
}

function normalizeStoredTemplate(template = {}) {
  const commands = Array.isArray(template.commands)
    ? template.commands.map((command) => String(command)).filter((command) => command.trim())
    : [];
  const variables =
    Array.isArray(template.variables) && template.variables.length
      ? template.variables.map((variable) => String(variable))
      : extractTemplateVariables(commands);

  return {
    ...template,
    category: normalizeTemplateCategory(template.category),
    commands,
    variables
  };
}

function getStorePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function getUserFirebaseConfigPath() {
  return path.join(app.getPath('userData'), 'firebase.config.json');
}

function defaultSettings() {
  return {
    setupComplete: false,
    mode: '',
    activeTeamId: '',
    auth: null
  };
}

async function readSettings() {
  if (settingsCache) return structuredClone(settingsCache);
  const settingsPath = getSettingsPath();
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    settingsCache = {
      ...defaultSettings(),
      ...JSON.parse(raw)
    };
  } catch {
    settingsCache = defaultSettings();
  }
  return structuredClone(settingsCache);
}

async function writeSettings(nextSettings) {
  settingsCache = {
    ...defaultSettings(),
    ...nextSettings
  };
  await fs.writeFile(getSettingsPath(), JSON.stringify(settingsCache, null, 2));
  return structuredClone(settingsCache);
}

async function saveFirebaseConfig(config) {
  const normalized = {
    apiKey: String(config.apiKey || '').trim(),
    authDomain: String(config.authDomain || '').trim(),
    projectId: String(config.projectId || config.project_id || '').trim(),
    googleClientId: String(config.googleClientId || config.googleOAuthClientId || '').trim(),
    googleClientSecret: String(config.googleClientSecret || config.googleOAuthClientSecret || '').trim(),
    googleRedirectUri: String(config.googleRedirectUri || '').trim()
  };
  if (!normalized.apiKey || !normalized.projectId) {
    throw new Error('Firebase Web config must include apiKey and projectId.');
  }
  if (!normalized.authDomain) normalized.authDomain = `${normalized.projectId}.firebaseapp.com`;
  await fs.writeFile(getUserFirebaseConfigPath(), JSON.stringify(normalized, null, 2));
  firebaseConfigCache = null;
  return firebaseConfigStatus();
}

async function ensureStore() {
  const storePath = getStorePath();
  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify({ projects: [] }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(getStorePath(), 'utf8');
  try {
    const data = JSON.parse(raw);
    return {
      projects: Array.isArray(data.projects) ? data.projects : [],
      templates: Array.isArray(data.templates) ? data.templates.map(normalizeStoredTemplate) : []
    };
  } catch {
    return { projects: [], templates: [] };
  }
}

async function writeStore(data) {
  await fs.writeFile(getStorePath(), JSON.stringify(data, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix = '') {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prefix ? `${prefix}-${id}` : id;
}

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

function publicSession(auth) {
  if (!auth) return null;
  return {
    uid: auth.uid,
    email: auth.email,
    displayName: auth.displayName || '',
    emailVerified: Boolean(auth.emailVerified),
    provider: auth.provider || ''
  };
}

async function loadFirebaseConfig({ refresh = false } = {}) {
  if (!refresh && firebaseConfigCache !== null) return firebaseConfigCache;

  const envConfig =
    process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID
      ? {
          apiKey: process.env.FIREBASE_API_KEY,
          authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
          projectId: process.env.FIREBASE_PROJECT_ID,
          googleClientId: process.env.FIREBASE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
          googleClientSecret: process.env.FIREBASE_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
          googleRedirectUri: process.env.FIREBASE_GOOGLE_REDIRECT_URI || '',
          source: 'environment'
        }
      : null;
  if (envConfig) {
    firebaseConfigCache = envConfig;
    return firebaseConfigCache;
  }

  const candidatePaths = [
    path.join(app.getAppPath(), 'firebase.config.json'),
    path.join(app.getAppPath(), '..', 'firebase.config.json'),
    path.join(__dirname, 'firebase.config.json'),
    path.join(path.dirname(app.getPath('exe')), 'firebase.config.json'),
    path.join(app.getPath('userData'), 'firebase.config.json')
  ];

  for (const configPath of candidatePaths) {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
      if (parsed.apiKey && parsed.projectId) {
        firebaseConfigCache = {
          apiKey: String(parsed.apiKey),
          authDomain: String(parsed.authDomain || ''),
          projectId: String(parsed.projectId),
          googleClientId: String(parsed.googleClientId || parsed.googleOAuthClientId || ''),
          googleClientSecret: String(parsed.googleClientSecret || parsed.googleOAuthClientSecret || ''),
          googleRedirectUri: String(parsed.googleRedirectUri || ''),
          source: configPath
        };
        return firebaseConfigCache;
      }
    } catch {
      // Config is optional; setup UI will explain when it is missing.
    }
  }

  firebaseConfigCache = null;
  return firebaseConfigCache;
}

async function firebaseConfigStatus() {
  const config = await loadFirebaseConfig({ refresh: true });
  return {
    configured: Boolean(config?.apiKey && config?.projectId),
    googleConfigured: Boolean(config?.googleClientId),
    projectId: config?.projectId || '',
    source: config?.source || ''
  };
}

function requireFirebaseConfig(config) {
  if (!config?.apiKey || !config?.projectId) {
    throw new Error('Firebase Web config is missing. Add firebase.config.json with apiKey and projectId.');
  }
}

function firebaseErrorMessage(errorBody) {
  const firstArrayError = Array.isArray(errorBody)
    ? errorBody.find((item) => item?.error)?.error
    : null;
  const message =
    firstArrayError?.message ||
    firstArrayError?.status ||
    errorBody?.error_description ||
    errorBody?.error?.message ||
    errorBody?.error ||
    errorBody?.raw ||
    '';
  const normalized = String(message).replace(/_/g, ' ').toLowerCase();
  if (normalized.includes('email exists')) return 'An account already exists for this email.';
  if (normalized.includes('invalid login credentials') || normalized.includes('invalid password')) return 'Invalid email or password.';
  if (normalized.includes('email not found')) return 'No account was found for this email.';
  if (normalized.includes('client secret') || normalized.includes('client authentication')) {
    return 'Google rejected the token exchange. Add googleClientSecret to firebase.config.json for this Web OAuth client, or switch to a Desktop OAuth client.';
  }
  if (normalized.includes('cloud firestore api has not been used') || normalized.includes('firestore.googleapis.com')) {
    return 'Cloud Firestore is not enabled for this Firebase project. Open Firebase Console > Firestore Database, create a database, then retry after a few minutes.';
  }
  if (normalized.includes('permission denied') || normalized.includes('missing or insufficient permissions')) {
    return 'Firestore permissions are blocking cloud data. Deploy the included firestore.rules to this Firebase project, then try again.';
  }
  return message ? `Firebase error: ${message}` : 'Firebase request failed.';
}

function isRecoverableCloudDataError(error) {
  const firstArrayError = Array.isArray(error?.body)
    ? error.body.find((item) => item?.error)?.error
    : null;
  const details = [
    error?.message,
    firstArrayError?.message,
    firstArrayError?.status,
    error?.body?.error_description,
    error?.body?.error?.message,
    error?.body?.error?.status,
    error?.body?.raw
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/_/g, ' ')
    .toLowerCase();

  return (
    error?.status === 403 ||
    details.includes('missing or insufficient permissions') ||
    details.includes('permission denied') ||
    details.includes('cloud firestore api has not been used') ||
    details.includes('firestore.googleapis.com')
  );
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error(firebaseErrorMessage(body));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function firebaseAuthRequest(action, payload) {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  return fetchJson(`${FIREBASE_AUTH_URL}/${action}?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function tryFirebaseHostingConfig(projectId) {
  if (!projectId) return null;
  const candidates = [
    `https://${projectId}.firebaseapp.com/__/firebase/init.json`,
    `https://${projectId}.web.app/__/firebase/init.json`
  ];
  for (const url of candidates) {
    try {
      const config = await fetchJson(url);
      if (config?.apiKey && config?.projectId) return config;
    } catch {
      // Hosting init config is optional and only works when Firebase Hosting is configured.
    }
  }
  return null;
}

function parseFirebaseConfigJson(parsed) {
  if (parsed?.apiKey && (parsed.projectId || parsed.project_id)) {
    return {
      apiKey: parsed.apiKey,
      authDomain: parsed.authDomain || '',
      projectId: parsed.projectId || parsed.project_id,
      googleClientId: parsed.googleClientId || parsed.googleOAuthClientId || '',
      googleClientSecret: parsed.googleClientSecret || parsed.googleOAuthClientSecret || '',
      googleRedirectUri: parsed.googleRedirectUri || ''
    };
  }

  if (parsed?.project_id && parsed?.client_email && parsed?.private_key) {
    return {
      adminProjectId: parsed.project_id
    };
  }

  return null;
}

function normalizeAuthSession(payload, displayName = '') {
  const expiresIn = Number(payload.expiresIn || 3600);
  return {
    uid: payload.localId || payload.user_id,
    email: payload.email || '',
    displayName,
    idToken: payload.idToken,
    refreshToken: payload.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - 60000,
    emailVerified: Boolean(payload.emailVerified),
    provider: payload.providerId || payload.providerUserInfo?.[0]?.providerId || ''
  };
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address()));
  });
}

async function requestGoogleTokens(config) {
  if (!config.googleClientId) {
    throw new Error('Google login needs googleClientId in firebase.config.json.');
  }

  const state = base64Url(crypto.randomBytes(18));
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  let settled = false;

  const redirectUri = config.googleRedirectUri || 'http://127.0.0.1:42813/oauth/google';
  const redirectUrl = new URL(redirectUri);
  if (redirectUrl.hostname !== '127.0.0.1' && redirectUrl.hostname !== 'localhost') {
    throw new Error('Google redirect URI must use localhost or 127.0.0.1 for desktop login.');
  }
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(redirectUrl.port || 80), redirectUrl.hostname, () => resolve());
  });

  const code = await new Promise((resolve, reject) => {
    let timeout = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else resolve(value);
    };

    server.on('request', (request, response) => {
      const url = new URL(request.url || '/', redirectUri);
      if (url.pathname !== '/oauth/google') {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end('<h1>Google login failed</h1><p>Invalid OAuth state.</p>');
        finish(new Error('Google login state did not match.'));
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end('<h1>Google login cancelled</h1><p>You can close this window.</p>');
        finish(new Error(`Google login failed: ${error}`));
        return;
      }

      const authCode = url.searchParams.get('code');
      if (!authCode) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end('<h1>Google login failed</h1><p>No authorization code was returned.</p>');
        finish(new Error('Google login did not return an authorization code.'));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<h1>Google login complete</h1><p>You can close this browser tab and return to DeployerX.</p>');
      finish(null, authCode);
    });

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', config.googleClientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'select_account');

    timeout = setTimeout(() => finish(new Error('Google login timed out. Please try again.')), 180000);
    shell.openExternal(authUrl.toString()).catch(finish);
  });

  const tokenBody = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  if (config.googleClientSecret) {
    tokenBody.set('client_secret', config.googleClientSecret);
  }

  return fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString()
  });
}

async function signInWithGoogle() {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  const googleTokens = await requestGoogleTokens(config);
  const credential =
    googleTokens.id_token
      ? `id_token=${encodeURIComponent(googleTokens.id_token)}&providerId=google.com`
      : `access_token=${encodeURIComponent(googleTokens.access_token)}&providerId=google.com`;

  const firebaseAuth = await firebaseAuthRequest('accounts:signInWithIdp', {
    postBody: credential,
    requestUri: 'http://localhost',
    returnIdpCredential: true,
    returnSecureToken: true
  });

  return normalizeAuthSession(firebaseAuth, firebaseAuth.displayName || '');
}

async function lookupAuthUser(auth) {
  if (!auth?.idToken) return auth;
  const lookup = await firebaseAuthRequest('accounts:lookup', { idToken: auth.idToken });
  const user = lookup?.users?.[0] || {};
  const provider = user.providerUserInfo?.[0]?.providerId || auth.provider || '';
  return {
    ...auth,
    email: user.email || auth.email || '',
    displayName: user.displayName || auth.displayName || '',
    emailVerified: Boolean(user.emailVerified),
    provider
  };
}

function needsEmailVerification(auth) {
  return Boolean(auth?.email && auth.provider !== 'google.com' && !auth.emailVerified);
}

async function refreshAuthSession(settings) {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  if (!settings.auth?.refreshToken) throw new Error('Login is required.');
  if (settings.auth.idToken && settings.auth.expiresAt > Date.now()) {
    const checkedAuth = await lookupAuthUser(settings.auth);
    await writeSettings({ ...settings, auth: checkedAuth });
    return checkedAuth;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: settings.auth.refreshToken
  });
  const refreshed = await fetchJson(`${FIREBASE_TOKEN_URL}?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const auth = normalizeAuthSession(
    {
      ...refreshed,
      localId: refreshed.user_id,
      idToken: refreshed.id_token,
      refreshToken: refreshed.refresh_token,
      expiresIn: refreshed.expires_in,
      email: settings.auth.email,
      emailVerified: settings.auth.emailVerified,
      provider: settings.auth.provider
    },
    settings.auth.displayName || ''
  );
  const checkedAuth = await lookupAuthUser(auth);
  await writeSettings({ ...settings, auth: checkedAuth });
  return checkedAuth;
}

async function requireAuthSession() {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') throw new Error('Cloud mode is not enabled.');
  const auth = await refreshAuthSession(settings);
  if (!auth?.idToken || !auth.uid) throw new Error('Login is required.');
  return auth;
}

async function firestoreBaseUrl() {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/(default)/documents`;
}

function encodePath(segments) {
  return segments.map((segment) => encodeURIComponent(String(segment))).join('/');
}

function displayFirestorePath(segments) {
  return segments.map((segment) => String(segment)).join('/');
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.entries(value).reduce((fields, [key, childValue]) => {
          fields[key] = toFirestoreValue(childValue);
          return fields;
        }, {})
      }
    };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if (!value || Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return value.timestampValue;
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    return (value.arrayValue.values || []).map(fromFirestoreValue);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) {
    return Object.entries(value.mapValue.fields || {}).reduce((object, [key, childValue]) => {
      object[key] = fromFirestoreValue(childValue);
      return object;
    }, {});
  }
  return null;
}

function toFirestoreDocument(data) {
  return {
    fields: Object.entries(data || {}).reduce((fields, [key, value]) => {
      if (String(key).startsWith('__')) return fields;
      fields[key] = toFirestoreValue(value);
      return fields;
    }, {})
  };
}

function fromFirestoreDocument(document) {
  const data = Object.entries(document?.fields || {}).reduce((object, [key, value]) => {
    object[key] = fromFirestoreValue(value);
    return object;
  }, {});
  const id = String(document?.name || '').split('/').pop();
  return {
    ...data,
    id: data.id || id,
    __path: document?.name || ''
  };
}

async function firestoreFetch(segments, options = {}) {
  const auth = await requireAuthSession();
  const baseUrl = await firestoreBaseUrl();
  const url = `${baseUrl}/${encodePath(segments)}`;
  try {
    return await fetchJson(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${auth.idToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    error.firestorePath = displayFirestorePath(segments);
    error.firestoreMethod = options.method || 'GET';
    if (error.status === 403 && !String(error.message || '').includes(error.firestorePath)) {
      error.message = `${error.message} Blocked ${error.firestoreMethod} ${error.firestorePath}.`;
    }
    throw error;
  }
}

async function getDoc(segments) {
  try {
    return fromFirestoreDocument(await firestoreFetch(segments));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function patchDoc(segments, data) {
  return fromFirestoreDocument(
    await firestoreFetch(segments, {
      method: 'PATCH',
      body: JSON.stringify(toFirestoreDocument(data))
    })
  );
}

async function deleteDoc(segments) {
  try {
    await firestoreFetch(segments, { method: 'DELETE' });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function listCollection(segments) {
  try {
    const body = await firestoreFetch(segments);
    return (body.documents || []).map(fromFirestoreDocument);
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

function firestoreDocumentId(document) {
  return String(document?.__path || '').split('/').pop() || document?.id;
}

async function deleteCollectionDocuments(segments) {
  const documents = await listCollection(segments);
  for (const document of documents) {
    await deleteDoc([...segments, firestoreDocumentId(document)]);
  }
}

async function deleteTeamMemberDocuments(teamId, ownerUid) {
  const members = await listCollection(['teams', teamId, 'members']);
  members.sort((left, right) => {
    const leftIsOwner = firestoreDocumentId(left) === ownerUid;
    const rightIsOwner = firestoreDocumentId(right) === ownerUid;
    return Number(leftIsOwner) - Number(rightIsOwner);
  });
  for (const member of members) {
    await deleteDoc(['teams', teamId, 'members', firestoreDocumentId(member)]);
  }
}

async function runFirestoreQuery(structuredQuery) {
  const auth = await requireAuthSession();
  const baseUrl = await firestoreBaseUrl();
  const body = await fetchJson(`${baseUrl}:runQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ structuredQuery })
  });
  return body.filter((row) => row.document).map((row) => fromFirestoreDocument(row.document));
}

function deriveTeamKey(passphrase, salt) {
  if (!String(passphrase || '').trim()) throw new Error('Team passphrase is required.');
  return crypto.pbkdf2Sync(String(passphrase), Buffer.from(salt, 'base64'), SECRET_ITERATIONS, 32, 'sha256');
}

function encryptWithKey(value, key) {
  if (!String(value || '')) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decryptWithKey(payload, key) {
  if (!payload?.data || !payload?.iv || !payload?.tag) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
}

function encryptedProbe(key) {
  return encryptWithKey(SECRET_PROBE, key);
}

function verifyTeamKey(team, key) {
  try {
    return decryptWithKey(team.secretProbe, key) === SECRET_PROBE;
  } catch {
    return false;
  }
}

async function ensureActiveTeamUnlocked() {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') return null;
  if (!settings.activeTeamId) throw new Error('Select or create a team before syncing data.');
  if (!cloudUnlock.key || cloudUnlock.teamId !== settings.activeTeamId) {
    throw new Error('Unlock this team with its passphrase before syncing data.');
  }
  return settings.activeTeamId;
}

async function readUserProfile(uid) {
  return (await getDoc(['users', uid])) || null;
}

async function writeUserProfile(auth, patch = {}) {
  const existing = (await readUserProfile(auth.uid)) || {};
  const profile = {
    ...existing,
    ...patch,
    uid: auth.uid,
    email: auth.email || existing.email || '',
    emailLower: emailKey(auth.email || existing.email),
    displayName: auth.displayName || existing.displayName || '',
    teams: Array.isArray(patch.teams) ? patch.teams : Array.isArray(existing.teams) ? existing.teams : [],
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso()
  };
  await patchDoc(['users', auth.uid], profile);
  return profile;
}

async function updateUserTeamRef(uid, teamRef) {
  const user = (await readUserProfile(uid)) || { uid, teams: [] };
  const teams = Array.isArray(user.teams) ? [...user.teams] : [];
  const index = teams.findIndex((item) => item.teamId === teamRef.teamId);
  if (index >= 0) teams[index] = { ...teams[index], ...teamRef };
  else teams.push(teamRef);
  await patchDoc(['users', uid], {
    ...user,
    teams,
    updatedAt: nowIso()
  });
}

async function removeUserTeamRef(uid, teamId) {
  const user = await readUserProfile(uid);
  if (!user) return;
  await patchDoc(['users', uid], {
    ...user,
    teams: (Array.isArray(user.teams) ? user.teams : []).filter((item) => item.teamId !== teamId),
    updatedAt: nowIso()
  });
}

async function currentMember(teamId) {
  const auth = await requireAuthSession();
  return getDoc(['teams', teamId, 'members', auth.uid]);
}

async function ensureTeamManager(teamId) {
  const member = await currentMember(teamId);
  if (!['owner', 'admin'].includes(member?.role)) throw new Error('Only team owners and admins can manage members.');
  return member;
}

function prepareCloudProjectForSave(project) {
  const copy = JSON.parse(JSON.stringify(project || {}));
  const ssh = { ...(copy.ssh || {}) };
  const encryptedSsh = {};
  for (const field of ['password', 'privateKey', 'passphrase']) {
    const encrypted = encryptWithKey(ssh[field], cloudUnlock.key);
    if (encrypted) encryptedSsh[field] = encrypted;
    ssh[field] = '';
  }
  return {
    ...copy,
    ssh,
    encryptedSsh,
    secretStorage: 'team-passphrase-v1'
  };
}

function prepareCloudProjectForRead(project) {
  const copy = JSON.parse(JSON.stringify(project || {}));
  const ssh = { ...(copy.ssh || {}) };
  if (copy.encryptedSsh && cloudUnlock.key) {
    for (const field of ['password', 'privateKey', 'passphrase']) {
      ssh[field] = decryptWithKey(copy.encryptedSsh[field], cloudUnlock.key);
    }
  }
  delete copy.encryptedSsh;
  delete copy.secretStorage;
  return {
    ...copy,
    ssh
  };
}

async function readCloudStore() {
  const teamId = await ensureActiveTeamUnlocked();
  const projects = await listCollection(['teams', teamId, 'projects']);
  const templates = await listCollection(['teams', teamId, 'templates']);
  return {
    projects: projects.map(prepareCloudProjectForRead),
    templates: templates.map(normalizeStoredTemplate)
  };
}

async function writeCloudStore(data) {
  const teamId = await ensureActiveTeamUnlocked();
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const templates = Array.isArray(data.templates) ? data.templates : [];
  const existingProjects = await listCollection(['teams', teamId, 'projects']);
  const existingTemplates = await listCollection(['teams', teamId, 'templates']);
  const nextProjectIds = new Set(projects.map((project) => String(project.id)));
  const nextTemplateIds = new Set(templates.map((template) => String(template.id)));

  for (const project of existingProjects) {
    if (!nextProjectIds.has(String(project.id))) {
      await deleteDoc(['teams', teamId, 'projects', project.id]);
    }
  }
  for (const template of existingTemplates) {
    if (!nextTemplateIds.has(String(template.id))) {
      await deleteDoc(['teams', teamId, 'templates', template.id]);
    }
  }

  for (const project of projects) {
    await patchDoc(['teams', teamId, 'projects', project.id], prepareCloudProjectForSave(project));
  }
  for (const template of templates) {
    await patchDoc(['teams', teamId, 'templates', template.id], normalizeStoredTemplate(template));
  }
}

async function mergeLocalStoreIntoCloud(localData) {
  const teamId = await ensureActiveTeamUnlocked();
  const projects = Array.isArray(localData.projects) ? localData.projects : [];
  const templates = Array.isArray(localData.templates) ? localData.templates : [];

  for (const project of projects) {
    await patchDoc(['teams', teamId, 'projects', project.id], prepareCloudProjectForSave(project));
  }
  for (const template of templates) {
    await patchDoc(['teams', teamId, 'templates', template.id], normalizeStoredTemplate(template));
  }
}

async function readCurrentStore() {
  const settings = await readSettings();
  return settings.mode === 'cloud' ? readCloudStore() : readStore();
}

async function writeCurrentStore(data) {
  const settings = await readSettings();
  if (settings.mode === 'cloud') return writeCloudStore(data);
  return writeStore(data);
}

async function deleteProjectFromCurrentStore(id) {
  const settings = await readSettings();
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await deleteDoc(['teams', teamId, 'projects', id]);
    return;
  }
  const data = await readStore();
  data.projects = data.projects.filter((project) => project.id !== id);
  await writeStore(data);
}

async function deleteTemplateFromCurrentStore(id) {
  const settings = await readSettings();
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await deleteDoc(['teams', teamId, 'templates', id]);
    return;
  }
  const data = await readStore();
  data.templates = data.templates.filter((template) => template.id !== id);
  await writeStore(data);
}

async function queryPendingInvites(email) {
  if (!email) return [];
  let invites = [];
  try {
    invites = await runFirestoreQuery({
      from: [{ collectionId: 'invites', allDescendants: true }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'emailLower' },
          op: 'EQUAL',
          value: { stringValue: emailKey(email) }
        }
      }
    });
  } catch {
    return [];
  }
  return invites
    .filter((invite) => invite.status === 'pending')
    .map((invite) => {
      const parts = String(invite.__path || '').split('/');
      const teamIndex = parts.indexOf('teams');
      return {
        ...invite,
        teamId: teamIndex >= 0 ? parts[teamIndex + 1] : invite.teamId
      };
    });
}

async function teamSnapshot() {
  const auth = await requireAuthSession();
  const settings = await readSettings();
  const profile = (await readUserProfile(auth.uid)) || (await writeUserProfile(auth));
  const teamRefs = Array.isArray(profile.teams) ? profile.teams : [];
  const teams = [];

  for (const teamRef of teamRefs) {
    const team = await getDoc(['teams', teamRef.teamId]);
    const member = team ? await getDoc(['teams', teamRef.teamId, 'members', auth.uid]) : null;
    if (team && member) {
      teams.push({
        id: team.id,
        name: team.name || teamRef.name || 'Team',
        role: member.role || teamRef.role || 'member',
        createdAt: team.createdAt || ''
      });
    }
  }

  let activeTeamId = settings.activeTeamId;
  if (activeTeamId && !teams.some((team) => team.id === activeTeamId)) activeTeamId = '';
  if (!activeTeamId && teams.length) activeTeamId = teams[0].id;
  if (activeTeamId !== settings.activeTeamId) {
    await writeSettings({ ...settings, activeTeamId });
  }

  const activeTeam = teams.find((team) => team.id === activeTeamId) || null;
  const canManageTeam = ['owner', 'admin'].includes(activeTeam?.role || '');
  const members = activeTeamId ? await listCollection(['teams', activeTeamId, 'members']) : [];
  const teamInvites = activeTeamId && canManageTeam ? await listCollection(['teams', activeTeamId, 'invites']) : [];
  const invites = await queryPendingInvites(auth.email);

  return {
    teams,
    activeTeamId,
    activeTeam,
    members,
    teamInvites: teamInvites.filter((invite) => invite.status === 'pending'),
    invites,
    unlocked: Boolean(activeTeamId && cloudUnlock.teamId === activeTeamId && cloudUnlock.key)
  };
}

function emptyTeamSnapshot(cloudError = '') {
  return {
    teams: [],
    activeTeamId: '',
    activeTeam: null,
    members: [],
    teamInvites: [],
    invites: [],
    unlocked: false,
    cloudError
  };
}

async function safeTeamSnapshot() {
  try {
    return await teamSnapshot();
  } catch (error) {
    if (!isRecoverableCloudDataError(error)) throw error;
    return emptyTeamSnapshot(error.message || 'Cloud data is blocked by Firebase setup.');
  }
}

async function finishCloudAuth(auth, profilePatch = {}) {
  auth = await lookupAuthUser(auth);
  await writeSettings({ ...(await readSettings()), setupComplete: true, mode: 'cloud', auth });
  if (needsEmailVerification(auth)) {
    return { session: publicSession(auth), requiresEmailVerification: true };
  }
  try {
    await writeUserProfile(auth, profilePatch);
    return { session: publicSession(auth), teams: await teamSnapshot() };
  } catch (error) {
    if (!isRecoverableCloudDataError(error)) throw error;
    return { session: publicSession(auth), teams: emptyTeamSnapshot(error.message), cloudError: error.message };
  }
}

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    title: 'DeployerX',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function toConnectionConfig(project) {
  const ssh = project.ssh || {};
  const config = {
    host: ssh.host,
    port: Number(ssh.port || 22),
    username: ssh.username,
    readyTimeout: Number(ssh.timeout || 20000)
  };

  if (ssh.authType === 'key') {
    config.privateKey = ssh.privateKey;
    if (ssh.passphrase) config.passphrase = ssh.passphrase;
  } else {
    config.password = ssh.password;
  }

  return config;
}

function validateProject(project) {
  const connectionError = validateConnectionProject(project);
  if (connectionError) return connectionError;
  if (!Array.isArray(project.commands) || project.commands.length === 0) {
    return 'At least one command is required.';
  }
  return null;
}

function validateConnectionProject(project) {
  const ssh = project.ssh || {};
  if (!project.name) return 'Project name is required.';
  if (!ssh.host) return 'Server host is required.';
  if (!ssh.username) return 'SSH username is required.';
  if (ssh.authType === 'key' && !ssh.privateKey) return 'SSH private key is required.';
  if (ssh.authType !== 'key' && !ssh.password) return 'SSH password is required.';
  return null;
}

function extractTemplateVariables(commands = []) {
  const variables = new Set();
  for (const command of commands) {
    const matches = String(command).matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g);
    for (const match of matches) variables.add(match[1]);
  }
  return [...variables];
}

function normalizeProjectImport(project) {
  const commands = Array.isArray(project?.commands)
    ? project.commands.map((command) => String(command)).filter((command) => command.trim())
    : typeof project?.commands === 'string'
      ? project.commands
          .split('\n')
          .map((command) => command.trim())
          .filter(Boolean)
      : [];
  const ssh = project?.ssh || {};

  return {
    ...project,
    id: project?.id ? String(project.id) : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: String(project?.name || 'Imported project').trim() || 'Imported project',
    serverType: project?.serverType || 'ubuntu',
    commands,
    variables: project?.variables && typeof project.variables === 'object' ? project.variables : {},
    ssh: {
      host: ssh.host || '',
      port: Number(ssh.port || 22),
      username: ssh.username || '',
      authType: ssh.authType || 'password',
      password: ssh.password || '',
      privateKey: ssh.privateKey || '',
      passphrase: ssh.passphrase || '',
      timeout: Number(ssh.timeout || 20000)
    },
    updatedAt: new Date().toISOString()
  };
}

function readProjectImportFile(raw) {
  const parsed = JSON.parse(raw);
  const projects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(projects)) throw new Error('Import file must contain projects.');
  return projects.map(normalizeProjectImport).filter((project) => project.name);
}

function normalizeTemplateImport(template) {
  const commands = Array.isArray(template?.commands)
    ? template.commands.map((command) => String(command)).filter((command) => command.trim())
    : typeof template?.commands === 'string'
      ? template.commands
          .split('\n')
          .map((command) => command.trim())
          .filter(Boolean)
    : [];
  const variables =
    Array.isArray(template?.variables) && template.variables.length
      ? template.variables.map((variable) => String(variable))
      : extractTemplateVariables(commands);

  return {
    ...template,
    id: template?.id ? String(template.id) : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: String(template?.name || 'Imported template').trim() || 'Imported template',
    category: normalizeTemplateCategory(template?.category),
    commands,
    variables,
    updatedAt: new Date().toISOString()
  };
}

function readTemplateImportFile(raw) {
  const parsed = JSON.parse(raw);
  const templates = Array.isArray(parsed) ? parsed : parsed.templates;
  if (!Array.isArray(templates)) throw new Error('Import file must contain templates.');
  return templates.map(normalizeTemplateImport).filter((template) => template.commands.length).map(normalizeStoredTemplate);
}

function readAccountImportFile(raw) {
  const parsed = JSON.parse(raw);
  const projects = Array.isArray(parsed?.projects) ? parsed.projects.map(normalizeProjectImport) : [];
  const templates = Array.isArray(parsed?.templates) ? parsed.templates.map(normalizeTemplateImport) : [];

  if (!projects.length && !templates.length) {
    throw new Error('Import file must contain projects or templates.');
  }

  return {
    projects: projects.filter((project) => project.name),
    templates: templates.filter((template) => template.commands.length).map(normalizeStoredTemplate)
  };
}

function importNameKey(item) {
  return String(item?.name || '').trim().toLowerCase();
}

function duplicateNames(existingItems, importedItems) {
  const existingNames = new Set(existingItems.map(importNameKey).filter(Boolean));
  const importedNameCounts = new Map();
  for (const item of importedItems) {
    const key = importNameKey(item);
    if (key) importedNameCounts.set(key, (importedNameCounts.get(key) || 0) + 1);
  }

  const names = importedItems
    .filter((item) => {
      const key = importNameKey(item);
      return key && (existingNames.has(key) || importedNameCounts.get(key) > 1);
    })
    .map((item) => String(item.name || '').trim())
    .filter(Boolean);

  return [...new Set(names)];
}

async function shouldReplaceDuplicateNames(itemLabel, names) {
  if (!names.length) return false;

  const preview = names.slice(0, 8).map((name) => `- ${name}`).join('\n');
  const overflow = names.length > 8 ? `\n- and ${names.length - 8} more` : '';
  return requestInAppConfirmation({
    message: `${names.length} duplicate ${itemLabel} name${names.length === 1 ? '' : 's'} found`,
    detail: `Replace will overwrite the duplicate ${itemLabel}${names.length === 1 ? '' : 's'}. Cancel will skip only these duplicates and import the rest.\n\n${preview}${overflow}`,
    confirmLabel: 'Replace'
  });
}

async function mergeImportsByName(existingItems, importedItems, itemLabel, normalizeItem = (item) => item) {
  const items = [...existingItems];
  const duplicates = duplicateNames(items, importedItems);
  const replaceDuplicates = await shouldReplaceDuplicateNames(itemLabel, duplicates);
  const stats = { added: 0, replaced: 0, skipped: 0, duplicates: duplicates.length };

  for (const importedItem of importedItems) {
    const item = normalizeItem(importedItem);
    const name = importNameKey(item);
    const nameIndex = items.findIndex((existingItem) => importNameKey(existingItem) === name);

    if (nameIndex >= 0) {
      if (!replaceDuplicates) {
        stats.skipped += 1;
        continue;
      }
      items[nameIndex] = item;
      stats.replaced += 1;
      continue;
    }

    const idIndex = item.id ? items.findIndex((existingItem) => String(existingItem.id) === String(item.id)) : -1;
    if (idIndex >= 0) {
      items[idIndex] = item;
      stats.replaced += 1;
    } else {
      items.unshift(item);
      stats.added += 1;
    }
  }

  return { items, stats };
}

function emitDeployment(runId, type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deployment:event', { runId, type, payload });
  }
}

function emitTerminal(sessionId, type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:event', { sessionId, type, payload });
  }
}

function runCommand(connection, command, runId, deploymentState) {
  return new Promise((resolve, reject) => {
    emitDeployment(runId, 'log', `$ ${command}\n`);
    connection.exec(command, { pty: true }, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      deploymentState.currentStream = stream;
      stream.on('close', (code) => {
        deploymentState.currentStream = null;
        if (deploymentState.stopped) {
          reject(new Error('Deployment stopped.'));
          return;
        }

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command exited with code ${code}: ${command}`));
        }
      });

      stream.on('data', (data) => emitDeployment(runId, 'log', data.toString()));
      stream.stderr.on('data', (data) => emitDeployment(runId, 'error', data.toString()));
    });
  });
}

function uploadFile(connection, upload, runId) {
  return new Promise((resolve, reject) => {
    connection.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }

      emitDeployment(runId, 'log', `Uploading ${upload.localPath} to ${upload.remotePath}\n`);
      sftp.fastPut(upload.localPath, upload.remotePath, (uploadError) => {
        if (uploadError) {
          reject(uploadError);
          return;
        }

        emitDeployment(runId, 'log', `Upload completed: ${upload.remotePath}\n`);
        resolve();
      });
    });
  });
}

async function executeDeployment(project, upload, runId) {
  const validationError = validateProject(project);
  if (validationError) throw new Error(validationError);

  const connection = new Client();
  const deploymentState = { connection, currentStream: null, stopped: false };
  activeDeployments.set(runId, deploymentState);

  return new Promise((resolve, reject) => {
    connection.on('ready', async () => {
      emitDeployment(runId, 'log', 'SSH connected.\n');
      try {
        if (upload && upload.localPath && upload.remotePath) {
          await uploadFile(connection, upload, runId);
        }

        for (const command of project.commands) {
          if (deploymentState.stopped) throw new Error('Deployment stopped.');
          if (command.trim()) await runCommand(connection, command.trim(), runId, deploymentState);
        }

        emitDeployment(runId, 'done', 'Deployment completed.');
        activeDeployments.delete(runId);
        connection.end();
        resolve();
      } catch (error) {
        emitDeployment(runId, 'failed', error.message);
        activeDeployments.delete(runId);
        connection.end();
        reject(error);
      }
    });

    connection.on('error', (error) => {
      emitDeployment(runId, 'failed', error.message);
      activeDeployments.delete(runId);
      reject(error);
    });

    connection.on('close', () => {
      activeDeployments.delete(runId);
    });

    connection.connect(toConnectionConfig(project));
  });
}

function startTerminal(project, sessionId, size = {}) {
  const validationError = validateConnectionProject(project);
  if (validationError) throw new Error(validationError);

  const connection = new Client();
  const terminalState = { connection, stream: null };
  activeTerminals.set(sessionId, terminalState);

  connection.on('ready', () => {
    emitTerminal(sessionId, 'log', 'SSH connected.\r\n');
    const cols = Math.max(Number(size.cols || 120), 80);
    const rows = Math.max(Number(size.rows || 34), 24);
    const width = cols * 9;
    const height = rows * 18;
    connection.shell(
      {
        term: 'xterm-256color',
        cols,
        rows,
        width,
        height
      },
      (error, stream) => {
        if (error) {
          emitTerminal(sessionId, 'failed', error.message);
          activeTerminals.delete(sessionId);
          connection.end();
          return;
        }

        terminalState.stream = stream;
        stream.write(`stty sane cols ${cols} rows ${rows}\n`);
        emitTerminal(sessionId, 'connected', 'Terminal connected.');

        stream.on('data', (data) => emitTerminal(sessionId, 'log', data.toString()));
        if (stream.stderr) {
          stream.stderr.on('data', (data) => emitTerminal(sessionId, 'error', data.toString()));
        }
        stream.on('close', () => {
          emitTerminal(sessionId, 'closed', 'Terminal closed.');
          activeTerminals.delete(sessionId);
          connection.end();
        });
      }
    );
  });

  connection.on('error', (error) => {
    emitTerminal(sessionId, 'failed', error.message);
    activeTerminals.delete(sessionId);
  });

  connection.on('close', () => {
    if (activeTerminals.has(sessionId)) {
      emitTerminal(sessionId, 'closed', 'Terminal closed.');
      activeTerminals.delete(sessionId);
    }
  });

  connection.connect(toConnectionConfig(project));
}

function resizeTerminal(sessionId, cols, rows) {
  const terminal = activeTerminals.get(sessionId);
  if (!terminal || !terminal.stream || !terminal.stream.setWindow) return false;
  const nextRows = Math.max(Number(rows || 34), 24);
  const nextCols = Math.max(Number(cols || 120), 80);
  terminal.stream.setWindow(nextRows, nextCols, nextRows * 18, nextCols * 9);
  return true;
}

function normalizeRemotePath(remotePath = '.') {
  const value = String(remotePath || '.').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  return value || '.';
}

function remoteBaseName(remotePath = '') {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === '/' || normalized === '.') return '';
  return normalized.split('/').filter(Boolean).pop() || '';
}

function joinRemotePath(parentPath, childName) {
  const parent = normalizeRemotePath(parentPath);
  const child = String(childName || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  if (!child) return parent;
  if (parent === '.') return child;
  if (parent === '/') return `/${child}`;
  return `${parent.replace(/\/$/, '')}/${child}`;
}

function parentRemotePath(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === '/' || normalized === '.') return normalized;
  const absolute = normalized.startsWith('/');
  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  if (!parts.length) return absolute ? '/' : '.';
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function normalizeLocalPath(localPath = '') {
  return path.resolve(String(localPath || app.getPath('home')));
}

function localKind(dirent, filePath) {
  if (dirent.isDirectory()) return 'folder';
  const extension = path.extname(filePath).replace('.', '').toLowerCase();
  return extension || 'file';
}

function assertPlainFileName(fileName, message = 'Enter a name.') {
  const name = String(fileName || '').trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error(message);
  return name;
}

async function listLocalDirectory(localPath = '') {
  const normalizedPath = normalizeLocalPath(localPath);
  const entries = await fs.readdir(normalizedPath, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const itemPath = path.join(normalizedPath, entry.name);
      let stats = null;
      try {
        stats = await fs.stat(itemPath);
      } catch {
        stats = null;
      }

      const isDirectory = entry.isDirectory();
      return {
        name: entry.name,
        path: itemPath,
        type: isDirectory ? 'directory' : 'file',
        size: isDirectory ? 0 : Number(stats?.size || 0),
        modifiedAt: stats?.mtime ? stats.mtime.toISOString() : '',
        mode: localKind(entry, itemPath)
      };
    })
  );

  return {
    path: normalizedPath,
    parentPath: path.dirname(normalizedPath),
    items: items.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
  };
}

async function makeLocalDirectory(localDirectory, folderName) {
  const name = assertPlainFileName(folderName, 'Enter a folder name.');
  const folderPath = path.join(normalizeLocalPath(localDirectory), name);
  await fs.mkdir(folderPath);
  return { path: folderPath };
}

async function openLocalEntry(entry) {
  if (!entry?.path) throw new Error('Choose a local item to open.');
  const result = await shell.openPath(normalizeLocalPath(entry.path));
  if (result) throw new Error(result);
  return true;
}

async function openLocalEntryWith(entry) {
  if (!entry?.path) throw new Error('Choose a local item to open.');
  if (process.platform === 'win32') {
    const child = execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', normalizeLocalPath(entry.path)], {
      detached: true,
      windowsHide: false
    });
    child.unref();
    return true;
  }
  return openLocalEntry(entry);
}

async function renameLocalEntry(entry, nextName) {
  if (!entry?.path) throw new Error('Choose a local item to rename.');
  const name = assertPlainFileName(nextName);
  const currentPath = normalizeLocalPath(entry.path);
  const nextPath = path.join(path.dirname(currentPath), name);
  await fs.rename(currentPath, nextPath);
  return { path: nextPath };
}

async function deleteLocalEntry(entry) {
  if (!entry?.path) throw new Error('Choose a local item to delete.');
  const targetPath = normalizeLocalPath(entry?.path);
  const stats = await fs.stat(targetPath);
  await fs.rm(targetPath, { recursive: stats.isDirectory(), force: false });
  return true;
}

function sftpReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) reject(error);
      else resolve(list || []);
    });
  });
}

function sftpFastPut(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpFastGet(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpMkdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpRmdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpRename(sftp, oldPath, newPath) {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function sftpEnsureMkdir(sftp, remotePath) {
  try {
    await sftpMkdir(sftp, remotePath);
  } catch (error) {
    try {
      await sftpReaddir(sftp, remotePath);
    } catch {
      throw error;
    }
  }
}

async function uploadLocalPath(sftp, localPath, remoteDirectory) {
  const stats = await fs.stat(localPath);
  const remotePath = joinRemotePath(remoteDirectory || '.', path.basename(localPath));

  if (stats.isDirectory()) {
    await sftpEnsureMkdir(sftp, remotePath);
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    for (const entry of entries) {
      await uploadLocalPath(sftp, path.join(localPath, entry.name), remotePath);
    }
    return remotePath;
  }

  await sftpFastPut(sftp, localPath, remotePath);
  return remotePath;
}

async function downloadRemotePath(sftp, remotePath, entryType, localDirectory) {
  const localPath = path.join(normalizeLocalPath(localDirectory), remoteBaseName(remotePath) || 'download');

  if (entryType === 'directory') {
    await fs.mkdir(localPath, { recursive: true });
    const entries = await sftpReaddir(sftp, remotePath);
    for (const entry of entries) {
      const childPath = joinRemotePath(remotePath, entry.filename);
      const childType = entry.attrs?.isDirectory?.() ? 'directory' : 'file';
      await downloadRemotePath(sftp, childPath, childType, localPath);
    }
    return localPath;
  }

  await sftpFastGet(sftp, remotePath, localPath);
  return localPath;
}

async function deleteRemotePath(sftp, remotePath, entryType) {
  if (entryType === 'directory') {
    const entries = await sftpReaddir(sftp, remotePath);
    for (const entry of entries) {
      const childPath = joinRemotePath(remotePath, entry.filename);
      const childType = entry.attrs?.isDirectory?.() ? 'directory' : 'file';
      await deleteRemotePath(sftp, childPath, childType);
    }
    await sftpRmdir(sftp, remotePath);
    return;
  }

  await sftpUnlink(sftp, remotePath);
}

function ftpSessionOrThrow(sessionId) {
  const session = activeFtpSessions.get(sessionId);
  if (!session || !session.sftp) throw new Error('FTP session is not connected.');
  return session;
}

function connectFtp(project, sessionId) {
  const validationError = validateConnectionProject(project);
  if (validationError) throw new Error(validationError);

  const connection = new Client();
  const ftpState = { connection, sftp: null };
  activeFtpSessions.set(sessionId, ftpState);

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      activeFtpSessions.delete(sessionId);
      connection.end();
      reject(error);
    };

    connection.on('ready', () => {
      connection.sftp((error, sftp) => {
        if (error) {
          fail(error);
          return;
        }

        ftpState.sftp = sftp;
        resolve({ sessionId, path: '.' });
      });
    });

    connection.on('error', fail);
    connection.on('close', () => {
      activeFtpSessions.delete(sessionId);
    });
    connection.connect(toConnectionConfig(project));
  });
}

async function listFtpDirectory(sessionId, remotePath = '.') {
  const { sftp } = ftpSessionOrThrow(sessionId);
  const normalizedPath = normalizeRemotePath(remotePath);
  const items = await sftpReaddir(sftp, normalizedPath);
  return {
    path: normalizedPath,
    parentPath: parentRemotePath(normalizedPath),
    items: items
      .map((item) => {
        const attrs = item.attrs || {};
        const isDirectory = Boolean(attrs.isDirectory?.());
        return {
          name: item.filename,
          path: joinRemotePath(normalizedPath, item.filename),
          type: isDirectory ? 'directory' : 'file',
          size: Number(attrs.size || 0),
          modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : '',
          mode: attrs.mode ? attrs.mode.toString(8) : ''
        };
      })
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
  };
}

async function uploadFtpFile(sessionId, localPath, remoteDirectory) {
  const { sftp } = ftpSessionOrThrow(sessionId);
  const fileName = path.basename(localPath || '');
  if (!fileName) throw new Error('Choose a local file to upload.');
  const remotePath = await uploadLocalPath(sftp, localPath, remoteDirectory || '.');
  return { remotePath };
}

async function downloadFtpFile(sessionId, remotePath, localPath) {
  const { sftp } = ftpSessionOrThrow(sessionId);
  await sftpFastGet(sftp, normalizeRemotePath(remotePath), localPath);
  return { localPath };
}

async function downloadFtpEntryToDirectory(sessionId, entry, localDirectory) {
  if (!entry?.path) throw new Error('Choose a server item to download.');
  const { sftp } = ftpSessionOrThrow(sessionId);
  const localPath = await downloadRemotePath(sftp, normalizeRemotePath(entry.path), entry.type, localDirectory);
  return { localPath };
}

async function makeFtpDirectory(sessionId, remoteDirectory, folderName) {
  const name = assertPlainFileName(folderName, 'Enter a folder name.');
  const remotePath = joinRemotePath(remoteDirectory || '.', name);
  const { sftp } = ftpSessionOrThrow(sessionId);
  await sftpMkdir(sftp, remotePath);
  return { remotePath };
}

async function renameFtpEntry(sessionId, entry, nextName) {
  const { sftp } = ftpSessionOrThrow(sessionId);
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/') throw new Error('Choose a file or folder to rename.');
  const name = assertPlainFileName(nextName);
  const nextPath = joinRemotePath(parentRemotePath(remotePath), name);
  await sftpRename(sftp, remotePath, nextPath);
  return { remotePath: nextPath };
}

async function openFtpEntry(sessionId, entry) {
  if (!entry?.path) throw new Error('Choose a server item to open.');
  const { sftp } = ftpSessionOrThrow(sessionId);
  const tempRoot = path.join(app.getPath('temp'), 'DeployerX', 'ftp-open', String(sessionId));
  await fs.mkdir(tempRoot, { recursive: true });
  const localPath = await downloadRemotePath(sftp, normalizeRemotePath(entry.path), entry.type, tempRoot);
  const result = await shell.openPath(localPath);
  if (result) throw new Error(result);
  return { localPath };
}

async function openFtpEntryWith(sessionId, entry) {
  if (!entry?.path) throw new Error('Choose a server item to open.');
  const { sftp } = ftpSessionOrThrow(sessionId);
  const tempRoot = path.join(app.getPath('temp'), 'DeployerX', 'ftp-open', String(sessionId));
  await fs.mkdir(tempRoot, { recursive: true });
  const localPath = await downloadRemotePath(sftp, normalizeRemotePath(entry.path), entry.type, tempRoot);
  if (process.platform === 'win32') {
    const child = execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', localPath], {
      detached: true,
      windowsHide: false
    });
    child.unref();
    return { localPath };
  }
  const result = await shell.openPath(localPath);
  if (result) throw new Error(result);
  return { localPath };
}

async function deleteFtpEntry(sessionId, entry) {
  const { sftp } = ftpSessionOrThrow(sessionId);
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/') throw new Error('Choose a file or folder to delete.');
  await deleteRemotePath(sftp, remotePath, entry?.type);
  return true;
}

function disconnectFtp(sessionId) {
  const session = activeFtpSessions.get(sessionId);
  if (!session) return false;
  session.connection.end();
  activeFtpSessions.delete(sessionId);
  return true;
}

function stopDeployment(runId) {
  const deployment = activeDeployments.get(runId);
  if (!deployment) return false;
  deployment.stopped = true;
  if (deployment.currentStream) deployment.currentStream.close();
  deployment.connection.end();
  activeDeployments.delete(runId);
  emitDeployment(runId, 'failed', 'Emergency stop requested.');
  return true;
}

function stopTerminal(sessionId) {
  const terminal = activeTerminals.get(sessionId);
  if (!terminal) return false;
  if (terminal.stream) terminal.stream.close();
  terminal.connection.end();
  activeTerminals.delete(sessionId);
  emitTerminal(sessionId, 'closed', 'Terminal stopped.');
  return true;
}

function emergencyStop() {
  for (const runId of [...activeDeployments.keys()]) {
    stopDeployment(runId);
  }
  for (const sessionId of [...activeTerminals.keys()]) {
    stopTerminal(sessionId);
  }
  for (const sessionId of [...activeFtpSessions.keys()]) {
    disconnectFtp(sessionId);
  }
}

app.whenReady().then(async () => {
  await ensureStore();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:metadata', async () => ({
  name: app.getName(),
  version: app.getVersion()
}));

ipcMain.handle('setup:get', async () => {
  const settings = await readSettings();
  return {
    setupComplete: settings.setupComplete,
    mode: settings.mode,
    activeTeamId: settings.activeTeamId,
    firebase: await firebaseConfigStatus(),
    session: publicSession(settings.auth),
    unlocked: Boolean(settings.activeTeamId && cloudUnlock.teamId === settings.activeTeamId && cloudUnlock.key)
  };
});

ipcMain.handle('setup:setMode', async (_event, mode) => {
  if (!['offline', 'cloud'].includes(mode)) throw new Error('Choose Cloud or Offline mode.');
  const current = await readSettings();
  if (mode === 'offline') {
    cloudUnlock = { teamId: '', key: null };
    const settings = await writeSettings({ ...current, setupComplete: true, mode: 'offline', activeTeamId: '', auth: null });
    return { ...settings, firebase: await firebaseConfigStatus() };
  }
  const settings = await writeSettings({ ...current, setupComplete: true, mode: 'cloud' });
  return { ...settings, firebase: await firebaseConfigStatus() };
});

ipcMain.handle('setup:select-firebase-config', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Firebase Web Config',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, firebase: await firebaseConfigStatus() };

  const parsed = parseFirebaseConfigJson(JSON.parse(await fs.readFile(result.filePaths[0], 'utf8')));
  if (!parsed) throw new Error('Selected JSON is not a Firebase Web config.');

  if (parsed.adminProjectId) {
    const discovered = await tryFirebaseHostingConfig(parsed.adminProjectId);
    if (!discovered) {
      throw new Error(
        'That file is a Firebase Admin SDK service account. It does not include the Web API key needed for Firebase Auth. Download the Firebase Web App config from Firebase Console > Project settings > Your apps, or enable Firebase Hosting init config.'
      );
    }
    return { canceled: false, firebase: await saveFirebaseConfig(discovered) };
  }

  return { canceled: false, firebase: await saveFirebaseConfig(parsed) };
});

ipcMain.handle('auth:register', async (_event, payload = {}) => {
  const email = emailKey(payload.email);
  const password = String(payload.password || '');
  const firstName = String(payload.firstName || '').trim();
  const lastName = String(payload.lastName || '').trim();
  const displayName = String(payload.displayName || `${firstName} ${lastName}`.trim()).trim();
  if (!email || !password) throw new Error('Email and password are required.');

  const registered = await firebaseAuthRequest('accounts:signUp', {
    email,
    password,
    returnSecureToken: true
  });
  let auth = normalizeAuthSession(registered, displayName);
  if (displayName) {
    const updated = await firebaseAuthRequest('accounts:update', {
      idToken: auth.idToken,
      displayName,
      returnSecureToken: false
    });
    auth = {
      ...auth,
      displayName: updated.displayName || displayName
    };
  }

  await firebaseAuthRequest('accounts:sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: auth.idToken
  });

  return finishCloudAuth(auth, { displayName, firstName, lastName, emailVerified: false });
});

ipcMain.handle('auth:login', async (_event, payload = {}) => {
  const email = emailKey(payload.email);
  const password = String(payload.password || '');
  if (!email || !password) throw new Error('Email and password are required.');

  const signedIn = await firebaseAuthRequest('accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true
  });
  const auth = normalizeAuthSession(signedIn, signedIn.displayName || '');
  return finishCloudAuth(auth);
});

ipcMain.handle('auth:forgotPassword', async (_event, payload = {}) => {
  const email = emailKey(payload.email);
  if (!email) throw new Error('Enter your email address first.');
  await firebaseAuthRequest('accounts:sendOobCode', {
    requestType: 'PASSWORD_RESET',
    email
  });
  return true;
});

ipcMain.handle('auth:resendVerification', async () => {
  const auth = await requireAuthSession();
  await firebaseAuthRequest('accounts:sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: auth.idToken
  });
  return true;
});

ipcMain.handle('auth:google', async () => {
  const auth = await signInWithGoogle();
  return finishCloudAuth(auth);
});

ipcMain.handle('auth:logout', async () => {
  const settings = await readSettings();
  cloudUnlock = { teamId: '', key: null };
  await writeSettings({ ...settings, auth: null, activeTeamId: '' });
  return true;
});

ipcMain.handle('auth:session', async () => {
  const settings = await readSettings();
  if (settings.mode !== 'cloud' || !settings.auth) return { session: null };
  let auth;
  try {
    auth = await refreshAuthSession(settings);
  } catch {
    cloudUnlock = { teamId: '', key: null };
    await writeSettings({ ...settings, auth: null, activeTeamId: '' });
    return { session: null };
  }

  if (needsEmailVerification(auth)) {
    return { session: publicSession(auth), requiresEmailVerification: true };
  }
  return { session: publicSession(auth), teams: await safeTeamSnapshot() };
});

ipcMain.handle('teams:list', async () => safeTeamSnapshot());

ipcMain.handle('teams:create', async (_event, payload = {}) => {
  const auth = await requireAuthSession();
  const name = String(payload.name || '').trim();
  const passphrase = String(payload.passphrase || '');
  if (!name) throw new Error('Team name is required.');
  if (!passphrase) throw new Error('Team passphrase is required.');

  const teamId = createId('team');
  const salt = crypto.randomBytes(16).toString('base64');
  const key = deriveTeamKey(passphrase, salt);
  const team = {
    id: teamId,
    name,
    ownerUid: auth.uid,
    secretSalt: salt,
    secretProbe: encryptedProbe(key),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  const member = {
    uid: auth.uid,
    email: auth.email,
    emailLower: emailKey(auth.email),
    displayName: auth.displayName || '',
    role: 'owner',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await patchDoc(['teams', teamId], team);
  await patchDoc(['teams', teamId, 'members', auth.uid], member);
  await updateUserTeamRef(auth.uid, { teamId, name, role: 'owner' });

  const settings = await readSettings();
  cloudUnlock = { teamId, key };
  await writeSettings({ ...settings, activeTeamId: teamId });
  return teamSnapshot();
});

ipcMain.handle('teams:switch', async (_event, teamId) => {
  const auth = await requireAuthSession();
  const team = await getDoc(['teams', teamId]);
  const member = team ? await getDoc(['teams', teamId, 'members', auth.uid]) : null;
  if (!team || !member) throw new Error('You do not have access to this team.');
  const settings = await readSettings();
  if (settings.activeTeamId !== teamId) cloudUnlock = { teamId: '', key: null };
  await writeSettings({ ...settings, activeTeamId: teamId });
  return teamSnapshot();
});

ipcMain.handle('teams:unlock', async (_event, payload = {}) => {
  const teamId = String(payload.teamId || (await readSettings()).activeTeamId || '');
  const passphrase = String(payload.passphrase || '');
  if (!teamId) throw new Error('Select a team first.');
  const team = await getDoc(['teams', teamId]);
  if (!team?.secretSalt || !team?.secretProbe) throw new Error('This team cannot be unlocked.');
  const key = deriveTeamKey(passphrase, team.secretSalt);
  if (!verifyTeamKey(team, key)) throw new Error('Team passphrase is incorrect.');
  cloudUnlock = { teamId, key };
  return teamSnapshot();
});

ipcMain.handle('teams:invite', async (_event, payload = {}) => {
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  const email = emailKey(payload.email);
  const role = ['admin', 'member'].includes(payload.role) ? payload.role : 'member';
  if (!teamId) throw new Error('Select a team first.');
  if (!email) throw new Error('Invite email is required.');
  await ensureTeamManager(teamId);
  const team = await getDoc(['teams', teamId]);
  const inviteId = createId('invite');
  await patchDoc(['teams', teamId, 'invites', inviteId], {
    id: inviteId,
    teamId,
    teamName: team?.name || 'Team',
    email,
    emailLower: email,
    role,
    status: 'pending',
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  return teamSnapshot();
});

ipcMain.handle('teams:acceptInvite', async (_event, payload = {}) => {
  const auth = await requireAuthSession();
  const teamId = String(payload.teamId || '');
  const inviteId = String(payload.inviteId || payload.id || '');
  if (!teamId || !inviteId) throw new Error('Invite is missing.');
  const invite = await getDoc(['teams', teamId, 'invites', inviteId]);
  if (!invite || invite.status !== 'pending') throw new Error('Invite is no longer available.');
  if (emailKey(invite.emailLower || invite.email) !== emailKey(auth.email)) throw new Error('This invite belongs to another email.');

  const team = await getDoc(['teams', teamId]);
  const member = {
    uid: auth.uid,
    email: auth.email,
    emailLower: emailKey(auth.email),
    displayName: auth.displayName || '',
    role: ['owner', 'admin', 'member'].includes(invite.role) ? invite.role : 'member',
    acceptedInviteId: inviteId,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  await patchDoc(['teams', teamId, 'members', auth.uid], member);
  await patchDoc(['teams', teamId, 'invites', inviteId], { ...invite, status: 'accepted', acceptedBy: auth.uid, updatedAt: nowIso() });
  await updateUserTeamRef(auth.uid, { teamId, name: team?.name || invite.teamName || 'Team', role: member.role });
  await writeSettings({ ...(await readSettings()), activeTeamId: teamId });
  cloudUnlock = { teamId: '', key: null };
  return teamSnapshot();
});

ipcMain.handle('teams:updateMember', async (_event, payload = {}) => {
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  const uid = String(payload.uid || '');
  const role = ['admin', 'member'].includes(payload.role) ? payload.role : '';
  if (!teamId || !uid || !role) throw new Error('Member and role are required.');
  await ensureTeamManager(teamId);
  const member = await getDoc(['teams', teamId, 'members', uid]);
  if (!member) throw new Error('Member was not found.');
  if (member.role === 'owner') throw new Error('Owner role cannot be changed.');
  await patchDoc(['teams', teamId, 'members', uid], { ...member, role, updatedAt: nowIso() });
  return teamSnapshot();
});

ipcMain.handle('teams:removeMember', async (_event, payload = {}) => {
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  const uid = String(payload.uid || '');
  if (!teamId || !uid) throw new Error('Member is required.');
  await ensureTeamManager(teamId);
  const member = await getDoc(['teams', teamId, 'members', uid]);
  if (member?.role === 'owner') throw new Error('Owner cannot be removed.');
  await deleteDoc(['teams', teamId, 'members', uid]);
  return teamSnapshot();
});

ipcMain.handle('teams:delete', async (_event, payload = {}) => {
  const auth = await requireAuthSession();
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  if (!teamId) throw new Error('Select a workspace first.');

  const team = await getDoc(['teams', teamId]);
  if (!team) throw new Error('Workspace was not found.');
  const member = await getDoc(['teams', teamId, 'members', auth.uid]);
  if (team.ownerUid !== auth.uid || member?.role !== 'owner') {
    throw new Error('Only the workspace owner can delete this workspace.');
  }

  await deleteCollectionDocuments(['teams', teamId, 'projects']);
  await deleteCollectionDocuments(['teams', teamId, 'templates']);
  await deleteCollectionDocuments(['teams', teamId, 'invites']);
  await deleteTeamMemberDocuments(teamId, auth.uid);
  await deleteDoc(['teams', teamId]);
  try {
    await removeUserTeamRef(auth.uid, teamId);
  } catch (error) {
    if (!isRecoverableCloudDataError(error)) throw error;
  }

  if (settings.activeTeamId === teamId) {
    cloudUnlock = { teamId: '', key: null };
    await writeSettings({ ...settings, activeTeamId: '' });
  }
  return safeTeamSnapshot();
});

ipcMain.handle('cloud:import-local', async () => {
  await ensureActiveTeamUnlocked();
  const localData = await readStore();
  if (!localData.projects.length && !localData.templates.length) {
    return { projectCount: 0, templateCount: 0, projects: [], templates: [] };
  }
  await mergeLocalStoreIntoCloud(localData);
  const cloudData = await readCloudStore();
  return {
    projectCount: localData.projects.length,
    templateCount: localData.templates.length,
    projects: cloudData.projects,
    templates: cloudData.templates
  };
});

ipcMain.handle('projects:list', async () => readCurrentStore());

ipcMain.handle('projects:save', async (_event, project) => {
  const data = await readCurrentStore();
  const id = project.id || `${Date.now()}`;
  const normalized = {
    ...project,
    id,
    updatedAt: nowIso()
  };
  const index = data.projects.findIndex((item) => item.id === id);
  if (index >= 0) data.projects[index] = normalized;
  else data.projects.unshift(normalized);
  await writeCurrentStore(data);
  return normalized;
});

ipcMain.handle('projects:delete', async (_event, id) => {
  await deleteProjectFromCurrentStore(id);
  return true;
});

ipcMain.handle('projects:export', async (_event, projectIds) => {
  const data = await readCurrentStore();
  const selectedIds = Array.isArray(projectIds) ? new Set(projectIds.map(String)) : null;
  const projects = selectedIds ? (data.projects || []).filter((project) => selectedIds.has(String(project.id))) : data.projects || [];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Projects',
    defaultPath: 'deployerx-projects.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const payload = {
    app: 'DeployerX',
    type: 'projects',
    exportedAt: nowIso(),
    projects
  };

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2));
  return { canceled: false, count: payload.projects.length };
});

ipcMain.handle('projects:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Projects',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const importedProjects = readProjectImportFile(await fs.readFile(result.filePaths[0], 'utf8'));
  if (!importedProjects.length) throw new Error('No projects were found in that file.');

  const data = await readCurrentStore();
  const mergedProjects = await mergeImportsByName(
    Array.isArray(data.projects) ? [...data.projects] : [],
    importedProjects,
    'project'
  );
  const projects = mergedProjects.items;

  data.projects = projects;
  await writeCurrentStore(data);
  return {
    canceled: false,
    count: mergedProjects.stats.added + mergedProjects.stats.replaced,
    skippedDuplicateCount: mergedProjects.stats.skipped,
    replacedDuplicateCount: mergedProjects.stats.replaced,
    projects
  };
});

ipcMain.handle('account:export', async () => {
  const data = await readCurrentStore();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Account',
    defaultPath: 'deployerx-account.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const payload = {
    app: 'DeployerX',
    type: 'account',
    exportedAt: nowIso(),
    projects: data.projects || [],
    templates: (data.templates || []).map(normalizeStoredTemplate)
  };

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2));
  return {
    canceled: false,
    projectCount: payload.projects.length,
    templateCount: payload.templates.length
  };
});

ipcMain.handle('account:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Account',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const imported = readAccountImportFile(await fs.readFile(result.filePaths[0], 'utf8'));
  const data = await readCurrentStore();
  const mergedProjects = await mergeImportsByName(
    Array.isArray(data.projects) ? [...data.projects] : [],
    imported.projects,
    'project'
  );
  const mergedTemplates = await mergeImportsByName(
    Array.isArray(data.templates) ? data.templates.map(normalizeStoredTemplate) : [],
    imported.templates,
    'template',
    normalizeStoredTemplate
  );
  const projects = mergedProjects.items;
  const templates = mergedTemplates.items;

  data.projects = projects;
  data.templates = templates;
  await writeCurrentStore(data);

  return {
    canceled: false,
    projectCount: mergedProjects.stats.added + mergedProjects.stats.replaced,
    templateCount: mergedTemplates.stats.added + mergedTemplates.stats.replaced,
    skippedProjectDuplicateCount: mergedProjects.stats.skipped,
    skippedTemplateDuplicateCount: mergedTemplates.stats.skipped,
    replacedProjectDuplicateCount: mergedProjects.stats.replaced,
    replacedTemplateDuplicateCount: mergedTemplates.stats.replaced,
    projects,
    templates
  };
});

ipcMain.handle('templates:save', async (_event, template) => {
  const data = await readCurrentStore();
  const id = template.id || `${Date.now()}`;
  const category = TEMPLATE_CATEGORIES.includes(String(template.category || '').trim()) ? String(template.category).trim() : '';
  if (!category) throw new Error('Template category is required.');
  const normalized = normalizeStoredTemplate({
    ...template,
    id,
    category,
    updatedAt: new Date().toISOString()
  });
  const index = data.templates.findIndex((item) => item.id === id);
  if (index >= 0) data.templates[index] = normalized;
  else data.templates.unshift(normalized);
  await writeCurrentStore(data);
  return normalized;
});

ipcMain.handle('templates:delete', async (_event, id) => {
  await deleteTemplateFromCurrentStore(id);
  return true;
});

ipcMain.handle('templates:export', async (_event, templateIds) => {
  const data = await readCurrentStore();
  const selectedIds = Array.isArray(templateIds) ? new Set(templateIds.map(String)) : null;
  const templates = selectedIds
    ? (data.templates || []).filter((template) => selectedIds.has(String(template.id)))
    : data.templates || [];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Command Templates',
    defaultPath: 'deployerx-command-templates.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const payload = {
    app: 'DeployerX',
    type: 'command-templates',
    exportedAt: nowIso(),
    templates: templates.map(normalizeStoredTemplate)
  };

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2));
  return { canceled: false, count: payload.templates.length };
});

ipcMain.handle('templates:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Command Templates',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const importedTemplates = readTemplateImportFile(await fs.readFile(result.filePaths[0], 'utf8'));
  if (!importedTemplates.length) throw new Error('No command templates were found in that file.');

  const data = await readCurrentStore();
  const mergedTemplates = await mergeImportsByName(
    Array.isArray(data.templates) ? data.templates.map(normalizeStoredTemplate) : [],
    importedTemplates,
    'template',
    normalizeStoredTemplate
  );
  const templates = mergedTemplates.items;

  data.templates = templates;
  await writeCurrentStore(data);
  return {
    canceled: false,
    count: mergedTemplates.stats.added + mergedTemplates.stats.replaced,
    skippedDuplicateCount: mergedTemplates.stats.skipped,
    replacedDuplicateCount: mergedTemplates.stats.replaced,
    templates
  };
});

ipcMain.handle('dialog:select-key', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select SSH Private Key',
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return fs.readFile(result.filePaths[0], 'utf8');
});

ipcMain.handle('dialog:select-upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select File to Upload',
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:select-ftp-upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select FTP Upload File',
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:select-ftp-download', async (_event, defaultName = 'download') => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save FTP Download',
    defaultPath: String(defaultName || 'download')
  });

  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('deployment:run', async (_event, payload) => {
  const runId = payload.runId || `${Date.now()}`;
  executeDeployment(payload.project, payload.upload, runId).catch(() => {});
  return { runId };
});

ipcMain.handle('deployment:stop', async (_event, runId) => stopDeployment(runId));

ipcMain.handle('terminal:start', async (_event, payload) => {
  const sessionId = payload.sessionId || `${Date.now()}`;
  startTerminal(payload.project, sessionId, { cols: payload.cols, rows: payload.rows });
  return { sessionId };
});

ipcMain.handle('terminal:input', async (_event, payload) => {
  const terminal = activeTerminals.get(payload.sessionId);
  if (!terminal || !terminal.stream) return false;
  terminal.stream.write(payload.input);
  return true;
});

ipcMain.on('terminal:input:send', (_event, payload) => {
  const terminal = activeTerminals.get(payload.sessionId);
  if (!terminal || !terminal.stream) return;
  terminal.stream.write(payload.input);
});

ipcMain.handle('terminal:resize', async (_event, payload) => resizeTerminal(payload.sessionId, payload.cols, payload.rows));

ipcMain.handle('terminal:stop', async (_event, sessionId) => stopTerminal(sessionId));

ipcMain.handle('local:list', async (_event, payload = {}) => listLocalDirectory(payload.path || app.getPath('home')));

ipcMain.handle('local:open', async (_event, payload = {}) => openLocalEntry(payload.entry));

ipcMain.handle('local:open-with', async (_event, payload = {}) => openLocalEntryWith(payload.entry));

ipcMain.handle('local:mkdir', async (_event, payload = {}) => makeLocalDirectory(payload.directory, payload.name));

ipcMain.handle('local:rename', async (_event, payload = {}) => renameLocalEntry(payload.entry, payload.name));

ipcMain.handle('local:delete', async (_event, payload = {}) => deleteLocalEntry(payload.entry));

ipcMain.handle('ftp:connect', async (_event, payload) => {
  const sessionId = payload.sessionId || `${Date.now()}`;
  return connectFtp(payload.project, sessionId);
});

ipcMain.handle('ftp:list', async (_event, payload) => listFtpDirectory(payload.sessionId, payload.path));

ipcMain.handle('ftp:upload', async (_event, payload) => uploadFtpFile(payload.sessionId, payload.localPath, payload.remoteDirectory));

ipcMain.handle('ftp:download', async (_event, payload) => downloadFtpFile(payload.sessionId, payload.remotePath, payload.localPath));

ipcMain.handle('ftp:download-to-directory', async (_event, payload) =>
  downloadFtpEntryToDirectory(payload.sessionId, payload.entry, payload.localDirectory)
);

ipcMain.handle('ftp:open', async (_event, payload) => openFtpEntry(payload.sessionId, payload.entry));

ipcMain.handle('ftp:open-with', async (_event, payload) => openFtpEntryWith(payload.sessionId, payload.entry));

ipcMain.handle('ftp:mkdir', async (_event, payload) => makeFtpDirectory(payload.sessionId, payload.remoteDirectory, payload.name));

ipcMain.handle('ftp:rename', async (_event, payload) => renameFtpEntry(payload.sessionId, payload.entry, payload.name));

ipcMain.handle('ftp:delete', async (_event, payload) => deleteFtpEntry(payload.sessionId, payload.entry));

ipcMain.handle('ftp:disconnect', async (_event, sessionId) => disconnectFtp(sessionId));

ipcMain.handle('emergency:stop', async () => {
  emergencyStop();
  return true;
});
