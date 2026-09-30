import { propagationSeconds } from './geo.js';
import { DEFAULT_TERRAIN_MATERIAL, MATERIAL_LABELS } from './materials.js';
import { boundedValue } from './range.js';
import { captureCentre, MAXIMUM_GRID_CELLS, MINIMUM_GRID_CELLS, terrainMetresPerDegree, validCaptureBounds } from './terrain-tiles.js';

export const TERRAIN_MODES = Object.freeze(['exterior', 'interior']);
export const TERRAIN_DISTANCE_METHOD = 'terrain-enu-euclidean';
export const TERRAIN_ACOUSTIC_ENVIRONMENT = Object.freeze({ exterior: 'physical', interior: 'creative-interior' });

export const TERRAIN_SCALE_RANGE = Object.freeze({ minimum: .01, maximum: 10, fallback: 1 });
export const EXTERIOR_HEIGHT_RANGE = Object.freeze({ minimum: .5, maximum: 1000, fallback: 1.7 });
export const GROUND_REFLECTION_RANGE = Object.freeze({ minimum: -24, maximum: 6, fallback: 0 });
export const SCATTERING_RANGE = Object.freeze({ minimum: 0, maximum: 1, fallback: .5 });
export const TERRAIN_POINT_ROLES = Object.freeze(['source', 'listener']);
/** Interior heights keep this clearance from the floor and from the ceiling above the point. */
const CAVITY_CLEARANCE_METRES = .5;
/** The ground under a point reaches at least this far, or ten times the point's height. */
const GROUND_RADIUS_MINIMUM_METRES = 20;
const GROUND_RADIUS_PER_HEIGHT = 10;
const DIFFUSE_DELAY_BIN_SECONDS = .001;
const DIFFUSE_AZIMUTH_SECTOR_DEGREES = 15;
const DIFFUSE_ELEVATION_SECTOR_DEGREES = 30;
/** Reflection points sit this far into the air, in cells, which is far under a sample of travel time. */
const SURFACE_OFFSET_CELLS = 1e-5;
/** Ray-march samples per analysis cell, and the cells ignored next to a surface endpoint. */
const MARCH_SAMPLES_PER_CELL = 1;
const ENDPOINT_SKIP_CELLS = 1;
const INTERIOR_SUBSAMPLES = 4;
/** Newton search for specular points: finite-difference step and convergence, in cells. */
const NEWTON_STEP_CELLS = .01;
const NEWTON_TOLERANCE_CELLS = 1e-7;
const NEWTON_ITERATIONS = 16;
/** Energy gain of a focusing concave reflection at most, +12 dB, where the caustic would diverge. */
const MAXIMUM_FOCUSING_ENERGY = 16;
const MAXIMUM_TERRAIN_VALUES = MAXIMUM_GRID_CELLS * MAXIMUM_GRID_CELLS;

const materialValues = new Set(Object.keys(MATERIAL_LABELS).filter(value => value !== 'inherit'));

const normalizedHeights = value => Object.fromEntries(TERRAIN_MODES.map(mode => [mode, Object.fromEntries(
  TERRAIN_POINT_ROLES.map(role => [role, boundedValue(value?.[mode]?.[role], EXTERIOR_HEIGHT_RANGE)])
)]));

/** The saved height for a Source or Listener in one terrain mode. */
export function terrainHeightMetres(space, role, mode = space.mode) {
  if (!TERRAIN_MODES.includes(mode) || !TERRAIN_POINT_ROLES.includes(role)) throw new RangeError('Terrain height mode or role is invalid.');
  return space.heightsMetres[mode][role];
}

export function elevationRange(values) {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return { minimumMetres: minimum, maximumMetres: maximum };
}

export const defaultFloorElevation = ({ minimumMetres, maximumMetres }) => minimumMetres + (maximumMetres - minimumMetres) * .25;

export function floorRange(values) {
  const { minimumMetres, maximumMetres } = elevationRange(values);
  return { minimum: minimumMetres, maximum: Math.max(minimumMetres, maximumMetres - 1), fallback: defaultFloorElevation({ minimumMetres, maximumMetres }) };
}

export function validCapture(capture) {
  return validCaptureBounds(capture?.bounds)
    && Number.isInteger(capture.columns) && Number.isInteger(capture.rows)
    && capture.columns >= MINIMUM_GRID_CELLS && capture.rows >= MINIMUM_GRID_CELLS
    && capture.columns * capture.rows <= MAXIMUM_TERRAIN_VALUES
    && Number.isFinite(capture.widthMetres) && capture.widthMetres > 0
    && Number.isFinite(capture.heightMetres) && capture.heightMetres > 0
    && capture.values instanceof Float32Array && capture.values.length === capture.columns * capture.rows
    && capture.values.every(Number.isFinite);
}

/** Accepts stored or edited terrain-space values and returns a complete, in-range space, or null. */
export function normalizeTerrainSpace(value) {
  if (!validCapture(value?.capture)) return null;
  const capture = value.capture;
  const groundReflectionDb = value.groundReflectionDb === null ? null : boundedValue(value.groundReflectionDb, GROUND_REFLECTION_RANGE);
  return {
    capture,
    mode: TERRAIN_MODES.includes(value.mode) ? value.mode : 'exterior',
    scale: boundedValue(value.scale, TERRAIN_SCALE_RANGE),
    floorElevationMetres: boundedValue(value.floorElevationMetres, floorRange(capture.values)),
    material: materialValues.has(value.material) ? value.material : DEFAULT_TERRAIN_MATERIAL,
    scattering: boundedValue(value.scattering, SCATTERING_RANGE),
    groundReflectionDb,
    heightsMetres: normalizedHeights(value.heightsMetres)
  };
}

export function createTerrainSpace(capture) {
  return normalizeTerrainSpace({ capture });
}

/** Float32 samples as little-endian base64, independent of the platform's byte order. */
export function encodeHeightfield(values) {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  const bytes = new Uint8Array(view.buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function decodeHeightfield(text, expectedLength) {
  if (typeof text !== 'string') throw new Error('Terrain heightfield data is missing.');
  let binary;
  try { binary = atob(text); } catch { throw new Error('Terrain heightfield data is invalid.'); }
  if (binary.length !== expectedLength * 4) throw new Error('Terrain heightfield size does not match its grid.');
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) view.setUint8(index, binary.charCodeAt(index));
  const values = new Float32Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) values[index] = view.getFloat32(index * 4, true);
  return values;
}

/** The serializable description of a terrain space; `includeHeightfield` adds the samples. */
export function serializeTerrainSpace(space, { includeHeightfield = true } = {}) {
  const { values, ...capture } = space.capture;
  const { minimumMetres, maximumMetres } = elevationRange(values);
  return {
    mode: space.mode,
    acousticEnvironment: TERRAIN_ACOUSTIC_ENVIRONMENT[space.mode],
    capture: { ...capture, elevationRangeMetres: { minimum: minimumMetres, maximum: maximumMetres } },
    ...(includeHeightfield ? { heightfield: { encoding: 'float32-le-base64', values: encodeHeightfield(values) } } : {}),
    placement: { pivot: captureCentre(capture.bounds), scale: space.scale },
    floorElevationMetres: space.floorElevationMetres,
    material: space.material,
    scattering: space.scattering,
    groundReflectionDb: space.groundReflectionDb,
    heightsMetres: structuredClone(space.heightsMetres)
  };
}

export function parseTerrainSpace(value) {
  if (value == null) return null;
  const capture = value.capture;
  if (value.heightfield?.encoding !== 'float32-le-base64') throw new Error('Terrain heightfield encoding is unsupported.');
  if (!Number.isInteger(capture?.columns) || !Number.isInteger(capture?.rows)
    || capture.columns * capture.rows > MAXIMUM_TERRAIN_VALUES) throw new Error('Terrain grid is invalid.');
  const values = decodeHeightfield(value.heightfield.values, capture.columns * capture.rows);
  const space = normalizeTerrainSpace({
    ...value,
    scale: value.placement?.scale,
    capture: {
      bounds: { west: capture.bounds?.west, south: capture.bounds?.south, east: capture.bounds?.east, north: capture.bounds?.north },
      provider: typeof capture.provider === 'string' ? capture.provider : 'unknown',
      tileZoom: Number.isInteger(capture.tileZoom) ? capture.tileZoom : null,
      columns: capture.columns,
      rows: capture.rows,
      widthMetres: capture.widthMetres,
      heightMetres: capture.heightMetres,
      curvatureCorrected: capture.curvatureCorrected === true,
      capturedAt: typeof capture.capturedAt === 'string' ? capture.capturedAt : null,
      values
    }
  });
  if (!space) throw new Error('Terrain capture is invalid.');
  return space;
}

/**
 * The metric frame of a terrain space. Captured coordinates are metres east and north of the
 * capture centre with elevation in metres, and the map shows the terrain there at its true size.
 * World coordinates are the acoustic space: the same frame scaled uniformly about the centre and
 * the lowest captured elevation. Sound travels through the world frame; the scale never moves
 * anything on the map.
 */
export function terrainFrame(space) {
  const { capture, scale, mode } = space;
  const { columns, rows, values, widthMetres, heightMetres } = capture;
  const pivot = captureCentre(capture.bounds);
  const cellX = widthMetres / columns;
  const cellY = heightMetres / rows;
  const { minimumMetres, maximumMetres } = elevationRange(values);
  const referenceElevation = minimumMetres;
  const floor = space.floorElevationMetres;
  const { east: eastScale, north: northScale } = terrainMetresPerDegree(pivot.latitude);

  const sampler = field => (x, y) => {
    const gridX = (x + widthMetres / 2) / cellX - .5;
    const gridY = (y + heightMetres / 2) / cellY - .5;
    if (gridX < -.5 || gridY < -.5 || gridX > columns - .5 || gridY > rows - .5) return NaN;
    const clampedX = Math.min(columns - 1, Math.max(0, gridX));
    const clampedY = Math.min(rows - 1, Math.max(0, gridY));
    const x0 = Math.min(columns - 2, Math.floor(clampedX));
    const y0 = Math.min(rows - 2, Math.floor(clampedY));
    const fx = clampedX - x0;
    const fy = clampedY - y0;
    const index = y0 * columns + x0;
    return (field[index] * (1 - fx) + field[index + 1] * fx) * (1 - fy)
      + (field[index + columns] * (1 - fx) + field[index + columns + 1] * fx) * fy;
  };
  const gradientX = new Float32Array(values.length);
  const gradientY = new Float32Array(values.length);
  for (let row = 0; row < rows; row += 1) {
    const down = Math.max(0, row - 1);
    const up = Math.min(rows - 1, row + 1);
    for (let column = 0; column < columns; column += 1) {
      const left = Math.max(0, column - 1);
      const right = Math.min(columns - 1, column + 1);
      gradientX[row * columns + column] = (values[row * columns + right] - values[row * columns + left]) / (cellX * (right - left));
      gradientY[row * columns + column] = (values[up * columns + column] - values[down * columns + column]) / (cellY * (up - down));
    }
  }
  const elevation = sampler(values);
  const slopeX = sampler(gradientX);
  const slopeY = sampler(gradientY);

  const toWorldZ = z => (z - referenceElevation) * scale;
  const surfaceZ = (worldX, worldY) => toWorldZ(elevation(worldX / scale, worldY / scale));
  const floorZ = toWorldZ(floor);

  return {
    space, scale, mode, columns, rows, cellX, cellY, widthMetres, heightMetres, values, pivot,
    referenceElevation, floor, floorZ, minimumElevation: minimumMetres, maximumElevation: maximumMetres,
    elevation, surfaceZ, toWorldZ, gradientX, gradientY,
    slopeAt: (worldX, worldY) => ({ x: slopeX(worldX / scale, worldY / scale), y: slopeY(worldX / scale, worldY / scale) }),
    worldFromPoint: point => ({
      x: (point.longitude - pivot.longitude) * eastScale * scale,
      y: (point.latitude - pivot.latitude) * northScale * scale
    }),
    pointFromWorld: ({ x, y }) => ({
      latitude: pivot.latitude + y / scale / northScale,
      longitude: pivot.longitude + x / scale / eastScale
    }),
    footprint: () => [
      [-widthMetres / 2, heightMetres / 2], [widthMetres / 2, heightMetres / 2],
      [widthMetres / 2, -heightMetres / 2], [-widthMetres / 2, -heightMetres / 2]
    ].map(([x, y]) => ({ latitude: pivot.latitude + y / northScale, longitude: pivot.longitude + x / eastScale }))
  };
}

/**
 * Places a Source or Listener in the terrain. Exterior heights are above the surface under the
 * point; interior heights are above the floor and are clamped below the ceiling. A point outside
 * the captured rectangle, or in the interior where there is no cavity, is not valid.
 */
export function placePoint(frame, point, heightMetres) {
  const world = frame.worldFromPoint(point);
  const surface = frame.surfaceZ(world.x, world.y);
  const base = { latitude: point.latitude, longitude: point.longitude };
  const scaledHeight = height => height * frame.scale;
  if (!Number.isFinite(surface)) return { ...base, valid: false, heightMetres: scaledHeight(heightMetres), heightSettingMetres: heightMetres, maximumHeightMetres: null, maximumHeightSettingMetres: null, reason: 'outside' };
  if (frame.mode === 'exterior') {
    const height = Math.min(EXTERIOR_HEIGHT_RANGE.maximum, Math.max(EXTERIOR_HEIGHT_RANGE.minimum, heightMetres));
    return {
      ...base, valid: true,
      heightMetres: scaledHeight(height), heightSettingMetres: height,
      maximumHeightMetres: scaledHeight(EXTERIOR_HEIGHT_RANGE.maximum), maximumHeightSettingMetres: EXTERIOR_HEIGHT_RANGE.maximum,
      positionMetres: { x: world.x, y: world.y, z: surface + scaledHeight(height) }
    };
  }
  const maximumHeightSettingMetres = (surface - frame.floorZ) / frame.scale - CAVITY_CLEARANCE_METRES;
  if (maximumHeightSettingMetres < CAVITY_CLEARANCE_METRES) return {
    ...base, valid: false,
    heightMetres: scaledHeight(heightMetres), heightSettingMetres: heightMetres,
    maximumHeightMetres: null, maximumHeightSettingMetres: null, reason: 'outside-cavity'
  };
  const height = Math.min(maximumHeightSettingMetres, Math.max(CAVITY_CLEARANCE_METRES, heightMetres));
  return {
    ...base, valid: true,
    heightMetres: scaledHeight(height), heightSettingMetres: height,
    maximumHeightMetres: scaledHeight(maximumHeightSettingMetres), maximumHeightSettingMetres,
    positionMetres: { x: world.x, y: world.y, z: frame.floorZ + scaledHeight(height) }
  };
}

export const terrainDistanceMetres = (a, b) => Math.hypot(
  b.positionMetres.x - a.positionMetres.x,
  b.positionMetres.y - a.positionMetres.y,
  b.positionMetres.z - a.positionMetres.z
);

export function arrivalElevationDegrees(listener, emitter) {
  if (!listener.positionMetres || !emitter.positionMetres) return 0;
  const dx = emitter.positionMetres.x - listener.positionMetres.x;
  const dy = emitter.positionMetres.y - listener.positionMetres.y;
  const dz = emitter.positionMetres.z - listener.positionMetres.z;
  return Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI;
}

/**
 * Whether the straight segment between two world points stays in the air: above the surface in
 * exterior mode, and between the floor and the surface in interior mode. Samples within one cell
 * of an endpoint that lies on a surface are ignored, because that surface owns the endpoint.
 */
export function segmentClear(frame, a, b, { skipStart = false, skipEnd = false } = {}) {
  const { scale, cellX, cellY, referenceElevation, mode, floor, elevation } = frame;
  const ax = a.x / scale; const ay = a.y / scale; const az = a.z / scale + referenceElevation;
  const bx = b.x / scale; const by = b.y / scale; const bz = b.z / scale + referenceElevation;
  const lengthCells = Math.hypot((bx - ax) / cellX, (by - ay) / cellY);
  const steps = Math.max(2, Math.ceil(lengthCells * MARCH_SAMPLES_PER_CELL));
  const skip = lengthCells > 0 ? ENDPOINT_SKIP_CELLS / lengthCells : 0;
  for (let step = 1; step < steps; step += 1) {
    const t = step / steps;
    if (skipStart && t < skip) continue;
    if (skipEnd && 1 - t < skip) continue;
    const surface = elevation(ax + (bx - ax) * t, ay + (by - ay) * t);
    const z = az + (bz - az) * t;
    if (mode === 'exterior') {
      if (z < surface) return false;
    } else if (!(z <= surface && z >= floor)) return false;
  }
  return true;
}

function surfaceNormal(frame, index) {
  const gradientX = frame.gradientX[index];
  const gradientY = frame.gradientY[index];
  const length = Math.hypot(gradientX, gradientY, 1);
  return { x: -gradientX / length, y: -gradientY / length, z: 1 / length, slopeFactor: length };
}

/**
 * The reflecting facets of a terrain space in world coordinates. Exterior: one upward facet per
 * cell. Interior: a downward ceiling facet and an upward floor facet per cell above the floor,
 * with area reduced to the share of the cell that lies inside the cavity.
 */
export function terrainFacets(frame) {
  const { columns, rows, cellX, cellY, values, scale, widthMetres, heightMetres, mode, floor, elevation, toWorldZ } = frame;
  const facets = [];
  const cellArea = cellX * cellY * scale * scale;
  for (let row = 0; row < rows; row += 1) {
    const y = -heightMetres / 2 + (row + .5) * cellY;
    for (let column = 0; column < columns; column += 1) {
      const x = -widthMetres / 2 + (column + .5) * cellX;
      const z = values[row * columns + column];
      const normal = surfaceNormal(frame, row * columns + column);
      const centre = { x: x * scale, y: y * scale };
      if (mode === 'exterior') {
        facets.push({ index: facets.length, surface: 'terrain', position: { ...centre, z: toWorldZ(z) }, normal, area: cellArea * normal.slopeFactor });
        continue;
      }
      let inside = 0;
      for (let sy = 0; sy < INTERIOR_SUBSAMPLES; sy += 1) for (let sx = 0; sx < INTERIOR_SUBSAMPLES; sx += 1) {
        const sample = elevation(x + ((sx + .5) / INTERIOR_SUBSAMPLES - .5) * cellX, y + ((sy + .5) / INTERIOR_SUBSAMPLES - .5) * cellY);
        if (sample > floor) inside += 1;
      }
      if (!inside) continue;
      const share = inside / INTERIOR_SUBSAMPLES ** 2;
      if (z > floor) {
        facets.push({
          index: facets.length, surface: 'ceiling', position: { ...centre, z: toWorldZ(z) },
          normal: { x: -normal.x, y: -normal.y, z: -normal.z }, area: cellArea * normal.slopeFactor * share
        });
      }
      facets.push({ index: facets.length, surface: 'floor', position: { ...centre, z: toWorldZ(floor) }, normal: { x: 0, y: 0, z: 1 }, area: cellArea * share });
    }
  }
  return facets;
}

const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = vector => Math.hypot(vector.x, vector.y, vector.z);
const compassDegrees = (from, to) => (Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI + 360) % 360;
const elevationDegrees = (from, to) => Math.atan2(to.z - from.z, Math.hypot(to.x - from.x, to.y - from.y)) * 180 / Math.PI;

function groundRadiusMetres(heightMetres) {
  return Math.max(GROUND_RADIUS_MINIMUM_METRES, GROUND_RADIUS_PER_HEIGHT * heightMetres);
}

const surfaceOffsetMetres = frame => Math.min(frame.cellX, frame.cellY) * frame.scale * SURFACE_OFFSET_CELLS;

function snapToSurface(frame, surface, point) {
  const offset = surfaceOffsetMetres(frame);
  if (surface === 'floor') return { x: point.x, y: point.y, z: frame.floorZ + offset };
  const z = frame.surfaceZ(point.x, point.y);
  if (!Number.isFinite(z)) return null;
  if (surface === 'ceiling') return z - offset > frame.floorZ ? { x: point.x, y: point.y, z: z - offset } : null;
  return { x: point.x, y: point.y, z: z + offset };
}

const unit = vector => {
  const size = length(vector);
  return { x: vector.x / size, y: vector.y / size, z: vector.z / size };
};

/**
 * Horizontal gradient of the Source → point → Listener path length for a point that follows a
 * surface given by its height and slope. It is zero exactly where the surface reflects specularly.
 */
function pathGradient(S, L, x, y, z, slope) {
  const p = { x, y, z };
  const fromSource = unit(subtract(p, S));
  const fromListener = unit(subtract(p, L));
  const sumZ = fromSource.z + fromListener.z;
  return [fromSource.x + fromListener.x + slope.x * sumZ, fromSource.y + fromListener.y + slope.y * sumZ];
}

function jacobian(gradient, x, y, step) {
  const east = gradient(x + step, y); const west = gradient(x - step, y);
  const north = gradient(x, y + step); const south = gradient(x, y - step);
  if (!east || !west || !north || !south) return null;
  return [
    [(east[0] - west[0]) / (2 * step), (north[0] - south[0]) / (2 * step)],
    [(east[1] - west[1]) / (2 * step), (north[1] - south[1]) / (2 * step)]
  ];
}

const determinant = matrix => matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];

/**
 * Specular points on the terrain surface (exterior) or ceiling (interior): the stationary points of
 * the path length along the surface, which is Fermat's principle for reflection. The surface uses
 * bilinear heights and a continuous slope field so a reflection between two cells is not lost.
 * Each point's energy relative to an image source follows stationary phase: the ratio of the path
 * Hessian on the tangent plane to the one on the curved surface, so a convex slope weakens its
 * echo and a concave one focuses it, capped at MAXIMUM_FOCUSING_ENERGY at a caustic.
 */
function surfaceSpecularPoints(frame, S, L) {
  const { columns, rows, cellX, cellY, scale, widthMetres, heightMetres, values, floor, mode } = frame;
  const worldCell = Math.min(cellX, cellY) * scale;
  const step = worldCell * NEWTON_STEP_CELLS;
  const heightAt = (x, y) => frame.surfaceZ(x, y);
  const surfaceGradient = (x, y) => {
    const z = heightAt(x, y);
    if (!Number.isFinite(z)) return null;
    return pathGradient(S, L, x, y, z, frame.slopeAt(x, y));
  };
  const centreX = column => (-widthMetres / 2 + (column + .5) * cellX) * scale;
  const centreY = row => (-heightMetres / 2 + (row + .5) * cellY) * scale;
  const gradients = new Array(values.length);
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const index = row * columns + column;
    if (mode === 'interior' && values[index] <= floor) continue;
    gradients[index] = surfaceGradient(centreX(column), centreY(row));
  }
  const found = new Map();
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const corners = [row * columns + column, row * columns + column + 1, (row + 1) * columns + column, (row + 1) * columns + column + 1].map(index => gradients[index]);
      if (corners.some(corner => !corner)) continue;
      if (!corners.some(corner => corner[0] <= 0) || !corners.some(corner => corner[0] >= 0)) continue;
      if (!corners.some(corner => corner[1] <= 0) || !corners.some(corner => corner[1] >= 0)) continue;
      let x = (centreX(column) + centreX(column + 1)) / 2;
      let y = (centreY(row) + centreY(row + 1)) / 2;
      let converged = false;
      for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
        const residual = surfaceGradient(x, y);
        const matrix = jacobian(surfaceGradient, x, y, step);
        if (!residual || !matrix) break;
        const det = determinant(matrix);
        if (!(Math.abs(det) > 0)) break;
        let dx = (matrix[1][1] * residual[0] - matrix[0][1] * residual[1]) / det;
        let dy = (matrix[0][0] * residual[1] - matrix[1][0] * residual[0]) / det;
        const size = Math.hypot(dx, dy);
        if (size > worldCell) { dx *= worldCell / size; dy *= worldCell / size; }
        x -= dx; y -= dy;
        if (Math.hypot(dx, dy) < worldCell * NEWTON_TOLERANCE_CELLS) { converged = true; break; }
      }
      if (!converged) continue;
      const key = `${Math.round(x / scale * 1000)},${Math.round(y / scale * 1000)}`;
      if (found.has(key)) continue;
      const z = heightAt(x, y);
      const slope = frame.slopeAt(x, y);
      if (!Number.isFinite(z)) continue;
      const upward = unit({ x: -slope.x, y: -slope.y, z: 1 });
      const surface = mode === 'interior' ? 'ceiling' : 'terrain';
      if (surface === 'ceiling' && z <= frame.floorZ) continue;
      const normal = surface === 'ceiling' ? { x: -upward.x, y: -upward.y, z: -upward.z } : upward;
      const point = { x, y, z };
      if (dot(normal, subtract(S, point)) <= 0 || dot(normal, subtract(L, point)) <= 0) continue;
      const planeGradient = (px, py) => pathGradient(S, L, px, py, z + slope.x * (px - x) + slope.y * (py - y), slope);
      const curved = jacobian(surfaceGradient, x, y, step);
      const plane = jacobian(planeGradient, x, y, step);
      if (!curved || !plane) continue;
      const focusing = Math.min(MAXIMUM_FOCUSING_ENERGY, Math.abs(determinant(plane)) / Math.max(Number.MIN_VALUE, Math.abs(determinant(curved))));
      found.set(key, { key, surface, point, normal, focusing });
    }
  }
  return [...found.values()];
}

/** The specular point of the flat interior floor, from its exact image source. */
function floorSpecularPoint(frame, S, L) {
  const mirroredZ = 2 * frame.floorZ - S.z;
  const t = (frame.floorZ - mirroredZ) / (L.z - mirroredZ);
  if (!(t > 0 && t < 1)) return null;
  const point = { x: S.x + (L.x - S.x) * t, y: S.y + (L.y - S.y) * t, z: frame.floorZ };
  if (!(frame.surfaceZ(point.x, point.y) > frame.floorZ)) return null;
  return { key: `${Math.round(point.x / frame.scale * 1000)},${Math.round(point.y / frame.scale * 1000)}`, surface: 'floor', point, normal: { x: 0, y: 0, z: 1 }, focusing: 1 };
}

/**
 * First-order terrain reflections for a placed Source and Listener, as reflectors the early and
 * late paths can use. The scattering setting `s` splits each surface's energy: `1 − s` reflects
 * specularly at the surface's specular points, each one an exact reflector; `s` scatters from every
 * facet as a Lambertian patch, `A · cosθᵢ · cosθₒ / π · (r / r₁r₂)²` relative to an image source
 * over the same total path, and diffuse patches merge by arrival time, azimuth, and elevation.
 * Ground is the surface the points stand over, and follows `groundReflectionDb`.
 */
export function terrainReflectors({ frame, facets = terrainFacets(frame), source, listener, globalReflectionLevelDb, maxSurfaces, speedOfSound }) {
  const { space } = frame;
  const S = source.positionMetres;
  const L = listener.positionMetres;
  const scattering = space.scattering;
  const groundGain = space.groundReflectionDb === null ? 0 : 10 ** (space.groundReflectionDb / 10);
  const sourceGroundRadius = groundRadiusMetres(source.heightMetres);
  const listenerGroundRadius = groundRadiusMetres(listener.heightMetres);
  const isGround = (surface, point) => (frame.mode === 'exterior' || surface === 'floor') && (
    Math.hypot(point.x - L.x, point.y - L.y) < listenerGroundRadius || Math.hypot(point.x - S.x, point.y - S.y) < sourceGroundRadius);
  const candidates = [];
  const clusters = new Map();

  if (scattering < 1) {
    const specularPoints = surfaceSpecularPoints(frame, S, L);
    if (frame.mode === 'interior') {
      const floorPoint = floorSpecularPoint(frame, S, L);
      if (floorPoint) specularPoints.push(floorPoint);
    }
    for (const { key, surface, point, normal, focusing } of specularPoints) {
      const ground = isGround(surface, point);
      const gain = ground ? groundGain : 1;
      if (!gain) continue;
      if (!segmentClear(frame, S, point, { skipEnd: true }) || !segmentClear(frame, point, L, { skipStart: true })) continue;
      const offset = surfaceOffsetMetres(frame);
      const position = { x: point.x + normal.x * offset, y: point.y + normal.y * offset, z: point.z + normal.z * offset };
      candidates.push({ id: `terrain-s-${surface}-${key}`, kind: 'terrain-specular', surface, ground, energy: (1 - scattering) * gain * focusing, position });
    }
  }

  if (scattering > 0) {
    for (const facet of facets) {
      const c = facet.position;
      const n = facet.normal;
      const toSource = subtract(S, c);
      const toListener = subtract(L, c);
      const r1 = length(toSource);
      const r2 = length(toListener);
      if (!(r1 > 0) || !(r2 > 0)) continue;
      const cosIncidence = dot(n, toSource) / r1;
      const cosExit = dot(n, toListener) / r2;
      if (cosIncidence <= 0 || cosExit <= 0) continue;
      const ground = isGround(facet.surface, c);
      const gain = ground ? groundGain : 1;
      if (!gain) continue;
      if (!segmentClear(frame, S, c, { skipEnd: true }) || !segmentClear(frame, c, L, { skipStart: true })) continue;
      const pathMetres = r1 + r2;
      const energy = scattering * gain * facet.area * cosIncidence * cosExit / Math.PI * (pathMetres / (r1 * r2)) ** 2;
      const delayBin = Math.floor(propagationSeconds(pathMetres, speedOfSound) / DIFFUSE_DELAY_BIN_SECONDS);
      const azimuthSector = Math.floor(compassDegrees(L, c) / DIFFUSE_AZIMUTH_SECTOR_DEGREES);
      const elevationSector = Math.floor((elevationDegrees(L, c) + 90) / DIFFUSE_ELEVATION_SECTOR_DEGREES);
      const key = `${ground ? 'g' : 't'}-${facet.surface}-${delayBin}-${azimuthSector}-${elevationSector}`;
      const cluster = clusters.get(key) ?? { key, surface: facet.surface, ground, energy: 0, x: 0, y: 0, z: 0, strongest: null, strongestEnergy: 0 };
      cluster.energy += energy;
      cluster.x += c.x * energy; cluster.y += c.y * energy; cluster.z += c.z * energy;
      if (energy > cluster.strongestEnergy) Object.assign(cluster, { strongest: c, strongestEnergy: energy });
      clusters.set(key, cluster);
    }
  }

  for (const cluster of clusters.values()) {
    if (!(cluster.energy > 0)) continue;
    const centroid = { x: cluster.x / cluster.energy, y: cluster.y / cluster.energy, z: cluster.z / cluster.energy };
    const position = snapToSurface(frame, cluster.surface, centroid) ?? snapToSurface(frame, cluster.surface, cluster.strongest) ?? cluster.strongest;
    candidates.push({ id: `terrain-d-${cluster.key}`, kind: 'terrain-diffuse', surface: cluster.surface, ground: cluster.ground, energy: cluster.energy, position });
  }

  candidates.sort((a, b) => b.energy - a.energy || (a.id < b.id ? -1 : 1));
  return candidates.slice(0, maxSurfaces).map(candidate => ({
    id: candidate.id,
    ...frame.pointFromWorld(candidate.position),
    positionMetres: candidate.position,
    levelDb: globalReflectionLevelDb + 10 * Math.log10(candidate.energy),
    material: space.material,
    reflectionKind: candidate.kind,
    terrainSurface: candidate.surface,
    ground: candidate.ground
  }));
}

/** Which terrain reflectors can reach each other through the air, for multi-bounce paths. */
export function terrainVisibility(frame, reflectors) {
  const visible = new Map(reflectors.map(reflector => [reflector.id, []]));
  for (let first = 0; first < reflectors.length; first += 1) {
    for (let second = first + 1; second < reflectors.length; second += 1) {
      const a = reflectors[first];
      const b = reflectors[second];
      if (!segmentClear(frame, a.positionMetres, b.positionMetres, { skipStart: true, skipEnd: true })) continue;
      visible.get(a.id).push(b.id);
      visible.get(b.id).push(a.id);
    }
  }
  return visible;
}

/** Everything the echo field needs from an unscaled terrain and one Source and Listener placement. */
export function buildCanonicalTerrainField({ space, facets = null, source, listener, globalReflectionLevelDb, maxSurfaces, speedOfSound }) {
  if (space.scale !== 1) throw new RangeError('A canonical terrain field must use scale 1.');
  const frame = terrainFrame(space);
  const placedSource = placePoint(frame, source, terrainHeightMetres(space, 'source'));
  const placedListener = placePoint(frame, listener, terrainHeightMetres(space, 'listener'));
  if (!placedSource.valid || !placedListener.valid) {
    return { valid: false, source: placedSource, listener: placedListener, reflectors: [], directOccluded: false };
  }
  const reflectors = terrainReflectors({
    frame, facets: facets ?? terrainFacets(frame), source: placedSource, listener: placedListener,
    globalReflectionLevelDb, maxSurfaces, speedOfSound
  });
  const visibility = terrainVisibility(frame, reflectors);
  reflectors.forEach(reflector => { reflector.visibleReflectorIds = visibility.get(reflector.id); });
  return {
    valid: true,
    source: placedSource,
    listener: placedListener,
    reflectors,
    directOccluded: !segmentClear(frame, placedSource.positionMetres, placedListener.positionMetres)
  };
}

const scaledPosition = (position, scale) => position ? {
  x: position.x * scale,
  y: position.y * scale,
  z: position.z * scale
} : position;

const scaledPlacedPoint = (point, scale) => ({
  ...point,
  heightMetres: point.heightMetres * scale,
  maximumHeightMetres: point.maximumHeightMetres === null ? null : point.maximumHeightMetres * scale,
  ...(point.positionMetres ? { positionMetres: scaledPosition(point.positionMetres, scale) } : {})
});

/** Applies acoustic scale after the reflector field has been fixed at 1:1. Map positions stay put. */
export function scaleTerrainField(field, scale) {
  return {
    ...field,
    source: scaledPlacedPoint(field.source, scale),
    listener: scaledPlacedPoint(field.listener, scale),
    reflectors: field.reflectors.map(reflector => ({
      ...reflector,
      positionMetres: scaledPosition(reflector.positionMetres, scale),
      ...(Array.isArray(reflector.visibleReflectorIds) ? { visibleReflectorIds: [...reflector.visibleReflectorIds] } : {})
    }))
  };
}

/** Builds a stable 1:1 field, then uniformly scales every acoustic position in that field. */
export function buildTerrainField({ space, facets = null, source, listener, globalReflectionLevelDb, maxSurfaces, speedOfSound }) {
  const canonicalSpace = space.scale === 1 ? space : { ...space, scale: 1 };
  const field = buildCanonicalTerrainField({
    space: canonicalSpace, facets: space.scale === 1 ? facets : null,
    source, listener, globalReflectionLevelDb, maxSurfaces, speedOfSound
  });
  return scaleTerrainField(field, space.scale);
}

/** Line segments where the ceiling meets the floor, in map coordinates, for the interior outline. */
export function floorOutline(frame) {
  const { columns, rows, cellX, cellY, values, widthMetres, heightMetres, floor } = frame;
  const segments = [];
  const cornerPoint = (column, row) => ({ x: -widthMetres / 2 + (column + .5) * cellX, y: -heightMetres / 2 + (row + .5) * cellY });
  const crossing = (a, b, valueA, valueB) => {
    const t = (floor - valueA) / (valueB - valueA);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const corners = [[column, row], [column + 1, row], [column + 1, row + 1], [column, row + 1]];
      const heights = corners.map(([x, y]) => values[y * columns + x]);
      const points = corners.map(([x, y]) => cornerPoint(x, y));
      const edges = [];
      for (let edge = 0; edge < 4; edge += 1) {
        const next = (edge + 1) % 4;
        if ((heights[edge] > floor) !== (heights[next] > floor)) edges.push(crossing(points[edge], points[next], heights[edge], heights[next]));
      }
      if (edges.length === 2) segments.push([edges[0], edges[1]]);
      if (edges.length === 4) segments.push([edges[0], edges[1]], [edges[2], edges[3]]);
    }
  }
  return segments.map(segment => segment.map(point => frame.pointFromWorld({ x: point.x * frame.scale, y: point.y * frame.scale })));
}

/** The map point under the tallest part of the cavity, where a first listen is least likely to be cramped. */
export function tallestCavityPoint(frame) {
  const { columns, rows, values, cellX, cellY, widthMetres, heightMetres, floor } = frame;
  let best = -1;
  for (let index = 0; index < values.length; index += 1) if (best < 0 || values[index] > values[best]) best = index;
  if (values[best] <= floor) return null;
  const column = best % columns;
  const row = Math.floor(best / columns);
  const x = -widthMetres / 2 + (column + .5) * cellX;
  const y = -heightMetres / 2 + (row + .5) * cellY;
  return { point: frame.pointFromWorld({ x: x * frame.scale, y: y * frame.scale }), cellMetres: Math.min(cellX, cellY) };
}

/**
 * The vertical section through the Source and the Listener, across the whole captured rectangle,
 * in world metres. Distance runs from where the line enters the rectangle; when the two points
 * coincide the section runs east–west through them.
 */
export function sectionProfile(frame, source, listener, samples = 256) {
  const { widthMetres, heightMetres, scale } = frame;
  const start = frame.worldFromPoint(source);
  const end = frame.worldFromPoint(listener);
  const a = { x: start.x / scale, y: start.y / scale };
  const b = { x: end.x / scale, y: end.y / scale };
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const direction = span > 1e-9 ? { x: (b.x - a.x) / span, y: (b.y - a.y) / span } : { x: 1, y: 0 };
  let entry = -Infinity;
  let exit = Infinity;
  for (const [origin, step, half] of [[a.x, direction.x, widthMetres / 2], [a.y, direction.y, heightMetres / 2]]) {
    if (Math.abs(step) < 1e-12) {
      if (Math.abs(origin) > half) return null;
      continue;
    }
    const first = (-half - origin) / step;
    const second = (half - origin) / step;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
  }
  if (!(exit > entry)) return null;
  const points = Array.from({ length: samples }, (_, index) => {
    const t = entry + (exit - entry) * (index + .5) / samples;
    const elevation = frame.elevation(a.x + direction.x * t, a.y + direction.y * t);
    return { distanceMetres: (t - entry) * scale, surfaceMetres: frame.toWorldZ(elevation) };
  });
  return {
    lengthMetres: (exit - entry) * scale,
    points,
    sourceDistanceMetres: -entry * scale,
    listenerDistanceMetres: (span - entry) * scale,
    floorMetres: frame.floorZ
  };
}
