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

test('normalizes legacy and multiple FTP users while mirroring the default user', async () => {
  const main = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  const source = readFunction(main, 'normalizeProjectFtp');
  const normalizeProjectFtp = vm.runInNewContext(`(${source})`);

  const legacy = normalizeProjectFtp({ host: 'files.example.test', username: 'deploy', password: 'secret' });
  assert.equal(legacy.users.length, 1);
  assert.equal(legacy.users[0].username, 'deploy');
  assert.equal(legacy.defaultUserId, legacy.users[0].id);
  assert.equal(legacy.password, 'secret');

  const multiple = normalizeProjectFtp({
    host: 'files.example.test',
    users: [
      { id: 'deploy-user', username: 'deploy', authType: 'password', password: 'deploy-secret' },
      { id: 'release-user', username: 'release', authType: 'key', privateKey: 'private-key' }
    ],
    defaultUserId: 'release-user'
  });
  assert.equal(multiple.users.length, 2);
  assert.equal(multiple.defaultUserId, 'release-user');
  assert.equal(multiple.username, 'release');
  assert.equal(multiple.authType, 'key');
  assert.equal(multiple.privateKey, 'private-key');
});

test('uses direct FTP credentials for port 21 and SSH credentials for SFTP', async () => {
  const main = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  const source = `${readFunction(main, 'normalizedConnectionPort')}\n${readFunction(main, 'isPlainFtpPort')}\n${readFunction(main, 'toFtpConnectionConfig')}\nthis.toFtpConnectionConfig = toFtpConnectionConfig;`;
  const context = {};
  vm.runInNewContext(source, context);
  const toFtpConnectionConfig = context.toFtpConnectionConfig;

  const config = toFtpConnectionConfig({
    ssh: {
      host: 'ssh.example.test',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'ssh-secret',
      timeout: 20000
    },
    ftp: {
      host: 'ftp.example.test',
      port: 21,
      username: 'ftp-user',
      authType: 'password',
      password: 'ftp-secret'
    }
  });

  assert.equal(config.protocol, 'ftp');
  assert.equal(config.host, 'ftp.example.test');
  assert.equal(config.port, 21);
  assert.equal(config.user, 'ftp-user');
  assert.equal(config.password, 'ftp-secret');

  const ftpOnlyConfig = toFtpConnectionConfig({
    ssh: {},
    ftp: {
      host: 'files.example.test',
      port: 22,
      username: 'ftp-only-user',
      authType: 'password',
      password: 'ftp-only-secret'
    }
  });
  assert.equal(ftpOnlyConfig.host, 'files.example.test');
  assert.equal(ftpOnlyConfig.protocol, 'sftp');
  assert.equal(ftpOnlyConfig.port, 22);
  assert.equal(ftpOnlyConfig.username, 'ftp-only-user');
  assert.equal(ftpOnlyConfig.password, 'ftp-only-secret');
});

test('accepts FTP-only connections while keeping SSH operations gated', async () => {
  const main = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  const source = [
    readFunction(main, 'normalizedConnectionPort'),
    readFunction(main, 'isPlainFtpPort'),
    readFunction(main, 'projectHasSshDetails'),
    readFunction(main, 'projectHasFtpDetails'),
    readFunction(main, 'validateConnectionProject'),
    'this.validateConnectionProject = validateConnectionProject;'
  ].join('\n');
  const context = { projectProxyValidationError: () => null };
  vm.runInNewContext(source, context);

  const ftpOnly = {
    name: 'FTP-only server',
    ssh: {},
    ftp: { host: 'files.example.test', username: 'ftp-user', authType: 'password', password: 'secret' }
  };
  assert.equal(context.validateConnectionProject(ftpOnly), null);
  assert.match(context.validateConnectionProject(ftpOnly, { requireSsh: true }), /requires an SSH connection/);
  assert.match(context.validateConnectionProject({ name: 'Empty server', ssh: {}, ftp: {} }), /SSH or FTP connection/);

  const sshWithIncompleteFtp = {
    name: 'SSH server with optional FTP settings',
    ssh: { host: 'ssh.example.test', username: 'deploy', authType: 'password', password: 'ssh-secret' },
    ftp: { host: 'files.example.test', username: 'ftp-user', authType: 'password' }
  };
  assert.match(context.validateConnectionProject(sshWithIncompleteFtp), /FTP password is required/);
  assert.equal(context.validateConnectionProject(sshWithIncompleteFtp, { requireSsh: true }), null);
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
  for (const id of ['terminalUserPromptModal', 'terminalUserPromptForm', 'terminalUserPromptList', 'terminalUserPromptConnectButton']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(renderer, new RegExp(`${id}: document\\.getElementById`));
  }
  assert.match(renderer, /function validateModalSshUsers\(\)/);
  assert.match(renderer, /Each SSH user must have a unique username/);
  assert.match(renderer, /state\.modalDraft\.ssh\.defaultUserId = user\.id/);
  assert.match(renderer, /function promptForTerminalUser\(project, terminalSession\)/);
  assert.match(renderer, /if \(users\.length <= 1\) return Promise\.resolve\(users\[0\] \|\| null\)/);
  assert.match(renderer, /terminalSession\.sshUserId = selectedUser\.id/);
  assert.match(renderer, /function terminalConnectionProject\(project, selectedUser\)[\s\S]*?users: userId \? \[user\] : \[\],[\s\S]*?defaultUserId: userId/);
  assert.match(renderer, /const connectionProject = terminalConnectionProject\(project, selectedUser\)/);
  assert.match(styles, /\.ssh-user-tabs\s*\{/);
  assert.match(styles, /\.terminal-user-option\s*\{/);
  assert.match(styles, /\.server-type-switcher \.workspace-switcher-menu\s*\{\s*max-height: min\(184px, var\(--server-type-menu-space, 184px\)\);/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.ssh-user-editor-heading/);
  assert.match(main, /if \(defaultUser\) defaultUser\[field\] = ssh\[field\]/);
});

test('keeps the Add Server command template menu inside the modal', async () => {
  const [renderer, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8')
  ]);

  assert.match(renderer, /function dropdownVerticalSpace\(trigger[\s\S]*trigger\.closest\('\.modal-body'\)[\s\S]*spaceBelow[\s\S]*spaceAbove/);
  assert.match(renderer, /function openModalTemplateMenu\(\)[\s\S]*dropdownVerticalSpace\(els\.modalTemplateButton\)[\s\S]*classList\.toggle\('opens-up', opensUp\)/);
  assert.match(renderer, /function openModalServerTypeMenu\(\)[\s\S]*dropdownVerticalSpace\(els\.modalServerTypeButton\)[\s\S]*classList\.toggle\('opens-up', opensUp\)/);
  assert.match(renderer, /function positionModalProjectGroupMenu\(\)[\s\S]*desiredMenuHeight[\s\S]*spaceBelow < desiredMenuHeight && spaceAbove > spaceBelow[\s\S]*classList\.toggle\('opens-up', opensUp\)/);
  assert.match(renderer, /function openUptimeMonitorTypeMenu\(\)[\s\S]*dropdownVerticalSpace\(els\.uptimeMonitorTypeButton\)[\s\S]*classList\.toggle\('opens-up', opensUp\)/);
  assert.match(renderer, /--template-menu-space/);
  assert.match(styles, /\.modal-template-switcher \.workspace-switcher-menu\.opens-up\s*\{[\s\S]*bottom: calc\(100% \+ 6px\)/);
  assert.match(styles, /\.group-switcher \.workspace-switcher-menu\.opens-up\s*\{[\s\S]*bottom: calc\(100% \+ 6px\)/);
  assert.match(styles, /\.group-switcher \.group-option-list\s*\{[\s\S]*max-height: 102px;[\s\S]*overflow-y: auto;/);
  assert.match(styles, /max-height: min\(280px, var\(--template-menu-space, 280px\)\)/);
});

test('keeps optional Proxy and FTP steps after SSH and allows saving from SSH', async () => {
  const [html, renderer, styles, main] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8')
  ]);

  const serverStep = html.indexOf('id="projectStepButtonServer"');
  const sshStep = html.indexOf('id="projectStepButtonSsh"');
  const proxyStep = html.indexOf('id="projectStepButtonProxy"');
  const ftpStep = html.indexOf('id="projectStepButtonFtp"');
  assert.ok(serverStep < sshStep && sshStep < proxyStep && proxyStep < ftpStep);
  assert.match(html, /projectStepButtonSsh[^>]+data-project-step-button="1"/);
  assert.match(html, /projectStepButtonProxy[^>]+data-project-step-button="2"/);
  assert.match(html, /<strong>Proxy<\/strong>\s*<small>Optional<\/small>/);
  assert.match(html, /<strong>FTP<\/strong>\s*<small>Optional<\/small>/);
  assert.match(html, /<h3>SSH Connection <small class="field-optional">Optional<\/small><\/h3>/);
  assert.doesNotMatch(html, /id="modalSshHost"[^>]+required/);
  assert.doesNotMatch(html, /id="modalSshUsername"[^>]+required/);
  for (const id of ['modalFtpUserTabs', 'modalAddFtpUserButton', 'modalRemoveFtpUserButton', 'modalDefaultFtpUserButton']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(renderer, new RegExp(`${id}: document\\.getElementById`));
  }
  assert.match(renderer, /function validateModalConnectionSettings\(\)/);
  assert.match(renderer, /els\.modalSshHost\.setCustomValidity\('\'\);\s*els\.modalSshHost\.value = normalizedProject\.ssh\?\.host/);
  assert.match(renderer, /els\.modalSshHost\.addEventListener\('input', \(\) => els\.modalSshHost\.setCustomValidity\('\'\)\)/);
  assert.match(renderer, /Configure an FTP connection, or go back and configure SSH/);
  assert.match(renderer, /function validateModalFtpUsers\(/);
  assert.match(renderer, /Each FTP user must have a unique username/);
  assert.match(renderer, /const allowsImplicitSshUser = hasSsh && state\.modalFtpUsers\.length === 1/);
  assert.match(renderer, /function modalFtpUserLabel\(user, index, \{ hasSsh = modalHasSshDetails\(\) \} = \{\}\)/);
  assert.match(renderer, /return hasSsh \? 'Use SSH user' : `FTP user \$\{index \+ 1\}`/);
  assert.match(html, /placeholder="FTP host \/ IP"/);
  assert.match(html, /id="modalFtpPort"[^>]+value="21"/);
  assert.match(html, /placeholder="FTP username"/);
  assert.doesNotMatch(html, /id="modalFtpAuthType"/);
  assert.doesNotMatch(html, /id="modalFtpKeyFields"/);
  assert.match(html, /id="modalFtpPort"[^>]+type="text"[^>]+inputmode="numeric"/);
  assert.match(html, /id="modalFtpUsername"[\s\S]*?id="modalFtpPassword"/);
  assert.match(renderer, /function saveActiveModalFtpUser\(\)[\s\S]*?user\.authType = 'password';[\s\S]*?user\.privateKey = '';[\s\S]*?user\.passphrase = '';/);
  assert.match(renderer, /function validateModalFtpUsers[\s\S]*?else if \(!user\.password\)/);
  assert.match(renderer, /function promptForFtpUser\(project\)/);
  assert.match(renderer, /const hasSsh = Boolean\(String\(project\?\.ssh\?\.host \|\| ''\)\.trim\(\)\);/);
  assert.match(renderer, /hasSsh \? 'Use SSH user' : `FTP user \$\{index \+ 1\}`/);
  assert.match(renderer, /state\.activeProjectTab = normalizedProject\.ftp\?\.host && !normalizedProject\.ssh\?\.host \? 'ftp' : 'ssh'/);
  assert.match(renderer, /if \(state\.activeProjectTab === 'ftp'\)[\s\S]*els\.connectFtpButton\.focus\(\)/);
  assert.match(main, /validateConnectionProject\(project, \{ requireSsh: true \}\)/);
  assert.match(main, /if \(!hasSsh && !hasFtp\) return 'Configure an SSH or FTP connection for the server\.'/);
  assert.match(html, />\s*Save Server\s*</);
  assert.match(html, /<div class="server-modal-top">[\s\S]*?<header class="modal-header">[\s\S]*?<ol class="server-wizard-progress"[\s\S]*?<\/div>/);
  assert.match(html, /class="field-grid windows-credentials-grid"[\s\S]*?id="modalRdpUsername"[\s\S]*?id="modalRdpPassword"[\s\S]*?<\/div>\s*<\/div>/);
  assert.match(renderer, /panels\[nextStep\]\?\.id === 'projectStepPanelSsh' \|\| nextStep === panels\.length - 1/);
  assert.match(renderer, /savingFromConnectionStep \? state\.modalStep : panels\.length - 1/);
  assert.match(styles, /\.server-wizard-progress\s*\{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.server-wizard-progress\.windows-flow\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.server-modal-card\s*\{[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.server-modal-card\s*\{[\s\S]*?max-height: min\(860px, calc\(100dvh - 32px\)\)/);
  assert.doesNotMatch(styles, /\.server-modal-card\s*\{[^}]*\n\s*height:/);
  assert.match(styles, /\.server-modal-top\s*\{[\s\S]*?grid-template-columns: minmax\(190px, 0\.8fr\) minmax\(480px, 2fr\)/);
  assert.match(styles, /\.server-modal-top > \.server-wizard-progress\s*\{[\s\S]*?width: min\(100%, 400px\)[\s\S]*?justify-self: end/);
  assert.match(styles, /\.server-modal-top \.server-wizard-step\s*\{[\s\S]*?grid-template-columns: 20px minmax\(0, 1fr\)/);
  assert.match(styles, /\.server-modal-top \.server-wizard-step-item:not\(:last-child\)::after\s*\{\s*display: none/);
  assert.match(styles, /\.server-modal-card \.project-modal-body\s*\{\s*min-height: 0/);
  assert.match(styles, /\.project-modal-card \.secret-input\s*\{[\s\S]*?position: relative;[\s\S]*?display: block/);
  assert.match(styles, /\.project-modal-card \.secret-input \.secret-toggle\s*\{[\s\S]*?position: absolute;[\s\S]*?right: 4px/);
  assert.match(styles, /html\[data-theme\] \.project-modal-card \.secret-input \.secret-toggle[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(styles, /\.project-modal-card \.ssh-user-fields \.modal-secret\s*\{\s*margin-top: 0/);
  assert.match(styles, /\.project-modal-card \.windows-credentials-grid\s*\{\s*grid-template-columns: repeat\(auto-fit, minmax\(190px, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.project-modal-card \.windows-endpoint-grid,[\s\S]*?\.project-modal-card \.windows-credentials-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.project-modal-card \.ssh-endpoint-grid,[\s\S]*?grid-template-columns: minmax\(280px, 520px\) 140px/);
});

test('supports RDP and VNC for Windows server profiles and remote control', async () => {
  const [html, renderer, preload, main, rdpClient, vncClient, rfb] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'rdp-client.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'vnc-client.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'vendor', 'novnc', 'core', 'rfb.js'), 'utf8')
  ]);

  assert.match(html, /<option value="vnc">Windows<\/option>/);
  assert.match(html, /id="modalRdpPort"[^>]+value="5900"/);
  assert.match(html, /data-windows-protocol="rdp">RDP<\/button>/);
  assert.match(html, /data-windows-protocol="vnc">VNC<\/button>/);
  assert.match(html, /VNC Server \/ IP/);
  assert.match(html, /VNC Password/);
  assert.match(html, /id="modalRdpDomain"/);
  assert.match(html, /Windows Remote Desktop session/);
  assert.match(renderer, /import\(protocol === 'rdp' \? '\.\/rdp-client\.js' : '\.\/vnc-client\.js'\)/);
  assert.match(renderer, /window\.deployerx\.startVnc\(/);
  assert.match(renderer, /window\.deployerx\.startRdp\(/);
  assert.match(renderer, /window\.deployerx\.loadRdpWasm\(/);
  assert.match(renderer, /window\.deployerx\.stopRdp\(/);
  assert.match(preload, /startRdp: \(payload\) => ipcRenderer\.invoke\('rdp:start', payload\)/);
  assert.match(preload, /startVnc: \(payload\) => ipcRenderer\.invoke\('vnc:start', payload\)/);
  assert.match(main, /ipcMain\.handle\('rdp:start'/);
  assert.match(main, /ipcMain\.handle\('vnc:start'/);
  assert.match(rdpClient, /SessionBuilder/);
  assert.match(vncClient, /import RFB from '.\/vendor\/novnc\/core\/rfb\.js'/);
  assert.match(vncClient, /VNC_HANDSHAKE_TIMEOUT_MS = 12000/);
  assert.doesNotMatch(rfb, /encs\.push\(encodings\.encodingH264\)/);
});
