import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMetres } from '../src/geo.js';
import { readHandoff } from '../src/handoff.js';
import { bearingDegrees, destinationPoint, handoffAirMetres, handoffPlacement, packagedHandoffs } from '../src/tect-receive.js';
import { unzipStored, zipStore } from '../src/zip.js';

const handoff = (change = {}) => readHandoff({
  format: 'tect.handoff',
  name: 'Mic 1',
  place: { name: 'Koli', latitudeDegrees: 63.0964, longitudeDegrees: 29.8061 },
  listener: { positionMetres: { east: 400, north: 0 }, heightAboveGroundMetres: 1.7 },
  arrival: { azimuthDegrees: 270, elevationDegrees: 0, distanceMetres: 400 },
  audio: { sampleRateHz: 48000, channels: 1, fullScalePa: 20, file: 'mic-1.wav' },
  content: { includes: ['direct', 'air-absorption'], excludes: ['terrain-echoes'] },
  ...change
});
const current = { source: { latitude: 60.16955, longitude: 24.9369 }, listener: { latitude: 60.1707, longitude: 24.941 } };

test('a destination point lies at its distance and bearing (tolerance 1 mm, 1e-6°)', () => {
  const start = { latitude: 63.0964, longitude: 29.8061 };
  for (const [bearing, metres] of [[0, 1000], [90, 400], [225, 7888], [359, 12]]) {
    const end = destinationPoint(start, bearing, metres);
    assert.ok(Math.abs(distanceMetres(start, end) - metres) < 1e-3);
    assert.ok(Math.abs(((bearingDegrees(start, end) - bearing + 540) % 360) - 180) < 1e-6);
  }
});

test('with a place, the Listener goes where the sound was heard and the Source the way it came from', () => {
  const placed = handoffPlacement(handoff(), current);
  const place = { latitude: 63.0964, longitude: 29.8061 };
  assert.ok(Math.abs(distanceMetres(place, placed.listener) - 400) < 1e-3);
  assert.ok(Math.abs(bearingDegrees(place, placed.listener) - 90) < 1e-6);
  // The Source is 400 m west of the Listener: back at the place, where the blast was, within the
  // 5 cm a great circle's turning bearing makes at 63° north over 400 m.
  assert.ok(distanceMetres(place, placed.source) < .1);
  assert.equal(placed.listenerHeightMetres, 1.7);
  assert.equal(placed.moved, true);
});

test('the Source lies at the distance along the ground, shortened by the elevation', () => {
  const placed = handoffPlacement(handoff({ arrival: { azimuthDegrees: 0, elevationDegrees: 60, distanceMetres: 1000 } }), current);
  assert.ok(Math.abs(distanceMetres(placed.listener, placed.source) - 500) < 1e-3);
});

test('without a place the Listener stays, and without an arrival the Source keeps its bearing and distance', () => {
  const unplaced = handoffPlacement(handoff({ place: null }), current);
  assert.deepEqual(unplaced.listener, current.listener);
  assert.ok(Math.abs(bearingDegrees(current.listener, unplaced.source) - 270) < 1e-6);
  assert.equal(unplaced.moved, false);
  const still = handoffPlacement(handoff({ place: null, arrival: null }), current);
  assert.ok(Math.abs(distanceMetres(still.listener, still.source) - distanceMetres(current.listener, current.source)) < 1e-3);
  assert.ok(Math.abs(bearingDegrees(still.listener, still.source) - bearingDegrees(current.listener, current.source)) < 1e-6);
});

test('the air in the sound is its distance only when the sound says it holds the air', () => {
  assert.equal(handoffAirMetres(handoff()), 400);
  assert.equal(handoffAirMetres(handoff({ content: { includes: ['direct'] } })), 0);
  assert.equal(handoffAirMetres(handoff({ arrival: null })), 0);
});

test('a package gives every handoff with its sound, passing over other files', () => {
  const encode = value => new TextEncoder().encode(JSON.stringify(value));
  const files = unzipStored(zipStore([
    { name: 'scene.json', data: encode({ format: 'boomtect.scene' }) },
    { name: 'mic-1.json', data: encode(handoff()) },
    { name: 'mic-1.wav', data: new Uint8Array([1, 2, 3]) },
    { name: 'mic-2.json', data: encode(handoff({ audio: { sampleRateHz: 48000, channels: 1, fullScalePa: 20, file: 'missing.wav' } })) },
    { name: 'broken.json', data: new TextEncoder().encode('{') }
  ]));
  const found = packagedHandoffs(files);
  assert.equal(found.length, 1);
  assert.equal(found[0].handoff.name, 'Mic 1');
  assert.deepEqual([...found[0].wav], [1, 2, 3]);
});

test('a stored archive reads back exactly, and a damaged one is refused', () => {
  const files = [{ name: 'a.txt', data: new Uint8Array([7, 8]) }, { name: 'b/c.wav', data: new Uint8Array(1000).fill(3) }];
  const archive = zipStore(files);
  assert.deepEqual(unzipStored(archive).map(file => [file.name, [...file.data]]), files.map(file => [file.name, [...file.data]]));
  const damaged = archive.slice();
  damaged[40] ^= 0xff;
  assert.throws(() => unzipStored(damaged), /checksum|damaged/);
  assert.throws(() => unzipStored(new Uint8Array(10)), /not a ZIP/);
});

test('the Source stands as high above the Listener as the elevation of the arrival makes it', () => {
  const placed = handoffPlacement(handoff({ arrival: { azimuthDegrees: 270, elevationDegrees: 30, distanceMetres: 1000 } }), current);
  assert.equal(placed.listenerHeightMetres, 1.7);
  assert.ok(Math.abs(placed.sourceHeightMetres - (1.7 + 500)) < 1e-9);
  const kept = handoffPlacement(handoff({ place: null, arrival: null }), { ...current, heightsMetres: { source: 40, listener: 3 } });
  assert.deepEqual([kept.listenerHeightMetres, kept.sourceHeightMetres], [3, 40]);
  const unplaced = handoffPlacement(handoff({ place: null, arrival: { azimuthDegrees: 0, elevationDegrees: 90, distanceMetres: 200 } }), { ...current, heightsMetres: { source: 40, listener: 3 } });
  assert.ok(Math.abs(unplaced.sourceHeightMetres - 203) < 1e-9);
});

test('the handoff moves only what its placement lets it, and nothing keeps a scene as it is', () => {
  const heights = { source: 40, listener: 3 };
  const sourceOnly = handoffPlacement(handoff({ placement: 'source' }), { ...current, heightsMetres: heights });
  assert.deepEqual(sourceOnly.listener, current.listener);
  assert.equal(sourceOnly.listenerHeightMetres, 3);
  assert.ok(Math.abs(bearingDegrees(current.listener, sourceOnly.source) - 270) < 1e-6);
  assert.equal(sourceOnly.moved, false);
  const none = handoffPlacement(handoff({ placement: 'none' }), { ...current, heightsMetres: heights });
  assert.deepEqual([none.listener, none.source], [current.listener, current.source]);
  assert.deepEqual([none.listenerHeightMetres, none.sourceHeightMetres], [3, 40]);
  assert.equal(none.moved, false);
});
