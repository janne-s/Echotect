import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFloat32Wav, wavByteLength } from '../src/wav.js';

test('WAV declares stereo 48 kHz IEEE float32 without changing samples', () => {
  const wav = encodeFloat32Wav([new Float32Array([1.25, -2]), new Float32Array([.5, -.25])]);
  const view = new DataView(wav);
  assert.equal(wav.byteLength, wavByteLength(2));
  assert.equal(view.getUint16(20, true), 3);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 32);
  assert.equal(view.getFloat32(44, true), 1.25);
  assert.equal(view.getFloat32(52, true), -2);
});
