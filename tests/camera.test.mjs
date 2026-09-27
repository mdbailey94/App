import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCameras } from '../src/camera.js';

const ids = (list) => list.map((d) => d.deviceId);

test('Android: main rear sensor first, front camera excluded', () => {
  const ranked = rankCameras([
    { deviceId: 'f', label: 'camera2 1, facing front' },
    { deviceId: 'uw', label: 'camera2 2, facing back' },
    { deviceId: 'main', label: 'camera2 0, facing back' },
    { deviceId: 'tele', label: 'camera2 3, facing back' },
  ]);
  assert.deepEqual(ids(ranked), ['main', 'uw', 'tele']);
});

test('iPhone: plain wide lens beats ultra wide, telephoto and virtual multi-cams', () => {
  const ranked = rankCameras([
    { deviceId: 'triple', label: 'Back Triple Camera' },
    { deviceId: 'uw', label: 'Back Ultra Wide Camera' },
    { deviceId: 'front', label: 'Front Camera' },
    { deviceId: 'wide', label: 'Back Camera' },
    { deviceId: 'tele', label: 'Back Telephoto Camera' },
  ]);
  assert.equal(ranked[0].deviceId, 'wide');
  assert.ok(!ids(ranked).includes('front'));
});

test('unlabelled cameras are kept in their original order', () => {
  assert.deepEqual(ids(rankCameras([{ deviceId: 'a', label: '' }, { deviceId: 'b', label: '' }])), ['a', 'b']);
});
