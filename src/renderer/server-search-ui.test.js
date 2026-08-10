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

test('renders the sidebar search as one bordered control', async () => {
  const [html, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8')
  ]);

  assert.match(html, /class="sidebar-search"[\s\S]*?id="serverSearch"/);
  assert.match(styles, /html\[data-theme\] \.sidebar-search input\s*\{[\s\S]*?padding: 0;[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(styles, /html\[data-theme\] \.sidebar-search input:focus\s*\{[\s\S]*?border: 0;[\s\S]*?box-shadow: none;/);
});

test('aligns the Add Server action with the server toolbar controls', async () => {
  const [html, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8')
  ]);

  assert.match(html, /id="dashboardCreateButton"[\s\S]*?<use href="#icon-plus"><\/use>[\s\S]*?Add Server/);
  assert.match(styles, /\.servers-view-header \.header-actions > \.button\s*\{[\s\S]*?height: 36px;[\s\S]*?min-height: 36px;/);
  assert.match(styles, /#dashboardCreateButton\s*\{[\s\S]*?min-width: 128px;[\s\S]*?padding-inline: 14px;/);
});
