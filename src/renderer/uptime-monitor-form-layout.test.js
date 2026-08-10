const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('uses two-column monitor fields on desktop and one column on narrow screens', async () => {
  const styles = await fs.readFile(path.join(__dirname, 'styles.css'), 'utf8');
  const uptimeStyles = styles.slice(styles.indexOf('.uptime-monitor-modal-card {'));

  assert.match(uptimeStyles, /\.uptime-monitor-modal-card \.modal-columns\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(uptimeStyles, /@media \(max-width: 700px\)[\s\S]*\.uptime-monitor-modal-card \.modal-columns\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(uptimeStyles, /@media \(max-width: 700px\)[\s\S]*\.uptime-monitor-modal-card \.span-2\s*\{\s*grid-column:\s*auto/);
});
