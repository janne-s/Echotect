import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectArrivalEvent, monitorArrivalPlan } from '../src/arrivals.js';
import { SOURCE_ONSET_GAIN, gainToDecibels } from '../src/audio-model.js';

const point = { latitude: 60, longitude: 24 };
const distant = { latitude: 60.001, longitude: 24 };

test('a distinct direct arrival keeps the onset and the arrival as separate events', () => {
  const direct = createDirectArrivalEvent({ source: point, listener: distant });
  assert.ok(direct.frame > 0);
  assert.deepEqual(monitorArrivalPlan(direct, false), { playOnset: true, playDirectArrival: true });
});

test('arrivals only mutes the onset and keeps the propagated direct arrival', () => {
  const direct = createDirectArrivalEvent({ source: point, listener: distant });
  assert.deepEqual(monitorArrivalPlan(direct, true), { playOnset: false, playDirectArrival: true });
});

test('a co-located source and listener produce one event, not two', () => {
  const direct = createDirectArrivalEvent({ source: point, listener: point });
  assert.equal(direct.frame, 0);
  assert.equal(direct.levelDb, gainToDecibels(SOURCE_ONSET_GAIN));
  assert.deepEqual(monitorArrivalPlan(direct, false), { playOnset: false, playDirectArrival: true });
});

test('arrivals only silences the shared onset of a co-located source and listener', () => {
  const direct = createDirectArrivalEvent({ source: point, listener: point });
  assert.deepEqual(monitorArrivalPlan(direct, true), { playOnset: false, playDirectArrival: false });
});
