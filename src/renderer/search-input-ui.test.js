const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererRoot = __dirname;
const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');

const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function staticSearchInputs(source) {
  const stack = [];
  const inputs = [];
  const tokens = source.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][\w:-]*)\b[^>]*>/gi);
  for (const match of tokens) {
    const token = match[0];
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    if (token.startsWith('</')) {
      while (stack.length) {
        const open = stack.pop();
        if (open.name === name) break;
      }
      continue;
    }
    if (name === 'input' && /\b(?:type|inputmode)="search"/i.test(token)) {
      const id = token.match(/\bid="([^"]+)"/i)?.[1] || 'unnamed search input';
      inputs.push({ id, hasSharedWrapper: stack.some((open) => /\bclass="[^"]*\bapp-search\b/i.test(open.token)) });
    }
    if (!voidElements.has(name) && !token.endsWith('/>')) stack.push({ name, token });
  }
  return inputs;
}

test('uses the shared search component for every renderer search input', () => {
  const inputs = staticSearchInputs(html);
  assert.equal(inputs.length, 14);
  assert.deepEqual(inputs.filter((input) => !input.hasSharedWrapper), []);
  assert.match(renderer, /class="database-plugin-search app-search"[^>]*>[\s\S]*?<input type="search"/);
});

test('keeps search visuals centralized and theme-safe', () => {
  assert.match(styles, /Canonical search input used across every renderer workspace and theme/);
  assert.match(styles, /html\[data-theme\] body \.app-search/);
  assert.match(styles, /\.app-search > input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/);
});
