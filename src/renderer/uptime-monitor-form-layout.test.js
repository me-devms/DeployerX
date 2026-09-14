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

test('spaces monitor row action buttons consistently', async () => {
  const [renderer, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8')
  ]);

  assert.match(renderer, /<div class="uptime-row-actions"><button[^>]+data-uptime-run-monitor=[\s\S]*?<button[^>]+data-uptime-edit-monitor=/);
  assert.match(styles, /\.uptime-row-actions\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*gap:\s*8px;/);
  assert.match(styles, /\.uptime-actions-column\s*\{\s*width:\s*100px;/);
});
