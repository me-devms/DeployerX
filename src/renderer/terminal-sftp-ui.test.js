const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('folder listing reuses one authenticated SSH connection across SFTP channels', { timeout: 10000 }, async (t) => {
  const { Client, Server, utils: { sftp: { STATUS_CODE } } } = require('ssh2');
  const { generateKeyPairSync } = require('node:crypto');
  const { once } = require('node:events');
  const vm = require('node:vm');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const peers = new Set();
  let logins = 0;
  const server = new Server({ hostKeys: [key] }, (peer) => {
    peers.add(peer);
    peer.on('error', () => {});
    peer.on('authentication', (request) => {
      if (request.method === 'password' && request.username === 'release' && request.password === 'test-only') {
        logins += 1;
        request.accept();
      } else request.reject();
    });
    peer.on('ready', () => peer.on('session', (accept) => {
      accept().on('sftp', (acceptSftp) => {
        const channel = acceptSftp();
        let listed = false;
        channel.on('OPENDIR', (id) => { listed = false; channel.handle(id, Buffer.from('directory')); });
        channel.on('READDIR', (id) => {
          if (listed) return channel.status(id, STATUS_CODE.EOF);
          listed = true;
          channel.name(id, [{ filename: 'releases', longname: 'releases', attrs: { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }]);
        });
        channel.on('CLOSE', (id) => channel.status(id, STATUS_CODE.OK));
      });
    }));
  });
  const connection = new Client();
  t.after(() => { connection.destroy(); for (const peer of peers) peer.end(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const ready = once(connection, 'ready');
  connection.connect({ host: '127.0.0.1', port: server.address().port, username: 'release', password: 'test-only', readyTimeout: 3000 });
  await ready;
  const context = vm.createContext({ activeTerminals: new Map([['working-ssh', { connection }]]) });
  const names = ['terminalSessionOrThrow', 'normalizeRemotePath', 'joinRemotePath', 'parentRemotePath', 'openSftpChannel', 'sftpReaddir', 'isSftpSubsystemUnavailableError', 'isTerminalChannelClosedError', 'unavailableTerminalDirectory', 'withTerminalSftp', 'listTerminalDirectory'];
  for (const name of names) {
    const start = main.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.notEqual(start, -1);
    vm.runInContext(main.slice(start, main.indexOf('\n}', start) + 2), context);
  }
  for (const directory of ['/', '/releases']) {
    context.directory = directory;
    const result = await vm.runInContext("listTerminalDirectory('working-ssh', directory)", context);
    assert.equal(result.path, directory);
    assert.equal(result.items[0].type, 'directory');
    assert.equal(result.items[0].name, 'releases');
  }
  assert.equal(logins, 1, 'Browsing must not open a second SSH connection');
  assert.equal(connection._sock.destroyed, false, 'Closing SFTP channels must preserve SSH');
});

test('caches a missing remote SFTP subsystem as a terminal capability result', () => {
  assert.match(main, /function isSftpSubsystemUnavailableError\(error\)/);
  assert.match(main, /Number\(error\?\.reason\) === 2/);
  assert.match(main, /Number\(error\?\.code\) === 127/);
  assert.match(main, /channel open failure:\\s\*open failed/i);
  assert.match(main, /if \(terminal\.sftpUnavailable\) return unavailableTerminalDirectory\(normalizedPath\)/);
  assert.match(main, /terminal\.sftpUnavailable = true;[\s\S]*?return unavailableTerminalDirectory\(normalizedPath\)/);
});

test('stops automatic directory retries and disables SFTP-only controls', () => {
  assert.match(renderer, /directoryUnavailable: false/);
  assert.match(renderer, /!session\.directoryLoading && !session\.directoryUnavailable && session\.directoryPath !== normalized/);
  assert.match(renderer, /if \(session\.directoryUnavailable\) \{[\s\S]*?Enable the SSH SFTP subsystem, then reconnect/);
  assert.match(renderer, /if \(result\.unavailable\) \{[\s\S]*?session\.directoryUnavailable = true/);
  assert.match(renderer, /!session\?\.directoryUnavailable && !uploadInFlight/);
});

test('initializes the interactive shell without leaving duplicate prompts', () => {
  assert.match(renderer, /startTerminal\(\{[\s\S]*?startupDirectory[\s\S]*?\}\)/);
  assert.doesNotMatch(renderer, /terminalSession\.pendingInput = startupDirectory/);
  assert.match(main, /const changeDirectory = startupDirectory \? `cd --/);
  assert.match(main, /printf '\\\\r\\\\033\[1A\\\\033\[2K\\\\r'/);
});
