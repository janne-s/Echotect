import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarlyArrivalEvents } from '../src/arrivals.js';
import { convolveFft, renderExportAudio } from '../src/offline-export.js';
import { distanceMetres } from '../src/geo.js';

test('rendered stems are aligned and direct arrival plus early plus late sums to wet', async () => {
  const audio = await renderExportAudio({
    sampleRate: 1000, source: { latitude: 60, longitude: 24 }, listener: { latitude: 60, longitude: 24 }, heading: 0, distanceMetres,
    reflectors: [{ id: 'a', latitude: 60.0001, longitude: 24, levelDb: -6 }, { id: 'b', latitude: 60, longitude: 24.0001, levelDb: -7 }],
    inputMono: new Float32Array([1, .5]), settings: { durationSeconds: .5, fdnTailSeconds: .4, lateMode: 'convolution', pointMode: 'persistent', pointPersistence: .65, pointMaxBounces: 2, pointPathLimit: 32, maxBounces: 2, cutoffDb: -90, lateWalks: 16, tailPersistence: .6, fdnDensity: .7, fdnDamping: .55, geometryInfluence: .7 }
  });
  assert.equal(audio.direct[0].length, audio.early[0].length);
  assert.equal(audio.early[0].length, audio.late[0].length);
  for (let channel = 0; channel < 2; channel += 1) for (let frame = 0; frame < audio.wet[channel].length; frame += 1) {
    assert.ok(Math.abs(audio.wet[channel][frame] - (audio.directArrival[channel][frame] + audio.early[channel][frame] + audio.late[channel][frame])) < 1e-7);
  }
  assert.ok(audio.direct[0].some(Boolean));
  assert.ok(audio.early[0].some(Boolean));
  assert.ok(audio.fdnIr[0].some(Boolean));
});

test('FFT fallback preserves a delayed stereo late response', () => {
  const result = convolveFft(new Float32Array([1, .5]), [new Float32Array([0, 0, .25]), new Float32Array([0, -.5, 0])], 4);
  assert.deepEqual([...result[0]], [0, 0, .25, .125]);
  assert.deepEqual([...result[1]], [0, -.5, -.25, 0]);
});

test('co-located direct arrival starts at sample zero without a separate trigger', async () => {
  const audio = await renderExportAudio({
    sampleRate: 1000, source: { latitude: 60, longitude: 24 }, listener: { latitude: 60, longitude: 24 }, heading: 0, distanceMetres,
    reflectors: [], inputMono: new Float32Array([1]),
    settings: { durationSeconds: .01, fdnTailSeconds: .01, lateMode: 'convolution', pointMode: 'persistent', pointPersistence: .65, pointMaxBounces: 2, pointPathLimit: 32, maxBounces: 2, cutoffDb: -90, lateWalks: 1, tailPersistence: .6, fdnDensity: .7, fdnDamping: .55, geometryInfluence: .7 }
  });
  assert.ok(Math.abs(audio.direct[0][0] - .8 * Math.SQRT1_2) < 1e-7);
  assert.equal(audio.direct[0].filter(Boolean).length, 1);
});

test('distinct direct stem contains trigger and propagated arrival while wet excludes trigger', async () => {
  const audio = await renderExportAudio({
    sampleRate: 1000, source: { latitude: 60, longitude: 24 }, listener: { latitude: 60.001, longitude: 24 }, heading: 0, distanceMetres,
    reflectors: [], inputMono: new Float32Array([1]),
    settings: { durationSeconds: .5, fdnTailSeconds: .5, lateMode: 'convolution', pointMode: 'persistent', pointPersistence: .65, pointMaxBounces: 2, pointPathLimit: 32, maxBounces: 2, cutoffDb: -90, lateWalks: 1, tailPersistence: .6, fdnDensity: .7, fdnDamping: .55, geometryInfluence: .7 }
  });
  assert.ok(audio.direct[0][0] > 0);
  assert.equal(audio.directArrival[0][0], 0);
  assert.equal(audio.wet[0][0], 0);
  assert.ok(audio.directArrival[0].some(Boolean));
});

test('distant FDN late field cannot begin before its geometric reflection arrivals', async () => {
  const source = { latitude: 60, longitude: 24 };
  const listener = { latitude: 60.0075, longitude: 24 };
  const reflectors = [
    { id: 'a', latitude: 60.003, longitude: 24.001, levelDb: -6 },
    { id: 'b', latitude: 60.0045, longitude: 23.999, levelDb: -6 }
  ];
  const settings = {
    durationSeconds: 1, fdnTailSeconds: 1, lateMode: 'fdn', pointMode: 'persistent', pointPersistence: .65,
    pointMaxBounces: 2, pointPathLimit: 32, maxBounces: 2, cutoffDb: -90, lateWalks: 8, tailPersistence: .6,
    fdnDensity: .7, fdnDamping: .55, geometryInfluence: 1, airMode: 'off', geometricSpreadingAmount: 0
  };
  const firstReflectionFrame = Math.min(...createEarlyArrivalEvents({ source, listener, reflectors, settings, sampleRate: 1000 }).map(event => event.frame));
  const audio = await renderExportAudio({
    sampleRate: 1000, source, listener, reflectors, heading: 0, distanceMetres,
    inputMono: new Float32Array([1]), settings, outputs: ['late']
  });
  assert.ok(firstReflectionFrame > 2000);
  const preArrivalPeak = Math.max(...audio.late.flatMap(channel => [...channel.subarray(0, firstReflectionFrame)].map(Math.abs)));
  const responsePeak = Math.max(...audio.late.flatMap(channel => [...channel.subarray(firstReflectionFrame)].map(Math.abs)));
  assert.ok(preArrivalPeak < 1e-12);
  assert.ok(responsePeak > 1e-8);
});
