const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../echotect_model.js');

const manifest = {
  format: 'echotect-project', schemaVersion: '2.0.0', project: { name: 'Test' },
  geometry: { listener: { headingDegrees: 0 } },
  derived: {
    direct: { propagationSeconds: 1, pathMetres: 343, levelDb: -7.783322, arrivalAzimuthDegrees: 0 },
    earlyPaths: [{ reflectorIds: ['r1'], finalReflectorId: 'r1', propagationSeconds: 2, pathMetres: 686, levelDb: -6, arrivalAzimuthDegrees: 90 }]
  }
};

const controls = {
  headingDegrees: 0, widthPercent: 100, scale: 1, directEnabled: true, reflectionsEnabled: true,
  directLevelDb: 0, reflectionsLevelDb: 0, normalizeReflections: false, reflectionNormalizationDb: 0
};

test('accepts the exact manifest version and creates direct plus early voices', () => {
  assert.deepEqual(model.validate(manifest), []);
  const paths = model.pathsFromManifest(manifest);
  assert.equal(paths.length, 2);
  assert.equal(paths[0].kind, 'direct');
  assert.equal(paths[1].id, 'r1');
});

test('scale continuously multiplies propagation time', () => {
  const path = model.pathsFromManifest(manifest)[1];
  const config = model.renderConfig(path, { headingDegrees: 0, widthPercent: 100, scale: 1.5, directEnabled: true, reflectionsEnabled: true, directLevelDb: 0, reflectionsLevelDb: 0 });
  assert.equal(config.delayMilliseconds, 3000);
});

test('quad panning is constant power and heading rotates the field', () => {
  const front = model.quadGains(0, 0, 100);
  const rotated = model.quadGains(0, 180, 100);
  const power = values => values.reduce((sum, value) => sum + value * value, 0);
  assert.ok(Math.abs(power(front) - 1) < 1e-12);
  assert.ok(Math.abs(power(rotated) - 1) < 1e-12);
  assert.ok(front[0] > 0 && front[1] > 0);
  assert.ok(rotated[2] > 0 && rotated[3] > 0);
});

test('unsupported schema is rejected without fallback', () => {
  const incompatible = JSON.parse(JSON.stringify(manifest));
  incompatible.schemaVersion = '0.9.0';
  assert.match(model.validate(incompatible).join(' '), /schemaVersion must be 2\.0\.0/);
});

test('the voice budget covers the complete Echotect early-path range plus the direct arrival', () => {
  const large = JSON.parse(JSON.stringify(manifest));
  large.derived.earlyPaths = Array.from({ length: 4096 }, (_, index) => ({
    reflectorIds: [`r${index}`], finalReflectorId: `r${index}`,
    propagationSeconds: 1, pathMetres: 343, levelDb: -30,
    arrivalAzimuthDegrees: index % 360
  }));
  assert.deepEqual(model.validate(large), []);
  assert.equal(model.pathsFromManifest(large).length, model.MAX_VOICES);
});

test('the direct level comes from the manifest instead of being derived again', () => {
  const declared = JSON.parse(JSON.stringify(manifest));
  declared.derived.direct.levelDb = -3;
  const [direct] = model.pathsFromManifest(declared);
  assert.equal(direct.levelDb, -3);
  const config = model.renderConfig(direct, { ...controls, headingDegrees: 0, widthPercent: 100 });
  const power = config.outputGains.reduce((sum, gain) => sum + gain * gain, 0);
  assert.ok(Math.abs(Math.sqrt(power) - 10 ** (-3 / 20)) < 1e-12);
});

test('normalization lifts the loudest reflection to 0 dB, keeps the spread, and leaves the direct path', () => {
  const quiet = JSON.parse(JSON.stringify(manifest));
  quiet.derived.earlyPaths = [-48, -60].map((levelDb, index) => ({
    reflectorIds: [`r${index}`], finalReflectorId: `r${index}`,
    propagationSeconds: 2, pathMetres: 686, levelDb, arrivalAzimuthDegrees: 90
  }));
  const paths = model.pathsFromManifest(quiet);
  const normalized = { ...controls, normalizeReflections: true, reflectionNormalizationDb: model.reflectionNormalizationDb(paths) };
  assert.equal(normalized.reflectionNormalizationDb, 48);
  assert.deepEqual(paths.map(path => model.effectiveLevelDb(path, normalized)), [quiet.derived.direct.levelDb, 0, -12]);
  assert.deepEqual(paths.map(path => model.effectiveLevelDb(path, { ...normalized, normalizeReflections: false })), [quiet.derived.direct.levelDb, -48, -60]);
  const gain = path => Math.hypot(...model.renderConfig(path, { ...normalized, reflectionsLevelDb: -6 }).outputGains);
  assert.ok(Math.abs(gain(paths[1]) - 10 ** (-6 / 20)) < 1e-12);
});

test('a manifest with no reflections normalizes by nothing', () => {
  const directOnly = JSON.parse(JSON.stringify(manifest));
  directOnly.derived.earlyPaths = [];
  assert.equal(model.reflectionNormalizationDb(model.pathsFromManifest(directOnly)), 0);
});

test('a manifest without a declared direct level is rejected', () => {
  const missing = JSON.parse(JSON.stringify(manifest));
  delete missing.derived.direct.levelDb;
  assert.match(model.validate(missing).join(' '), /derived\.direct\.levelDb/);
});

test('an occluded direct path has no voice and the reflections keep their order', () => {
  const occluded = JSON.parse(JSON.stringify(manifest));
  occluded.derived.direct.occluded = true;
  occluded.derived.direct.levelDb = null;
  assert.deepEqual(model.validate(occluded), []);
  const paths = model.pathsFromManifest(occluded);
  assert.deepEqual(paths.map(path => path.kind), ['reflection']);
  assert.equal(paths[0].id, 'r1');
});

test('an occluded direct path read through a Max Dict is still occluded', () => {
  [undefined, 'null', ''].forEach(levelDb => {
    const fromDict = JSON.parse(JSON.stringify(manifest));
    fromDict.derived.direct.occluded = 1;
    if (levelDb === undefined) delete fromDict.derived.direct.levelDb;
    else fromDict.derived.direct.levelDb = levelDb;
    assert.deepEqual(model.validate(fromDict), []);
    assert.deepEqual(model.pathsFromManifest(fromDict).map(path => path.kind), ['reflection']);
  });
});

test('an occluded direct path must not declare a level', () => {
  const contradictory = JSON.parse(JSON.stringify(manifest));
  contradictory.derived.direct.occluded = true;
  assert.match(model.validate(contradictory).join(' '), /occluded/);
});
