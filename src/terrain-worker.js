import { buildTerrainField, terrainFacets, terrainFrame } from './terrain-space.js';

let facetCache = null;

const facetKey = space => JSON.stringify({
  bounds: space.capture.bounds, capturedAt: space.capture.capturedAt, columns: space.capture.columns, rows: space.capture.rows,
  mode: space.mode, floorElevationMetres: space.floorElevationMetres, scale: space.scale
});

self.addEventListener('message', ({ data }) => {
  const { revision, space, source, listener, globalReflectionLevelDb, maxSurfaces, speedOfSound } = data;
  try {
    const key = facetKey(space);
    if (facetCache?.key !== key) facetCache = { key, facets: terrainFacets(terrainFrame(space)) };
    const field = buildTerrainField({ space, facets: facetCache.facets, source, listener, globalReflectionLevelDb, maxSurfaces, speedOfSound });
    self.postMessage({ revision, field });
  } catch (error) {
    self.postMessage({ revision, error: error instanceof Error ? error.message : String(error) });
  }
});
