import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectManifest, validateProjectManifest } from '../src/project-manifest.js';

const manifest = () => createProjectManifest({
  projectId: 'project-1', projectName: 'Test', createdAt: '2026-01-01T00:00:00.000Z',
  source: { latitude: 60, longitude: 24 }, listener: { latitude: 60.001, longitude: 24 },
  reflectors: [{ id: 'r1', latitude: 60, longitude: 24.001, levelDb: -6, material: 'inherit', effectiveMaterial: 'generic' }],
  globalReflectionLevelDb: -6, globalMaterial: 'generic', pointsLinked: false, heading: 0,
  echoField: { enabled: false, radiusMetres: 100, activeSurfaceCount: 0 },
  echoFieldSettings: { durationSeconds: 10, maxBounces: 32, earlyPathLimit: 512, cutoffDb: -90, fdnTailSeconds: 8, lateMode: 'convolution' }, inputName: 'handclap', inputDurationSeconds: .23
});

test('manifest 1.0.0 round-trips as JSON and validates', () => {
  const roundTrip = JSON.parse(JSON.stringify(manifest()));
  assert.deepEqual(validateProjectManifest(roundTrip), { valid: true, errors: [] });
  assert.equal(roundTrip.units.distance, 'metres');
  assert.equal(roundTrip.exports.wav.normalization, false);
});

test('unsupported schema versions are rejected', () => {
  const value = manifest(); value.schemaVersion = '0.9.0';
  assert.equal(validateProjectManifest(value).valid, false);
});
