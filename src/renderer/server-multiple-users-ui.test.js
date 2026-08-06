const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', source.indexOf(') {', start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not read ${name}`);
}

test('normalizes legacy and multiple SSH users while mirroring the default user', async () => {
  const main = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  const source = readFunction(main, 'normalizeProjectSsh');
  const normalizeProjectSsh = vm.runInNewContext(`(${source})`);

  const legacy = normalizeProjectSsh({ host: 'example.test', username: 'root', password: 'secret' });
  assert.equal(legacy.users.length, 1);
  assert.equal(legacy.users[0].username, 'root');
  assert.equal(legacy.defaultUserId, legacy.users[0].id);
  assert.equal(legacy.password, 'secret');

  const multiple = normalizeProjectSsh({
    host: 'example.test',
    users: [
      { id: 'root-user', username: 'root', authType: 'password', password: 'root-secret' },
      { id: 'deploy-user', username: 'deploy', authType: 'key', privateKey: 'private-key' }
    ],
    defaultUserId: 'deploy-user'
  });
  assert.equal(multiple.users.length, 2);
  assert.equal(multiple.defaultUserId, 'deploy-user');
  assert.equal(multiple.username, 'deploy');
  assert.equal(multiple.authType, 'key');
  assert.equal(multiple.privateKey, 'private-key');
});

test('wires the responsive SSH user editor and validation controls', async () => {
  const [html, renderer, styles, main] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8')
  ]);

  for (const id of ['modalSshUserTabs', 'modalAddSshUserButton', 'modalRemoveSshUserButton', 'modalDefaultSshUserButton']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(renderer, new RegExp(`${id}: document\\.getElementById`));
  }
  assert.match(renderer, /function validateModalSshUsers\(\)/);
  assert.match(renderer, /Each SSH user must have a unique username/);
  assert.match(renderer, /state\.modalDraft\.ssh\.defaultUserId = user\.id/);
  assert.match(styles, /\.ssh-user-tabs\s*\{/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.ssh-user-editor-heading/);
  assert.match(main, /if \(defaultUser\) defaultUser\[field\] = ssh\[field\]/);
});
