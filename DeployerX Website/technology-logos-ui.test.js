const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'css', 'components.css'), 'utf8');

test('uses local technology logos instead of abbreviation placeholders', () => {
  const technologySection = html.match(/<section class="section" id="technology">([\s\S]*?)<\/section>/)?.[1] || '';
  const logos = [...technologySection.matchAll(/<img src="(assets\/technology\/[^"]+)"/g)].map((match) => match[1]);

  assert.equal(logos.length, 8);
  assert.equal(new Set(logos).size, 8);
  assert.doesNotMatch(technologySection, /<span>(?:El|JS|SSH|SQL|VNC|FB|M|&gt;_)<\/span>/);
  logos.forEach((logo) => assert.equal(fs.existsSync(path.join(root, logo)), true, `${logo} should exist`));
});

test('keeps logo frames consistently sized and gives xterm sufficient contrast', () => {
  assert.match(styles, /\.tech-grid \.tech-logo \{[^}]*width: 48px;[^}]*height: 48px;/s);
  assert.match(styles, /\.tech-grid \.tech-logo img \{[^}]*width: 34px;[^}]*height: 34px;[^}]*object-fit: contain;/s);
  assert.match(styles, /\.tech-grid \.tech-logo-xterm \{ background: #e8eef5; \}/);
});
