import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { console };
const { default: Display } = await import('./vendor/novnc/core/display.js');
delete globalThis.window;

test('disposes decoded and pending video frames when the display closes', () => {
  let closeCount = 0;
  let flushResolved = false;
  const pendingFrame = { ready: false, keep: true };
  const display = {
    _renderQ: [
      {
        type: 'frame',
        frame: {
          ready: true,
          frame: { close: () => { closeCount += 1; } }
        }
      },
      { type: 'frame', frame: pendingFrame },
      { type: 'fill' }
    ],
    _flushPromise: Promise.resolve(),
    _flushResolve: () => { flushResolved = true; }
  };

  Display.prototype.dispose.call(display);

  assert.equal(closeCount, 1);
  assert.equal(pendingFrame.keep, false);
  assert.deepEqual(display._renderQ, []);
  assert.equal(flushResolved, true);
  assert.equal(display._flushPromise, null);
  assert.equal(display._flushResolve, null);
});

test('refreshes the full visible VNC viewport from the retained framebuffer', () => {
  const calls = [];
  const display = {
    _viewportLoc: { x: 120, y: 40, w: 1920, h: 1080 },
    _damage: (...args) => calls.push(['damage', ...args]),
    flip: () => calls.push(['flip'])
  };

  Display.prototype.refresh.call(display);

  assert.deepEqual(calls, [
    ['damage', 120, 40, 1920, 1080],
    ['flip']
  ]);
});
