import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEchoFieldSettings } from '../src/echo-field-settings.js';
import { renderExportAudio } from '../src/offline-export.js';
import { createProjectManifest, validateProjectManifest } from '../src/project-manifest.js';
import { buildTerrainField, TERRAIN_DISTANCE_METHOD, terrainDistanceMetres } from '../src/terrain-space.js';
import { WAV_SAMPLE_RATE } from '../src/wav.js';
import { createWorkspaceProject, parseWorkspaceProject } from '../src/workspace-project.js';
import { at, syntheticSpace, terrainHeights } from './support/terrain.js';

const space = syntheticSpace((x, y) => 25 * Math.sin(x / 50) + 15 * Math.cos(y / 35) + (Math.abs(x) < 20 ? 90 : 0), undefined, {
  scattering: .5, ...terrainHeights(60), material: 'grass'
});
const settings = { ...normalizeEchoFieldSettings({ durationSeconds: 1, lateWalks: 256, maxBounces: 8, pointPathLimit: 256 }), buildingOcclusion: true };
const terrainField = buildTerrainField({ space, source: at(-120, 10), listener: at(110, -30), globalReflectionLevelDb: -6, maxSurfaces: 48, speedOfSound: 343 });
const reflectors = terrainField.reflectors.map(reflector => ({ ...reflector, effectiveMaterial: reflector.material }));
const inputMono = new Float32Array(48);
inputMono[0] = 1;

const manifest = () => createProjectManifest({
  projectId: 'terrain-1', projectName: 'Canyon', createdAt: '2026-09-23T00:00:00.000Z',
  source: terrainField.source, listener: terrainField.listener, reflectors,
  globalReflectionLevelDb: -6, globalMaterial: 'generic', pointsLinked: false, heading: 0,
  echoField: { enabled: true, radiusMetres: 100, activeSurfaceCount: reflectors.length },
  echoFieldSettings: settings, inputName: 'impulse', inputDurationSeconds: inputMono.length / WAV_SAMPLE_RATE,
  terrainSpace: space, distanceMetres: terrainDistanceMetres, directOccluded: terrainField.directOccluded
});

const render = () => renderExportAudio({
  source: terrainField.source, listener: terrainField.listener, reflectors, heading: 0, settings,
  distanceMetres: terrainDistanceMetres, directOccluded: terrainField.directOccluded, inputMono, outputs: ['convolutionIr', 'direct']
});

test('the ridge occludes the direct path and the reflections still sound', async () => {
  assert.equal(terrainField.directOccluded, true);
  const audio = await render();
  assert.ok(audio.convolutionIr[0].some(Boolean));
  const directFrame = Math.round(terrainDistanceMetres(terrainField.source, terrainField.listener) / 343 * WAV_SAMPLE_RATE);
  const tail = audio.direct.map(channel => channel.slice(directFrame - 4, directFrame + 200));
  assert.ok(tail.every(channel => channel.every(sample => sample === 0)));
});

test('a terrain manifest declares its space, distance method, and arrival elevations', () => {
  const value = JSON.parse(JSON.stringify(manifest()));
  assert.deepEqual(validateProjectManifest(value), { valid: true, errors: [] });
  assert.equal(value.schemaVersion, '2.0.0');
  assert.equal(value.propagation.distanceMethod, TERRAIN_DISTANCE_METHOD);
  assert.equal(value.derived.direct.occluded, true);
  assert.equal(value.derived.direct.levelDb, null);
  assert.equal(value.terrainSpace.acousticEnvironment, 'physical');
  assert.equal('heightfield' in value.terrainSpace, false);
  assert.ok(value.derived.earlyPaths.length > 0);
  assert.ok(value.derived.earlyPaths.every(path => Number.isFinite(path.arrivalElevationDegrees)));
  assert.ok(Number.isFinite(value.geometry.listener.positionMetres.up));
  assert.equal(value.geometry.reflectors[0].effectiveMaterial, 'grass');
});

test('identical terrain renders bit-identical impulse responses', async () => {
  const [first, second] = await Promise.all([render(), render()]);
  assert.deepEqual(first.convolutionIr, second.convolutionIr);
});

test('a workspace project carries its terrain space and reopens it exactly', () => {
  const file = createWorkspaceProject({
    project: { id: 'terrain-1', name: 'Canyon', createdAt: '2026-09-23T00:00:00.000Z' },
    placements: {
      map: { source: at(-20, 10), listener: at(10, -30), pointsLinked: true },
      terrain: {
        exterior: { source: at(-120, 10), listener: at(110, -30), pointsLinked: false },
        interior: { source: at(-40, 20), listener: at(30, 40), pointsLinked: true }
      }
    },
    activeSpace: 'terrain', reflectors: [], automaticReflectors: [], structures: [],
    globalReflectionLevelDb: -6, globalMaterial: 'generic', echoFieldEnabled: false,
    settings: { heading: 0, arrivalsOnly: false, panningMode: 'spatial-stereo', playbackMode: 'live', echoFieldRadiusMetres: 100, echoField: settings },
    mapView: { ...at(0, 0), zoom: 14 }, terrainSpace: space
  });
  const opened = parseWorkspaceProject(JSON.stringify(file));
  assert.deepEqual(opened.terrainSpace.capture.values, space.capture.values);
  assert.equal(opened.terrainSpace.material, 'grass');
  assert.deepEqual(opened.terrainSpace.heightsMetres, space.heightsMetres);
  assert.equal(opened.activeSpace, 'terrain');
  assert.deepEqual(opened.placements.terrain, file.geometry.placements.terrain);
  assert.notDeepEqual(opened.placements.terrain.exterior, opened.placements.terrain.interior);
  assert.notDeepEqual(opened.placements.map, opened.placements.terrain.exterior);
  assert.equal(parseWorkspaceProject(JSON.stringify({ ...file, terrainSpace: null })).terrainSpace, null);
});

test('a damaged terrain heightfield rejects the project', () => {
  const file = createWorkspaceProject({
    project: { id: 'terrain-1', name: 'Canyon', createdAt: '2026-09-23T00:00:00.000Z' },
    placements: {
      map: { source: at(0, 0), listener: at(10, 0), pointsLinked: false },
      terrain: {
        exterior: { source: at(0, 0), listener: at(10, 0), pointsLinked: false },
        interior: { source: at(0, 0), listener: at(10, 0), pointsLinked: false }
      }
    },
    activeSpace: 'terrain', reflectors: [], automaticReflectors: [],
    globalReflectionLevelDb: -6, globalMaterial: 'generic', echoFieldEnabled: false,
    settings: { heading: 0, echoFieldRadiusMetres: 100, echoField: settings }, mapView: { ...at(0, 0), zoom: 14 }, terrainSpace: space
  });
  file.terrainSpace.heightfield.values = file.terrainSpace.heightfield.values.slice(8);
  assert.throws(() => parseWorkspaceProject(JSON.stringify(file)), /heightfield/);
});
