const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../echotect_model.js');

const manifest = {
  format: 'echotect-project', schemaVersion: '1.1.0', project: { name: 'Test' },
  geometry: { listener: { headingDegrees: 0 } },
  derived: {
    direct: { propagationSeconds: 1, pathMetres: 343, levelDb: -7.783322, arrivalAzimuthDegrees: 0 },
    earlyPaths: [{ reflectorIds: ['r1'], finalReflectorId: 'r1', propagationSeconds: 2, pathMetres: 686, levelDb: -6, arrivalAzimuthDegrees: 90 }]
  }
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
  assert.match(model.validate(incompatible).join(' '), /schemaVersion must be 1\.1\.0/);
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
  assert.ok(Math.abs(direct.levelGain - 10 ** (-3 / 20)) < 1e-12);
});

test('a manifest without a declared direct level is rejected', () => {
  const missing = JSON.parse(JSON.stringify(manifest));
  delete missing.derived.direct.levelDb;
  assert.match(model.validate(missing).join(' '), /derived\.direct\.levelDb/);
});
