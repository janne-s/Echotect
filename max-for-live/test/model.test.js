const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../echotect_model.js');

const manifest = {
  format: 'echotect-project', schemaVersion: '1.0.0', project: { name: 'Test' },
  geometry: { listener: { headingDegrees: 0 } },
  derived: {
    direct: { propagationSeconds: 1, pathMetres: 343, arrivalAzimuthDegrees: 0 },
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
  assert.match(model.validate(incompatible).join(' '), /schemaVersion must be 1\.0\.0/);
});

test('supports the complete Echotect early-path range across poly banks', () => {
  const large = JSON.parse(JSON.stringify(manifest));
  large.derived.earlyPaths = Array.from({ length: 4096 }, (_, index) => ({
    reflectorIds: [`r${index}`], finalReflectorId: `r${index}`,
    propagationSeconds: 1, pathMetres: 343, levelDb: -30,
    arrivalAzimuthDegrees: index % 360
  }));
  assert.deepEqual(model.validate(large), []);
  large.derived.earlyPaths.push(large.derived.earlyPaths[0]);
  assert.deepEqual(model.validate(large), []);
});
