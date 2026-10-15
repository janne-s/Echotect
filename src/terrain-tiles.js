import { EARTH_RADIUS_METRES } from './geo.js';

export const TERRAIN_PROVIDER = Object.freeze({
  id: 'aws-terrain-tiles-terrarium',
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  attribution: 'Terrain Tiles: Mapzen / AWS Open Data (SRTM, GMTED2010, NED, ETOPO1 and national datasets)',
  attributionUrl: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md'
});

const TILE_SIZE = 256;
const MAXIMUM_TILE_ZOOM = 15;
const MINIMUM_TILE_ZOOM = 1;
const MAXIMUM_TILE_REQUESTS = 36;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const EARTH_CIRCUMFERENCE_METRES = 40075016.686;
export const MAXIMUM_GRID_CELLS = 256;
export const MINIMUM_GRID_CELLS = 4;
export const MINIMUM_CAPTURE_EXTENT_METRES = 100;
export const MAXIMUM_CAPTURE_EXTENT_METRES = 80000;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const METRES_PER_DEGREE = EARTH_RADIUS_METRES * Math.PI / 180;

/** The haversine sphere, so terrain and map distances between the same points agree. */
export const terrainMetresPerDegree = latitude => ({ north: METRES_PER_DEGREE, east: METRES_PER_DEGREE * Math.cos(latitude * Math.PI / 180) });

export const decodeTerrarium = (red, green, blue) => red * 256 + green + blue / 256 - 32768;

export const curvatureDropMetres = horizontalMetres => horizontalMetres ** 2 / (2 * EARTH_RADIUS_METRES);

export const tileX = (longitude, zoom) => (longitude + 180) / 360 * 2 ** zoom;

export function tileY(latitude, zoom) {
  const radians = clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE) * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * 2 ** zoom;
}

export const tilePixelMetres = (latitude, zoom) =>
  EARTH_CIRCUMFERENCE_METRES * Math.cos(latitude * Math.PI / 180) / (TILE_SIZE * 2 ** zoom);

export function tileRange(bounds, zoom) {
  const last = 2 ** zoom - 1;
  const west = clamp(Math.floor(tileX(bounds.west, zoom)), 0, last);
  const east = clamp(Math.floor(tileX(bounds.east, zoom)), 0, last);
  const north = clamp(Math.floor(tileY(bounds.north, zoom)), 0, last);
  const south = clamp(Math.floor(tileY(bounds.south, zoom)), 0, last);
  return { west, east, north, south, count: (east - west + 1) * (south - north + 1) };
}

export function captureCentre(bounds) {
  return { latitude: (bounds.north + bounds.south) / 2, longitude: (bounds.east + bounds.west) / 2 };
}

export function captureExtentMetres(bounds) {
  const { north, east } = terrainMetresPerDegree(captureCentre(bounds).latitude);
  return { widthMetres: (bounds.east - bounds.west) * east, heightMetres: (bounds.north - bounds.south) * north };
}

export function validCaptureBounds(bounds) {
  if (![bounds?.west, bounds?.south, bounds?.east, bounds?.north].every(Number.isFinite)) return false;
  if (bounds.east <= bounds.west || bounds.north <= bounds.south) return false;
  if (Math.abs(bounds.north) > MAX_MERCATOR_LATITUDE || Math.abs(bounds.south) > MAX_MERCATOR_LATITUDE) return false;
  if (bounds.west < -180 || bounds.east > 180) return false;
  const { widthMetres, heightMetres } = captureExtentMetres(bounds);
  return Math.min(widthMetres, heightMetres) >= MINIMUM_CAPTURE_EXTENT_METRES
    && Math.max(widthMetres, heightMetres) <= MAXIMUM_CAPTURE_EXTENT_METRES;
}

export function capturePlan(bounds) {
  if (!validCaptureBounds(bounds)) throw new RangeError('The terrain rectangle is outside the supported size.');
  const { widthMetres, heightMetres } = captureExtentMetres(bounds);
  const centre = captureCentre(bounds);
  const targetCellMetres = Math.max(widthMetres, heightMetres) / MAXIMUM_GRID_CELLS;
  let zoom = MAXIMUM_TILE_ZOOM;
  while (zoom > MINIMUM_TILE_ZOOM && tilePixelMetres(centre.latitude, zoom - 1) <= targetCellMetres) zoom -= 1;
  while (zoom > MINIMUM_TILE_ZOOM && tileRange(bounds, zoom).count > MAXIMUM_TILE_REQUESTS) zoom -= 1;
  const cellMetres = Math.max(targetCellMetres, tilePixelMetres(centre.latitude, zoom));
  const columns = Math.max(MINIMUM_GRID_CELLS, Math.round(widthMetres / cellMetres));
  const rows = Math.max(MINIMUM_GRID_CELLS, Math.round(heightMetres / cellMetres));
  return { zoom, tiles: tileRange(bounds, zoom), widthMetres, heightMetres, columns, rows, centre };
}

export function buildHeightfield(plan, elevationAt) {
  const { columns, rows, centre, zoom } = plan;
  const cellMetres = plan.widthMetres / columns;
  const values = new Float32Array(columns * rows);
  const { north, east } = terrainMetresPerDegree(centre.latitude);
  for (let row = 0; row < rows; row += 1) {
    const y = -plan.heightMetres / 2 + (row + .5) * plan.heightMetres / rows;
    const latitude = centre.latitude + y / north;
    const pixelY = tileY(latitude, zoom) * TILE_SIZE - .5;
    for (let column = 0; column < columns; column += 1) {
      const x = -plan.widthMetres / 2 + (column + .5) * cellMetres;
      const longitude = centre.longitude + x / east;
      const pixelX = tileX(longitude, zoom) * TILE_SIZE - .5;
      const x0 = Math.floor(pixelX); const y0 = Math.floor(pixelY);
      const fx = pixelX - x0; const fy = pixelY - y0;
      const elevation = (elevationAt(x0, y0) * (1 - fx) + elevationAt(x0 + 1, y0) * fx) * (1 - fy)
        + (elevationAt(x0, y0 + 1) * (1 - fx) + elevationAt(x0 + 1, y0 + 1) * fx) * fy;
      values[row * columns + column] = elevation - curvatureDropMetres(Math.hypot(x, y));
    }
  }
  return values;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_CHANNELS = Object.freeze({ 2: 3, 3: 1, 6: 4 });

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Not through a canvas: colour management and anti-fingerprinting noise alter elevation, one red step being 256 m. */
export async function decodePngRgb(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error('Terrain tile is not a PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0; let height = 0; let colourType = -1; let palette = null;
  const data = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      colourType = body[9];
      if (body[8] !== 8 || body[12] !== 0 || !(colourType in PNG_CHANNELS)) throw new Error('Terrain tile PNG format is unsupported.');
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = PNG_CHANNELS[colourType];
  const stride = width * channels;
  const raw = await inflate(new Uint8Array(await new Blob(data).arrayBuffer()));
  if (raw.length < height * (stride + 1)) throw new Error('Terrain tile PNG data is truncated.');
  const pixels = new Uint8Array(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const left = column >= channels ? pixels[target + column - channels] : 0;
      const up = row ? pixels[target - stride + column] : 0;
      const upLeft = row && column >= channels ? pixels[target - stride + column - channels] : 0;
      const value = raw[source + column];
      const predicted = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : 0;
      pixels[target + column] = (value + predicted) & 255;
    }
  }
  if (colourType === 2) return { width, height, rgb: pixels };
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const from = colourType === 6 ? pixels.subarray(pixel * 4, pixel * 4 + 3) : palette.subarray(pixels[pixel] * 3, pixels[pixel] * 3 + 3);
    rgb.set(from, pixel * 3);
  }
  return { width, height, rgb };
}

async function decodeTile(response) {
  const { width, height, rgb } = await decodePngRgb(await response.arrayBuffer());
  if (width !== TILE_SIZE || height !== TILE_SIZE) throw new Error('Terrain tile size is unexpected.');
  const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let index = 0; index < elevations.length; index += 1) {
    elevations[index] = decodeTerrarium(rgb[index * 3], rgb[index * 3 + 1], rgb[index * 3 + 2]);
  }
  return elevations;
}

export async function captureTerrain(bounds, { signal } = {}) {
  const plan = capturePlan(bounds);
  const { tiles, zoom } = plan;
  const entries = [];
  for (let y = tiles.north; y <= tiles.south; y += 1) for (let x = tiles.west; x <= tiles.east; x += 1) entries.push({ x, y });
  const decoded = await Promise.all(entries.map(async ({ x, y }) => {
    const url = TERRAIN_PROVIDER.url.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
    const response = await fetch(url, { signal, mode: 'cors' });
    if (!response.ok) throw new Error(`Terrain tile ${zoom}/${x}/${y} could not be loaded.`);
    return { x, y, elevations: await decodeTile(response) };
  }));
  const byKey = new Map(decoded.map(tile => [`${tile.x}/${tile.y}`, tile.elevations]));
  const elevationAt = (pixelX, pixelY) => {
    const x = clamp(pixelX, tiles.west * TILE_SIZE, (tiles.east + 1) * TILE_SIZE - 1);
    const y = clamp(pixelY, tiles.north * TILE_SIZE, (tiles.south + 1) * TILE_SIZE - 1);
    const tile = byKey.get(`${Math.floor(x / TILE_SIZE)}/${Math.floor(y / TILE_SIZE)}`);
    return tile[(y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)];
  };
  return {
    bounds: { ...bounds },
    provider: TERRAIN_PROVIDER.id,
    tileZoom: zoom,
    columns: plan.columns,
    rows: plan.rows,
    widthMetres: plan.widthMetres,
    heightMetres: plan.heightMetres,
    curvatureCorrected: true,
    capturedAt: new Date().toISOString(),
    values: buildHeightfield(plan, elevationAt)
  };
}
