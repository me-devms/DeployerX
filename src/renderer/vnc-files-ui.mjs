import { remoteChild } from './vnc-file-transfer.mjs';

export function attachVncFiles(client) {
  const api = window.deployerx;
  const transfer = client.rfb?.fileTransfer;
  const controls = document.createElement('div');
  controls.className = 'vnc-file-controls';
  controls.innerHTML = '<button type="button" class="button outline compact" aria-expanded="false">Files & keys</button>';
  const toggle = controls.firstElementChild;
  const panel = document.createElement('section');
  panel.className = 'vnc-files-panel hidden';
  panel.setAttribute('aria-label', 'VNC files and keyboard');
  panel.innerHTML = `
    <div class="vnc-files-actions"><strong>Remote files</strong><button type="button" class="button plain compact" data-action="close">Close</button></div>
    <p>Keyboard shortcuts go to the remote PC while its screen is focused. Ctrl+Alt+Shift+F12 exits full view. Use the button below to send Ctrl+Alt+Delete.</p>
    <div class="vnc-files-actions"><button type="button" class="button outline compact" data-action="windows">Windows key</button><button type="button" class="button outline compact" data-action="cad">Ctrl+Alt+Delete</button></div>
    <p data-role="support">Upload files or drop them onto the screen. Paste copied files or images with Ctrl+V. Images upload as PNG files; TightVNC clipboard sync supports text only.</p>
    <label>Remote folder <input data-role="path" value="/" spellcheck="false" aria-label="Remote folder" /></label>
    <div class="vnc-files-actions"><button type="button" class="button outline compact" data-action="up">Up</button><button type="button" class="button outline compact" data-action="browse">Open folder</button><button type="button" class="button outline compact" data-action="upload">Upload files</button><button type="button" class="button outline compact" data-action="paste">Paste files / image</button></div>
    <input data-role="upload" type="file" multiple hidden />
    <div class="vnc-files-list" data-role="list" aria-label="Remote files"></div>
    <progress data-role="progress" max="100" value="0" aria-label="File transfer progress" hidden></progress>
    <p data-role="status" role="status" aria-live="polite"></p>
    <button type="button" class="button outline compact" data-action="cancel" hidden>Cancel transfer</button>`;
  client.target.parentElement.append(controls, panel);
  const find = (role) => panel.querySelector(`[data-role="${role}"]`);
  const action = (name) => panel.querySelector(`[data-action="${name}"]`);
  const folder = find('path');
  const status = find('status');
  const progress = find('progress');
  let currentPath = '/';
  let disposed = false;
  let busy = false;
  let cancelRequested = false;
  let visible = true;
  let panelOpen = false;
  const updateVisibility = () => {
    controls.classList.toggle('hidden', !visible);
    panel.classList.toggle('hidden', !visible || !panelOpen);
  };
  const supported = Boolean(transfer?.supported);
  if (!supported) find('support').textContent = 'File transfer requires TightVNC 2.x with file transfers enabled on the server.';
  const setBusy = (value) => {
    busy = value;
    for (const name of ['up', 'browse', 'upload', 'paste']) action(name).disabled = value || !supported;
    folder.disabled = value || !supported;
    for (const button of find('list').querySelectorAll('button')) button.disabled = value;
    action('cancel').hidden = !value;
  };
  setBusy(false);
  const open = () => {
    panelOpen = true;
    updateVisibility();
    toggle.setAttribute('aria-expanded', 'true');
    if (visible) folder.focus();
  };
  const report = (error) => { status.textContent = error.message || String(error); };
  async function browse(path = folder.value) {
    if (busy || disposed || !supported) return;
    const normalized = path.replace(/\\/g, '/').replace(/\/$/, '') || '/';
    if (!normalized.startsWith('/') || normalized.includes('\0')) return report(new Error('Use a remote path such as /C:/Users.'));
    setBusy(true);
    status.textContent = 'Loading folder…';
    try {
      const entries = await transfer.list(normalized);
      if (disposed) return;
      currentPath = normalized;
      folder.value = normalized;
      find('list').replaceChildren(...entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).map((entry) => {
        const row = document.createElement('div');
        row.className = 'vnc-file-row';
        const name = document.createElement('span');
        name.textContent = entry.name + (entry.directory ? '/' : '');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button outline compact';
        button.textContent = entry.directory ? 'Open' : 'Download';
        button.setAttribute('aria-label', `${button.textContent} ${entry.name}`);
        button.onclick = () => entry.directory ? browse(remoteChild(currentPath, entry.name)) : download(entry);
        row.append(name, button);
        return row;
      }));
      status.textContent = entries.length ? `${entries.length} entries` : 'This folder is empty.';
    } catch (error) { report(error); }
    finally { if (!disposed) setBusy(false); }
  }
  function updateProgress(name, direction, done, total) {
    progress.hidden = false;
    progress.value = total ? Math.min(99, done / total * 100) : 0;
    status.textContent = `${direction} ${name}: ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
  }
  async function upload(files) {
    if (busy || disposed) throw new Error('Wait for the current transfer to finish.');
    if (!supported) throw new Error('File transfer is not supported by this server.');
    open();
    if (currentPath === '/') throw new Error('Open a destination folder before uploading (for example /C:/Users/Public/Downloads).');
    setBusy(true);
    cancelRequested = false;
    try {
      for (const file of files) {
        if (cancelRequested || disposed) throw new Error('Transfer cancelled.');
        await transfer.upload(remoteChild(currentPath, file.name), file,
          (done, total) => updateProgress(file.name, 'Uploading', done, total));
      }
      progress.value = 100;
      status.textContent = `${files.length} file(s) uploaded to ${currentPath}.`;
    } finally { if (!disposed) setBusy(false); }
  }
  async function pasteClipboard() {
    if (busy) throw new Error('Wait for the current transfer to finish.');
    const content = await api.readVncClipboardFiles();
    const localFiles = content.files || [];
    try {
      if (disposed) return true;
      if (content.image) {
        await upload([new File([content.image], `Clipboard-${Date.now()}.png`, { type: 'image/png' })]);
        return true;
      }
      if (!localFiles.length) return false;
      const files = localFiles.map((file) => ({ ...file, slice: (start, end) => ({
        arrayBuffer: async () => {
          const data = await api.readVncFile(file.id, start, Math.min(end, file.size) - start);
          if (!data.length && start < file.size) throw new Error('Local file changed during upload.');
          return data;
        }
      }) }));
      await upload(files);
      return true;
    } finally { await Promise.allSettled(localFiles.map((file) => api.finishVncFile(file.id))); }
  }
  async function download(entry) {
    if (busy || disposed) return;
    setBusy(true);
    let destination;
    try {
      destination = await api.openVncDownload(entry.name);
      if (!destination || disposed) return;
      await transfer.download(remoteChild(currentPath, entry.name), entry.size,
        (bytes) => api.writeVncFile(destination.id, bytes),
        (done, total) => updateProgress(entry.name, 'Downloading', done, total));
      await api.finishVncFile(destination.id, true);
      destination = null;
      progress.value = 100;
      status.textContent = `${entry.name} downloaded.`;
    } catch (error) { report(error); }
    finally {
      if (destination) await api.finishVncFile(destination.id).catch(() => {});
      if (!disposed) setBusy(false);
    }
  }
  toggle.onclick = () => { if (panel.classList.contains('hidden')) { open(); if (supported && !find('list').children.length) browse(currentPath); } else action('close').click(); };
  action('close').onclick = () => { panelOpen = false; updateVisibility(); toggle.setAttribute('aria-expanded', 'false'); client.focus(); };
  action('browse').onclick = () => browse();
  action('up').onclick = () => browse(currentPath.slice(0, currentPath.lastIndexOf('/')) || '/');
  action('upload').onclick = () => find('upload').click();
  action('paste').onclick = () => pasteClipboard().then((handled) => { if (!handled) status.textContent = 'Copy files or an image on this PC first.'; }).catch(report);
  action('cancel').onclick = () => { cancelRequested = true; transfer.cancel(); status.textContent = 'Cancelling after the current chunk…'; };
  action('windows').onclick = () => { client.rfb?.sendKey(0xffeb, 'MetaLeft'); client.focus(); };
  action('cad').onclick = () => { client.rfb?.sendCtrlAltDel(); client.focus(); };
  folder.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); browse(); } };
  find('upload').onchange = () => { const files = [...find('upload').files]; find('upload').value = ''; if (files.length) upload(files).catch(report); };
  const drag = (event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = supported && !busy ? 'copy' : 'none'; } };
  const drop = (event) => {
    event.preventDefault();
    if (!client.isActive()) return;
    if ([...event.dataTransfer.items].some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      open(); report(new Error('Drop individual files. Folder upload is not supported.')); return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length) upload(files).catch((error) => { open(); report(error); });
  };
  client.target.addEventListener('dragover', drag);
  client.target.addEventListener('drop', drop);
  const removeError = api?.onVncKeyboardError?.((message) => { open(); report(new Error(message)); });
  return {
    setVisible(value) { visible = Boolean(value); updateVisibility(); },
    pasteClipboard,
    report(error) { open(); report(error); },
    dispose() {
      disposed = true;
      transfer?.cancel();
      controls.remove();
      panel.remove();
      removeError?.();
      client.target.removeEventListener('dragover', drag);
      client.target.removeEventListener('drop', drop);
    }
  };
}
