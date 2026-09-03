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

test('keeps SSH shells isolated by tab and starts every terminal at the authenticated home directory', async () => {
  const [source, mainSource] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, '..', 'main.js'), 'utf8')
  ]);

  assert.equal(source.includes('activeTerminalTabIds: {}'), true, 'active tab state per server');
  assert.equal(source.includes("find((session) => session.sessionId === sessionId)"), true, 'events resolve their own terminal session');
  assert.equal(source.includes('state.activeTerminalTabIds[session.projectId] === session.tabId'), true, 'only the selected tab writes to xterm');
  assert.equal(source.includes('terminalSessions?.some((session) => session.sessionId && session.connected)'), true, 'project SSH state includes every tab');
  assert.equal(source.includes("createTerminalTabSession(projectId, { startupDirectory = '' } = {})"), true, 'every terminal starts in the authenticated user home directory');
  assert.equal(source.includes("blankTerminalSession(projectId = '', { tabId = '', label = '', startupDirectory = '' } = {})"), true, 'terminal sessions do not force a root startup directory');
  assert.match(source, /startupPath && startupPath !== '\/' \? normalizeRemoteShellPath\(startupPath\) : ''/, 'legacy root startup paths are ignored');
  assert.match(mainSource, /changeDirectory = startupDirectory \? `cd -- \$\{quoteTerminalShellPath\(startupDirectory\)\}; ` : '';[\s\S]*?stream\.write\(`stty sane[\s\S]*?\$\{changeDirectory\}[\s\S]*?stty echo echonl/, 'optional startup paths are quoted and shell echo is restored');
  assert.equal(mainSource.includes("const completionCaseHandling = \"if [ -n \\\"$BASH_VERSION\\\" ]; then bind 'set completion-ignore-case on'; fi\";"), true, 'Bash tab completion ignores directory name casing');
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

test('shows actionable SSH connection failures in the terminal output', async () => {
  const [source, mainSource] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, '..', 'main.js'), 'utf8')
  ]);

  assert.match(mainSource, /function normalizeTerminalConnectionError\([\s\S]*?SSH connection timed out/);
  assert.match(mainSource, /function normalizeTerminalConnectionError\([\s\S]*?SSH authentication failed/);
  assert.match(mainSource, /function normalizeTerminalConnectionError\([\s\S]*?connection was refused/);
  assert.match(mainSource, /function normalizeTerminalConnectionError\([\s\S]*?could not be resolved/);
  assert.match(mainSource, /emitTerminal\(sessionId, 'failed', normalizeTerminalConnectionError\(error, project, connectionConfig\)\.message\)/);
  assert.match(source, /const detail = String\(payloadMessage \|\| \(event\.type === 'failed' \? 'SSH connection failed without a diagnostic message\.'/);
  assert.match(source, /const message = event\.type === 'failed' \? `\[SSH connection error\] \$\{detail\}\\n`/);
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

test('persists custom terminal tab names and edits them inline', async () => {
  const [source, html, mainSource] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, 'index.html'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, '..', 'main.js'), 'utf8')
  ]);

  assert.equal(source.includes("TERMINAL_TAB_NAMES_STORAGE_KEY = 'deployerx.terminal-tab-names.v1'"), true, 'terminal names use a stable storage key');
  assert.match(source, /function saveTerminalTabNames\([\s\S]*?localStorage\.setItem\(TERMINAL_TAB_NAMES_STORAGE_KEY/, 'custom names are written to local storage');
  assert.match(source, /function startTerminalTabRename\([\s\S]*?state\.terminalTabRename = \{ projectId, tabId \}/, 'renaming opens an inline edit state');
  assert.match(source, /function finishTerminalTabRename\([\s\S]*?saveTerminalTabNames\(projectId\)/, 'inline rename saves custom names');
  assert.equal(source.includes("window.prompt('Rename terminal'"), false, 'terminal renaming does not use Electron-unsupported native prompts');
  assert.equal(html.includes('id="terminalRenameModal"'), false, 'terminal rename modal is not rendered');
  assert.match(source, /data-terminal-tab-rename/, 'terminal labels expose a rename target');
  assert.match(source, /contenteditable="plaintext-only"/, 'edited labels become editable text instead of an input field');
  assert.match(source, /terminal-tab-status[\s\S]*?contenteditable="plaintext-only"/, 'rename keeps the tab status indicator and active button');
  assert.match(source, /range\.selectNodeContents\(renameLabel\);\s+selection\?\.removeAllRanges/, 'double-click selects the full label text');
  assert.match(source, /if \(state\.activeTerminalTabIds\[projectId\] === session\.tabId\) return;/, 'selecting the active tab does not interrupt a double-click gesture');
  assert.match(source, /els\.terminalTabs\.addEventListener\('dblclick'[\s\S]*?data-terminal-tab-select[\s\S]*?startTerminalTabRename\(/, 'double-clicking a terminal title opens inline editing');
  assert.doesNotMatch(source, /terminalTabs\.addEventListener\('click',[\s\S]*?data-terminal-tab-rename\]\)\) return;/, 'single-clicking a label still activates its terminal');
  assert.match(source, /if \(event\.detail > 1\)[\s\S]*?cancelTerminalTabClick\(\);/, 'double-clicks cancel pending single-click activation');
  assert.match(source, /terminalTabClickTimer = setTimeout\([\s\S]*?activateTerminalTab\(tabId\)[\s\S]*?\}, 180\);/, 'single-click activation waits for the double-click decision');
  assert.match(source, /event\.key === 'Enter' \|\| event\.key === 'Escape'/, 'Enter saves and Escape cancels inline editing');
  assert.match(mainSource, /function isTerminalChannelClosedError[\s\S]*?unable to exec[\s\S]*?no response from server/, 'expected SSH close errors are recognized');
  assert.match(mainSource, /async function listTerminalDirectory[\s\S]*?isTerminalChannelClosedError\(error\)[\s\S]*?closed: true/, 'directory refresh closes quietly with a closed SSH channel');
});

test('keeps the terminal shell fixed while xterm owns output scrolling', async () => {
  const styles = await fs.readFile(path.join(rendererDirectory, 'styles.css'), 'utf8');

  assert.match(styles, /body\.project-view-active \{\s+overflow: hidden;/, 'document does not scroll in project view');
  assert.match(styles, /body\.project-view-active \.app-shell \{\s+height: 100dvh;\s+min-height: 0;\s+overflow: hidden;/, 'app shell stays locked to the viewport');
  assert.match(styles, /body\.project-view-active #projectView:not\(\.hidden\) \{\s+display: grid;\s+grid-template-rows: auto minmax\(0, 1fr\);/, 'project header and terminal use fixed grid rows');
  assert.match(styles, /\.main-terminal-output \.xterm-scrollable-element > \.scrollbar > \.slider[\s\S]*?background: transparent !important;/, 'xterm scrollbar slider stays hidden without disabling terminal scrolling');
});

test('prevents native text highlighting in the SSH directory browser', async () => {
  const styles = await fs.readFile(path.join(rendererDirectory, 'styles.css'), 'utf8');
  assert.match(styles, /\.ssh-directory-status,\s*\.ssh-directory-list\s*\{\s*user-select:\s*none;/s);
});
