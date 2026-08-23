import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ECHO_FIELD_SETTINGS, ECHO_FIELD_SETTINGS, LATE_MODES, normalizeEchoFieldSettings } from '../src/echo-field-settings.js';

test('every setting declares a usable range and an in-range fallback', () => {
  for (const [name, spec] of Object.entries(ECHO_FIELD_SETTINGS)) {
    assert.ok(spec.minimum < spec.maximum, `${name} range`);
    assert.ok(spec.step > 0 && spec.step <= spec.maximum - spec.minimum, `${name} step`);
    assert.ok(spec.fallback >= spec.minimum && spec.fallback <= spec.maximum, `${name} fallback`);
    if (spec.integer) assert.equal(Math.round(spec.fallback), spec.fallback, `${name} integer fallback`);
  }
});

test('missing, malformed, and unusable values fall back to the defaults', () => {
  assert.deepEqual(normalizeEchoFieldSettings(undefined), DEFAULT_ECHO_FIELD_SETTINGS);
  assert.deepEqual(normalizeEchoFieldSettings({ durationSeconds: null, cutoffDb: 'x', lateMode: 'reverb' }), DEFAULT_ECHO_FIELD_SETTINGS);
});

test('slider strings and out-of-range numbers are bounded to the declared range', () => {
  const settings = normalizeEchoFieldSettings({ durationSeconds: '12', maxSurfaces: 4, earlyPathLimit: 99999, lateWalks: '300.7', geometryInfluence: -3 });
  assert.equal(settings.durationSeconds, 12);
  assert.equal(settings.maxSurfaces, ECHO_FIELD_SETTINGS.maxSurfaces.minimum);
  assert.equal(settings.earlyPathLimit, ECHO_FIELD_SETTINGS.earlyPathLimit.maximum);
  assert.equal(settings.lateWalks, 301);
  assert.equal(settings.geometryInfluence, ECHO_FIELD_SETTINGS.geometryInfluence.minimum);
});

test('both late modes survive normalization unchanged', () => {
  for (const lateMode of LATE_MODES) assert.equal(normalizeEchoFieldSettings({ lateMode }).lateMode, lateMode);
});
