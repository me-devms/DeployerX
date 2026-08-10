import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVncDisplays } from './vnc-display-layout.mjs';

test('uses exact VNC screen geometry when multiple screens are advertised', () => {
  assert.deepEqual(resolveVncDisplays([
    { id: 7, x: 0, y: 0, width: 1920, height: 1080 },
    { id: 9, x: 1920, y: 0, width: 2560, height: 1440 }
  ], 4480, 1440), [
    { id: '7', x: 0, y: 0, width: 1920, height: 1080, label: 'Display 1', inferred: false },
    { id: '9', x: 1920, y: 0, width: 2560, height: 1440, label: 'Display 2', inferred: false }
  ]);
});

test('infers two equal displays from a combined wide framebuffer', () => {
  const displays = resolveVncDisplays([], 3840, 1080);
  assert.equal(displays.length, 2);
  assert.deepEqual(displays.map(({ x, width, height }) => ({ x, width, height })), [
    { x: 0, width: 1920, height: 1080 },
    { x: 1920, width: 1920, height: 1080 }
  ]);
});

test('does not offer display choices for a normal single-display framebuffer', () => {
  assert.deepEqual(resolveVncDisplays([], 1920, 1080), []);
  assert.deepEqual(resolveVncDisplays([{ id: 1, x: 0, y: 0, width: 1920, height: 1080 }], 1920, 1080), []);
  assert.deepEqual(resolveVncDisplays([{ id: 1, x: 0, y: 0, width: 3840, height: 1080 }], 3840, 1080), []);
});
