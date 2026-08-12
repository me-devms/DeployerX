const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = __dirname;
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

test('renderer CSP permits WebAssembly without enabling general eval', () => {
  const scriptSrc = html.match(/script-src[^;]+/)?.[0] || '';
  assert.match(scriptSrc, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(scriptSrc.replace(/'wasm-unsafe-eval'/g, ''), /'unsafe-eval'/);
});

test('RDP keeps detailed errors out of the compact header', () => {
  assert.match(renderer, /const headerStatus = rdpHeaderStatus\(status, protocol\)/);
  assert.match(renderer, /els\.rdpToolbarStatus\.textContent = headerStatus/);
  assert.match(renderer, /els\.terminalStatus\.textContent = headerStatus/);
  assert.match(renderer, /els\.rdpConnectHint\.textContent = message/);
  assert.match(renderer, /message\.length <= 240/);
});

test('RDP status text is bounded in the header and connect panel', () => {
  assert.match(styles, /\.project-connection-status\s*\{[^}]*max-width:\s*180px/s);
  assert.match(styles, /\.project-connection-status span\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(styles, /\.rdp-connect-panel > span:not\(\.rdp-connect-icon\)\s*\{[^}]*max-height:\s*60px/s);
});
