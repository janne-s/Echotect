import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectManifest, validateProjectManifest } from '../src/project-manifest.js';

const manifest = () => createProjectManifest({
  projectId: 'project-1', projectName: 'Test', createdAt: '2026-01-01T00:00:00.000Z',
  source: { latitude: 60, longitude: 24 }, listener: { latitude: 60.001, longitude: 24 },
  reflectors: [{ id: 'r1', latitude: 60, longitude: 24.001, levelDb: -6, material: 'inherit', effectiveMaterial: 'generic' }],
  globalReflectionLevelDb: -6, globalMaterial: 'generic', pointsLinked: false, heading: 0,
  echoField: { enabled: false, radiusMetres: 100, activeSurfaceCount: 0 },
  echoFieldSettings: { durationSeconds: 10, maxBounces: 32, pointPathLimit: 512, pointMaxBounces: 6,
    pointPersistence: .65, pointMode: 'persistent', airMode: 'standard', airAbsorptionAmount: 1,
    materialColorationAmount: 1, cutoffDb: -90, fdnTailSeconds: 8, lateMode: 'convolution' }, inputName: 'handclap', inputDurationSeconds: .23
});

test('manifest 1.0.0 round-trips point settings and validates', () => {
  const roundTrip = JSON.parse(JSON.stringify(manifest()));
  assert.deepEqual(validateProjectManifest(roundTrip), { valid: true, errors: [] });
  assert.equal(roundTrip.units.distance, 'metres');
  assert.equal(roundTrip.exports.wav.normalization, false);
  assert.equal(roundTrip.renderSettings.pointMode, 'persistent');
  assert.equal(roundTrip.renderSettings.pointPersistence, .65);
  assert.equal(roundTrip.propagation.atmosphericAbsorptionMethod, 'ISO 9613-1:1993');
  assert.equal(roundTrip.derived.earlyPaths[0].octaveBandGains.length, 7);
});

test('unsupported schema versions are rejected', () => {
  const value = manifest(); value.schemaVersion = '0.9.0';
  assert.equal(validateProjectManifest(value).valid, false);
});
