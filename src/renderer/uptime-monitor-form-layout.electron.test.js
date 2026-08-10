const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('[data-uptime-monitor-step="3"] .modal-columns');
    const fields = [...grid.children].map((field) => {
      const rect = field.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width };
    });
    return { columns: getComputedStyle(grid).gridTemplateColumns, fields };
  })()`);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    backgroundColor: '#f6f7fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true }
  });

  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    await window.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      document.getElementById('uptimeMonitorModal').classList.remove('hidden');
      document.querySelectorAll('[data-uptime-monitor-step]').forEach((step) => step.classList.toggle('hidden', step.dataset.uptimeMonitorStep !== '3'));
    })()`);

    const desktop = await measure(window);
    window.setSize(640, 820);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const narrow = await measure(window);
    const desktopPairs = desktop.fields[0].top === desktop.fields[1].top
      && desktop.fields[0].left < desktop.fields[1].left
      && desktop.fields[2].top === desktop.fields[3].top;
    const narrowRows = narrow.fields.every((field, index) => index === 0 || field.top > narrow.fields[index - 1].top);
    const passed = desktop.columns.split(' ').length === 2
      && desktopPairs
      && narrow.columns.split(' ').length === 1
      && narrowRows;

    process.stdout.write(`${JSON.stringify({ ok: passed, desktop, narrow })}\n`);
    app.exit(passed ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  } finally {
    window.destroy();
  }
});
