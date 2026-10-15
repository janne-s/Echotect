import { createTerrainSpace } from '../../src/terrain-space.js';
import { terrainMetresPerDegree } from '../../src/terrain-tiles.js';

export const CENTRE = Object.freeze({ latitude: 46, longitude: 7 });

export function syntheticCapture(elevation, { columns = 64, rows = 64, widthMetres = 640, heightMetres = 640 } = {}) {
  const values = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      values[row * columns + column] = elevation(-widthMetres / 2 + (column + .5) * widthMetres / columns, -heightMetres / 2 + (row + .5) * heightMetres / rows);
    }
  }
  const { north, east } = terrainMetresPerDegree(CENTRE.latitude);
  const latitudeSpan = heightMetres / 2 / north;
  const longitudeSpan = widthMetres / 2 / east;
  return {
    bounds: { west: CENTRE.longitude - longitudeSpan, east: CENTRE.longitude + longitudeSpan, south: CENTRE.latitude - latitudeSpan, north: CENTRE.latitude + latitudeSpan },
    provider: 'synthetic', tileZoom: 0, columns, rows, widthMetres, heightMetres, curvatureCorrected: false, capturedAt: '2026-09-23T00:00:00.000Z', values
  };
}

export function syntheticSpace(elevation, gridOptions, overrides = {}) {
  return { ...createTerrainSpace(syntheticCapture(elevation, gridOptions)), ...overrides };
}

export function terrainHeights(source, listener = source, mode = 'exterior') {
  return {
    heightsMetres: {
      exterior: { source: 1.7, listener: 1.7 },
      interior: { source: 1.7, listener: 1.7 },
      [mode]: { source, listener }
    }
  };
}

export const at = (x, y) => ({
  latitude: CENTRE.latitude + y / terrainMetresPerDegree(CENTRE.latitude).north,
  longitude: CENTRE.longitude + x / terrainMetresPerDegree(CENTRE.latitude).east
});

export const distance3d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export const reflectionPathMetres = (field, reflector) =>
  distance3d(field.source.positionMetres, reflector.positionMetres) + distance3d(reflector.positionMetres, field.listener.positionMetres);
