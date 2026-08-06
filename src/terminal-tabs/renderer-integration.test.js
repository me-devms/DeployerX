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
  assert.equal(styles.includes('grid-template-rows: 36px minmax(0, 1fr);'), true, 'tab strip keeps a stable terminal height');
  assert.equal(styles.includes('.terminal-tab.active'), true, 'active terminal indicator');
  assert.equal(styles.includes('.terminal-tab.connected .terminal-tab-status'), true, 'per-tab connection indicator');
});

test('keeps SSH shells isolated by tab and starts every terminal at the filesystem root', async () => {
  const source = await fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8');

  assert.equal(source.includes('activeTerminalTabIds: {}'), true, 'active tab state per server');
  assert.equal(source.includes("find((session) => session.sessionId === sessionId)"), true, 'events resolve their own terminal session');
  assert.equal(source.includes('state.activeTerminalTabIds[session.projectId] === session.tabId'), true, 'only the selected tab writes to xterm');
  assert.equal(source.includes('terminalSessions?.some((session) => session.sessionId && session.connected)'), true, 'project SSH state includes every tab');
  assert.equal(source.includes("createTerminalTabSession(projectId, { startupDirectory = '/' } = {})"), true, 'every terminal defaults to the filesystem root');
  assert.equal(source.includes('`cd -- ${quoteShellPath(startupDirectory)}; stty echo echonl\\r`'), true, 'the default path is shell quoted and restores terminal echo');
  assert.equal(source.includes('await window.deployerx.stopTerminal(session.sessionId)'), true, 'closing a tab stops only its own shell');
  assert.equal(source.includes('if (!isVisibleTerminalSession(terminalSession)) return;'), true, 'background connections cannot steal focus');
});
