const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

function luminance([red, green, blue]) {
  const channels = [red, green, blue].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(first, second) {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    backgroundColor: '#11111b',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true }
  });
  let exitCode = 0;

  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const colors = await window.webContents.executeJavaScript(`(() => {
      document.documentElement.dataset.theme = 'catppuccin-mocha';
      const primary = document.createElement('button');
      primary.className = 'button solid';
      primary.textContent = 'Connect';
      const danger = document.createElement('button');
      danger.className = 'button solid danger';
      danger.textContent = 'Delete';
      const tab = document.createElement('button');
      tab.className = 'project-tab active';
      tab.textContent = 'FTP';
      document.body.append(primary, danger, tab);
      const snapshot = (element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, foreground: style.color };
      };
      const result = { primary: snapshot(primary), danger: snapshot(danger), tab: snapshot(tab) };
      primary.remove();
      danger.remove();
      tab.remove();
      return result;
    })()`);

    const ratio = contrastRatio([203, 166, 247], [24, 24, 37]);
    const passed = colors.primary.background === 'rgb(203, 166, 247)'
      && colors.primary.foreground === 'rgb(24, 24, 37)'
      && colors.tab.background === 'rgb(203, 166, 247)'
      && colors.tab.foreground === 'rgb(24, 24, 37)'
      && colors.danger.foreground === 'rgb(255, 255, 255)'
      && ratio >= 7;
    process.stdout.write(`${JSON.stringify({ ok: passed, colors, contrastRatio: ratio })}\n`);
    if (!passed) exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
