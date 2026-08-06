const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const AUDIT_SCHEMA_VERSION = 1;
const LOG_SCHEMA_VERSION = 1;
const INITIAL_HASH = '0'.repeat(64);
const MAX_STRING_LENGTH = 4096;
const MAX_COLLECTION_ITEMS = 100;
const MAX_DEPTH = 8;
const MAX_LOG_BYTES = 64 * 1024;

const SAFE_KEY_NAMES = new Set([
  'adapterid',
  'idempotencykey',
  'keyversion',
  'objectkey',
  'providerkey',
  'publickeyfingerprint',
  'secretrefid',
  'secretrefids',
  'secrettype'
]);

const SENSITIVE_KEY_NAMES = new Set([
  'accesstoken',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'ciphertext',
  'connectionstring',
  'idtoken',
  'password',
  'passphrase',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretkey',
  'secretvalue',
  'setcookie',
  'signedurl',
  'token'
]);

function nowIso() {
  return new Date().toISOString();
}

function requiredText(value, label, maximumLength = 200) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maximumLength) throw new Error(`${label} is too long.`);
  return normalized;
}

function normalizedKeyName(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizedKeyName(key);
  if (SAFE_KEY_NAMES.has(normalized)) return false;
  if (SENSITIVE_KEY_NAMES.has(normalized)) return true;
  return /(password|passphrase|privatekey|accesstoken|refreshtoken|idtoken|secretkey|apikey|authorization|credential|ciphertext|signedurl)$/.test(normalized);
}

function sanitizeString(value) {
  let output = String(value || '');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(output)) return '[REDACTED_PRIVATE_KEY]';
  output = output.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]');
  output = output.replace(
    /([?&](?:x-amz-signature|x-amz-credential|sig|signature|token|access_token|code|api[_-]?key|access[_-]?key)=)[^&\s]+/gi,
    '$1[REDACTED]'
  );
  output = output.replace(
    /\b(password|passphrase|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
    '$1=[REDACTED]'
  );
  output = output.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  if (output.length > MAX_STRING_LENGTH) output = `${output.slice(0, MAX_STRING_LENGTH)}[TRUNCATED]`;
  return output;
}

function sanitizeForLog(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return sanitizeString(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return '[REDACTED_BINARY]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: sanitizeString(value.name), message: sanitizeString(value.message) };
  }
  if (typeof value !== 'object') return sanitizeString(String(value));
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => sanitizeForLog(item, depth + 1, seen));
      if (value.length > MAX_COLLECTION_ITEMS) items.push(`[TRUNCATED_${value.length - MAX_COLLECTION_ITEMS}_ITEMS]`);
      return items;
    }
    const result = {};
    const entries = Object.entries(value).slice(0, MAX_COLLECTION_ITEMS);
    for (const [key, item] of entries) {
      const safeKey = sanitizeString(key).slice(0, 200);
      result[safeKey] = isSensitiveKey(key) ? '[REDACTED]' : sanitizeForLog(item, depth + 1, seen);
    }
    if (Object.keys(value).length > MAX_COLLECTION_ITEMS) result.__truncatedKeys = true;
    return result;
  } finally {
    seen.delete(value);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function workspaceFileKey(workspaceId) {
  return sha256(requiredText(workspaceId, 'Workspace ID')).slice(0, 32);
}

async function readJsonLines(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

class BackupAuditStore {
  constructor({ rootPath, clock = nowIso }) {
    this.rootPath = requiredText(rootPath, 'Audit store path', 4096);
    this.clock = clock;
    this.chainState = new Map();
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
  }

  async append(input = {}) {
    return this.#withLock(async () => {
      await this.initialize();
      const workspaceId = requiredText(input.workspaceId, 'Workspace ID');
      const state = await this.#loadChainState(workspaceId);
      const occurredAt = this.clock();
      const event = {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        eventId: `audit_${crypto.randomUUID()}`,
        sequence: state.sequence + 1,
        workspaceId,
        occurredAt,
        actor: {
          type: requiredText(input.actor?.type || 'system', 'Actor type', 40),
          id: requiredText(input.actor?.id || 'system', 'Actor ID')
        },
        action: requiredText(input.action, 'Audit action'),
        resource: {
          type: requiredText(input.resource?.type || 'backup-manager', 'Resource type'),
          id: input.resource?.id ? requiredText(input.resource.id, 'Resource ID') : null
        },
        outcome: this.#allowedOutcome(input.outcome),
        severity: this.#allowedSeverity(input.severity),
        correlationId: input.correlationId ? requiredText(input.correlationId, 'Correlation ID') : null,
        details: sanitizeForLog(input.details || {}),
        previousHash: state.lastHash
      };
      event.hash = sha256(stableStringify(event));
      await fs.appendFile(this.#filePath(workspaceId), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.chainState.set(workspaceId, { sequence: event.sequence, lastHash: event.hash });
      return structuredClone(event);
    });
  }

  async list(workspaceId, { limit = 100 } = {}) {
    return this.#withLock(async () => {
      await this.initialize();
      const normalizedWorkspaceId = requiredText(workspaceId, 'Workspace ID');
      const boundedLimit = Math.max(1, Math.min(1000, Math.round(Number(limit) || 100)));
      const events = await readJsonLines(this.#filePath(normalizedWorkspaceId));
      return events.slice(-boundedLimit).reverse();
    });
  }

  async verify(workspaceId) {
    return this.#withLock(async () => {
      await this.initialize();
      const normalizedWorkspaceId = requiredText(workspaceId, 'Workspace ID');
      const events = await readJsonLines(this.#filePath(normalizedWorkspaceId));
      return this.#verifyEvents(events, normalizedWorkspaceId);
    });
  }

  #filePath(workspaceId) {
    return path.join(this.rootPath, `${workspaceFileKey(workspaceId)}.jsonl`);
  }

  #allowedOutcome(value) {
    const outcome = String(value || 'success');
    if (!['attempt', 'success', 'failure', 'denied'].includes(outcome)) throw new Error('Audit outcome is invalid.');
    return outcome;
  }

  #allowedSeverity(value) {
    const severity = String(value || 'info');
    if (!['info', 'warning', 'critical'].includes(severity)) throw new Error('Audit severity is invalid.');
    return severity;
  }

  #verifyEvents(events, workspaceId) {
    let previousHash = INITIAL_HASH;
    let expectedSequence = 1;
    for (const event of events) {
      const storedHash = event.hash;
      const withoutHash = { ...event };
      delete withoutHash.hash;
      if (event.workspaceId !== workspaceId) {
        return { valid: false, count: expectedSequence - 1, error: 'workspace-mismatch', lastHash: previousHash };
      }
      if (event.sequence !== expectedSequence) {
        return { valid: false, count: expectedSequence - 1, error: 'sequence-mismatch', lastHash: previousHash };
      }
      if (event.previousHash !== previousHash) {
        return { valid: false, count: expectedSequence - 1, error: 'previous-hash-mismatch', lastHash: previousHash };
      }
      if (storedHash !== sha256(stableStringify(withoutHash))) {
        return { valid: false, count: expectedSequence - 1, error: 'event-hash-mismatch', lastHash: previousHash };
      }
      previousHash = storedHash;
      expectedSequence += 1;
    }
    return { valid: true, count: events.length, error: null, lastHash: previousHash };
  }

  async #loadChainState(workspaceId) {
    if (this.chainState.has(workspaceId)) return this.chainState.get(workspaceId);
    const events = await readJsonLines(this.#filePath(workspaceId));
    const verification = this.#verifyEvents(events, workspaceId);
    if (!verification.valid) throw new Error(`Backup Manager audit chain is invalid: ${verification.error}.`);
    const state = { sequence: verification.count, lastHash: verification.lastHash };
    this.chainState.set(workspaceId, state);
    return state;
  }

  async #withLock(operation) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class StructuredLogStore {
  constructor({ rootPath, clock = nowIso, maximumEntryBytes = MAX_LOG_BYTES, retentionDays = 30 }) {
    this.rootPath = requiredText(rootPath, 'Log store path', 4096);
    this.clock = clock;
    this.maximumEntryBytes = maximumEntryBytes;
    this.retentionDays = Math.max(1, Math.min(3650, Math.round(Number(retentionDays) || 30)));
    this.lastPrunedDate = new Map();
    this.queue = Promise.resolve();
  }

  async append(input = {}) {
    return this.#withLock(async () => {
      const workspaceId = requiredText(input.workspaceId, 'Workspace ID');
      const timestamp = this.clock();
      const entry = {
        schemaVersion: LOG_SCHEMA_VERSION,
        logId: `log_${crypto.randomUUID()}`,
        timestamp,
        workspaceId,
        level: this.#allowedLevel(input.level),
        component: requiredText(input.component, 'Log component'),
        message: sanitizeString(requiredText(input.message, 'Log message', 10000)),
        correlationId: input.correlationId ? requiredText(input.correlationId, 'Correlation ID') : null,
        context: sanitizeForLog(input.context || {})
      };
      let serialized = JSON.stringify(entry);
      if (Buffer.byteLength(serialized, 'utf8') > this.maximumEntryBytes) {
        entry.context = { truncated: true };
        entry.message = sanitizeString(entry.message).slice(0, 1024);
        serialized = JSON.stringify(entry);
      }
      const directory = path.join(this.rootPath, workspaceFileKey(workspaceId));
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const logDate = timestamp.slice(0, 10);
      await this.#prune(directory, workspaceId, timestamp, logDate);
      await fs.appendFile(path.join(directory, `${logDate}.jsonl`), `${serialized}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      return structuredClone(entry);
    });
  }

  async list(workspaceId, options = {}) {
    return this.#withLock(async () => {
      const normalizedWorkspaceId = requiredText(workspaceId, 'Workspace ID');
      const limit = Math.max(1, Math.min(1000, Math.round(Number(options.limit) || 200)));
      const correlationId = options.correlationId ? requiredText(options.correlationId, 'Correlation ID') : null;
      const component = options.component ? requiredText(options.component, 'Log component') : null;
      const levels = Array.isArray(options.levels) ? new Set(options.levels.filter((level) => ['debug', 'info', 'warning', 'error'].includes(level))) : null;
      const directory = path.join(this.rootPath, workspaceFileKey(normalizedWorkspaceId));
      let names;
      try { names = await fs.readdir(directory); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
      const files = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse();
      const output = [];
      for (const name of files) {
        const entries = await readJsonLines(path.join(directory, name));
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          if (entry.workspaceId !== normalizedWorkspaceId) continue;
          if (correlationId && entry.correlationId !== correlationId) continue;
          if (component && entry.component !== component) continue;
          if (levels && !levels.has(entry.level)) continue;
          output.push(entry);
          if (output.length >= limit) return output;
        }
      }
      return output;
    });
  }

  logger({ workspaceId, component, correlationId = null, baseContext = {} }) {
    return new RedactingLogger({
      sink: this,
      workspaceId,
      component,
      correlationId,
      baseContext
    });
  }

  #allowedLevel(value) {
    const level = String(value || 'info');
    if (!['debug', 'info', 'warning', 'error'].includes(level)) throw new Error('Log level is invalid.');
    return level;
  }

  async #prune(directory, workspaceId, timestamp, logDate) {
    if (this.lastPrunedDate.get(workspaceId) === logDate) return;
    const cutoff = new Date(timestamp);
    cutoff.setUTCDate(cutoff.getUTCDate() - this.retentionDays);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const names = await fs.readdir(directory);
    await Promise.all(
      names
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoffDate)
        .map((name) => fs.rm(path.join(directory, name), { force: true }))
    );
    this.lastPrunedDate.set(workspaceId, logDate);
  }

  async #withLock(operation) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class RedactingLogger {
  constructor({ sink, workspaceId, component, correlationId, baseContext }) {
    this.sink = sink;
    this.workspaceId = workspaceId;
    this.component = component;
    this.correlationId = correlationId;
    this.baseContext = sanitizeForLog(baseContext || {});
  }

  debug(message, context = {}) {
    return this.#write('debug', message, context);
  }

  info(message, context = {}) {
    return this.#write('info', message, context);
  }

  warn(message, context = {}) {
    return this.#write('warning', message, context);
  }

  error(message, context = {}) {
    return this.#write('error', message, context);
  }

  #write(level, message, context) {
    return this.sink.append({
      workspaceId: this.workspaceId,
      component: this.component,
      correlationId: this.correlationId,
      level,
      message,
      context: { ...this.baseContext, ...sanitizeForLog(context || {}) }
    });
  }
}

module.exports = {
  BackupAuditStore,
  RedactingLogger,
  StructuredLogStore,
  sanitizeForLog,
  sanitizeString
};
