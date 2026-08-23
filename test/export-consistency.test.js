import test from 'node:test';
import assert from 'node:assert/strict';
import { decibelsToGain } from '../src/audio-model.js';
import { distanceMetres } from '../src/geo.js';
import { renderExportAudio } from '../src/offline-export.js';
import { createProjectManifest } from '../src/project-manifest.js';
import { WAV_SAMPLE_RATE } from '../src/wav.js';

const source = { latitude: 60, longitude: 24 };
const listener = { latitude: 60.001, longitude: 24 };
const settings = {
  durationSeconds: 1, maxSurfaces: 48, earlyPathLimit: 512, lateWalks: 256, maxBounces: 8,
  cutoffDb: -90, tailPersistence: .6, lateMode: 'convolution', fdnTailSeconds: 1,
  fdnDensity: .7, fdnDamping: .55, geometryInfluence: .7
};
const inputMono = new Float32Array(48).fill(0);
inputMono[0] = 1;
const inputDurationSeconds = inputMono.length / WAV_SAMPLE_RATE;

const manifestFor = reflectors => createProjectManifest({
  projectId: 'project-1', projectName: 'Consistency', createdAt: '2026-01-01T00:00:00.000Z',
  source, listener, reflectors, globalReflectionLevelDb: -6, globalMaterial: 'generic',
  pointsLinked: false, heading: 0,
  echoField: { enabled: false, radiusMetres: 100, activeSurfaceCount: 0 },
  echoFieldSettings: settings, inputName: 'test', inputDurationSeconds
});

const renderFor = reflectors => renderExportAudio({
  source, listener, reflectors, heading: 0, settings, distanceMetres, inputMono, sampleRate: WAV_SAMPLE_RATE
});

const frames = seconds => Math.round(seconds * WAV_SAMPLE_RATE);
const arrivalGain = (channels, frame) => Math.hypot(channels[0][frame], channels[1][frame]);

test('manifest export durations match the rendered WAV lengths', async () => {
  const reflectors = [
    { id: 'r1', latitude: 60.0005, longitude: 24.0004, levelDb: -6 },
    { id: 'r2', latitude: 59.9994, longitude: 24.0009, levelDb: -8 }
  ];
  const manifest = manifestFor(reflectors);
  const audio = await renderFor(reflectors);

  assert.equal(frames(manifest.exports.convolutionIr.durationSeconds), audio.convolutionIr[0].length);
  assert.equal(frames(manifest.exports.renderedFdnIr.durationSeconds), audio.fdnIr[0].length);
  assert.equal(frames(manifest.exports.wetRender.durationSeconds), audio.wet[0].length);
  assert.equal(frames(manifest.exports.stems.durationSeconds), audio.direct[0].length);
  assert.equal(audio.direct[0].length, audio.early[0].length);
  assert.equal(audio.early[0].length, audio.late[0].length);
});

test('every declared arrival is rendered at the declared time and level', async () => {
  // One reflector cannot produce a recursive late field, so the response holds early arrivals only.
  const reflectors = [{ id: 'r1', latitude: 60.0005, longitude: 24.0004, levelDb: -6 }];
  const manifest = manifestFor(reflectors);
  const audio = await renderFor(reflectors);

  const direct = manifest.derived.direct;
  assert.ok(Math.abs(arrivalGain(audio.directArrival, frames(direct.propagationSeconds)) - decibelsToGain(direct.levelDb)) < 1e-6);

  assert.ok(manifest.derived.earlyPaths.length > 0);
  for (const path of manifest.derived.earlyPaths) {
    const frame = frames(path.propagationSeconds);
    assert.ok(Math.abs(arrivalGain(audio.convolutionIr, frame) - decibelsToGain(path.levelDb)) < 1e-6,
      `path ${path.reflectorIds.join('>')} at ${path.propagationSeconds} s`);
  }
  const rendered = audio.convolutionIr[0].reduce((count, value, frame) => count + (value || audio.convolutionIr[1][frame] ? 1 : 0), 0);
  assert.equal(rendered, manifest.derived.earlyPaths.length);
});
