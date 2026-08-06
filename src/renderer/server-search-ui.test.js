const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('renders the server search as one bordered control', async () => {
  const [html, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8')
  ]);

  assert.match(html, /class="server-toolbar-search server-filter-input"[\s\S]*?id="serversFilterSearch"/);
  assert.match(styles, /html\[data-theme\] \.server-filter-input input\s*\{[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(styles, /html\[data-theme\] \.server-filter-input input:focus\s*\{[\s\S]*?border: 0;[\s\S]*?box-shadow: none;/);
});
