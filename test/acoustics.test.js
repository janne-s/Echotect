import test from 'node:test';
import assert from 'node:assert/strict';
import { atmosphericAbsorptionDbPerMetre, materialBandGains, pathBandGains, pathFilter, STANDARD_ATMOSPHERE } from '../src/acoustics.js';

test('ISO 9613-1 standard atmosphere coefficients match known values', () => {
  const dbPerKilometre = frequency => atmosphericAbsorptionDbPerMetre(frequency, STANDARD_ATMOSPHERE) * 1000;
  assert.ok(Math.abs(dbPerKilometre(1000) - 4.665) < .01);
  assert.ok(Math.abs(dbPerKilometre(4000) - 29.666) < .02);
  assert.ok(Math.abs(dbPerKilometre(8000) - 105.291) < .02);
});

test('air and vegetation remove more high-frequency than low-frequency energy', () => {
  const air = pathBandGains({ pathMetres: 100, settings: { airMode: 'standard', airAbsorptionAmount: 1 }, sourceGain: 1 });
  const vegetation = materialBandGains('vegetation');
  assert.ok(air[6] < air[3]);
  assert.ok(vegetation[6] < vegetation[0]);
});

test('geometric spreading is calibrated to a geometry-derived reference path', () => {
  const reference = pathBandGains({ pathMetres: 100, referencePathMetres: 100, settings: { airMode: 'off' }, sourceGain: 1 });
  const doubleDistance = pathBandGains({ pathMetres: 200, referencePathMetres: 100, settings: { airMode: 'off' }, sourceGain: 1 });
  assert.ok(Math.abs(doubleDistance[3] / reference[3] - .5) < 1e-12);
});

test('geometric spreading amount is an explicit creative control', () => {
  const physical = pathBandGains({ pathMetres: 200, referencePathMetres: 100, settings: { airMode: 'off', geometricSpreadingAmount: 1 }, sourceGain: 1 });
  const disabled = pathBandGains({ pathMetres: 200, referencePathMetres: 100, settings: { airMode: 'off', geometricSpreadingAmount: 0 }, sourceGain: 1 });
  assert.ok(Math.abs(physical[3] - .5) < 1e-12);
  assert.equal(disabled[3], 1);
});

test('causal coloration begins at the geometric arrival sample', () => {
  const filter = pathFilter([1, .9, .8, .7, .5, .3, .1], 48000);
  assert.notEqual(filter[0], 0);
});
