import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMetres } from '../src/geo.js';
import { synthesizeLateReverb } from '../src/late-reverb.js';

const options = {
  sampleRate: 8000,
  durationSeconds: 2,
  source: { latitude: 60, longitude: 24 },
  listener: { latitude: 60, longitude: 24 },
  heading: 0,
  distanceMetres,
  reflectors: [
    { id: 'a', latitude: 60.0005, longitude: 24, levelDb: -6 },
    { id: 'b', latitude: 60, longitude: 24.0007, levelDb: -6 },
    { id: 'c', latitude: 59.9994, longitude: 24, levelDb: -8 }
  ]
};

test('geometry creates a non-empty stereo late response', () => {
  const [left, right] = synthesizeLateReverb(options);
  assert.ok(left.some(Boolean));
  assert.ok(right.some(Boolean));
});

test('the same geometry creates a deterministic response', () => {
  const first = synthesizeLateReverb(options);
  const second = synthesizeLateReverb(options);
  assert.deepEqual(first, second);
});

test('one surface does not invent a recursive tail', () => {
  const channels = synthesizeLateReverb({ ...options, reflectors: options.reflectors.slice(0, 1) });
  assert.equal(channels[0].some(Boolean), false);
});

const tailEnergy = (channels, startFrame) => channels.reduce((total, channel) =>
  total + channel.subarray(startFrame).reduce((sum, sample) => sum + sample * sample, 0), 0);

test('persistent point mode retains more recursive energy than geometric mode', () => {
  const geometric = synthesizeLateReverb({ ...options, diffuseEnergyRetention: .3 });
  const persistent = synthesizeLateReverb({ ...options, diffuseEnergyRetention: .8 });
  assert.ok(tailEnergy(persistent, options.sampleRate * .75) > tailEnergy(geometric, options.sampleRate * .75));
});
