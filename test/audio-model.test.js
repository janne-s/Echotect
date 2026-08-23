import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIBILITY_THRESHOLD_DB, buildReflectionPaths, gainToDecibels, reflectionPathGain } from '../src/audio-model.js';

test('one reflector produces exactly one reflected path', () => {
  const reflector = { id: 'r1', levelDb: -6 };
  assert.deepEqual(buildReflectionPaths([reflector]), [[reflector]]);
});

test('two reflectors interact without immediate self-reflection', () => {
  const r1 = { id: 'r1', levelDb: -6 };
  const r2 = { id: 'r2', levelDb: -6 };
  const paths = buildReflectionPaths([r1, r2]);
  assert.ok(paths.some(path => path.length >= 5));
  assert.ok(paths.every(path => path.every((reflector, index) => index === 0 || reflector.id !== path[index - 1].id)));
});

test('reflection paths stop when their reflector levels fall below -90 dB', () => {
  const r1 = { id: 'r1', levelDb: -12 };
  const r2 = { id: 'r2', levelDb: -12 };
  const paths = buildReflectionPaths([r1, r2]);
  assert.equal(Math.max(...paths.map(path => path.length)), 7);
});

test('each reflector attenuates the complete path', () => {
  const gain = reflectionPathGain(1, [{ levelDb: -6 }, { levelDb: -6 }]);
  assert.ok(Math.abs(gainToDecibels(gain) - -12) < 0.001);
  assert.ok(gainToDecibels(reflectionPathGain(1, Array.from({ length: 16 }, (_, index) => ({ id: String(index), levelDb: -6 })))) < AUDIBILITY_THRESHOLD_DB);
});
