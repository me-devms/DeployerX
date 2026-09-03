const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = __dirname;
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const vncClient = fs.readFileSync(path.join(rendererDir, 'vnc-client.js'), 'utf8');

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

test('VNC renders one-click monitor toggles with an all-displays button', () => {
  assert.match(html, /id="vncDisplaySelector"[^>]*role="group"[^>]*aria-label="VNC monitors"/);
  assert.doesNotMatch(html, /vncDisplayButton|vncDisplayMenu/);
  assert.match(renderer, /vncDisplays\.map\(\(display, index\) =>/);
  assert.match(renderer, /const monitorLabel = 'Monitor ' \+ monitorNumber/);
  assert.match(renderer, /vnc-display-toggle-mark/);
  assert.match(renderer, /vnc-display-toggle-number/);
  assert.match(renderer, /href="#icon-monitor"/);
  assert.match(renderer, /allButton\.dataset\.vncDisplayId = 'all'/);
  assert.match(renderer, /allButton\.setAttribute\('aria-label', 'All displays'\)/);
  assert.match(renderer, /vnc-display-all-mark/);
  assert.match(html, /id="icon-monitor"[^>]*>[\s\S]*?<rect[^>]*width="19"[^>]*height="14"/);
  assert.match(renderer, /button\.title = monitorLabel/);
  assert.match(renderer, /button\.setAttribute\('aria-pressed', display\.id === selectedVncDisplayId/);
  assert.match(styles, /\.vnc-display-selector\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(styles, /\.vnc-display-toggle\s*\{[^}]*width:\s*36px/s);
  assert.match(styles, /\.vnc-display-toggle-number\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.vnc-display-toggle\.active\s*\{[^}]*background:\s*var\(--primary\)/s);
});

test('VNC selects the first detected monitor until the user changes it', () => {
  assert.match(vncClient, /this\.selectedDisplayId = nextDisplays\[0\]\.id/);
  assert.match(vncClient, /this\.rfb\.viewRegion = display \|\| null/);
});
