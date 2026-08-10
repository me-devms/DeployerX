const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('keeps the VNC surface mounted and resizes it after native fullscreen settles', async () => {
  const [styles, renderer, main] = await Promise.all([
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8')
  ]);

  const fullscreenStyles = styles.slice(
    styles.indexOf('.app-shell.rdp-fullscreen {'),
    styles.indexOf('@container ftp-workspace')
  );
  assert.match(fullscreenStyles, /position:\s*fixed/);
  assert.match(fullscreenStyles, /height:\s*100dvh/);
  assert.match(fullscreenStyles, /\.rdp-viewport\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/s);
  assert.match(fullscreenStyles, /background:\s*#101214/g);
  assert.match(styles, /body\.project-view-active \.app-shell\.rdp-fullscreen #projectView:not\(\.hidden\)\s*\{\s*grid-template-rows:\s*minmax\(0, 1fr\)/);

  const toggle = renderer.slice(
    renderer.indexOf('async function toggleRdpFullscreen()'),
    renderer.indexOf('const DATABASE_DRIVER_UI')
  );
  assert.doesNotMatch(toggle, /applyRdpFullscreen\(requested\)[\s\S]*setVncFullscreen/);
  assert.match(toggle, /rdpFullscreenTransitionPending[\s\S]*setVncFullscreen[\s\S]*applyRdpFullscreen\(enabled\)/);
  assert.match(renderer, /\[0, 160, 420\][\s\S]*activeRdpClient\.resize\(\)/);

  const transition = main.slice(
    main.indexOf('function transitionMainWindowFullscreen(enabled)'),
    main.indexOf("ipcMain.handle('backup:secrets:list'")
  );
  assert.match(transition, /window\.once\(eventName, finish\)/);
  assert.match(transition, /window\.setFullScreen\(enabled\)[\s\S]*\[0, 220, 650\]/);
  assert.match(transition, /await transitionMainWindowFullscreen\(false\)/);
  assert.match(transition, /const fullscreen = await transitionMainWindowFullscreen\(true\)/);
  assert.match(transition, /maximized:\s*mainWindow\.isMaximized\(\)/);
  assert.match(transition, /restoreState\.maximized[\s\S]*mainWindow\.maximize\(\)/);
  assert.match(main, /mainWindow\.on\('leave-full-screen',[\s\S]*restoreVncWindowState\(\)/);
});
