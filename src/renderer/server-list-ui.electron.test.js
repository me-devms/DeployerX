const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-server-list-ui-'));
  const window = new BrowserWindow({
    show: false,
    width: 1343,
    height: 760,
    backgroundColor: '#1d2021',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  let exitCode = 0;

  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    await window.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('setupModal')?.classList.add('hidden');
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.documentElement.dataset.theme = 'gruvbox-dark';
      activeThemeId = 'gruvbox-dark';
      state.setup.mode = 'offline';
      state.setup.complete = true;
      state.projects = Array.from({ length: 18 }, (_, index) => ({
        id: 'server-' + index,
        name: 'Server ' + String(index + 1).padStart(2, '0'),
        group: index < 9 ? 'Production' : 'Internal',
        serverType: index % 3 === 0 ? 'ubuntu' : index % 3 === 1 ? 'almalinux' : 'windows',
        pinned: index % 4 === 0,
        ssh: { host: '192.168.1.' + (index + 10), port: 22, username: index % 2 ? 'administrator' : 'root' },
        ftp: {},
        commands: Array.from({ length: index % 6 }, (_, commandIndex) => ({ id: 'command-' + index + '-' + commandIndex }))
      }));
      showView('servers');
      renderProjects();
      true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 220));
    await window.webContents.executeJavaScript(`document.querySelectorAll('.toast').forEach((toast) => toast.classList.add('hidden'));`);

    const topState = await window.webContents.executeJavaScript(`(() => {
      const view = document.getElementById('serversView');
      const header = document.querySelector('.servers-view-header');
      const search = document.querySelector('.server-toolbar-search');
      const input = document.getElementById('serversFilterSearch');
      const headerStyle = getComputedStyle(header);
      const searchStyle = getComputedStyle(search);
      const inputStyle = getComputedStyle(input);
      return {
        viewWidth: view.clientWidth,
        headerPosition: headerStyle.position,
        headerScrollTop: view.scrollTop,
        headerHeight: header.getBoundingClientRect().height,
        actionsInsideView: document.getElementById('dashboardCreateButton').getBoundingClientRect().right <= view.getBoundingClientRect().right + 1,
        searchBackground: searchStyle.backgroundColor,
        inputBackground: inputStyle.backgroundColor,
        inputBorderWidth: inputStyle.borderTopWidth,
        inputBoxShadow: inputStyle.boxShadow,
        searchHeight: search.getBoundingClientRect().height,
        inputHeight: input.getBoundingClientRect().height
      };
    })()`);
    const topPath = path.join(captureRoot, 'servers-top.png');
    window.webContents.invalidate();
    await window.webContents.capturePage();
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.writeFile(topPath, (await window.webContents.capturePage()).toPNG());

    const scrolledState = await window.webContents.executeJavaScript(`(async () => {
      const view = document.getElementById('serversView');
      view.scrollTop = 360;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const headerRect = document.querySelector('.servers-view-header').getBoundingClientRect();
      const addRect = document.getElementById('dashboardCreateButton').getBoundingClientRect();
      const favorites = [...document.querySelectorAll('.server-inventory-favorite')]
        .map((button) => button.getBoundingClientRect())
        .filter((rect) => rect.bottom > 58 && rect.top < innerHeight);
      const intersects = (left, right) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
      return {
        scrollTop: view.scrollTop,
        headerBottom: headerRect.bottom,
        addButtonBottom: addRect.bottom,
        visibleFavorites: favorites.length,
        addOverlapsFavorite: favorites.some((favorite) => intersects(addRect, favorite))
      };
    })()`);
    await window.webContents.executeJavaScript(`document.querySelectorAll('.toast').forEach((toast) => toast.classList.add('hidden'));`);
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await window.webContents.capturePage();
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const scrolledPath = path.join(captureRoot, 'servers-scrolled.png');
    await fs.writeFile(scrolledPath, (await window.webContents.capturePage()).toPNG());

    const valid = topState.headerPosition === 'relative'
      && topState.actionsInsideView
      && topState.searchBackground !== 'rgba(0, 0, 0, 0)'
      && topState.inputBackground === 'rgba(0, 0, 0, 0)'
      && topState.inputBorderWidth === '0px'
      && topState.inputBoxShadow === 'none'
      && topState.searchHeight - topState.inputHeight === 2
      && scrolledState.scrollTop >= 300
      && scrolledState.headerBottom < 58
      && scrolledState.addButtonBottom < 58
      && scrolledState.visibleFavorites > 0
      && !scrolledState.addOverlapsFavorite;

    process.stdout.write(`${JSON.stringify({ ok: valid, topState, scrolledState, screenshots: { topPath, scrolledPath } })}\n`);
    if (!valid) exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
