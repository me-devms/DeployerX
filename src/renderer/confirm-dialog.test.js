const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const rendererDirectory = __dirname;

test('uses one shared confirmation dialog across renderer actions', async () => {
  const [html, source] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'index.html'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8')
  ]);

  assert.equal((html.match(/id="confirmModal"/g) || []).length, 1, 'one confirmation dialog instance');
  assert.match(html, /id="confirmModal"[^>]+data-component="confirm-dialog"/, 'shared component marker');
  assert.ok((source.match(/confirmDangerousAction\(/g) || []).length > 20, 'feature confirmations use the shared dialog');
  assert.doesNotMatch(source, /\b(?:window\.)?confirm\s*\(/, 'native browser confirmations are not used');
});

test('keeps the shared confirmation dialog compact and keyboard accessible', async () => {
  const [styles, source] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'styles.css'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8')
  ]);

  assert.match(styles, /\.confirm-card \{\s+width: min\(408px, calc\(100vw - 32px\)\);/, 'compact dialog width');
  assert.match(styles, /\.confirm-card \.modal-footer \{[\s\S]*?border-top: 0;[\s\S]*?background: transparent;/, 'integrated action area');
  assert.match(source, /confirmModalFocusOrigin/, 'focus is restored to the invoking control');
  assert.match(source, /els\.confirmModal\.addEventListener\('keydown'/, 'dialog owns its keyboard behavior');
});
