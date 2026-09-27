import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTelephoto, rankCameras } from '../src/camera.js';

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

test('iPhone: telephoto chosen by name', () => {
  const rear = rankCameras([
    dev('triple', 'Back Triple Camera'),
    dev('uw', 'Back Ultra Wide Camera'),
    dev('front', 'Front Camera'),
    dev('wide', 'Back Camera'),
    dev('tele', 'Back Telephoto Camera'),
  ]);
  assert.equal(chooseTelephoto(rear), 'tele');
});

test('Android: telephoto recognised by its long minimum focus distance', () => {
  assert.equal(chooseTelephoto([
    { deviceId: 'main', label: 'camera2 0, facing back', minFocus: 0.1 },
    { deviceId: 'uw', label: 'camera2 2, facing back', minFocus: 0.03 },
    { deviceId: 'tele', label: 'camera2 3, facing back', minFocus: 0.8 },
  ]), 'tele');
});

test('no telephoto: main + ultra-wide or missing focus data gives null', () => {
  assert.equal(chooseTelephoto([
    { deviceId: 'main', label: 'camera2 0, facing back', minFocus: 0.1 },
    { deviceId: 'uw', label: 'camera2 2, facing back', minFocus: 0.03 },
  ]), null);
  assert.equal(chooseTelephoto([
    { deviceId: 'a', label: 'camera2 0, facing back' },
    { deviceId: 'b', label: 'camera2 2, facing back' },
  ]), null);
  assert.equal(chooseTelephoto([{ deviceId: 'wide', label: 'Back Camera' }]), null);
});
