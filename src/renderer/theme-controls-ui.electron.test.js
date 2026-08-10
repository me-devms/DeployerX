const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const themes = [
  'deployerx-light',
  'termius-dark',
  'tokyo-day',
  'catppuccin-mocha',
  'gruvbox-dark',
  'solarized-light'
];
const darkThemes = new Set(['termius-dark', 'catppuccin-mocha', 'gruvbox-dark']);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-theme-controls-'));
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 840,
    backgroundColor: '#111111',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  let exitCode = 0;

  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 800));
    await window.webContents.executeJavaScript(`(() => {
      document.getElementById('startupLoader')?.remove();
      document.head.insertAdjacentHTML('beforeend', '<style id="theme-audit-motion">*, *::before, *::after { transition: none !important; animation: none !important; }</style>');
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      state.setup.mode = 'offline';
      state.setup.complete = true;
      state.activeProject = normalizeProject({
        id: 'theme-server',
        name: 'Theme Server',
        group: 'Production',
        serverType: 'almalinux',
        ssh: {
          host: '192.0.2.10',
          port: 22,
          users: [
            { id: 'root-user', username: 'root', authType: 'password', password: 'secret' },
            { id: 'deploy-user', username: 'deploy', authType: 'password', password: 'secret' }
          ],
          defaultUserId: 'root-user'
        },
        ftp: {},
        commands: []
      });
      state.projects = [structuredClone(state.activeProject)];
      openEditModal();
      setProjectModalStep(1, { focus: false });
      true;
    })()`);

    const results = [];
    for (const themeId of themes) {
      const result = await window.webContents.executeJavaScript(`(async () => {
        document.documentElement.dataset.theme = ${JSON.stringify(themeId)};
        activeThemeId = ${JSON.stringify(themeId)};
        document.getElementById('startupLoader')?.classList.add('hidden');
        document.getElementById('setupModal')?.classList.add('hidden');
        document.querySelector('.app-shell')?.classList.remove('hidden');
        setModalVisible(true, els.projectModal);
        document.querySelectorAll('.toast').forEach((toast) => toast.classList.add('hidden'));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const resolveColor = (variable) => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = 'var(' + variable + ')';
          document.body.appendChild(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        };
        const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
        const foreground = (selector) => getComputedStyle(document.querySelector(selector)).color;
        const inputSelectors = ['#modalProjectName', '#modalSshHost', '#modalSshPort', '#modalSshUsername', '#modalSshPassword', '#sshDirectoryPath'];
        return {
          themeId: ${JSON.stringify(themeId)},
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          controlBg: resolveColor('--control-bg'),
          surface: resolveColor('--surface'),
          surfaceSubtle: resolveColor('--surface-subtle'),
          ink: resolveColor('--ink'),
          inputBackgrounds: inputSelectors.map(background),
          inputForegrounds: inputSelectors.map(foreground),
          selectBackground: background('select'),
          textareaBackground: background('textarea'),
          authDropdownBackground: background('#modalAuthTypeButton'),
          authDropdownForeground: foreground('#modalAuthTypeButton'),
          modalBackground: background('#projectModal .modal-card')
        };
      })()`);
      const screenshotPath = path.join(captureRoot, `${themeId}.png`);
      window.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
      results.push({ ...result, screenshotPath });
    }

    const valid = results.every((result) => {
      const expectedScheme = darkThemes.has(result.themeId) ? 'dark' : 'light';
      const controlsMatch = result.inputBackgrounds.every((color) => color === result.controlBg)
        && result.inputForegrounds.every((color) => color === result.ink)
        && [result.controlBg, result.surfaceSubtle].includes(result.selectBackground)
        && [result.controlBg, result.surfaceSubtle].includes(result.textareaBackground)
        && [result.controlBg, result.surface, result.surfaceSubtle].includes(result.authDropdownBackground)
        && result.authDropdownForeground === result.ink;
      const darkControlsAreNotWhite = !darkThemes.has(result.themeId)
        || ![...result.inputBackgrounds, result.selectBackground, result.textareaBackground, result.authDropdownBackground, result.modalBackground]
          .includes('rgb(255, 255, 255)');
      return result.colorScheme === expectedScheme
        && result.modalBackground === result.surface
        && controlsMatch
        && darkControlsAreNotWhite;
    });

    process.stdout.write(`${JSON.stringify({ ok: valid, results })}\n`);
    if (!valid) exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
