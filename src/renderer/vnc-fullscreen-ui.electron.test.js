const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

function waitForFullscreen(window, enabled) {
  if (window.isFullScreen() === enabled) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const eventName = enabled ? 'enter-full-screen' : 'leave-full-screen';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}.`)), 3000);
    window.once(eventName, () => {
      clearTimeout(timer);
      resolve();
    });
    window.setFullScreen(enabled);
  });
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1180,
    height: 780,
    backgroundColor: '#f6f7fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true }
  });

  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    await window.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      const shell = document.querySelector('.app-shell');
      shell.classList.remove('hidden');
      shell.style.setProperty('display', 'grid', 'important');
      document.body.classList.add('project-view-active');
      state.currentView = 'project';
      state.activeProject = { id: 'vnc-test', name: 'VNC test', serverType: 'windows-vnc', vnc: {} };
      state.rdpProjectId = 'vnc-test';
      state.rdpStatus = 'connected';
      document.querySelectorAll('.workspace > .view').forEach((view) => view.classList.add('hidden'));
      els.projectView.classList.remove('hidden');
      els.projectView.classList.add('windows-project');
      els.rdpWorkspace.classList.remove('hidden');
      els.rdpWorkspace.classList.add('rdp-connected');
      els.sshWorkspace.classList.add('hidden');
      els.rdpCanvas.classList.add('hidden');
      els.vncCanvas.classList.remove('hidden');
      const framebuffer = document.createElement('canvas');
      framebuffer.width = 1280;
      framebuffer.height = 720;
      const context = framebuffer.getContext('2d');
      context.fillStyle = '#126b45';
      context.fillRect(0, 0, framebuffer.width, framebuffer.height);
      context.fillStyle = '#ffffff';
      context.font = '48px sans-serif';
      context.fillText('VNC framebuffer', 48, 80);
      els.vncCanvas.replaceChildren(framebuffer);
    })()`);

    await waitForFullscreen(window, true);
    await window.webContents.executeJavaScript('applyRdpFullscreen(true)');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const nativeFullscreenEntered = window.isFullScreen();

    const layout = await window.webContents.executeJavaScript(`(() => {
      const bounds = (element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, left: rect.left, top: rect.top };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        shell: bounds(els.appShell),
        workspace: bounds(document.querySelector('.workspace')),
        project: bounds(els.projectView),
        remote: bounds(els.rdpWorkspace),
        viewportSurface: bounds(els.rdpViewport),
        canvas: bounds(els.vncCanvas),
        shellFullscreen: els.appShell.classList.contains('rdp-fullscreen'),
        projectVisible: getComputedStyle(els.projectView).display !== 'none',
        remoteVisible: getComputedStyle(els.rdpWorkspace).display !== 'none'
      };
    })()`);

    const capture = await window.webContents.capturePage();
    const bitmap = capture.toBitmap();
    let lightPixels = 0;
    const totalPixels = capture.getSize().width * capture.getSize().height;
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      if (bitmap[offset] > 240 && bitmap[offset + 1] > 240 && bitmap[offset + 2] > 240) lightPixels += 1;
    }
    const lightPixelRatio = totalPixels ? lightPixels / totalPixels : 1;
    const surfaces = [layout.shell, layout.workspace, layout.project, layout.remote, layout.viewportSurface, layout.canvas];
    await waitForFullscreen(window, false);
    await window.webContents.executeJavaScript('applyRdpFullscreen(false)');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const restored = await window.webContents.executeJavaScript(`(() => ({
      shellFullscreen: els.appShell.classList.contains('rdp-fullscreen'),
      topbarVisible: getComputedStyle(document.querySelector('.app-topbar')).display !== 'none',
      sidebarVisible: getComputedStyle(document.querySelector('.sidebar')).display !== 'none',
      projectHeaderVisible: getComputedStyle(els.projectView.querySelector('.view-header')).display !== 'none'
    }))()`);
    const passed = nativeFullscreenEntered
      && layout.shellFullscreen
      && layout.projectVisible
      && layout.remoteVisible
      && surfaces.every((surface) => surface.width > 100 && surface.height > 100)
      && Math.abs(layout.shell.width - layout.viewport.width) <= 1
      && Math.abs(layout.shell.height - layout.viewport.height) <= 1
      && lightPixelRatio < 0.05
      && !window.isFullScreen()
      && !restored.shellFullscreen
      && restored.topbarVisible
      && restored.sidebarVisible
      && restored.projectHeaderVisible;

    process.stdout.write(`${JSON.stringify({ ok: passed, nativeFullscreenEntered, layout, restored, lightPixelRatio })}\n`);
    if (!passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (window.isFullScreen()) await waitForFullscreen(window, false).catch(() => {});
    window.destroy();
    app.exit(process.exitCode || 0);
  }
});
