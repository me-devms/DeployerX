const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('keeps the Electron main entry valid CommonJS without orphaned top-level awaits', () => {
  assert.doesNotThrow(() => new Function(source));
  const fileTail = source.slice(-1000);
  assert.doesNotMatch(fileTail, /await syncUptimeTransitionToCloud\(context, \{ incident \}\)/);
  assert.doesNotMatch(fileTail, /await writeUptimeCloudRecord\(context, UPTIME_CLOUD_COLLECTIONS\.maintenance, maintenance\)/);
});
