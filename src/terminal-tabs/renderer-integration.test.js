const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const rendererDirectory = path.join(__dirname, '..', 'renderer');

test('renders accessible SSH terminal tabs with a fixed new-tab control', async () => {
  const [html, styles] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'index.html'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, 'styles.css'), 'utf8')
  ]);

  assert.equal(html.includes('id="terminalTabs" class="terminal-tabs" role="tablist"'), true, 'terminal tab list');
  assert.equal(html.includes('id="terminalNewTabButton"'), true, 'new terminal control');
  assert.equal(styles.includes('grid-template-rows: 32px minmax(0, 1fr);'), true, 'tab strip keeps a compact stable height');
  assert.match(styles, /\.terminal-tab-bar \{[\s\S]*?border-bottom-left-radius: 6px;/, 'tab strip border follows the terminal corner radius');
  assert.match(styles, /html\[data-theme\] \.terminal-main \{\s+gap: 0;\s+padding: 0 12px 12px;/, 'terminal tabs touch the top edge');
  assert.match(styles, /\.terminal-tab:first-child \{\s+overflow: hidden;\s+border-bottom-left-radius: 6px;/, 'first tab follows the terminal corner radius');
  assert.equal(styles.includes('.terminal-tab.active'), true, 'active terminal indicator');
  assert.equal(styles.includes('.terminal-tab.connected .terminal-tab-status'), true, 'per-tab connection indicator');
});

test('keeps SSH shells isolated by tab and starts every terminal at the filesystem root', async () => {
  const [source, mainSource] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, '..', 'main.js'), 'utf8')
  ]);

  assert.equal(source.includes('activeTerminalTabIds: {}'), true, 'active tab state per server');
  assert.equal(source.includes("find((session) => session.sessionId === sessionId)"), true, 'events resolve their own terminal session');
  assert.equal(source.includes('state.activeTerminalTabIds[session.projectId] === session.tabId'), true, 'only the selected tab writes to xterm');
  assert.equal(source.includes('terminalSessions?.some((session) => session.sessionId && session.connected)'), true, 'project SSH state includes every tab');
  assert.equal(source.includes("createTerminalTabSession(projectId, { startupDirectory = '/' } = {})"), true, 'every terminal defaults to the filesystem root');
  assert.match(mainSource, /changeDirectory = startupDirectory \? `cd -- \$\{quoteTerminalShellPath\(startupDirectory\)\}; ` : '';[\s\S]*?stream\.write\(`stty sane[\s\S]*?\$\{changeDirectory\}[\s\S]*?stty echo echonl/, 'startup changes to the quoted root path and restores terminal echo');
  assert.equal(source.includes('await window.deployerx.stopTerminal(session.sessionId)'), true, 'closing a tab stops only its own shell');
  assert.equal(source.includes('if (!isVisibleTerminalSession(terminalSession)) return;'), true, 'background connections cannot steal focus');
  assert.equal(source.includes("document.body.classList.toggle('project-view-active', isProject)"), true, 'project view locks document scrolling');
  assert.match(source, /els\.connectTerminalButton\.addEventListener\('click', \(\) => \{\s+connectTerminal\(\)\.catch\(\(error\) => showAlert\(error\.message \|\| 'Could not connect SSH\.'\)\);\s+\}\);/, 'connect button must call connectTerminal without passing the click event as the project');
});

test('restores terminal rendering and keyboard focus after navigation', async () => {
  const source = await fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8');

  assert.match(source, /function restoreTerminalInteraction[\s\S]*?fitTerminal\(\);[\s\S]*?terminal\.refresh\(0, Math\.max\(0, terminal\.rows - 1\)\);[\s\S]*?resizeActiveTerminal\(\);[\s\S]*?terminal\.focus\(\);/, 'visible SSH terminals are refitted, repainted, resized, and focused');
  assert.match(source, /function setProjectTab[\s\S]*?restoreTerminalInteraction\(\);/, 'returning from the FTP tab restores the SSH terminal');
  assert.match(source, /if \(event\.type === 'connected'\)[\s\S]*?if \(isVisibleTerminalSession\(terminalSession\)\) restoreTerminalInteraction\(\);/, 'a newly connected terminal receives keyboard focus');
});

test('does not disable remote shell echo when creating the SSH PTY', async () => {
  const mainSource = await fs.readFile(path.join(rendererDirectory, '..', 'main.js'), 'utf8');
  const terminalStart = mainSource.slice(mainSource.indexOf('async function startTerminal'), mainSource.indexOf('function resizeTerminal'));

  assert.equal(terminalStart.includes('modes: { ECHO: 0, ECHONL: 0 }'), false, 'typed shell input remains visible');
  assert.equal(terminalStart.includes('stty echo echonl'), true, 'shell startup also normalizes echo flags');
});

test('keeps terminal tab numbers contiguous and identifies multi-user sessions', async () => {
  const [source, styles] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, 'styles.css'), 'utf8')
  ]);

  assert.match(source, /function renumberTerminalTabs\([\s\S]*?session\.label = `Terminal \$\{index \+ 1\}`;[\s\S]*?terminalTabCounters\[projectId\] = tabs\.length;/, 'remaining tabs are renumbered from one');
  assert.match(source, /tabs\.splice\(index, 1\);[\s\S]*?renumberTerminalTabs\(projectId, tabs\);/, 'closing a tab compacts the sequence');
  assert.match(source, /savedUsers\.length > 1 && username \? `\$\{baseLabel\} - \$\{username\}` : baseLabel/, 'multi-user tabs include the selected username');
  assert.equal(source.includes('terminalTabDisplayLabel(session)'), true, 'rendered labels use the user-aware display name');
  assert.match(styles, /\.terminal-tab \{[\s\S]*?width: 190px;[\s\S]*?min-width: 190px;/, 'tabs reserve enough width for usernames');
});

test('keeps the terminal shell fixed while xterm owns output scrolling', async () => {
  const styles = await fs.readFile(path.join(rendererDirectory, 'styles.css'), 'utf8');

  assert.match(styles, /body\.project-view-active \{\s+overflow: hidden;/, 'document does not scroll in project view');
  assert.match(styles, /body\.project-view-active \.app-shell \{\s+height: 100dvh;\s+min-height: 0;\s+overflow: hidden;/, 'app shell stays locked to the viewport');
  assert.match(styles, /body\.project-view-active #projectView:not\(\.hidden\) \{\s+display: grid;\s+grid-template-rows: auto minmax\(0, 1fr\);/, 'project header and terminal use fixed grid rows');
});

test('prevents native text highlighting in the SSH directory browser', async () => {
  const styles = await fs.readFile(path.join(rendererDirectory, 'styles.css'), 'utf8');
  assert.match(styles, /\.ssh-directory-status,\s*\.ssh-directory-list\s*\{\s*user-select:\s*none;/s);
});
