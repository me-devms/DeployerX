const crypto = require('node:crypto');
const path = require('node:path');

const REGISTRY_BASE_URL = 'https://registry.tabularis.dev';
const MAX_REMOTE_PLUGINS = 200;

function clientError(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, category: 'database-plugin-registry', retryable });
}

function base64UrlJson(value, label) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw clientError('DATABASE_PLUGIN_SIGNATURE_INVALID', `The plugin ${label} is invalid.`); }
}

function parseRepositoryUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { host: url.hostname.toLowerCase(), owner: parts[0], repository: parts[1].replace(/\.git$/i, '') };
}

function capabilityValue(capabilities, snake, fallback = false) {
  return capabilities?.[snake] === undefined ? fallback : Boolean(capabilities[snake]);
}

function driverManifest(plugin, manifest) {
  const capabilities = manifest.capabilities && typeof manifest.capabilities === 'object' ? manifest.capabilities : {};
  const connectionUri = capabilityValue(capabilities, 'connection_uri')
    || capabilityValue(capabilities, 'connection_string')
    || (typeof capabilities.connection_string_example === 'string' && Boolean(capabilities.connection_string_example.trim()));
  const fileBased = capabilityValue(capabilities, 'file_based');
  const folderBased = capabilityValue(capabilities, 'folder_based');
  const noConnectionRequired = capabilityValue(capabilities, 'no_connection_required');
  const localOnly = fileBased || folderBased || noConnectionRequired;
  const declaredSettings = Array.isArray(manifest.settings) ? manifest.settings.slice(0, 100) : [];
  const sensitiveSetting = (field) => /(?:password|passphrase|secret|token|api.?key|connection.?uri|private.?key|certificate|(?:extra|connection).?properties)/i.test(String(field?.key || ''));
  const credentialSlots = declaredSettings.filter(sensitiveSetting).map((field) => {
    const key = String(field.key || '').toLowerCase().replaceAll('_', '-');
    const type = /connection.?uri/i.test(key) ? 'connection-uri' : /private.?key/i.test(key) ? 'private-key' : /certificate/i.test(key) ? 'certificate' : /password|passphrase/i.test(key) ? 'password' : 'token';
    return { id: key, type, label: field.label || field.key, required: field.required === true };
  });
  if (connectionUri && !credentialSlots.some((slot) => slot.type === 'connection-uri')) credentialSlots.push({ id: 'connection-uri', type: 'connection-uri', label: 'Connection URI', required: true });
  if (!localOnly && !connectionUri && !credentialSlots.length) credentialSlots.push({ id: 'username', type: 'username', label: 'Username', required: false }, { id: 'password', type: 'password', label: 'Password', required: false });
  return {
    id: plugin.id,
    name: manifest.name || plugin.name || plugin.id,
    version: manifest.version || plugin.latestVersion,
    source: 'plugin',
    description: manifest.description || plugin.description || null,
    defaultPort: Number.isInteger(plugin.extensions?.default_port) ? plugin.extensions.default_port : null,
    sqlDialect: capabilities.sql_dialect || capabilities.sqlDialect || manifest.sql_dialect || manifest.sqlDialect || 'generic',
    identifierQuote: capabilities.identifier_quote || capabilities.identifierQuote || manifest.identifier_quote || manifest.identifierQuote || null,
    capabilities: {
      schemas: capabilityValue(capabilities, 'schemas') || fileBased || folderBased,
      fileBased,
      folderBased,
      noConnectionRequired,
      query: capabilities.query !== false,
      batch: capabilityValue(capabilities, 'batch'),
      crud: capabilities.crud === true || capabilities.readonly === false,
      explain: capabilityValue(capabilities, 'explain'),
      schemaChanges: capabilityValue(capabilities, 'manage_tables'),
      views: capabilityValue(capabilities, 'views'),
      materializedViews: capabilityValue(capabilities, 'materialized_views'),
      routines: capabilityValue(capabilities, 'routines'),
      triggers: capabilityValue(capabilities, 'triggers'),
      userManagement: capabilityValue(capabilities, 'user_management'),
      supportsSsl: !localOnly,
      supportsSsh: !localOnly
    },
    credentialSlots,
    settings: { fields: declaredSettings.filter((field) => !sensitiveSetting(field)) },
    runtime: { args: [], methods: {} }
  };
}

function targetFromAsset(assetName, executable) {
  const value = `${assetName} ${executable}`.toLowerCase();
  const platforms = value.includes('linux') ? ['linux'] : value.includes('darwin') || value.includes('macos') ? ['darwin'] : value.includes('windows') || value.includes('win32') || /(^|[-_.])win([-_.]|$)/.test(value) || value.includes('.exe') ? ['win32'] : ['win32', 'darwin', 'linux'];
  const architectures = value.includes('arm64') || value.includes('aarch64') ? ['arm64'] : value.includes('x64') || value.includes('amd64') ? ['x64'] : ['universal'];
  return { platforms, architectures };
}

function entrypointForPlatform(executable, assetName, platform = process.platform) {
  const entrypoint = String(executable || '').trim();
  const target = targetFromAsset(assetName, entrypoint);
  const windowsOnly = target.platforms.length === 1 && target.platforms[0] === 'win32';
  if (platform === 'win32' && windowsOnly && !path.extname(entrypoint)) return `${entrypoint}.exe`;
  return entrypoint;
}

class TabulariumClient {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = REGISTRY_BASE_URL, platform = process.platform, arch = process.arch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Tabularium client requires fetch.');
    this.fetch = fetchImpl;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.platform = platform;
    this.arch = arch;
    this.keyCache = null;
  }

  async requestJson(url) {
    const response = await this.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'DeployerX-Database-Manager' } });
    if (!response?.ok) throw clientError('DATABASE_PLUGIN_REGISTRY_UNAVAILABLE', 'The database plugin registry is unavailable.', true);
    return response.json();
  }

  async loadCatalog() {
    const listing = await this.requestJson(`${this.baseUrl}/api/plugins?limit=${MAX_REMOTE_PLUGINS}`);
    if (!Array.isArray(listing?.plugins) || listing.plugins.length > MAX_REMOTE_PLUGINS) throw clientError('DATABASE_PLUGIN_CATALOG_INVALID', 'The database plugin registry returned an invalid catalog.');
    const approved = listing.plugins.filter((plugin) => plugin?.status === 'approved' && plugin?.id && plugin?.latestVersion);
    const resolved = await Promise.all(approved.map(async (plugin) => {
      try {
        const release = await this.loadPluginRelease(plugin);
        return release
          ? { release }
          : { unavailable: { pluginId: plugin.id, version: plugin.latestVersion, name: plugin.name || plugin.id, description: plugin.description || null, unavailableReason: 'The approved release does not publish a complete signed driver asset.' } };
      } catch (error) {
        return { unavailable: { pluginId: plugin.id, version: plugin.latestVersion, name: plugin.name || plugin.id, description: plugin.description || null, unavailableReason: error?.retryable ? 'Release metadata is temporarily unavailable.' : 'The approved release could not be resolved or validated.' } };
      }
    }));
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      releases: resolved.flatMap((item) => item.release ? [item.release] : []),
      unavailable: resolved.flatMap((item) => item.unavailable ? [item.unavailable] : [])
    };
  }

  async loadPluginRelease(plugin) {
    const detail = await this.requestJson(`${this.baseUrl}/api/plugins/${encodeURIComponent(plugin.id)}`);
    const release = Array.isArray(detail.releases) ? detail.releases.find((item) => item.version === detail.latestVersion) : null;
    const integrity = release?.integrity;
    if (!integrity?.jws || !Array.isArray(integrity.assets)) return null;
    const manifestRaw = String(integrity.manifest_raw || '{}');
    const manifest = JSON.parse(manifestRaw);
    const executable = String(manifest.executable || detail.extensions?.executable || '').trim();
    if (!executable) return null;
    const asset = integrity.assets.filter((item) => !String(item.name || '').endsWith('.tabularium')).sort((left, right) => this.assetScore(right.name) - this.assetScore(left.name))[0];
    if (!asset?.name || !asset.sha256 || !Number.isSafeInteger(Number(asset.size))) return null;
    const url = await this.resolveAssetUrl(detail.repoUrl, release.version, asset.name);
    if (!url) return null;
    const header = base64UrlJson(integrity.jws.split('.')[0], 'signature header');
    const target = targetFromAsset(asset.name, executable);
    return {
      pluginId: detail.id,
      version: release.version,
      name: detail.name || detail.id,
      description: detail.description || null,
      approved: detail.status === 'approved',
      target,
      archive: { name: asset.name, url, size: Number(asset.size), sha256: asset.sha256 },
      signature: { algorithm: 'Ed25519', value: integrity.jws, keyId: header.kid },
      manifestSha256: crypto.createHash('sha256').update(manifestRaw, 'utf8').digest('hex'),
      entrypoint: entrypointForPlatform(executable, asset.name, this.platform),
      driverManifest: driverManifest(detail, manifest)
    };
  }

  assetScore(assetName) {
    const name = String(assetName || '').toLowerCase();
    const platformTokens = this.platform === 'win32' ? ['windows', 'win32', '-win-', '.exe'] : this.platform === 'darwin' ? ['darwin', 'macos'] : ['linux'];
    const archTokens = this.arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'amd64'];
    const hasSpecificPlatform = ['windows', 'win32', '-win-', 'darwin', 'macos', 'linux'].some((token) => name.includes(token));
    const hasSpecificArch = ['arm64', 'aarch64', 'x64', 'amd64'].some((token) => name.includes(token));
    return (platformTokens.some((token) => name.includes(token)) ? 100 : hasSpecificPlatform ? -100 : 20)
      + (archTokens.some((token) => name.includes(token)) ? 10 : hasSpecificArch ? -10 : 2);
  }

  async resolveAssetUrl(repositoryUrl, version, assetName) {
    const repository = parseRepositoryUrl(repositoryUrl);
    if (!repository) return null;
    const tags = [`v${version}`, version];
    if (repository.host === 'github.com') {
      for (const tag of tags) {
        try {
          const release = await this.requestJson(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases/tags/${encodeURIComponent(tag)}`);
          const asset = release.assets?.find((item) => item.name === assetName);
          if (asset?.browser_download_url) return asset.browser_download_url;
        } catch {}
      }
    }
    if (repository.host === 'codeberg.org') {
      for (const tag of tags) {
        try {
          const release = await this.requestJson(`https://codeberg.org/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases/tags/${encodeURIComponent(tag)}`);
          const asset = release.assets?.find((item) => item.name === assetName);
          if (asset?.browser_download_url) return asset.browser_download_url;
        } catch {}
      }
    }
    return null;
  }

  async verifyRelease(release) {
    const compact = String(release?.signature?.value || '').split('.');
    if (compact.length !== 3) return false;
    const header = base64UrlJson(compact[0], 'signature header');
    const claims = base64UrlJson(compact[1], 'signature payload');
    if (header.alg !== 'EdDSA' || !header.kid || claims.v !== 1 || claims.kid !== header.kid
      || claims.registry !== this.baseUrl || claims.plugin_slug !== release.pluginId || claims.release_version !== release.version
      || claims.manifest_sha256 !== release.manifestSha256) return false;
    const matchingAsset = claims.assets?.find((asset) => asset.name === release.archive.name && asset.sha256 === release.archive.sha256 && Number(asset.size) === release.archive.size);
    if (!matchingAsset) return false;
    const keys = await this.loadKeys();
    const jwk = keys.find((key) => key.kid === header.kid && key.kty === 'OKP' && key.crv === 'Ed25519' && key.alg === 'EdDSA');
    if (!jwk) return false;
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return crypto.verify(null, Buffer.from(`${compact[0]}.${compact[1]}`, 'ascii'), publicKey, Buffer.from(compact[2], 'base64url'));
  }

  async loadKeys() {
    if (!this.keyCache) {
      const document = await this.requestJson(`${this.baseUrl}/.well-known/registry-key.json`);
      if (!Array.isArray(document?.keys) || !document.keys.length) throw clientError('DATABASE_PLUGIN_REGISTRY_KEY_INVALID', 'The database plugin registry key document is invalid.');
      this.keyCache = document.keys;
    }
    return this.keyCache;
  }
}

module.exports = { REGISTRY_BASE_URL, TabulariumClient, driverManifest, entrypointForPlatform, parseRepositoryUrl, targetFromAsset };
