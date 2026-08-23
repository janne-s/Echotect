import test from 'node:test';
import assert from 'node:assert/strict';
import { arrivalAzimuthDegrees, hrtfPosition } from '../src/spatial.js';

const listener = { latitude: 0, longitude: 0 };

test('north is the forward HRTF direction', () => {
  const position = hrtfPosition(listener, { latitude: 1, longitude: 0 });
  assert.ok(Math.abs(position.x) < 0.000001);
  assert.ok(Math.abs(position.z + 1) < 0.000001);
  assert.ok(Math.abs(arrivalAzimuthDegrees(listener, { latitude: 1, longitude: 0 })) < 0.000001);
});

test('east is heard from the right at 90 degrees', () => {
  const position = hrtfPosition(listener, { latitude: 0, longitude: 1 });
  assert.ok(Math.abs(position.x - 1) < 0.000001);
  assert.ok(Math.abs(position.z) < 0.000001);
  assert.ok(Math.abs(arrivalAzimuthDegrees(listener, { latitude: 0, longitude: 1 }) - 90) < 0.000001);
});

test('west is heard from the left at 270 degrees', () => {
  assert.ok(Math.abs(arrivalAzimuthDegrees(listener, { latitude: 0, longitude: -1 }) - 270) < 0.000001);
});

test('listener heading rotates the HRTF field', () => {
  const facingEast = 90;
  const east = hrtfPosition(listener, { latitude: 0, longitude: 1 }, facingEast);
  const north = hrtfPosition(listener, { latitude: 1, longitude: 0 }, facingEast);
  assert.ok(Math.abs(east.x) < 0.000001);
  assert.ok(Math.abs(east.z + 1) < 0.000001);
  assert.ok(Math.abs(north.x + 1) < 0.000001);
});

test('co-located sound has no artificial HRTF direction', () => {
  assert.equal(hrtfPosition(listener, listener, 135), null);
});
