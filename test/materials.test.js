import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMaterial, normalizeFacadeMaterial } from '../src/materials.js';

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
