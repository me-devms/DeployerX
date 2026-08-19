const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('moves focus out before hiding aria-hidden interactive surfaces', () => {
  assert.match(renderer, /function moveFocusBeforeHide\(container, preferredTarget = null\)/);
  assert.match(renderer, /if \(target\) target\.focus\(\{ preventScroll: true \}\);\s*else document\.activeElement\?\.blur\?\.\(\);/);

  const closeTerminalPrompt = renderer.slice(
    renderer.indexOf('function closeTerminalUserPrompt('),
    renderer.indexOf('function readTerminalUserPromptSelection(')
  );
  assert.match(closeTerminalPrompt, /moveFocusBeforeHide\(els\.terminalUserPromptModal, restoreFocus \? focusOrigin : null\);[\s\S]*setModalVisible\(false, els\.terminalUserPromptModal\);[\s\S]*setAttribute\('aria-hidden', 'true'\)/);

  const hideContextMenu = renderer.slice(
    renderer.indexOf('function hideFtpContextMenu('),
    renderer.indexOf('function promptFileName(')
  );
  assert.match(hideContextMenu, /moveFocusBeforeHide\(els\.ftpContextMenu\);[\s\S]*setAttribute\('aria-hidden', 'true'\)/);
});
