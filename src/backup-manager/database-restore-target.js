const { StringDecoder } = require('string_decoder');

const HEADER_LIMIT_BYTES = 2 * 1024 * 1024;

function targetError(code, message) {
  return Object.assign(new Error(message), { code, category: 'integrity', retryable: false });
}

function requiredName(value, label, maximumLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || /\p{C}/u.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
}

function singleSourceDatabase(metadata = {}, maximumLength = 64) {
  const selected = Array.isArray(metadata.selectedDatabases) ? metadata.selectedDatabases : [];
  const expected = Array.isArray(metadata.expectedDatabases) ? metadata.expectedDatabases : [];
  const names = [...new Set((selected.length ? selected : expected).map((name) => requiredName(name, 'Source database', maximumLength)))];
  if (names.length !== 1) throw targetError('DATABASE_NEW_TARGET_REQUIRES_SINGLE_SOURCE', 'Restore to a new database requires a recovery point containing exactly one protected database.');
  return names[0];
}

function remapMysqlFamilyMetadata(metadata = {}, targetDatabase) {
  const sourceDatabase = singleSourceDatabase(metadata, 64);
  const target = requiredName(targetDatabase, 'Target database', 64);
  const result = structuredClone(metadata);
  const mapDatabase = (value) => value === sourceDatabase ? target : value;
  result.selectedDatabases = (result.selectedDatabases || []).map(mapDatabase);
  result.expectedDatabases = (result.expectedDatabases || []).map(mapDatabase);
  result.selectedTables = (result.selectedTables || []).map((item) => ({ ...item, database: mapDatabase(item.database), schema: mapDatabase(item.schema) }));
  result.expectedObjects = (result.expectedObjects || []).map((item) => ({ ...item, database: mapDatabase(item.database), schema: mapDatabase(item.schema) }));
  result.restoreDatabaseMapping = { sourceDatabase, targetDatabase: target };
  return { metadata: result, sourceDatabase, targetDatabase: target };
}

function remapPostgresqlMetadata(metadata = {}, targetDatabase) {
  const sourceDatabase = singleSourceDatabase(metadata, 63);
  const target = requiredName(targetDatabase, 'Target database', 63);
  const result = structuredClone(metadata);
  const mapDatabase = (value) => value === sourceDatabase ? target : value;
  result.selectedDatabases = (result.selectedDatabases || []).map(mapDatabase);
  result.expectedDatabases = (result.expectedDatabases || []).map(mapDatabase);
  result.selectedSchemas = (result.selectedSchemas || []).map((item) => ({ ...item, database: mapDatabase(item.database) }));
  result.selectedTables = (result.selectedTables || []).map((item) => ({ ...item, database: mapDatabase(item.database) }));
  result.expectedSchemas = (result.expectedSchemas || []).map((item) => ({ ...item, database: mapDatabase(item.database) }));
  result.expectedObjects = (result.expectedObjects || []).map((item) => ({ ...item, database: mapDatabase(item.database) }));
  result.restoreDatabaseMapping = { sourceDatabase, targetDatabase: target };
  return { metadata: result, sourceDatabase, targetDatabase: target };
}

function decodeMysqlIdentifier(value) {
  return value.slice(1, -1).replace(/``/g, '`');
}

function quoteMysqlIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

class MysqlLineRemapper {
  constructor(sourceDatabase, targetDatabase) {
    this.sourceDatabase = sourceDatabase;
    this.targetIdentifier = quoteMysqlIdentifier(targetDatabase);
    this.blockComment = false;
    this.executableComment = false;
    this.pendingDatabase = false;
    this.pendingUse = false;
    this.previousKeyword = '';
    this.databaseMappings = 0;
    this.useMappings = 0;
    this.qualifiedMappings = 0;
  }

  process(line) {
    let output = '';
    let index = 0;
    while (index < line.length) {
      if (this.blockComment) {
        const end = line.indexOf('*/', index);
        if (end < 0) return output + line.slice(index);
        output += line.slice(index, end + 2);
        index = end + 2;
        this.blockComment = false;
        continue;
      }
      if (this.executableComment && line.startsWith('*/', index)) {
        output += '*/';
        index += 2;
        this.executableComment = false;
        continue;
      }
      if (!this.executableComment && (line.startsWith('/*!', index) || line.startsWith('/*M!', index))) {
        const markerLength = line.startsWith('/*M!', index) ? 4 : 3;
        output += line.slice(index, index + markerLength);
        index += markerLength;
        this.executableComment = true;
        continue;
      }
      if (!this.executableComment && line.startsWith('/*', index)) {
        this.blockComment = true;
        continue;
      }
      if (!this.executableComment && (line[index] === '#' || (line.startsWith('--', index) && /\s/.test(line[index + 2] || '')))) return output + line.slice(index);
      if (line[index] === "'" || line[index] === '"') {
        const quote = line[index];
        const start = index;
        index += 1;
        while (index < line.length) {
          if (line[index] === '\\') { index += 2; continue; }
          if (line[index] === quote && line[index + 1] === quote) { index += 2; continue; }
          if (line[index] === quote) { index += 1; break; }
          index += 1;
        }
        output += line.slice(start, index);
        continue;
      }
      if (line[index] === '`') {
        const start = index;
        index += 1;
        while (index < line.length) {
          if (line[index] === '`' && line[index + 1] === '`') { index += 2; continue; }
          if (line[index] === '`') { index += 1; break; }
          index += 1;
        }
        const raw = line.slice(start, index);
        const name = decodeMysqlIdentifier(raw);
        const next = line.slice(index).match(/^\s*(.)/)?.[1] || '';
        const databaseTarget = this.pendingDatabase && name === this.sourceDatabase;
        const useTarget = this.pendingUse && name === this.sourceDatabase;
        const qualifiedTarget = next === '.' && name === this.sourceDatabase;
        if (databaseTarget || useTarget || qualifiedTarget) {
          output += this.targetIdentifier;
          if (databaseTarget) this.databaseMappings += 1;
          if (useTarget) this.useMappings += 1;
          if (qualifiedTarget) this.qualifiedMappings += 1;
        } else output += raw;
        if (this.pendingDatabase) this.pendingDatabase = false;
        if (this.pendingUse) this.pendingUse = false;
        continue;
      }
      if (/[A-Za-z_$\u0080-\uFFFF]/u.test(line[index])) {
        const start = index;
        index += 1;
        while (index < line.length && /[A-Za-z0-9_$\u0080-\uFFFF]/u.test(line[index])) index += 1;
        const word = line.slice(start, index);
        const upper = word.toUpperCase();
        const next = line.slice(index).match(/^\s*(.)/)?.[1] || '';
        const databaseTarget = this.pendingDatabase && word === this.sourceDatabase;
        const useTarget = this.pendingUse && word === this.sourceDatabase;
        const qualifiedTarget = next === '.' && word === this.sourceDatabase;
        if (databaseTarget || useTarget || qualifiedTarget) {
          output += this.targetIdentifier;
          if (databaseTarget) this.databaseMappings += 1;
          if (useTarget) this.useMappings += 1;
          if (qualifiedTarget) this.qualifiedMappings += 1;
        } else output += word;
        if (this.pendingDatabase && !['IF', 'NOT', 'EXISTS'].includes(upper)) this.pendingDatabase = false;
        if (this.pendingUse) this.pendingUse = false;
        if (upper === 'USE') this.pendingUse = true;
        if (upper === 'DATABASE' && ['CREATE', 'DROP', 'ALTER'].includes(this.previousKeyword)) this.pendingDatabase = true;
        if (!['IF', 'NOT', 'EXISTS'].includes(upper)) this.previousKeyword = upper;
        continue;
      }
      if (line[index] === ';') {
        this.pendingDatabase = false;
        this.pendingUse = false;
        this.previousKeyword = '';
      }
      output += line[index];
      index += 1;
    }
    return output;
  }

  confirmed() {
    return this.databaseMappings > 0 && this.useMappings > 0;
  }
}

function quotePostgresqlIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function decodePostgresqlIdentifier(quoted, bare) {
  return quoted === undefined ? bare : quoted.replace(/""/g, '"');
}

function remapPostgresqlLine(line, sourceDatabase, targetDatabase, counters) {
  let output = line;
  const databaseStatement = /^(\s*(?:CREATE|DROP|ALTER)\s+DATABASE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+)(?:"((?:[^"]|"")*)"|([^\s;]+))/i;
  const match = output.match(databaseStatement);
  if (match && decodePostgresqlIdentifier(match[2], match[3]) === sourceDatabase) {
    output = `${match[1]}${quotePostgresqlIdentifier(targetDatabase)}${output.slice(match[0].length)}`;
    counters.databaseMappings += 1;
  }
  if (/^\s*\\connect\s+/i.test(output)) {
    const escapedSource = sourceDatabase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quotedSource = sourceDatabase.replace(/"/g, '""');
    const patterns = [
      new RegExp(`^(\\s*\\\\connect\\s+)${escapedSource}(\\s*)$`, 'i'),
      new RegExp(`^(\\s*\\\\connect\\s+)"${quotedSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"(\\s*)$`, 'i'),
      new RegExp(`(dbname=')${escapedSource.replace(/'/g, "''")}(')`, 'i')
    ];
    for (const pattern of patterns) {
      if (!pattern.test(output)) continue;
      output = output.replace(pattern, (_whole, prefix, suffix) => pattern === patterns[2]
        ? `${prefix}${targetDatabase.replace(/'/g, "\\'")}${suffix}`
        : `${prefix}${quotePostgresqlIdentifier(targetDatabase)}${suffix}`);
      counters.connectMappings += 1;
      break;
    }
  }
  return output;
}

async function* remapLines(source, transformLine, confirmed, errorCode, errorMessage) {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let held = [];
  let heldBytes = 0;
  let released = false;
  const emit = function* (text) {
    const transformed = transformLine(text);
    if (released) { yield Buffer.from(transformed, 'utf8'); return; }
    held.push(transformed);
    heldBytes += Buffer.byteLength(transformed);
    if (!confirmed()) {
      if (heldBytes > HEADER_LIMIT_BYTES) throw targetError(errorCode, errorMessage);
      return;
    }
    released = true;
    yield Buffer.from(held.join(''), 'utf8');
    held = [];
  };
  for await (const chunk of source) {
    carry += decoder.write(Buffer.from(chunk));
    let newline;
    while ((newline = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, newline + 1);
      carry = carry.slice(newline + 1);
      yield* emit(line);
    }
  }
  carry += decoder.end();
  if (carry) yield* emit(carry);
  if (!released) throw targetError(errorCode, errorMessage);
}

async function* remapMysqlFamilyDump(source, sourceDatabase, targetDatabase) {
  const remapper = new MysqlLineRemapper(requiredName(sourceDatabase, 'Source database', 64), requiredName(targetDatabase, 'Target database', 64));
  yield* remapLines(source, (line) => remapper.process(line), () => remapper.confirmed(), 'DATABASE_DUMP_REMAP_UNSAFE', 'The logical dump did not contain the expected database creation and selection controls, so no bytes were restored.');
}

async function* remapPostgresqlDump(source, sourceDatabase, targetDatabase) {
  const sourceName = requiredName(sourceDatabase, 'Source database', 63);
  const targetName = requiredName(targetDatabase, 'Target database', 63);
  const counters = { databaseMappings: 0, connectMappings: 0 };
  yield* remapLines(source, (line) => remapPostgresqlLine(line, sourceName, targetName, counters), () => counters.databaseMappings > 0 && counters.connectMappings > 0, 'POSTGRESQL_DUMP_REMAP_UNSAFE', 'The PostgreSQL dump did not contain the expected database creation and connection controls, so no bytes were restored.');
}

module.exports = {
  remapMysqlFamilyDump,
  remapMysqlFamilyMetadata,
  remapPostgresqlDump,
  remapPostgresqlMetadata,
  singleSourceDatabase
};
