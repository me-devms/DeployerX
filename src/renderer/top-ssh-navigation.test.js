const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('adds a primary SSH navigation action backed by the existing project terminal', async () => {
  const [html, renderer] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8')
  ]);

  assert.match(html, /id="topSshButton"[\s\S]*?<use href="#icon-square-terminal"><\/use>[\s\S]*?<span>SSH<\/span>/);
  assert.match(renderer, /topSshButton: document\.getElementById\('topSshButton'\)/);
  assert.match(renderer, /function openTopSshTerminal\(\)[\s\S]*?getConnectedTerminalSession\(candidate\.id\)[\s\S]*?openProject\(project\.id\);[\s\S]*?setProjectTab\('ssh'\);/);
  assert.match(renderer, /els\.topSshButton\.addEventListener\('click', openTopSshTerminal\);/);
});

test('keeps the SSH navigation state synchronized with the active project tab', async () => {
  const renderer = await fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8');

  assert.match(renderer, /els\.topSshButton\.classList\.toggle\('active', isProject && !isRdpProject\(\) && state\.activeProjectTab === 'ssh'\);/);
  assert.match(renderer, /const isSsh = !isFtp;[\s\S]*?els\.topSshButton\.classList\.toggle\('active', isSsh\);/);
});
