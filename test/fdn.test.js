import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMetres } from '../src/geo.js';
import { createFdnConfiguration, createFdnInjections } from '../src/fdn.js';

const geometry = {
  sampleRate: 48000,
  source: { latitude: 60, longitude: 24 },
  listener: { latitude: 60.0001, longitude: 24 },
  reflectors: [
    { latitude: 60.0005, longitude: 24.0002 },
    { latitude: 59.9996, longitude: 24.0007 }
  ],
  distanceMetres
};

test('FDN produces eight bounded delay lines and feedback gains', () => {
  const configuration = createFdnConfiguration(geometry);
  assert.equal(configuration.delaySamples.length, 8);
  assert.equal(configuration.feedback.length, 8);
  assert.ok(configuration.delaySamples.every(value => Number.isInteger(value) && value > 1));
  assert.ok(configuration.feedback.every(value => value > 0 && value < 1));
});

test('geometry influence changes delay tuning', () => {
  const generic = createFdnConfiguration({ ...geometry, geometryInfluence: 0 });
  const geographic = createFdnConfiguration({ ...geometry, geometryInfluence: 1 });
  assert.notDeepEqual(generic.delaySamples, geographic.delaySamples);
});

test('a longer tail increases feedback', () => {
  const short = createFdnConfiguration({ ...geometry, tailSeconds: 2 });
  const long = createFdnConfiguration({ ...geometry, tailSeconds: 20 });
  assert.ok(long.feedback.every((value, index) => value > short.feedback[index]));
});

test('FDN excitation keeps each physical reflection arrival time', () => {
  const configuration = createFdnConfiguration(geometry);
  const injections = createFdnInjections([
    { frame: 2400, gain: .4, reflectorIds: ['a'], finalReflectorId: configuration.lineReflectorIds[0] },
    { frame: 3900, gain: .4, reflectorIds: ['a', 'b', 'a'], finalReflectorId: configuration.lineReflectorIds[0] }
  ], configuration);
  assert.deepEqual([...new Set(injections.map(injection => injection.frame))], [2400, 3900]);
  assert.ok(Math.abs(injections.at(-1).gain) > Math.abs(injections[0].gain));
});

test('building occlusion removes feedback between disconnected reflectors', () => {
  const reflectors = geometry.reflectors.map((reflector, index) => ({ ...reflector, id: String(index), visibleReflectorIds: [] }));
  const configuration = createFdnConfiguration({ ...geometry, reflectors, buildingOcclusion: true });
  configuration.feedbackMatrix.forEach((row, destination) => row.forEach((gain, source) => {
    if (configuration.lineReflectorIds[destination] !== configuration.lineReflectorIds[source]) assert.equal(gain, 0);
  }));
  assert.deepEqual(createFdnInjections([
    { frame: 100, gain: .5, reflectorIds: ['0'], finalReflectorId: '0' }
  ], configuration), []);
});
