const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { JSONPath } = require('jsonpath-plus');

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_RESPONSE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);

function elapsedMilliseconds(started) {
  return Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1e6));
}

function safeError(error, fallback = 'Check failed.') {
  const code = String(error?.code || 'UPTIME_CHECK_FAILED').slice(0, 100);
  const source = String(error?.message || fallback).replace(/[\r\n]+/g, ' ').trim();
  return { code, message: source.slice(0, 500) || fallback };
}

function failureCategory(error) {
  const code = String(error?.code || '').toUpperCase();
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UPTIME_CHECK_TIMEOUT'].includes(code)) return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'connection';
  if (/CERT|TLS|SSL/.test(code)) return 'tls';
  if (code === 'UPTIME_RESPONSE_TOO_LARGE') return 'response-size';
  return 'execution';
}

function sanitizedHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [String(key).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')])
      .filter(([key]) => !SENSITIVE_RESPONSE_HEADERS.has(key))
      .slice(0, 100)
  );
}

function statusMatches(statusCode, ranges = []) {
  return ranges.some((range) => statusCode >= Number(range.minimum) && statusCode <= Number(range.maximum));
}

function compareAssertion(actualValues, assertion) {
  const values = Array.isArray(actualValues) ? actualValues : [actualValues];
  const present = values.some((value) => value !== undefined && value !== null);
  if (assertion.operator === 'exists') return present;
  if (assertion.operator === 'not-exists') return !present;
  const expected = String(assertion.expected ?? '');
  return values.some((value) => {
    const actual = typeof value === 'string' ? value : JSON.stringify(value);
    const left = assertion.caseSensitive ? actual : actual.toLowerCase();
    const right = assertion.caseSensitive ? expected : expected.toLowerCase();
    if (assertion.operator === 'equals') return left === right;
    if (assertion.operator === 'not-equals') return left !== right;
    if (assertion.operator === 'contains') return left.includes(right);
    if (assertion.operator === 'not-contains') return !left.includes(right);
    if (assertion.operator === 'matches') {
      try { return new RegExp(expected, assertion.caseSensitive ? '' : 'i').test(actual); }
      catch { return false; }
    }
    return false;
  });
}

function evaluateAssertions(assertions, response) {
  if (!assertions.length) return { passed: true, results: [] };
  let parsedJson;
  let jsonError = null;
  const results = assertions.map((assertion) => {
    let values;
    if (assertion.target === 'body') values = response.body;
    else if (assertion.target === 'header') values = response.headers[String(assertion.selector).toLowerCase()];
    else {
      if (parsedJson === undefined && !jsonError) {
        try { parsedJson = JSON.parse(response.body); }
        catch (error) { jsonError = error; }
      }
      if (jsonError) values = undefined;
      else {
        try { values = JSONPath({ path: assertion.selector, json: parsedJson, wrap: true }); }
        catch { values = undefined; }
      }
    }
    const passed = compareAssertion(values, assertion);
    return { target: assertion.target, selector: assertion.selector, operator: assertion.operator, passed };
  });
  return { passed: results.every((result) => result.passed), results };
}

function certificateDetails(socket) {
  if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
  const certificate = socket.getPeerCertificate();
  if (!certificate || !Object.keys(certificate).length) return null;
  const validToMs = Date.parse(certificate.valid_to || '');
  return {
    subject: certificate.subject?.CN || '',
    issuer: certificate.issuer?.CN || '',
    validFrom: certificate.valid_from ? new Date(certificate.valid_from).toISOString() : null,
    validTo: Number.isFinite(validToMs) ? new Date(validToMs).toISOString() : null,
    fingerprint256: String(certificate.fingerprint256 || ''),
    daysRemaining: Number.isFinite(validToMs) ? Math.floor((validToMs - Date.now()) / 86400000) : null,
    authorized: socket.authorized !== false,
    authorizationError: String(socket.authorizationError || '')
  };
}

function applyLatencyPolicy(result, monitor) {
  if (result.outcome === 'down' || result.latencyMs == null) return result;
  const critical = Number(monitor.alertPolicy?.latencyCriticalMs || 0);
  const warning = Number(monitor.alertPolicy?.latencyWarningMs || 0);
  if (critical > 0 && result.latencyMs > critical) {
    return { ...result, outcome: 'down', ok: false, failureCategory: 'latency', summary: `Latency ${result.latencyMs} ms exceeded the critical threshold of ${critical} ms.` };
  }
  if (warning > 0 && result.latencyMs > warning) {
    return { ...result, outcome: 'warning', ok: true, failureCategory: 'latency', summary: `Latency ${result.latencyMs} ms exceeded the warning threshold of ${warning} ms.` };
  }
  return result;
}

async function resolveRequestHeaders(config, secretResolver, monitor) {
  const headers = { ...(config.headers || {}) };
  for (const [headerName, secretRefId] of Object.entries(config.secretHeaderRefs || {})) {
    if (typeof secretResolver !== 'function') {
      const error = new Error(`Secret resolver is required for ${headerName}.`);
      error.code = 'UPTIME_SECRET_REQUIRED';
      throw error;
    }
    headers[headerName] = String(await secretResolver(secretRefId, { headerName, monitor }));
  }
  return headers;
}

function requestOnce({ requestUrl, method, headers, body, timeoutMs, verifyTls, maximumResponseBytes, captureBody, clients }) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const client = requestUrl.protocol === 'https:' ? clients.https : clients.http;
    let completed = false;
    const finish = (error, value) => {
      if (completed) return;
      completed = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = client.request(requestUrl, { method, headers, rejectUnauthorized: verifyTls }, (response) => {
      const chunks = [];
      let size = 0;
      if (!captureBody) {
        const contentLength = Number(response.headers['content-length']);
        finish(null, {
          statusCode: Number(response.statusCode || 0),
          headers: sanitizedHeaders(response.headers),
          body: '',
          bodyBytes: Number.isFinite(contentLength) ? contentLength : null,
          latencyMs: elapsedMilliseconds(started),
          certificate: certificateDetails(response.socket)
        });
        response.destroy();
        request.destroy();
        return;
      }
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maximumResponseBytes) {
          const error = new Error(`Response exceeded the ${maximumResponseBytes}-byte capture limit.`);
          error.code = 'UPTIME_RESPONSE_TOO_LARGE';
          finish(error);
          response.destroy();
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => finish(null, {
        statusCode: Number(response.statusCode || 0),
        headers: sanitizedHeaders(response.headers),
        body: Buffer.concat(chunks).toString('utf8'),
        bodyBytes: size,
        latencyMs: elapsedMilliseconds(started),
        certificate: certificateDetails(response.socket)
      }));
      response.once('error', (error) => finish(error));
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`Request timed out after ${timeoutMs} ms.`);
      error.code = 'UPTIME_CHECK_TIMEOUT';
      request.destroy(error);
    });
    request.once('error', (error) => finish(error));
    if (body) request.write(body);
    request.end();
  });
}

async function runHttpCheck(monitor, options = {}) {
  const config = monitor.config;
  const headers = await resolveRequestHeaders(config, options.secretResolver, monitor);
  let requestUrl = new URL(config.url);
  let method = config.method;
  let body = config.body;
  const redirects = [];
  const clients = options.clients || { http, https };
  const maximumResponseBytes = Number(options.maximumResponseBytes || DEFAULT_MAXIMUM_RESPONSE_BYTES);
  const captureBody = (config.assertions || []).some((assertion) => ['body', 'jsonpath'].includes(assertion.target));
  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await requestOnce({ requestUrl, method, headers, body, timeoutMs: monitor.timeoutMs, verifyTls: config.verifyTls, maximumResponseBytes, captureBody, clients });
    const location = response.headers.location;
    if (config.followRedirects && REDIRECT_STATUSES.has(response.statusCode) && location) {
      if (redirectCount >= config.maximumRedirects) {
        return { ok: false, outcome: 'down', latencyMs: response.latencyMs, statusCode: response.statusCode, failureCategory: 'redirect', summary: `HTTP redirect limit of ${config.maximumRedirects} was exceeded.`, details: { redirects, responseHeaders: response.headers, bodyBytes: response.bodyBytes } };
      }
      requestUrl = new URL(location, requestUrl);
      redirects.push(requestUrl.toString());
      if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && method === 'POST')) { method = 'GET'; body = ''; }
      continue;
    }
    const statusPassed = statusMatches(response.statusCode, config.expectedStatusRanges);
    const assertions = evaluateAssertions(config.assertions || [], response);
    if (!statusPassed || !assertions.passed) {
      const reason = !statusPassed ? `HTTP ${response.statusCode} was outside the expected status range.` : `${assertions.results.filter((result) => !result.passed).length} response assertion${assertions.results.filter((result) => !result.passed).length === 1 ? '' : 's'} failed.`;
      return { ok: false, outcome: 'down', latencyMs: response.latencyMs, statusCode: response.statusCode, failureCategory: !statusPassed ? 'http-status' : 'assertion', summary: reason, details: { finalUrl: requestUrl.toString(), redirects, responseHeaders: response.headers, bodyBytes: response.bodyBytes, assertions: assertions.results, certificate: response.certificate } };
    }
    return applyLatencyPolicy({ ok: true, outcome: 'up', latencyMs: response.latencyMs, statusCode: response.statusCode, failureCategory: '', summary: `HTTP ${response.statusCode} in ${response.latencyMs} ms.`, details: { finalUrl: requestUrl.toString(), redirects, responseHeaders: response.headers, bodyBytes: response.bodyBytes, assertions: assertions.results, certificate: response.certificate } }, monitor);
  }
}

function runTcpCheck(monitor, options = {}) {
  return new Promise((resolve) => {
    const socketFactory = options.socketFactory || (() => new net.Socket());
    const socket = socketFactory();
    const started = process.hrtime.bigint();
    let completed = false;
    const finish = (result) => {
      if (completed) return;
      completed = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(monitor.timeoutMs);
    socket.once('connect', () => {
      const latencyMs = elapsedMilliseconds(started);
      finish(applyLatencyPolicy({ ok: true, outcome: 'up', latencyMs, statusCode: null, failureCategory: '', summary: `TCP connection succeeded in ${latencyMs} ms.`, details: { host: monitor.config.host, port: monitor.config.port } }, monitor));
    });
    socket.once('timeout', () => finish({ ok: false, outcome: 'down', latencyMs: elapsedMilliseconds(started), statusCode: null, failureCategory: 'timeout', summary: `TCP connection timed out after ${monitor.timeoutMs} ms.`, details: { host: monitor.config.host, port: monitor.config.port } }));
    socket.once('error', (error) => { const safe = safeError(error, 'TCP connection failed.'); finish({ ok: false, outcome: 'down', latencyMs: elapsedMilliseconds(started), statusCode: null, failureCategory: failureCategory(error), summary: safe.message, errorCode: safe.code, details: { host: monitor.config.host, port: monitor.config.port } }); });
    socket.connect(monitor.config.port, monitor.config.host);
  });
}

function runTlsCheck(monitor, options = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let completed = false;
    let socket;
    const finish = (result) => {
      if (completed) return;
      completed = true;
      socket?.destroy();
      resolve(result);
    };
    const connect = options.tlsConnect || tls.connect;
    socket = connect({ host: monitor.config.host, port: monitor.config.port, servername: monitor.config.serverName || monitor.config.host, rejectUnauthorized: monitor.config.verifyTls }, () => {
      const latencyMs = elapsedMilliseconds(started);
      const certificate = certificateDetails(socket);
      if (!certificate?.validTo || certificate.daysRemaining == null) return finish({ ok: false, outcome: 'down', latencyMs, statusCode: null, failureCategory: 'tls-certificate', summary: 'The TLS peer did not provide a readable certificate.', details: { host: monitor.config.host, port: monitor.config.port } });
      if (certificate.daysRemaining <= monitor.config.expiryCriticalDays) return finish({ ok: false, outcome: 'down', latencyMs, statusCode: null, failureCategory: 'tls-expiry', summary: `TLS certificate expires in ${certificate.daysRemaining} day${certificate.daysRemaining === 1 ? '' : 's'}.`, details: { host: monitor.config.host, port: monitor.config.port, certificate } });
      if (certificate.daysRemaining <= monitor.config.expiryWarningDays) return finish({ ok: true, outcome: 'warning', latencyMs, statusCode: null, failureCategory: 'tls-expiry', summary: `TLS certificate expires in ${certificate.daysRemaining} days.`, details: { host: monitor.config.host, port: monitor.config.port, certificate } });
      finish(applyLatencyPolicy({ ok: true, outcome: 'up', latencyMs, statusCode: null, failureCategory: '', summary: `TLS certificate is valid for ${certificate.daysRemaining} more days.`, details: { host: monitor.config.host, port: monitor.config.port, certificate } }, monitor));
    });
    socket.setTimeout(monitor.timeoutMs, () => { const error = new Error(`TLS connection timed out after ${monitor.timeoutMs} ms.`); error.code = 'UPTIME_CHECK_TIMEOUT'; socket.destroy(error); });
    socket.once('error', (error) => { const safe = safeError(error, 'TLS connection failed.'); finish({ ok: false, outcome: 'down', latencyMs: elapsedMilliseconds(started), statusCode: null, failureCategory: failureCategory(error), summary: safe.message, errorCode: safe.code, details: { host: monitor.config.host, port: monitor.config.port } }); });
  });
}

async function runMonitorCheck(monitor, options = {}) {
  const startedAt = new Date().toISOString();
  try {
    const result = monitor.type === 'tcp' ? await runTcpCheck(monitor, options) : monitor.type === 'tls' ? await runTlsCheck(monitor, options) : await runHttpCheck(monitor, options);
    return { ...result, startedAt, completedAt: new Date().toISOString(), type: monitor.type };
  } catch (error) {
    const safe = safeError(error);
    return { ok: false, outcome: 'down', latencyMs: null, statusCode: null, failureCategory: failureCategory(error), summary: safe.message, errorCode: safe.code, details: {}, startedAt, completedAt: new Date().toISOString(), type: monitor.type };
  }
}

module.exports = {
  DEFAULT_MAXIMUM_RESPONSE_BYTES,
  applyLatencyPolicy,
  compareAssertion,
  evaluateAssertions,
  failureCategory,
  runHttpCheck,
  runMonitorCheck,
  runTcpCheck,
  runTlsCheck,
  safeError,
  sanitizedHeaders,
  statusMatches
};
