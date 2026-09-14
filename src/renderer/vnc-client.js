import RFB from './vendor/novnc/core/rfb.js';
import { resolveVncDisplays } from './vnc-display-layout.mjs';
import { attachVncFiles } from './vnc-files-ui.mjs';

const VNC_HANDSHAKE_TIMEOUT_MS = 12000;

function eventMessage(event, fallback) {
  return String(event?.detail?.reason || event?.detail?.message || fallback || '').trim();
}

function securityFailureMessage(event) {
  const message = eventMessage(event, 'VNC authentication failed.');
  if (message.toLocaleLowerCase('en-US') === 'server is not configured properly') {
    return 'TightVNC Server rejected the connection because its Primary password is not configured. Configure a Primary password on the remote PC, then enter the same password in DeployerX.';
  }
  return message;
}

class VncClient {
  constructor({ target, readClipboard, writeClipboard, onConnected, onEnded, onEscape, onDisplaysChanged, isActive = () => true }) {
    this.target = target;
    this.isActive = isActive;
    this.readClipboard = readClipboard;
    this.writeClipboard = writeClipboard;
    this.onConnected = onConnected;
    this.onEnded = onEnded;
    this.onEscape = onEscape;
    this.onDisplaysChanged = onDisplaysChanged;
    this.rfb = null;
    this.screenLayout = [];
    this.framebufferSize = { width: 0, height: 0 };
    this.displays = [];
    this.selectedDisplayId = 'all';
    this.manualDisconnect = false;
    this.failureMessage = '';
    this.connectionTimer = null;
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handlePaste = this.handlePaste.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.lastClipboardText = '';
    this.hasSyncedLocalClipboard = false;
    this.syncKeyboardFocus = this.syncKeyboardFocus.bind(this);
    this.keyboardFocused = false;
    this.nativeKeys = new Map();
  }

  async connect({ proxyUrl, username = '', password = '' }) {
    this.disconnect();
    this.manualDisconnect = false;
    this.failureMessage = '';
    this.hasSyncedLocalClipboard = false;
    this.target.replaceChildren();
    const rfb = new RFB(this.target, proxyUrl, {
      credentials: { username, password },
      shared: true
    });
    this.rfb = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.viewOnly = false;
    rfb.focusOnClick = true;
    rfb.background = '#101214';
    rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ username, password }));
    rfb.addEventListener('clipboard', (event) => {
      try {
        const text = event.detail?.text || '';
        this.lastClipboardText = text;
        this.hasSyncedLocalClipboard = true;
        this.writeClipboard?.(text);
      } catch {}
    });
    rfb.addEventListener('securityfailure', (event) => {
      this.failureMessage = securityFailureMessage(event);
    });
    rfb.addEventListener('screenlayout', (event) => {
      if (this.rfb !== rfb) return;
      this.screenLayout = event.detail?.screens || [];
      this.updateDisplays();
    });
    rfb.addEventListener('framebuffersize', (event) => {
      if (this.rfb !== rfb) return;
      this.framebufferSize = {
        width: Number(event.detail?.width) || 0,
        height: Number(event.detail?.height) || 0
      };
      this.updateDisplays();
    });
    rfb.addEventListener('connect', () => {
      if (this.rfb !== rfb) return;
      this.clearConnectionTimer();
      this.filePanel = attachVncFiles(this);
      this.connected = true;
      this.syncKeyboardFocus();
      this.syncLocalClipboard();
      this.onConnected?.();
    });
    rfb.addEventListener('disconnect', (event) => {
      if (this.rfb !== rfb) return;
      this.rfb = null;
      this.clearConnectionTimer();
      this.removeInputListeners();
      this.target.replaceChildren();
      this.resetDisplays();
      if (!this.manualDisconnect) {
        const clean = Boolean(event.detail?.clean);
        this.onEnded?.(this.failureMessage || (clean ? 'VNC session ended.' : 'VNC connection was interrupted.'));
      }
    });
    window.addEventListener('keydown', this.handleKeyDown, true);
    window.addEventListener('focus', this.syncKeyboardFocus);
    window.addEventListener('blur', this.syncKeyboardFocus);
    document.addEventListener('focusin', this.syncKeyboardFocus);
    document.addEventListener('focusout', this.syncKeyboardFocus);
    this.keyboardTimer = setInterval(this.syncKeyboardFocus, 250);
    this.removeNativeKeyListener = window.deployerx?.onVncKey?.((key) => {
      if (!this.rfb || (key.down && (!this.keyboardFocused || !this.isActive()))) return;
      if (key.down) this.nativeKeys.set(key.code, key.keysym);
      else this.nativeKeys.delete(key.code);
      this.rfb.sendKey(key.keysym, key.code, key.down);
    });
    this.target.addEventListener('paste', this.handlePaste);
    this.target.addEventListener('mousedown', this.handleMouseDown, true);
    this.connectionTimer = setTimeout(() => {
      this.fail('The VNC handshake timed out. Verify this port is running TightVNC Server and that its authentication mode is enabled.');
    }, VNC_HANDSHAKE_TIMEOUT_MS);
    requestAnimationFrame(() => rfb.focus({ preventScroll: true }));
  }

  handleKeyDown(event) {
    const remoteFocused = this.isActive() && (this.target === document.activeElement || this.target.contains(document.activeElement));
    const pasteShortcut = event.code === 'KeyV' && !event.altKey && !event.shiftKey &&
      (event.ctrlKey || (event.metaKey && /Mac/.test(navigator.platform)));
    if (remoteFocused && pasteShortcut) {
      if (this.filePanel) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat && !this.pastePending) {
          this.pastePending = true;
          const rfb = this.rfb;
          this.filePanel.pasteClipboard().then((handled) => {
            if (handled || this.rfb !== rfb) return;
            this.syncLocalClipboard();
            rfb.sendPaste();
          }).catch((error) => this.filePanel?.report(error)).finally(() => { this.pastePending = false; });
        }
        return;
      }
      this.syncLocalClipboard();
    }
    if (!remoteFocused || event.key !== 'F12' || !event.ctrlKey || !event.altKey || !event.shiftKey || !this.onEscape?.()) return;
    this.rfb?.releaseKeys();
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  syncKeyboardFocus() {
    const visible = this.isActive() && this.target.getClientRects().length > 0;
    this.filePanel?.setVisible(visible);
    const focused = Boolean(this.connected && this.rfb && visible && document.hasFocus() &&
      (this.target === document.activeElement || this.target.contains(document.activeElement)));
    if (!focused && this.keyboardFocused) {
      this.rfb?.releaseKeys();
      for (const [code, keysym] of this.nativeKeys) this.rfb?.sendKey(keysym, code, false);
      this.nativeKeys.clear();
    }
    this.keyboardFocused = focused;
    window.deployerx?.setVncKeyboardFocus?.(focused);
  }

  syncLocalClipboard() {
    if (!this.rfb || typeof this.readClipboard !== 'function') return;
    let text;
    try { text = this.readClipboard(); } catch { return; }
    if (typeof text !== 'string') return;
    if (this.hasSyncedLocalClipboard && text === this.lastClipboardText) return;
    this.lastClipboardText = text;
    this.hasSyncedLocalClipboard = true;
    this.rfb.clipboardPasteFrom(text);
  }

  handlePaste(event) {
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!text || !this.rfb) return;
    if (this.hasSyncedLocalClipboard && text === this.lastClipboardText) return;
    this.lastClipboardText = text;
    this.hasSyncedLocalClipboard = true;
    this.rfb.clipboardPasteFrom(text);
  }

  handleMouseDown(event) {
    if (event.button === 2) this.syncLocalClipboard();
  }

  resize() {
    if (!this.rfb) return;
    const rfb = this.rfb;
    rfb.scaleViewport = false;
    rfb.scaleViewport = true;
    requestAnimationFrame(() => {
      if (this.rfb === rfb) rfb.refresh();
    });
  }

  updateDisplays() {
    const { width, height } = this.framebufferSize;
    const nextDisplays = resolveVncDisplays(this.screenLayout, width, height);
    const selectedStillExists = nextDisplays.some((display) => display.id === this.selectedDisplayId);
    if (nextDisplays.length && (!selectedStillExists || this.selectedDisplayId === 'all')) {
      this.selectedDisplayId = nextDisplays[0].id;
    }
    this.displays = nextDisplays;
    this.applyDisplaySelection();
    this.onDisplaysChanged?.(this.displays.map((display) => ({ ...display })), this.selectedDisplayId);
  }

  applyDisplaySelection() {
    if (!this.rfb) return;
    const display = this.displays.find((item) => item.id === this.selectedDisplayId);
    this.rfb.viewRegion = display || null;
  }

  selectDisplay(displayId = 'all') {
    const nextId = String(displayId);
    if (nextId !== 'all' && !this.displays.some((display) => display.id === nextId)) return false;
    this.selectedDisplayId = nextId;
    this.applyDisplaySelection();
    this.onDisplaysChanged?.(this.displays.map((display) => ({ ...display })), this.selectedDisplayId);
    this.focus();
    return true;
  }

  resetDisplays() {
    this.screenLayout = [];
    this.framebufferSize = { width: 0, height: 0 };
    this.displays = [];
    this.selectedDisplayId = 'all';
    this.onDisplaysChanged?.([], 'all');
  }

  focus() {
    if (this.rfb) this.rfb.focus({ preventScroll: true });
    else this.target.focus({ preventScroll: true });
  }

  removeInputListeners() {
    this.connected = false;
    this.filePanel?.dispose();
    this.filePanel = null;
    clearInterval(this.keyboardTimer);
    window.removeEventListener('focus', this.syncKeyboardFocus);
    window.removeEventListener('blur', this.syncKeyboardFocus);
    document.removeEventListener('focusin', this.syncKeyboardFocus);
    document.removeEventListener('focusout', this.syncKeyboardFocus);
    window.deployerx?.setVncKeyboardFocus?.(false);
    this.removeNativeKeyListener?.();
    this.removeNativeKeyListener = null;
    this.keyboardFocused = false;
    this.nativeKeys.clear();
    window.removeEventListener('keydown', this.handleKeyDown, true);
    this.target.removeEventListener('paste', this.handlePaste);
    this.target.removeEventListener('mousedown', this.handleMouseDown, true);
  }

  clearConnectionTimer() {
    clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
  }

  fail(message) {
    this.failureMessage = eventMessage({ detail: { message } }, 'VNC connection failed.');
    if (this.rfb) this.rfb.disconnect();
  }

  disconnect() {
    this.clearConnectionTimer();
    this.removeInputListeners();
    if (!this.rfb) return;
    this.manualDisconnect = true;
    const rfb = this.rfb;
    this.rfb = null;
    rfb.disconnect();
    this.target.replaceChildren();
    this.resetDisplays();
  }
}

export function createVncClient(options) {
  return new VncClient(options);
}
