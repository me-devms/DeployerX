const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('caches a missing remote SFTP subsystem as a terminal capability result', () => {
  assert.match(main, /function isSftpSubsystemUnavailableError\(error\)/);
  assert.match(main, /Number\(error\?\.code\) === 127/);
  assert.match(main, /if \(terminal\.sftpUnavailable\) return unavailableTerminalDirectory\(normalizedPath\)/);
  assert.match(main, /terminal\.sftpUnavailable = true;[\s\S]*?return unavailableTerminalDirectory\(normalizedPath\)/);
});

test('stops automatic directory retries and disables SFTP-only controls', () => {
  assert.match(renderer, /directoryUnavailable: false/);
  assert.match(renderer, /!session\.directoryLoading && !session\.directoryUnavailable && session\.directoryPath !== normalized/);
  assert.match(renderer, /if \(session\.directoryUnavailable\) \{[\s\S]*?Enable the SSH SFTP subsystem, then reconnect/);
  assert.match(renderer, /if \(result\.unavailable\) \{[\s\S]*?session\.directoryUnavailable = true/);
  assert.match(renderer, /!session\?\.directoryUnavailable && !uploadInFlight/);
});
