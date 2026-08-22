import test from 'node:test';
import assert from 'node:assert/strict';
import { directSoundMetrics, distanceMetres, hasDistinctDirectArrival, parseCoordinates, reflectionMetrics } from '../src/geo.js';

test('parses pasted decimal coordinates', () => {
  assert.deepEqual(parseCoordinates('60.1699, 24.9384'), { latitude: 60.1699, longitude: 24.9384 });
});

test('parses coordinates from a Google Maps style URL', () => {
  assert.deepEqual(parseCoordinates('https://maps.google.com/place/x/@60.1699,24.9384,15z'), { latitude: 60.1699, longitude: 24.9384 });
});

test('parses coordinates from an Apple Maps style query', () => {
  assert.deepEqual(parseCoordinates('https://maps.apple.com/?ll=60.1699,24.9384'), { latitude: 60.1699, longitude: 24.9384 });
});

test('rejects coordinates outside valid ranges', () => {
  assert.equal(parseCoordinates('160.1, 24.9'), null);
});

test('distance is zero for the same coordinate', () => {
  const point = { latitude: 60, longitude: 24 };
  assert.equal(distanceMetres(point, point), 0);
});

test('343 metre reflected path is approximately one second', () => {
  const source = { latitude: 0, longitude: 0 };
  const listener = { latitude: 0, longitude: 0 };
  const reflector = { latitude: 0, longitude: 0.00154245 };
  const metrics = reflectionMetrics(source, listener, reflector);
  assert.ok(Math.abs(metrics.pathMetres - 343) < 0.5);
  assert.ok(Math.abs(metrics.propagationSeconds - 1) < 0.002);
});

test('343 metre direct path arrives after approximately one second', () => {
  const source = { latitude: 0, longitude: 0 };
  const listener = { latitude: 0, longitude: 0.0030849 };
  const metrics = directSoundMetrics(source, listener);
  assert.ok(Math.abs(metrics.pathMetres - 343) < 0.5);
  assert.ok(Math.abs(metrics.propagationSeconds - 1) < 0.002);
});

test('co-located source and listener have no distinct direct arrival', () => {
  const point = { latitude: 60.1699, longitude: 24.9384 };
  assert.equal(hasDistinctDirectArrival(point, point), false);
});
