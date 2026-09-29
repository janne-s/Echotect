import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMaterial, groundAbsorption, GROUND_FLOW_RESISTIVITY, MATERIAL_ABSORPTION, normalizeFacadeMaterial } from '../src/materials.js';

test('normalizes Overture facade materials', () => {
  assert.equal(normalizeFacadeMaterial('cement_block'), 'concrete');
  assert.equal(normalizeFacadeMaterial('timber_framing'), 'wood');
  assert.equal(normalizeFacadeMaterial('glass'), 'glass');
});

test('unknown facade material has no automatic override', () => {
  assert.equal(normalizeFacadeMaterial('unknown composite'), null);
});

test('reflector material overrides or inherits the global material', () => {
  assert.equal(effectiveMaterial({ material: 'glass' }, 'concrete'), 'glass');
  assert.equal(effectiveMaterial({ material: 'inherit' }, 'concrete'), 'concrete');
});

test('building materials keep their measured absorption', () => {
  assert.deepEqual(MATERIAL_ABSORPTION.concrete, [.02, .02, .03, .03, .03, .04, .07]);
  assert.deepEqual(MATERIAL_ABSORPTION.stone, [.02, .02, .02, .03, .04, .05, .06]);
  assert.deepEqual(MATERIAL_ABSORPTION.vegetation, [.10, .15, .25, .40, .55, .65, .75]);
});

test('natural ground absorbs more as it gets softer and as frequency rises', () => {
  for (const material of Object.keys(GROUND_FLOW_RESISTIVITY)) {
    const bands = MATERIAL_ABSORPTION[material];
    assert.equal(bands.length, 7);
    bands.forEach((value, band) => {
      assert.ok(value > 0 && value < 1);
      if (band) assert.ok(value > bands[band - 1]);
    });
  }
  assert.ok(MATERIAL_ABSORPTION.snow[3] > MATERIAL_ABSORPTION.grass[3]);
  assert.ok(MATERIAL_ABSORPTION.grass[3] > MATERIAL_ABSORPTION.stonyGround[3]);
});

test('ground absorption approaches zero for a very hard surface', () => {
  assert.ok(groundAbsorption(1000, 200000) < .01);
});
