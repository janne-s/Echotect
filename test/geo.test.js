import test from 'node:test';
import assert from 'node:assert/strict';
import { directSoundMetrics, distanceMetres, hasDistinctDirectArrival, parseCoordinates, reflectionMetrics, soundSpeedMetresPerSecond } from '../src/geo.js';

test('parses pasted decimal coordinates', () => {
  assert.deepEqual(parseCoordinates('60.1699, 24.9384'), { latitude: 60.1699, longitude: 24.9384 });
});

test('parses coordinates from a Google Maps style URL', () => {
  assert.deepEqual(parseCoordinates('https://maps.google.com/place/x/@60.1699,24.9384,15z'), { latitude: 60.1699, longitude: 24.9384 });
});

test('parses coordinates from an Apple Maps style query', () => {
  assert.deepEqual(parseCoordinates('https://maps.apple.com/?ll=60.1699,24.9384'), { latitude: 60.1699, longitude: 24.9384 });
});

test('parses hemisphere coordinates with a decimal comma in either order', () => {
  const point = { latitude: 61.80228, longitude: 21.52714 };
  assert.deepEqual(parseCoordinates('61,80228° N, 21,52714° E'), point);
  assert.deepEqual(parseCoordinates('21,52714° E 61,80228° N'), point);
  assert.deepEqual(parseCoordinates('N 61.80228 E 21.52714'), point);
});

test('southern and western hemispheres are negative', () => {
  assert.deepEqual(parseCoordinates('61.80228° S, 21.52714° W'), { latitude: -61.80228, longitude: -21.52714 });
});

test('parses a decimal comma pair where the separator is unambiguous', () => {
  const point = { latitude: 60.1699, longitude: 24.9384 };
  assert.deepEqual(parseCoordinates('60,1699 24,9384'), point);
  assert.deepEqual(parseCoordinates('60,1699; 24,9384'), point);
  assert.deepEqual(parseCoordinates('60.1699°, 24.9384°'), point);
});

test('rejects coordinates outside valid ranges', () => {
  assert.equal(parseCoordinates('160.1, 24.9'), null);
  assert.equal(parseCoordinates('95° N, 21° E'), null);
});

test('a place name is not read as a coordinate', () => {
  assert.equal(parseCoordinates('Helsinki'), null);
  assert.equal(parseCoordinates('Suomenlinna, Helsinki'), null);
});

test('distance is zero for the same coordinate', () => {
  const point = { latitude: 60, longitude: 24 };
  assert.equal(distanceMetres(point, point), 0);
});

test('custom atmosphere temperature changes the speed of sound and propagation time', () => {
  const coldSpeed = soundSpeedMetresPerSecond({ airMode: 'custom', airTemperatureCelsius: 0, airHumidityPercent: 50 });
  const warmSpeed = soundSpeedMetresPerSecond({ airMode: 'custom', airTemperatureCelsius: 40, airHumidityPercent: 50 });
  assert.ok(warmSpeed > coldSpeed);
  const source = { latitude: 0, longitude: 0 };
  const listener = { latitude: 0, longitude: 0.003 };
  assert.ok(directSoundMetrics(source, listener, warmSpeed).propagationSeconds < directSoundMetrics(source, listener, coldSpeed).propagationSeconds);
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

test('in the map space, heights lift a path into a straight line through vertical reflectors', async () => {
  const { destinationPoint } = await import('../src/tect-receive.js');
  const { directSoundMetrics, distanceMetres, liftedElevationDegrees, reflectionPathMetrics } = await import('../src/geo.js');
  const listener = { latitude: 60.17, longitude: 24.94, heightMetres: 0 };
  const source = { ...destinationPoint(listener, 270, 400), heightMetres: 300 };
  assert.ok(Math.abs(directSoundMetrics(source, listener).pathMetres - 500) < 1e-6);
  assert.ok(Math.abs(directSoundMetrics({ ...source, heightMetres: 0 }, listener).pathMetres - 400) < 1e-6);
  assert.ok(Math.abs(liftedElevationDegrees(source, listener, 400) - Math.atan2(300, 400) * 180 / Math.PI) < 1e-9);
  // A wall 20 m north of the Listener: the path meets it 20 m along its 420 m, at 300 × 20/420 ≈ 14.3 m.
  const wall = { ...destinationPoint(listener, 0, 20), id: 'w' };
  const horizontal = distanceMetres(source, wall) + distanceMetres(wall, listener);
  const open = reflectionPathMetrics(source, listener, [wall]);
  assert.ok(Math.abs(open.pathMetres - Math.hypot(horizontal, 300)) < 1e-6);
  assert.equal(open.blocked, false);
  assert.equal(reflectionPathMetrics(source, listener, [{ ...wall, heightMetres: 20 }]).blocked, false);
  assert.equal(reflectionPathMetrics(source, listener, [{ ...wall, heightMetres: 10 }]).blocked, true);
  const flat = reflectionPathMetrics({ ...source, heightMetres: undefined }, listener, [{ ...wall, heightMetres: 1 }]);
  assert.ok(Math.abs(flat.pathMetres - horizontal) < 1e-6);
  assert.equal(flat.blocked, false);
  const other = (a, b) => distanceMetres(a, b);
  assert.ok(Math.abs(directSoundMetrics(source, listener, 343, other).pathMetres - 400) < 1e-6);
});
