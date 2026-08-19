const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const websiteRoot = __dirname;
const projectRoot = path.dirname(websiteRoot);
const packageDocument = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const currentVersion = packageDocument.version;
const currentTag = `v${currentVersion}`;
const html = fs.readFileSync(path.join(websiteRoot, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(websiteRoot, 'js', 'main.js'), 'utf8');

test('website release fallback matches the application version', () => {
  assert.match(html, new RegExp(`data-latest-version>${currentTag.replaceAll('.', '\\.')}<`));
  assert.match(html, new RegExp(`releases/tag/${currentTag.replaceAll('.', '\\.')}`));
  assert.match(script, new RegExp(`tag: '${currentTag.replaceAll('.', '\\.')}'`));
  assert.match(script, new RegExp(`releases/download/${currentTag.replaceAll('.', '\\.')}/DeployerX-${currentVersion.replaceAll('.', '\\.')}`));
});

test('website assets are cache-busted with the current version', () => {
  for (const asset of ['css/tokens.css', 'css/base.css', 'css/components.css', 'css/responsive.css', 'js/main.js']) {
    assert.match(html, new RegExp(`${asset.replaceAll('.', '\\.')}\\?v=${currentVersion.replaceAll('.', '\\.')}`));
  }
});

test('website keeps theme, menu, and complete release notes controls available', () => {
  assert.match(html, /class="icon-button theme-toggle"/);
  assert.match(html, /id="menu-overlay"/);
  assert.match(html, /id="release-notes-dialog"/);
  assert.match(script, /Showing the bundled release notes fallback/);
});
