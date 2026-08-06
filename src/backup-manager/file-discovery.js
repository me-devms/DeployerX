const crypto = require('crypto');

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const MAX_DIRECTORY_ENTRIES = 50000;
const ALLOWED_TYPES = new Set(['directory', 'file', 'symlink', 'other']);

class FileDiscoveryError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'FileDiscoveryError';
    this.code = code;
    this.category = options.category || 'discovery';
    this.retryable = Boolean(options.retryable);
  }
}

function boundedText(value, label, maximumLength) {
  const text = String(value ?? '');
  if (!text) throw new FileDiscoveryError('DISCOVERY_INPUT_INVALID', `${label} is required.`);
  if (text.includes('\0') || text.length > maximumLength) {
    throw new FileDiscoveryError('DISCOVERY_INPUT_INVALID', `${label} is invalid.`);
  }
  return text;
}

function normalizePageSize(value) {
  const parsed = Number(value ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new FileDiscoveryError('DISCOVERY_PAGE_SIZE_INVALID', `Page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return parsed;
}

function directoryDigest(directoryPath) {
  return crypto.createHash('sha256').update(directoryPath).digest('hex').slice(0, 24);
}

function encodeCursor(directoryPath, after) {
  return Buffer.from(JSON.stringify({ v: 1, d: directoryDigest(directoryPath), after }), 'utf8').toString('base64url');
}

function decodeCursor(cursor, directoryPath) {
  if (!cursor) return null;
  const raw = boundedText(cursor, 'Discovery cursor', 2048);
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || parsed.d !== directoryDigest(directoryPath) || typeof parsed.after !== 'string' || parsed.after.length > 2048) {
      throw new Error('invalid');
    }
    return parsed.after;
  } catch {
    throw new FileDiscoveryError('DISCOVERY_CURSOR_INVALID', 'The directory page cursor is invalid or belongs to another path. Refresh this folder.');
  }
}

function entrySortKey(entry) {
  const rank = entry.type === 'directory' ? '0' : entry.type === 'file' ? '1' : entry.type === 'symlink' ? '2' : '3';
  return `${rank}\0${entry.name.toLocaleLowerCase('en-US')}\0${entry.name}`;
}

function stableEntryId(adapterId, entryPath, type) {
  return `entry_${crypto.createHash('sha256').update(`${adapterId}\0${type}\0${entryPath}`).digest('hex').slice(0, 32)}`;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeEntry(raw, adapterId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = boundedText(raw.name, 'Entry name', 1024);
  const entryPath = boundedText(raw.path, 'Entry path', 4096);
  const type = ALLOWED_TYPES.has(raw.type) ? raw.type : 'other';
  const size = Number.isSafeInteger(raw.size) && raw.size >= 0 ? raw.size : null;
  const mode = Number.isInteger(raw.mode) && raw.mode >= 0 ? raw.mode : null;
  return {
    id: stableEntryId(adapterId, entryPath, type),
    name,
    path: entryPath,
    type,
    size,
    modifiedAt: normalizeTimestamp(raw.modifiedAt),
    mode,
    hidden: Boolean(raw.hidden),
    accessible: raw.accessible !== false
  };
}

function createDiscoveryPage({ adapterId, directoryPath, parentPath = null, entries, cursor = null, pageSize }) {
  const normalizedAdapterId = boundedText(adapterId, 'Adapter ID', 120);
  const normalizedPath = boundedText(directoryPath, 'Directory path', 4096);
  if (!Array.isArray(entries)) throw new FileDiscoveryError('DISCOVERY_RESULT_INVALID', 'The source adapter returned an invalid directory listing.');
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    throw new FileDiscoveryError('DISCOVERY_DIRECTORY_TOO_LARGE', `This directory contains more than ${MAX_DIRECTORY_ENTRIES} entries. Narrow the source path before browsing it.`);
  }
  const limit = normalizePageSize(pageSize);
  const after = decodeCursor(cursor, normalizedPath);
  const normalizedEntries = entries.map((entry) => normalizeEntry(entry, normalizedAdapterId)).filter(Boolean);
  normalizedEntries.sort((left, right) => entrySortKey(left).localeCompare(entrySortKey(right), 'en-US'));
  const start = after ? normalizedEntries.findIndex((entry) => entrySortKey(entry).localeCompare(after, 'en-US') > 0) : 0;
  const offset = start < 0 ? normalizedEntries.length : start;
  const items = normalizedEntries.slice(offset, offset + limit);
  const hasMore = offset + items.length < normalizedEntries.length;
  return {
    adapterId: normalizedAdapterId,
    path: normalizedPath,
    parentPath: parentPath === null ? null : boundedText(parentPath, 'Parent path', 4096),
    items,
    nextCursor: hasMore && items.length ? encodeCursor(normalizedPath, entrySortKey(items[items.length - 1])) : null,
    hasMore,
    pageSize: limit
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  FileDiscoveryError,
  MAX_DIRECTORY_ENTRIES,
  MAX_PAGE_SIZE,
  createDiscoveryPage,
  normalizePageSize,
  stableEntryId
};
