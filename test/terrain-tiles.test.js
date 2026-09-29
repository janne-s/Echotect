import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildHeightfield, capturePlan, curvatureDropMetres, decodePngRgb, decodeTerrarium, MAXIMUM_GRID_CELLS, tilePixelMetres, validCaptureBounds } from '../src/terrain-tiles.js';

const boundsAround = (latitude, longitude, halfDegrees) => ({ west: longitude - halfDegrees, east: longitude + halfDegrees, south: latitude - halfDegrees, north: latitude + halfDegrees });

test('Terrarium pixels decode to metres', () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(0, 0, 0), -32768);
  assert.equal(decodeTerrarium(131, 45, 128), 3 * 256 + 45 + .5);
});

test('a level surface drops 7.85 m below the tangent plane at 10 km', () => {
  assert.ok(Math.abs(curvatureDropMetres(10000) - 7.85) < .05);
  assert.ok(Math.abs(curvatureDropMetres(20000) - 31.4) < .1);
});

test('the capture grid follows the tiles and caps its long side', () => {
  const small = capturePlan(boundsAround(46, 7, .005));
  const large = capturePlan(boundsAround(46, 7, .3));
  assert.ok(Math.max(large.columns, large.rows) <= MAXIMUM_GRID_CELLS + 1);
  assert.ok(large.zoom < small.zoom);
  assert.ok(small.widthMetres / small.columns >= tilePixelMetres(46, small.zoom) - 1e-9);
  assert.ok(small.tiles.count <= 36 && large.tiles.count <= 36);
});

test('rectangles outside the supported size are rejected', () => {
  assert.equal(validCaptureBounds(boundsAround(46, 7, .0001)), false);
  assert.equal(validCaptureBounds(boundsAround(46, 7, 1)), false);
  assert.equal(validCaptureBounds({ west: 7, east: 6, south: 46, north: 47 }), false);
  assert.equal(validCaptureBounds(boundsAround(46, 7, .01)), true);
});

test('resampled heights are lowered onto the tangent plane at the capture centre', () => {
  const plan = capturePlan(boundsAround(46, 7, .05));
  const values = buildHeightfield(plan, () => 500);
  const centreIndex = Math.floor(plan.rows / 2) * plan.columns + Math.floor(plan.columns / 2);
  const cornerX = -plan.widthMetres / 2 + .5 * plan.widthMetres / plan.columns;
  const cornerY = -plan.heightMetres / 2 + .5 * plan.heightMetres / plan.rows;
  assert.ok(Math.abs(values[centreIndex] - 500) < .05);
  assert.ok(Math.abs(values[0] - (500 - curvatureDropMetres(Math.hypot(cornerX, cornerY)))) < 1e-3);
});

test('a Terrarium tile decodes to its exact bytes without a canvas', async () => {
  const bytes = readFileSync(new URL('./fixtures/terrarium-14-5385-7452.png', import.meta.url));
  const { width, height, rgb } = await decodePngRgb(bytes);
  assert.equal(width, 256);
  assert.equal(height, 256);
  const elevation = index => decodeTerrarium(rgb[index * 3], rgb[index * 3 + 1], rgb[index * 3 + 2]);
  assert.equal(elevation(0), 1150.1171875);
  assert.equal(elevation(128 * 256 + 128), 1070.83203125);
  let meanStep = 0;
  for (let index = 1; index < width * height; index += 1) meanStep += Math.abs(elevation(index) - elevation(index - 1)) / (width * height);
  assert.ok(meanStep < 10);
});
