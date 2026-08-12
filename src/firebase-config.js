'use strict';

const PLACEHOLDER_PATTERN = /(?:^|[^a-z])(your|replace|example|placeholder)[_-]/i;
const GOOGLE_CLIENT_ID_PATTERN = /^[0-9]+-[0-9A-Za-z_-]+\.apps\.googleusercontent\.com$/;

function text(value) {
  return String(value || '').trim();
}

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(text(value));
}

function normalizeFirebaseConfig(config = {}) {
  return {
    apiKey: text(config.apiKey),
    authDomain: text(config.authDomain),
    projectId: text(config.projectId || config.project_id),
    googleClientId: text(config.googleClientId || config.googleOAuthClientId),
    googleClientSecret: text(config.googleClientSecret || config.googleOAuthClientSecret),
    googleRedirectUri: text(config.googleRedirectUri)
  };
}

function validateFirebaseConfig(config, { requireGoogle = false } = {}) {
  const normalized = normalizeFirebaseConfig(config);
  const errors = [];

  for (const field of ['apiKey', 'projectId']) {
    if (!normalized[field]) errors.push(`${field} is required.`);
    else if (isPlaceholder(normalized[field])) errors.push(`${field} contains a placeholder value.`);
  }

  if (normalized.authDomain && isPlaceholder(normalized.authDomain)) {
    errors.push('authDomain contains a placeholder value.');
  }

  if (requireGoogle && !normalized.googleClientId) {
    errors.push('googleClientId is required.');
  } else if (normalized.googleClientId) {
    if (isPlaceholder(normalized.googleClientId)) {
      errors.push('googleClientId contains a placeholder value.');
    } else if (!GOOGLE_CLIENT_ID_PATTERN.test(normalized.googleClientId)) {
      errors.push('googleClientId is not a valid Google OAuth client ID.');
    }
  }

  if (normalized.googleRedirectUri) {
    try {
      const redirect = new URL(normalized.googleRedirectUri);
      if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(redirect.hostname)) {
        errors.push('googleRedirectUri must use http://127.0.0.1 or http://localhost.');
      }
    } catch {
      errors.push('googleRedirectUri is not a valid URL.');
    }
  }

  return { valid: errors.length === 0, errors, config: normalized };
}

function assertFirebaseConfig(config, options) {
  const result = validateFirebaseConfig(config, options);
  if (!result.valid) throw new Error(`Firebase configuration is invalid: ${result.errors.join(' ')}`);
  return result.config;
}

function sanitizeFirebaseConfigForRuntime(config) {
  const normalized = normalizeFirebaseConfig(config);
  const baseConfig = {
    ...normalized,
    googleClientId: '',
    googleClientSecret: '',
    googleRedirectUri: ''
  };
  if (!validateFirebaseConfig(baseConfig).valid) return null;
  if (validateFirebaseConfig(normalized, { requireGoogle: true }).valid) return normalized;
  return baseConfig;
}

module.exports = {
  assertFirebaseConfig,
  isPlaceholder,
  normalizeFirebaseConfig,
  sanitizeFirebaseConfigForRuntime,
  validateFirebaseConfig
};
