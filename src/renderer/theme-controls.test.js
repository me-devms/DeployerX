const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const stylesPath = path.join(__dirname, 'styles.css');
const themeIds = [
  'deployerx-light',
  'termius-dark',
  'tokyo-day',
  'catppuccin-mocha',
  'gruvbox-dark',
  'solarized-light'
];

test('defines a form-control surface and native color scheme for every theme', async () => {
  const styles = await fs.readFile(stylesPath, 'utf8');

  for (const themeId of themeIds) {
    const block = styles.match(new RegExp(`:root\\[data-theme="${themeId}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
    assert.match(block, /--control-bg:\s*#[0-9a-f]{6};/i, `${themeId} control surface`);
    assert.match(block, /color-scheme:\s*(?:light|dark);/, `${themeId} native control scheme`);
  }
});

test('shared inputs and surfaces do not hardcode light-theme white', async () => {
  const styles = await fs.readFile(stylesPath, 'utf8');

  assert.match(styles, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),[\s\S]*?background-color: var\(--control-bg\);/);
  assert.match(styles, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):focus,[\s\S]*?color-mix\(in srgb, var\(--primary\) 22%, transparent\)/);
  assert.match(styles, /html\[data-theme\] input:-webkit-autofill,[\s\S]*?1000px var\(--control-bg\) inset;/);
  assert.deepEqual(
    [...styles.matchAll(/background:\s*#(?:fff|ffffff)\b/gi)].map((match) => match[0]),
    ['background: #ffffff'],
    'only the switch thumb keeps an intentional white background'
  );
});

test('dashboard operation surfaces follow the active theme', async () => {
  const styles = await fs.readFile(stylesPath, 'utf8');

  assert.match(styles, /html\[data-theme\] \.dashboard-operation-row,[\s\S]*?background: var\(--surface-subtle\);/);
  assert.match(styles, /html\[data-theme\] \.dashboard-operation-row:hover,[\s\S]*?background: color-mix\(in srgb, var\(--primary\) 8%, var\(--surface-subtle\)\);/);
  assert.match(styles, /html\[data-theme\] \.dashboard-stat-card \.dashboard-stat-icon,[\s\S]*?background: var\(--surface-subtle\) !important;/);
});

test('Catppuccin primary controls use dark text on the light mauve accent', async () => {
  const styles = await fs.readFile(stylesPath, 'utf8');
  const catppuccin = styles.match(/:root\[data-theme="catppuccin-mocha"\] \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(catppuccin, /--primary:\s*#cba6f7;/i);
  assert.match(catppuccin, /--primary-contrast:\s*#181825;/i);
  assert.match(styles, /\.button\.solid\s*\{[^}]*color:\s*var\(--primary-contrast\);[^}]*background:\s*var\(--primary\);/s);
  assert.match(styles, /\.project-tab\.active\s*\{[^}]*background:\s*var\(--primary\);[^}]*color:\s*var\(--primary-contrast\);/s);
  assert.match(styles, /\.button\.solid\.danger\s*\{[^}]*color:\s*#ffffff;/s);
});
