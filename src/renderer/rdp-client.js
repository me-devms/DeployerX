import initIronRdp, {
  ClipboardData,
  DesktopSize,
  DeviceEvent,
  Extension,
  InputTransaction,
  RotationUnit,
  SessionBuilder,
  setup
} from '../../node_modules/ironrdp-wasm/pkg/rdp_client.js';

// Keyboard mapping follows the MIT-licensed IronRDP WASM browser example.
const SCANCODES = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c,
  Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12,
  KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18,
  KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f,
  KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35,
  ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47,
  Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c,
  Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, F11: 0x57, F12: 0x58, NumpadEnter: 0xe01c,
  ControlRight: 0xe01d, NumpadDivide: 0xe035, PrintScreen: 0xe037, AltRight: 0xe038,
  Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b, ArrowRight: 0xe04d,
  End: 0xe04f, ArrowDown: 0xe050, PageDown: 0xe051, Insert: 0xe052, Delete: 0xe053,
  MetaLeft: 0xe05b, MetaRight: 0xe05c, ContextMenu: 0xe05d, Pause: 0xe11d45
};

let initializePromise;

async function initializeIronRdp(loadWasm) {
  if (!initializePromise) {
    initializePromise = (async () => {
      const wasm = await loadWasm();
      const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
      await initIronRdp({ module_or_path: bytes });
      setup('warn');
    })().catch((error) => {
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

function plainMessage(value, seen = new Set()) {
  if (typeof value === 'string') return value.replace(/^Error:\s*/i, '').trim();
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  for (const key of ['message', 'reason', 'description', 'detail', 'error', 'cause']) {
    const text = plainMessage(value[key], seen);
    if (text) return text;
  }
  try {
    const text = String(value).replace(/^Error:\s*/i, '').trim();
    if (text && text !== '[object Object]') return text;
  } catch {}
  return '';
}

function errorMessage(error) {
  const ironError = [error, error?.message, error?.cause, error?.error]
    .find((value) => value && typeof value === 'object' && typeof value.kind === 'function');
  try {
    const kind = ironError?.kind?.();
    if (kind === 1) return 'The Windows password is incorrect.';
    if (kind === 2) return 'Windows rejected the username or password.';
    if (kind === 3) return 'This account is not allowed to use Remote Desktop.';
    if (kind === 4) {
      const details = ironError.rdcleanpathDetails?.();
      const suffix = [
        details?.httpStatusCode ? `HTTP ${details.httpStatusCode}` : '',
        details?.wsaErrorCode ? `socket error ${details.wsaErrorCode}` : '',
        details?.tlsAlertCode ? `TLS alert ${details.tlsAlertCode}` : ''
      ].filter(Boolean).join(', ');
      return `The Remote Desktop proxy handshake failed${suffix ? ` (${suffix})` : ''}.`;
    }
    if (kind === 5) return 'Could not connect to the local RDP transport.';
    if (kind === 6) return 'The server and client could not negotiate an RDP connection.';
    if (kind === 0) {
      const detail = plainMessage(ironError.backtrace?.());
      if (detail) return detail;
    }
  } catch {}
  const text = plainMessage(error);
  if (text) return text;
  return 'Remote Desktop connection failed.';
}

function canvasSize(canvas) {
  const rect = canvas.parentElement?.getBoundingClientRect() || canvas.getBoundingClientRect();
  return {
    width: Math.max(640, Math.round(rect.width || 1280)),
    height: Math.max(480, Math.round(rect.height || 720))
  };
}

function textFromClipboardData(clipboardData) {
  if (!clipboardData || clipboardData.isEmpty()) return '';
  const items = clipboardData.items();
  const item = items.find((entry) => /text\/(plain|unicode)|utf-?8|text/i.test(entry.mimeType())) || items[0];
  if (!item) return '';
  const value = item.value();
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value).replace(/\0+$/g, '');
  return String(value ?? '');
}

class IronRdpCanvasClient {
  constructor({ canvas, loadWasm, readClipboard, writeClipboard, onSessionReady, onConnected, onEnded, onEscape }) {
    this.canvas = canvas;
    this.loadWasm = loadWasm;
    this.readClipboard = readClipboard;
    this.writeClipboard = writeClipboard;
    this.onSessionReady = onSessionReady;
    this.onConnected = onConnected;
    this.onEnded = onEnded;
    this.onEscape = onEscape;
    this.session = null;
    this.inputCleanup = null;
    this.renderCleanup = null;
    this.firstFrameTimer = 0;
    this.frameSettleTimer = 0;
    this.frameTiles = new Set();
    this.connectedNotified = false;
    this.ended = false;
    this.lastRequestedSize = '';
  }

  notifyConnected() {
    if (this.ended || this.connectedNotified) return;
    this.connectedNotified = true;
    clearTimeout(this.firstFrameTimer);
    clearTimeout(this.frameSettleTimer);
    this.firstFrameTimer = 0;
    this.frameSettleTimer = 0;
    requestAnimationFrame(() => {
      if (!this.ended) this.onConnected?.();
    });
  }

  resetFrameCoverage() {
    clearTimeout(this.frameSettleTimer);
    this.frameSettleTimer = 0;
    this.frameTiles.clear();
  }

  setCanvasSize(width, height) {
    const nextWidth = Math.round(Number(width));
    const nextHeight = Math.round(Number(height));
    if (!(nextWidth > 0) || !(nextHeight > 0)) return;
    if (this.canvas.width === nextWidth && this.canvas.height === nextHeight) return;
    this.resetFrameCoverage();
    if (this.canvas.width !== nextWidth) this.canvas.width = nextWidth;
    if (this.canvas.height !== nextHeight) this.canvas.height = nextHeight;
  }

  recordFrameUpdate(args) {
    if (this.connectedNotified) return;
    const imageData = args[0];
    let x = Number(args[1]) || 0;
    let y = Number(args[2]) || 0;
    let width = Number(imageData?.width) || 0;
    let height = Number(imageData?.height) || 0;
    if (args.length >= 7) {
      x += Number(args[3]) || 0;
      y += Number(args[4]) || 0;
      width = Number(args[5]) || 0;
      height = Number(args[6]) || 0;
    }
    if (width < 0) { x += width; width = Math.abs(width); }
    if (height < 0) { y += height; height = Math.abs(height); }

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(canvasWidth, x + width);
    const bottom = Math.min(canvasHeight, y + height);
    if (!(right > left) || !(bottom > top)) return;

    const columns = 12;
    const rows = 8;
    const firstColumn = Math.floor(left * columns / canvasWidth);
    const lastColumn = Math.min(columns - 1, Math.ceil(right * columns / canvasWidth) - 1);
    const firstRow = Math.floor(top * rows / canvasHeight);
    const lastRow = Math.min(rows - 1, Math.ceil(bottom * rows / canvasHeight) - 1);
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        this.frameTiles.add(row * columns + column);
      }
    }

    const coverage = this.frameTiles.size / (columns * rows);
    if (coverage >= 0.85) {
      this.notifyConnected();
      return;
    }
    if (coverage >= 0.55) {
      clearTimeout(this.frameSettleTimer);
      this.frameSettleTimer = setTimeout(() => this.notifyConnected(), 250);
    }
  }

  observeFirstFrame(context) {
    const originalPutImageData = context?.putImageData;
    if (typeof originalPutImageData !== 'function') return;
    const client = this;
    const observedPutImageData = function (...args) {
      const result = originalPutImageData.apply(this, args);
      client.recordFrameUpdate(args);
      return result;
    };
    try {
      context.putImageData = observedPutImageData;
      if (context.putImageData !== observedPutImageData) return;
      this.renderCleanup = () => {
        if (context.putImageData === observedPutImageData) context.putImageData = originalPutImageData;
      };
    } catch {}
  }

  sendInput(deviceEvent) {
    if (!this.session) return;
    const transaction = new InputTransaction();
    transaction.addEvent(deviceEvent);
    this.session.applyInputs(transaction);
  }

  async syncLocalClipboard() {
    if (!this.session) return;
    try {
      const text = await this.readClipboard();
      const clipboard = new ClipboardData();
      if (text) clipboard.addText('text/plain', text);
      await this.session.onClipboardPaste(clipboard);
    } catch {}
  }

  attachInput() {
    const canvas = this.canvas;
    const listeners = [];
    let mouseFrame = 0;
    let pendingMousePosition = null;
    let lastMousePosition = '';
    let interceptedEscape = false;
    const flushMouseMove = () => {
      mouseFrame = 0;
      if (!this.session || !pendingMousePosition) return;
      const { x, y } = pendingMousePosition;
      pendingMousePosition = null;
      const position = `${x}:${y}`;
      if (position === lastMousePosition) return;
      lastMousePosition = position;
      this.sendInput(DeviceEvent.mouseMove(x, y));
    };
    const listen = (type, handler, options) => {
      canvas.addEventListener(type, handler, options);
      listeners.push(() => canvas.removeEventListener(type, handler, options));
    };
    listen('keydown', (event) => {
      if (event.code === 'Escape' && (interceptedEscape || this.onEscape?.())) {
        interceptedEscape = true;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') this.syncLocalClipboard();
      const scancode = SCANCODES[event.code];
      if (scancode !== undefined) this.sendInput(DeviceEvent.keyPressed(scancode));
    });
    listen('keyup', (event) => {
      if (event.code === 'Escape' && interceptedEscape) {
        interceptedEscape = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const scancode = SCANCODES[event.code];
      if (scancode !== undefined) this.sendInput(DeviceEvent.keyReleased(scancode));
    });
    listen('mousemove', (event) => {
      if (!this.session) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / rect.width)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / rect.height)));
      pendingMousePosition = { x, y };
      if (!mouseFrame) mouseFrame = requestAnimationFrame(flushMouseMove);
    });
    listen('mousedown', (event) => {
      event.preventDefault();
      canvas.focus();
      flushMouseMove();
      this.sendInput(DeviceEvent.mouseButtonPressed(event.button));
    });
    listen('mouseup', (event) => {
      event.preventDefault();
      this.sendInput(DeviceEvent.mouseButtonReleased(event.button));
    });
    listen('wheel', (event) => {
      event.preventDefault();
      if (event.deltaY) this.sendInput(DeviceEvent.wheelRotations(true, event.deltaY > 0 ? -1 : 1, RotationUnit.Line));
      if (event.deltaX) this.sendInput(DeviceEvent.wheelRotations(false, event.deltaX > 0 ? -1 : 1, RotationUnit.Line));
    }, { passive: false });
    listen('contextmenu', (event) => event.preventDefault());
    listen('blur', () => {
      try { this.session?.releaseAllInputs(); } catch {}
    });
    this.inputCleanup = () => {
      if (mouseFrame) cancelAnimationFrame(mouseFrame);
      listeners.splice(0).forEach((remove) => remove());
    };
  }

  async connect({ destination, username, password, domain, proxyUrl }) {
    await initializeIronRdp(this.loadWasm);
    const initialSize = canvasSize(this.canvas);
    const builder = new SessionBuilder();
    builder.username(username);
    builder.password(password);
    builder.destination(destination);
    builder.proxyAddress(proxyUrl);
    builder.authToken('none');
    builder.desktopSize(new DesktopSize(initialSize.width, initialSize.height));
    const context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.observeFirstFrame(context);
    builder.renderCanvas(this.canvas);
    builder.extension(new Extension('enable_credssp', true));
    builder.extension(new Extension('display_control', true));
    if (domain) builder.serverDomain(domain);
    builder.setCursorStyleCallbackContext(this.canvas);
    builder.setCursorStyleCallback((style) => { this.canvas.style.cursor = style || 'default'; });
    builder.canvasResizedCallback((width, height) => {
      this.setCanvasSize(width, height);
    });
    builder.remoteClipboardChangedCallback((clipboardData) => {
      const text = textFromClipboardData(clipboardData);
      if (text) this.writeClipboard(text);
    });
    builder.forceClipboardUpdateCallback(() => this.syncLocalClipboard());

    try {
      this.session = await builder.connect();
      const desktop = this.session.desktopSize();
      this.setCanvasSize(desktop.width, desktop.height);
      this.lastRequestedSize = `${desktop.width}:${desktop.height}`;
      this.attachInput();
      this.canvas.focus();
      if (!this.connectedNotified) this.onSessionReady?.();
      this.session.run()
        .then((info) => this.end(errorMessage(info?.reason?.() || 'Remote Desktop session ended.')))
        .catch((error) => this.end(errorMessage(error)));
      if (!this.connectedNotified) this.firstFrameTimer = setTimeout(() => this.notifyConnected(), 3500);
      return { width: desktop.width, height: desktop.height };
    } catch (error) {
      this.end(errorMessage(error));
      throw new Error(errorMessage(error));
    }
  }

  resize() {
    if (!this.session) return;
    const size = canvasSize(this.canvas);
    const requestedSize = `${size.width}:${size.height}`;
    if (requestedSize === this.lastRequestedSize) return;
    this.lastRequestedSize = requestedSize;
    const scaleFactor = Math.max(100, Math.min(500, Math.round((window.devicePixelRatio || 1) * 100)));
    try { this.session.resize(size.width, size.height, scaleFactor); } catch {}
  }

  disconnect() {
    try { this.session?.shutdown(); } catch {}
    this.end('Not connected');
  }

  end(message) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.firstFrameTimer);
    clearTimeout(this.frameSettleTimer);
    this.firstFrameTimer = 0;
    this.frameSettleTimer = 0;
    this.inputCleanup?.();
    this.inputCleanup = null;
    this.renderCleanup?.();
    this.renderCleanup = null;
    this.session = null;
    this.onEnded?.(message);
  }
}

export function createIronRdpClient(options) {
  return new IronRdpCanvasClient(options);
}

export function prepareIronRdpClient(loadWasm) {
  return initializeIronRdp(loadWasm);
}

export { errorMessage };
