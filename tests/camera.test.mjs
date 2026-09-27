import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameStats, looksCovered, pickCoveredCamera, rankCameras } from '../src/camera.js';

// Mimic MediaDeviceInfo, which keeps its fields as prototype getters.
class FakeDevice {
  #id; #label;
  constructor(deviceId, label) { this.#id = deviceId; this.#label = label; }
  get deviceId() { return this.#id; }
  get label() { return this.#label; }
}
const dev = (id, label) => new FakeDevice(id, label);
const ids = (list) => list.map((d) => d.deviceId);

test('rankCameras keeps ids and labels of real MediaDeviceInfo objects', () => {
  const [first] = rankCameras([dev('main', 'camera2 0, facing back')]);
  assert.deepEqual(first, { deviceId: 'main', label: 'camera2 0, facing back', score: 10 });
});

test('Android: main rear sensor first, front camera excluded', () => {
  const ranked = rankCameras([
    dev('f', 'camera2 1, facing front'),
    dev('uw', 'camera2 2, facing back'),
    dev('main', 'camera2 0, facing back'),
    dev('tele', 'camera2 3, facing back'),
  ]);
  assert.deepEqual(ids(ranked), ['main', 'uw', 'tele']);
});

// 40×40 RGBA frames.
function frame(fn) {
  const px = new Uint8ClampedArray(40 * 40 * 4);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const [r, g, b] = fn(x, y);
    px.set([r, g, b, 255], (y * 40 + x) * 4);
  }
  return px;
}
// A room: bright window, dark furniture, edges.
const room = frameStats(frame((x, y) => (x < 15 ? [220, 225, 230] : y > 25 ? [40, 35, 30] : [120, 110, 90])));
// Fingertip lit by the flash: red glow, brighter in the middle.
const litFinger = frameStats(frame((x, y) => {
  const d = Math.hypot(x - 20, y - 20);
  return [230 - d * 1.2, 40, 30];
}));
// Fingertip with no light behind it: nearly black.
const darkFinger = frameStats(frame(() => [12, 4, 4]));
// A dim bedroom before the lights are on.
const darkRoom = frameStats(frame((x, y) => (x < 20 ? [22, 22, 24] : [8, 8, 9])));

test('looksCovered: fingertip vs room', () => {
  assert.equal(looksCovered(litFinger), true);
  assert.equal(looksCovered(darkFinger), true);
  assert.equal(looksCovered(room), false);
});

test('pickCoveredCamera finds the lens under the finger', () => {
  assert.equal(pickCoveredCamera([
    { deviceId: 'main', stats: room },
    { deviceId: 'uw', stats: room },
    { deviceId: 'tele', stats: litFinger },
  ]), 'tele');
  // Unlit covered lens (flashlight belongs to another camera) still found.
  assert.equal(pickCoveredCamera([
    { deviceId: 'main', stats: room },
    { deviceId: 'tele', stats: darkFinger },
  ]), 'tele');
});

test('pickCoveredCamera refuses to guess when nothing or everything looks covered', () => {
  assert.equal(pickCoveredCamera([{ deviceId: 'a', stats: room }, { deviceId: 'b', stats: room }]), null);
  assert.equal(pickCoveredCamera([{ deviceId: 'a', stats: darkRoom }, { deviceId: 'b', stats: darkFinger }]), null);
  // In a dark room the flash-lit fingertip still stands out.
  assert.equal(pickCoveredCamera([{ deviceId: 'a', stats: darkRoom }, { deviceId: 'b', stats: litFinger }]), 'b');
});

test('front filter does not trip on unrelated words in a label', () => {
  assert.deepEqual(ids(rankCameras([dev('a', '/home/user/cam.y4m'), dev('f', 'Front Camera'), dev('s', 'camera2 1, facing front')])), ['a']);
});
