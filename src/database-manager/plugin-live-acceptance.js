const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { clearRuntimeCredentials } = require('./connection-context');
const { normalizeQueryResult, normalizeSchemaSnapshot } = require('./domain');
const { createInstalledPluginRuntime } = require('./driver-runtime');
const { DatabasePluginRegistry } = require('./plugin-registry');

const PLUGIN_ACCEPTANCE_REPORT_SCHEMA_VERSION = 1;
const PLUGIN_ACCEPTANCE_CONFIGURATION_ENV = 'DEPLOYERX_DB_PLUGIN_ACCEPT_JSON';
const PLUGIN_ACCEPTANCE_REGISTRY_ROOT_ENV = 'DEPLOYERX_DB_PLUGIN_REGISTRY_ROOT';
const PLUGIN_QUERY_ACKNOWLEDGEMENT_ENV = 'DEPLOYERX_DB_PLUGIN_ACCEPT_QUERY';
const PLUGIN_QUERY_ACKNOWLEDGEMENT = 'I_UNDERSTAND_PLUGIN_ACCEPTANCE_QUERY_MUST_BE_READ_ONLY';
const MAX_CONFIGURATION_BYTES = 512 * 1024;
const MAX_PLUGIN_CONFIGURATIONS = 50;
const MAX_QUERY_BYTES = 256 * 1024;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CREDENTIAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,119}$/;
const SENSITIVE_SETTING_KEY = /(?:password|passphrase|private.?key|secret|token|credential|connection.?uri|authorization|cookie|api.?key|client.?key|access.?key)$/i;

class PluginAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PluginAcceptanceError';
    this.code = code;
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function acceptanceError(code) {
  throw new PluginAcceptanceError(code);
}

function safeCode(error, fallback = 'PLUGIN_ACCEPTANCE_CHECK_FAILED') {
  const code = String(error?.code || '');
  return SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

function boundedJson(value, state = { depth: 0, nodes: 0 }) {
  state.nodes += 1;
  if (state.depth > 20 || state.nodes > 10000) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.includes('\0')) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
    return value;
  }
  const childState = { ...state, depth: state.depth + 1 };
  if (Array.isArray(value)) {
    if (value.length > 10000) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
    const result = value.map((item) => boundedJson(item, childState));
    state.nodes = childState.nodes;
    return result;
  }
  if (!plainObject(value)) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
  const result = {};
  for (const key of Object.keys(value)) {
    if (!key || key.length > 200 || key.includes('\0')) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
    result[key] = boundedJson(value[key], childState);
  }
  state.nodes = childState.nodes;
  return result;
}

function containsSensitiveSetting(value, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveSetting(item, depth + 1));
  return Object.entries(value).some(([key, item]) => SENSITIVE_SETTING_KEY.test(key) || containsSensitiveSetting(item, depth + 1));
}

function normalizeConnection(input, pluginId) {
  if (!plainObject(input) || String(input.driverId || '').trim().toLowerCase() !== pluginId || input.accessMode !== 'read-only') {
    acceptanceError('PLUGIN_ACCEPTANCE_CONNECTION_INVALID');
  }
  const credentialsInput = input.credentials === undefined ? {} : input.credentials;
  if (!plainObject(credentialsInput)) acceptanceError('PLUGIN_ACCEPTANCE_CONNECTION_INVALID');
  const credentials = {};
  for (const [key, value] of Object.entries(credentialsInput)) {
    const credentialId = String(key).trim().toLowerCase();
    if (!CREDENTIAL_ID_PATTERN.test(credentialId) || typeof value !== 'string' || value.includes('\0')) acceptanceError('PLUGIN_ACCEPTANCE_CONNECTION_INVALID');
    credentials[credentialId] = value;
  }
  const settings = boundedJson(input.settings === undefined ? {} : input.settings);
  if (!plainObject(settings) || containsSensitiveSetting(settings)) acceptanceError('PLUGIN_ACCEPTANCE_CONNECTION_INVALID');
  const endpoint = boundedJson(input.endpoint === undefined ? { kind: 'none' } : input.endpoint);
  const ssl = boundedJson(input.ssl === undefined ? { mode: 'disabled' } : input.ssl);
  if (!plainObject(endpoint) || !plainObject(ssl)) acceptanceError('PLUGIN_ACCEPTANCE_CONNECTION_INVALID');
  const database = input.database === undefined || input.database === null ? null : String(input.database);
  const defaultSchema = input.defaultSchema === undefined || input.defaultSchema === null ? null : String(input.defaultSchema);
  if ((database && (database.length > 2048 || database.includes('\0'))) || (defaultSchema && (defaultSchema.length > 2048 || defaultSchema.includes('\0')))) {
    acceptanceError('PLUGIN_ACCEPTANCE_CONNECTION_INVALID');
  }
  return { driverId: pluginId, endpoint, database, defaultSchema, accessMode: 'read-only', ssl, settings, credentials };
}

function normalizePluginConfiguration(input) {
  if (!plainObject(input)) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
  const pluginId = String(input.pluginId || '').trim().toLowerCase();
  if (!PLUGIN_ID_PATTERN.test(pluginId)) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
  let query = null;
  if (input.query !== undefined && input.query !== null && input.query !== '') {
    if (typeof input.query !== 'string' || input.query.includes('\0') || Buffer.byteLength(input.query, 'utf8') > MAX_QUERY_BYTES) {
      acceptanceError('PLUGIN_ACCEPTANCE_QUERY_INVALID');
    }
    query = input.query;
  }
  return Object.freeze({ pluginId, connection: normalizeConnection(input.connection, pluginId), query });
}

function acceptanceConfiguration(environment = process.env) {
  const rootValue = environment[PLUGIN_ACCEPTANCE_REGISTRY_ROOT_ENV];
  const registryRoot = typeof rootValue === 'string' ? rootValue.trim() : '';
  if (!registryRoot || registryRoot.includes('\0') || Buffer.byteLength(registryRoot, 'utf8') > 4096 || !path.isAbsolute(registryRoot)) {
    acceptanceError('PLUGIN_ACCEPTANCE_REGISTRY_ROOT_INVALID');
  }
  const serialized = environment[PLUGIN_ACCEPTANCE_CONFIGURATION_ENV];
  if (typeof serialized !== 'string' || !serialized.trim()) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_REQUIRED');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIGURATION_BYTES) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_TOO_LARGE');
  let parsed;
  try { parsed = JSON.parse(serialized); } catch { acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_JSON_INVALID'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_PLUGIN_CONFIGURATIONS) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
  const plugins = parsed.map(normalizePluginConfiguration);
  if (new Set(plugins.map((plugin) => plugin.pluginId)).size !== plugins.length) acceptanceError('PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
  return Object.freeze({ registryRoot: path.resolve(registryRoot), plugins: Object.freeze(plugins) });
}

function validateCredentials(installed, connection) {
  const slots = Array.isArray(installed.driverManifest?.credentialSlots) ? installed.driverManifest.credentialSlots : [];
  const declared = new Set(slots.map((slot) => slot.id));
  for (const credentialId of Object.keys(connection.credentials)) {
    if (!declared.has(credentialId)) acceptanceError('PLUGIN_ACCEPTANCE_CREDENTIAL_UNDECLARED');
  }
  for (const slot of slots) {
    if (slot.required !== false && !connection.credentials[slot.id]) acceptanceError('PLUGIN_ACCEPTANCE_CREDENTIAL_REQUIRED');
  }
}

function integrityFailureCode(record) {
  if (record?.signatureVerified === false) return 'PLUGIN_ACCEPTANCE_SIGNATURE_REQUIRED';
  if (record?.integrityStatus === 'failed') return 'PLUGIN_ACCEPTANCE_INTEGRITY_FAILED';
  if (record?.integrityStatus === 'reinstall-required') return 'PLUGIN_ACCEPTANCE_REINSTALL_REQUIRED';
  if (record && record.enabled === false) return 'PLUGIN_ACCEPTANCE_NOT_ENABLED';
  return 'PLUGIN_ACCEPTANCE_NOT_INSTALLED';
}

function queryRequest(query) {
  return { requestId: `plugin_accept_${crypto.randomUUID()}`, query, page: 1, pageSize: 10, schema: null, batch: false };
}

function schemaRequest() {
  return { requestId: `plugin_accept_${crypto.randomUUID()}`, profileId: 'plugin-acceptance', schema: null, includeSystem: false, maxTables: 100, maxColumnsPerTable: 100 };
}

async function runConfiguredPlugin({ registry, configuration, environment, runtimeFactory }) {
  const report = { pluginId: configuration.pluginId, version: null, status: 'failed', checks: [] };
  const connection = configuration.connection;
  let runtime = null;
  let primaryError = null;
  const check = async (name, operation) => {
    try {
      const result = await operation();
      report.checks.push({ name, status: 'passed' });
      return result;
    } catch (error) {
      report.checks.push({ name, status: 'failed', code: safeCode(error) });
      throw error;
    }
  };
  try {
    const record = registry.listInstalled({ includeDisabled: true }).find((plugin) => plugin.pluginId === configuration.pluginId);
    const installed = registry.getInstalled(configuration.pluginId);
    if (!installed) {
      report.checks.push({ name: 'installed-integrity', status: 'failed', code: integrityFailureCode(record) });
      return report;
    }
    report.version = installed.version;
    await check('installed-integrity', () => registry.verifyInstalled(configuration.pluginId));
    await check('credential-contract', async () => validateCredentials(installed, connection));
    runtime = runtimeFactory({
      installed,
      beforeStart: () => registry.verifyInstalled(configuration.pluginId),
      environment
    });
    await check('system-health', async () => {
      const result = await runtime.health({ timeoutMs: 5000 });
      if (result?.status !== 'ready') acceptanceError('PLUGIN_ACCEPTANCE_HEALTH_FAILED');
    });
    await check('connection-test', async () => {
      const result = await runtime.testConnection(connection, { timeoutMs: 15000 });
      if (result?.status !== 'success') acceptanceError('PLUGIN_ACCEPTANCE_CONNECTION_TEST_FAILED');
    });
    if (installed.driverManifest.capabilities?.schemas === false) {
      report.checks.push({ name: 'schema-discovery', status: 'skipped', code: 'PLUGIN_ACCEPTANCE_SCHEMA_NOT_SUPPORTED' });
    } else {
      await check('schema-discovery', async () => {
        normalizeSchemaSnapshot(await runtime.discoverSchema(connection, schemaRequest(), { timeoutMs: 30000 }));
      });
    }
    if (installed.driverManifest.capabilities?.query === false) {
      report.checks.push({ name: 'read-query', status: 'skipped', code: 'PLUGIN_ACCEPTANCE_QUERY_NOT_SUPPORTED' });
    } else if (!configuration.query) {
      report.checks.push({ name: 'read-query', status: 'failed', code: 'PLUGIN_ACCEPTANCE_QUERY_REQUIRED' });
      primaryError = new PluginAcceptanceError('PLUGIN_ACCEPTANCE_QUERY_REQUIRED');
    } else {
      await check('read-query', async () => {
        const result = await runtime.executeQuery(connection, queryRequest(configuration.query), { timeoutMs: 30000 });
        if (!plainObject(result) || !Array.isArray(result.rows) || result.rows.length > 10) acceptanceError('PLUGIN_ACCEPTANCE_QUERY_RESULT_INVALID');
        normalizeQueryResult(result);
      });
    }
  } catch (error) {
    primaryError = error;
    if (!report.checks.some((check) => check.status === 'failed')) {
      report.checks.push({ name: 'runtime-create', status: 'failed', code: safeCode(error, 'PLUGIN_ACCEPTANCE_RUNTIME_CREATE_FAILED') });
    }
  } finally {
    clearRuntimeCredentials(connection);
    if (runtime) {
      try {
        await runtime.stop();
        report.checks.push({ name: 'runtime-stop', status: 'passed' });
      } catch (error) {
        report.checks.push({ name: 'runtime-stop', status: 'failed', code: safeCode(error, 'PLUGIN_ACCEPTANCE_RUNTIME_STOP_FAILED') });
        primaryError ||= error;
      }
    }
  }
  report.status = primaryError || report.checks.some((check) => check.status === 'failed') ? 'failed' : 'passed';
  return report;
}

function finalizeReport(report) {
  const checks = [...report.checks, ...report.plugins.flatMap((plugin) => plugin.checks)];
  report.summary = {
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    skipped: checks.filter((check) => check.status === 'skipped').length
  };
  report.passed = report.ready && report.summary.failed === 0 && report.plugins.length > 0 && report.plugins.every((plugin) => plugin.status === 'passed');
  return report;
}

async function runPluginLiveAcceptance({
  environment = process.env,
  registryRootStat = fs.stat,
  registryFactory = ({ rootPath }) => new DatabasePluginRegistry({
    rootPath,
    download: async () => acceptanceError('PLUGIN_ACCEPTANCE_INSTALL_NOT_ALLOWED'),
    extract: async () => acceptanceError('PLUGIN_ACCEPTANCE_INSTALL_NOT_ALLOWED')
  }),
  runtimeFactory = (options) => createInstalledPluginRuntime(options)
} = {}) {
  const report = { schemaVersion: PLUGIN_ACCEPTANCE_REPORT_SCHEMA_VERSION, ready: false, passed: false, checks: [], plugins: [], summary: { passed: 0, failed: 0, skipped: 0 } };
  let configuration;
  try {
    configuration = acceptanceConfiguration(environment);
  } catch (error) {
    report.checks.push({ name: 'configuration', status: 'failed', code: safeCode(error, 'PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID') });
    return finalizeReport(report);
  }
  if (configuration.plugins.some((plugin) => plugin.query) && environment[PLUGIN_QUERY_ACKNOWLEDGEMENT_ENV] !== PLUGIN_QUERY_ACKNOWLEDGEMENT) {
    report.checks.push({ name: 'query-acknowledgement', status: 'failed', code: 'PLUGIN_ACCEPTANCE_QUERY_ACK_REQUIRED' });
    return finalizeReport(report);
  }
  let registry;
  try {
    let rootStat;
    try { rootStat = await registryRootStat(configuration.registryRoot); }
    catch { acceptanceError('PLUGIN_ACCEPTANCE_REGISTRY_ROOT_UNAVAILABLE'); }
    if (!rootStat?.isDirectory()) acceptanceError('PLUGIN_ACCEPTANCE_REGISTRY_ROOT_UNAVAILABLE');
    registry = registryFactory({ rootPath: configuration.registryRoot });
    await registry.initialize();
    report.checks.push({ name: 'registry', status: 'passed' });
    report.ready = true;
  } catch (error) {
    report.checks.push({ name: 'registry', status: 'failed', code: safeCode(error, 'PLUGIN_ACCEPTANCE_REGISTRY_UNAVAILABLE') });
    return finalizeReport(report);
  }
  for (const plugin of configuration.plugins) {
    report.plugins.push(await runConfiguredPlugin({ registry, configuration: plugin, environment, runtimeFactory }));
  }
  return finalizeReport(report);
}

async function main() {
  if (process.argv.length > 2) {
    const report = finalizeReport({ schemaVersion: PLUGIN_ACCEPTANCE_REPORT_SCHEMA_VERSION, ready: false, passed: false, checks: [{ name: 'arguments', status: 'failed', code: 'PLUGIN_ACCEPTANCE_ARGUMENTS_NOT_SUPPORTED' }], plugins: [], summary: {} });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const report = await runPluginLiveAcceptance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 2;
}

if (require.main === module) main().catch(() => {
  process.stdout.write(`${JSON.stringify({ schemaVersion: PLUGIN_ACCEPTANCE_REPORT_SCHEMA_VERSION, ready: false, passed: false, checks: [{ name: 'runner', status: 'failed', code: 'PLUGIN_ACCEPTANCE_RUNNER_FAILED' }], plugins: [], summary: { passed: 0, failed: 1, skipped: 0 } }, null, 2)}\n`);
  process.exitCode = 2;
});

module.exports = {
  PLUGIN_ACCEPTANCE_CONFIGURATION_ENV,
  PLUGIN_ACCEPTANCE_REGISTRY_ROOT_ENV,
  PLUGIN_ACCEPTANCE_REPORT_SCHEMA_VERSION,
  PLUGIN_QUERY_ACKNOWLEDGEMENT,
  PLUGIN_QUERY_ACKNOWLEDGEMENT_ENV,
  PluginAcceptanceError,
  acceptanceConfiguration,
  runConfiguredPlugin,
  runPluginLiveAcceptance
};
