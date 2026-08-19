const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const websiteRoot = __dirname;
const html = fs.readFileSync(path.join(websiteRoot, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(websiteRoot, 'css', 'components.css'), 'utf8');
const script = fs.readFileSync(path.join(websiteRoot, 'js', 'main.js'), 'utf8');

test('renders a larger contributor strip with a static fallback', () => {
  assert.match(html, /data-contributor-avatars/);
  assert.match(html, /assets\/contributors\/lxsuthar\.png/);
  assert.match(html, /assets\/contributors\/me-devms\.png/);
  assert.match(styles, /\.contributor-avatars a \{[^}]*width: 56px;[^}]*height: 56px;/);
  assert.match(styles, /\.contributors-copy p \{[^}]*font-size: 17px;/);
});

test('automatically loads future GitHub contributors while preserving fallback content', () => {
  assert.match(script, /repos\/me-devms\/DeployerX\/contributors\?per_page=6&anon=0/);
  assert.match(script, /\.slice\(0, 5\)/);
  assert.match(script, /avatars\.replaceChildren\(\.\.\.links, more\)/);
  assert.match(script, /local contributor portraits remain visible when GitHub is unavailable/);
});
