const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('renders the server search as one bordered control', async () => {
  const [html, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8')
  ]);

  assert.match(html, /class="server-toolbar-search server-filter-input app-search"[\s\S]*?id="serversFilterSearch"/);
  assert.match(styles, /Canonical search input used across every renderer workspace and theme/);
  assert.match(styles, /html\[data-theme\] \.app-search > input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
});

test('renders the sidebar search as one bordered control', async () => {
  const [html, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8')
  ]);

  assert.match(html, /class="sidebar-search app-search"[\s\S]*?id="serverSearch"/);
  assert.match(styles, /html\[data-theme\] \.app-search > input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)[\s\S]*?padding: 0;[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
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

test('keeps server toolbar actions out of scrolling inventory rows', async () => {
  const styles = await fs.readFile(path.join(__dirname, 'styles.css'), 'utf8');

  assert.match(styles, /\.servers-view-header\s*\{[\s\S]*?position: relative;[\s\S]*?top: auto;/);
  assert.match(styles, /\.server-inventory-row\s*\{[\s\S]*?isolation: isolate;/);
  assert.match(styles, /@container servers-view \(max-width: 1220px\)[\s\S]*?\.servers-view-header\s*\{[\s\S]*?flex-wrap: wrap;/);
});

test('keeps the themed server search visually unified', async () => {
  const styles = await fs.readFile(path.join(__dirname, 'styles.css'), 'utf8');

  assert.match(styles, /html\[data-theme\] body \.app-search/);
  assert.match(styles, /\.app-search > input::\-webkit-search-cancel-button,[\s\S]*?display: none;/);
});
