import { buildCanonicalTerrainField, terrainFacets, terrainFrame } from './terrain-space.js';

let facetCache = null;

const facetKey = space => JSON.stringify({
  bounds: space.capture.bounds, capturedAt: space.capture.capturedAt, columns: space.capture.columns, rows: space.capture.rows,
  mode: space.mode, floorElevationMetres: space.floorElevationMetres
});

self.addEventListener('message', ({ data }) => {
  const { revision, space, source, listener, globalReflectionLevelDb, maxSurfaces, speedOfSound } = data;
  try {
    const canonicalSpace = space.scale === 1 ? space : { ...space, scale: 1 };
    const key = facetKey(canonicalSpace);
    if (facetCache?.key !== key) facetCache = { key, facets: terrainFacets(terrainFrame(canonicalSpace)) };
    const field = buildCanonicalTerrainField({ space: canonicalSpace, facets: facetCache.facets, source, listener, globalReflectionLevelDb, maxSurfaces, speedOfSound });
    self.postMessage({ revision, field });
  } catch (error) {
    self.postMessage({ revision, error: error instanceof Error ? error.message : String(error) });
  }
});
