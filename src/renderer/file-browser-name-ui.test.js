const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

test('preserves exact file and folder name casing in browser rows', () => {
  assert.match(renderer, /<span class="ftp-name">[\s\S]*?<strong>\$\{escapeHtml\(entry\.name\)\}<\/strong>/);
  assert.match(renderer, /<span class="ssh-directory-name">[\s\S]*?<strong>\$\{escapeHtml\(entry\.name\)\}<\/strong>/);
  assert.match(styles, /\.ftp-row\s*\{[\s\S]*?text-transform: none;/);
  assert.match(styles, /\.ssh-directory-row\s*\{[\s\S]*?text-transform: none;/);
});
