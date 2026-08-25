import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceProject, parseWorkspaceProject, WORKSPACE_PROJECT_FORMAT } from '../src/workspace-project.js';

const workspace = {
  project: { id: 'project-1', name: 'Saved field', createdAt: '2026-08-24T00:00:00.000Z' },
  source: { latitude: 60.1, longitude: 24.9 }, listener: { latitude: 60.2, longitude: 25 },
  reflectors: [{ id: 'manual-1', latitude: 60.15, longitude: 24.95, levelDb: -6, material: 'brick' }],
  automaticReflectors: [{ id: 'area-1', latitude: 60.16, longitude: 24.96, levelDb: -15, material: 'concrete', buildingEdge: [[24.95, 60.15], [24.97, 60.17]], reflectionKind: 'specular' }],
  pointsLinked: false, globalReflectionLevelDb: -6, globalMaterial: 'generic', echoFieldEnabled: true,
  settings: { heading: 123, arrivalsOnly: true, panningMode: 'hrtf-live', playbackMode: 'rendered', echoFieldRadiusMetres: 180, echoField: { pointMode: 'persistent', lateMode: 'convolution', airMode: 'standard' } },
  mapView: { latitude: 60.2, longitude: 25, zoom: 16 }
};

test('workspace project round-trips editable state without derived echo data', () => {
  const file = createWorkspaceProject(workspace);
  assert.equal(file.format, WORKSPACE_PROJECT_FORMAT);
  assert.equal('derived' in file, false);
  const opened = parseWorkspaceProject(JSON.stringify(file));
  assert.equal(opened.settings.heading, 123);
  assert.equal(opened.settings.panningMode, 'hrtf-live');
  assert.equal(opened.settings.playbackMode, 'rendered');
  assert.equal(opened.settings.echoFieldRadiusMetres, 180);
  assert.equal(opened.automaticReflectors[0].buildingEdge.length, 2);
  assert.equal(opened.echoFieldEnabled, true);
  assert.equal(opened.background, null);
});

test('export manifests are not accepted as editable workspace projects', () => {
  assert.throws(() => parseWorkspaceProject(JSON.stringify({ format: 'echotect-project' })), /not an Echotect project/);
});

test('older workspace projects default to live playback', () => {
  const file = createWorkspaceProject(workspace);
  delete file.monitor.playbackMode;
  assert.equal(parseWorkspaceProject(JSON.stringify(file)).settings.playbackMode, 'live');
});

test('invalid reflector geometry rejects the whole project before state changes', () => {
  const file = createWorkspaceProject(workspace);
  file.geometry.reflectors[0].latitude = 200;
  assert.throws(() => parseWorkspaceProject(JSON.stringify(file)), /position and an id/);
});

test('embedded image background survives project round-trip', () => {
  const file = createWorkspaceProject({
    ...workspace,
    background: {
      name: 'plan.png', dataUrl: 'data:image/png;base64,AAAA', pixelWidth: 800, pixelHeight: 600,
      center: workspace.listener, widthMetres: 75, rotationDegrees: -30, opacity: .5
    }
  });
  const opened = parseWorkspaceProject(JSON.stringify(file));
  assert.equal(opened.background.name, 'plan.png');
  assert.equal(opened.background.widthMetres, 75);
  assert.equal(opened.background.rotationDegrees, -30);
});
