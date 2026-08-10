import RFB from './vendor/novnc/core/rfb.js';
import { resolveVncDisplays } from './vnc-display-layout.mjs';

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
  constructor({ target, readClipboard, writeClipboard, onConnected, onEnded, onEscape, onDisplaysChanged }) {
    this.target = target;
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
  }

  async connect({ proxyUrl, username = '', password = '' }) {
    this.disconnect();
    this.manualDisconnect = false;
    this.failureMessage = '';
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
        this.writeClipboard?.(event.detail?.text || '');
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
    this.target.addEventListener('paste', this.handlePaste);
    this.connectionTimer = setTimeout(() => {
      this.fail('The VNC handshake timed out. Verify this port is running TightVNC Server and that its authentication mode is enabled.');
    }, VNC_HANDSHAKE_TIMEOUT_MS);
    requestAnimationFrame(() => rfb.focus({ preventScroll: true }));
  }

  handleKeyDown(event) {
    if (event.key !== 'Escape' || !this.onEscape?.()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  handlePaste(event) {
    const text = event.clipboardData?.getData('text/plain') || '';
    if (text && this.rfb) this.rfb.clipboardPasteFrom(text);
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
    if (this.selectedDisplayId !== 'all' && !selectedStillExists) this.selectedDisplayId = 'all';
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
    window.removeEventListener('keydown', this.handleKeyDown, true);
    this.target.removeEventListener('paste', this.handlePaste);
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
