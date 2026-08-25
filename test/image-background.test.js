import test from 'node:test';
import assert from 'node:assert/strict';
import { imageCoordinates, transformImagePoint } from '../src/image-background.js';
import { distanceMetres } from '../src/geo.js';

const background = {
  center: { latitude: 60, longitude: 25 }, pixelWidth: 1000, pixelHeight: 500,
  widthMetres: 100, rotationDegrees: 0
};

test('image corners preserve calibrated width and aspect ratio', () => {
  const corners = imageCoordinates(background).map(([longitude, latitude]) => ({ longitude, latitude }));
  assert.ok(Math.abs(distanceMetres(corners[0], corners[1]) - 100) < 1);
  assert.ok(Math.abs(distanceMetres(corners[1], corners[2]) - 50) < 1);
});

test('changing image scale and rotation keeps a point attached to the image', () => {
  const point = { latitude: 60, longitude: imageCoordinates(background)[1][0] };
  const transformed = transformImagePoint(point, background, { ...background, widthMetres: 200, rotationDegrees: 90 });
  const distance = distanceMetres(background.center, transformed);
  assert.ok(Math.abs(distance - 100) < 1);
  assert.ok(transformed.latitude < background.center.latitude);
});
