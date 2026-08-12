const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

test('does not automatically capitalize dynamic UI values', () => {
  assert.doesNotMatch(styles, /text-transform:\s*capitalize/);
  assert.match(styles, /\.terminal-tab-label\s*\{[\s\S]*?text-transform: none;/);
  assert.match(styles, /\.ftp-row\s*\{[\s\S]*?text-transform: none;/);
  assert.match(styles, /\.ssh-directory-row\s*\{[\s\S]*?text-transform: none;/);
});

test('renders terminal usernames without changing their casing', () => {
  assert.match(renderer, /const username = String\(session\?\.sshUsername \|\| ''\)\.trim\(\)/);
  assert.match(renderer, /\$\{baseLabel\} - \$\{username\}/);
  assert.doesNotMatch(renderer, /sshUsername[^\n]*\.to(?:Upper|Lower)Case\(/);
});
